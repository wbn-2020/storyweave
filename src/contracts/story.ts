import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText } from './api'
import {
  AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_NATURES, parseKnowledgeSource,
  type AuthorDecision, type ConflictState, type KnowledgeFreshness, type KnowledgeNature,
  type KnowledgeSourceInput, type SourceValidity,
} from './knowledge'

export const STORY_KINDS = ['relation', 'event', 'foreshadow', 'cognition'] as const
export const FORESHADOW_STAGES = ['planned', 'planted', 'advanced', 'revealed', 'resolved', 'abandoned'] as const
export const COGNITION_ATTITUDES = ['knows', 'believes', 'misunderstands', 'suspects'] as const
export type StoryKind = typeof STORY_KINDS[number]
export type ForeshadowStage = typeof FORESHADOW_STAGES[number]
export type CognitionAttitude = typeof COGNITION_ATTITUDES[number]

/** order 由作者明确填写；日期和相对时间标签不自动推导全序。 */
export type StoryTime = { kind: 'unknown' } | { kind: 'date' | 'relative'; label: string; order: number | null }
export type Disclosure = { state: 'unknown' | 'undisclosed' } | {
  state: 'located'; chapterId: string; revisionId: string; blockId: string
}

interface StoryCommonFields {
  title: string
  description: string
  nature: KnowledgeNature
  authorDecision: AuthorDecision
  freshness: KnowledgeFreshness
  conflictState: ConflictState
  /** 读者披露位置独立于故事时间与人物获知时间。 */
  disclosure: Disclosure
}

export interface RelationFields extends StoryCommonFields {
  kind: 'relation'
  fromEntityId: string
  toEntityId: string
  relationType: string
  direction: 'directed' | 'mutual'
  validFrom: StoryTime
  validUntil: StoryTime
  startEventId: string | null
  endEventId: string | null
}

export interface StoryStateChange {
  id: string
  entityId: string
  attribute: string
  before: string
  after: string
}

export interface EventFields extends StoryCommonFields {
  kind: 'event'
  storyTime: StoryTime
  participantIds: string[]
  mentionedEntityIds: string[]
  stateChanges: StoryStateChange[]
}

export interface ForeshadowMilestone {
  id: string
  stage: Exclude<ForeshadowStage, 'planned'>
  note: string
  storyTime: StoryTime
  disclosure: Disclosure
  source?: KnowledgeSourceInput
}

export interface ForeshadowFields extends StoryCommonFields {
  kind: 'foreshadow'
  storyTime: StoryTime
  stage: ForeshadowStage
  entityIds: string[]
  eventIds: string[]
  milestones: ForeshadowMilestone[]
  plannedPayoff: Disclosure
  actualPayoff: Disclosure
}

export interface CognitionFields extends StoryCommonFields {
  kind: 'cognition'
  /** 人物获知或形成认知的故事时间，不根据参与事件或读者披露自动填写。 */
  storyTime: StoryTime
  personId: string
  attitude: CognitionAttitude
  concealed: boolean
  acquisitionEventId: string | null
}

export type StoryRecordFields = RelationFields | EventFields | ForeshadowFields | CognitionFields
export interface StoryRecordInput { bookId: string; id: string }
export interface StoryRevisionInput extends StoryRecordInput { revisionId: string }
export interface CreateStoryRecordInput {
  bookId: string
  expectedKnowledgeRevision: number
  fields: StoryRecordFields
  source?: KnowledgeSourceInput
}
export interface UpdateStoryRecordInput extends CreateStoryRecordInput { id: string }
export interface ListStoryRecordsInput {
  bookId: string
  kind?: StoryKind
  search?: string
  entityId?: string
  limit?: number
  offset?: number
}
export interface StoryRecordSummary {
  id: string
  bookId: string
  fields: StoryRecordFields
  createdAt: string
  updatedAt: string
}
export interface StoryRecordListItem {
  id: string
  bookId: string
  kind: StoryKind
  title: string
  description: string
  time: StoryTime
  stage?: ForeshadowStage
  createdAt: string
  updatedAt: string
}
export type StorySource = KnowledgeSourceInput & {
  id: string
  recordId: string
  validity: SourceValidity
  referenceState?: 'current' | 'historical'
  createdAt: string
}
export interface StoryRevision {
  id: string
  bookId: string
  recordId: string
  knowledgeRevision: number
  fields: StoryRecordFields
  reason: 'created' | 'updated'
  createdAt: string
  labels: Record<string, string>
}
export interface StoryRevisionSummary {
  id: string
  recordId: string
  knowledgeRevision: number
  title: string
  reason: 'created' | 'updated'
  createdAt: string
}
export interface StoryRecordDetail extends StoryRecordSummary {
  bookRevision: number
  knowledgeRevision: number
  sources: StorySource[]
  labels: Record<string, string>
  /** 最近的修改记录；完整历史保留在书内数据库。 */
  revisions: StoryRevisionSummary[]
}
export interface StoryRecordPage {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  items: StoryRecordListItem[]
  total: number
  nextOffset: number | null
}

export const MAX_STORY_RECORDS = 100_000
export const MAX_STORY_SOURCES = 200
export const MAX_STORY_HISTORY_PAGE = 50
export const MAX_STORY_LINKS = 200
export const MAX_FORESHADOW_MILESTONES = 200

function invalid(message: string): never {
  throw new DomainError({ code: 'INVALID_INPUT', message })
}

function record(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) return invalid(`${label}格式无效或包含不支持的字段。`)
  return value
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return invalid(`${label}无效。`)
  return value as T
}

function id(value: unknown): string { return requiredId(value).toLowerCase() }
function nullableId(value: unknown): string | null { return value === null ? null : id(value) }

function idList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_STORY_LINKS) return invalid(`${label}最多 ${MAX_STORY_LINKS} 项。`)
  const ids = value.map((item: unknown) => id(item))
  if (new Set(ids).size !== ids.length) return invalid(`${label}不能重复。`)
  return ids
}

export function parseStoryTime(value: unknown): StoryTime {
  if (!isRecord(value)) return invalid('故事时间格式无效。')
  const kind = choice(value.kind, ['unknown', 'date', 'relative'] as const, '故事时间类型')
  const data = record(value, kind === 'unknown' ? ['kind'] : ['kind', 'label', 'order'], '故事时间')
  if (kind === 'unknown') return { kind }
  if (data.order !== null && (typeof data.order !== 'number' || !Number.isSafeInteger(data.order) || Math.abs(data.order) > 1_000_000_000)) {
    return invalid('时间排序值必须是绝对值不超过 10 亿的整数，未指定时填写 null。')
  }
  return { kind, label: requiredText(data.label, '时间标签', 200), order: data.order as number | null }
}

export function parseDisclosure(value: unknown): Disclosure {
  if (!isRecord(value)) return invalid('读者披露位置格式无效。')
  const state = choice(value.state, ['unknown', 'undisclosed', 'located'] as const, '披露状态')
  const data = record(value, state === 'located' ? ['state', 'chapterId', 'revisionId', 'blockId'] : ['state'], '读者披露位置')
  if (state !== 'located') return { state }
  return { state, chapterId: id(data.chapterId), revisionId: id(data.revisionId), blockId: id(data.blockId) }
}

function stateChanges(value: unknown): StoryStateChange[] {
  if (!Array.isArray(value) || value.length > MAX_STORY_LINKS) return invalid(`事件状态变化最多 ${MAX_STORY_LINKS} 项。`)
  const changes = value.map((item: unknown): StoryStateChange => {
    const data = record(item, ['id', 'entityId', 'attribute', 'before', 'after'], '事件状态变化')
    return { id: id(data.id), entityId: id(data.entityId), attribute: requiredText(data.attribute, '变化属性', 120),
      before: optionalText(data.before, '变化前状态', 2000), after: optionalText(data.after, '变化后状态', 2000) }
  })
  if (new Set(changes.map((item) => item.id)).size !== changes.length) return invalid('状态变化标识不能重复。')
  return changes
}

function milestones(value: unknown, bookId: string): ForeshadowMilestone[] {
  if (!Array.isArray(value) || value.length > MAX_FORESHADOW_MILESTONES) return invalid(`伏笔里程碑最多 ${MAX_FORESHADOW_MILESTONES} 项。`)
  const result = value.map((item: unknown): ForeshadowMilestone => {
    const data = record(item, ['id', 'stage', 'note', 'storyTime', 'disclosure', 'source'], '伏笔里程碑')
    return { id: id(data.id), stage: choice(data.stage, ['planted', 'advanced', 'revealed', 'resolved', 'abandoned'] as const, '里程碑阶段'),
      note: requiredText(data.note, '里程碑说明', 2000), storyTime: parseStoryTime(data.storyTime), disclosure: parseDisclosure(data.disclosure),
      ...(data.source === undefined ? {} : { source: parseKnowledgeSource(data.source, bookId) }) }
  })
  if (new Set(result.map((item) => item.id)).size !== result.length) return invalid('伏笔里程碑标识不能重复。')
  let terminal = false
  let planted = false
  let revealed = false
  for (const milestone of result) {
    // 里程碑是有序的生命周期记录；揭示之后仍可继续推进，回收与放弃为终局。
    if (terminal) return invalid('已回收或放弃后不能继续追加伏笔里程碑。')
    if (milestone.stage === 'planted') {
      if (planted) return invalid('同一伏笔只能首次埋设一次，后续请记录推进。')
      planted = true
    } else if (milestone.stage !== 'abandoned' && !planted) {
      return invalid('请先记录伏笔埋设，再记录推进、揭示或回收。')
    }
    if (milestone.stage === 'revealed') {
      if (revealed) return invalid('同一伏笔只能首次揭示一次，后续请记录推进或回收。')
      revealed = true
    }
    terminal = milestone.stage === 'resolved' || milestone.stage === 'abandoned'
  }
  return result
}

const COMMON_KEYS = ['kind', 'title', 'description', 'nature', 'authorDecision', 'freshness', 'conflictState', 'disclosure']

export function parseStoryFields(value: unknown, bookId: string): StoryRecordFields {
  if (!isRecord(value)) return invalid('故事记录格式无效。')
  const kind = choice(value.kind, STORY_KINDS, '故事记录类型')
  const extraKeys = kind === 'relation'
    ? ['fromEntityId', 'toEntityId', 'relationType', 'direction', 'validFrom', 'validUntil', 'startEventId', 'endEventId']
    : kind === 'event' ? ['storyTime', 'participantIds', 'mentionedEntityIds', 'stateChanges']
      : kind === 'foreshadow' ? ['storyTime', 'stage', 'entityIds', 'eventIds', 'milestones', 'plannedPayoff', 'actualPayoff']
        : ['storyTime', 'personId', 'attitude', 'concealed', 'acquisitionEventId']
  const data = record(value, [...COMMON_KEYS, ...extraKeys], '故事记录')
  const common: StoryCommonFields = {
    title: requiredText(data.title, '记录名称', 120), description: optionalText(data.description, '记录说明', 20_000),
    nature: choice(data.nature, KNOWLEDGE_NATURES, '知识性质'), authorDecision: choice(data.authorDecision, AUTHOR_DECISIONS, '作者决定'),
    freshness: choice(data.freshness, KNOWLEDGE_FRESHNESS, '新鲜度'), conflictState: choice(data.conflictState, CONFLICT_STATES, '冲突状态'),
    disclosure: parseDisclosure(data.disclosure),
  }
  if (kind === 'relation') {
    const fromEntityId = id(data.fromEntityId)
    const toEntityId = id(data.toEntityId)
    if (fromEntityId === toEntityId) return invalid('关系两端必须是不同的知识实体。')
    const validFrom = parseStoryTime(data.validFrom)
    const validUntil = parseStoryTime(data.validUntil)
    if (validFrom.kind !== 'unknown' && validUntil.kind !== 'unknown' && validFrom.order !== null && validUntil.order !== null && validFrom.order > validUntil.order) {
      return invalid('关系起始排序值不能晚于结束排序值。')
    }
    return { ...common, kind, fromEntityId, toEntityId, relationType: requiredText(data.relationType, '关系类型', 120),
      direction: choice(data.direction, ['directed', 'mutual'] as const, '关系方向'), validFrom, validUntil,
      startEventId: nullableId(data.startEventId), endEventId: nullableId(data.endEventId) }
  }
  if (kind === 'event') return { ...common, kind, storyTime: parseStoryTime(data.storyTime),
    participantIds: idList(data.participantIds, '事件参与者'), mentionedEntityIds: idList(data.mentionedEntityIds, '被提及对象'), stateChanges: stateChanges(data.stateChanges) }
  if (kind === 'foreshadow') {
    const stage = choice(data.stage, FORESHADOW_STAGES, '伏笔阶段')
    const history = milestones(data.milestones, bookId)
    if ((history.length === 0 && stage !== 'planned') || (history.length > 0 && history[history.length - 1]?.stage !== stage)) {
      return invalid('伏笔当前阶段必须与最后一条里程碑一致；尚无里程碑时必须是计划阶段。')
    }
    return { ...common, kind, storyTime: parseStoryTime(data.storyTime), stage, entityIds: idList(data.entityIds, '伏笔关联实体'),
      eventIds: idList(data.eventIds, '伏笔关联事件'), milestones: history, plannedPayoff: parseDisclosure(data.plannedPayoff), actualPayoff: parseDisclosure(data.actualPayoff) }
  }
  if (typeof data.concealed !== 'boolean') return invalid('人物隐瞒标记必须是布尔值。')
  return { ...common, kind, storyTime: parseStoryTime(data.storyTime), personId: id(data.personId),
    attitude: choice(data.attitude, COGNITION_ATTITUDES, '人物认知态度'), concealed: data.concealed, acquisitionEventId: nullableId(data.acquisitionEventId) }
}

export function parseStoryRecordInput(value: unknown): StoryRecordInput {
  const data = record(value, ['bookId', 'id'], '故事记录请求')
  return { bookId: id(data.bookId), id: id(data.id) }
}

export function parseStoryRevisionInput(value: unknown): StoryRevisionInput {
  const data = record(value, ['bookId', 'id', 'revisionId'], '故事历史请求')
  return { bookId: id(data.bookId), id: id(data.id), revisionId: id(data.revisionId) }
}

export function parseCreateStoryRecord(value: unknown): CreateStoryRecordInput {
  const data = record(value, ['bookId', 'expectedKnowledgeRevision', 'fields', 'source'], '新建故事记录请求')
  const bookId = id(data.bookId)
  return { bookId, expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识库版本'), fields: parseStoryFields(data.fields, bookId),
    ...(data.source === undefined ? {} : { source: parseKnowledgeSource(data.source, bookId) }) }
}

export function parseUpdateStoryRecord(value: unknown): UpdateStoryRecordInput {
  const data = record(value, ['bookId', 'id', 'expectedKnowledgeRevision', 'fields', 'source'], '更新故事记录请求')
  const { id: recordId, ...input } = data
  return { ...parseCreateStoryRecord(input), id: id(recordId) }
}

export function parseListStoryRecords(value: unknown): ListStoryRecordsInput {
  const data = record(value, ['bookId', 'kind', 'search', 'entityId', 'limit', 'offset'], '故事记录列表请求')
  const limit = data.limit === undefined ? 50 : requiredInteger(data.limit, '每页数量', 100)
  if (limit === 0) return invalid('每页数量必须在 1 到 100 之间。')
  return { bookId: id(data.bookId), limit, offset: data.offset === undefined ? 0 : requiredInteger(data.offset, '列表位置', MAX_STORY_RECORDS),
    ...(data.kind === undefined ? {} : { kind: choice(data.kind, STORY_KINDS, '故事记录类型') }),
    ...(data.search === undefined ? {} : { search: optionalText(data.search, '搜索内容', 200) }),
    ...(data.entityId === undefined ? {} : { entityId: id(data.entityId) }) }
}
