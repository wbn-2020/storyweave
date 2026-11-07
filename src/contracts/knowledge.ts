import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, type BookInput } from './api'

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

export interface KnowledgeItemDetail extends KnowledgeItemSummary {
  bookRevision: number
  knowledgeRevision: number
  sources: KnowledgeSource[]
  /** 最近的修改记录；完整历史保留在知识库内。 */
  revisions: KnowledgeRevision[]
}

export interface KnowledgeItemInput { bookId: string; id: string }
export interface CreateKnowledgeItemInput {
  bookId: string
  expectedKnowledgeRevision: number
  fields: KnowledgeItemFields
  source?: KnowledgeSourceInput
}
export interface UpdateKnowledgeItemInput extends CreateKnowledgeItemInput { id: string }
export interface ListKnowledgeItemsInput {
  bookId: string
  kind?: KnowledgeKind
  nature?: KnowledgeNature
  search?: string
  limit?: number
  offset?: number
}
export interface KnowledgeItemPage {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  items: KnowledgeItemSummary[]
  total: number
  nextOffset: number | null
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
  const data = record(value, ['kind', 'name', 'aliases', 'summary', 'nature', 'authorDecision', 'freshness', 'conflictState'], '知识条目')
  if (!Array.isArray(data.aliases) || data.aliases.length > 50) return invalid('别名最多 50 个。')
  const aliases = Array.from(data.aliases, (alias: unknown) => requiredText(alias, '别名', 120))
  if (new Set(aliases).size !== aliases.length) return invalid('别名不能重复。')
  return {
    kind: choice(data.kind, KNOWLEDGE_KINDS, '知识类型'), name: requiredText(data.name, '条目名称', 120), aliases,
    summary: optionalText(data.summary, '条目说明', 20_000), nature: choice(data.nature, KNOWLEDGE_NATURES, '知识性质'),
    authorDecision: choice(data.authorDecision, AUTHOR_DECISIONS, '作者决定'),
    freshness: choice(data.freshness, KNOWLEDGE_FRESHNESS, '新鲜度'), conflictState: choice(data.conflictState, CONFLICT_STATES, '冲突状态'),
  }
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
  const data = record(value, ['bookId', 'id'], '知识条目请求')
  return { bookId: requiredId(data.bookId).toLowerCase(), id: requiredId(data.id).toLowerCase() }
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
  const data = record(value, ['bookId', 'id', 'expectedKnowledgeRevision', 'fields', 'source'], '更新知识条目请求')
  const { id, ...input } = data
  // 更新只追加显式来源，不能以整条覆盖悄悄删除已记录的正文出处。
  return { ...parseCreateKnowledgeItem(input), id: requiredId(id).toLowerCase() }
}

export function parseListKnowledgeItems(value: unknown): ListKnowledgeItemsInput {
  const data = record(value, ['bookId', 'kind', 'nature', 'search', 'limit', 'offset'], '知识列表请求')
  const limit = data.limit === undefined ? 50 : requiredInteger(data.limit, '每页数量', 100)
  if (limit === 0) return invalid('每页数量必须在 1 到 100 之间。')
  return { bookId: requiredId(data.bookId).toLowerCase(), limit,
    offset: data.offset === undefined ? 0 : requiredInteger(data.offset, '列表位置', MAX_KNOWLEDGE_ITEMS),
    ...(data.kind === undefined ? {} : { kind: choice(data.kind, KNOWLEDGE_KINDS, '知识类型') }),
    ...(data.nature === undefined ? {} : { nature: choice(data.nature, KNOWLEDGE_NATURES, '知识性质') }),
    ...(data.search === undefined ? {} : { search: optionalText(data.search, '搜索内容', 200) }) }
}
