import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredText } from '../../contracts/api'
import { countCharacters, documentToText, parseManuscript, type ManuscriptDocument } from '../../contracts/manuscript'
import { parseKnowledgeSource, type KnowledgeSourceInput } from '../../contracts/knowledge'
import {
  FORESHADOW_STAGES, MAX_STORY_HISTORY_PAGE, MAX_STORY_RECORDS, MAX_STORY_SOURCES, STORY_KINDS,
  parseCreateStoryRecord, parseListStoryRecords, parseStoryFields, parseStoryRecordInput, parseStoryRevisionInput, parseStoryTime, parseUpdateStoryRecord,
  type CreateStoryRecordInput, type Disclosure, type ListStoryRecordsInput, type StoryRecordDetail,
  type StoryRecordFields, type StoryRecordInput, type StoryRecordListItem, type StoryRecordPage, type StoryRecordSummary,
  type StoryRevision, type StoryRevisionInput, type StoryRevisionSummary, type StorySource, type UpdateStoryRecordInput,
} from '../../contracts/story'
import type { StudioRepository } from '../storage/studio-repository'

interface RecordRow {
  id: string; book_id: string; kind: StoryRecordFields['kind']; title: string; description: string
  fields_json: string; story_order: number | null; created_at: string; updated_at: string
}
interface ListRow {
  id: string; book_id: string; kind: StoryRecordFields['kind']; title: string; description: string
  time_json: string; stage: StoryRecordListItem['stage'] | null; story_order: number | null
  created_at: string; updated_at: string
}
interface SourceRow {
  id: string; record_id: string; source_type: KnowledgeSourceInput['sourceType']; book_id: string
  chapter_id: string | null; revision_id: string | null; block_id: string | null; quote: string; created_at: string
}
interface RevisionRow {
  id: string; record_id: string; knowledge_revision: number; fields_json: string
  reason: StoryRevision['reason']; created_at: string
}
interface RevisionSummaryRow extends Omit<RevisionRow, 'fields_json'> { title: string }
interface BookState { id: string; revision: number; knowledge_revision: number; archived_at: string | null }
interface EntityRef { id: string; role: 'relation_from' | 'relation_to' | 'participant' | 'mentioned' | 'state_change' | 'foreshadow_entity' | 'cognition_subject' }
interface EventRef { id: string; role: 'relation_start' | 'relation_end' | 'foreshadow_event' | 'acquisition' }

const RECORD_COLUMNS = 'id, book_id, kind, title, description, fields_json, story_order, created_at, updated_at'
const LIST_FILTER = `book_id = @bookId AND (@kind IS NULL OR kind = @kind)
  AND (@search = '' OR instr(title, @search) > 0 OR instr(description, @search) > 0)
  AND (@entityId IS NULL OR EXISTS (SELECT 1 FROM story_entity_refs ref
    WHERE ref.record_id = story_records.id AND ref.book_id = @bookId AND ref.entity_id = @entityId))`

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '故事资料读写失败，请保留当前编辑并检查作品文件。' })
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }

function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}

function readState(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, revision, knowledge_revision, archived_at FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
      !Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 0) throw storageFailure()
  return row
}

function storedFields(json: string, bookId: string): StoryRecordFields {
  try { return parseStoryFields(JSON.parse(json), bookId) } catch { throw storageFailure() }
}

function orderOf(fields: StoryRecordFields): number | null {
  const time = fields.kind === 'relation' ? fields.validFrom : fields.storyTime
  return time.kind === 'unknown' ? null : time.order
}

function summary(row: RecordRow): StoryRecordSummary {
  const fields = storedFields(row.fields_json, row.book_id)
  if (fields.kind !== row.kind || fields.title !== row.title || fields.description !== row.description || orderOf(fields) !== row.story_order) throw storageFailure()
  return { id: row.id, bookId: row.book_id, fields, createdAt: row.created_at, updatedAt: row.updated_at }
}

function listItem(row: ListRow, bookId: string): StoryRecordListItem {
  try {
    const time = parseStoryTime(JSON.parse(row.time_json))
    const order = time.kind === 'unknown' ? null : time.order
    if (row.book_id !== bookId || !STORY_KINDS.includes(row.kind) || order !== row.story_order ||
        typeof row.description !== 'string' || row.description.length > 480 ||
        (row.kind === 'foreshadow' && !FORESHADOW_STAGES.includes(row.stage!)) ||
        (row.kind !== 'foreshadow' && row.stage !== null)) throw storageFailure()
    return { id: requiredId(row.id), bookId, kind: row.kind, title: requiredText(row.title, '记录名称', 120),
      description: row.description, time, ...(row.kind === 'foreshadow' ? { stage: row.stage! } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at }
  } catch { throw storageFailure() }
}

function readRecord(db: Database.Database, bookId: string, id: string): RecordRow {
  const row = db.prepare(`SELECT ${RECORD_COLUMNS} FROM story_records WHERE book_id = ? AND id = ?`).get(bookId, id) as RecordRow | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这条故事记录。' })
  return row
}

function links(fields: StoryRecordFields): { entities: EntityRef[]; events: EventRef[] } {
  const entities: EntityRef[] = []
  const events: EventRef[] = []
  if (fields.kind === 'relation') {
    entities.push({ id: fields.fromEntityId, role: 'relation_from' }, { id: fields.toEntityId, role: 'relation_to' })
    if (fields.startEventId) events.push({ id: fields.startEventId, role: 'relation_start' })
    if (fields.endEventId) events.push({ id: fields.endEventId, role: 'relation_end' })
  } else if (fields.kind === 'event') {
    entities.push(...fields.participantIds.map((id): EntityRef => ({ id, role: 'participant' })),
      ...fields.mentionedEntityIds.map((id): EntityRef => ({ id, role: 'mentioned' })),
      ...Array.from(new Set(fields.stateChanges.map((change) => change.entityId)), (id): EntityRef => ({ id, role: 'state_change' })))
  } else if (fields.kind === 'foreshadow') {
    entities.push(...fields.entityIds.map((id): EntityRef => ({ id, role: 'foreshadow_entity' })))
    events.push(...fields.eventIds.map((id): EventRef => ({ id, role: 'foreshadow_event' })))
  } else {
    entities.push({ id: fields.personId, role: 'cognition_subject' })
    if (fields.acquisitionEventId) events.push({ id: fields.acquisitionEventId, role: 'acquisition' })
  }
  return { entities, events }
}

function disclosures(fields: StoryRecordFields): Disclosure[] {
  return fields.kind === 'foreshadow'
    ? [fields.disclosure, fields.plannedPayoff, fields.actualPayoff, ...fields.milestones.map((item) => item.disclosure)]
    : [fields.disclosure]
}

function ensureMilestoneHistory(previous: StoryRecordFields, next: StoryRecordFields): void {
  if (previous.kind !== next.kind) invalid('已有记录的类型不能更改，请另建对应类型的记录。')
  if (previous.kind !== 'foreshadow' || next.kind !== 'foreshadow') return
  // 已记录的里程碑属于创作历史，只能追加，不能通过整条保存删改旧阶段和出处。
  if (next.milestones.length < previous.milestones.length || previous.milestones.some((item, index) =>
    JSON.stringify(item) !== JSON.stringify(next.milestones[index]))) invalid('已有伏笔里程碑不能删除、调序或修改；请追加推进说明。')
  if ((previous.stage === 'resolved' || previous.stage === 'abandoned') && next.milestones.length !== previous.milestones.length) {
    invalid('已回收或放弃的伏笔不能继续追加里程碑。')
  }
}

export class StoryRepository {
  constructor(private readonly studio: StudioRepository) {}

  listRecords(input: ListStoryRecordsInput): StoryRecordPage {
    return perform(() => {
      const data = parseListStoryRecords(input)
      const { db } = this.studio.getStoryDatabase(data.bookId)
      return db.transaction(() => {
        const state = readState(db, data.bookId)
        const params = { bookId: data.bookId, kind: data.kind ?? null, search: data.search ?? '', entityId: data.entityId ?? null }
        const { total } = db.prepare(`SELECT COUNT(*) AS total FROM story_records WHERE ${LIST_FILTER}`).get(params) as { total: number }
        if (!Number.isSafeInteger(total) || total < 0 || total > MAX_STORY_RECORDS) throw storageFailure()
        const limit = data.limit ?? 50
        const offset = data.offset ?? 0
        // 只比较作者明确填写的排序值；未知时间排在后面，不从自由文本日期猜测顺序。
        // 列表只提取必要字段，不将数百条里程碑和多版完整快照一起送进渲染进程。
        const rows = db.prepare(`SELECT id, book_id, kind, title, substr(description, 1, 240) AS description,
          json_extract(fields_json, CASE kind WHEN 'relation' THEN '$.validFrom' ELSE '$.storyTime' END) AS time_json,
          json_extract(fields_json, '$.stage') AS stage, story_order, created_at, updated_at
          FROM story_records WHERE ${LIST_FILTER}
          ORDER BY story_order IS NULL, story_order, updated_at DESC, id LIMIT @limit OFFSET @offset`)
          .all({ ...params, limit, offset }) as ListRow[]
        const items = rows.map((row) => listItem(row, data.bookId))
        return { bookId: data.bookId, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision,
          items, total, nextOffset: offset + rows.length < total ? offset + rows.length : null }
      })()
    })
  }

  getRecord(input: StoryRecordInput): StoryRecordDetail {
    return perform(() => {
      const data = parseStoryRecordInput(input)
      const { db } = this.studio.getStoryDatabase(data.bookId)
      return db.transaction(() => this.readDetail(db, data.bookId, data.id))()
    })
  }

  readRevision(input: StoryRevisionInput): StoryRevision {
    return perform(() => {
      const data = parseStoryRevisionInput(input)
      const { db } = this.studio.getStoryDatabase(data.bookId)
      return db.transaction(() => {
        const state = readState(db, data.bookId)
        const current = readRecord(db, data.bookId, data.id)
        const row = db.prepare(`SELECT id, record_id, knowledge_revision, fields_json, reason, created_at
          FROM story_record_revisions WHERE record_id = ? AND id = ?`).get(data.id, data.revisionId) as RevisionRow | undefined
        if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前故事记录中不存在这个历史版本。' })
        if (!Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 1 || row.knowledge_revision > state.knowledge_revision ||
            (row.reason !== 'created' && row.reason !== 'updated')) throw storageFailure()
        const fields = storedFields(row.fields_json, data.bookId)
        if (fields.kind !== current.kind) throw storageFailure()
        return { id: row.id, bookId: data.bookId, recordId: row.record_id, knowledgeRevision: row.knowledge_revision,
          fields, reason: row.reason, createdAt: row.created_at, labels: this.readLabels(db, data.bookId, fields) }
      })()
    })
  }

  createRecord(input: CreateStoryRecordInput): StoryRecordDetail {
    return perform(() => this.writeRecord(parseCreateStoryRecord(input)))
  }

  updateRecord(input: UpdateStoryRecordInput): StoryRecordDetail {
    return perform(() => {
      const data = parseUpdateStoryRecord(input)
      return this.writeRecord(data, data.id)
    })
  }

  private writeRecord(data: CreateStoryRecordInput, existingId?: string): StoryRecordDetail {
    const { db } = this.studio.getStoryDatabase(data.bookId)
    const id = existingId ?? randomUUID()
    const detail = db.transaction(() => {
      const state = readState(db, data.bookId)
      if (state.archived_at) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请先取消归档再编辑故事资料。' })
      if (state.knowledge_revision !== data.expectedKnowledgeRevision) throw new DomainError({
        code: 'REVISION_CONFLICT', message: '知识库已有新版本。请保留当前表单，重新读取后比较再保存。',
      })
      if (state.revision >= Number.MAX_SAFE_INTEGER || state.knowledge_revision >= Number.MAX_SAFE_INTEGER) throw storageFailure()
      const previous = existingId ? summary(readRecord(db, data.bookId, existingId)) : null
      if (previous) ensureMilestoneHistory(previous.fields, data.fields)
      if (!previous) {
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM story_records').get() as { count: number }
        if (count >= MAX_STORY_RECORDS) invalid(`当前作品最多支持 ${MAX_STORY_RECORDS} 条故事记录。`)
      }
      const references = links(data.fields)
      this.requireLinks(db, data.bookId, references)
      this.requireDisclosures(db, disclosures(data.fields))
      const candidates = [...(data.source ? [data.source] : []), ...(data.fields.kind === 'foreshadow'
        ? data.fields.milestones.flatMap((item) => item.source ? [item.source] : []) : [])]
      const unique = [...new Map(candidates.map((source) => [JSON.stringify(source), source])).values()]
      const additions = unique.filter((source) => !this.hasSource(db, id, source))
      const { count: sourceCount } = db.prepare('SELECT COUNT(*) AS count FROM story_sources WHERE record_id = ?').get(id) as { count: number }
      if (sourceCount + additions.length > MAX_STORY_SOURCES) invalid(`每条故事记录最多保留 ${MAX_STORY_SOURCES} 个来源。`)
      const sourceStates = this.studio.readKnowledgeSources(additions)
      if (sourceStates.some((source) => source.validity !== 'valid')) invalid('正文来源无法核对，请选择已保存的版本、段落和该段连续原文。')
      const fieldsJson = JSON.stringify(data.fields)
      if (previous && JSON.stringify(previous.fields) === fieldsJson && additions.length === 0) return this.readDetail(db, data.bookId, id)
      const now = new Date().toISOString()
      const values = { id, bookId: data.bookId, kind: data.fields.kind, title: data.fields.title,
        description: data.fields.description, fieldsJson, storyOrder: orderOf(data.fields), now }
      if (previous) {
        const changed = db.prepare(`UPDATE story_records SET title = @title, description = @description,
          fields_json = @fieldsJson, story_order = @storyOrder, updated_at = @now WHERE id = @id AND book_id = @bookId`).run(values)
        if (changed.changes !== 1) throw storageFailure()
        // 引用表是当前字段的派生索引；完整旧引用仍保留在不可变字段历史中。
        db.prepare('DELETE FROM story_entity_refs WHERE record_id = ?').run(id)
        db.prepare('DELETE FROM story_event_refs WHERE record_id = ?').run(id)
      } else {
        db.prepare(`INSERT INTO story_records (${RECORD_COLUMNS})
          VALUES (@id, @bookId, @kind, @title, @description, @fieldsJson, @storyOrder, @now, @now)`).run(values)
      }
      const insertEntity = db.prepare('INSERT INTO story_entity_refs (record_id, book_id, entity_id, role) VALUES (?, ?, ?, ?)')
      const insertEvent = db.prepare('INSERT INTO story_event_refs (record_id, book_id, event_id, role) VALUES (?, ?, ?, ?)')
      for (const ref of references.entities) insertEntity.run(id, data.bookId, ref.id, ref.role)
      for (const ref of references.events) insertEvent.run(id, data.bookId, ref.id, ref.role)
      for (const source of additions) this.insertSource(db, id, source, now)
      const revisionId = randomUUID()
      const bookRevision = state.revision + 1
      const knowledgeRevision = state.knowledge_revision + 1
      db.prepare(`INSERT INTO story_record_revisions (id, record_id, knowledge_revision, fields_json, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(revisionId, id, knowledgeRevision, fieldsJson, previous ? 'updated' : 'created', now)
      // 故事事实、固定出处、历史与待处理事件必须跟书和知识修订号在同一事务提交。
      const advanced = db.prepare(`UPDATE book_meta SET revision = ?, knowledge_revision = ?, updated_at = ?
        WHERE singleton = 1 AND id = ? AND revision = ? AND knowledge_revision = ? AND archived_at IS NULL`)
        .run(bookRevision, knowledgeRevision, now, data.bookId, state.revision, state.knowledge_revision)
      if (advanced.changes !== 1) throw new DomainError({ code: 'REVISION_CONFLICT', message: '作品或知识库版本已变化，本次修改没有覆盖新资料。' })
      db.prepare(`INSERT INTO story_outbox (id, record_id, story_revision_id, book_revision, knowledge_revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, revisionId, bookRevision, knowledgeRevision, now)
      return this.readDetail(db, data.bookId, id)
    }).immediate()
    this.studio.refreshKnowledgeCatalog(data.bookId)
    return detail
  }

  private requireLinks(db: Database.Database, bookId: string, references: ReturnType<typeof links>): void {
    const entity = db.prepare('SELECT kind FROM knowledge_items WHERE id = ? AND book_id = ?')
    const kinds = new Map<string, string>()
    for (const ref of references.entities) {
      if (!kinds.has(ref.id)) {
        const row = entity.get(ref.id, bookId) as { kind: string } | undefined
        if (!row) invalid('关联实体不存在于当前作品，请先在本书知识库建立对应条目。')
        kinds.set(ref.id, row.kind)
      }
      if (ref.role === 'cognition_subject' && kinds.get(ref.id) !== 'person') invalid('人物认知的主体必须是当前作品的人物条目。')
    }
    const event = db.prepare("SELECT id FROM story_records WHERE id = ? AND book_id = ? AND kind = 'event'")
    for (const ref of references.events) if (!event.get(ref.id, bookId)) invalid('关联事件不存在于当前作品，请先建立事件记录。')
  }

  private requireDisclosures(db: Database.Database, locations: Disclosure[]): void {
    const groups = new Map<string, Extract<Disclosure, { state: 'located' }>[]>()
    for (const location of locations) {
      if (location.state !== 'located') continue
      const key = `${location.chapterId}/${location.revisionId}`
      const group = groups.get(key) ?? []
      group.push(location)
      groups.set(key, group)
    }
    const read = db.prepare('SELECT document_json, content_hash, plain_text, character_count FROM chapter_revisions WHERE chapter_id = ? AND id = ?')
    // 同一次保存按固定修订分组解析；披露锚点绑定历史稿，不随当前正文移动。
    for (const group of groups.values()) {
      const first = group[0]!
      const row = read.get(first.chapterId, first.revisionId) as {
        document_json: string; content_hash: string; plain_text: string; character_count: number
      } | undefined
      if (!row) invalid('披露位置不存在于当前作品的已保存版本中。')
      let document: ManuscriptDocument
      try { document = parseManuscript(JSON.parse(row.document_json)) } catch { throw storageFailure() }
      if (createHash('sha256').update(row.document_json, 'utf8').digest('hex') !== row.content_hash ||
          documentToText(document) !== row.plain_text || countCharacters(row.plain_text) !== row.character_count) throw storageFailure()
      const blocks = new Set(document.content.map((block) => block.attrs.id))
      if (group.some((location) => !blocks.has(location.blockId))) invalid('披露位置的段落不在所选版本中，请重新选择。')
    }
  }

  private hasSource(db: Database.Database, recordId: string, source: KnowledgeSourceInput): boolean {
    const chapter = source.sourceType === 'chapter_text' ? source : null
    return !!db.prepare(`SELECT id FROM story_sources WHERE record_id = ? AND source_type = ? AND book_id = ?
      AND chapter_id IS ? AND revision_id IS ? AND block_id IS ? AND quote = ? LIMIT 1`).get(recordId, source.sourceType, source.bookId,
      chapter?.chapterId ?? null, chapter?.revisionId ?? null, chapter?.blockId ?? null, source.quote)
  }

  private readLabels(db: Database.Database, bookId: string, fields: StoryRecordFields): Record<string, string> {
    const references = links(fields)
    const labels: Record<string, string> = {}
    const entity = db.prepare('SELECT name FROM knowledge_items WHERE id = ? AND book_id = ?')
    const event = db.prepare("SELECT title FROM story_records WHERE id = ? AND book_id = ? AND kind = 'event'")
    // 名称是当前实体的显示信息，旧关联身份仍取自不可变快照；不为标签读取整条来源和历史。
    for (const id of new Set(references.entities.map((ref) => ref.id))) {
      const row = entity.get(id, bookId) as { name: string } | undefined
      if (row) labels[id] = row.name
    }
    for (const id of new Set(references.events.map((ref) => ref.id))) {
      const row = event.get(id, bookId) as { title: string } | undefined
      if (row) labels[id] = row.title
    }
    return labels
  }

  private insertSource(db: Database.Database, recordId: string, source: KnowledgeSourceInput, now: string): void {
    const chapter = source.sourceType === 'chapter_text' ? source : null
    db.prepare(`INSERT INTO story_sources (id, record_id, source_type, book_id, chapter_id, revision_id, block_id, quote, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), recordId, source.sourceType, source.bookId,
      chapter?.chapterId ?? null, chapter?.revisionId ?? null, chapter?.blockId ?? null, source.quote, now)
  }

  private readDetail(db: Database.Database, bookId: string, id: string): StoryRecordDetail {
    const state = readState(db, bookId)
    const record = summary(readRecord(db, bookId, id))
    const rows = db.prepare(`SELECT id, record_id, source_type, book_id, chapter_id, revision_id, block_id, quote, created_at
      FROM story_sources WHERE record_id = ? ORDER BY created_at, id LIMIT ?`).all(id, MAX_STORY_SOURCES + 1) as SourceRow[]
    if (rows.length > MAX_STORY_SOURCES) throw storageFailure()
    const inputs = rows.map((row): KnowledgeSourceInput => {
      try {
        return parseKnowledgeSource({ sourceType: row.source_type, bookId: row.book_id, quote: row.quote,
          ...(row.source_type === 'chapter_text' ? { chapterId: row.chapter_id, revisionId: row.revision_id, blockId: row.block_id } : {}) }, bookId)
      } catch { throw storageFailure() }
    })
    const sourceStates = this.studio.readKnowledgeSources(inputs)
    const sources = inputs.map((source, index): StorySource => {
      const row = rows[index]
      const validity = sourceStates[index]
      if (!row || !validity) throw storageFailure()
      return { ...source, id: row.id, recordId: row.record_id, createdAt: row.created_at, ...validity }
    })
    const revisions = (db.prepare(`SELECT id, record_id, knowledge_revision, json_extract(fields_json, '$.title') AS title, reason, created_at
      FROM story_record_revisions WHERE record_id = ? ORDER BY knowledge_revision DESC LIMIT ?`).all(id, MAX_STORY_HISTORY_PAGE) as RevisionSummaryRow[])
      .map((row): StoryRevisionSummary => {
        if (!Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 1 || row.knowledge_revision > state.knowledge_revision ||
            (row.reason !== 'created' && row.reason !== 'updated')) throw storageFailure()
        return { id: row.id, recordId: row.record_id, knowledgeRevision: row.knowledge_revision,
          title: requiredText(row.title, '历史记录名称', 120), reason: row.reason, createdAt: row.created_at }
      })
    const latest = db.prepare(`SELECT fields_json FROM story_record_revisions WHERE record_id = ? ORDER BY knowledge_revision DESC LIMIT 1`)
      .get(id) as { fields_json: string } | undefined
    if (!revisions[0] || !latest || JSON.stringify(storedFields(latest.fields_json, bookId)) !== JSON.stringify(record.fields)) throw storageFailure()
    return { ...record, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision, sources, revisions,
      labels: this.readLabels(db, bookId, record.fields) }
  }
}
