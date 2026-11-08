import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { DomainError, type BookSnapshot, type CompletedRequest, type Result, type StudioApi } from '../../contracts/api'
import type { AiConnectionPage, AiContextPacket, AiRun, AiRunState } from '../../contracts/ai'
import type { AiMemoryTaskScope, AiMemoryTaskState } from '../../contracts/ai-memory-task'
import { AI_SUMMARY_NODE_PAGE, AI_SUMMARY_PLAN_PAGE, AI_SUMMARY_PROMPT_VERSION, AI_SUMMARY_TEXT_LIMIT, isAiSummaryAdoptReceiptFor, isAiSummaryReceiptFor, parseAiSummaryAdoptInput, parseAiSummaryContext, parseAiSummaryProposal, parseAiSummaryStartInput, type AiSummaryAdoptInput, type AiSummaryAdoptReceipt, type AiSummaryControlInput, type AiSummaryNodeDetail, type AiSummaryNodeSummary, type AiSummaryProposal, type AiSummaryReceipt, type AiSummarySource, type AiSummaryStartInput, type AiSummaryStatus, type AiSummaryTaskDetail, type AiSummaryTaskSummary } from '../../contracts/ai-summary'
import type { KnowledgeStatus } from '../../contracts/knowledge'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import shared from '../App.module.css'
import layout from './KnowledgePanel.module.css'
import styles from './AiPanel.module.css'

interface Props {
  api: StudioApi
  book: BookSnapshot
  busy: boolean
  error?: string | null
  pendingMessage?: string | null
  checkingReceipt: boolean
  onCheckReceipt: () => void
  onRecover: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  onUpgrade: (accept: (status: KnowledgeStatus) => void) => Promise<void>
  onAdoptSummary: (input: AiSummaryAdoptInput, source: AiRun, previous: AiSummaryTaskSummary, accept: (receipt: AiSummaryAdoptReceipt) => boolean) => Promise<void>
}
interface SummaryForm { scope: string; fanIn: 2 | 4 | 8; connectionId: string; instruction: string }
interface PendingWrite { requestId?: string; label: string; receive: (response: CompletedRequest) => boolean; retryRead?: NodeRead }
interface DiscardAction { label: string; proceed: () => void }
interface NodeRead { task: AiSummaryTaskDetail; node: AiSummaryNodeSummary; runOnly?: boolean }
const taskLabels: Record<AiMemoryTaskState, string> = { planning: '规划汇总节点', ready: '等待处理节点', paused: '已暂停', failed: '需要处理异常', completed: '范围内汇总已采用', superseded: '下层来源已变化', cancelled: '已取消' }
const runLabels: Record<AiRunState, string> = { prepared: '等待明确发送', running: '生成中', succeeded: '待作者审阅', failed: '生成失败', cancelled: '生成已取消', interrupted: '生成已中断', rejected: '作者已拒绝', adopted: '作者已采用' }
const initialInstruction = '请依据完整的下层摘要汇总主要事件、人物变化与因果关系，保留覆盖每份来源的准确引文，区分陈述、人物认知与推断。'
function terminal(task: AiSummaryTaskSummary): boolean { return ['completed', 'superseded', 'cancelled'].includes(task.state) }
function formScope(value: string): AiMemoryTaskScope { return value === 'book' ? { kind: 'book' } : { kind: 'volume', volumeId: value === 'ungrouped' ? null : value } }
function sameScope(left: AiMemoryTaskScope, right: AiMemoryTaskScope): boolean { return left.kind === right.kind && (left.kind === 'book' || right.kind === 'volume' && left.volumeId === right.volumeId) }
function sameNode(left: AiSummaryNodeSummary, right: AiSummaryNodeSummary): boolean {
  return left.id === right.id && left.taskId === right.taskId && left.ordinal === right.ordinal && left.level === right.level && left.position === right.position &&
    left.title === right.title && left.firstChapterOrdinal === right.firstChapterOrdinal && left.lastChapterOrdinal === right.lastChapterOrdinal && left.chapterCount === right.chapterCount
}
function validTask(bookId: string, value: AiSummaryTaskDetail, id: string): boolean {
  return value.bookId === bookId && value.id === id && Number.isSafeInteger(value.version) && value.version >= 0 &&
    value.nodes.length <= AI_SUMMARY_NODE_PAGE && new Set(value.nodes.map((node) => node.id)).size === value.nodes.length &&
    new Set(value.nodes.map((node) => node.ordinal)).size === value.nodes.length && value.nodes.every((node) => node.taskId === id) &&
    (!value.currentNode || value.currentNode.taskId === id) && value.approvedNodes <= value.plannedNodes && value.plannedNodes <= value.totalNodes
}
function validRun(run: AiRun, task: AiSummaryTaskDetail, node: AiSummaryNodeSummary): boolean {
  try {
    const context = run.context; const summary = parseAiSummaryContext(context.summary); const anchor = summary.sources[0]
    return run.id === node.runId && run.bookId === task.bookId && run.kind === 'summarize' && context.bookId === task.bookId && context.kind === run.kind &&
      context.promptVersion === AI_SUMMARY_PROMPT_VERSION && summary.taskId === task.id && summary.nodeId === node.id && summary.manifestHash === task.manifestHash &&
      sameScope(summary.scope, task.scope) && summary.scopeTitle === task.scopeTitle && summary.fanIn === task.fanIn && summary.level === node.level &&
      summary.position === node.position && summary.coveredChapters === node.chapterCount && context.instruction === task.instruction &&
      context.connection.id === task.connectionId && run.connectionName === context.connection.name && run.model === context.connection.model &&
      run.chapterId === anchor.chapterId && run.chapterTitle === anchor.chapterTitle && context.chapterId === anchor.chapterId &&
      context.chapterRevisionId === anchor.chapterRevisionId && context.chapterTitle === anchor.chapterTitle && /^[0-9a-f]{64}$/.test(context.contextHash)
  } catch { return false }
}
function validNode(task: AiSummaryTaskDetail, value: AiSummaryNodeDetail, expected: AiSummaryNodeSummary): boolean {
  if (value.taskId !== task.id || !sameNode(value, expected) || value.sources !== null && (value.sources.length < 1 || value.sources.length > task.fanIn)) return false
  if (value.run && (value.runId !== value.run.id || value.runState !== value.run.state || !validRun(value.run, task, value) || JSON.stringify(value.sources) !== JSON.stringify(value.run.context.summary?.sources))) return false
  if (!value.run && value.runId !== null) return false
  return value.state !== 'approved' || Boolean(value.acceptedText?.trim() && value.acceptedText.length <= AI_SUMMARY_TEXT_LIMIT && value.approvedAt && value.run?.state === 'adopted' && value.run.acceptedText === value.acceptedText)
}
function readProposal(run: AiRun | null): { proposal: AiSummaryProposal | null; error: string | null } {
  if (!run || !['succeeded', 'adopted'].includes(run.state)) return { proposal: null, error: null }
  try { return { proposal: parseAiSummaryProposal(run.outputText, parseAiSummaryContext(run.context.summary)), error: null } }
  catch (cause) { return { proposal: null, error: cause instanceof DomainError ? cause.detail.message : '原输出无法解析为可核对的分层摘要，请保留后明确重试。' } }
}

function SummarySources({ sources, disabled, onInspect }: { sources: AiSummarySource[] | null; disabled: boolean; onInspect: (source: AiSummarySource) => void }) {
  return <details className={styles.sources}><summary>完整下层摘要来源（{sources === null ? '尚未全部确认' : sources.length}）</summary>
    {sources === null ? <p className={styles.note}>下层节点尚未全部采用，当前节点没有完整来源，不能准备发送。</p> : <ul className={layout.sources}>{sources.slice(0, 8).map((source) => <li key={source.id}>
      <div><strong>{source.title}</strong><span>{source.kind === 'chapter' ? '作者已采用的章节摘要' : '作者已采用的下层汇总'} · 覆盖 {source.chapterCount} 章</span></div>
      <p className={layout.sourceIds}>来源 {source.id}<br />首来源章（存储锚点）：{source.chapterTitle} · 修订 {source.chapterRevisionId}</p><p className={layout.body}>{source.text}</p>
      {source.kind === 'node' ? <button type="button" className={shared.button} disabled={disabled} onClick={() => onInspect(source)}>查看这份下层汇总与来源</button> : <details className={styles.sources}><summary>这份章节摘要所附的固定原稿引文（{source.citations.length} 处）</summary>{source.citations.map((citation, index) => <div key={`${citation.blockId}:${index}`}><p className={layout.sourceIds}>原稿段落 {citation.blockId}</p><blockquote>{citation.quote}</blockquote></div>)}</details>}
    </li>)}</ul>}
  </details>
}
function SummaryPreview({ context }: { context: AiContextPacket }) {
  return <section className={styles.preview} aria-label="节点实际发送预览"><div className={styles.heading}><h3>本节点固定发送预览</h3><span>提示版本 {context.promptVersion}</span></div>
    <dl className={styles.facts}><div><dt>接口</dt><dd>{context.connection.baseUrl}/chat/completions</dd></div><div><dt>模型</dt><dd>{context.connection.model}</dd></div><div><dt>输入估算</dt><dd>{context.estimatedInputTokens.toLocaleString()} tokens</dd></div><div><dt>输出预算／上下文窗口</dt><dd>{context.reservedOutputTokens.toLocaleString()}／{context.connection.contextWindow.toLocaleString()} tokens</dd></div></dl>
    <p className={styles.note}>明确发送后，下列完整输入将交给这个接口；实际用量与收费以接口返回为准。</p>
    {context.warnings.length > 0 && <ul className={shared.warningList}>{context.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    <details className={styles.messages}><summary>逐条查看实际 messages（{context.messages.length} 条）</summary>{context.messages.map((message, index) => <div key={index}><h4>{message.role === 'system' ? '系统要求' : '汇总输入'}</h4><pre>{message.content}</pre></div>)}</details>
    <p className={styles.identity}>作品版本 {context.bookRevision} · 知识版本 {context.knowledgeRevision}<br />输入指纹 {context.contextHash}</p>
  </section>
}

export function AiSummaryPanel(props: Props) { return <AiSummarySession key={props.book.book.id} {...props} /> }

function AiSummarySession({ api, book, busy, error, pendingMessage, checkingReceipt, onCheckReceipt, onRecover, onClose, onDirtyChange, onUpgrade, onAdoptSummary }: Props) {
  const [status, setStatus] = useState<AiSummaryStatus | null>(null)
  const [connections, setConnections] = useState<AiConnectionPage | null>(null)
  const [task, setTask] = useState<AiSummaryTaskDetail | null>(null)
  const [node, setNode] = useState<AiSummaryNodeDetail | null>(null)
  const [sourceNode, setSourceNode] = useState<AiSummaryNodeDetail | null>(null)
  const [form, setForm] = useState<SummaryForm>({ scope: 'book', fanIn: 4, connectionId: '', instruction: initialInstruction })
  const [formDirty, setFormDirty] = useState(false)
  const [acceptedText, setAcceptedText] = useState('')
  const [reviewDirty, setReviewDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingWrite | null>(null)
  const [checkingLocal, setCheckingLocal] = useState(false)
  const [refreshRequested, setRefreshRequested] = useState(true)
  const [requestedNode, setRequestedNode] = useState<NodeRead | null>(null)
  const [pollStopped, setPollStopped] = useState(false)
  const [pollCycle, setPollCycle] = useState(0)
  const [pageAfter, setPageAfter] = useState<number | undefined>()
  const [pageTrail, setPageTrail] = useState<(number | undefined)[]>([])
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [backupPath, setBackupPath] = useState<string | null>(null)
  const [discard, setDiscard] = useState<DiscardAction | null>(null)
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const mounted = useRef(false)
  const epoch = useRef(0)
  const ticket = useRef(0)
  const lock = useRef(false)
  const statusRef = useRef<AiSummaryStatus | null>(null)
  const taskRef = useRef<AiSummaryTaskDetail | null>(null)
  const nodeRef = useRef<AiSummaryNodeDetail | null>(null)
  const pendingRef = useRef<PendingWrite | null>(null)
  const requestedRef = useRef<NodeRead | null>(null)
  const formDirtyRef = useRef(false)
  const reviewDirtyRef = useRef(false)
  const callback = useRef(onDirtyChange)
  callback.current = onDirtyChange
  const run = node?.run ?? null
  const archived = Boolean(book.book.archivedAt)
  const baseBlocked = busy || loading || reading || Boolean(operation || pending || pendingMessage)
  const blocked = baseBlocked || Boolean(requestedNode)
  const activeView = Boolean(task && status?.activeTask?.id === task.id && !terminal(task))
  const currentView = Boolean(activeView && node && task?.currentNode?.id === node.id)
  const generating = run?.state === 'running' || Boolean(task?.currentNode?.runState === 'running' && task.currentNode.id !== node?.id)
  const ready = status !== null && status.schemaVersion >= 9 && !status.requiresUpgrade && connections !== null && !connections.requiresUpgrade
  const edited = formDirty || reviewDirty
  const dirty = blocked || generating || edited
  const formLocked = blocked || archived || generating || Boolean(discard)
  const staleRun = Boolean(run && status && (run.context.bookRevision !== status.bookRevision || run.context.knowledgeRevision !== status.knowledgeRevision))
  const savedConnection = connections?.connections.find((item) => item.id === run?.context.connection.id)
  const changedConnection = Boolean(run?.state === 'prepared' && connections && (!savedConnection || JSON.stringify(savedConnection) !== JSON.stringify(run.context.connection)))
  const needsCheckpoint = Boolean(currentView && run && run.state !== 'running' && run.state !== 'adopted' && (['failed', 'cancelled', 'interrupted', 'rejected'].includes(run.state) || staleRun || changedConnection))
  const editable = currentView && task?.sourceCurrent && task.state === 'ready' && run?.state === 'succeeded' && !staleRun
  const parsed = useMemo(() => readProposal(run), [run?.id, run?.state, run?.outputText, run?.context])
  const selectedChapters = book.chapters.filter((chapter) => form.scope === 'book' || chapter.volumeId === (form.scope === 'ungrouped' ? null : form.scope)).length
  const panelError = [message, error].filter((value, index, values) => value && value !== pendingMessage && values.indexOf(value) === index).join(' ') || null

  function active(at: number): boolean { return mounted.current && epoch.current === at }
  function hold(value: PendingWrite | null) { pendingRef.current = value; setPending(value) }
  function queueNode(value: NodeRead | null) { requestedRef.current = value; setRequestedNode(value) }
  function markFormDirty(value: boolean) { formDirtyRef.current = value; setFormDirty(value) }
  function markReviewDirty(value: boolean) { reviewDirtyRef.current = value; setReviewDirty(value) }
  function saveTask(value: AiSummaryTaskDetail) { taskRef.current = value; setTask(value) }
  function acceptableStatus(value: AiSummaryStatus): boolean {
    const previous = statusRef.current
    return value.bookId === book.book.id && (!value.activeTask || value.activeTask.bookId === book.book.id) && value.recentTasks.every((item) => item.bookId === book.book.id) &&
      (!previous || value.bookRevision >= previous.bookRevision && value.knowledgeRevision >= previous.knowledgeRevision)
  }
  function acceptStatus(value: AiSummaryStatus): boolean { if (!acceptableStatus(value)) return false; statusRef.current = value; setStatus(value); return true }
  function acceptConnections(value: AiConnectionPage): boolean {
    if (value.bookId !== book.book.id) return false
    setConnections(value)
    if (!formDirtyRef.current) setForm((previous) => ({ ...previous, connectionId: value.connections.some((item) => item.id === previous.connectionId) ? previous.connectionId : value.connections[0]?.id ?? '' }))
    return true
  }
  function resetReview(value: AiRun | null) {
    const proposal = readProposal(value).proposal
    setAcceptedText(value?.acceptedText ?? proposal?.summary ?? ''); markReviewDirty(false)
  }
  function clearNode() { nodeRef.current = null; setNode(null); setSourceNode(null); resetReview(null) }
  function acceptNode(value: AiSummaryNodeDetail, owner: AiSummaryTaskDetail, expected: AiSummaryNodeSummary, replaceReview = false): boolean {
    const previous = nodeRef.current
    if (taskRef.current?.id !== owner.id || !validNode(owner, value, expected) ||
      (!replaceReview && reviewDirtyRef.current && previous?.runId !== value.runId) ||
      (previous?.run?.id === value.run?.id && previous?.run && value.run && (value.run.version < previous.run.version || JSON.stringify(value.run.context) !== JSON.stringify(previous.run.context)))) return false
    nodeRef.current = value; setNode(value)
    if (previous?.id !== value.id) setSourceNode(null)
    // 进度刷新只推进固定候选；作者编辑中的摘要不会被同一候选的轮询覆盖。
    if (replaceReview || !reviewDirtyRef.current && (previous?.id !== value.id || previous?.run?.state !== value.run?.state || previous?.run?.outputText !== value.run?.outputText)) resetReview(value.run)
    const current = taskRef.current
    if (current) saveTask({ ...current, currentNode: current.currentNode?.id === value.id ? value : current.currentNode, nodes: current.nodes.map((item) => item.id === value.id ? value : item) })
    return true
  }
  function acceptRun(value: AiRun, owner: AiSummaryTaskDetail, source: AiSummaryNodeSummary): boolean {
    const current = nodeRef.current
    if (!current || current.id !== source.id || !validRun(value, owner, source)) return false
    return acceptNode({ ...current, runId: value.id, runState: value.state, run: value }, owner, source)
  }
  function writableTask(): AiSummaryTaskDetail | null {
    const current = taskRef.current; const activeTask = statusRef.current?.activeTask
    return current && current.id === activeTask?.id && current.version === activeTask.version && !terminal(current) ? current : null
  }
  function begin(label: string, allowArchived = false): number | null {
    if (lock.current || blocked || pendingRef.current || requestedRef.current || archived && !allowArchived) return null
    lock.current = true; ticket.current += 1; setOperation(label); setMessage(null); setDiscard(null); callback.current(true)
    return epoch.current
  }
  function finish(at: number) { if (active(at)) { lock.current = false; setOperation(null) } }
  function guardReview(label: string, proceed: () => void) {
    if (reviewDirtyRef.current) setDiscard({ label, proceed: () => { resetReview(nodeRef.current?.run ?? null); proceed() } })
    else proceed()
  }
  function close() {
    if (blocked || lock.current || pendingRef.current || requestedRef.current || generating) return
    if (formDirtyRef.current || reviewDirtyRef.current) { setDiscard({ label: '放弃本页未保存的任务要求和摘要修改，并关闭？已保存的任务、采用记录与原输出会保留。', proceed: () => { markFormDirty(false); markReviewDirty(false); callback.current(false); onClose() } }); return }
    callback.current(false); onClose()
  }

  useEffect(() => {
    mounted.current = true; lock.current = false; setRefreshRequested(true)
    return () => { mounted.current = false; epoch.current += 1; ticket.current += 1; callback.current(false) }
  }, [api, book.book.id])
  useEffect(() => { callback.current(dirty) }, [dirty])
  useEffect(() => { setRecoveryConfirmed(false) }, [pending, pendingMessage, form, acceptedText, edited])

  async function write<T>(label: string, send: () => Promise<Result<T>>, accept: (value: T) => boolean, receive: (response: CompletedRequest) => boolean, allowArchived = false): Promise<boolean> {
    const at = begin(label, allowArchived)
    if (at === null) return false
    try {
      const result = await request(send)
      if (!active(at)) return false
      if (result.ok) {
        if (accept(result.data)) return true
        setMessage('原回执与固定任务或候选不符，已保留编辑并锁定新的写入。'); hold({ label, receive }); return false
      }
      setMessage(result.error.message)
      if (['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'STORAGE_ERROR'].includes(result.error.code)) hold({ requestId: result.error.requestId, label, receive })
      else if (result.error.code === 'REVISION_CONFLICT') setRefreshRequested(true)
      return false
    } finally { finish(at) }
  }
  function receiveGeneration(response: CompletedRequest, source: NodeRead): boolean {
    if (response.command === 'ai.connection.list') {
      if (response.result.ok && !acceptConnections(response.result.data)) return false
    } else if (response.command === 'ai.get' || response.command === 'ai.claim' || response.command === 'ai.checkpoint' || response.command === 'ai.finish') {
      if (response.result.ok && !acceptRun(response.result.data, source.task, source.node)) return false
    } else return false
    setMessage(response.result.ok ? '原请求已确认，正在只读核对当前节点候选；不会重发。' : response.result.error.message)
    queueNode({ ...source, runOnly: true }); setPollStopped(false); return true
  }
  async function checkLocalReceipt() {
    const captured = pendingRef.current
    if (!captured || lock.current || reading || checkingLocal || checkingReceipt || busy || pendingMessage) return
    if (!captured.requestId) { setMessage('原操作没有可查询的请求编号，请先留存本页内容再进入恢复核对。'); return }
    const at = epoch.current; setCheckingLocal(true)
    try {
      const result = await request(() => api.getRequestStatus({ requestId: captured.requestId! }))
      if (!active(at) || pendingRef.current !== captured) return
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.state !== 'completed') { setMessage(result.data.state === 'pending' ? '原请求仍在处理，请稍后核对。' : '原回执已不可用，请留存本页内容后进入恢复。'); return }
      const response = result.data.response
      if (!response.result.ok && ['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'STORAGE_ERROR'].includes(response.result.error.code)) { setMessage(response.result.error.message); return }
      if (!captured.receive(response)) { setMessage('原回执的对象、操作或版本不符，已保持写入锁定。'); return }
      hold(null)
    } finally { if (active(at)) setCheckingLocal(false) }
  }
  async function readRunData(source: NodeRead, at: number, currentTicket: number): Promise<boolean> {
    if (!source.node.runId) return false
    const result = await request(() => api.getAiRun({ bookId: book.book.id, runId: source.node.runId! }))
    if (!active(at) || ticket.current !== currentTicket) return false
    if (result.ok && acceptRun(result.data, source.task, source.node)) { setPollStopped(false); setPollCycle((value) => value + 1); return true }
    setPollStopped(true); setMessage(result.ok ? '节点候选的任务、来源指纹或固定上下文不符，已停止刷新。' : result.error.message)
    if (result.ok || ['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'STORAGE_ERROR'].includes(result.error.code)) hold({ requestId: result.ok ? undefined : result.error.requestId, label: '核对汇总候选', retryRead: source, receive: (response) => receiveGeneration(response, source) })
    return false
  }
  async function retryRunRead() {
    const captured = pendingRef.current; const source = captured?.retryRead
    if (!captured || !source || lock.current || busy || loading || reading || operation || pendingMessage || checkingLocal || checkingReceipt || requestedRef.current ||
      taskRef.current?.id !== source.task.id || nodeRef.current?.id !== source.node.id || nodeRef.current?.runId !== source.node.runId) return
    const at = epoch.current; const currentTicket = ++ticket.current
    lock.current = true; setReading(true)
    try {
      // 读取成功仅解除本次读取等待，不能替代采用等写入的专属回执；acceptRun 保留作者编辑。
      if (await readRunData(source, at, currentTicket) && active(at) && ticket.current === currentTicket && pendingRef.current === captured) {
        hold(null); setMessage(null)
      }
    } finally { if (active(at) && ticket.current === currentTicket) { lock.current = false; setReading(false) } }
  }
  async function readNodeData(source: NodeRead, at: number, currentTicket: number): Promise<boolean> {
    const result = await request(() => api.getAiSummaryNode({ bookId: book.book.id, taskId: source.task.id, nodeId: source.node.id }))
    if (!active(at) || ticket.current !== currentTicket) return false
    if (!result.ok || !acceptNode(result.data, source.task, source.node)) { setMessage(result.ok ? '节点的任务、层级、章节覆盖或固定来源不符。' : result.error.message); return false }
    return !result.data.runId || await readRunData({ task: source.task, node: result.data }, at, currentTicket)
  }
  async function readTaskData(id: string, afterOrdinal: number | undefined, at: number, currentTicket: number): Promise<boolean> {
    const result = await request(() => api.getAiSummaryTask({ bookId: book.book.id, taskId: id, ...(afterOrdinal === undefined ? {} : { afterOrdinal }) }))
    if (!active(at) || ticket.current !== currentTicket) return false
    if (!result.ok) { setMessage(result.error.message); return false }
    const value = result.data; const previous = taskRef.current
    if (!validTask(book.book.id, value, id) || previous?.id === id && value.version < previous.version) { setMessage('汇总任务的作品、版本或节点分页范围不符。'); return false }
    const selected = previous?.id === id && nodeRef.current?.taskId === id ? nodeRef.current : value.currentNode ?? value.nodes[0] ?? null
    if (reviewDirtyRef.current && selected?.id !== nodeRef.current?.id) { setMessage('任务节点已有变化，请先留存或明确放弃审阅修改。'); return false }
    saveTask(value); setPageAfter(afterOrdinal)
    if (!selected) { clearNode(); return true }
    return await readNodeData({ task: value, node: selected }, at, currentTicket)
  }
  async function initialize() {
    if (lock.current || busy || pendingRef.current || pendingMessage || operation) return
    const at = epoch.current; const currentTicket = ++ticket.current
    lock.current = true; setLoading(true); setMessage(null)
    try {
      const results = await Promise.allSettled([request(() => api.getAiSummaryStatus({ bookId: book.book.id })), request(() => api.listAiConnections({ bookId: book.book.id }))])
      if (!active(at) || ticket.current !== currentTicket) return
      const [statusResult, connectionResult] = results
      if (connectionResult.status !== 'fulfilled' || !connectionResult.value.ok || !acceptConnections(connectionResult.value.data)) setMessage(connectionResult.status === 'fulfilled' && !connectionResult.value.ok ? connectionResult.value.error.message : '连接读取失败或作品身份不符。')
      if (statusResult.status !== 'fulfilled' || !statusResult.value.ok || !acceptStatus(statusResult.value.data)) { setMessage(statusResult.status === 'fulfilled' && !statusResult.value.ok ? statusResult.value.error.message : '汇总状态读取失败或作品身份不符。'); return }
      const value = statusResult.value.data; const id = taskRef.current?.id ?? value.activeTask?.id ?? value.recentTasks[0]?.id
      if (!value.requiresUpgrade && value.schemaVersion >= 9 && id) await readTaskData(id, taskRef.current?.id === id ? pageAfter : undefined, at, currentTicket)
    } finally { if (active(at) && ticket.current === currentTicket) { lock.current = false; setLoading(false) } }
  }
  useEffect(() => {
    if (!refreshRequested || busy || reading || operation || pending || pendingMessage || lock.current || requestedNode) return
    setRefreshRequested(false); void initialize()
  }, [refreshRequested, busy, reading, operation, pending, pendingMessage, requestedNode])
  async function readNode(source: NodeRead) {
    if (lock.current || baseBlocked || taskRef.current?.id !== source.task.id) return
    const at = epoch.current; const currentTicket = ++ticket.current
    lock.current = true; setReading(true)
    try { if (source.runOnly) await readRunData(source, at, currentTicket); else await readNodeData(source, at, currentTicket) }
    finally { if (active(at) && ticket.current === currentTicket) { lock.current = false; setReading(false) } }
  }
  useEffect(() => {
    if (!requestedNode || baseBlocked || lock.current) return
    const source = requestedNode; queueNode(null); void readNode(source)
  }, [requestedNode, baseBlocked])
  useEffect(() => {
    if (!task || !node || !run || run.state !== 'running' || run.active === false || blocked || pollStopped) return
    const source = { task, node, runOnly: true }
    const timer = window.setTimeout(() => { void readNode(source) }, 1200)
    return () => window.clearTimeout(timer)
  }, [task?.id, node?.id, run?.id, run?.state, run?.active, run?.version, blocked, pollStopped, pollCycle])
  async function readTask(id: string, afterOrdinal?: number, trail: (number | undefined)[] = []) {
    if (blocked || generating || lock.current) return
    const at = epoch.current; const currentTicket = ++ticket.current
    lock.current = true; setReading(true); setMessage(null); setDiscard(null)
    try { if (await readTaskData(id, afterOrdinal, at, currentTicket)) setPageTrail(trail) }
    finally { if (active(at) && ticket.current === currentTicket) { lock.current = false; setReading(false) } }
  }
  function openTask(id: string) { guardReview('放弃本页尚未采用的摘要修改，并读取这份任务？原输出仍保留。', () => void readTask(id)) }
  function openNode(value: AiSummaryNodeSummary) {
    const owner = taskRef.current
    if (!owner || blocked || generating && value.id !== owner.currentNode?.id) return
    guardReview('放弃本页尚未采用的摘要修改，并读取这个节点？', () => void readNode({ task: owner, node: value }))
  }
  async function inspectSource(source: AiSummarySource, fromLevel: number) {
    const owner = taskRef.current
    if (!owner || source.kind !== 'node' || blocked || lock.current) return
    const at = epoch.current; const currentTicket = ++ticket.current
    lock.current = true; setReading(true); setMessage(null)
    try {
      const result = await request(() => api.getAiSummaryNode({ bookId: book.book.id, taskId: owner.id, nodeId: source.id }))
      if (!active(at) || ticket.current !== currentTicket || taskRef.current?.id !== owner.id) return
      if (result.ok && result.data.id === source.id && result.data.title === source.title && validNode(owner, result.data, result.data) &&
        result.data.state === 'approved' && result.data.acceptedText === source.text && result.data.chapterCount === source.chapterCount &&
        result.data.level === fromLevel - 1 && result.data.run?.context.chapterId === source.chapterId &&
        result.data.run.context.chapterRevisionId === source.chapterRevisionId && result.data.run.context.chapterTitle === source.chapterTitle) setSourceNode(result.data)
      else setMessage(result.ok ? '下层节点与固定摘要来源不符，已保留当前审阅内容。' : result.error.message)
    } finally { if (active(at) && ticket.current === currentTicket) { lock.current = false; setReading(false) } }
  }
  function acceptableReceipt(value: AiSummaryReceipt, previous?: AiSummaryTaskSummary, sent?: AiSummaryStartInput, replaceReview = false): boolean {
    if (!isAiSummaryReceiptFor(book.book.id, value, previous) || !validTask(book.book.id, value.task, value.task.id) || !acceptableStatus(value.status) ||
      previous && taskRef.current?.id !== previous.id || value.node && (!value.task.currentNode || !validNode(value.task, value.node, value.task.currentNode)) ||
      sent && (!sameScope(sent.scope, value.task.scope) || value.task.fanIn !== sent.fanIn || value.task.connectionId !== sent.connectionId || value.task.instruction !== sent.instruction || value.task.sourceBookRevision !== sent.expectedBookRevision || value.task.sourceKnowledgeRevision !== sent.expectedKnowledgeRevision)) return false
    const previousNode = nodeRef.current
    if (!replaceReview && reviewDirtyRef.current && previousNode?.runId !== value.node?.runId) return false
    return !(previousNode?.run && value.node?.run?.id === previousNode.run.id && (value.node.run.version < previousNode.run.version || JSON.stringify(value.node.run.context) !== JSON.stringify(previousNode.run.context)))
  }
  function applyReceipt(value: AiSummaryReceipt, previous?: AiSummaryTaskSummary, sent?: AiSummaryStartInput, replaceReview = false): boolean {
    if (!acceptableReceipt(value, previous, sent, replaceReview)) return false
    acceptStatus(value.status); saveTask(value.task); setPageAfter(undefined); setPageTrail([])
    if (value.node && value.task.currentNode) {
      if (!acceptNode(value.node, value.task, value.task.currentNode, replaceReview)) return false
      if (value.node.run?.state === 'running') queueNode({ task: value.task, node: value.node, runOnly: true })
    } else {
      clearNode()
      if (value.task.currentNode) queueNode({ task: value.task, node: value.task.currentNode })
    }
    if (sent) markFormDirty(false)
    setPollStopped(false); return true
  }
  function taskReceiver(command: 'ai.summary.start' | 'ai.summary.step' | 'ai.summary.control', previous?: AiSummaryTaskSummary, sent?: AiSummaryStartInput) {
    return (response: CompletedRequest): boolean => {
      if (response.command !== command || response.command !== 'ai.summary.start' && response.command !== 'ai.summary.step' && response.command !== 'ai.summary.control') return false
      if (!response.result.ok) { setMessage(response.result.error.message); setRefreshRequested(true); return true }
      return applyReceipt(response.result.data, previous, sent)
    }
  }
  async function start(event: FormEvent) {
    event.preventDefault()
    const current = statusRef.current
    if (!current || !ready || current.activeTask || generating) return
    let input: AiSummaryStartInput
    try { input = parseAiSummaryStartInput({ bookId: book.book.id, expectedBookRevision: current.bookRevision,
      expectedKnowledgeRevision: current.knowledgeRevision, connectionId: form.connectionId, scope: formScope(form.scope), fanIn: form.fanIn, instruction: form.instruction }) }
    catch (cause) { setMessage(cause instanceof DomainError ? cause.detail.message : '请核对汇总范围、模型连接与要求。'); return }
    guardReview('放弃尚未采用的摘要修改，并固定新任务来源？', () => void write('固定完整摘要来源', () => api.startAiSummaryTask(input),
      (value) => applyReceipt(value, undefined, input), taskReceiver('ai.summary.start', undefined, input)))
  }
  async function step() {
    const owner = writableTask()
    if (!owner || !owner.sourceCurrent || !['planning', 'ready'].includes(owner.state) || generating) return
    if (owner.phase === 'reviewing' && owner.currentNode?.runId && !needsCheckpoint) return
    guardReview('放弃尚未采用的摘要修改，并核对当前检查点？', () => void write(owner.phase === 'planning' ? '规划下一批节点' : needsCheckpoint ? '记录节点异常检查点' : '保存节点发送预览',
      () => api.stepAiSummaryTask({ bookId: book.book.id, taskId: owner.id, expectedTaskVersion: owner.version }),
      (value) => applyReceipt(value, owner), taskReceiver('ai.summary.step', owner)))
  }
  async function controlConfirmed(action: AiSummaryControlInput['action']) {
    const owner = writableTask()
    if (!owner || generating && action !== 'pause') return
    const labels = { pause: '暂停任务', resume: '恢复任务', retry: '恢复节点准备检查点', cancel: '取消汇总任务' }
    await write(labels[action], () => api.controlAiSummaryTask({ bookId: book.book.id, taskId: owner.id, expectedTaskVersion: owner.version, action }),
      (value) => applyReceipt(value, owner), taskReceiver('ai.summary.control', owner))
  }
  function control(action: AiSummaryControlInput['action']) {
    if (blocked || generating && action !== 'pause' || !writableTask()) return
    if (action === 'retry' || action === 'cancel') {
      const label = action === 'retry' ? '重试当前节点准备？原候选和尝试仍保留；重试后须另行准备预览并明确发送。' : '取消本次汇总任务？已采用摘要和原输出仍保留。'
      if (reviewDirtyRef.current) guardReview(`放弃未采用的摘要修改，${label}`, () => void controlConfirmed(action))
      else setDiscard({ label, proceed: () => void controlConfirmed(action) })
    } else void controlConfirmed(action)
  }
  async function sendRun() {
    const owner = writableTask(); const currentNode = nodeRef.current; const current = currentNode?.run
    if (!owner || owner.state !== 'ready' || !owner.sourceCurrent || !currentNode || currentNode.id !== owner.currentNode?.id ||
      !current || current.state !== 'prepared' || staleRun || changedConnection || !validRun(current, owner, currentNode)) return
    const source = { task: owner, node: currentNode }
    await write('明确发送当前节点并生成', () => api.startAiRun({ bookId: book.book.id, runId: current.id, expectedVersion: current.version, contextHash: current.context.contextHash }),
      (value) => value.state === 'running' && value.version === current.version + 1 && value.active === true && acceptRun(value, owner, currentNode),
      (response) => receiveGeneration(response, source))
  }
  async function stopRun() {
    const owner = taskRef.current; const currentNode = nodeRef.current; const current = currentNode?.run
    if (!owner || !currentNode || !current || current.state !== 'running') return
    await write('取消生成并保留部分输出', () => api.cancelAiRun({ bookId: book.book.id, runId: current.id }),
      (value) => acceptRun(value, owner, currentNode), (response) => receiveGeneration(response, { task: owner, node: currentNode }))
  }
  async function finishRun(action: 'interrupt' | 'reject') {
    // 历史或归档任务中的孤立生成也须允许留存中断，避免与关闭保护互相锁住。
    const owner = action === 'interrupt' ? taskRef.current : writableTask()
    const currentNode = nodeRef.current; const current = currentNode?.run
    if (!owner || !currentNode || !current || !validRun(current, owner, currentNode)) return
    if (action === 'interrupt' ? current.state !== 'running' || current.active !== false : currentNode.id !== owner.currentNode?.id || ['running', 'adopted', 'rejected'].includes(current.state)) return
    const accept = (value: AiRun) => value.version === current.version + 1 && value.state === (action === 'interrupt' ? 'interrupted' : 'rejected') && acceptRun(value, owner, currentNode)
    const receive = (response: CompletedRequest): boolean => {
      if (response.command !== (action === 'interrupt' ? 'ai.interrupt' : 'ai.reject')) return false
      if (!response.result.ok) { setMessage(response.result.error.message); return true }
      return accept(response.result.data as AiRun)
    }
    await write(action === 'interrupt' ? '标记汇总生成中断' : '拒绝当前汇总候选', () => action === 'interrupt'
      ? api.interruptAiRun({ bookId: book.book.id, runId: current.id, expectedVersion: current.version })
      : api.rejectAiRun({ bookId: book.book.id, runId: current.id, expectedVersion: current.version }), accept, receive, action === 'interrupt')
  }
  async function adoptSummary() {
    const owner = writableTask(); const currentNode = nodeRef.current; const current = currentNode?.run
    if (!owner || owner.state !== 'ready' || !owner.sourceCurrent || !currentNode || owner.currentNode?.id !== currentNode.id ||
      !current || current.state !== 'succeeded' || staleRun || !validRun(current, owner, currentNode) || !readProposal(current).proposal) return
    let input: AiSummaryAdoptInput
    try { input = parseAiSummaryAdoptInput({ bookId: book.book.id, taskId: owner.id, expectedTaskVersion: owner.version,
      nodeId: currentNode.id, runId: current.id, expectedRunVersion: current.version, acceptedText }) }
    catch (cause) { setMessage(cause instanceof DomainError ? cause.detail.message : '请核对采用的汇总内容。'); return }
    const at = begin('采用当前节点摘要')
    if (at === null) return
    try {
      await onAdoptSummary(input, current, owner, (receipt) => {
        if (!active(at)) return false
        // 父子共同核对整个采用事务；先完成全部校验，再改变编辑状态和条件写入基线。
        if (!isAiSummaryAdoptReceiptFor(input, current, owner, receipt) || !acceptableReceipt(receipt, owner, undefined, true) ||
          !validNode(receipt.task, receipt.adoptedNode, currentNode)) {
          setMessage('采用回执与固定节点或审阅内容不符，请留存本页后核对。'); hold({ label: '核对汇总采用', receive: () => false }); return false
        }
        acceptStatus(receipt.status); saveTask(receipt.task); setPageAfter(undefined); setPageTrail([])
        if (!acceptNode(receipt.adoptedNode, receipt.task, currentNode, true)) {
          hold({ label: '核对汇总采用', receive: () => false }); return false
        }
        setMessage(receipt.task.state === 'completed' ? '范围内全部节点摘要已采用。历史来源与原输出保留，汇总尚未自动加入创作上下文。' : '节点摘要已采用。请明确准备下一个节点，不会自动发送。')
        return true
      })
    } catch { if (active(at)) { setMessage('采用结果未确认，请保留审阅内容后核对原回执。'); hold({ label: '核对汇总采用', receive: () => false }) } }
    finally { finish(at) }
  }
  async function upgrade() {
    if (!upgradeConfirmed || !status?.requiresUpgrade || generating) return
    const at = begin('备份并启用分层汇总')
    if (at === null) return
    try {
      await onUpgrade((value) => {
        if (!active(at)) return
        if (value.bookId !== book.book.id || value.schemaVersion < 11) {
          setMessage('升级回执尚未确认 v11 可用，请保留本页并核对。'); hold({ label: '核对分层汇总升级', receive: () => false }); return
        }
        setBackupPath(value.backupPath ?? null); setUpgradeConfirmed(false); setRefreshRequested(true)
      })
    } catch { if (active(at)) { setMessage('升级结果未确认，请保留本页后进入恢复核对。'); hold({ label: '核对分层汇总升级', receive: () => false }) } }
    finally { finish(at) }
  }
  function recover() {
    if (operation || reading || checkingLocal || checkingReceipt || edited && !recoveryConfirmed) return
    callback.current(false); onRecover()
  }
  const recoveryText = JSON.stringify({ bookId: book.book.id, task, activeTask: status?.activeTask ?? null, node, run,
    summaryReview: reviewDirty ? acceptedText : undefined, taskForm: formDirty ? form : undefined,
    pendingRequest: pending ? { requestId: pending.requestId, label: pending.label } : undefined }, null, 2)
  const canStep = activeView && task?.sourceCurrent && ['planning', 'ready'].includes(task.state) &&
    (task.phase === 'planning' || !task.currentNode?.runId || needsCheckpoint)

  return <Dialog title="卷与全书分层汇总" wide busy={blocked || generating} onClose={close} error={panelError}>
    <div className={layout.intro}><p>《{book.book.title}》</p><span>固定已采用章节摘要 → 逐层汇总 → 作者逐节点审阅</span></div>
    <p className={styles.note}>每次只发送一组完整下层摘要。缺少当前稿的章节摘要时先补齐章节整理；上层须等下层全部采用。本页保存独立汇总资料，采用不会自动写入知识条目。</p>
    {operation && <p className={styles.note} role="status">{operation}…</p>}
    {(pending || pendingMessage) && <section className={layout.pending} role="alert"><h3>本次操作结果未确认</h3><p>{pendingMessage ?? `${pending?.label}尚未收到确定回执，新的写入已暂停。`}</p><p>查询原请求只核对已保存的结果，不会重新发送或采用。</p>
      <label>任务、候选与本页编辑的恢复副本<textarea className={styles.recoveryCopy} value={recoveryText} readOnly rows={8} onFocus={(event) => event.target.select()} /></label>
      {edited && <label className={shared.checkLabel}><input type="checkbox" checked={recoveryConfirmed} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />我已复制留存任务要求与审阅修改，允许进入恢复</label>}
      <div className={styles.actions}><button type="button" className={shared.button} disabled={reading || checkingLocal || checkingReceipt || Boolean(operation)} onClick={pendingMessage ? onCheckReceipt : () => void checkLocalReceipt()}>{checkingLocal || checkingReceipt ? '正在核对…' : '查询原回执'}</button>
        {pending?.retryRead && !pendingMessage && <button type="button" className={shared.button} disabled={busy || loading || reading || Boolean(operation || requestedNode) || checkingLocal || checkingReceipt} onClick={() => void retryRunRead()}>重新读取原候选</button>}
        <button type="button" className={shared.button} disabled={Boolean(operation) || reading || checkingLocal || checkingReceipt || edited && !recoveryConfirmed} onClick={recover}>进入草稿与恢复</button></div>
    </section>}
    {loading && <p className={styles.note} role="status">正在只读核对汇总任务、连接与节点…</p>}
    {!loading && (!status || !connections) && <button type="button" className={shared.button} disabled={blocked} onClick={() => setRefreshRequested(true)}>重新读取状态</button>}
    {status?.requiresUpgrade && <section className={layout.upgrade}><h3>为本书启用分层汇总</h3><p>当前作品格式 v{status.schemaVersion}。先建立独立数据库备份，再升级到当前作品格式，保存汇总任务、分层节点与不可变尝试。</p><label className={layout.upgradeCheck}><input type="checkbox" checked={upgradeConfirmed} disabled={blocked || archived || generating} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />同意为本书创建数据库备份并升级</label><button type="button" className={shared.primaryButton} disabled={blocked || archived || generating || !upgradeConfirmed} onClick={() => void upgrade()}>备份并启用</button></section>}
    {backupPath && <p className={layout.backupPath}>升级前数据库副本：{backupPath}</p>}
    {ready && <>
      <section className={styles.composer} aria-label="新建汇总任务"><div className={styles.heading}><h3>新建分层汇总</h3><span>{status.activeTask ? '已有活动任务' : '同时保留一个活动任务'}</span></div>
        <form className={layout.editorForm} onSubmit={(event) => void start(event)}>
          <div className={layout.twoColumns}><label>汇总范围<select value={form.scope} disabled={formLocked} onChange={(event) => { setForm({ ...form, scope: event.target.value }); markFormDirty(true) }}><option value="book">全书章节</option>{book.volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title}</option>)}<option value="ungrouped">未分卷章节</option></select></label><label>每组完整摘要数<select value={form.fanIn} disabled={formLocked} onChange={(event) => { setForm({ ...form, fanIn: Number(event.target.value) as 2 | 4 | 8 }); markFormDirty(true) }}><option value={2}>2 份</option><option value={4}>4 份</option><option value={8}>8 份</option></select></label></div>
          <label>已保存的模型连接<select value={form.connectionId} disabled={formLocked} onChange={(event) => { setForm({ ...form, connectionId: event.target.value }); markFormDirty(true) }}><option value="" disabled>请选择连接</option>{connections.connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
          <p className={styles.note}>连接与本次会话的密钥在“AI 创作协作”管理。当前范围含 {selectedChapters.toLocaleString()} 章；全书已有 {status.availableChapterSummaries.toLocaleString()}／{status.totalChapters.toLocaleString()} 章具备当前稿、当前标题的已采用摘要，创建时逐章核对所选范围。</p>
          <label>每层汇总要求<textarea value={form.instruction} rows={4} maxLength={6000} required disabled={formLocked} onChange={(event) => { setForm({ ...form, instruction: event.target.value }); markFormDirty(true) }} /></label>
          <p className={styles.note}>来源超预算会拒绝准备，请选择较小分组或调整连接预算。一次最多规划 {AI_SUMMARY_PLAN_PAGE} 个节点，所有发送均需逐节点确认。</p>
          <div className={styles.actions}><button type="submit" className={shared.primaryButton} disabled={formLocked || Boolean(status.activeTask) || !form.connectionId || !form.instruction.trim() || selectedChapters === 0}>创建本地汇总任务</button><button type="button" className={shared.button} disabled={blocked || generating} onClick={() => setRefreshRequested(true)}>刷新状态</button></div>
        </form>
      </section>
      {status.activeTask && task?.id !== status.activeTask.id && <section className={styles.run}><h3>当前活动任务 · {status.activeTask.scopeTitle}</h3><button type="button" className={shared.button} disabled={blocked || generating} onClick={() => openTask(status.activeTask!.id)}>返回活动任务</button></section>}
      {task && <section className={styles.run} aria-label="已保存的汇总任务"><div className={styles.heading}><h3>{task.scopeTitle} · 每组 {task.fanIn} 份</h3><span>{taskLabels[task.state]} · {activeView ? '活动任务' : '历史只读记录'}</span></div>
        <p className={styles.note}>范围 {task.totalChapters.toLocaleString()} 章 · 已规划 {task.plannedNodes.toLocaleString()}／{task.totalNodes.toLocaleString()} 个节点 · 已采用 {task.approvedNodes.toLocaleString()} 个</p><progress aria-label="汇总节点采用进度" value={task.approvedNodes} max={Math.max(1, task.totalNodes)} />
        <p className={styles.identity}>任务 {task.id} · 版本 {task.version} · {displayTime(task.updatedAt)}<br />创建时连接 {task.connectionName} · {task.model}<br />创建时作品版本 {task.sourceBookRevision}／知识版本 {task.sourceKnowledgeRevision}<br />来源指纹 {task.manifestHash}</p>
        <details className={styles.messages}><summary>固定汇总要求</summary><pre>{task.instruction}</pre></details><p className={styles.note}>新候选使用固定连接 ID 的当前配置，实际模型与预算以节点预览为准。</p>
        {!task.sourceCurrent && <p className={shared.formError} role="alert">范围内原稿、标题、顺序或已采用的章节摘要已变化。旧汇总保留为历史，不能继续发送或采用；请取消旧任务后按新来源重新创建。</p>}
        {task.error && <p className={shared.formError} role="alert">{task.error}</p>}
        {activeView && <div className={styles.actions}>
          {canStep && <button type="button" className={shared.primaryButton} disabled={blocked || archived || generating} onClick={() => void step()}>{task.phase === 'planning' ? `规划下一批（最多 ${AI_SUMMARY_PLAN_PAGE} 个）` : needsCheckpoint ? '记录节点异常检查点' : '准备当前节点发送预览'}</button>}
          {['planning', 'ready'].includes(task.state) && <button type="button" className={shared.button} disabled={blocked || archived} onClick={() => control('pause')}>暂停任务</button>}
          {task.state === 'paused' && <button type="button" className={shared.button} disabled={blocked || archived || generating || !task.sourceCurrent} onClick={() => control('resume')}>恢复任务</button>}
          {task.state === 'failed' && <button type="button" className={shared.button} disabled={blocked || archived || generating || !task.sourceCurrent} onClick={() => control('retry')}>重试当前准备</button>}
          <button type="button" className={shared.button} disabled={blocked || archived || generating} onClick={() => control('cancel')}>取消任务</button>
        </div>}
        {task.currentNode && <p className={styles.note}>当前节点：{task.currentNode.title} · {task.currentNode.runState ? runLabels[task.currentNode.runState] : '尚无发送预览'}{node?.id !== task.currentNode.id && <button type="button" className={shared.textButton} disabled={blocked} onClick={() => openNode(task.currentNode!)}>查看当前节点</button>}</p>}
        {task.nodes.length > 0 && <details className={styles.history}><summary>本页节点（最多 {AI_SUMMARY_NODE_PAGE} 个）</summary><ul>{task.nodes.map((item) => <li key={item.id}><button type="button" className={styles.historyItem} disabled={blocked || generating} aria-current={node?.id === item.id ? 'true' : undefined} onClick={() => openNode(item)}><span><strong>{item.title}</strong><small>{item.state === 'approved' ? '已采用' : '待处理'} · {item.runState ? runLabels[item.runState] : '尚无候选'} · 尝试 {item.attempts} 次</small></span><span>查看节点</span></button></li>)}</ul></details>}
        <div className={layout.paging}><button type="button" className={shared.button} disabled={blocked || generating || pageTrail.length === 0} onClick={() => guardReview('放弃尚未采用的摘要修改，并读取上一页？', () => void readTask(task.id, pageTrail[pageTrail.length - 1], pageTrail.slice(0, -1)))}>上一页</button><button type="button" className={shared.button} disabled={blocked || generating || task.nextAfterOrdinal === null} onClick={() => guardReview('放弃尚未采用的摘要修改，并读取下一页？', () => void readTask(task.id, task.nextAfterOrdinal ?? undefined, [...pageTrail, pageAfter]))}>下一页</button></div>
      </section>}
      {node && task && <section className={styles.run} aria-label="汇总节点与审阅"><div className={styles.heading}><h3>{node.title}</h3><span>{node.state === 'approved' ? '作者已采用' : run ? runLabels[run.state] : '等待下层来源与预览'}</span></div>
        <SummarySources sources={node.sources} disabled={blocked} onInspect={(source) => void inspectSource(source, node.level)} />
        {run && <>
          {run.error && <p className={shared.formError} role="alert">{run.error}</p>}
          {(staleRun || changedConnection) && !['adopted', 'rejected'].includes(run.state) && <p className={shared.formError} role="alert">候选固定的作品、知识或连接版本已变化。请记录异常检查点，再重试并核对新预览。</p>}
          <SummaryPreview context={run.context} />
          <div className={styles.actions}>
            {currentView && task.state === 'ready' && task.sourceCurrent && run.state === 'prepared' && <button type="button" className={shared.primaryButton} disabled={blocked || archived || staleRun || changedConnection} onClick={() => void sendRun()}>确认当前节点并发送（可能产生费用）</button>}
            {run.state === 'running' && run.active !== false && <button type="button" className={shared.button} disabled={blocked || archived} onClick={() => void stopRun()}>取消生成并保留输出</button>}
            {run.state === 'running' && run.active === false && <button type="button" className={shared.button} disabled={blocked} onClick={() => void finishRun('interrupt')}>标记已中断并保留输出</button>}
            {currentView && !['running', 'adopted', 'rejected'].includes(run.state) && <button type="button" className={shared.button} disabled={blocked || archived} onClick={() => guardReview('放弃未采用的摘要修改，并拒绝本次候选？原输出仍保留。', () => void finishRun('reject'))}>拒绝本次候选</button>}
            <button type="button" className={shared.button} disabled={blocked} onClick={() => void readNode({ task, node, runOnly: true })}>只读刷新候选</button>
          </div>
          {run.state === 'running' && run.active === false && <p className={styles.note}>桌面进程没有对应活动网络。核对后可明确标记中断，不会自动重发。</p>}
          <details className={styles.messages}><summary>保留的模型原输出</summary><pre>{run.outputText || '尚无输出'}</pre></details>
          {parsed.error && <p className={shared.formError} role="alert">{parsed.error}</p>}
          {parsed.proposal && <><label className={styles.output}>作者审阅后的摘要<textarea className={styles.acceptedText} value={acceptedText} rows={10} maxLength={AI_SUMMARY_TEXT_LIMIT} disabled={blocked || archived || !editable} onChange={(event) => { setAcceptedText(event.target.value); markReviewDirty(true) }} /></label><p className={styles.note}>摘要最多 {AI_SUMMARY_TEXT_LIMIT.toLocaleString()} 字符，始终是 AI 整理资料；采用不提升为客观事实。下列引用来自固定下层摘要，不是本次读取的全书正文。</p><details className={styles.sources}><summary>固定下层摘要引文（{parsed.proposal.citations.length} 处）</summary>{parsed.proposal.citations.map((citation, index) => <div key={`${citation.sourceId}:${index}`}><p className={layout.sourceIds}>摘要来源 {citation.sourceId}</p><blockquote>{citation.quote}</blockquote></div>)}</details>
            {editable && <button type="button" className={shared.primaryButton} disabled={blocked || archived || !acceptedText.trim()} onClick={() => void adoptSummary()}>采用本节点摘要</button>}</>}
        </>}
      </section>}
      {sourceNode && <section className={styles.run} aria-label="下层来源追溯"><div className={styles.heading}><h3>下层来源 · {sourceNode.title}</h3><button type="button" className={shared.button} disabled={blocked} onClick={() => setSourceNode(null)}>收起来源</button></div><p className={layout.body}>{sourceNode.acceptedText}</p><SummarySources sources={sourceNode.sources} disabled={blocked} onInspect={(source) => void inspectSource(source, sourceNode.level)} /></section>}
      {status.recentTasks.length > 0 && <details className={styles.history}><summary>最近 {Math.min(10, status.recentTasks.length)} 份汇总任务</summary><ul>{status.recentTasks.slice(0, 10).map((item) => <li key={item.id}><button type="button" className={styles.historyItem} disabled={blocked || generating} aria-current={task?.id === item.id ? 'true' : undefined} onClick={() => openTask(item.id)}><span><strong>{item.scopeTitle} · 每组 {item.fanIn} 份</strong><small>已采用 {item.approvedNodes}／{item.totalNodes} 个节点 · {item.sourceCurrent ? '来源当前' : '历史来源'}</small></span><span>{taskLabels[item.state]}<small>{displayTime(item.updatedAt)}</small></span></button></li>)}</ul></details>}
      {archived && <p className={styles.note}>作品已归档，可读取历史与来源；解除归档后可继续汇总。</p>}
    </>}
    {discard && <section className={styles.discard} role="alert"><p>{discard.label}</p><div className={styles.actions}><button type="button" className={shared.button} disabled={blocked || generating} onClick={() => setDiscard(null)}>保留当前内容</button><button type="button" className={shared.primaryButton} disabled={blocked || generating} onClick={() => { const proceed = discard.proceed; setDiscard(null); proceed() }}>确认并继续</button></div></section>}
    <div className={styles.footer}><button type="button" className={shared.button} disabled={blocked || generating} onClick={close}>关闭</button></div>
  </Dialog>
}
