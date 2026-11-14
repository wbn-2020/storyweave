import type { ReadableStreamDefaultReader } from 'node:stream/web'
import { DomainError, failure, isRecord, type Result } from '../../contracts/api'
import type { AiConnection, AiUsage } from '../../contracts/ai'
import {
  GENERATION_OUTPUT_LIMIT, parseGenerationAdoptInput, parseGenerationPrepareInput, parseGenerationReadInput,
  parseGenerationSelectionInput, parseGenerationStartInput, parseGenerationVersionInput, parseKickstartDraftInput,
  parseStudioAiConnectionInput, type GenerationFinishInput, type GenerationRun,
} from '../../contracts/generation'
import { writeNewText } from '../file-access'
import { PendingAiResults, type PendingAiFile, type PendingAiPreflight } from './pending-ai-results'
import type { ServiceClient } from './service-client'

interface ActiveGeneration { root: string; bookId: string; runId: string; service: ServiceClient; controller: AbortController; cancelled: boolean; preflight: PendingAiPreflight }
interface PendingGeneration { root: string; contextHash: string; input: GenerationFinishInput; file?: PendingAiFile }
interface UncertainRequest { service: ServiceClient; requestId: string }
const RESPONSE_BYTES = 4 * 1024 * 1024
const EVENT_BYTES = 128 * 1024
const TIMEOUT = 180_000
const keyScope = (root: string, id: string) => JSON.stringify([root, id])
const localEndpoint = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)

export class GenerationSessions {
  private readonly keys = new Map<string, { baseUrl: string; value: string }>()
  private keyEpoch = 0
  private readonly journal = new PendingAiResults('pending-generation-results')
  private active: ActiveGeneration | null = null
  private pending: PendingGeneration | null = null
  private uncertain: UncertainRequest | null = null
  private working = false
  private restoring: Promise<Result<null>> | null = null
  private restoredRoot: string | null = null

  sessionKey(root: string, connection: AiConnection): string | undefined {
    const key = this.keys.get(keyScope(root, connection.id))
    return key?.baseUrl === connection.baseUrl ? key.value : undefined
  }
  clearSessionKeys(root: string): void {
    this.keyEpoch += 1
    for (const scope of this.keys.keys()) {
      if ((JSON.parse(scope) as [string, string])[0] === root) this.keys.delete(scope)
    }
  }
  hasActive(includePending = true): boolean { this.resolveUncertain(); return this.active !== null || this.working || this.restoring !== null || this.uncertain !== null || (includePending && this.pending !== null) }
  abortAll(): void { this.active?.controller.abort() }
  savePendingResult(path: string): boolean {
    const pending = this.pending
    if (!pending) return false
    if (this.active || this.uncertain || this.working) throw new DomainError({ code: 'WORKSPACE_BUSY', message: '请先等待开书生成或原请求结束。' })
    writeNewText(path, (write) => write(JSON.stringify({ format: 'storyweave.generation-result', version: 1, workspaceRoot: pending.root,
      contextHash: pending.contextHash, input: pending.input, createdAt: new Date().toISOString() }) + '\n'))
    if (pending.file) this.journal.settle(pending.file, 'exported')
    this.pending = null
    return true
  }

  restorePending(service: ServiceClient): Promise<Result<null>> {
    if (this.restoring) return this.restoring
    const restore = async (): Promise<Result<null>> => {
      const root = service.getWorkspaceRoot()
      if (!root || this.active || this.working) return { ok: true, data: null }
      if (!this.resolveUncertain()) return failure('WORKSPACE_BUSY', '开书原写入尚未确认，请先核对原请求。')
      try {
        if (this.pending) {
          if (this.pending.root !== root) return failure('WORKSPACE_BUSY', '另一书库的开书结果尚待保存，请先返回原书库核对。')
          const settled = await this.settle(this.pending, service)
          if (!settled.ok) return settled
        }
        if (this.restoredRoot === root) return { ok: true, data: null }
        let firstError: Result<null> | null = null
        for (const entry of this.journal.load(root)) {
          if ('warning' in entry) { firstError ??= failure('STORAGE_ERROR', entry.warning); continue }
          if (entry.file.payload.command !== 'generation.finish') { firstError ??= failure('STORAGE_ERROR', '开书留存目录出现其他类型记录，请保留并核对。'); continue }
          const pending = { root, contextHash: entry.file.payload.contextHash, input: entry.file.payload.input, file: entry.file }
          this.pending = pending
          const result = await this.settle(pending, service)
          if (!result.ok) return result
        }
        if (!firstError) this.restoredRoot = root
        return firstError ?? { ok: true, data: null }
      } catch (error) { return error instanceof DomainError ? { ok: false, error: error.detail } : failure('STORAGE_ERROR', '开书结果尚未补存，请保留 pending-generation-results 目录。') }
    }
    this.restoring = restore().finally(() => { this.restoring = null })
    return this.restoring
  }

  async handle(command: string, payload: unknown, service: ServiceClient): Promise<Result<unknown>> {
    const root = service.getWorkspaceRoot()
    if (!root) return failure('WORKSPACE_REQUIRED', '请先选择作品库。')
    try {
      if (!this.resolveUncertain()) return failure('WORKSPACE_BUSY', '开书原请求仍在处理，请稍后读取核对。')
      switch (command) {
        case 'generation.connections': {
          if (payload !== undefined) return failure('INVALID_INPUT', '模型连接列表不接受参数。')
          const result = await service.request('generation.connections', undefined)
          if (!result.ok) return result
          if (service.getWorkspaceRoot() !== root) return failure('REVISION_CONFLICT', '作品库已切换，请重新读取连接。')
          return { ok: true, data: { ...result.data, sessionKeyIds: result.data.connections.filter((connection) => this.sessionKey(root, connection) !== undefined).map((connection) => connection.id) } }
        }
        case 'generation.configure': {
          if (this.hasActive()) return failure('WORKSPACE_BUSY', '请先结束或核对当前开书请求。')
          const input = parseStudioAiConnectionInput(payload), { apiKey, ...configuration } = input
          const keyEpoch = this.keyEpoch
          this.working = true
          try {
            const result = await service.request('generation.connection.save', configuration)
            if (!result.ok) { this.remember(result, service); return result }
            if (service.getWorkspaceRoot() !== root) return failure('REVISION_CONFLICT', '作品库已变化，请重新读取配置。')
            const scope = keyScope(root, result.data.id)
            // 离页后仍可确认配置写入，但迟到回执不能重新启用该页的密钥。
            if (keyEpoch !== this.keyEpoch) return result
            if (apiKey !== undefined) {
              if (apiKey) this.keys.set(scope, { baseUrl: result.data.baseUrl, value: apiKey })
              else this.keys.delete(scope)
            } else if (this.keys.get(scope)?.baseUrl !== result.data.baseUrl) this.keys.delete(scope)
            return result
          } finally { this.working = false }
        }
        case 'generation.draft':
        case 'generation.prepare':
        case 'generation.select':
        case 'generation.adopt': {
          if (this.hasActive()) return failure('WORKSPACE_BUSY', '请先结束当前生成或核对待存结果。')
          this.working = true
          try {
            const result = command === 'generation.draft' ? await service.request(command, parseKickstartDraftInput(payload))
              : command === 'generation.prepare' ? await service.request(command, parseGenerationPrepareInput(payload))
              : command === 'generation.select' ? await service.request(command, parseGenerationSelectionInput(payload))
              : await service.request(command, parseGenerationAdoptInput(payload))
            this.remember(result, service)
            return result
          } finally { this.working = false }
        }
        case 'generation.get': {
          const input = parseGenerationReadInput(payload)
          let recoveryWarning: string | undefined
          if (!this.active) {
            const restored = await this.restorePending(service)
            if (!restored.ok) recoveryWarning = restored.error.message
          }
          const result = await service.request('generation.get', input)
          // 留存故障不能封住已保存的候选；未补存终态时也不能自动改写原 running 记录。
          if (result.ok && recoveryWarning) return { ok: true, data: { ...result.data, recoveryWarning } }
          if (!result.ok || !result.data.run || result.data.run.state !== 'running') return result
          const run = result.data.run
          if (this.active?.root === root && this.active.bookId === run.bookId && this.active.runId === run.id && this.active.service === service) return result
          const interrupted = await service.request('generation.interrupt', { bookId: run.bookId, runId: run.id, expectedVersion: run.version })
          return interrupted.ok ? { ok: true, data: { ...result.data, run: interrupted.data } } : interrupted
        }
        case 'generation.start': {
          if (this.hasActive()) return failure('WORKSPACE_BUSY', '已有开书请求或待存结果，请先核对。')
          const input = parseGenerationStartInput(payload)
          this.working = true
          try {
            const current = await service.request('generation.get', { bookId: input.bookId, runId: input.runId })
            if (!current.ok) return current
            const run = current.data.run
            if (!run || run.state !== 'prepared' || run.version !== input.expectedVersion || run.contextHash !== input.contextHash) return failure('REVISION_CONFLICT', '请读取并确认当前发送预览。')
            const apiKey = this.sessionKey(root, run.connection)
            if (!apiKey && !localEndpoint(run.connection.baseUrl)) return failure('FORBIDDEN', '请在工作区模型配置中输入本次会话密钥。')
            const preflight = this.journal.preflight(root)
            const claimed = await service.request('generation.claim', input)
            if (!claimed.ok) { this.remember(claimed, service); return claimed }
            if (service.getWorkspaceRoot() !== root) return failure('REVISION_CONFLICT', '作品库已切换，本次未请求模型。')
            const active: ActiveGeneration = { root, bookId: run.bookId, runId: run.id, service, controller: new AbortController(), cancelled: false, preflight }
            this.active = active
            void this.drive(active, claimed.data, apiKey ?? '').finally(() => { if (this.active === active) this.active = null })
            return claimed
          } finally { this.working = false }
        }
        case 'generation.cancel': {
          const input = parseGenerationVersionInput(payload), active = this.active
          if (active && active.root === root && active.bookId === input.bookId && active.runId === input.runId && active.service === service) {
            active.cancelled = true
            active.controller.abort()
          }
          const result = await service.request('generation.get', { bookId: input.bookId, runId: input.runId })
          if (!result.ok) return result
          const run = result.data.run
          if (!run) return failure('NOT_FOUND', '未找到需要中止的开书尝试。')
          if (!active && run.state === 'running') {
            if (this.pending?.input.runId === run.id) return failure('WORKSPACE_BUSY', '完整结果尚待补存，请重新读取，或关闭窗口时另存完整结果后核对。')
            return await service.request('generation.interrupt', { bookId: run.bookId, runId: run.id, expectedVersion: run.version })
          }
          return { ok: true, data: run }
        }
        default: return failure('INVALID_INPUT', '开书命令不受支持。')
      }
    } catch (error) { return error instanceof DomainError ? { ok: false, error: error.detail } : failure('STORAGE_ERROR', '开书操作未确认，请保留草稿并重新读取。') }
  }

  private remember(result: Result<unknown>, service: ServiceClient): void {
    if (!result.ok && result.error.requestId && ['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(result.error.code)) this.uncertain = { service, requestId: result.error.requestId }
  }
  private resolveUncertain(): boolean {
    if (!this.uncertain) return true
    if (this.uncertain.service.getRequestStatus(this.uncertain.requestId).state === 'pending') return false
    this.uncertain = null
    return true
  }
  private async settle(pending: PendingGeneration, service: ServiceClient): Promise<Result<null>> {
    if (service.getWorkspaceRoot() !== pending.root) return failure('REVISION_CONFLICT', '待存结果不属于当前书库。')
    if (!this.resolveUncertain()) return failure('WORKSPACE_BUSY', '原保存仍待回执，未重复提交。')
    if (!pending.file) pending.file = this.journal.save(pending.root, { command: 'generation.finish', contextHash: pending.contextHash, input: pending.input })
    const current = await service.request('generation.get', { bookId: pending.input.bookId, runId: pending.input.runId })
    if (!current.ok) return current
    const run = current.data.run
    if (!run || run.contextHash !== pending.contextHash) return failure('STORAGE_ERROR', '开书结果的原输入身份不匹配，请保留留存文件。')
    if (run.state === 'running') {
      const result = await service.request('generation.finish', { ...pending.input, expectedVersion: run.version })
      if (!result.ok) { this.remember(result, service); return result }
      if (result.data.outputText !== pending.input.outputText) return failure('STORAGE_ERROR', '开书终态未完整保存，请保留留存文件。')
    } else if (run.outputText !== pending.input.outputText) return failure('REVISION_CONFLICT', '原提案终态与留存结果不同，需人工核对。')
    this.journal.settle(pending.file, 'committed')
    if (this.pending === pending) this.pending = null
    return { ok: true, data: null }
  }

  private async drive(active: ActiveGeneration, initial: GenerationRun, apiKey: string): Promise<void> {
    let run = initial, outputText = '', pendingHigh = '', usage: AiUsage | null = null
    let state: GenerationFinishInput['state'] = 'failed', error: string | null = null, timedOut = false
    let lastCheckpoint = Date.now(), savedCharacters = 0
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const timer = setTimeout(() => { timedOut = true; active.controller.abort() }, TIMEOUT)
    const protocol = () => new Error('模型返回的流格式不完整或不受支持，已保留收到的内容。')
    try {
      const response = await fetch(`${run.connection.baseUrl}/chat/completions`, { method: 'POST', redirect: 'error', signal: active.controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: run.connection.model, messages: run.messages, max_tokens: run.connection.maxOutputTokens, stream: true, stream_options: { include_usage: true }, n: 1 }) })
      if (!response.ok) throw new Error(`模型请求返回 HTTP ${response.status}，未读取远端错误正文。`)
      if (!response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw protocol()
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let buffer = '', eventData = '', received = 0, doneMarker = false, finishReason: string | null = null
      const append = (delta: string) => {
        let text = pendingHigh + delta
        pendingHigh = ''
        const last = text.charCodeAt(text.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) { pendingHigh = text.slice(-1); text = text.slice(0, -1) }
        for (let index = 0; index < text.length; index++) {
          const code = text.charCodeAt(index)
          if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) throw protocol() }
          else if (code >= 0xdc00 && code <= 0xdfff) throw protocol()
        }
        if (text.includes('\0') || outputText.length + text.length > GENERATION_OUTPUT_LIMIT) throw new Error('开书输出超过限制或含无效字符，已停止接收。')
        outputText += text
      }
      const event = () => {
        if (!eventData) return
        const text = eventData; eventData = ''
        if (doneMarker) throw protocol()
        if (text === '[DONE]') { doneMarker = true; return }
        const value: unknown = JSON.parse(text)
        if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length > 1) throw protocol()
        if (value.usage !== undefined && value.usage !== null) {
          if (!isRecord(value.usage)) throw protocol()
          const count = (v: unknown): number | null => { if (v === undefined || v === null) return null; if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw protocol(); return v }
          usage = { inputTokens: count(value.usage.prompt_tokens), outputTokens: count(value.usage.completion_tokens), totalTokens: count(value.usage.total_tokens) }
        }
        if (!value.choices.length) return
        const choice = value.choices[0]
        if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.delta) || choice.delta.tool_calls !== undefined || choice.delta.function_call !== undefined) throw protocol()
        if (choice.delta.content !== undefined && choice.delta.content !== null) {
          if (typeof choice.delta.content !== 'string' || (finishReason !== null && choice.delta.content.length > 0)) throw protocol()
          append(choice.delta.content)
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (finishReason !== null || typeof choice.finish_reason !== 'string') throw protocol()
          finishReason = choice.finish_reason
        }
      }
      const line = (text: string) => {
        if (!text) { event(); return }
        if (text.startsWith(':')) return
        const colon = text.indexOf(':')
        if (colon < 0 || text.slice(0, colon) !== 'data') return
        let data = text.slice(colon + 1)
        if (data.startsWith(' ')) data = data.slice(1)
        eventData += (eventData ? '\n' : '') + data
        if (Buffer.byteLength(eventData, 'utf8') > EVENT_BYTES) throw protocol()
      }
      const consume = (flush: boolean) => {
        let start = 0
        for (let index = 0; index < buffer.length; index++) {
          if (buffer[index] !== '\r' && buffer[index] !== '\n') continue
          if (!flush && buffer[index] === '\r' && index === buffer.length - 1) break
          line(buffer.slice(start, index))
          if (buffer[index] === '\r' && buffer[index + 1] === '\n') index++
          start = index + 1
        }
        buffer = buffer.slice(start)
        if (Buffer.byteLength(buffer, 'utf8') > EVENT_BYTES) throw protocol()
        if (flush) { if (buffer) line(buffer); buffer = ''; event() }
      }
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) { buffer += decoder.decode(); consume(true); break }
        received += chunk.value.byteLength
        if (received > RESPONSE_BYTES) throw new Error('模型响应超过 4 MiB，已停止接收。')
        buffer += decoder.decode(chunk.value, { stream: true }); consume(false)
        if (outputText.length - savedCharacters >= 1024 || (outputText.length > savedCharacters && Date.now() - lastCheckpoint >= 1000)) {
          const checkpoint = await active.service.request('generation.checkpoint', { bookId: run.bookId, runId: run.id, expectedVersion: run.version, outputText })
          if (!checkpoint.ok) { this.remember(checkpoint, active.service); throw new Error('本地生成进度未确认，已停止请求并保留结果。') }
          run = checkpoint.data; savedCharacters = outputText.length; lastCheckpoint = Date.now()
        }
        if (doneMarker) { await reader.cancel().catch(() => undefined); break }
      }
      if (!doneMarker || finishReason !== 'stop' || pendingHigh || !outputText.trim()) throw new Error(finishReason === 'length' ? '输出预算不足，开书包尚不完整，请扩大输出预算后重试。' : '模型未完整结束输出，原文已保留。')
      state = 'succeeded'
    } catch (failure) {
      state = active.cancelled ? 'cancelled' : 'failed'
      error = active.cancelled ? '作者已中止生成，部分输出已保留。' : timedOut ? '生成超过 180 秒，部分输出已保留。'
        : failure instanceof Error && !['TypeError', 'SyntaxError'].includes(failure.name) ? failure.message.slice(0, 500) : '模型网络或流解析未完成，已保留收到的内容。'
    } finally {
      clearTimeout(timer)
      active.controller.abort()
      if (reader) await reader.cancel().catch(() => undefined)
    }
    const pending: PendingGeneration = { root: active.root, contextHash: run.contextHash,
      input: { bookId: run.bookId, runId: run.id, expectedVersion: run.version, state, outputText, usage, error } }
    this.pending = pending
    try {
      pending.file = this.journal.save(active.root, { command: 'generation.finish', contextHash: run.contextHash, input: pending.input }, active.preflight)
      await this.settle(pending, active.service)
    } catch { /* 完整结果留在内存；读取候选时重试落盘，关窗前仍须留存。 */ }
  }
}
