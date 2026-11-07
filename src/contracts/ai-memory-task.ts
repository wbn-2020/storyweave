import { DomainError, isRecord, requiredId, requiredInteger, requiredText } from './api'
import { AI_MEMORY_PROMPT_VERSION, type AiBookInput, type AiRun, type AiRunState } from './ai'

export const AI_MEMORY_TASK_PLAN_PAGE = 100
export const AI_MEMORY_TASK_UNIT_PAGE = 50
export const AI_MEMORY_TASK_CONSUMER = 'chapter_model_review_v1'
export type AiMemoryTaskKind = 'summarize' | 'extract'
export type AiMemoryTaskState = 'planning' | 'ready' | 'paused' | 'failed' | 'completed' | 'superseded' | 'cancelled'
export type AiMemoryTaskScope = { kind: 'book' } | { kind: 'volume'; volumeId: string | null }
export interface AiMemoryTaskStartInput extends AiBookInput {
  expectedBookRevision: number
  expectedKnowledgeRevision: number
  connectionId: string
  kind: AiMemoryTaskKind
  scope: AiMemoryTaskScope
  instruction: string
  selection?: 'pending_review'
  expectedCoverageHash?: string
}
export interface AiMemoryTaskInput extends AiBookInput { taskId: string; expectedTaskVersion: number }
export interface AiMemoryTaskReadInput extends AiBookInput { taskId: string; afterOrdinal?: number }
export interface AiMemoryTaskControlInput extends AiMemoryTaskInput { action: 'pause' | 'resume' | 'cancel' | 'retry' | 'skip' }
export interface AiMemoryTaskSummary {
  id: string
  bookId: string
  version: number
  state: AiMemoryTaskState
  phase: 'planning' | 'reviewing'
  kind: AiMemoryTaskKind
  scope: AiMemoryTaskScope
  scopeTitle: string
  selection?: 'pending_review'
  connectionId: string
  connectionName: string
  model: string
  instruction: string
  sourceBookRevision: number
  sourceKnowledgeRevision: number
  sourceCurrent: boolean
  totalChapters: number
  plannedChapters: number
  reviewedChapters: number
  skippedChapters: number
  error: string | null
  createdAt: string
  updatedAt: string
}
export interface AiMemoryTaskUnit {
  ordinal: number
  chapterId: string
  chapterTitle: string
  chapterRevisionId: string
  state: 'pending' | 'reviewed' | 'skipped'
  runId: string | null
  runState: AiRunState | null
  attempts: number
}
export interface AiMemoryTaskDetail extends AiMemoryTaskSummary {
  units: AiMemoryTaskUnit[]
  currentUnit: AiMemoryTaskUnit | null
  nextAfterOrdinal: number | null
}
export interface AiMemoryTaskStatus {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  schemaVersion: number
  requiresUpgrade: boolean
  consumer: typeof AI_MEMORY_TASK_CONSUMER
  activeTask: AiMemoryTaskSummary | null
  recentTasks: AiMemoryTaskSummary[]
  /** 只证明该消费者已记录作者逐章决定，不表示知识全部采纳或模型质量达标。 */
  reviewedSourceCount: number
}
export interface AiMemoryTaskReceipt { bookId: string; task: AiMemoryTaskDetail; status: AiMemoryTaskStatus; run: AiRun | null }

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('模型整理任务格式无效或包含不支持的字段。')
  return value
}
function id(value: unknown): string { return requiredId(value).toLowerCase() }
export function parseAiMemoryTaskScope(value: unknown): AiMemoryTaskScope {
  const scope = record(value, ['kind', 'volumeId'])
  if (scope.kind === 'book' && scope.volumeId === undefined) return { kind: 'book' }
  if (scope.kind === 'volume' && scope.volumeId !== undefined) return { kind: 'volume', volumeId: scope.volumeId === null ? null : id(scope.volumeId) }
  return invalid('请选择全书、一个卷或未分卷章节。')
}
export function parseAiMemoryTaskStartInput(value: unknown): AiMemoryTaskStartInput {
  const data = record(value, ['bookId', 'expectedBookRevision', 'expectedKnowledgeRevision', 'connectionId', 'kind', 'scope', 'instruction', 'selection', 'expectedCoverageHash'])
  if (data.kind !== 'summarize' && data.kind !== 'extract') invalid('模型整理任务只支持章节摘要或知识建议。')
  if (data.selection !== undefined && data.selection !== 'pending_review') invalid('不支持这个章节选择方式。')
  if (data.selection === 'pending_review' ? typeof data.expectedCoverageHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.expectedCoverageHash) : data.expectedCoverageHash !== undefined) {
    invalid('增量任务需要当前待维护清单指纹，请重新读取清单。')
  }
  return { bookId: id(data.bookId), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识版本'), connectionId: id(data.connectionId),
    kind: data.kind, scope: parseAiMemoryTaskScope(data.scope), instruction: requiredText(data.instruction, '整理要求', 6000),
    ...(data.selection === 'pending_review' ? { selection: data.selection, expectedCoverageHash: data.expectedCoverageHash as string } : {}) }
}
export function parseAiMemoryTaskInput(value: unknown): AiMemoryTaskInput {
  const data = record(value, ['bookId', 'taskId', 'expectedTaskVersion'])
  return { bookId: id(data.bookId), taskId: id(data.taskId), expectedTaskVersion: requiredInteger(data.expectedTaskVersion, '整理任务版本') }
}
export function parseAiMemoryTaskReadInput(value: unknown): AiMemoryTaskReadInput {
  const data = record(value, ['bookId', 'taskId', 'afterOrdinal'])
  return { bookId: id(data.bookId), taskId: id(data.taskId),
    ...(data.afterOrdinal === undefined ? {} : { afterOrdinal: requiredInteger(data.afterOrdinal, '章节分页位置', 20_000) }) }
}
export function parseAiMemoryTaskControlInput(value: unknown): AiMemoryTaskControlInput {
  const data = record(value, ['bookId', 'taskId', 'expectedTaskVersion', 'action'])
  if (data.action !== 'pause' && data.action !== 'resume' && data.action !== 'cancel' && data.action !== 'retry' && data.action !== 'skip') invalid('不支持这个模型整理任务操作。')
  return { ...parseAiMemoryTaskInput({ bookId: data.bookId, taskId: data.taskId, expectedTaskVersion: data.expectedTaskVersion }), action: data.action }
}

export function isAiMemoryTaskReceiptFor(bookId: string, receipt: AiMemoryTaskReceipt, previous?: AiMemoryTaskSummary): boolean {
  try {
    const { task, status, run } = receipt
    if (receipt.bookId !== bookId || task.bookId !== bookId || status.bookId !== bookId || status.schemaVersion < 8 ||
      status.consumer !== AI_MEMORY_TASK_CONSUMER || (!previous && task.version !== 0) || (previous && (task.id !== previous.id || task.version !== previous.version + 1 ||
        task.kind !== previous.kind || task.selection !== previous.selection || task.connectionId !== previous.connectionId || task.instruction !== previous.instruction ||
        task.connectionName !== previous.connectionName || task.model !== previous.model ||
        task.sourceBookRevision !== previous.sourceBookRevision || task.sourceKnowledgeRevision !== previous.sourceKnowledgeRevision ||
        task.totalChapters !== previous.totalChapters || task.scopeTitle !== previous.scopeTitle || JSON.stringify(task.scope) !== JSON.stringify(previous.scope)))) return false
    if (!['planning', 'ready', 'paused', 'failed', 'completed', 'superseded', 'cancelled'].includes(task.state) ||
      (task.phase !== 'planning' && task.phase !== 'reviewing') || (task.kind !== 'summarize' && task.kind !== 'extract') ||
      (task.selection !== undefined && task.selection !== 'pending_review') || (task.selection === 'pending_review' && (status.schemaVersion < 11 || task.totalChapters > 100)) ||
      typeof task.sourceCurrent !== 'boolean' || [task.version, task.totalChapters, task.plannedChapters, task.reviewedChapters, task.skippedChapters,
        status.bookRevision, status.knowledgeRevision, status.reviewedSourceCount].some((value) => !Number.isSafeInteger(value) || value < 0)) return false
    requiredId(task.id)
    if (['planning', 'ready', 'paused', 'failed'].includes(task.state) &&
      (status.activeTask?.id !== task.id || status.activeTask.version !== task.version || status.activeTask.state !== task.state)) return false
    if (run && (!task.currentUnit || run.bookId !== bookId || run.id !== task.currentUnit.runId || run.chapterId !== task.currentUnit.chapterId ||
      run.context.summary !== undefined || run.context.promptVersion !== AI_MEMORY_PROMPT_VERSION ||
      run.kind !== task.kind || run.context.bookId !== bookId || run.context.chapterId !== run.chapterId || run.context.kind !== task.kind ||
      run.context.chapterRevisionId !== task.currentUnit.chapterRevisionId || run.context.chapterTitle !== task.currentUnit.chapterTitle ||
      run.context.connection.id !== task.connectionId || run.context.instruction !== task.instruction ||
      run.connectionName !== run.context.connection.name || run.model !== run.context.connection.model)) return false
    return task.units.length <= AI_MEMORY_TASK_UNIT_PAGE && new Set(task.units.map((unit) => unit.ordinal)).size === task.units.length &&
      task.reviewedChapters + task.skippedChapters <= task.plannedChapters && task.plannedChapters <= task.totalChapters && task.totalChapters <= 20_000
  } catch { return false }
}
