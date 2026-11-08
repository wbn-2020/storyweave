import { useEffect, useMemo, useState } from 'react'
import type { BookSnapshot, StudioApi, WorkspaceSnapshot } from '../../contracts/api'
import { displayTime, request, statusLabels } from '../request'
import { StudioIcon, type StudioIconName } from './StudioIcon'
import { BookCover } from './LibraryPanels'
import styles from './WelcomeWorkspace.module.css'
import { lastWritingBook, writingPosition } from '../writing-location'

export type WorkspaceTool = 'knowledge' | 'galaxy' | 'timeline' | 'notes' | 'workbench'

interface Props {
  api?: StudioApi
  workspace: WorkspaceSnapshot
  currentBook: BookSnapshot | null
  busy: boolean
  onOpenWorkspace: () => void
  onCreate: () => void
  onImport: () => void
  onShelf: () => void
  onRecover: () => void
  onPreferences: () => void
  onOpenBook: (bookId: string, chapterId?: string) => void
  onTool: (bookId: string, tool: WorkspaceTool) => void
}

type BookLoad = { key: string } & (
  | { status: 'loading' }
  | { status: 'ready'; snapshot: BookSnapshot }
  | { status: 'error'; message: string }
)

const tools: { id: WorkspaceTool; title: string; description: string; icon: StudioIconName; action: string }[] = [
  { id: 'workbench', title: '规划与审稿', description: '场景、大纲、审稿与写作目标', icon: 'list', action: '打开创作规划' },
  { id: 'knowledge', title: '故事设定', description: '人物、地点与世界规则', icon: 'read', action: '进入故事设定' },
  { id: 'galaxy', title: '关系星海', description: '人物关系与故事线索', icon: 'galaxy', action: '打开关系星海' },
  { id: 'timeline', title: '故事时间线', description: '事件顺序与前因后果', icon: 'timeline', action: '查看故事时间线' },
  { id: 'notes', title: '素材与笔记', description: '随时记下新的灵感', icon: 'notes', action: '打开素材与笔记' },
]

function updatedTime(value: string) { return Date.parse(value) || 0 }
function number(value: number) { return value.toLocaleString('zh-CN') }

export function WelcomeWorkspace({ api, workspace, currentBook, busy, onOpenWorkspace, onCreate, onImport, onShelf, onRecover, onPreferences, onOpenBook, onTool }: Props) {
  const [load, setLoad] = useState<BookLoad | null>(null)
  const [attempt, setAttempt] = useState(0)
  const hasWorkspace = Boolean(workspace.rootPath)
  const blocked = busy || !api
  const recentBooks = useMemo(() => workspace.rootPath
    ? [...workspace.books].sort((left, right) => updatedTime(right.updatedAt) - updatedTime(left.updatedAt))
    : [], [workspace.rootPath, workspace.books])
  const currentSummary = currentBook && recentBooks.find((item) => item.id === currentBook.book.id)
  const selectedBook = currentSummary || recentBooks.find((item) => item.id === lastWritingBook(workspace.rootPath)) || recentBooks.find((item) => !item.archivedAt) || recentBooks[0]
  const selectedId = selectedBook?.id
  // 只有仍属于当前作品库、且不早于书架版本的快照可直接复用，避免回到首页后重复读取。
  const suppliedBook = currentBook && currentSummary && currentBook.book.revision >= currentSummary.revision ? currentBook : null
  const requestKey = JSON.stringify([workspace.rootPath, workspace.recoveryScope, selectedId, selectedBook?.revision, selectedBook?.updatedAt, attempt])

  useEffect(() => {
    if (!api || !workspace.rootPath || !selectedId || suppliedBook || busy) return
    let active = true
    setLoad({ key: requestKey, status: 'loading' })
    // 首页只取当前一本书的章节摘要。目录切换、版本变化或组件离开后，旧请求不能写回。
    void request(() => api.getBook({ bookId: selectedId })).then((result) => {
      if (!active) return
      if (!result.ok) {
        setLoad({ key: requestKey, status: 'error', message: result.error.message })
      } else if (result.data.book.id !== selectedId) {
        setLoad({ key: requestKey, status: 'error', message: '读取到的作品与当前选择不一致，请重试。' })
      } else {
        setLoad({ key: requestKey, status: 'ready', snapshot: result.data })
      }
    })
    return () => { active = false }
  }, [api, workspace.rootPath, selectedId, suppliedBook, requestKey, busy])

  // key 在渲染时先隔离旧目录结果，不等待 effect 清理才隐藏旧统计。
  const currentLoad = load?.key === requestKey ? load : null
  const snapshot = suppliedBook || (api && currentLoad?.status === 'ready' ? currentLoad.snapshot : null)
  const featuredBook = snapshot?.book ?? selectedBook
  const loading = Boolean(selectedBook && !snapshot && api && currentLoad?.status !== 'error')
  const loadError = selectedBook && !snapshot
    ? !api ? '桌面连接暂不可用，请在客户端中重新打开作品库。' : currentLoad?.status === 'error' ? currentLoad.message : null
    : null
  const emptyLibrary = hasWorkspace && recentBooks.length === 0
  const recentChapters = useMemo(() => snapshot
    ? [...snapshot.chapters].sort((left, right) => updatedTime(right.updatedAt) - updatedTime(left.updatedAt) || left.position - right.position).slice(0, 3)
    : [], [snapshot])
  const writingCount = hasWorkspace ? recentBooks.filter((item) => !item.archivedAt).length : null
  const chapterCount = snapshot ? snapshot.chapters.length : emptyLibrary ? 0 : null
  const characterCount = snapshot ? snapshot.chapters.reduce((total, chapter) => total + chapter.characterCount, 0) : emptyLibrary ? 0 : null
  const finalizedCount = snapshot ? snapshot.chapters.filter((chapter) => chapter.status === 'finalized').length : emptyLibrary ? 0 : null
  const statistics = [
    { label: '写作中作品', value: writingCount, hint: '当前作品库', icon: 'books' as const },
    { label: '当前作品章节', value: chapterCount, hint: '按卷章目录统计', icon: 'list' as const },
    { label: '正文总字符', value: characterCount, hint: '当前作品 · 已保存正文', icon: 'pen' as const },
    { label: '已定稿章节', value: finalizedCount, hint: '当前作品 · 作者定稿', icon: 'check' as const },
  ]
  const today = new Date()
  const dateValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const workspaceName = workspace.rootPath?.split(/[\\/]/).filter(Boolean).pop() || '本地作品库'
  const canOpenTools = Boolean(snapshot) || !selectedBook
  const retry = () => setAttempt((value) => value + 1)
  const openFeatured = () => {
    if (!hasWorkspace) onOpenWorkspace()
    else if (featuredBook) onOpenBook(featuredBook.id)
    else onCreate()
  }

  return <section className={styles.welcome} aria-labelledby="workspace-home-title">
    <div className={styles.content}>
      <header className={styles.heading}>
        <div className={styles.headingText}>
          <h2 id="workspace-home-title">今日工作台</h2>
          <time dateTime={dateValue}>{today.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</time>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.secondaryButton} type="button" onClick={onImport} disabled={blocked}><StudioIcon name="folder" size={16} />导入文本</button>
          <button className={featuredBook ? styles.secondaryButton : styles.primaryButton} type="button" onClick={onCreate} disabled={blocked}><StudioIcon name="pen" size={16} />新建作品</button>
        </div>
      </header>
      {!api && <p className={styles.connectionNotice} role="status">桌面连接暂不可用，作品操作将在连接恢复后开放。</p>}

      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <section className={styles.hero} aria-label={featuredBook ? '当前作品' : '开始创作'}>
            <div className={styles.heroCover} aria-hidden="true">{featuredBook ? <BookCover book={featuredBook} featured /> : <span className={styles.emptyCover}><StudioIcon name="pen" size={24} /><strong>你的故事<br />从此开始</strong><small>织章 · 创作手稿</small></span>}</div>
            <div className={styles.heroContent}>
              <span className={styles.heroLabel}><StudioIcon name={featuredBook?.archivedAt ? 'archive' : 'pen'} size={15} />{featuredBook ? featuredBook.archivedAt ? '作品回顾 · 已归档' : '继续创作' : '你的创作空间'}</span>
              <h3 title={featuredBook?.title}>{featuredBook?.title || '开始一部新作品'}</h3>
              <p className={styles.heroSynopsis}>{featuredBook?.synopsis || (featuredBook ? '每一段文字，都让故事更近一步。' : '给灵感一个位置，让文字慢慢长成故事。')}</p>
              {featuredBook && recentChapters.length ? <p className={styles.heroChapter}><span>最近修改</span><strong title={recentChapters[0].title}>{recentChapters[0].title}</strong></p>
                : <p>{featuredBook ? snapshot ? '从卷章目录开始，把下一幕写进故事。' : '打开作品目录，接着写下你的故事。' : '正文、设定与灵感，在这里一起展开。'}</p>}
              <button className={styles.heroButton} type="button" onClick={openFeatured} disabled={blocked}>
                {!hasWorkspace ? '选择作品库目录' : featuredBook ? featuredBook.archivedAt || !recentChapters.length ? '打开作品目录' : '继续写作' : '新建第一部作品'}<StudioIcon name="arrow" size={16} />
              </button>
            </div>
          </section>

          <dl className={styles.statistics} aria-label="作品与章节统计" aria-busy={loading}>
            {statistics.map((item) => <div className={styles.statistic} key={item.label}>
              <dt>{item.label}<StudioIcon name={item.icon} size={15} /></dt>
              <dd>{item.value === null ? <span aria-label={!hasWorkspace ? '尚未选择作品库' : loading ? '读取中' : '暂不可用'}>—</span> : number(item.value)}<span className={styles.statHint}>{item.hint}</span></dd>
            </div>)}
          </dl>

          <section className={styles.chaptersSection} aria-labelledby="workspace-chapters-title" aria-busy={loading}>
            <div className={styles.sectionHeading}>
              <h3 id="workspace-chapters-title">{selectedBook ? '最近章节' : '开始你的第一部作品'}</h3>
              {selectedBook && <span>按最近修改排序</span>}
            </div>
            {loadError ? <div className={styles.loadError} role="alert"><div><strong>章节信息暂未读到</strong><p>{loadError}</p></div><button className={styles.secondaryButton} type="button" onClick={retry} disabled={blocked}>重新读取</button></div>
              : loading ? <div className={styles.loadingChapters} role="status"><span>正在读取章节与字数…</span><div aria-hidden="true"><i /><i /><i /></div></div>
                : snapshot ? recentChapters.length ? <ol className={styles.chapterList}>
                  {recentChapters.map((chapter) => <li key={chapter.id}>
                    <button className={styles.chapterRow} type="button" onClick={() => onOpenBook(snapshot.book.id, chapter.id)} disabled={blocked}>
                      <span className={styles.chapterNumber}>{String(chapter.position + 1).padStart(2, '0')}</span>
                      <span className={styles.chapterInfo}><strong title={chapter.title}>{chapter.title}</strong><span>{number(chapter.characterCount)} 字符<span className={styles.chapterStatus} data-status={chapter.status}>{statusLabels[chapter.status]}</span></span></span>
                      <time dateTime={chapter.updatedAt}>{displayTime(chapter.updatedAt)}</time><StudioIcon name="chevron" size={15} />
                    </button>
                  </li>)}
                </ol> : <div className={styles.noChapters}><StudioIcon name="pen" size={25} /><div><strong>故事还没有第一章</strong><p>{snapshot.book.archivedAt ? '这部归档作品暂时没有章节，可以打开目录查看作品。' : '进入作品目录新建章节，或先去故事设定整理人物与世界。'}</p></div><button className={styles.textButton} type="button" onClick={() => onOpenBook(snapshot.book.id)} disabled={blocked}>打开目录<StudioIcon name="arrow" size={14} /></button></div>
                  : <ol className={styles.startSteps}>
                    <li><span className={styles.stepNumber}>{hasWorkspace ? <StudioIcon name="check" size={16} /> : '01'}</span><div><strong>选择作品库</strong><p>{hasWorkspace ? '本地目录已准备好。' : '选一个文件夹，安放正文与资料。'}</p><button className={styles.textButton} type="button" onClick={onOpenWorkspace} disabled={blocked}>{hasWorkspace ? '更换目录' : '选择目录'}<StudioIcon name="arrow" size={13} /></button></div></li>
                    <li><span className={styles.stepNumber}>02</span><div><strong>新建或导入作品</strong><p>从新故事开始，也可带入已有稿件。</p><button className={styles.textButton} type="button" onClick={onCreate} disabled={blocked}>新建作品<StudioIcon name="arrow" size={13} /></button></div></li>
                    <li><span className={styles.stepNumber}>03</span><div><strong>正文与设定一起展开</strong><p>写第一章，补充人物、关系和故事事件。</p><span className={styles.stepHint}>作品建立后即可开始</span></div></li>
                  </ol>}
          </section>

          <section className={styles.toolsSection} aria-labelledby="workspace-tools-title">
            <div className={styles.sectionHeading}>
              <h3 id="workspace-tools-title">故事工作台</h3>
              <span title={featuredBook?.title}>{featuredBook ? `当前作品：${featuredBook.title}` : '先建立作品，再展开你的故事'}</span>
            </div>
            {snapshot && !snapshot.book.archivedAt && <p>
              {snapshot.chapters.length === 0 ? '下一步：建立第一章，随时可以再补故事设定。'
                : snapshot.chapters.some((item) => item.status === 'review') ? '下一步：把待审章节的问题记入审稿清单，修改后逐项复核。'
                  : snapshot.chapters.some((item) => !item.goal) ? '下一步：为章节补上目标，或者直接接着写。'
                    : '下一步：继续上次的章节，或用场景卡安排接下来的变化。'}
              <button className={styles.textButton} type="button" disabled={blocked} onClick={() => snapshot.chapters.length ? onTool(snapshot.book.id, 'workbench') : onOpenBook(snapshot.book.id)}>{snapshot.chapters.length ? '查看规划与审稿' : '建立章节'}<StudioIcon name="arrow" size={13} /></button>
              {writingPosition(workspace.rootPath, snapshot.book.id) && <button className={styles.textButton} type="button" disabled={blocked} onClick={() => onOpenBook(snapshot.book.id)}>回到上次写作位置<StudioIcon name="arrow" size={13} /></button>}
            </p>}
            <div className={styles.toolGrid}>
              {tools.map((tool) => <button className={styles.toolCard} data-tool={tool.id} type="button" key={tool.id} disabled={blocked || !canOpenTools}
                aria-label={`${tool.title}，${snapshot ? tool.action : selectedBook ? loading ? '正在读取作品' : '读取作品后进入' : '先建立作品'}`}
                onClick={() => snapshot ? onTool(snapshot.book.id, tool.id) : onCreate()}>
                <span className={styles.toolIcon} aria-hidden="true"><StudioIcon name={tool.icon} size={19} /></span>
                <span className={styles.toolText}>
                  <strong>{tool.title}</strong>
                  <span className={styles.toolDescription}>{tool.description}</span>
                </span>
              </button>)}
            </div>
          </section>
        </div>

        <aside className={styles.supportColumn} aria-label="作品与常用操作">
          <section className={styles.recentPanel} aria-labelledby="workspace-recent-title">
            <div className={styles.panelHeading}><h3 id="workspace-recent-title">最近作品</h3><button className={styles.textButton} type="button" onClick={onShelf} disabled={busy || !hasWorkspace}>全部<StudioIcon name="chevron" size={13} /></button></div>
            {recentBooks.length ? <ul className={styles.recentList}>
              {recentBooks.slice(0, 3).map((item) => <li key={item.id}><button className={styles.recentBook} type="button" onClick={() => onOpenBook(item.id)} disabled={blocked}>
                <span className={styles.smallCover} aria-hidden="true"><BookCover book={item} /></span>
                <span className={styles.recentBookInfo}><strong title={item.title}>{item.title}</strong><span className={styles.bookState} data-archived={Boolean(item.archivedAt)}>{item.archivedAt ? '已归档' : '写作中'}</span><time dateTime={item.updatedAt}>{displayTime(item.updatedAt)} 更新</time></span>
                <StudioIcon name="chevron" size={14} />
              </button></li>)}
            </ul> : <div className={styles.emptyRecent}><StudioIcon name="books" size={28} /><strong>{hasWorkspace ? '书架已就绪' : '给故事留一个位置'}</strong><p>{hasWorkspace ? '新建第一部作品，最近更新的故事就会出现在这里。' : '选择本地作品库后，在这里找到你最近更新的故事。'}</p><button className={styles.textButton} type="button" onClick={hasWorkspace ? onCreate : onOpenWorkspace} disabled={blocked}>{hasWorkspace ? '新建第一部作品' : '选择作品库'}<StudioIcon name="arrow" size={14} /></button></div>}
          </section>

          <section className={styles.storagePanel} aria-labelledby="workspace-storage-title">
            <div className={styles.storageHeading}><StudioIcon name="folder" size={17} /><h3 id="workspace-storage-title">本地作品库</h3></div>
            <strong className={styles.workspaceName} title={workspace.rootPath ?? undefined}>{hasWorkspace ? workspaceName : '尚未选择目录'}</strong>
            <p>{hasWorkspace ? '正文与故事资料保存在这个作品库中。' : '作品库是电脑里的文件夹，已有作品可直接选择原目录。'}</p>
            <button className={styles.textButton} type="button" onClick={onOpenWorkspace} disabled={blocked}>{hasWorkspace ? '切换作品库' : '选择目录'}<StudioIcon name="arrow" size={13} /></button>
            <div className={styles.utilityActions}><button type="button" onClick={onRecover} disabled={blocked}><StudioIcon name="archive" size={16} /><span>备份与恢复</span><StudioIcon name="chevron" size={13} /></button><button type="button" onClick={onPreferences} disabled={busy}><StudioIcon name="settings" size={16} /><span>显示偏好</span><StudioIcon name="chevron" size={13} /></button></div>
          </section>
        </aside>
      </div>
    </div>
  </section>
}
