import type Database from 'better-sqlite3'
import { DomainError, requiredId } from '../../contracts/api'
import { MAX_NOTE_BODY, NOTE_MATERIAL_SCHEMA_VERSION, parseNoteMaterial, sameNoteChapters, sameNoteMaterial, type NoteDetail, type NoteFields } from '../../contracts/notes'
import {
  parseCopyInspirationInput, parseInspirationFields, parseListInspirationInput, parseSaveInspirationInput,
  type CopyInspirationInput, type InspirationItem, type InspirationPage, type ListInspirationInput, type SaveInspirationInput,
  parseImportInspirationsInput, type ImportInspirationsInput, type ImportInspirationsReceipt,
} from '../../contracts/workbench'
import { NotesRepository } from '../notes/notes-repository'
import type { StudioRepository } from '../storage/studio-repository'
import { isStudyCardKind, studyMaterialText } from '../../contracts/study-card'
import {
  INSPIRATION_THUMBNAIL_SCHEMA_VERSION, matchesCopiedInspirationThumbnail, matchesInspirationThumbnail, parseReadInspirationThumbnailInput,
  type InspirationThumbnailImage, type ReadInspirationThumbnailInput,
} from '../../contracts/inspiration-thumbnail'
import { NOTE_THUMBNAIL_SCHEMA_VERSION, type NoteThumbnailFields } from '../../contracts/note-thumbnail'
import { validateNoteThumbnailContent } from '../notes/thumbnail-repository'
import { inspirationThumbnailBudget, readInspirationThumbnail, readInspirationThumbnailMetadata, supportsInspirationThumbnails, writeInspirationThumbnail } from './inspiration-thumbnail-repository'

interface Row {
  id: string; revision: number; kind: string; title: string; body: string; source: string; tags_json: string
  parent_id: string | null; book_id: string | null; archived: number; created_at: string; updated_at: string
}
function failure(message: string, code: 'STORAGE_ERROR' | 'INVALID_INPUT' | 'REVISION_CONFLICT' | 'NOT_FOUND' = 'STORAGE_ERROR'): never {
  throw new DomainError({ code, message })
}
function perform<T>(action: () => T): T {
  try { return action() } catch (error) {
    if (error instanceof DomainError) throw error
    return failure('灵感收件箱读写失败，请保留当前输入。')
  }
}
function item(db: Database.Database, row: Row): InspirationItem {
  if (requiredId(row.id).toLowerCase() !== row.id || !Number.isSafeInteger(row.revision) || row.revision < 1
    || typeof row.tags_json !== 'string' || row.tags_json.length > 8_000 || ![0, 1].includes(row.archived)
    || ![row.created_at, row.updated_at].every((time) => typeof time === 'string' && time.length === 24
      && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time)
    || row.created_at > row.updated_at) return failure('灵感条目格式无效。')
  const fields = parseInspirationFields({ kind: row.kind, title: row.title, body: row.body, source: row.source, tags: JSON.parse(row.tags_json),
    parentId: row.parent_id, bookId: row.book_id, archived: row.archived === 1 })
  const saved = { ...fields, id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
  return { ...saved, thumbnail: readInspirationThumbnailMetadata(db, saved) }
}
function read(db: Database.Database, id: string): InspirationItem {
  const row = db.prepare('SELECT * FROM inspirations WHERE id = ?').get(id) as Row | undefined
  if (!row) return failure('灵感条目不存在。', 'NOT_FOUND')
  return item(db, row)
}

export class InspirationRepository {
  constructor(private readonly studio: StudioRepository, private readonly notes: NotesRepository) {}

  list(input: ListInspirationInput): InspirationPage {
    return perform(() => {
      const data = parseListInspirationInput(input)
      const db = this.studio.getInspirationDatabase()
      if (!db) return { items: [], total: 0, nextOffset: null, schemaVersion: INSPIRATION_THUMBNAIL_SCHEMA_VERSION }
      return db.transaction(() => {
        inspirationThumbnailBudget(db)
        const where = `(@archived = 1 OR archived = 0) AND (@bookId IS NULL OR book_id = @bookId)
          AND (@search = '' OR instr(lower(title), lower(@search)) > 0 OR instr(lower(body), lower(@search)) > 0 OR instr(lower(tags_json), lower(@search)) > 0)`
        const params = { archived: data.includeArchived ? 1 : 0, bookId: data.bookId ?? null, search: data.search ?? '' }
        const total = (db.prepare(`SELECT COUNT(*) AS total FROM inspirations WHERE ${where}`).get(params) as { total: number }).total
        const offset = data.offset ?? 0
        const items = (db.prepare(`SELECT * FROM inspirations WHERE ${where} ORDER BY updated_at DESC, id LIMIT 50 OFFSET @offset`).all({ ...params, offset }) as Row[]).map((row) => item(db, row))
        return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null, schemaVersion: db.pragma('user_version', { simple: true }) as number }
      })()
    })
  }

  readThumbnail(input: ReadInspirationThumbnailInput): InspirationThumbnailImage {
    return perform(() => {
      const data = parseReadInspirationThumbnailInput(input), db = this.studio.getInspirationDatabase()
      if (!db) return failure('全局灵感库尚无条目。', 'NOT_FOUND')
      return db.transaction(() => readInspirationThumbnail(db, data, read(db, data.id)))()
    })
  }

  save(input: SaveInspirationInput): InspirationItem {
    return perform(() => {
      const data = parseSaveInspirationInput(input)
      if (data.fields.bookId && !this.studio.getWorkspace().books.some((book) => book.id === data.fields.bookId)) return failure('关联作品不属于当前书库。', 'INVALID_INPUT')
      const db = this.studio.getInspirationDatabase(true)!
      return db.transaction(() => {
        inspirationThumbnailBudget(db)
        if (data.thumbnail !== undefined && !supportsInspirationThumbnails(db)) {
          throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并启用全局灵感配图，文字内容仍可照常保存。' })
        }
        if (data.thumbnail) validateNoteThumbnailContent(data.thumbnail)
        const previous = db.prepare('SELECT revision FROM inspirations WHERE id = ?').get(data.id) as { revision: number } | undefined
        if ((previous?.revision ?? 0) !== data.expectedRevision) return failure('灵感已有新版本，请保留输入并重新读取。', 'REVISION_CONFLICT')
        const original = previous ? read(db, data.id) : null
        if (data.expectedRevision >= Number.MAX_SAFE_INTEGER) return failure('灵感版本超出支持范围。')
        if (!previous && (db.prepare('SELECT COUNT(*) AS total FROM inspirations').get() as { total: number }).total >= 10_000) return failure('当前收件箱最多支持 10,000 条灵感。', 'INVALID_INPUT')
        // 父子链表达参考作品、场景观察、摘录与手法分析，禁止循环和失联来源。
        const visited = new Set([data.id])
        let parent = data.fields.parentId
        while (parent) {
          if (visited.has(parent) || visited.size > 100) return failure('参考链不能形成循环或超过 100 层。', 'INVALID_INPUT')
          visited.add(parent)
          parent = read(db, parent).parentId
        }
        const now = new Date().toISOString()
        const params = { id: data.id, revision: data.expectedRevision + 1, ...data.fields, tags: JSON.stringify(data.fields.tags), archived: data.fields.archived ? 1 : 0, now }
        if (previous) db.prepare(`UPDATE inspirations SET revision = @revision, kind = @kind, title = @title, body = @body, source = @source,
          tags_json = @tags, parent_id = @parentId, book_id = @bookId, archived = @archived, updated_at = @now WHERE id = @id`).run(params)
        else db.prepare(`INSERT INTO inspirations (id, revision, kind, title, body, source, tags_json, parent_id, book_id, archived, created_at, updated_at)
          VALUES (@id, @revision, @kind, @title, @body, @source, @tags, @parentId, @bookId, @archived, @now, @now)`).run(params)
        db.prepare('INSERT INTO inspiration_revisions (id, revision, fields_json, created_at) VALUES (?, ?, ?, ?)').run(data.id, params.revision, JSON.stringify(data.fields), now)
        if (data.thumbnail !== undefined && !matchesInspirationThumbnail(original?.thumbnail ?? null, data.thumbnail)) {
          writeInspirationThumbnail(db, { id: data.id, revision: params.revision, createdAt: original?.createdAt ?? now, updatedAt: now }, data.thumbnail, now)
        }
        return read(db, data.id)
      }).immediate()
    })
  }

  copyToNote(input: CopyInspirationInput): NoteDetail {
    return perform(() => {
      const data = parseCopyInspirationInput(input)
      const db = this.studio.getInspirationDatabase()
      if (!db) return failure('灵感收件箱尚无条目。', 'NOT_FOUND')
      return db.transaction(() => {
        // 固定来源文字与图片的同一快照，目标图片仍由笔记事务一并保存。
        const source = read(db, data.id)
        if (source.revision !== data.expectedRevision) return failure('灵感已有新版本，请重读后复制。', 'REVISION_CONFLICT')
        const attribution = [`灵感来源：${source.title}`, source.source && `出处：${source.source}`, source.tags.length && `标签：${source.tags.join('、')}`].filter(Boolean).join('\n')
        const fields: NoteFields = { title: source.title, category: source.kind === 'method' || source.kind === 'technique' || isStudyCardKind(source.kind) ? 'method' : source.kind === 'idea' ? 'inspiration' : 'material',
          body: `${studyMaterialText(source.kind, source.body)}\n\n${attribution}` }
        if (fields.title.length > 120 || fields.body.length > MAX_NOTE_BODY) return failure('这条灵感超过作品笔记的标题或正文上限，请先拆分或缩短后复制；原文会保留。', 'INVALID_INPUT')
        const target = this.studio.getNotesDatabase(data.bookId)
        if (source.thumbnail && (target.db.pragma('user_version', { simple: true }) as number) < NOTE_THUMBNAIL_SCHEMA_VERSION) {
          throw new DomainError({ code: 'FORBIDDEN', message: '这条灵感带有原图，请先备份升级目标作品后完整复制；原图不会被丢弃。' })
        }
        let thumbnail: NoteThumbnailFields | null = null
        if (source.thumbnail) {
          const image = readInspirationThumbnail(db, { id: source.id, imageRevision: source.thumbnail.inspirationRevision }, source)
          thumbnail = { mime: image.mime, dataBase64: image.dataBase64, sha256: image.sha256, alt: image.alt }
        }
        const material = (target.db.pragma('user_version', { simple: true }) as number) >= NOTE_MATERIAL_SCHEMA_VERSION
          ? parseNoteMaterial({ source: source.source, tags: source.tags }) : undefined
        // 复制不删除或改写收件箱原件；同一 noteId 的重试须核对完整内容，避免重复写入。
        let existing: NoteDetail | null = null
        try { existing = this.notes.get({ bookId: data.bookId, id: data.noteId }) } catch (error) {
          if (!(error instanceof DomainError) || error.detail.code !== 'NOT_FOUND') throw error
        }
        if (existing) {
          if (existing.title !== fields.title || existing.body !== fields.body || existing.category !== fields.category
            || (material !== undefined && !sameNoteMaterial(existing.material, material))
            || !matchesCopiedInspirationThumbnail(existing.thumbnail, source.thumbnail)
            || (data.chapterIds !== undefined && !sameNoteChapters(existing.chapterIds, data.chapterIds))) return failure('目标笔记已有其他内容、配图、标签、出处或章节关联，本次没有覆盖。', 'REVISION_CONFLICT')
          if (existing.thumbnail && thumbnail) {
            const savedImage = this.notes.readThumbnail({ bookId: data.bookId, id: existing.id, imageRevision: existing.thumbnail.noteRevision })
            if (savedImage.dataBase64 !== thumbnail.dataBase64) return failure('目标笔记配图与来源原图不同，本次没有覆盖。', 'REVISION_CONFLICT')
          }
          return existing
        }
        return this.notes.create({ bookId: data.bookId, expectedBookRevision: data.expectedBookRevision, id: data.noteId, fields,
          ...(thumbnail === null ? {} : { thumbnail }),
          ...(material === undefined ? {} : { material }),
          ...(data.chapterIds === undefined ? {} : { chapterIds: data.chapterIds }) })
      })()
    })
  }

  importItems(input: ImportInspirationsInput): ImportInspirationsReceipt {
    return perform(() => {
      const data = parseImportInspirationsInput(input)
      const db = this.studio.getInspirationDatabase(true)!
      return db.transaction(() => {
        // 客户端固定导入标识，未知回执重试只确认相同内容；整批在同一事务提交。
        const items = data.items.map((entry) => {
          if (db.prepare('SELECT id FROM inspirations WHERE id = ?').get(entry.id)) {
            const saved = read(db, entry.id)
            if (saved.revision !== 1 || saved.thumbnail !== null || JSON.stringify(parseInspirationFields(saved)) !== JSON.stringify(entry.fields)) return failure('已有导入条目内容或配图不符，本次没有覆盖。', 'REVISION_CONFLICT')
            return saved
          }
          return this.save(entry)
        })
        return { items }
      }).immediate()
    })
  }
}
