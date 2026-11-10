import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, type BookInput, type BookMutationInput, type BookSnapshot, type Result } from './api'
import type { AiRun, AiRunState } from './ai'
import { parseBeatCardSource, type BeatCardSource } from './study-card'

export const LIVING_SCHEMA_VERSION = 16
export const LIVING_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const LIVING_INSTRUCTION_LIMIT = 48_000
export type OutlineScope = 'book' | 'volume' | 'chapter'
export type LivingKind = 'memory' | 'expand' | 'rebase'
export type CreativeHealth = 'empty' | 'pending_proposal' | 'stale' | 'in_progress' | 'ready'
export interface LivingBeat { title: string; action: string; outcome: string }
export interface OutlineFields { title: string; summary: string; goal: string; conflict: string; hook: string; tension: number | null; beats: LivingBeat[]; beatSource?: BeatCardSource }
export interface LivingOutline {
  id: string; scope: OutlineScope; parentId: string | null; position: number; fields: OutlineFields
  revisionId: string | null; version: number; locked: boolean; manual: boolean; stale: boolean; staleReason: string | null
}
export interface OutlineHistoryEntry { id: string; version: number; fields: OutlineFields; locked: boolean; origin: 'manual' | 'ai' | 'restored'; createdAt: string }
export interface MemoryCitation { blockId: string; quote: string }
export interface MemoryNote { text: string; citations: MemoryCitation[] }
export type MemoryNature = 'narrative_claim' | 'character_belief' | 'ai_inference'
export interface MemoryEvent extends MemoryNote { title: string; nature: MemoryNature }
export interface MemoryState extends MemoryNote { entityId: string; attribute: string; nature: MemoryNature }
export interface MemoryProposal { kind: 'memory'; summary: MemoryNote; events: MemoryEvent[]; states: MemoryState[] }
export interface OutlineProposal { kind: 'expand' | 'rebase'; chapters: { chapterId: string | null; fields: OutlineFields }[] }
export type LivingProposal = MemoryProposal | OutlineProposal
export interface PublishedMemory {
  id: string; chapterId: string; chapterTitle: string; revisionId: string; runId: string
  state: 'published' | 'stale' | 'superseded'; staleReason: string | null; proposal: MemoryProposal; createdAt: string
}
export interface LivingWritingContext { version: 1; outlines: LivingOutline[]; memories: PublishedMemory[] }
export interface LivingSnapshot {
  bookId: string; bookRevision: number; knowledgeRevision: number; schemaVersion: number; requiresUpgrade: boolean
  outlines: LivingOutline[]; memories: PublishedMemory[]; memoryTotal: number
  entities: { id: string; name: string; kind: string }[]; entityTotal: number
  runs: { id: string; kind: LivingKind; state: AiRunState; createdAt: string }[]
  health: Record<'idea' | 'world' | 'cast' | 'outline' | 'manuscript', CreativeHealth>
}
export interface MemoryArchiveInput extends BookInput { chapterId?: string; beforeId?: string }
export interface MemoryArchivePage { bookId: string; bookRevision: number; items: PublishedMemory[]; total: number; nextBeforeId: string | null }
export interface SaveOutlineInput extends BookMutationInput { id: string; expectedVersion: number; fields: OutlineFields; locked: boolean }
export interface OutlineHistoryInput extends BookInput { id: string; beforeVersion?: number }
export interface OutlineHistoryPage { bookId: string; id: string; items: OutlineHistoryEntry[]; nextBeforeVersion: number | null }
export interface RestoreOutlineInput extends BookMutationInput { id: string; expectedVersion: number; revisionId: string }
export interface LivingPrepareInput extends BookMutationInput {
  chapterId: string; connectionId: string; kind: LivingKind; instruction: string
  targetIds: string[]; confirmManualIds: string[]; entityIds: string[]; count: number
}
export interface LivingRunInput extends BookInput { runId: string }
export interface LivingRunDetail { bookId: string; kind: LivingKind; request: LivingPrepareInput; targets: LivingOutline[]; run: AiRun; proposal: LivingProposal | null; parseError: string | null; adopted: boolean }
export interface LivingAdoptInput extends BookMutationInput { runId: string; expectedRunVersion: number; proposal: LivingProposal }
export interface LivingAdoptReceipt { bookId: string; runId: string; refs: string[]; snapshot: LivingSnapshot; book: BookSnapshot }
export interface LivingApi {
  getLiving(input: BookInput): Promise<Result<LivingSnapshot>>
  listMemoryArchive(input: MemoryArchiveInput): Promise<Result<MemoryArchivePage>>
  saveOutline(input: SaveOutlineInput): Promise<Result<LivingSnapshot>>
  listOutlineHistory(input: OutlineHistoryInput): Promise<Result<OutlineHistoryPage>>
  restoreOutline(input: RestoreOutlineInput): Promise<Result<LivingSnapshot>>
  prepareLiving(input: LivingPrepareInput): Promise<Result<LivingRunDetail>>
  getLivingRun(input: LivingRunInput): Promise<Result<LivingRunDetail>>
  adoptLiving(input: LivingAdoptInput): Promise<Result<LivingAdoptReceipt>>
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('演进大纲或记忆数据格式无效，或含不支持的字段。')
  return value
}
function id(value: unknown): string { return requiredId(value).toLowerCase() }
function text(value: unknown, label: string, maximum: number, required = false): string {
  const result = required ? requiredText(value, label, maximum) : optionalText(value, label, maximum)
  if (result.includes('\0')) invalid(`${label}含无效字符。`)
  return result
}
function list<T>(value: unknown, maximum: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`列表最多允许 ${maximum} 项。`)
  return value.map(parse)
}
function ids(value: unknown, maximum: number): string[] {
  const values = list(value, maximum, id)
  if (new Set(values).size !== values.length) invalid('所选条目不能重复。')
  return values
}
function mutation(v: Record<string, unknown>): BookMutationInput { return { bookId: id(v.bookId), expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本') } }
export function parseOutlineFields(value: unknown): OutlineFields {
  const v = object(value, ['title', 'summary', 'goal', 'conflict', 'hook', 'tension', 'beats', 'beatSource'])
  // 章纲直接承接章节资料，须兼容已有 10,000 字符目标，不能让合法旧数据阻断整书大纲读取。
  return { title: text(v.title, '大纲标题', 120, true), summary: text(v.summary, '大纲内容', 16000), goal: text(v.goal, '目标', 10000),
    conflict: text(v.conflict, '冲突', 2000), hook: text(v.hook, '收束或章末悬念', 2000),
    tension: v.tension === null ? null : requiredInteger(v.tension, '紧张度', 100),
    beats: list(v.beats, 6, (item) => { const b = object(item, ['title', 'action', 'outcome']); return {
      title: text(b.title, '节拍标题', 120, true), action: text(b.action, '节拍动作', 2000), outcome: text(b.outcome, '节拍变化', 2000) } }),
    ...(v.beatSource === undefined ? {} : { beatSource: parseBeatCardSource(v.beatSource) }) }
}
export function parseMemoryArchiveInput(value: unknown): MemoryArchiveInput {
  const v = object(value, ['bookId', 'chapterId', 'beforeId'])
  return { bookId: id(v.bookId), ...(v.chapterId === undefined ? {} : { chapterId: id(v.chapterId) }), ...(v.beforeId === undefined ? {} : { beforeId: id(v.beforeId) }) }
}
function note(value: unknown, extra: readonly string[] = []): MemoryNote {
  const v = object(value, ['text', 'citations', ...extra])
  const citations = list(v.citations, 8, (item) => { const c = object(item, ['blockId', 'quote']); return { blockId: id(c.blockId), quote: text(c.quote, '原文引文', 2000, true) } })
  if (!citations.length || new Set(citations.map((c) => `${c.blockId}:${c.quote}`)).size !== citations.length) invalid('每项记忆需要 1 至 8 处不重复的原文引文。')
  return { text: text(v.text, '记忆内容', 8000, true), citations }
}
function nature(value: unknown): MemoryNature {
  if (value !== 'narrative_claim' && value !== 'character_belief' && value !== 'ai_inference') invalid('请区分正文陈述、人物信念与模型推断。')
  return value
}
export function parseLivingProposal(value: unknown): LivingProposal {
  if (!isRecord(value)) invalid('模型需返回一个 JSON 对象。')
  if (value.kind === 'memory') {
    const v = object(value, ['kind', 'summary', 'events', 'states'])
    return { kind: 'memory', summary: note(v.summary), events: list(v.events, 20, (item) => {
      const e = object(item, ['title', 'text', 'nature', 'citations']); return { ...note(e, ['title', 'nature']), title: text(e.title, '事件标题', 120, true), nature: nature(e.nature) }
    }), states: list(v.states, 30, (item) => { const s = object(item, ['entityId', 'attribute', 'text', 'nature', 'citations']); return {
      ...note(s, ['entityId', 'attribute', 'nature']), entityId: id(s.entityId), attribute: text(s.attribute, '人物状态属性', 120, true), nature: nature(s.nature) } }) }
  }
  const v = object(value, ['kind', 'chapters'])
  if (v.kind !== 'expand' && v.kind !== 'rebase') invalid('不支持这个提案类型。')
  const chapters = list(v.chapters, v.kind === 'expand' ? 3 : 10, (item) => { const c = object(item, ['chapterId', 'fields']); return {
    chapterId: c.chapterId === null ? null : id(c.chapterId), fields: parseOutlineFields(c.fields) } })
  if (!chapters.length || (v.kind === 'expand' ? chapters.some((c) => c.chapterId !== null)
    : chapters.some((c) => c.chapterId === null) || new Set(chapters.map((c) => c.chapterId)).size !== chapters.length)) invalid('补纲须新增章节，修纲须明确且不重复地引用已有章节。')
  return { kind: v.kind, chapters }
}
export function parseSaveOutlineInput(value: unknown): SaveOutlineInput {
  const v = object(value, ['bookId', 'expectedBookRevision', 'id', 'expectedVersion', 'fields', 'locked'])
  if (typeof v.locked !== 'boolean') invalid('大纲锁定标记无效。')
  return { ...mutation(v), id: id(v.id), expectedVersion: requiredInteger(v.expectedVersion, '大纲版本'), fields: parseOutlineFields(v.fields), locked: v.locked }
}
export function parseOutlineHistoryInput(value: unknown): OutlineHistoryInput {
  const v = object(value, ['bookId', 'id', 'beforeVersion'])
  return { bookId: id(v.bookId), id: id(v.id), ...(v.beforeVersion === undefined ? {} : { beforeVersion: requiredInteger(v.beforeVersion, '历史分页版本') }) }
}
export function parseRestoreOutlineInput(value: unknown): RestoreOutlineInput {
  const v = object(value, ['bookId', 'expectedBookRevision', 'id', 'expectedVersion', 'revisionId'])
  return { ...mutation(v), id: id(v.id), expectedVersion: requiredInteger(v.expectedVersion, '大纲版本'), revisionId: id(v.revisionId) }
}
export function parseLivingPrepareInput(value: unknown): LivingPrepareInput {
  const v = object(value, ['bookId', 'expectedBookRevision', 'chapterId', 'connectionId', 'kind', 'instruction', 'targetIds', 'confirmManualIds', 'entityIds', 'count'])
  if (v.kind !== 'memory' && v.kind !== 'expand' && v.kind !== 'rebase') invalid('请选择定稿整理、滚动补纲或修纲。')
  const count = requiredInteger(v.count, '补纲章节数', 3)
  if (!count) invalid('补纲章节数须为 1 至 3。')
  const targetIds = ids(v.targetIds, 10), confirmManualIds = ids(v.confirmManualIds, 10)
  if (confirmManualIds.some((value) => !targetIds.includes(value)) || (v.kind !== 'rebase' && (targetIds.length || confirmManualIds.length)) || (v.kind === 'rebase' && !targetIds.length)) invalid('请明确修纲范围及允许替换的作者手改章纲。')
  return { ...mutation(v), chapterId: id(v.chapterId), connectionId: id(v.connectionId), kind: v.kind, instruction: text(v.instruction, '本次要求', 2000, true),
    targetIds, confirmManualIds, entityIds: ids(v.entityIds, 30), count }
}
export function parseLivingRunInput(value: unknown): LivingRunInput { const v = object(value, ['bookId', 'runId']); return { bookId: id(v.bookId), runId: id(v.runId) } }
export function parseLivingAdoptInput(value: unknown): LivingAdoptInput {
  const v = object(value, ['bookId', 'expectedBookRevision', 'runId', 'expectedRunVersion', 'proposal'])
  const proposal = parseLivingProposal(v.proposal)
  if (JSON.stringify(proposal).length > 60000) invalid('采用内容与引文合计超过 60,000 字符，请缩短内容。')
  return { ...mutation(v), runId: id(v.runId), expectedRunVersion: requiredInteger(v.expectedRunVersion, '候选版本'), proposal }
}

export function parseLivingWritingContext(value: unknown): LivingWritingContext {
  const v = object(value, ['version', 'outlines', 'memories'])
  if (v.version !== 1) invalid('创作上下文版本无效。')
  const outlines = list(v.outlines, 3, (item) => {
    const n = object(item, ['id', 'scope', 'parentId', 'position', 'fields', 'revisionId', 'version', 'locked', 'manual', 'stale', 'staleReason'])
    if (!['book', 'volume', 'chapter'].includes(String(n.scope)) || typeof n.locked !== 'boolean' || typeof n.manual !== 'boolean' || n.stale !== false || n.staleReason !== null) invalid('上下文只允许依赖完整、已复核的有效章纲。')
    return { id: id(n.id), scope: n.scope as OutlineScope, parentId: n.parentId === null ? null : id(n.parentId), position: requiredInteger(n.position, '位置'),
      fields: parseOutlineFields(n.fields), revisionId: n.revisionId === null ? null : id(n.revisionId), version: requiredInteger(n.version, '大纲版本'),
      locked: n.locked, manual: n.manual, stale: false, staleReason: null } satisfies LivingOutline
  })
  const memories = list(v.memories, 3, (item) => {
    const m = object(item, ['id', 'chapterId', 'chapterTitle', 'revisionId', 'runId', 'state', 'staleReason', 'proposal', 'createdAt'])
    const proposal = parseLivingProposal(m.proposal)
    if (m.state !== 'published' || m.staleReason !== null || proposal.kind !== 'memory' || typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt))) invalid('上下文只允许当前有效的已发布记忆。')
    return { id: id(m.id), chapterId: id(m.chapterId), chapterTitle: text(m.chapterTitle, '章节标题', 120, true), revisionId: id(m.revisionId), runId: id(m.runId),
      state: 'published', staleReason: null, proposal, createdAt: m.createdAt } satisfies PublishedMemory
  })
  if (new Set(outlines.map((n) => n.id)).size !== outlines.length || new Set(memories.map((m) => m.id)).size !== memories.length) invalid('创作上下文来源不能重复。')
  return { version: 1, outlines, memories }
}
