import { useEffect, useMemo, useState } from 'react'
import type { BookSnapshot, StudioApi, WorkspaceSnapshot } from '../../contracts/api'
import { STUDIO_THEMES, STUDIO_THEME_META, type StudioTheme } from '../display-preferences'
import { displayTime, request, statusLabels } from '../request'
import { StudioIcon } from './StudioIcon'
import { BookCover } from './LibraryPanels'
import styles from './WelcomeWorkspace.module.css'
import { lastWritingBook } from '../writing-location'

export type WorkspaceTool = 'knowledge' | 'galaxy' | 'timeline' | 'notes' | 'workbench' | 'calendar' | 'media'

interface Props {
  api?: StudioApi
  workspace: WorkspaceSnapshot
  currentBook: BookSnapshot | null
  busy: boolean
  studioTheme?: StudioTheme
  onThemeChange?: (theme: StudioTheme) => void
  onOpenWorkspace: () => void
  onCreate: () => void
  onImport: () => void
  onShelf: () => void
  onRecover: () => void
  onPreferences: () => void
  onOpenBook: (bookId: string, chapterId?: string) => void
  onTool: (bookId: string, tool: WorkspaceTool) => void
  onOpenInspiration?: () => void
}

type BookLoad = { key: string } & (
  | { status: 'loading' }
  | { status: 'ready'; snapshot: BookSnapshot }
  | { status: 'error'; message: string }
)

// 小狼 wolfan / Pagekin / StarWriter 8 大神级小说技能
const GOD_TIER_SKILLS = [
  { id: 'dethrone-ai', name: '朱雀去 AI 味', badge: '高频必用', desc: '清洗“仿佛/勾起弧度/眼中精芒”套话，转为动词白描与口语细节' },
  { id: 'hook-opening', name: '黄金三章开篇', badge: '签约核心', desc: '强危机入局，立住主角执念与金手指预期，章末留强悬念钩子' },
  { id: 'action-breakdown', name: '打斗动作分解', badge: '画面张力', desc: '起手预备、发力机制、受创物理反馈与环境破坏，招招到肉' },
  { id: 'dialogue-subtext', name: '对白潜台词', badge: '人设不崩', desc: '话里有话，用称谓、停顿、小动作与言不由衷展现心理博弈' },
  { id: 'escalation-tension', name: '情绪拉扯控温', badge: '爽点节奏', desc: '先抑后扬，设计三轮阻力升级与反转代价，拒绝平铺直叙' },
  { id: 'foreshadow-chain', name: '伏笔账本核验', badge: '长篇防崩', desc: '对照已埋、待收与到期伏笔，让每次揭晓引发局势与认知震荡' },
  { id: 'iceberg-world', name: '冰山世界白描', badge: '拒绝说明文', desc: '借衣食住行、货币物价、市井行话侧写世界观，只露冰山一角' },
  { id: 'cliffhanger-hook', name: '断章卡点制造', badge: '追读神器', desc: '在秘密揭晓前半秒或致命危机降临一瞬截断，拉满读者追读欲' },
]

function updatedTime(value: string) { return Date.parse(value) || 0 }
function number(value: number) { return value.toLocaleString('zh-CN') }

export function WelcomeWorkspace({
  api, workspace, currentBook, busy, studioTheme = 'mirroric', onThemeChange,
  onOpenWorkspace, onCreate, onImport, onShelf, onRecover, onPreferences, onOpenBook, onTool, onOpenInspiration,
}: Props) {
  const [load, setLoad] = useState<BookLoad | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [bookQuery, setBookQuery] = useState('')
  const hasWorkspace = Boolean(workspace.rootPath)
  const coverScope = workspace.rootPath ? JSON.stringify([workspace.rootPath, workspace.recoveryScope ?? null]) : undefined
  const blocked = busy || !api
  const recentBooks = useMemo(() => workspace.rootPath
    ? [...workspace.books].sort((left, right) => updatedTime(right.updatedAt) - updatedTime(left.updatedAt))
    : [], [workspace.rootPath, workspace.books])
  const currentSummary = currentBook && recentBooks.find((item) => item.id === currentBook.book.id)
  const selectedBook = currentSummary || recentBooks.find((item) => item.id === lastWritingBook(workspace.rootPath)) || recentBooks.find((item) => !item.archivedAt) || recentBooks[0]
  const selectedId = selectedBook?.id
  const suppliedBook = currentBook && currentSummary && currentBook.book.revision >= currentSummary.revision ? currentBook : null
  const requestKey = JSON.stringify([workspace.rootPath, workspace.recoveryScope, selectedId, selectedBook?.revision, selectedBook?.updatedAt, attempt])

  useEffect(() => {
    if (!api || !workspace.rootPath || !selectedId || suppliedBook || busy) return
    let active = true
    setLoad({ key: requestKey, status: 'loading' })
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

  const currentLoad = load?.key === requestKey ? load : null
  const snapshot = suppliedBook || (api && currentLoad?.status === 'ready' ? currentLoad.snapshot : null)
  const featuredBook = snapshot?.book ?? selectedBook
  const loading = Boolean(selectedBook && !snapshot && api && currentLoad?.status !== 'error')
  const loadError = selectedBook && !snapshot
    ? !api ? '桌面连接暂不可用，请在客户端中重新打开作品库。' : currentLoad?.status === 'error' ? currentLoad.message : null
    : null
  const emptyLibrary = hasWorkspace && recentBooks.length === 0
  const recentChapters = useMemo(() => snapshot
    ? [...snapshot.chapters].sort((left, right) => updatedTime(right.updatedAt) - updatedTime(left.updatedAt) || left.position - right.position).slice(0, 5)
    : [], [snapshot])
  const writingCount = hasWorkspace ? recentBooks.filter((item) => !item.archivedAt).length : 0
  const chapterCount = snapshot ? snapshot.chapters.length : emptyLibrary ? 0 : 0
  const characterCount = snapshot ? snapshot.chapters.reduce((total, chapter) => total + chapter.characterCount, 0) : 0
  const finalizedCount = snapshot ? snapshot.chapters.filter((chapter) => chapter.status === 'finalized').length : 0
  const activeChapter = recentChapters[0]
  const targetChars = activeChapter?.targetCharacters ?? 0
  // 章节字数不代表今日产出；未设目标时也不能推算创作完成度。
  const progressPercent = activeChapter && targetChars > 0 ? Math.min(100, Math.round(activeChapter.characterCount / targetChars * 100)) : null
  const filteredBooks = useMemo(() => {
    const q = bookQuery.trim().toLowerCase()
    if (!q) return recentBooks
    return recentBooks.filter((b) => `${b.title} ${b.genre} ${b.synopsis}`.toLowerCase().includes(q))
  }, [recentBooks, bookQuery])

  const today = new Date()
  const englishDate = today.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase()
  const workspaceName = workspace.rootPath?.split(/[\\/]/).filter(Boolean).pop() || '未选择作品库'
  const retry = () => setAttempt((value) => value + 1)
  const openFeatured = () => {
    if (!hasWorkspace) onOpenWorkspace()
    else if (featuredBook) onOpenBook(featuredBook.id)
    else onCreate()
  }

  return <section className={styles.welcome} aria-labelledby="workspace-home-title">
    <div className={styles.content}>
      {/* ============================== 1. StarWriter 同款顶部欢迎语 ============================== */}
      <header className={styles.workspaceHeader}>
        <div className={styles.bookTitleGroup}>
          <span className={styles.dateEyebrow}>{englishDate} · STORYWEAVE AI STUDIO</span>
          <div className={styles.titleRow}>
            <h1 id="workspace-home-title">让故事继续生长。</h1>
            <span className={styles.currentTag}>
              {featuredBook ? `正在创作《${featuredBook.title}》` : '智能体全流程小说工作台'}
            </span>
          </div>
          <p className={styles.subtitleText}>
            这是你的创作空间，从想法箱、故事建筑师、角色卡、9大世界模型到朱雀去 AI 味评审，慢慢写，也一直向前。
          </p>
        </div>

        <div className={styles.headerRightActions}>
          <button className={styles.ghostBtn} type="button" onClick={onImport} disabled={blocked}>
            <StudioIcon name="folder" size={14} />导入小说
          </button>
          <button className={styles.primaryBtn} type="button" onClick={onCreate} disabled={blocked}>
            <StudioIcon name="pen" size={14} />+ 新建作品
          </button>
        </div>
      </header>

      {!api && <p className={styles.connectionNotice} role="status">桌面连接暂不可用，作品操作将在连接恢复后开放。</p>}

      {/* ============================== 2. 第一行：StarWriter 经典「继续上次创作 (左2/3) + 今日目标与打卡 (右1/3)」 ============================== */}
      <div className={styles.topHeroRow}>
        <section className={styles.activeWritingCard} aria-label="继续上次创作">
          <div className={styles.activeCoverBox}>
            {featuredBook ? <BookCover book={featuredBook} featured api={api} workspaceScope={coverScope} /> : <StudioIcon name="pen" size={48} />}
          </div>
          <div className={styles.activeWritingBody}>
            <div className={styles.activeTagRow}>
              <span className={styles.activePill}><span className={styles.pulseDot} />{featuredBook ? '继续上次创作' : '开始新的故事'}</span>
              <span className={styles.activeChapterMeta}>停在一个值得继续的地方</span>
            </div>
            <h2 className={styles.activeChapterTitle} title={featuredBook?.title ?? '开始你的第一部作品'}>
              {featuredBook ? featuredBook.title : '开始你的第一部作品'}
            </h2>
            <p className={styles.activeSubMeta}>
              {featuredBook
                ? `${activeChapter ? `第 ${activeChapter.position + 1} 章〈${activeChapter.title}〉` : '待建立第一章'} · 累计 ${number(characterCount)} 字 · 共 ${chapterCount} 章`
                : '支持从「想法箱 → 故事建筑师」一键生成书名、简介、世界观、人物卡与分卷大纲'}
            </p>
            <div className={styles.activeProgressRow}>
              {progressPercent !== null && <div className={styles.progressBarWrapper}>
                <div className={styles.progressBarTrack}>
                  <div className={styles.progressBarFill} style={{ width: `${progressPercent}%` }} />
                </div>
              </div>}
              <span className={styles.progressPercentText}>
                {activeChapter ? progressPercent !== null ? `本章 ${number(activeChapter.characterCount)} / ${number(targetChars)} 字 (${progressPercent}%)` : '本章尚未设置目标字数' : '建立章节后可设置字数目标'}
              </span>
            </div>
            <div className={styles.activeActionsRow}>
              <button className={styles.primaryBtn} type="button" onClick={openFeatured} disabled={blocked}>
                <StudioIcon name="pen" size={14} />
                {!hasWorkspace ? '选择作品库目录' : featuredBook ? '继续写作' : '新建第一部作品'}
              </button>
              {featuredBook && snapshot && (
                <button className={styles.ghostBtn} type="button" onClick={() => onTool(featuredBook.id, 'workbench')} disabled={blocked}>
                  <StudioIcon name="compass" size={14} />大纲与朱雀评审
                </button>
              )}
              {featuredBook && snapshot && (
                <button className={styles.subtleBtn} type="button" onClick={() => onTool(featuredBook.id, 'knowledge')} disabled={blocked}>
                  <StudioIcon name="user" size={14} />角色卡 / 起名 / 世界模型
                </button>
              )}
            </div>
          </div>
        </section>

        <div className={styles.goalStack}>
          <section className={styles.goalCard} aria-label="本章字数与目标">
            <div className={styles.goalCardHead}>
              <span><StudioIcon name="compass" size={14} />本章字数与目标</span>
              <button type="button" className={styles.miniLinkBtn} onClick={() => snapshot ? onTool(snapshot.book.id, 'calendar') : onCreate()} disabled={blocked}>日历打卡 →</button>
            </div>
            <div className={styles.goalValueRow}>
              <strong>{number(activeChapter?.characterCount ?? 0)}</strong>
              <span>{targetChars > 0 ? `/ ${number(targetChars)} 字` : '字 · 未设置目标'}</span>
            </div>
            {progressPercent !== null && <div className={styles.progressBarTrack}>
              <div className={styles.progressBarFill} style={{ width: `${progressPercent}%` }} />
            </div>}
          </section>

          <section className={styles.goalCard} aria-label="创作沉淀统计">
            <div className={styles.goalCardHead}>
              <span><StudioIcon name="history" size={14} />创作沉淀</span>
              <span className={styles.goalBadge}>本地实时保存</span>
            </div>
            <div className={styles.goalStatsGrid}>
              <div><strong>{writingCount}</strong><small>连载作品</small></div>
              <div><strong>{chapterCount}</strong><small>已建章节</small></div>
              <div><strong>{finalizedCount}</strong><small>已定稿章</small></div>
            </div>
          </section>
        </div>
      </div>

      {/* ============================== 3. 第二行：StarWriter 标志性「我的作品」横幅卡片画廊 ============================== */}
      <section className={styles.myBooksSection} aria-labelledby="my-books-heading">
        <div className={styles.sectionHeadingRow}>
          <div>
            <h3 id="my-books-heading">我的作品</h3>
            <p className={styles.sectionSubtitle}>
              {recentBooks.length ? `${recentBooks.length} 个故事正在等待你的下一句` : '每个故事一间独立书房，人物、世界观与伏笔账本自动沉淀'}
            </p>
          </div>
          <div className={styles.booksToolbar}>
            <label className={styles.inlineSearch}>
              <StudioIcon name="search" size={14} />
              <input
                type="search"
                placeholder="搜索作品…"
                value={bookQuery}
                onChange={(e) => setBookQuery(e.target.value)}
              />
            </label>
            <button className={styles.ghostBtn} type="button" onClick={onImport} disabled={blocked}>导入小说</button>
            <button className={styles.primaryBtn} type="button" onClick={onCreate} disabled={blocked}>+ 新建</button>
          </div>
        </div>

        <div className={styles.landscapeBookGrid}>
          {filteredBooks.slice(0, 5).map((item, idx) => (
            <article key={item.id} className={styles.landscapeBookCard} data-Banner={idx % 4}>
              <button type="button" className={styles.landscapeCardBtn} onClick={() => onOpenBook(item.id)} disabled={blocked}>
                <div className={styles.landscapeBanner} data-tone={idx % 4}>
                  <span className={styles.bannerStatusPill}>{item.archivedAt ? '已归档' : '创作中'}</span>
                  <strong className={styles.bannerWatermark}>{item.title}</strong>
                </div>
                <div className={styles.landscapeCardBody}>
                  <h4>{item.title}</h4>
                  <p>{item.synopsis || '尚未填写简介，点击进入正文或补充故事设定…'}</p>
                  <div className={styles.landscapeCardFoot}>
                    <span>{item.genre || '长篇创作'} · {displayTime(item.updatedAt)}</span>
                    <span className={styles.enterArrow}>↗</span>
                  </div>
                </div>
              </button>
            </article>
          ))}

          <button type="button" className={styles.newStorySlotCard} onClick={onCreate} disabled={blocked}>
            <span className={styles.newSlotPlus}>+</span>
            <strong>开始一个新故事</strong>
            <small>从一句话种子、人物卡或导入 TXT 开始</small>
          </button>
        </div>
      </section>

      {/* ============================== 4. 第三行：双栏工作台（左：6大创作模块 + 8大神级Skill + 最近章节；右：AI Agent 流水线） ============================== */}
      <div className={styles.workspaceGrid}>
        <div className={styles.mainCanvas}>
          {/* 创作空间四大核心入口 */}
          <section className={styles.overviewStatsRow} aria-label="核心设定与检测入口">
            <button className={styles.statCard} type="button" onClick={() => snapshot ? onTool(snapshot.book.id, 'knowledge') : onCreate()} disabled={blocked}>
              <span className={styles.statBadge}>角色 & 属性</span>
              <strong className={styles.statTitle}>人物角色卡 & 起名器</strong>
              <small className={styles.statHint}>姓氏圆章 · 六维雷达 · 避开烂大街名字</small>
            </button>
            <button className={styles.statCard} type="button" onClick={() => snapshot ? onTool(snapshot.book.id, 'knowledge') : onCreate()} disabled={blocked}>
              <span className={styles.statBadge}>9 大流派预设</span>
              <strong className={styles.statTitle}>世界观卡片 & 势力</strong>
              <small className={styles.statHint}>修仙/末日/高武/克苏鲁 9 套模型开箱即用</small>
            </button>
            <button className={styles.statCard} type="button" onClick={() => snapshot ? onTool(snapshot.book.id, 'workbench') : onCreate()} disabled={blocked}>
              <span className={styles.statBadge}>过审护航</span>
              <strong className={styles.statTitle}>朱雀去AI味 & 读者模拟</strong>
              <small className={styles.statHint}>标出AI套话 + 小白/老书虫/编辑三重章评</small>
            </button>
            <button className={styles.statCard} type="button" onClick={() => snapshot ? onTool(snapshot.book.id, 'timeline') : onCreate()} disabled={blocked}>
              <span className={styles.statBadge}>跨章防崩</span>
              <strong className={styles.statTitle}>伏笔账本 & 双轨时间线</strong>
              <small className={styles.statHint}>已埋 → 待收 → 已收，故事线与披露线分离</small>
            </button>
          </section>

          {/* 神级小说 Skill 库 */}
          <section className={styles.skillsSection} aria-labelledby="skills-heading">
            <div className={styles.sectionHeadingRow}>
              <div>
                <h3 id="skills-heading">8 大神级网文 Skill 库</h3>
                <p className={styles.sectionSubtitle}>专为长篇网文打磨的实战技法 · 写正文与拆书时一键勾选注入</p>
              </div>
              {onOpenInspiration && (
                <button className={styles.textBtn} type="button" onClick={onOpenInspiration} disabled={blocked}>
                  进入拆书与技能中心 <StudioIcon name="arrow" size={13} />
                </button>
              )}
            </div>

            <div className={styles.skillCardsGrid}>
              {GOD_TIER_SKILLS.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  className={styles.skillCard}
                  onClick={() => onOpenInspiration ? onOpenInspiration() : openFeatured()}
                  title={`点击查看或调用【${skill.name}】`}
                >
                  <div className={styles.skillCardTop}>
                    <span className={styles.skillPill}>{skill.name}</span>
                    <small className={styles.skillBadge}>{skill.badge}</small>
                  </div>
                  <p className={styles.skillDesc}>{skill.desc}</p>
                </button>
              ))}
            </div>
          </section>

          {/* 最近章节列表 */}
          <section className={styles.recentChaptersSection} aria-labelledby="recent-heading">
            <div className={styles.sectionHeadingRow}>
              <div>
                <h3 id="recent-heading">最近章节与草稿</h3>
                <p className={styles.sectionSubtitle}>每章改稿自动留存历史快照，随时对比回退</p>
              </div>
              {snapshot && (
                <button className={styles.textBtn} type="button" onClick={() => onOpenBook(snapshot.book.id)} disabled={blocked}>
                  打开全部章节 <StudioIcon name="arrow" size={13} />
                </button>
              )}
            </div>

            {loadError ? (
              <div className={styles.errorBox} role="alert">
                <p>{loadError}</p>
                <button className={styles.ghostBtn} type="button" onClick={retry} disabled={blocked}>重试</button>
              </div>
            ) : loading ? (
              <div className={styles.loadingBox} role="status">正在同步章节数据…</div>
            ) : recentChapters.length ? (
              <div className={styles.chaptersTable}>
                {recentChapters.map((ch) => (
                  <button
                    key={ch.id}
                    className={styles.chapterItemRow}
                    type="button"
                    onClick={() => snapshot && onOpenBook(snapshot.book.id, ch.id)}
                    disabled={blocked}
                  >
                    <span className={styles.chOrdinal}>第 {ch.position + 1} 章</span>
                    <strong className={styles.chTitle} title={ch.title}>{ch.title}</strong>
                    <span className={styles.chWords}>{number(ch.characterCount)} 字</span>
                    <span className={styles.chStatus} data-status={ch.status}>{statusLabels[ch.status]}</span>
                    <time className={styles.chTime} dateTime={ch.updatedAt}>{displayTime(ch.updatedAt)}</time>
                    <StudioIcon name="arrow" size={12} />
                  </button>
                ))}
              </div>
            ) : (
              <div className={styles.emptyChaptersBox}>
                <p>当前尚未建立正文章节。可先用「故事建筑师」生成大纲，或直接建立第一章开始落笔：</p>
                <button className={styles.primaryBtn} type="button" onClick={openFeatured} disabled={blocked}>
                  建立第一章正文
                </button>
              </div>
            )}
          </section>
        </div>

        {/* 右侧：AI Agent 任务流 + 13模块流水线说明 (Mirroric + 豆豆工作台) */}
        <aside className={styles.agentAside} aria-label="星轨 AI 智能体任务流">
          <section className={styles.agentPipelineCard}>
            <div className={styles.agentCardHeader}>
              <div className={styles.agentTitleGroup}>
                <span className={styles.agentTag}>星轨 AI · 智能体</span>
                <h3>AI Agent 创作流水线</h3>
              </div>
              <button
                className={styles.newAgentBtn}
                type="button"
                onClick={() => snapshot ? onTool(snapshot.book.id, 'workbench') : openFeatured()}
                disabled={blocked}
              >
                故事建筑师
              </button>
            </div>

            <p className={styles.agentCardDesc}>不是 13 个孤岛，而是“把想法变成骨架，再把骨架变成正文”的流水线</p>

            <ol className={styles.pipelineSteps}>
              <li className={`${styles.stepItem} ${styles.stepDone}`} onClick={() => snapshot ? onTool(snapshot.book.id, 'notes') : openFeatured()}>
                <span className={styles.stepMarker}>✓</span>
                <div className={styles.stepInfo}>
                  <strong>1. 想法箱 & 灵感泡泡</strong>
                  <small>随手记脑洞与金句，勾选打包给故事建筑师</small>
                </div>
                <span className={styles.stepState}>已就绪</span>
              </li>

              <li className={`${styles.stepItem} ${styles.stepActive}`} onClick={() => snapshot ? onTool(snapshot.book.id, 'knowledge') : openFeatured()}>
                <span className={styles.stepMarker}>2</span>
                <div className={styles.stepInfo}>
                  <strong>2. 角色卡 & 9大世界观模型</strong>
                  <small>补全性格/口头禅/六维雷达与力量体系卡片</small>
                </div>
                <span className={styles.stepState}>点击进入</span>
              </li>

              <li className={styles.stepItem} onClick={() => snapshot ? onTool(snapshot.book.id, 'workbench') : openFeatured()}>
                <span className={styles.stepMarker}>3</span>
                <div className={styles.stepInfo}>
                  <strong>3. 拆解卷章大纲 & 场景节拍</strong>
                  <small>每章明确：发生什么、谁在场、结尾钩子停在哪</small>
                </div>
                <span className={styles.stepState}>待推进</span>
              </li>

              <li className={styles.stepItem} onClick={openFeatured}>
                <span className={styles.stepMarker}>4</span>
                <div className={styles.stepInfo}>
                  <strong>4. 精准上下文融合写作</strong>
                  <small>自动勾选世界观/在场人物/前置章 + 去AI味技能卡</small>
                </div>
                <span className={styles.stepState}>去写作</span>
              </li>

              <li className={styles.stepItem} onClick={() => snapshot ? onTool(snapshot.book.id, 'workbench') : openFeatured()}>
                <span className={styles.stepMarker}>5</span>
                <div className={styles.stepInfo}>
                  <strong>5. 朱雀AI检测 & 三维读者模拟</strong>
                  <small>扫描AI套话痕迹 + 小白/老书虫/编辑模拟章评</small>
                </div>
                <span className={styles.stepState}>去评测</span>
              </li>
            </ol>

            <div className={styles.agentThinkingBox}>
              <div className={styles.thinkingHeader}>
                <span className={styles.pulseSpark}><StudioIcon name="spark" size={14} /></span>
                <strong>精准上下文控制 · 绝不串戏</strong>
              </div>
              <p>续写第 21 章绝不会翻出未披露的未来设定；所有 AI 提议先进入对照区，经你确认后才写入正文。</p>
            </div>

            <button
              className={styles.agentLaunchBtn}
              type="button"
              onClick={openFeatured}
              disabled={blocked}
            >
              <StudioIcon name="spark" size={14} />
              进入章节编辑器 & 呼出 AI 副驾驶
            </button>
          </section>

          <section className={styles.libraryStatusCard}>
            <div className={styles.libStatusRow}>
              <span><StudioIcon name="folder" size={13} />本地作品库</span>
              <strong title={workspace.rootPath ?? undefined}>{workspaceName}</strong>
            </div>
            <div className={styles.libActions}>
              <button type="button" onClick={onOpenWorkspace} disabled={blocked}>切换目录</button>
              <button type="button" onClick={onShelf} disabled={blocked || !hasWorkspace}>书柜管理</button>
              <button type="button" onClick={onRecover} disabled={blocked}>备份恢复</button>
              <button type="button" onClick={onPreferences} disabled={busy}>多主题换色</button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </section>
}
