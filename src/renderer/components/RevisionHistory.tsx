import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChapterSnapshot, RevisionSnapshot, RevisionSummary, StudioApi } from '../../contracts/api'
import { DomainError } from '../../contracts/api'
import { documentToText, parseManuscript, type ManuscriptBlock } from '../../contracts/manuscript'
import { applyParagraphChanges, compareParagraphs, paragraphText } from '../../contracts/paragraph-diff'
import type { RevisionMergeInput } from '../../contracts/revision-merge'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import styles from '../App.module.css'
import diffStyles from './RevisionHistory.module.css'

export interface RevisionHistoryProps {
  api: StudioApi
  chapter: ChapterSnapshot
  archived: boolean
  busy: boolean
  error?: string | null
  onClose: () => void
  onRestore: (revisionId: string) => void
  onMerge?: (input: RevisionMergeInput) => void | Promise<void>
}
const reasons = { created: '建立章节', saved: '保存正文', restored: '恢复版本', imported: '导入正文' }

export function RevisionHistory({ api, chapter, archived, busy, error, onClose, onRestore, onMerge }: RevisionHistoryProps) {
  const [items, setItems] = useState<RevisionSummary[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const basisKey = `${chapter.bookId}:${chapter.id}:${chapter.revisionId}:${chapter.bookRevision}`
  const [selection, setSelection] = useState<{ basisKey: string; revision: RevisionSnapshot } | null>(null)
  const preview = selection?.basisKey === basisKey ? selection.revision : null
  const [selectedBlocks, setSelectedBlocks] = useState<string[]>([])
  const [differencePage, setDifferencePage] = useState(0)
  const [confirmMerge, setConfirmMerge] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const pageRequest = useRef(0)
  const previewRequest = useRef(0)
  const mounted = useRef(true)
  const submitLock = useRef(false)
  const currentBasis = useRef(basisKey)
  currentBasis.current = basisKey
  const blocked = busy || submitting
  const comparison = useMemo(() => {
    if (!preview) return { changes: [], error: null }
    try { return { changes: compareParagraphs(chapter.document, preview.document), error: null } }
    catch (caught) { return { changes: [], error: caught instanceof DomainError ? caught.message : '无法比较这两份正文，仍可查看原稿。' } }
  }, [chapter.document, preview])
  const merged = useMemo(() => {
    if (!preview || !selectedBlocks.length) return { document: null, error: null }
    try { return { document: applyParagraphChanges(chapter.document, preview.document, selectedBlocks), error: null } }
    catch (caught) { return { document: null, error: caught instanceof DomainError ? caught.message : '所选差异无法合并，请重新选择。' } }
  }, [chapter.document, preview, selectedBlocks])
  const pageSize = 20
  const pageCount = Math.max(1, Math.ceil(comparison.changes.length / pageSize))
  const currentPage = Math.min(differencePage, pageCount - 1)
  const visibleChanges = comparison.changes.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  useEffect(() => {
    mounted.current = true
    setItems([]); setCursor(null); setSelection(null); setPreviewLoading(false); setConfirmRestore(false); setConfirmMerge(false); setSelectedBlocks([]); setDifferencePage(0)
    void loadPage()
    return () => { mounted.current = false; pageRequest.current += 1; previewRequest.current += 1 }
  }, [basisKey])

  async function loadPage(beforeSequence?: number) {
    const ticket = ++pageRequest.current
    const requestedBasis = basisKey
    setLoading(true); setReadError(null)
    const result = await request(() => api.listRevisions({ bookId: chapter.bookId, chapterId: chapter.id, beforeSequence }))
    if (!mounted.current || ticket !== pageRequest.current || currentBasis.current !== requestedBasis) return
    setLoading(false)
    if (!result.ok) { setReadError(result.error.message); return }
    setItems((current) => beforeSequence === undefined ? result.data.items : [...current, ...result.data.items.filter((item) => !current.some((existing) => existing.id === item.id))])
    setCursor(result.data.nextBeforeSequence)
  }

  async function selectRevision(id: string) {
    if (blocked) return
    const ticket = ++previewRequest.current
    const requestedBasis = basisKey
    setPreviewLoading(true); setSelection(null); setReadError(null); setConfirmRestore(false); setConfirmMerge(false); setSelectedBlocks([]); setDifferencePage(0)
    const result = await request(() => api.readRevision({ bookId: chapter.bookId, chapterId: chapter.id, revisionId: id }))
    if (!mounted.current || ticket !== previewRequest.current || currentBasis.current !== requestedBasis) return
    setPreviewLoading(false)
    if (!result.ok) { setReadError(result.error.message); return }
    if (result.data.bookId !== chapter.bookId || result.data.chapterId !== chapter.id || result.data.id !== id) {
      setReadError('读取的版本身份与所选章节不符，未展示或采用。'); return
    }
    try {
      const document = parseManuscript(result.data.document)
      if (documentToText(document) !== result.data.plainText) throw new Error('Revision text mismatch')
      setSelection({ basisKey: requestedBasis, revision: { ...result.data, document } })
    } catch { setReadError('所选版本的正文结构或纯文本无法核对，请保留原稿后重试。') }
  }

  function toggleBlock(id: string) {
    if (blocked) return
    setSelectedBlocks((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
    setConfirmMerge(false); setConfirmRestore(false)
  }

  async function mergeSelected() {
    if (blocked || submitLock.current || archived || !onMerge || !preview || !merged.document || comparison.error) return
    if (!confirmMerge) { setConfirmMerge(true); setConfirmRestore(false); return }
    submitLock.current = true; setSubmitting(true); setReadError(null)
    try {
      await onMerge({ bookId: chapter.bookId, chapterId: chapter.id, expectedBookRevision: chapter.bookRevision,
        expectedRevisionId: chapter.revisionId, sourceRevisionId: preview.id, selectedBlockIds: [...selectedBlocks] })
    } catch { if (mounted.current) setReadError('采用结果尚未确认，所选差异仍保留。请核对保存状态后再继续。') }
    finally { submitLock.current = false; if (mounted.current) { setSubmitting(false); setConfirmMerge(false) } }
  }

  return <Dialog title={`${chapter.title} · 版本历史`} wide busy={blocked} error={error ?? readError} onClose={onClose} className={diffStyles.dialog}>
    <p className={styles.helpText}>恢复会生成新的工作稿版本，已有历史和作者定稿保留。</p>
    <div className={`${styles.previewLayout} ${diffStyles.layout}`}>
      <div className={styles.previewList}>{chapter.finalizedRevisionId && <button type="button" className={styles.button} disabled={blocked} onClick={() => void selectRevision(chapter.finalizedRevisionId!)}>与作者定稿比较</button>}<ol>{items.map((item) => <li key={item.id}><button type="button" className={preview?.id === item.id ? styles.selectedPreview : ''} onClick={() => void selectRevision(item.id)} disabled={blocked}>
        <strong>版本 {item.sequence} · {reasons[item.reason]}</strong><span>{displayTime(item.createdAt)} · {item.characterCount.toLocaleString()} 字</span>
        <small>{[item.id === chapter.revisionId ? '当前稿' : '', item.id === chapter.finalizedRevisionId ? '作者定稿' : ''].filter(Boolean).join(' · ')}</small>
      </button></li>)}</ol>
      {loading ? <p className={styles.helpText} role="status">读取历史中…</p> : cursor !== null ? <button className={styles.textButton} type="button" onClick={() => void loadPage(cursor)} disabled={blocked}>加载更早版本</button> : items.length > 0 ? <p className={styles.helpText}>已到最早版本</p> : <button className={styles.textButton} type="button" onClick={() => void loadPage()} disabled={blocked}>重新读取历史</button>}</div>
      <section className={`${styles.previewPane} ${diffStyles.comparison}`} aria-label="版本正文对照">{previewLoading ? <p role="status">正在读取正文…</p> : preview ? <>
        <h3>当前稿 ↔ {preview.id === chapter.finalizedRevisionId ? '作者定稿' : `版本 ${preview.sequence}`}</h3>
        <p className={diffStyles.hint}>选中后把对应段落恢复为右侧来源稿；移动项同时采用来源内容与相对顺序。未选段落保留当前内容。</p>
        {comparison.error ? <p role="alert">{comparison.error}</p> : <>
          <div className={diffStyles.actions}><span role="status">{comparison.changes.length} 处段落差异 · 已选 {selectedBlocks.length} 处</span>
            <button type="button" disabled={blocked || archived || !onMerge || !comparison.changes.length} onClick={() => { setSelectedBlocks(comparison.changes.map((change) => change.blockId)); setConfirmMerge(false); setConfirmRestore(false) }}>选择全部差异</button>
            <button type="button" disabled={blocked || !selectedBlocks.length} onClick={() => { setSelectedBlocks([]); setConfirmMerge(false) }}>清空选择</button></div>
          {!comparison.changes.length && <p>段落内容、格式与顺序相同。</p>}
          {visibleChanges.map((change) => <article key={change.blockId} className={diffStyles.change}>
            <label className={diffStyles.choice}><input type="checkbox" checked={selectedBlocks.includes(change.blockId)} disabled={blocked || archived || !onMerge} onChange={() => toggleBlock(change.blockId)} />
              {change.kind === 'added' ? '恢复来源独有段落' : change.kind === 'removed' ? '移除当前独有段落' : change.moved ? `恢复段落顺序${change.contentChanged ? '与内容／格式' : ''}` : '恢复段落内容／格式'}</label>
            <div className={diffStyles.columns}><BlockPreview block={change.current} label={change.currentIndex === null ? '当前稿 · 无此段' : `当前稿 · 第 ${change.currentIndex + 1} 块`} />
              <BlockPreview block={change.source} label={change.sourceIndex === null ? '来源稿 · 无此段' : `来源稿 · 第 ${change.sourceIndex + 1} 块`} /></div>
          </article>)}
          {pageCount > 1 && <nav className={diffStyles.actions} aria-label="段落差异分页"><button type="button" disabled={blocked || currentPage === 0} onClick={() => setDifferencePage(currentPage - 1)}>上一页差异</button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={blocked || currentPage + 1 === pageCount} onClick={() => setDifferencePage(currentPage + 1)}>下一页差异</button></nav>}
        </>}
        <details className={diffStyles.originals}><summary>查看两份完整原稿</summary><div className={diffStyles.columns}><div><h4>当前稿</h4><pre>{chapter.plainText || '（空白章节）'}</pre></div><div><h4>来源稿</h4><pre>{preview.plainText || '（空白章节）'}</pre></div></div></details>
        {merged.error && <p role="alert">{merged.error}</p>}
        {merged.document && <details className={diffStyles.originals} open={confirmMerge}><summary>预览采用后的正文</summary><pre>{documentToText(merged.document) || '（空白章节）'}</pre></details>}
      </> : <p>选择左侧历史或作者定稿，与当前稿比较。</p>}</section>
    </div>
    {confirmRestore && preview && <p className={styles.formError}>将把版本 {preview.sequence} 的正文恢复为新的当前稿。当前窗口的修改会先保存。</p>}
    {confirmMerge && <p className={diffStyles.confirm} role="status">将采用所选 {selectedBlocks.length} 处段落差异并新增工作稿版本；原稿、历史与作者定稿保留。请核对上方预览。</p>}
    <div className={styles.formActions}><button type="button" className={styles.button} onClick={onClose} disabled={blocked}>关闭</button>
      {(confirmRestore || confirmMerge) && <button type="button" className={styles.button} onClick={() => { setConfirmRestore(false); setConfirmMerge(false) }} disabled={blocked}>取消恢复</button>}
      <button type="button" className={styles.button} disabled={blocked || archived || !preview || preview.id === chapter.revisionId || previewLoading} onClick={() => { if (preview) { setConfirmMerge(false); if (confirmRestore) onRestore(preview.id); else setConfirmRestore(true) } }}>{confirmRestore ? '确认整版恢复' : '恢复整个所选版本'}</button>
      {onMerge && <button type="button" className={styles.primaryButton} disabled={blocked || archived || !merged.document || Boolean(comparison.error)} onClick={() => void mergeSelected()}>{submitting ? '正在采用…' : confirmMerge ? '确认局部恢复' : `采用所选差异（${selectedBlocks.length}）`}</button>}
    </div>
  </Dialog>
}

function BlockPreview({ block, label }: { block: ManuscriptBlock | null; label: string }) {
  return <div><h4>{label}</h4>{!block ? <p className={diffStyles.hint}>—</p> : <>
    <small>{block.type === 'heading' ? `${block.attrs.level} 级标题` : block.type === 'horizontalRule' ? '分场线' : '正文段落'}</small>
    {block.type === 'horizontalRule' ? <hr /> : <p className={diffStyles.paragraph}>{block.content?.length ? block.content.map((node, index) => {
      if (node.type === 'hardBreak') return <br key={index} />
      let text = <span>{node.text}</span>
      if (node.marks?.some((mark) => mark.type === 'bold')) text = <strong>{text}</strong>
      if (node.marks?.some((mark) => mark.type === 'italic')) text = <em>{text}</em>
      return <span key={index}>{text}</span>
    }) : paragraphText(block) || '（空段落）'}</p>}
  </>}</div>
}
