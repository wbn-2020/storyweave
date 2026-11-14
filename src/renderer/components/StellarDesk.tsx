import { useEffect, useState } from 'react'
import type { BookSnapshot, StudioApi, WorkspaceSnapshot } from '../../contracts/api'
import { isCalendarSnapshot, type CalendarSnapshot } from '../../contracts/writing-calendar'
import { lastWritingBook, writingPosition } from '../writing-location'
import { displayTime, request, statusLabels } from '../request'
import { BookCover } from './LibraryPanels'
import { StudioIcon } from './StudioIcon'
import { GenrePicker, ProgressRing } from './stellar/Genres'
import { StellarEmpty } from './stellar/StellarEmpty'
import { useBookPreview } from './stellar/useBookPreview'
import { StellarBookCard } from './StellarShelf'
import { CalendarYearHeatmap } from './CalendarYearHeatmap'
import ui from './stellar/stellar.module.css'
import styles from './StudioPages.module.css'

interface Props {
  api?: StudioApi; workspace: WorkspaceSnapshot; currentBook: BookSnapshot | null; busy: boolean
  onOpenWorkspace: () => void; onCreate: (genre?: string) => void; onImport: () => void; onShelf: () => void
  onRecover: () => void; onPreferences: () => void; onOverview: (bookId: string) => void
  onOpenBook: (bookId: string, chapterId?: string) => void
  onTool: (bookId: string, tool: 'calendar' | 'workbench' | 'living' | 'forge' | 'notes') => void
}

export function StellarDesk({ api, workspace, currentBook, busy, onOpenWorkspace, onCreate, onImport, onShelf,
  onRecover, onPreferences, onOverview, onOpenBook, onTool }: Props) {
  const [excerpt, setExcerpt] = useState<{ key: string; text: string } | null>(null)
  const [calendar, setCalendar] = useState<{ key: string; snapshot?: CalendarSnapshot; error?: string } | null>(null)
  const [calendarAttempt, setCalendarAttempt] = useState(0)
  const scope = workspace.rootPath ? JSON.stringify([workspace.rootPath, workspace.recoveryScope]) : undefined
  const books = [...workspace.books].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const featured = books.find((item) => item.id === currentBook?.book.id)
    ?? books.find((item) => item.id === lastWritingBook(workspace.rootPath))
    ?? books.find((item) => !item.archivedAt) ?? books[0]
  const preview = useBookPreview(api, scope, featured, currentBook)
  const book = preview.snapshot
  const chapters = [...(book?.chapters ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const chapter = chapters.find((item) => item.id === writingPosition(workspace.rootPath, featured?.id ?? '')?.chapterId) ?? chapters[0]
  const excerptKey = JSON.stringify([scope, featured?.id, chapter?.id, chapter?.revisionId])
  const blocked = busy || !api
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const calendarKey = JSON.stringify([scope, featured?.id, featured?.revision, month, calendarAttempt])
  const currentCalendar = calendar?.key === calendarKey ? calendar : null
  const day = currentCalendar?.snapshot?.today
  const activity = currentCalendar?.snapshot?.activity ?? []
  const todayAdded = day ? activity.filter((item) => item.date === day).reduce((total, item) => total + item.added, 0) : null
  const events = currentCalendar?.snapshot?.events ?? []
  const todayTarget = events.filter((item) => item.date === day && item.kind === 'writing').reduce((total, item) => total + (item.targetCharacters ?? 0), 0)
  const percent = chapter?.targetCharacters ? Math.min(100, Math.round(chapter.characterCount / chapter.targetCharacters * 100)) : null
  const continueWriting = () => !workspace.rootPath ? onOpenWorkspace() : featured ? onOpenBook(featured.id, chapter?.id) : onCreate()

  useEffect(() => {
    if (!api || !featured || !chapter || !scope) return
    let active = true
    void request(() => api.readChapter({ bookId: featured.id, chapterId: chapter.id })).then((result) => {
      if (active && result.ok && result.data.bookId === featured.id && result.data.id === chapter.id && result.data.revisionId === chapter.revisionId) {
        setExcerpt({ key: excerptKey, text: result.data.plainText.slice(-220) })
      }
    })
    return () => { active = false }
  }, [api, scope, featured?.id, chapter?.id, chapter?.revisionId, excerptKey])

  useEffect(() => {
    if (!api || !scope || !featured) return
    let active = true
    void request(() => api.getWritingCalendar({ bookId: featured.id, month })).then((result) => {
      if (!active) return
      setCalendar(!result.ok ? { key: calendarKey, error: result.error.message }
        : !isCalendarSnapshot(result.data, featured.id, month) || result.data.bookRevision < featured.revision
          ? { key: calendarKey, error: '日历版本不匹配，请刷新。' }
          : result.data.requiresUpgrade ? { key: calendarKey, error: '请在创作日历中完成作品升级。' }
            : { key: calendarKey, snapshot: result.data })
    })
    return () => { active = false }
  }, [api, scope, featured?.id, featured?.revision, month, calendarKey])

  return <section className={styles.page} aria-labelledby="stellar-desk-title">
    <div className={styles.pageInner}>
      <header className={styles.heading}>
        <div><h1 id="stellar-desk-title">今日书桌</h1><time>{now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</time></div>
        <div className={ui.actions}><button className={ui.button} type="button" disabled={blocked} onClick={onImport}><StudioIcon name="folder" size={16} />导入作品</button><button className={ui.primary} type="button" disabled={blocked} onClick={() => onCreate()}><StudioIcon name="plus" size={16} />新建作品</button></div>
      </header>
      {!api && <p className={ui.error} role="status">本地服务未连接，请从桌面客户端重新打开作品库。</p>}
      <div className={styles.desk}>
        <div className={styles.mainColumn}>
          <section className={styles.continuePanel} aria-label="继续创作">
            <div className={styles.sectionHead}><h2><StudioIcon name="pen" size={20} />继续创作</h2>{featured && <button className={ui.ghost} type="button" disabled={blocked} onClick={() => onOverview(featured.id)}>作品总览<StudioIcon name="chevron" size={16} /></button>}</div>
            <div className={styles.continue}>
              {featured ? <BookCover book={featured} api={api} workspaceScope={scope} /> : <StudioIcon name="books" size={48} />}
              <div className={styles.continueBody}>
                <h2>{featured?.title ?? '写下第一个故事'}</h2>
                {preview.loading ? <div role="status" aria-label="正在读取章节"><div className={ui.skeleton} /><p>正在读取章节…</p></div> : <h3>{chapter ? `第 ${chapter.position + 1} 章 · ${chapter.title}` : featured ? '尚未建立章节' : '从一句话开始'}</h3>}
                <p>{excerpt?.key === excerptKey && excerpt.text ? excerpt.text : featured?.synopsis || (workspace.rootPath ? '你的故事，会从这里展开。' : '选择本地作品库，开启创作。')}</p>
                {featured && <span className={ui.muted}>上次更新 · {displayTime(featured.updatedAt)}</span>}
                {preview.error && <div className={ui.error} role="alert">{preview.error}<button className={ui.button} type="button" onClick={preview.retry}>重试</button></div>}
              </div>
              <div className={styles.continueProgress}>
                {percent !== null && <><ProgressRing value={percent} label="本章字数目标" /><span>本章目标</span></>}
                <button className={ui.primary} type="button" disabled={blocked} onClick={continueWriting}>{!workspace.rootPath ? '选择作品库' : featured?.archivedAt ? '打开作品' : featured ? '继续写下去' : '新建作品'}<StudioIcon name="arrow" size={16} /></button>
              </div>
            </div>
          </section>
          <section className={styles.deskGenres} aria-label="开新故事"><div className={styles.sectionHead}><h2>开新故事<StudioIcon name="spark" size={16} /></h2></div><GenrePicker disabled={blocked} onSelect={onCreate} /></section>
          <section aria-label="我的作品">
            <div className={styles.sectionHead}><h2>我的作品 <span className={ui.muted}>{books.length}</span></h2><button className={ui.ghost} type="button" disabled={blocked} onClick={onShelf}>全部作品<StudioIcon name="chevron" size={16} /></button></div>
            {books.length ? <div className={styles.bookGrid}>{books.slice(0, 3).map((item) => <StellarBookCard key={`${scope}:${item.id}`} api={api} scope={scope} book={item} busy={blocked} onOpen={onOverview} onWrite={onOpenBook} />)}</div>
              : <StellarEmpty icon="read" title="从一句话开始" description="书架还在等待第一部作品" hint={workspace.rootPath ? '开始你的第一个故事吧' : '选择本地作品库，开启创作。'}>
                <button className={ui.primary} type="button" disabled={blocked} onClick={() => onCreate()}><StudioIcon name="plus" size={20} />新建作品</button><button className={ui.button} type="button" disabled={blocked} onClick={onImport}>导入稿件</button>
              </StellarEmpty>}
          </section>
          {book && <details className={styles.recentChapters}>
            <summary>最近章节 · {book.chapters.length} 章</summary>
            <div className={styles.sectionHead}><h2>最近章节</h2><span className={ui.muted}>{book.chapters.length} 章 · {book.chapters.reduce((n, item) => n + item.characterCount, 0).toLocaleString()} 字</span></div>
            {chapters.slice(0, 5).map((item) => <button className={styles.chapterRow} key={item.id} type="button" disabled={blocked} onClick={() => onOpenBook(book.book.id, item.id)}><span>第 {item.position + 1} 章</span><strong>{item.title}</strong><span>{item.characterCount.toLocaleString()} 字</span><span>{statusLabels[item.status]}</span></button>)}
          </details>}
        </div>
        <aside className={styles.sideColumn} aria-label="创作记录与待办">
          <section className={styles.sideSection}>
            <h2><StudioIcon name="compass" size={18} />今日目标</h2>
            {currentCalendar?.error ? <div className={ui.error} role="alert">{currentCalendar.error}<button className={ui.button} type="button" onClick={() => setCalendarAttempt((value) => value + 1)}>重试</button></div>
              : <div className={styles.goal}>
                {todayTarget > 0 && todayAdded !== null && <ProgressRing value={Math.min(100, Math.round(todayAdded / todayTarget * 100))} label="今日新增字数目标" />}
                <div><strong>{todayAdded?.toLocaleString() ?? '—'}</strong><small>{todayTarget ? `/ ${todayTarget.toLocaleString()} 字` : featured ? '今日新增字数' : '尚无写作记录'}</small></div>
              </div>}
            {featured && <button className={ui.ghost} type="button" disabled={blocked} onClick={() => onTool(featured.id, 'calendar')}>{todayTarget ? '查看创作记录' : '设置今日目标'}<StudioIcon name="arrow" size={16} /></button>}
          </section>
          {api && featured && currentCalendar?.snapshot && <section className={styles.sideSection}>
            <CalendarYearHeatmap key={calendarKey} api={api} bookId={featured.id} bookRevision={currentCalendar.snapshot.bookRevision}
              month={month} today={currentCalendar.snapshot.today} disabled={blocked} compact />
          </section>}
          <section className={styles.sideSection}>
            <h2><StudioIcon name="list" size={18} />今日待办</h2>
            <ul className={styles.queue}>
              {events.filter((item) => !item.done && item.date <= (day ?? '')).slice(0, 4).map((item) => <li key={item.id}><button type="button" disabled={blocked} onClick={() => featured && onTool(featured.id, 'calendar')}><StudioIcon name="calendar" size={16} /><span>{item.title}<small>{item.date}</small></span><StudioIcon name="chevron" size={16} /></button></li>)}
              {chapters.filter((item) => item.status === 'review').slice(0, 3).map((item) => <li key={item.id}><button type="button" disabled={blocked} onClick={() => featured && onTool(featured.id, 'workbench')}><StudioIcon name="read" size={16} /><span>{item.title}<small>待审稿</small></span><StudioIcon name="chevron" size={16} /></button></li>)}
            </ul>
            {!chapters.some((item) => item.status === 'review') && !events.some((item) => !item.done && item.date <= (day ?? '')) && <p>{featured && !currentCalendar ? '正在读取待办…' : currentCalendar?.error ? '日程待办尚未读取' : '暂无待处理事项'}</p>}
          </section>
          <details className={styles.sideUtility}><summary><StudioIcon name="folder" size={16} />本地作品库</summary><p>{workspace.rootPath ?? '尚未选择作品库'}</p><div className={ui.actions}><button className={ui.button} type="button" disabled={blocked} onClick={onOpenWorkspace}>切换目录</button><button className={ui.button} type="button" disabled={blocked} onClick={onRecover}>备份恢复</button><button className={ui.ghost} type="button" disabled={busy} onClick={onPreferences}>外观设置</button></div></details>
        </aside>
      </div>
    </div>
  </section>
}
