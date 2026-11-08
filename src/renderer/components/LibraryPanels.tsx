import { useState } from 'react'
import type { BookSnapshot, BookSummary, ChapterStatus, ChapterSummary } from '../../contracts/api'
import { displayTime, statusLabels } from '../request'
import { StudioIcon } from './StudioIcon'
import styles from '../App.module.css'
import libraryStyles from './LibraryPanels.module.css'

interface ShelfProps {
  books: BookSummary[]
  busy: boolean
  onOpen: (id: string) => void
  onEdit: (book: BookSummary) => void
  onCreate: () => void
  onImport: () => void
  onRecover: () => void
}

export function BookCover({ book, featured = false }: { book: BookSummary; featured?: boolean }) {
  const tone = Array.from(book.id).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4
  return <span className={`${libraryStyles.bookCover} ${featured ? libraryStyles.featuredCover : ''}`} data-tone={tone} aria-hidden="true">
    <span className={libraryStyles.coverGenre}>{book.genre || '作品手稿'}</span>
    <strong className={libraryStyles.coverTitle}>{book.title}</strong>
    <svg className={libraryStyles.coverLines} viewBox="0 0 160 224" fill="none" stroke="currentColor" strokeWidth="0.7" focusable="false">
      <circle cx="151" cy="211" r="110" /><circle cx="151" cy="211" r="88" /><circle cx="151" cy="211" r="66" />
      <path d="M12 0v224M0 187h160" />
    </svg>
    <span className={libraryStyles.coverImprint}>织章</span>
  </span>
}

export function BookShelf({ books, busy, onOpen, onEdit, onCreate, onImport, onRecover }: ShelfProps) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const needle = query.trim().toLocaleLowerCase()
  const writingCount = books.filter((item) => !item.archivedAt).length
  // 在筛选副本上按真实更新时间排序，保留父级传入的作品顺序。
  const shelfBooks = books.filter((item) => Boolean(item.archivedAt) === archived)
    .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
  const visible = shelfBooks.filter((item) => `${item.title} ${item.genre} ${item.synopsis}`.toLocaleLowerCase().includes(needle))
  const recent = !archived && !needle ? shelfBooks[0] : undefined

  return <section className={libraryStyles.shelf} aria-label="我的书架" aria-busy={busy}>
    <div className={libraryStyles.shelfContent}>
      <header className={libraryStyles.shelfHeader}>
        <div><h2>我的书架</h2><p>整理故事，继续写下一个章节。</p></div>
        <div className={libraryStyles.actionRow}>
          <button className={libraryStyles.button} type="button" onClick={onImport} disabled={busy}><StudioIcon name="folder" />导入文本</button>
          <button className={libraryStyles.primaryButton} type="button" onClick={onCreate} disabled={busy}><StudioIcon name="pen" />新建作品</button>
        </div>
      </header>

      {recent && <section className={libraryStyles.recentBook} aria-label="最近更新的作品">
        <BookCover book={recent} featured />
        <div className={libraryStyles.recentBody}>
          <span className={libraryStyles.recentLabel}>最近更新</span>
          <h3 title={recent.title}>{recent.title}</h3>
          <p className={libraryStyles.recentSynopsis}>{recent.synopsis || '还没有作品简介，可以在作品资料中补充。'}</p>
          <div className={libraryStyles.recentMeta}><span>{recent.genre || '未设置类型'}</span><span>更新于 <time dateTime={recent.updatedAt}>{displayTime(recent.updatedAt)}</time></span></div>
          <div className={libraryStyles.actionRow}>
            <button className={libraryStyles.primaryButton} type="button" onClick={() => onOpen(recent.id)} disabled={busy}>进入写作<StudioIcon name="arrow" size={16} /></button>
            <button className={libraryStyles.textButton} type="button" onClick={() => onEdit(recent)} disabled={busy}>作品资料</button>
          </div>
        </div>
      </section>}

      <div className={libraryStyles.shelfTools}>
        <div className={libraryStyles.scopeTabs} role="group" aria-label="书架范围">
          <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>写作中<span>{writingCount}</span></button>
          <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>已归档<span>{books.length - writingCount}</span></button>
        </div>
        <label className={libraryStyles.searchField}>
          <StudioIcon name="search" size={17} />
          <input type="search" aria-label="搜索作品" placeholder="搜索书名、类型或简介" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <div className={libraryStyles.listHeading}>
        <p role="status">{needle ? `找到 ${visible.length} 部作品` : `${shelfBooks.length} 部作品`}</p>
        <span>按最近更新排序</span>
      </div>

      {visible.length === 0 ? <div className={libraryStyles.shelfEmpty}>
        <span className={libraryStyles.emptyIcon}><StudioIcon name={needle ? 'search' : archived ? 'archive' : 'books'} size={34} /></span>
        <h3>{needle ? '没有找到匹配的作品' : archived ? '还没有归档作品' : books.length ? '暂时没有写作中的作品' : '书架还是空的'}</h3>
        <p>{needle ? `当前${archived ? '已归档' : '写作中'}的作品中没有匹配“${query.trim()}”的结果。试试其他书名、类型或简介。` : archived ? '归档后的作品会保留在这里。可以打开阅读，也可以在作品资料中解除归档。' : books.length ? '新建一部作品，或从“已归档”中找回想继续写的故事。' : '新建第一部作品，或导入已有的 TXT / Markdown 稿件。'}</p>
        <div className={libraryStyles.actionRow}>
          {needle ? <button className={libraryStyles.button} type="button" onClick={() => setQuery('')}>清空筛选</button> : archived ? <button className={libraryStyles.button} type="button" onClick={() => setArchived(false)}>返回写作中</button> : <>
            <button className={libraryStyles.primaryButton} type="button" onClick={onCreate} disabled={busy}><StudioIcon name="pen" />新建作品</button>
            <button className={libraryStyles.button} type="button" onClick={onImport} disabled={busy}><StudioIcon name="folder" />导入文本</button>
          </>}
        </div>
      </div> : <div className={libraryStyles.bookGrid}>
        {visible.map((item) => <article className={libraryStyles.bookCard} key={item.id}>
          <button className={libraryStyles.bookTile} type="button" onClick={() => onOpen(item.id)} disabled={busy} aria-label={`打开${item.title}${item.archivedAt ? '（已归档）' : ''}`}>
            <BookCover book={item} />
            <span className={libraryStyles.bookInfo}>
              <strong className={libraryStyles.bookTitle} title={item.title}>{item.title}</strong>
              <span className={libraryStyles.bookGenre}>{item.genre || '未设置类型'}</span>
              {item.synopsis && <span className={libraryStyles.bookSynopsis}>{item.synopsis}</span>}
              <span className={libraryStyles.bookUpdated}>更新于 <time dateTime={item.updatedAt}>{displayTime(item.updatedAt)}</time></span>
            </span>
          </button>
          <button type="button" className={libraryStyles.bookDetails} onClick={() => onEdit(item)} disabled={busy} aria-label={`${item.title}：作品资料${item.archivedAt ? ' / 解除归档' : ''}`}>作品资料{item.archivedAt ? ' / 解除归档' : ''}<StudioIcon name="chevron" size={14} /></button>
        </article>)}
      </div>}

      <footer className={libraryStyles.shelfFooter}>
        <span>当前作品库</span>
        <button className={libraryStyles.textButton} type="button" onClick={onRecover} disabled={busy}><StudioIcon name="history" size={16} />找回未登记的作品</button>
      </footer>
    </div>
  </section>
}

interface OutlineProps {
  book: BookSnapshot
  selectedId?: string
  busy: boolean
  onOpen: (id: string) => void
  onCreate: (volumeId: string | null) => void
  onVolume: (volumeId?: string) => void
  onMoveChapter: (id: string, direction: -1 | 1) => void
  onMoveVolume: (id: string, direction: -1 | 1) => void
}

export function ChapterOutline({ book, selectedId, busy, onOpen, onCreate, onVolume, onMoveChapter, onMoveVolume }: OutlineProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<ChapterStatus | ''>('')
  const archived = Boolean(book.book.archivedAt)
  const groups = [{ id: null, title: '未分卷', position: -1 }, ...book.volumes]
  const needle = query.trim().toLocaleLowerCase()
  const grouped = new Map<string | null, { all: ChapterSummary[]; visible: ChapterSummary[] }>()
  let matchCount = 0
  for (const item of book.chapters) {
    const group = grouped.get(item.volumeId) ?? { all: [], visible: [] }
    group.all.push(item)
    if ((!status || item.status === status) && item.title.toLocaleLowerCase().includes(needle)) { group.visible.push(item); matchCount += 1 }
    grouped.set(item.volumeId, group)
  }
  // 保留父级专注模式使用的 chapterRail 隐藏钩子，内部样式由本模块负责。
  return <aside id="chapter-outline" className={`${styles.chapterRail} ${libraryStyles.outline}`} aria-label="卷章目录" aria-busy={busy}>
    <div className={libraryStyles.railHeading}><span><StudioIcon name="list" size={16} />卷章目录</span><button type="button" onClick={() => onVolume()} disabled={busy || archived} aria-label="新建卷">＋ 卷</button></div>
    <div className={libraryStyles.outlineFilters}><input type="search" aria-label="搜索章节" placeholder="搜索章节" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="按章节状态筛选" value={status} onChange={(event) => setStatus(event.target.value as ChapterStatus | '')}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
    {matchCount === 0 && <p className={libraryStyles.railEmpty}>{book.chapters.length ? '没有符合筛选的章节。' : archived ? '此归档作品还没有章节。' : '还没有章节，先建立第一场。'}</p>}
    {groups.map((group) => {
      const items = grouped.get(group.id)?.visible ?? []
      const siblings = grouped.get(group.id)?.all ?? []
      if (!group.id && items.length === 0 && book.volumes.length > 0) return null
      return <section key={group.id ?? 'ungrouped'} className={libraryStyles.volumeGroup}>
        <div className={libraryStyles.volumeHeading}><strong>{group.title}</strong>{group.id && <div className={libraryStyles.smallActions}>
          <button type="button" onClick={() => onVolume(group.id!)} disabled={busy || archived} aria-label={`重命名${group.title}`}>改名</button>
          <button type="button" onClick={() => onMoveVolume(group.id!, -1)} disabled={busy || archived || group.position === 0} aria-label={`上移${group.title}`}>↑</button>
          <button type="button" onClick={() => onMoveVolume(group.id!, 1)} disabled={busy || archived || group.position === book.volumes.length - 1} aria-label={`下移${group.title}`}>↓</button>
        </div>}</div>
        <ol className={libraryStyles.chapterList}>{items.map((item) => {
          const index = item.id === selectedId ? siblings.findIndex((other) => other.id === item.id) : -1
          return <li key={item.id}><button type="button" className={item.id === selectedId ? libraryStyles.chapterActive : ''} aria-current={item.id === selectedId ? 'page' : undefined} onClick={() => onOpen(item.id)} disabled={busy}>
            <span>{String(item.position + 1).padStart(2, '0')}</span><strong>{item.title}</strong><small>{statusLabels[item.status]} · {item.characterCount.toLocaleString()} 字</small></button>
            {item.id === selectedId && <div className={libraryStyles.chapterMove}><button type="button" onClick={() => onMoveChapter(item.id, -1)} disabled={busy || archived || index === 0}>↑ 上移</button><button type="button" onClick={() => onMoveChapter(item.id, 1)} disabled={busy || archived || index === siblings.length - 1}>↓ 下移</button></div>}
          </li>
        })}</ol>
        {!archived && <button className={libraryStyles.addChapter} type="button" onClick={() => onCreate(group.id)} disabled={busy}>＋ 在此新建章节</button>}
      </section>
    })}
  </aside>
}
