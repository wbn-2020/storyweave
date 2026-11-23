import type Database from 'better-sqlite3'
import { DomainError } from '../../contracts/api'
import type { ForgeEntity, ForgePerson, ForgeRelation, ForgeStateChange } from '../../contracts/forge'
import { parseKnowledgeFields } from '../../contracts/knowledge'
import { MAX_COGNITION_STATES, cognitionStateAt, parseStoryFields, type CognitionState, type StoryTime } from '../../contracts/story'
import { chapterDependenciesCurrent } from '../memory/source-projection'

export function forgeFailure(message = '工坊资料无法核对，请保留作品与候选后检查来源。'): never {
  throw new DomainError({ code: 'STORAGE_ERROR', message })
}
export function forgeConflict(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
export function forgeInvalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
export function forgeJson(value: string | null): unknown { try { if (value === null) return forgeFailure(); return JSON.parse(value) } catch { return forgeFailure() } }
export function requireForge(db: Database.Database): void {
  if ((db.pragma('user_version', { simple: true }) as number) < 17) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级作品至 v17，再使用角色与世界工坊。' })
}
export function forgeEntity(db: Database.Database, bookId: string, id: string, knowledgeRevision: number): ForgeEntity {
  const row = db.prepare(`SELECT r.id, r.fields_json FROM knowledge_item_revisions r JOIN knowledge_items i ON i.id = r.item_id
    WHERE i.book_id = ? AND r.item_id = ? AND r.knowledge_revision <= ? ORDER BY r.knowledge_revision DESC LIMIT 1`)
    .get(bookId, id, knowledgeRevision) as { id: string; fields_json: string } | undefined
  if (!row) return forgeInvalid('所选实体不存在于本次作品版本中。')
  return { id, revisionId: row.id, fields: parseKnowledgeFields(forgeJson(row.fields_json)) }
}
export function forgeReviewed(fields: { authorDecision: string; freshness: string; conflictState: string }): boolean {
  return fields.authorDecision === 'adopted' && fields.freshness === 'current' && ['clear', 'explained'].includes(fields.conflictState)
}
const timeOrder = (time: StoryTime) => time.kind === 'unknown' ? null : time.order

/** 按任务固定的知识版本重建历史，后续编辑不能改写旧试戏的资料。 */
export function readForgePerson(db: Database.Database, bookId: string, personId: string, storyOrder: number | null, knowledgeRevision: number,
  options: { currentSources?: boolean; offset?: number; cognitionIds?: string[]; stateIds?: string[] } = {}): ForgePerson {
  const entity = forgeEntity(db, bookId, personId, knowledgeRevision)
  if (entity.fields.kind !== 'person') return forgeInvalid('请选择本书的人物实体。')
  const profiles = db.prepare(`SELECT id, fields_json, created_at FROM knowledge_item_revisions
    WHERE item_id = ? AND knowledge_revision <= ? ORDER BY knowledge_revision DESC LIMIT 20`).all(personId, knowledgeRevision) as
    { id: string; fields_json: string; created_at: string }[]
  const { count: profileTotal } = db.prepare('SELECT COUNT(*) AS count FROM knowledge_item_revisions WHERE item_id = ? AND knowledge_revision <= ?')
    .get(personId, knowledgeRevision) as { count: number }
  // 历史事件的主体可以被后续修订调整，因此不能只通过当前引用索引回查旧状态。
  const rows = db.prepare(`SELECT r.id, r.record_id, r.fields_json FROM story_record_revisions r JOIN story_records s ON s.id = r.record_id
    WHERE s.book_id = ? AND r.knowledge_revision <= ? AND NOT EXISTS
      (SELECT 1 FROM story_record_revisions newer WHERE newer.record_id = r.record_id AND newer.knowledge_revision > r.knowledge_revision AND newer.knowledge_revision <= ?)
      AND (json_extract(r.fields_json, '$.personId') = ? OR json_extract(r.fields_json, '$.fromEntityId') = ?
        OR json_extract(r.fields_json, '$.toEntityId') = ? OR EXISTS
          (SELECT 1 FROM json_each(r.fields_json, '$.stateChanges') change WHERE json_extract(change.value, '$.entityId') = ?))
    ORDER BY r.knowledge_revision`).iterate(bookId, knowledgeRevision, knowledgeRevision, personId, personId, personId, personId) as
    Iterable<{ id: string; record_id: string; fields_json: string }>
  const records = Array.from(rows, (row) => ({ id: row.record_id, revisionId: row.id, fields: parseStoryFields(forgeJson(row.fields_json), bookId) }))
  const sourceChecks = new Map<string, boolean>()
  const sourceCurrent = (id: string): boolean => {
    if (!options.currentSources) return true
    if (!sourceChecks.has(id)) sourceChecks.set(id, chapterDependenciesCurrent(db, 'story', bookId, id))
    return sourceChecks.get(id)!
  }
  const states = new Map<string, CognitionState>(), revisions = new Map<string, string>()
  for (const record of records) if (record.fields.kind === 'cognition') {
    if (record.fields.personId !== personId) return forgeFailure()
    states.set(record.id, { id: record.id, fields: record.fields, effectiveUntil: record.fields.evolution?.validUntil ?? { kind: 'unknown' } })
    revisions.set(record.id, record.revisionId)
  }
  const successors = new Set<string>()
  for (const state of states.values()) {
    const previousId = state.fields.evolution?.previousId
    if (!previousId) continue
    const previous = states.get(previousId), before = previous ? timeOrder(previous.fields.storyTime) : null, after = timeOrder(state.fields.storyTime)
    if (!previous || successors.has(previousId) || before === null || after === null || before >= after) return forgeFailure('人物认知链缺少前态、出现分叉或故事时间无效。')
    successors.add(previousId)
    const until = timeOrder(previous.effectiveUntil)
    if (previous.effectiveUntil.kind === 'unknown' || until !== null && after < until) previous.effectiveUntil = state.fields.storyTime
  }
  for (const state of states.values()) {
    let cursor: CognitionState | undefined = state
    let length = 0
    while (cursor) {
      if (++length > MAX_COGNITION_STATES) return forgeFailure('人物认知历程超过受支持的状态数量。')
      cursor = cursor.fields.evolution?.previousId ? states.get(cursor.fields.evolution.previousId) : undefined
    }
  }
  const acquisitions = new Map<string, boolean>()
  const acquisitionUsable = (state: CognitionState): boolean => {
    const eventId = state.fields.acquisitionEventId
    // 未关联事件时保留作者手工登记的认知；有关联则必须核对其身份与形成时间，事件详情不进入试戏。
    if (!eventId) return true
    const key = `${eventId}:${timeOrder(state.fields.storyTime)}`
    if (acquisitions.has(key)) return acquisitions.get(key)!
    const row = db.prepare(`SELECT r.fields_json FROM story_record_revisions r JOIN story_records s ON s.id = r.record_id
      WHERE s.book_id = ? AND r.record_id = ? AND r.knowledge_revision <= ? ORDER BY r.knowledge_revision DESC LIMIT 1`)
      .get(bookId, eventId, knowledgeRevision) as { fields_json: string } | undefined
    const event = row ? parseStoryFields(forgeJson(row.fields_json), bookId) : null
    const formed = timeOrder(state.fields.storyTime), at = event?.kind === 'event' ? timeOrder(event.storyTime) : null
    const usable = event?.kind === 'event' && forgeReviewed(event) && sourceCurrent(eventId) && ['author_setting', 'narrative_claim'].includes(event.nature) && formed !== null && at !== null && at <= formed
    acquisitions.set(key, usable); return usable
  }
  const cognitions = [...states.values()].map((state) => ({ id: state.id, revisionId: revisions.get(state.id)!,
    title: state.fields.title, description: state.fields.description, attitude: state.fields.attitude, concealed: state.fields.concealed,
    formedAt: state.fields.storyTime, effectiveUntil: state.effectiveUntil, acquisitionEventId: state.fields.acquisitionEventId,
    usable: storyOrder !== null && cognitionStateAt([state], storyOrder) !== null && forgeReviewed(state.fields) && sourceCurrent(state.id) && acquisitionUsable(state) && state.fields.nature === 'character_belief' &&
      !['forgotten', 'refuted'].includes(state.fields.evolution?.kind ?? '') }))
  const changes: (ForgeStateChange & { eligible: boolean })[] = records.flatMap((record) => {
    const fields = record.fields
    if (fields.kind !== 'event') return []
    return fields.stateChanges.filter((change) => change.entityId === personId).map((change) => ({ ...change,
      recordId: record.id, revisionId: record.revisionId, storyTime: fields.storyTime,
      usable: false, eligible: forgeReviewed(fields) && ['author_setting', 'narrative_claim'].includes(fields.nature) }))
  })
  if (new Set(changes.map((change) => change.id)).size !== changes.length) return forgeFailure('人物状态变化标识在多个事件中重复，不能明确选择来源。')
  // 同属性只采用时点前的最后一项；同一时点出现两项时保留冲突，不能任挑一个。
  const latest = new Map<string, { order: number; count: number }>(), unknownTime = new Set<string>()
  // 按固定知识版本汇总竞争资格；来源过期只阻止选用，不让更早状态复活，也不改变历史重建结果。
  for (const change of changes) {
    if (!change.eligible || storyOrder === null) continue
    const at = timeOrder(change.storyTime)
    if (at === null) { unknownTime.add(change.attribute); continue }
    if (at > storyOrder) continue
    const previous = latest.get(change.attribute)
    if (!previous || at > previous.order) latest.set(change.attribute, { order: at, count: 1 })
    else if (at === previous.order) previous.count += 1
  }
  for (const change of changes) {
    const current = latest.get(change.attribute)
    change.usable = change.eligible && sourceCurrent(change.recordId) && Boolean(change.after.trim()) && !unknownTime.has(change.attribute) &&
      current?.count === 1 && current.order === timeOrder(change.storyTime)
  }
  const relations: ForgeRelation[] = records.flatMap((record): ForgeRelation[] => {
    if (record.fields.kind !== 'relation') return []
    const start = timeOrder(record.fields.validFrom), end = timeOrder(record.fields.validUntil)
    const active = storyOrder === null || !forgeReviewed(record.fields) || !sourceCurrent(record.id) || start === null || record.fields.validUntil.kind !== 'unknown' && end === null ? 'unknown'
      : storyOrder < start || end !== null && storyOrder >= end ? 'inactive' : 'active'
    return [{ id: record.id, revisionId: record.revisionId, fields: record.fields, active }]
  })
  const result: ForgePerson = { entity, profileTotal, profiles: profiles.map((row) => ({ revisionId: row.id, createdAt: row.created_at, fields: parseKnowledgeFields(forgeJson(row.fields_json)) })),
    cognitions, states: changes.map(({ eligible: _eligible, ...change }) => change), relations }
  if (options.cognitionIds) result.cognitions = result.cognitions.filter((item) => options.cognitionIds!.includes(item.id))
  if (options.stateIds) result.states = result.states.filter((item) => options.stateIds!.includes(item.id))
  if (options.offset !== undefined) {
    result.historyOffset = options.offset
    result.historyTotal = Math.max(result.cognitions.length, result.states.length, result.relations.length)
    result.cognitions = result.cognitions.slice(options.offset, options.offset + 50)
    result.states = result.states.slice(options.offset, options.offset + 50)
    result.relations = result.relations.slice(options.offset, options.offset + 50)
  }
  if (options.currentSources && (!chapterDependenciesCurrent(db, 'knowledge', bookId, personId) || [...sourceChecks.values()].some((current) => !current))) {
    result.sourceWarning = '部分资料引用的正文已修改，相关认知与状态暂不可选。请按当前正文复核并补充新稿引文。'
  }
  if (options.cognitionIds && options.stateIds) result.relations = []
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1_000_000) return forgeInvalid('人物历史资料超过本次一百万字节预算，请缩小档案说明后再读取。')
  return result
}
