import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DomainError, type BookSnapshot, type CompletedRequest, type Result, type StudioApi } from '../../contracts/api'
import { AI_MEMORY_PROMPT_VERSION, isAiMemoryAdoptReceiptFor, parseAiMemoryAdoptInput, type AiConnectionPage, type AiContextPacket, type AiMaintenanceBaseline, type AiMemoryAdoptInput, type AiMemoryAdoptReceipt, type AiRun, type AiRunState } from '../../contracts/ai'
import { AI_MEMORY_TASK_CONSUMER, AI_MEMORY_TASK_PLAN_PAGE, AI_MEMORY_TASK_UNIT_PAGE, isAiMemoryTaskReceiptFor, parseAiMemoryTaskStartInput, type AiMemoryTaskControlInput, type AiMemoryTaskDetail, type AiMemoryTaskKind, type AiMemoryTaskReceipt, type AiMemoryTaskScope, type AiMemoryTaskStartInput, type AiMemoryTaskState, type AiMemoryTaskStatus, type AiMemoryTaskSummary, type AiMemoryTaskUnit } from '../../contracts/ai-memory-task'
import { AI_MEMORY_MAINTENANCE_BATCH, AI_MEMORY_MAINTENANCE_PAGE, isAiMemoryMaintenancePageFor, parseAiMemoryMaintenanceInput, type AiMemoryMaintenanceInput, type AiMemoryMaintenancePage } from '../../contracts/ai-memory-maintenance'
import type { KnowledgeStatus } from '../../contracts/knowledge'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import { AiMemoryReview, aiMemoryReviewEntries, createAiMemoryDrafts, type AiMemoryDraft } from './AiMemoryReview'
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
  onAdoptMemory: (input: AiMemoryAdoptInput, source: AiRun, accept: (receipt: AiMemoryAdoptReceipt) => boolean) => Promise<void>
}

interface TaskForm { kind: AiMemoryTaskKind; scope: string; selection: 'all' | 'pending_review'; connectionId: string; instruction: string }
interface PendingWrite { requestId?: string; label: string; receive: (response: CompletedRequest) => boolean }
interface DiscardAction { label: string; proceed: () => void }
interface RunRead { task: AiMemoryTaskDetail; unit: AiMemoryTaskUnit }
interface MaintenanceRead { input: AiMemoryMaintenanceInput; bookRevision: number; schemaVersion: number }
interface MaintenanceResult { source: MaintenanceRead; page: AiMemoryMaintenancePage }
const initialInstruction = '请严格依据本章正文整理，保留可核对的段落引文，区分正文陈述、人物认知与推断。'
const taskLabels: Record<AiMemoryTaskState, string> = { planning: '规划范围中', ready: '等待逐章处理', paused: '已暂停', failed: '处理失败', completed: '作者审阅已登记', superseded: '章节来源已变化', cancelled: '已取消' }
const kindLabels: Record<AiMemoryTaskKind, string> = { summarize: '章节摘要', extract: '知识建议' }
const runLabels: Record<AiRunState, string> = { prepared: '等待明确发送', running: '生成中', succeeded: '待作者审阅', failed: '生成失败', cancelled: '已取消生成', interrupted: '已中断', adopted: '作者已采用', rejected: '作者已拒绝' }
const unitLabels = { pending: '待处理', reviewed: '已登记作者决定', skipped: '作者已跳过' }
function terminal(task: AiMemoryTaskSummary): boolean { return ['completed', 'superseded', 'cancelled'].includes(task.state) }
function taskScope(value: string): AiMemoryTaskScope { return value === 'book' ? { kind: 'book' } : { kind: 'volume', volumeId: value === 'ungrouped' ? null : value } }
function sameScope(left: AiMemoryTaskScope, right: AiMemoryTaskScope): boolean { return left.kind === right.kind && (left.kind === 'book' || (right.kind === 'volume' && left.volumeId === right.volumeId)) }
function validDetail(bookId: string, value: AiMemoryTaskDetail, id: string): boolean {
  return value.bookId === bookId && value.id === id && value.units.length <= AI_MEMORY_TASK_UNIT_PAGE &&
    (value.selection === undefined || value.selection === 'pending_review') &&
    (value.selection !== 'pending_review' || value.totalChapters <= AI_MEMORY_MAINTENANCE_BATCH) &&
    new Set(value.units.map((unit) => unit.ordinal)).size === value.units.length &&
    value.reviewedChapters + value.skippedChapters <= value.plannedChapters && value.plannedChapters <= value.totalChapters
}
function validRun(value: AiRun, task: AiMemoryTaskDetail, unit: AiMemoryTaskUnit): boolean {
  return value.id === unit.runId && value.bookId === task.bookId && value.chapterId === unit.chapterId && value.chapterTitle === unit.chapterTitle && value.kind === task.kind &&
    value.context.summary === undefined && value.context.bookId === task.bookId && value.context.chapterId === unit.chapterId && value.context.kind === task.kind &&
    value.context.chapterRevisionId === unit.chapterRevisionId && value.context.chapterTitle === unit.chapterTitle && value.context.instruction === task.instruction &&
    value.connectionName === value.context.connection.name && value.model === value.context.connection.model &&
    value.context.connection.id === task.connectionId && value.context.contextScope === 'chapter' &&
    value.context.selectedBlockIds.length === 0 && value.context.evidence.length === 0 &&
    value.context.promptVersion === AI_MEMORY_PROMPT_VERSION && /^[0-9a-f]{64}$/.test(value.context.contextHash)
}

function TaskContextPreview({ context }: { context: AiContextPacket }) {
  return <section className={styles.preview} aria-label="本章实际发送预览">
    <div className={styles.heading}><h3>本章固定发送预览</h3><span>提示版本 {context.promptVersion}</span></div>
    <dl className={styles.facts}><div><dt>接口</dt><dd>{context.connection.baseUrl}/chat/completions</dd></div><div><dt>模型</dt><dd>{context.connection.model}</dd></div><div><dt>输入估算</dt><dd>{context.estimatedInputTokens.toLocaleString()} tokens</dd></div><div><dt>输出预算／上下文窗口</dt><dd>{context.reservedOutputTokens.toLocaleString()}／{context.connection.contextWindow.toLocaleString()} tokens</dd></div></dl>
    <p className={styles.note}>明确发送后，本章正文与下列要求将交给这个接口。输入量为估算，实际计费以接口返回为准。</p>
    {context.warnings.length > 0 && <ul className={shared.warningList}>{context.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    <details className={styles.messages}><summary>逐条查看实际 messages（{context.messages.length} 条）</summary>{context.messages.map((message, index) => <div key={index}><h4>{message.role === 'system' ? '系统要求' : '本章输入'}</h4><pre>{message.content}</pre></div>)}</details>
    <p className={styles.identity}>作品版本 {context.bookRevision} · 知识版本 {context.knowledgeRevision}<br />章节修订 {context.chapterRevisionId}<br />输入指纹 {context.contextHash}</p>
  </section>
}

export function AiMemoryTasksPanel(props: Props) { return <AiMemoryTasksSession key={props.book.book.id} {...props} /> }

function AiMemoryTasksSession({ api, book, busy, error, pendingMessage, checkingReceipt, onCheckReceipt, onRecover, onClose, onDirtyChange, onUpgrade, onAdoptMemory }: Props) {
  const [status, setStatus] = useState<AiMemoryTaskStatus | null>(null)
  const [connections, setConnections] = useState<AiConnectionPage | null>(null)
  const [task, setTask] = useState<AiMemoryTaskDetail | null>(null)
  const [run, setRun] = useState<AiRun | null>(null)
  const [form, setForm] = useState<TaskForm>({ kind: 'summarize', scope: 'book', selection: 'all', connectionId: '', instruction: initialInstruction })
  const [maintenance, setMaintenance] = useState<MaintenanceResult | null>(null)
  const [formDirty, setFormDirty] = useState(false)
  const [drafts, setDrafts] = useState<AiMemoryDraft[]>([])
  const [draftDirty, setDraftDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingWrite | null>(null)
  const [checkingLocal, setCheckingLocal] = useState(false)
  const [refreshRequested, setRefreshRequested] = useState(true)
  const [requestedRun, setRequestedRun] = useState<RunRead | null>(null)
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
  const statusRef = useRef<AiMemoryTaskStatus | null>(null)
  const taskRef = useRef<AiMemoryTaskDetail | null>(null)
  const runRef = useRef<AiRun | null>(null)
  const runUnitRef = useRef<AiMemoryTaskUnit | null>(null)
  const formDirtyRef = useRef(false)
  const draftDirtyRef = useRef(false)
  const pendingRef = useRef<PendingWrite | null>(null)
  const requestedRunRef = useRef<RunRead | null>(null)
  const formRef = useRef(form)
  const bookRevisionRef = useRef(book.book.revision)
  const maintenanceRequestRef = useRef<MaintenanceRead | null>(null)
  const maintenanceRef = useRef<MaintenanceResult | null>(null)
  const callback = useRef(onDirtyChange)
  formRef.current = form
  bookRevisionRef.current = book.book.revision
  callback.current = onDirtyChange
  const archived = Boolean(book.book.archivedAt)
  const baseBlocked = busy || loading || reading || Boolean(operation || pending || pendingMessage)
  const blocked = baseBlocked || Boolean(requestedRun)
  const activeView = Boolean(task && status?.activeTask?.id === task.id && !terminal(task))
  const currentRun = task?.currentUnit?.runId === run?.id ? run : null
  const generating = run?.state === 'running' || Boolean(task?.currentUnit?.runState === 'running' && !currentRun)
  const ready = status !== null && status.schemaVersion >= 8 && !status.requiresUpgrade && connections !== null && !connections.requiresUpgrade
  const maintenanceReady = ready && status.schemaVersion >= 11
  const edited = formDirty || draftDirty
  const dirty = blocked || generating || edited
  const formLocked = blocked || archived || generating || Boolean(discard)
  const maintenanceRun = Boolean(activeView && currentRun && task?.selection === 'pending_review' && task.sourceCurrent)
  const staleRun = Boolean(run && status && ((run.context.bookRevision !== status.bookRevision && !maintenanceRun) || run.context.knowledgeRevision !== status.knowledgeRevision))
  const savedConnection = connections?.connections.find((item) => item.id === run?.context.connection.id)
  const changedConnection = Boolean(run?.state === 'prepared' && connections && (!savedConnection || JSON.stringify(savedConnection) !== JSON.stringify(run.context.connection)))
  const needsCheckpoint = Boolean(currentRun && !['adopted', 'rejected', 'running'].includes(currentRun.state) && (['failed', 'cancelled', 'interrupted'].includes(currentRun.state) || staleRun || changedConnection))
  const canEditRun = activeView && currentRun !== null && task?.sourceCurrent && task.state === 'ready'
  const panelError = [message, error].filter((value, index, values) => value && value !== pendingMessage && values.indexOf(value) === index).join(' ') || null
  const selectedChapters = book.chapters.filter((chapter) => form.scope === 'book' || chapter.volumeId === (form.scope === 'ungrouped' ? null : form.scope)).length
  const currentMaintenance = maintenance && maintenanceCurrent(maintenance.source) ? maintenance.page : null

  function active(at: number): boolean { return mounted.current && epoch.current === at }
  function hold(value: PendingWrite | null) { pendingRef.current = value; setPending(value) }
  function queueRun(value: RunRead | null) { requestedRunRef.current = value; setRequestedRun(value) }
  function markFormDirty(value: boolean) { formDirtyRef.current = value; setFormDirty(value) }
  function markDraftDirty(value: boolean) { draftDirtyRef.current = value; setDraftDirty(value) }
  function invalidateMaintenance() { maintenanceRequestRef.current = null; maintenanceRef.current = null; setMaintenance(null) }
  function maintenanceCurrent(source: MaintenanceRead): boolean {
    const current = statusRef.current; const fields = formRef.current; const input = source.input
    return maintenanceRequestRef.current === source && bookRevisionRef.current === source.bookRevision &&
      current !== null && !current.requiresUpgrade && current.schemaVersion >= 11 && current.schemaVersion === source.schemaVersion &&
      current.bookRevision === input.expectedBookRevision && current.knowledgeRevision === input.expectedKnowledgeRevision &&
      fields.selection === 'pending_review' && fields.kind === input.kind && sameScope(taskScope(fields.scope), input.scope)
  }
  function changeForm(fields: Partial<TaskForm>) {
    if (formLocked || lock.current) return
    const previous = formRef.current; const next = { ...previous, ...fields }
    if (previous.selection !== next.selection || previous.kind !== next.kind || previous.scope !== next.scope) invalidateMaintenance()
    formRef.current = next; setForm(next); markFormDirty(true)
  }
  function saveTask(value: AiMemoryTaskDetail) {
    const previous = taskRef.current
    if (previous?.id !== value.id || previous.version !== value.version || previous.sourceCurrent !== value.sourceCurrent) invalidateMaintenance()
    taskRef.current = value; setTask(value)
  }
  function acceptStatus(value: AiMemoryTaskStatus): boolean {
    const previous = statusRef.current
    if (value.bookId !== book.book.id || value.consumer !== AI_MEMORY_TASK_CONSUMER ||
      (value.activeTask && value.activeTask.bookId !== book.book.id) || value.recentTasks.some((item) => item.bookId !== book.book.id) ||
      (previous && (value.bookRevision < previous.bookRevision || value.knowledgeRevision < previous.knowledgeRevision))) return false
    invalidateMaintenance(); statusRef.current = value; setStatus(value); return true
  }
  function acceptConnections(value: AiConnectionPage): boolean {
    if (value.bookId !== book.book.id) return false
    setConnections(value)
    if (!formDirtyRef.current) setForm((previous) => ({ ...previous, connectionId: value.connections.some((item) => item.id === previous.connectionId) ? previous.connectionId : value.connections[0]?.id ?? '' }))
    return true
  }
  function resetRun() { runRef.current = null; runUnitRef.current = null; setRun(null); setDrafts([]); markDraftDirty(false) }
  function acceptRun(value: AiRun, owner: AiMemoryTaskDetail, unit: AiMemoryTaskUnit): boolean {
    const previous = runRef.current; const current = taskRef.current
    if (!current || current.id !== owner.id || !validRun(value, owner, unit) ||
      (previous?.id === value.id && (value.version < previous.version || JSON.stringify(value.context) !== JSON.stringify(previous.context)))) return false
    if (previous?.id !== value.id && draftDirtyRef.current) return false
    runRef.current = value; runUnitRef.current = unit; setRun(value)
    // 同一候选的进度读取只更新原输出；作者正在编辑的字段与选择始终保留。
    if (!draftDirtyRef.current && (previous?.id !== value.id || previous.state !== value.state || previous.outputText !== value.outputText)) {
      try { setDrafts(value.state === 'succeeded' ? createAiMemoryDrafts(value) : []) } catch { setDrafts([]) }
    }
    if (current.currentUnit?.runId === value.id) saveTask({ ...current, currentUnit: { ...current.currentUnit, runState: value.state }, units: current.units.map((item) => item.runId === value.id ? { ...item, runState: value.state } : item) })
    return true
  }
  function writableTask(): AiMemoryTaskDetail | null {
    const current = taskRef.current
    return current && current.id === statusRef.current?.activeTask?.id && !terminal(current) ? current : null
  }
  function maintenanceBaselineFor(owner: AiMemoryTaskDetail): AiMaintenanceBaseline | undefined {
    const current = statusRef.current
    return owner.selection === 'pending_review' && current ? { taskId: owner.id, expectedTaskVersion: owner.version,
      expectedBookRevision: current.bookRevision, expectedKnowledgeRevision: current.knowledgeRevision } : undefined
  }
  function begin(label: string, allowArchived = false): number | null {
    if (lock.current || blocked || pendingRef.current || requestedRunRef.current || (archived && !allowArchived)) return null
    invalidateMaintenance()
    lock.current = true; ticket.current += 1; setOperation(label); setMessage(null); setDiscard(null); callback.current(true)
    return epoch.current
  }
  function finish(at: number) { if (active(at)) { lock.current = false; setOperation(null) } }
  function discardDrafts() {
    markDraftDirty(false)
    try { setDrafts(runRef.current?.state === 'succeeded' ? createAiMemoryDrafts(runRef.current) : []) } catch { setDrafts([]) }
  }
  function guardDrafts(label: string, proceed: () => void) {
    if (draftDirtyRef.current) setDiscard({ label, proceed: () => { discardDrafts(); proceed() } })
    else proceed()
  }
  function close() {
    if (blocked || lock.current || pendingRef.current || requestedRunRef.current) return
    if (generating) { setMessage('生成尚未结束，请先取消，或核对后明确标记中断。'); return }
    if (formDirtyRef.current || draftDirtyRef.current) {
      setDiscard({ label: '放弃本页未保存的任务要求与审阅修改，并关闭？已保存的任务、原输出和作者决定会保留。', proceed: () => { markFormDirty(false); discardDrafts(); callback.current(false); onClose() } }); return
    }
    callback.current(false); onClose()
  }

  useEffect(() => {
    mounted.current = true; setRefreshRequested(true)
    return () => { mounted.current = false; epoch.current += 1; ticket.current += 1; callback.current(false) }
  }, [api, book.book.id])
  useEffect(() => { callback.current(dirty) }, [dirty])
  useEffect(() => { setRecoveryConfirmed(false) }, [pending, pendingMessage, form, drafts, edited])
  useEffect(() => { invalidateMaintenance(); setRefreshRequested(true) }, [book.book.revision])

  async function write<T>(label: string, send: () => Promise<Result<T>>, accept: (value: T) => boolean, receive: (response: CompletedRequest) => boolean, allowArchived = false): Promise<boolean> {
    const at = begin(label, allowArchived)
    if (at === null) return false
    try {
      const result = await request(send)
      if (!active(at)) return false
      if (result.ok) {
        if (accept(result.data)) return true
        setMessage('回执与本次固定对象不符，已保留编辑并暂停新的写入。'); hold({ label, receive }); return false
      }
      setMessage(result.error.message)
      if (['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'STORAGE_ERROR'].includes(result.error.code)) hold({ requestId: result.error.requestId, label, receive })
      else if (result.error.code === 'REVISION_CONFLICT') setRefreshRequested(true)
      return false
    } finally { finish(at) }
  }
  function receiveGeneration(response: CompletedRequest, source: RunRead): boolean {
    if (response.command === 'ai.connection.list') {
      if (response.result.ok && !acceptConnections(response.result.data)) return false
    } else if (response.command === 'ai.get' || response.command === 'ai.claim' || response.command === 'ai.checkpoint' || response.command === 'ai.finish') {
      if (response.result.ok && !acceptRun(response.result.data, source.task, source.unit)) return false
    } else return false
    if (!response.result.ok) setMessage(response.result.error.message)
    else setMessage('原请求已确认，正在只读核对当前候选；不会重发模型请求。')
    queueRun(source); setPollStopped(false); return true
  }
  async function checkLocalReceipt() {
    const captured = pendingRef.current
    if (!captured || checkingLocal || checkingReceipt || busy || pendingMessage) return
    if (!captured.requestId) { setMessage('原请求没有可查询的编号，请留存本页内容后进入恢复核对。'); return }
    const at = epoch.current; setCheckingLocal(true)
    try {
      const result = await request(() => api.getRequestStatus({ requestId: captured.requestId! }))
      if (!active(at) || pendingRef.current !== captured) return
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.state !== 'completed') { setMessage(result.data.state === 'pending' ? '原请求仍在处理，请稍后核对。' : '原回执已不可用，请留存本页内容后进入恢复。'); return }
      const response = result.data.response
      if (!response.result.ok && ['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(response.result.error.code)) { setMessage(response.result.error.message); return }
      if (!captured.receive(response)) { setMessage('原回执的操作、版本或对象不符，已保持写入锁定。'); return }
      hold(null)
    } finally { if (active(at)) setCheckingLocal(false) }
  }

  async function readMaintenance(afterOrdinal?: number) {
    const current = statusRef.current; const fields = formRef.current; const previous = maintenanceRef.current
    if (blocked || generating || lock.current || discard || pendingRef.current || requestedRunRef.current ||
      !current || current.requiresUpgrade || current.schemaVersion < 11 || fields.selection !== 'pending_review') return
    // 翻页始终复用原清单指纹；审阅登记会改变待维护集合，不能拼接两份不同的分页结果。
    if (afterOrdinal !== undefined && (!previous || !maintenanceCurrent(previous.source))) {
      invalidateMaintenance(); setMessage('待维护清单已失效，请从第一页重新读取。'); return
    }
    let input: AiMemoryMaintenanceInput
    try {
      input = parseAiMemoryMaintenanceInput({ bookId: book.book.id, expectedBookRevision: current.bookRevision,
        expectedKnowledgeRevision: current.knowledgeRevision, kind: fields.kind, scope: taskScope(fields.scope),
        ...(afterOrdinal === undefined ? {} : { afterOrdinal, expectedCoverageHash: previous!.page.coverageHash }) })
    } catch (cause) { setMessage(cause instanceof DomainError ? cause.detail.message : '请核对待维护清单的范围。'); return }
    const source: MaintenanceRead = { input, bookRevision: bookRevisionRef.current, schemaVersion: current.schemaVersion }
    const at = epoch.current; const currentTicket = ++ticket.current
    invalidateMaintenance(); maintenanceRequestRef.current = source
    lock.current = true; setReading(true); setMessage(null); callback.current(true)
    const accept = (value: AiMemoryMaintenancePage): boolean => {
      if (!isAiMemoryMaintenancePageFor(value, source.input) || value.schemaVersion !== source.schemaVersion) {
        setMessage('待维护回执与原请求的类型、范围、版本或分页指纹不符。'); return false
      }
      // 迟到回执先核对原请求；条件已变时只确认收讫，保留作者编辑并要求重读清单。
      if (!active(at) || ticket.current !== currentTicket || !maintenanceCurrent(source)) {
        if (maintenanceRequestRef.current === source) invalidateMaintenance()
        setMessage('原清单回执已确认，但当前范围、版本或任务进度已变化，请重新读取待维护清单。')
        setRefreshRequested(true); return true
      }
      const saved = { source, page: value }; maintenanceRef.current = saved; setMaintenance(saved); setMessage(null); return true
    }
    const receive = (response: CompletedRequest): boolean => {
      if (response.command !== 'ai.task.maintenance') return false
      if (!response.result.ok) {
        invalidateMaintenance(); setMessage(response.result.error.message)
        if (response.result.error.code === 'REVISION_CONFLICT') setRefreshRequested(true)
        return true
      }
      return accept(response.result.data)
    }
    try {
      const result = await request(() => api.listAiMemoryMaintenance(input))
      if (!active(at)) return
      if (result.ok) {
        if (!accept(result.data)) hold({ label: '核对待维护清单', receive })
        return
      }
      setMessage(result.error.message)
      // 只读超时也需要补领原回执，避免服务仍有未确认请求时反复发送分页读取。
      if (['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'STORAGE_ERROR'].includes(result.error.code)) hold({ requestId: result.error.requestId, label: '读取待维护清单', receive })
      else {
        invalidateMaintenance()
        if (result.error.code === 'REVISION_CONFLICT') setRefreshRequested(true)
      }
    } finally { if (active(at)) { lock.current = false; setReading(false) } }
  }

  async function readRunData(source: RunRead, at: number, currentTicket: number): Promise<boolean> {
    const result = await request(() => api.getAiRun({ bookId: book.book.id, runId: source.unit.runId! }))
    if (!active(at) || ticket.current !== currentTicket) return false
    if (result.ok && acceptRun(result.data, source.task, source.unit)) { setPollStopped(false); setPollCycle((value) => value + 1); return true }
    setPollStopped(true); setMessage(result.ok ? '读取候选的章节、修订或固定输入不符，已停止读取进度。' : result.error.message)
    if (result.ok || ['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(result.error.code)) hold({ requestId: result.ok ? undefined : result.error.requestId, label: '核对本章候选', receive: (response) => receiveGeneration(response, source) })
    return false
  }
  async function readDetailData(id: string, afterOrdinal: number | undefined, at: number, currentTicket: number): Promise<boolean> {
    const result = await request(() => api.getAiMemoryTask({ bookId: book.book.id, taskId: id, ...(afterOrdinal === undefined ? {} : { afterOrdinal }) }))
    if (!active(at) || ticket.current !== currentTicket) return false
    if (!result.ok) { setMessage(result.error.message); return false }
    const value = result.data; const previous = taskRef.current
    if (!validDetail(book.book.id, value, id) || (previous?.id === id && value.version < previous.version)) { setMessage('任务详情的作品、版本或分页范围不符。'); return false }
    const unit = value.currentUnit ?? (previous?.id === id ? runUnitRef.current : null)
    if (draftDirtyRef.current && runRef.current?.id !== unit?.runId) { setMessage('任务的当前章节已变化，请先留存或明确放弃本页审阅修改。'); return false }
    saveTask(value); setPageAfter(afterOrdinal)
    if (!unit?.runId) { resetRun(); return true }
    if (runRef.current?.id !== unit.runId) resetRun()
    return await readRunData({ task: value, unit }, at, currentTicket)
  }
  async function initialize() {
    if (lock.current || busy || pendingRef.current || pendingMessage || operation) return
    const at = epoch.current; const currentTicket = ++ticket.current
    invalidateMaintenance()
    lock.current = true; setLoading(true); setMessage(null)
    try {
      const results = await Promise.allSettled([request(() => api.getAiMemoryTaskStatus({ bookId: book.book.id })), request(() => api.listAiConnections({ bookId: book.book.id }))])
      if (!active(at) || ticket.current !== currentTicket) return
      const [statusResult, connectionResult] = results
      if (connectionResult.status !== 'fulfilled' || !connectionResult.value.ok || !acceptConnections(connectionResult.value.data)) setMessage(connectionResult.status === 'fulfilled' && !connectionResult.value.ok ? connectionResult.value.error.message : '连接列表读取失败或作品身份不符。')
      if (statusResult.status !== 'fulfilled' || !statusResult.value.ok || !acceptStatus(statusResult.value.data)) { setMessage(statusResult.status === 'fulfilled' && !statusResult.value.ok ? statusResult.value.error.message : '任务状态读取失败或身份不符。'); return }
      const value = statusResult.value.data
      const id = taskRef.current?.id ?? value.activeTask?.id ?? value.recentTasks[0]?.id
      if (!value.requiresUpgrade && value.schemaVersion >= 8 && id) await readDetailData(id, taskRef.current?.id === id ? pageAfter : undefined, at, currentTicket)
    } finally { if (active(at) && ticket.current === currentTicket) { lock.current = false; setLoading(false) } }
  }
  useEffect(() => {
    if (!refreshRequested || busy || reading || operation || pending || pendingMessage || lock.current || requestedRun) return
    setRefreshRequested(false); void initialize()
  }, [refreshRequested, busy, reading, operation, pending, pendingMessage, requestedRun])

  async function readRun(source: RunRead) {
    if (lock.current || baseBlocked || taskRef.current?.id !== source.task.id || !source.unit.runId) return
    const at = epoch.current; const currentTicket = ++ticket.current
    lock.current = true; setReading(true)
    try { await readRunData(source, at, currentTicket) }
    finally { if (active(at) && ticket.current === currentTicket) { lock.current = false; setReading(false) } }
  }
  useEffect(() => {
    if (!requestedRun || baseBlocked || lock.current) return
    const source = requestedRun; queueRun(null); void readRun(source)
  }, [requestedRun, baseBlocked])
  useEffect(() => {
    if (!run || run.state !== 'running' || run.active === false || blocked || pollStopped || !task || !runUnitRef.current) return
    const source = { task, unit: runUnitRef.current }
    const timer = window.setTimeout(() => { void readRun(source) }, 1200)
    return () => window.clearTimeout(timer)
  }, [run?.id, run?.state, run?.active, run?.version, task?.id, blocked, pollStopped, pollCycle])

  async function readTask(id: string, afterOrdinal?: number, trail: (number | undefined)[] = []) {
    if (blocked || generating || lock.current) return
    const at = epoch.current; const currentTicket = ++ticket.current
    lock.current = true; setReading(true); setMessage(null); setDiscard(null)
    try { if (await readDetailData(id, afterOrdinal, at, currentTicket)) setPageTrail(trail) }
    finally { if (active(at) && ticket.current === currentTicket) { lock.current = false; setReading(false) } }
  }
  function openTask(id: string) { guardDrafts('放弃本页尚未采用的审阅修改，并读取这份任务？原模型输出仍保留。', () => void readTask(id)) }
  function openUnit(unit: AiMemoryTaskUnit) {
    const owner = taskRef.current
    if (!owner || !unit.runId || blocked || (generating && unit.runId !== owner.currentUnit?.runId)) return
    guardDrafts('放弃本页尚未采用的审阅修改，并读取这一章的候选？', () => { resetRun(); void readRun({ task: owner, unit }) })
  }

  function acceptTaskReceipt(value: AiMemoryTaskReceipt, previous?: AiMemoryTaskSummary, sent?: AiMemoryTaskStartInput, expectedCount?: number): boolean {
    if (!isAiMemoryTaskReceiptFor(book.book.id, value, previous) || !validDetail(book.book.id, value.task, value.task.id) ||
      (expectedCount !== undefined && value.task.totalChapters !== expectedCount) ||
      (previous && taskRef.current?.id !== previous.id) ||
      (!terminal(value.task) && (value.status.activeTask?.id !== value.task.id || value.status.activeTask.version !== value.task.version)) ||
      (terminal(value.task) && value.status.activeTask?.id === value.task.id) ||
      (value.run && (!value.task.currentUnit || !validRun(value.run, value.task, value.task.currentUnit))) ||
      (sent && (value.task.kind !== sent.kind || value.task.selection !== sent.selection || !sameScope(value.task.scope, sent.scope) || value.task.connectionId !== sent.connectionId || value.task.instruction !== sent.instruction || value.task.sourceBookRevision !== sent.expectedBookRevision || value.task.sourceKnowledgeRevision !== sent.expectedKnowledgeRevision))) return false
    const nextRunId = value.task.currentUnit?.runId ?? null
    if (draftDirtyRef.current && runRef.current?.id !== nextRunId) return false
    const oldRun = runRef.current
    if (value.run && oldRun?.id === value.run.id && (value.run.version < oldRun.version || JSON.stringify(value.run.context) !== JSON.stringify(oldRun.context))) return false
    if (!acceptStatus(value.status)) return false
    saveTask(value.task); setPageAfter(undefined); setPageTrail([])
    if (value.run && value.task.currentUnit) {
      if (!acceptRun(value.run, value.task, value.task.currentUnit)) return false
    } else if (value.task.currentUnit?.runId) queueRun({ task: value.task, unit: value.task.currentUnit })
    else resetRun()
    if (sent) markFormDirty(false)
    setPollStopped(false); return true
  }
  function taskReceiver(command: 'ai.task.start' | 'ai.task.step' | 'ai.task.control', previous?: AiMemoryTaskSummary, sent?: AiMemoryTaskStartInput) {
    return (response: CompletedRequest): boolean => {
      if (response.command !== command || (response.command !== 'ai.task.start' && response.command !== 'ai.task.step' && response.command !== 'ai.task.control')) return false
      if (!response.result.ok) { setMessage(response.result.error.message); setRefreshRequested(true); return true }
      return acceptTaskReceipt(response.result.data, previous, sent)
    }
  }
  async function start(event: FormEvent) {
    event.preventDefault()
    const current = statusRef.current; const fields = formRef.current; const coverage = maintenanceRef.current
    if (!ready || !current || current.activeTask || formLocked || lock.current || !connections?.connections.some((item) => item.id === fields.connectionId)) return
    if (fields.selection === 'pending_review' && (!coverage || !maintenanceCurrent(coverage.source) || coverage.page.pendingChapters === 0)) {
      setMessage('请先读取当前范围的待维护清单；只有存在当前稿待审阅章节时才能创建增量任务。'); return
    }
    let input: AiMemoryTaskStartInput
    try { input = parseAiMemoryTaskStartInput({ bookId: book.book.id, expectedBookRevision: current.bookRevision, expectedKnowledgeRevision: current.knowledgeRevision,
      kind: fields.kind, scope: taskScope(fields.scope), connectionId: fields.connectionId, instruction: fields.instruction,
      ...(fields.selection === 'pending_review' ? { selection: fields.selection, expectedCoverageHash: coverage!.page.coverageHash } : {}) }) }
    catch (cause) { setMessage(cause instanceof DomainError ? cause.detail.message : '请核对任务范围和整理要求。'); return }
    const expectedCount = fields.selection === 'pending_review' ? Math.min(AI_MEMORY_MAINTENANCE_BATCH, coverage!.page.pendingChapters) : undefined
    const accept = (value: AiMemoryTaskReceipt) => acceptTaskReceipt(value, undefined, input, expectedCount)
    const receive = (response: CompletedRequest): boolean => {
      if (response.command !== 'ai.task.start') return false
      if (!response.result.ok) { setMessage(response.result.error.message); setRefreshRequested(true); return true }
      return accept(response.result.data)
    }
    guardDrafts('放弃当前未采用的审阅修改，并创建新任务？', () => {
      // 审阅放弃确认期间基线也可能变化；再次校验后才提交固定的增量范围。
      if (input.selection === 'pending_review' && (!coverage || !maintenanceCurrent(coverage.source))) {
        setMessage('待维护清单已失效，请重新读取后创建增量任务。'); return
      }
      void write('固定本次整理范围', () => api.startAiMemoryTask(input), accept, receive)
    })
  }
  async function step() {
    const current = writableTask()
    if (!current || !current.sourceCurrent || !['planning', 'ready'].includes(current.state) || generating) return
    if (current.phase === 'reviewing' && current.currentUnit?.runId && (!currentRun || (!['adopted', 'rejected'].includes(currentRun.state) && !needsCheckpoint))) return
    guardDrafts('放弃本页未采用的审阅修改，并登记当前决定、推进任务？', () => void write(current.phase === 'planning' ? '规划下一批章节' : current.currentUnit?.runId ? '登记作者决定并推进' : '保存本章发送预览', () => api.stepAiMemoryTask({ bookId: book.book.id, taskId: current.id, expectedTaskVersion: current.version }), (value) => acceptTaskReceipt(value, current), taskReceiver('ai.task.step', current)))
  }
  async function controlConfirmed(action: AiMemoryTaskControlInput['action']) {
    const current = writableTask()
    if (!current || generating) return
    const confirmed = await write(action === 'retry' ? '恢复本章准备检查点' : action === 'skip' ? '记录跳过本章' : action === 'pause' ? '暂停任务' : action === 'resume' ? '恢复任务' : '取消任务', () => api.controlAiMemoryTask({ bookId: book.book.id, taskId: current.id, expectedTaskVersion: current.version, action }), (value) => acceptTaskReceipt(value, current), taskReceiver('ai.task.control', current))
    // 只有本次重试回执已确认，才接着准备一个本地预览；迟到回执不触发后续写入。
    if (confirmed && action === 'retry' && taskRef.current?.id === current.id && taskRef.current.phase === 'reviewing' && !taskRef.current.currentUnit?.runId) await step()
  }
  function control(action: AiMemoryTaskControlInput['action']) {
    if (blocked || generating || !writableTask()) return
    if (action === 'retry') {
      setDiscard({ label: `${draftDirtyRef.current ? '放弃未采用的审阅修改，' : ''}为本章另建候选预览？稍后再次明确发送会产生一笔新的模型请求，接口可能收费。原候选和输出仍保留。`, proceed: () => { discardDrafts(); void controlConfirmed(action) } }); return
    }
    if (action === 'skip' || action === 'cancel') guardDrafts(action === 'skip' ? '放弃尚未采用的审阅修改，并记录跳过本章？' : '放弃尚未采用的审阅修改，并取消本次任务？', () => void controlConfirmed(action))
    else void controlConfirmed(action)
  }
  async function sendRun() {
    const owner = writableTask(); const unit = owner?.currentUnit; const current = runRef.current
    if (!owner || owner.state !== 'ready' || !owner.sourceCurrent || !unit || !current || current.id !== unit.runId || current.state !== 'prepared' || staleRun || changedConnection || !validRun(current, owner, unit)) return
    const source = { task: owner, unit }
    const maintenanceBaseline = maintenanceBaselineFor(owner)
    await write('明确发送本章并生成', () => api.startAiRun({ bookId: book.book.id, runId: current.id, expectedVersion: current.version, contextHash: current.context.contextHash,
      ...(maintenanceBaseline ? { maintenanceBaseline } : {}) }), (value) => {
      if (value.state !== 'running' || value.version !== current.version + 1 || value.active !== true || !acceptRun(value, owner, unit)) return false
      setPollStopped(false); return true
    }, (response) => receiveGeneration(response, source))
  }
  async function stopRun() {
    const owner = taskRef.current; const unit = runUnitRef.current; const current = runRef.current
    if (!owner || !unit || !current || current.state !== 'running') return
    await write('取消生成并保留部分输出', () => api.cancelAiRun({ bookId: book.book.id, runId: current.id }), (value) => acceptRun(value, owner, unit), (response) => receiveGeneration(response, { task: owner, unit }))
  }
  async function finishRun(action: 'interrupt' | 'reject') {
    // 孤立 running 属于运行状态恢复；失效或归档任务也要能留存中断，解除关闭锁。
    const owner = action === 'interrupt' ? taskRef.current : writableTask()
    const unit = action === 'interrupt' ? runUnitRef.current : owner?.currentUnit
    const current = runRef.current
    if (!owner || !unit || !current || !validRun(current, owner, unit)) return
    if (action === 'interrupt' ? current.state !== 'running' || current.active !== false : ['running', 'adopted', 'rejected'].includes(current.state)) return
    const accept = (value: AiRun) => value.version === current.version + 1 && value.state === (action === 'interrupt' ? 'interrupted' : 'rejected') && acceptRun(value, owner, unit)
    const receive = (response: CompletedRequest): boolean => {
      if (response.command !== (action === 'interrupt' ? 'ai.interrupt' : 'ai.reject')) return false
      if (!response.result.ok) { setMessage(response.result.error.message); return true }
      return accept(response.result.data as AiRun)
    }
    await write(action === 'interrupt' ? '标记本章生成中断' : '拒绝本章候选', () => action === 'interrupt' ? api.interruptAiRun({ bookId: book.book.id, runId: current.id, expectedVersion: current.version }) : api.rejectAiRun({ bookId: book.book.id, runId: current.id, expectedVersion: current.version }), accept, receive, action === 'interrupt')
  }
  async function adoptMemory() {
    const owner = writableTask(); const unit = owner?.currentUnit; const current = runRef.current
    if (!owner || owner.state !== 'ready' || !owner.sourceCurrent || !unit || !current || current.id !== unit.runId || current.state !== 'succeeded' || staleRun || !validRun(current, owner, unit)) return
    let input: AiMemoryAdoptInput
    const maintenanceBaseline = maintenanceBaselineFor(owner)
    try { input = parseAiMemoryAdoptInput({ bookId: book.book.id, runId: current.id, expectedVersion: current.version,
      ...(maintenanceBaseline ? { maintenanceBaseline } : {}), entries: aiMemoryReviewEntries(drafts) }) }
    catch (cause) { setMessage(cause instanceof DomainError ? cause.detail.message : '请核对选择的整理条目。'); return }
    const at = begin('采用本章已审阅的知识建议')
    if (at === null) return
    try {
      await onAdoptMemory(input, current, (receipt) => {
        if (!active(at)) return false
        // 先核对固定候选与精确采用内容；父层和本页须共同确认后才能清除作者编辑。
        if (!isAiMemoryAdoptReceiptFor(input, current, receipt) || !validRun(receipt.run, owner, unit) || !acceptRun(receipt.run, owner, unit)) {
          setMessage('采用回执与本章固定候选不符，请留存审阅内容后核对。'); hold({ label: '核对本章知识采用', receive: () => false }); return false
        }
        markDraftDirty(false); setDrafts([])
        const previous = statusRef.current
        if (previous) { const updated = { ...previous, bookRevision: receipt.status.bookRevision, knowledgeRevision: receipt.status.knowledgeRevision }; statusRef.current = updated; setStatus(updated) }
        setMessage('所选知识已保存。请明确登记本章作者决定，再继续任务。'); return true
      })
    } catch { if (active(at)) { setMessage('本章知识采用结果未确认，请留存审阅内容后进入恢复核对。'); hold({ label: '核对本章知识采用', receive: () => false }) } }
    finally { finish(at) }
  }
  async function upgrade() {
    if (!upgradeConfirmed || !status || status.schemaVersion >= 11 || generating) return
    const at = begin('备份并启用章节整理任务')
    if (at === null) return
    try {
      await onUpgrade((value) => {
        if (!active(at)) return
        if (value.bookId !== book.book.id || value.schemaVersion < 11) { setMessage('升级回执尚未确认 v11 可用，请保留窗口并核对。'); hold({ label: '核对章节任务升级', receive: () => false }); return }
        setBackupPath(value.backupPath ?? null); setUpgradeConfirmed(false); setRefreshRequested(true)
      })
    } catch { if (active(at)) { setMessage('升级结果未确认，请保留本页并进入恢复核对。'); hold({ label: '核对章节任务升级', receive: () => false }) } }
    finally { finish(at) }
  }
  function recover() {
    if (operation || reading || checkingLocal || checkingReceipt || (edited && !recoveryConfirmed)) return
    callback.current(false); onRecover()
  }
  const recoveryText = JSON.stringify({ bookId: book.book.id, task, activeTask: status?.activeTask ?? null, run,
    memoryReview: draftDirty ? drafts : undefined, taskForm: formDirty ? form : undefined,
    pendingRequest: pending ? { requestId: pending.requestId, label: pending.label } : undefined }, null, 2)
  const canStep = activeView && task?.sourceCurrent && ['planning', 'ready'].includes(task.state) && (task.phase === 'planning' || !task.currentUnit?.runId || Boolean(currentRun && (['adopted', 'rejected'].includes(currentRun.state) || needsCheckpoint)))

  return <Dialog title="章节整理任务" wide busy={blocked || generating} onClose={close} error={panelError}>
    <div className={layout.intro}><p>《{book.book.title}》</p><span>固定章节范围 → 本章预览 → 明确发送 → 作者审阅 → 登记进度</span></div>
    <p className={styles.note}>每章单独生成与审阅。创建、恢复、规划任务只操作本地记录；发送按钮仅提交当前章，不会自动发送后续章节。</p>
    {operation && <p className={styles.note} role="status">{operation}…</p>}
    {(pending || pendingMessage) && <section className={layout.pending} role="alert"><h3>本次操作结果未确认</h3><p>{pendingMessage ?? `${pending?.label}尚未收到确定回执，新的写入已暂停。`}</p><p>请查询原请求，核对清单、任务或候选的确定结果。补领回执不会重新提交模型或采用请求。</p>{edited && <><label>需要留存的任务、固定候选与本页编辑<textarea className={styles.recoveryCopy} value={recoveryText} readOnly rows={8} onFocus={(event) => event.target.select()} /></label><label className={shared.checkLabel}><input type="checkbox" checked={recoveryConfirmed} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />我已复制留存需要的任务要求与审阅内容，允许进入恢复</label></>}<div className={styles.actions}><button type="button" className={shared.button} disabled={checkingLocal || checkingReceipt || Boolean(operation)} onClick={pendingMessage ? onCheckReceipt : () => void checkLocalReceipt()}>{checkingLocal || checkingReceipt ? '正在核对…' : '查询原回执'}</button><button type="button" className={shared.button} disabled={Boolean(operation) || reading || checkingLocal || checkingReceipt || (edited && !recoveryConfirmed)} onClick={recover}>进入草稿与恢复</button></div></section>}
    {loading && <p className={styles.note} role="status">正在只读核对任务、连接与本章候选…</p>}
    {!loading && (!status || !connections) && <button type="button" className={shared.button} disabled={blocked} onClick={() => setRefreshRequested(true)}>重新读取状态</button>}
    {status && status.schemaVersion < 11 && <section className={layout.upgrade}><h3>{status.schemaVersion < 8 ? '为本书启用章节整理任务' : '为本书启用增量维护'}</h3><p>当前作品格式 v{status.schemaVersion}。先建立独立数据库备份，再升级到当前作品格式，保存逐章任务、作者决定与增量任务的固定章节范围。v8 及以上作品可继续使用全范围整理。</p><label className={layout.upgradeCheck}><input type="checkbox" checked={upgradeConfirmed} disabled={blocked || archived || generating || Boolean(discard)} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />同意为本书创建数据库备份并升级</label><button type="button" className={shared.primaryButton} disabled={blocked || archived || generating || Boolean(discard) || !upgradeConfirmed} onClick={() => void upgrade()}>备份并启用</button></section>}
    {backupPath && <p className={layout.backupPath}>升级前数据库副本：{backupPath}</p>}
    {ready && <>
      <section className={styles.composer} aria-label="新建章节整理任务"><div className={styles.heading}><h3>新建整理任务</h3><span>{status.activeTask ? '已有活动任务，请先处理或取消' : '同时保留一个活动队列'}</span></div><form className={layout.editorForm} onSubmit={(event) => void start(event)}>
        <div className={layout.twoColumns}><label>整理类型<select value={form.kind} disabled={formLocked} onChange={(event) => changeForm({ kind: event.target.value as AiMemoryTaskKind })}><option value="summarize">逐章摘要</option><option value="extract">逐章提取知识建议</option></select></label><label>章节范围<select value={form.scope} disabled={formLocked} onChange={(event) => changeForm({ scope: event.target.value })}><option value="book">全书章节</option>{book.volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title}</option>)}<option value="ungrouped">未分卷章节</option></select></label></div>
        <label>整理方式<select value={form.selection} disabled={formLocked} onChange={(event) => changeForm({ selection: event.target.value === 'pending_review' ? 'pending_review' : 'all' })}><option value="all">全范围整理</option><option value="pending_review" disabled={!maintenanceReady}>仅当前稿待审阅（增量维护{maintenanceReady ? '' : '，需升级至 v11'}）</option></select></label>
        {form.selection === 'pending_review' && <section aria-label="当前稿待维护清单">
          <div className={styles.heading}><h3>当前稿待审阅</h3><span>{kindLabels[form.kind]} · 每页最多 {AI_MEMORY_MAINTENANCE_PAGE} 章</span></div>
          <p className={styles.note}>摘要和知识建议分别统计。登记采用或拒绝均算已审阅；跳过仍待维护。这些数字表示作者审阅覆盖，不是已采用的知识数量。</p>
          <button type="button" className={shared.button} disabled={blocked || generating || Boolean(discard) || !maintenanceReady} onClick={() => void readMaintenance()}>{currentMaintenance ? '重新读取清单（从第一页）' : '读取当前范围待维护清单'}</button>
          {!currentMaintenance && <p className={styles.note} role="status">请先读取清单。范围、整理类型、作品或知识版本、任务进度变化后，需要重新读取。</p>}
          {currentMaintenance && <>
            <p className={styles.note}>{currentMaintenance.scopeTitle} · 当前范围 {currentMaintenance.totalChapters.toLocaleString()} 章 · 当前稿已审阅 {currentMaintenance.reviewedChapters.toLocaleString()} 章 · 待维护 {currentMaintenance.pendingChapters.toLocaleString()} 章</p>
            <dl className={styles.facts}><div><dt>从未审阅</dt><dd>{currentMaintenance.unreviewedChapters.toLocaleString()} 章</dd></div><div><dt>改稿待重审</dt><dd>{currentMaintenance.changedChapters.toLocaleString()} 章</dd></div></dl>
            {currentMaintenance.pendingChapters === 0 ? <p className={styles.note} role="status">当前范围的本类整理均已登记作者决定，暂无待维护章节。</p> : <>
              <p className={styles.note}>当前显示待维护清单第 {currentMaintenance.afterOrdinal + 1}–{currentMaintenance.afterOrdinal + currentMaintenance.chapters.length} 章。</p>
              <ul className={styles.memoryResults}>{currentMaintenance.chapters.map((chapter) => <li key={chapter.chapterId}><strong>{chapter.ordinal}. {chapter.chapterTitle}</strong><small>{chapter.reason === 'changed' ? '改稿待重审（修订或标题已有变化）' : '从未审阅'} · {chapter.volumeId === null ? '未分卷' : book.volumes.find((volume) => volume.id === chapter.volumeId)?.title ?? '所属卷'}</small></li>)}</ul>
              <div className={layout.paging}><button type="button" className={shared.button} disabled={blocked || generating || Boolean(discard) || currentMaintenance.afterOrdinal === 0} onClick={() => void readMaintenance(Math.max(0, currentMaintenance.afterOrdinal - AI_MEMORY_MAINTENANCE_PAGE))}>待维护上一页</button><button type="button" className={shared.button} disabled={blocked || generating || Boolean(discard) || currentMaintenance.nextAfterOrdinal === null} onClick={() => { if (currentMaintenance.nextAfterOrdinal !== null) void readMaintenance(currentMaintenance.nextAfterOrdinal) }}>待维护下一页</button></div>
            </>}
          </>}
        </section>}
        <label>已保存的模型连接<select value={form.connectionId} disabled={formLocked} onChange={(event) => changeForm({ connectionId: event.target.value })}><option value="" disabled>请选择连接</option>{connections.connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
        <p className={styles.note}>连接与本次应用会话的密钥在“AI 创作协作”中管理。本页只选择已经保存的连接。</p>
        <label>逐章整理要求<textarea value={form.instruction} maxLength={6000} rows={4} required disabled={formLocked} onChange={(event) => changeForm({ instruction: event.target.value })} /></label>
        <p className={styles.note}>{form.selection === 'pending_review'
          ? `增量任务固定整个待维护清单最前 ${AI_MEMORY_MAINTENANCE_BATCH} 章（不足则全部固定），与当前浏览页无关。${currentMaintenance ? `本次将固定 ${Math.min(AI_MEMORY_MAINTENANCE_BATCH, currentMaintenance.pendingChapters).toLocaleString()} 章。` : ''}所有模型发送仍需逐章确认。`
          : `当前范围含 ${selectedChapters.toLocaleString()} 章。任务先固定本地范围，每次最多规划 ${AI_MEMORY_TASK_PLAN_PAGE} 章；所有模型发送都需逐章确认。`}</p>
        <div className={styles.actions}><button type="submit" className={shared.primaryButton} disabled={formLocked || Boolean(status.activeTask) || !form.connectionId || !form.instruction.trim() || (form.selection === 'pending_review' ? !maintenanceReady || !currentMaintenance || currentMaintenance.pendingChapters === 0 : selectedChapters === 0)}>{form.selection === 'pending_review' ? '创建本地增量任务' : '创建本地整理任务'}</button><button type="button" className={shared.button} disabled={blocked || generating || Boolean(discard)} onClick={() => { invalidateMaintenance(); setRefreshRequested(true) }}>刷新状态</button></div>
      </form></section>
      <p className={styles.note}>历史已记录审阅来源：{status.reviewedSourceCount.toLocaleString()}。计数可能包含已经失效的旧稿，只说明该消费者记录过作者决定，不表示当前全书覆盖、条目全部采用或长篇记忆质量已验收。</p>
      {status.activeTask && task?.id !== status.activeTask.id && <section className={styles.run}><div className={styles.heading}><h3>当前活动任务 · {status.activeTask.scopeTitle}</h3><span>{taskLabels[status.activeTask.state]}</span></div><p className={styles.note}>{status.activeTask.selection === 'pending_review' ? '增量维护' : '全范围整理'} · 固定 {status.activeTask.totalChapters.toLocaleString()} 章</p><button type="button" className={shared.button} disabled={blocked || generating} onClick={() => openTask(status.activeTask!.id)}>返回活动任务</button></section>}
      {task && <section className={styles.run} aria-label="已保存的任务详情"><div className={styles.heading}><h3>{kindLabels[task.kind]} · {task.scopeTitle}</h3><span>{taskLabels[task.state]} · {activeView ? '活动任务' : '历史只读记录'}</span></div>
        <p className={styles.note}>{task.selection === 'pending_review' ? '增量维护' : '全范围整理'} · 固定 {task.totalChapters.toLocaleString()} 章{task.selection === 'pending_review' && '。固定范围外的新增或改稿章节留待下一次读取清单；跳过章节仍列入后续待维护清单。'}</p>
        <p className={styles.note}>已规划 {task.plannedChapters.toLocaleString()}／{task.totalChapters.toLocaleString()} 章 · 已登记决定 {task.reviewedChapters.toLocaleString()} 章 · 跳过 {task.skippedChapters.toLocaleString()} 章</p><progress aria-label="章节作者决定登记进度" value={task.reviewedChapters + task.skippedChapters} max={Math.max(1, task.totalChapters)} />
        <p className={styles.identity}>任务 {task.id} · 版本 {task.version} · {displayTime(task.updatedAt)}<br />创建时连接 {task.connectionName} · {task.model}<br />创建时作品版本 {task.sourceBookRevision}／知识版本 {task.sourceKnowledgeRevision}</p>
        <p className={styles.note}>新候选使用该连接的当前配置，实际发送的模型与预算以本章固定预览为准。</p>
        <details className={styles.messages}><summary>已保存的逐章整理要求</summary><pre>{task.instruction}</pre></details>
        {!task.sourceCurrent && <p className={shared.formError} role="alert">范围内的章节来源已有变化，旧任务不可继续生成或采用。请取消旧任务后，按新范围创建任务；已有原稿与决定记录会保留。知识采用本身不会使整个任务失效。</p>}
        {task.error && <p className={shared.formError} role="alert">{task.error}</p>}
        {activeView && <div className={styles.actions}>
          {canStep && <button type="button" className={shared.primaryButton} disabled={blocked || archived || generating} onClick={() => void step()}>{task.phase === 'planning' ? `规划下一批（最多 ${AI_MEMORY_TASK_PLAN_PAGE} 章）` : needsCheckpoint ? '核对本章异常并记录检查点' : task.currentUnit?.runId ? '登记本章决定并继续' : '准备本章发送预览'}</button>}
          {['planning', 'ready'].includes(task.state) && <button type="button" className={shared.button} disabled={blocked || archived || generating} onClick={() => control('pause')}>暂停任务</button>}
          {task.state === 'paused' && <button type="button" className={shared.button} disabled={blocked || archived || generating || !task.sourceCurrent} onClick={() => control('resume')}>恢复任务</button>}
          {task.phase === 'reviewing' && ['ready', 'failed'].includes(task.state) && task.currentUnit && <>{task.state === 'failed' && <button type="button" className={shared.button} disabled={blocked || archived || generating || !task.sourceCurrent} onClick={() => control('retry')}>重试本章准备</button>}<button type="button" className={shared.button} disabled={blocked || archived || generating || !task.sourceCurrent} onClick={() => control('skip')}>跳过本章</button></>}
          {task.state === 'failed' && task.phase === 'planning' && <button type="button" className={shared.button} disabled={blocked || archived || generating || !task.sourceCurrent} onClick={() => control('retry')}>重试本地规划</button>}
          <button type="button" className={shared.button} disabled={blocked || archived || generating} onClick={() => control('cancel')}>取消任务</button>
        </div>}
        {task.currentUnit && <p className={styles.note}>范围内第 {task.currentUnit.ordinal} 章：{task.currentUnit.chapterTitle} · {task.currentUnit.runState ? runLabels[task.currentUnit.runState] : '尚未准备预览'}{task.currentUnit.runId && run?.id !== task.currentUnit.runId && <button type="button" className={shared.textButton} disabled={blocked} onClick={() => openUnit(task.currentUnit!)}>查看当前章候选</button>}</p>}
        {task.units.length > 0 && <details className={styles.history}><summary>本页章节（最多 {AI_MEMORY_TASK_UNIT_PAGE} 章）</summary><ul>{task.units.map((unit) => <li key={unit.ordinal}><button type="button" className={styles.historyItem} disabled={blocked || generating || !unit.runId} aria-current={run?.id === unit.runId ? 'true' : undefined} onClick={() => openUnit(unit)}><span><strong>{unit.ordinal}. {unit.chapterTitle}</strong><small>{unitLabels[unit.state]} · {unit.runState ? runLabels[unit.runState] : '尚无候选'} · 候选次数 {unit.attempts}</small></span><span>{unit.runId ? '读取候选' : '待处理'}</span></button></li>)}</ul></details>}
        <div className={layout.paging}><button type="button" className={shared.button} disabled={blocked || generating || pageTrail.length === 0} onClick={() => guardDrafts('放弃本页未采用的审阅修改，并读取上一页？', () => void readTask(task.id, pageTrail[pageTrail.length - 1], pageTrail.slice(0, -1)))}>上一页</button><button type="button" className={shared.button} disabled={blocked || generating || task.nextAfterOrdinal === null} onClick={() => guardDrafts('放弃本页未采用的审阅修改，并读取下一页？', () => void readTask(task.id, task.nextAfterOrdinal ?? undefined, [...pageTrail, pageAfter]))}>下一页</button></div>
      </section>}
      {run && task && <section className={styles.run} aria-label="本章候选"><div className={styles.heading}><h3>{run.chapterTitle} · {runLabels[run.state]}</h3><span>{canEditRun ? '当前章候选' : '只读候选'}</span></div>
        {run.error && <p className={shared.formError} role="alert">{run.error}</p>}
        {(staleRun || changedConnection) && !['adopted', 'rejected'].includes(run.state) && <p className={shared.formError} role="alert">本次候选固定的作品、知识或连接版本已变化。请先核对异常检查点，再重试本章准备、核对新预览后发送；本章来源未变化时任务范围仍可保留。</p>}
        {maintenanceRun && status && run.context.bookRevision !== status.bookRevision && !staleRun && <p className={styles.note}>作品其他内容已有更新。本章保留原发送预览和输出；发送或采用时会重新核对本章实际输入、固定任务范围及当前版本。</p>}
        <TaskContextPreview context={run.context} />
        <div className={styles.actions}>
          {canEditRun && run.state === 'prepared' && <button type="button" className={shared.primaryButton} disabled={blocked || archived || staleRun || changedConnection} onClick={() => void sendRun()}>确认本章内容并发送（可能产生费用）</button>}
          {run.state === 'running' && run.active !== false && <button type="button" className={shared.button} disabled={blocked || archived} onClick={() => void stopRun()}>取消生成并保留输出</button>}
          {run.state === 'running' && run.active === false && <button type="button" className={shared.button} disabled={blocked} onClick={() => void finishRun('interrupt')}>标记已中断并保留输出</button>}
          {activeView && currentRun && !['running', 'adopted', 'rejected'].includes(run.state) && <button type="button" className={shared.button} disabled={blocked || archived} onClick={() => guardDrafts('放弃尚未采用的审阅修改，并拒绝这次候选？原输出仍保留。', () => void finishRun('reject'))}>拒绝本章候选</button>}
          <button type="button" className={shared.button} disabled={blocked} onClick={() => { if (taskRef.current && runUnitRef.current) void readRun({ task: taskRef.current, unit: runUnitRef.current }) }}>只读刷新候选</button>
        </div>
        {run.state === 'running' && run.active === false && <p className={styles.note}>本地记录仍为生成中，但桌面进程没有对应活动请求。先只读核对，再明确标记中断；不会自动重发。</p>}
        <AiMemoryReview api={api} run={run} drafts={drafts} disabled={blocked || archived || !canEditRun || staleRun} onChange={(value) => { setDrafts(value); markDraftDirty(true) }} onAdopt={() => void adoptMemory()} />
      </section>}
      {status.recentTasks.length > 0 && <details className={styles.history}><summary>最近 {Math.min(10, status.recentTasks.length)} 份任务记录</summary><ul>{status.recentTasks.slice(0, 10).map((item) => <li key={item.id}><button type="button" className={styles.historyItem} disabled={blocked || generating} aria-current={task?.id === item.id ? 'true' : undefined} onClick={() => openTask(item.id)}><span><strong>{kindLabels[item.kind]} · {item.scopeTitle}</strong><small>{item.selection === 'pending_review' ? '增量维护' : '全范围整理'} · 固定 {item.totalChapters} 章 · {item.reviewedChapters} 章已登记 · {item.skippedChapters} 章跳过</small></span><span>{taskLabels[item.state]}<small>{displayTime(item.updatedAt)}</small></span></button></li>)}</ul></details>}
      {archived && <p className={styles.note}>作品已归档，可读取任务与原输出；解除归档后可继续整理。</p>}
    </>}
    {discard && <section className={styles.discard} role="alert"><p>{discard.label}</p><div className={styles.actions}><button type="button" className={shared.button} disabled={blocked || generating} onClick={() => setDiscard(null)}>保留当前内容</button><button type="button" className={shared.primaryButton} disabled={blocked || generating} onClick={() => { const proceed = discard.proceed; setDiscard(null); proceed() }}>确认并继续</button></div></section>}
    <div className={styles.footer}><button type="button" className={shared.button} disabled={blocked || generating} onClick={close}>关闭</button></div>
  </Dialog>
}
