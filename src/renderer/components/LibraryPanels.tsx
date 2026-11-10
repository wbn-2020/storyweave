import { useEffect, useId, useRef, useState } from 'react'
import type { BookSnapshot, BookSummary, ChapterStatus, ChapterSummary, StudioApi } from '../../contracts/api'
import { isBookMediaImage, isBookMediaSnapshot } from '../../contracts/book-media'
import { displayTime, request, statusLabels } from '../request'
import { StudioIcon } from './StudioIcon'
import styles from '../App.module.css'
import libraryStyles from './LibraryPanels.module.css'

interface ShelfProps {
  api?: StudioApi
  workspaceScope?: string
  books: BookSummary[]
  busy: boolean
  onOpen: (id: string) => void
  onEdit: (book: BookSummary) => void
  onCreate: () => void
  onImport: () => void
  onRecover: () => void
}

function CoverSceneSvg({ tone }: { tone: number }) {
  const uid = useId().replace(/:/g, '')
  if (tone === 1) {
    // 远山夜月（青黛山水）
    return <svg className={libraryStyles.coverScene} viewBox="0 0 240 336" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`mSky-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2E4339" /><stop offset=".58" stopColor="#1B2922" /><stop offset="1" stopColor="#0C1411" />
        </linearGradient>
        <radialGradient id={`mMoon-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#E6CFA0" stopOpacity=".4" /><stop offset="1" stopColor="#E6CFA0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="240" height="336" fill={`url(#mSky-${uid})`} />
      <circle cx="72" cy="84" r="56" fill={`url(#mMoon-${uid})`} />
      <circle cx="72" cy="84" r="20" fill="#E5D2A7" opacity=".24" />
      <path d="M0 220 L54 168 L108 206 L168 148 L240 202 L240 336 L0 336 Z" fill="#16241E" opacity=".85" />
      <path d="M0 256 L42 222 L98 250 L152 198 L210 240 L240 224 L240 336 L0 336 Z" fill="#0E1814" />
      <path d="M0 292 Q60 282 120 290 T240 286 L240 336 L0 336 Z" fill="#080F0C" />
      <g stroke="#C8B998" strokeOpacity=".12" strokeWidth="1">
        <path d="M0 242h240M0 274h240" />
      </g>
    </svg>
  }
  if (tone === 2) {
    // 宣纸火漆信封（古典书信）
    return <svg className={libraryStyles.coverScene} viewBox="0 0 240 336" aria-hidden="true" focusable="false">
      <rect width="240" height="336" fill="#E8DDC6" />
      <path d="M0 0 L120 146 L240 0" fill="none" stroke="#8C7456" strokeOpacity=".26" strokeWidth="1.2" />
      <path d="M0 336 L96 204 M240 336 L144 204" fill="none" stroke="#8C7456" strokeOpacity=".2" strokeWidth="1" />
      <circle cx="88" cy="138" r="22" fill="#A83B28" opacity=".22" />
      <circle cx="88" cy="138" r="14" fill="#A83B28" opacity=".32" />
      <g stroke="#7A6548" strokeOpacity=".12" strokeWidth="1">
        <path d="M36 60v216M64 60v216M92 60v216" />
      </g>
    </svg>
  }
  if (tone === 3) {
    // 深空星轨（星图秘境）
    return <svg className={libraryStyles.coverScene} viewBox="0 0 240 336" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`cSky-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#261F3D" /><stop offset=".55" stopColor="#161329" /><stop offset="1" stopColor="#0B0917" />
        </linearGradient>
      </defs>
      <rect width="240" height="336" fill={`url(#cSky-${uid})`} />
      <circle cx="110" cy="176" r="88" fill="none" stroke="#D9C79E" strokeOpacity=".15" strokeDasharray="3 5" />
      <circle cx="110" cy="176" r="56" fill="none" stroke="#D9C79E" strokeOpacity=".22" />
      <circle cx="110" cy="176" r="24" fill="#D9C79E" opacity=".12" />
      <path d="M54 128 L110 176 L154 118 L178 212 L82 236 Z" fill="none" stroke="#E2B47A" strokeOpacity=".32" strokeWidth="1" />
      <circle cx="54" cy="128" r="3.5" fill="#E2B47A" opacity=".8" />
      <circle cx="110" cy="176" r="5" fill="#FFF3D6" opacity=".9" />
      <circle cx="154" cy="118" r="3" fill="#B69PF8" opacity=".75" />
      <circle cx="178" cy="212" r="3.5" fill="#E2B47A" opacity=".7" />
      <circle cx="82" cy="236" r="3" fill="#8AA596" opacity=".8" />
    </svg>
  }
  // 默认 tone === 0：雾港灯塔与月海（ui-v5 经典灯塔封面）
  return <svg className={libraryStyles.coverScene} viewBox="0 0 240 336" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`fogSky-${uid}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#263837" /><stop offset=".52" stopColor="#162424" /><stop offset="1" stopColor="#0B1313" />
      </linearGradient>
      <radialGradient id={`moonGlow-${uid}`} cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="#E6D7B3" stopOpacity=".36" /><stop offset="1" stopColor="#E6D7B3" stopOpacity="0" />
      </radialGradient>
      <linearGradient id={`beamFade-${uid}`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#D8C79E" stopOpacity=".24" /><stop offset="1" stopColor="#D8C79E" stopOpacity="0" />
      </linearGradient>
      <linearGradient id={`seaFade-${uid}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#243634" /><stop offset="1" stopColor="#080F0F" />
      </linearGradient>
    </defs>
    <rect width="240" height="336" fill={`url(#fogSky-${uid})`} />
    <circle cx="176" cy="78" r="64" fill={`url(#moonGlow-${uid})`} />
    <circle cx="176" cy="78" r="24" fill="#DED0AE" opacity=".18" />
    <path d="M70 92 8 54v70l62-18Z" fill={`url(#beamFade-${uid})`} />
    <path d="M70 92 8 108v28l62-30Z" fill={`url(#beamFade-${uid})`} opacity=".7" />
    <path d="M58 92h24l-4-14H62Z" fill="#080E0E" />
    <path d="M62 92h16l6 126H56Z" fill="#091010" />
    <path d="M60 92h20M58 108h24M57 128h26" stroke="#B7A379" strokeOpacity=".26" strokeWidth="1" />
    <rect x="64" y="74" width="12" height="7" fill="#C9B27F" opacity=".7" />
    <path d="M0 218c42-5 72 4 112 0s78 5 128-2v120H0Z" fill={`url(#seaFade-${uid})`} />
    <path d="M0 238c34-4 58 3 92 0s54 3 90 0 40 2 58 0M0 258c48-3 66 3 104 0s66 4 94 1 32 1 42 0" fill="none" stroke="#8EA19A" strokeOpacity=".16" strokeWidth="1" />
    <path d="M0 302h18l7-18 9 11 8-23 12 30h29l10-14 11 14h126v34H0Z" fill="#070D0D" />
  </svg>
}

export function BookCover({ book, featured = false, api, workspaceScope }: { book: BookSummary; featured?: boolean; api?: StudioApi; workspaceScope?: string }) {
  const host = useRef<HTMLSpanElement>(null)
  const [image, setImage] = useState<{ key: string; api: StudioApi; src: string; ready: boolean } | null>(null)
  const key = JSON.stringify([workspaceScope, book.id, book.revision])
  // 在渲染时隔离书库和版本，不等待 effect 清理才隐藏上一部作品的封面。
  const current = image?.key === key && image.api === api ? image : null

  useEffect(() => {
    setImage(null)
    const element = host.current
    if (!api || !workspaceScope || !element) return
    const mediaApi = api
    let active = true, inView = false, started = false
    const visible = () => inView && document.visibilityState !== 'hidden'
    async function load() {
      if (!active || started || !visible()) return
      started = true
      try {
        const listed = await request(() => mediaApi.getBookMedia({ bookId: book.id }))
        if (!active) return
        if (!visible()) { started = false; return }
        if (!listed.ok || !isBookMediaSnapshot(listed.data, book.id) || listed.data.requiresUpgrade || listed.data.bookRevision !== book.revision) return
        const snapshot = listed.data
        const cover = snapshot.items.find((item) => item.id === snapshot.activeCoverId && item.kind === 'cover')
        if (!cover) return
        const read = await request(() => mediaApi.readBookMedia({ bookId: book.id, id: cover.id }))
        if (!active) return
        if (!visible()) { started = false; return }
        if (!read.ok || !isBookMediaImage(read.data, book.id, cover.id)) return
        const picture = read.data
        if (Object.entries(cover).some(([field, value]) => picture[field as keyof typeof cover] !== value)) return
        const bytes = Uint8Array.from(atob(picture.dataBase64), (character) => character.charCodeAt(0))
        const hash = await crypto.subtle.digest('SHA-256', bytes.buffer)
        if (!active) return
        if (!visible()) { started = false; return }
        if (Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') !== picture.sha256) return
        setImage({ key, api: mediaApi, src: `data:${picture.mime};base64,${picture.dataBase64}`, ready: false })
      } catch { /* 封面是辅助展示；读取或校验失败时继续使用现有生成封面。 */ }
    }
    const onVisibility = () => { void load() }
    let observer: IntersectionObserver | undefined
    const checkBounds = () => {
      const bounds = element.getBoundingClientRect()
      inView = bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0
        && bounds.top < window.innerHeight && bounds.left < window.innerWidth
      onVisibility()
    }
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        const entry = entries.at(-1)
        inView = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0)
        onVisibility()
      }, { threshold: 0.01 })
      observer.observe(element)
    } else {
      window.addEventListener('scroll', checkBounds, true)
      window.addEventListener('resize', checkBounds)
      checkBounds()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      observer?.disconnect()
      window.removeEventListener('scroll', checkBounds, true)
      window.removeEventListener('resize', checkBounds)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [api, workspaceScope, book.id, book.revision, key])

  const tone = Array.from(book.id).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4
  return <span ref={host} className={`${libraryStyles.bookCover} ${featured ? libraryStyles.featuredCover : ''}`} data-tone={tone} aria-hidden="true">
    <CoverSceneSvg tone={tone} />
    <span className={libraryStyles.coverFrame} />
    <strong className={libraryStyles.coverTitle}>{book.title}</strong>
    <span className={libraryStyles.coverGenre}>{book.genre || '织章 · 著'}</span>
    <span className={libraryStyles.coverImprint}>STORYWEAVE</span>
    {current && <img key={current.key} className={libraryStyles.coverImage} src={current.src} alt="" decoding="async" data-ready={current.ready}
      onLoad={(event) => {
        const ready = event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalHeight > 0
        setImage((value) => {
          if (!value || value !== current) return value
          return ready ? { ...value, ready: true } : null
        })
      }}
      onError={() => setImage((value) => value === current ? null : value)} />}
  </span>
}

export function BookShelf({ books, busy, api, workspaceScope, onOpen, onEdit, onCreate, onImport, onRecover }: ShelfProps) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const needle = query.trim().toLocaleLowerCase()
  const writingCount = books.filter((item) => !item.archivedAt).length
  const shelfBooks = books.filter((item) => Boolean(item.archivedAt) === archived)
    .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
  const visible = shelfBooks.filter((item) => `${item.title} ${item.genre} ${item.synopsis}`.toLocaleLowerCase().includes(needle))
  const recent = !archived && !needle ? shelfBooks[0] : undefined

  return <section className={libraryStyles.shelf} aria-label="我的书架" aria-busy={busy}>
    <div className={libraryStyles.shelfContent}>
      <header className={libraryStyles.shelfHeader}>
        <div>
          <p className={libraryStyles.eyebrow}><span className={libraryStyles.eyebrowLine} />BOOKSHELF · 个人作品藏书阁</p>
          <h2>故事，<br /><em>从这里继续。</em></h2>
          <p>每一部小说都是一间独立的书房。新建、导入或打开一部作品，接着写下一幕。</p>
        </div>
        <div className={libraryStyles.actionRow}>
          <button className={libraryStyles.button} type="button" onClick={onImport} disabled={busy}><StudioIcon name="folder" size={15} />导入文本</button>
          <button className={libraryStyles.primaryButton} type="button" onClick={onCreate} disabled={busy}><StudioIcon name="pen" size={15} />新建作品</button>
        </div>
      </header>

      {recent && <section className={libraryStyles.recentBook} aria-label="最近更新的作品">
        <div className={libraryStyles.recentCoverWrap}>
          <BookCover book={recent} featured api={api} workspaceScope={workspaceScope} />
          <span className={libraryStyles.coverRibbon}>{recent.genre || '长篇手稿'}</span>
        </div>
        <div className={libraryStyles.recentBody}>
          <span className={libraryStyles.eyebrow}><span className={libraryStyles.eyebrowLine} />RECENTLY UPDATED · 最近落笔</span>
          <h3 title={recent.title}>{recent.title}</h3>
          <p className={libraryStyles.recentSynopsis}>{recent.synopsis || '这部作品还没有填写简介。可在作品资料中留下故事前提，或直接进入正文写作。'}</p>
          <div className={libraryStyles.recentMeta}><span>{recent.genre || '未设置类型'}</span><span>·</span><span>更新于 <time dateTime={recent.updatedAt}>{displayTime(recent.updatedAt)}</time></span></div>
          <div className={libraryStyles.actionRow}>
            <button className={libraryStyles.primaryButton} type="button" onClick={() => onOpen(recent.id)} disabled={busy}>进入写作<StudioIcon name="arrow" size={15} /></button>
            <button className={libraryStyles.button} type="button" onClick={() => onEdit(recent)} disabled={busy}>作品资料与简介</button>
          </div>
        </div>
        <span className={libraryStyles.recentGhost} aria-hidden="true">01</span>
      </section>}

      <div className={libraryStyles.shelfTools}>
        <div className={libraryStyles.scopeTabs} role="group" aria-label="书架范围">
          <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>写作中<span>{writingCount}</span></button>
          <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>已归档<span>{books.length - writingCount}</span></button>
        </div>
        <label className={libraryStyles.searchField}>
          <StudioIcon name="search" size={15} />
          <input type="search" aria-label="搜索作品" placeholder="搜索书名、类型或简介…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <div className={libraryStyles.listHeading}>
        <p role="status">{needle ? `找到 ${visible.length} 部作品` : `共 ${shelfBooks.length} 部作品`}</p>
        <span>按最近更新排序</span>
      </div>

      {visible.length === 0 ? <div className={libraryStyles.shelfEmpty}>
        <span className={libraryStyles.emptyIcon}><StudioIcon name={needle ? 'search' : archived ? 'archive' : 'books'} size={30} /></span>
        <h3>{needle ? '没有找到匹配的作品' : archived ? '还没有归档作品' : books.length ? '暂时没有写作中的作品' : '书架还在等待第一部作品'}</h3>
        <p>{needle ? `当前${archived ? '已归档' : '写作中'}的作品中没有匹配“${query.trim()}”的结果。试试其他书名、类型或简介。` : archived ? '归档后的作品会安静保留在这里。可以打开阅读，也可以在作品资料中解除归档。' : books.length ? '新建一部作品，或从“已归档”中找回想继续写的故事。' : '从一句话故事种子开始建立新作品，或导入电脑里已有的 TXT / Markdown 稿件。'}</p>
        <div className={libraryStyles.actionRow}>
          {needle ? <button className={libraryStyles.button} type="button" onClick={() => setQuery('')}>清空筛选</button> : archived ? <button className={libraryStyles.button} type="button" onClick={() => setArchived(false)}>返回写作中</button> : <>
            <button className={libraryStyles.primaryButton} type="button" onClick={onCreate} disabled={busy}><StudioIcon name="pen" size={15} />新建第一部作品</button>
            <button className={libraryStyles.button} type="button" onClick={onImport} disabled={busy}><StudioIcon name="folder" size={15} />导入已有稿件</button>
          </>}
        </div>
      </div> : <div className={libraryStyles.bookGrid}>
        {visible.map((item) => <article className={libraryStyles.bookCard} key={item.id}>
          <button className={libraryStyles.bookTile} type="button" onClick={() => onOpen(item.id)} disabled={busy} aria-label={`打开${item.title}${item.archivedAt ? '（已归档）' : ''}`}>
            <BookCover book={item} api={api} workspaceScope={workspaceScope} />
            <span className={libraryStyles.bookInfo}>
              <strong className={libraryStyles.bookTitle} title={item.title}>{item.title}</strong>
              <span className={libraryStyles.bookGenre}>{item.genre || '长篇创作手稿'}</span>
              {item.synopsis && <span className={libraryStyles.bookSynopsis}>{item.synopsis}</span>}
              <span className={libraryStyles.bookUpdated}>更新于 <time dateTime={item.updatedAt}>{displayTime(item.updatedAt)}</time></span>
            </span>
          </button>
          <button type="button" className={libraryStyles.bookDetails} onClick={() => onEdit(item)} disabled={busy} aria-label={`${item.title}：作品资料${item.archivedAt ? ' / 解除归档' : ''}`}>作品资料{item.archivedAt ? ' / 解除归档' : ''}<StudioIcon name="chevron" size={13} /></button>
        </article>)}
      </div>}

      <footer className={libraryStyles.shelfFooter}>
        <span>LOCAL ARCHIVE · 本地书库存储</span>
        <button className={libraryStyles.textButton} type="button" onClick={onRecover} disabled={busy}><StudioIcon name="history" size={15} />找回未登记的作品</button>
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
  return <aside id="chapter-outline" className={`${styles.chapterRail} ${libraryStyles.outline}`} aria-label="卷章目录" aria-busy={busy}>
    <div className={libraryStyles.railHeading}>
      <div>
        <span className={libraryStyles.railEyebrow}>MANUSCRIPT</span>
        <strong>章节目录</strong>
      </div>
      <button type="button" onClick={() => onVolume()} disabled={busy || archived} aria-label="新建卷">＋ 卷</button>
    </div>
    <div className={libraryStyles.outlineFilters}>
      <input type="search" aria-label="搜索章节" placeholder="搜索章节…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="按章节状态筛选" value={status} onChange={(event) => setStatus(event.target.value as ChapterStatus | '')}>
        <option value="">全部状态</option>
        {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
    </div>
    {matchCount === 0 && <p className={libraryStyles.railEmpty}>{book.chapters.length ? '没有符合筛选的章节。' : archived ? '此归档作品还没有章节。' : '还没有章节，先建立第一场。'}</p>}
    {groups.map((group) => {
      const items = grouped.get(group.id)?.visible ?? []
      const siblings = grouped.get(group.id)?.all ?? []
      if (!group.id && items.length === 0 && book.volumes.length > 0) return null
      return <section key={group.id ?? 'ungrouped'} className={libraryStyles.volumeGroup}>
        <div className={libraryStyles.volumeHeading}>
          <strong>{group.title}</strong>
          {group.id && <div className={libraryStyles.smallActions}>
            <button type="button" onClick={() => onVolume(group.id!)} disabled={busy || archived} aria-label={`重命名${group.title}`}>改名</button>
            <button type="button" onClick={() => onMoveVolume(group.id!, -1)} disabled={busy || archived || group.position === 0} aria-label={`上移${group.title}`}>↑</button>
            <button type="button" onClick={() => onMoveVolume(group.id!, 1)} disabled={busy || archived || group.position === book.volumes.length - 1} aria-label={`下移${group.title}`}>↓</button>
          </div>}
        </div>
        <ol className={libraryStyles.chapterList}>{items.map((item) => {
          const index = item.id === selectedId ? siblings.findIndex((other) => other.id === item.id) : -1
          return <li key={item.id}>
            <button type="button" className={item.id === selectedId ? libraryStyles.chapterActive : ''} aria-current={item.id === selectedId ? 'page' : undefined} onClick={() => onOpen(item.id)} disabled={busy}>
              <span>{String(item.position + 1).padStart(2, '0')}</span>
              <strong>{item.title}</strong>
              <small><i className={libraryStyles.statusDot} data-status={item.status} />{statusLabels[item.status]} · {item.characterCount.toLocaleString()} 字</small>
            </button>
            {item.id === selectedId && <div className={libraryStyles.chapterMove}>
              <button type="button" onClick={() => onMoveChapter(item.id, -1)} disabled={busy || archived || index === 0}>↑ 上移</button>
              <button type="button" onClick={() => onMoveChapter(item.id, 1)} disabled={busy || archived || index === siblings.length - 1}>↓ 下移</button>
            </div>}
          </li>
        })}</ol>
        {!archived && <button className={libraryStyles.addChapter} type="button" onClick={() => onCreate(group.id)} disabled={busy}>＋ 新建章节</button>}
      </section>
    })}
  </aside>
}
