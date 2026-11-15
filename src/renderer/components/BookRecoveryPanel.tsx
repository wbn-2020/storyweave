import { useEffect, useRef, useState } from 'react'
import type { AppError, BookSummary, RecoveryDraftList, Result, StudioApi } from '../../contracts/api'
import {
  isBookRecoveryExportReceiptFor, isBookRecoveryPreviewFor, isBookRecoveryRestoreReceiptFor,
  type BookRecoveryExportInput, type BookRecoveryExportReceipt, type BookRecoveryPreview, type BookRecoveryRestoreReceipt,
} from '../../contracts/book-recovery'
import { request } from '../request'
import { Dialog } from './Dialog'
import styles from '../StellarShared.module.css'
import recovery from './StellarRecovery.module.css'
import { StudioIcon } from './StudioIcon'

interface Props {
  api: StudioApi
  open: boolean
  book: BookSummary | null
  targetRoot: string | null
  draftScope?: string
  bookCount: number
  recoveryEpoch: number
  busy: boolean
  error?: string | null
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  onRecover: () => void
  onChooseWorkspace: () => void
  onRestored: (receipt: BookRecoveryRestoreReceipt) => void
  onRefresh: (targetRoot: string) => Promise<string | null>
  onOpenBook: (bookId: string) => void
}

type RecoveryRequest = { targetRoot: string; recoveryEpoch: number } & (
  | { command: 'recovery.export'; input: BookRecoveryExportInput; title: string }
  | { command: 'recovery.prepare' }
  | { command: 'recovery.restore'; preview: BookRecoveryPreview }
)
interface PendingRequest { source: RecoveryRequest; requestId?: string }
interface ExportedBook { receipt: BookRecoveryExportReceipt; title: string; targetRoot: string }
interface RestoredBook { receipt: BookRecoveryRestoreReceipt; preview: BookRecoveryPreview }
interface PackageEntry {
  id: string; title: string; path: string; createdAt: string; bytes: number
  state: 'verified' | 'unchecked' | 'restored'
  targetState?: BookRecoveryPreview['targetState']
}
type PackageRecord = Omit<PackageEntry, 'state' | 'targetState'> & { targetRoot: string }
const targetStateLabels = { new: '可恢复', resumable: '可续办', incomplete: '未完成冲突', conflict: '目标目录冲突' } as const

function label(source: RecoveryRequest): string {
  return source.command === 'recovery.export' ? '创建作品备份' : source.command === 'recovery.prepare' ? '校验恢复包' : '恢复作品'
}
function uncertain(error: AppError): boolean {
  return error.code === 'REQUEST_TIMEOUT' || error.code === 'SERVICE_UNAVAILABLE'
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
function recoveryInfo(value: PendingRequest): string {
  const source = value.source
  return JSON.stringify({ operation: label(source), requestId: value.requestId ?? null, targetRoot: source.targetRoot,
    ...(source.command === 'recovery.export' ? { title: source.title, ...source.input } : {}),
    ...(source.command === 'recovery.restore' ? { packageId: source.preview.packageId, manifestHash: source.preview.manifestHash,
      packagePath: source.preview.packagePath, book: source.preview.book } : {}) }, null, 2)
}

export function BookRecoveryPanel(props: Props) {
  const { api, open, book, targetRoot, recoveryEpoch, busy, error, onClose, onChooseWorkspace, onOpenBook } = props
  const [preview, setPreview] = useState<BookRecoveryPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [exported, setExported] = useState<ExportedBook | null>(null)
  const [restored, setRestored] = useState<RestoredBook | null>(null)
  const [packageHistory, setPackageHistory] = useState<PackageRecord[]>([])
  const [failedRestore, setFailedRestore] = useState<{ preview: BookRecoveryPreview; message: string } | null>(null)
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [unresolved, setUnresolved] = useState<PendingRequest | null>(null)
  const [reconciled, setReconciled] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [draftInventory, setDraftInventory] = useState<RecoveryDraftList | null>(null)
  const [inventoryError, setInventoryError] = useState<string | null>(null)
  const [inventoryReading, setInventoryReading] = useState(false)
  const [inventoryAttempt, setInventoryAttempt] = useState(0)
  const [validationFailure, setValidationFailure] = useState<{ targetRoot: string; recoveryEpoch: number; message: string } | null>(null)
  const current = useRef(props)
  const mounted = useRef(false)
  const lock = useRef(false)
  const pendingRef = useRef<PendingRequest | null>(null)
  const previewRef = useRef<BookRecoveryPreview | null>(null)
  const selectionRef = useRef<RecoveryRequest | null>(null)
  const previousRecovery = useRef(recoveryEpoch)
  current.current = props
  const blocked = busy || Boolean(operation || pending)
  const needsReconciliation = Boolean(unresolved && !reconciled)
  const currentPreview = preview?.targetRoot === targetRoot && selectionRef.current?.recoveryEpoch === recoveryEpoch ? preview : null
  const currentValidationFailure = validationFailure?.targetRoot === targetRoot && validationFailure.recoveryEpoch === recoveryEpoch ? validationFailure : null

  function publishLock() { current.current.onDirtyChange(lock.current || Boolean(pendingRef.current)) }
  function hold(value: PendingRequest | null) { pendingRef.current = value; setPending(value); publishLock() }
  function clearPreview() { previewRef.current = null; setPreview(null); setConfirmed(false) }
  function begin(name: string, allowPending = false): boolean {
    if (!current.current.open || current.current.busy || lock.current || (!allowPending && pendingRef.current)) return false
    setValidationFailure(null)
    lock.current = true; setOperation(name); setMessage(null); publishLock(); return true
  }
  function finish() { lock.current = false; if (mounted.current) { setOperation(null); publishLock() } }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; current.current.onDirtyChange(false) }
  }, [])
  useEffect(() => {
    setValidationFailure(null)
    selectionRef.current = null; clearPreview()
    // 重新连接只释放旧会话锁，不代表此前的磁盘操作没有发生；保留身份供作者核对。
    if (previousRecovery.current !== recoveryEpoch && pendingRef.current) {
      setUnresolved(pendingRef.current); setReconciled(false); hold(null)
      setMessage('已重新连接，上次操作结果仍未确认。请先核对书架和下方记录，再重新选择恢复包。')
    }
    previousRecovery.current = recoveryEpoch
  }, [targetRoot, recoveryEpoch])
  useEffect(() => {
    if (!open || !props.draftScope) { setDraftInventory(null); return }
    let active = true
    setInventoryReading(true); setInventoryError(null); setDraftInventory(null)
    // 容量直接读取当前作品库的有界检查点清单，不把作品备份大小当成草稿占用。
    void request(() => api.listRecoveryDrafts({ scope: props.draftScope! })).then((result) => {
      if (!active) return
      setInventoryReading(false)
      if (result.ok) setDraftInventory(result.data)
      else setInventoryError(result.error.message)
    })
    return () => { active = false }
  }, [api, open, props.draftScope, recoveryEpoch, inventoryAttempt])

  async function refreshShelf(target: string) {
    let failure: string | null
    try { failure = await current.current.onRefresh(target) }
    catch { failure = '书架刷新未完成，请稍后重试刷新。' }
    if (mounted.current) setRefreshError(failure)
  }

  function rememberPackage(target: string, value: Pick<BookRecoveryPreview, 'packageId' | 'packagePath' | 'createdAt' | 'totalBytes'>, title: string) {
    // 会话清单只保留显示字段；历史校验状态和一次性令牌不能成为下一次恢复的依据。
    setPackageHistory((previous) => [{ targetRoot: target, id: value.packageId, title,
      path: value.packagePath, createdAt: value.createdAt, bytes: value.totalBytes },
    ...previous.filter((item) => item.targetRoot !== target || item.id !== value.packageId)])
  }

  function accept(source: RecoveryRequest, value: unknown): boolean {
    if (source.command === 'recovery.export') {
      if (!isBookRecoveryExportReceiptFor(value, source.input)) return false
      rememberPackage(source.targetRoot, value, source.title)
      setExported({ receipt: value, title: source.title, targetRoot: source.targetRoot })
      setMessage('作品备份已创建，请保留整个恢复包目录。'); return true
    }
    if (source.command === 'recovery.prepare') {
      if (!isBookRecoveryPreviewFor(value, source.targetRoot)) return false
      // 只读预览也带一次性令牌；迟到回执可以确认收讫，但不能替换新选择或新书库的预览。
      if (selectionRef.current !== source || current.current.targetRoot !== source.targetRoot || current.current.recoveryEpoch !== source.recoveryEpoch) {
        setMessage('原预览回执已确认，书库或会话已变化，请重新选择恢复包。'); return true
      }
      rememberPackage(source.targetRoot, value, value.book.title)
      previewRef.current = value; setPreview(value); setConfirmed(false)
      setMessage('恢复包已校验，请核对内容与目标作品库。'); return true
    }
    if (!isBookRecoveryRestoreReceiptFor(value, source.preview)) return false
    rememberPackage(source.targetRoot, source.preview, value.book.title)
    // 先保存确定的完成回执，书架刷新是独立的只读操作，失败不能重新开放旧令牌提交。
    clearPreview(); setRestored({ receipt: value, preview: source.preview }); setFailedRestore(null); setRefreshError(null)
    setMessage('作品恢复已完成。')
    try { current.current.onRestored(value) }
    catch { setRefreshError('书架显示更新未完成，可重试刷新。') }
    return true
  }

  function fail(source: RecoveryRequest, failure: AppError) {
    if (source.command !== 'recovery.export') clearPreview()
    if (uncertain(failure)) {
      hold({ source, requestId: failure.requestId })
      setMessage('尚未收到确定结果，较大的恢复包可能需要更长时间。请查询原回执，不要重复提交。')
    } else {
      // 失败回执不一定含包身份，也可能是权限或目录错误，不能据此虚构“损坏包”列表项。
      if (source.command === 'recovery.prepare') setValidationFailure({ targetRoot: source.targetRoot, recoveryEpoch: source.recoveryEpoch, message: failure.message })
      if (source.command === 'recovery.restore') setFailedRestore({ preview: source.preview, message: failure.message })
      setMessage(failure.message + (source.command === 'recovery.restore' ? ' 本次预览已失效，请重新选择恢复包并核对目标书库。' : ''))
    }
  }

  async function run(source: RecoveryRequest, send: () => Promise<Result<unknown>>) {
    if (!begin(label(source))) return
    try {
      const result = await request(send)
      if (!mounted.current) return
      if (!result.ok) { fail(source, result.error); return }
      if (result.data === null && source.command !== 'recovery.restore') { setMessage('已取消目录选择。'); return }
      if (!accept(source, result.data)) {
        hold({ source }); setMessage('返回内容与本次作品、恢复包或目标书库不匹配，结果仍待确认。'); return
      }
      if (source.command === 'recovery.restore') await refreshShelf(source.targetRoot)
    } finally { finish() }
  }

  function exportBook() {
    const latest = current.current
    if (blocked || needsReconciliation || lock.current || !latest.book || !latest.targetRoot) return
    const source: RecoveryRequest = { command: 'recovery.export', targetRoot: latest.targetRoot, recoveryEpoch: latest.recoveryEpoch,
      title: latest.book.title, input: { bookId: latest.book.id, expectedBookRevision: latest.book.revision } }
    void run(source, () => api.exportBookRecovery(source.input))
  }

  function selectPackage() {
    const latest = current.current
    if (blocked || needsReconciliation || lock.current || !latest.targetRoot) return
    const source: RecoveryRequest = { command: 'recovery.prepare', targetRoot: latest.targetRoot, recoveryEpoch: latest.recoveryEpoch }
    clearPreview(); selectionRef.current = source
    void run(source, () => api.selectBookRecovery())
  }

  function restoreBook() {
    const selected = previewRef.current
    if (blocked || needsReconciliation || lock.current || !confirmed || !selected || selected.conflict || selected.targetRoot !== current.current.targetRoot ||
      selectionRef.current?.recoveryEpoch !== current.current.recoveryEpoch) return
    const source: RecoveryRequest = { command: 'recovery.restore', targetRoot: selected.targetRoot, recoveryEpoch: current.current.recoveryEpoch, preview: selected }
    const input = { token: selected.token, packageId: selected.packageId, manifestHash: selected.manifestHash, resume: selected.targetState === 'resumable' }
    // 令牌在首次提交时从可用状态移除；失败、超时和补领都不得重复提交这次输入。
    clearPreview(); selectionRef.current = null
    void run(source, () => api.restoreBookRecovery(input))
  }

  async function checkReceipt() {
    const captured = pendingRef.current
    if (!captured?.requestId || !begin('查询原回执', true)) return
    try {
      const result = await request(() => api.getRequestStatus({ requestId: captured.requestId! }))
      if (!mounted.current || pendingRef.current !== captured) return
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.state !== 'completed') {
        setMessage(result.data.state === 'pending' ? '原请求仍在处理，请稍后再查询。' : '原回执已不可用，操作可能已经完成。请保留下方记录并进入草稿与恢复。'); return
      }
      const response = result.data.response
      if (response.command !== captured.source.command) { setMessage('原回执的操作类型不匹配，已保持锁定。'); return }
      if (!response.result.ok) {
        if (uncertain(response.result.error)) { setMessage(response.result.error.message); return }
        hold(null); fail(captured.source, response.result.error); return
      }
      if (!accept(captured.source, response.result.data)) { setMessage('原回执的作品、恢复包或目标书库不匹配，已保持锁定。'); return }
      hold(null)
      if (captured.source.command === 'recovery.restore') await refreshShelf(captured.source.targetRoot)
    } finally { finish() }
  }

  async function retryRefresh() {
    if (!restored || !begin('刷新书架')) return
    try { await refreshShelf(restored.receipt.targetRoot) } finally { finish() }
  }
  function chooseWorkspace() {
    if (blocked || lock.current || pendingRef.current) return
    // 重新选择同一目录也会清除服务令牌，发起选择前就使旧预览失效。
    selectionRef.current = null; clearPreview(); onChooseWorkspace()
  }
  function close() {
    if (blocked || lock.current || pendingRef.current) return
    selectionRef.current = null; clearPreview(); onClose()
  }
  function recover() {
    if (busy || lock.current) return
    selectionRef.current = null; clearPreview(); current.current.onRecover()
  }

  // 校验通过的包也可能与目标目录冲突，不能将其标为包内容损坏。
  const packages = new Map<string, PackageEntry>()
  for (const item of packageHistory) {
    if (item.targetRoot !== targetRoot) continue
    const completed = restored?.receipt.targetRoot === targetRoot && restored.receipt.packageId === item.id && restored.preview.packagePath === item.path
    packages.set(item.id, { ...item, state: completed ? 'restored' : 'unchecked' })
  }
  if (currentPreview) packages.set(currentPreview.packageId, { id: currentPreview.packageId, title: currentPreview.book.title,
    path: currentPreview.packagePath, createdAt: currentPreview.createdAt, bytes: currentPreview.totalBytes, state: 'verified', targetState: currentPreview.targetState })
  const capacity = draftInventory?.capacity
  const capacityRatio = capacity ? capacity.bytes / Math.max(1, capacity.maxBytes) : 0
  // 文件数和字节数任一触限都会暂停检查点；进度条仍只表示真实字节占用。
  const capacityNearLimit = capacity && (capacity.files >= capacity.maxFiles * .8 || capacityRatio >= .8)
  const capacityFull = capacity && (capacity.files >= capacity.maxFiles || capacity.bytes >= capacity.maxBytes)
  const previewState = pending ? '等待回执' : operation ? `${operation}…`
    : currentValidationFailure ? '校验未完成'
      : currentPreview ? targetStateLabels[currentPreview.targetState]
      : failedRestore?.preview.targetRoot === targetRoot ? '恢复未完成'
        : restored?.receipt.targetRoot === targetRoot ? '恢复已完成' : '等待选择恢复包'

  if (!open) return null
  return <Dialog title="备份与恢复" inline busy={blocked} onClose={close} error={error} className={recovery.page}>
    <p className={recovery.subtitle}>管理您的书库备份，随时恢复重要数据</p>
    <div className={recovery.overview}>
      <section className={recovery.location} aria-label="当前书库位置"><span className={recovery.overviewMark} aria-hidden="true"><StudioIcon name="folder" size={28} /></span><div><h3>当前书库位置</h3><strong>{targetRoot ?? '尚未选择作品库'}</strong></div><dl><div><dt>书籍数</dt><dd>{props.bookCount.toLocaleString()}</dd></div><div><dt>最近备份</dt><dd>{exported?.targetRoot === targetRoot ? new Date(exported.receipt.createdAt).toLocaleString('zh-CN') : '本次会话暂无'}</dd></div></dl></section>
      <section className={recovery.capacity} aria-label="检查点容量"><span className={recovery.overviewMark} aria-hidden="true"><StudioIcon name="layers" size={28} /></span><div className={recovery.capacityContent}><header><h3>检查点容量</h3>{capacityNearLimit && <span className={recovery.capacityWarning}><StudioIcon name="warning" size={18} />{capacityFull ? '已达上限' : '接近上限'}</span>}<button type="button" className={recovery.iconButton} disabled={inventoryReading || blocked || !props.draftScope} title="刷新检查点容量" aria-label="刷新检查点容量" onClick={() => setInventoryAttempt((value) => value + 1)}><StudioIcon name="refresh" size={20} /></button></header>
        {capacity ? <><dl><div><dt>当前代文件数</dt><dd>{capacity.files.toLocaleString()}<small> / {capacity.maxFiles.toLocaleString()}</small></dd></div><div><dt>容量使用</dt><dd>{Math.round(capacityRatio * 100)}%<progress value={Math.min(1, capacityRatio)} max={1} aria-label="检查点容量使用比例" /></dd></div></dl><p>{formatBytes(capacity.bytes)} / {formatBytes(capacity.maxBytes)} · {draftInventory?.generations.length.toLocaleString()} 代</p></> : <p role={inventoryError ? 'alert' : 'status'}>{inventoryError ?? (inventoryReading ? '正在读取检查点容量…' : '选择作品库后查看')}</p>}
        {draftInventory?.warnings.map((warning, index) => <p className={recovery.capacityNotice} role="alert" key={`${index}:${warning}`}>{warning}</p>)}
        </div>
      </section>
    </div>
    <div className={styles.fieldStack} aria-busy={Boolean(operation)}>
      {operation && <p className={recovery.operationStatus} role="status"><span className={styles.spinner} aria-hidden="true" />{operation}…</p>}
      {message && !currentValidationFailure && <p className={styles.helpText} role="status">{message}</p>}
      {pending && <section className={styles.inlineNotice} role="alert"><div className={styles.fieldStack}>
        <strong>{label(pending.source)}结果待确认</strong>
        <p>原操作可能仍在处理或已经完成。请查询原回执，暂时不要再次备份或提交恢复。</p>
        {!pending.requestId && <p>本次没有可查询的请求编号，请保留操作记录并进入草稿与恢复核对。</p>}
        <label>本次操作记录<textarea value={recoveryInfo(pending)} readOnly rows={5} onFocus={(event) => event.target.select()} /></label>
        <div className={styles.actionRow}>
          <button className={styles.button} type="button" aria-busy={operation === '查询原回执'} disabled={busy || Boolean(operation) || !pending.requestId} onClick={() => void checkReceipt()}>查询原回执</button>
          <button className={styles.button} type="button" disabled={busy || Boolean(operation)} onClick={recover}>进入草稿与恢复</button>
        </div>
      </div></section>}
      {unresolved && <section className={styles.fieldStack}>
        <p className={styles.formError}>重新连接前的{label(unresolved.source)}仍需核对。请查看相关目录和书架；下方记录会保留。</p>
        <label>未确认操作记录<textarea value={recoveryInfo(unresolved)} readOnly rows={4} onFocus={(event) => event.target.select()} /></label>
        <label className={styles.checkLabel}><input type="checkbox" checked={reconciled} disabled={blocked} onChange={(event) => setReconciled(event.target.checked)} />我已核对上次操作的目录和书架，后续操作将重新选择目录并预览。</label>
      </section>}
      <div className={recovery.workspace}>
      <section className={`${styles.fieldStack} ${recovery.backup}`} aria-label="备份当前作品">
        <header className={recovery.sectionHeading}><h3>恢复包列表</h3><button className={recovery.iconButton} type="button" disabled={blocked || needsReconciliation || !targetRoot} title="选择恢复包并校验" aria-label="选择恢复包并校验" onClick={selectPackage}><StudioIcon name="refresh" size={20} /></button></header>
        <ul className={recovery.packages} aria-label="本次会话恢复包">{[...packages.values()].map((item) => <li key={item.id} data-state={item.state} data-current={currentPreview?.packageId === item.id}>
          <span className={recovery.packageMark} aria-hidden="true"><StudioIcon name="archive" size={28} /></span><div className={recovery.packageDetails}><strong>{item.title}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN')} · {formatBytes(item.bytes)}</small><span title={item.path}>{item.path}</span>{item.targetState && <small className={recovery.packageTargetState} data-state={item.targetState}>{targetStateLabels[item.targetState]}</small>}</div><span className={recovery.packageState}><StudioIcon name={item.state === 'unchecked' ? 'clock' : 'check'} size={18} />{item.state === 'unchecked' ? '待校验' : item.state === 'restored' ? '已恢复' : '通过'}</span>
        </li>)}</ul>
        {!packages.size && <div className={recovery.empty}><StudioIcon name="archive" size={32} /><p>尚未选择恢复包</p><button className={styles.button} type="button" disabled={blocked || needsReconciliation || !targetRoot} onClick={selectPackage}>选择恢复包</button></div>}
        <p className={styles.helpText}>仅列出本次会话已创建或校验过的恢复包；历史记录需重新选择校验。</p>
        <details className={recovery.backupDetails}>
        <summary>备份当前作品</summary>
        <h3>备份当前作品</h3>
        <p className={styles.helpText}>保存书内数据库中的正文、历史版本、作者定稿、资料与任务记录，以及登记的导入原件。恢复前会校验数据库结构、内容和文件摘要。</p>
        <p className={styles.helpText}>恢复包不含未提交编辑、书库级自动检查点（包括已经落盘的各代草稿）、待补存模型结果、书架目录库、升级备份及显示偏好。全局灵感库 inspiration.sqlite 也不包含；先复制到书内笔记的灵感会随作品备份。请分别保留这些资料；模型会话密钥不会写入备份。完整作品备份不能替代整个工作区的备份。</p>
        <p className={styles.helpText}>{book ? `当前作品：《${book.title}》 · 作品版本 ${book.revision}${book.archivedAt ? ' · 已归档，可备份' : ''}` : '需要备份时，请先从书架打开作品。下方恢复入口可直接使用。'}</p>
        <button className={styles.button} type="button" aria-busy={operation === '创建作品备份'} disabled={blocked || needsReconciliation || !book || !targetRoot} onClick={exportBook}>选择保存位置并备份当前作品</button>
        <p className={styles.helpText}>选择父目录后，将新建一个独立的恢复包子目录。请完整保留其中的文件。</p>
        {exported && <div className={styles.copyReceipt} role="status">《{exported.title}》最近一次备份已完成
          <span>恢复包：{exported.receipt.packagePath}</span>
          <span>来源作品库：{exported.targetRoot}</span>
          <span>{new Date(exported.receipt.createdAt).toLocaleString('zh-CN')} · 作品版本 {exported.receipt.bookRevision} · 格式 v{exported.receipt.schemaVersion}</span>
          <span>{exported.receipt.chapterCount.toLocaleString()} 章 · {exported.receipt.revisionCount.toLocaleString()} 个正文版本 · {exported.receipt.sourceCount.toLocaleString()} 份导入原件 · {formatBytes(exported.receipt.totalBytes)}</span>
        </div>}
        </details>
      </section>
      <section className={`${styles.fieldStack} ${recovery.restore}`} aria-label="从恢复包恢复作品">
        <header className={recovery.sectionHeading}><h3>恢复预览</h3><span className={recovery.state} data-state={pending ? 'pending' : operation ? 'working' : currentValidationFailure ? 'failed' : currentPreview?.targetState ?? (failedRestore?.preview.targetRoot === targetRoot ? 'failed' : restored?.receipt.targetRoot === targetRoot ? 'restored' : 'idle')}>{previewState}</span></header>
        <p className={styles.helpText}>目标作品库：{targetRoot ?? '尚未选择，请先选择作品库。'}</p>
        <p className={styles.helpText}>请选择包含 manifest.json 的完整恢复包目录。预览校验通过并确认后，才会恢复作品。</p>
        {currentValidationFailure && <div className={recovery.validationFailure} role="alert">
          <span className={recovery.decisionMark} aria-hidden="true"><StudioIcon name="warning" size={24} /></span>
          <div><strong>恢复包校验未完成</strong><p>{currentValidationFailure.message}</p><p>请核对完整恢复包与目标作品库，再重新选择并校验。</p></div>
        </div>}
        {failedRestore && <div className={styles.stateBlock}>
          <p className={styles.formError}>最近一次恢复返回：{failedRestore.message}</p>
          <p className={styles.directoryPath}>恢复包：{failedRestore.preview.packagePath}</p>
          <p className={styles.directoryPath}>目标作品库：{failedRestore.preview.targetRoot}</p>
          <p>请先核对目标目录和书架；继续恢复须重新选择恢复包预览。</p>
        </div>}
        {!currentPreview && !currentValidationFailure && !restored && !failedRestore && <div className={recovery.previewEmpty}><StudioIcon name="archive" size={64} /><p>选择完整恢复包后查看作品身份与清单</p></div>}
        {currentPreview && <>
          <div className={recovery.previewIdentity}><span className={recovery.previewMark} aria-hidden="true"><StudioIcon name="archive" size={64} /></span><div className={recovery.identityDetails}>
            <h4>《{currentPreview.book.title}》{currentPreview.book.archivedAt ? ' · 已归档' : ''}</h4>
            <dl className={recovery.identityList}>
              <div><dt>包身份</dt><dd>{currentPreview.packageId}</dd></div>
              <div><dt>备份时间</dt><dd>{new Date(currentPreview.createdAt).toLocaleString('zh-CN')}</dd></div>
              <div><dt>作品版本</dt><dd>{currentPreview.book.revision} · 数据格式 v{currentPreview.schemaVersion}</dd></div>
              <div><dt>章节数</dt><dd>{currentPreview.chapterCount.toLocaleString()}</dd></div>
              <div><dt>恢复包大小</dt><dd>{formatBytes(currentPreview.totalBytes)}</dd></div>
            </dl>
          </div></div>
          <div className={recovery.manifestSummary}>
            <h4>清单摘要</h4>
            <p>{currentPreview.chapterCount.toLocaleString()} 章 · {currentPreview.revisionCount.toLocaleString()} 个正文版本 · {currentPreview.sourceCount.toLocaleString()} 份导入原件</p>
            <p className={styles.directoryPath}>恢复包：{currentPreview.packagePath}</p>
            <p className={styles.directoryPath}>目标作品库：{currentPreview.targetRoot}</p>
          </div>
        </>}
        {/* 预览与书库选择按钮常驻同一父节点，目录窗口返回时不因预览挂载而替换焦点目标。 */}
        <div className={recovery.restoreDecision} data-state={currentPreview?.targetState ?? 'unselected'}>
          {currentPreview && <div className={currentPreview.conflict ? recovery.conflict : recovery.verified} role={currentPreview.conflict ? 'alert' : 'status'}><span className={recovery.decisionMark} aria-hidden="true"><StudioIcon name={currentPreview.conflict ? 'warning' : 'check'} size={24} /></span><div><strong>{targetStateLabels[currentPreview.targetState]}</strong><p>{currentPreview.targetMessage}</p></div></div>}
          {currentPreview && !currentPreview.conflict && <label className={`${styles.checkLabel} ${recovery.restoreConfirmation}`}>
            <input type="checkbox" checked={confirmed} disabled={blocked || needsReconciliation} onChange={(event) => setConfirmed(event.target.checked)} />{currentPreview.targetState === 'resumable' ? '我已核对恢复来源与目标，确认保留已有文件并续办这次恢复。' : '我已核对作品、备份时间和目标作品库，确认恢复这份作品。'}
          </label>}
          <div className={recovery.decisionActions}>
            <button className={styles.button} type="button" disabled={blocked || needsReconciliation || !targetRoot}
              aria-busy={operation === '校验恢复包'} title="从原生窗口选择完整恢复包目录，校验并预览" onClick={selectPackage}>{currentPreview ? '重新校验并预览' : '选择恢复包目录并预览'}</button>
            {currentPreview && <button className={styles.primaryButton} type="button" disabled={blocked || needsReconciliation || currentPreview.conflict || !confirmed}
              title={currentPreview.conflict ? currentPreview.targetMessage : !confirmed ? '请先勾选下方恢复确认。' : undefined} onClick={restoreBook}>{currentPreview.targetState === 'resumable' ? '确认续办恢复' : '确认恢复作品'}</button>}
            <button className={styles.button} type="button" disabled={blocked} onClick={chooseWorkspace}>选择其他作品库</button>
          </div>
        </div>
        {restored && <div className={styles.fieldStack}>
          <div className={styles.copyReceipt} role="status">《{restored.receipt.book.title}》已恢复完成
            <span>目标作品库：{restored.receipt.targetRoot}</span>
            <span>来源恢复包：{restored.preview.packagePath}</span>
            <span>{restored.receipt.chapterCount.toLocaleString()} 章 · {restored.receipt.revisionCount.toLocaleString()} 个正文版本 · {restored.receipt.sourceCount.toLocaleString()} 份导入原件</span>
          </div>
          {refreshError && <p className={styles.formError} role="alert">恢复已经完成，书架尚未刷新：{refreshError} 可重试刷新，无需再次恢复。</p>}
          <div className={styles.actionRow}>
            <button className={styles.button} type="button" disabled={blocked || restored.receipt.targetRoot !== targetRoot} onClick={() => void retryRefresh()}>刷新书架</button>
            <button className={styles.button} type="button" disabled={blocked || restored.receipt.targetRoot !== targetRoot} onClick={() => onOpenBook(restored.receipt.book.id)}>打开已恢复作品</button>
          </div>
        </div>}
        <p className={recovery.invariant}><StudioIcon name="lock" size={20} />不会覆盖现有目录与残件</p>
      </section>
      </div>
    </div>
    <div className={recovery.footer}><button className={styles.button} type="button" onClick={close} disabled={blocked}>返回</button></div>
  </Dialog>
}
