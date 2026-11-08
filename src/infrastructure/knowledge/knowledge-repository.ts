import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, requiredId } from '../../contracts/api'
import {
  MAX_KNOWLEDGE_HISTORY_PAGE, MAX_KNOWLEDGE_ITEMS, MAX_KNOWLEDGE_SOURCES,
  parseCreateKnowledgeItem, parseKnowledgeFields, parseKnowledgeItemInput,
  parseKnowledgeSource, parseListKnowledgeItems, parseUpdateKnowledgeItem,
  type CreateKnowledgeItemInput, type KnowledgeItemDetail, type KnowledgeItemFields,
  type KnowledgeItemInput, type KnowledgeItemPage, type KnowledgeItemSummary,
  type KnowledgeRevision, type KnowledgeSource, type KnowledgeSourceInput,
  type ListKnowledgeItemsInput, type UpdateKnowledgeItemInput,
} from '../../contracts/knowledge'
import type { StudioRepository } from '../storage/studio-repository'

interface ItemRow {
  id: string; book_id: string; kind: KnowledgeItemFields['kind']; name: string; aliases_json: string
  summary: string; nature: KnowledgeItemFields['nature']; author_decision: KnowledgeItemFields['authorDecision']
  freshness: KnowledgeItemFields['freshness']; conflict_state: KnowledgeItemFields['conflictState']
  created_at: string; updated_at: string
}
interface SourceRow {
  id: string; item_id: string; source_type: KnowledgeSourceInput['sourceType']; book_id: string
  chapter_id: string | null; revision_id: string | null; block_id: string | null; quote: string; created_at: string
}
interface HistoryRow {
  id: string; item_id: string; knowledge_revision: number; fields_json: string
  reason: KnowledgeRevision['reason']; created_at: string
}
interface BookState { id: string; revision: number; knowledge_revision: number; archived_at: string | null }

const ITEM_COLUMNS = `id, book_id, kind, name, aliases_json, summary, nature,
  author_decision, freshness, conflict_state, created_at, updated_at`
const LIST_FILTER = `book_id = @bookId AND (@kind IS NULL OR kind = @kind)
  AND (@nature IS NULL OR nature = @nature)
  AND (@search = '' OR instr(name, @search) > 0 OR instr(summary, @search) > 0
    OR EXISTS (SELECT 1 FROM json_each(aliases_json) WHERE instr(value, @search) > 0))`

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '知识库资料读写失败，请保留当前编辑并检查作品文件。' })
}

function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}

function storedFields(value: unknown): KnowledgeItemFields {
  try { return parseKnowledgeFields(value) } catch { throw storageFailure() }
}

function itemFields(row: ItemRow): KnowledgeItemFields {
  return storedFields({ kind: row.kind, name: row.name, aliases: JSON.parse(row.aliases_json), summary: row.summary,
    nature: row.nature, authorDecision: row.author_decision, freshness: row.freshness, conflictState: row.conflict_state })
}

function itemSummary(row: ItemRow): KnowledgeItemSummary {
  return { id: row.id, bookId: row.book_id, ...itemFields(row), createdAt: row.created_at, updatedAt: row.updated_at }
}

function readState(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, revision, knowledge_revision, archived_at FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
      !Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 0) throw storageFailure()
  return row
}

function readItem(db: Database.Database, bookId: string, id: string): ItemRow {
  const row = db.prepare(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE book_id = ? AND id = ?`).get(bookId, id) as ItemRow | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个知识条目。' })
  return row
}

export class KnowledgeRepository {
  // 连接的身份核对和生命周期由作品仓储统一管理，所有知识数据进入同一 book.sqlite。
  constructor(private readonly studio: StudioRepository) {}

  listItems(input: ListKnowledgeItemsInput): KnowledgeItemPage {
    return perform(() => {
      const data = parseListKnowledgeItems(input)
      const { db } = this.studio.getKnowledgeDatabase(data.bookId)
      return db.transaction(() => {
        const state = readState(db, data.bookId)
        const params = { bookId: data.bookId, kind: data.kind ?? null, nature: data.nature ?? null, search: data.search ?? '' }
        const { total } = db.prepare(`SELECT COUNT(*) AS total FROM knowledge_items WHERE ${LIST_FILTER}`).get(params) as { total: number }
        if (!Number.isSafeInteger(total) || total > MAX_KNOWLEDGE_ITEMS) throw storageFailure()
        const limit = data.limit ?? 50
        const offset = data.offset ?? 0
        const rows = db.prepare(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE ${LIST_FILTER}
          ORDER BY updated_at DESC, id LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset }) as ItemRow[]
        return { bookId: data.bookId, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision,
          items: rows.map(itemSummary), total, nextOffset: offset + rows.length < total ? offset + rows.length : null }
      })()
    })
  }

  getItem(input: KnowledgeItemInput): KnowledgeItemDetail {
    return perform(() => {
      const data = parseKnowledgeItemInput(input)
      const { db } = this.studio.getKnowledgeDatabase(data.bookId)
      return db.transaction(() => this.readDetail(db, data.bookId, data.id))()
    })
  }

  createItem(input: CreateKnowledgeItemInput): KnowledgeItemDetail {
    return perform(() => this.writeItem(parseCreateKnowledgeItem(input)))
  }

  createItemWithSources(input: CreateKnowledgeItemInput, sources: readonly KnowledgeSourceInput[]): KnowledgeItemDetail {
    const data = parseCreateKnowledgeItem(input)
    if (data.source || sources.length < 1 || sources.length > MAX_KNOWLEDGE_SOURCES) {
      throw new DomainError({ code: 'INVALID_INPUT', message: '新条目须提供明确且数量受限的来源集合。' })
    }
    return perform(() => this.writeItem(data, undefined, sources.map((source) => parseKnowledgeSource(source, data.bookId))))
  }

  updateItem(input: UpdateKnowledgeItemInput): KnowledgeItemDetail {
    return perform(() => {
      const data = parseUpdateKnowledgeItem(input)
      return this.writeItem(data, data.id)
    })
  }

  updateItemWithSources(input: UpdateKnowledgeItemInput, expectedRevisionId: string, sources: readonly KnowledgeSourceInput[]): KnowledgeItemDetail {
    return perform(() => {
      const data = parseUpdateKnowledgeItem(input)
      const expected = requiredId(expectedRevisionId).toLowerCase()
      if (data.source || !sources.length || sources.length > MAX_KNOWLEDGE_SOURCES) {
        throw new DomainError({ code: 'INVALID_INPUT', message: '关联或修订须提供明确且数量受限的来源集合。' })
      }
      const { db } = this.studio.getKnowledgeDatabase(data.bookId)
      return db.transaction(() => {
        // 作者查看过的实体修订和知识库 CAS 同时成立，才能追加来源或保存字段修订。
        const current = this.readDetail(db, data.bookId, data.id)
        if (current.revisions[0]?.id !== expected) {
          throw new DomainError({ code: 'REVISION_CONFLICT', message: '目标实体已有新修订，请重新读取并核对，当前审阅不会覆盖新资料。' })
        }
        return this.writeItem(data, data.id, sources.map((source) => parseKnowledgeSource(source, data.bookId)))
      }).immediate()
    })
  }

  private writeItem(data: CreateKnowledgeItemInput, existingId?: string, additionalSources: readonly KnowledgeSourceInput[] = []): KnowledgeItemDetail {
    const { db } = this.studio.getKnowledgeDatabase(data.bookId)
    const id = existingId ?? randomUUID()
    const detail = db.transaction(() => {
      const state = readState(db, data.bookId)
      if (state.archived_at) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请先取消归档再编辑知识库。' })
      if (state.knowledge_revision !== data.expectedKnowledgeRevision) {
        throw new DomainError({ code: 'REVISION_CONFLICT', message: '知识库已有新版本。当前编辑请继续保留，重新读取后比较再保存。' })
      }
      if (state.revision >= Number.MAX_SAFE_INTEGER || state.knowledge_revision >= Number.MAX_SAFE_INTEGER) throw storageFailure()
      const previous = existingId ? readItem(db, data.bookId, existingId) : null
      if (previous?.kind === 'person' && data.fields.kind !== 'person' && (db.pragma('user_version', { simple: true }) as number) >= 4 &&
          db.prepare("SELECT record_id FROM story_entity_refs WHERE entity_id = ? AND role = 'cognition_subject' LIMIT 1").get(id)) {
        throw new DomainError({ code: 'INVALID_INPUT', message: '这个人物仍被人物认知记录引用，请先调整对应认知主体，再更改条目类型。' })
      }
      if (previous && (previous.kind === 'person' || previous.kind === 'place') && data.fields.kind !== previous.kind &&
          db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scene_cards'").get()) {
        // 归档场景仍保留人物和地点语义；改类型前须解除现存场景关联，旧库无场景表时跳过。
        const scene = db.prepare(`SELECT id FROM scene_cards
          WHERE json_extract(fields_json, '$.locationId') = ?
            OR EXISTS (SELECT 1 FROM json_each(scene_cards.fields_json, '$.characterIds') WHERE value = ?)
          LIMIT 1`).get(id, id)
        if (scene) throw new DomainError({ code: 'INVALID_INPUT', message: '这个人物或地点仍被场景卡引用（包括归档场景），请先调整场景关联，再更改条目类型。' })
      }
      const sources = [...(data.source ? [data.source] : []), ...additionalSources].filter((source, index, values) => {
        this.requireSource(source)
        // 相同出处再次提交不新增重复记录，也不会单独制造一个修改版本。
        return (!existingId || !this.hasSource(db, existingId, source)) && values.findIndex((item) => JSON.stringify(item) === JSON.stringify(source)) === index
      })
      if (previous && JSON.stringify(itemFields(previous)) === JSON.stringify(data.fields) && sources.length === 0) {
        return this.readDetail(db, data.bookId, id)
      }
      if (!previous) {
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM knowledge_items').get() as { count: number }
        if (count >= MAX_KNOWLEDGE_ITEMS) throw new DomainError({ code: 'INVALID_INPUT', message: `当前作品最多支持 ${MAX_KNOWLEDGE_ITEMS} 个知识条目。` })
      }
      if (sources.length && previous) {
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources WHERE item_id = ?').get(id) as { count: number }
        if (count + sources.length > MAX_KNOWLEDGE_SOURCES) throw new DomainError({ code: 'INVALID_INPUT', message: `每个条目最多记录 ${MAX_KNOWLEDGE_SOURCES} 个来源。` })
      }
      const now = new Date().toISOString()
      const fields = data.fields
      const values = { id, bookId: data.bookId, kind: fields.kind, name: fields.name, aliases: JSON.stringify(fields.aliases),
        summary: fields.summary, nature: fields.nature, decision: fields.authorDecision, freshness: fields.freshness,
        conflict: fields.conflictState, now }
      if (previous) {
        const changed = db.prepare(`UPDATE knowledge_items SET kind = @kind, name = @name, aliases_json = @aliases,
          summary = @summary, nature = @nature, author_decision = @decision, freshness = @freshness,
          conflict_state = @conflict, updated_at = @now WHERE id = @id AND book_id = @bookId`).run(values)
        if (changed.changes !== 1) throw storageFailure()
      } else {
        db.prepare(`INSERT INTO knowledge_items (${ITEM_COLUMNS})
          VALUES (@id, @bookId, @kind, @name, @aliases, @summary, @nature, @decision, @freshness, @conflict, @now, @now)`).run(values)
      }
      for (const source of sources) this.insertSource(db, id, source, now)
      const revisionId = randomUUID()
      const knowledgeRevision = state.knowledge_revision + 1
      const bookRevision = state.revision + 1
      db.prepare(`INSERT INTO knowledge_item_revisions (id, item_id, knowledge_revision, fields_json, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(revisionId, id, knowledgeRevision, JSON.stringify(fields), previous ? 'updated' : 'created', now)
      // 条目、作者决定、不可变历史和待处理事件必须与两个版本号一起提交。
      const advanced = db.prepare(`UPDATE book_meta SET revision = ?, knowledge_revision = ?, updated_at = ?
        WHERE singleton = 1 AND id = ? AND revision = ? AND knowledge_revision = ? AND archived_at IS NULL`)
        .run(bookRevision, knowledgeRevision, now, data.bookId, state.revision, state.knowledge_revision)
      if (advanced.changes !== 1) throw new DomainError({ code: 'REVISION_CONFLICT', message: '作品或知识库版本已变化，本次修改没有覆盖新资料。' })
      db.prepare(`INSERT INTO knowledge_outbox (id, item_id, knowledge_revision_id, book_revision, knowledge_revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, revisionId, bookRevision, knowledgeRevision, now)
      return this.readDetail(db, data.bookId, id)
    }).immediate()
    // 外层 AI 采用事务结束前不跨库更新目录缓存，避免回滚后留下未提交版本。
    if (!db.inTransaction) this.studio.refreshKnowledgeCatalog(data.bookId)
    return detail
  }

  private requireSource(source: KnowledgeSourceInput): void {
    if (source.sourceType === 'chapter_text' && this.studio.readKnowledgeSource(source).validity !== 'valid') {
      throw new DomainError({ code: 'INVALID_INPUT', message: '正文来源无法核对，请选择已保存的章节版本、段落和该段原文引文。' })
    }
  }

  private hasSource(db: Database.Database, itemId: string, source: KnowledgeSourceInput): boolean {
    const chapter = source.sourceType === 'chapter_text' ? source : null
    return !!db.prepare(`SELECT id FROM knowledge_sources WHERE item_id = ? AND source_type = ? AND book_id = ?
      AND chapter_id IS ? AND revision_id IS ? AND block_id IS ? AND quote = ? LIMIT 1`)
      .get(itemId, source.sourceType, source.bookId, chapter?.chapterId ?? null, chapter?.revisionId ?? null, chapter?.blockId ?? null, source.quote)
  }

  private insertSource(db: Database.Database, itemId: string, source: KnowledgeSourceInput, now: string): void {
    const chapter = source.sourceType === 'chapter_text' ? source : null
    // valid 只说明记录完整且正文引文可核对，不代表该陈述已被作者采纳或事实正确。
    db.prepare(`INSERT INTO knowledge_sources (id, item_id, source_type, book_id, chapter_id, revision_id, block_id, quote, validity, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?)`).run(randomUUID(), itemId, source.sourceType, source.bookId,
      chapter?.chapterId ?? null, chapter?.revisionId ?? null, chapter?.blockId ?? null, source.quote, now)
  }

  private readDetail(db: Database.Database, bookId: string, id: string): KnowledgeItemDetail {
    const state = readState(db, bookId)
    const item = itemSummary(readItem(db, bookId, id))
    const sourceRows = db.prepare(`SELECT id, item_id, source_type, book_id, chapter_id, revision_id, block_id, quote, created_at
      FROM knowledge_sources WHERE item_id = ? ORDER BY created_at, id LIMIT ?`).all(id, MAX_KNOWLEDGE_SOURCES + 1) as SourceRow[]
    if (sourceRows.length > MAX_KNOWLEDGE_SOURCES) throw storageFailure()
    const sourceInputs = sourceRows.map((row): KnowledgeSourceInput => {
      try {
        return parseKnowledgeSource({ sourceType: row.source_type, bookId: row.book_id, quote: row.quote,
          ...(row.source_type === 'chapter_text' ? { chapterId: row.chapter_id, revisionId: row.revision_id, blockId: row.block_id } : {}) }, bookId)
      } catch { throw storageFailure() }
    })
    const sourceStates = this.studio.readKnowledgeSources(sourceInputs)
    const sources = sourceInputs.map((source, index): KnowledgeSource => {
      const row = sourceRows[index]
      const status = sourceStates[index]
      if (!row || !status) throw storageFailure()
      return { ...source, id: row.id, itemId: row.item_id, createdAt: row.created_at, ...status }
    })
    const historyRows = db.prepare(`SELECT id, item_id, knowledge_revision, fields_json, reason, created_at
      FROM knowledge_item_revisions WHERE item_id = ? ORDER BY knowledge_revision DESC LIMIT ?`).all(id, MAX_KNOWLEDGE_HISTORY_PAGE) as HistoryRow[]
    const revisions = historyRows.map((row): KnowledgeRevision => {
      if (!Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 1 || row.knowledge_revision > state.knowledge_revision ||
          (row.reason !== 'created' && row.reason !== 'updated')) throw storageFailure()
      return { id: row.id, itemId: row.item_id, knowledgeRevision: row.knowledge_revision,
        fields: storedFields(JSON.parse(row.fields_json)), reason: row.reason, createdAt: row.created_at }
    })
    if (revisions.length === 0) throw storageFailure()
    return { ...item, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision, sources, revisions }
  }
}
