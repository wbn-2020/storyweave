import { DomainError, isRecord, requiredId, requiredInteger, requiredText, optionalText, type ChapterSnapshot } from './api'
import type { MemoryEvidence } from './memory'
import { KNOWLEDGE_KINDS, parseKnowledgeFields, resolveKnowledgeFields, type KnowledgeItemFields, type KnowledgeKind, type KnowledgeStatus } from './knowledge'
import type { AiSummaryContext } from './ai-summary'
import { parseAiContextSummaryRefs, type AiContextSummaryRef, type AiContextSummarySnapshot } from './ai-context-summary'
import { parseAiCharacterScope, type AiCharacterScope, type AiCharacterContext } from './ai-character-context'
import { parseCreativeRefs, parseCreativeApplication, type CreativeResourceRef, type CreativeResources } from './creative-resources'
import { LIVING_INSTRUCTION_LIMIT, type LivingWritingContext } from './living'
import { FORGE_INSTRUCTION_LIMIT } from './forge'

export const AI_PROMPT_VERSION = 1
export const AI_MEMORY_PROMPT_VERSION = 2
export const AI_READER_CONTEXT_PROMPT_VERSION = 5
export const AI_OUTPUT_LIMIT = 60_000
export const AI_CONTEXT_LIMIT = 80_000
export type AiTaskKind = 'plan' | 'continue' | 'rewrite' | 'summarize' | 'extract'
export type AiContextPerspective = 'author' | 'reader' | 'character'
export function isAiMemoryTask(kind: AiTaskKind): kind is 'summarize' | 'extract' { return kind === 'summarize' || kind === 'extract' }
export type AiRunState = 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'rejected' | 'adopted'
export interface AiBookInput { bookId: string }
export interface AiConnectionConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  contextWindow: number
  maxOutputTokens: number
}
export interface AiConnection extends AiConnectionConfig { version: number; updatedAt: string }
export interface AiConnectionSaveInput extends AiBookInput { connection: AiConnectionConfig; expectedVersion: number | null }
export interface AiConfigureInput extends AiConnectionSaveInput { apiKey?: string }
export interface AiConnectionPage { bookId: string; requiresUpgrade: boolean; connections: AiConnection[]; sessionKeyIds: string[] }
export interface AiPrepareInput extends AiBookInput {
  chapterId: string
  expectedBookRevision: number
  expectedKnowledgeRevision: number
  expectedRevisionId: string
  connectionId: string
  kind: AiTaskKind
  /** 审稿沿用 plan 存储类型，独立固定语义，不能当成规划采用。 */
  purpose?: 'review' | 'study' | 'living' | 'forge'
  instruction: string
  contextScope: 'chapter' | 'nearby'
  /** 缺省沿用作者视角。 */
  perspective?: AiContextPerspective
  characterScope?: AiCharacterScope
  selectedBlockIds: string[]
  memoryChunkIds: number[]
  summaryRefs?: AiContextSummaryRef[]
  resourceRefs?: CreativeResourceRef[]
  resourceApplication?: string
  useLivingContext?: boolean
}
export interface AiPrepareServiceInput extends AiPrepareInput { connection: AiConnection }
export interface AiContextBlock { blockId: string; startOffset: number; endOffset: number; text: string }
export interface AiMessage { role: 'system' | 'user'; content: string }
export interface AiWritingContext {
  version: 1
  settingsRevision: number | null
  genre: string
  synopsis: string
  premise: string
  style: string
  narrator: string
  tense: string
  rules: string
}
export interface AiContextPacket {
  bookId: string
  chapterId: string
  bookRevision: number
  knowledgeRevision: number
  chapterRevisionId: string
  chapterTitle: string
  kind: AiTaskKind
  purpose?: 'review' | 'study' | 'living' | 'forge'
  instruction: string
  contextScope: 'chapter' | 'nearby'
  /** 旧上下文缺省沿用作者视角。 */
  perspective?: AiContextPerspective
  /** 人物身份与本次手选认知的固定快照，不代表完整时点心智。 */
  characterContext?: AiCharacterContext
  creativeResources?: CreativeResources
  selectedBlockIds: string[]
  originalText: string
  chapterBlocks: AiContextBlock[]
  evidence: MemoryEvidence[]
  connection: AiConnection
  promptVersion: number
  messages: AiMessage[]
  estimatedInputTokens: number
  reservedOutputTokens: number
  warnings: string[]
  contextHash: string
  /** 存在时为分层汇总，首来源章仅作存储锚点，不作为单章整理采用。 */
  summary?: AiSummaryContext
  /** 创作时手选的完整已采用摘要；与生成分层汇总的 summary 互斥。 */
  contextSummaries?: AiContextSummarySnapshot[]
  /** 独立版本的作者创作约定快照；旧候选缺省不附加，受限视角不发送。 */
  writingContext?: AiWritingContext
  livingContext?: LivingWritingContext
}
export interface AiUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
export interface AiRunSummary {
  id: string
  bookId: string
  chapterId: string
  chapterTitle: string
  kind: AiTaskKind
  purpose?: 'review' | 'study' | 'living' | 'forge'
  state: AiRunState
  version: number
  connectionName: string
  model: string
  outputCharacters: number
  error: string | null
  createdAt: string
  updatedAt: string
}
export interface AiRun extends AiRunSummary {
  context: AiContextPacket
  outputText: string
  acceptedText: string | null
  adoptedRevisionId: string | null
  usage: AiUsage | null
  finishReason: string | null
  active?: boolean
  memoryAdoptions?: AiMemoryAdoptedEntry[]
}
export interface AiListInput extends AiBookInput { before?: string }
export interface AiRunPage { bookId: string; requiresUpgrade: boolean; runs: AiRunSummary[]; nextBefore: string | null }
export interface AiRunInput extends AiBookInput { runId: string }
export interface AiVersionInput extends AiRunInput { expectedVersion: number }
export interface AiMaintenanceBaseline {
  taskId: string
  expectedTaskVersion: number
  expectedBookRevision: number
  expectedKnowledgeRevision: number
}
export interface AiStartInput extends AiVersionInput { contextHash: string; maintenanceBaseline?: AiMaintenanceBaseline }
export interface AiAdoptInput extends AiVersionInput { acceptedText: string }
export interface AiAdoptReceipt { bookId: string; run: AiRun; chapter: ChapterSnapshot }
export interface AiMemoryCitation { blockId: string; quote: string }
export interface AiMemorySuggestion {
  kind: KnowledgeKind
  name: string
  aliases: string[]
  summary: string
  nature: 'ai_derived' | 'narrative_claim' | 'character_belief' | 'ai_inference'
  citations: AiMemoryCitation[]
}
export interface AiMemoryProposal { items: AiMemorySuggestion[] }
export type AiMemoryReviewAction = 'create' | 'link' | 'revise' | 'ignore'
export interface AiMemoryReviewEntry {
  sourceIndex: number
  fields: KnowledgeItemFields
  /** 旧审计缺省为新建。已有实体操作固定目标身份及作者查看过的修订。 */
  action?: AiMemoryReviewAction
  targetItemId?: string
  expectedTargetRevisionId?: string
}
export interface AiMemoryAdoptedEntry extends AiMemoryReviewEntry {
  itemId: string | null
  citations: AiMemoryCitation[]
  changed?: boolean
  previousFields?: KnowledgeItemFields
  resultingRevisionId?: string
}
export interface AiMemoryAdoptInput extends AiVersionInput { entries: AiMemoryReviewEntry[]; maintenanceBaseline?: AiMaintenanceBaseline }
export interface AiMemoryAdoptReceipt { bookId: string; run: AiRun; status: KnowledgeStatus; itemIds: string[] }

function adoptedRunMatches(input: AiVersionInput, source: AiRun, saved: AiRun): boolean {
  // 父层版本与子面板改稿必须在同一回执核对通过后再推进。
  return source.id === input.runId && source.bookId === input.bookId && source.state === 'succeeded' && source.version === input.expectedVersion &&
    source.context.bookId === source.bookId && source.context.chapterId === source.chapterId && source.context.kind === source.kind &&
    saved.id === source.id && saved.bookId === source.bookId && saved.chapterId === source.chapterId && saved.kind === source.kind &&
    saved.state === 'adopted' && saved.version === source.version + 1 && saved.outputText === source.outputText &&
    saved.context.bookId === source.context.bookId && saved.context.chapterId === source.context.chapterId && saved.context.kind === source.context.kind &&
    saved.context.bookRevision === source.context.bookRevision && saved.context.knowledgeRevision === source.context.knowledgeRevision &&
    saved.context.chapterRevisionId === source.context.chapterRevisionId && saved.context.promptVersion === source.context.promptVersion &&
    saved.context.purpose === source.context.purpose && JSON.stringify(saved.context.writingContext) === JSON.stringify(source.context.writingContext) &&
    JSON.stringify(saved.context.creativeResources) === JSON.stringify(source.context.creativeResources) &&
    JSON.stringify(saved.context.livingContext) === JSON.stringify(source.context.livingContext) &&
    saved.context.contextHash === source.context.contextHash
}

export function isAiAdoptReceiptFor(input: AiAdoptInput, source: AiRun, receipt: AiAdoptReceipt): boolean {
  try {
    return source.context.summary === undefined && source.context.purpose === undefined && !isAiMemoryTask(source.kind) && receipt.bookId === input.bookId && adoptedRunMatches(input, source, receipt.run) &&
      receipt.run.acceptedText === input.acceptedText && receipt.chapter.bookId === input.bookId && receipt.chapter.id === source.chapterId &&
      receipt.chapter.bookRevision === source.context.bookRevision + 1 && receipt.run.adoptedRevisionId === receipt.chapter.revisionId
  } catch { return false }
}

export function isAiMemoryAdoptReceiptFor(input: AiMemoryAdoptInput, source: AiRun, receipt: AiMemoryAdoptReceipt): boolean {
  try {
    const baseline = input.maintenanceBaseline
    const savedEntries = receipt.run.memoryAdoptions
    if (!savedEntries || savedEntries.length !== input.entries.length) return false
    const changes = savedEntries.filter((entry) => entry.changed ?? true).length
    const itemIds = savedEntries.flatMap((entry) => entry.itemId === null ? [] : [entry.itemId])
    if (baseline && (receipt.status.schemaVersion < 11 || baseline.expectedBookRevision < source.context.bookRevision || baseline.expectedKnowledgeRevision !== source.context.knowledgeRevision)) return false
    if (source.context.summary !== undefined || receipt.run.context.summary !== undefined || !isAiMemoryTask(source.kind) || receipt.bookId !== input.bookId || !adoptedRunMatches(input, source, receipt.run) ||
      receipt.run.adoptedRevisionId !== source.context.chapterRevisionId || receipt.status.bookId !== input.bookId || receipt.status.schemaVersion < 7 ||
      receipt.status.bookRevision !== (baseline?.expectedBookRevision ?? source.context.bookRevision) + changes ||
      receipt.status.knowledgeRevision !== source.context.knowledgeRevision + changes ||
      JSON.stringify(receipt.itemIds) !== JSON.stringify(itemIds) || new Set(itemIds).size !== itemIds.length) return false
    const proposal = parseAiMemoryProposal(source.outputText, source.context)
    return input.entries.every((entry, index) => {
      const saved = receipt.run.memoryAdoptions![index]!
      const original = proposal.items[entry.sourceIndex]
      const action = entry.action ?? 'create'
      const expectedFields = action === 'ignore' ? entry.fields : resolveKnowledgeFields(entry.fields, saved.previousFields)
      if (saved.changed !== undefined && typeof saved.changed !== 'boolean') return false
      if ((saved.action ?? 'create') !== action || saved.targetItemId !== entry.targetItemId ||
        saved.expectedTargetRevisionId !== entry.expectedTargetRevisionId) return false
      if (action === 'ignore' ? saved.itemId !== null || saved.changed !== false : saved.itemId === null || requiredId(saved.itemId) !== saved.itemId) return false
      if (action === 'create' && saved.changed === false) return false
      if ((action === 'link' || action === 'revise') && (typeof saved.changed !== 'boolean' || saved.itemId !== entry.targetItemId || !saved.previousFields || !saved.resultingRevisionId ||
        saved.previousFields.kind !== entry.fields.kind || saved.previousFields.nature !== entry.fields.nature ||
        requiredId(saved.resultingRevisionId) !== saved.resultingRevisionId ||
        (saved.changed === false && (saved.resultingRevisionId !== entry.expectedTargetRevisionId || JSON.stringify(saved.previousFields) !== JSON.stringify(expectedFields))) ||
        (action === 'link' && JSON.stringify(saved.previousFields) !== JSON.stringify(expectedFields)))) return false
      return original !== undefined && saved.sourceIndex === entry.sourceIndex &&
        JSON.stringify(parseKnowledgeFields(saved.fields)) === JSON.stringify(parseKnowledgeFields(expectedFields)) && JSON.stringify(saved.citations) === JSON.stringify(original.citations)
    })
  } catch { return false }
}
export interface AiCheckpointInput extends AiRunInput { outputText: string }
export interface AiFinishInput extends AiRunInput {
  state: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  outputText: string
  usage: AiUsage | null
  finishReason: string | null
  error: string | null
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('AI 请求格式无效或包含不支持的字段。')
  return value
}
function id(value: unknown): string { return requiredId(value).toLowerCase() }
function positive(value: unknown, label: string, maximum: number): number {
  const number = requiredInteger(value, label, maximum)
  if (number < 1) invalid(`${label}必须大于零。`)
  return number
}
export function parseAiWritingContext(value: unknown): AiWritingContext {
  const data = record(value, ['version', 'settingsRevision', 'genre', 'synopsis', 'premise', 'style', 'narrator', 'tense', 'rules'])
  if (data.version !== 1) invalid('作品创作约定快照版本无效。')
  const text = (key: string, maximum: number) => {
    const value = data[key]
    if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) invalid('作品创作约定内容无效或超出上限。')
    return value
  }
  return { version: 1, settingsRevision: data.settingsRevision === null ? null : requiredInteger(data.settingsRevision, '创作约定版本'),
    genre: text('genre', 120), synopsis: text('synopsis', 5000), premise: text('premise', 5000),
    style: text('style', 5000), narrator: text('narrator', 500), tense: text('tense', 500), rules: text('rules', 10_000) }
}
export function parseAiEndpoint(value: unknown): string {
  const raw = requiredText(value, '模型接口地址', 2000)
  let url: URL
  try { url = new URL(raw) } catch { return invalid('模型接口必须是完整的 HTTP 或 HTTPS 地址。') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    invalid('接口须使用 HTTPS；本机地址可用 HTTP。地址中不能包含凭据、查询参数或片段。')
  }
  const base = url.href.replace(/\/+$/, '')
  if (/\/(chat\/completions|images\/generations|responses|embeddings)$/i.test(base)) invalid('请填写接口基础地址，例如 https://api.example.com/v1，不要包含 chat/completions 或 images/generations。')
  return base
}
export function parseAiConnectionConfig(value: unknown): AiConnectionConfig {
  const data = record(value, ['id', 'name', 'baseUrl', 'model', 'contextWindow', 'maxOutputTokens'])
  const contextWindow = positive(data.contextWindow, '上下文窗口', 2_000_000)
  const maxOutputTokens = positive(data.maxOutputTokens, '最大输出 token', 16_384)
  if (contextWindow < 1024 || maxOutputTokens >= contextWindow) invalid('上下文窗口至少 1024，且必须大于最大输出预算。')
  return { id: id(data.id), name: requiredText(data.name, '连接名称', 80), baseUrl: parseAiEndpoint(data.baseUrl),
    model: requiredText(data.model, '模型名称', 200), contextWindow, maxOutputTokens }
}
export function parseAiConnectionSaveInput(value: unknown): AiConnectionSaveInput {
  const data = record(value, ['bookId', 'connection', 'expectedVersion'])
  return { bookId: id(data.bookId), connection: parseAiConnectionConfig(data.connection),
    expectedVersion: data.expectedVersion === null ? null : requiredInteger(data.expectedVersion, '连接版本') }
}
export function parseAiConnection(value: unknown): AiConnection {
  const data = record(value, ['id', 'name', 'baseUrl', 'model', 'contextWindow', 'maxOutputTokens', 'version', 'updatedAt'])
  const { version, updatedAt, ...config } = data
  return { ...parseAiConnectionConfig(config), version: requiredInteger(version, '连接版本'), updatedAt: requiredText(updatedAt, '连接更新时间', 40) }
}
export function parseAiConfigureInput(value: unknown): AiConfigureInput {
  const data = record(value, ['bookId', 'connection', 'expectedVersion', 'apiKey'])
  const input = parseAiConnectionSaveInput({ bookId: data.bookId, connection: data.connection, expectedVersion: data.expectedVersion })
  if (data.apiKey === undefined) return input
  if (typeof data.apiKey !== 'string' || data.apiKey.length > 8192 || /[\r\n\0]/.test(data.apiKey)) invalid('会话密钥格式无效。')
  return { ...input, apiKey: data.apiKey.trim() }
}
export function parseAiBookInput(value: unknown): AiBookInput {
  const data = record(value, ['bookId'])
  return { bookId: id(data.bookId) }
}
export function parseAiPrepareInput(value: unknown): AiPrepareInput {
  const data = record(value, ['bookId', 'chapterId', 'expectedBookRevision', 'expectedKnowledgeRevision', 'expectedRevisionId', 'connectionId', 'kind', 'purpose', 'instruction', 'contextScope', 'perspective', 'characterScope', 'selectedBlockIds', 'memoryChunkIds', 'summaryRefs', 'resourceRefs', 'resourceApplication', 'useLivingContext'])
  if (!['plan', 'continue', 'rewrite', 'summarize', 'extract'].includes(String(data.kind))) invalid('不支持这个协作任务。')
  if (data.purpose !== undefined && (!['review', 'study', 'living', 'forge'].includes(String(data.purpose)) || data.kind !== 'plan')) invalid('专用工坊只能用于规划类任务。')
  if (data.useLivingContext !== undefined && typeof data.useLivingContext !== 'boolean') invalid('有效章纲与记忆选项无效。')
  if (data.useLivingContext === true && ((data.perspective !== undefined && data.perspective !== 'author') || data.kind === 'summarize' || data.kind === 'extract' || data.purpose !== undefined && data.purpose !== 'review')) invalid('有效章纲与记忆仅用于作者视角的创作和审稿。')
  if (data.contextScope !== 'chapter' && data.contextScope !== 'nearby') invalid('上下文范围无效。')
  if (data.perspective !== undefined && data.perspective !== 'author' && data.perspective !== 'reader' && data.perspective !== 'character') invalid('上下文视角无效。')
  if ((data.kind === 'summarize' || data.kind === 'extract') && data.perspective !== undefined && data.perspective !== 'author') invalid('章节整理仅支持作者视角。')
  if (data.perspective !== 'character' && data.characterScope !== undefined) invalid('只有人物视角可以指定人物与故事时点。')
  const characterScope = data.perspective === 'character' ? parseAiCharacterScope(data.characterScope) : undefined
  if (!Array.isArray(data.selectedBlockIds) || data.selectedBlockIds.length > 200 || !Array.isArray(data.memoryChunkIds) || data.memoryChunkIds.length > 12) invalid('改写最多选择 200 个连续段落，资料最多选择 12 个片段。')
  const selectedBlockIds = data.selectedBlockIds.map(id)
  const memoryChunkIds = data.memoryChunkIds.map((item) => positive(item, '资料片段编号', Number.MAX_SAFE_INTEGER))
  const summaryRefs = parseAiContextSummaryRefs(data.summaryRefs)
  const resourceRefs = parseCreativeRefs(data.resourceRefs)
  const resourceApplication = parseCreativeApplication(data.resourceApplication)
  if ((resourceRefs.length || resourceApplication) && ((data.perspective !== undefined && data.perspective !== 'author') || data.kind === 'summarize' || data.kind === 'extract')) invalid('场景、方法和自由资料只用于作者创作，请移除后再切换受限视角或章节整理。')
  if (resourceApplication && !resourceRefs.length) invalid('请先选择场景、方法或资料，再填写使用要求。')
  if (data.purpose === 'study' && ((data.perspective !== undefined && data.perspective !== 'author') || !resourceRefs.length || resourceRefs.some((ref) => ref.source !== 'inspiration') || memoryChunkIds.length || summaryRefs.length)) invalid('拆书只分析明确选择的全局参考文本，请移除本书记忆和前文摘要，并选择全局参考资料。')
  if (data.purpose === 'living' && ((data.perspective !== undefined && data.perspective !== 'author') || data.contextScope !== 'chapter' ||
    memoryChunkIds.length || summaryRefs.length || resourceRefs.length || resourceApplication)) invalid('演进与定稿提案只使用沙盘固定的来源和完整参考章，请从沙盘重新准备。')
  if (data.purpose === 'forge' && ((data.perspective !== undefined && data.perspective !== 'author') || data.contextScope !== 'chapter' ||
    memoryChunkIds.length || summaryRefs.length || resourceRefs.length || resourceApplication || data.useLivingContext)) invalid('角色与世界工坊只使用本次明确选定的固定来源。')
  if (characterScope && summaryRefs.length) invalid('人物视角不能发送完整前文摘要，请先移除已选摘要。')
  if (new Set(selectedBlockIds).size !== selectedBlockIds.length || new Set(memoryChunkIds).size !== memoryChunkIds.length) invalid('所选段落或资料不能重复。')
  if ((data.kind === 'rewrite') !== (selectedBlockIds.length > 0)) invalid('改写必须选择连续段落；其他任务不选择改写目标。')
  if ((data.kind === 'summarize' || data.kind === 'extract') && (data.contextScope !== 'chapter' || memoryChunkIds.length || summaryRefs.length)) invalid('章节整理必须使用完整本章原稿，不附加其他资料或摘要。')
  // 作者视角省略字段，保持旧请求与消息指纹的兼容性。
  return { bookId: id(data.bookId), chapterId: id(data.chapterId), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识版本'), expectedRevisionId: id(data.expectedRevisionId), connectionId: id(data.connectionId),
    kind: data.kind as AiTaskKind, instruction: requiredText(data.instruction, '协作要求', data.purpose === 'forge' ? FORGE_INSTRUCTION_LIMIT : data.purpose === 'living' ? LIVING_INSTRUCTION_LIMIT : 6000), contextScope: data.contextScope,
    ...(data.purpose === 'review' || data.purpose === 'study' || data.purpose === 'living' || data.purpose === 'forge' ? { purpose: data.purpose } : {}),
    selectedBlockIds, memoryChunkIds, ...(data.perspective === 'reader' ? { perspective: 'reader' as const } : {}),
    ...(characterScope ? { perspective: 'character' as const, characterScope } : {}),
    ...(summaryRefs.length ? { summaryRefs } : {}),
    ...(resourceRefs.length ? { resourceRefs, resourceApplication } : {}),
    ...(data.useLivingContext === true ? { useLivingContext: true } : {}) }
}
export function parseAiListInput(value: unknown): AiListInput {
  const data = record(value, ['bookId', 'before'])
  return { bookId: id(data.bookId), ...(data.before === undefined ? {} : { before: id(data.before) }) }
}
export function parseAiPrepareServiceInput(value: unknown): AiPrepareServiceInput {
  if (!isRecord(value)) invalid('AI 预览请求格式无效。')
  const { connection, ...input } = value
  return { ...parseAiPrepareInput(input), connection: parseAiConnection(connection) }
}
export function parseAiRunInput(value: unknown): AiRunInput {
  const data = record(value, ['bookId', 'runId'])
  return { bookId: id(data.bookId), runId: id(data.runId) }
}
export function parseAiVersionInput(value: unknown): AiVersionInput {
  const data = record(value, ['bookId', 'runId', 'expectedVersion'])
  return { bookId: id(data.bookId), runId: id(data.runId), expectedVersion: requiredInteger(data.expectedVersion, '候选版本') }
}
export function parseAiStartInput(value: unknown): AiStartInput {
  const data = record(value, ['bookId', 'runId', 'expectedVersion', 'contextHash', 'maintenanceBaseline'])
  if (typeof data.contextHash !== 'string' || !/^[0-9a-f]{64}$/.test(data.contextHash)) invalid('上下文指纹无效，请重新预览。')
  return { ...parseAiVersionInput({ bookId: data.bookId, runId: data.runId, expectedVersion: data.expectedVersion }), contextHash: data.contextHash,
    ...(data.maintenanceBaseline === undefined ? {} : { maintenanceBaseline: parseAiMaintenanceBaseline(data.maintenanceBaseline) }) }
}
function parseAiMaintenanceBaseline(value: unknown): AiMaintenanceBaseline {
  const data = record(value, ['taskId', 'expectedTaskVersion', 'expectedBookRevision', 'expectedKnowledgeRevision'])
  return { taskId: id(data.taskId), expectedTaskVersion: requiredInteger(data.expectedTaskVersion, '增量任务版本'),
    expectedBookRevision: requiredInteger(data.expectedBookRevision, '当前作品版本'),
    expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '当前知识版本') }
}
export function parseAiAdoptInput(value: unknown): AiAdoptInput {
  const data = record(value, ['bookId', 'runId', 'expectedVersion', 'acceptedText'])
  if (typeof data.acceptedText !== 'string' || !data.acceptedText.trim() || data.acceptedText.length > AI_OUTPUT_LIMIT || data.acceptedText.includes('\0')) invalid('采用内容不能为空、包含空字符或超过 60,000 个字符。')
  // 作者审阅的缩进与首尾换行属于采用内容，校验后按原样保存。
  return { ...parseAiVersionInput({ bookId: data.bookId, runId: data.runId, expectedVersion: data.expectedVersion }), acceptedText: data.acceptedText }
}

/** history 仅供已保存采用审计读取；新提议与采用请求使用默认输入校验。 */
export function parseAiMemoryProposal(text: string, context: AiContextPacket, mode: 'input' | 'history' = 'input'): AiMemoryProposal {
  if (context.summary !== undefined || context.promptVersion !== AI_MEMORY_PROMPT_VERSION || !isAiMemoryTask(context.kind) || text.length > AI_OUTPUT_LIMIT) invalid('这次输出不是可审阅的章节整理结果。')
  let value: unknown
  try { value = JSON.parse(text) } catch { return invalid('整理输出须为单个 JSON 对象，不能包含代码围栏或解释文字。原输出已保留，请另建预览重新生成，或复制后手工整理。') }
  const data = record(value, ['items'])
  if (!Array.isArray(data.items) || data.items.length > 20 || (context.kind === 'summarize' && data.items.length !== 1)) invalid('抽取最多 20 条；章节摘要必须恰好 1 条。')
  const items = data.items.map((value): AiMemorySuggestion => {
    const item = record(value, ['kind', 'name', 'aliases', 'summary', 'nature', 'citations'])
    const fields = parseKnowledgeFields({ kind: item.kind, name: item.name, aliases: item.aliases, summary: item.summary,
      nature: item.nature, authorDecision: 'unreviewed', freshness: 'current', conflictState: 'unchecked' })
    if (mode !== 'history' && fields.summary.includes('\0')) invalid('整理条目说明不能包含空字符（NUL）。原输出已保留，请重新生成或复制后手工整理。')
    if (!KNOWLEDGE_KINDS.includes(fields.kind) || !['ai_derived', 'narrative_claim', 'character_belief', 'ai_inference'].includes(fields.nature) || !fields.summary.trim() || fields.summary.length > 8000) invalid('整理条目须有不超过 8,000 字符的说明，并保留正文陈述、角色认知、整理或推断的性质。')
    if (context.kind === 'summarize' && (fields.kind !== 'other' || fields.nature !== 'ai_derived')) invalid('章节摘要须为其他类型的 AI 整理条目。')
    if (!Array.isArray(item.citations) || item.citations.length < 1 || item.citations.length > 8) invalid('每条整理结果须有 1 至 8 处本章段落引文。')
    const citations = item.citations.map((value): AiMemoryCitation => {
      const citation = record(value, ['blockId', 'quote'])
      const blockId = id(citation.blockId)
      if (typeof citation.quote !== 'string' || !citation.quote.trim() || citation.quote.length > 2000 || citation.quote.includes('\0')) invalid('引文须为不超过 2,000 字符的原文。')
      const block = context.chapterBlocks.find((block) => block.blockId === blockId)
      if (!block || !block.text.includes(citation.quote)) invalid('整理引文与本次固定章节段落不符，请核对段落编号和逐字引文。')
      return { blockId, quote: citation.quote }
    })
    if (new Set(citations.map((citation) => JSON.stringify(citation))).size !== citations.length) invalid('同一条整理结果的引文不能重复。')
    return { kind: fields.kind, name: fields.name, aliases: fields.aliases, summary: fields.summary,
      nature: fields.nature as AiMemorySuggestion['nature'], citations }
  })
  return { items }
}

/** history 只兼容旧审计中的 NUL；身份、性质、长度与条目约束仍照常检查。 */
export function parseAiMemoryAdoptInput(value: unknown, mode: 'input' | 'history' = 'input'): AiMemoryAdoptInput {
  const data = record(value, ['bookId', 'runId', 'expectedVersion', 'entries', 'maintenanceBaseline'])
  if (!Array.isArray(data.entries) || data.entries.length < 1 || data.entries.length > 20) invalid('请选择 1 至 20 条已经审阅的整理结果。')
  const entries = data.entries.map((value): AiMemoryReviewEntry => {
    const entry = record(value, ['sourceIndex', 'fields', 'action', 'targetItemId', 'expectedTargetRevisionId'])
    const action = entry.action ?? 'create'
    if (!['create', 'link', 'revise', 'ignore'].includes(String(action))) invalid('请选择新建、关联、修订或忽略。')
    const existing = action === 'link' || action === 'revise'
    if (!existing && (entry.targetItemId !== undefined || entry.expectedTargetRevisionId !== undefined)) invalid('只有关联或修订可以指定已有实体。')
    const fields = parseKnowledgeFields(entry.fields)
    if (mode !== 'history' && fields.summary.includes('\0')) invalid('采用条目说明不能包含空字符（NUL），请修正后再采用。')
    if (!existing && (!['ai_derived', 'narrative_claim', 'character_belief', 'ai_inference'].includes(fields.nature) || fields.authorDecision !== 'adopted' || fields.freshness !== 'current' || !fields.summary.trim() || fields.summary.length > 8000)) invalid('新建或忽略条目须保留原提议性质，并有不超过 8,000 字符的说明。')
    if (action === 'revise' && (fields.authorDecision !== 'adopted' || fields.freshness !== 'current')) invalid('修订须由作者确认采用并核对为当前资料。')
    return { sourceIndex: requiredInteger(entry.sourceIndex, '原提议序号', 19), fields,
      ...(entry.action === undefined ? {} : { action: action as AiMemoryReviewAction }),
      ...(existing ? { targetItemId: id(entry.targetItemId), expectedTargetRevisionId: id(entry.expectedTargetRevisionId) } : {}) }
  })
  if (new Set(entries.map((entry) => entry.sourceIndex)).size !== entries.length) invalid('同一整理提议不能重复采用。')
  const targets = entries.flatMap((entry) => entry.targetItemId ? [entry.targetItemId] : [])
  if (new Set(targets).size !== targets.length) invalid('同批不能多次修改同一实体，请合并审阅内容并忽略重复提议。')
  if (JSON.stringify(entries).length > AI_OUTPUT_LIMIT) invalid('本次采用内容超过 60,000 字符，请减少所选条目或缩短说明。')
  return { ...parseAiVersionInput({ bookId: data.bookId, runId: data.runId, expectedVersion: data.expectedVersion }), entries,
    ...(data.maintenanceBaseline === undefined ? {} : { maintenanceBaseline: parseAiMaintenanceBaseline(data.maintenanceBaseline) }) }
}
export function parseAiCheckpointInput(value: unknown): AiCheckpointInput {
  const data = record(value, ['bookId', 'runId', 'outputText'])
  return { bookId: id(data.bookId), runId: id(data.runId), outputText: outputText(data.outputText) }
}
function outputText(value: unknown): string {
  if (typeof value !== 'string' || value.length > AI_OUTPUT_LIMIT || value.includes('\0')) invalid('模型输出格式无效或超过保存上限。')
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) invalid('模型输出含不完整的 Unicode 字符，未写入本次结果。')
  }
  return value
}
export function parseAiFinishInput(value: unknown): AiFinishInput {
  const data = record(value, ['bookId', 'runId', 'state', 'outputText', 'usage', 'finishReason', 'error'])
  if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(data.state))) invalid('候选结束状态无效。')
  let usage: AiUsage | null = null
  if (data.usage !== null) {
    const item = record(data.usage, ['inputTokens', 'outputTokens', 'totalTokens'])
    const count = (value: unknown) => value === null ? null : requiredInteger(value, '实际 token 用量')
    usage = { inputTokens: count(item.inputTokens), outputTokens: count(item.outputTokens), totalTokens: count(item.totalTokens) }
  }
  return { bookId: id(data.bookId), runId: id(data.runId), state: data.state as AiFinishInput['state'], outputText: outputText(data.outputText), usage,
    finishReason: data.finishReason === null ? null : optionalText(data.finishReason, '结束原因', 100),
    error: data.error === null ? null : requiredText(data.error, '错误说明', 500) }
}
