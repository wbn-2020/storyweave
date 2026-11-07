import { DomainError, isRecord, requiredId, requiredInteger, requiredText } from './api'
import { AI_OUTPUT_LIMIT, type AiBookInput, type AiMemoryCitation, type AiRun, type AiRunState } from './ai'
import { parseAiMemoryTaskScope, type AiMemoryTaskScope, type AiMemoryTaskState } from './ai-memory-task'

export const AI_SUMMARY_PROMPT_VERSION = 3
export const AI_SUMMARY_PLAN_PAGE = 100
export const AI_SUMMARY_NODE_PAGE = 50
export const AI_SUMMARY_TEXT_LIMIT = 8000
export interface AiSummarySource {
  id: string
  kind: 'chapter' | 'node'
  title: string
  text: string
  chapterCount: number
  chapterId: string
  chapterRevisionId: string
  chapterTitle: string
  /** 只有章节摘要附原稿引文；上层节点的直接来源是下层摘要。 */
  citations: AiMemoryCitation[]
}
export interface AiSummaryContext {
  taskId: string
  nodeId: string
  scope: AiMemoryTaskScope
  scopeTitle: string
  manifestHash: string
  level: number
  position: number
  fanIn: 2 | 4 | 8
  coveredChapters: number
  sources: AiSummarySource[]
}
export interface AiSummaryProposal { summary: string; citations: { sourceId: string; quote: string }[] }
export interface AiSummaryStartInput extends AiBookInput {
  expectedBookRevision: number
  expectedKnowledgeRevision: number
  connectionId: string
  scope: AiMemoryTaskScope
  fanIn: 2 | 4 | 8
  instruction: string
}
export interface AiSummaryTaskInput extends AiBookInput { taskId: string; expectedTaskVersion: number }
export interface AiSummaryReadInput extends AiBookInput { taskId: string; afterOrdinal?: number }
export interface AiSummaryNodeInput extends AiBookInput { taskId: string; nodeId: string }
export interface AiSummaryControlInput extends AiSummaryTaskInput { action: 'pause' | 'resume' | 'retry' | 'cancel' }
export interface AiSummaryAdoptInput extends AiSummaryTaskInput { nodeId: string; runId: string; expectedRunVersion: number; acceptedText: string }
export interface AiSummaryTaskSummary {
  id: string
  bookId: string
  version: number
  state: AiMemoryTaskState
  phase: 'planning' | 'reviewing'
  scope: AiMemoryTaskScope
  scopeTitle: string
  manifestHash: string
  fanIn: 2 | 4 | 8
  connectionId: string
  connectionName: string
  model: string
  instruction: string
  sourceBookRevision: number
  sourceKnowledgeRevision: number
  sourceCurrent: boolean
  totalChapters: number
  totalNodes: number
  plannedNodes: number
  approvedNodes: number
  error: string | null
  createdAt: string
  updatedAt: string
}
export interface AiSummaryNodeSummary {
  id: string
  taskId: string
  ordinal: number
  level: number
  position: number
  title: string
  firstChapterOrdinal: number
  lastChapterOrdinal: number
  chapterCount: number
  state: 'pending' | 'approved'
  runId: string | null
  runState: AiRunState | null
  attempts: number
}
export interface AiSummaryNodeDetail extends AiSummaryNodeSummary {
  acceptedText: string | null
  approvedAt: string | null
  /** 下层节点尚未确认时为 null，不用空数组冒充完整来源。 */
  sources: AiSummarySource[] | null
  run: AiRun | null
}
export interface AiSummaryTaskDetail extends AiSummaryTaskSummary {
  nodes: AiSummaryNodeSummary[]
  currentNode: AiSummaryNodeSummary | null
  nextAfterOrdinal: number | null
}
export interface AiSummaryStatus {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  updatedAt: string
  schemaVersion: number
  requiresUpgrade: boolean
  totalChapters: number
  availableChapterSummaries: number
  activeTask: AiSummaryTaskSummary | null
  recentTasks: AiSummaryTaskSummary[]
}
export interface AiSummaryReceipt { bookId: string; task: AiSummaryTaskDetail; status: AiSummaryStatus; node: AiSummaryNodeDetail | null }
export interface AiSummaryAdoptReceipt extends AiSummaryReceipt { adoptedNode: AiSummaryNodeDetail; adoptedRun: AiRun }

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('分层摘要格式无效或包含不支持的字段。')
  return value
}
function id(value: unknown): string { return requiredId(value).toLowerCase() }
function positive(value: unknown, label: string, maximum: number): number {
  const result = requiredInteger(value, label, maximum)
  if (!result) invalid(`${label}必须大于零。`)
  return result
}
function fanIn(value: unknown): 2 | 4 | 8 {
  if (value !== 2 && value !== 4 && value !== 8) invalid('每组摘要数须为 2、4 或 8。')
  return value
}
export function parseAiSummaryContext(value: unknown): AiSummaryContext {
  const data = record(value, ['taskId', 'nodeId', 'scope', 'scopeTitle', 'manifestHash', 'level', 'position', 'fanIn', 'coveredChapters', 'sources'])
  const width = fanIn(data.fanIn)
  const level = requiredInteger(data.level, '汇总层级', 30)
  if (typeof data.manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(data.manifestHash) ||
    !Array.isArray(data.sources) || !data.sources.length || data.sources.length > width) invalid('汇总来源数量或指纹无效。')
  const sources = data.sources.map((value): AiSummarySource => {
    const source = record(value, ['id', 'kind', 'title', 'text', 'chapterCount', 'chapterId', 'chapterRevisionId', 'chapterTitle', 'citations'])
    if (source.kind !== (level === 0 ? 'chapter' : 'node') || !Array.isArray(source.citations) || source.citations.length > 8 ||
      (source.kind === 'chapter' ? source.citations.length === 0 : source.citations.length !== 0)) invalid('汇总来源层级或原稿引文无效。')
    const citations = source.citations.map((value): AiMemoryCitation => {
      const citation = record(value, ['blockId', 'quote'])
      return { blockId: id(citation.blockId), quote: requiredText(citation.quote, '原稿引文', 2000) }
    })
    const count = positive(source.chapterCount, '来源章节数', 20_000)
    if (source.kind === 'chapter' && count !== 1) invalid('章节摘要只能覆盖一章。')
    return { id: id(source.id), kind: source.kind as AiSummarySource['kind'], title: requiredText(source.title, '来源标题', 120),
      text: requiredText(source.text, '来源摘要', AI_SUMMARY_TEXT_LIMIT), chapterCount: count, chapterId: id(source.chapterId),
      chapterRevisionId: id(source.chapterRevisionId), chapterTitle: requiredText(source.chapterTitle, '首来源章标题', 120), citations }
  })
  const coveredChapters = positive(data.coveredChapters, '覆盖章节数', 20_000)
  if (new Set(sources.map((source) => source.id)).size !== sources.length || sources.reduce((count, source) => count + source.chapterCount, 0) !== coveredChapters) invalid('汇总来源重复或覆盖章节数不符。')
  return { taskId: id(data.taskId), nodeId: id(data.nodeId), scope: parseAiMemoryTaskScope(data.scope), scopeTitle: requiredText(data.scopeTitle, '范围标题', 120),
    manifestHash: data.manifestHash, level, position: requiredInteger(data.position, '本层位置', 20_000), fanIn: width, coveredChapters, sources }
}
export function parseAiSummaryProposal(output: string, context: AiSummaryContext): AiSummaryProposal {
  if (typeof output !== 'string' || output.length > AI_OUTPUT_LIMIT) invalid('汇总原输出超过上限。')
  let value: unknown
  try { value = JSON.parse(output) } catch { return invalid('汇总须返回单个 JSON 对象，请保留原输出后重试。') }
  const data = record(value, ['summary', 'citations'])
  if (!Array.isArray(data.citations) || !data.citations.length || data.citations.length > 16) invalid('汇总须附 1–16 处下层摘要引文。')
  const citations = data.citations.map((value) => {
    const citation = record(value, ['sourceId', 'quote'])
    const sourceId = id(citation.sourceId)
    const quote = requiredText(citation.quote, '下层摘要引文', 2000)
    if (!context.sources.some((source) => source.id === sourceId && source.text.includes(quote))) invalid('汇总引文与本次固定下层摘要不符。')
    return { sourceId, quote }
  })
  if (context.sources.some((source) => !citations.some((citation) => citation.sourceId === source.id))) invalid('每份下层摘要都须至少一处可核对引文。')
  const summary = requiredText(data.summary, '汇总摘要', AI_SUMMARY_TEXT_LIMIT)
  if (summary.includes('\0')) invalid('汇总摘要不能包含空字符（NUL）。原输出已保留，请重新生成或复制后手工整理。')
  return { summary, citations }
}
export function parseAiSummaryStartInput(value: unknown): AiSummaryStartInput {
  const data = record(value, ['bookId', 'expectedBookRevision', 'expectedKnowledgeRevision', 'connectionId', 'scope', 'fanIn', 'instruction'])
  return { bookId: id(data.bookId), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识版本'), connectionId: id(data.connectionId),
    scope: parseAiMemoryTaskScope(data.scope), fanIn: fanIn(data.fanIn), instruction: requiredText(data.instruction, '汇总要求', 6000) }
}
export function parseAiSummaryTaskInput(value: unknown): AiSummaryTaskInput {
  const data = record(value, ['bookId', 'taskId', 'expectedTaskVersion'])
  return { bookId: id(data.bookId), taskId: id(data.taskId), expectedTaskVersion: requiredInteger(data.expectedTaskVersion, '汇总任务版本') }
}
export function parseAiSummaryReadInput(value: unknown): AiSummaryReadInput {
  const data = record(value, ['bookId', 'taskId', 'afterOrdinal'])
  return { bookId: id(data.bookId), taskId: id(data.taskId), ...(data.afterOrdinal === undefined ? {} : { afterOrdinal: requiredInteger(data.afterOrdinal, '节点分页位置', 40_000) }) }
}
export function parseAiSummaryNodeInput(value: unknown): AiSummaryNodeInput {
  const data = record(value, ['bookId', 'taskId', 'nodeId'])
  return { bookId: id(data.bookId), taskId: id(data.taskId), nodeId: id(data.nodeId) }
}
export function parseAiSummaryControlInput(value: unknown): AiSummaryControlInput {
  const data = record(value, ['bookId', 'taskId', 'expectedTaskVersion', 'action'])
  if (data.action !== 'pause' && data.action !== 'resume' && data.action !== 'retry' && data.action !== 'cancel') invalid('不支持这个汇总任务操作。')
  return { ...parseAiSummaryTaskInput({ bookId: data.bookId, taskId: data.taskId, expectedTaskVersion: data.expectedTaskVersion }), action: data.action }
}
export function parseAiSummaryAdoptInput(value: unknown): AiSummaryAdoptInput {
  const data = record(value, ['bookId', 'taskId', 'expectedTaskVersion', 'nodeId', 'runId', 'expectedRunVersion', 'acceptedText'])
  const acceptedText = requiredText(data.acceptedText, '作者采用的摘要', AI_SUMMARY_TEXT_LIMIT)
  if (acceptedText.includes('\0')) invalid('作者采用的摘要不能包含空字符（NUL），请修正后再采用。')
  return { ...parseAiSummaryTaskInput({ bookId: data.bookId, taskId: data.taskId, expectedTaskVersion: data.expectedTaskVersion }),
    nodeId: id(data.nodeId), runId: id(data.runId), expectedRunVersion: requiredInteger(data.expectedRunVersion, '汇总候选版本'),
    acceptedText }
}
export function isAiSummaryReceiptFor(bookId: string, receipt: AiSummaryReceipt, previous?: AiSummaryTaskSummary): boolean {
  try {
    const { task, status, node } = receipt
    if (receipt.bookId !== bookId || task.bookId !== bookId || status.bookId !== bookId || status.schemaVersion < 9 ||
      status.requiresUpgrade !== false || typeof task.sourceCurrent !== 'boolean' ||
      !['planning', 'ready', 'paused', 'failed', 'completed', 'superseded', 'cancelled'].includes(task.state) ||
      !['planning', 'reviewing'].includes(task.phase) || ![2, 4, 8].includes(task.fanIn) || !/^[0-9a-f]{64}$/.test(task.manifestHash) ||
      task.version !== (previous ? previous.version + 1 : 0) ||
      [task.version, task.totalChapters, task.totalNodes, task.plannedNodes, task.approvedNodes, task.sourceBookRevision, task.sourceKnowledgeRevision, status.bookRevision, status.knowledgeRevision].some((value) => !Number.isSafeInteger(value) || value < 0) ||
      task.totalChapters < 1 || task.totalChapters > 20_000 || task.totalNodes < 1 || task.totalNodes > 40_000 || task.approvedNodes > task.plannedNodes || task.plannedNodes > task.totalNodes || task.nodes.length > AI_SUMMARY_NODE_PAGE) return false
    // 回执遵循与持久层相同的状态组合，不能用一个合法任务 ID 掩盖未完成的终态。
    if ((task.phase === 'reviewing' && task.plannedNodes !== task.totalNodes) || (task.phase === 'planning' && task.approvedNodes !== 0) ||
      (task.state === 'planning' && task.phase !== 'planning') || (task.state === 'ready' && task.phase !== 'reviewing') ||
      (task.state === 'completed' && task.approvedNodes !== task.totalNodes)) return false
    if (previous && (task.id !== previous.id || task.manifestHash !== previous.manifestHash || task.fanIn !== previous.fanIn ||
      task.connectionId !== previous.connectionId || task.connectionName !== previous.connectionName || task.model !== previous.model ||
      task.instruction !== previous.instruction || task.scopeTitle !== previous.scopeTitle || JSON.stringify(task.scope) !== JSON.stringify(previous.scope) ||
      task.sourceBookRevision !== previous.sourceBookRevision || task.sourceKnowledgeRevision !== previous.sourceKnowledgeRevision ||
      task.totalChapters !== previous.totalChapters || task.totalNodes !== previous.totalNodes)) return false
    const active = ['planning', 'ready', 'paused', 'failed'].includes(task.state)
    if (active ? status.activeTask?.id !== task.id || status.activeTask.version !== task.version : status.activeTask?.id === task.id) return false
    if (active && (status.activeTask?.state !== task.state || status.activeTask.phase !== task.phase || status.activeTask.sourceCurrent !== task.sourceCurrent ||
      status.activeTask.plannedNodes !== task.plannedNodes || status.activeTask.approvedNodes !== task.approvedNodes ||
      status.activeTask.totalNodes !== task.totalNodes || status.activeTask.totalChapters !== task.totalChapters || status.activeTask.manifestHash !== task.manifestHash)) return false
    if (Boolean(node) !== Boolean(task.currentNode)) return false
    if (node && (node.id !== task.currentNode?.id || node.taskId !== task.id || node.state !== task.currentNode?.state ||
      node.runId !== task.currentNode?.runId || node.runState !== task.currentNode?.runState || node.runId !== (node.run?.id ?? null) || node.runState !== (node.run?.state ?? null))) return false
    if (node?.run && (node.run.bookId !== bookId || node.run.kind !== 'summarize' || node.run.context.promptVersion !== AI_SUMMARY_PROMPT_VERSION ||
      node.run.context.summary?.taskId !== task.id || node.run.context.summary.nodeId !== node.id ||
      node.run.context.summary.manifestHash !== task.manifestHash || node.run.context.connection.id !== task.connectionId || node.run.context.instruction !== task.instruction)) return false
    return true
  } catch { return false }
}
export function isAiSummaryAdoptReceiptFor(input: AiSummaryAdoptInput, source: AiRun, previous: AiSummaryTaskSummary, receipt: AiSummaryAdoptReceipt): boolean {
  try {
    const saved = receipt.adoptedRun
    const nodeRun = receipt.adoptedNode.run
    return isAiSummaryReceiptFor(input.bookId, receipt, previous) && input.taskId === previous.id && input.expectedTaskVersion === previous.version &&
      source.id === input.runId && source.bookId === input.bookId && source.kind === 'summarize' && source.context.promptVersion === AI_SUMMARY_PROMPT_VERSION &&
      source.version === input.expectedRunVersion && source.state === 'succeeded' && source.context.summary?.nodeId === input.nodeId &&
      source.context.summary.taskId === input.taskId && saved.id === source.id && saved.bookId === input.bookId && saved.state === 'adopted' && saved.version === source.version + 1 &&
      saved.kind === source.kind && saved.chapterId === source.chapterId && saved.chapterTitle === source.chapterTitle &&
      saved.connectionName === source.connectionName && saved.model === source.model &&
      saved.outputText === source.outputText && JSON.stringify(saved.context) === JSON.stringify(source.context) && saved.acceptedText === input.acceptedText &&
      saved.adoptedRevisionId === source.context.chapterRevisionId && receipt.adoptedNode.id === input.nodeId && receipt.adoptedNode.taskId === input.taskId &&
      receipt.adoptedNode.state === 'approved' && receipt.adoptedNode.acceptedText === input.acceptedText && receipt.adoptedNode.runId === source.id &&
      receipt.adoptedNode.runState === 'adopted' && nodeRun !== null && nodeRun.id === saved.id && nodeRun.bookId === saved.bookId && nodeRun.kind === saved.kind &&
      nodeRun.version === saved.version && nodeRun.state === saved.state && nodeRun.outputText === saved.outputText && nodeRun.acceptedText === saved.acceptedText &&
      nodeRun.adoptedRevisionId === saved.adoptedRevisionId && JSON.stringify(nodeRun.context) === JSON.stringify(saved.context) &&
      receipt.status.bookRevision === source.context.bookRevision + 1 && receipt.status.knowledgeRevision === source.context.knowledgeRevision &&
      receipt.task.approvedNodes === previous.approvedNodes + 1
  } catch { return false }
}
