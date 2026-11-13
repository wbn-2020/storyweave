import { performance } from 'node:perf_hooks'
import { failure, isRecord, type Result } from '../../contracts/api'
import type { AiConnection } from '../../contracts/ai'
import type { AiConnectionProbeInput, AiConnectionProbeResult } from '../../contracts/ai-connection-probe'

interface Probe { root: string; identity: string; controller: AbortController; timedOut: boolean }
interface ResolvedConnection { connection: AiConnection; apiKey?: string }
const TIMEOUT = 8_000
const RESPONSE_BYTES = 1024 * 1024

/** 探测只读取模型列表，不创建生成任务；关闭与切库可独立取消，不加入稿件写入门禁。 */
export class ConnectionProbes {
  private readonly active = new Map<string, Probe>()

  cancel(requestId: string): void { this.active.get(requestId)?.controller.abort() }
  abortAll(): void { for (const probe of this.active.values()) probe.controller.abort() }

  async run(root: string, input: AiConnectionProbeInput, resolve: () => Promise<Result<ResolvedConnection>>, currentRoot: () => string | null): Promise<Result<AiConnectionProbeResult>> {
    const identity = JSON.stringify([root, input.scope, input.scope === 'book' ? input.bookId : null, input.connectionId])
    if (this.active.has(input.requestId) || [...this.active.values()].some((item) => item.identity === identity)) return failure('WORKSPACE_BUSY', '此连接正在测试，请等待当前结果。')
    if (this.active.size >= 3) return failure('WORKSPACE_BUSY', '最多同时测试三个连接，请等待当前结果。')
    const probe: Probe = { root, identity, controller: new AbortController(), timedOut: false }
    this.active.set(input.requestId, probe)
    let latencyMs: number | null = null, httpStatus: number | null = null
    const result = (state: AiConnectionProbeResult['state'], message: string): Result<AiConnectionProbeResult> => ({ ok: true, data: {
      requestId: input.requestId, connectionId: input.connectionId, connectionVersion: input.expectedVersion, state, latencyMs, httpStatus, checkedAt: new Date().toISOString(), message,
    } })
    const timer = setTimeout(() => { probe.timedOut = true; probe.controller.abort() }, TIMEOUT)
    try {
      const resolved = await resolve()
      if (probe.controller.signal.aborted) return result(probe.timedOut ? 'failed' : 'cancelled', probe.timedOut ? '连接测试超时（8 秒），请检查接口或稍后重试。' : '连接测试已取消。')
      if (!resolved.ok) return resolved
      if (currentRoot() !== root) return failure('REVISION_CONFLICT', '作品库已切换，本次测试结果已作废。')
      const { connection, apiKey } = resolved.data
      if (connection.id !== input.connectionId || connection.version !== input.expectedVersion) return failure('REVISION_CONFLICT', '连接配置已变化，请刷新后再测试。')
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection.baseUrl).hostname)
      if (!local && !apiKey) return result('failed', '请先保存本次桌面会话密钥，再测试远端连接。')
      const started = performance.now()
      const response = await fetch(`${connection.baseUrl}/models`, { method: 'GET', redirect: 'error', signal: probe.controller.signal,
        headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } })
      latencyMs = Math.max(1, Math.round(performance.now() - started))
      httpStatus = response.status
      if (!response.ok) {
        await response.body?.cancel()
        return result('failed', response.status === 401 || response.status === 403 ? `认证失败（HTTP ${response.status}），请检查本次会话密钥与权限。` : `模型列表返回 HTTP ${response.status}，请检查接口地址及模型列表权限。`)
      }
      if (!response.body || !/^application\/(?:[\w.-]+[+])?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || Number(response.headers.get('content-length')) > RESPONSE_BYTES) {
        await response.body?.cancel()
        return result('failed', '模型列表格式无效或超过 1 MiB，无法确认此模型可用。')
      }
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
      let text = '', bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > RESPONSE_BYTES) return result('failed', '模型列表超过 1 MiB，无法确认此模型可用。')
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (probe.controller.signal.aborted) throw new Error('cancelled')
      if (currentRoot() !== root) return failure('REVISION_CONFLICT', '作品库已切换，本次测试结果已作废。')
      let data: unknown
      try { data = JSON.parse(text) } catch { return result('failed', '接口未返回有效模型列表，请检查兼容接口地址。') }
      if (!isRecord(data) || !Array.isArray(data.data) || data.data.length > 10_000 || data.data.some((item) => !isRecord(item) || typeof item.id !== 'string')) return result('failed', '接口未返回有效模型列表，请检查兼容接口地址。')
      return data.data.some((item) => item.id === connection.model) ? result('succeeded', '连接成功，已在模型列表中确认此模型。') : result('failed', '接口可达，但模型列表中没有配置的模型，请检查模型名称或权限。')
    } catch {
      return result(probe.controller.signal.aborted && !probe.timedOut ? 'cancelled' : 'failed', probe.timedOut ? '连接测试超时（8 秒），请检查接口或稍后重试。'
        : probe.controller.signal.aborted ? '连接测试已取消。' : '无法完成模型列表探测，请检查网络、接口地址或证书；接口须支持 GET /models。')
    } finally { clearTimeout(timer); this.active.delete(input.requestId) }
  }
}
