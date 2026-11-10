import { createElement, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { isRecord, type BookSnapshot, type RequestStatus, type Result } from '../../contracts/api'
import {
  MAX_EXPORT_NOTE_LENGTH, bookExportExtension, bookExportReference, type BookExportChapterEntry, type BookExportChapterInput,
  type BookExportChapterPreview, type BookExportCommitInput, type BookExportOptions,
  type BookExportPrepareInput, type BookExportPreview,
} from '../../contracts/export'
import type { InlineNode } from '../../contracts/manuscript'
import { request, statusLabels } from '../request'
import { Dialog } from './Dialog'
import appStyles from '../App.module.css'
import styles from './ExportBookPanel.module.css'

export interface BookExportPanelApi {
  prepareBookExport(input: BookExportPrepareInput): Promise<Result<BookExportPreview>>
  readBookExportChapter(input: BookExportChapterInput): Promise<Result<BookExportChapterPreview>>
  getRequestStatus(input: { requestId: string }): Promise<Result<RequestStatus>>
}

type PendingRead = { requestId: string; bookKey: string } & (
  { kind: 'prepare'; input: BookExportPrepareInput } | { kind: 'chapter'; preview: BookExportPreview; chapterId: string }
)

export interface ExportBookPanelProps {
  api: BookExportPanelApi
  book: BookSnapshot
  busy: boolean
  error?: string | null
  onClose: () => void
  onExport: (input: BookExportCommitInput) => Promise<void> | void
}

const PAGE_SIZE = 50
const stateLabels = { included: '包含', not_selected: '未勾选', not_finalized: '缺少定稿', unavailable: '正文不可用' }
const defaultDocxOptions = { submissionLayout: false, preface: '', afterword: '' }

function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function inlinePreview(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === 'hardBreak') return <br key={index} />
    let value: ReactNode = node.text
    if (node.marks?.some((mark) => mark.type === 'italic')) value = <em>{value}</em>
    if (node.marks?.some((mark) => mark.type === 'bold')) value = <strong>{value}</strong>
    return <span key={index}>{value}</span>
  })
}

function ChapterContent({ chapter, submissionLayout }: { chapter: BookExportChapterPreview; submissionLayout: boolean }) {
  if (chapter.format !== 'epub' && chapter.format !== 'docx') return <pre className={styles.textPreview}>{chapter.text || '（空白章节）'}</pre>
  return <article className={`${styles.epubPreview} ${chapter.format === 'docx' && submissionLayout ? styles.submissionPreview : ''}`} lang={chapter.language}>
    {chapter.includeChapterTitles && <h1>{chapter.title}</h1>}
    {chapter.document.content.map((block) => block.type === 'horizontalRule'
      ? chapter.format === 'docx' ? <p key={block.attrs.id} className={styles.sceneBreak}>* * *</p> : <hr key={block.attrs.id} />
      : createElement(block.type === 'heading' ? `h${block.attrs.level + (chapter.includeChapterTitles ? 1 : 0)}` : 'p',
        { key: block.attrs.id }, block.content?.length ? inlinePreview(block.content) : <br />))}
  </article>
}

export function ExportBookPanel({ api, book, busy, error, onClose, onExport }: ExportBookPanelProps) {
  const [options, setOptions] = useState<Omit<BookExportOptions, 'chapterIds'>>({ format: 'txt', scope: 'working', includeChapterTitles: true, author: '', language: 'zh-CN' })
  const [selectedIds, setSelectedIds] = useState<string[]>(() => book.chapters.map((chapter) => chapter.id))
  const [preview, setPreview] = useState<BookExportPreview | null>(null)
  const [chapterPreview, setChapterPreview] = useState<BookExportChapterPreview | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [preparing, setPreparing] = useState(false)
  const [reading, setReading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [showManifest, setShowManifest] = useState(false)
  const [pendingRead, setPendingRead] = useState<PendingRead | null>(null)
  const [checking, setChecking] = useState(false)
  const headingId = useId()
  const mounted = useRef(true)
  const prepareTicket = useRef(0)
  const chapterTicket = useRef(0)
  const exportInFlight = useRef(false)
  const activeToken = useRef<string | null>(null)
  const currentBook = `${book.book.id}:${book.book.revision}`
  const currentBookRef = useRef(currentBook)
  currentBookRef.current = currentBook
  const lastBookId = useRef(book.book.id)
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const entries = useMemo(() => new Map<string, BookExportChapterEntry>(preview?.manifest.chapters.map((entry) => [entry.chapterId, entry]) ?? []), [preview])
  const query = search.trim().toLocaleLowerCase()
  const filtered = useMemo(() => book.chapters.filter((chapter) => !query || chapter.title.toLocaleLowerCase().includes(query)), [book.chapters, query])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const shownPage = Math.min(page, pages - 1)
  const shownChapters = filtered.slice(shownPage * PAGE_SIZE, (shownPage + 1) * PAGE_SIZE)
  const blocked = busy || preparing || exporting || Boolean(pendingRead)
  const currentPreview = preview?.manifest.bookId === book.book.id && preview.manifest.bookRevision === book.book.revision ? preview : null
  const docxOptions = options.docx ?? defaultDocxOptions

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; prepareTicket.current += 1; chapterTicket.current += 1 }
  }, [])

  useEffect(() => {
    invalidate()
    setPage(0)
    if (lastBookId.current !== book.book.id) {
      setSelectedIds(book.chapters.map((chapter) => chapter.id))
      setOptions({ format: 'txt', scope: 'working', includeChapterTitles: true, author: '', language: 'zh-CN' })
      setSearch('')
    } else {
      const ids = new Set(book.chapters.map((chapter) => chapter.id))
      setSelectedIds((current) => current.filter((id) => ids.has(id)))
    }
    lastBookId.current = book.book.id
  }, [book.book.id, book.book.revision])

  function invalidate() {
    prepareTicket.current += 1; chapterTicket.current += 1; activeToken.current = null
    setPreview(null); setChapterPreview(null); setAcknowledged(false); setShowManifest(false)
    setReadError(null); setPreparing(false); setReading(false); setPendingRead(null); setChecking(false)
  }

  function updateOptions(fields: Partial<Omit<BookExportOptions, 'chapterIds'>>) {
    invalidate()
    setOptions((current) => ({ ...current, ...fields }))
  }

  function selectChapter(chapterId: string, checked: boolean) {
    invalidate()
    setSelectedIds((current) => checked ? [...current.filter((id) => id !== chapterId), chapterId] : current.filter((id) => id !== chapterId))
  }

  async function prepare() {
    if (blocked || !selectedIds.length) return
    invalidate()
    const ticket = ++prepareTicket.current
    const bookKey = currentBook
    const { docx, ...baseOptions } = options
    const input = { bookId: book.book.id, expectedBookRevision: book.book.revision, ...baseOptions,
      ...(options.format === 'epub' || options.format === 'docx' ? {} : { author: '', language: 'zh-CN' }),
      ...(options.format === 'docx' ? { docx: docx ?? defaultDocxOptions } : {}), chapterIds: selectedIds }
    setPreparing(true)
    const result = await request(() => api.prepareBookExport(input))
    if (!mounted.current || ticket !== prepareTicket.current || currentBookRef.current !== bookKey) return
    setPreparing(false)
    if (!result.ok) {
      if (result.error.requestId) setPendingRead({ requestId: result.error.requestId, bookKey, kind: 'prepare', input })
      setReadError(result.error.message); return
    }
    acceptPreview(result.data)
  }

  function acceptPreview(value: BookExportPreview) {
    setReadError(null)
    setPreview(value)
    activeToken.current = value.token
    const first = value.manifest.chapters.find((entry) => entry.state === 'included')
    if (first) void readChapter(value, first.chapterId)
  }

  async function readChapter(source: BookExportPreview, chapterId: string) {
    const ticket = ++chapterTicket.current
    const bookKey = currentBook
    setReading(true); setChapterPreview(null); setReadError(null)
    const result = await request(() => api.readBookExportChapter({ ...bookExportReference(source), chapterId }))
    if (!mounted.current || ticket !== chapterTicket.current || activeToken.current !== source.token || currentBookRef.current !== bookKey) return
    setReading(false)
    if (!result.ok) {
      if (result.error.requestId) setPendingRead({ requestId: result.error.requestId, bookKey, kind: 'chapter', preview: source, chapterId })
      else invalidate()
      setReadError(result.error.message); return
    }
    setChapterPreview(result.data)
  }

  async function checkPending() {
    if (!pendingRead || checking) return
    const waiting = pendingRead
    setChecking(true)
    const result = await request(() => api.getRequestStatus({ requestId: waiting.requestId }))
    if (!mounted.current || currentBookRef.current !== waiting.bookKey) return
    setChecking(false)
    if (!result.ok) { setReadError(result.error.message); return }
    if (result.data.state === 'pending') { setReadError('原请求仍在处理，请稍后再次核对。'); return }
    if (result.data.state === 'unknown') { invalidate(); setReadError('原预览请求已不可查询，请重新生成清单；本次读取没有创建成品。'); return }
    const response = result.data.response
    const expectedCommand = waiting.kind === 'prepare' ? 'book.export.prepare' : 'book.export.chapter'
    if (String(response.command) !== expectedCommand) { setReadError('请求回执类型不符，请关闭面板后重新读取。'); return }
    if (!response.result.ok) { invalidate(); setReadError(response.result.error.message); return }
    const value: unknown = response.result.data
    // 补领只接收原请求身份与固定版本，不能把另一章的迟到结果放进当前预览。
    if (waiting.kind === 'prepare') {
      const selectedChapters = new Set(waiting.input.chapterIds)
      let language: string
      try { language = new Intl.Locale(waiting.input.language.trim()).baseName } catch {
        setReadError('预览语言与原请求不符，请关闭面板后重新读取。'); return
      }
      if (!isRecord(value) || !isRecord(value.manifest) || !Array.isArray(value.manifest.chapters) ||
          value.manifest.bookId !== waiting.input.bookId || value.manifest.bookRevision !== waiting.input.expectedBookRevision ||
          value.manifest.outputFormat !== waiting.input.format || value.manifest.scope !== waiting.input.scope ||
          value.manifest.includeChapterTitles !== waiting.input.includeChapterTitles ||
          value.manifest.author !== waiting.input.author.trim() || value.manifest.language !== language ||
          (waiting.input.format === 'docx' && (!isRecord(value.manifest.docx) ||
            value.manifest.docx.submissionLayout !== waiting.input.docx?.submissionLayout ||
            value.manifest.docx.preface !== waiting.input.docx?.preface || value.manifest.docx.afterword !== waiting.input.docx?.afterword)) ||
          value.manifest.chapters.some((entry: unknown) => !isRecord(entry) || typeof entry.chapterId !== 'string' ||
            entry.selected !== selectedChapters.has(entry.chapterId)) ||
          value.manifest.chapters.filter((entry: unknown) => isRecord(entry) && entry.selected === true).length !== selectedChapters.size ||
          typeof value.token !== 'string' || typeof value.manifestHash !== 'string') {
        setReadError('预览回执与当前作品不符，请关闭面板后重新读取。'); return
      }
      setPendingRead(null)
      acceptPreview(value as unknown as BookExportPreview)
    } else {
      const entry = waiting.preview.manifest.chapters.find((chapter) => chapter.chapterId === waiting.chapterId)
      if (!isRecord(value) || value.bookId !== waiting.preview.manifest.bookId || value.chapterId !== waiting.chapterId ||
          value.revisionId !== entry?.revisionId || value.format !== waiting.preview.manifest.outputFormat ||
          value.language !== waiting.preview.manifest.language || value.includeChapterTitles !== waiting.preview.manifest.includeChapterTitles || !isRecord(value.document)) {
        setReadError('正文回执与固定版本不符，请关闭面板后重新读取。'); return
      }
      setPendingRead(null); setReadError(null)
      setChapterPreview(value as unknown as BookExportChapterPreview)
    }
  }

  async function submit() {
    if (blocked || exportInFlight.current || !currentPreview?.canExport || (currentPreview.requiresAcknowledgement && !acknowledged)) return
    exportInFlight.current = true
    setExporting(true); setReadError(null)
    try {
      await onExport({ ...bookExportReference(currentPreview), format: currentPreview.manifest.outputFormat, acknowledgeOmissions: acknowledged })
    } catch {
      if (mounted.current) setReadError('导出结果尚未确认，请核对所选保存位置和任务回执后再操作。')
    } finally {
      exportInFlight.current = false
      if (mounted.current) setExporting(false)
    }
  }

  function status(entry: BookExportChapterEntry | undefined, chapterId: string): ReactNode {
    if (!entry) return selected.has(chapterId) ? '待核对' : '未勾选'
    return <><span className={entry.state === 'unavailable' ? styles.problem : ''}>{stateLabels[entry.state]}</span>
      {entry.reason && <small>{entry.reason}</small>}
      {entry.state === 'included' && entry.characterCount === 0 && <small className={styles.problem}>空白正文，仍会导出</small>}</>
  }

  return <Dialog title="交付与导出" wide className={`${appStyles.lightDialog} ${styles.dialog}`} busy={busy || exporting} error={error ?? readError} onClose={onClose}>
    <p className={styles.introduction}>《{book.book.title}》按作品目录顺序交付。先核对章节和正文，再选择保存位置。</p>
    {pendingRead && <p className={styles.pending} role="status">预览请求尚未确认，暂时保留当前选择。
      <button type="button" className={appStyles.button} disabled={checking || busy} onClick={() => void checkPending()}>{checking ? '查询中…' : '查询原请求结果'}</button>
    </p>}
    <div className={styles.options}>
      <label>正文范围<select value={options.scope} disabled={blocked} onChange={(event) => updateOptions({ scope: event.target.value as BookExportOptions['scope'] })}>
        <option value="working">当前工作稿</option><option value="finalized">作者定稿</option>
      </select></label>
      <label>成品格式<select value={options.format} disabled={blocked} onChange={(event) => updateOptions({ format: event.target.value as BookExportOptions['format'] })}>
        <option value="txt">TXT · 纯文本</option><option value="markdown">Markdown · 保留文字格式</option><option value="epub">EPUB · 读者样书</option><option value="docx">DOCX · Word 文稿</option>
      </select></label>
      {(options.format === 'epub' || options.format === 'docx') && <>
        <label>署名（选填）<input value={options.author} maxLength={120} disabled={blocked} onChange={(event) => updateOptions({ author: event.target.value })} autoComplete="off" /></label>
        <label>正文语言<input value={options.language} maxLength={64} disabled={blocked} onChange={(event) => updateOptions({ language: event.target.value })} aria-describedby={`${headingId}-language`} autoComplete="off" />
          <small id={`${headingId}-language`}>例如 zh-CN（简体中文）、en（英语）</small></label>
      </>}
    </div>
    {options.format === 'docx' && <fieldset className={styles.docxOptions} disabled={blocked}>
      <legend>DOCX 排版与附文</legend>
      <label className={`${appStyles.checkLabel} ${styles.check}`}><input type="checkbox" checked={docxOptions.submissionLayout} onChange={(event) => updateOptions({ docx: { ...docxOptions, submissionLayout: event.target.checked } })} />使用投稿排版</label>
      <p className={styles.help}>含书名与署名页，采用 A4、2.54 厘米页边距、12 磅正文宋体／Times New Roman；投稿排版使用双倍行距、正文首行缩进两字和页码。各章另起一页。</p>
      <div className={styles.options}>
        <label>前言（选填）<textarea value={docxOptions.preface} maxLength={MAX_EXPORT_NOTE_LENGTH} rows={4} onChange={(event) => updateOptions({ docx: { ...docxOptions, preface: event.target.value } })} aria-describedby={`${headingId}-notes`} /></label>
        <label>后记（选填）<textarea value={docxOptions.afterword} maxLength={MAX_EXPORT_NOTE_LENGTH} rows={4} onChange={(event) => updateOptions({ docx: { ...docxOptions, afterword: event.target.value } })} aria-describedby={`${headingId}-notes`} /></label>
      </div>
      <p id={`${headingId}-notes`} className={styles.help}>各限 {MAX_EXPORT_NOTE_LENGTH.toLocaleString()} 个字符，仅进入本次 DOCX 与版本清单，不计入章节字数。修改后须重新生成预览。</p>
    </fieldset>}
    <label className={`${appStyles.checkLabel} ${styles.check}`}><input type="checkbox" checked={options.includeChapterTitles} disabled={blocked} onChange={(event) => updateOptions({ includeChapterTitles: event.target.checked })} />正文包含章节标题</label>
    <p className={styles.help}>{options.scope === 'finalized' ? '尚未定稿的章节会列出跳过原因；定稿后对工作稿的修改不进入本次成品。' : '预览使用已经保存的当前稿，生成预览后修改作品需要重新核对。'}{options.format === 'epub' && ' EPUB 目录保留章节名，实际分页与字体由阅读器决定。'}{options.format === 'docx' && ' DOCX 预览展示固定正文与格式，实际分页和字体以打开文档的软件为准。'}</p>

    <div className={styles.selectionBar}>
      <p id={headingId}>已选 {selectedIds.length.toLocaleString()} / {book.chapters.length.toLocaleString()} 章</p>
      <div className={styles.selectionActions}>
        <button type="button" className={appStyles.button} disabled={blocked} onClick={() => { invalidate(); setSelectedIds(book.chapters.map((chapter) => chapter.id)) }}>全选</button>
        <button type="button" className={appStyles.button} disabled={blocked || !selectedIds.length} onClick={() => { invalidate(); setSelectedIds([]) }}>清空选择</button>
        <button type="button" className={appStyles.primaryButton} disabled={blocked || !selectedIds.length} onClick={() => void prepare()}>{preparing ? '正在核对…' : currentPreview ? '重新核对清单' : '生成导出预览'}</button>
      </div>
    </div>
    <label className={styles.search}>筛选章节<input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} placeholder="输入章节名称" maxLength={120} /></label>

    <div className={styles.previewLayout}>
      <section className={styles.chapterList} aria-labelledby={headingId}>
        <div className={styles.tableScroll} role="region" aria-label="逐章导出清单" tabIndex={0}>
          <table className={styles.table}>
            <thead><tr><th scope="col">选择</th><th scope="col">章节与版本</th><th scope="col">字数</th><th scope="col">交付状态</th></tr></thead>
            <tbody>{shownChapters.map((chapter) => {
              const entry = currentPreview ? entries.get(chapter.id) : undefined
              return <tr key={chapter.id} data-active={chapterPreview?.chapterId === chapter.id || undefined}>
                <td><input type="checkbox" aria-label={`导出 ${chapter.title}`} checked={selected.has(chapter.id)} disabled={blocked} onChange={(event) => selectChapter(chapter.id, event.target.checked)} /></td>
                <th scope="row"><span className={styles.chapterTitle}>{chapter.title}</span><small>{entry?.volumeTitle ? `${entry.volumeTitle} · ` : ''}{statusLabels[chapter.status]}</small>
                  {entry?.revisionSequence !== null && entry?.revisionSequence !== undefined && <small>版本 {entry.revisionSequence} · {options.scope === 'working' ? '工作稿' : '作者定稿'}</small>}
                  {entry?.state === 'included' && currentPreview && <button type="button" className={styles.previewButton} disabled={blocked} aria-pressed={chapterPreview?.chapterId === chapter.id} onClick={() => void readChapter(currentPreview, chapter.id)}>预览正文</button>}
                </th>
                <td>{entry?.characterCount?.toLocaleString() ?? '—'}</td>
                <td>{status(entry, chapter.id)}</td>
              </tr>
            })}</tbody>
          </table>
          {!shownChapters.length && <p className={styles.empty}>{query ? '没有匹配的章节。' : '作品尚未建立章节。'}</p>}
        </div>
        {pages > 1 && <nav className={styles.pagination} aria-label="章节清单分页">
          <button type="button" className={appStyles.button} disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>上一页</button>
          <span>{shownPage + 1} / {pages}</span>
          <button type="button" className={appStyles.button} disabled={shownPage + 1 === pages} onClick={() => setPage(shownPage + 1)}>下一页</button>
        </nav>}
      </section>
      <section className={styles.manuscript} aria-label="固定版本正文预览" aria-busy={reading}>
        <h3>{chapterPreview ? chapterPreview.title : '正文预览'}</h3>
        {reading ? <p className={styles.empty} role="status">正在读取固定版本…</p> : chapterPreview ? <ChapterContent chapter={chapterPreview} submissionLayout={currentPreview?.manifest.docx?.submissionLayout ?? false} /> : <p className={styles.empty}>生成清单后，选择一章查看本次交付正文。</p>}
      </section>
    </div>

    {currentPreview && <section className={styles.summary} aria-label="本次交付核对结果" aria-live="polite">
      <p><strong>{currentPreview.chapterCount.toLocaleString()} 章 · {currentPreview.characterCount.toLocaleString()} 字</strong><span>预计 {fileSize(currentPreview.estimatedBytes)} · 作品版本 {currentPreview.manifest.bookRevision}</span></p>
      {currentPreview.manifest.outputFormat === 'docx' && <>
        <p>DOCX · {currentPreview.manifest.docx?.submissionLayout ? '投稿排版' : '常规排版'} · 附文不计入章节字数</p>
        {currentPreview.manifest.docx?.preface && <details><summary>本次前言</summary><pre className={styles.notePreview}>{currentPreview.manifest.docx.preface}</pre></details>}
        {currentPreview.manifest.docx?.afterword && <details><summary>本次后记</summary><pre className={styles.notePreview}>{currentPreview.manifest.docx.afterword}</pre></details>}
      </>}
      {currentPreview.blockingReasons.length > 0 && <ul className={styles.problem}>{currentPreview.blockingReasons.map((message) => <li key={message}>{message}</li>)}</ul>}
      {currentPreview.warnings.length > 0 && <ul>{currentPreview.warnings.map((message) => <li key={message}>{message}</li>)}</ul>}
      {currentPreview.requiresAcknowledgement && <label className={`${appStyles.checkLabel} ${styles.check}`}><input type="checkbox" checked={acknowledged} disabled={blocked} onChange={(event) => setAcknowledged(event.target.checked)} />我已核对不导出与空白章节，按这份清单交付。</label>}
      <details onToggle={(event) => setShowManifest(event.currentTarget.open)}><summary>查看本次版本清单</summary>
        {showManifest && <><p className={styles.help}>清单保留作品与章节身份、固定修订、字数和跳过原因。预览 30 分钟内有效。</p><pre className={styles.manifest}>{JSON.stringify(currentPreview.manifest, null, 2)}</pre></>}
      </details>
    </section>}
    <p className={styles.help}>保存时新建 .{bookExportExtension(options.format)} 成品和同名 .manifest.json 版本清单。正文成品只包含选定内容；完整恢复请使用作品恢复包。单次成品上限 2 GiB。</p>
    <div className={styles.actions}>
      <button type="button" className={appStyles.button} disabled={busy || exporting} onClick={onClose}>关闭</button>
      <button type="button" className={appStyles.primaryButton} disabled={blocked || reading || !currentPreview?.canExport || (currentPreview.requiresAcknowledgement && !acknowledged)} onClick={() => void submit()}>{exporting ? '正在导出…' : '选择位置并导出'}</button>
    </div>
  </Dialog>
}
