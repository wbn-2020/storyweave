import { Buffer } from 'node:buffer'
import type { ReadableStreamDefaultReader } from 'node:stream/web'
import { DomainError, failure, isRecord, type Result } from '../../contracts/api'
import {
  AI_OUTPUT_LIMIT, parseAiAdoptInput, parseAiBookInput, parseAiConfigureInput, parseAiConnection,
  parseAiListInput, parseAiMemoryAdoptInput, parseAiPrepareInput, parseAiRunInput, parseAiStartInput, parseAiVersionInput,
  type AiConfigureInput, type AiConnection, type AiConnectionPage, type AiFinishInput, type AiRun, type AiRunInput, type AiUsage,
} from '../../contracts/ai'
import { parseGetAiPresetsInput, parseSaveAiPresetInput } from '../../contracts/ai-presets'
import type { ServiceClient } from './service-client'
import { writeNewText } from '../file-access'
import { PendingAiResults, type PendingAiFile, type PendingAiPreflight } from './pending-ai-results'
import { parseAiMemoryTaskControlInput, parseAiMemoryTaskInput, parseAiMemoryTaskReadInput, parseAiMemoryTaskStartInput } from '../../contracts/ai-memory-task'
import { parseAiMemoryMaintenanceInput } from '../../contracts/ai-memory-maintenance'
import { parseAiSummaryAdoptInput, parseAiSummaryControlInput, parseAiSummaryNodeInput, parseAiSummaryReadInput, parseAiSummaryStartInput, parseAiSummaryTaskInput } from '../../contracts/ai-summary'
import { parseAiContextSummaryInput } from '../../contracts/ai-context-summary'
import { parseAiContextRecommendationInput } from '../../contracts/ai-context-recommendation'
import {
  MEMORY_VECTOR_BATCH_SIZE, parseMemoryEmbeddingResponse, parseMemoryVectorPrepareInput,
  isMemoryVectorRunPage,
  parseMemoryVectorProfileInput, parseMemoryVectorReadInput, parseMemoryVectorStartInput, parseMemoryVectorVersionInput,
  type MemoryVectorFinishInput, type MemoryVectorReadInput, type MemoryVectorRun,
} from '../../contracts/memory-vector'
import { parseMemoryBookInput } from '../../contracts/memory'

const RESPONSE_LIMIT = 4 * 1024 * 1024
const VECTOR_RESPONSE_LIMIT = 2 * 1024 * 1024
const VECTOR_TIMEOUT = 120_000
const SSE_BUFFER_LIMIT = 128 * 1024
const GENERATION_TIMEOUT = 180_000
const CHECKPOINT_INTERVAL = 1000
const CHECKPOINT_CHARACTERS = 1024
const CONSUMER_ERRORS = {
  network: '模型网络请求未完成，已保留收到的部分内容。',
  http: '模型接口返回 HTTP 错误，未读取远端错误正文。',
  protocol: '模型返回的流式数据格式无效，已保留可确认的部分内容。',
  response_limit: '模型响应超过 4 MiB 上限，已停止接收并保留部分内容。',
  output_limit: '模型输出超过 60000 字符上限，已停止接收并保留部分内容。',
  unfinished: '模型未正常结束输出。请核对原任务中已接收的内容；不会自动重发。',
  length: '模型因输出预算结束，候选内容尚不完整。',
  content_filter: '模型内容被接口过滤，候选内容尚不完整。',
  unsupported: '模型以不支持的结束原因停止，候选内容尚不完整。',
  timeout: '模型生成超过 180 秒，已停止请求并保留部分内容。',
  checkpoint: '本地进度保存未完成，生成已停止；请检查候选记录。',
  connection: '连接配置或书库已变化，未向模型发送请求。',
} as const

type StreamErrorKind = keyof typeof CONSUMER_ERRORS
class StreamError extends Error {
  constructor(readonly kind: StreamErrorKind) { super(CONSUMER_ERRORS[kind]) }
}
class UncertainWrite extends Error {}
const VECTOR_ERRORS = {
  network: '向量网络请求未完成，请核对当前任务状态后再操作。',
  http: '向量接口返回 HTTP 错误，未读取远端错误正文。',
  protocol: '向量响应格式、数量或维度无效，未保存向量结果。',
  response_limit: '向量响应超过 2 MiB 上限，已停止接收。',
  timeout: '向量请求超过 120 秒，已停止接收。',
  connection: '连接配置或书库已变化，未向向量模型发送请求。',
} as const
class VectorError extends Error {
  constructor(readonly kind: keyof typeof VECTOR_ERRORS) { super(VECTOR_ERRORS[kind]) }
}
interface SessionKey { baseUrl: string; value: string }
interface ActiveRequest {
  root: string; bookId: string; runId: string; service: ServiceClient
  controller: AbortController; stop: 'cancelled' | 'timeout' | null
  done: Promise<void>; complete: () => void
  resultPreflight?: PendingAiPreflight
}
interface UncertainRequest { service: ServiceClient; requestId?: string }
interface ActiveVectorRequest extends ActiveRequest { version: number }
interface PendingConfiguration { root: string; input: AiConfigureInput; service: ServiceClient; requestId: string }
type PendingFinish = {
  root: string; service: ServiceClient; contextHash: string
  submission: { state: 'unsubmitted' } | { state: 'uncertain'; requestId?: string }
  settling?: Promise<Result<null>>
  journal?: PendingAiFile
  resultPreflight?: PendingAiPreflight
} & ({ command: 'ai.finish'; input: AiFinishInput } | { command: 'memory.vector.finish'; input: MemoryVectorFinishInput })

function runScope(root: string, input: AiRunInput): string { return JSON.stringify(['run', root, input.bookId, input.runId]) }
function vectorScope(root: string, input: MemoryVectorReadInput): string { return JSON.stringify(['vector', root, input.bookId, input.runId]) }
function keyScope(root: string, bookId: string, connectionId: string): string { return JSON.stringify(['connection', root, bookId, connectionId]) }
function sameConnection(left: AiConnection, right: AiConnection): boolean {
  return left.id === right.id && left.name === right.name && left.baseUrl === right.baseUrl && left.model === right.model &&
    left.contextWindow === right.contextWindow && left.maxOutputTokens === right.maxOutputTokens &&
    left.version === right.version && left.updatedAt === right.updatedAt
}
function matchesConfiguration(connection: AiConnection, input: AiConfigureInput): boolean {
  const expected = input.connection
  return connection.id === expected.id && connection.name === expected.name && connection.baseUrl === expected.baseUrl &&
    connection.model === expected.model && connection.contextWindow === expected.contextWindow &&
    connection.maxOutputTokens === expected.maxOutputTokens && connection.version === (input.expectedVersion === null ? 0 : input.expectedVersion + 1)
}
function localEndpoint(baseUrl: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)
}
function uncertain(result: Result<unknown>): boolean {
  return !result.ok && (result.error.code === 'REQUEST_TIMEOUT' ||
    (result.error.code === 'SERVICE_UNAVAILABLE' && result.error.requestId !== undefined))
}
function usageOf(value: unknown): AiUsage {
  if (!isRecord(value)) throw new StreamError('protocol')
  const number = (item: unknown): number | null => {
    if (item === null || item === undefined) return null
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) throw new StreamError('protocol')
    return item
  }
  return { inputTokens: number(value.prompt_tokens), outputTokens: number(value.completion_tokens), totalTokens: number(value.total_tokens) }
}
function limitedText(text: string, maximum: number): string {
  let end = Math.min(maximum, text.length)
  const before = text.charCodeAt(end - 1)
  const after = text.charCodeAt(end)
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1
  return text.slice(0, end)
}

export class AiSessions {
  constructor(private readonly workspaceKey?: (root: string, connection: AiConnection) => string | undefined) {}
  sessionKey(root: string, bookId: string, connection: AiConnection): string | undefined {
    const key = this.keys.get(keyScope(root, bookId, connection.id))
    return key?.baseUrl === connection.baseUrl ? key.value : this.workspaceKey?.(root, connection)
  }
  private readonly keys = new Map<string, SessionKey>()
  private keyEpoch = 0
  private readonly uncertainWrites = new Map<string, UncertainRequest>()
  private readonly pendingConfigurations = new Map<string, PendingConfiguration>()
  private active: ActiveRequest | null = null
  private vectorActive: ActiveVectorRequest | null = null
  private configuring = false
  private pendingFinish: PendingFinish | null = null
  private readonly pendingResults = new PendingAiResults()
  private restoringResults: Promise<Result<null>> | null = null
  private restoredRoot: string | null = null
  private recoveryWarning: Result<null> | null = null

  clearSessionKeys(root: string, bookId: string): void {
    this.keyEpoch += 1
    for (const scope of this.keys.keys()) {
      const [, keyRoot, keyBook] = JSON.parse(scope) as [string, string, string, string]
      if (keyRoot === root && keyBook === bookId) this.keys.delete(scope)
    }
    // 释放待确认配置的密钥，保留原请求身份与忙锁，不能把离页解释为写入结束。
    for (const pending of this.pendingConfigurations.values()) {
      if (pending.root === root && pending.input.bookId === bookId) pending.input = { ...pending.input, apiKey: undefined }
    }
  }

  restorePending(service: ServiceClient): Promise<Result<null>> {
    if (this.restoringResults) return this.restoringResults
    const restore = async (): Promise<Result<null>> => {
      const root = service.getWorkspaceRoot()
      if (!root || this.active || this.vectorActive || this.configuring) return { ok: true, data: null }
      try {
        let unresolved: PendingFinish | null = null
        let firstError: Result<null> | null = null
        let warnings = 0
        if (this.pendingFinish) {
          const result = await this.settleFinish(this.pendingFinish, service)
          if (!result.ok) {
            if (!this.pendingFinish?.journal) return result
            unresolved = this.pendingFinish
            firstError = result
          }
        }
        if (!firstError && this.restoredRoot === root) return this.recoveryWarning ?? { ok: true, data: null }
        // 重开后先读取原运行身份和固定上下文，只有仍为 running 的同一记录才补交本地终态。
        for (const entry of this.pendingResults.load(root)) {
          if ('warning' in entry) { warnings += 1; firstError ??= failure('STORAGE_ERROR', entry.warning); continue }
          const file = entry.file
          if (file.payload.command !== 'ai.finish' && file.payload.command !== 'memory.vector.finish') { warnings += 1; firstError ??= failure('STORAGE_ERROR', '原模型留存目录出现其他类型记录，请保留原文件并核对。'); continue }
          const unresolvedFile = unresolved?.journal
          if (unresolvedFile && file.root === unresolvedFile.root && file.id === unresolvedFile.id &&
            file.hash === unresolvedFile.hash && file.volume.id === unresolvedFile.volume.id && file.volume.hash === unresolvedFile.volume.hash) continue
          const pending: PendingFinish = { ...file.payload, root, service, journal: file, submission: { state: 'uncertain' } }
          this.pendingFinish ??= pending
          const result = await this.settleFinish(pending, service)
          if (!result.ok) { unresolved ??= pending; firstError ??= result }
        }
        this.pendingFinish = unresolved
        if (firstError && !firstError.ok) {
          const result: Result<null> = { ok: false, error: { ...firstError.error,
            message: `${firstError.error.message}${warnings ? ` 共 ${warnings} 项残件需人工核对；其他有效文件已继续核对。` : ''}` } }
          // 残件保留并持续提示；已经逐项扫描且没有待提交结果时，不永久封住后续模型工作。
          if (!unresolved) { this.restoredRoot = root; this.recoveryWarning = result }
          return result
        }
        this.restoredRoot = root
        this.recoveryWarning = null
        return { ok: true, data: null }
      } catch (error) {
        return error instanceof DomainError ? { ok: false, error: error.detail }
          : failure('STORAGE_ERROR', '待存模型结果尚未完成核对，请保留书库中的 pending-model-results 目录。')
      }
    }
    this.restoringResults = restore().finally(() => { this.restoringResults = null })
    return this.restoringResults
  }

  savePendingResult(filePath: string): boolean {
    if (this.hasActive(false)) throw new DomainError({ code: 'WORKSPACE_BUSY', message: '模型操作或原保存请求仍在处理，请等待结束后再另存。' })
    const pending = this.pendingFinish
    if (!pending) return false
    // 副本保存原始结果和固定身份，不包含会话密钥；独占写入并同步成功后才解除内存保留。
    const copy = { format: 'storyweave.ai-result', version: 1, createdAt: new Date().toISOString(),
      description: '待存模型结果留存副本；需要核对原记录后手工处理，不会自动导入或再次发送模型。',
      workspaceRoot: pending.root, command: pending.command, contextHash: pending.contextHash,
      submission: pending.submission, input: pending.input }
    writeNewText(filePath, (write) => write(JSON.stringify(copy) + '\n'))
    const confirmed = this.confirmFinish(pending, 'exported')
    if (!confirmed.ok) throw new DomainError(confirmed.error)
    return true
  }

  hasActive(includePendingFinish = true): boolean {
    this.discardUnavailableConfigurations()
    if (this.pendingFinish && !this.pendingFinish.settling) this.checkFinishReceipt(this.pendingFinish)
    const pending = this.pendingFinish
    const submission = pending?.submission
    const awaitingFinishReceipt = pending !== null && submission?.state === 'uncertain' && submission.requestId !== undefined &&
      pending.service.getRequestStatus(submission.requestId).state === 'pending'
    return this.active !== null || this.vectorActive !== null || this.configuring || this.restoringResults !== null ||
      (includePendingFinish && this.pendingFinish !== null) || this.pendingFinish?.settling !== undefined || awaitingFinishReceipt || [...this.uncertainWrites.values()]
      .some((request) => request.requestId !== undefined && request.service.getRequestStatus(request.requestId).state === 'pending') ||
      [...this.pendingConfigurations.values()].some((request) => request.service.getRequestStatus(request.requestId).state === 'pending')
  }

  abortAll(): void {
    this.pendingConfigurations.clear()
    for (const active of [this.active, this.vectorActive]) {
      if (!active) continue
      active.stop = 'cancelled'
      active.controller.abort()
    }
  }

  async handle(command: string, payload: unknown, service: ServiceClient): Promise<Result<unknown>> {
    try {
      this.discardUnavailableConfigurations(service)
      const root = service.getWorkspaceRoot()
      if (!root) return failure('WORKSPACE_REQUIRED', '请先打开本地书库，再使用 AI 协作。')
      const restored = await this.restorePending(service)
      // 个别恢复残件不能封住其他候选的读取入口；生成和采用仍须等待留存结果核对。
      const reading = ['ai.connection.list', 'ai.presets.get', 'ai.list', 'ai.get', 'ai.context.summaries', 'ai.context.recommend',
        'ai.task.status', 'ai.task.maintenance', 'ai.task.get', 'ai.summary.status', 'ai.summary.get', 'ai.summary.node',
        'memory.vector.list', 'memory.vector.status', 'memory.vector.get'].includes(command)
      if (!restored.ok && !reading && (this.pendingFinish || this.restoredRoot !== root)) return restored
      switch (command) {
        case 'ai.presets.get': return await service.request('ai.presets.get', parseGetAiPresetsInput(payload))
        case 'ai.presets.save': return await service.request('ai.presets.save', parseSaveAiPresetInput(payload))
        case 'ai.connection.list': {
          const input = parseAiBookInput(payload)
          const result = await service.request('ai.connection.list', input)
          if (!result.ok) return result
          if (service.getWorkspaceRoot() !== root || result.data.bookId !== input.bookId) return failure('REVISION_CONFLICT', '书库已变化，请重新读取模型连接。')
          return { ok: true, data: this.connectionPage(root, result.data, service) }
        }
        case 'ai.configure': return await this.configure(root, payload, service)
        case 'ai.prepare': {
          const input = parseAiPrepareInput(payload)
          const result = await service.request('ai.connection.list', { bookId: input.bookId })
          if (!result.ok) return result
          if (service.getWorkspaceRoot() !== root || result.data.bookId !== input.bookId) return failure('REVISION_CONFLICT', '书库已变化，请重新预览上下文。')
          this.reconcileConfigurations(root, result.data, service)
          const connection = result.data.connections.find((item) => item.id === input.connectionId)
          if (!connection) return failure('NOT_FOUND', '当前作品中没有这个模型连接，请先保存连接配置。')
          return await service.request('ai.prepare', { ...input, connection: parseAiConnection(connection) })
        }
        case 'ai.list': return await service.request('ai.list', parseAiListInput(payload))
        case 'ai.context.summaries': return await service.request('ai.context.summaries', parseAiContextSummaryInput(payload))
        case 'ai.context.recommend': return await service.request('ai.context.recommend', parseAiContextRecommendationInput(payload))
        case 'ai.get': return await this.get(root, parseAiRunInput(payload), service)
        case 'ai.start': return await this.start(root, payload, service)
        case 'ai.cancel': {
          const input = parseAiRunInput(payload)
          const active = this.activeFor(root, input, service)
          if (!active) {
            const result = await this.get(root, input, service)
            return result.ok && result.data.state === 'running'
              ? failure('FORBIDDEN', '这个运行记录没有本机活动请求，请读取当前候选版本后显式中断。') : result
          }
          active.stop = 'cancelled'
          active.controller.abort()
          await active.done
          return await this.get(root, input, service)
        }
        case 'ai.interrupt': {
          const input = parseAiVersionInput(payload)
          if (this.finishFor(root, input, 'ai.finish')) return failure('WORKSPACE_BUSY', '模型结果仍待保存，请先重新读取候选；中断不会丢弃这份待存结果。')
          if (this.active || this.vectorActive || this.configuring) return failure('WORKSPACE_BUSY', '本机仍有生成或配置操作，请先等待其结束。')
          const scope = runScope(root, input)
          const pending = this.uncertainWrites.get(scope)
          if (pending?.requestId && pending.service.getRequestStatus(pending.requestId).state === 'pending') {
            return { ok: false, error: { code: 'WORKSPACE_BUSY', requestId: pending.requestId, message: '原保存请求仍在处理，请先查询原请求回执，不能提前中断。' } }
          }
          const result = await service.request('ai.interrupt', input)
          if (!result.ok && uncertain(result)) this.uncertainWrites.set(scope, { service, requestId: result.error.requestId })
          else this.uncertainWrites.delete(scope)
          return result
        }
        case 'ai.reject': return await service.request('ai.reject', parseAiVersionInput(payload))
        case 'ai.adopt': return await service.request('ai.adopt', parseAiAdoptInput(payload))
        case 'ai.memory.adopt': return await service.request('ai.memory.adopt', parseAiMemoryAdoptInput(payload))
        case 'ai.task.status': return await service.request('ai.task.status', parseAiBookInput(payload))
        case 'ai.task.maintenance': return await service.request('ai.task.maintenance', parseAiMemoryMaintenanceInput(payload))
        case 'ai.task.get': return await service.request('ai.task.get', parseAiMemoryTaskReadInput(payload))
        case 'ai.task.start': return await service.request('ai.task.start', parseAiMemoryTaskStartInput(payload))
        case 'ai.task.step': return await service.request('ai.task.step', parseAiMemoryTaskInput(payload))
        case 'ai.task.control': return await service.request('ai.task.control', parseAiMemoryTaskControlInput(payload))
        case 'ai.summary.status': return await service.request('ai.summary.status', parseAiBookInput(payload))
        case 'ai.summary.get': return await service.request('ai.summary.get', parseAiSummaryReadInput(payload))
        case 'ai.summary.node': return await service.request('ai.summary.node', parseAiSummaryNodeInput(payload))
        case 'ai.summary.start': return await service.request('ai.summary.start', parseAiSummaryStartInput(payload))
        case 'ai.summary.step': return await service.request('ai.summary.step', parseAiSummaryTaskInput(payload))
        case 'ai.summary.control': return await service.request('ai.summary.control', parseAiSummaryControlInput(payload))
        case 'ai.summary.adopt': return await service.request('ai.summary.adopt', parseAiSummaryAdoptInput(payload))
        case 'memory.vector.list': {
          const input = parseMemoryBookInput(payload)
          const result = await service.request('memory.vector.list', input)
          if (!result.ok) return result
          if (service.getWorkspaceRoot() !== root || !isMemoryVectorRunPage(result.data, input.bookId)) {
            return failure('REVISION_CONFLICT', '向量任务列表或书库身份不符，请重新读取。')
          }
          return { ok: true, data: { ...result.data, runs: result.data.runs.map((run) => ({ ...run,
            active: this.activeVectorFor(root, { bookId: input.bookId, runId: run.id }, service) !== null })) } }
        }
        case 'memory.vector.status': {
          const input = parseMemoryVectorProfileInput(payload)
          const page = await service.request('ai.connection.list', { bookId: input.bookId })
          if (!page.ok) return page
          if (service.getWorkspaceRoot() !== root || page.data.bookId !== input.bookId) return failure('REVISION_CONFLICT', '书库已变化，请重新读取向量状态。')
          this.reconcileConfigurations(root, page.data, service)
          const connection = page.data.connections.find((item) => item.id === input.connectionId)
          if (!connection) return failure('NOT_FOUND', '当前作品中没有这个模型连接，请先保存连接配置。')
          return await service.request('memory.vector.status', { ...input, connection: parseAiConnection(connection) })
        }
        case 'memory.vector.prepare': {
          const input = parseMemoryVectorPrepareInput(payload)
          const page = await service.request('ai.connection.list', { bookId: input.bookId })
          if (!page.ok) return page
          if (service.getWorkspaceRoot() !== root || page.data.bookId !== input.bookId) return failure('REVISION_CONFLICT', '书库已变化，请重新预览向量请求。')
          this.reconcileConfigurations(root, page.data, service)
          const connection = page.data.connections.find((item) => item.id === input.connectionId)
          if (!connection) return failure('NOT_FOUND', '当前作品中没有这个模型连接，请先保存连接配置。')
          const result = await service.request('memory.vector.prepare', { ...input, connection: parseAiConnection(connection) })
          return result.ok ? { ok: true, data: { ...result.data,
            active: this.activeVectorFor(root, { bookId: input.bookId, runId: result.data.id }, service) !== null } } : result
        }
        case 'memory.vector.get': return await this.getVector(root, parseMemoryVectorReadInput(payload), service)
        case 'memory.vector.start': return await this.startVector(root, payload, service)
        case 'memory.vector.cancel': {
          const input = parseMemoryVectorVersionInput(payload)
          const active = this.activeVectorFor(root, input, service)
          if (active) {
            if (active.version !== input.expectedVersion) return failure('REVISION_CONFLICT', '向量任务版本已变化，请重新读取后再取消。')
            active.stop = 'cancelled'
            active.controller.abort()
            await active.done
            return await this.getVector(root, { bookId: input.bookId, runId: input.runId }, service)
          }
          const current = await this.getVector(root, { bookId: input.bookId, runId: input.runId }, service)
          if (!current.ok) return current
          if (current.data.state === 'running') return failure('FORBIDDEN', '这个向量任务没有本机活动请求，请读取当前版本后显式中断。')
          if (current.data.state !== 'prepared') return current
          const result = await service.request('memory.vector.cancel', input)
          if (!result.ok && uncertain(result)) this.uncertainWrites.set(vectorScope(root, input), { service, requestId: result.error.requestId })
          return result.ok ? { ok: true, data: { ...result.data,
            active: this.activeVectorFor(root, { bookId: result.data.bookId, runId: result.data.id }, service) !== null } } : result
        }
        case 'memory.vector.interrupt': {
          const input = parseMemoryVectorVersionInput(payload)
          if (this.finishFor(root, input, 'memory.vector.finish')) return failure('WORKSPACE_BUSY', '向量结果仍待保存，请先读取原请求；中断不会丢弃这份待存结果。')
          if (this.active || this.vectorActive || this.configuring) return failure('WORKSPACE_BUSY', '本机仍有模型请求或配置操作，请先等待其结束。')
          const scope = vectorScope(root, input)
          const pending = this.uncertainWrites.get(scope)
          if (pending?.requestId && pending.service.getRequestStatus(pending.requestId).state === 'pending') {
            return { ok: false, error: { code: 'WORKSPACE_BUSY', requestId: pending.requestId, message: '原向量写入仍在处理，请先查询原请求回执，不能提前中断。' } }
          }
          const result = await service.request('memory.vector.interrupt', input)
          if (!result.ok && uncertain(result)) this.uncertainWrites.set(scope, { service, requestId: result.error.requestId })
          else this.uncertainWrites.delete(scope)
          return result.ok ? { ok: true, data: { ...result.data, active: false } } : result
        }
        default: return failure('INVALID_INPUT', '不支持这个 AI 会话命令。')
      }
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, error: error.detail }
      return failure('STORAGE_ERROR', 'AI 会话操作未完成，请保留当前内容并重新读取候选状态。')
    } finally { this.discardUnavailableConfigurations(service) }
  }

  private activeVectorFor(root: string, input: MemoryVectorReadInput, service: ServiceClient): ActiveVectorRequest | null {
    const active = this.vectorActive
    return active?.root === root && active.bookId === input.bookId && active.runId === input.runId && active.service === service ? active : null
  }

  private finishFor(root: string, input: AiRunInput, command: PendingFinish['command']): PendingFinish | null {
    const pending = this.pendingFinish
    return pending?.root === root && pending.command === command &&
      pending.input.bookId === input.bookId && pending.input.runId === input.runId ? pending : null
  }

  private matchesFinish(pending: PendingFinish, run: AiRun | MemoryVectorRun): boolean {
    if (!isRecord(run) || !isRecord(run.context) || run.bookId !== pending.input.bookId || run.id !== pending.input.runId ||
      run.context.bookId !== pending.input.bookId || run.context.contextHash !== pending.contextHash) return false
    if (pending.command === 'ai.finish') {
      const input = pending.input
      return 'outputText' in run &&
        (run.state === input.state || run.state === 'adopted' || run.state === 'rejected') &&
        run.outputText === input.outputText && run.finishReason === input.finishReason && run.error === input.error &&
        JSON.stringify(run.usage) === JSON.stringify(input.usage)
    }
    // 来源失效时，向量仓储会回滚整批并提交 failed；这也是可核对的最终结果。
    return !('outputText' in run) && run.version === pending.input.expectedVersion + 1 &&
      (run.state === pending.input.state || pending.input.state === 'succeeded' && run.state === 'failed')
  }

  private confirmFinish(pending: PendingFinish, disposition: 'committed' | 'exported' = 'committed'): Result<null> {
    try { if (pending.journal) this.pendingResults.settle(pending.journal, disposition) }
    catch (error) { return failure('STORAGE_ERROR', `模型结果已确认，但留存完成记录尚未写入；原结果仍保留，请重新读取核对。${error instanceof DomainError ? ` ${error.detail.message}` : ''}`) }
    if (this.pendingFinish === pending) this.pendingFinish = null
    const scope = pending.command === 'ai.finish' ? runScope(pending.root, pending.input) : vectorScope(pending.root, pending.input)
    this.uncertainWrites.delete(scope)
    return { ok: true, data: null }
  }

  private settleFinish(pending: PendingFinish, service: ServiceClient, readBeforeSubmit = true): Promise<Result<null>> {
    // 共用一个补存 Promise；取消、轮询和手动读取不能并发重放同一终态。
    if (pending.settling) return pending.settling
    const settling = this.finishAttempt(pending, service, readBeforeSubmit)
      .finally(() => { pending.settling = undefined })
    pending.settling = settling
    return settling
  }

  private checkFinishReceipt(pending: PendingFinish): Result<null> | null {
    if (pending.submission.state === 'uncertain' && pending.submission.requestId) {
      const status = pending.service.getRequestStatus(pending.submission.requestId)
      if (status.state === 'pending') return { ok: false, error: { code: 'REQUEST_TIMEOUT', requestId: pending.submission.requestId,
        message: '模型结果的原保存请求仍在处理，请查询原回执；最终结果已在本次会话保留，不会重复提交。' } }
      if (status.state === 'completed') {
        const response = status.response
        if ((response.command !== 'ai.finish' && response.command !== 'memory.vector.finish') || response.command !== pending.command) {
          return failure('STORAGE_ERROR', '模型保存回执的操作身份不符，已保留待存结果。')
        }
        if (response.result.ok) {
          if (this.matchesFinish(pending, response.result.data)) return this.confirmFinish(pending)
          return failure('STORAGE_ERROR', '模型保存回执与固定结果不符，已保留待存结果，请核对原记录。')
        }
      }
    }
    return null
  }

  private async finishAttempt(pending: PendingFinish, service: ServiceClient, readBeforeSubmit: boolean): Promise<Result<null>> {
    try {
      pending.journal ??= this.pendingResults.save(pending.root,
        pending.command === 'ai.finish' ? { command: pending.command, input: pending.input, contextHash: pending.contextHash }
          : { command: pending.command, input: pending.input, contextHash: pending.contextHash }, pending.resultPreflight)
    } catch (error) {
      return failure('STORAGE_ERROR', `模型终态尚未写入本地待存文件，未提交数据库。请保留窗口、检查磁盘或另存模型结果。${error instanceof DomainError ? ` ${error.detail.message}` : ''}`)
    }
    if (service.getWorkspaceRoot() !== pending.root) return failure('REVISION_CONFLICT', '书库已变化，模型结果仍保留在本次会话中，请先恢复原书库。')
    if (pending.service !== service && !pending.service.hasExited()) {
      return failure('WORKSPACE_BUSY', '原作品服务尚未退出，模型结果仍保留；不能跨服务重放未确认写入。')
    }
    const receipt = this.checkFinishReceipt(pending)
    if (receipt) return receipt
    const scope = pending.command === 'ai.finish' ? runScope(pending.root, pending.input) : vectorScope(pending.root, pending.input)
    const previous = this.uncertainWrites.get(scope)
    if (previous?.requestId && previous.service.getRequestStatus(previous.requestId).state === 'pending') {
      return { ok: false, error: { code: 'REQUEST_TIMEOUT', requestId: previous.requestId,
        message: '模型进度的原写入仍在处理，终态已落盘保留；待原回执结束后再核对补存。' } }
    }
    if (readBeforeSubmit || pending.submission.state === 'uncertain') {
      const current = pending.command === 'ai.finish'
        ? await service.request('ai.get', { bookId: pending.input.bookId, runId: pending.input.runId })
        : await service.request('memory.vector.get', { bookId: pending.input.bookId, runId: pending.input.runId })
      if (!current.ok) return current
      if (this.matchesFinish(pending, current.data)) return this.confirmFinish(pending)
      const run = current.data
      if (service.getWorkspaceRoot() !== pending.root || !isRecord(run) || !isRecord(run.context) || run.bookId !== pending.input.bookId || run.id !== pending.input.runId ||
        run.context.bookId !== pending.input.bookId || run.context.contextHash !== pending.contextHash || run.state !== 'running' ||
        (pending.command === 'ai.finish' ? !('outputText' in run) || typeof run.outputText !== 'string' || !pending.input.outputText.startsWith(run.outputText)
          : run.version !== pending.input.expectedVersion)) {
        return failure('REVISION_CONFLICT', '原记录与待存模型结果不符，已保留结果，请核对原记录后再处理。')
      }
      // 原回执已结束或旧服务已退出，再读取同一运行中的记录，才能确认终态未提交。
      pending.submission = { state: 'unsubmitted' }
    }
    pending.service = service
    pending.submission = { state: 'uncertain' }
    const finished = pending.command === 'ai.finish'
      ? await service.request('ai.finish', pending.input)
      : await service.request('memory.vector.finish', pending.input)
    if (finished.ok) {
      if (this.matchesFinish(pending, finished.data)) return this.confirmFinish(pending)
      return failure('STORAGE_ERROR', '模型保存回执与固定结果不符，已保留待存结果，请重新核对。')
    }
    // BUSY 明确表示未执行；无 requestId 的不可用来自发送前拒绝，其他失败先核对持久化记录。
    if (!finished.error.requestId && (finished.error.code === 'WORKSPACE_BUSY' || finished.error.code === 'SERVICE_UNAVAILABLE')) {
      pending.submission = { state: 'unsubmitted' }
      return { ok: false, error: { ...finished.error, message: `${finished.error.message} 模型最终结果仍保留在本次会话；请稍后读取原请求以补存，不会重发模型。` } }
    }
    pending.submission = { state: 'uncertain', requestId: finished.error.requestId }
    return finished
  }

  private async getVector(root: string, input: MemoryVectorReadInput, service: ServiceClient): Promise<Result<MemoryVectorRun>> {
    const finish = this.finishFor(root, input, 'memory.vector.finish')
    if (finish) {
      const settled = await this.settleFinish(finish, service)
      if (!settled.ok) return settled
    }
    const scope = vectorScope(root, input)
    const pending = this.uncertainWrites.get(scope)
    if (pending?.requestId && pending.service.getRequestStatus(pending.requestId).state === 'pending') {
      return { ok: false, error: { code: 'REQUEST_TIMEOUT', requestId: pending.requestId,
        message: '向量任务的原请求仍在处理，请查询原请求回执；不会重复发送模型请求或重放写入。' } }
    }
    const result = await service.request('memory.vector.get', input)
    if (!result.ok) return result
    if (service.getWorkspaceRoot() !== root || result.data.bookId !== input.bookId || result.data.id !== input.runId) {
      return failure('REVISION_CONFLICT', '向量任务或书库已变化，请重新读取。')
    }
    if (result.data.state !== 'running') this.uncertainWrites.delete(scope)
    return { ok: true, data: { ...result.data, active: this.activeVectorFor(root, input, service) !== null } }
  }

  private rememberVectorUncertain(active: ActiveVectorRequest, requestId?: string): void {
    this.uncertainWrites.set(vectorScope(active.root, { bookId: active.bookId, runId: active.runId }), { service: active.service, requestId })
  }

  private releaseVector(active: ActiveVectorRequest): void {
    if (this.vectorActive === active) this.vectorActive = null
    active.complete()
  }

  private async startVector(root: string, payload: unknown, service: ServiceClient): Promise<Result<MemoryVectorRun>> {
    const input = parseMemoryVectorStartInput(payload)
    if (this.hasActive() || this.configuring) return failure('WORKSPACE_BUSY', '已有模型请求或配置操作正在处理，请先等待、取消或核对原请求。')
    let complete!: () => void
    const active: ActiveVectorRequest = { root, bookId: input.bookId, runId: input.runId, service, version: input.expectedVersion,
      controller: new AbortController(), stop: null, done: new Promise<void>((resolve) => { complete = resolve }), complete: () => complete() }
    // get 和 claim 也占用同一个活动名额，切库及重复启动不能越过待确认写入。
    this.vectorActive = active
    let launched = false
    try {
      const current = await service.request('memory.vector.get', { bookId: input.bookId, runId: input.runId })
      if (!current.ok) return current
      const run = current.data
      if (run.id !== input.runId || run.bookId !== input.bookId || run.context.bookId !== input.bookId ||
        run.state !== 'prepared' || run.version !== input.expectedVersion || run.context.contextHash !== input.contextHash ||
        run.kind !== run.context.kind || run.embeddingModel !== run.context.embeddingModel || run.publicationVersion !== run.context.publicationVersion ||
        !Array.isArray(run.context.input) || run.context.input.length < 1 || run.context.input.length > MEMORY_VECTOR_BATCH_SIZE ||
        run.inputCount !== run.context.input.length || (run.kind === 'search' && run.context.input.length !== 1) ||
        run.context.input.some((text) => typeof text !== 'string' || !text.trim() || text.includes('\0'))) {
        return failure('REVISION_CONFLICT', '向量预览、版本或输入已变化，请重新读取后再开始。')
      }
      const connection = parseAiConnection(run.context.connection)
      const page = await service.request('ai.connection.list', { bookId: input.bookId })
      if (!page.ok) return page
      const saved = page.data.connections.find((item) => item.id === connection.id)
      if (service.getWorkspaceRoot() !== root || page.data.bookId !== input.bookId || !saved || !sameConnection(connection, parseAiConnection(saved))) {
        return failure('REVISION_CONFLICT', '连接配置或书库已变化，请重新预览向量请求。')
      }
      this.reconcileConfigurations(root, page.data, service)
      const key = this.keys.get(keyScope(root, input.bookId, connection.id))
      const apiKey = key?.baseUrl === connection.baseUrl ? key.value : this.workspaceKey?.(root, connection) ?? ''
      if (!localEndpoint(connection.baseUrl) && !apiKey) return failure('FORBIDDEN', '这个远端连接尚无本次应用会话的密钥，请在连接设置中输入后再开始。')
      if (active.controller.signal.aborted) return failure('FORBIDDEN', '向量开始操作已取消，尚未向模型发送请求。')
      // 在 claim 前确认日志可写与磁盘余量；预检失败时仍保持 prepared，不消耗模型请求。
      active.resultPreflight = this.pendingResults.preflight(root)
      const claimed = await service.request('memory.vector.claim', input)
      if (!claimed.ok) {
        if (uncertain(claimed)) this.rememberVectorUncertain(active, claimed.error.requestId)
        return claimed
      }
      if (claimed.data.id !== input.runId || claimed.data.bookId !== input.bookId || claimed.data.state !== 'running' ||
        claimed.data.version !== input.expectedVersion + 1 || JSON.stringify(claimed.data.context) !== JSON.stringify(run.context)) {
        this.rememberVectorUncertain(active)
        return failure('STORAGE_ERROR', '向量开始回执无法核对，请读取当前记录并显式中断，不能重复发送模型请求。')
      }
      active.version = claimed.data.version
      launched = true
      void this.driveVector(active, claimed.data, apiKey).catch(() => {
        active.controller.abort()
        this.rememberVectorUncertain(active)
      }).finally(() => this.releaseVector(active))
      return { ok: true, data: { ...claimed.data, active: true } }
    } finally { if (!launched) this.releaseVector(active) }
  }

  private async driveVector(active: ActiveVectorRequest, run: MemoryVectorRun, apiKey: string): Promise<void> {
    const target = { bookId: active.bookId, runId: active.runId, expectedVersion: run.version }
    let finish: MemoryVectorFinishInput = { ...target, state: 'failed', error: VECTOR_ERRORS.network }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const timer = setTimeout(() => { if (active.stop === null) active.stop = 'timeout'; active.controller.abort() }, VECTOR_TIMEOUT)
    try {
      const connection = parseAiConnection(run.context.connection)
      const page = await active.service.request('ai.connection.list', { bookId: active.bookId })
      if (!page.ok) {
        if (uncertain(page) || page.error.code === 'WORKSPACE_BUSY') {
          this.rememberVectorUncertain(active, page.error.requestId)
          throw new UncertainWrite()
        }
        throw new VectorError('connection')
      }
      const current = page.data.connections.find((item) => item.id === connection.id)
      if (active.service.getWorkspaceRoot() !== active.root || page.data.bookId !== active.bookId ||
        !current || !sameConnection(connection, parseAiConnection(current))) throw new VectorError('connection')
      if (active.controller.signal.aborted) throw new VectorError('network')
      const response = await fetch(`${connection.baseUrl}/embeddings`, {
        method: 'POST', redirect: 'error', signal: active.controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: run.context.embeddingModel, input: run.context.input, encoding_format: 'float' }),
      })
      if (!response.ok) throw new VectorError('http')
      if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new VectorError('protocol')
      const declaredLength = response.headers.get('content-length')
      if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > VECTOR_RESPONSE_LIMIT) throw new VectorError('response_limit')
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const decode = (bytes?: Uint8Array): string => {
        try { return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true }) }
        catch { throw new VectorError('protocol') }
      }
      let receivedBytes = 0
      let body = ''
      while (true) {
        const chunk = await reader.read()
        if (active.controller.signal.aborted) throw new VectorError('network')
        if (chunk.done) { body += decode(); break }
        receivedBytes += chunk.value.byteLength
        if (receivedBytes > VECTOR_RESPONSE_LIMIT) throw new VectorError('response_limit')
        body += decode(chunk.value)
      }
      try {
        finish = { ...target, state: 'succeeded', response: parseMemoryEmbeddingResponse(JSON.parse(body), run.context.input.length) }
      } catch { throw new VectorError('protocol') }
    } catch (error) {
      finish = active.stop === 'cancelled' ? { ...target, state: 'cancelled' } : { ...target, state: 'failed',
        error: VECTOR_ERRORS[active.stop === 'timeout' ? 'timeout' : error instanceof UncertainWrite ? 'connection' : error instanceof VectorError ? error.kind : 'network'] }
    } finally {
      clearTimeout(timer)
      active.controller.abort()
      if (reader) void reader.cancel().catch(() => {})
    }
    if (active.stop === 'cancelled') finish = { ...target, state: 'cancelled' }
    const pending: PendingFinish = { command: 'memory.vector.finish', input: finish, root: active.root,
      service: active.service, contextHash: run.context.contextHash, submission: { state: 'unsubmitted' }, resultPreflight: active.resultPreflight }
    this.pendingFinish = pending
    await this.settleFinish(pending, active.service)
  }

  private discardUnavailableConfigurations(service?: ServiceClient): void {
    for (const [scope, pending] of this.pendingConfigurations) {
      const status = pending.service.getRequestStatus(pending.requestId)
      if (pending.service.hasExited() || (service !== undefined && pending.service !== service) ||
        pending.service.getWorkspaceRoot() !== pending.root || status.state === 'unknown' ||
        (status.state === 'completed' && (status.response.command !== 'ai.connection.save' || !status.response.result.ok))) {
        this.pendingConfigurations.delete(scope)
      }
    }
  }

  private reconcileConfigurations(root: string, page: AiConnectionPage, service: ServiceClient): void {
    this.discardUnavailableConfigurations(service)
    if (service.getWorkspaceRoot() !== root) return
    for (const [scope, pending] of this.pendingConfigurations) {
      if (pending.root !== root || pending.input.bookId !== page.bookId || pending.service !== service) continue
      const status = service.getRequestStatus(pending.requestId)
      if (status.state !== 'completed') continue
      this.pendingConfigurations.delete(scope)
      if (status.response.command !== 'ai.connection.save' || !status.response.result.ok) continue
      // 迟到回执和当前连接须共同匹配原条件保存，才能启用仅存在主进程内存的密钥。
      try {
        const saved = parseAiConnection(status.response.result.data)
        const current = page.connections.find((connection) => connection.id === pending.input.connection.id)
        if (current && matchesConfiguration(saved, pending.input) && sameConnection(saved, parseAiConnection(current))) {
          this.applySessionKey(scope, saved, pending.input.apiKey)
        }
      } catch { /* 无法核对的密钥不启用，作者需重新填写并保存。 */ }
    }
  }

  private applySessionKey(scope: string, connection: AiConnection, apiKey: string | undefined): void {
    // 条件保存确认后才更换会话密钥；接口地址变化不能沿用旧地址的凭据。
    if (apiKey !== undefined) {
      if (apiKey) this.keys.set(scope, { baseUrl: connection.baseUrl, value: apiKey })
      else this.keys.delete(scope)
    } else if (this.keys.get(scope)?.baseUrl !== connection.baseUrl) this.keys.delete(scope)
  }

  private connectionPage(root: string, page: AiConnectionPage, service: ServiceClient): AiConnectionPage {
    this.reconcileConfigurations(root, page, service)
    return { ...page, sessionKeyIds: page.connections.filter((connection) => {
      const scope = keyScope(root, page.bookId, connection.id)
      const key = this.keys.get(scope)
      if (key && key.baseUrl !== connection.baseUrl) this.keys.delete(scope)
      return (key !== undefined && key.baseUrl === connection.baseUrl && key.value.length > 0) || Boolean(this.workspaceKey?.(root, connection))
    }).map((connection) => connection.id) }
  }

  private async configure(root: string, payload: unknown, service: ServiceClient): Promise<Result<AiConnectionPage>> {
    const input = parseAiConfigureInput(payload)
    if (this.hasActive() || this.configuring) return failure('WORKSPACE_BUSY', '生成或配置操作尚未结束，请稍后再保存连接。')
    this.configuring = true
    const keyEpoch = this.keyEpoch
    try {
      const page = await service.request('ai.connection.list', { bookId: input.bookId })
      if (!page.ok) return page
      if (service.getWorkspaceRoot() !== root || page.data.bookId !== input.bookId) return failure('REVISION_CONFLICT', '书库已变化，请重新读取模型连接。')
      this.reconcileConfigurations(root, page.data, service)
      const scope = keyScope(root, input.bookId, input.connection.id)
      // 新保存前结束同一连接的旧密钥待确认状态，旧回执不能覆盖之后的配置。
      this.pendingConfigurations.delete(scope)
      const { apiKey, ...save } = input
      const saved = await service.request('ai.connection.save', save)
      if (!saved.ok) {
        if (saved.error.code === 'REQUEST_TIMEOUT' && saved.error.requestId && !service.hasExited()) {
          this.pendingConfigurations.set(scope, { root, input: keyEpoch === this.keyEpoch ? input : { ...input, apiKey: undefined },
            service, requestId: saved.error.requestId })
          this.discardUnavailableConfigurations(service)
        }
        return saved
      }
      const connection = parseAiConnection(saved.data)
      if (service.getWorkspaceRoot() !== root || !matchesConfiguration(connection, input)) {
        return failure('STORAGE_ERROR', '连接保存回执无法核对，请重新读取配置后再输入会话密钥。')
      }
      if (keyEpoch === this.keyEpoch) this.applySessionKey(scope, connection, apiKey)
      return { ok: true, data: this.connectionPage(root, { ...page.data,
        connections: [...page.data.connections.filter((item) => item.id !== connection.id), connection] }, service) }
    } finally { this.configuring = false }
  }

  private activeFor(root: string, input: AiRunInput, service: ServiceClient): ActiveRequest | null {
    const active = this.active
    return active?.root === root && active.bookId === input.bookId && active.runId === input.runId && active.service === service ? active : null
  }

  private async get(root: string, input: AiRunInput, service: ServiceClient): Promise<Result<AiRun>> {
    const finish = this.finishFor(root, input, 'ai.finish')
    if (finish) {
      const settled = await this.settleFinish(finish, service)
      if (!settled.ok) return settled
    }
    const pending = this.uncertainWrites.get(runScope(root, input))
    if (pending?.requestId && pending.service.getRequestStatus(pending.requestId).state === 'pending') {
      return { ok: false, error: { code: 'REQUEST_TIMEOUT', requestId: pending.requestId,
        message: '候选的原写入仍在处理，请先查询该请求回执；不会重复提交或提前中断。' } }
    }
    const result = await service.request('ai.get', input)
    if (result.ok && result.data.state !== 'running') this.uncertainWrites.delete(runScope(root, input))
    return result.ok ? { ok: true, data: { ...result.data, active: this.activeFor(root, input, service) !== null } } : result
  }

  private async start(root: string, payload: unknown, service: ServiceClient): Promise<Result<AiRun>> {
    const input = parseAiStartInput(payload)
    if (this.hasActive() || this.configuring) return failure('WORKSPACE_BUSY', '已有生成或配置操作正在处理，请先等待、取消或核对原请求。')
    let complete!: () => void
    const active: ActiveRequest = { root, bookId: input.bookId, runId: input.runId, service,
      controller: new AbortController(), stop: null, done: new Promise<void>((resolve) => { complete = resolve }), complete: () => complete() }
    // 读取和 claim 也占用活动名额，防止等待写入时切库或重复启动同一候选。
    this.active = active
    let launched = false
    try {
      const current = await service.request('ai.get', { bookId: input.bookId, runId: input.runId })
      if (!current.ok) return current
      const run = current.data
      if (run.id !== input.runId || run.bookId !== input.bookId || run.context.bookId !== input.bookId ||
        run.context.contextHash !== input.contextHash || run.version !== input.expectedVersion || run.state !== 'prepared') {
        return failure('REVISION_CONFLICT', '候选预览或版本已变化，请重新读取后再开始。')
      }
      const connection = parseAiConnection(run.context.connection)
      const page = await service.request('ai.connection.list', { bookId: input.bookId })
      if (!page.ok) return page
      const saved = page.data.connections.find((item) => item.id === connection.id)
      if (page.data.bookId !== input.bookId || !saved || !sameConnection(connection, parseAiConnection(saved)) || service.getWorkspaceRoot() !== root) {
        return failure('REVISION_CONFLICT', '连接配置或书库已变化，请重新预览上下文。')
      }
      this.reconcileConfigurations(root, page.data, service)
      const key = this.keys.get(keyScope(root, input.bookId, connection.id))
      const apiKey = key?.baseUrl === connection.baseUrl ? key.value : this.workspaceKey?.(root, connection) ?? ''
      if (!localEndpoint(connection.baseUrl) && !apiKey) return failure('FORBIDDEN', '这个远端连接尚无本次应用会话的密钥，请在连接设置中输入后再开始。')
      if (active.controller.signal.aborted) return failure('FORBIDDEN', '开始操作已取消，尚未向模型发送请求。')
      // 先确认终态留存能力，再将候选置为 running；不把日志容量问题留到模型返回后。
      active.resultPreflight = this.pendingResults.preflight(root)
      const claimed = await service.request('ai.claim', input)
      if (!claimed.ok) {
        if (uncertain(claimed)) this.rememberUncertain(active, claimed.error.requestId)
        return claimed
      }
      if (claimed.data.id !== input.runId || claimed.data.bookId !== input.bookId || claimed.data.state !== 'running' ||
        claimed.data.context.contextHash !== input.contextHash || !sameConnection(connection, parseAiConnection(claimed.data.context.connection))) {
        this.rememberUncertain(active)
        return failure('STORAGE_ERROR', '候选开始回执无法核对，请读取当前记录并显式中断，不能重复发送模型请求。')
      }
      launched = true
      void this.drive(active, claimed.data, apiKey).catch(() => {
        active.controller.abort()
        this.rememberUncertain(active)
      }).finally(() => this.release(active))
      return { ok: true, data: { ...claimed.data, active: true } }
    } finally { if (!launched) this.release(active) }
  }

  private release(active: ActiveRequest): void {
    if (this.active === active) this.active = null
    active.complete()
  }

  private rememberUncertain(active: ActiveRequest, requestId?: string): void {
    this.uncertainWrites.set(runScope(active.root, { bookId: active.bookId, runId: active.runId }), { service: active.service, requestId })
  }

  private async drive(active: ActiveRequest, run: AiRun, apiKey: string): Promise<void> {
    let outputText = ''
    let pendingSurrogate = ''
    let usage: AiUsage | null = null
    const streamState: { finishReason: string | null } = { finishReason: null }
    let terminalState: AiFinishInput['state'] = 'failed'
    let error: string | null = null
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let lastCheckpoint = Date.now()
    let savedCharacters = 0
    const timer = setTimeout(() => { if (active.stop === null) active.stop = 'timeout'; active.controller.abort() }, GENERATION_TIMEOUT)
    try {
      const connection = parseAiConnection(run.context.connection)
      const page = await active.service.request('ai.connection.list', { bookId: active.bookId })
      if (!page.ok) {
        if (uncertain(page) || page.error.code === 'WORKSPACE_BUSY') {
          this.rememberUncertain(active, page.error.requestId)
          throw new UncertainWrite()
        }
        throw new StreamError('connection')
      }
      const current = page.data.connections.find((item) => item.id === connection.id)
      if (active.service.getWorkspaceRoot() !== active.root || page.data.bookId !== active.bookId ||
        !current || !sameConnection(connection, parseAiConnection(current))) throw new StreamError('connection')
      if (active.controller.signal.aborted) throw new StreamError('network')
      const response = await fetch(`${connection.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: active.controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: connection.model, messages: run.context.messages, stream: true,
          stream_options: { include_usage: true }, max_completion_tokens: connection.maxOutputTokens, n: 1 }),
      })
      if (!response.ok) throw new StreamError('http')
      if (!response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new StreamError('protocol')
      const declaredLength = response.headers.get('content-length')
      if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > RESPONSE_LIMIT) throw new StreamError('response_limit')
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let receivedBytes = 0
      let lineBuffer = ''
      let eventData = ''
      let eventBytes = 0
      let hasData = false
      let skipLf = false
      let done = false
      const event = () => {
        if (!hasData) return
        const data = eventData
        eventData = ''; eventBytes = 0; hasData = false
        if (data === '[DONE]') {
          if (pendingSurrogate) throw new StreamError('protocol')
          done = true
          return
        }
        if (!data) return
        let value: unknown
        try { value = JSON.parse(data) } catch { throw new StreamError('protocol') }
        if (!isRecord(value) || value.error !== undefined || !Array.isArray(value.choices) || value.choices.length > 1) throw new StreamError('protocol')
        if (value.usage !== undefined && value.usage !== null) usage = usageOf(value.usage)
        if (value.choices.length === 0) {
          if (value.usage === undefined || value.usage === null) throw new StreamError('protocol')
          return
        }
        const choice = value.choices[0]
        if (!isRecord(choice) || (choice.index !== undefined && choice.index !== 0) || !isRecord(choice.delta)) throw new StreamError('protocol')
        if (typeof choice.delta.refusal === 'string' && choice.delta.refusal.length > 0) throw new StreamError('content_filter')
        const delta = choice.delta.content
        if (delta !== undefined && delta !== null) {
          if (typeof delta !== 'string' || delta.includes('\0') || (streamState.finishReason !== null && delta.length > 0)) throw new StreamError('protocol')
          // JSON 允许代理对分布在相邻 delta；暂存末尾高代理字符，检查点只写完整字符。
          const combined = pendingSurrogate + delta
          const last = combined.charCodeAt(combined.length - 1)
          pendingSurrogate = last >= 0xd800 && last <= 0xdbff ? combined.slice(-1) : ''
          const complete = pendingSurrogate ? combined.slice(0, -1) : combined
          for (const character of complete) {
            const code = character.charCodeAt(0)
            if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) throw new StreamError('protocol')
          }
          if (outputText.length + complete.length > AI_OUTPUT_LIMIT) {
            outputText += limitedText(complete, AI_OUTPUT_LIMIT - outputText.length)
            throw new StreamError('output_limit')
          }
          outputText += complete
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== 'string' || streamState.finishReason !== null || pendingSurrogate) throw new StreamError('protocol')
          streamState.finishReason = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice.finish_reason) ? choice.finish_reason : 'unsupported'
        }
      }
      const line = () => {
        const text = lineBuffer
        lineBuffer = ''
        if (text === '') { event(); return }
        if (text.startsWith(':')) return
        const separator = text.indexOf(':')
        const name = separator === -1 ? text : text.slice(0, separator)
        if (name !== 'data') return
        let data = separator === -1 ? '' : text.slice(separator + 1)
        if (data.startsWith(' ')) data = data.slice(1)
        eventBytes += Buffer.byteLength(data, 'utf8') + 1
        if (eventBytes > SSE_BUFFER_LIMIT) throw new StreamError('protocol')
        eventData += `${hasData ? '\n' : ''}${data}`
        hasData = true
      }
      const feed = (text: string) => {
        let offset = 0
        while (offset < text.length && !done) {
          if (skipLf) { skipLf = false; if (text[offset] === '\n') { offset += 1; continue } }
          const lf = text.indexOf('\n', offset)
          const cr = text.indexOf('\r', offset)
          const end = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr)
          const part = text.slice(offset, end === -1 ? text.length : end)
          if (lineBuffer.length + part.length > SSE_BUFFER_LIMIT) throw new StreamError('protocol')
          const buffered = lineBuffer + part
          if (Buffer.byteLength(buffered, 'utf8') > SSE_BUFFER_LIMIT) throw new StreamError('protocol')
          lineBuffer = buffered
          if (end === -1) return
          skipLf = text[end] === '\r'
          line()
          offset = end + 1
        }
      }
      const decode = (bytes?: Uint8Array) => {
        try { return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true }) }
        catch { throw new StreamError('protocol') }
      }
      const checkpoint = async () => {
        if (active.service.getWorkspaceRoot() !== active.root) {
          this.rememberUncertain(active)
          throw new UncertainWrite()
        }
        // 每次确认保存后再继续读取，超时写入不重放，也不能接着提交另一个终态写入。
        const result = await active.service.request('ai.checkpoint', { bookId: active.bookId, runId: active.runId, outputText })
        if (!result.ok) {
          if (uncertain(result) || (result.error.requestId !== undefined &&
            (result.error.code === 'WORKSPACE_BUSY' || result.error.code === 'SERVICE_UNAVAILABLE'))) {
            this.rememberUncertain(active, result.error.requestId)
            throw new UncertainWrite()
          }
          // 明确未提交的检查点停止生成，并携带已收到文本进入终态保存／补存。
          throw new StreamError('checkpoint')
        }
        if (result.data.bookId !== active.bookId || result.data.id !== active.runId ||
          result.data.state !== 'running' || result.data.outputText !== outputText) {
          this.rememberUncertain(active)
          throw new UncertainWrite()
        }
        savedCharacters = outputText.length
        lastCheckpoint = Date.now()
      }
      let pendingChunk = reader.read()
      while (!done) {
        let tickTimer: ReturnType<typeof setTimeout> | undefined
        // 对方停顿也保留已收到的内容；始终只有一个 reader.read 和一个待确认检查点。
        const next = outputText.length - savedCharacters >= CHECKPOINT_CHARACTERS
          ? await (async () => {
            try {
              return await Promise.race([
                pendingChunk.then((chunk) => ({ kind: 'chunk' as const, chunk })),
                new Promise<{ kind: 'checkpoint' }>((resolve) => {
                  tickTimer = setTimeout(() => resolve({ kind: 'checkpoint' }), Math.max(0, CHECKPOINT_INTERVAL - (Date.now() - lastCheckpoint)))
                }),
              ])
            } finally { if (tickTimer !== undefined) clearTimeout(tickTimer) }
          })()
          : { kind: 'chunk' as const, chunk: await pendingChunk }
        if (next.kind === 'checkpoint') { await checkpoint(); continue }
        const chunk = next.chunk
        if (chunk.done) { feed(decode()); break }
        receivedBytes += chunk.value.byteLength
        if (receivedBytes > RESPONSE_LIMIT) throw new StreamError('response_limit')
        feed(decode(chunk.value))
        if (active.controller.signal.aborted) throw new StreamError('network')
        if (!done && Date.now() - lastCheckpoint >= CHECKPOINT_INTERVAL && outputText.length - savedCharacters >= CHECKPOINT_CHARACTERS) {
          await checkpoint()
        }
        if (!done) pendingChunk = reader.read()
      }
      const finishReason = streamState.finishReason
      if (!done || !outputText.trim() || finishReason !== 'stop') {
        throw new StreamError(finishReason === 'length' ? 'length' : finishReason === 'content_filter' ? 'content_filter' :
          finishReason !== null && finishReason !== 'stop' ? 'unsupported' : 'unfinished')
      }
      terminalState = 'succeeded'
    } catch (failure) {
      // 检查点回执未知也必须留存已经收到的尾部；补存时先核对原请求与数据库，不重发模型。
      if (failure instanceof UncertainWrite) error = CONSUMER_ERRORS.checkpoint
      else if (active.stop === 'cancelled') { terminalState = 'cancelled'; error = null }
      else error = CONSUMER_ERRORS[active.stop === 'timeout' ? 'timeout' : failure instanceof StreamError ? failure.kind : 'network']
    } finally {
      clearTimeout(timer)
      // 终止远端传输与读取；取消 body 的拒绝也不把原始网络异常传给界面或日志。
      active.controller.abort()
      if (reader) void reader.cancel().catch(() => {})
    }
    if (active.stop === 'cancelled') { terminalState = 'cancelled'; error = null }
    // 最终 payload 先写入书库留存文件，再提交业务进程；失败时继续保留内存和落盘原件。
    const pending: PendingFinish = { command: 'ai.finish', root: active.root, service: active.service,
      contextHash: run.context.contextHash, submission: { state: 'unsubmitted' }, resultPreflight: active.resultPreflight,
      input: { bookId: active.bookId, runId: active.runId, state: terminalState, outputText, usage, finishReason: streamState.finishReason, error } }
    this.pendingFinish = pending
    await this.settleFinish(pending, active.service)
  }
}
