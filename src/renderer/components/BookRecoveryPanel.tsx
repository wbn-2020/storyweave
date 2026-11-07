import { useEffect, useRef, useState } from 'react'
import type { AppError, BookSummary, Result, StudioApi } from '../../contracts/api'
import {
  isBookRecoveryExportReceiptFor, isBookRecoveryPreviewFor, isBookRecoveryRestoreReceiptFor,
  type BookRecoveryExportInput, type BookRecoveryExportReceipt, type BookRecoveryPreview, type BookRecoveryRestoreReceipt,
} from '../../contracts/book-recovery'
import { request } from '../request'
import { Dialog } from './Dialog'
import styles from '../App.module.css'

interface Props {
  api: StudioApi
  open: boolean
  book: BookSummary | null
  targetRoot: string | null
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
  const [failedRestore, setFailedRestore] = useState<{ preview: BookRecoveryPreview; message: string } | null>(null)
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [unresolved, setUnresolved] = useState<PendingRequest | null>(null)
  const [reconciled, setReconciled] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
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

  function publishLock() { current.current.onDirtyChange(lock.current || Boolean(pendingRef.current)) }
  function hold(value: PendingRequest | null) { pendingRef.current = value; setPending(value); publishLock() }
  function clearPreview() { previewRef.current = null; setPreview(null); setConfirmed(false) }
  function begin(name: string, allowPending = false): boolean {
    if (!current.current.open || current.current.busy || lock.current || (!allowPending && pendingRef.current)) return false
    lock.current = true; setOperation(name); setMessage(null); publishLock(); return true
  }
  function finish() { lock.current = false; if (mounted.current) { setOperation(null); publishLock() } }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; current.current.onDirtyChange(false) }
  }, [])
  useEffect(() => {
    selectionRef.current = null; clearPreview()
    // 重新连接只释放旧会话锁，不代表此前的磁盘操作没有发生；保留身份供作者核对。
    if (previousRecovery.current !== recoveryEpoch && pendingRef.current) {
      setUnresolved(pendingRef.current); setReconciled(false); hold(null)
      setMessage('已重新连接，上次操作结果仍未确认。请先核对书架和下方记录，再重新选择恢复包。')
    }
    previousRecovery.current = recoveryEpoch
  }, [targetRoot, recoveryEpoch])

  async function refreshShelf(target: string) {
    let failure: string | null
    try { failure = await current.current.onRefresh(target) }
    catch { failure = '书架刷新未完成，请稍后重试刷新。' }
    if (mounted.current) setRefreshError(failure)
  }

  function accept(source: RecoveryRequest, value: unknown): boolean {
    if (source.command === 'recovery.export') {
      if (!isBookRecoveryExportReceiptFor(value, source.input)) return false
      setExported({ receipt: value, title: source.title, targetRoot: source.targetRoot })
      setMessage('作品备份已创建，请保留整个恢复包目录。'); return true
    }
    if (source.command === 'recovery.prepare') {
      if (!isBookRecoveryPreviewFor(value, source.targetRoot)) return false
      // 只读预览也带一次性令牌；迟到回执可以确认收讫，但不能替换新选择或新书库的预览。
      if (selectionRef.current !== source || current.current.targetRoot !== source.targetRoot || current.current.recoveryEpoch !== source.recoveryEpoch) {
        setMessage('原预览回执已确认，书库或会话已变化，请重新选择恢复包。'); return true
      }
      previewRef.current = value; setPreview(value); setConfirmed(false)
      setMessage('恢复包已校验，请核对内容与目标作品库。'); return true
    }
    if (!isBookRecoveryRestoreReceiptFor(value, source.preview)) return false
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
    const input = { token: selected.token, packageId: selected.packageId, manifestHash: selected.manifestHash }
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

  if (!open) return null
  return <Dialog title="作品备份与恢复" wide busy={blocked} onClose={close} error={error}>
    <div className={styles.fieldStack} aria-busy={Boolean(operation)}>
      {operation && <p className={styles.helpText} role="status">{operation}…</p>}
      {message && <p className={styles.helpText} role="status">{message}</p>}
      {pending && <section className={styles.inlineNotice} role="alert"><div className={styles.fieldStack}>
        <strong>{label(pending.source)}结果待确认</strong>
        <p>原操作可能仍在处理或已经完成。请查询原回执，暂时不要再次备份或提交恢复。</p>
        {!pending.requestId && <p>本次没有可查询的请求编号，请保留操作记录并进入草稿与恢复核对。</p>}
        <label>本次操作记录<textarea value={recoveryInfo(pending)} readOnly rows={5} onFocus={(event) => event.target.select()} /></label>
        <div className={styles.actionRow}>
          <button className={styles.button} type="button" disabled={busy || Boolean(operation) || !pending.requestId} onClick={() => void checkReceipt()}>查询原回执</button>
          <button className={styles.button} type="button" disabled={busy || Boolean(operation)} onClick={recover}>进入草稿与恢复</button>
        </div>
      </div></section>}
      {unresolved && <section className={styles.fieldStack}>
        <p className={styles.formError}>重新连接前的{label(unresolved.source)}仍需核对。请查看相关目录和书架；下方记录会保留。</p>
        <label>未确认操作记录<textarea value={recoveryInfo(unresolved)} readOnly rows={4} onFocus={(event) => event.target.select()} /></label>
        <label className={styles.checkLabel}><input type="checkbox" checked={reconciled} disabled={blocked} onChange={(event) => setReconciled(event.target.checked)} />我已核对上次操作的目录和书架，后续操作将重新选择目录并预览。</label>
      </section>}
      <section className={styles.fieldStack} aria-label="备份当前作品">
        <h3>备份当前作品</h3>
        <p className={styles.helpText}>保存所有已落盘的正文、历史版本、作者定稿、资料与任务记录，以及登记的导入原件。未落盘草稿、书库目录、升级备份和会话密钥不包含在恢复包内。</p>
        <p className={styles.helpText}>{book ? `当前作品：《${book.title}》 · 作品版本 ${book.revision}${book.archivedAt ? ' · 已归档，可备份' : ''}` : '需要备份时，请先从书架打开作品。下方恢复入口可直接使用。'}</p>
        <button className={styles.button} type="button" disabled={blocked || needsReconciliation || !book || !targetRoot} onClick={exportBook}>选择保存位置并备份当前作品</button>
        <p className={styles.helpText}>选择父目录后，将新建一个独立的恢复包子目录。请完整保留其中的文件。</p>
        {exported && <div className={styles.copyReceipt} role="status">《{exported.title}》最近一次备份已完成
          <span>恢复包：{exported.receipt.packagePath}</span>
          <span>来源作品库：{exported.targetRoot}</span>
          <span>{new Date(exported.receipt.createdAt).toLocaleString('zh-CN')} · 作品版本 {exported.receipt.bookRevision} · 格式 v{exported.receipt.schemaVersion}</span>
          <span>{exported.receipt.chapterCount.toLocaleString()} 章 · {exported.receipt.revisionCount.toLocaleString()} 个正文版本 · {exported.receipt.sourceCount.toLocaleString()} 份导入原件 · {formatBytes(exported.receipt.totalBytes)}</span>
        </div>}
      </section>
      <section className={styles.fieldStack} aria-label="从恢复包恢复作品">
        <h3>从恢复包恢复作品</h3>
        <p className={styles.helpText}>目标作品库：{targetRoot ?? '尚未选择，请先选择作品库。'}</p>
        <div className={styles.actionRow}>
          <button className={styles.button} type="button" disabled={blocked || needsReconciliation || !targetRoot} onClick={selectPackage}>选择恢复包目录并预览</button>
          <button className={styles.button} type="button" disabled={blocked} onClick={chooseWorkspace}>选择其他作品库</button>
        </div>
        <p className={styles.helpText}>请选择包含 manifest.json 的完整恢复包目录。预览校验通过并确认后，才会恢复作品。</p>
        {failedRestore && <div className={styles.stateBlock}>
          <p className={styles.formError}>最近一次恢复返回：{failedRestore.message}</p>
          <p className={styles.directoryPath}>恢复包：{failedRestore.preview.packagePath}</p>
          <p className={styles.directoryPath}>目标作品库：{failedRestore.preview.targetRoot}</p>
          <p>请先核对目标目录和书架；继续恢复须重新选择恢复包预览。</p>
        </div>}
        {currentPreview && <>
          <div className={styles.stateBlock}>
            <strong>《{currentPreview.book.title}》{currentPreview.book.archivedAt ? ' · 已归档' : ''}</strong>
            <p>备份时间：{new Date(currentPreview.createdAt).toLocaleString('zh-CN')}</p>
            <p>作品版本 {currentPreview.book.revision} · 数据格式 v{currentPreview.schemaVersion}</p>
            <p>{currentPreview.chapterCount.toLocaleString()} 章 · {currentPreview.revisionCount.toLocaleString()} 个正文版本 · {currentPreview.sourceCount.toLocaleString()} 份导入原件 · {formatBytes(currentPreview.totalBytes)}</p>
            <p className={styles.directoryPath}>恢复包：{currentPreview.packagePath}</p>
            <p className={styles.directoryPath}>目标作品库：{currentPreview.targetRoot}</p>
          </div>
          {currentPreview.conflict ? <p className={styles.formError} role="alert">目标作品库已有同一 ID 的作品或作品目录，无法恢复。请选择其他作品库，再重新选择恢复包。已有作品不会被覆盖。</p> : <label className={styles.checkLabel}>
            <input type="checkbox" checked={confirmed} disabled={blocked || needsReconciliation} onChange={(event) => setConfirmed(event.target.checked)} />我已核对作品、备份时间和目标作品库，确认恢复这份作品。
          </label>}
          <button className={styles.primaryButton} type="button" disabled={blocked || needsReconciliation || currentPreview.conflict || !confirmed} onClick={restoreBook}>确认恢复作品</button>
        </>}
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
      </section>
    </div>
    <div className={styles.formActions}><button className={styles.button} type="button" onClick={close} disabled={blocked}>关闭</button></div>
  </Dialog>
}
