import { useState } from 'react'
import type { BookSummary, StudioApi } from '../../contracts/api'
import { displayTime } from '../request'
import { BookCover } from './LibraryPanels'
import { StudioIcon } from './StudioIcon'
import { genreTone, STELLAR_GENRES } from './stellar/Genres'
import { useBookPreview } from './stellar/useBookPreview'
import ui from './stellar/stellar.module.css'
import styles from './StudioPages.module.css'

export function StellarBookCard({ api, scope, book, busy, onOpen, onWrite, onEdit }: {
  api?: StudioApi; scope?: string; book: BookSummary; busy: boolean
  onOpen: (id: string) => void; onWrite: (id: string) => void; onEdit?: (book: BookSummary) => void
}) {
  const { snapshot, loading, error, retry } = useBookPreview(api, scope, book)
  const lifecycle = snapshot?.book.lifecycle ?? book.lifecycle
  const count = snapshot?.chapters.reduce((n, item) => n + item.characterCount, 0)
  const final = snapshot?.chapters.filter((item) => item.status === 'finalized').length ?? 0
  return <article className={styles.bookCard} data-genre={genreTone(book.genre)} data-archived={Boolean(book.archivedAt)}>
    <button className={styles.bookMain} type="button" disabled={busy} onClick={() => onOpen(book.id)} aria-label={`打开${book.title}的作品总览`}>
      <BookCover api={api} workspaceScope={scope} book={book} />
      <div><h3>{book.title}</h3><small className={styles.bookGenre}>{book.genre || '未设置题材'}</small>
        <span className={`${ui.chip} ${styles.bookState}`} data-tone={book.archivedAt || lifecycle === 'finished' ? 'warning' : 'accent'}>{book.archivedAt ? '已归档' : lifecycle === 'finished' ? '已完结' : lifecycle === 'kickstarting' ? '孵化中' : '创作中'}</span>
        {Boolean(snapshot?.chapters.length) && <div className={styles.bookProgress} title={`已定稿 ${final} / ${snapshot!.chapters.length} 章`}><progress className={ui.progress} value={final} max={snapshot!.chapters.length} aria-label={`已定稿 ${final} / ${snapshot!.chapters.length} 章`} /><span>{Math.round(final / snapshot!.chapters.length * 100)}%</span></div>}
        <small>{snapshot ? `${count!.toLocaleString()} 字 · ${snapshot.chapters.length} 章` : loading ? '读取作品…' : '统计暂不可用'}</small>
      </div>
    </button>
    {error && <div className={ui.error} role="status">{error}<button className={ui.ghost} type="button" disabled={busy} onClick={retry}>重试</button></div>}
    <div className={styles.bookFoot}>{onEdit ? <button className={ui.ghost} type="button" disabled={busy} onClick={() => onEdit(book)} aria-label={`编辑${book.title}资料`} title="作品资料"><StudioIcon name="more" size={16} /></button> : <span>{displayTime(book.updatedAt)}</span>}<button className={ui.ghost} type="button" disabled={busy} onClick={() => onWrite(book.id)}>{book.archivedAt ? '打开阅读' : lifecycle === 'kickstarting' ? '继续孵化' : '继续写作'}<StudioIcon name="arrow" size={16} /></button></div>
  </article>
}

export function StellarShelf({ api, scope, books, busy, onOpen, onWrite, onEdit, onCreate, onImport, onRecover }: {
  api?: StudioApi; scope?: string; books: BookSummary[]; busy: boolean
  onOpen: (id: string) => void; onWrite: (id: string) => void; onEdit: (book: BookSummary) => void
  onCreate: () => void; onImport: () => void; onRecover: () => void
}) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [genre, setGenre] = useState('')
  const [mode, setMode] = useState<'grid' | 'list'>('grid')
  const [page, setPage] = useState(0)
  const recent = [...books].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const visible = recent.filter((item) => Boolean(item.archivedAt) === archived && (!genre || item.genre === genre)
    && `${item.title} ${item.genre} ${item.synopsis}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const pageCount = Math.max(1, Math.ceil(visible.length / 6))
  const currentPage = Math.min(page, pageCount - 1)
  const genres = [...STELLAR_GENRES.map((item) => item.label), ...new Set(books.map((item) => item.genre).filter((item) => item && !STELLAR_GENRES.some((genre) => genre.label === item)))]
  const activeCount = books.filter((item) => !item.archivedAt).length
  return <section className={styles.page} aria-label="作品书架"><div className={styles.pageInner}>
    <header className={styles.heading}><div><h1 className={styles.visuallyHidden}>作品书架</h1><p className={styles.shelfStatistics}><span><strong>{books.length}</strong>部作品</span><span><strong>{activeCount}</strong>部未归档</span><span><strong>{books.length - activeCount}</strong>部已归档</span></p></div><div className={ui.actions}><div className={ui.tabs} role="group" aria-label="书架布局"><button type="button" title="列表视图" aria-label="列表视图" aria-pressed={mode === 'list'} onClick={() => setMode('list')}><StudioIcon name="list" size={20} /></button><button type="button" title="网格视图" aria-label="网格视图" aria-pressed={mode === 'grid'} onClick={() => setMode('grid')}><StudioIcon name="grid" size={20} /></button></div><button className={ui.primary} type="button" disabled={busy} onClick={onCreate}><StudioIcon name="plus" size={16} />新建作品</button></div></header>
    <div className={styles.shelfFilters}>
      <div className={styles.genreFilters} role="group" aria-label="题材筛选"><button type="button" aria-pressed={!genre} onClick={() => { setGenre(''); setPage(0) }}><StudioIcon name="grid" size={16} />全部</button>
        {genres.map((item) => <button key={item} type="button" aria-pressed={genre === item} onClick={() => { setGenre(item); setPage(0) }}>{STELLAR_GENRES.find((genre) => genre.label === item) && <StudioIcon name={STELLAR_GENRES.find((genre) => genre.label === item)!.icon} size={16} />}{item}</button>)}</div>
      <div className={styles.filters}><div className={ui.tabs} role="group" aria-label="作品状态"><button type="button" aria-pressed={!archived} onClick={() => { setArchived(false); setPage(0) }}>未归档</button><button type="button" aria-pressed={archived} onClick={() => { setArchived(true); setPage(0) }}>已归档</button></div>
        <label><StudioIcon name="search" size={18} /><input type="search" aria-label="搜索作品" placeholder="搜索作品、题材…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} /></label></div>
    </div>
    <div className={styles.shelfLayout}><div>
      {visible.length ? <div className={`${styles.bookGrid} ${mode === 'grid' ? styles.shelfGrid : styles.shelfList}`}>{visible.slice(currentPage * 6, currentPage * 6 + 6).map((item) => <StellarBookCard key={`${scope}:${item.id}`} api={api} scope={scope} book={item} busy={busy} onOpen={onOpen} onWrite={onWrite} onEdit={onEdit} />)}</div>
        : <div className={ui.empty}><StudioIcon name={query || genre ? 'search' : 'books'} size={32} /><h3>{query || genre ? '没有匹配的作品' : archived ? '暂无归档作品' : '开始你的第一部作品'}</h3><div className={ui.actions}>{query || genre ? <button className={ui.button} type="button" onClick={() => { setQuery(''); setGenre('') }}>清空筛选</button> : <><button className={ui.primary} type="button" disabled={busy} onClick={onCreate}>新建作品</button><button className={ui.button} type="button" disabled={busy} onClick={onImport}>导入稿件</button></>}</div></div>}
      {pageCount > 1 && <div className={ui.pagination}><button className={ui.button} type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pageCount}</span><button className={ui.button} type="button" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}
    </div><aside className={`${styles.sideColumn} ${styles.shelfSidebar}`} aria-label="书库工具"><section className={styles.sideSection}><h2><StudioIcon name="clock" size={18} />最近更新</h2><ul className={`${styles.queue} ${styles.recentBooks}`}>{recent.slice(0, 3).map((item) => <li key={item.id}><button type="button" disabled={busy} onClick={() => onOpen(item.id)}><span className={styles.recentCover}><BookCover api={api} workspaceScope={scope} book={item} /></span><span>{item.title}<small>{item.genre || '未设置题材'}</small><small>{displayTime(item.updatedAt)}</small></span></button></li>)}</ul></section>
      <section className={`${styles.sideSection} ${styles.shelfImport}`}><StudioIcon name="notes" size={40} /><h2>导入作品</h2><p>TXT / Markdown</p><button className={ui.button} type="button" disabled={busy} onClick={onImport}><StudioIcon name="plus" size={16} />导入作品</button></section><button className={ui.ghost} type="button" disabled={busy} onClick={onRecover}><StudioIcon name="history" size={16} />找回未登记作品</button></aside></div>
  </div></section>
}
