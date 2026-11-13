import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { BookSummary, DraftImportPreview, RecoveryDraftList, StudioApi } from '../../contracts/api'
import { request } from '../request'
import { Dialog } from './Dialog'
import styles from '../StellarShared.module.css'

interface Props {
  api: StudioApi
  scope: string
  book: BookSummary
  busy: boolean
  error?: string | null
  onClose: () => void
  onCommit: (token: string, title: string) => void
  onRotated?: () => void
}

type Reading = 'list' | 'file' | 'preview' | 'rotate' | null

export function DraftImportDialog({ api, scope, book, busy, error, onClose, onCommit, onRotated }: Props) {
  const [drafts, setDrafts] = useState<RecoveryDraftList | null>(null)
  const [generationId, setGenerationId] = useState<string | undefined>()
  const [confirmRotation, setConfirmRotation] = useState(false)
  const [preview, setPreview] = useState<DraftImportPreview | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [reading, setReading] = useState<Reading>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [submittedToken, setSubmittedToken] = useState<string | null>(null)
  const mounted = useRef(false)
  const requestSequence = useRef(0)
  const operation = useRef<number | null>(null)
  const submitted = useRef<string | null>(null)
  const context = `${scope}:${book.id}:${book.revision}`
  const current = useRef({ context, busy, archived: Boolean(book.archivedAt) })
  current.current = { context, busy, archived: Boolean(book.archivedAt) }
  const locked = busy || reading !== null
  const previewMatches = Boolean(preview && preview.targetBookId === book.id && preview.expectedBookRevision === book.revision)
  const canCommit = Boolean(previewMatches && acknowledged && title.trim() && !locked && !book.archivedAt && submittedToken !== preview?.token)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; requestSequence.current += 1; operation.current = null }
  }, [])

  useEffect(() => { setGenerationId(undefined); setConfirmRotation(false) }, [scope])

  useEffect(() => {
    const ticket = ++requestSequence.current
    operation.current = ticket
    setReading('list'); setReadError(null); setDrafts(null); setPreview(null)
    setSelectedId(null); setAcknowledged(false); setSubmittedToken(null); submitted.current = null
    void request(() => api.listRecoveryDrafts({ scope, generationId })).then((result) => {
      if (!mounted.current || ticket !== requestSequence.current || current.current.context !== context) return
      operation.current = null
      setReading(null)
      if (!result.ok) { setReadError(result.error.message); return }
      setDrafts(result.data)
    })
    return () => { requestSequence.current += 1 }
  }, [api, scope, context, attempt, generationId])

  async function rotate() {
    if (!drafts || !confirmRotation || current.current.busy || operation.current !== null) return
    const ticket = ++requestSequence.current
    operation.current = ticket; setReading('rotate'); setReadError(null)
    const result = await request(() => api.rotateRecoveryDrafts({ scope, expectedGenerationId: drafts.capacity.generationId }))
    if (!mounted.current || ticket !== requestSequence.current || current.current.context !== context) return
    operation.current = null; setReading(null)
    if (!result.ok) { setReadError(result.error.message); return }
    setConfirmRotation(false); setDrafts(result.data); setGenerationId(result.data.selectedGenerationId)
    setAttempt((value) => value + 1)
    // 新代发布后重试当前未保存稿件，避免容量失败的同一编辑序号一直等待下一次输入。
    onRotated?.()
  }

  async function prepare(checkpointId?: string) {
    if (current.current.busy || operation.current !== null) return
    const ticket = ++requestSequence.current
    operation.current = ticket
    // 原预览先失效；取消选文件或读取失败都不能继续确认旧 token。
    setPreview(null); setAcknowledged(false); setReadError(null); setSubmittedToken(null); submitted.current = null
    setSelectedId(checkpointId ?? null); setReading(checkpointId ? 'preview' : 'file')
    const target = { scope, bookId: book.id, expectedBookRevision: book.revision }
    const result = checkpointId
      ? await request(() => api.previewRecoveryDraft({ ...target, checkpointId, generationId: drafts?.selectedGenerationId }))
      : await request(() => api.selectDraftImport(target))
    if (!mounted.current || ticket !== requestSequence.current || current.current.context !== context) return
    operation.current = null
    setReading(null)
    if (!result.ok) { setReadError(result.error.message); return }
    if (!result.data) { setSelectedId(null); return }
    if (result.data.targetBookId !== book.id || result.data.expectedBookRevision !== book.revision) {
      setReadError('恢复预览的目标作品或版本不匹配，请重新选择草稿。')
      return
    }
    setPreview(result.data)
    setTitle(`${result.data.title.slice(0, 115)}（恢复）`)
  }

  function commit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canCommit || !preview || current.current.busy || current.current.archived || operation.current !== null || submitted.current === preview.token) return
    // 确认即时锁定 token，父组件处理回执期间不允许再次提交同一预览。
    submitted.current = preview.token
    setSubmittedToken(preview.token)
    onCommit(preview.token, title.trim())
  }

  function close() {
    if (!current.current.busy && operation.current === null) onClose()
  }

  return <Dialog title="从草稿副本恢复" wide busy={locked} error={error ?? readError} onClose={close}>
    <p className={styles.helpText}>恢复目标：《{book.title}》。检查点来自当前作品库；也可以选择另存的 JSON 草稿。确认后会在目标作品中建立新章节，保留原章节、版本和草稿副本。</p>
    {book.archivedAt && <p className={styles.formError}>目标作品已归档，可以预览草稿。请解除归档后再恢复。</p>}
    <div className={styles.importOptions}>
      <button type="button" className={styles.button} disabled={locked} onClick={() => void prepare()}>{reading === 'file' ? '正在选择与读取…' : '选择 JSON 草稿副本'}</button>
      <button type="button" className={styles.button} disabled={locked} onClick={() => setAttempt((value) => value + 1)}>重新检查恢复草稿</button>
    </div>
    {drafts && <section className={styles.fieldStack} aria-label="检查点容量与分代">
      <p className={styles.helpText}>当前写入代：{drafts.capacity.generationId === 'legacy' ? '初始代' : drafts.capacity.generationId} ·
        {drafts.capacity.files.toLocaleString()} / {drafts.capacity.maxFiles.toLocaleString()} 项 ·
        {(drafts.capacity.bytes / 1024 / 1024).toFixed(1)} / {(drafts.capacity.maxBytes / 1024 / 1024).toFixed(0)} MiB。
        检查点按代独立限额；旧代和已保存副本全部保留。</p>
      <label>查看检查点代<select value={drafts.selectedGenerationId} disabled={locked} onChange={(event) => setGenerationId(event.target.value)}>
        {drafts.generations.map((item) => <option key={item.id} value={item.id}>{item.createdAt ? formatTime(item.createdAt) : '初始代'}{item.active ? '（当前写入）' : '（保留）'}</option>)}
      </select></label>
      <label className={styles.checkLabel}><input type="checkbox" checked={confirmRotation} disabled={locked} onChange={(event) => setConfirmRotation(event.target.checked)} />保留全部旧检查点，新建一代承接后续自动保护</label>
      <button type="button" className={styles.button} disabled={locked || !confirmRotation} onClick={() => void rotate()}>{reading === 'rotate' ? '正在建立新代…' : '建立检查点新代'}</button>
    </section>}
    {drafts && drafts.warnings.length > 0 && <ul className={styles.warningList}>{drafts.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {drafts && drafts.skipped > 0 && <p className={styles.helpText}>{drafts.skipped} 项无法读取或不符合草稿格式，未作修改。</p>}
    <div className={styles.previewLayout}>
      <section className={styles.previewList} aria-label="可恢复草稿">
        {reading === 'list' && <p className={styles.helpText} role="status">正在检查本地草稿…</p>}
        {drafts?.items.length === 0 && <p className={styles.helpText}>当前没有可列出的恢复草稿。可以从 JSON 文件选择已另存的副本。</p>}
        <ol>{drafts?.items.map((item) => <li key={item.checkpointId}>
          <button type="button" className={selectedId === item.checkpointId ? styles.selectedPreview : undefined}
            aria-pressed={selectedId === item.checkpointId} disabled={locked} onClick={() => void prepare(item.checkpointId)}>
            <strong>{item.title}</strong><span>{item.characterCount.toLocaleString()} 字 · {item.bookId === book.id ? '本作品' : '其他作品'}</span>
            <time dateTime={item.createdAt}><small>{formatTime(item.createdAt)}</small></time>
          </button>
        </li>)}</ol>
      </section>
      <section className={styles.previewPane} aria-label="草稿正文预览" aria-busy={reading === 'file' || reading === 'preview'}>
        {(reading === 'file' || reading === 'preview') ? <p role="status">正在读取草稿预览…</p> : preview ? <><h3>{preview.title}</h3><pre>{preview.plainText}</pre></> : <p>选择一个检查点或 JSON 草稿，检查正文后再确认恢复。</p>}
      </section>
    </div>
    {preview && <>
      <div className={styles.importSummary}><strong>{preview.sourceName}</strong><span>{preview.characterCount.toLocaleString()} 字</span><time dateTime={preview.createdAt}>{formatTime(preview.createdAt)}</time></div>
      <p className={styles.helpText}>来源作品：{preview.bookId}{preview.bookId === book.id ? '（当前作品）' : '（与目标作品不同）'}<br />来源章节：{preview.chapterId}<br />来源正文版本：{preview.baseRevisionId}</p>
    </>}
    <form onSubmit={commit}>
      <div className={styles.fieldStack}>
        <label>新章节名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required disabled={!previewMatches || locked || Boolean(book.archivedAt) || submittedToken === preview?.token} /></label>
        <label className={styles.checkLabel}><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={!previewMatches || locked || Boolean(book.archivedAt) || submittedToken === preview?.token} />我已核对草稿，确认恢复到《{book.title}》的新章节，保留现有章节。</label>
      </div>
      {submittedToken && <p className={styles.helpText} role="status">该预览已提交恢复。若结果未确认，请先核对回执和目录，再决定是否另选草稿。</p>}
      <div className={styles.formActions}><button type="button" className={styles.button} disabled={locked} onClick={close}>取消</button><button type="submit" className={styles.primaryButton} disabled={!canCommit}>{busy ? '正在恢复…' : '恢复为新章节'}</button></div>
    </form>
  </Dialog>
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
