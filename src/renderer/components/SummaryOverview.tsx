import { useEffect, useRef, useState } from 'react'
import type { BookSnapshot, StudioApi } from '../../contracts/api'
import { AI_SUMMARY_TEXT_LIMIT, type AiSummaryNodeDetail, type AiSummaryStatus } from '../../contracts/ai-summary'
import type { LivingSnapshot } from '../../contracts/living'
import type { ForeshadowRadarPage } from '../../contracts/story-control'
import { request } from '../request'
import { StudioIcon } from './StudioIcon'
import styles from './StellarSummary.module.css'

interface Props {
  api: StudioApi
  book: BookSnapshot
  status: AiSummaryStatus
  disabled: boolean
  onNavigate: (chapterId: string) => void
  onPrepare: (scope: string) => void
  onTask: (id: string) => void
  onForeshadow: () => void
}
interface SourceRead {
  api: StudioApi; key: string; reading: boolean
  living: LivingSnapshot | null; radar: ForeshadowRadarPage | null
  livingUnavailable: string | null; error: string | null
}
interface SummaryRead {
  api: StudioApi; key: string; reading: boolean
  summary: AiSummaryNodeDetail | null; error: string | null
}

export function SummaryOverview({ api, book, status, disabled, onNavigate, onPrepare, onTask, onForeshadow }: Props) {
  const [scope, setScope] = useState(book.volumes[0]?.id ?? (book.chapters.length ? 'ungrouped' : 'book'))
  const [sourceRead, setSourceRead] = useState<SourceRead | null>(null)
  const [summaryRead, setSummaryRead] = useState<SummaryRead | null>(null)
  const [refresh, setRefresh] = useState(0)
  const root = useRef<HTMLElement>(null)
  const chapters = book.chapters.filter((chapter) => scope === 'book' || chapter.volumeId === (scope === 'ungrouped' ? null : scope))
  const chapterIds = new Set(chapters.map((chapter) => chapter.id))
  const scopeTitle = scope === 'book' ? '全书' : scope === 'ungrouped' ? '未分卷章节' : book.volumes.find((volume) => volume.id === scope)?.title ?? '所选卷'
  const task = status.recentTasks.find((item) => scope === 'book' ? item.scope.kind === 'book'
    : item.scope.kind === 'volume' && item.scope.volumeId === (scope === 'ungrouped' ? null : scope))
  // 渲染时先核对读取身份，避免 effect 清理前将上一范围的摘要或旧版本资料画入当前页面。
  const sourceKey = JSON.stringify([book.book.id, book.book.revision, status.bookId, status.bookRevision, status.knowledgeRevision, refresh])
  const summaryKey = JSON.stringify([sourceKey, scope, task?.id, task?.version, task?.state, task?.sourceCurrent, task?.totalNodes, task?.scope])
  const currentSources = sourceRead?.api === api && sourceRead.key === sourceKey ? sourceRead : null
  const currentSummary = summaryRead?.api === api && summaryRead.key === summaryKey ? summaryRead : null
  const living = currentSources?.living ?? null
  const radar = currentSources?.radar ?? null
  const summary = currentSummary?.summary ?? null
  const reading = !currentSources || currentSources.reading
  const summaryReading = Boolean(task?.state === 'completed' && task.totalNodes && (!currentSummary || currentSummary.reading))
  const error = currentSources?.error ?? null
  const summaryError = currentSummary?.error ?? null
  const livingUnavailable = reading ? '正在核对大纲与记忆资料…' : currentSources?.livingUnavailable ?? '大纲与记忆资料尚未取得，请刷新后重读。'
  const outline = living?.outlines.find((item) => scope === 'book' ? item.scope === 'book' : item.scope === 'volume' && item.id === scope)
  const memoryPeople = new Set(living?.memories.filter((memory) => memory.state === 'published' && chapterIds.has(memory.chapterId))
    .flatMap((memory) => memory.proposal.states.map((state) => state.entityId)) ?? [])
  const people = living?.entities.filter((entity) => entity.kind === 'person' && memoryPeople.has(entity.id)) ?? []
  const totalWords = book.chapters.reduce((sum, chapter) => sum + chapter.characterCount, 0)
  const groups = [...book.volumes.map((volume) => ({ id: volume.id, title: volume.title })),
    ...(book.chapters.some((chapter) => chapter.volumeId === null) ? [{ id: 'ungrouped', title: '未分卷章节' }] : [])]
  const sourceChapters = summary && task?.sourceCurrent && book.book.revision === status.bookRevision
    ? chapters.map((chapter) => ({ id: chapter.id, title: chapter.title }))
    : [...new Map((summary?.sources ?? []).filter((source) => source.kind === 'chapter').map((source) => [source.chapterId, { id: source.chapterId, title: source.chapterTitle }])).values()]

  useEffect(() => {
    let active = true
    setSourceRead({ api, key: sourceKey, reading: true, living: null, radar: null, livingUnavailable: null, error: null })
    void (async () => {
      const [outlineResult, radarResult] = await Promise.all([
        request(() => api.getLiving({ bookId: book.book.id })),
        request(() => api.listForeshadowRadar({ bookId: book.book.id, scope: 'open' })),
      ])
      if (!active) return
      const failures: string[] = []
      let living: LivingSnapshot | null = null, radar: ForeshadowRadarPage | null = null, livingUnavailable: string | null = null
      if (outlineResult.ok && outlineResult.data.bookId === book.book.id && outlineResult.data.bookRevision === status.bookRevision && outlineResult.data.bookRevision >= book.book.revision
        && outlineResult.data.knowledgeRevision === status.knowledgeRevision) {
        if (outlineResult.data.requiresUpgrade) livingUnavailable = '本书尚未启用演进大纲与记忆，请在大纲沙盘核对备份升级说明。'
        else living = outlineResult.data
      } else {
        livingUnavailable = outlineResult.ok ? '大纲版本与汇总状态不一致，请刷新。' : `大纲与记忆资料读取失败：${outlineResult.error.message}`
        failures.push(livingUnavailable)
      }
      if (radarResult.ok && radarResult.data.bookId === book.book.id && radarResult.data.bookRevision === status.bookRevision && radarResult.data.bookRevision >= book.book.revision
        && radarResult.data.knowledgeRevision === status.knowledgeRevision) radar = radarResult.data
      else failures.push(radarResult.ok ? '伏笔版本与汇总状态不一致，请刷新。' : radarResult.error.message)
      setSourceRead({ api, key: sourceKey, reading: false, living, radar, livingUnavailable, error: failures.join(' ') || null })
    })()
    return () => { active = false }
  }, [api, sourceKey])

  useEffect(() => {
    let active = true
    if (!task || task.state !== 'completed' || !task.totalNodes) { setSummaryRead(null); return }
    setSummaryRead({ api, key: summaryKey, reading: true, summary: null, error: null })
    const finish = (summary: AiSummaryNodeDetail | null, error: string | null = null) => {
      if (active) setSummaryRead({ api, key: summaryKey, reading: false, summary, error })
    }
    void (async () => {
      // 最后一个序号才是覆盖整个范围的根节点，不把首个分组摘要当作整卷汇总。
      const result = await request(() => api.getAiSummaryTask({ bookId: book.book.id, taskId: task.id, afterOrdinal: task.totalNodes - 1 }))
      if (!active) return
      if (!result.ok) { finish(null, result.error.message); return }
      const owner = result.data
      const node = owner.nodes.find((item) => item.ordinal === owner.totalNodes && item.chapterCount === owner.totalChapters)
      if (owner.bookId !== book.book.id || owner.id !== task.id || owner.version !== task.version || owner.state !== 'completed'
        || owner.sourceCurrent !== task.sourceCurrent || JSON.stringify(owner.scope) !== JSON.stringify(task.scope) || !node || node.state !== 'approved') {
        finish(null, '汇总根节点或范围版本已变化，请刷新状态后重读。'); return
      }
      const detail = await request(() => api.getAiSummaryNode({ bookId: book.book.id, taskId: owner.id, nodeId: node.id }))
      if (!active) return
      if (!detail.ok) finish(null, detail.error.message)
      else {
        const value = detail.data
        if (value.id !== node.id || value.taskId !== owner.id || value.ordinal !== owner.totalNodes || value.chapterCount !== owner.totalChapters
          || value.state !== 'approved' || !value.acceptedText?.trim() || value.acceptedText.length > AI_SUMMARY_TEXT_LIMIT
          || value.run?.bookId !== book.book.id || value.run.id !== value.runId || value.run.state !== 'adopted'
          || value.run.acceptedText !== value.acceptedText || !value.sources?.length) finish(null, '已采用摘要与固定根节点回执不一致。')
        else finish(value)
      }
    })()
    return () => { active = false }
  }, [api, summaryKey])

  function selectScope(value: string) {
    if (disabled) return
    setScope(value)
    requestAnimationFrame(() => root.current?.focus({ preventScroll: true }))
  }

  return <section className={styles.overview} aria-label="全书分层汇总阅读">
    <header className={styles.toolbar}><span>{book.book.title}</span><div>
      <button type="button" className={styles.iconButton} disabled={disabled || reading || summaryReading} title="刷新汇总阅读资料" aria-label="刷新汇总阅读资料" onClick={() => setRefresh((value) => value + 1)}><StudioIcon name="refresh" size={20} /></button>
      <button type="button" className={styles.regenerate} disabled={disabled || Boolean(book.book.archivedAt)} onClick={() => onPrepare(scope)}><StudioIcon name="refresh" size={20} />重新汇总{scope === 'book' ? '全书' : '本卷'}</button>
    </div></header>
    {(error || summaryError) && <p className={styles.error} role="alert">{error} {summaryError}</p>}
    <div className={styles.columns}>
      <nav className={styles.tree} aria-label="全书卷章树"><button type="button" className={styles.bookRoot} disabled={disabled} aria-current={scope === 'book' ? 'true' : undefined} onClick={() => selectScope('book')}><StudioIcon name="read" size={24} /><strong>全书</strong></button>
        <p>{totalWords.toLocaleString()} 字 · {book.chapters.length} 章</p>
        <h3><StudioIcon name="layers" size={20} />{book.volumes.length} 卷</h3>
        {groups.map((group, index) => {
          const entries = book.chapters.filter((chapter) => chapter.volumeId === (group.id === 'ungrouped' ? null : group.id))
          return <div key={group.id} className={styles.volumeGroup}>
            <button type="button" className={styles.volumeButton} data-tone={index % 3} disabled={disabled} aria-expanded={scope === group.id} aria-current={scope === group.id ? 'true' : undefined} onClick={() => selectScope(group.id)}><StudioIcon name={scope === group.id ? 'down' : 'chevron'} size={16} /><StudioIcon name="layers" size={16} /><span><strong>{group.title}</strong><small>{entries.reduce((sum, chapter) => sum + chapter.characterCount, 0).toLocaleString()} 字 · {entries.length} 章</small></span></button>
            {scope === group.id && <ul>{entries.map((chapter) => <li key={chapter.id}><button type="button" disabled={disabled} onClick={() => onNavigate(chapter.id)}><StudioIcon name="notes" size={16} /><span>{chapter.title}</span><i data-state={chapter.status} /></button></li>)}</ul>}
            {scope === group.id && !entries.length && <p className={styles.muted}>本卷尚无章节</p>}
          </div>
        })}
        {!groups.length && <p className={styles.muted}>还没有卷或章节。</p>}
      </nav>
      <article ref={root} tabIndex={-1} className={styles.summary} aria-label={`${scopeTitle}摘要`}>
        <header className={styles.cover} aria-busy={reading}><h2>{scopeTitle}</h2><p><StudioIcon name="spark" size={20} />{outline?.fields.goal || (living ? '尚未填写本范围的故事目标' : livingUnavailable)}</p></header>
        <section className={styles.summaryText} aria-busy={summaryReading}><h3><StudioIcon name="spark" size={20} />内容摘要</h3>
          {summaryReading ? <div className={styles.skeleton} role="status">正在核对已采用的范围摘要…</div> : summary ? <><span className={styles.status} data-stale={!task?.sourceCurrent}>{task?.sourceCurrent ? '已采用 · 来源当前' : '来源已变更 · 待复核'}</span><p>{summary.acceptedText}</p></>
            : <div className={styles.empty}><p>{summaryError ? '已采用摘要尚未取得，请刷新后重读；可打开原任务核对。' : task?.state === 'completed' ? '本范围汇总未提供可核对的根节点，请打开原任务核对。' : task ? '本范围汇总尚未完成。请继续逐节点审阅。' : '最近十份任务中尚无本范围已完成的汇总。'}</p>
              {task && <button type="button" className={styles.button} disabled={disabled} onClick={() => onTask(task.id)}>查看本范围任务</button>}
              <button type="button" className={styles.button} disabled={disabled || Boolean(book.book.archivedAt)} onClick={() => onPrepare(scope)}>准备汇总</button></div>}
          {outline && <div className={styles.plan}><h4>卷纲节拍 · 规划{outline.stale ? ' · 待复核' : ''}</h4>
            <dl>{outline.fields.beats.map((beat, index) => <div key={index} data-tone={index % 3}><dt>{beat.title}</dt><dd>{beat.action}{beat.outcome && <p>{beat.outcome}</p>}</dd></div>)}</dl>
            <details><summary>目标、冲突与收束</summary><dl><div><dt>目标</dt><dd>{outline.fields.goal || '未填写'}</dd></div><div><dt>冲突</dt><dd>{outline.fields.conflict || '未填写'}</dd></div><div><dt>收束</dt><dd>{outline.fields.hook || '未填写'}</dd></div></dl></details>
          </div>}
        </section>
        <section className={styles.people} aria-busy={reading}><h3><StudioIcon name="user" size={20} />关键人物</h3><div>{people.map((person, index) => <span data-tone={index % 3} key={person.id}><StudioIcon name="user" size={20} />{person.name}</span>)}</div>
          {!people.length && <p className={styles.muted}>{reading ? '正在读取人物状态…' : living ? '当前读取的已发布记忆中尚无本范围的人物状态。' : livingUnavailable}</p>}
          {living && (living.memoryTotal > living.memories.length || living.entityTotal > living.entities.length) && <p className={styles.muted}>人物取自最近 {living.memories.length} 份记忆与本页 {living.entities.length} 个可用实体；其他历史记录可在记忆归档中查阅。</p>}
        </section>
        <section className={styles.foreshadows}><h3><StudioIcon name="notes" size={20} />未回收伏笔 <small>全书</small></h3>
          {radar ? <><ul>{radar.items.map((item) => <li key={item.id}><button type="button" disabled={disabled} onClick={onForeshadow}>{item.title}</button></li>)}</ul>{!radar.items.length && <p className={styles.muted}>尚无未回收伏笔记录。</p>}{radar.nextOffset !== null && <button type="button" className={styles.button} disabled={disabled} onClick={onForeshadow}>查看全部 {radar.total} 条</button>}</> : <p className={styles.muted}>{reading ? '正在读取伏笔…' : '伏笔资料尚未取得。'}</p>}
        </section>
        <section className={styles.sources}><h3><StudioIcon name="workflow" size={20} />源章节链接</h3><div>{sourceChapters.slice(0, 20).map((source) => <button type="button" key={source.id} disabled={disabled || !book.chapters.some((chapter) => chapter.id === source.id)} title="打开此来源章的当前稿；固定历史原文在任务来源中核对" onClick={() => onNavigate(source.id)}>{source.title}</button>)}</div>
          {sourceChapters.length > 20 && <p className={styles.muted}>共 {sourceChapters.length} 个来源章，当前显示前 20 个。</p>}
          {summary && task && <button type="button" className={styles.button} disabled={disabled} onClick={() => onTask(task.id)}>追溯完整下层来源</button>}
          {!summary && <p className={styles.muted}>{summaryReading ? '正在核对已采用摘要的来源…' : summaryError || task?.state === 'completed' ? '摘要来源尚未取得，请打开原任务核对或刷新后重读。' : '采用范围摘要后显示其实际来源。'}</p>}
        </section>
      </article>
      <aside className={styles.spine} aria-label="全书脉络" aria-busy={reading}><h3><StudioIcon name="spark" size={24} />全书脉络</h3><ol>
        {groups.map((group, index) => {
          const value = living?.outlines.find((item) => item.scope === 'volume' && item.id === group.id)
          return <li data-tone={index % 3} key={group.id}><button type="button" disabled={disabled} aria-current={scope === group.id ? 'true' : undefined} onClick={() => selectScope(group.id)}><strong>{group.title}</strong><p>{value?.fields.goal || value?.fields.summary || (living ? '本卷尚未填写规划主线' : livingUnavailable)}</p><small>{!living ? reading ? '读取中' : '资料待核对' : value?.stale ? '规划待复核' : '卷主线 · 规划'}</small></button></li>
        })}
      </ol>{!groups.length && <p className={styles.muted}>建立分卷后显示全书脉络。</p>}</aside>
    </div>
    <footer className={styles.stats}><StudioIcon name="chart" size={24} /><strong>{book.chapters.length} 章 · {totalWords.toLocaleString()} 字 · {radar ? `${radar.total} 条未回收` : reading ? '未回收数量待读取' : '未回收数量待核对'}</strong></footer>
  </section>
}
