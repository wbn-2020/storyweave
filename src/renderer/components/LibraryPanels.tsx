import { useState } from 'react'
import type { BookSnapshot, BookSummary, ChapterStatus, ChapterSummary } from '../../contracts/api'
import { displayTime, statusLabels } from '../request'
import styles from '../App.module.css'

interface ShelfProps {
  books: BookSummary[]
  busy: boolean
  onOpen: (id: string) => void
  onEdit: (book: BookSummary) => void
  onCreate: () => void
  onImport: () => void
  onRecover: () => void
}

export function BookShelf({ books, busy, onOpen, onEdit, onCreate, onImport, onRecover }: ShelfProps) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const visible = books.filter((item) => Boolean(item.archivedAt) === archived && `${item.title} ${item.genre} ${item.synopsis}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <section className={styles.shelf}>
    <div className={styles.shelfHeader}><div><span className={styles.eyeline}>本地作品</span><h2>我的书架</h2><p>打开一本书，从上次停笔的地方继续。</p></div>
      <div className={styles.actionRow}><button className={styles.button} type="button" onClick={onImport} disabled={busy}>导入文本</button><button className={styles.primaryButton} type="button" onClick={onCreate} disabled={busy}>＋ 新建作品</button></div>
    </div>
    <div className={styles.shelfTools}><input className={styles.searchInput} type="search" aria-label="搜索作品" placeholder="搜索书名、类型或简介" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className={styles.segmented} aria-label="书架范围"><button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>写作中</button><button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>已归档</button></div>
    </div>
    {visible.length === 0 ? <div className={styles.shelfEmpty}><span className={styles.emptyMark}>字</span><h3>{query ? '没有找到这部作品' : archived ? '暂时没有归档作品' : '书架还是空的'}</h3><p>{query ? '试试其他书名或类型。' : archived ? '归档后的作品仍可阅读和导出。' : '建立新作品，或导入已有 TXT / Markdown 稿件。'}</p></div> : <div className={styles.bookGrid}>
      {visible.map((item) => <article className={styles.bookCard} key={item.id}>
        <button className={styles.bookTile} type="button" onClick={() => onOpen(item.id)} disabled={busy}><span className={styles.bookCover}>卷</span><span><strong>{item.title}</strong><small>{item.genre || '未设置类型'} · {displayTime(item.updatedAt)}</small>{item.synopsis && <span className={styles.bookSynopsis}>{item.synopsis}</span>}</span></button>
        <button type="button" className={styles.textButton} onClick={() => onEdit(item)} disabled={busy}>作品资料{item.archivedAt ? ' / 解除归档' : ''}</button>
      </article>)}
    </div>}
    <button className={styles.textButton} type="button" onClick={onRecover} disabled={busy}>找回当前作品库中未登记的作品</button>
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
  return <aside className={styles.chapterRail} aria-label="卷章目录">
    <div className={styles.railHeading}><span>卷章目录</span><button type="button" onClick={() => onVolume()} disabled={busy || archived} aria-label="新建卷">＋卷</button></div>
    <div className={styles.outlineFilters}><input className={styles.searchInput} type="search" aria-label="搜索章节" placeholder="搜索章节" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="按章节状态筛选" value={status} onChange={(event) => setStatus(event.target.value as ChapterStatus | '')}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
    {matchCount === 0 && <p className={styles.railEmpty}>{book.chapters.length ? '没有符合筛选的章节。' : '还没有章节，先建立第一场。'}</p>}
    {groups.map((group) => {
      const items = grouped.get(group.id)?.visible ?? []
      const siblings = grouped.get(group.id)?.all ?? []
      if (!group.id && items.length === 0 && book.volumes.length > 0) return null
      return <section key={group.id ?? 'ungrouped'} className={styles.volumeGroup}>
        <div className={styles.volumeHeading}><strong>{group.title}</strong>{group.id && <div className={styles.smallActions}>
          <button type="button" onClick={() => onVolume(group.id!)} disabled={busy || archived} aria-label={`重命名${group.title}`}>改名</button>
          <button type="button" onClick={() => onMoveVolume(group.id!, -1)} disabled={busy || archived || group.position === 0} aria-label={`上移${group.title}`}>↑</button>
          <button type="button" onClick={() => onMoveVolume(group.id!, 1)} disabled={busy || archived || group.position === book.volumes.length - 1} aria-label={`下移${group.title}`}>↓</button>
        </div>}</div>
        <ol className={styles.chapterList}>{items.map((item) => {
          const index = item.id === selectedId ? siblings.findIndex((other) => other.id === item.id) : -1
          return <li key={item.id}><button type="button" className={item.id === selectedId ? styles.chapterActive : ''} aria-current={item.id === selectedId ? 'page' : undefined} onClick={() => onOpen(item.id)} disabled={busy}>
            <span>{String(item.position + 1).padStart(2, '0')}</span><strong>{item.title}</strong><small>{statusLabels[item.status]} · {item.characterCount.toLocaleString()} 字</small></button>
            {item.id === selectedId && <div className={styles.chapterMove}><button type="button" onClick={() => onMoveChapter(item.id, -1)} disabled={busy || archived || index === 0}>↑ 上移</button><button type="button" onClick={() => onMoveChapter(item.id, 1)} disabled={busy || archived || index === siblings.length - 1}>↓ 下移</button></div>}
          </li>
        })}</ol>
        {!archived && <button className={styles.textButton} type="button" onClick={() => onCreate(group.id)} disabled={busy}>＋ 在此新建章节</button>}
      </section>
    })}
  </aside>
}
