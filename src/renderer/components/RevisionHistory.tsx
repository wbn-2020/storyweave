import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ChapterSnapshot, RevisionSnapshot, RevisionSummary, StudioApi } from '../../contracts/api'
import { DomainError } from '../../contracts/api'
import { documentToText, parseManuscript, type ManuscriptBlock } from '../../contracts/manuscript'
import { applyParagraphChanges, compareParagraphs, paragraphText, type ParagraphChange } from '../../contracts/paragraph-diff'
import type { RevisionMergeInput } from '../../contracts/revision-merge'
import { displayTime, request } from '../request'
import type { RegisterPanelLeaveGuard } from '../hooks/usePanelLeave'
import { Dialog } from './Dialog'
import { StudioIcon } from './StudioIcon'
import styles from '../StellarShared.module.css'
import diffStyles from './StellarRevision.module.css'

export interface RevisionHistoryProps {
  api: StudioApi
  chapter: ChapterSnapshot
  archived: boolean
  busy: boolean
  error?: string | null
  registerLeaveGuard?: RegisterPanelLeaveGuard
  onClose: () => void
  onRestore: (revisionId: string) => void | Promise<void>
  onMerge?: (input: RevisionMergeInput) => void | Promise<void>
}
const reasons = { created: '建立章节', saved: '保存正文', restored: '恢复版本', imported: '导入正文' }
interface ManuscriptRow { block: ManuscriptBlock; index: number }

export function RevisionHistory({ api, chapter, archived, busy, error, onClose, onRestore, onMerge, registerLeaveGuard }: RevisionHistoryProps) {
  const [items, setItems] = useState<RevisionSummary[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const basisKey = `${chapter.bookId}:${chapter.id}:${chapter.revisionId}:${chapter.bookRevision}`
  const [selection, setSelection] = useState<{ basisKey: string; revision: RevisionSnapshot } | null>(null)
  const preview = selection?.basisKey === basisKey ? selection.revision : null
  const [selectedBlocks, setSelectedBlocks] = useState<string[]>([])
  const [differencePage, setDifferencePage] = useState(0)
  const [onlyChanged, setOnlyChanged] = useState(false)
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
  const parentBusy = useRef(busy)
  parentBusy.current = busy
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
  const changesById = useMemo(() => new Map(comparison.changes.map((change) => [change.blockId, change])), [comparison.changes])
  const comparisonRows = useMemo(() => {
    if (!preview || comparison.error) return []
    const current = chapter.document.content.map((block, index) => ({ block, index }))
    const source = preview.document.content.map((block, index) => ({ block, index }))
    const currentById = new Map(current.map((row) => [row.block.attrs.id, row]))
    const rows: { current: ManuscriptRow | null; source: ManuscriptRow | null }[] = []
    let currentIndex = 0, sourceIndex = 0
    // 原差异算法已标出移动；只用顺序未变的共同段落作锚点，不重排任一份原稿。
    for (const sourceRow of source) {
      const currentRow = currentById.get(sourceRow.block.attrs.id)
      if (!currentRow || changesById.get(sourceRow.block.attrs.id)?.moved) continue
      while (currentIndex < currentRow.index) rows.push({ current: current[currentIndex++], source: null })
      while (sourceIndex < sourceRow.index) rows.push({ current: null, source: source[sourceIndex++] })
      rows.push({ current: currentRow, source: sourceRow })
      currentIndex = currentRow.index + 1; sourceIndex = sourceRow.index + 1
    }
    while (currentIndex < current.length) rows.push({ current: current[currentIndex++], source: null })
    while (sourceIndex < source.length) rows.push({ current: null, source: source[sourceIndex++] })
    // 配对后再筛选与分页，插入或移除不会把后续共同段落挤到另一页。
    return onlyChanged ? rows.filter((row) => row.current && changesById.has(row.current.block.attrs.id)
      || row.source && changesById.has(row.source.block.attrs.id)) : rows
  }, [chapter.document, preview, comparison.error, onlyChanged, changesById])
  const pageSize = 40
  const pageCount = Math.max(1, Math.ceil(comparisonRows.length / pageSize))
  const currentPage = Math.min(differencePage, pageCount - 1)
  const rangeStart = currentPage * pageSize
  const pageRows = comparisonRows.slice(rangeStart, rangeStart + pageSize)

  useEffect(() => {
    mounted.current = true
    setItems([]); setCursor(null); setSelection(null); setPreviewLoading(false); setConfirmRestore(false); setConfirmMerge(false); setSelectedBlocks([]); setDifferencePage(0)
    void loadPage()
    return () => { mounted.current = false; pageRequest.current += 1; previewRequest.current += 1 }
  }, [basisKey])

  useEffect(() => {
    registerLeaveGuard?.(async () => {
      // 恢复自身也经过父层导航预检，实际写入由预检后的父层锁保护。
      if (parentBusy.current) { setReadError('正在恢复或核对回执，请先完成当前操作。'); return false }
      return true
    })
    return () => registerLeaveGuard?.(null)
  }, [registerLeaveGuard])

  useEffect(() => {
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat ||
          parentBusy.current || submitLock.current || document.querySelector('dialog[open]') || event.target instanceof HTMLSelectElement) return
      event.preventDefault()
      if (confirmRestore || confirmMerge) { setConfirmRestore(false); setConfirmMerge(false); return }
      onClose()
    }
    window.addEventListener('keydown', closeWithEscape)
    return () => window.removeEventListener('keydown', closeWithEscape)
  }, [onClose, confirmRestore, confirmMerge])

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

  async function restoreSelected() {
    if (blocked || submitLock.current || archived || !preview || preview.id === chapter.revisionId) return
    if (!confirmRestore) { setConfirmRestore(true); setConfirmMerge(false); return }
    submitLock.current = true; setSubmitting(true); setReadError(null)
    try { await onRestore(preview.id) }
    catch { if (mounted.current) setReadError('恢复结果尚未确认，请核对保存状态；原有历史仍保留。') }
    finally { submitLock.current = false; if (mounted.current) { setSubmitting(false); setConfirmRestore(false) } }
  }

  return <Dialog title={<><StudioIcon name="history" size={28} />版本历史</>} wide busy={blocked} error={error ?? readError} onClose={onClose} className={diffStyles.dialog}>
    <p className={diffStyles.context}>《{chapter.title}》 · 恢复会生成新的工作稿版本，已有历史和作者定稿保留。</p>
    <div className={`${styles.previewLayout} ${diffStyles.layout}`}>
      <div className={`${styles.previewList} ${diffStyles.timeline}`} role="region" aria-label="章节修订时间线" tabIndex={0}>{chapter.finalizedRevisionId && <button type="button" className={styles.button} disabled={blocked} onClick={() => void selectRevision(chapter.finalizedRevisionId!)}>与作者定稿比较</button>}<ol>{items.map((item) => <li key={item.id} data-current={item.id === chapter.revisionId} data-selected={preview?.id === item.id} data-reason={item.reason} data-finalized={item.id === chapter.finalizedRevisionId}><button type="button" className={preview?.id === item.id ? styles.selectedPreview : ''} aria-pressed={preview?.id === item.id} aria-current={item.id === chapter.revisionId ? 'true' : undefined} onClick={() => void selectRevision(item.id)} disabled={blocked}>
        <span className={diffStyles.revisionHeading}><strong>修订 {item.sequence}</strong><span className={diffStyles.revisionBadges}>
          {item.id === chapter.revisionId && <span data-state="current">当前</span>}
          {item.id === chapter.finalizedRevisionId && <span data-state="finalized">定稿</span>}
          <span data-reason={item.reason}>{reasons[item.reason]}</span>
        </span></span>
        <time dateTime={item.createdAt} title={item.createdAt}>{displayTime(item.createdAt)}</time><span className={diffStyles.revisionCount}>{item.characterCount.toLocaleString()} 字</span>
      </button></li>)}</ol>
      {loading ? <p className={styles.helpText} role="status">读取历史中…</p> : cursor !== null ? <button className={styles.textButton} type="button" onClick={() => void loadPage(cursor)} disabled={blocked}>加载更早版本</button> : items.length > 0 ? <p className={styles.helpText}>已到最早版本</p> : <button className={styles.textButton} type="button" onClick={() => void loadPage()} disabled={blocked}>重新读取历史</button>}</div>
      <section className={`${styles.previewPane} ${diffStyles.comparison}`} aria-label="版本正文对照" aria-busy={previewLoading} tabIndex={0}>{previewLoading ? <p role="status">正在读取正文…</p> : preview ? <>
        {comparison.error ? <p role="alert">{comparison.error}</p> : <>
          <div className={diffStyles.actions}><span role="status">{comparison.changes.length} 处段落差异 · 已选 {selectedBlocks.length} 处</span>
            <button type="button" disabled={blocked || archived || !onMerge || !comparison.changes.length} onClick={() => { setSelectedBlocks(comparison.changes.map((change) => change.blockId)); setConfirmMerge(false); setConfirmRestore(false) }}>选择全部差异</button>
            <button type="button" disabled={blocked || !selectedBlocks.length} onClick={() => { setSelectedBlocks([]); setConfirmMerge(false) }}>清空选择</button>
            <label className={diffStyles.filter}><input type="checkbox" checked={onlyChanged} disabled={blocked} onChange={(event) => { setOnlyChanged(event.target.checked); setDifferencePage(0) }} />仅看差异</label></div>
          {!comparison.changes.length && <p>段落内容、格式与顺序相同。</p>}
          <div className={diffStyles.manuscripts} style={{ '--comparison-rows': Math.max(2, pageRows.length + 1) } as CSSProperties}>
            <ManuscriptColumn title="当前稿" rows={pageRows.map((row) => row.current)} changes={changesById} selected={selectedBlocks} side="current" disabled={blocked || archived || !onMerge} onSelect={toggleBlock} />
            <ManuscriptColumn title={preview.id === chapter.finalizedRevisionId ? '选中历史稿 · 作者定稿' : `选中历史稿 · 版本 ${preview.sequence}`} rows={pageRows.map((row) => row.source)} changes={changesById} selected={selectedBlocks} side="source" disabled={blocked || archived || !onMerge} onSelect={toggleBlock} />
          </div>
          {pageCount > 1 && <nav className={diffStyles.actions} aria-label="版本正文分页"><button type="button" disabled={blocked || currentPage === 0} onClick={() => setDifferencePage(currentPage - 1)}>上一页正文</button><span>{currentPage + 1} / {pageCount} · 每栏最多 40 块</span><button type="button" disabled={blocked || currentPage + 1 === pageCount} onClick={() => setDifferencePage(currentPage + 1)}>下一页正文</button></nav>}
          <p className={diffStyles.hint}>当前稿向所选来源稿恢复；勾选对应段落后预览。未选段落保留当前内容，移动项同时采用来源内容与相对顺序。</p>
        </>}
        <details className={diffStyles.originals}><summary>查看两份完整原稿</summary><div className={diffStyles.columns}><div><h4>当前稿</h4><pre>{chapter.plainText || '（空白章节）'}</pre></div><div><h4>来源稿</h4><pre>{preview.plainText || '（空白章节）'}</pre></div></div></details>
        {merged.error && <p role="alert">{merged.error}</p>}
        {merged.document && <details className={diffStyles.originals} open={confirmMerge}><summary>预览采用后的正文</summary><pre>{documentToText(merged.document) || '（空白章节）'}</pre></details>}
      </> : <p>选择左侧历史或作者定稿，与当前稿比较。</p>}</section>
      <aside className={diffStyles.summary} aria-label="差异摘要" tabIndex={0}><h3><StudioIcon name="chart" size={24} />差异摘要</h3>
        {preview && !comparison.error ? <><dl>
          <dt data-kind="added">新增</dt><dd>{comparison.changes.filter((item) => item.kind === 'added').length} 段</dd>
          <dt data-kind="removed">删除</dt><dd>{comparison.changes.filter((item) => item.kind === 'removed').length} 段</dd>
          <dt data-kind="changed">修改</dt><dd>{comparison.changes.filter((item) => item.current && item.source && item.contentChanged).length} 段</dd>
          <dt data-kind="moved">移动</dt><dd>{comparison.changes.filter((item) => item.moved).length} 段</dd>
        </dl><p className={diffStyles.hint}>按当前稿恢复到所选来源稿计算；修改含内容与格式，同一段落可能同时修改与移动。</p><strong>已选 {selectedBlocks.length} 处</strong></> : <p className={diffStyles.hint}>选择一个历史版本查看差异。</p>}
        <div className={diffStyles.restoreActions}>
          {onMerge && <button type="button" className={styles.primaryButton} title={archived ? '归档作品只读' : !selectedBlocks.length ? '先勾选需要恢复的差异' : '核对预览后新增工作稿修订'} disabled={blocked || archived || !merged.document || Boolean(comparison.error)} onClick={() => void mergeSelected()}><StudioIcon name="layers" size={18} />{submitting ? '正在恢复…' : confirmMerge ? '确认局部恢复' : `局部恢复（${selectedBlocks.length}）`}</button>}
          <button type="button" className={diffStyles.restoreVersion} title={archived ? '归档作品只读' : !preview ? '先选择历史版本' : preview.id === chapter.revisionId ? '所选版本已经是当前稿' : '核对所选历史稿后新增修订'} disabled={blocked || archived || !preview || preview.id === chapter.revisionId || previewLoading} onClick={() => void restoreSelected()}><StudioIcon name="history" size={18} />{confirmRestore ? '确认整版恢复' : '恢复为新修订'}</button>
        </div>
        {confirmRestore && preview && <p className={diffStyles.confirm} role="status">将把版本 {preview.sequence} 的正文恢复为新的当前稿。当前窗口的修改会先保存。</p>}
        {confirmMerge && <p className={diffStyles.confirm} role="status">将采用所选 {selectedBlocks.length} 处段落差异并新增工作稿版本；原稿、历史与作者定稿保留。请核对中间预览。</p>}
        <p className={diffStyles.preserve}><StudioIcon name="info" size={20} />局部恢复和整版恢复都会新增修订，原有历史完整保留。</p>
      </aside>
    </div>
    <div className={styles.formActions}><button type="button" className={styles.button} onClick={onClose} disabled={blocked}>关闭</button>
      {(confirmRestore || confirmMerge) && <button type="button" className={styles.button} onClick={() => { setConfirmRestore(false); setConfirmMerge(false) }} disabled={blocked}>取消恢复</button>}
    </div>
  </Dialog>
}

function ManuscriptColumn({ title, rows, changes, selected, side, disabled, onSelect }: {
  title: string; rows: (ManuscriptRow | null)[]; changes: ReadonlyMap<string, ParagraphChange>
  selected: string[]; side: 'current' | 'source'; disabled: boolean; onSelect: (id: string) => void
}) {
  const hasContent = rows.some((row) => row !== null)
  return <section className={diffStyles.manuscriptColumn} aria-label={title}><h3><span data-side={side} />{title}</h3>{rows.length ? <ol>{rows.map((row, rowIndex) => {
    if (!row) return <li key={`missing:${rowIndex}`} className={diffStyles.missingBlock} aria-hidden={hasContent || rowIndex > 0}>{!hasContent && rowIndex === 0 && <p className={diffStyles.hint}>本页无对应正文块。</p>}</li>
    const { block, index } = row
    const change = changes.get(block.attrs.id)
    return <li key={block.attrs.id} data-kind={change?.kind} data-selected={selected.includes(block.attrs.id)} data-side={side}>
      <span className={diffStyles.lineNumber}>{index + 1}{change && <label title={change.kind === 'added' ? '恢复来源独有段落' : change.kind === 'removed' ? '移除当前独有段落' : change.moved ? '恢复来源顺序及内容' : '恢复来源内容与格式'}>
        <input type="checkbox" aria-label={`选取${side === 'current' ? '当前稿' : '历史稿'}第 ${index + 1} 块差异`} checked={selected.includes(block.attrs.id)} disabled={disabled} onChange={() => onSelect(block.attrs.id)} />
      </label>}</span><BlockPreview block={block} />
    </li>
  })}</ol> : <p className={diffStyles.hint}>本页无对应正文块。</p>}</section>
}

function BlockPreview({ block }: { block: ManuscriptBlock }) {
  return <div className={diffStyles.block}>
    {block.type !== 'paragraph' && <small>{block.type === 'heading' ? `${block.attrs.level} 级标题` : '分场线'}</small>}
    {block.type === 'horizontalRule' ? <hr /> : <p className={diffStyles.paragraph}>{block.content?.length ? block.content.map((node, index) => {
      if (node.type === 'hardBreak') return <br key={index} />
      let text = <span>{node.text}</span>
      if (node.marks?.some((mark) => mark.type === 'bold')) text = <strong>{text}</strong>
      if (node.marks?.some((mark) => mark.type === 'italic')) text = <em>{text}</em>
      return <span key={index}>{text}</span>
    }) : paragraphText(block) || '（空段落）'}</p>}
  </div>
}
