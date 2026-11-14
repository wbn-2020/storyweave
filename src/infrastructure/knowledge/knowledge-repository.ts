import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, requiredId } from '../../contracts/api'
import {
  KNOWLEDGE_KINDS, KNOWLEDGE_ADJUDICATION_SCHEMA_VERSION, MAX_KNOWLEDGE_ADJUDICATIONS,
  MAX_KNOWLEDGE_HISTORY_PAGE, MAX_KNOWLEDGE_ITEMS, MAX_KNOWLEDGE_SOURCES,
  knowledgeAdjudicationFields, parseKnowledgeAdjudication,
  parseCreateKnowledgeItem, parseKnowledgeFields, parseKnowledgeItemInput, resolveKnowledgeFields,
  parseKnowledgeSource, parseListKnowledgeItems, parseUpdateKnowledgeItem,
  type CreateKnowledgeItemInput, type KnowledgeItemDetail, type KnowledgeItemFields,
  type KnowledgeItemInput, type KnowledgeItemPage, type KnowledgeItemSummary,
  type KnowledgeRevision, type KnowledgeSource, type KnowledgeSourceInput,
  type ListKnowledgeItemsInput, type UpdateKnowledgeItemInput,
  type KnowledgeAdjudication, type KnowledgeAdjudicationInput,
} from '../../contracts/knowledge'
import type { StudioRepository } from '../storage/studio-repository'
import { readKnowledgeStoryContext } from './story-context'

interface ItemRow {
  id: string; book_id: string; kind: KnowledgeItemFields['kind']; name: string; aliases_json: string
  summary: string; nature: KnowledgeItemFields['nature']; author_decision: KnowledgeItemFields['authorDecision']
  freshness: KnowledgeItemFields['freshness']; conflict_state: KnowledgeItemFields['conflictState']
  created_at: string; updated_at: string
  character_profile_json: string | null
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
interface AdjudicationRow {
  id: string; item_id: string; source_a_id: string; source_b_id: string
  previous_revision_id: string; revision_id: string; book_revision: number
  resolution: KnowledgeAdjudication['resolution']; note: string; created_at: string
  knowledge_revision: number; previous_knowledge_revision: number; fields_json: string; previous_fields_json: string
  source_a_quote: string; source_b_quote: string; revision_created_at: string; reason: string; intervening_revision: number
}

const ITEM_COLUMNS = `id, book_id, kind, name, aliases_json, summary, nature,
  author_decision, freshness, conflict_state, created_at, updated_at`
const REVIEW_FILTER = `(author_decision IN ('unreviewed', 'review_later') OR freshness <> 'current' OR conflict_state IN ('candidate', 'unchecked'))`
const LIST_FILTER = `book_id = @bookId AND (@kind IS NULL OR kind = @kind)
  AND (@nature IS NULL OR nature = @nature)
  AND (@reviewOnly = 0 OR ${REVIEW_FILTER})
  AND (@search = '' OR instr(name, @search) > 0 OR instr(summary, @search) > 0
    OR EXISTS (SELECT 1 FROM json_each(aliases_json) WHERE instr(value, @search) > 0))`

function hasCharacterProfileColumn(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM pragma_table_info('knowledge_items') WHERE name = 'character_profile_json'").get()
}

function itemColumns(db: Database.Database): string {
  // 旧书仍可浏览与编辑普通条目，读取不能隐式迁移。
  return `${ITEM_COLUMNS}, ${hasCharacterProfileColumn(db) ? 'character_profile_json' : 'NULL AS character_profile_json'}`
}

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
    nature: row.nature, authorDecision: row.author_decision, freshness: row.freshness, conflictState: row.conflict_state,
    ...(row.character_profile_json == null ? {} : { characterProfile: JSON.parse(row.character_profile_json) }) })
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
  const row = db.prepare(`SELECT ${itemColumns(db)} FROM knowledge_items WHERE book_id = ? AND id = ?`).get(bookId, id) as ItemRow | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个知识条目。' })
  return row
}

function readAdjudications(db: Database.Database, state: BookState, itemId: string, revisionId: string | null = null): KnowledgeAdjudication[] {
  if ((db.pragma('user_version', { simple: true }) as number) < KNOWLEDGE_ADJUDICATION_SCHEMA_VERSION) return []
  const rows = db.prepare(`SELECT a.*, r.knowledge_revision, r.fields_json, r.created_at AS revision_created_at, r.reason,
      p.knowledge_revision AS previous_knowledge_revision, p.fields_json AS previous_fields_json,
      sa.quote AS source_a_quote, sb.quote AS source_b_quote,
      EXISTS (SELECT 1 FROM knowledge_item_revisions h WHERE h.item_id = a.item_id
        AND h.knowledge_revision > p.knowledge_revision AND h.knowledge_revision < r.knowledge_revision) AS intervening_revision
    FROM knowledge_adjudications a
    LEFT JOIN knowledge_item_revisions r ON r.id = a.revision_id AND r.item_id = a.item_id
    LEFT JOIN knowledge_item_revisions p ON p.id = a.previous_revision_id AND p.item_id = a.item_id
    LEFT JOIN knowledge_sources sa ON sa.id = a.source_a_id AND sa.item_id = a.item_id AND sa.book_id = @bookId
    LEFT JOIN knowledge_sources sb ON sb.id = a.source_b_id AND sb.item_id = a.item_id AND sb.book_id = @bookId
    WHERE a.item_id = @itemId AND (@revisionId IS NULL OR a.revision_id = @revisionId) ORDER BY a.book_revision DESC LIMIT @limit`)
    .all({ bookId: state.id, itemId, revisionId, limit: MAX_KNOWLEDGE_ADJUDICATIONS + 1 }) as AdjudicationRow[]
  if (rows.length > MAX_KNOWLEDGE_ADJUDICATIONS) throw storageFailure()
  return rows.map((row) => {
    const parsed = parseKnowledgeAdjudication({ id: row.id, expectedBookRevision: row.book_revision - 1,
      expectedItemRevisionId: row.previous_revision_id, sourceAId: row.source_a_id, sourceBId: row.source_b_id,
      resolution: row.resolution, note: row.note })
    if (parsed.id !== row.id || parsed.expectedItemRevisionId !== row.previous_revision_id ||
        parsed.sourceAId !== row.source_a_id || parsed.sourceBId !== row.source_b_id || parsed.note !== row.note ||
        requiredId(row.revision_id).toLowerCase() !== row.revision_id || row.item_id !== itemId ||
        row.revision_id === row.previous_revision_id || row.book_revision > state.revision ||
        !Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 1 || row.knowledge_revision > state.knowledge_revision ||
        !Number.isSafeInteger(row.previous_knowledge_revision) || row.previous_knowledge_revision < 1 ||
        row.previous_knowledge_revision >= row.knowledge_revision || row.reason !== 'updated' || row.intervening_revision !== 0 ||
        row.created_at !== row.revision_created_at || new Date(row.created_at).toISOString() !== row.created_at ||
        [row.source_a_quote, row.source_b_quote].some((quote) => typeof quote !== 'string' || !quote.trim() || quote.length > 2000)) throw storageFailure()
    const expected = knowledgeAdjudicationFields(storedFields(JSON.parse(row.previous_fields_json)),
      { quote: row.source_a_quote }, { quote: row.source_b_quote }, row.resolution)
    if (JSON.stringify(storedFields(JSON.parse(row.fields_json))) !== JSON.stringify(expected)) throw storageFailure()
    return { id: row.id, itemId, sourceAId: row.source_a_id, sourceBId: row.source_b_id,
      previousRevisionId: row.previous_revision_id, revisionId: row.revision_id, bookRevision: row.book_revision,
      knowledgeRevision: row.knowledge_revision, resolution: row.resolution, note: row.note, createdAt: row.created_at }
  })
}

/** 记忆只带入该固定修订自身的裁决；历史解释不能自动套用到作者后来改过的条目。 */
export function readKnowledgeAdjudicationContext(db: Database.Database, bookId: string, itemId: string, revisionId: string): string | null {
  return perform(() => {
    const [entry] = readAdjudications(db, readState(db, bookId), itemId, revisionId)
    if (!entry) return null
    const rows = db.prepare('SELECT id, quote FROM knowledge_sources WHERE item_id = ? AND book_id = ? AND id IN (?, ?)')
      .all(itemId, bookId, entry.sourceAId, entry.sourceBId) as { id: string; quote: string }[]
    const a = rows.find((row) => row.id === entry.sourceAId), b = rows.find((row) => row.id === entry.sourceBId)
    if (!a || !b) throw storageFailure()
    const label = { keep_a: '保留 A；B 仅留存为被裁定的原出处', keep_b: '保留 B；A 仅留存为被裁定的原出处', intentional: '作者标为有意安排；两侧须按作者说明理解' }[entry.resolution]
    return [`作者固定冲突裁决：${label}`, `证据 A：${a.quote}`, `证据 B：${b.quote}`,
      `裁决说明：${entry.note || '未另附说明'}`, `裁决编号：${entry.id}`].join('\n')
  })
}

/** 升级与恢复均核对裁决对应的真实前后字段；外键存在不能代替业务一致性。 */
export function validateKnowledgeAdjudicationsDatabase(db: Database.Database, bookId: string): void {
  perform(() => {
    if ((db.pragma('user_version', { simple: true }) as number) < KNOWLEDGE_ADJUDICATION_SCHEMA_VERSION) return
    const state = readState(db, bookId)
    const rows = db.prepare('SELECT DISTINCT item_id FROM knowledge_adjudications').iterate() as Iterable<{ item_id: string }>
    for (const row of rows) {
      readItem(db, bookId, row.item_id)
      readAdjudications(db, state, row.item_id)
    }
  })
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
        const params = { bookId: data.bookId, kind: data.kind ?? null, nature: data.nature ?? null, search: data.search ?? '', reviewOnly: data.reviewOnly ? 1 : 0 }
        const { total } = db.prepare(`SELECT COUNT(*) AS total FROM knowledge_items WHERE ${LIST_FILTER}`).get(params) as { total: number }
        if (!Number.isSafeInteger(total) || total > MAX_KNOWLEDGE_ITEMS) throw storageFailure()
        const limit = data.limit ?? 50
        const offset = data.offset ?? 0
        const rows = db.prepare(`SELECT ${itemColumns(db)} FROM knowledge_items WHERE ${LIST_FILTER}
          ORDER BY updated_at DESC, id LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset }) as ItemRow[]
        let overview: KnowledgeItemPage['overview']
        if (data.includeOverview) {
          // 分类为全书计数，出处只统计当前页；同一只读事务避免数量与卡片来自不同版本。
          const counts = Object.fromEntries(KNOWLEDGE_KINDS.map((kind) => [kind, 0])) as Record<KnowledgeItemFields['kind'], number>
          const grouped = db.prepare(`SELECT kind, COUNT(*) AS total, SUM(CASE WHEN ${REVIEW_FILTER} THEN 1 ELSE 0 END) AS review
            FROM knowledge_items WHERE book_id = ? GROUP BY kind`).all(data.bookId) as { kind: KnowledgeItemFields['kind']; total: number; review: number }[]
          let all = 0, reviewTotal = 0
          for (const group of grouped) {
            if (!KNOWLEDGE_KINDS.includes(group.kind) || !Number.isSafeInteger(group.total) || group.total < 0 ||
                !Number.isSafeInteger(group.review) || group.review < 0 || group.review > group.total) throw storageFailure()
            counts[group.kind] = group.total; all += group.total; reviewTotal += group.review
          }
          if (all > MAX_KNOWLEDGE_ITEMS) throw storageFailure()
          const sourceRows = db.prepare(`SELECT item_id, COUNT(DISTINCT chapter_id) AS total FROM knowledge_sources
            WHERE book_id = @bookId AND source_type = 'chapter_text' AND item_id IN (SELECT value FROM json_each(@ids)) GROUP BY item_id`)
            .all({ bookId: data.bookId, ids: JSON.stringify(rows.map((row) => row.id)) }) as { item_id: string; total: number }[]
          if (sourceRows.some((row) => !rows.some((item) => item.id === row.item_id) || !Number.isSafeInteger(row.total) || row.total < 0 || row.total > MAX_KNOWLEDGE_SOURCES)) throw storageFailure()
          overview = { counts, total: all, reviewTotal, sourceChapterCounts: Object.fromEntries(sourceRows.map((row) => [row.item_id, row.total])) }
        }
        return { bookId: data.bookId, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision,
          items: rows.map(itemSummary), total, nextOffset: offset + rows.length < total ? offset + rows.length : null,
          ...(overview ? { overview } : {}) }
      })()
    })
  }

  getItem(input: KnowledgeItemInput): KnowledgeItemDetail {
    return perform(() => {
      const data = parseKnowledgeItemInput(input)
      const { db } = this.studio.getKnowledgeDatabase(data.bookId)
      return db.transaction(() => {
        const detail = this.readDetail(db, data.bookId, data.id)
        return data.includeStoryContext ? { ...detail, storyContext: readKnowledgeStoryContext(db, data.bookId, data.id) } : detail
      })()
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
      return this.writeItem(data, data.id, [], data.adjudication)
    })
  }

  updateItemWithSources(input: UpdateKnowledgeItemInput, expectedRevisionId: string, sources: readonly KnowledgeSourceInput[]): KnowledgeItemDetail {
    return perform(() => {
      const data = parseUpdateKnowledgeItem(input)
      if (data.adjudication) throw new DomainError({ code: 'INVALID_INPUT', message: '独立知识裁决不能附加在 AI 来源采用中。' })
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

  private writeItem(data: CreateKnowledgeItemInput, existingId?: string, additionalSources: readonly KnowledgeSourceInput[] = [],
    adjudication?: KnowledgeAdjudicationInput): KnowledgeItemDetail {
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
      const previousFields = previous ? itemFields(previous) : null
      // 旧客户端和 AI 修订可能只提交通用字段；省略档案须保留，显式空对象才清空。
      const fields = resolveKnowledgeFields(data.fields, previousFields ?? undefined)
      if (adjudication) {
        if (!existingId || !previousFields || data.source || additionalSources.length) throw storageFailure()
        if ((db.pragma('user_version', { simple: true }) as number) < KNOWLEDGE_ADJUDICATION_SCHEMA_VERSION) {
          throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并启用 v26 知识裁决，普通知识条目仍可继续编辑。' })
        }
        const current = this.readDetail(db, data.bookId, existingId)
        if (state.revision !== adjudication.expectedBookRevision || current.revisions[0]?.id !== adjudication.expectedItemRevisionId) {
          throw new DomainError({ code: 'REVISION_CONFLICT', message: '作品或条目已有新修订，请保留裁决草稿，重新读取两侧证据后再决定。' })
        }
        const a = current.sources.find((source) => source.id === adjudication.sourceAId)
        const b = current.sources.find((source) => source.id === adjudication.sourceBId)
        if (!a || !b || a.validity !== 'valid' || b.validity !== 'valid') {
          throw new DomainError({ code: 'INVALID_INPUT', message: '两侧证据必须属于当前条目且出处可核对，请先补全来源。' })
        }
        if (JSON.stringify(fields) !== JSON.stringify(knowledgeAdjudicationFields(previousFields, a, b, adjudication.resolution))) {
          throw new DomainError({ code: 'INVALID_INPUT', message: '裁决后的字段与固定证据或所选决定不一致，请重新预览。' })
        }
        if ((current.adjudications?.length ?? 0) >= MAX_KNOWLEDGE_ADJUDICATIONS ||
            db.prepare('SELECT 1 FROM knowledge_adjudications WHERE id = ?').get(adjudication.id)) {
          throw new DomainError({ code: 'INVALID_INPUT', message: '裁决编号已存在或条目的裁决记录已达上限，请核对原回执；本次没有重复写入。' })
        }
      }
      if (fields.characterProfile && fields.kind !== 'person') throw new DomainError({ code: 'INVALID_INPUT', message: '此人物仍有档案，请先明确清空档案再更改条目类型；历史档案会保留。' })
      const profileEnabled = hasCharacterProfileColumn(db)
      if (fields.characterProfile?.abilities && (db.pragma('user_version', { simple: true }) as number) < 17) {
        throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级作品至 v17，再保存六维能力数值。' })
      }
      if (fields.characterProfile && !profileEnabled) {
        throw new DomainError({ code: 'FORBIDDEN', message: '请先在知识库中备份并升级这部作品，再保存人物档案；普通条目和正文仍可继续编辑。' })
      }
      if (previous?.kind === 'person' && data.fields.kind !== 'person' && (db.pragma('user_version', { simple: true }) as number) >= 4 &&
          db.prepare("SELECT record_id FROM story_entity_refs WHERE entity_id = ? AND role = 'cognition_subject' LIMIT 1").get(id)) {
        throw new DomainError({ code: 'INVALID_INPUT', message: '这个人物仍被人物认知记录引用，请先调整对应认知主体，再更改条目类型。' })
      }
      if (previous?.kind === 'person' && fields.kind !== 'person' && (db.pragma('user_version', { simple: true }) as number) >= 19 &&
        db.prepare(`SELECT 1 FROM realm_history h, json_each(h.fields_json, '$.characters') c
          WHERE json_extract(c.value, '$.personId') = ? LIMIT 1`).get(id)) {
        // 不可变突破历史保留人物语义，不能因后续改类型而令整书恢复失败。
        throw new DomainError({ code: 'INVALID_INPUT', message: '这个人物已进入不可变境界历史，不能改成其他条目类型；可继续修改人物档案。' })
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
      if (previous && !adjudication && JSON.stringify(previousFields) === JSON.stringify(fields) && sources.length === 0) {
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
      const values = { id, bookId: data.bookId, kind: fields.kind, name: fields.name, aliases: JSON.stringify(fields.aliases),
        summary: fields.summary, nature: fields.nature, decision: fields.authorDecision, freshness: fields.freshness,
        conflict: fields.conflictState, now,
        ...(profileEnabled ? { characterProfile: fields.characterProfile ? JSON.stringify(fields.characterProfile) : null } : {}) }
      if (previous) {
        const changed = db.prepare(`UPDATE knowledge_items SET kind = @kind, name = @name, aliases_json = @aliases,
          summary = @summary, nature = @nature, author_decision = @decision, freshness = @freshness,
          conflict_state = @conflict, updated_at = @now${profileEnabled ? ', character_profile_json = @characterProfile' : ''}
          WHERE id = @id AND book_id = @bookId`).run(values)
        if (changed.changes !== 1) throw storageFailure()
      } else {
        db.prepare(`INSERT INTO knowledge_items (${ITEM_COLUMNS}${profileEnabled ? ', character_profile_json' : ''})
          VALUES (@id, @bookId, @kind, @name, @aliases, @summary, @nature, @decision, @freshness, @conflict, @now, @now${profileEnabled ? ', @characterProfile' : ''})`).run(values)
      }
      for (const source of sources) this.insertSource(db, id, source, now)
      const revisionId = randomUUID()
      const knowledgeRevision = state.knowledge_revision + 1
      const bookRevision = state.revision + 1
      db.prepare(`INSERT INTO knowledge_item_revisions (id, item_id, knowledge_revision, fields_json, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(revisionId, id, knowledgeRevision, JSON.stringify(fields), previous ? 'updated' : 'created', now)
      if (adjudication) {
        db.prepare(`INSERT INTO knowledge_adjudications (id, item_id, source_a_id, source_b_id, previous_revision_id,
          revision_id, book_revision, resolution, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(adjudication.id, id, adjudication.sourceAId, adjudication.sourceBId, adjudication.expectedItemRevisionId,
            revisionId, bookRevision, adjudication.resolution, adjudication.note, now)
      }
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
    const adjudications = (db.pragma('user_version', { simple: true }) as number) >= KNOWLEDGE_ADJUDICATION_SCHEMA_VERSION
      ? readAdjudications(db, state, id) : undefined
    return { ...item, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision, sources, revisions,
      ...(adjudications === undefined ? {} : { adjudications }) }
  }
}
