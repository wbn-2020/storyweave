import { isRecord, requiredId, type Result, type ServiceCommand, type StudioApi } from '../contracts/api'
import type { AiRunPage, AiRunSummary } from '../contracts/ai'
import { AI_MEMORY_TASK_CONSUMER, isAiMemoryTaskReceiptFor, type AiMemoryTaskReceipt, type AiMemoryTaskStatus, type AiMemoryTaskSummary } from '../contracts/ai-memory-task'
import { isAiSummaryReceiptFor, type AiSummaryReceipt, type AiSummaryStatus, type AiSummaryTaskSummary } from '../contracts/ai-summary'
import { isImageGenerationPage, isImageGenerationRun, type ImageGenerationPage, type ImageGenerationRun, type ImageGenerationSummary } from '../contracts/image-generation'
import type { MemoryStatus, MemoryTaskSummary } from '../contracts/memory'
import { isMemoryVectorRun, isMemoryVectorRunPage, type MemoryVectorRun, type MemoryVectorRunPage, type MemoryVectorRunSummary } from '../contracts/memory-vector'

export type TaskDestination = 'ai' | 'memory' | 'aiMemoryTasks' | 'aiSummary' | 'media' | 'vector'
export interface TaskAiTarget { runId: string; chapterId: string }
export type TaskStopTarget =
  | { kind: 'ai'; task: AiRunSummary }
  | { kind: 'memory'; task: MemoryTaskSummary }
  | { kind: 'chapters'; task: AiMemoryTaskSummary }
  | { kind: 'summary'; task: AiSummaryTaskSummary }
  | { kind: 'image'; bookId: string; task: ImageGenerationSummary }
  | { kind: 'vector'; task: MemoryVectorRunSummary }
export interface TaskStopResult { confirmed: boolean; message: string }
export interface TaskEntry {
  id: string; version?: number; title: string; state: string; time: string; timeLabel?: '创建'; detail: string
  destination: TaskDestination; aiTarget?: TaskAiTarget; taskId?: string; error: string | null
  done?: number; total?: number; stop?: TaskStopTarget
}
export const taskStateLabels: Record<string, string> = {
  prepared: '等待发送', running: '处理中', planning: '规划中', ready: '等待审阅', paused: '已暂停',
  failed: '失败', completed: '已完成', succeeded: '等待采纳', superseded: '来源已变化', cancelled: '已取消',
  interrupted: '已中断', rejected: '已丢弃', adopted: '已采纳',
  saved: '已存入本书', discarded: '已放弃',
}
export function taskStateLabel(task: TaskEntry): string {
  return task.state === 'succeeded' && task.destination === 'vector' ? '已完成' :
    task.destination === 'media' && task.state === 'succeeded' ? '等待保存' : taskStateLabels[task.state]
}
const runStates = ['prepared', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'rejected', 'adopted']
const queueStates = ['planning', 'ready', 'paused', 'failed', 'completed', 'superseded', 'cancelled']
const activeQueueStates = ['planning', 'ready', 'paused', 'failed']
const kinds = { plan: '规划', continue: '续写', rewrite: '改写', summarize: '摘要', extract: '设定提取' }
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
function identity(value: unknown): boolean {
  try { return typeof value === 'string' && requiredId(value) === value } catch { return false }
}
function base(task: unknown, bookId: string, states: string[]): task is Record<string, unknown> {
  return isRecord(task) && identity(task.id) && task.bookId === bookId && count(task.version) &&
    typeof task.state === 'string' && states.includes(task.state) && time(task.createdAt) && time(task.updatedAt) &&
    (task.error === null || typeof task.error === 'string')
}
function validRun(task: AiRunSummary, bookId: string): boolean {
  return base(task, bookId, runStates) && identity(task.chapterId) && text(task.chapterTitle) && Object.prototype.hasOwnProperty.call(kinds, task.kind) &&
    (task.purpose === undefined || ['review', 'study', 'forge', 'living'].includes(task.purpose)) &&
    text(task.connectionName) && text(task.model) && count(task.outputCharacters)
}
function validMemory(task: MemoryTaskSummary, bookId: string): boolean {
  return base(task, bookId, ['planning', 'running', 'paused', 'completed', 'superseded', 'cancelled', 'failed']) &&
    ['planning', 'indexing', 'publishing'].includes(task.phase) &&
    [task.targetBookRevision, task.targetKnowledgeRevision, task.plannedSources, task.completedSources, task.processedChunks].every(count) &&
    task.completedSources <= task.plannedSources
}
function validQueue(task: AiMemoryTaskSummary | AiSummaryTaskSummary, bookId: string): boolean {
  return base(task, bookId, queueStates) && ['planning', 'reviewing'].includes(task.phase) &&
    isRecord(task.scope) && (task.scope.kind === 'book' || task.scope.kind === 'volume' && (task.scope.volumeId === null || identity(task.scope.volumeId))) &&
    text(task.scopeTitle) && identity(task.connectionId) && text(task.connectionName) && text(task.model) &&
    typeof task.instruction === 'string' && typeof task.sourceCurrent === 'boolean' &&
    [task.sourceBookRevision, task.sourceKnowledgeRevision, task.totalChapters].every(count) && task.totalChapters <= 20_000
}
function validChapters(task: AiMemoryTaskSummary, bookId: string): boolean {
  return validQueue(task, bookId) && ['summarize', 'extract'].includes(task.kind) &&
    (task.selection === undefined || task.selection === 'pending_review') &&
    [task.plannedChapters, task.reviewedChapters, task.skippedChapters].every(count) &&
    task.reviewedChapters + task.skippedChapters <= task.plannedChapters && task.plannedChapters <= task.totalChapters
}
function validSummary(task: AiSummaryTaskSummary, bookId: string): boolean {
  return validQueue(task, bookId) && [2, 4, 8].includes(task.fanIn) && /^[a-f0-9]{64}$/.test(task.manifestHash) &&
    [task.totalNodes, task.plannedNodes, task.approvedNodes].every(count) && task.totalNodes <= 40_000 &&
    task.approvedNodes <= task.plannedNodes && task.plannedNodes <= task.totalNodes
}
function statusTasks<T extends { state: string }>(value: { bookId: string; activeTask: T | null; recentTasks: T[] }, bookId: string, valid: (task: T, bookId: string) => boolean, activeStates: string[]): T[] {
  if (!isRecord(value) || value.bookId !== bookId || !Array.isArray(value.recentTasks) || value.recentTasks.length > 10 ||
    !value.recentTasks.every((task) => valid(task, bookId)) ||
    value.activeTask !== null && (!valid(value.activeTask, bookId) || !activeStates.includes(value.activeTask.state))) throw new Error('任务快照格式或身份不符')
  return [...(value.activeTask ? [value.activeTask] : []), ...value.recentTasks]
}
function runEntry(run: AiRunSummary): TaskEntry {
  const kind = run.purpose === 'review' ? '审稿' : run.purpose === 'study' ? '拆书' : run.purpose === 'forge' ? '角色工坊' : run.purpose === 'living' ? '大纲推演' : kinds[run.kind]
  return { id: `ai:${run.id}`, version: run.version, title: `${kind} · ${run.chapterTitle}`, state: run.state, time: run.updatedAt,
    detail: `${run.connectionName} · ${run.model} · ${run.outputCharacters.toLocaleString()} 字输出`, destination: 'ai',
    aiTarget: { runId: run.id, chapterId: run.chapterId }, error: run.error, ...(run.state === 'running' ? { stop: { kind: 'ai' as const, task: run } } : {}) }
}
export function readTaskCenterSnapshot(bookId: string, values: {
  runs: Result<AiRunPage>; index: Result<MemoryStatus>; chapters: Result<AiMemoryTaskStatus>; summary: Result<AiSummaryStatus>; images: Result<ImageGenerationPage>; vectors: Result<MemoryVectorRunPage>
}): { tasks: TaskEntry[]; errors: string[] } {
  const tasks: TaskEntry[] = [], errors: string[] = []
  const read = <T>(label: string, result: Result<T>, accept: (value: T) => TaskEntry[]) => {
    try {
      if (!result.ok) { errors.push(`${label}：${result.error.message}`); return }
      tasks.push(...accept(result.data))
    } catch { errors.push(`${label}：任务快照格式、作品身份或进度不符，请重新读取。`) }
  }
  read('生成记录', values.runs, (value) => {
    if (!isRecord(value) || value.bookId !== bookId || !Array.isArray(value.runs) || value.runs.length > 30 ||
      !value.runs.every((run) => validRun(run, bookId))) throw new Error('生成记录无效')
    return value.runs.map(runEntry)
  })
  read('本地索引', values.index, (value) => statusTasks(value, bookId, validMemory, ['planning', 'running', 'paused', 'failed']).map((task): TaskEntry => ({
    id: `memory:${task.id}`, taskId: task.id, version: task.version, title: '本地记忆索引', state: task.state, time: task.updatedAt,
    detail: `${task.completedSources} / ${task.plannedSources} 个来源`, done: task.completedSources, total: task.plannedSources, destination: 'memory', error: task.error,
    ...(value.activeTask?.id === task.id && value.activeTask.version === task.version ? { stop: { kind: 'memory' as const, task } } : {}),
  })))
  read('逐章整理', values.chapters, (value) => {
    if (!isRecord(value) || value.consumer !== AI_MEMORY_TASK_CONSUMER) throw new Error('整理消费者不符')
    return statusTasks(value, bookId, validChapters, activeQueueStates).map((task): TaskEntry => ({
      id: `chapters:${task.id}`, taskId: task.id, version: task.version, title: `逐章整理 · ${task.scopeTitle}`, state: task.state, time: task.updatedAt,
      detail: `已审阅 ${task.reviewedChapters} 章 · 跳过 ${task.skippedChapters} 章`, done: task.reviewedChapters + task.skippedChapters,
      total: task.totalChapters, destination: 'aiMemoryTasks', error: task.error,
      ...(value.activeTask?.id === task.id && value.activeTask.version === task.version ? { stop: { kind: 'chapters' as const, task } } : {}),
    }))
  })
  read('全书汇总', values.summary, (value) => statusTasks(value, bookId, validSummary, activeQueueStates).map((task): TaskEntry => ({
    id: `summary:${task.id}`, taskId: task.id, version: task.version, title: `分层汇总 · ${task.scopeTitle}`, state: task.state, time: task.updatedAt,
    detail: `已确认 ${task.approvedNodes} / ${task.totalNodes} 个节点`, done: task.approvedNodes, total: task.totalNodes, destination: 'aiSummary', error: task.error,
    ...(value.activeTask?.id === task.id && value.activeTask.version === task.version ? { stop: { kind: 'summary' as const, task } } : {}),
  })))
  read('图片生成', values.images, (value) => {
    if (!isImageGenerationPage(value, bookId)) throw new Error('图片任务无效')
    if (value.warning) errors.push(`图片生成：${value.warning}`)
    return value.runs.map((task): TaskEntry => ({
      id: `image:${task.runId}`, taskId: task.runId, title: `${task.kind === 'cover' ? '封面' : '人物立绘'} · ${task.title}`,
      state: task.state, time: task.createdAt, timeLabel: '创建', detail: task.model, destination: 'media', error: null,
      ...(task.state === 'running' && !value.warning ? { stop: { kind: 'image' as const, bookId, task } } : {}),
    }))
  })
  read('向量任务', values.vectors, (value) => {
    if (!isMemoryVectorRunPage(value, bookId)) throw new Error('向量任务无效')
    if (value.requiresUpgrade) errors.push('向量任务：作品格式尚不支持向量记录；可在记忆面板明确备份升级。')
    if (value.truncated) errors.push('向量任务：当前只显示运行中优先的最近 30 条，不代表完整历史。')
    return value.runs.map((task): TaskEntry => ({
      id: `vector:${task.id}`, taskId: task.id, version: task.version,
      title: task.kind === 'index' ? '向量整理' : '混合检索', state: task.state, time: task.updatedAt,
      detail: `${task.connectionName} · ${task.embeddingModel} · ${task.inputCount} 项输入`,
      destination: 'vector', error: task.error,
      ...((task.state === 'prepared' || task.state === 'running') && typeof task.active === 'boolean'
        ? { stop: { kind: 'vector' as const, task } } : {}),
    }))
  })
  const unique = new Map<string, TaskEntry>()
  // activeTask 与 recentTasks 可包含同一个任务；旧历史项不能覆盖较新的检查点。
  for (const task of tasks) {
    const previous = unique.get(task.id)
    if (!previous || task.version !== undefined && previous.version !== undefined && task.version > previous.version) unique.set(task.id, task)
  }
  return { tasks: [...unique.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.id.localeCompare(b.id)), errors }
}

/** 列表没有上下文或版本；停止前须回读同一生成，不能凭列表状态确认取消。 */
export function isTaskImageRun(value: unknown, bookId: string, task: ImageGenerationSummary): value is ImageGenerationRun {
  return isImageGenerationRun(value, bookId, task.runId) && value.input.mediaId === task.mediaId &&
    value.input.kind === task.kind && value.input.personId === task.personId && value.input.title === task.title &&
    value.connection.model === task.model && value.createdAt === task.createdAt
}

export function isTaskVectorRun(value: unknown, task: MemoryVectorRunSummary): value is MemoryVectorRun {
  return isMemoryVectorRun(value, task.bookId, task.id) && value.kind === task.kind &&
    value.publicationVersion === task.publicationVersion && value.connectionName === task.connectionName &&
    value.embeddingModel === task.embeddingModel && value.inputCount === task.inputCount && value.createdAt === task.createdAt
}

export function taskStopOperation(api: StudioApi, target: Exclude<TaskStopTarget, { kind: 'image' | 'vector' }>): {
  commands: ServiceCommand[]; send: () => Promise<Result<unknown>>; accept: (value: unknown) => boolean; read?: () => Promise<Result<unknown>>
} {
  const { task } = target, bookId = task.bookId
  if (target.kind === 'ai') {
    return {
      commands: ['ai.get', 'ai.checkpoint', 'ai.finish'],
      send: () => api.cancelAiRun({ bookId, runId: task.id }),
      read: () => api.getAiRun({ bookId, runId: task.id }),
      accept: (value) => {
        if (!isRecord(value) || !validRun(value as unknown as AiRunSummary, bookId)) return false
        return value.id === task.id && value.chapterId === target.task.chapterId && value.kind === target.task.kind &&
          value.purpose === target.task.purpose && value.connectionName === target.task.connectionName && value.model === target.task.model &&
          value.createdAt === task.createdAt && Number(value.version) > task.version && value.state !== 'running' && value.state !== 'prepared'
      },
    }
  }
  const input = { bookId, taskId: task.id, expectedTaskVersion: task.version, action: 'cancel' as const }
  const cancelled = (value: unknown): value is { task: Record<string, unknown>; status: Record<string, unknown> } =>
    isRecord(value) && value.bookId === bookId && isRecord(value.task) && value.task.bookId === bookId &&
    value.task.id === task.id && value.task.version === task.version + 1 && ['cancelled', 'superseded'].includes(String(value.task.state)) &&
    isRecord(value.status) && value.status.bookId === bookId && value.status.activeTask !== undefined &&
    (value.status.activeTask === null || isRecord(value.status.activeTask) && value.status.activeTask.id !== task.id)
  if (target.kind === 'chapters') return {
    commands: ['ai.task.control'], send: () => api.controlAiMemoryTask(input),
    accept: (value) => cancelled(value) && isAiMemoryTaskReceiptFor(bookId, value as unknown as AiMemoryTaskReceipt, target.task),
  }
  if (target.kind === 'summary') return {
    commands: ['ai.summary.control'], send: () => api.controlAiSummaryTask(input),
    accept: (value) => cancelled(value) && isAiSummaryReceiptFor(bookId, value as unknown as AiSummaryReceipt, target.task),
  }
  return {
    commands: ['memory.control'], send: () => api.controlMemoryTask(input),
    accept: (value) => cancelled(value) && validMemory(value.task as unknown as MemoryTaskSummary, bookId) &&
      value.task.targetBookRevision === target.task.targetBookRevision && value.task.targetKnowledgeRevision === target.task.targetKnowledgeRevision &&
      value.task.createdAt === task.createdAt && value.task.phase === target.task.phase && value.task.plannedSources === target.task.plannedSources &&
      value.task.completedSources === target.task.completedSources && value.task.processedChunks === target.task.processedChunks,
  }
}
