import type { BookSnapshot, StudioApi } from '../../contracts/api'
import type { LivingSnapshot } from '../../contracts/living'
import { displayTime } from '../request'
import { BookCover } from './LibraryPanels'
import { CreativeSpine, type CreativeDomain } from './CreativeSpine'
import { StudioIcon, type StudioIconName } from './StudioIcon'
import ui from './stellar/stellar.module.css'
import styles from './StudioPages.module.css'

export type BookDestination = 'write' | 'living' | 'forge' | 'galaxy' | 'workbench' | 'knowledge' | 'timeline' | 'story'
  | 'notes' | 'media' | 'reader' | 'memory' | 'aiMemoryTasks' | 'aiSummary' | 'export' | 'bookDetails' | 'calendar' | 'world' | 'abilities' | 'weave'
export const BOOK_DESTINATIONS: readonly { id: BookDestination; label: string; icon: StudioIconName }[] = [
  { id: 'write', label: '写作台', icon: 'pen' }, { id: 'living', label: '大纲沙盘', icon: 'compass' },
  { id: 'forge', label: '角色与世界', icon: 'user' }, { id: 'galaxy', label: '记忆星图', icon: 'galaxy' },
  { id: 'workbench', label: '章节规划与审稿', icon: 'list' }, { id: 'knowledge', label: '故事设定', icon: 'globe' },
  { id: 'timeline', label: '故事年表', icon: 'timeline' }, { id: 'story', label: '事件与伏笔', icon: 'workflow' },
  { id: 'notes', label: '素材与便笺', icon: 'notes' }, { id: 'media', label: '封面与立绘', icon: 'image' },
  { id: 'reader', label: '沉浸阅读', icon: 'read' }, { id: 'memory', label: '长篇记忆检索', icon: 'search' },
  { id: 'aiMemoryTasks', label: '逐章整理', icon: 'spark' }, { id: 'aiSummary', label: '全书汇总', icon: 'layers' },
  { id: 'export', label: '导出作品', icon: 'export' }, { id: 'bookDetails', label: '作品资料', icon: 'settings' },
  { id: 'calendar', label: '创作记录', icon: 'chart' },
  { id: 'world', label: '世界星域', icon: 'globe' }, { id: 'abilities', label: '境界与战力', icon: 'bolt' },
  { id: 'weave', label: '织星系统', icon: 'spark' },
]
const destinationDescriptions = ['开始创作你的故事', '规划故事结构', '构建鲜活的世界', '管理灵感与设定']

export function BookOverview({ api, scope, book, snapshot, reading, error, busy, onNavigate, onChapter, onDomain, onReload }: {
  api?: StudioApi; scope?: string; book: BookSnapshot; snapshot: LivingSnapshot | null; busy: boolean
  onNavigate: (destination: BookDestination) => void; onChapter: (id: string) => void
  reading: boolean; error: string | null; onDomain: (domain: CreativeDomain) => void; onReload: () => void
}) {
  const words = book.chapters.reduce((n, item) => n + item.characterCount, 0)
  const finalized = book.chapters.filter((item) => item.status === 'finalized').length
  const recent = [...book.chapters].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4)
  // 读取中、失败或旧格式的空快照不代表没有待办；章节审稿仍可按已读取目录展示。
  const currentSnapshot = !reading && !error && snapshot && !snapshot.requiresUpgrade ? snapshot : null
  const stale = currentSnapshot?.outlines.filter((item) => item.stale) ?? []
  const reviews = book.chapters.filter((item) => item.status === 'review')
  const pending = [
    ...stale.map((item) => ({ id: `outline:${item.id}`, title: item.fields.title, detail: '大纲依赖已变化，待复核', destination: 'living' as const, tone: 'warning' })),
    ...reviews.map((item) => ({ id: `review:${item.id}`, title: item.title, detail: '审稿待处理', destination: 'workbench' as const, tone: 'accent' })),
  ]
  const pendingStatus = reading ? '正在核对创作状态，当前仅列出已读取章节中的审稿待办。'
    : error ? `创作状态读取未完成：${error} 当前仅列出已读取章节中的审稿待办。`
      : snapshot?.requiresUpgrade ? '本书尚未启用演进大纲，大纲待办未知。可前往大纲沙盘核对备份升级说明。'
        : !snapshot ? '创作状态尚未读取，当前仅列出已读取章节中的审稿待办。' : null
  return <section className={styles.page} aria-label="作品总览"><div className={styles.pageInner}>
    <header className={styles.overviewHeading}><h1>五域星轨</h1><span className={ui.chip} data-tone={book.book.archivedAt ? 'warning' : 'accent'}>{book.book.archivedAt ? '归档 · 只读' : book.book.lifecycle === 'finished' ? '已完结' : '创作中'}</span></header>
    <CreativeSpine snapshot={snapshot} reading={reading} error={error} disabled={busy} onNavigate={onDomain} onReload={onReload} variant="orbit" />
    <div className={styles.overview}>
      <section className={styles.bookIdentity} aria-label={`《${book.book.title}》作品资料`}>
        <button type="button" className={styles.identityCover} disabled={busy} onClick={() => onNavigate('bookDetails')} aria-label={`查看《${book.book.title}》作品资料`} title={book.book.title}><BookCover api={api} workspaceScope={scope} book={book.book} /></button>
        {book.chapters.length > 0 && <div className={styles.identityProgress} title={`已定稿 ${finalized} / ${book.chapters.length} 章`}><progress className={ui.progress} value={finalized} max={book.chapters.length} aria-label={`定稿章节进度 ${finalized} / ${book.chapters.length}`} /><strong>{Math.round(finalized / book.chapters.length * 100)}%</strong></div>}
        <dl><div><dt><StudioIcon name="notes" size={20} /><span>累计字数</span></dt><dd>{words.toLocaleString()} 字</dd></div>
          <div><dt><StudioIcon name="read" size={20} /><span>章节</span></dt><dd>{book.chapters.length} 章 · {book.volumes.length} 卷</dd></div>
          <div title="按每分钟 500 字估算"><dt><StudioIcon name="clock" size={20} /><span>约需阅读</span></dt><dd>预计阅读 {Math.ceil(words / 500)} 分钟</dd></div></dl>
        <details className={styles.identityDetails}><summary>作品资料</summary><p>{book.book.genre || '未设置题材'}</p><p>{book.book.synopsis || '尚未填写简介'}</p><button className={ui.button} type="button" disabled={busy} onClick={() => onNavigate('bookDetails')}>编辑资料</button></details>
      </section>
      <div className={styles.destinations}>{BOOK_DESTINATIONS.slice(0, 4).map((item, index) => <button className={styles.destination} key={item.id} type="button" disabled={busy} onClick={() => onNavigate(item.id)}><StudioIcon name={item.icon} size={48} /><strong>{item.label}</strong><span>{destinationDescriptions[index]}</span><StudioIcon name="chevron" size={20} /></button>)}</div>
      <aside className={styles.overviewQueue} aria-label="待处理事项"><h2><StudioIcon name="spark" size={20} />待处理<span className={ui.chip} aria-label={currentSnapshot ? `已读取的大纲与章节审稿待办 ${pending.length} 项` : `已知章节审稿待办 ${reviews.length} 项，大纲待办未确认`}>{currentSnapshot ? pending.length : pending.length ? `已知 ${pending.length}` : '待核对'}</span></h2><ul className={styles.overviewQueueList}>
        {pending.slice(0, 4).map((item) => <li key={item.id}><button type="button" disabled={busy} onClick={() => onNavigate(item.destination)}><i data-tone={item.tone} /><span><strong>{item.title}</strong><small>{item.detail}</small></span><StudioIcon name="chevron" size={20} /></button></li>)}
      </ul>{pendingStatus ? <div className={styles.overviewQueueStatus} data-tone={!reading && error ? 'danger' : undefined} role={!reading && error ? 'alert' : 'status'}>
        <p>{pendingStatus}</p>
        {!reading && !error && snapshot?.requiresUpgrade
          ? <button className={ui.ghost} type="button" disabled={busy} onClick={() => onNavigate('living')}>查看大纲启用说明<StudioIcon name="arrow" size={16} /></button>
          : <button className={ui.ghost} type="button" disabled={busy || reading} aria-busy={reading} onClick={onReload}>{reading ? '核对中…' : '重新读取创作状态'}<StudioIcon name="refresh" size={16} /></button>}
      </div> : pending.length === 0 && <p>暂无待处理事项</p>}
        {pending.length > 4 && <nav className={styles.overviewQueueActions} aria-label="全部待处理事项入口">
          {stale.length > 0 && <button className={ui.ghost} type="button" disabled={busy} onClick={() => onNavigate('living')}>查看大纲待复核（{stale.length}）<StudioIcon name="arrow" size={16} /></button>}
          {reviews.length > 0 && <button className={ui.ghost} type="button" disabled={busy} onClick={() => onNavigate('workbench')}>查看章节规划与审稿（{reviews.length}）<StudioIcon name="arrow" size={16} /></button>}
        </nav>}
      </aside>
    </div>
    <section className={styles.activity}><h2><StudioIcon name="chart" size={20} />最近动态</h2><div className={styles.activityList}>{recent.map((item) => <button key={item.id} type="button" disabled={busy} onClick={() => onChapter(item.id)}><time dateTime={item.updatedAt}>{displayTime(item.updatedAt)}</time><strong>{item.title}</strong><span>{item.characterCount.toLocaleString()} 字</span></button>)}</div>{!recent.length && <p className={ui.muted}>暂无正文章节</p>}</section>
    <details className={styles.overviewTools}><summary>更多作品工具</summary><nav className={styles.toolLinks} aria-label="作品工具">{BOOK_DESTINATIONS.slice(4).map((item) => <button className={ui.ghost} key={item.id} type="button" disabled={busy} onClick={() => onNavigate(item.id)}><StudioIcon name={item.icon} size={16} />{item.label}</button>)}</nav></details>
  </div></section>
}
