import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, writeSync, type Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { DomainError, optionalText, requiredId, requiredInteger, requiredText, type BookSummary } from '../../contracts/api'
import {
  MAX_RECOVERY_BYTES, MAX_RECOVERY_FILES, MAX_RECOVERY_MANIFEST_BYTES,
  parseBookRecoveryExportServiceInput, parseBookRecoveryManifest, parseBookRecoveryPrepareInput, parseBookRecoveryRestoreInput,
  type BookRecoveryExportServiceInput, type BookRecoveryExportReceipt, type BookRecoveryFile, type BookRecoveryManifest,
  type BookRecoveryPrepareInput, type BookRecoveryPreview, type BookRecoveryRestoreInput, type BookRecoveryRestoreReceipt,
} from '../../contracts/book-recovery'
import { countCharacters, documentToText, MAX_CHAPTER_LENGTH, parseManuscript } from '../../contracts/manuscript'
import { parseKnowledgeFields, parseKnowledgeSource } from '../../contracts/knowledge'
import { parseStoryFields } from '../../contracts/story'
import { parseNoteFields, parseNoteMaterial } from '../../contracts/notes'
import { parseMemoryVectorValues } from '../../contracts/memory-vector'
import { NotesRepository } from '../notes/notes-repository'
import { validateNoteThumbnails } from '../notes/thumbnail-repository'
import { validateForeshadowThumbnails } from '../story/thumbnail-repository'
import { AiRepository } from '../ai/ai-repository'
import { GenerationRepository } from '../ai/generation-repository'
import { LivingRepository } from '../workbench/living-repository'
import { AiMemoryTaskRepository } from '../ai/memory-task-repository'
import { AiSummaryRepository } from '../ai/summary-repository'
import { MemoryRepository } from '../memory/task-repository'
import { MemorySearchRepository } from '../memory/search-repository'
import { MemoryVectorRepository } from '../memory/vector-repository'
import { validateWorkbenchDatabase } from '../workbench/workbench-repository'
import { WORKBENCH_SCHEMA } from '../workbench/schema'
import { validateCalendarDatabase } from '../workbench/calendar-repository'
import { validateWeaveDatabase } from '../workbench/weave-repository'
import { validateRealmDatabase } from '../workbench/realm-repository'
import { validateAiPresetsDatabase } from '../ai/preset-repository'
import { validateMediaDatabase } from '../workbench/media-repository'
import { KNOWLEDGE_SCHEMA } from '../knowledge/schema'
import { STORY_SCHEMA } from '../story/schema'
import { MEMORY_SCHEMA } from '../memory/schema'
import { AI_SCHEMA } from '../ai/schema'
import { AI_MEMORY_MAINTENANCE_SCHEMA, AI_MEMORY_TASK_SCHEMA } from '../ai/memory-task-schema'
import { AI_SUMMARY_SCHEMA } from '../ai/summary-schema'
import { MEMORY_VECTOR_SCHEMA } from '../memory/vector-schema'
import { NOTES_SCHEMA } from '../notes/schema'
import { BOOK_APPLICATION_ID, BOOK_BASE_SCHEMA, BOOK_V14_SCHEMA, BOOK_V15_SCHEMA, BOOK_V16_SCHEMA, BOOK_V17_SCHEMA, BOOK_V18_SCHEMA, BOOK_V19_SCHEMA, BOOK_V20_SCHEMA, BOOK_V21_SCHEMA, BOOK_V22_SCHEMA, BOOK_V23_SCHEMA, BOOK_V24_SCHEMA, BOOK_SCHEMA, BOOK_SCHEMA_VERSION } from './schema'
import { ForgeRepository } from '../workbench/forge-repository'
import { BOOK_RECOVERY_COMPLETE, BOOK_RECOVERY_PENDING, StudioRepository } from './studio-repository'

const MANIFEST_NAME = 'manifest.json'
const MAX_SOURCE_BYTES = 32 * 1024 * 1024
const IO_BYTES = 1024 * 1024
const PREVIEW_TTL = 30 * 60 * 1000
const MAX_SCHEMA_OBJECTS = 512
interface PathIdentity { path: string; directory: boolean; stat: Stats }
interface Snapshot {
  book: BookSummary; schemaVersion: number; chapterCount: number; revisionCount: number; sources: BookRecoveryFile[]
}
interface CheckedPackage {
  manifest: BookRecoveryManifest; manifestBytes: Buffer; manifestHash: string
  directory: PathIdentity; guards: PathIdentity[]; files: PathIdentity[]
}
interface PreparedPackage {
  preview: BookRecoveryPreview; expiresAt: number; generation: number; root: PathIdentity; books: PathIdentity; checked: CheckedPackage
}

function invalid(message: string): never {
  throw new DomainError({ code: 'STORAGE_ERROR', message })
}

function failure(error: unknown, operation: string, retained?: string): DomainError {
  const detail = error instanceof DomainError ? error.detail : { code: 'STORAGE_ERROR' as const, message: `${operation}失败，请检查文件与磁盘空间。` }
  return new DomainError({ ...detail, message: retained ? `${detail.message} 本次文件已保留在：${retained}。请保留并核对；未完成的目录不能作为恢复包或作品使用。` : detail.message })
}

function samePath(a: string, b: string): boolean { return resolve(a).toLowerCase() === resolve(b).toLowerCase() }
function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs }
function sameContent(a: Stats, b: Stats): boolean { return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs }

function checkedPath(path: string, directory: boolean): PathIdentity {
  if (process.platform !== 'win32' || !/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':') || path.includes('\0')) {
    invalid('恢复包只支持 Windows 本地磁盘中的普通目录和文件。')
  }
  const requested = resolve(path)
  const canonical = realpathSync.native(requested)
  const stat = lstatSync(requested)
  if (!/^[a-z]:[\\/]/i.test(canonical) || !samePath(requested, canonical) || stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    invalid(`发现链接、网络位置或异常文件类型，已停止访问：${requested}`)
  }
  return { path: canonical, directory, stat }
}

function recheck(identity: PathIdentity, content = false): void {
  const actual = checkedPath(identity.path, identity.directory)
  if (!(content ? sameContent(identity.stat, actual.stat) : sameIdentity(identity.stat, actual.stat))) {
    invalid(`文件或目录在操作期间发生变化，请重新预览：${identity.path}`)
  }
}

function checkGuards(guards: readonly PathIdentity[]): void { for (const guard of guards) recheck(guard) }

function requireExportParent(parent: PathIdentity): void {
  recheck(parent)
  // 恢复包拒绝清单外目录；在其中新增备份会让旧包失效，必须在首次写入前拦截。
  for (let directory = parent.path; ;) {
    if (lstatSync(join(directory, MANIFEST_NAME), { throwIfNoEntry: false }) &&
        lstatSync(join(directory, 'book.sqlite'), { throwIfNoEntry: false })) {
      throw new DomainError({ code: 'INVALID_INPUT', message: '不能把新备份保存到已有作品恢复包或其子目录中，请选择恢复包之外的保存位置。' })
    }
    const next = dirname(directory)
    if (samePath(next, directory)) return
    directory = next
  }
}

function openRead(identity: PathIdentity, maximum: number): number {
  recheck(identity, true)
  if (!Number.isSafeInteger(identity.stat.size) || identity.stat.size < 0 || identity.stat.size > maximum) invalid(`文件超过恢复包大小限制：${identity.path}`)
  const fd = openSync(identity.path, 'r')
  try {
    const opened = fstatSync(fd)
    if (!sameContent(identity.stat, opened) || !opened.isFile() || opened.nlink !== 1) invalid(`文件在打开前发生变化：${identity.path}`)
    return fd
  } catch (error) { closeSync(fd); throw error }
}

function readBounded(identity: PathIdentity, maximum: number): Buffer {
  const fd = openRead(identity, maximum)
  try {
    const bytes = Buffer.alloc(identity.stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, Math.min(IO_BYTES, bytes.length - offset), offset)
      if (count === 0) invalid(`文件读取不完整：${identity.path}`)
      offset += count
    }
    if (!sameContent(identity.stat, fstatSync(fd))) invalid(`文件在读取期间发生变化：${identity.path}`)
    recheck(identity, true)
    return bytes
  } finally { closeSync(fd) }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset)
    if (count === 0) invalid('文件未能完整写入，已保留本次部分内容。')
    offset += count
  }
}

function writeNew(path: string, bytes: Buffer, guards: readonly PathIdentity[]): PathIdentity {
  checkGuards(guards)
  const fd = openSync(path, 'wx')
  try {
    const identity = fstatSync(fd)
    checkGuards(guards)
    if (!sameIdentity(identity, checkedPath(path, false).stat)) invalid(`新文件身份发生变化：${path}`)
    writeAll(fd, bytes)
    fsyncSync(fd)
    checkGuards(guards)
    const result = checkedPath(path, false)
    if (!sameIdentity(identity, result.stat) || result.stat.size !== bytes.length) invalid(`新文件身份或长度不一致：${path}`)
    return result
  } finally { closeSync(fd) }
}

// 以固定大小缓冲区核对原字节；复制与摘要来自同一次读取，不将整库或全部原件载入内存。
function streamFile(identity: PathIdentity, relative: string, maximum: number, guards: readonly PathIdentity[], target?: string): BookRecoveryFile {
  checkGuards(guards)
  const source = openRead(identity, maximum)
  let destination: number | undefined
  let created: Stats | undefined
  try {
    if (target !== undefined) {
      destination = openSync(target, 'wx')
      created = fstatSync(destination)
      checkGuards(guards)
      if (!sameIdentity(created, checkedPath(target, false).stat)) invalid(`复制目标身份发生变化：${target}`)
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(IO_BYTES)
    let offset = 0
    while (offset < identity.stat.size) {
      const count = readSync(source, buffer, 0, Math.min(buffer.length, identity.stat.size - offset), offset)
      if (count === 0) invalid(`文件读取不完整：${identity.path}`)
      const chunk = buffer.subarray(0, count)
      hash.update(chunk)
      if (destination !== undefined) writeAll(destination, chunk)
      offset += count
    }
    if (!sameContent(identity.stat, fstatSync(source))) invalid(`文件在读取期间发生变化：${identity.path}`)
    recheck(identity, true)
    checkGuards(guards)
    if (destination !== undefined && target !== undefined && created) {
      fsyncSync(destination)
      const actual = checkedPath(target, false)
      if (!sameIdentity(created, actual.stat) || actual.stat.size !== offset || !sameContent(actual.stat, fstatSync(destination))) invalid(`复制目标发生变化：${target}`)
    }
    return { path: relative, bytes: offset, sha256: hash.digest('hex') }
  } finally {
    try { if (destination !== undefined) closeSync(destination) } finally { closeSync(source) }
  }
}

function matchFile(actual: BookRecoveryFile, expected: BookRecoveryFile): void {
  if (actual.path !== expected.path || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) invalid(`恢复包文件摘要或字节数不一致：${expected.path}`)
}

function noSidecars(databasePath: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (lstatSync(`${databasePath}${suffix}`, { throwIfNoEntry: false })) invalid(`数据库存在未封存的旁车文件，不能恢复：${databasePath}${suffix}`)
  }
}

function checkHeader(identity: PathIdentity, standalone: boolean): void {
  const fd = openRead(identity, MAX_RECOVERY_BYTES)
  try {
    const header = Buffer.alloc(100)
    let offset = 0
    while (offset < header.length) {
      const count = readSync(fd, header, offset, header.length - offset, offset)
      if (count === 0) invalid('作品数据库头不完整。')
      offset += count
    }
    const rawSize = header.readUInt16BE(16)
    const pageSize = rawSize === 1 ? 65536 : rawSize
    if (!header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) || pageSize < 512 || pageSize > 65536 ||
        (pageSize & (pageSize - 1)) !== 0 || identity.stat.size % pageSize !== 0 ||
        (standalone && (header[18] !== 1 || header[19] !== 1))) invalid('作品数据库格式无效或仍依赖 WAL 日志，未进行恢复。')
    if (!sameContent(identity.stat, fstatSync(fd))) invalid('数据库在检查期间发生变化。')
    recheck(identity, true)
  } finally { closeSync(fd) }
}

function configureProbe(db: Database.Database): void {
  db.pragma('trusted_schema = OFF')
  db.pragma('query_only = ON')
  db.pragma('mmap_size = 0')
  db.pragma('cell_size_check = ON')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 2000')
}

interface SchemaObject { type: string; name: string; table: string; sql: string | null }
function normalizedSql(sql: string): string {
  // 保留字面量及运算符，只归一化空白、关键字大小写与 SQLite 更名时添加的已知表名引号。
  const tokens = sql.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|[a-zA-Z_][a-zA-Z_0-9]*|[0-9]+|[^\s]/g) ?? []
  if (tokens.at(-1) === ';') tokens.pop()
  return tokens.map((token) => /^"(?:ai_runs|ai_adoptions|ai_presets|ai_preset_history)"$/.test(token) ? token.slice(1, -1) :
    token.startsWith("'") || token.startsWith('"') ? token : token.toLowerCase()).join('\u001f')
}

function expectedSchema(version: number): Map<string, SchemaObject> {
  let ddl = BOOK_BASE_SCHEMA
  if (version >= 3) ddl += KNOWLEDGE_SCHEMA
  if (version >= 4) ddl += STORY_SCHEMA
  if (version >= 5) ddl += MEMORY_SCHEMA
  if (version === 6) {
    const memoryAdoptions = AI_SCHEMA.indexOf('CREATE TABLE ai_memory_adoptions')
    if (memoryAdoptions < 0) invalid('程序内置的旧版 AI 结构参照不可用。')
    ddl += AI_SCHEMA.slice(0, memoryAdoptions)
      .replace("'plan', 'continue', 'rewrite', 'summarize', 'extract'", "'plan', 'continue', 'rewrite'")
  } else if (version >= 7) ddl += AI_SCHEMA
  if (version >= 8) ddl += AI_MEMORY_TASK_SCHEMA
  if (version >= 9) ddl += AI_SUMMARY_SCHEMA
  if (version >= 10) ddl += MEMORY_VECTOR_SCHEMA
  if (version >= 11) ddl += AI_MEMORY_MAINTENANCE_SCHEMA
  if (version >= 12) ddl += NOTES_SCHEMA
  if (version >= 13) ddl += WORKBENCH_SCHEMA
  if (version === 14) ddl = BOOK_V14_SCHEMA
  if (version === 15) ddl = BOOK_V15_SCHEMA
  if (version === 16) ddl = BOOK_V16_SCHEMA
  if (version === 17) ddl = BOOK_V17_SCHEMA
  if (version === 18) ddl = BOOK_V18_SCHEMA
  if (version === 19) ddl = BOOK_V19_SCHEMA
  if (version === 20) ddl = BOOK_V20_SCHEMA
  if (version === 21) ddl = BOOK_V21_SCHEMA
  if (version === 22) ddl = BOOK_V22_SCHEMA
  if (version === 23) ddl = BOOK_V23_SCHEMA
  if (version === 24) ddl = BOOK_V24_SCHEMA
  // 新建和备份升级采用相同追加结构，避免格式版本增加后误用新字段验证旧恢复包。
  if (version === BOOK_SCHEMA_VERSION) ddl = BOOK_SCHEMA
  // 只执行程序自带 DDL 构造私有参照库，FTS5 影子表与隐式索引由同一 SQLite 版本生成。
  // 恢复包中的 SQL 只作为待比较的文本，绝不交给 exec 或用于创建数据库对象。
  const reference = new Database(':memory:')
  try {
    reference.pragma('trusted_schema = OFF')
    reference.exec(ddl)
    const rows = reference.prepare('SELECT type, name, tbl_name AS "table", sql FROM sqlite_schema').all() as SchemaObject[]
    return new Map(rows.map((row) => [row.name, { ...row, sql: row.sql === null ? null : normalizedSql(row.sql) }]))
  } finally { reference.close() }
}

function verifySchema(db: Database.Database, version: number): void {
  const expected = expectedSchema(version)
  const seen = new Set<string>()
  const statistics: Record<string, string> = {
    sqlite_stat1: 'CREATE TABLE sqlite_stat1(tbl,idx,stat)',
    sqlite_stat4: 'CREATE TABLE sqlite_stat4(tbl,idx,neq,nlt,ndlt,sample)',
  }
  const rows = db.prepare(`SELECT CASE WHEN length(CAST(type AS BLOB)) <= 16 THEN type END AS type,
    CASE WHEN length(CAST(name AS BLOB)) <= 256 THEN name END AS name,
    CASE WHEN length(CAST(tbl_name AS BLOB)) <= 256 THEN tbl_name END AS table_name,
    length(CAST(sql AS BLOB)) AS sql_bytes,
    CASE WHEN length(CAST(sql AS BLOB)) <= 131072 THEN sql END AS sql FROM sqlite_schema LIMIT ?`)
    .iterate(MAX_SCHEMA_OBJECTS + 1)
  let objects = 0
  let bytes = 0
  for (const value of rows) {
    const row = value as { type: string; name: string; table_name: string; sql: string | null; sql_bytes: number | null }
    objects += 1
    bytes += row.sql_bytes ?? 0
    if (typeof row.type !== 'string' || typeof row.name !== 'string' || typeof row.table_name !== 'string' ||
        objects > MAX_SCHEMA_OBJECTS || bytes > 2 * 1024 * 1024 || (row.sql_bytes ?? 0) > 131072 || seen.has(row.name)) invalid('作品数据库结构超过支持范围。')
    seen.add(row.name)
    const object = expected.get(row.name)
    if (!object) {
      const allowed = Object.hasOwn(statistics, row.name) ? statistics[row.name] : undefined
      if (!allowed || row.sql === null || row.type !== 'table' || row.table_name !== row.name || normalizedSql(row.sql) !== normalizedSql(allowed)) invalid(`作品包含不受支持的数据库对象：${row.name}`)
    } else if (row.type !== object.type || row.table_name !== object.table || (row.sql === null ? null : normalizedSql(row.sql)) !== object.sql) {
      invalid(`作品数据库对象与程序支持的结构不一致：${row.name}`)
    }
  }
  for (const name of expected.keys()) if (!seen.has(name)) invalid(`作品数据库缺少必要结构：${name}`)
}

function schemaVersion(db: Database.Database): number {
  const version = db.pragma('user_version', { simple: true })
  if (db.pragma('application_id', { simple: true }) !== BOOK_APPLICATION_ID || typeof version !== 'number' ||
      !Number.isInteger(version) || version < 2 || version > BOOK_SCHEMA_VERSION) invalid('恢复包的数据库身份或格式版本不受支持。')
  return version
}

function requireIdle(db: Database.Database, version: number): void {
  if ((version >= 6 && db.prepare("SELECT 1 FROM ai_runs WHERE state = 'running' LIMIT 1").get()) ||
      (version >= 10 && db.prepare("SELECT 1 FROM memory_vector_runs WHERE state = 'running' LIMIT 1").get()) ||
      (version >= 15 && db.prepare("SELECT 1 FROM generation_runs WHERE state = 'running' LIMIT 1").get())) {
    throw new DomainError({ code: 'FORBIDDEN', message: '作品仍有正在发送或生成的 AI／向量请求，请在请求结束或明确中断后重新导出。运行中的请求不能封存到恢复包。' })
  }
}

function isoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function requireCanonicalId(value: unknown): void {
  if (requiredId(value).toLowerCase() !== value) invalid('恢复包中的卷、章节或修订标识必须是规范的小写 UUID。')
}

function verifyChapterMetadata(db: Database.Database): void {
  // 外键完整只说明引用存在；身份和元数据还必须能被正常编辑入口接受。
  for (const table of ['volumes', 'chapters'] as const) {
    const entries = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 36 THEN id END AS id,
      CASE WHEN length(CAST(title AS BLOB)) <= 480 THEN title END AS title, position,
      CASE WHEN length(CAST(created_at AS BLOB)) <= 24 THEN created_at END AS createdAt,
      CASE WHEN length(CAST(updated_at AS BLOB)) <= 24 THEN updated_at END AS updatedAt FROM ${table}`).iterate()
    for (const value of entries) {
      const entry = value as { id: unknown; title: unknown; position: unknown; createdAt: unknown; updatedAt: unknown }
      requireCanonicalId(entry.id)
      if (requiredText(entry.title, '卷或章节名称', 120) !== entry.title || !isoTime(entry.createdAt) || !isoTime(entry.updatedAt)) {
        invalid('恢复包中的卷或章节资料无效。')
      }
      requiredInteger(entry.position, '卷或章节位置')
    }
  }
  const chapters = db.prepare(`SELECT
    CASE WHEN length(CAST(current_revision_id AS BLOB)) <= 36 THEN current_revision_id END AS currentId,
    CASE WHEN volume_id IS NULL OR length(CAST(volume_id AS BLOB)) <= 36 THEN volume_id ELSE '' END AS volumeId,
    CASE WHEN finalized_revision_id IS NULL OR length(CAST(finalized_revision_id AS BLOB)) <= 36 THEN finalized_revision_id ELSE '' END AS finalizedId,
    CASE WHEN finalized_at IS NULL OR length(CAST(finalized_at AS BLOB)) <= 24 THEN finalized_at ELSE '' END AS finalizedAt,
    CASE WHEN length(CAST(goal AS BLOB)) <= 40000 THEN goal END AS goal,
    CASE WHEN length(CAST(viewpoint AS BLOB)) <= 2000 THEN viewpoint END AS viewpoint,
    CASE WHEN length(CAST(notes AS BLOB)) <= 80000 THEN notes END AS notes, target_characters AS target FROM chapters`).iterate()
  for (const value of chapters) {
    const chapter = value as { currentId: unknown; volumeId: unknown; finalizedId: unknown; finalizedAt: unknown;
      goal: unknown; viewpoint: unknown; notes: unknown; target: unknown }
    requireCanonicalId(chapter.currentId)
    if (chapter.volumeId !== null) requireCanonicalId(chapter.volumeId)
    if (chapter.finalizedId !== null) requireCanonicalId(chapter.finalizedId)
    if (chapter.finalizedAt !== null && !isoTime(chapter.finalizedAt)) invalid('恢复包章节定稿时间无效。')
    optionalText(chapter.goal, '章节目标', 10_000)
    optionalText(chapter.viewpoint, '章节视角', 500)
    optionalText(chapter.notes, '章节备注', 20_000)
    if (chapter.target !== null) requiredInteger(chapter.target, '目标字数', 1_000_000)
  }
}

class RecoveryReadStudio extends StudioRepository {
  constructor(private readonly probe: Database.Database, private readonly snapshotBook: BookSummary) { super() }
  override getMemoryDatabase(bookId: string): Database.Database {
    if (bookId !== this.snapshotBook.id) invalid('恢复资料引用了其他作品。')
    return this.probe
  }
  override getNotesDatabase(bookId: string): { db: Database.Database; book: BookSummary } {
    return { db: this.getMemoryDatabase(bookId), book: this.snapshotBook }
  }
}

function verifyNonManuscriptData(db: Database.Database, version: number, book: BookSummary): void {
  const identifier = (name: string) => {
    if (!/^[a-z_][a-z_0-9]*$/.test(name)) invalid('程序内置恢复校验字段无效。')
    return `"${name}"`
  }
  const knowledgeRevision = (db.prepare('SELECT knowledge_revision FROM book_meta WHERE singleton = 1').get() as { knowledge_revision: unknown }).knowledge_revision
  requiredInteger(knowledgeRevision, '知识版本')
  const parsed = (value: unknown): unknown => {
    if (typeof value !== 'string') invalid('恢复资料缺少 JSON 内容。')
    return JSON.parse(value)
  }
  const fixedBlock = (chapterId: unknown, revisionId: unknown, blockId: unknown, quote?: unknown) => {
    requireCanonicalId(chapterId); requireCanonicalId(revisionId); requireCanonicalId(blockId)
    const source = db.prepare('SELECT document_json FROM chapter_revisions WHERE chapter_id = ? AND id = ?').get(chapterId, revisionId) as { document_json: string } | undefined
    if (!source) invalid('恢复资料的固定正文来源不存在。')
    const document = parseManuscript(JSON.parse(source.document_json))
    const block = document.content.find((item) => item.attrs.id === blockId)
    if (!block || (typeof quote === 'string' && !documentToText({ type: 'doc', content: [block] }).includes(quote))) invalid('恢复资料的段落或逐字引文无法核对。')
  }
  const disclosure = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(disclosure); return }
    const object = value as Record<string, unknown>
    if (object.state === 'located') fixedBlock(object.chapterId, object.revisionId, object.blockId)
    Object.values(object).forEach(disclosure)
  }
  // 结构和外键不能证明 TEXT 身份、历史 JSON 或业务字段可读；逐行校验，不一次载入全书。
  for (const table of expectedSchema(version).values()) {
    if (table.type !== 'table' || !table.sql || !table.sql.startsWith('create\u001ftable') || table.name.startsWith('sqlite_') ||
        table.name.startsWith('memory_chunks_fts') || ['book_meta', 'chapters', 'chapter_revisions', 'volumes'].includes(table.name)) continue
    const name = identifier(table.name)
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[]
    for (const column of columns.filter((item) => item.type.toUpperCase() === 'TEXT')) {
      if (db.prepare(`SELECT 1 FROM ${name} WHERE length(CAST(${identifier(column.name)} AS BLOB)) > 67108864 LIMIT 1`).get()) invalid(`恢复资料字段超限：${table.name}.${column.name}`)
    }
    const rows = db.prepare(`SELECT * FROM ${name}`).iterate() as Iterable<Record<string, unknown>>
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (value === null) continue
        if (key === 'id' || key.endsWith('_id')) {
          if (key === 'planning_after_id' && value === '') continue
          if (typeof value === 'string') requireCanonicalId(value)
          else requiredInteger(value, '资料标识')
        }
        if (key === 'book_id' && value !== book.id) invalid('恢复资料的作品身份不一致。')
        if (key.endsWith('_at') && !isoTime(value)) invalid(`恢复资料时间无效：${table.name}.${key}`)
        if (typeof value === 'number' && !Number.isSafeInteger(value)) invalid(`恢复资料整数越界：${table.name}.${key}`)
        if ((key.endsWith('_hash') || key === 'sha256') && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) invalid(`恢复资料摘要无效：${table.name}.${key}`)
        if (key.endsWith('_json')) parsed(value)
      }
      if (table.name === 'knowledge_items') {
        const fields = parseKnowledgeFields({ kind: row.kind, name: row.name, aliases: parsed(row.aliases_json), summary: row.summary,
          nature: row.nature, authorDecision: row.author_decision, freshness: row.freshness, conflictState: row.conflict_state,
          ...(row.character_profile_json == null ? {} : { characterProfile: parsed(row.character_profile_json) }) })
        if (version < 17 && fields.characterProfile?.abilities) invalid('旧格式恢复包不能包含六维能力数值。')
      } else if (table.name === 'knowledge_item_revisions') {
        const fields = parseKnowledgeFields(parsed(row.fields_json))
        if (version < 17 && fields.characterProfile?.abilities) invalid('旧格式恢复包不能包含六维能力数值。')
        requiredInteger(row.knowledge_revision, '知识历史版本', knowledgeRevision as number)
      } else if (table.name === 'story_records' || table.name === 'story_record_revisions') {
        const fields = parseStoryFields(parsed(row.fields_json), book.id)
        if (version < 17 && fields.kind === 'relation' && fields.layer !== undefined) invalid('旧格式恢复包不能包含关系层次。')
        if (fields.kind === 'event' && fields.appearanceCheck) {
          const check = fields.appearanceCheck
          if (version < 17 || !db.prepare('SELECT id FROM chapter_revisions WHERE chapter_id = ? AND id = ?').get(check.chapterId, check.revisionId)) invalid('整章出场核对的格式版本或正文修订不符。')
          for (const entityId of check.absentEntityIds) if (!db.prepare('SELECT id FROM knowledge_items WHERE id = ? AND book_id = ?').get(entityId, book.id)) invalid('整章出场核对引用了其他作品或不存在的实体。')
        }
        if (version < 17 && fields.kind === 'foreshadow' && 'targetNumber' in fields.plannedPayoff) invalid('旧格式恢复包不能包含未建卷章序号。')
        disclosure(fields)
        if (table.name === 'story_records') {
          const time = fields.kind === 'relation' ? fields.validFrom : fields.storyTime
          if (fields.kind !== row.kind || fields.title !== row.title || fields.description !== row.description ||
              (time.kind === 'unknown' ? null : time.order) !== row.story_order) invalid('恢复包故事字段与列表资料不一致。')
        } else requiredInteger(row.knowledge_revision, '故事历史版本', knowledgeRevision as number)
      } else if (table.name === 'knowledge_sources' || table.name === 'story_sources') {
        const source = parseKnowledgeSource({ sourceType: row.source_type, bookId: row.book_id, quote: row.quote,
          ...(row.source_type === 'chapter_text' ? { chapterId: row.chapter_id, revisionId: row.revision_id, blockId: row.block_id } : {}) }, book.id)
        if (source.sourceType === 'chapter_text') fixedBlock(source.chapterId, source.revisionId, source.blockId, source.quote)
      } else if (table.name === 'notes') {
        const fields = parseNoteFields({ category: row.category, title: row.title, body: row.body })
        if (fields.title !== row.title) invalid('恢复包笔记标题不符合存储格式。')
        requiredInteger(row.revision, '笔记版本', book.revision)
      } else if (table.name === 'note_materials') {
        if (parseNoteMaterial({ source: row.source, tags: [] }).source !== row.source) invalid('恢复包素材出处不符合存储格式。')
      } else if (table.name === 'note_tags') {
        if (parseNoteMaterial({ source: '', tags: [row.tag] }).tags[0] !== row.tag) invalid('恢复包素材标签不符合存储格式。')
      } else if (table.name === 'note_promotions') parseNoteFields(parsed(row.fields_json))
      else if (table.name === 'memory_vectors') {
        const vector = parseMemoryVectorValues(parsed(row.vector_json))
        const profile = db.prepare('SELECT dimensions FROM memory_vector_profiles WHERE profile_hash = ?').get(row.profile_hash) as { dimensions: number } | undefined
        const chunk = db.prepare('SELECT text FROM memory_chunks WHERE id = ?').get(row.chunk_id) as { text: string } | undefined
        const run = db.prepare('SELECT kind, state, profile_hash FROM memory_vector_runs WHERE id = ?').get(row.run_id) as { kind: string; state: string; profile_hash: string } | undefined
        const norm = vector.reduce((sum, value) => sum + value * value, 0)
        if (!profile || vector.length !== profile.dimensions || !Number.isFinite(norm) || Math.abs(norm - 1) > 0.0001 ||
            !chunk || createHash('sha256').update(chunk.text, 'utf8').digest('hex') !== row.text_hash ||
            !run || run.kind !== 'index' || run.state !== 'succeeded' || run.profile_hash !== row.profile_hash) invalid('恢复包向量缓存的来源、维度或归一化数值不一致。')
      }
    }
  }
  const studio = new RecoveryReadStudio(db, book)
  const memory = new MemoryRepository((id) => studio.getMemoryDatabase(id))
  const search = new MemorySearchRepository((id) => studio.getMemoryDatabase(id), (input) => memory.status(input))
  const ai = new AiRepository(studio, search)
  const vectors = new MemoryVectorRepository((id) => studio.getMemoryDatabase(id), search)
  const notes = new NotesRepository(studio)
  const tasks = new AiMemoryTaskRepository(studio, ai)
  const summaries = new AiSummaryRepository(studio, ai)
  const eachId = (table: string, visit: (id: string) => void) => {
    let after = ''
    while (true) {
      const rows = db.prepare(`SELECT id FROM ${identifier(table)} WHERE id > ? ORDER BY id LIMIT 128`).all(after) as { id: string }[]
      for (const row of rows) visit(row.id)
      if (rows.length < 128) return
      after = rows.at(-1)!.id
    }
  }
  const pages = (read: (afterOrdinal: number) => { nextAfterOrdinal: number | null }) => {
    let after = 0
    while (true) {
      const page = read(after)
      if (page.nextAfterOrdinal === null) return
      if (!Number.isSafeInteger(page.nextAfterOrdinal) || page.nextAfterOrdinal <= after) invalid('恢复资料分页序号无效。')
      after = page.nextAfterOrdinal
    }
  }
  // 复用正常只读入口的上下文、采用审计和笔记转换校验；query_only 始终开启。
  if (version >= 6) {
    ai.listConnections({ bookId: book.id })
    eachId('ai_runs', (runId) => { ai.get({ bookId: book.id, runId }) })
  }
  if (version >= 8) eachId('ai_memory_tasks', (taskId) => pages((afterOrdinal) => tasks.get({ bookId: book.id, taskId, afterOrdinal })))
  if (version >= 9) eachId('ai_summary_tasks', (taskId) => pages((afterOrdinal) => summaries.get({ bookId: book.id, taskId, afterOrdinal })))
  if (version >= 10) eachId('memory_vector_runs', (runId) => { vectors.get({ bookId: book.id, runId }) })
  if (version >= 13) validateWorkbenchDatabase(db, book.id)
  if (version >= 14) {
    validateCalendarDatabase(db, book.id)
    validateAiPresetsDatabase(db, book.id)
    validateMediaDatabase(db, book.id)
  }
  if (version >= 15) new GenerationRepository(studio).validateBook(book.id)
  if (version >= 16) new LivingRepository(studio, ai).validateBook(book.id)
  if (version >= 17) new ForgeRepository(studio, ai).validateBook(book.id)
  if (version >= 18) validateWeaveDatabase(db, book.id)
  if (version >= 19) validateRealmDatabase(db, book.id)
  if (version >= 23) validateNoteThumbnails(db, book.id)
  if (version >= 24) validateForeshadowThumbnails(db, book.id)
  if (version >= 12) eachId('notes', (id) => { notes.get({ bookId: book.id, id }) })
}

function readSnapshot(db: Database.Database): Snapshot {
  const version = schemaVersion(db)
  if (db.pragma('quick_check(1)', { simple: true }) !== 'ok') invalid('作品数据库快速完整性检查未通过。')
  verifySchema(db, version)
  if (db.pragma('integrity_check(1)', { simple: true }) !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) invalid('作品数据库完整性或外键检查未通过。')
  const rows = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 36 THEN id END AS id,
    CASE WHEN length(CAST(title AS BLOB)) <= 480 THEN title END AS title,
    CASE WHEN length(CAST(genre AS BLOB)) <= 480 THEN genre END AS genre,
    CASE WHEN length(CAST(synopsis AS BLOB)) <= 80000 THEN synopsis END AS synopsis,
    CASE WHEN archived_at IS NULL OR length(CAST(archived_at AS BLOB)) <= 24 THEN archived_at ELSE '' END AS archivedAt, revision,
    CASE WHEN length(CAST(created_at AS BLOB)) <= 24 THEN created_at END AS createdAt,
    CASE WHEN length(CAST(updated_at AS BLOB)) <= 24 THEN updated_at END AS updatedAt
    ${version >= 15 ? ', lifecycle' : ''} FROM book_meta LIMIT 2`).all() as BookSummary[]
  const row = rows[0]
  if (rows.length !== 1 || !row || requiredId(row.id).toLowerCase() !== row.id || !row.title || row.title !== row.title.trim() || row.title.length > 120 ||
      typeof row.genre !== 'string' || row.genre.length > 120 || typeof row.synopsis !== 'string' || row.synopsis.length > 20_000 ||
      !isoTime(row.createdAt) || !isoTime(row.updatedAt) || (row.archivedAt !== null && !isoTime(row.archivedAt))) invalid('恢复包作品资料无效。')
  requiredInteger(row.revision, '作品版本')
  if (version >= 15 && !['kickstarting', 'active', 'finished'].includes(row.lifecycle ?? '')) invalid('恢复包作品生命周期无效。')
  const book: BookSummary = { id: row.id, title: row.title, genre: row.genre, synopsis: row.synopsis, archivedAt: row.archivedAt,
    revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(version >= 15 ? { lifecycle: row.lifecycle } : {}) }
  const count = (table: 'chapters' | 'chapter_revisions' | 'volumes', maximum = Number.MAX_SAFE_INTEGER): number => {
    const result = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    return requiredInteger(result.count, '作品记录数', maximum)
  }
  const chapterCount = count('chapters', 20_000)
  const revisionCount = count('chapter_revisions')
  count('volumes', 1_000)
  if (revisionCount < chapterCount) invalid('恢复包缺少正文历史。')
  verifyChapterMetadata(db)
  requireIdle(db, version)
  const sources: BookRecoveryFile[] = []
  const sourceRows = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 36 THEN id END AS id,
    CASE WHEN length(CAST(relative_path AS BLOB)) <= 128 THEN relative_path END AS path,
    CASE WHEN length(CAST(sha256 AS BLOB)) <= 64 THEN sha256 END AS sha256, byte_length AS bytes
    FROM import_sources ORDER BY id LIMIT ?`).iterate(MAX_RECOVERY_FILES)
  for (const value of sourceRows) {
    const source = value as BookRecoveryFile & { id: string }
    if (sources.length >= MAX_RECOVERY_FILES - 1 || requiredId(source.id).toLowerCase() !== source.id ||
        source.path !== `sources/${source.id}.original` || !/^[a-f0-9]{64}$/.test(source.sha256)) invalid('导入原件登记信息无效或超过支持数量。')
    requiredInteger(source.bytes, '导入原件字节数', MAX_SOURCE_BYTES)
    sources.push({ path: source.path, bytes: source.bytes, sha256: source.sha256 })
  }
  // SQLite 完整性检查不核对正文摘要；逐个历史版本校验三种表示，并限制单次读取内存。
  const revisions = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 36 THEN id END AS id,
    CASE WHEN length(CAST(chapter_id AS BLOB)) <= 36 THEN chapter_id END AS chapterId,
    CASE WHEN parent_revision_id IS NULL OR length(CAST(parent_revision_id AS BLOB)) <= 36 THEN parent_revision_id ELSE '' END AS parentId,
    CASE WHEN restored_from_revision_id IS NULL OR length(CAST(restored_from_revision_id AS BLOB)) <= 36 THEN restored_from_revision_id ELSE '' END AS restoredId,
    CASE WHEN length(CAST(created_at AS BLOB)) <= 24 THEN created_at END AS createdAt, sequence,
    CASE WHEN length(CAST(document_json AS BLOB)) <= 67108864 THEN document_json END AS document_json,
    CASE WHEN length(CAST(plain_text AS BLOB)) <= ? THEN plain_text END AS plain_text,
    CASE WHEN length(CAST(content_hash AS BLOB)) <= 64 THEN content_hash END AS content_hash, character_count
    FROM chapter_revisions`).iterate(MAX_CHAPTER_LENGTH * 4)
  for (const value of revisions) {
    const revision = value as { id: unknown; chapterId: unknown; parentId: unknown; restoredId: unknown; createdAt: unknown; sequence: unknown;
      document_json: string | null; plain_text: string; content_hash: string; character_count: number }
    requireCanonicalId(revision.id)
    requireCanonicalId(revision.chapterId)
    if (revision.parentId !== null) requireCanonicalId(revision.parentId)
    if (revision.restoredId !== null) requireCanonicalId(revision.restoredId)
    if (!isoTime(revision.createdAt) || requiredInteger(revision.sequence, '正文历史序号') < 1) invalid('恢复包正文历史资料无效。')
    if (typeof revision.document_json !== 'string' || !/^[a-f0-9]{64}$/.test(revision.content_hash) ||
        createHash('sha256').update(revision.document_json, 'utf8').digest('hex') !== revision.content_hash) invalid('恢复包存在损坏的正文历史摘要。')
    const document = parseManuscript(JSON.parse(revision.document_json))
    if (documentToText(document) !== revision.plain_text || countCharacters(revision.plain_text) !== revision.character_count) invalid('恢复包正文历史与纯文本不一致。')
  }
  verifyNonManuscriptData(db, version, book)
  return { book, schemaVersion: version, chapterCount, revisionCount, sources }
}

function inspectDatabase(identity: PathIdentity): Snapshot {
  noSidecars(identity.path)
  checkHeader(identity, true)
  const db = new Database(identity.path, { readonly: true, fileMustExist: true, timeout: 2000 })
  try { configureProbe(db); return readSnapshot(db) }
  finally { db.close(); noSidecars(identity.path); recheck(identity, true) }
}

function matchSnapshot(snapshot: Snapshot, manifest: BookRecoveryManifest): void {
  if (JSON.stringify(snapshot.book) !== JSON.stringify(manifest.book) || snapshot.schemaVersion !== manifest.schemaVersion ||
      snapshot.chapterCount !== manifest.chapterCount || snapshot.revisionCount !== manifest.revisionCount ||
      snapshot.sources.length !== manifest.files.length - 1) invalid('恢复包清单与数据库作品、版本或记录数不一致。')
  const expected = new Map(manifest.files.slice(1).map((file) => [file.path, file]))
  for (const file of snapshot.sources) {
    const recorded = expected.get(file.path)
    if (!recorded) invalid(`恢复包缺少已登记的导入原件：${file.path}`)
    matchFile(file, recorded)
  }
}

function checkDirectoryEntries(directory: PathIdentity, expected: ReadonlyMap<string, boolean>): void {
  recheck(directory)
  const handle = opendirSync(directory.path)
  const seen = new Set<string>()
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      const isDirectory = expected.get(entry.name)
      if (isDirectory === undefined || seen.has(entry.name) || entry.isSymbolicLink() ||
          (isDirectory ? !entry.isDirectory() : !entry.isFile())) invalid(`恢复包包含未知路径或异常目录项：${join(directory.path, entry.name)}`)
      seen.add(entry.name)
    }
  } finally { handle.closeSync() }
  if (seen.size !== expected.size) invalid(`恢复包文件不完整：${directory.path}`)
  recheck(directory)
}

function checkPackageEntries(directory: PathIdentity, manifest: BookRecoveryManifest, markers: readonly string[] = []): PathIdentity[] {
  const expected = new Map<string, boolean>([[MANIFEST_NAME, false], ['book.sqlite', false]])
  for (const marker of markers) expected.set(marker, false)
  if (manifest.files.length > 1) expected.set('sources', true)
  checkDirectoryEntries(directory, expected)
  const guards = [directory]
  if (manifest.files.length > 1) {
    const sources = checkedPath(join(directory.path, 'sources'), true)
    checkDirectoryEntries(sources, new Map(manifest.files.slice(1).map((file) => [file.path.slice('sources/'.length), false])))
    guards.push(sources)
  }
  return guards
}

function inspectPackage(packagePath: string, expectedHash?: string, markers: readonly string[] = []): CheckedPackage {
  const directory = checkedPath(packagePath, true)
  const manifestIdentity = checkedPath(join(directory.path, MANIFEST_NAME), false)
  const manifestBytes = readBounded(manifestIdentity, MAX_RECOVERY_MANIFEST_BYTES)
  const manifestHash = createHash('sha256').update(manifestBytes).digest('hex')
  if (expectedHash !== undefined && manifestHash !== expectedHash) invalid('恢复包清单在预览后发生变化，请重新选择。')
  const manifest = parseBookRecoveryManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)))
  const guards = checkPackageEntries(directory, manifest, markers)
  const files: PathIdentity[] = []
  for (const file of manifest.files) {
    const identity = checkedPath(join(directory.path, file.path), false)
    if (identity.stat.size !== file.bytes) invalid(`恢复包文件长度与清单不一致：${file.path}`)
    matchFile(streamFile(identity, file.path, file.path === 'book.sqlite' ? MAX_RECOVERY_BYTES : MAX_SOURCE_BYTES, guards), file)
    files.push(identity)
  }
  matchSnapshot(inspectDatabase(files[0]!), manifest)
  checkPackageEntries(directory, manifest, markers)
  recheck(manifestIdentity, true)
  for (const identity of files) recheck(identity, true)
  return { manifest, manifestBytes, manifestHash, directory, guards, files }
}

function totalBytes(manifest: BookRecoveryManifest): number { return manifest.files.reduce((sum, file) => sum + file.bytes, 0) }

function recoveryMarker(manifest: BookRecoveryManifest, manifestHash: string): Buffer {
  return Buffer.from(JSON.stringify({ format: 'storyweave-recovery-commit', bookId: manifest.book.id,
    packageId: manifest.packageId, manifestHash }) + '\n', 'utf8')
}

function verifyOrWrite(path: string, bytes: Buffer, guards: readonly PathIdentity[]): PathIdentity {
  if (!lstatSync(path, { throwIfNoEntry: false })) return writeNew(path, bytes, guards)
  checkGuards(guards)
  const identity = checkedPath(path, false)
  if (!readBounded(identity, Math.max(bytes.length, 1024)).equals(bytes)) invalid(`已有恢复记录与本次来源不符，未覆盖：${path}`)
  return identity
}

function inspectRestoreTarget(booksPath: string, checked: CheckedPackage, registered: boolean): Pick<BookRecoveryPreview, 'targetState' | 'targetMessage' | 'conflict'> {
  const target = join(booksPath, checked.manifest.book.id)
  if (registered) return { targetState: 'conflict', conflict: true, targetMessage: '同一作品已经登记，请打开现有作品，或选择其他作品库恢复。' }
  if (!lstatSync(target, { throwIfNoEntry: false })) return { targetState: 'new', conflict: false, targetMessage: '将在目标书库建立新作品目录。' }
  try {
    const directory = checkedPath(target, true)
    const pendingPath = join(target, BOOK_RECOVERY_PENDING)
    if (!lstatSync(pendingPath, { throwIfNoEntry: false })) return { targetState: 'conflict', conflict: true, targetMessage: '同名目录没有可核对的恢复来源记录，请保留目录并选择其他作品库。' }
    const marker = recoveryMarker(checked.manifest, checked.manifestHash)
    if (!readBounded(checkedPath(pendingPath, false), 1024).equals(marker)) invalid('目标目录属于其他恢复来源。')
    const allowed = new Set([BOOK_RECOVERY_PENDING, BOOK_RECOVERY_COMPLETE, MANIFEST_NAME, 'book.sqlite', ...(checked.manifest.files.length > 1 ? ['sources'] : [])])
    const checkEntries = (path: string, names: ReadonlySet<string>) => {
      const entries = opendirSync(path)
      try {
        for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
          if (!names.has(entry.name) || entry.isSymbolicLink()) invalid('恢复目录中存在来源不明的项目。')
        }
      } finally { entries.closeSync() }
    }
    checkEntries(target, allowed)
    const sources = join(target, 'sources')
    if (lstatSync(sources, { throwIfNoEntry: false })) {
      checkedPath(sources, true)
      checkEntries(sources, new Set(checked.manifest.files.slice(1).map((file) => file.path.slice('sources/'.length))))
    }
    // 续办只接受原清单的完整文件；部分写入无法在不覆盖的前提下修复，应改用新目标。
    for (const file of checked.manifest.files) {
      const path = join(target, file.path)
      if (lstatSync(path, { throwIfNoEntry: false })) matchFile(streamFile(checkedPath(path, false), file.path, file.bytes, [directory]), file)
    }
    for (const [name, bytes] of [[MANIFEST_NAME, checked.manifestBytes], [BOOK_RECOVERY_COMPLETE, marker]] as const) {
      const path = join(target, name)
      if (lstatSync(path, { throwIfNoEntry: false }) && !readBounded(checkedPath(path, false), Math.max(bytes.length, 1024)).equals(bytes)) invalid('恢复目录中的清单或完成记录不符。')
    }
    recheck(directory)
    return { targetState: 'resumable', conflict: false, targetMessage: '发现同一恢复包的未登记目录。已有文件摘要一致，可确认续办；仅补齐缺失文件并完成登记。' }
  } catch {
    return { targetState: 'incomplete', conflict: true, targetMessage: '发现未完成或不一致的恢复目录，已有内容将保留。为避免覆盖部分文件，请选择其他作品库重新恢复。' }
  }
}

export class BookRecoveryRepository {
  private prepared: PreparedPackage | null = null
  private generation = 0
  private exporting = false

  constructor(private readonly studio: StudioRepository) {}

  clear(): void { this.prepared = null; this.generation += 1 }

  async export(input: BookRecoveryExportServiceInput): Promise<BookRecoveryExportReceipt> {
    if (this.exporting) throw new DomainError({ code: 'WORKSPACE_BUSY', message: '已有完整作品导出正在执行，请等待其完成。' })
    this.exporting = true
    let retained: string | undefined
    try {
      const data = parseBookRecoveryExportServiceInput(input)
      const requestGeneration = this.generation
      const source = this.studio.getBookRecoverySource(data.bookId, data.expectedBookRevision)
      const root = checkedPath(source.rootPath, true)
      const books = checkedPath(join(source.rootPath, 'books'), true)
      const bookDirectory = checkedPath(source.bookPath, true)
      const sourceDatabase = checkedPath(join(source.bookPath, 'book.sqlite'), false)
      const parent = checkedPath(data.directoryPath, true)
      const version = schemaVersion(source.db)
      requireIdle(source.db, version)
      const pageSize = source.db.pragma('page_size', { simple: true }) as number
      const pages = source.db.pragma('page_count', { simple: true }) as number
      if (!Number.isSafeInteger(pages * pageSize) || pages <= 0 || pageSize <= 0 || pages * pageSize > MAX_RECOVERY_BYTES) invalid('作品数据库超过 8 GiB 恢复包上限。')
      const packageId = randomUUID()
      const createdAt = new Date().toISOString()
      const packagePath = join(parent.path, `storyweave-recovery-${packageId}`)
      requireExportParent(parent)
      mkdirSync(packagePath)
      retained = packagePath
      const directory = checkedPath(packagePath, true)
      const guards = [root, books, bookDirectory, parent, directory]
      const databasePath = join(packagePath, 'book.sqlite')
      // backup 会根据目标是否已存在决定失败时是否移除文件；wx 预建的专属文件始终保留。
      const fd = openSync(databasePath, 'wx')
      let snapshot: Snapshot
      try {
        const identity = fstatSync(fd)
        fsyncSync(fd)
        const assertBackup = () => {
          checkGuards(guards)
          recheck(sourceDatabase)
          if (!sameIdentity(identity, checkedPath(databasePath, false).stat)) invalid('备份目标文件身份发生变化。')
          if (this.generation !== requestGeneration) invalid('书库会话已改变，本次导出未封存。')
        }
        assertBackup()
        const progress = await source.db.backup(databasePath, { progress: ({ totalPages }) => {
          assertBackup()
          if (totalPages * pageSize > MAX_RECOVERY_BYTES) invalid('作品数据库在备份期间超过恢复包上限。')
          return 128
        } })
        if (progress.remainingPages !== 0 || progress.totalPages <= 0) invalid('作品数据库在线备份未完成。')
        assertBackup()
        const before = checkedPath(databasePath, false)
        noSidecars(databasePath)
        checkHeader(before, false)
        const probe = new Database(databasePath, { fileMustExist: true, timeout: 2000 })
        try {
          configureProbe(probe)
          snapshot = readSnapshot(probe)
          if (snapshot.schemaVersion !== version || JSON.stringify(snapshot.book) !== JSON.stringify(source.book)) invalid('备份作品版本与导出基线不一致，请重新导出。')
          // 仅对本次专属副本封存日志；源作品继续沿用自己的 WAL 连接。
          probe.pragma('query_only = OFF')
          if (probe.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') invalid('备份数据库未能独立封存。')
          probe.pragma('query_only = ON')
        } finally { probe.close() }
        assertBackup()
        noSidecars(databasePath)
        fsyncSync(fd)
      } finally { closeSync(fd) }
      const databaseIdentity = checkedPath(databasePath, false)
      checkHeader(databaseIdentity, true)
      const files = [streamFile(databaseIdentity, 'book.sqlite', MAX_RECOVERY_BYTES, guards)]
      let size = files[0]!.bytes
      const originalGuards = [...guards]
      if (snapshot.sources.length > 0) {
        originalGuards.push(checkedPath(join(source.bookPath, 'sources'), true))
        const targetSources = join(packagePath, 'sources')
        mkdirSync(targetSources)
        guards.push(checkedPath(targetSources, true))
      }
      for (const expected of snapshot.sources) {
        size += expected.bytes
        if (size > MAX_RECOVERY_BYTES) invalid('数据库与导入原件合计超过 8 GiB 恢复包上限。')
        const original = checkedPath(join(source.bookPath, expected.path), false)
        if (original.stat.size !== expected.bytes) invalid(`导入原件长度与登记不一致：${expected.path}`)
        const copied = streamFile(original, expected.path, MAX_SOURCE_BYTES, [...originalGuards, ...guards], join(packagePath, expected.path))
        matchFile(copied, expected)
        files.push(copied)
      }
      checkGuards(guards)
      const current = this.studio.getBookRecoverySource(data.bookId, data.expectedBookRevision)
      if (this.generation !== requestGeneration || current.generation !== source.generation || current.db !== source.db ||
          !samePath(current.rootPath, source.rootPath) || schemaVersion(current.db) !== version) invalid('作品或书库在导出期间发生变化，请重新导出。')
      requireIdle(current.db, version)
      const manifest = parseBookRecoveryManifest({ format: 'storyweave-book-recovery', version: 1, packageId, createdAt,
        book: snapshot.book, schemaVersion: snapshot.schemaVersion, chapterCount: snapshot.chapterCount, revisionCount: snapshot.revisionCount, files })
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
      if (manifestBytes.length > MAX_RECOVERY_MANIFEST_BYTES) invalid('恢复包清单超过 8 MiB 上限。')
      // 清单最后发布；没有清单的残件不可预览，也不可登记为完成的恢复包。
      writeNew(join(packagePath, MANIFEST_NAME), manifestBytes, guards)
      const manifestHash = createHash('sha256').update(manifestBytes).digest('hex')
      const checked = inspectPackage(packagePath, manifestHash)
      return { packageId, packagePath, manifestHash, createdAt, bookId: snapshot.book.id, bookRevision: snapshot.book.revision,
        schemaVersion: snapshot.schemaVersion, chapterCount: snapshot.chapterCount, revisionCount: snapshot.revisionCount,
        sourceCount: snapshot.sources.length, totalBytes: totalBytes(checked.manifest) }
    } catch (error) { throw failure(error, '导出恢复包', retained) }
    finally { this.exporting = false }
  }

  prepare(input: BookRecoveryPrepareInput): BookRecoveryPreview {
    this.prepared = null
    try {
      const data = parseBookRecoveryPrepareInput(input)
      const workspace = this.studio.getBookRecoveryWorkspace()
      const root = checkedPath(workspace.rootPath, true)
      const books = checkedPath(workspace.booksPath, true)
      const checked = inspectPackage(data.packagePath)
      const manifest = checked.manifest
      const current = this.studio.getBookRecoveryWorkspace(manifest.book.id)
      checkGuards([root, books])
      if (workspace.generation !== current.generation || !samePath(workspace.rootPath, current.rootPath)) invalid('预览期间书库发生变化，请重新预览。')
      const target = inspectRestoreTarget(workspace.booksPath, checked, this.studio.getWorkspace().books.some((book) => book.id === manifest.book.id))
      const preview: BookRecoveryPreview = { token: randomUUID(), packageId: manifest.packageId, manifestHash: checked.manifestHash,
        createdAt: manifest.createdAt, book: manifest.book, schemaVersion: manifest.schemaVersion,
        chapterCount: manifest.chapterCount, revisionCount: manifest.revisionCount, sourceCount: manifest.files.length - 1,
        totalBytes: totalBytes(manifest), packagePath: checked.directory.path, targetRoot: workspace.rootPath, ...target }
      this.prepared = { preview, expiresAt: Date.now() + PREVIEW_TTL, generation: workspace.generation, root, books, checked }
      return { ...preview, book: { ...preview.book } }
    } catch (error) { throw failure(error, '预览恢复包') }
  }

  restore(input: BookRecoveryRestoreInput): BookRecoveryRestoreReceipt {
    const prepared = this.prepared
    this.prepared = null
    let retained: string | undefined
    try {
      const data = parseBookRecoveryRestoreInput(input)
      if (!prepared || prepared.expiresAt <= Date.now() || data.token !== prepared.preview.token ||
          data.packageId !== prepared.preview.packageId || data.manifestHash !== prepared.preview.manifestHash) {
        throw new DomainError({ code: 'FORBIDDEN', message: '恢复确认已过期或已使用，请重新预览恢复包。' })
      }
      const workspace = this.studio.getBookRecoveryWorkspace(prepared.preview.book.id)
      if (workspace.generation !== prepared.generation || !samePath(workspace.rootPath, prepared.preview.targetRoot)) invalid('当前书库与预览时不同，请重新预览恢复包。')
      if (prepared.preview.conflict || Boolean(data.resume) !== (prepared.preview.targetState === 'resumable')) throw new DomainError({ code: 'REVISION_CONFLICT', message: '请重新核对恢复目标，并明确确认新建或续办恢复。' })
      checkGuards([prepared.root, prepared.books, ...prepared.checked.guards])
      for (const file of prepared.checked.files) recheck(file, true)
      // 预览令牌只证明作者的选择；实际复制前重新读取全部字节，不信任旧校验结果。
      const checked = inspectPackage(prepared.preview.packagePath, prepared.preview.manifestHash)
      const manifest = checked.manifest
      if (manifest.packageId !== data.packageId || JSON.stringify(manifest) !== JSON.stringify(prepared.checked.manifest)) invalid('恢复包在预览后发生变化。')
      const targetState = inspectRestoreTarget(workspace.booksPath, checked, this.studio.getWorkspace().books.some((book) => book.id === manifest.book.id))
      if (targetState.conflict || targetState.targetState !== prepared.preview.targetState) invalid('恢复目标在预览后发生变化，请重新预览；已有文件均保留。')
      const target = join(workspace.booksPath, manifest.book.id)
      checkGuards([prepared.root, prepared.books])
      if (targetState.targetState === 'new') mkdirSync(target)
      retained = target
      const directory = checkedPath(target, true)
      const guards = [prepared.root, prepared.books, directory]
      const marker = recoveryMarker(manifest, checked.manifestHash)
      const pending = verifyOrWrite(join(target, BOOK_RECOVERY_PENDING), marker, guards)
      if (manifest.files.length > 1) {
        if (!lstatSync(join(target, 'sources'), { throwIfNoEntry: false })) mkdirSync(join(target, 'sources'))
        guards.push(checkedPath(join(target, 'sources'), true))
      }
      for (let index = 0; index < manifest.files.length; index += 1) {
        const file = manifest.files[index]!
        const destination = join(target, file.path)
        if (lstatSync(destination, { throwIfNoEntry: false })) {
          matchFile(streamFile(checkedPath(destination, false), file.path, file.bytes, guards), file)
          continue
        }
        const copied = streamFile(checked.files[index]!, file.path, file.path === 'book.sqlite' ? MAX_RECOVERY_BYTES : MAX_SOURCE_BYTES,
          [...checked.guards, ...guards], destination)
        matchFile(copied, file)
      }
      verifyOrWrite(join(target, MANIFEST_NAME), checked.manifestBytes, guards)
      const markers = lstatSync(join(target, BOOK_RECOVERY_COMPLETE), { throwIfNoEntry: false })
        ? [BOOK_RECOVERY_PENDING, BOOK_RECOVERY_COMPLETE] : [BOOK_RECOVERY_PENDING]
      const verified = inspectPackage(target, checked.manifestHash, markers)
      if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) invalid('恢复目标与已确认的恢复包不一致。')
      recheck(pending, true)
      checkGuards(guards)
      // 完成标记只追加一次；任何更早的失败都由打开和孤立作品登记入口拒绝接管。
      verifyOrWrite(join(target, BOOK_RECOVERY_COMPLETE), marker, guards)
      const book = this.studio.registerRecoveredBook(manifest.book, workspace.rootPath, workspace.generation)
      return { packageId: manifest.packageId, manifestHash: checked.manifestHash, targetRoot: workspace.rootPath, book,
        chapterCount: manifest.chapterCount, revisionCount: manifest.revisionCount, sourceCount: manifest.files.length - 1 }
    } catch (error) { throw failure(error, '恢复作品', retained) }
  }
}
