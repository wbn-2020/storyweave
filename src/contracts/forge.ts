import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, type BookInput, type BookMutationInput, type BookSnapshot, type Result } from './api'
import type { AiRun, AiRunState } from './ai'
import { CHARACTER_PROFILE_FIELDS, parseCharacterProfile, type CharacterProfile, type CharacterProfileField } from './character-profile'
import { parseStoryTime, type CognitionAttitude, type RelationFields, type StoryTime } from './story'
import type { KnowledgeItemFields, KnowledgeKind } from './knowledge'
import type { MemoryCitation } from './living'

export const FORGE_SCHEMA_VERSION = 17
export const FORGE_INSTRUCTION_LIMIT = 48_000
export const FORGE_KINDS = ['names', 'cast', 'fill', 'extract', 'world', 'relations', 'audition'] as const
export type ForgeKind = typeof FORGE_KINDS[number]
export const FORGE_LABELS: Record<ForgeKind, string> = { names: '角色起名', cast: '生成角色班底', fill: '补全空白档案', extract: '从正文提炼人物', world: '世界锻造', relations: '从正文推断关系', audition: '角色试戏' }
export const forgeUsesChapter = (kind: ForgeKind) => kind === 'extract' || kind === 'relations'
export interface ForgeEntity { id: string; revisionId: string; fields: KnowledgeItemFields }
export interface ForgeCognition {
  id: string; revisionId: string; title: string; description: string; attitude: CognitionAttitude; concealed: boolean
  formedAt: StoryTime; effectiveUntil: StoryTime; acquisitionEventId: string | null; usable: boolean
}
export interface ForgeStateChange {
  id: string; recordId: string; revisionId: string; attribute: string; before: string; after: string; storyTime: StoryTime; usable: boolean
}
export interface ForgeRelation { id: string; revisionId: string; fields: RelationFields; active: 'active' | 'inactive' | 'unknown' }
export interface ForgePerson {
  entity: ForgeEntity; profiles: { revisionId: string; createdAt: string; fields: KnowledgeItemFields }[]; profileTotal: number
  cognitions: ForgeCognition[]; states: ForgeStateChange[]; relations: ForgeRelation[]
}
export interface ForgeSnapshot {
  bookId: string; bookRevision: number; knowledgeRevision: number; schemaVersion: number; requiresUpgrade: boolean
  entities: { id: string; name: string; kind: KnowledgeKind }[]; entityTotal: number; person: ForgePerson | null
  runs: { id: string; kind: ForgeKind; state: AiRunState; createdAt: string }[]
}
export interface ForgeReadInput extends BookInput { personId: string | null; storyOrder: number | null }
export interface ForgePrepareInput extends BookMutationInput {
  chapterId: string; connectionId: string; kind: ForgeKind; instruction: string; count: number
  personId: string | null; profileRevisionId: string | null; storyOrder: number | null
  referenceRunId: string | null
  traitFields: CharacterProfileField[]; entityIds: string[]; cognitionIds: string[]; stateIds: string[]; excludedNames: string[]
}
export interface ForgeCard { key: string; kind: KnowledgeKind; name: string; summary: string; profile?: CharacterProfile; citations: MemoryCitation[] }
export interface ForgeRelationProposal {
  key: string; fromEntityId: string; toEntityId: string; relationType: string; direction: 'directed' | 'mutual'; layer: 'surface' | 'hidden'
  description: string; nature: 'narrative_claim' | 'character_belief' | 'ai_inference'; citations: MemoryCitation[]
  validFrom: StoryTime; validUntil: StoryTime
}
export type ForgeProposal = { kind: 'names'; names: { name: string; meaning: string }[] }
  | { kind: 'cast' | 'world' | 'fill' | 'extract'; cards: ForgeCard[] }
  | { kind: 'relations'; relations: ForgeRelationProposal[] }
export interface ForgeRunInput extends BookInput { runId: string }
export interface ForgeRunDetail { bookId: string; request: ForgePrepareInput; run: AiRun; proposal: ForgeProposal | null; parseError: string | null; adopted: boolean }
export interface ForgeAdoptInput extends BookMutationInput { runId: string; expectedRunVersion: number; proposal: ForgeProposal }
export interface ForgeRef { key: string; kind: 'knowledge' | 'relation'; id: string; revisionId: string }
export interface ForgeAdoptReceipt { bookId: string; runId: string; refs: ForgeRef[]; book: BookSnapshot }
export interface ForgeApi {
  getForge(input: ForgeReadInput): Promise<Result<ForgeSnapshot>>
  prepareForge(input: ForgePrepareInput): Promise<Result<ForgeRunDetail>>
  getForgeRun(input: ForgeRunInput): Promise<Result<ForgeRunDetail>>
  adoptForge(input: ForgeAdoptInput): Promise<Result<ForgeAdoptReceipt>>
}
function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('角色与世界工坊的数据格式无效。')
  return value
}
const id = (value: unknown) => requiredId(value).toLowerCase()
const nullableId = (value: unknown) => value === null ? null : id(value)
function list<T>(value: unknown, maximum: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`本次最多允许 ${maximum} 项。`)
  return value.map(parse)
}
function ids(value: unknown, maximum: number): string[] { const values = list(value, maximum, id); if (new Set(values).size !== values.length) invalid('选择的来源不能重复。'); return values }
function text(value: unknown, label: string, maximum: number, optional = false): string {
  const result = optional ? optionalText(value, label, maximum) : requiredText(value, label, maximum)
  if (result.includes('\0')) invalid(`${label}不能含空字符。`)
  return result
}
function order(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000) invalid('故事时点须为绝对值不超过十亿的整数，不能从章节号推断。')
  return value
}
export function parseForgeReadInput(value: unknown): ForgeReadInput {
  const v = object(value, ['bookId', 'personId', 'storyOrder'])
  return { bookId: id(v.bookId), personId: nullableId(v.personId), storyOrder: order(v.storyOrder) }
}
export function parseForgePrepareInput(value: unknown): ForgePrepareInput {
  const v = object(value, ['bookId', 'expectedBookRevision', 'chapterId', 'connectionId', 'kind', 'instruction', 'count', 'personId', 'profileRevisionId', 'storyOrder', 'referenceRunId', 'traitFields', 'entityIds', 'cognitionIds', 'stateIds', 'excludedNames'])
  if (!FORGE_KINDS.includes(v.kind as ForgeKind)) invalid('请选择角色、世界、关系或试戏任务。')
  const kind = v.kind as ForgeKind, personId = nullableId(v.personId), profileRevisionId = nullableId(v.profileRevisionId), storyOrder = order(v.storyOrder)
  const referenceRunId = nullableId(v.referenceRunId)
  if (referenceRunId && kind !== 'world') invalid('只有世界锻造可以接续一轮已有提案。')
  const traitFields = list(v.traitFields, 8, (item) => { if (!CHARACTER_PROFILE_FIELDS.includes(item as CharacterProfileField)) invalid('人物档案字段无效。'); return item as CharacterProfileField })
  const cognitionIds = ids(v.cognitionIds, 12), stateIds = ids(v.stateIds, 12), entityIds = ids(v.entityIds, 20)
  if (new Set(traitFields).size !== traitFields.length) invalid('档案字段不能重复。')
  if (['fill', 'extract', 'audition'].includes(kind) && !personId) invalid('请明确选择本书人物。')
  if (kind === 'audition' ? storyOrder === null || (traitFields.length > 0 && profileRevisionId === null)
    : profileRevisionId !== null || storyOrder !== null || traitFields.length > 0 || cognitionIds.length > 0 || stateIds.length > 0) invalid('试戏须明确故事时点、档案版本及选择的认知和状态；其他任务不携带试戏资料。')
  if (kind === 'audition' && entityIds.length) invalid('试戏不展开其他人物的全知档案。')
  if (!['fill', 'extract', 'audition'].includes(kind) && personId !== null) invalid('当前任务不需要人物目标。')
  if (kind === 'relations' && entityIds.length < 2) invalid('正文关系推断需要明确选择至少两个实体。')
  const count = requiredInteger(v.count, '候选数量', 4)
  if (!count) invalid('候选数量须为一至四。')
  const excludedNames = list(v.excludedNames, 100, (name) => text(name, '避用名称', 120))
  if (new Set(excludedNames).size !== excludedNames.length) invalid('避用名称不能重复。')
  return { bookId: id(v.bookId), expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本'), chapterId: id(v.chapterId), connectionId: id(v.connectionId), kind,
    instruction: text(v.instruction, '本次要求', 2000), count, personId, profileRevisionId, storyOrder, referenceRunId, traitFields, entityIds, cognitionIds, stateIds, excludedNames }
}
export function parseForgeRunInput(value: unknown): ForgeRunInput { const v = object(value, ['bookId', 'runId']); return { bookId: id(v.bookId), runId: id(v.runId) } }
export function forgeInstructionKind(instruction: string): ForgeKind {
  let value: unknown
  try { value = JSON.parse(instruction) } catch { return invalid('工坊预览缺少固定来源。') }
  if (!isRecord(value) || value.workflow !== 'forge-v1' || !FORGE_KINDS.includes(value.kind as ForgeKind)) invalid('工坊预览格式无效。')
  return value.kind as ForgeKind
}
function citations(value: unknown): MemoryCitation[] {
  return list(value, 8, (item) => { const v = object(item, ['blockId', 'quote']); return { blockId: id(v.blockId), quote: text(v.quote, '原文引文', 2000) } })
}
function key(value: unknown): string { if (typeof value !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(value)) invalid('候选身份无效。'); return value }
export function parseForgeProposal(value: unknown): ForgeProposal {
  if (!isRecord(value)) invalid('模型需返回一个完整 JSON 对象。')
  if (value.kind === 'names') {
    const v = object(value, ['kind', 'names']), names = list(v.names, 12, (item) => { const n = object(item, ['name', 'meaning']); return { name: text(n.name, '名字', 120), meaning: text(n.meaning, '名字意象', 500) } })
    if (!names.length || new Set(names.map((n) => n.name)).size !== names.length) invalid('名字不能为空或重复。')
    return { kind: 'names', names }
  }
  if (value.kind === 'relations') {
    const v = object(value, ['kind', 'relations']), relations = list(v.relations, 10, (item): ForgeRelationProposal => {
      const r = object(item, ['key', 'fromEntityId', 'toEntityId', 'relationType', 'direction', 'layer', 'description', 'nature', 'citations', 'validFrom', 'validUntil'])
      if (!['directed', 'mutual'].includes(String(r.direction)) || !['surface', 'hidden'].includes(String(r.layer)) || !['narrative_claim', 'character_belief', 'ai_inference'].includes(String(r.nature))) invalid('关系方向、层次或知识性质无效。')
      const fromEntityId = id(r.fromEntityId), toEntityId = id(r.toEntityId)
      if (fromEntityId === toEntityId) invalid('关系端点不能相同。')
      const validFrom = parseStoryTime(r.validFrom), validUntil = parseStoryTime(r.validUntil)
      if (validFrom.kind !== 'unknown' && validUntil.kind !== 'unknown' && validFrom.order !== null && validUntil.order !== null && validFrom.order > validUntil.order) invalid('关系有效期范围无效。')
      return { key: key(r.key), fromEntityId, toEntityId, relationType: text(r.relationType, '关系类型', 120), direction: r.direction as 'directed' | 'mutual', layer: r.layer as 'surface' | 'hidden',
        description: text(r.description, '关系说明', 4000), nature: r.nature as ForgeRelationProposal['nature'], citations: citations(r.citations), validFrom, validUntil }
    })
    if (new Set(relations.map((r) => r.key)).size !== relations.length) invalid('关系候选身份不能重复。')
    return { kind: 'relations', relations }
  }
  const v = object(value, ['kind', 'cards'])
  if (!['cast', 'world', 'fill', 'extract'].includes(String(v.kind))) invalid('不支持这类工坊提案。')
  const cards = list(v.cards, v.kind === 'world' ? 6 : 4, (item): ForgeCard => {
    const c = object(item, ['key', 'kind', 'name', 'summary', 'profile', 'citations'])
    if (!['person', 'place', 'organization', 'object', 'rule', 'theme', 'other'].includes(String(c.kind))) invalid('卡片类型无效。')
    const profile = c.profile === undefined ? undefined : parseCharacterProfile(c.profile)
    if (profile && c.kind !== 'person') invalid('只有人物卡可包含人物档案。')
    return { key: key(c.key), kind: c.kind as KnowledgeKind, name: text(c.name, '卡片名称', 120), summary: text(c.summary, '卡片说明', 8000, true),
      ...(profile ? { profile } : {}), citations: citations(c.citations) }
  })
  if (new Set(cards.map((c) => c.key)).size !== cards.length) invalid('候选身份不能重复。')
  return { kind: v.kind as 'cast' | 'world' | 'fill' | 'extract', cards }
}
export function parseForgeAdoptInput(value: unknown): ForgeAdoptInput {
  const v = object(value, ['bookId', 'expectedBookRevision', 'runId', 'expectedRunVersion', 'proposal']), proposal = parseForgeProposal(v.proposal)
  if (proposal.kind === 'names' || (proposal.kind === 'relations' ? !proposal.relations.length : !proposal.cards.length)) invalid('请选择至少一项可采用的卡片或关系。')
  if (JSON.stringify(proposal).length > 60000) invalid('采用内容超过六万字符，请缩小范围。')
  return { bookId: id(v.bookId), expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本'), runId: id(v.runId), expectedRunVersion: requiredInteger(v.expectedRunVersion, '候选版本'), proposal }
}
