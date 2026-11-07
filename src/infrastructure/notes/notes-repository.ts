import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredInteger } from '../../contracts/api'
import { KNOWLEDGE_KINDS, type KnowledgeKind } from '../../contracts/knowledge'
import {
  MAX_NOTES, MAX_NOTE_BODY, NOTE_PAGE_SIZE, parseCreateNoteInput, parseListNotesInput,
  parseNoteFields, parseNoteInput, parsePromoteNoteInput, parseUpdateNoteInput,
  type CreateNoteInput, type ListNotesInput, type NoteDetail, type NoteFields, type NoteInput,
  type NotePage, type NotePromotion, type NoteSummary, type PromoteNoteInput, type UpdateNoteInput,
} from '../../contracts/notes'
import { KnowledgeRepository } from '../knowledge/knowledge-repository'
import type { StudioRepository } from '../storage/studio-repository'

interface BookState { id: string; revision: number; knowledge_revision: number; archived_at: string | null }
interface NoteRow {
  id: unknown; book_id: unknown; category: unknown; title: unknown; revision: unknown
  created_at: unknown; updated_at: unknown
  promotion_note_id: unknown; promotion_book_id: unknown; promotion_item_id: unknown
  promotion_kind: unknown; promotion_note_revision: unknown; promotion_created_at: unknown; target_item_id: unknown
}
interface SummaryRow extends NoteRow { excerpt: unknown; body_valid: unknown }
interface DetailRow extends NoteRow { body: unknown; promotion_fields_json: unknown }
type NoteMetadata = Pick<NoteSummary, 'id' | 'bookId' | 'category' | 'title' | 'revision' | 'createdAt' | 'updatedAt'>

const MAX_FIELDS_JSON_BYTES = (MAX_NOTE_BODY + 120) * 6 + 128
const NOTE_COLUMNS = `n.id, n.book_id, n.category,
  CASE WHEN length(CAST(n.title AS BLOB)) <= 480 THEN n.title END AS title,
  n.revision, n.created_at, n.updated_at,
  p.note_id AS promotion_note_id, p.book_id AS promotion_book_id, p.item_id AS promotion_item_id,
  p.kind AS promotion_kind, p.note_revision AS promotion_note_revision, p.created_at AS promotion_created_at,
  k.id AS target_item_id`
const NOTE_TABLES = `notes n LEFT JOIN note_promotions p ON p.note_id = n.id
  LEFT JOIN knowledge_items k ON k.id = p.item_id AND k.book_id = p.book_id`
const LIST_FILTER = `n.book_id = @bookId AND (@category IS NULL OR n.category = @category)
  AND (@search = '' OR instr(n.title, @search) > 0 OR instr(n.body, @search) > 0)`

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '素材与笔记读写失败，请保留当前编辑并检查作品文件。' })
}

function conflict(): DomainError {
  return new DomainError({ code: 'REVISION_CONFLICT', message: '作品或笔记已有新版本，请保留当前编辑，重新读取后比较再保存。' })
}

function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}

function storedId(value: unknown): string {
  try {
    const id = requiredId(value)
    if (id !== id.toLowerCase()) throw storageFailure()
    return id
  } catch { throw storageFailure() }
}

function storedInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  try {
    const number = requiredInteger(value, '存储版本或数量', maximum)
    if (number < minimum) throw storageFailure()
    return number
  } catch { throw storageFailure() }
}

function storedTime(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw storageFailure()
  return value
}

function storedFields(value: unknown): NoteFields {
  try {
    const fields = parseNoteFields(value)
    if (fields.title !== (value as NoteFields).title) throw storageFailure()
    return fields
  } catch { throw storageFailure() }
}

function sameFields(first: NoteFields, second: NoteFields): boolean {
  return first.category === second.category && first.title === second.title && first.body === second.body
}

function readState(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, revision, knowledge_revision, archived_at FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!row || storedId(row.id) !== bookId) throw storageFailure()
  return { id: bookId, revision: storedInteger(row.revision), knowledge_revision: storedInteger(row.knowledge_revision),
    archived_at: row.archived_at === null ? null : storedTime(row.archived_at) }
}

function metadata(row: NoteRow, state: BookState): NoteMetadata {
  const fields = storedFields({ category: row.category, title: row.title, body: '' })
  if (storedId(row.book_id) !== state.id) throw storageFailure()
  return { id: storedId(row.id), bookId: state.id, category: fields.category, title: fields.title,
    revision: storedInteger(row.revision, 1, state.revision), createdAt: storedTime(row.created_at), updatedAt: storedTime(row.updated_at) }
}

function promotion(row: NoteRow, note: NoteMetadata): NotePromotion | null {
  if (row.promotion_note_id === null) {
    if ([row.promotion_book_id, row.promotion_item_id, row.promotion_kind, row.promotion_note_revision,
      row.promotion_created_at, row.target_item_id].some((value) => value !== null)) throw storageFailure()
    return null
  }
  const itemId = storedId(row.promotion_item_id)
  if (storedId(row.promotion_note_id) !== note.id || storedId(row.promotion_book_id) !== note.bookId ||
      row.target_item_id !== itemId || typeof row.promotion_kind !== 'string' || !KNOWLEDGE_KINDS.includes(row.promotion_kind as KnowledgeKind)) throw storageFailure()
  return { itemId, kind: row.promotion_kind as KnowledgeKind,
    noteRevision: storedInteger(row.promotion_note_revision, 1, note.revision), createdAt: storedTime(row.promotion_created_at) }
}

function readDetail(db: Database.Database, state: BookState, id: string): NoteDetail {
  const row = db.prepare(`SELECT ${NOTE_COLUMNS},
    CASE WHEN length(CAST(n.body AS BLOB)) <= ${MAX_NOTE_BODY * 4} THEN n.body END AS body,
    CASE WHEN length(CAST(p.fields_json AS BLOB)) <= ${MAX_FIELDS_JSON_BYTES} THEN p.fields_json END AS promotion_fields_json
    FROM ${NOTE_TABLES} WHERE n.book_id = ? AND n.id = ?`).get(state.id, id) as DetailRow | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这条笔记。' })
  const note = metadata(row, state)
  if (note.id !== id) throw storageFailure()
  const fields = storedFields({ category: row.category, title: row.title, body: row.body })
  const converted = promotion(row, note)
  let promotedFields: NoteFields | null = null
  if (converted) {
    if (typeof row.promotion_fields_json !== 'string' || row.promotion_fields_json.length > MAX_FIELDS_JSON_BYTES) throw storageFailure()
    promotedFields = storedFields(JSON.parse(row.promotion_fields_json))
    if (!promotedFields.body.trim() || (converted.noteRevision === note.revision && !sameFields(promotedFields, fields))) throw storageFailure()
  } else if (row.promotion_fields_json !== null) throw storageFailure()
  return { ...note, ...fields, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision,
    archived: state.archived_at !== null, promotion: converted, promotedFields }
}

function requireWritable(state: BookState, expectedBookRevision: number): void {
  if (state.archived_at !== null) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请先取消归档再编辑或转换笔记。' })
  if (state.revision !== expectedBookRevision) throw conflict()
}

function advanceBook(db: Database.Database, state: BookState, now: string): void {
  const changed = db.prepare(`UPDATE book_meta SET revision = ?, updated_at = ?
    WHERE singleton = 1 AND id = ? AND revision = ? AND knowledge_revision = ? AND archived_at IS NULL`)
    .run(state.revision + 1, now, state.id, state.revision, state.knowledge_revision)
  if (changed.changes !== 1) throw conflict()
}

export class NotesRepository {
  constructor(private readonly studio: StudioRepository) {}

  list(input: ListNotesInput): NotePage {
    return perform(() => {
      const data = parseListNotesInput(input)
      const { db } = this.studio.getNotesDatabase(data.bookId)
      return db.transaction(() => {
        const state = readState(db, data.bookId)
        if (data.expectedBookRevision !== undefined && state.revision !== data.expectedBookRevision) throw conflict()
        const params = { bookId: data.bookId, category: data.category ?? null, search: data.search ?? '' }
        const count = db.prepare(`SELECT COUNT(*) AS total FROM notes n WHERE ${LIST_FILTER}`).get(params) as { total: unknown }
        const total = storedInteger(count.total, 0, MAX_NOTES)
        const limit = data.limit ?? NOTE_PAGE_SIZE
        const offset = data.offset ?? 0
        // 正文在库内检索和截取，列表只传递本页摘要；总数和分页固定在同一作品版本。
        const rows = db.prepare(`SELECT ${NOTE_COLUMNS}, substr(n.body, 1, 180) AS excerpt,
          CASE WHEN length(n.body) <= ${MAX_NOTE_BODY} AND length(CAST(n.body AS BLOB)) <= ${MAX_NOTE_BODY * 4}
            AND instr(n.body, char(0)) = 0 THEN 1 ELSE 0 END AS body_valid
          FROM ${NOTE_TABLES} WHERE ${LIST_FILTER}
          ORDER BY n.updated_at DESC, n.id LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset }) as SummaryRow[]
        if (rows.length !== Math.min(limit, Math.max(0, total - offset))) throw storageFailure()
        const items = rows.map((row): NoteSummary => {
          const note = metadata(row, state)
          if (row.body_valid !== 1 || typeof row.excerpt !== 'string' || row.excerpt.includes('\0') || Array.from(row.excerpt).length > 180) throw storageFailure()
          let excerpt = row.excerpt.slice(0, 180)
          // SQLite 按码点截取；再按契约字符长度收口时，保持代理对完整。
          if (/[\uD800-\uDBFF]$/.test(excerpt) && /^[\uDC00-\uDFFF]/.test(row.excerpt.slice(180))) excerpt = excerpt.slice(0, -1)
          return { ...note, excerpt, promotion: promotion(row, note) }
        })
        if (new Set(items.map((item) => item.id)).size !== items.length) throw storageFailure()
        return { bookId: state.id, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision,
          archived: state.archived_at !== null, items, total, nextOffset: offset + items.length < total ? offset + items.length : null }
      })()
    })
  }

  get(input: NoteInput): NoteDetail {
    return perform(() => {
      const data = parseNoteInput(input)
      const { db } = this.studio.getNotesDatabase(data.bookId)
      return db.transaction(() => readDetail(db, readState(db, data.bookId), data.id))()
    })
  }

  create(input: CreateNoteInput): NoteDetail {
    return perform(() => this.write(parseCreateNoteInput(input)))
  }

  update(input: UpdateNoteInput): NoteDetail {
    return perform(() => this.write(parseUpdateNoteInput(input)))
  }

  private write(data: CreateNoteInput | UpdateNoteInput): NoteDetail {
    const { db } = this.studio.getNotesDatabase(data.bookId)
    const detail = db.transaction(() => {
      const state = readState(db, data.bookId)
      requireWritable(state, data.expectedBookRevision)
      const previous = 'expectedNoteRevision' in data ? readDetail(db, state, data.id) : null
      if (previous && 'expectedNoteRevision' in data && previous.revision !== data.expectedNoteRevision) throw conflict()
      if (previous && sameFields(previous, data.fields)) return previous
      if (!previous) {
        if (db.prepare('SELECT id FROM notes WHERE id = ?').get(data.id)) {
          throw new DomainError({ code: 'REVISION_CONFLICT', message: '这条笔记的标识已存在，请保留当前编辑并重新读取。' })
        }
        const count = db.prepare('SELECT COUNT(*) AS total FROM notes WHERE book_id = ?').get(data.bookId) as { total: unknown }
        if (storedInteger(count.total, 0, MAX_NOTES) >= MAX_NOTES) {
          throw new DomainError({ code: 'INVALID_INPUT', message: `每部作品最多支持 ${MAX_NOTES} 条笔记。` })
        }
      }
      if (state.revision >= Number.MAX_SAFE_INTEGER || (previous?.revision ?? 0) >= Number.MAX_SAFE_INTEGER) throw storageFailure()
      const now = new Date().toISOString()
      const params = { id: data.id, bookId: data.bookId, ...data.fields, revision: (previous?.revision ?? 0) + 1, now }
      if (previous) {
        const changed = db.prepare(`UPDATE notes SET category = @category, title = @title, body = @body, revision = @revision, updated_at = @now
          WHERE id = @id AND book_id = @bookId AND revision = @previousRevision`).run({ ...params, previousRevision: previous.revision })
        if (changed.changes !== 1) throw conflict()
      } else {
        const created = db.prepare(`INSERT INTO notes (id, book_id, category, title, body, revision, created_at, updated_at)
          VALUES (@id, @bookId, @category, @title, @body, @revision, @now, @now)`).run(params)
        if (created.changes !== 1) throw storageFailure()
      }
      // 普通笔记只推进作品版本，不进入知识、记忆或待处理事实事件。
      advanceBook(db, state, now)
      return readDetail(db, readState(db, data.bookId), data.id)
    }).immediate()
    if (!db.inTransaction) this.studio.refreshKnowledgeCatalog(data.bookId)
    return detail
  }

  promote(input: PromoteNoteInput): NoteDetail {
    return perform(() => {
      const data = parsePromoteNoteInput(input)
      const { db } = this.studio.getNotesDatabase(data.bookId)
      const detail = db.transaction(() => {
        const state = readState(db, data.bookId)
        requireWritable(state, data.expectedBookRevision)
        if (state.knowledge_revision !== data.expectedKnowledgeRevision) throw conflict()
        const note = readDetail(db, state, data.id)
        if (note.revision !== data.expectedNoteRevision) throw conflict()
        if (note.promotion) throw new DomainError({ code: 'FORBIDDEN', message: '这条笔记已转换为作者设定，请查看原转换记录。每条笔记只能转换一次。' })
        if (!note.body.trim()) throw new DomainError({ code: 'INVALID_INPUT', message: '请先保存非空笔记正文，再转换为作者设定。' })
        if (state.revision >= Number.MAX_SAFE_INTEGER || state.knowledge_revision >= Number.MAX_SAFE_INTEGER) throw storageFailure()
        const fields: NoteFields = { category: note.category, title: note.title, body: note.body }
        // 知识说明遵循知识契约的首尾空白归一化，转换快照保留笔记原文。
        const summary = fields.body.trim()
        // 复用知识写入的历史、来源及 outbox；外层事务保证条目与转换快照共同提交或回滚。
        const item = new KnowledgeRepository(this.studio).createItem({ bookId: data.bookId, expectedKnowledgeRevision: state.knowledge_revision,
          fields: { kind: data.kind, name: fields.title, aliases: [], summary,
            nature: 'author_setting', authorDecision: 'adopted', freshness: 'current', conflictState: 'unchecked' },
          source: { sourceType: 'author_input', bookId: data.bookId, quote: `素材笔记 ${note.id} · 版本 ${note.revision} · ${note.title}` } })
        if (item.bookId !== data.bookId || item.bookRevision !== state.revision + 1 || item.knowledgeRevision !== state.knowledge_revision + 1 ||
            item.kind !== data.kind || item.name !== fields.title || item.summary !== summary || item.aliases.length !== 0 ||
            item.nature !== 'author_setting' || item.authorDecision !== 'adopted' || item.freshness !== 'current' || item.conflictState !== 'unchecked') throw storageFailure()
        const created = db.prepare(`INSERT INTO note_promotions (note_id, book_id, item_id, kind, note_revision, fields_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(note.id, data.bookId, storedId(item.id), data.kind, note.revision, JSON.stringify(fields), storedTime(item.createdAt))
        if (created.changes !== 1) throw storageFailure()
        // 内容修订和内容更新时间保持原值，转换时间独立保存在不可变快照中。
        return readDetail(db, readState(db, data.bookId), data.id)
      }).immediate()
      if (!db.inTransaction) this.studio.refreshKnowledgeCatalog(data.bookId)
      return detail
    })
  }
}
