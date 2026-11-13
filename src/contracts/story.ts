import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText } from './api'
import { parseForeshadowThumbnailFields, type ForeshadowThumbnailFields, type ForeshadowThumbnailMetadata } from './foreshadow-thumbnail'
import {
  AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_NATURES, parseKnowledgeSource,
  type AuthorDecision, type ConflictState, type KnowledgeFreshness, type KnowledgeNature,
  type KnowledgeSourceInput, type SourceValidity,
} from './knowledge'

export const STORY_KINDS = ['relation', 'event', 'foreshadow', 'cognition'] as const
export const FORESHADOW_STAGES = ['planned', 'planted', 'advanced', 'revealed', 'resolved', 'abandoned'] as const
export const COGNITION_ATTITUDES = ['knows', 'believes', 'misunderstands', 'suspects'] as const
export const COGNITION_CHANGES = ['formed', 'revised', 'refuted', 'concealed', 'forgotten'] as const
export type StoryKind = typeof STORY_KINDS[number]
export type ForeshadowStage = typeof FORESHADOW_STAGES[number]
export type CognitionAttitude = typeof COGNITION_ATTITUDES[number]
export type CognitionChangeKind = typeof COGNITION_CHANGES[number]

/** order 由作者明确填写；日期和相对时间标签不自动推导全序。 */
export type StoryTime = { kind: 'unknown' } | { kind: 'date' | 'relative'; label: string; order: number | null }
export type Disclosure = { state: 'unknown' | 'undisclosed' } | {
  state: 'located'; chapterId: string; revisionId: string; blockId: string
}

/** 计划不要求正文已经存在；旧版固定段落目标保持原样可读。 */
export type PlannedPayoff = Disclosure
  | { state: 'volume'; volumeId: string | null; label: string; targetNumber?: number }
  | { state: 'chapter'; chapterId: string | null; label: string; targetNumber?: number }
  | { state: 'scene'; sceneId: string | null; chapterId: string | null; label: string }
  | { state: 'text'; label: string }

export interface CognitionEvolution {
  kind: CognitionChangeKind
  previousId: string | null
  /** 截止时点不包含在有效期内；后继状态可使本状态更早结束。 */
  validUntil: StoryTime
  knowledgeOrigin?: { itemId: string; revisionId: string }
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
  /** 关系层次独立于读者披露；旧记录省略时表示未标注。 */
  layer?: 'surface' | 'hidden'
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
  /** 作者核对整章后明确登记的缺席；正文修订改变后只能作为旧稿核对记录。 */
  appearanceCheck?: { chapterId: string; revisionId: string; absentEntityIds: string[]; note: string }
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
  plannedPayoff: PlannedPayoff
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
  /** 每个状态独立保存；缺省表示旧记录，不给旧快照补写新字段。 */
  evolution?: CognitionEvolution
}

export type StoryRecordFields = RelationFields | EventFields | ForeshadowFields | CognitionFields
export interface StoryRecordInput { bookId: string; id: string }
export interface StoryRevisionInput extends StoryRecordInput { revisionId: string }
export interface CreateStoryRecordInput {
  bookId: string
  expectedKnowledgeRevision: number
  fields: StoryRecordFields
  source?: KnowledgeSourceInput
  /** 仅伏笔支持；省略保留原图，null 明确移除，与记录同事务保存。 */
  thumbnail?: ForeshadowThumbnailFields | null
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
  thumbnail?: ForeshadowThumbnailMetadata | null
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
  cognitionHistory?: CognitionState[]
  thumbnail?: ForeshadowThumbnailMetadata | null
}
export interface CognitionState {
  id: string
  fields: CognitionFields
  effectiveUntil: StoryTime
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
export const MAX_COGNITION_STATES = 200
export const STORY_EVOLUTION_SCHEMA_VERSION = 13

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

export function parsePlannedPayoff(value: unknown): PlannedPayoff {
  if (!isRecord(value)) return invalid('计划回收目标格式无效。')
  if (value.state === 'unknown' || value.state === 'undisclosed' || value.state === 'located') return parseDisclosure(value)
  const state = choice(value.state, ['volume', 'chapter', 'scene', 'text'] as const, '计划回收范围')
  const keys = state === 'volume' ? ['volumeId'] : state === 'chapter' ? ['chapterId'] : state === 'scene' ? ['sceneId', 'chapterId'] : []
  const data = record(value, ['state', 'label', ...keys, ...(state === 'volume' || state === 'chapter' ? ['targetNumber'] : [])], '计划回收目标')
  const label = requiredText(data.label, '计划回收范围说明', 500)
  let targetNumber: number | undefined
  if (data.targetNumber !== undefined) {
    targetNumber = requiredInteger(data.targetNumber, '计划卷章序号', 200_000)
    if (targetNumber < 1 || data.volumeId != null || data.chapterId != null) return invalid('未建卷章序号须从 1 开始，且不能同时关联已有卷章。')
  }
  const number = targetNumber === undefined ? {} : { targetNumber }
  if (state === 'volume') return { state, label, volumeId: nullableId(data.volumeId), ...number }
  if (state === 'chapter') return { state, label, chapterId: nullableId(data.chapterId), ...number }
  if (state === 'scene') return { state, label, sceneId: nullableId(data.sceneId), chapterId: nullableId(data.chapterId) }
  return { state, label }
}

export function plannedPayoffText(value: PlannedPayoff): string {
  if ('label' in value) {
    const labels = { volume: '卷', chapter: '章', scene: '场景', text: '文字范围' }
    return `${labels[value.state]}：${value.label}${'targetNumber' in value && value.targetNumber !== undefined ? `（计划第 ${value.targetNumber} ${value.state === 'volume' ? '卷' : '章'}）` : ''}`
  }
  // 旧目标沿用原记忆投影文字，避免同一历史修订重新投影时改变摘要指纹。
  if (value.state !== 'located') return value.state === 'unknown' ? '未知' : '未披露'
  return `章节 ${value.chapterId}；修订 ${value.revisionId}；段落 ${value.blockId}`
}

function parseCognitionEvolution(value: unknown, formedAt: StoryTime): CognitionEvolution {
  const data = record(value, ['kind', 'previousId', 'validUntil', 'knowledgeOrigin'], '认知变迁')
  const kind = choice(data.kind, COGNITION_CHANGES, '认知变化类型')
  const previousId = nullableId(data.previousId)
  if ((kind === 'formed') !== (previousId === null)) return invalid('形成认知不关联前态；修正、推翻、隐瞒和遗忘须选择前一认知状态。')
  const validUntil = parseStoryTime(data.validUntil)
  if (previousId !== null && (formedAt.kind === 'unknown' || formedAt.order === null)) return invalid('认知变化须填写明确的故事排序值。')
  if (validUntil.kind !== 'unknown') {
    if (validUntil.order === null || formedAt.kind === 'unknown' || formedAt.order === null || validUntil.order <= formedAt.order) {
      return invalid('认知有效截止须有明确排序值，且严格晚于形成时间。')
    }
  }
  let knowledgeOrigin: CognitionEvolution['knowledgeOrigin']
  if (data.knowledgeOrigin !== undefined) {
    const origin = record(data.knowledgeOrigin, ['itemId', 'revisionId'], '认知转换来源')
    knowledgeOrigin = { itemId: id(origin.itemId), revisionId: id(origin.revisionId) }
  }
  return { kind, previousId, validUntil, ...(knowledgeOrigin ? { knowledgeOrigin } : {}) }
}

/** 编辑时间与故事时间分别保存；该函数只查询作者确认的状态区间。 */
export function cognitionStateAt(history: readonly CognitionState[], storyOrder: number): CognitionState | null {
  return history.find((state) => {
    const start = state.fields.storyTime
    const end = state.effectiveUntil
    return start.kind !== 'unknown' && start.order !== null && start.order <= storyOrder &&
      (end.kind === 'unknown' || end.order !== null && storyOrder < end.order)
  }) ?? null
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
    ? ['fromEntityId', 'toEntityId', 'relationType', 'direction', 'layer', 'validFrom', 'validUntil', 'startEventId', 'endEventId']
    : kind === 'event' ? ['storyTime', 'participantIds', 'mentionedEntityIds', 'stateChanges', 'appearanceCheck']
      : kind === 'foreshadow' ? ['storyTime', 'stage', 'entityIds', 'eventIds', 'milestones', 'plannedPayoff', 'actualPayoff']
        : ['storyTime', 'personId', 'attitude', 'concealed', 'acquisitionEventId', 'evolution']
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
      ...(data.layer === undefined ? {} : { layer: choice(data.layer, ['surface', 'hidden'] as const, '关系层次') }),
      startEventId: nullableId(data.startEventId), endEventId: nullableId(data.endEventId) }
  }
  if (kind === 'event') {
    const participantIds = idList(data.participantIds, '事件参与者')
    const mentionedEntityIds = idList(data.mentionedEntityIds, '被提及对象')
    let appearanceCheck: EventFields['appearanceCheck']
    if (data.appearanceCheck !== undefined) {
      const check = record(data.appearanceCheck, ['chapterId', 'revisionId', 'absentEntityIds', 'note'], '整章出场核对')
      const absentEntityIds = idList(check.absentEntityIds, '已核对缺席的实体')
      if (!absentEntityIds.length) return invalid('整章核对至少需要一个明确缺席的实体。')
      if (absentEntityIds.some((entityId) => participantIds.includes(entityId) || mentionedEntityIds.includes(entityId))) return invalid('同一条事件不能同时标注某实体参与／提及与整章缺席。')
      appearanceCheck = { chapterId: id(check.chapterId), revisionId: id(check.revisionId), absentEntityIds,
        note: requiredText(check.note, '整章核对说明', 2000) }
    }
    return { ...common, kind, storyTime: parseStoryTime(data.storyTime), participantIds, mentionedEntityIds,
      stateChanges: stateChanges(data.stateChanges), ...(appearanceCheck ? { appearanceCheck } : {}) }
  }
  if (kind === 'foreshadow') {
    const stage = choice(data.stage, FORESHADOW_STAGES, '伏笔阶段')
    const history = milestones(data.milestones, bookId)
    if ((history.length === 0 && stage !== 'planned') || (history.length > 0 && history[history.length - 1]?.stage !== stage)) {
      return invalid('伏笔当前阶段必须与最后一条里程碑一致；尚无里程碑时必须是计划阶段。')
    }
    return { ...common, kind, storyTime: parseStoryTime(data.storyTime), stage, entityIds: idList(data.entityIds, '伏笔关联实体'),
      eventIds: idList(data.eventIds, '伏笔关联事件'), milestones: history, plannedPayoff: parsePlannedPayoff(data.plannedPayoff), actualPayoff: parseDisclosure(data.actualPayoff) }
  }
  if (typeof data.concealed !== 'boolean') return invalid('人物隐瞒标记必须是布尔值。')
  const storyTime = parseStoryTime(data.storyTime)
  return { ...common, kind, storyTime, personId: id(data.personId),
    attitude: choice(data.attitude, COGNITION_ATTITUDES, '人物认知态度'), concealed: data.concealed, acquisitionEventId: nullableId(data.acquisitionEventId),
    ...(data.evolution === undefined ? {} : { evolution: parseCognitionEvolution(data.evolution, storyTime) }) }
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
  const data = record(value, ['bookId', 'expectedKnowledgeRevision', 'fields', 'source', 'thumbnail'], '新建故事记录请求')
  const bookId = id(data.bookId)
  const fields = parseStoryFields(data.fields, bookId)
  if (data.thumbnail !== undefined && fields.kind !== 'foreshadow') return invalid('只有伏笔记录可以保存伏笔配图。')
  return { bookId, expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识库版本'), fields,
    ...(data.thumbnail === undefined ? {} : { thumbnail: data.thumbnail === null ? null : parseForeshadowThumbnailFields(data.thumbnail) }),
    ...(data.source === undefined ? {} : { source: parseKnowledgeSource(data.source, bookId) }) }
}

export function parseUpdateStoryRecord(value: unknown): UpdateStoryRecordInput {
  const data = record(value, ['bookId', 'id', 'expectedKnowledgeRevision', 'fields', 'source', 'thumbnail'], '更新故事记录请求')
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
