import type Database from 'better-sqlite3'
import { DomainError } from '../../contracts/api'
import { MAX_NOTE_BODY, type NoteDetail, type NoteFields } from '../../contracts/notes'
import {
  parseCopyInspirationInput, parseInspirationFields, parseListInspirationInput, parseSaveInspirationInput,
  type CopyInspirationInput, type InspirationItem, type InspirationPage, type ListInspirationInput, type SaveInspirationInput,
} from '../../contracts/workbench'
import { NotesRepository } from '../notes/notes-repository'
import type { StudioRepository } from '../storage/studio-repository'

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
function item(row: Row): InspirationItem {
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.tags_json !== 'string' || row.tags_json.length > 8_000 || ![0, 1].includes(row.archived)) return failure('灵感条目格式无效。')
  const fields = parseInspirationFields({ kind: row.kind, title: row.title, body: row.body, source: row.source, tags: JSON.parse(row.tags_json),
    parentId: row.parent_id, bookId: row.book_id, archived: row.archived === 1 })
  return { ...fields, id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
}
function read(db: Database.Database, id: string): InspirationItem {
  const row = db.prepare('SELECT * FROM inspirations WHERE id = ?').get(id) as Row | undefined
  if (!row) return failure('灵感条目不存在。', 'NOT_FOUND')
  return item(row)
}

export class InspirationRepository {
  constructor(private readonly studio: StudioRepository, private readonly notes: NotesRepository) {}

  list(input: ListInspirationInput): InspirationPage {
    return perform(() => {
      const data = parseListInspirationInput(input)
      const db = this.studio.getInspirationDatabase()
      if (!db) return { items: [], total: 0, nextOffset: null }
      return db.transaction(() => {
        const where = `(@archived = 1 OR archived = 0) AND (@bookId IS NULL OR book_id = @bookId)
          AND (@search = '' OR instr(lower(title), lower(@search)) > 0 OR instr(lower(body), lower(@search)) > 0 OR instr(lower(tags_json), lower(@search)) > 0)`
        const params = { archived: data.includeArchived ? 1 : 0, bookId: data.bookId ?? null, search: data.search ?? '' }
        const total = (db.prepare(`SELECT COUNT(*) AS total FROM inspirations WHERE ${where}`).get(params) as { total: number }).total
        const offset = data.offset ?? 0
        const items = (db.prepare(`SELECT * FROM inspirations WHERE ${where} ORDER BY updated_at DESC, id LIMIT 50 OFFSET @offset`).all({ ...params, offset }) as Row[]).map(item)
        return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null }
      })()
    })
  }

  save(input: SaveInspirationInput): InspirationItem {
    return perform(() => {
      const data = parseSaveInspirationInput(input)
      if (data.fields.bookId && !this.studio.getWorkspace().books.some((book) => book.id === data.fields.bookId)) return failure('关联作品不属于当前书库。', 'INVALID_INPUT')
      const db = this.studio.getInspirationDatabase(true)!
      return db.transaction(() => {
        const previous = db.prepare('SELECT revision FROM inspirations WHERE id = ?').get(data.id) as { revision: number } | undefined
        if ((previous?.revision ?? 0) !== data.expectedRevision) return failure('灵感已有新版本，请保留输入并重新读取。', 'REVISION_CONFLICT')
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
        return read(db, data.id)
      }).immediate()
    })
  }

  copyToNote(input: CopyInspirationInput): NoteDetail {
    return perform(() => {
      const data = parseCopyInspirationInput(input)
      const db = this.studio.getInspirationDatabase()
      if (!db) return failure('灵感收件箱尚无条目。', 'NOT_FOUND')
      const source = read(db, data.id)
      if (source.revision !== data.expectedRevision) return failure('灵感已有新版本，请重读后复制。', 'REVISION_CONFLICT')
      const attribution = [`灵感来源：${source.title}`, source.source && `出处：${source.source}`, source.tags.length && `标签：${source.tags.join('、')}`].filter(Boolean).join('\n')
      const fields: NoteFields = { title: source.title, category: source.kind === 'method' || source.kind === 'technique' ? 'method' : source.kind === 'idea' ? 'inspiration' : 'material',
        body: `${source.body}\n\n${attribution}` }
      if (fields.title.length > 120 || fields.body.length > MAX_NOTE_BODY) return failure('这条灵感超过作品笔记的标题或正文上限，请先拆分或缩短后复制；原文会保留。', 'INVALID_INPUT')
      // 复制不删除或改写收件箱原件；同一 noteId 的重试须核对完整内容，避免重复写入。
      let existing: NoteDetail | null = null
      try { existing = this.notes.get({ bookId: data.bookId, id: data.noteId }) } catch (error) {
        if (!(error instanceof DomainError) || error.detail.code !== 'NOT_FOUND') throw error
      }
      if (existing) {
        if (existing.title !== fields.title || existing.body !== fields.body || existing.category !== fields.category) return failure('目标笔记已有其他内容，本次没有覆盖。', 'REVISION_CONFLICT')
        return existing
      }
      return this.notes.create({ bookId: data.bookId, expectedBookRevision: data.expectedBookRevision, id: data.noteId, fields })
    })
  }
}
