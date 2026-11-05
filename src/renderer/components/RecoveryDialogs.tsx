import { useEffect, useState } from 'react'
import type { OrphanScan, StudioApi } from '../../contracts/api'
import { request } from '../request'
import { Dialog } from './Dialog'
import styles from '../App.module.css'

interface OrphanProps { api: StudioApi; busy: boolean; error?: string | null; onClose: () => void; onRegister: (bookId: string) => void }

export function OrphanBooksDialog({ api, busy, error, onClose, onRegister }: OrphanProps) {
  const [scan, setScan] = useState<OrphanScan | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setScan(null); setReadError(null)
    void request(() => api.findOrphanBooks()).then((result) => {
      if (!active) return
      if (result.ok) setScan(result.data); else setReadError(result.error.message)
    })
    return () => { active = false }
  }, [api, attempt])
  return <Dialog title="找回未登记作品" error={error ?? readError} busy={busy} onClose={onClose}>
    <p className={styles.helpText}>检查当前作品库内已有、但未出现在书架中的作品。登记会把选中的作品放回书架。</p>
    {!scan && !readError && <p className={styles.helpText} role="status">正在检查当前作品库…</p>}
    {readError && <button className={styles.textButton} type="button" onClick={() => setAttempt(attempt + 1)} disabled={busy}>重新检查</button>}
    {scan && <><ul className={styles.orphanList}>{scan.books.map((item) => <li key={item.book.id}><span><strong>{item.book.title}</strong><small>{item.chapterCount} 章</small></span><button className={styles.button} type="button" onClick={() => onRegister(item.book.id)} disabled={busy}>登记到书架</button></li>)}</ul>
      {scan.books.length === 0 && <p className={styles.helpText}>没有找到可登记的作品。</p>}{scan.skipped > 0 && <p className={styles.helpText}>{scan.skipped} 项无法识别，未作修改。</p>}</>}
    <div className={styles.formActions}><button className={styles.button} type="button" onClick={onClose} disabled={busy}>关闭</button></div>
  </Dialog>
}

interface RecoveryProps {
  busy: boolean
  error?: string | null
  hasDraft: boolean
  copiedPath: string | null
  uncertainMutation: boolean
  canReloadWithoutRestart: boolean
  onCopy: () => void
  onRecover: (restart: boolean) => void
  onClose: () => void
}

export function RecoveryDialog({ busy, error, hasDraft, copiedPath, uncertainMutation, canReloadWithoutRestart, onCopy, onRecover, onClose }: RecoveryProps) {
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => setAcknowledged(false), [copiedPath])
  const permitted = acknowledged && (!hasDraft || Boolean(copiedPath)) && !busy
  return <Dialog title="保留草稿与恢复工作室" busy={busy} error={error} onClose={onClose}>
    <div className={styles.fieldStack}>
      <p className={styles.helpText}>先把当前窗口的正文另存为草稿副本，再决定是否重新读取磁盘。副本由桌面程序直接写出，不依赖写作服务。</p>
      {hasDraft && <button className={styles.button} type="button" onClick={onCopy} disabled={busy}>{busy ? '处理中…' : copiedPath ? '再次另存当前草稿' : '另存当前草稿副本'}</button>}
      {copiedPath && <p className={styles.copyReceipt} role="status">草稿副本已保存：<span>{copiedPath}</span></p>}
      {hasDraft && !copiedPath && <p className={styles.helpText}>成功保存当前编辑状态的副本后，才能继续重载。取消另存不会放弃草稿。</p>}
      <label className={styles.checkLabel}><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={busy || (hasDraft && !copiedPath)} />我确认以磁盘版本替换窗口草稿，并重新核对书架和目录。</label>
      {uncertainMutation && <p className={styles.formError}>上次操作可能已经写入。恢复后请先核对作品和章节，不要立即重复建立或导入。</p>}
      <p className={styles.helpText}>重新连接仅在旧服务已退出后可用。无法确认服务状态或读取失败时，当前窗口内容和副本仍保留。</p>
    </div>
    <div className={styles.formActions}><button className={styles.button} type="button" onClick={onClose} disabled={busy}>取消</button>
      {canReloadWithoutRestart && <button className={styles.button} type="button" disabled={!permitted} onClick={() => onRecover(false)}>重载已保存版本</button>}
      <button className={styles.primaryButton} type="button" disabled={!permitted} onClick={() => onRecover(true)}>重新连接并重载</button></div>
  </Dialog>
}
