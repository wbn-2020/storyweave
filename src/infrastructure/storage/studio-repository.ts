import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import Database from 'better-sqlite3'
import {
  DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, parseCreateBookInput,
  type BookInput, type BookSnapshot, type BookSummary, type ChapterInput,
  type ChapterSnapshot, type ChapterSummary, type CreateBookInput,
  type CreateChapterInput, type SaveChapterInput, type SaveChapterOutput,
  type WorkspaceSnapshot, type UpdateBookInput, type CreateVolumeInput, type RenameVolumeInput,
  type ReorderVolumesInput, type ReorderChaptersInput, type UpdateChapterInput, type FinalizeChapterInput,
  type ListRevisionsInput, type RevisionInput, type RestoreRevisionInput, type RevisionPage,
  type RevisionSnapshot, type RevisionSummary, type VolumeSummary, type OrphanScan,
  type TextEncoding, type ExportBookInput, type ChapterStatus, type DraftImportData,
} from '../../contracts/api'
import { countCharacters, documentToText, emptyDocument, parseManuscript, type ManuscriptDocument } from '../../contracts/manuscript'
import { MAX_DRAFT_FILE_BYTES, parseDraftFile } from '../../contracts/draft'
import { MAX_KNOWLEDGE_SOURCES, parseKnowledgeSource, parseKnowledgeStatusInput, parseUpgradeKnowledgeInput, type KnowledgeSourceInput, type KnowledgeStatus, type SourceValidity, type UpgradeKnowledgeInput } from '../../contracts/knowledge'
import { KNOWLEDGE_SCHEMA } from '../knowledge/schema'
import { STORY_SCHEMA } from '../story/schema'
import { FORESHADOW_THUMBNAIL_SCHEMA } from '../story/thumbnail-schema'
import { MEMORY_SCHEMA } from '../memory/schema'
import { AI_SCHEMA, AI_V6_TO_V7_SCHEMA } from '../ai/schema'
import { GENERATION_BOOK_UPGRADE, STUDIO_GENERATION_SCHEMA } from '../ai/generation-schema'
import { MEMORY_VECTOR_SCHEMA } from '../memory/vector-schema'
import { AI_MEMORY_MAINTENANCE_SCHEMA, AI_MEMORY_TASK_SCHEMA } from '../ai/memory-task-schema'
import { AI_SUMMARY_SCHEMA } from '../ai/summary-schema'
import { NOTES_SCHEMA, NOTE_CHAPTER_SCHEMA, NOTE_MATERIAL_SCHEMA, NOTE_THUMBNAIL_SCHEMA } from '../notes/schema'
import { INSPIRATION_APPLICATION_ID, INSPIRATION_SCHEMA, INSPIRATION_THUMBNAIL_SCHEMA, WORKBENCH_SCHEMA } from '../workbench/schema'
import { INSPIRATION_THUMBNAIL_SCHEMA_VERSION, parseUpgradeInspirationsInput, type UpgradeInspirationsInput, type UpgradeInspirationsReceipt } from '../../contracts/inspiration-thumbnail'
import { CHARACTER_PROFILE_SCHEMA } from '../knowledge/schema'
import { CALENDAR_SCHEMA } from '../workbench/calendar-schema'
import { AI_PRESETS_V14_SCHEMA, AI_PRESETS_V25_UPGRADE } from '../ai/preset-schema'
import { validateAiPresetsDatabase } from '../ai/preset-repository'
import { MEDIA_SCHEMA, SCENE_MEDIA_SCHEMA } from '../workbench/media-schema'
import { LIVING_SCHEMA } from '../workbench/living-schema'
import { FORGE_SCHEMA } from '../workbench/forge-schema'
import { WEAVE_SCHEMA } from '../workbench/weave-schema'
import { REALM_SCHEMA } from '../workbench/realm-schema'
import { recordWritingActivity } from '../workbench/writing-activity'
import type { WritingDay } from '../../contracts/workbench'
import { MAX_IMPORT_BYTES, renderTextExport } from '../text/manuscript-text'
import { BOOK_APPLICATION_ID, BOOK_SCHEMA, BOOK_SCHEMA_VERSION, STUDIO_APPLICATION_ID, STUDIO_SCHEMA, STUDIO_SCHEMA_VERSION } from './schema'
import { storageError } from './storage-error'

interface BookRow {
  id: string; title: string; genre: string; synopsis: string; archived_at: string | null
  revision: number; created_at: string; updated_at: string
  lifecycle?: 'kickstarting' | 'active' | 'finished'
}
interface ChapterRow {
  id: string; title: string; position: number; current_revision_id: string
  character_count: number; updated_at: string
  volume_id: string | null; goal: string; viewpoint: string; target_characters: number | null
  notes: string; status: ChapterStatus; finalized_revision_id: string | null; finalized_at: string | null
}
interface RevisionRow extends ChapterRow {
  document_json: string; plain_text: string; content_hash: string
}
interface OpenBook { id: string; db: Database.Database }
interface KnowledgeSourceState { validity: SourceValidity; referenceState?: 'current' | 'historical' }
interface HistoryRow {
  id: string; sequence: number; parent_revision_id: string | null; restored_from_revision_id: string | null
  reason: RevisionSummary['reason']; character_count: number; created_at: string
  document_json: string; plain_text: string; content_hash: string
}
export interface ImportBookData {
  title: string; sourceName: string; encoding: TextEncoding; sourceBytes: Uint8Array
  chapters: { title: string; document: ManuscriptDocument }[]
}

const MAX_BOOKS = 1_000
const MAX_CHAPTERS = 20_000
const MAX_VOLUMES = 1_000
const BOOK_COLUMNS = 'id, title, genre, synopsis, archived_at, revision, created_at, updated_at'
const CHAPTER_COLUMNS = `c.id, c.title, c.position, c.current_revision_id, c.updated_at, r.character_count,
  c.volume_id, c.goal, c.viewpoint, c.target_characters, c.notes, c.status, c.finalized_revision_id, c.finalized_at`

export const BOOK_RECOVERY_PENDING = 'recovery.pending.json'
export const BOOK_RECOVERY_COMPLETE = 'recovery.complete.json'

function assertRecoveryComplete(directory: string, bookId: string, required = false): void {
  const pending = join(directory, BOOK_RECOVERY_PENDING)
  const complete = join(directory, BOOK_RECOVERY_COMPLETE)
  if (!required && !lstatSync(pending, { throwIfNoEntry: false }) && !lstatSync(complete, { throwIfNoEntry: false })) return
  const read = (path: string): Buffer => {
    assertLocalPath(path, false)
    const before = lstatSync(path)
    if (before.nlink !== 1 || before.size === 0 || before.size > 1024) throw storageFailure()
    const fd = openSync(path, 'r')
    try {
      const opened = fstatSync(fd)
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw storageFailure()
      const bytes = Buffer.alloc(before.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (count === 0) throw storageFailure()
        offset += count
      }
      const after = fstatSync(fd)
      const current = lstatSync(path)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
          current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1 || current.isSymbolicLink()) throw storageFailure()
      return bytes
    } finally { closeSync(fd) }
  }
  try {
    const bytes = read(pending)
    if (!bytes.equals(read(complete))) throw storageFailure()
    const marker: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!isRecord(marker) || Object.keys(marker).sort().join(',') !== 'bookId,format,manifestHash,packageId' ||
        marker.format !== 'storyweave-recovery-commit' || marker.bookId !== bookId ||
        requiredId(marker.packageId) !== String(marker.packageId).toLowerCase() ||
        typeof marker.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(marker.manifestHash)) throw storageFailure()
  } catch {
    throw new DomainError({ code: 'STORAGE_ERROR', message: `这部作品的恢复尚未完成或完成标记无效，已停止打开和登记。请保留目录：${directory}` })
  }
}

function storageFailure(error?: unknown): DomainError {
  return storageError(error, '本地资料读写失败，当前草稿请继续保留。请检查目录、磁盘空间及文件是否可用。')
}

function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure(error)
  }
}

function payload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new DomainError({ code: 'INVALID_INPUT', message: '操作参数无效。' })
  return value
}

function samePath(first: string, second: string): boolean {
  const a = normalize(resolve(first))
  const b = normalize(resolve(second))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function requireLocalDiskSyntax(path: string): void {
  if (process.platform !== 'win32' || !/^[a-z]:[\\/]/i.test(path) || !/^[a-z]:[\\/]/i.test(normalize(path))) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '请选择 Windows 本地磁盘目录；当前书库不支持网络共享、网络映射盘或设备路径。' })
  }
}

function localCanonicalPath(path: string): string {
  requireLocalDiskSyntax(path)
  let canonical: string
  try { canonical = realpathSync.native(path) } catch {
    throw new DomainError({ code: 'INVALID_INPUT', message: '无法确认这份路径属于可访问的本地磁盘，请重新选择已存在的本地书库目录。' })
  }
  // Windows native realpath 依据最终句柄解析路径；映射到 UNC 的目录不能进入 WAL 书库。
  requireLocalDiskSyntax(canonical)
  return canonical
}

// 子目录和库文件都应属于所选书库；共享硬链接也会使写入影响其他目录的资产。
function assertLocalPath(path: string, directory: boolean): string {
  const canonical = localCanonicalPath(path)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || !samePath(path, canonical)) {
    throw new DomainError({ code: 'STORAGE_ERROR', message: '书库内发现链接或不符合预期的文件类型，已停止访问。' })
  }
  return canonical
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path)
  assertLocalPath(path, true)
}

function assertDatabasePaths(path: string): boolean {
  const exists = lstatSync(path, { throwIfNoEntry: false }) !== undefined
  if (exists) assertLocalPath(path, false)
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = `${path}${suffix}`
    if (lstatSync(sidecar, { throwIfNoEntry: false })) assertLocalPath(sidecar, false)
  }
  return exists
}

function verifyDatabase(db: Database.Database, applicationId: number): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (db.pragma('application_id', { simple: true }) === applicationId && version === 1) {
    throw new DomainError({ code: 'STORAGE_ERROR', message: '此书库使用旧版 v1 格式，需要专门的迁移工具。当前版本未修改旧库，也不支持直接恢复旧格式。' })
  }
  const supported = applicationId === BOOK_APPLICATION_ID ? Number.isInteger(version) && version >= 2 && version <= BOOK_SCHEMA_VERSION
    : version === 2 || version === STUDIO_SCHEMA_VERSION
  if (db.pragma('application_id', { simple: true }) !== applicationId || !supported) {
    throw new DomainError({ code: 'STORAGE_ERROR', message: '数据库格式或版本不受当前程序支持，未修改该数据库。' })
  }
}

function verifyExistingFile(path: string, applicationId: number): void {
  const probe = new Database(path, { readonly: true, fileMustExist: true, timeout: 2000 })
  try { verifyDatabase(probe, applicationId) } finally { probe.close() }
}

function configure(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 2000')
  db.pragma('trusted_schema = OFF')
}

function bookSummary(row: BookRow): BookSummary {
  return {
    id: row.id, title: row.title, genre: row.genre, synopsis: row.synopsis, archivedAt: row.archived_at,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.lifecycle === undefined ? {} : { lifecycle: row.lifecycle }),
  }
}

function chapterSummary(row: ChapterRow): ChapterSummary {
  return {
    id: row.id, title: row.title, position: row.position, revisionId: row.current_revision_id,
    characterCount: row.character_count, updatedAt: row.updated_at,
    volumeId: row.volume_id, goal: row.goal, viewpoint: row.viewpoint, targetCharacters: row.target_characters,
    notes: row.notes, status: row.status, finalizedRevisionId: row.finalized_revision_id, finalizedAt: row.finalized_at,
  }
}

function historySummary(row: HistoryRow): RevisionSummary {
  return {
    id: row.id, sequence: row.sequence, parentRevisionId: row.parent_revision_id,
    restoredFromRevisionId: row.restored_from_revision_id, reason: row.reason,
    characterCount: row.character_count, createdAt: row.created_at,
  }
}

function verifyDocument(row: { document_json: string; content_hash: string; plain_text: string; character_count: number }): ManuscriptDocument {
  let document: ManuscriptDocument
  try { document = parseManuscript(JSON.parse(row.document_json)) } catch { throw storageFailure() }
  if (createHash('sha256').update(row.document_json, 'utf8').digest('hex') !== row.content_hash ||
      documentToText(document) !== row.plain_text || countCharacters(row.plain_text) !== row.character_count) throw storageFailure()
  return document
}

export class StudioRepository {
  private rootPath: string | null = null
  private studio: Database.Database | null = null
  private activeBook: OpenBook | null = null
  private inspiration: Database.Database | null = null
  private recoveryGeneration = 0

  getWorkspace(): WorkspaceSnapshot {
    return perform(() => {
      if (!this.studio || !this.rootPath) return { rootPath: null, books: [] }
      const rows = this.studio.prepare(`SELECT ${BOOK_COLUMNS} FROM books ORDER BY updated_at DESC, id LIMIT ?`).all(MAX_BOOKS + 1) as BookRow[]
      if (rows.length > MAX_BOOKS) throw new DomainError({ code: 'STORAGE_ERROR', message: `当前版本每个书库最多支持 ${MAX_BOOKS} 部作品。` })
      return { rootPath: this.rootPath, books: rows.map(bookSummary) }
    })
  }

  openWorkspace(rootPath: string): WorkspaceSnapshot {
    return perform(() => {
      if (typeof rootPath !== 'string') {
        throw new DomainError({ code: 'INVALID_INPUT', message: '请选择已存在的本地书库目录。' })
      }
      const canonicalRoot = assertLocalPath(rootPath, true)
      if (this.rootPath && samePath(canonicalRoot, this.rootPath)) return this.getWorkspace()
      const databasePath = join(canonicalRoot, 'studio.sqlite')
      const isExisting = assertDatabasePaths(databasePath)
      let next: Database.Database | null = null
      try {
        if (isExisting) verifyExistingFile(databasePath, STUDIO_APPLICATION_ID)
        next = new Database(databasePath, { timeout: 2000, fileMustExist: isExisting })
        if (isExisting) verifyDatabase(next, STUDIO_APPLICATION_ID)
        configure(next)
        // 工作室目录库保持独占连接锁，第二个实例不能同时接管同一书库的写入。
        next.pragma('journal_mode = DELETE')
        next.pragma('locking_mode = EXCLUSIVE')
        next.exec('BEGIN EXCLUSIVE; COMMIT;')
        if (!isExisting) {
          const db = next
          db.transaction(() => {
            db.exec(STUDIO_SCHEMA)
            db.pragma(`application_id = ${STUDIO_APPLICATION_ID}`)
            db.pragma(`user_version = ${STUDIO_SCHEMA_VERSION}`)
          })()
        }
        const meta = next.prepare('SELECT format FROM studio_meta WHERE singleton = 1').get() as { format: string } | undefined
        if (meta?.format !== 'storyweave-studio') throw storageFailure()
        const rows = next.prepare(`SELECT ${BOOK_COLUMNS} FROM books ORDER BY updated_at DESC, id LIMIT ?`).all(MAX_BOOKS + 1) as BookRow[]
        if (rows.length > MAX_BOOKS) throw new DomainError({ code: 'STORAGE_ERROR', message: `当前版本每个书库最多支持 ${MAX_BOOKS} 部作品。` })
        ensureDirectory(join(canonicalRoot, 'books'))
        this.close()
        this.studio = next
        this.rootPath = canonicalRoot
        next = null
        return { rootPath: canonicalRoot, books: rows.map(bookSummary) }
      } catch (error) {
        if (next?.open) next.close()
        if (isRecord(error) && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')) {
          throw new DomainError({ code: 'WORKSPACE_BUSY', message: '这份书库正在被另一个程序实例使用，请关闭另一实例后再打开。' })
        }
        throw error
      }
    })
  }

  createBook(input: CreateBookInput): BookSnapshot {
    return this.createBookAsset(input, randomUUID())
  }

  createKickstartBook(bookId: string, seedJson: string): BookSnapshot {
    const id = requiredId(bookId).toLowerCase()
    const studio = this.requireStudio()
    const directory = join(this.requireRoot(), 'books', id)
    if (studio.prepare('SELECT id FROM books WHERE id = ?').get(id)) return this.getBook({ bookId: id })
    // 同一草稿重试先核对已有资产；初始化残件保留，由恢复入口报告，不能覆盖重建。
    if (lstatSync(directory, { throwIfNoEntry: false })) return this.registerOrphanBook({ bookId: id })
    return this.createBookAsset({ title: '未完成的开书草稿' }, id, seedJson)
  }

  getStudioDatabase(): Database.Database { return this.requireStudio() }

  async prepareStudioGenerationStorage(): Promise<Database.Database> {
    const db = this.requireStudio(), root = this.requireRoot()
    if (db.pragma('user_version', { simple: true }) === STUDIO_SCHEMA_VERSION) return db
    // 打开旧书库不改格式；作者首次保存全局连接时，先留存目录库备份再追加配置表。
    const backups = join(root, 'studio-backups')
    ensureDirectory(backups)
    const directory = join(backups, `v2-${randomUUID()}`)
    mkdirSync(directory)
    assertLocalPath(directory, true)
    const path = join(directory, 'studio.sqlite'), descriptor = openSync(path, 'wx')
    let identity: ReturnType<typeof fstatSync>
    try { identity = fstatSync(descriptor); fsyncSync(descriptor) } finally { closeSync(descriptor) }
    try {
      const copied = await db.backup(path)
      assertLocalPath(root, true); assertLocalPath(backups, true); assertLocalPath(directory, true); assertLocalPath(path, false)
      const actual = lstatSync(path)
      if (copied.remainingPages !== 0 || copied.totalPages <= 0 || actual.dev !== identity.dev || actual.ino !== identity.ino) throw storageFailure()
      const probe = new Database(path, { readonly: true, fileMustExist: true })
      try {
        if (probe.pragma('application_id', { simple: true }) !== STUDIO_APPLICATION_ID || probe.pragma('user_version', { simple: true }) !== 2 ||
            probe.pragma('quick_check(1)', { simple: true }) !== 'ok') throw storageFailure()
      } finally { probe.close() }
      const durable = openSync(path, 'r+')
      try {
        const current = fstatSync(durable)
        if (current.dev !== identity.dev || current.ino !== identity.ino) throw storageFailure()
        fsyncSync(durable)
      } finally { closeSync(durable) }
      if (this.studio !== db || this.requireRoot() !== root) throw storageFailure()
      db.transaction(() => {
        if (db.pragma('user_version', { simple: true }) !== 2) throw storageFailure()
        db.exec(STUDIO_GENERATION_SCHEMA)
        db.pragma(`user_version = ${STUDIO_SCHEMA_VERSION}`)
      }).immediate()
    } catch {
      throw new DomainError({ code: 'STORAGE_ERROR', message: `工作区模型配置尚未保存。请保留目录库与本次备份：${path}；备份可能未完成，勿直接替换原库。` })
    }
    return db
  }

  private createBookAsset(input: CreateBookInput, id: string, kickstartSeed?: string): BookSnapshot {
    return perform(() => {
      const data = parseCreateBookInput(input)
      const title = data.title
      const studio = this.requireStudio()
      const count = studio.prepare('SELECT COUNT(*) AS count FROM books').get() as { count: number }
      if (count.count >= MAX_BOOKS) throw new DomainError({ code: 'INVALID_INPUT', message: `当前书库已达到 ${MAX_BOOKS} 部作品的上限。` })
      const now = new Date().toISOString()
      const directory = join(this.requireRoot(), 'books', id)
      assertLocalPath(join(this.requireRoot(), 'books'), true)
      mkdirSync(directory)
      assertLocalPath(directory, true)
      const db = new Database(join(directory, 'book.sqlite'))
      try {
        configure(db)
        db.pragma('journal_mode = WAL')
        db.pragma('synchronous = FULL')
        db.transaction(() => {
          db.exec(BOOK_SCHEMA)
          db.pragma(`application_id = ${BOOK_APPLICATION_ID}`)
          db.pragma(`user_version = ${BOOK_SCHEMA_VERSION}`)
          db.prepare('INSERT INTO book_meta (singleton, id, title, created_at, updated_at) VALUES (1, ?, ?, ?, ?)').run(id, title, now, now)
          if (kickstartSeed !== undefined) db.prepare("UPDATE book_meta SET lifecycle = 'kickstarting', seed_json = ? WHERE singleton = 1").run(kickstartSeed)
          if (data.starter) {
            // 新手引导只保存作者填写的种子，不凭空创建人物事实；首章与前提同事务建立。
            const seed = data.starter
            const premise = [seed.protagonist && `主角：${seed.protagonist}`, seed.desire && `愿望：${seed.desire}`, seed.obstacle && `阻碍：${seed.obstacle}`].filter(Boolean).join('\n')
            db.prepare('UPDATE workbench_settings SET premise = ? WHERE singleton = 1').run(premise)
            const chapterId = randomUUID(), revisionId = randomUUID()
            const documentJson = JSON.stringify(emptyDocument())
            db.prepare(`INSERT INTO chapters (id, title, position, goal, viewpoint, current_revision_id, created_at, updated_at)
              VALUES (?, ?, 0, ?, ?, ?, ?, ?)`).run(chapterId, seed.firstChapterTitle, seed.desire, seed.protagonist, revisionId, now, now)
            db.prepare(`INSERT INTO chapter_revisions (id, chapter_id, document_json, plain_text, content_hash, character_count, sequence, reason, created_at)
              VALUES (?, ?, ?, '', ?, 0, 1, 'created', ?)`).run(revisionId, chapterId, documentJson, this.hash(documentJson), now)
            this.recordChapterChange(db, chapterId, revisionId, now)
          }
        })()
        // 每书主库先成为完整资产，再登记工作室目录；登记失败时保留已创建文件。
        studio.prepare('INSERT INTO books (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now)
      } finally {
        db.close()
      }
      return this.getBook({ bookId: id })
    })
  }

  getBook(input: BookInput): BookSnapshot {
    return perform(() => {
      const bookId = requiredId(payload(input).bookId).toLowerCase()
      const db = this.openBook(bookId)
      const book = this.readBookMetadata(db, bookId)
      const rows = db.prepare(`SELECT ${CHAPTER_COLUMNS}
        FROM chapters c JOIN chapter_revisions r ON r.id = c.current_revision_id AND r.chapter_id = c.id
        ORDER BY c.position, c.id LIMIT ?`).all(MAX_CHAPTERS + 1) as ChapterRow[]
      if (rows.length > MAX_CHAPTERS) throw new DomainError({ code: 'STORAGE_ERROR', message: `当前版本每部作品最多支持 ${MAX_CHAPTERS} 章。` })
      const volumes = db.prepare('SELECT id, title, position FROM volumes ORDER BY position, id LIMIT ?').all(MAX_VOLUMES + 1) as VolumeSummary[]
      if (volumes.length > MAX_VOLUMES) throw storageFailure()
      this.updateCatalog(book)
      return { book, chapters: rows.map(chapterSummary), volumes }
    })
  }

  createChapter(input: CreateChapterInput): ChapterSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const title = requiredText(data.title, '章节名', 120)
      const db = this.openBook(bookId)
      const volumeId = data.volumeId == null ? null : requiredId(data.volumeId).toLowerCase()
      const chapterId = randomUUID()
      const revisionId = randomUUID()
      const document = emptyDocument()
      const documentJson = JSON.stringify(document)
      const now = new Date().toISOString()
      db.transaction(() => {
        this.requireWritable(db, bookId)
        this.requireVolume(db, volumeId)
        const current = db.prepare('SELECT COALESCE(MAX(position), -1) AS maximum, COUNT(*) AS count FROM chapters').get() as { maximum: number; count: number }
        if (current.count >= MAX_CHAPTERS) throw new DomainError({ code: 'INVALID_INPUT', message: `当前作品已达到 ${MAX_CHAPTERS} 章的上限。` })
        db.prepare('INSERT INTO chapters (id, title, position, volume_id, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(chapterId, title, current.maximum + 1, volumeId, revisionId, now, now)
        db.prepare(`INSERT INTO chapter_revisions
          (id, chapter_id, parent_revision_id, document_json, plain_text, content_hash, character_count, created_at, sequence, reason)
          VALUES (?, ?, NULL, ?, '', ?, 0, ?, ?, 'created')`).run(revisionId, chapterId, documentJson, this.hash(documentJson), now, this.nextSequence(db))
        this.normalizeChapterPositions(db, now)
        this.recordChapterChange(db, chapterId, revisionId, now)
      }).immediate()
      this.updateCatalog(this.readBookMetadata(db, bookId))
      return this.readChapter({ bookId, chapterId })
    })
  }

  readChapter(input: ChapterInput): ChapterSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const chapterId = requiredId(data.chapterId).toLowerCase()
      const db = this.openBook(bookId)
      const row = this.readChapterRow(db, chapterId)
      const document = verifyDocument(row)
      return { ...chapterSummary(row), bookId, document, plainText: row.plain_text, bookRevision: this.readBookMetadata(db, bookId).revision }
    })
  }

  saveChapter(input: SaveChapterInput, source: WritingDay['source'] = 'manual', restoredFromRevisionId?: string): SaveChapterOutput {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const chapterId = requiredId(data.chapterId).toLowerCase()
      const expectedRevisionId = requiredId(data.expectedRevisionId).toLowerCase()
      const document = parseManuscript(data.document)
      const documentJson = JSON.stringify(document)
      const contentHash = this.hash(documentJson)
      const plainText = documentToText(document)
      const characterCount = countCharacters(plainText)
      const db = this.openBook(bookId)
      const changed = db.transaction(() => {
        this.requireWritable(db, bookId)
        const current = this.readChapterRow(db, chapterId)
        if (current.current_revision_id !== expectedRevisionId) {
          throw new DomainError({ code: 'REVISION_CONFLICT', message: '章节已有更新版本。当前草稿已保留，请重新读取后比较，不能直接覆盖。', currentRevisionId: current.current_revision_id })
        }
        if (current.content_hash === contentHash && current.document_json === documentJson) return false
        const revisionId = randomUUID()
        const now = new Date().toISOString()
        const restoredFrom = restoredFromRevisionId === undefined ? null : requiredId(restoredFromRevisionId).toLowerCase()
        if (restoredFrom && (source !== 'restore' || !db.prepare('SELECT id FROM chapter_revisions WHERE id = ? AND chapter_id = ?').get(restoredFrom, chapterId))) {
          throw new DomainError({ code: 'INVALID_INPUT', message: '局部恢复来源必须是当前章节的有效历史版本。' })
        }
        db.prepare(`INSERT INTO chapter_revisions
          (id, chapter_id, parent_revision_id, document_json, plain_text, content_hash, character_count, created_at, sequence, reason, restored_from_revision_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(revisionId, chapterId, expectedRevisionId, documentJson, plainText, contentHash, characterCount, now, this.nextSequence(db), restoredFrom ? 'restored' : 'saved', restoredFrom)
        const updated = db.prepare("UPDATE chapters SET current_revision_id = ?, updated_at = ?, status = 'writing' WHERE id = ? AND current_revision_id = ?")
          .run(revisionId, now, chapterId, expectedRevisionId)
        if (updated.changes !== 1) throw new DomainError({ code: 'REVISION_CONFLICT', message: '章节版本已变化，本次保存没有覆盖新稿。' })
        // 在事务内核对真正落库的表示，失败时同时回滚历史和当前指针。
        verifyDocument(this.readChapterRow(db, chapterId))
        this.recordChapterChange(db, chapterId, revisionId, now, source)
        return true
      }).immediate()
      // AI 采用借用同书外层事务，目录缓存只能在外层提交或回滚后更新。
      if (changed && !db.inTransaction) this.updateCatalog(this.readBookMetadata(db, bookId))
      return { chapter: this.readChapter({ bookId, chapterId }), changed }
    })
  }

  updateBook(input: UpdateBookInput): BookSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const expected = requiredInteger(data.expectedBookRevision, '作品版本')
      const title = requiredText(data.title, '作品名', 120)
      const genre = optionalText(data.genre, '类型', 120)
      const synopsis = optionalText(data.synopsis, '简介', 20_000)
      if (typeof data.archived !== 'boolean') throw new DomainError({ code: 'INVALID_INPUT', message: '归档状态无效。' })
      const db = this.openBook(bookId)
      db.transaction(() => {
        const book = this.requireBookRevision(db, bookId, expected)
        // 归档资产只能查看；显式取消归档后才能继续编辑。
        if (book.archivedAt && data.archived) throw new DomainError({ code: 'FORBIDDEN', message: '请先取消归档再修改作品。' })
        const now = new Date().toISOString()
        db.prepare('UPDATE book_meta SET title = ?, genre = ?, synopsis = ?, archived_at = ? WHERE singleton = 1')
          .run(title, genre, synopsis, data.archived ? now : null)
        this.recordMutation(db, 'book.metadata', now)
      }).immediate()
      return this.getBook({ bookId })
    })
  }

  createVolume(input: CreateVolumeInput): BookSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const expected = requiredInteger(data.expectedBookRevision, '作品版本')
      const title = requiredText(data.title, '卷名', 120)
      const db = this.openBook(bookId)
      db.transaction(() => {
        this.requireWritable(db, bookId, expected)
        const current = db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) AS maximum FROM volumes').get() as { count: number; maximum: number }
        if (current.count >= MAX_VOLUMES) throw new DomainError({ code: 'INVALID_INPUT', message: `每部作品最多支持 ${MAX_VOLUMES} 卷。` })
        const now = new Date().toISOString()
        db.prepare('INSERT INTO volumes (id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), title, current.maximum + 1, now, now)
        this.recordMutation(db, 'book.structure', now)
      }).immediate()
      return this.getBook({ bookId })
    })
  }

  renameVolume(input: RenameVolumeInput): BookSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const expected = requiredInteger(data.expectedBookRevision, '作品版本')
      const volumeId = requiredId(data.volumeId).toLowerCase()
      const title = requiredText(data.title, '卷名', 120)
      const db = this.openBook(bookId)
      db.transaction(() => {
        this.requireWritable(db, bookId, expected)
        this.requireVolume(db, volumeId)
        const now = new Date().toISOString()
        db.prepare('UPDATE volumes SET title = ?, updated_at = ? WHERE id = ?').run(title, now, volumeId)
        this.recordMutation(db, 'book.structure', now)
      }).immediate()
      return this.getBook({ bookId })
    })
  }

  reorderVolumes(input: ReorderVolumesInput): BookSnapshot {
    return this.reorder(input, 'volumes', 'volumeIds', MAX_VOLUMES)
  }

  reorderChapters(input: ReorderChaptersInput): BookSnapshot {
    return this.reorder(input, 'chapters', 'chapterIds', MAX_CHAPTERS)
  }

  updateChapter(input: UpdateChapterInput): ChapterSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const chapterId = requiredId(data.chapterId).toLowerCase()
      const expected = requiredInteger(data.expectedBookRevision, '作品版本')
      const title = requiredText(data.title, '章节名', 120)
      const volumeId = data.volumeId === null ? null : requiredId(data.volumeId).toLowerCase()
      const goal = optionalText(data.goal, '章节目标', 10_000)
      const viewpoint = optionalText(data.viewpoint, '章节视角', 500)
      const notes = optionalText(data.notes, '章节备注', 20_000)
      const target = data.targetCharacters === null ? null : requiredInteger(data.targetCharacters, '目标字数', 1_000_000)
      if (!['planned', 'writing', 'review'].includes(String(data.status))) throw new DomainError({ code: 'INVALID_INPUT', message: '章节状态无效，请通过定稿操作保存定稿。' })
      const db = this.openBook(bookId)
      db.transaction(() => {
        this.requireWritable(db, bookId, expected)
        const current = this.readChapterRow(db, chapterId)
        this.requireVolume(db, volumeId)
        const now = new Date().toISOString()
        db.prepare(`UPDATE chapters SET title = ?, volume_id = ?, goal = ?, viewpoint = ?, target_characters = ?, notes = ?, status = ?, updated_at = ? WHERE id = ?`)
          .run(title, volumeId, goal, viewpoint, target, notes, data.status, now, chapterId)
        if (current.volume_id !== volumeId) this.normalizeChapterPositions(db, now)
        this.recordMutation(db, 'chapter.metadata', now, chapterId)
      }).immediate()
      this.updateCatalog(this.readBookMetadata(db, bookId))
      return this.readChapter({ bookId, chapterId })
    })
  }

  finalizeChapter(input: FinalizeChapterInput): ChapterSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const chapterId = requiredId(data.chapterId).toLowerCase()
      const expected = requiredInteger(data.expectedBookRevision, '作品版本')
      const revisionId = requiredId(data.expectedRevisionId).toLowerCase()
      const db = this.openBook(bookId)
      db.transaction(() => {
        this.requireWritable(db, bookId, expected)
        const chapter = this.readChapterRow(db, chapterId)
        if (chapter.current_revision_id !== revisionId) this.revisionConflict(chapter.current_revision_id)
        const now = new Date().toISOString()
        db.prepare("UPDATE chapters SET finalized_revision_id = ?, finalized_at = ?, status = 'finalized', updated_at = ? WHERE id = ?")
          .run(revisionId, now, now, chapterId)
        this.recordMutation(db, 'chapter.finalized', now, chapterId)
      }).immediate()
      this.updateCatalog(this.readBookMetadata(db, bookId))
      return this.readChapter({ bookId, chapterId })
    })
  }

  listRevisions(input: ListRevisionsInput): RevisionPage {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const chapterId = requiredId(data.chapterId).toLowerCase()
      const before = data.beforeSequence === undefined ? Number.MAX_SAFE_INTEGER : requiredInteger(data.beforeSequence, '历史游标')
      const db = this.openBook(bookId)
      this.readChapterRow(db, chapterId)
      const rows = db.prepare(`SELECT id, sequence, parent_revision_id, restored_from_revision_id, reason, character_count, created_at
        FROM chapter_revisions WHERE chapter_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 51`).all(chapterId, before) as HistoryRow[]
      const items = rows.slice(0, 50).map(historySummary)
      return { items, nextBeforeSequence: rows.length > 50 ? items[items.length - 1]!.sequence : null }
    })
  }

  readRevision(input: RevisionInput): RevisionSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const chapterId = requiredId(data.chapterId).toLowerCase()
      const revisionId = requiredId(data.revisionId).toLowerCase()
      const row = this.historyRow(this.openBook(bookId), chapterId, revisionId)
      return { ...historySummary(row), bookId, chapterId, document: verifyDocument(row), plainText: row.plain_text }
    })
  }

  restoreRevision(input: RestoreRevisionInput): ChapterSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const chapterId = requiredId(data.chapterId).toLowerCase()
      const sourceId = requiredId(data.revisionId).toLowerCase()
      const expected = requiredId(data.expectedRevisionId).toLowerCase()
      const db = this.openBook(bookId)
      db.transaction(() => {
        this.requireWritable(db, bookId)
        const current = this.readChapterRow(db, chapterId)
        if (current.current_revision_id !== expected) this.revisionConflict(current.current_revision_id)
        const source = this.historyRow(db, chapterId, sourceId)
        verifyDocument(source)
        const revisionId = randomUUID()
        const now = new Date().toISOString()
        // 恢复总是新增历史节点；当前稿和旧定稿仍然保留，来源追溯不倒退。
        db.prepare(`INSERT INTO chapter_revisions
          (id, chapter_id, parent_revision_id, document_json, plain_text, content_hash, character_count, created_at, sequence, reason, restored_from_revision_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'restored', ?)`)
          .run(revisionId, chapterId, expected, source.document_json, source.plain_text, source.content_hash, source.character_count, now, this.nextSequence(db), sourceId)
        const updated = db.prepare("UPDATE chapters SET current_revision_id = ?, updated_at = ?, status = 'writing' WHERE id = ? AND current_revision_id = ?")
          .run(revisionId, now, chapterId, expected)
        if (updated.changes !== 1) this.revisionConflict(current.current_revision_id)
        this.recordChapterChange(db, chapterId, revisionId, now)
      }).immediate()
      this.updateCatalog(this.readBookMetadata(db, bookId))
      return this.readChapter({ bookId, chapterId })
    })
  }

  findOrphanBooks(): OrphanScan {
    return perform(() => {
      const studio = this.requireStudio()
      const directory = join(this.requireRoot(), 'books')
      assertLocalPath(directory, true)
      const registered = new Set((studio.prepare('SELECT id FROM books').all() as { id: string }[]).map((row) => row.id))
      const scan: OrphanScan = { books: [], skipped: 0 }
      const handle = opendirSync(directory)
      let examined = 0
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          examined += 1
          if (examined > 5_000) throw new DomainError({ code: 'STORAGE_ERROR', message: '书库目录项超过 5,000 个，请先人工核对目录内容。' })
          if (registered.has(entry.name)) continue
          let db: Database.Database | null = null
          try {
            const id = requiredId(entry.name).toLowerCase()
            if (!entry.isDirectory() || entry.isSymbolicLink() || id !== entry.name) { scan.skipped += 1; continue }
            db = this.openOrphanReadOnly(id)
            const book = this.readBookMetadata(db, id)
            const chapterCount = (db.prepare('SELECT COUNT(*) AS count FROM chapters').get() as { count: number }).count
            const volumeCount = (db.prepare('SELECT COUNT(*) AS count FROM volumes').get() as { count: number }).count
            if (chapterCount > MAX_CHAPTERS || volumeCount > MAX_VOLUMES) { scan.skipped += 1; continue }
            scan.books.push({ book, chapterCount })
          } catch { scan.skipped += 1 } finally { if (db?.open) db.close() }
        }
      } finally { handle.closeSync() }
      scan.books.sort((a, b) => b.book.updatedAt.localeCompare(a.book.updatedAt) || a.book.id.localeCompare(b.book.id))
      return scan
    })
  }

  registerOrphanBook(input: BookInput): BookSnapshot {
    return perform(() => {
      const bookId = requiredId(payload(input).bookId).toLowerCase()
      const studio = this.requireStudio()
      if (studio.prepare('SELECT id FROM books WHERE id = ?').get(bookId)) return this.getBook({ bookId })
      this.checkBookCapacity(studio)
      const db = this.openOrphanReadOnly(bookId)
      try {
        const book = this.readBookMetadata(db, bookId)
        const check = db.pragma('quick_check', { simple: true })
        if (check !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length > 0) throw storageFailure()
        const chapterCount = (db.prepare('SELECT COUNT(*) AS count FROM chapters').get() as { count: number }).count
        const volumeCount = (db.prepare('SELECT COUNT(*) AS count FROM volumes').get() as { count: number }).count
        if (chapterCount > MAX_CHAPTERS || volumeCount > MAX_VOLUMES) throw storageFailure()
        this.insertCatalog(studio, book)
      } finally { db.close() }
      return this.getBook({ bookId })
    })
  }

  importBook(input: ImportBookData): BookSnapshot {
    return perform(() => {
      const data = payload(input)
      const title = requiredText(data.title, '作品名', 120)
      const sourceName = requiredText(data.sourceName, '来源文件名', 255)
      if (!(data.sourceBytes instanceof Uint8Array) || data.sourceBytes.byteLength > MAX_IMPORT_BYTES) throw new DomainError({ code: 'INVALID_INPUT', message: '导入原稿字节无效或超过 32 MiB。' })
      if (!['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(String(data.encoding))) throw new DomainError({ code: 'INVALID_INPUT', message: '导入编码无效。' })
      const sourceBytes = data.sourceBytes
      const encoding = data.encoding as TextEncoding
      if (!Array.isArray(data.chapters) || data.chapters.length === 0 || data.chapters.length > MAX_CHAPTERS) throw new DomainError({ code: 'INVALID_INPUT', message: '导入章节数量无效。' })
      let totalLength = 0
      const chapters = Array.from(data.chapters, (item: unknown) => {
        const chapter = payload(item)
        const document = parseManuscript(chapter.document)
        totalLength += documentToText(document).length
        if (totalLength > MAX_IMPORT_BYTES) throw new DomainError({ code: 'INVALID_INPUT', message: '导入正文总量超过当前上限，请拆分后导入。' })
        return { title: requiredText(chapter.title, '章节名', 120), document }
      })
      const studio = this.requireStudio()
      this.checkBookCapacity(studio)
      const bookId = randomUUID()
      const sourceId = randomUUID()
      const now = new Date().toISOString()
      const directory = join(this.requireRoot(), 'books', bookId)
      assertLocalPath(join(this.requireRoot(), 'books'), true)
      mkdirSync(directory)
      assertLocalPath(directory, true)
      const sourceDirectory = join(directory, 'sources')
      mkdirSync(sourceDirectory)
      assertLocalPath(sourceDirectory, true)
      const relativeSource = `sources/${sourceId}.original`
      // 原稿按不可变标识另存；失败保留新目录，绝不覆盖或删除用户原文件。
      writeFileSync(join(sourceDirectory, `${sourceId}.original`), sourceBytes, { flag: 'wx', flush: true })
      const db = new Database(join(directory, 'book.sqlite'))
      try {
        configure(db)
        db.pragma('journal_mode = WAL')
        db.pragma('synchronous = FULL')
        db.transaction(() => {
          db.exec(BOOK_SCHEMA)
          db.pragma(`application_id = ${BOOK_APPLICATION_ID}`)
          db.pragma(`user_version = ${BOOK_SCHEMA_VERSION}`)
          db.prepare('INSERT INTO book_meta (singleton, id, title, created_at, updated_at) VALUES (1, ?, ?, ?, ?)').run(bookId, title, now, now)
          db.prepare(`INSERT INTO import_sources (id, source_name, encoding, relative_path, sha256, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(sourceId, sourceName, encoding, relativeSource, createHash('sha256').update(sourceBytes).digest('hex'), sourceBytes.byteLength, now)
          const insertChapter = db.prepare(`INSERT INTO chapters (id, title, position, current_revision_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'writing', ?, ?)`)
          const insertRevision = db.prepare(`INSERT INTO chapter_revisions
            (id, chapter_id, parent_revision_id, document_json, plain_text, content_hash, character_count, created_at, sequence, reason)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'imported')`)
          for (let position = 0; position < chapters.length; position += 1) {
            const chapter = chapters[position]!
            const chapterId = randomUUID()
            const revisionId = randomUUID()
            const json = JSON.stringify(chapter.document)
            const plainText = documentToText(chapter.document)
            insertChapter.run(chapterId, chapter.title, position, revisionId, now, now)
            insertRevision.run(revisionId, chapterId, json, plainText, this.hash(json), countCharacters(plainText), now, position + 1)
            verifyDocument(this.readChapterRow(db, chapterId))
            this.recordChapterChange(db, chapterId, revisionId, now)
          }
        }).immediate()
        this.insertCatalog(studio, this.readBookMetadata(db, bookId))
      } finally { db.close() }
      return this.getBook({ bookId })
    })
  }

  importDraft(input: DraftImportData): ChapterSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const expected = requiredInteger(data.expectedBookRevision, '作品版本')
      const title = requiredText(data.title, '新章节名', 120)
      const sourceName = requiredText(data.sourceName, '来源文件名', 255)
      if (!(data.sourceBytes instanceof Uint8Array) || data.sourceBytes.byteLength > MAX_DRAFT_FILE_BYTES) throw new DomainError({ code: 'INVALID_INPUT', message: '单章草稿文件无效或超过 16 MiB。' })
      const sourceBytes = data.sourceBytes
      const draft = parseDraftFile(sourceBytes)
      const document = parseManuscript({
        type: 'doc',
        content: draft.document.content.map((block) => ({ ...block, attrs: { ...block.attrs, id: randomUUID() } })),
      })
      const documentJson = JSON.stringify(document)
      const plainText = documentToText(document)
      const characterCount = countCharacters(plainText)
      const db = this.openBook(bookId)
      this.requireWritable(db, bookId, expected)
      const count = (db.prepare('SELECT COUNT(*) AS count FROM chapters').get() as { count: number }).count
      if (count >= MAX_CHAPTERS) throw new DomainError({ code: 'INVALID_INPUT', message: `当前作品已达到 ${MAX_CHAPTERS} 章的上限。` })

      const sourceId = randomUUID()
      const chapterId = randomUUID()
      const revisionId = randomUUID()
      const now = new Date().toISOString()
      const bookDirectory = join(this.requireRoot(), 'books', bookId)
      assertLocalPath(join(this.requireRoot(), 'books'), true)
      assertLocalPath(bookDirectory, true)
      const sourceDirectory = join(bookDirectory, 'sources')
      ensureDirectory(sourceDirectory)
      // 单章草稿恢复为独立新章，原字节与旧身份只用于追溯，不覆盖来源作品。
      writeFileSync(join(sourceDirectory, `${sourceId}.original`), sourceBytes, { flag: 'wx', flush: true })
      const notes = `从单章草稿恢复。原作品 ${draft.bookId}；原章节 ${draft.chapterId}；基准版本 ${draft.baseRevisionId}；草稿时间 ${draft.createdAt}；来源 ${sourceId}。`
      db.transaction(() => {
        this.requireWritable(db, bookId, expected)
        const current = db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) AS maximum FROM chapters').get() as { count: number; maximum: number }
        if (current.count >= MAX_CHAPTERS) throw new DomainError({ code: 'INVALID_INPUT', message: `当前作品已达到 ${MAX_CHAPTERS} 章的上限。` })
        db.prepare(`INSERT INTO import_sources (id, source_name, encoding, relative_path, sha256, byte_length, created_at)
          VALUES (?, ?, 'utf-8', ?, ?, ?, ?)`).run(sourceId, sourceName, `sources/${sourceId}.original`, createHash('sha256').update(sourceBytes).digest('hex'), sourceBytes.byteLength, now)
        db.prepare(`INSERT INTO chapters (id, title, position, volume_id, current_revision_id, notes, status, created_at, updated_at)
          VALUES (?, ?, ?, NULL, ?, ?, 'writing', ?, ?)`).run(chapterId, title, current.maximum + 1, revisionId, notes, now, now)
        db.prepare(`INSERT INTO chapter_revisions
          (id, chapter_id, parent_revision_id, document_json, plain_text, content_hash, character_count, created_at, sequence, reason)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'imported')`)
          .run(revisionId, chapterId, documentJson, plainText, this.hash(documentJson), characterCount, now, this.nextSequence(db))
        verifyDocument(this.readChapterRow(db, chapterId))
        this.normalizeChapterPositions(db, now)
        this.recordChapterChange(db, chapterId, revisionId, now, 'restore')
      }).immediate()
      this.updateCatalog(this.readBookMetadata(db, bookId))
      return this.readChapter({ bookId, chapterId })
    })
  }

  exportBookText(input: ExportBookInput, write: (chunk: string) => void): { chapterCount: number; characterCount: number; bookRevision: number } {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const expected = requiredInteger(data.expectedBookRevision, '作品版本')
      if ((data.format !== 'txt' && data.format !== 'markdown') || (data.scope !== 'working' && data.scope !== 'finalized') || typeof data.includeChapterTitles !== 'boolean' || typeof write !== 'function') {
        throw new DomainError({ code: 'INVALID_INPUT', message: '导出选项无效。' })
      }
      const format = data.format
      const includeTitles = data.includeChapterTitles
      const db = this.openBook(bookId)
      return db.transaction(() => {
        const book = this.requireBookRevision(db, bookId, expected)
        // 一次读事务固定目录与版本；按章输出，不将全书正文和历史装入同一个对象。
        const column = data.scope === 'finalized' ? 'finalized_revision_id' : 'current_revision_id'
        const rows = db.prepare(`SELECT c.title, r.document_json, r.plain_text, r.content_hash, r.character_count
          FROM chapters c JOIN chapter_revisions r ON r.id = c.${column} AND r.chapter_id = c.id
          ORDER BY c.position, c.id LIMIT ?`).iterate(MAX_CHAPTERS + 1) as Iterable<{ title: string; document_json: string; plain_text: string; content_hash: string; character_count: number }>
        let chapterCount = 0
        let characterCount = 0
        for (const row of rows) {
          if (chapterCount >= MAX_CHAPTERS) throw storageFailure()
          const document = verifyDocument(row)
          if (chapterCount > 0) write('\n\n')
          write(renderTextExport([{ title: row.title, document }], format, includeTitles))
          chapterCount += 1
          characterCount += row.character_count
        }
        if (chapterCount === 0) throw new DomainError({ code: 'INVALID_INPUT', message: data.scope === 'finalized' ? '这部作品还没有定稿章节。' : '这部作品还没有正文章节。' })
        return { chapterCount, characterCount, bookRevision: book.revision }
      })()
    })
  }

  getKnowledgeStatus(input: BookInput): KnowledgeStatus {
    return perform(() => {
      const { bookId } = parseKnowledgeStatusInput(input)
      const db = this.openBook(bookId)
      const schemaVersion = db.pragma('user_version', { simple: true }) as number
      const row = db.prepare('SELECT knowledge_revision FROM book_meta WHERE singleton = 1').get() as { knowledge_revision: number } | undefined
      if ((!Number.isInteger(schemaVersion) || schemaVersion < 2 || schemaVersion > BOOK_SCHEMA_VERSION) || !row ||
          !Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 0) throw storageFailure()
      if (schemaVersion >= 3) {
        // 状态查询只核对既有结构，不以读取为由补建表或修改旧作品。
        db.prepare(`SELECT i.id, s.revision_id, r.fields_json, o.knowledge_revision_id
          FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.item_id = i.id
          LEFT JOIN knowledge_item_revisions r ON r.item_id = i.id
          LEFT JOIN knowledge_outbox o ON o.item_id = i.id LIMIT 0`).all()
      }
      if (schemaVersion >= 4) {
        db.prepare(`SELECT r.id, s.revision_id, h.fields_json, o.story_revision_id,
          e.entity_id, a.event_id FROM story_records r
          LEFT JOIN story_sources s ON s.record_id = r.id
          LEFT JOIN story_record_revisions h ON h.record_id = r.id
          LEFT JOIN story_outbox o ON o.record_id = r.id
          LEFT JOIN story_entity_refs e ON e.record_id = r.id
          LEFT JOIN story_event_refs a ON a.record_id = r.id LIMIT 0`).all()
      }
      const book = this.readBookMetadata(db, bookId)
      return { bookId, bookRevision: book.revision, updatedAt: book.updatedAt,
        schemaVersion, knowledgeRevision: row.knowledge_revision, requiresUpgrade: schemaVersion === 2 }
    })
  }

  async upgradeKnowledge(input: UpgradeKnowledgeInput): Promise<KnowledgeStatus> {
    let backupPath: string | undefined
    try {
      const { bookId, expectedBookRevision } = parseUpgradeKnowledgeInput(input)
      const status = this.getKnowledgeStatus({ bookId })
      if (status.schemaVersion === BOOK_SCHEMA_VERSION) return status
      const previousVersion = status.schemaVersion
      const db = this.openBook(bookId)
      this.requireWritable(db, bookId, expectedBookRevision)
      if (expectedBookRevision >= Number.MAX_SAFE_INTEGER) throw storageFailure()
      const directory = join(this.requireRoot(), 'books', bookId)
      assertLocalPath(join(this.requireRoot(), 'books'), true)
      assertLocalPath(directory, true)
      const backups = join(directory, 'backups')
      ensureDirectory(backups)
      const backupDirectory = join(backups, `knowledge-v${previousVersion}-${randomUUID()}`)
      mkdirSync(backupDirectory)
      assertLocalPath(backupDirectory, true)
      backupPath = join(backupDirectory, 'book.sqlite')

      // better-sqlite3 会清理失败的新目标；先独占创建本次空文件，让失败备份也留存。
      // 只接受本次创建的文件，不把任意旧备份交给会覆盖目标的 backup API。
      const created = openSync(backupPath, 'wx')
      let identity: ReturnType<typeof fstatSync>
      try { identity = fstatSync(created); fsyncSync(created) } finally { closeSync(created) }
      const checkBackupIdentity = () => {
        assertLocalPath(backups, true)
        assertLocalPath(backupDirectory, true)
        assertLocalPath(backupPath!, false)
        const current = lstatSync(backupPath!)
        if (current.dev !== identity.dev || current.ino !== identity.ino) throw storageFailure()
      }
      checkBackupIdentity()
      const copied = await db.backup(backupPath)
      if (copied.remainingPages !== 0 || copied.totalPages <= 0) throw storageFailure()
      checkBackupIdentity()
      const probe = new Database(backupPath, { readonly: true, fileMustExist: true, timeout: 2000 })
      try {
        configure(probe)
        verifyDatabase(probe, BOOK_APPLICATION_ID)
        if (probe.pragma('user_version', { simple: true }) !== previousVersion) throw storageFailure()
        this.requireBookRevision(probe, bookId, expectedBookRevision)
        const check = probe.pragma('quick_check') as { quick_check: string }[]
        if (check.length !== 1 || check[0]?.quick_check !== 'ok' || probe.prepare('PRAGMA foreign_key_check').get()) throw storageFailure()
      } finally { probe.close() }
      checkBackupIdentity()
      const durable = openSync(backupPath, 'r+')
      try {
        const current = fstatSync(durable)
        if (current.dev !== identity.dev || current.ino !== identity.ino) throw storageFailure()
        fsyncSync(durable)
      } finally { closeSync(durable) }

      // 服务串行队列在 await 期间保留当前连接；事务内再次核对版本，避免升级旧快照。
      const upgraded = db.transaction((): KnowledgeStatus => {
        this.requireWritable(db, bookId, expectedBookRevision)
        if (db.pragma('user_version', { simple: true }) !== previousVersion) throw storageFailure()
        if (previousVersion === 2) db.exec(KNOWLEDGE_SCHEMA)
        if (previousVersion < 4) db.exec(STORY_SCHEMA)
        if (previousVersion < 5) db.exec(MEMORY_SCHEMA)
        // v6 已有固定上下文与采用历史；只在本次备份后的事务内按原值复制并替换结构。
        if (previousVersion === 6) db.exec(AI_V6_TO_V7_SCHEMA)
        else if (previousVersion < 6) db.exec(AI_SCHEMA)
        if (previousVersion < 8) db.exec(AI_MEMORY_TASK_SCHEMA)
        if (previousVersion < 9) db.exec(AI_SUMMARY_SCHEMA)
        if (previousVersion < 10) db.exec(MEMORY_VECTOR_SCHEMA)
        if (previousVersion < 11) db.exec(AI_MEMORY_MAINTENANCE_SCHEMA)
        if (previousVersion < 12) db.exec(NOTES_SCHEMA)
        if (previousVersion < 13) db.exec(WORKBENCH_SCHEMA)
        if (previousVersion < 14) {
          db.exec(CHARACTER_PROFILE_SCHEMA)
          db.exec(CALENDAR_SCHEMA)
          db.exec(AI_PRESETS_V14_SCHEMA)
          db.exec(MEDIA_SCHEMA)
        }
        if (previousVersion < 15) db.exec(GENERATION_BOOK_UPGRADE)
        if (previousVersion < 16) db.exec(LIVING_SCHEMA)
        if (previousVersion < 17) db.exec(FORGE_SCHEMA)
        if (previousVersion < 18) db.exec(WEAVE_SCHEMA)
        if (previousVersion < 19) db.exec(REALM_SCHEMA)
        if (previousVersion < 20) db.exec(NOTE_CHAPTER_SCHEMA)
        if (previousVersion < 21) db.exec(SCENE_MEDIA_SCHEMA)
        if (previousVersion < 22) db.exec(NOTE_MATERIAL_SCHEMA)
        if (previousVersion < 23) db.exec(NOTE_THUMBNAIL_SCHEMA)
        if (previousVersion < 24) db.exec(FORESHADOW_THUMBNAIL_SCHEMA)
        if (previousVersion < 25) {
          validateAiPresetsDatabase(db, bookId)
          db.exec(AI_PRESETS_V25_UPGRADE)
        }
        if (db.prepare('PRAGMA foreign_key_check').get()) throw storageFailure()
        db.pragma(`user_version = ${BOOK_SCHEMA_VERSION}`)
        validateAiPresetsDatabase(db, bookId)
        this.recordMutation(db, 'book.metadata', new Date().toISOString())
        const book = this.readBookMetadata(db, bookId)
        return { ...status, bookRevision: book.revision, updatedAt: book.updatedAt,
          schemaVersion: BOOK_SCHEMA_VERSION, requiresUpgrade: false, backupPath }
      }).immediate()
      this.refreshKnowledgeCatalog(bookId)
      return upgraded
    } catch (error) {
      if (backupPath) throw new DomainError({ code: 'STORAGE_ERROR', message: `知识库升级未完成，请保留当前作品与本次备份文件：${backupPath}。文件可能尚未完成复制，勿直接替换原库。` })
      if (error instanceof DomainError) throw error
      throw storageFailure()
    }
  }

  getKnowledgeDatabase(bookId: string): { db: Database.Database; book: BookSummary } {
    return perform(() => {
      const id = requiredId(bookId).toLowerCase()
      const db = this.openBook(id)
      const version = db.pragma('user_version', { simple: true }) as number
      if (!Number.isInteger(version) || version < 3 || version > BOOK_SCHEMA_VERSION) {
        throw new DomainError({ code: 'FORBIDDEN', message: '请先在知识库页面备份并升级这部作品，再使用知识条目。' })
      }
      return { db, book: this.readBookMetadata(db, id) }
    })
  }

  getStoryDatabase(bookId: string): { db: Database.Database; book: BookSummary } {
    const context = this.getKnowledgeDatabase(bookId)
    if ((context.db.pragma('user_version', { simple: true }) as number) < 4) {
      throw new DomainError({ code: 'FORBIDDEN', message: '请先在故事记录面板备份并升级作品，再使用关系、时间线、伏笔和人物认知。' })
    }
    return context
  }

  getNotesDatabase(bookId: string): { db: Database.Database; book: BookSummary } {
    return perform(() => {
      const id = requiredId(bookId).toLowerCase()
      const db = this.openBook(id)
      if ((db.pragma('user_version', { simple: true }) as number) < 12) {
        throw new DomainError({ code: 'FORBIDDEN', message: '请先在素材与笔记面板备份并升级这部作品，再使用独立笔记。' })
      }
      return { db, book: this.readBookMetadata(db, id) }
    })
  }

  getMemoryDatabase(bookId: string): Database.Database {
    return perform(() => {
      const id = requiredId(bookId).toLowerCase()
      const db = this.openBook(id)
      this.readBookMetadata(db, id)
      // 旧书可只读整理状态；领域仓储自行检查最低版本，读取不会触发隐式迁移。
      return db
    })
  }

  getInspirationDatabase(create = false): Database.Database | null {
    return perform(() => {
      const directory = this.requireRoot()
      assertLocalPath(directory, true)
      const path = join(directory, 'inspiration.sqlite')
      const existing = assertDatabasePaths(path)
      if (!existing && !create) return null
      if (this.inspiration?.open) return this.inspiration
      const check = (db: Database.Database) => {
        const version = db.pragma('user_version', { simple: true })
        if (db.pragma('application_id', { simple: true }) !== INSPIRATION_APPLICATION_ID
          || version !== 1 && version !== INSPIRATION_THUMBNAIL_SCHEMA_VERSION) throw storageFailure()
      }
      if (existing) {
        const probe = new Database(path, { readonly: true, fileMustExist: true, timeout: 2000 })
        try { check(probe) } finally { probe.close() }
      }
      const db = new Database(path, { fileMustExist: existing, timeout: 2000 })
      try {
        configure(db)
        if (existing) check(db)
        else db.transaction(() => {
          db.exec(INSPIRATION_SCHEMA)
          db.exec(INSPIRATION_THUMBNAIL_SCHEMA)
          db.pragma(`application_id = ${INSPIRATION_APPLICATION_ID}`)
          db.pragma(`user_version = ${INSPIRATION_THUMBNAIL_SCHEMA_VERSION}`)
        }).immediate()
        this.inspiration = db
        return db
      } catch (error) { db.close(); throw error }
    })
  }

  async upgradeInspirations(input: UpgradeInspirationsInput): Promise<UpgradeInspirationsReceipt> {
    let backupPath: string | undefined
    try {
      const data = parseUpgradeInspirationsInput(input), db = this.getInspirationDatabase()
      if (!db || db.pragma('user_version', { simple: true }) !== data.expectedSchemaVersion) {
        throw new DomainError({ code: 'REVISION_CONFLICT', message: '全局灵感库格式已变化，请刷新列表后重新检查。' })
      }
      const dataVersion = db.pragma('data_version', { simple: true })
      const backups = join(this.requireRoot(), 'backups')
      ensureDirectory(backups)
      const directory = join(backups, `inspiration-v1-${randomUUID()}`)
      mkdirSync(directory)
      assertLocalPath(directory, true)
      backupPath = join(directory, 'inspiration.sqlite')
      // 仅向本次独占创建的目标备份；失败文件保留，不覆盖既有副本。
      const created = openSync(backupPath, 'wx')
      let identity: ReturnType<typeof fstatSync>
      try { identity = fstatSync(created); fsyncSync(created) } finally { closeSync(created) }
      const checkIdentity = () => {
        assertLocalPath(backups, true); assertLocalPath(directory, true); assertLocalPath(backupPath!, false)
        const actual = lstatSync(backupPath!)
        if (actual.dev !== identity.dev || actual.ino !== identity.ino) throw storageFailure()
      }
      checkIdentity()
      const copied = await db.backup(backupPath)
      if (copied.remainingPages !== 0 || copied.totalPages <= 0) throw storageFailure()
      checkIdentity()
      const probe = new Database(backupPath, { readonly: true, fileMustExist: true, timeout: 2000 })
      try {
        configure(probe)
        if (probe.pragma('application_id', { simple: true }) !== INSPIRATION_APPLICATION_ID
          || probe.pragma('user_version', { simple: true }) !== data.expectedSchemaVersion
          || probe.pragma('quick_check(1)', { simple: true }) !== 'ok' || probe.prepare('PRAGMA foreign_key_check').get()) throw storageFailure()
      } finally { probe.close() }
      checkIdentity()
      const durable = openSync(backupPath, 'r+')
      try {
        const actual = fstatSync(durable)
        if (actual.dev !== identity.dev || actual.ino !== identity.ino) throw storageFailure()
        fsyncSync(durable)
      } finally { closeSync(durable) }
      // 备份期间若其他连接改库，保留副本并停止，不能把旧快照当成本次升级前状态。
      db.transaction(() => {
        if (db.pragma('user_version', { simple: true }) !== data.expectedSchemaVersion
          || db.pragma('data_version', { simple: true }) !== dataVersion) throw storageFailure()
        db.exec(INSPIRATION_THUMBNAIL_SCHEMA)
        if (db.prepare('PRAGMA foreign_key_check').get()) throw storageFailure()
        db.pragma(`user_version = ${INSPIRATION_THUMBNAIL_SCHEMA_VERSION}`)
      }).immediate()
      return { schemaVersion: INSPIRATION_THUMBNAIL_SCHEMA_VERSION, backupPath }
    } catch (error) {
      if (backupPath) throw new DomainError({ code: 'STORAGE_ERROR', message: `全局灵感配图启用未确认，请保留原库与本次备份：${backupPath}。备份可能尚未完成，请勿直接替换原库。` })
      if (error instanceof DomainError) throw error
      throw storageFailure()
    }
  }

  readKnowledgeSource(input: Extract<KnowledgeSourceInput, { sourceType: 'chapter_text' }>): KnowledgeSourceState {
    const state = this.readKnowledgeSources([input])[0]
    if (!state) throw storageFailure()
    return state
  }

  readKnowledgeSources(inputs: readonly KnowledgeSourceInput[]): KnowledgeSourceState[] {
    return perform(() => {
      if (inputs.length > MAX_KNOWLEDGE_SOURCES) throw new DomainError({ code: 'INVALID_INPUT', message: '待核对的来源数量超过上限。' })
      const first = inputs[0]
      if (!first) return []
      const bookId = requiredId(first.bookId).toLowerCase()
      const states: KnowledgeSourceState[] = []
      const groups = new Map<string, { source: Extract<KnowledgeSourceInput, { sourceType: 'chapter_text' }>; index: number }[]>()
      inputs.forEach((input, index) => {
        const source = parseKnowledgeSource(input, bookId)
        states.push({ validity: source.sourceType === 'chapter_text' ? 'missing' : 'valid' })
        if (source.sourceType !== 'chapter_text') return
        const key = `${source.chapterId}/${source.revisionId}`
        const entries = groups.get(key) ?? []
        entries.push({ source, index })
        groups.set(key, entries)
      })
      if (groups.size === 0) return states
      const db = this.openBook(bookId)
      // 同次详情读取按固定修订分组，每章只解析一次；不保留跨请求的正文缓存。
      for (const entries of groups.values()) {
        const firstEntry = entries[0]
        if (!firstEntry) continue
        const { chapterId, revisionId } = firstEntry.source
        const chapter = db.prepare('SELECT current_revision_id FROM chapters WHERE id = ?').get(chapterId) as { current_revision_id: string } | undefined
        const row = db.prepare(`SELECT document_json, plain_text, content_hash, character_count
          FROM chapter_revisions WHERE chapter_id = ? AND id = ?`).get(chapterId, revisionId) as HistoryRow | undefined
        if (!chapter || !row) continue
        const document = verifyDocument(row)
        const blocks = new Map(document.content.map((block) => [block.attrs.id, block]))
        const texts = new Map<string, string>()
        // 历史修订仍是有效证据；是否属于当前稿由章节指针实时判断。
        const referenceState = chapter.current_revision_id === revisionId ? 'current' : 'historical'
        for (const { source, index } of entries) {
          const block = blocks.get(source.blockId)
          if (!block) continue
          let text = texts.get(source.blockId)
          if (text === undefined) {
            text = documentToText({ type: 'doc', content: [block] })
            texts.set(source.blockId, text)
          }
          states[index] = { validity: text.includes(source.quote) ? 'valid' : 'partial', referenceState }
        }
      }
      return states
    })
  }

  refreshKnowledgeCatalog(bookId: string): void {
    // 事实已提交到每书数据库，目录缓存失败不应将成功写入报告为失败。
    try { this.updateCatalog(this.readBookMetadata(this.openBook(bookId), bookId)) }
    catch { console.warn('storyweave.catalog_refresh_failed') }
  }

  getBookRecoveryWorkspace(bookId?: string): { rootPath: string; booksPath: string; generation: number; conflict: boolean } {
    return perform(() => {
      const rootPath = this.requireRoot()
      const booksPath = join(rootPath, 'books')
      assertLocalPath(rootPath, true)
      assertLocalPath(booksPath, true)
      const id = bookId === undefined ? undefined : requiredId(bookId).toLowerCase()
      const conflict = id !== undefined && (Boolean(this.requireStudio().prepare('SELECT id FROM books WHERE id = ?').get(id)) ||
        lstatSync(join(booksPath, id), { throwIfNoEntry: false }) !== undefined)
      if (id !== undefined && !conflict) this.checkBookCapacity(this.requireStudio())
      return { rootPath, booksPath, generation: this.recoveryGeneration, conflict }
    })
  }

  getBookRecoverySource(bookId: string, expectedBookRevision: number): {
    db: Database.Database; book: BookSummary; bookPath: string; rootPath: string; generation: number
  } {
    return perform(() => {
      const id = requiredId(bookId).toLowerCase()
      const expected = requiredInteger(expectedBookRevision, '作品版本')
      const db = this.openBook(id)
      const workspace = this.getBookRecoveryWorkspace()
      return { db, book: this.requireBookRevision(db, id, expected), bookPath: join(workspace.booksPath, id),
        rootPath: workspace.rootPath, generation: workspace.generation }
    })
  }

  registerRecoveredBook(book: BookSummary, expectedRoot: string, generation: number): BookSummary {
    return perform(() => {
      const workspace = this.getBookRecoveryWorkspace()
      if (!samePath(workspace.rootPath, expectedRoot) || workspace.generation !== generation) {
        throw new DomainError({ code: 'REVISION_CONFLICT', message: '当前书库已经切换，请重新预览恢复包。' })
      }
      const bookId = requiredId(book.id).toLowerCase()
      assertRecoveryComplete(join(workspace.booksPath, bookId), bookId, true)
      const probe = this.openOrphanReadOnly(bookId)
      let actual: BookSummary
      try {
        actual = this.readBookMetadata(probe, bookId)
        if (JSON.stringify(actual) !== JSON.stringify(book)) throw storageFailure()
      } finally { probe.close() }
      const studio = this.requireStudio()
      studio.transaction(() => {
        if (studio.prepare('SELECT id FROM books WHERE id = ?').get(bookId)) {
          throw new DomainError({ code: 'REVISION_CONFLICT', message: '当前书库已存在相同作品身份，未覆盖任何作品。' })
        }
        this.checkBookCapacity(studio)
        this.insertCatalog(studio, actual)
      }).immediate()
      return actual
    })
  }

  close(): void {
    if (this.inspiration?.open) this.inspiration.close()
    this.inspiration = null
    this.recoveryGeneration += 1
    if (this.activeBook?.db.open) this.activeBook.db.close()
    this.activeBook = null
    if (this.studio?.open) this.studio.close()
    this.studio = null
    this.rootPath = null
  }

  private requireStudio(): Database.Database {
    if (!this.studio) throw new DomainError({ code: 'WORKSPACE_REQUIRED', message: '请先选择本地书库目录。' })
    return this.studio
  }

  private requireRoot(): string {
    this.requireStudio()
    if (!this.rootPath) throw storageFailure()
    return this.rootPath
  }

  private openBook(bookId: string): Database.Database {
    const studio = this.requireStudio()
    const registered = studio.prepare('SELECT id FROM books WHERE id = ?').get(bookId)
    if (!registered) throw new DomainError({ code: 'NOT_FOUND', message: '当前书库中不存在这部作品。' })
    assertRecoveryComplete(join(this.requireRoot(), 'books', bookId), bookId)
    if (this.activeBook?.id === bookId) {
      this.readBookMetadata(this.activeBook.db, bookId)
      return this.activeBook.db
    }
    const directory = join(this.requireRoot(), 'books', bookId)
    assertLocalPath(join(this.requireRoot(), 'books'), true)
    assertLocalPath(directory, true)
    const databasePath = join(directory, 'book.sqlite')
    assertLocalPath(databasePath, false)
    assertDatabasePaths(databasePath)
    verifyExistingFile(databasePath, BOOK_APPLICATION_ID)
    const db = new Database(databasePath, { timeout: 2000, fileMustExist: true })
    try {
      verifyDatabase(db, BOOK_APPLICATION_ID)
      configure(db)
      this.readBookMetadata(db, bookId)
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = FULL')
    } catch (error) {
      db.close()
      throw error
    }
    if (this.activeBook?.db.open) this.activeBook.db.close()
    this.activeBook = { id: bookId, db }
    return db
  }

  private readBookMetadata(db: Database.Database, expectedId: string): BookSummary {
    const lifecycle = (db.pragma('user_version', { simple: true }) as number) >= 15 ? ', lifecycle' : ''
    const row = db.prepare(`SELECT ${BOOK_COLUMNS}${lifecycle} FROM book_meta WHERE singleton = 1`).get() as BookRow | undefined
    if (!row || row.id !== expectedId) throw new DomainError({ code: 'STORAGE_ERROR', message: '作品数据库身份与当前目录不一致，已停止访问。' })
    return bookSummary(row)
  }

  private readChapterRow(db: Database.Database, chapterId: string): RevisionRow {
    const row = db.prepare(`SELECT ${CHAPTER_COLUMNS}, r.document_json, r.plain_text, r.content_hash
      FROM chapters c JOIN chapter_revisions r ON r.id = c.current_revision_id AND r.chapter_id = c.id
      WHERE c.id = ?`).get(chapterId) as RevisionRow | undefined
    if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个章节。' })
    return row
  }

  private requireBookRevision(db: Database.Database, bookId: string, expected: number): BookSummary {
    const book = this.readBookMetadata(db, bookId)
    if (book.revision !== expected) throw new DomainError({ code: 'REVISION_CONFLICT', message: '作品目录或资料已更新，请刷新后再执行这项操作。' })
    return book
  }

  private requireWritable(db: Database.Database, bookId: string, expected?: number): BookSummary {
    const book = expected === undefined ? this.readBookMetadata(db, bookId) : this.requireBookRevision(db, bookId, expected)
    if (book.archivedAt) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请先取消归档再继续编辑。' })
    return book
  }

  private requireVolume(db: Database.Database, volumeId: string | null): void {
    if (volumeId !== null && !db.prepare('SELECT id FROM volumes WHERE id = ?').get(volumeId)) {
      throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个卷。' })
    }
  }

  private revisionConflict(currentRevisionId: string): never {
    throw new DomainError({ code: 'REVISION_CONFLICT', message: '章节已有更新版本，当前操作没有覆盖新稿。', currentRevisionId })
  }

  private historyRow(db: Database.Database, chapterId: string, revisionId: string): HistoryRow {
    const row = db.prepare(`SELECT id, sequence, parent_revision_id, restored_from_revision_id, reason,
      character_count, created_at, document_json, plain_text, content_hash FROM chapter_revisions WHERE chapter_id = ? AND id = ?`)
      .get(chapterId, revisionId) as HistoryRow | undefined
    if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前章节中不存在这个历史版本。' })
    return row
  }

  private nextSequence(db: Database.Database): number {
    const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS maximum FROM chapter_revisions').get() as { maximum: number }
    if (!Number.isSafeInteger(row.maximum) || row.maximum >= Number.MAX_SAFE_INTEGER - 1) throw storageFailure()
    return row.maximum + 1
  }

  private reorder(input: ReorderVolumesInput | ReorderChaptersInput, table: 'volumes' | 'chapters', field: 'volumeIds' | 'chapterIds', maximum: number): BookSnapshot {
    return perform(() => {
      const data = payload(input)
      const bookId = requiredId(data.bookId).toLowerCase()
      const expected = requiredInteger(data.expectedBookRevision, '作品版本')
      const rawIds = data[field]
      if (!Array.isArray(rawIds) || rawIds.length > maximum) throw new DomainError({ code: 'INVALID_INPUT', message: '排序列表无效。' })
      const ids = Array.from(rawIds, (value: unknown) => requiredId(value).toLowerCase())
      if (new Set(ids).size !== ids.length) throw new DomainError({ code: 'INVALID_INPUT', message: '排序列表包含重复项目。' })
      const db = this.openBook(bookId)
      db.transaction(() => {
        this.requireWritable(db, bookId, expected)
        const rows = db.prepare(`SELECT id, position FROM ${table} ORDER BY position, id LIMIT ?`).all(maximum + 1) as { id: string; position: number }[]
        const existing = new Set(rows.map((row) => row.id))
        if (rows.length !== ids.length || ids.some((id) => !existing.has(id))) throw new DomainError({ code: 'REVISION_CONFLICT', message: '排序必须包含当前作品的全部项目，请刷新后重试。' })
        if (ids.every((id, index) => rows[index]?.id === id)) return
        const now = new Date().toISOString()
        const maxPosition = rows.reduce((max, row) => Math.max(max, row.position), -1)
        if (!Number.isSafeInteger(maxPosition) || maxPosition > Number.MAX_SAFE_INTEGER / 3) throw storageFailure()
        // UNIQUE(position) 在逐行更新时生效，先搬到不重叠的临时区间再写最终次序。
        db.prepare(`UPDATE ${table} SET position = position + ?`).run(maxPosition + ids.length + 1)
        const update = db.prepare(`UPDATE ${table} SET position = ?, updated_at = ? WHERE id = ?`)
        ids.forEach((id, index) => update.run(index, now, id))
        this.normalizeChapterPositions(db, now)
        this.recordMutation(db, 'book.structure', now)
      }).immediate()
      return this.getBook({ bookId })
    })
  }

  private normalizeChapterPositions(db: Database.Database, now: string): void {
    const rows = db.prepare(`SELECT c.id, c.position FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id
      ORDER BY CASE WHEN c.volume_id IS NULL THEN 0 ELSE 1 END, v.position, c.position, c.id LIMIT ?`)
      .all(MAX_CHAPTERS + 1) as { id: string; position: number }[]
    if (rows.length > MAX_CHAPTERS) throw storageFailure()
    if (rows.every((row, index) => row.position === index)) return
    const maximum = rows.reduce((max, row) => Math.max(max, row.position), -1)
    if (!Number.isSafeInteger(maximum) || maximum > Number.MAX_SAFE_INTEGER / 3) throw storageFailure()
    // 全书章号固定为未分卷、卷顺序、卷内顺序；界面与导出共同读取这一持久顺序。
    db.prepare('UPDATE chapters SET position = position + ?').run(maximum + rows.length + 1)
    const update = db.prepare('UPDATE chapters SET position = ?, updated_at = ? WHERE id = ?')
    rows.forEach((row, index) => update.run(index, now, row.id))
  }

  private openOrphanReadOnly(bookId: string): Database.Database {
    const directory = join(this.requireRoot(), 'books', bookId)
    assertLocalPath(join(this.requireRoot(), 'books'), true)
    assertLocalPath(directory, true)
    assertRecoveryComplete(directory, bookId)
    const path = join(directory, 'book.sqlite')
    assertLocalPath(path, false)
    assertDatabasePaths(path)
    const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 2000 })
    try {
      verifyDatabase(db, BOOK_APPLICATION_ID)
      configure(db)
      this.readBookMetadata(db, bookId)
      return db
    } catch (error) { db.close(); throw error }
  }

  private checkBookCapacity(studio: Database.Database): void {
    const count = (studio.prepare('SELECT COUNT(*) AS count FROM books').get() as { count: number }).count
    if (count >= MAX_BOOKS) throw new DomainError({ code: 'INVALID_INPUT', message: `当前书库已达到 ${MAX_BOOKS} 部作品的上限。` })
  }

  private insertCatalog(studio: Database.Database, book: BookSummary): void {
    studio.prepare(`INSERT INTO books (id, title, genre, synopsis, archived_at, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(book.id, book.title, book.genre, book.synopsis, book.archivedAt, book.revision, book.createdAt, book.updatedAt)
  }

  private recordMutation(db: Database.Database, kind: 'book.metadata' | 'book.structure' | 'chapter.metadata' | 'chapter.finalized', now: string, chapterId: string | null = null): void {
    let revisionId: string | null = null
    if (kind === 'chapter.metadata' || kind === 'chapter.finalized') {
      if (!chapterId) throw storageFailure()
      const chapter = db.prepare('SELECT current_revision_id FROM chapters WHERE id = ?').get(chapterId) as { current_revision_id: string } | undefined
      if (!chapter) throw storageFailure()
      // 在变更事务中固定当时的正文来源；同一正文允许多次资料修改或定稿事件。
      revisionId = chapter.current_revision_id
    }
    db.prepare('UPDATE book_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1').run(now)
    const row = db.prepare('SELECT revision FROM book_meta WHERE singleton = 1').get() as { revision: number }
    db.prepare('INSERT INTO outbox (id, kind, chapter_id, revision_id, book_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), kind, chapterId, revisionId, row.revision, now)
  }

  private recordChapterChange(db: Database.Database, chapterId: string, revisionId: string, now: string, source?: WritingDay['source']): void {
    db.prepare('UPDATE book_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1').run(now)
    const row = db.prepare('SELECT revision FROM book_meta WHERE singleton = 1').get() as { revision: number }
    db.prepare(`INSERT INTO outbox (id, kind, chapter_id, revision_id, book_revision, created_at)
      VALUES (?, 'chapter.changed', ?, ?, ?, ?)`).run(randomUUID(), chapterId, revisionId, row.revision, now)
    recordWritingActivity(db, chapterId, revisionId, now, source)
  }

  private updateCatalog(book: BookSummary): void {
    // 正文已在每书事务内持久化；目录缓存失败不能把已提交保存伪装成失败。
    try {
      this.requireStudio().prepare('UPDATE books SET title = ?, genre = ?, synopsis = ?, archived_at = ?, revision = ?, updated_at = ? WHERE id = ?')
        .run(book.title, book.genre, book.synopsis, book.archivedAt, book.revision, book.updatedAt, book.id)
    } catch {
      console.warn('storyweave.catalog_refresh_failed')
    }
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
  }
}
