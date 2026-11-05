import { useEffect, useRef, useState } from 'react'
import type { ChapterSnapshot, RevisionSnapshot, RevisionSummary, StudioApi } from '../../contracts/api'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import styles from '../App.module.css'

interface Props {
  api: StudioApi
  chapter: ChapterSnapshot
  archived: boolean
  busy: boolean
  error?: string | null
  onClose: () => void
  onRestore: (revisionId: string) => void
}
const reasons = { created: '建立章节', saved: '保存正文', restored: '恢复版本', imported: '导入正文' }

export function RevisionHistory({ api, chapter, archived, busy, error, onClose, onRestore }: Props) {
  const [items, setItems] = useState<RevisionSummary[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [preview, setPreview] = useState<RevisionSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const pageRequest = useRef(0)
  const previewRequest = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    setItems([]); setCursor(null); setPreview(null); setConfirmRestore(false)
    void loadPage()
    return () => { mounted.current = false; pageRequest.current += 1; previewRequest.current += 1 }
  }, [chapter.bookId, chapter.id, chapter.revisionId])

  async function loadPage(beforeSequence?: number) {
    const ticket = ++pageRequest.current
    setLoading(true); setReadError(null)
    const result = await request(() => api.listRevisions({ bookId: chapter.bookId, chapterId: chapter.id, beforeSequence }))
    if (!mounted.current || ticket !== pageRequest.current) return
    setLoading(false)
    if (!result.ok) { setReadError(result.error.message); return }
    setItems((current) => beforeSequence === undefined ? result.data.items : [...current, ...result.data.items.filter((item) => !current.some((existing) => existing.id === item.id))])
    setCursor(result.data.nextBeforeSequence)
  }

  async function selectRevision(id: string) {
    const ticket = ++previewRequest.current
    setPreviewLoading(true); setPreview(null); setReadError(null); setConfirmRestore(false)
    const result = await request(() => api.readRevision({ bookId: chapter.bookId, chapterId: chapter.id, revisionId: id }))
    if (!mounted.current || ticket !== previewRequest.current) return
    setPreviewLoading(false)
    if (!result.ok) { setReadError(result.error.message); return }
    // 界面只持有当前选中的一个正文版本，列表中始终仅保留摘要。
    setPreview(result.data)
  }

  return <Dialog title={`${chapter.title} · 版本历史`} wide busy={busy} error={error ?? readError} onClose={onClose}>
    <p className={styles.helpText}>恢复会生成新的工作稿版本，已有历史和作者定稿保留。</p>
    <div className={styles.previewLayout}>
      <div className={styles.previewList}><ol>{items.map((item) => <li key={item.id}><button type="button" className={preview?.id === item.id ? styles.selectedPreview : ''} onClick={() => void selectRevision(item.id)} disabled={busy}>
        <strong>版本 {item.sequence} · {reasons[item.reason]}</strong><span>{displayTime(item.createdAt)} · {item.characterCount.toLocaleString()} 字</span>
        <small>{[item.id === chapter.revisionId ? '当前稿' : '', item.id === chapter.finalizedRevisionId ? '作者定稿' : ''].filter(Boolean).join(' · ')}</small>
      </button></li>)}</ol>
      {loading ? <p className={styles.helpText} role="status">读取历史中…</p> : cursor !== null ? <button className={styles.textButton} type="button" onClick={() => void loadPage(cursor)} disabled={busy}>加载更早版本</button> : items.length > 0 ? <p className={styles.helpText}>已到最早版本</p> : <button className={styles.textButton} type="button" onClick={() => void loadPage()} disabled={busy}>重新读取历史</button>}</div>
      <section className={styles.previewPane} aria-label="版本正文预览">{previewLoading ? <p role="status">正在读取正文…</p> : preview ? <><h3>版本 {preview.sequence}</h3><pre>{preview.plainText || '（空白章节）'}</pre></> : <p>选择左侧版本查看正文。</p>}</section>
    </div>
    {confirmRestore && preview && <p className={styles.formError}>将把版本 {preview.sequence} 的正文恢复为新的当前稿。当前窗口的修改会先保存。</p>}
    <div className={styles.formActions}><button type="button" className={styles.button} onClick={onClose} disabled={busy}>关闭</button>
      {confirmRestore && <button type="button" className={styles.button} onClick={() => setConfirmRestore(false)} disabled={busy}>取消恢复</button>}
      <button type="button" className={styles.primaryButton} disabled={busy || archived || !preview || preview.id === chapter.revisionId || previewLoading} onClick={() => { if (preview) { if (confirmRestore) onRestore(preview.id); else setConfirmRestore(true) } }}>{busy ? '处理中…' : confirmRestore ? '确认恢复为新版本' : '恢复所选版本'}</button>
    </div>
  </Dialog>
}
