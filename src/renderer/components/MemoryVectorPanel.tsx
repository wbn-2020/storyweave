import { useEffect, useRef, useState } from 'react'
import { DomainError, type CompletedRequest, type Result, type StudioApi } from '../../contracts/api'
import type { AiConnection } from '../../contracts/ai'
import { parseMemorySearchInput, type MemorySearchInput, type MemorySearchPage } from '../../contracts/memory'
import {
  parseMemoryVectorPrepareInput, parseMemoryVectorProfileInput,
  type MemoryVectorKind, type MemoryVectorPrepareInput, type MemoryVectorRun, type MemoryVectorStatus,
} from '../../contracts/memory-vector'
import { displayTime, request } from '../request'
import shared from '../App.module.css'
import layout from './KnowledgePanel.module.css'
import styles from './MemoryPanel.module.css'

interface Props {
  api: StudioApi
  bookId: string
  archived: boolean
  publicationVersion: number
  disabled: boolean
  searchInput: MemorySearchInput
  onBusyChange: (value: boolean) => void
  onResults: (page: MemorySearchPage) => void
  onRestoreSearch: (input: MemorySearchInput) => void
  onRecover: () => void
}
interface Pending {
  label: string
  requestId?: string
  commands: CompletedRequest['command'][]
  readCommands: ('ai.connection.list' | 'memory.vector.get')[]
  readRunId?: string
  readBefore?: MemoryVectorRun
  retryRead?: true
  receive: (run: MemoryVectorRun) => boolean
}
const stateLabels = { prepared: '待发送', running: '请求中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
const kindLabels = { index: '向量整理', search: '混合检索' }
function uncertain(result: Result<unknown>): boolean {
  return !result.ok && (result.error.code === 'REQUEST_TIMEOUT' || result.error.code === 'SERVICE_UNAVAILABLE')
}
function sameRun(before: MemoryVectorRun, after: MemoryVectorRun): boolean {
  return before.id === after.id && before.bookId === after.bookId && before.kind === after.kind &&
    before.context.contextHash === after.context.contextHash && JSON.stringify(before.context) === JSON.stringify(after.context)
}
function sameConnection(before: AiConnection, after: AiConnection): boolean {
  return before.id === after.id && before.name === after.name && before.baseUrl === after.baseUrl && before.model === after.model &&
    before.contextWindow === after.contextWindow && before.maxOutputTokens === after.maxOutputTokens &&
    before.version === after.version && before.updatedAt === after.updatedAt
}
function matchesPrepared(input: MemoryVectorPrepareInput, run: MemoryVectorRun): boolean {
  return run.bookId === input.bookId && run.context.bookId === input.bookId && run.kind === input.kind && run.context.kind === input.kind &&
    run.publicationVersion === input.expectedPublicationVersion && run.context.publicationVersion === input.expectedPublicationVersion &&
    run.context.connection.id === input.connectionId && run.embeddingModel === input.embeddingModel &&
    JSON.stringify(run.context.search) === JSON.stringify(input.search) &&
    run.inputCount === run.context.input.length && run.inputCount > 0 && run.inputCount <= 8 &&
    (input.kind === 'index' ? run.context.items.length === run.inputCount && run.context.items.every((item, index) => item.text === run.context.input[index]) :
      run.context.input.length === 1 && run.context.input[0] === input.search?.query)
}

export function MemoryVectorPanel({ api, bookId, archived, publicationVersion, disabled, searchInput, onBusyChange, onResults, onRestoreSearch, onRecover }: Props) {
  const [connections, setConnections] = useState<AiConnection[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [status, setStatus] = useState<MemoryVectorStatus | null>(null)
  const [run, setRun] = useState<MemoryVectorRun | null>(null)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [checking, setChecking] = useState(false)
  const [pollStopped, setPollStopped] = useState(false)
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const [connectionsRequested, setConnectionsRequested] = useState(true)
  const mounted = useRef(true)
  const lock = useRef(false)
  const runRef = useRef<MemoryVectorRun | null>(null)
  const busyCallback = useRef(onBusyChange)
  busyCallback.current = onBusyChange
  const unresolved = pending !== null || run?.state === 'running'
  const blocked = disabled || working || checking || pending !== null
  const selected = connections.find((item) => item.id === connectionId)
  const form = { bookId, connectionId, embeddingModel: embeddingModel.trim() }
  const recovery = JSON.stringify({ bookId, connectionId, connection: selected, embeddingModel, search: searchInput,
    runId: run?.id, runVersion: run?.version, contextHash: run?.context.contextHash, publicationVersion,
    requestId: pending?.requestId, pendingRunId: pending?.readRunId, operation: pending?.label }, null, 2)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; busyCallback.current(false) }
  }, [])
  useEffect(() => { busyCallback.current(working || checking || unresolved) }, [working, checking, unresolved])
  useEffect(() => { setRecoveryConfirmed(false) }, [recovery])

  async function readConnections() {
    if (lock.current || disabled || unresolved) return
    lock.current = true; setWorking(true); setMessage(null)
    const result = await request(() => api.listAiConnections({ bookId }))
    if (mounted.current) {
      if (result.ok && result.data.bookId === bookId) setConnections(result.data.connections)
      else setMessage(result.ok ? '模型连接的作品身份不符。' : result.error.message)
      setWorking(false)
    }
    lock.current = false
  }
  useEffect(() => {
    if (connectionsRequested && !disabled && !unresolved && !lock.current) {
      setConnectionsRequested(false); void readConnections()
    }
  }, [api, bookId, connectionsRequested, disabled, unresolved])

  async function refreshCoverage() {
    if (lock.current || blocked || unresolved) return
    try {
      const input = parseMemoryVectorProfileInput(form)
      lock.current = true; setWorking(true); setMessage(null)
      const result = await request(() => api.getMemoryVectorStatus(input))
      if (!mounted.current) return
      if (result.ok && result.data.bookId === bookId && result.data.publicationVersion === publicationVersion) setStatus(result.data)
      else setMessage(result.ok ? '覆盖状态的发布批次已变化，请刷新本地整理状态。' : result.error.message)
    } catch (error) { if (mounted.current) setMessage(error instanceof DomainError ? error.message : '向量配置无效。') }
    finally { lock.current = false; if (mounted.current) setWorking(false) }
  }

  function accept(value: MemoryVectorRun): boolean {
    if (!mounted.current || value.bookId !== bookId || value.context.bookId !== bookId) return false
    runRef.current = value; setRun(value)
    setPollStopped(false)
    setStatus(null)
    return true
  }
  async function write(label: string, commands: Pending['commands'], operation: () => Promise<Result<MemoryVectorRun>>, receive: Pending['receive'],
    readCommands: Pending['readCommands'] = [], readBefore?: MemoryVectorRun) {
    if (lock.current || blocked) return
    lock.current = true; setWorking(true); setMessage(null); busyCallback.current(true)
    const held = { label, commands, receive, readCommands, readRunId: readBefore?.id, readBefore }
    try {
      const result = await request(operation)
      if (!mounted.current) return
      if (result.ok) {
        if (!receive(result.data)) { setPending(held); setMessage('回执与本次输入不符，已保留表单，请先核对原记录。') }
      } else {
        setMessage(result.error.message)
        if (uncertain(result) || result.error.code === 'STORAGE_ERROR' || result.error.code === 'WORKSPACE_BUSY' && result.error.requestId) {
          setPending({ ...held, requestId: result.error.requestId })
        }
      }
    } finally { lock.current = false; if (mounted.current) setWorking(false) }
  }
  async function prepare(kind: MemoryVectorKind) {
    if (archived || unresolved || blocked) return
    try {
      const input = parseMemoryVectorPrepareInput({ ...form, expectedPublicationVersion: publicationVersion, kind,
        ...(kind === 'search' ? { search: searchInput } : {}) })
      const expectedConnection = selected
      await write(`准备${kindLabels[kind]}`, ['memory.vector.prepare'], () => api.prepareMemoryVectorRun(input), (value) => {
        if (!matchesPrepared(input, value) || !expectedConnection || !sameConnection(value.context.connection, expectedConnection)) return false
        return accept(value)
      }, ['ai.connection.list'])
    } catch (error) { setMessage(error instanceof DomainError ? error.message : '向量预览参数无效。') }
  }
  function formMatches(value: MemoryVectorRun): boolean {
    try {
      const input = parseMemoryVectorPrepareInput({ ...form, expectedPublicationVersion: publicationVersion, kind: value.kind,
        ...(value.kind === 'search' ? { search: searchInput } : {}) })
      return matchesPrepared(input, value) && selected !== undefined && sameConnection(selected, value.context.connection)
    } catch { return false }
  }
  async function start() {
    const current = runRef.current
    if (!current || archived || current.state !== 'prepared' || !formMatches(current)) return
    await write('发送向量请求', ['memory.vector.claim'], () => api.startMemoryVectorRun({ bookId, runId: current.id,
      expectedVersion: current.version, contextHash: current.context.contextHash }), (value) =>
      sameRun(current, value) && value.state === 'running' && value.version === current.version + 1 && accept(value),
      ['memory.vector.get', 'ai.connection.list'], current)
  }
  async function stop() {
    const current = runRef.current
    if (!current || (current.state !== 'prepared' && current.state !== 'running')) return
    if (current.state === 'running' && current.active === undefined) { setMessage('请先读取原请求，核对本机网络状态后再取消或中断。'); return }
    const interrupt = current.state === 'running' && current.active === false
    const commands: Pending['commands'] = interrupt ? ['memory.vector.interrupt'] : ['memory.vector.cancel', 'memory.vector.finish']
    await write(interrupt ? '中断孤立请求' : '取消向量请求', commands, () =>
      (interrupt ? api.interruptMemoryVectorRun : api.cancelMemoryVectorRun)({ bookId, runId: current.id, expectedVersion: current.version }), (value) =>
      sameRun(current, value) && value.version >= current.version && value.state !== 'prepared' && value.state !== 'running' && accept(value),
      interrupt ? [] : ['memory.vector.get', 'ai.connection.list'], current)
  }
  async function readRun(id: string, polling = false) {
    const retry = !polling && pending?.retryRead && pending.readRunId === id ? pending : null
    // 只解除同一记录的读取等待；准备、发送等未知写入仍须核对各自回执。
    if (lock.current || disabled || working || checking || (pending !== null && !retry) ||
      (!polling && unresolved && runRef.current?.id !== id && !retry)) return
    lock.current = true
    setWorking(true); busyCallback.current(true)
    const before = retry?.readBefore ?? (runRef.current?.id === id ? runRef.current : undefined)
    const receive = (value: MemoryVectorRun) => value.id === id && value.bookId === bookId &&
      (!before || sameRun(before, value) && value.version >= before.version) && accept(value)
    const result = await request(() => api.getMemoryVectorRun({ bookId, runId: id }))
    if (mounted.current) {
      if (result.ok && receive(result.data)) {
        if (retry) setPending(null)
        setMessage(null)
      } else {
        setPollStopped(true)
        setMessage(result.ok ? '向量记录与原请求不符，请保留恢复内容。' : `${result.error.message}${polling ? ' 已暂停自动读取，可手动读取原请求。' : ''}`)
        if (retry || result.ok || uncertain(result) || result.error.code === 'STORAGE_ERROR' || result.error.requestId) {
          setPending({ label: '读取原向量请求', retryRead: true, requestId: result.ok ? undefined : result.error.requestId,
            commands: ['memory.vector.claim', 'memory.vector.finish', 'memory.vector.cancel', 'memory.vector.interrupt'],
            readCommands: ['memory.vector.get', 'ai.connection.list'], readRunId: id, readBefore: before, receive })
        }
      }
      setWorking(false)
    }
    lock.current = false
  }
  useEffect(() => {
    if (run?.state !== 'running' || blocked || pollStopped) return
    const timer = window.setTimeout(() => { void readRun(run.id, true) }, 1500)
    return () => window.clearTimeout(timer)
  }, [run, blocked, pollStopped])

  async function checkReceipt() {
    if (!pending?.requestId || checking || lock.current || disabled) return
    const captured = pending
    lock.current = true; setChecking(true)
    const result = await request(() => api.getRequestStatus({ requestId: captured.requestId! }))
    if (mounted.current) {
      if (!result.ok) setMessage(result.error.message)
      else if (result.data.state !== 'completed') setMessage(result.data.state === 'pending' ? '原请求仍在处理，请稍后再核对。' : '原回执已不可用，请留存恢复内容后核对作品。')
      else {
        const response = result.data.response
        const isRead = captured.readCommands.some((command) => command === response.command)
        if (!isRead && !captured.commands.includes(response.command)) setMessage('回执命令与原操作不符，已保留表单。')
        else if (!response.result.ok) {
          setMessage(response.result.error.message)
          if (!uncertain(response.result) && response.result.error.code !== 'STORAGE_ERROR') { setPending(null); setPollStopped(true) }
        } else if (isRead && response.command === 'ai.connection.list') {
          if (response.result.data.bookId === bookId) {
            setPending(null); setPollStopped(true); setMessage('已核对原连接读取回执。请重新读取预览；发送仍需明确操作。')
          } else setMessage('原连接读取回执的作品不符，已保留表单。')
        } else if (isRead && response.command === 'memory.vector.get') {
          const value = response.result.data
          if (value.id === captured.readRunId && value.bookId === bookId &&
            (!captured.readBefore || sameRun(captured.readBefore, value) && value.version >= captured.readBefore.version) && accept(value)) {
            setPending(null); setPollStopped(true); setMessage('已核对原读取回执。请读取原请求以更新本机网络状态。')
          } else setMessage('原读取回执的对象或版本不符，已保留表单。')
        } else if (captured.receive(response.result.data as MemoryVectorRun)) {
          setPollStopped(true)
          setPending(null); setMessage('已核对原请求回执；没有重复发送。')
        } else setMessage('回执内容与原操作不符，已保留表单。')
      }
      setChecking(false)
    }
    lock.current = false
  }
  function restoreForm() {
    if (!run || blocked || unresolved) return
    setConnectionId(run.context.connection.id); setEmbeddingModel(run.embeddingModel)
    if (run.context.search) onRestoreSearch(parseMemorySearchInput(run.context.search))
    setMessage('已恢复该预览的配置与检索条件；发送前会重新核对当前来源。')
  }
  function results() {
    if (!run?.result || blocked || unresolved) return
    onResults(run.result)
    setMessage('已显示该请求完成时的混合检索快照，出处入口会重新核对当前版本。')
  }
  function recover() {
    if (lock.current || working || checking || !recoveryConfirmed) return
    busyCallback.current(false); onRecover()
  }

  return <section className={styles.vector} aria-label="向量整理与混合检索">
    <div className={styles.taskHeading}><h3>向量整理与混合检索</h3><button type="button" className={shared.button} disabled={blocked || unresolved} onClick={() => void readConnections()}>刷新连接</button></div>
    <p className={styles.note}>先预览，明确发送后才向所选接口传递文本。每批最多 8 个有效片段；混合检索仅发送上方查询文字。后续批次需再次准备与发送，向量进度独立于本地索引覆盖。</p>
    <div className={styles.vectorForm}><label>模型连接<select value={connectionId} disabled={blocked || unresolved} onChange={(event) => { setConnectionId(event.target.value); setStatus(null) }}><option value="">选择本书连接</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label><label>向量模型<input value={embeddingModel} maxLength={200} disabled={blocked || unresolved} placeholder="填写接口支持的向量模型" onChange={(event) => { setEmbeddingModel(event.target.value); setStatus(null) }} /></label></div>
    {connections.length === 0 && <p className={styles.note}>请先在 AI 协作中保存本书连接。远端密钥只在本次应用会话使用；此处沿用相同连接。</p>}
    <div className={styles.actions}><button type="button" className={shared.button} disabled={blocked || unresolved || !selected || !embeddingModel.trim()} onClick={() => void refreshCoverage()}>读取向量覆盖</button><button type="button" className={shared.button} disabled={blocked || unresolved || archived || !selected || !embeddingModel.trim() || publicationVersion < 1} onClick={() => void prepare('index')}>预览下一批向量整理</button><button type="button" className={shared.button} disabled={blocked || unresolved || archived || !selected || !embeddingModel.trim() || !searchInput.query.trim() || publicationVersion < 1} onClick={() => void prepare('search')}>预览混合检索</button></div>
    {status && <p className={styles.note}>发布批次 {status.publicationVersion} · 已有向量 {status.indexedChunks.toLocaleString()} / {status.eligibleChunks.toLocaleString()} 个有效片段 · {status.dimensions === null ? '尚无成功结果' : `${status.dimensions} 维，返回模型 ${status.responseModel}`}。覆盖仅表示派生索引范围。</p>}
    {message && <p className={shared.formError} role="status">{message}</p>}
    {pending && <div className={layout.pending} role="alert"><h4>{pending.label}尚未确认</h4><p>请求编号：{pending.requestId ?? '不可用'}。写入已锁定，请核对原回执并留存恢复内容。</p><label>配置与请求恢复内容<textarea className={styles.vectorRecovery} readOnly rows={7} value={recovery} onFocus={(event) => event.target.select()} /></label><label className={shared.checkLabel}><input type="checkbox" checked={recoveryConfirmed} disabled={working || checking} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />我已复制留存配置、查询与原请求编号，允许进入恢复</label><div className={styles.actions}><button type="button" className={shared.button} disabled={working || checking || disabled || !pending.requestId} onClick={() => void checkReceipt()}>查询原请求回执</button>
      {pending.retryRead && pending.readRunId && <button type="button" className={shared.button} disabled={disabled || working || checking} onClick={() => void readRun(pending.readRunId!)}>重新读取原请求</button>}
      <button type="button" className={shared.button} disabled={working || checking || !recoveryConfirmed} onClick={recover}>进入草稿与恢复</button></div></div>}
    {run && <div className={styles.vectorPreview}><h4>{kindLabels[run.kind]} · {stateLabels[run.state]}</h4><p className={styles.note}>{run.context.connection.baseUrl}/embeddings<br />向量模型 {run.embeddingModel} · 发布 {run.publicationVersion} · 输入估计 {run.context.estimatedInputTokens.toLocaleString()} token（保守估算，非费用承诺）<br />请求 {run.id} · 版本 {run.version}<br />指纹 {run.context.contextHash}</p>
      {run.state === 'prepared' && !formMatches(run) && <p className={styles.note}>当前配置、查询或发布版本与此预览不同。请重新准备，或明确恢复该预览的表单。</p>}
      <details open><summary>将发送的完整输入（{run.context.input.length} 项）</summary>{run.context.input.map((text, index) => <div key={index}><p className={styles.note}>输入 {index + 1}{run.context.items[index] && ` · ${run.context.items[index].title} · 修订 ${run.context.items[index].revisionId} · 片段 ${run.context.items[index].chunkId}`}</p><pre>{text}</pre></div>)}</details>
      {run.error && <p className={shared.formError}>{run.error}</p>}
      <div className={styles.actions}>{run.state === 'prepared' && <><button type="button" className={shared.primaryButton} disabled={blocked || archived || !formMatches(run)} onClick={() => void start()}>发送这份预览</button><button type="button" className={shared.button} disabled={blocked} onClick={() => void stop()}>取消此预览</button><button type="button" className={shared.button} disabled={blocked} onClick={restoreForm}>恢复该预览表单</button></>}{run.state === 'running' && <button type="button" className={shared.button} disabled={blocked || run.active === undefined} onClick={() => void stop()}>{run.active === undefined ? '请先读取本机请求状态' : run.active ? '取消当前网络请求' : '明确中断孤立请求'}</button>}<button type="button" className={shared.button} disabled={blocked} onClick={() => void readRun(run.id)}>读取原请求</button>{run.result && <button type="button" className={shared.button} disabled={blocked} onClick={results}>显示本次混合结果快照</button>}</div>
      {run.usage && <p className={styles.note}>接口报告输入 token：{run.usage.inputTokens ?? '未提供'}；总 token：{run.usage.totalTokens ?? '未提供'}。</p>}
      {run.state === 'succeeded' && run.kind === 'index' && <p className={styles.note}>本批已保存。可刷新覆盖，再明确准备下一批；不会自动继续发送。</p>}
    </div>}
    {(run || pending || embeddingModel) && <details className={styles.history}><summary>可复制的恢复内容</summary><textarea className={styles.vectorRecovery} readOnly rows={7} value={recovery} aria-label="向量请求恢复内容" /></details>}
    {status && status.recentRuns.length > 0 && <details className={styles.history}><summary>最近 20 批请求</summary><ul>{status.recentRuns.map((item) => <li key={item.id}><span>{kindLabels[item.kind]} · {stateLabels[item.state]} · {item.embeddingModel} · {displayTime(item.updatedAt)}</span><button type="button" className={shared.button} disabled={blocked || unresolved} onClick={() => void readRun(item.id)}>查看固定记录</button></li>)}</ul></details>}
  </section>
}
