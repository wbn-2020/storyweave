import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { failure, isRecord, type CommandMap, type CompletedRequest, type RequestStatus, type Result, type ServiceCommand, type ServiceResponse } from '../../contracts/api'

type ServiceOutput = CommandMap[ServiceCommand]['output']
interface PendingRequest {
  command: ServiceCommand
  workspaceRoot: string | null
  resolve: (result: Result<ServiceOutput>) => void
  timer: ReturnType<typeof setTimeout>
  timedOut: boolean
}

export class ServiceClient {
  private readonly child: UtilityProcess
  private readonly pending = new Map<string, PendingRequest>()
  private readonly receipts = new Map<string, CompletedRequest>()
  private unavailable = false
  private closeRequested = false
  private closedSuccessfully = false
  private exited = false
  private workspaceRoot: string | null = null
  private stderrBuffer = ''
  private logEvents = 0
  private unclassifiedLogged = false

  constructor(entryPath: string, private readonly onSuccess?: (command: ServiceCommand, output: ServiceOutput, root: string | null) => void) {
    this.child = utilityProcess.fork(entryPath, [], { serviceName: 'StoryWeave 本地作品服务', stdio: 'pipe' })
    // 仅记录白名单事件码；原生异常只留下固定类别，避免路径或正文进入日志。
    this.child.stdout?.resume()
    this.child.stderr?.on('data', (chunk: Buffer | string) => this.receiveStderr(chunk))
    this.child.on('message', (message: unknown) => this.receive(message))
    this.child.on('exit', () => {
      this.exited = true
      if (!this.closedSuccessfully) this.logEvent('storyweave.service_exited')
      if (this.stderrBuffer.trim()) this.logUnclassifiedStderr()
      this.stderrBuffer = ''
      this.markUnavailable()
    })
    this.child.on('error', () => {
      this.logEvent('storyweave.service_process_error')
      this.markUnavailable()
    })
  }

  request<K extends ServiceCommand>(command: K, payload: CommandMap[K]['input']): Promise<Result<CommandMap[K]['output']>> {
    if (this.unavailable || this.closeRequested) {
      return Promise.resolve(failure('SERVICE_UNAVAILABLE', '本地作品服务不可用，请保留当前稿件。'))
    }
    if ([...this.pending.values()].some((request) => request.timedOut)) {
      return Promise.resolve(failure('WORKSPACE_BUSY', '上一请求结果尚未确认，本次操作未提交。请保留当前稿件，先查询原请求状态。'))
    }
    if (this.pending.size >= 8) {
      return Promise.resolve(failure('WORKSPACE_BUSY', '本地作品服务正在处理其他操作，本次操作未提交，请稍后再试。'))
    }
    if (command === 'service.close') this.closeRequested = true
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        // 超时不取消已经交给数据库的写入，也不释放队列名额以重复提交。
        pending.timedOut = true
        pending.resolve({
          ok: false,
          error: { code: 'REQUEST_TIMEOUT', requestId: id, message: '操作仍未返回结果，保存状态尚未确认。请保留当前稿件，并查询原请求状态。' },
        })
      }, 30_000)
      this.pending.set(id, {
        command,
        workspaceRoot: this.workspaceRoot,
        resolve: resolve as (result: Result<ServiceOutput>) => void,
        timer,
        timedOut: false,
      })
      try {
        this.child.postMessage({ id, command, payload })
      } catch {
        this.markUnavailable()
      }
    })
  }

  getRequestStatus(requestId: string): RequestStatus {
    if (this.pending.has(requestId)) return { state: 'pending' }
    const receipt = this.receipts.get(requestId)
    return receipt ? { state: 'completed', response: receipt } : { state: 'unknown' }
  }

  hasExited(): boolean { return this.exited }
  getWorkspaceRoot(): string | null { return this.workspaceRoot }
  takeReceipts(): Map<string, CompletedRequest> { return new Map(this.receipts) }

  async close(): Promise<Result<null>> {
    if (this.closedSuccessfully) {
      this.child.kill()
      return { ok: true, data: null }
    }
    const result = await this.request('service.close', undefined)
    if (result.ok) {
      // 此时服务已经同步关闭数据库，才允许结束 utility process。
      this.unavailable = true
      this.child.kill()
    } else if (result.error.code !== 'REQUEST_TIMEOUT') {
      this.closeRequested = false
    }
    return result
  }

  private receive(message: unknown): void {
    if (!isRecord(message) || typeof message.id !== 'string' || !isRecord(message.result) || typeof message.result.ok !== 'boolean') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    const response = message as unknown as ServiceResponse
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if ((pending.command === 'workspace.open' || pending.command === 'workspace.get') && response.result.ok && isRecord(response.result.data) && (typeof response.result.data.rootPath === 'string' || response.result.data.rootPath === null)) {
      this.workspaceRoot = response.result.data.rootPath
    }
    if (pending.command === 'service.close') {
      this.closedSuccessfully = response.result.ok
      this.closeRequested = response.result.ok
    }
    if (response.result.ok) {
      try { this.onSuccess?.(pending.command, response.result.data, pending.workspaceRoot) }
      catch { /* 辅助恢复记录失败不能改变已经确认的领域写入结果。 */ }
    }
    // 只保留需要补领的迟到回执，正常读写返回后不在主进程长期缓存整章正文。
    if (pending.timedOut) this.remember(message.id, pending.command, response.result)
    else pending.resolve(response.result)
    if (pending.command === 'service.close' && pending.timedOut && response.result.ok) {
      // 窗口已因超时保留；此时数据库才确认关闭，结束旧进程后才能恢复服务并保留界面中的新编辑。
      this.unavailable = true
      this.child.kill()
    }
  }

  private remember(id: string, command: ServiceCommand, result: Result<ServiceOutput>): void {
    // command 来自发送时的请求，不采用子进程回传的任意命令身份。
    this.receipts.set(id, { command, result } as CompletedRequest)
    if (this.receipts.size > 32) {
      const oldest = this.receipts.keys().next().value
      if (oldest !== undefined) this.receipts.delete(oldest)
    }
  }

  private markUnavailable(): void {
    this.unavailable = true
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      const result: Result<never> = {
        ok: false,
        error: { code: 'SERVICE_UNAVAILABLE', requestId: id, message: '本地作品服务已中断，原请求是否提交无法确认。请保留当前稿件，不能据此认定修改未写入。' },
      }
      this.remember(id, pending.command, result)
      if (!pending.timedOut) pending.resolve(result)
    }
    this.pending.clear()
  }

  private receiveStderr(chunk: Buffer | string): void {
    if (chunk.length > 4096) {
      this.stderrBuffer = ''
      this.logUnclassifiedStderr()
      return
    }
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (text.length > 4096 || this.stderrBuffer.length + text.length > 8192) {
      this.stderrBuffer = ''
      this.logUnclassifiedStderr()
      return
    }
    const lines = (this.stderrBuffer + text).split(/\r?\n/)
    this.stderrBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === 'storyweave.catalog_refresh_failed') this.logEvent('storyweave.catalog_refresh_failed')
      else if (line.trim()) this.logUnclassifiedStderr()
    }
  }

  private logUnclassifiedStderr(): void {
    if (this.unclassifiedLogged) return
    this.unclassifiedLogged = true
    this.logEvent('storyweave.service_stderr_unclassified')
  }

  private logEvent(event: 'storyweave.catalog_refresh_failed' | 'storyweave.service_exited' | 'storyweave.service_process_error' | 'storyweave.service_stderr_unclassified'): void {
    if (this.logEvents < 64) console.warn(event)
    else if (this.logEvents === 64) console.warn('storyweave.service_log_limit_reached')
    this.logEvents = Math.min(this.logEvents + 1, 65)
  }
}
