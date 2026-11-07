import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { BookSnapshot, StudioApi } from '../../contracts/api'
import { KNOWLEDGE_NATURES, type KnowledgeNature, type KnowledgeStatus } from '../../contracts/knowledge'
import { MEMORY_SOURCE_KINDS, type MemoryControlInput, type MemoryEvidence, type MemorySearchHit, type MemorySearchPage, type MemorySourceKind, type MemoryStartInput, type MemoryStatus, type MemoryTaskInput, type MemoryTaskReceipt, type MemoryTaskSummary } from '../../contracts/memory'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import { MemoryVectorPanel } from './MemoryVectorPanel'
import shared from '../App.module.css'
import layout from './KnowledgePanel.module.css'
import styles from './MemoryPanel.module.css'

interface Props {
  api: StudioApi
  book: BookSnapshot
  busy: boolean
  error?: string | null
  pendingMessage?: string | null
  checkingReceipt: boolean
  onCheckReceipt: () => void
  onRecover: () => void
  onClose: () => void
  onDirtyChange: (busy: boolean) => void
  onUpgrade: (accept: (status: KnowledgeStatus) => void) => Promise<void>
  onStart: (input: MemoryStartInput, accept: (receipt: MemoryTaskReceipt) => void) => Promise<void>
  onStep: (input: MemoryTaskInput, accept: (receipt: MemoryTaskReceipt) => void) => Promise<void>
  onControl: (input: MemoryControlInput, accept: (receipt: MemoryTaskReceipt) => void) => Promise<void>
}

const sourceLabels = { chapter: '正文', knowledge: '知识条目', story: '故事记录' }
const natureLabels: Record<KnowledgeNature, string> = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '人物认知', ai_derived: 'AI 整理', ai_inference: 'AI 推断', external_reference: '外部参考' }
const decisionLabels = { unreviewed: '未审阅', adopted: '作者采纳', rejected: '已拒绝', review_later: '稍后审阅' }
const freshnessLabels = { current: '作者标记：当前', affected: '作者标记：受影响', updating: '作者标记：更新中', failed: '作者标记：整理失败' }
const conflictLabels = { unchecked: '未判断冲突', clear: '作者标记无冲突', candidate: '冲突候选', explained: '已说明冲突' }
const taskLabels = { planning: '规划范围', running: '处理中', paused: '已暂停', completed: '已发布', superseded: '输入已变化', cancelled: '已取消', failed: '处理失败' }
const phaseLabels = { planning: '固定来源范围', indexing: '原文分片与索引', publishing: '等待整批发布' }
const reasonLabels = { keyword: '关键词', title: '名称', entity: '显式实体关联', semantic: '向量语义候选' }
function runnable(task: MemoryTaskSummary | null | undefined): boolean { return task?.state === 'planning' || task?.state === 'running' }

export function MemoryPanel({ api, book, busy, error, pendingMessage, checkingReceipt, onCheckReceipt, onRecover, onClose, onDirtyChange, onUpgrade, onStart, onStep, onControl }: Props) {
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [reading, setReading] = useState(false)
  const [vectorBusy, setVectorBusy] = useState(false)
  const [autoRun, setAutoRun] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [backupPath, setBackupPath] = useState<string | null>(null)
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const [refreshRequested, setRefreshRequested] = useState(true)
  const [query, setQuery] = useState('')
  const [sourceKind, setSourceKind] = useState<MemorySourceKind | ''>('')
  const [nature, setNature] = useState<KnowledgeNature | ''>('')
  const [includeUnreviewed, setIncludeUnreviewed] = useState(true)
  const [includeAffected, setIncludeAffected] = useState(false)
  const [page, setPage] = useState<MemorySearchPage | null>(null)
  const [evidence, setEvidence] = useState<MemoryEvidence | null>(null)
  const mounted = useRef(false)
  const lock = useRef(false)
  const ticket = useRef(0)
  const statusRef = useRef<MemoryStatus | null>(null)
  const dirtyCallback = useRef(onDirtyChange)
  dirtyCallback.current = onDirtyChange
  const archived = Boolean(book.book.archivedAt)
  const parentBlocked = busy || loading || working || reading || Boolean(pendingMessage)
  const blocked = parentBlocked || vectorBusy
  const task = status?.activeTask

  function acceptStatus(value: MemoryStatus) {
    if (value.bookId !== book.book.id) { setMessage('整理状态的作品身份不符，请重新打开。'); return false }
    if (statusRef.current?.publicationVersion !== value.publicationVersion || statusRef.current?.bookRevision !== value.bookRevision) {
      setPage(null); setEvidence(null)
    }
    statusRef.current = value; setStatus(value)
    return true
  }
  async function refreshStatus() {
    if (lock.current || busy || pendingMessage) return
    const currentTicket = ++ticket.current
    setLoading(true); setMessage(null)
    const result = await request(() => api.getMemoryStatus({ bookId: book.book.id }))
    if (!mounted.current || currentTicket !== ticket.current) return
    setLoading(false)
    if (result.ok) acceptStatus(result.data)
    else setMessage(result.error.message)
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ticket.current += 1; dirtyCallback.current(false) }
  }, [api, book.book.id])
  useEffect(() => { dirtyCallback.current(working || vectorBusy) }, [working, vectorBusy])
  useEffect(() => { setRecoveryConfirmed(false) }, [pendingMessage])

  function beginWrite(): boolean {
    if (lock.current || blocked || archived) return false
    lock.current = true; ticket.current += 1; setWorking(true); setMessage(null); dirtyCallback.current(true)
    return true
  }
  function endWrite() {
    lock.current = false
    if (mounted.current) { setWorking(false); dirtyCallback.current(vectorBusy) }
  }
  function acceptReceipt(value: MemoryTaskReceipt): boolean {
    if (!mounted.current) return false
    if (value.bookId !== book.book.id || value.task.bookId !== book.book.id) { setMessage('任务回执的作品身份不符，请核对。'); return false }
    return acceptStatus(value.status)
  }
  async function start() {
    if (!status || status.requiresUpgrade || task || !beginWrite()) return
    let confirmed = false
    try {
      await onStart({ bookId: book.book.id, expectedBookRevision: status.bookRevision, expectedKnowledgeRevision: status.knowledgeRevision }, (value) => {
        if (acceptReceipt(value)) confirmed = true
      })
      // 只用本次已确认回执继续调度；迟到回执可更新状态，但不会自动重发或继续任务。
      if (mounted.current && confirmed) setAutoRun(runnable(statusRef.current?.activeTask))
    } catch { if (mounted.current) setMessage('整理结果尚未确认，请核对原回执后再继续。') }
    finally { endWrite() }
  }
  async function step() {
    const current = statusRef.current?.activeTask
    if (!current || !runnable(current) || !beginWrite()) return
    let confirmed = false
    try {
      await onStep({ bookId: book.book.id, taskId: current.id, expectedTaskVersion: current.version }, (value) => {
        if (value.task.id !== current.id || value.task.version <= current.version) { setMessage('任务回执与本批检查点不符，请刷新状态。'); return }
        if (acceptReceipt(value)) confirmed = true
      })
    } catch { if (mounted.current) setMessage('本批处理尚未确认，请核对原回执。') }
    finally {
      if (mounted.current && (!confirmed || !runnable(statusRef.current?.activeTask))) setAutoRun(false)
      endWrite()
    }
  }
  useEffect(() => {
    if (!autoRun || blocked || !runnable(task)) return
    // 每个有界请求完成后让出界面线程；关面板或停止调度都保留数据库中的检查点。
    const timer = window.setTimeout(() => { void step() }, 120)
    return () => window.clearTimeout(timer)
  }, [autoRun, blocked, task?.id, task?.version])

  async function control(action: MemoryControlInput['action']) {
    const current = statusRef.current?.activeTask
    if (!current || !beginWrite()) return
    setAutoRun(false)
    try {
      await onControl({ bookId: book.book.id, taskId: current.id, expectedTaskVersion: current.version, action }, acceptReceipt)
    } catch { if (mounted.current) setMessage('任务操作尚未确认，请核对原回执。') }
    finally { endWrite() }
  }
  async function upgrade() {
    if (!upgradeConfirmed || !status || status.schemaVersion >= 10 || !beginWrite()) return
    try {
      await onUpgrade((value) => {
        if (!mounted.current) return
        if (value.bookId !== book.book.id || value.schemaVersion < 11) { setMessage('升级回执尚未确认 v11 可用。'); return }
        setBackupPath(value.backupPath ?? null); setUpgradeConfirmed(false)
        // 升级回执只带基础知识状态，不能伪造记忆覆盖；重新只读查询新结构。
        setStatus(null); statusRef.current = null; setRefreshRequested(true)
      })
    } catch { if (mounted.current) setMessage('升级结果尚未确认，请保留窗口并核对回执。') }
    finally { endWrite() }
  }
  useEffect(() => {
    if (refreshRequested && !working && !busy && !pendingMessage && !lock.current) {
      setRefreshRequested(false); void refreshStatus()
    }
  }, [refreshRequested, working, busy, pendingMessage, loading])

  async function search(event: FormEvent) {
    event.preventDefault()
    if (blocked || autoRun || status?.requiresUpgrade || !query.trim() || lock.current) return
    const currentTicket = ++ticket.current
    lock.current = true; setReading(true); setPage(null); setEvidence(null); setMessage(null)
    const result = await request(() => api.searchMemory({ bookId: book.book.id, query, includeUnreviewed, includeAffected, limit: 30,
      ...(sourceKind ? { sourceKind } : {}), ...(nature ? { nature } : {}) }))
    if (!mounted.current || currentTicket !== ticket.current) return
    lock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id) {
      acceptStatus(result.data.status); setPage(result.data)
    } else setMessage(result.ok ? '检索结果的作品身份不符。' : result.error.message)
  }
  async function readEvidence(hit: MemorySearchHit) {
    if (blocked || autoRun || lock.current) return
    const currentTicket = ++ticket.current
    lock.current = true; setReading(true); setEvidence(null); setMessage(null)
    const result = await request(() => api.readMemoryEvidence({ bookId: book.book.id, chunkId: hit.chunkId }))
    if (!mounted.current || currentTicket !== ticket.current) return
    lock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.chunkId === hit.chunkId && result.data.revisionId === hit.revisionId && result.data.sourceId === hit.sourceId) setEvidence(result.data)
    else setMessage(result.ok ? '出处身份或修订不符，请重新检索。' : result.error.message)
  }
  function close() {
    if (blocked || lock.current) return
    setAutoRun(false); onClose()
  }
  const panelError = [message, error].filter((value, index, values) => value && value !== pendingMessage && values.indexOf(value) === index).join(' ') || null

  return <Dialog title="本书记忆与检索" wide onClose={close} busy={blocked} error={panelError}>
    <div className={layout.intro}><p>《{book.book.title}》的本地资料</p><span>作者全知视图 · 关键词与显式实体关联</span></div>
    <p className={styles.note}>整理正文原文、知识条目和故事记录，保留固定版本出处。向量请求在下方逐批预览并明确发送；章节摘要通过独立审阅链路保存。覆盖进度表示索引范围，人物认知、未来计划与 AI 推断保留各自性质。</p>
    {pendingMessage && <div className={layout.pending} role="alert"><h3>本次操作结果未确认</h3><p>{pendingMessage}</p><p>任务检查点保存在作品库中。请先查询原回执；重新连接后先核对任务状态。若已填写向量配置，请先复制下方向量区域的恢复内容。</p><label className={shared.checkLabel}><input type="checkbox" checked={recoveryConfirmed} disabled={checkingReceipt || vectorBusy} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />我已留存本页需要保留的配置与查询，允许进入恢复</label><div className={shared.formActions}><button type="button" className={shared.button} disabled={checkingReceipt} onClick={onCheckReceipt}>{checkingReceipt ? '正在核对…' : '查询原回执'}</button><button type="button" className={shared.button} disabled={checkingReceipt || vectorBusy || !recoveryConfirmed} onClick={onRecover}>进入草稿与恢复</button></div></div>}
    {loading && <p className={styles.note} role="status">正在读取整理状态…</p>}
    {!loading && !status && <button type="button" className={shared.button} disabled={blocked} onClick={() => void refreshStatus()}>重新读取状态</button>}
    {status && status.schemaVersion < 10 && <section className={layout.upgrade}><h3>{status.requiresUpgrade ? '为旧作品启用记忆索引' : '为本书启用向量索引与混合检索'}</h3><p>当前格式 v{status.schemaVersion}。启用前会建立独立数据库备份，核对后升级到当前作品格式；已有本地检索仍可继续使用。</p><label className={layout.upgradeCheck}><input type="checkbox" checked={upgradeConfirmed} disabled={blocked || archived} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />同意为本书创建备份并升级数据结构</label><button type="button" className={shared.primaryButton} disabled={blocked || archived || !upgradeConfirmed} onClick={() => void upgrade()}>备份并启用</button></section>}
    {backupPath && <p className={layout.backupPath}>升级前数据库副本：{backupPath}</p>}
    {status && !status.requiresUpgrade && <>
      <section className={styles.coverage} aria-label="整理覆盖"><div><span>版本匹配的索引</span><strong>{status.indexedSourceCount.toLocaleString()} <small>/ {status.sourceCount.toLocaleString()} 个来源</small></strong></div><div><span>待索引变更</span><strong>{status.pendingEventCount.toLocaleString()}</strong></div><div><span>发布批次</span><strong>{status.publicationVersion || '尚无'}</strong></div><p className={status.current ? styles.current : styles.stale}>{status.current ? '已发布批次覆盖当前作品版本' : '当前版本尚未整批覆盖；发生变化的旧来源会排除检索'}<span>作品版本 {status.bookRevision} · 知识版本 {status.knowledgeRevision} · {status.changedDependencyCount} 个来源的引用原稿已有变化，需复核</span></p></section>
      <section className={styles.task} aria-label="整理任务"><div className={styles.taskHeading}><h3>{task ? taskLabels[task.state] : '整理本书资料'}</h3><button className={shared.button} type="button" disabled={blocked || autoRun} onClick={() => void refreshStatus()}>刷新状态</button></div>
        {task ? <><p>{phaseLabels[task.phase]} · 已完成 {task.completedSources.toLocaleString()} / {task.plannedSources.toLocaleString()} 个来源 · {task.processedChunks.toLocaleString()} 个片段</p><progress aria-label="已完成来源" value={task.completedSources} max={Math.max(1, task.plannedSources)} /><p className={styles.note}>固定输入：作品 {task.targetBookRevision}／知识 {task.targetKnowledgeRevision}。每次最多规划 100 个来源或处理 64 个片段，完整且版本匹配才发布。</p>{task.error && <p className={shared.formError}>{task.error}</p>}<div className={styles.actions}>
          {runnable(task) && (autoRun ? <button className={shared.button} type="button" onClick={() => setAutoRun(false)}>停止连续处理</button> : <><button className={shared.primaryButton} type="button" disabled={blocked || archived} onClick={() => setAutoRun(true)}>继续整理</button><button className={shared.button} type="button" disabled={blocked || archived} onClick={() => void step()}>只处理下一批</button><button className={shared.button} type="button" disabled={blocked || archived} onClick={() => void control('pause')}>暂停任务</button></>)}
          {task.state === 'paused' && <button className={shared.primaryButton} type="button" disabled={blocked || archived} onClick={() => void control('resume')}>恢复任务</button>}
          {task.state === 'failed' && <button className={shared.primaryButton} type="button" disabled={blocked || archived} onClick={() => void control('retry')}>从检查点重试</button>}
          <button className={shared.button} type="button" disabled={blocked || autoRun || archived} onClick={() => void control('cancel')}>取消任务</button>
        </div><p className={styles.note}>{autoRun ? '正在逐批处理；可停止调度，已确认的进度会保留。' : '检查点会保留；关闭面板后停止调度，下次可继续。'}</p></> : <><p>新任务固定当前版本，复用版本匹配的完整索引。任务处理中暂存的片段在发布前不可检索。</p><button className={shared.primaryButton} type="button" disabled={blocked || archived} onClick={() => void start()}>整理当前版本</button></>}
        {archived && <p className={styles.note}>作品已归档，可检索已有资料；解除归档后可继续整理。</p>}
        {status.recentTasks.length > 0 && <details className={styles.history}><summary>最近任务</summary><ul>{status.recentTasks.map((item) => <li key={item.id}><span>{taskLabels[item.state]} · {item.completedSources}/{item.plannedSources} 来源</span><span>{displayTime(item.updatedAt)} · 作品 {item.targetBookRevision}</span>{item.error && <span>{item.error}</span>}</li>)}</ul></details>}
      </section>
      <form className={styles.search} onSubmit={(event) => void search(event)}><label className={styles.query}>查找资料<input value={query} maxLength={200} disabled={blocked || autoRun} placeholder="人物名字、地点、事件或原文词语" onChange={(event) => setQuery(event.target.value)} /></label><label>来源<select value={sourceKind} disabled={blocked || autoRun} onChange={(event) => setSourceKind(event.target.value as MemorySourceKind | '')}><option value="">全部来源</option>{MEMORY_SOURCE_KINDS.map((value) => <option key={value} value={value}>{sourceLabels[value]}</option>)}</select></label><label>性质<select value={nature} disabled={blocked || autoRun} onChange={(event) => setNature(event.target.value as KnowledgeNature | '')}><option value="">全部性质</option>{KNOWLEDGE_NATURES.map((value) => <option key={value} value={value}>{natureLabels[value]}</option>)}</select></label><button className={shared.primaryButton} type="submit" disabled={blocked || autoRun || !query.trim()}>检索</button><div className={styles.checks}><label><input type="checkbox" checked={includeUnreviewed} disabled={blocked || autoRun} onChange={(event) => setIncludeUnreviewed(event.target.checked)} />包含未审阅资料</label><label><input type="checkbox" checked={includeAffected} disabled={blocked || autoRun} onChange={(event) => setIncludeAffected(event.target.checked)} />包含受影响或引用原稿已变化的资料</label></div></form>
      {status.schemaVersion >= 10 && <MemoryVectorPanel api={api} bookId={book.book.id} archived={archived} publicationVersion={status.publicationVersion}
        disabled={parentBlocked || autoRun} onBusyChange={setVectorBusy} onRecover={onRecover}
        searchInput={{ bookId: book.book.id, query, includeUnreviewed, includeAffected, limit: 30, ...(sourceKind ? { sourceKind } : {}), ...(nature ? { nature } : {}) }}
        onRestoreSearch={(input) => { setQuery(input.query); setSourceKind(input.sourceKind ?? ''); setNature(input.nature ?? ''); setIncludeUnreviewed(input.includeUnreviewed !== false); setIncludeAffected(input.includeAffected === true) }}
        onResults={(result) => { if (result.bookId === book.book.id) { setPage(result); setEvidence(null) } else setMessage('混合检索结果的作品身份不符。') }} />}
      {page?.semantic && <p className={styles.note}>本次混合检索快照：筛选范围内已有向量 {page.semantic.indexedChunks.toLocaleString()} / {page.semantic.eligibleChunks.toLocaleString()} 个片段，实际比较 {page.semantic.scannedChunks.toLocaleString()} 个，单次上限 {page.semantic.scanLimit.toLocaleString()}。每路最多 100 个候选；覆盖或扫描不全会标记截断，不表示全书语义召回已完成。</p>}
      {reading && <p className={styles.note} role="status">正在读取…</p>}
      {page && <section className={styles.results} aria-label="检索结果"><p className={styles.note}>批次 {page.publicationVersion} · {page.hits.length} 个原文片段{page.truncated ? ' · 有界候选仍有更多结果，请缩小检索范围' : ''}。已拒绝资料不参与检索；当前界面包含作者全知内容。</p>{page.hits.length === 0 && <p className={styles.empty}>没有找到当前筛选范围内的有效片段。可以调整词语、筛选或整理当前版本。</p>}<ol>{page.hits.map((hit) => <li key={hit.chunkId}><div className={styles.resultHeading}><h4>{hit.title}</h4><span>{sourceLabels[hit.sourceKind]} · {hit.reasons.map((reason) => reasonLabels[reason]).join('、')}</span></div><div className={layout.labels}><span>{natureLabels[hit.nature]}</span>{hit.authorDecision && <span>{decisionLabels[hit.authorDecision]}</span>}<span>{hit.sourceKind === 'chapter' ? '来源状态：当前' : freshnessLabels[hit.freshness]}</span><span>{hit.sourceKind === 'chapter' ? '未判断陈述真伪' : conflictLabels[hit.conflictState]}</span>{hit.dependencyState === 'source_changed' && <span>引用原稿已变化，待复核</span>}</div><blockquote>{hit.excerpt}</blockquote><button className={shared.button} type="button" disabled={blocked || autoRun} onClick={() => void readEvidence(hit)}>核对固定版本出处</button>{evidence?.chunkId === hit.chunkId && <div className={styles.evidence}><p>原对象 {evidence.sourceId}<br />修订 {evidence.revisionId}<br />{evidence.blockId ? `正文块 ${evidence.blockId}` : '知识／故事字段摘录'} · UTF-16 偏移 {evidence.startOffset}–{evidence.endOffset}</p><pre>{evidence.text}</pre><small>已核对当前发布指针与这份固定原稿；原文存在不等于陈述真实。{evidence.dependencyState === 'source_changed' && '引用的原稿已变化，历史引用仍可核对。'}</small></div>}</li>)}</ol></section>}
    </>}
  </Dialog>
}
