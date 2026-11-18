import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppError, BookSnapshot, ChapterSummary, RevisionSnapshot, StudioApi } from '../../contracts/api'
import type { InlineNode } from '../../contracts/manuscript'
import { DISPLAY_FONT_SIZES, DISPLAY_LINE_HEIGHTS, PAPER_TONE_LABELS, displayPreferenceStyle, type DisplayPreferences } from '../display-preferences'
import { displayTime, request } from '../request'
import { StudioIcon } from './StudioIcon'
import { ReaderAnnotations, useReaderAnnotations, type AnnotationAction } from './ReaderAnnotations'
import { paginateReaderDocument, type ReaderBlock, type ReaderPage } from './reader-pages'
import shared from '../StellarShared.module.css'
import paperStyles from './PaperSurface.module.css'
import styles from './StellarReader.module.css'

export interface BookReaderPanelProps {
  api: StudioApi
  book: BookSnapshot
  initialChapterId?: string
  busy: boolean
  error?: string | null
  displayPreferences: DisplayPreferences
  preferencesWarning: string | null
  onPreferencesChange: (change: Partial<DisplayPreferences>) => void
  onRetryPreferencesSave: () => void
  onClose: () => void
  onReviewIssue?: (issueId: string, action: AnnotationAction) => void
}

type Scope = 'working' | 'finalized'
interface ReaderChapter extends Pick<ChapterSummary, 'id' | 'title' | 'revisionId' | 'finalizedRevisionId'> {
  ordinal: number
  volumeTitle: string
}
interface Catalog { title: string; revision: number; chapters: ReaderChapter[] }
interface LoadedChapter {
  pages: ReaderPage[]
  selectedRevision: Pick<RevisionSnapshot, 'id' | 'sequence' | 'createdAt' | 'characterCount'>
}
interface PendingRead { requestId: string; command: 'book.get' | 'revision.read' }
const DIRECTORY_PAGE_SIZE = 50
const scopeLabels = { working: '工作稿', finalized: '作者定稿' }

function revisionFor(chapter: ReaderChapter, scope: Scope): string | null {
  return scope === 'finalized' ? chapter.finalizedRevisionId : chapter.revisionId
}

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'hardBreak') return <br key={index} />
    let text: ReactNode = node.text
    if (node.marks?.some((mark) => mark.type === 'bold')) text = <strong>{text}</strong>
    if (node.marks?.some((mark) => mark.type === 'italic')) text = <em>{text}</em>
    return <Fragment key={index}>{text}</Fragment>
  })
}

function PageBlock({ block }: { block: ReaderBlock }) {
  const Heading = block.level === 1 ? 'h4' : block.level === 2 ? 'h5' : 'h6'
  const children = block.content.length ? renderInline(block.content) : <br />
  return <div className={styles.fragment} data-block-id={block.id} data-block-part={block.part}>
    {block.continued && <div className={styles.continuation}>接上页</div>}
    {block.type === 'horizontalRule' ? <hr /> : block.type === 'heading' ? <Heading>{children}</Heading> : <p>{children}</p>}
    {block.continues && <div className={styles.continuation}>下页继续</div>}
  </div>
}

export function BookReaderPanel(props: BookReaderPanelProps) {
  // 作品身份改变即卸载整段阅读会话，旧回包不能进入另一部作品。
  return <ReaderContent key={props.book.book.id} {...props} />
}

function ReaderContent({ api, book, initialChapterId, busy, error, displayPreferences, preferencesWarning, onPreferencesChange, onRetryPreferencesSave, onClose, onReviewIssue }: BookReaderPanelProps) {
  const bookId = book.book.id
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [scope, setScope] = useState<Scope>('working')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedChapter | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [loading, setLoading] = useState<'catalog' | 'chapter' | null>('catalog')
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [chapterError, setChapterError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingRead | null>(null)
  const [pendingMessage, setPendingMessage] = useState('')
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [directoryPage, setDirectoryPage] = useState(0)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [annotationsEnabled, setAnnotationsEnabled] = useState(true)
  const [directoryJump, setDirectoryJump] = useState(0)
  const [paperJump, setPaperJump] = useState(0)
  const current = useRef({ api, busy })
  current.current = { api, busy }
  const selection = useRef<{ id: string | null; scope: Scope }>({ id: initialChapterId ?? null, scope: 'working' })
  const mounted = useRef(false)
  const readLock = useRef(false)
  const statusLock = useRef(false)
  const readTicket = useRef(0)
  const statusTicket = useRef(0)
  const pendingRead = useRef<PendingRead | null>(null)
  const paper = useRef<HTMLDivElement>(null)
  const paperHeading = useRef<HTMLHeadingElement>(null)
  const directoryList = useRef<HTMLDivElement>(null)
  const currentChapterButton = useRef<HTMLButtonElement>(null)
  const statusButton = useRef<HTMLButtonElement>(null)
  const directoryTrigger = useRef<HTMLButtonElement>(null)
  const directorySearch = useRef<HTMLInputElement>(null)
  const appearance = useRef<HTMLDetailsElement>(null)
  const titleId = useId()
  const directoryId = useId()
  const pageStatusId = useId()

  const clearReading = useCallback(() => {
    setLoaded(null); setPageIndex(0); setChapterError(null)
  }, [])

  const retainTimeout = useCallback((failure: AppError, command: PendingRead['command']): boolean => {
    if (failure.code !== 'REQUEST_TIMEOUT' || !failure.requestId) return false
    const next = { requestId: failure.requestId, command }
    // 超时请求可能仍在运行；同步锁住新读，只允许查询原请求或离开面板。
    pendingRead.current = next; setPending(next)
    readTicket.current += 1; readLock.current = false
    clearReading(); setLoading(null); setCatalog(null); setSelectedId(null); setCatalogError(null)
    setPendingMessage('读取超时，原请求可能仍在处理。请查询状态后再刷新版本。')
    return true
  }, [clearReading])

  const loadChapter = useCallback(async (chapter: ReaderChapter, readingScope: Scope) => {
    if (!mounted.current || readLock.current || pendingRead.current) return
    const revisionId = revisionFor(chapter, readingScope)
    if (!revisionId) return
    const ticket = ++readTicket.current
    readLock.current = true
    selection.current = { id: chapter.id, scope: readingScope }
    clearReading(); setSelectedId(chapter.id); setLoading('chapter'); setNotice(null)
    const result = await request(() => current.current.api.readRevision({ bookId, chapterId: chapter.id, revisionId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setLoading(null)
    if (!result.ok) {
      if (!retainTimeout(result.error, 'revision.read')) setChapterError(result.error.message)
      return
    }
    const revision = result.data
    if (revision.bookId !== bookId || revision.chapterId !== chapter.id || revision.id !== revisionId) {
      setChapterError('返回的作品、章节或版本不符，请重试读取本章。'); return
    }
    try {
      // 仅保留当前章的分页与小量元数据，整份 revision 和 plainText 不进入面板状态。
      const pages = paginateReaderDocument(revision.document)
      setLoaded({ pages, selectedRevision: {
        id: revision.id, sequence: revision.sequence, createdAt: revision.createdAt, characterCount: revision.characterCount,
      } })
    } catch {
      setChapterError('正文无法分页，请重试读取本章。')
    }
  }, [bookId, clearReading, retainTimeout])

  const loadCatalog = useCallback(async () => {
    if (!mounted.current || readLock.current || pendingRead.current) return
    const preferred = selection.current
    const ticket = ++readTicket.current
    readLock.current = true
    clearReading(); setCatalog(null); setSelectedId(null); setCatalogError(null); setNotice(null); setLoading('catalog')
    const result = await request(() => current.current.api.getBook({ bookId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setLoading(null)
    if (!result.ok) {
      if (!retainTimeout(result.error, 'book.get')) setCatalogError(result.error.message)
      return
    }
    const snapshot = result.data
    if (snapshot.book.id !== bookId) {
      setCatalogError('返回的作品身份不符，请重新读取目录。'); return
    }
    const volumes = new Map(snapshot.volumes.map((volume) => [volume.id, volume.title]))
    // 全书 position 是阅读顺序；复制两种版本指针，后续只在显式刷新时更新。
    const chapters: ReaderChapter[] = [...snapshot.chapters].sort((a, b) => a.position - b.position).map((chapter, index) => ({
      id: chapter.id, title: chapter.title, ordinal: index + 1,
      revisionId: chapter.revisionId, finalizedRevisionId: chapter.finalizedRevisionId,
      volumeTitle: chapter.volumeId ? volumes.get(chapter.volumeId) ?? '' : '',
    }))
    const available = chapters.filter((chapter) => Boolean(revisionFor(chapter, preferred.scope)))
    const next = available.find((chapter) => chapter.id === preferred.id) ?? available[0]
    setCatalog({ title: snapshot.book.title, revision: snapshot.book.revision, chapters })
    setSearch(''); setDirectoryPage(next ? Math.floor(available.indexOf(next) / DIRECTORY_PAGE_SIZE) : 0)
    selection.current = { id: next?.id ?? null, scope: preferred.scope }
    if (next) void loadChapter(next, preferred.scope)
  }, [bookId, clearReading, loadChapter, retainTimeout])

  useEffect(() => {
    mounted.current = true
    void loadCatalog()
    return () => {
      mounted.current = false; readTicket.current += 1; statusTicket.current += 1
      readLock.current = false; statusLock.current = false
    }
  }, [loadCatalog])

  useEffect(() => {
    if (paper.current) paper.current.scrollTop = 0
  }, [selectedId, scope, pageIndex, loaded])

  useEffect(() => {
    // 只在作者主动导航时聚焦，异步回包不能打断目录搜索或阅读设置。
    if (paperJump > 0) paperHeading.current?.focus({ preventScroll: true })
  }, [paperJump])

  useEffect(() => {
    if (directoryList.current) directoryList.current.scrollTop = 0
  }, [directoryPage, search, scope, catalog])

  useEffect(() => {
    if (directoryOpen) directorySearch.current?.focus()
  }, [directoryOpen])

  useEffect(() => {
    if (directoryJump > 0) currentChapterButton.current?.focus()
  }, [directoryJump])

  useEffect(() => { if (pending) statusButton.current?.focus() }, [pending])

  useEffect(() => { paperHeading.current?.focus({ preventScroll: true }) }, [])

  const chapters = useMemo(() => catalog?.chapters.filter((chapter) => Boolean(revisionFor(chapter, scope))) ?? [], [catalog, scope])
  const selectedIndex = useMemo(() => chapters.findIndex((chapter) => chapter.id === selectedId), [chapters, selectedId])
  const selected = chapters[selectedIndex]
  const unfinalizedCount = useMemo(() => catalog?.chapters.filter((chapter) => !chapter.finalizedRevisionId).length ?? 0, [catalog])
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return query ? chapters.filter((chapter) => chapter.title.toLocaleLowerCase().includes(query) || chapter.volumeTitle.toLocaleLowerCase().includes(query)) : chapters
  }, [chapters, search])
  const directoryPageCount = Math.max(1, Math.ceil(filtered.length / DIRECTORY_PAGE_SIZE))
  const visibleDirectoryPage = Math.min(directoryPage, directoryPageCount - 1)
  const visibleChapters = filtered.slice(visibleDirectoryPage * DIRECTORY_PAGE_SIZE, (visibleDirectoryPage + 1) * DIRECTORY_PAGE_SIZE)
  const annotations = useReaderAnnotations({ api, bookId, enabled: annotationsEnabled && loaded !== null, busy })
  const blocked = busy || loading !== null || pending !== null

  function canRead() {
    return mounted.current && !current.current.busy && !readLock.current && !pendingRead.current
  }

  function refreshCatalog() {
    if (!canRead()) return
    setPaperJump((value) => value + 1)
    void loadCatalog()
  }

  function selectChapter(chapter: ReaderChapter | undefined) {
    if (!chapter || !canRead() || (chapter.id === selectedId && loaded)) return
    setDirectoryOpen(false)
    setPaperJump((value) => value + 1)
    void loadChapter(chapter, scope)
  }

  function changeScope(nextScope: Scope) {
    if (!canRead() || !catalog || scope === nextScope) return
    readTicket.current += 1
    clearReading(); setSelectedId(null); setScope(nextScope); setDirectoryPage(0); setNotice(null)
    setPaperJump((value) => value + 1)
    const available = catalog.chapters.filter((chapter) => Boolean(revisionFor(chapter, nextScope)))
    const next = available.find((chapter) => chapter.id === selectedId) ?? available[0]
    selection.current = { id: next?.id ?? null, scope: nextScope }
    if (next) void loadChapter(next, nextScope)
  }

  function movePage(next: number) {
    if (!canRead() || !loaded || next < 0 || next >= loaded.pages.length) return
    setPageIndex(next)
    setPaperJump((value) => value + 1)
  }

  function jumpToCurrent() {
    if (selectedIndex < 0) return
    setSearch(''); setDirectoryPage(Math.floor(selectedIndex / DIRECTORY_PAGE_SIZE)); setDirectoryOpen(true)
    setDirectoryJump((value) => value + 1)
  }

  async function queryRequest() {
    const saved = pendingRead.current
    if (!mounted.current || current.current.busy || !saved || statusLock.current) return
    const ticket = ++statusTicket.current
    statusLock.current = true; setCheckingStatus(true)
    const result = await request(() => current.current.api.getRequestStatus({ requestId: saved.requestId }))
    if (!mounted.current || ticket !== statusTicket.current || pendingRead.current !== saved) return
    statusLock.current = false; setCheckingStatus(false)
    if (!result.ok) { setPendingMessage(`状态查询失败：${result.error.message} 可再次查询。`); return }
    const status = result.data
    if (status.state === 'pending') { setPendingMessage('原读取仍在处理，请稍后再次查询。'); return }
    if (status.state === 'completed' && status.response.command !== saved.command) {
      setPendingMessage('返回的请求类型不符，仍需等待确认。可以关闭面板后检查服务。'); return
    }
    // 迟到结果只解除等待；必须由作者显式刷新建立新的目录和固定版本。
    pendingRead.current = null; setPending(null); setPendingMessage('')
    setNotice(status.state === 'unknown'
      ? '原请求状态已不可查询。可点击「刷新版本」重新读取。'
      : '原读取已结束。请点击「刷新版本」继续阅读。')
  }

  function close() {
    if (current.current.busy) return
    // 父级可能拒绝关闭；只在实际卸载时清理读取，避免仍显示的阅读页失去响应。
    onClose()
  }

  return <section className={styles.panel} aria-label="作品阅读" onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.keyCode === 229) return
    const target = event.target as HTMLElement
    // 原生选择器先处理自身的退出；先收起批注或设置，下一次 Esc 才离开阅读。
    if (target.closest('select')) return
    const expanded = target.closest('details[open]') ?? paper.current?.querySelector('details[data-reader-annotation][open]') ?? (appearance.current?.open ? appearance.current : null)
    if (expanded instanceof HTMLDetailsElement) {
      event.preventDefault(); event.stopPropagation(); expanded.open = false; expanded.querySelector('summary')?.focus(); return
    }
    event.preventDefault(); event.stopPropagation()
    if (directoryOpen) { setDirectoryOpen(false); directoryTrigger.current?.focus(); return }
    close()
  }}>
      <header className={styles.topbar}>
        <div className={styles.bookIdentity}>
          <span className={styles.brand}><StudioIcon name="planet" size={28} /><strong>织章</strong></span>
          <button type="button" className={styles.backButton} disabled={busy} onClick={close} aria-label="退出阅读" title="退出阅读"><StudioIcon name="arrow" size={20} /></button>
          <p className={styles.bookTitle} title={catalog?.title ?? book.book.title}>《{catalog?.title ?? book.book.title}》</p>
        </div>
        <div className={styles.scopes} role="group" aria-label="阅读版本">
          {(['working', 'finalized'] as const).map((value) => <button key={value} type="button" className={shared.button}
            aria-pressed={scope === value} disabled={blocked || !catalog} onClick={() => changeScope(value)}>{scopeLabels[value]}</button>)}
        </div>
        {catalog && catalog.chapters.length > 0 && unfinalizedCount === catalog.chapters.length && <span className={styles.workingOnly}>仅工作稿</span>}
        <details ref={appearance} className={styles.appearance}>
          <summary aria-label="阅读排版设置" title="阅读排版设置"><span>Aa</span><StudioIcon name="down" size={20} /></summary>
          <div className={styles.settings}>
          <label>字号<select value={displayPreferences.fontSize} disabled={busy} onChange={(event) => onPreferencesChange({ fontSize: Number(event.target.value) })}>
            {DISPLAY_FONT_SIZES.map((size) => <option key={size} value={size}>{size} px</option>)}
          </select></label>
          <label>行距<select value={displayPreferences.lineHeight} disabled={busy} onChange={(event) => onPreferencesChange({ lineHeight: Number(event.target.value) })}>
            {DISPLAY_LINE_HEIGHTS.map((height) => <option key={height} value={height}>{height} 倍</option>)}
          </select></label>
          <label>纸色<select value={displayPreferences.paperTone} disabled={busy} onChange={(event) => onPreferencesChange({ paperTone: event.target.value as DisplayPreferences['paperTone'] })}>
            {Object.entries(PAPER_TONE_LABELS).map(([tone, label]) => <option key={tone} value={tone}>{label}</option>)}
          </select></label>
          <label>显示批注<input type="checkbox" role="switch" className={styles.annotationSwitch} checked={annotationsEnabled} disabled={busy}
            onChange={(event) => setAnnotationsEnabled(event.target.checked)} /></label>
          {annotationsEnabled && <div className={styles.annotationStatus}>
            {annotations.state.kind === 'ready' ? <p role="status">批注读取时作品版本 {annotations.state.snapshot.bookRevision}</p>
              : annotations.state.kind === 'idle' ? <p>等待读取正文</p>
                : annotations.state.kind === 'loading' ? <p role="status">正在读取批注…</p> : <p>{annotations.state.message}</p>}
            {annotations.state.kind === 'pending' ? <>
              <button type="button" className={shared.button} disabled={busy || annotations.checking} aria-busy={annotations.checking}
                onClick={() => void annotations.queryOriginal()}>{annotations.checking ? '核对中…' : '核对原请求'}</button>
              <details><summary>请求详情</summary><p>workbench.get · {annotations.state.requestId}</p></details>
            </> : (annotations.state.kind === 'ready' || annotations.state.kind === 'failed' || annotations.state.kind === 'loading') &&
              <button type="button" className={shared.button} disabled={busy || annotations.state.kind === 'loading'} aria-busy={annotations.state.kind === 'loading'}
                onClick={() => void annotations.load()}>{annotations.state.kind === 'loading' ? '读取批注…' : annotations.state.kind === 'ready' ? '刷新批注' : '重试读取批注'}</button>}
          </div>}
          <p className={styles.help}>只读阅读 · 更新内容请刷新版本</p>
          {catalog && <p className={styles.scopeNote}>共 {catalog.chapters.length} 章，{unfinalizedCount} 章未定稿。{scope === 'finalized' ? '当前仅阅读作者定稿。' : '当前阅读工作稿。'}</p>}
          <button type="button" className={shared.button} disabled={blocked} aria-busy={loading === 'catalog'} onClick={refreshCatalog}>{loading === 'catalog' ? '读取目录…' : '刷新版本'}</button>
          <p className={styles.help}>显示偏好与写作共用，更改即时应用并自动保存，仅影响显示。</p>
          </div>
        </details>
        <button type="button" className={styles.exitButton} disabled={busy} onClick={close}>退出阅读</button>
      </header>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {annotationsEnabled && (annotations.state.kind === 'failed' || annotations.state.kind === 'pending' || annotations.state.kind === 'unavailable') &&
        <p className={styles.notice} role={annotations.state.kind === 'unavailable' ? 'status' : 'alert'}>批注：{annotations.state.message}</p>}
      {preferencesWarning && <section className={styles.preferencesWarning} aria-label="显示偏好保存提示">
        <p role="alert">{preferencesWarning}</p>
        <button type="button" className={shared.button} disabled={busy} onClick={onRetryPreferencesSave}>保存当前显示偏好</button>
      </section>}
      {pending && <section className={styles.pending} aria-label="读取等待确认">
        <p role="alert">{pendingMessage}</p>
        <button ref={statusButton} type="button" className={shared.button} disabled={busy || checkingStatus} aria-busy={checkingStatus} onClick={() => void queryRequest()}>{checkingStatus ? '查询中…' : '查询原请求'}</button>
        <details><summary>请求详情</summary><p>{pending.command} · {pending.requestId}</p></details>
      </section>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <div className={styles.layout}>
        <aside id={directoryId} className={styles.catalog} data-open={directoryOpen} aria-label="章节目录">
          <div className={styles.catalogHeading}><h3>目录</h3><button type="button" className={shared.button} disabled={!selected || blocked} onClick={jumpToCurrent}>当前章节</button>
            <button type="button" className={styles.catalogClose} aria-label="收起目录" title="收起目录" onClick={() => { setDirectoryOpen(false); directoryTrigger.current?.focus() }}><StudioIcon name="close" size={20} /></button></div>
          <label className={styles.search}>搜索目录<input ref={directorySearch} type="search" value={search} disabled={!catalog} placeholder="章节标题或卷名"
            onChange={(event) => { setSearch(event.target.value); setDirectoryPage(0) }} /></label>
          <div ref={directoryList} className={styles.catalogList}>
            {loading === 'catalog' && <p className={styles.help} role="status">正在读取目录…</p>}
            {!catalog && loading !== 'catalog' && <p className={styles.help}>{pending ? '确认请求状态后继续阅读。' : '刷新版本后显示目录。'}</p>}
            {catalog && filtered.length === 0 && <p className={styles.help}>{search.trim() ? '没有匹配的章节或卷名。' : scope === 'finalized' ? '本次目录中没有作者定稿。' : '本次目录中没有可读章节。'}</p>}
            <ol className={styles.chapters}>
              {visibleChapters.map((chapter) => <li key={chapter.id} value={chapter.ordinal}>
                <button ref={chapter.id === selectedId ? currentChapterButton : undefined} type="button" className={styles.chapter}
                  aria-current={chapter.id === selectedId ? 'true' : undefined} disabled={blocked} onClick={() => selectChapter(chapter)}>
                  <span className={styles.ordinal}>{chapter.ordinal}</span><span><strong>{chapter.title}</strong>
                    {chapter.volumeTitle && <small>{chapter.volumeTitle}</small>}
                    {scope === 'working' && !chapter.finalizedRevisionId && <small>未定稿</small>}
                  </span>
                </button>
              </li>)}
            </ol>
          </div>
          {catalog && <nav className={styles.directoryPaging} aria-label="目录分页">
            <span role="status">{filtered.length} 章 · {visibleDirectoryPage + 1} / {directoryPageCount} 页</span>
            <button type="button" className={shared.button} disabled={visibleDirectoryPage === 0} onClick={() => setDirectoryPage(visibleDirectoryPage - 1)}>前一页</button>
            <button type="button" className={shared.button} disabled={visibleDirectoryPage + 1 >= directoryPageCount} onClick={() => setDirectoryPage(visibleDirectoryPage + 1)}>后一页</button>
          </nav>}
        </aside>
        <section className={styles.reader} aria-label="阅读正文">
          <div ref={paper} className={`${paperStyles.surface} ${styles.paper}`} data-paper-tone={displayPreferences.paperTone} style={displayPreferenceStyle(displayPreferences)}
            role="region" aria-labelledby={titleId} aria-busy={loading !== null}>
            <div className={styles.readingWidth}>
              <header className={styles.paperHeader}>
                {selected?.volumeTitle && <p className={styles.volume}>{selected.volumeTitle}</p>}
                <h3 id={titleId} ref={paperHeading} tabIndex={-1} aria-describedby={loaded ? pageStatusId : undefined}>{selected?.title ?? '作品正文'}</h3>
                {selected && <p className={styles.paperMeta}>{scopeLabels[scope]}{loaded ? ` · ${loaded.selectedRevision.characterCount.toLocaleString()} 字` : ''}{book.book.archivedAt ? ' · 归档作品 · 只读' : ''}</p>}
                {loaded && <details className={styles.version}>
                  <summary>版本详情</summary>
                  <p>作品目录版本 {catalog?.revision} · 正文版本 {loaded.selectedRevision.sequence}</p>
                  <p>{displayTime(loaded.selectedRevision.createdAt)} · {loaded.selectedRevision.id}</p>
                </details>}
                <div className={styles.chapterDivider} aria-hidden="true"><StudioIcon name="spark" size={20} /></div>
              </header>
              {loading && <div className={styles.paperState}>
                <p role="status">{loading === 'catalog' ? '正在准备作品目录…' : `正在读取${scopeLabels[scope]}…`}</p>
                <div className={styles.skeleton} aria-hidden="true"><span /><span /><span /></div>
              </div>}
              {catalogError && <div className={styles.paperState}>
                <p role="alert">目录读取失败：{catalogError}</p>
                <button type="button" className={shared.button} disabled={blocked} onClick={refreshCatalog}>重试读取目录</button>
              </div>}
              {chapterError && <div className={styles.paperState}>
                <p role="alert">本章读取失败：{chapterError}</p>
                <button type="button" className={shared.button} disabled={blocked || !selected} onClick={() => { if (selected) selectChapter(selected) }}>重试本章</button>
              </div>}
              {pending && <p className={styles.paperState}>读取等待确认，可查询原请求或返回编辑。</p>}
              {!loading && !pending && !catalogError && !catalog && <p className={styles.paperState}>请刷新版本，重新取得作品目录。</p>}
              {catalog && !loading && chapters.length === 0 && <div className={styles.paperState}>
                <h4>{scope === 'finalized' ? '暂无作者定稿' : '暂无可读章节'}</h4>
                <p>{scope === 'finalized' ? '可切换到工作稿阅读，或在编辑页完成定稿后刷新版本。' : '请在编辑页添加章节，保存后重新打开阅读。'}</p>
              </div>}
              {loaded && <>
                {loaded.selectedRevision.characterCount === 0 && <p className={styles.paperState}>这个版本尚无文字。</p>}
                {selected && <ReaderAnnotations key={`${selected.id}:${loaded.selectedRevision.id}`}
                  snapshot={annotationsEnabled && annotations.state.kind === 'ready' ? annotations.state.snapshot : null}
                  chapterId={selected.id} revisionId={loaded.selectedRevision.id} pages={loaded.pages} pageIndex={pageIndex}
                  onReviewIssue={onReviewIssue} disabled={blocked || Boolean(book.book.archivedAt)}
                  renderBlock={(block) => <PageBlock block={block} />} />}
              </>}
            </div>
          </div>
          <nav className={styles.pageNavigation} aria-label="章节分页">
            <button type="button" className={shared.button} disabled={blocked || !loaded || pageIndex === 0} onClick={() => movePage(pageIndex - 1)}>上一页</button>
            <span id={pageStatusId} role="status">{loaded ? `第 ${pageIndex + 1} / ${loaded.pages.length} 页` : '等待正文'}</span>
            <button type="button" className={shared.button} disabled={blocked || !loaded || pageIndex + 1 >= loaded.pages.length} onClick={() => movePage(pageIndex + 1)}>下一页</button>
          </nav>
        </section>
      </div>
      <nav className={styles.chapterNavigation} aria-label="章节切换">
        <button type="button" className={shared.button} disabled={blocked || selectedIndex <= 0}
          onClick={() => selectChapter(chapters[selectedIndex - 1])}><StudioIcon name="chevron" size={20} /><span>上一章</span></button>
        <button ref={directoryTrigger} type="button" className={shared.button} aria-expanded={directoryOpen} aria-controls={directoryId}
          onClick={() => setDirectoryOpen((value) => !value)} title={directoryOpen ? '收起目录' : '展开目录'}><StudioIcon name="list" size={20} /><span>目录</span></button>
        <span className={styles.chapterPosition} aria-label={selected ? `全书第 ${selected.ordinal} / ${catalog?.chapters.length} 章` : scopeLabels[scope]}>{selected ? `${selected.ordinal} / ${catalog?.chapters.length}` : scopeLabels[scope]}</span>
        <button type="button" className={shared.button} disabled={blocked || selectedIndex < 0 || selectedIndex + 1 >= chapters.length}
          onClick={() => selectChapter(chapters[selectedIndex + 1])}><span>下一章</span><StudioIcon name="chevron" size={20} /></button>
        <button type="button" className={`${shared.button} ${styles.returnButton}`} disabled={busy} onClick={close}><StudioIcon name="pen" size={20} /><span>回到编辑</span></button>
      </nav>
  </section>
}
