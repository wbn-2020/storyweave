import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, type BookInput } from './api'
import { parseCharacterProfile, type CharacterProfile } from './character-profile'

export const KNOWLEDGE_KINDS = ['person', 'place', 'organization', 'object', 'rule', 'theme', 'other'] as const
export const KNOWLEDGE_NATURES = ['author_setting', 'future_plan', 'narrative_claim', 'character_belief', 'ai_derived', 'ai_inference', 'external_reference'] as const
export const AUTHOR_DECISIONS = ['unreviewed', 'adopted', 'rejected', 'review_later'] as const
export const KNOWLEDGE_FRESHNESS = ['current', 'affected', 'updating', 'failed'] as const
export const CONFLICT_STATES = ['unchecked', 'clear', 'candidate', 'explained'] as const

export type KnowledgeKind = typeof KNOWLEDGE_KINDS[number]
export type KnowledgeNature = typeof KNOWLEDGE_NATURES[number]
export type AuthorDecision = typeof AUTHOR_DECISIONS[number]
export type KnowledgeFreshness = typeof KNOWLEDGE_FRESHNESS[number]
export type ConflictState = typeof CONFLICT_STATES[number]
export type SourceValidity = 'valid' | 'partial' | 'missing'

export interface KnowledgeItemFields {
  kind: KnowledgeKind
  name: string
  aliases: string[]
  summary: string
  nature: KnowledgeNature
  authorDecision: AuthorDecision
  freshness: KnowledgeFreshness
  conflictState: ConflictState
  /** 可选人物档案；更新时省略表示保留，显式空对象表示清空。 */
  characterProfile?: CharacterProfile
}

export type KnowledgeSourceInput = {
  sourceType: 'chapter_text'
  bookId: string
  chapterId: string
  revisionId: string
  blockId: string
  quote: string
} | {
  sourceType: 'author_input' | 'external'
  bookId: string
  quote: string
}

export type KnowledgeSource = KnowledgeSourceInput & {
  id: string
  itemId: string
  validity: SourceValidity
  referenceState?: 'current' | 'historical'
  createdAt: string
}

export interface KnowledgeItemSummary extends KnowledgeItemFields {
  id: string
  bookId: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeRevision {
  id: string
  itemId: string
  knowledgeRevision: number
  fields: KnowledgeItemFields
  reason: 'created' | 'updated'
  createdAt: string
}

export const KNOWLEDGE_ADJUDICATION_SCHEMA_VERSION = 26
export const KNOWLEDGE_RESOLUTIONS = ['keep_a', 'keep_b', 'intentional'] as const
export type KnowledgeResolution = typeof KNOWLEDGE_RESOLUTIONS[number]

export interface KnowledgeAdjudicationInput {
  id: string
  expectedBookRevision: number
  expectedItemRevisionId: string
  sourceAId: string
  sourceBId: string
  resolution: KnowledgeResolution
  note: string
}

export interface KnowledgeAdjudication {
  id: string
  itemId: string
  sourceAId: string
  sourceBId: string
  previousRevisionId: string
  revisionId: string
  bookRevision: number
  knowledgeRevision: number
  resolution: KnowledgeResolution
  note: string
  createdAt: string
}

export const KNOWLEDGE_RELATED_LIMIT = 12
export interface KnowledgeRelatedItem {
  recordId: string
  entityId: string
  name: string
  kind: KnowledgeKind
  title: string
  relationType: string
  direction: 'outgoing' | 'incoming' | 'mutual'
  layer?: 'surface' | 'hidden'
  nature: KnowledgeNature
  authorDecision: AuthorDecision
  freshness: KnowledgeFreshness
  conflictState: ConflictState
}
export interface KnowledgeAppearance {
  chapterId: string
  chapterTitle: string
  chapterPosition: number
  revisionId: string
  eventId: string
}
export type KnowledgeStoryContext = { state: 'requires_upgrade' } | {
  state: 'ready'
  /** 当前稿中最早的有效登场登记，不以知识出处或提及代替。 */
  firstAppearance: KnowledgeAppearance | null
  /** 按同一有效登记规则取最晚章节；只有一章时与首次相同。 */
  lastAppearance: KnowledgeAppearance | null
  /** 最近登记的关系，保留原判断；不推断其在当前剧情的有效性。 */
  relations: KnowledgeRelatedItem[]
  relationsTruncated: boolean
}

export interface KnowledgeItemDetail extends KnowledgeItemSummary {
  bookRevision: number
  knowledgeRevision: number
  sources: KnowledgeSource[]
  /** 最近的修改记录；完整历史保留在知识库内。 */
  revisions: KnowledgeRevision[]
  /** v26 起返回独立裁决记录；来源和前后修订均为不可变身份。 */
  adjudications?: KnowledgeAdjudication[]
  /** 仅显式详情读取按需返回，与条目共用同一事务和双版本；写入回执不附带。 */
  storyContext?: KnowledgeStoryContext
}

export interface KnowledgeItemInput { bookId: string; id: string; includeStoryContext?: boolean }
export interface CreateKnowledgeItemInput {
  bookId: string
  expectedKnowledgeRevision: number
  fields: KnowledgeItemFields
  source?: KnowledgeSourceInput
}
export interface UpdateKnowledgeItemInput extends CreateKnowledgeItemInput {
  id: string
  adjudication?: KnowledgeAdjudicationInput
}
export interface ListKnowledgeItemsInput {
  bookId: string
  kind?: KnowledgeKind
  nature?: KnowledgeNature
  search?: string
  limit?: number
  offset?: number
  reviewOnly?: boolean
  includeOverview?: boolean
}
export interface KnowledgeItemPage {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  items: KnowledgeItemSummary[]
  total: number
  nextOffset: number | null
  overview?: {
    counts: Record<KnowledgeKind, number>
    total: number
    reviewTotal: number
    sourceChapterCounts: Record<string, number>
  }
}

export interface KnowledgeStatus {
  bookId: string
  bookRevision: number
  /** 作品元数据的更新时间，用于升级回执先推进界面基线。 */
  updatedAt: string
  schemaVersion: number
  knowledgeRevision: number
  /** 表示基础知识表是否缺失；故事记录另要求 schemaVersion >= 4。 */
  requiresUpgrade: boolean
  backupPath?: string
}

export interface UpgradeKnowledgeInput {
  bookId: string
  expectedBookRevision: number
}

export const MAX_KNOWLEDGE_ITEMS = 100_000
export const MAX_KNOWLEDGE_SOURCES = 200
export const MAX_KNOWLEDGE_HISTORY_PAGE = 50
export const MAX_KNOWLEDGE_ADJUDICATIONS = 200

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

export function parseKnowledgeStatusInput(value: unknown): BookInput {
  const data = record(value, ['bookId'], '知识库状态请求')
  return { bookId: requiredId(data.bookId).toLowerCase() }
}

export function parseUpgradeKnowledgeInput(value: unknown): UpgradeKnowledgeInput {
  const data = record(value, ['bookId', 'expectedBookRevision'], '知识库升级请求')
  return { bookId: requiredId(data.bookId).toLowerCase(), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本') }
}

export function parseKnowledgeFields(value: unknown): KnowledgeItemFields {
  const data = record(value, ['kind', 'name', 'aliases', 'summary', 'nature', 'authorDecision', 'freshness', 'conflictState', 'characterProfile'], '知识条目')
  if (!Array.isArray(data.aliases) || data.aliases.length > 50) return invalid('别名最多 50 个。')
  const aliases = Array.from(data.aliases, (alias: unknown) => requiredText(alias, '别名', 120))
  if (new Set(aliases).size !== aliases.length) return invalid('别名不能重复。')
  const kind = choice(data.kind, KNOWLEDGE_KINDS, '知识类型')
  const characterProfile = data.characterProfile === undefined ? undefined : parseCharacterProfile(data.characterProfile)
  if (kind !== 'person' && characterProfile && Object.keys(characterProfile).length > 0) return invalid('只有人物条目可以填写人物档案。')
  return {
    kind, name: requiredText(data.name, '条目名称', 120), aliases,
    summary: optionalText(data.summary, '条目说明', 20_000), nature: choice(data.nature, KNOWLEDGE_NATURES, '知识性质'),
    authorDecision: choice(data.authorDecision, AUTHOR_DECISIONS, '作者决定'),
    freshness: choice(data.freshness, KNOWLEDGE_FRESHNESS, '新鲜度'), conflictState: choice(data.conflictState, CONFLICT_STATES, '冲突状态'),
    ...(characterProfile === undefined ? {} : { characterProfile }),
  }
}

/** 省略档案保留已有值；显式空档案清空。写入和回执核对共用同一规则。 */
export function resolveKnowledgeFields(fields: KnowledgeItemFields, previous?: KnowledgeItemFields): KnowledgeItemFields {
  const resolved = { ...fields }
  const profile = fields.characterProfile ?? previous?.characterProfile
  if (profile && Object.keys(profile).length > 0) resolved.characterProfile = profile
  else delete resolved.characterProfile
  return resolved
}

export function parseKnowledgeSource(value: unknown, bookId: string): KnowledgeSourceInput {
  if (!isRecord(value)) return invalid('来源记录无效。')
  const sourceType = choice(value.sourceType, ['author_input', 'chapter_text', 'external'] as const, '来源类型')
  const data = record(value, sourceType === 'chapter_text'
    ? ['sourceType', 'bookId', 'chapterId', 'revisionId', 'blockId', 'quote'] : ['sourceType', 'bookId', 'quote'], '来源记录')
  const sourceBookId = requiredId(data.bookId).toLowerCase()
  if (sourceBookId !== requiredId(bookId).toLowerCase()) return invalid('来源必须属于当前作品，跨书资料需要明确复制后再关联。')
  // 引文保留原始空白，以便存储层对指定 revision 与段落做精确核验。
  if (typeof data.quote !== 'string' || !data.quote.trim() || data.quote.length > 2000) return invalid('来源说明或引文不能为空，且不能超过 2,000 个字符。')
  if (sourceType === 'chapter_text') {
    return { sourceType, bookId: sourceBookId, chapterId: requiredId(data.chapterId).toLowerCase(),
      revisionId: requiredId(data.revisionId).toLowerCase(), blockId: requiredId(data.blockId).toLowerCase(), quote: data.quote }
  }
  return { sourceType, bookId: sourceBookId, quote: data.quote }
}

export function parseKnowledgeItemInput(value: unknown): KnowledgeItemInput {
  const data = record(value, ['bookId', 'id', 'includeStoryContext'], '知识条目请求')
  if (data.includeStoryContext !== undefined && typeof data.includeStoryContext !== 'boolean') return invalid('关联登记读取开关必须为布尔值。')
  return { bookId: requiredId(data.bookId).toLowerCase(), id: requiredId(data.id).toLowerCase(),
    ...(data.includeStoryContext === undefined ? {} : { includeStoryContext: data.includeStoryContext as boolean }) }
}

/** 新增只读投影必须有界且指向其他实体；错误结构不能被界面解释成空登记。 */
export function isKnowledgeStoryContextFor(value: unknown, itemId: string): value is KnowledgeStoryContext {
  try {
    requiredId(itemId)
    if (!isRecord(value)) return false
    if (value.state === 'requires_upgrade') return Object.keys(value).length === 1
    const data = record(value, ['state', 'firstAppearance', 'lastAppearance', 'relations', 'relationsTruncated'], '关联登记')
    if (data.state !== 'ready' || !Array.isArray(data.relations) || data.relations.length > KNOWLEDGE_RELATED_LIMIT ||
        typeof data.relationsTruncated !== 'boolean' || (data.relationsTruncated && data.relations.length !== KNOWLEDGE_RELATED_LIMIT)) return false
    const [first, last] = [data.firstAppearance, data.lastAppearance].map((value): KnowledgeAppearance | null => {
      if (value === null) return null
      const appearance = record(value, ['chapterId', 'chapterTitle', 'chapterPosition', 'revisionId', 'eventId'], '登场登记')
      return { chapterId: requiredId(appearance.chapterId), chapterTitle: requiredText(appearance.chapterTitle, '登场章节', 120),
        chapterPosition: requiredInteger(appearance.chapterPosition, '登场章节位置', Number.MAX_SAFE_INTEGER - 1),
        revisionId: requiredId(appearance.revisionId), eventId: requiredId(appearance.eventId) }
    })
    // 首末取自同一快照；空值必须成对，同一章节的修订和代表事件不能互相矛盾。
    if ((first === null) !== (last === null)) return false
    if (first && last && (first.chapterPosition > last.chapterPosition ||
        ((first.chapterId.toLowerCase() === last.chapterId.toLowerCase() || first.chapterPosition === last.chapterPosition) &&
          JSON.stringify(first) !== JSON.stringify(last)))) {
      return false
    }
    const ids = new Set<string>(), entities = new Map<string, string>()
    for (const entry of data.relations) {
      const relation = record(entry, ['recordId', 'entityId', 'name', 'kind', 'title', 'relationType', 'direction', 'layer',
        'nature', 'authorDecision', 'freshness', 'conflictState'], '关联记录')
      const recordId = requiredId(relation.recordId).toLowerCase(), entityId = requiredId(relation.entityId).toLowerCase()
      const name = requiredText(relation.name, '关联对象', 120), kind = choice(relation.kind, KNOWLEDGE_KINDS, '关联类型')
      if (entityId === itemId.toLowerCase() || ids.has(recordId) ||
          (entities.has(entityId) && entities.get(entityId) !== JSON.stringify([name, kind]))) return false
      ids.add(recordId); entities.set(entityId, JSON.stringify([name, kind]))
      requiredText(relation.title, '关系名称', 120); requiredText(relation.relationType, '关系类型', 120)
      choice(relation.direction, ['outgoing', 'incoming', 'mutual'] as const, '关系方向')
      if (relation.layer !== undefined) choice(relation.layer, ['surface', 'hidden'] as const, '关系层次')
      choice(relation.nature, KNOWLEDGE_NATURES, '关系性质'); choice(relation.authorDecision, AUTHOR_DECISIONS, '关系决定')
      choice(relation.freshness, KNOWLEDGE_FRESHNESS, '关系新鲜度'); choice(relation.conflictState, CONFLICT_STATES, '关系冲突')
    }
    return true
  } catch { return false }
}

export function parseCreateKnowledgeItem(value: unknown): CreateKnowledgeItemInput {
  const data = record(value, ['bookId', 'expectedKnowledgeRevision', 'fields', 'source'], '新建知识条目请求')
  const bookId = requiredId(data.bookId).toLowerCase()
  const fields = parseKnowledgeFields(data.fields)
  // 写入边界拦截空字符，历史字段解析保留兼容性，便于查看与修正旧条目。
  if (fields.summary.includes('\0')) return invalid('条目说明不能包含空字符（NUL），请修正后再保存。')
  return { bookId, expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识库版本'),
    fields, ...(data.source === undefined ? {} : { source: parseKnowledgeSource(data.source, bookId) }) }
}

export function parseUpdateKnowledgeItem(value: unknown): UpdateKnowledgeItemInput {
  const data = record(value, ['bookId', 'id', 'expectedKnowledgeRevision', 'fields', 'source', 'adjudication'], '更新知识条目请求')
  const { id, adjudication, ...input } = data
  if (adjudication !== undefined && data.source !== undefined) return invalid('裁决只能使用已登记的固定来源，请先保存新增来源再进行裁决。')
  // 更新只追加显式来源，不能以整条覆盖悄悄删除已记录的正文出处。
  return { ...parseCreateKnowledgeItem(input), id: requiredId(id).toLowerCase(),
    ...(adjudication === undefined ? {} : { adjudication: parseKnowledgeAdjudication(adjudication) }) }
}

export function parseKnowledgeAdjudication(value: unknown): KnowledgeAdjudicationInput {
  const data = record(value, ['id', 'expectedBookRevision', 'expectedItemRevisionId', 'sourceAId', 'sourceBId', 'resolution', 'note'], '知识裁决')
  const sourceAId = requiredId(data.sourceAId).toLowerCase(), sourceBId = requiredId(data.sourceBId).toLowerCase()
  if (sourceAId === sourceBId) return invalid('证据 A 与 B 必须是两条不同的已登记来源。')
  const resolution = choice(data.resolution, KNOWLEDGE_RESOLUTIONS, '裁决决定')
  const note = optionalText(data.note, '裁决说明', 2000)
  if (note.includes('\0') || (resolution === 'intentional' && !note.trim())) return invalid('有意安排须填写说明，裁决说明不能包含空字符。')
  return { id: requiredId(data.id).toLowerCase(), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedItemRevisionId: requiredId(data.expectedItemRevisionId).toLowerCase(), sourceAId, sourceBId, resolution, note }
}

/** 明确保留一侧时只替换说明并记录采纳；知识性质、档案和两侧原出处始终保留。 */
export function knowledgeAdjudicationFields(previous: KnowledgeItemFields, a: Pick<KnowledgeSource, 'quote'>,
  b: Pick<KnowledgeSource, 'quote'>, resolution: KnowledgeResolution): KnowledgeItemFields {
  const { kind, name, aliases, summary, nature, authorDecision, freshness, characterProfile } = previous
  return parseKnowledgeFields({ kind, name, aliases, summary, nature, authorDecision, freshness, conflictState: 'explained',
    ...(characterProfile === undefined ? {} : { characterProfile }),
    ...(resolution === 'intentional' ? {} : { summary: resolution === 'keep_a' ? a.quote : b.quote, authorDecision: 'adopted' }) })
}

/** 成功信封也必须对应同一裁决、两侧来源及固定修订，才能推进界面版本。 */
export function isKnowledgeAdjudicationReceiptFor(input: UpdateKnowledgeItemInput, value: KnowledgeItemDetail): boolean {
  try {
    const expected = input.adjudication
    if (!expected || !value || value.bookId !== input.bookId || value.id !== input.id ||
        value.bookRevision !== expected.expectedBookRevision + 1 || value.knowledgeRevision !== input.expectedKnowledgeRevision + 1) return false
    const saved = value.adjudications?.find((entry) => entry.id === expected.id), revision = value.revisions[0], previous = value.revisions[1]
    const a = value.sources.find((entry) => entry.id === expected.sourceAId), b = value.sources.find((entry) => entry.id === expected.sourceBId)
    if (!saved || !revision || !previous || !a || !b || saved.itemId !== input.id || a.itemId !== input.id || b.itemId !== input.id ||
        a.bookId !== input.bookId || b.bookId !== input.bookId || a.validity !== 'valid' || b.validity !== 'valid' ||
        saved.sourceAId !== expected.sourceAId || saved.sourceBId !== expected.sourceBId ||
        saved.previousRevisionId !== expected.expectedItemRevisionId || saved.revisionId !== revision.id ||
        saved.resolution !== expected.resolution || saved.note !== expected.note || saved.bookRevision !== value.bookRevision ||
        saved.knowledgeRevision !== value.knowledgeRevision || revision.itemId !== input.id || revision.reason !== 'updated' ||
        revision.knowledgeRevision !== value.knowledgeRevision || previous.id !== expected.expectedItemRevisionId || previous.itemId !== input.id ||
        !Number.isSafeInteger(previous.knowledgeRevision) || previous.knowledgeRevision < 1 || previous.knowledgeRevision > input.expectedKnowledgeRevision ||
        saved.createdAt !== revision.createdAt || saved.createdAt !== value.updatedAt) return false
    requiredId(revision.id)
    const { kind, name, aliases, summary, nature, authorDecision, freshness, conflictState, characterProfile } = value
    const fields = parseKnowledgeFields({ kind, name, aliases, summary, nature, authorDecision, freshness, conflictState,
      ...(characterProfile === undefined ? {} : { characterProfile }) })
    return JSON.stringify(fields) === JSON.stringify(parseKnowledgeFields(input.fields)) &&
      JSON.stringify(fields) === JSON.stringify(parseKnowledgeFields(revision.fields)) &&
      JSON.stringify(fields) === JSON.stringify(knowledgeAdjudicationFields(parseKnowledgeFields(previous.fields), a, b, expected.resolution))
  } catch { return false }
}

export function parseListKnowledgeItems(value: unknown): ListKnowledgeItemsInput {
  const data = record(value, ['bookId', 'kind', 'nature', 'search', 'limit', 'offset', 'reviewOnly', 'includeOverview'], '知识列表请求')
  const limit = data.limit === undefined ? 50 : requiredInteger(data.limit, '每页数量', 100)
  if (limit === 0) return invalid('每页数量必须在 1 到 100 之间。')
  if (['reviewOnly', 'includeOverview'].some((key) => data[key] !== undefined && typeof data[key] !== 'boolean')) return invalid('知识列表筛选开关必须为布尔值。')
  return { bookId: requiredId(data.bookId).toLowerCase(), limit,
    offset: data.offset === undefined ? 0 : requiredInteger(data.offset, '列表位置', MAX_KNOWLEDGE_ITEMS),
    ...(data.kind === undefined ? {} : { kind: choice(data.kind, KNOWLEDGE_KINDS, '知识类型') }),
    ...(data.nature === undefined ? {} : { nature: choice(data.nature, KNOWLEDGE_NATURES, '知识性质') }),
    ...(data.reviewOnly === undefined ? {} : { reviewOnly: data.reviewOnly as boolean }),
    ...(data.includeOverview === undefined ? {} : { includeOverview: data.includeOverview as boolean }),
    ...(data.search === undefined ? {} : { search: optionalText(data.search, '搜索内容', 200) }) }
}
