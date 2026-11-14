import { useEffect, useId, useRef, useState } from 'react'
import { DomainError, type BookSnapshot, type ChapterSnapshot, type StudioApi } from '../../contracts/api'
import type { AiConnection, AiRun } from '../../contracts/ai'
import { parseLivingAdoptInput, parseLivingPrepareInput, parseOutlineFields, type LivingKind, type LivingOutline,
  type LivingProposal, type LivingRunDetail, type LivingSnapshot, type OutlineFields, type OutlineHistoryPage, type MemoryArchivePage, type OutlineProposal } from '../../contracts/living'
import { useToolSession } from './workbench-ui'
import { displayTime } from '../request'
import shared from '../StellarShared.module.css'
import styles from './StellarLiving.module.css'
import { BeatCardPicker } from './BeatCardPicker'
import { Dialog, DialogDisplayContext } from './Dialog'
import { StudioIcon } from './StudioIcon'

interface Props {
  api: StudioApi; book: BookSnapshot; chapter: ChapterSnapshot | null; disabled: boolean
  initialTab?: 'outline' | 'memory'; initialId?: string
  onDirtyChange: (value: boolean) => void; onBookChange: (value: BookSnapshot) => void
  onSnapshotChange: (value: LivingSnapshot) => void
  onNavigate: (chapterId: string) => void; onConfigure: () => void; onRecover: () => void
}
const kindLabels: Record<LivingKind, string> = { memory: '整理当前定稿', expand: '从末章继续补纲', rebase: '修整选定章纲' }
const natureLabels = { narrative_claim: '正文陈述', character_belief: '人物信念', ai_inference: '模型推断' }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

export function LivingPanel({ api, book, chapter, disabled, initialTab = 'outline', initialId, onDirtyChange, onBookChange, onSnapshotChange, onNavigate, onConfigure, onRecover }: Props) {
  const [snapshot, setSnapshot] = useState<LivingSnapshot | null>(null)
  const [tab, setTab] = useState(initialTab)
  const [memoryChapterId, setMemoryChapterId] = useState(chapter?.id ?? '')
  const [memoryState, setMemoryState] = useState<'all' | 'published' | 'stale' | 'superseded'>('all')
  const [memoryNature, setMemoryNature] = useState<'all' | 'narrative_claim' | 'character_belief' | 'ai_inference'>('all')
  const [archive, setArchive] = useState<{ page: MemoryArchivePage; chapterId: string } | null>(null)
  const [archiveBefore, setArchiveBefore] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState(initialId ?? chapter?.id ?? book.book.id)
  const [fields, setFields] = useState<OutlineFields | null>(null)
  const [locked, setLocked] = useState(false)
  const [outlineDirty, setOutlineDirty] = useState(false)
  const [history, setHistory] = useState<OutlineHistoryPage | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [chapterPage, setChapterPage] = useState(0)
  const [confirmAdopt, setConfirmAdopt] = useState(false)
  const [reviewingRebase, setReviewingRebase] = useState(true)
  const generationPanel = useRef<HTMLElement>(null)
  const outlineEditor = useRef<HTMLDetailsElement>(null)
  const [connections, setConnections] = useState<AiConnection[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [kind, setKind] = useState<LivingKind>(initialTab === 'memory' ? 'memory' : 'expand')
  const [anchorId, setAnchorId] = useState(chapter?.id ?? book.chapters[book.chapters.length - 1]?.id ?? '')
  const [instruction, setInstruction] = useState(initialTab === 'memory' ? '整理本章已经定稿的事件和人物状态，保留原文引文，区分正文陈述、人物信念与推断。' : '接续既有末章，按总纲和卷目标推进后续章节，每章给出三个可写的节拍。')
  const [count, setCount] = useState(3)
  const [targets, setTargets] = useState<string[]>([])
  const [manualIds, setManualIds] = useState<string[]>([])
  const [entityIds, setEntityIds] = useState<string[]>([])
  const [requestDirty, setRequestDirty] = useState(false)
  const [detail, setDetail] = useState<LivingRunDetail | null>(null)
  const [proposal, setProposal] = useState<LivingProposal | null>(null)
  const [proposalDirty, setProposalDirty] = useState(false)
  const [previewInput, setPreviewInput] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [pollStopped, setPollStopped] = useState(false)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [backupPath, setBackupPath] = useState<string | null>(null)
  const [preserved, setPreserved] = useState<string | null>(null)
  const [lastAttempt, setLastAttempt] = useState<{ command: string; input: unknown } | null>(null)
  const callbacks = useRef({ onDirtyChange, onBookChange, onSnapshotChange })
  callbacks.current = { onDirtyChange, onBookChange, onSnapshotChange }
  const guard = useRef({ tool: false, outline: false, proposal: false, request: false, running: false, uncertain: false })
  const mounted = useRef(true), initialRead = useRef(true)
  const report = () => callbacks.current.onDirtyChange(Object.values(guard.current).some(Boolean))
  const tool = useToolSession({ api, disabled, onDirtyChange: (value) => { guard.current.tool = value; report() } })
  const node = snapshot?.outlines.find((item) => item.id === selectedId)
  const run = detail?.run ?? null
  const blocked = tool.locked || book.book.archivedAt !== null || run?.state === 'running' || uncertain
  const canEdit = !blocked && !(node?.locked && locked)
  const editableProposal = !blocked && run?.state === 'succeeded' && !detail?.adopted
  const setGuard = (key: 'outline' | 'proposal' | 'request' | 'uncertain', value: boolean) => {
    guard.current[key] = value; report()
    if (key === 'outline') setOutlineDirty(value)
    if (key === 'proposal') setProposalDirty(value)
    if (key === 'request') setRequestDirty(value)
    if (key === 'uncertain') setUncertain(value)
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; initialRead.current = true; callbacks.current.onDirtyChange(false) }
  }, [])
  useEffect(() => { if (!disabled && initialRead.current) { initialRead.current = false; void load() } }, [disabled])
  useEffect(() => { guard.current.running = run?.state === 'running'; report() }, [run?.state])
  useEffect(() => { setConfirmAdopt(false) }, [proposal, snapshot?.bookRevision, run?.id, run?.version])
  useEffect(() => { if (proposal?.kind === 'rebase') setReviewingRebase(true) }, [run?.id, proposal?.kind])
  useEffect(() => {
    if (run?.state !== 'running' || tool.locked || pollStopped) return
    const timer = window.setTimeout(() => { void refreshRun() }, 1200)
    return () => window.clearTimeout(timer)
  }, [run?.id, run?.state, run?.version, tool.busy, tool.pending, disabled, pollStopped])

  function receiveSnapshot(value: LivingSnapshot, resetFields = false) {
    if (value.bookId !== book.book.id || value.schemaVersion < 2 || !Array.isArray(value.outlines)) throw new Error('Living identity mismatch')
    setSnapshot(value)
    callbacks.current.onSnapshotChange(value)
    const next = value.outlines.find((item) => item.id === selectedId) ?? value.outlines[0]
    if (next && (resetFields || !guard.current.outline)) { setSelectedId(next.id); setFields(next.fields); setLocked(next.locked) }
  }
  async function readArchive(beforeId?: string, previous = false) {
    if (blocked || outlineDirty || proposalDirty || requestDirty) return
    const selectedChapter = memoryChapterId
    await tool.read(() => api.listMemoryArchive({ bookId: book.book.id, ...(selectedChapter ? { chapterId: selectedChapter } : {}), ...(beforeId ? { beforeId } : {}) }), (value) => {
      if (value.bookId !== book.book.id || value.bookRevision !== snapshot?.bookRevision || !Array.isArray(value.items) || value.items.length > 20 ||
        value.items.some((item) => selectedChapter && item.chapterId !== selectedChapter)) throw new Error('Memory archive mismatch')
      setArchive({ page: value, chapterId: selectedChapter })
      setArchiveBefore((values) => beforeId ? previous ? values.slice(0, -1) : [...values, beforeId] : [])
    })
  }
  async function load() {
    if (outlineDirty || proposalDirty || requestDirty) { tool.setError('请先保存或明确放弃当前表单，再刷新资料。'); return }
    const loaded = await tool.read(() => api.getLiving({ bookId: book.book.id }), (value) => receiveSnapshot(value, true))
    if (!loaded || !mounted.current) return
    await tool.read(() => api.listAiConnections({ bookId: book.book.id }), (value) => {
      if (value.bookId !== book.book.id) throw new Error('Connection identity mismatch')
      setConnections(value.connections); setConnectionId((current) => value.connections.some((item) => item.id === current) ? current : value.connections[0]?.id ?? '')
    })
  }
  async function syncBook() {
    await tool.read(() => api.getBook({ bookId: book.book.id }), (value) => {
      if (value.book.id !== book.book.id) throw new Error('Book identity mismatch')
      callbacks.current.onBookChange(value)
    })
  }
  function selectNode(value: LivingOutline, edit = false) {
    if (blocked || outlineDirty || proposalDirty) { tool.setError('请先保存或放弃当前改动。'); return }
    setSelectedId(value.id); setFields(value.fields); setLocked(value.locked); setHistory(null)
    setEditorOpen(edit)
    if (edit) window.requestAnimationFrame(() => outlineEditor.current?.scrollIntoView({ block: 'nearest' }))
  }
  function editFields(value: OutlineFields) { setFields(value); setGuard('outline', true) }
  function editRequest(action: () => void) { action(); setGuard('request', true) }
  function editProposal(value: LivingProposal) { setProposal(value); setGuard('proposal', true) }
  async function save() {
    if (!snapshot || !node || !fields || blocked) return
    let next: OutlineFields
    try { next = parseOutlineFields(fields) } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '大纲内容无效。'); return }
    const expected = node.version + 1
    const input = { bookId: book.book.id, expectedBookRevision: snapshot.bookRevision, id: node.id, expectedVersion: node.version, fields: next, locked }
    setLastAttempt({ command: 'living.save', input })
    const saved = await tool.write('living.save', () => api.saveOutline(input),
    (value) => value.bookId === book.book.id && value.outlines.some((item) => item.id === node.id && item.version === expected && item.locked === locked && same(item.fields, next)),
    (value) => { setGuard('outline', false); receiveSnapshot(value, true); setHistory(null) }, '大纲已保存为新修订。')
    if (saved) await syncBook()
  }
  async function readHistory(beforeVersion?: number) {
    if (!node || blocked) return
    await tool.read(() => api.listOutlineHistory({ bookId: book.book.id, id: node.id, ...(beforeVersion === undefined ? {} : { beforeVersion }) }), (value) => {
      if (value.bookId !== book.book.id || value.id !== node.id) throw new Error('Outline history identity mismatch')
      setHistory((previous) => beforeVersion !== undefined && previous ? { ...value, items: [...previous.items, ...value.items] } : value)
    })
  }
  async function restore(revisionId: string) {
    if (!node || !snapshot || blocked || outlineDirty || node.locked) return
    const original = history?.items.find((item) => item.id === revisionId)
    if (!original) return
    const input = { bookId: book.book.id, expectedBookRevision: snapshot.bookRevision, id: node.id, expectedVersion: node.version, revisionId }
    setLastAttempt({ command: 'living.restore', input })
    const saved = await tool.write('living.restore', () => api.restoreOutline(input),
      (value) => value.bookId === book.book.id && value.outlines.some((item) => item.id === node.id && item.version === node.version + 1 && same(item.fields, original.fields)),
      (value) => { receiveSnapshot(value, true); setHistory(null) }, '已从所选历史建立新修订，原有版本完整保留。')
    if (saved) await syncBook()
  }
  async function upgrade() {
    if (!snapshot || !upgradeConfirmed || blocked) return
    const input = { bookId: book.book.id, expectedBookRevision: snapshot.bookRevision }
    setLastAttempt({ command: 'knowledge.upgrade', input })
    const saved = await tool.write('knowledge.upgrade', () => api.upgradeKnowledge(input),
      (value) => value.bookId === book.book.id && value.schemaVersion >= 16,
      (value) => { setBackupPath(value.backupPath ?? null); setUpgradeConfirmed(false) }, '作品备份与格式升级已确认。')
    if (saved) { await load(); await syncBook() }
  }
  function requestInput() {
    return parseLivingPrepareInput({ bookId: book.book.id, expectedBookRevision: snapshot?.bookRevision, chapterId: anchorId, connectionId, kind, instruction,
      targetIds: kind === 'rebase' ? targets : [], confirmManualIds: kind === 'rebase' ? manualIds : [], entityIds, count })
  }
  async function prepare() {
    if (blocked || outlineDirty || proposalDirty || !snapshot) return
    let input: ReturnType<typeof requestInput>
    try { input = requestInput() } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请核对本次范围。'); return }
    setLastAttempt({ command: 'living.prepare', input })
    const saved = await tool.write('living.prepare', () => api.prepareLiving(input),
      (value) => value.bookId === book.book.id && value.kind === kind && value.run.bookId === book.book.id && value.run.chapterId === input.chapterId && value.run.state === 'prepared' && value.run.context.purpose === 'living' && value.run.context.bookRevision === input.expectedBookRevision,
      (value) => { setDetail(value); setProposal(null); setPreviewInput(JSON.stringify(input)); setGuard('request', false); setPollStopped(false) }, '预览已保存。确认发送后才会调用模型。')
    if (saved) await tool.read(() => api.getLiving({ bookId: book.book.id }), (value) => receiveSnapshot(value, true))
  }
  function receiveRun(value: LivingRunDetail) {
    if (value.bookId !== book.book.id || value.run.bookId !== book.book.id || value.run.context.purpose !== 'living' || (run && value.run.id !== run.id)) throw new Error('Run identity mismatch')
    setDetail(value)
    if (!guard.current.proposal) setProposal(value.proposal)
    setGuard('uncertain', false)
  }
  async function refreshRun(id = run?.id) {
    if (!id || tool.locked) return
    const loaded = await tool.read(async () => {
      // 先通过桌面会话补存终态，再从书库读取提案；直接读领域仓储无法处理主进程的待存结果。
      const settled = await api.getAiRun({ bookId: book.book.id, runId: id })
      if (!settled.ok) return settled
      const result = await api.getLivingRun({ bookId: book.book.id, runId: id })
      if (result.ok && result.data.run.state === 'running') result.data.run.active = settled.data.active
      return result
    }, (value) => {
      if (value.run.id !== id) throw new Error('Requested run mismatch')
      if (id !== run?.id) {
        const input = value.request
        if (input.bookId !== book.book.id || input.chapterId !== value.run.chapterId || input.connectionId !== value.run.context.connection.id) throw new Error('Stored request identity mismatch')
        setKind(input.kind); setAnchorId(input.chapterId); setConnectionId(input.connectionId); setInstruction(input.instruction)
        setCount(input.count); setTargets(input.targetIds); setManualIds(input.confirmManualIds); setEntityIds(input.entityIds)
        setDetail(value); setProposal(value.proposal); setPreviewInput(JSON.stringify(input)); setGuard('uncertain', false)
      }
      else receiveRun(value)
    })
    if (!loaded) setPollStopped(true)
  }
  async function control(action: 'start' | 'cancel' | 'interrupt') {
    if (!run || tool.locked || proposalDirty || outlineDirty) return
    if (action === 'start') {
      let current: string
      try { current = JSON.stringify(requestInput()) } catch { tool.setError('输入已变化，请重新准备预览。'); return }
      if (current !== previewInput) { tool.setError('输入或范围已变化，请重新准备预览。'); return }
      setGuard('request', false)
    }
    setLastAttempt({ command: `ai.${action}`, input: { bookId: book.book.id, runId: run.id,
      ...(action === 'cancel' ? {} : { expectedVersion: run.version }), ...(action === 'start' ? { contextHash: run.context.contextHash } : {}) } })
    setGuard('uncertain', true)
    const success = await tool.read(() => action === 'start'
      ? api.startAiRun({ bookId: book.book.id, runId: run.id, expectedVersion: run.version, contextHash: run.context.contextHash })
      : action === 'cancel' ? api.cancelAiRun({ bookId: book.book.id, runId: run.id })
        : api.interruptAiRun({ bookId: book.book.id, runId: run.id, expectedVersion: run.version }), (value: AiRun) => {
      if (value.bookId !== book.book.id || value.id !== run.id || value.context.contextHash !== run.context.contextHash) throw new Error('Model control identity mismatch')
      setDetail((previous) => previous ? { ...previous, run: value } : previous); setGuard('uncertain', false); setPollStopped(false)
    })
    if (success) await refreshRun()
  }
  async function adopt() {
    if (!snapshot || !run || !proposal || blocked || outlineDirty || detail?.adopted) return
    let input: ReturnType<typeof parseLivingAdoptInput>
    try { input = parseLivingAdoptInput({ bookId: book.book.id, expectedBookRevision: snapshot.bookRevision, runId: run.id, expectedRunVersion: run.version, proposal }) }
    catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '采用内容无效。'); return }
    setLastAttempt({ command: 'living.adopt', input })
    const adopted = await tool.write('living.adopt', () => api.adoptLiving(input),
      (value) => value.bookId === book.book.id && value.runId === run.id && value.book.book.id === book.book.id && value.snapshot.bookId === book.book.id && value.refs.length === (proposal.kind === 'memory' ? 1 : proposal.chapters.length),
      (value) => { setGuard('proposal', false); receiveSnapshot(value.snapshot, true); callbacks.current.onBookChange(value.book); setDetail((previous) => previous ? { ...previous, adopted: true } : previous) }, '采用已确认，来源与回执已在同一事务保存。')
    if (adopted) { setConfirmAdopt(false); await refreshRun() }
  }
  function discard() {
    if (blocked) return
    if (node) { setFields(node.fields); setLocked(node.locked) }
    setProposal(detail?.proposal ?? null)
    if (detail) {
      const input = detail.request
      setKind(input.kind); setAnchorId(input.chapterId); setConnectionId(input.connectionId); setInstruction(input.instruction)
      setCount(input.count); setTargets(input.targetIds); setManualIds(input.confirmManualIds); setEntityIds(input.entityIds)
    }
    setGuard('outline', false); setGuard('proposal', false); setGuard('request', false)
    setPreviewInput(null); tool.setError(null)
  }

  const chapterNodes = snapshot?.outlines.filter((item) => item.scope === 'chapter') ?? []
  const bookNode = snapshot?.outlines.find((item) => item.scope === 'book')
  const volumeNodes = snapshot?.outlines.filter((item) => item.scope === 'volume') ?? []
  const volumeId = node?.scope === 'volume' ? node.id : node?.scope === 'chapter' ? node.parentId : volumeNodes[0]?.id ?? null
  const volumeNode = volumeNodes.find((item) => item.id === volumeId)
  const volumeChapters = chapterNodes.filter((item) => item.parentId === volumeId)
  const chapterPages = Math.max(1, Math.ceil(volumeChapters.length / 18))
  const visibleChapterPage = Math.min(chapterPage, chapterPages - 1)
  useEffect(() => { setChapterPage(0) }, [volumeId])
  const archiveCurrent = archive?.chapterId === memoryChapterId && archive.page.bookRevision === snapshot?.bookRevision
  const visibleMemories = archiveCurrent ? archive!.page.items : snapshot?.memories ?? []
  const plotted = volumeChapters.slice(-120)
  let low = 0, high = 0, rhythmParent: string | null = null
  const rhythmWarnings = chapterNodes.flatMap((item) => {
    if (rhythmParent !== item.parentId) { low = 0; high = 0; rhythmParent = item.parentId }
    low = item.fields.tension !== null && item.fields.tension < 50 ? low + 1 : 0
    high = item.fields.tension !== null && item.fields.tension > 85 ? high + 1 : 0
    return low === 4 || high === 5 ? [`${item.fields.title}：${low === 4 ? '连续四章紧张度低于50，可检查是否需要转折。' : '连续五章紧张度高于85，可检查是否需要缓冲。'}`] : []
  })
  let matchesPreview = false
  try { matchesPreview = previewInput !== null && JSON.stringify(requestInput()) === previewInput } catch { /* 尚未形成有效预览。 */ }
  const recoveryRecord = tool.error || tool.pending || tool.readFailure || uncertain ? JSON.stringify({ version: 1, workflow: 'living', bookId: book.book.id, bookRevision: snapshot?.bookRevision ?? book.book.revision,
    tab, outline: { selectedId, base: node, fields, locked, dirty: outlineDirty },
    request: { kind, chapterId: anchorId, connectionId, instruction, count, targetIds: targets, confirmManualIds: manualIds, entityIds },
    requestDirty, detail, proposal, proposalDirty, previewInput, uncertain, backupPath, lastAttempt, error: tool.error,
    pending: tool.pending ? { command: tool.pending.command, error: tool.pending.error } : null, readFailure: tool.readFailure }, null, 2) : ''

  return <div className={styles.panel} aria-busy={tool.busy}>
    <div className={styles.toolbar}>
      <div className={styles.tabs} role="group" aria-label="创作资料视图">
        <button type="button" aria-pressed={tab === 'outline'} disabled={blocked || outlineDirty || proposalDirty} onClick={() => setTab('outline')}>演进大纲</button>
        <button type="button" aria-pressed={tab === 'memory'} disabled={blocked || outlineDirty || proposalDirty} onClick={() => { setTab('memory'); setKind('memory') }}>定稿记忆</button>
      </div>
      <div className={styles.actions}><button className={shared.button} type="button" disabled={blocked || outlineDirty || proposalDirty || requestDirty} onClick={() => void load()}>刷新资料</button>
        {(outlineDirty || proposalDirty || requestDirty) && <button className={shared.button} type="button" disabled={blocked} onClick={discard}>放弃未保存表单</button>}</div>
    </div>
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
    {tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {tool.pending && <div className={styles.warning}><p>原写入结果待核对，当前表单已保留。</p><button type="button" className={shared.button} disabled={tool.busy || !tool.pending.error.requestId} onClick={() => { void tool.checkReceipt().then(async (confirmed) => { if (confirmed) { await tool.read(() => api.getLiving({ bookId: book.book.id }), (value) => receiveSnapshot(value, true)); await syncBook() } }) }}>查询原请求回执</button></div>}
    {tool.readFailure && <div className={styles.warning} role="status"><p>原读取或模型控制结果待核对。{tool.readFailure.requestId ? `请求编号：${tool.readFailure.requestId}` : '未取得可查询的编号，请留存后进入恢复。'}</p>
      <button type="button" className={shared.button} disabled={tool.locked || !tool.readFailure.requestId} onClick={() => void tool.checkReadReceipt()}>核对原读取请求</button></div>}
    {(tool.error || tool.pending || tool.readFailure || uncertain) && <details className={styles.section} open={Boolean(tool.pending || tool.readFailure || uncertain)}><summary>留存当前大纲、提案与请求记录</summary>
      <p className={styles.note}>恢复会离开本页。请复制下方完整内容到安全位置；其中保留未保存编辑和已读取的模型输出。未补存的模型终态仍由桌面恢复流程处理。</p>
      <label>演进内容与恢复记录<textarea readOnly rows={8} value={recoveryRecord} onFocus={(event) => event.target.select()} /></label>
      <label className={styles.check}><input type="checkbox" checked={preserved === recoveryRecord} disabled={disabled || tool.busy} onChange={(event) => setPreserved(event.target.checked ? recoveryRecord : null)} />我已留存当前完整内容</label>
      <button type="button" className={shared.button} disabled={disabled || tool.busy || preserved !== recoveryRecord} onClick={() => { if (!disabled && !tool.busy && preserved === recoveryRecord) onRecover() }}>已留存，进入草稿与服务恢复</button>
    </details>}
    {uncertain && <p className={styles.warning} role="status">模型操作结果待核对。请读取原提案状态，再决定后续操作。</p>}
    {!snapshot && <p role="status">正在读取作品的大纲与记忆来源…</p>}
    {snapshot?.requiresUpgrade && <section className={styles.section}><h2>启用演进大纲与记忆发布</h2><p>当前作品格式为 v{snapshot.schemaVersion}。升级会先保留完整备份，再追加 v16 的大纲历史、记忆批次和采用回执。</p>
      <label className={styles.check}><input type="checkbox" checked={upgradeConfirmed} disabled={blocked} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />确认先备份，再升级这部作品</label>
      <button className={shared.primaryButton} type="button" disabled={blocked || !upgradeConfirmed} onClick={() => void upgrade()}>备份并升级</button></section>}
    {backupPath && <p className={styles.note}>本次备份：{backupPath}</p>}
    {proposal?.kind === 'rebase' && tab === 'outline' && <div className={styles.actions}><button type="button" className={shared.button} onClick={() => setReviewingRebase((value) => !value)}><StudioIcon name={reviewingRebase ? 'arrow' : 'workflow'} size={20} />{reviewingRebase ? '返回大纲沙盘' : '查看修纲三栏对照'}</button></div>}
    {snapshot && !snapshot.requiresUpgrade && <div className={styles.workspace} data-view={tab} data-review={tab === 'outline' && reviewingRebase && proposal?.kind === 'rebase' ? 'rebase' : undefined}>
      {tab === 'outline' ? <div className={styles.outlineLayout}>
        <nav className={styles.tree} aria-label="总纲与分卷">
          {bookNode && <button type="button" className={`${styles.treeItem} ${selectedId === bookNode.id ? styles.selected : ''}`} aria-current={selectedId === bookNode.id ? 'true' : undefined} disabled={blocked} onClick={() => selectNode(bookNode)}><StudioIcon name="compass" size={24} /><strong>全书总纲</strong><small>{bookNode.locked ? '已锁定' : bookNode.stale ? '待复核' : bookNode.version ? `修订 ${bookNode.version}` : '尚未保存'}</small></button>}
          {volumeNodes.map((item, index) => {
            const chapters = chapterNodes.filter((entry) => entry.parentId === item.id)
            return <button key={item.id} type="button" className={`${styles.treeItem} ${item.id === volumeId ? styles.selected : ''}`} aria-current={item.id === selectedId ? 'true' : undefined} data-scope="volume" data-tone={index % 3} disabled={blocked} onClick={() => selectNode(item)}>
              <StudioIcon name="orbit" size={32} /><strong>{item.fields.title}</strong><span>{chapters.length ? `第 ${chapters[0]!.position + 1}–${chapters.at(-1)!.position + 1} 章` : '尚无章纲'}</span><small>{item.stale ? '待复核' : item.locked ? '已锁定' : item.manual ? '作者手改' : `${chapters.length} 章`}</small>
            </button>
          })}
          {chapterNodes.some((item) => item.parentId === null) && <button type="button" className={`${styles.treeItem} ${volumeId === null && node?.scope === 'chapter' ? styles.selected : ''}`} disabled={blocked} onClick={() => selectNode(chapterNodes.find((item) => item.parentId === null)!)}><StudioIcon name="list" size={24} /><strong>未分卷章节</strong><small>{chapterNodes.filter((item) => item.parentId === null).length} 章</small></button>}
        </nav>
        <section className={styles.editor} aria-label="大纲沙盘">
          <OutlineTensionChart outlines={plotted} disabled={blocked || outlineDirty || proposalDirty} onSelect={(item) => selectNode(item, true)} />
          {rhythmWarnings.length > 0 && <details className={styles.rhythmNotes}><summary>节奏提醒 · {rhythmWarnings.length} 条</summary><ul>{rhythmWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
          {bookNode && <div className={styles.overviewCards} aria-label="总纲四卡">{([
            ['summary', '大纲内容', 'compass'], ['goal', '目标', 'orbit'], ['conflict', '核心冲突', 'bolt'], ['hook', '高潮与收束', 'spark'],
          ] as const).map(([key, label, icon]) => <button key={key} type="button" className={styles.outlineCard} data-field={key} disabled={blocked} onClick={() => selectNode(bookNode, true)}>
            <StudioIcon name={bookNode.locked ? 'lock' : icon} size={32} /><strong>{label}</strong><p>{bookNode.fields[key] || '尚未填写'}</p><small>{bookNode.locked ? '已锁定' : bookNode.stale ? '待复核' : bookNode.version ? `修订 ${bookNode.version}` : '待建立'}</small>
          </button>)}</div>}
          {volumeNode && <button type="button" className={styles.volumeLine} disabled={blocked} onClick={() => selectNode(volumeNode, true)}><StudioIcon name={volumeNode.locked ? 'lock' : 'spark'} size={32} /><span><strong>{volumeNode.fields.title}</strong><small>{volumeNode.fields.goal || volumeNode.fields.summary || '填写本卷推进方向'}</small></span><StudioIcon name="chevron" size={20} /></button>}
          {node && fields && <details ref={outlineEditor} className={styles.outlineEditor} open={editorOpen} onToggle={(event) => setEditorOpen(event.currentTarget.open)}>
            <summary>编辑{node.scope === 'book' ? '全书总纲' : node.scope === 'volume' ? '本卷主线' : '本章大纲'} · {fields.title}{outlineDirty ? ' · 未保存修改' : ''}</summary>
            <div className={styles.section}>
          <div className={styles.editorHeading}><div><h2>{node.scope === 'book' ? '总纲' : node.scope === 'volume' ? '分卷主线' : '章节大纲'}</h2><p>修订 {node.version || '尚未保存'} · {node.manual ? '作者内容' : '生成计划'}</p></div>
            <label className={styles.check}><input type="checkbox" checked={locked} disabled={blocked} onChange={(event) => { setLocked(event.target.checked); setGuard('outline', true) }} />锁定内容</label></div>
          {node.stale && <p className={styles.warning}>{node.staleReason} 请比较当前来源；确认内容仍适用后保存新修订。</p>}
          <OutlineFieldsEditor fields={fields} chapter={node.scope === 'chapter'} disabled={!canEdit} onChange={editFields} />
          {node.scope === 'chapter' && <BeatCardPicker key={node.id} api={api} disabled={!canEdit} onApply={(beatSource, beats) => editFields({ ...fields, beats, beatSource })} />}
          {fields.beatSource && <details className={styles.note}><summary>本章引用的节拍来源 · {fields.beatSource.title} · v{fields.beatSource.revision}</summary><p>固定来源 {fields.beatSource.id}；采用时的卡片正文随大纲修订保留。</p><pre>{fields.beatSource.body}</pre></details>}
          <div className={styles.actions}><button className={shared.primaryButton} type="button" disabled={blocked || !outlineDirty} onClick={() => void save()}>保存大纲新修订</button>{node.stale && !outlineDirty && <button className={shared.button} type="button" disabled={blocked || proposalDirty} onClick={() => void save()}>确认内容仍适用，保存复核修订</button>}<button className={shared.button} type="button" disabled={blocked} onClick={() => void readHistory()}>查看版本历史</button>{node.scope === 'chapter' && <button type="button" className={shared.button} disabled={blocked || outlineDirty || proposalDirty} onClick={() => onNavigate(node.id)}>进入本章写作</button>}</div>
          {history && <div className={styles.history}><h3>大纲修订历史</h3>{history.items.length === 0 && <p>保存一次大纲后，这里会记录可追溯的版本。</p>}{history.items.map((item) => <details key={item.id}><summary>版本 {item.version} · {item.origin === 'manual' ? '作者保存' : item.origin === 'restored' ? '历史恢复' : 'AI 采纳'} · {displayTime(item.createdAt)}</summary><pre>{JSON.stringify(item.fields, null, 2)}</pre><button type="button" className={shared.button} disabled={blocked || outlineDirty || node.locked || item.version === node.version} onClick={() => void restore(item.id)}>以此版本建立新修订</button></details>)}{history.nextBeforeVersion !== null && <button className={shared.button} type="button" disabled={blocked} onClick={() => void readHistory(history.nextBeforeVersion!)}>读取更早版本</button>}</div>}
            </div>
          </details>}
        </section>
        <section className={styles.chapterBoard} aria-label="本卷章纲卡片">
          <div className={styles.editorHeading}><h3>{volumeNode ? '本卷章纲' : '章节大纲'}</h3><small>{volumeChapters.length} 章</small></div>
          {volumeChapters.length ? <div className={styles.chapterCards}>{volumeChapters.slice(visibleChapterPage * 18, (visibleChapterPage + 1) * 18).map((item) => <article key={item.id} className={styles.chapterCard} data-selected={item.id === selectedId}>
            <button type="button" className={styles.chapterSelect} disabled={blocked} onClick={() => selectNode(item, true)}><StudioIcon name={item.locked ? 'lock' : 'spark'} size={20} /><small>第 {item.position + 1} 章</small><strong>{item.fields.title}</strong><span data-state={item.stale ? 'stale' : item.locked ? 'locked' : 'ready'}>{item.stale ? '待复核' : item.locked ? '已锁定' : item.manual ? '作者手改' : '生成计划'}</span></button>
            <button type="button" className={styles.chapterWrite} disabled={blocked || outlineDirty || proposalDirty} title="进入本章写作" onClick={() => onNavigate(item.id)}><StudioIcon name="pen" size={16} />写作</button>
          </article>)}</div> : <div className={styles.empty}><StudioIcon name="list" size={32} /><p>尚无章纲。可先填写总纲，再选择参考章节补纲。</p><button type="button" className={shared.button} onClick={() => generationPanel.current?.scrollIntoView({ block: 'nearest' })}>前往 AI 续推</button></div>}
          {chapterPages > 1 && <div className={styles.actions}><button type="button" className={shared.button} disabled={visibleChapterPage === 0} onClick={() => setChapterPage(visibleChapterPage - 1)}>上一页</button><small>{visibleChapterPage + 1} / {chapterPages}</small><button type="button" className={shared.button} disabled={visibleChapterPage + 1 === chapterPages} onClick={() => setChapterPage(visibleChapterPage + 1)}>下一页</button></div>}
        </section>
      </div> : <section className={styles.memoryList}><div><h2>定稿记忆归档与来源</h2><p>摘要、事件和状态由作者确认后发布。修改来源后会提示待复核，旧批次保留。正文陈述、人物信念与模型推断分别核对。</p></div>
        <div className={styles.fieldGrid}><label>归档章节<select value={memoryChapterId} onChange={(event) => setMemoryChapterId(event.target.value)}><option value="">全部已加载章节</option>{book.chapters.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>批次状态<select value={memoryState} onChange={(event) => setMemoryState(event.target.value as typeof memoryState)}><option value="all">全部状态</option><option value="published">当前有效</option><option value="stale">待复核</option><option value="superseded">历史批次</option></select></label><label>事件与状态性质<select value={memoryNature} onChange={(event) => setMemoryNature(event.target.value as typeof memoryNature)}><option value="all">全部性质及摘要</option>{Object.entries(natureLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        <div className={styles.actions}><button type="button" className={shared.button} disabled={blocked || outlineDirty || proposalDirty || requestDirty} onClick={() => void readArchive()}>查询所选章节的全部归档</button>
          {archiveCurrent && <><button type="button" className={shared.button} disabled={blocked || !archiveBefore.length} onClick={() => void readArchive(archiveBefore.length > 1 ? archiveBefore[archiveBefore.length - 2] : undefined, true)}>上一页批次</button><button type="button" className={shared.button} disabled={blocked || !archive!.page.nextBeforeId} onClick={() => void readArchive(archive!.page.nextBeforeId!)}>下一页批次</button><span className={styles.note}>当前范围共 {archive!.page.total} 批，每页最多 20 批；状态和性质筛选只影响本页。</span></>}
        </div>
        {snapshot.memories.length === 0 && <p className={styles.empty}>先写一章并定稿，再在下方整理。每条事件和状态都能查看原文引文。</p>}
        {visibleMemories.filter((memory) => (!memoryChapterId || memory.chapterId === memoryChapterId) && (memoryState === 'all' || memory.state === memoryState)).map((memory) => <article key={memory.id} className={styles.memory}><div className={styles.editorHeading}><h3>{memory.chapterTitle}</h3><span data-state={memory.state}>{memory.state === 'published' ? '当前有效' : memory.state === 'stale' ? '待复核' : '历史批次'}</span></div><p>{memory.proposal.summary.text}</p>{memory.staleReason && <p className={styles.warning}>{memory.staleReason}</p>}
          <details><summary>查看事件、状态与定稿引文</summary>{[
            { label: '本章摘要', nature: null, note: memory.proposal.summary },
            ...memory.proposal.events.map((item) => ({ label: item.title, nature: item.nature, note: item })),
            ...memory.proposal.states.map((item) => ({ label: item.attribute, nature: item.nature, note: item })),
          ].filter((item) => memoryNature === 'all' || item.nature === memoryNature).map(({ label, nature, note }, index) => <div className={styles.evidence} key={index}>
            <p>{label} · {nature === null ? '整理资料' : natureLabels[nature]}</p><p>{note.text}</p>{note.citations.map((citation, at) => <blockquote key={at}>{citation.quote}<small>段落 {citation.blockId}</small></blockquote>)}
          </div>)}</details><button className={shared.button} type="button" disabled={blocked || outlineDirty || proposalDirty} onClick={() => onNavigate(memory.chapterId)}>打开来源章节</button><small>定稿修订 {memory.revisionId} · {displayTime(memory.createdAt)}</small></article>)}
        {!archiveCurrent && <p className={styles.note}>默认载入最近 {snapshot.memories.length} 个批次，共 {snapshot.memoryTotal} 个；查询所选章节可分页读取更早批次。</p>}
      </section>}

      <section ref={generationPanel} className={styles.generation}><div className={styles.editorHeading}><div><h2><StudioIcon name="spark" size={20} />{tab === 'outline' ? 'AI 滚动续推' : '整理定稿记忆'}</h2><p>先固定来源和范围，再确认发送；生成结果经审阅后采纳。</p></div><button type="button" className={shared.button} disabled={blocked || outlineDirty || proposalDirty || requestDirty} onClick={onConfigure}>模型配置与副驾驶</button></div>
        <div className={styles.fieldGrid}><label>本次任务<select value={kind} disabled={blocked} onChange={(event) => editRequest(() => setKind(event.target.value as LivingKind))}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>模型连接<select value={connectionId} disabled={blocked} onChange={(event) => editRequest(() => setConnectionId(event.target.value))}><option value="">请选择已保存连接</option>{connections.map((connection) => <option value={connection.id} key={connection.id}>{connection.name} · {connection.model}</option>)}</select></label></div>
        <div className={styles.fieldGrid}><label>{kind === 'memory' ? '固定定稿章节' : '当前参考章节'}<select value={anchorId} disabled={blocked} onChange={(event) => editRequest(() => setAnchorId(event.target.value))}><option value="">请选择章节</option>{book.chapters.map((item) => <option key={item.id} value={item.id}>{item.position + 1}. {item.title}{item.status === 'finalized' ? ' · 已定稿' : ''}</option>)}</select></label>{kind === 'expand' && <label>末章后新增章纲数量<select value={count} disabled={blocked} onChange={(event) => editRequest(() => setCount(Number(event.target.value)))}>{[1, 2, 3].map((value) => <option key={value} value={value}>{value} 章</option>)}</select></label>}</div>
        {kind === 'rebase' && <fieldset className={styles.range}><legend>明确本次修纲范围（最多十章）</legend>{chapterNodes.map((item) => {
          const chapter = book.chapters.find((value) => value.id === item.id), eligible = chapter?.status === 'planned' && chapter.characterCount === 0 && !chapter.finalizedRevisionId && !item.locked
          return <div key={item.id}><label className={styles.check}><input type="checkbox" checked={targets.includes(item.id)} disabled={blocked || !eligible || (!targets.includes(item.id) && targets.length >= 10)} onChange={(event) => editRequest(() => { setTargets((values) => event.target.checked ? [...values, item.id] : values.filter((value) => value !== item.id)); if (!event.target.checked) setManualIds((values) => values.filter((value) => value !== item.id)) })} />{item.fields.title}{item.locked ? ' · 已锁定' : !eligible ? ' · 已开始写作' : item.stale ? ' · 待复核' : ''}</label>
            {targets.includes(item.id) && item.manual && <label className={styles.check}><input type="checkbox" checked={manualIds.includes(item.id)} disabled={blocked} onChange={(event) => editRequest(() => setManualIds((values) => event.target.checked ? [...values, item.id] : values.filter((value) => value !== item.id)))} />允许本次替换这章已有的作者章纲</label>}</div>
        })}</fieldset>}
        <details><summary>选择本次需要识别的实体（{entityIds.length}/30）</summary><p className={styles.note}>只列已采用、当前且无候选冲突的实体；未选实体的状态不会由本次整理自动补全。</p><div className={styles.entityChoices}>{snapshot.entities.map((entity) => <label className={styles.check} key={entity.id}><input type="checkbox" checked={entityIds.includes(entity.id)} disabled={blocked || (!entityIds.includes(entity.id) && entityIds.length >= 30)} onChange={(event) => editRequest(() => setEntityIds((values) => event.target.checked ? [...values, entity.id] : values.filter((value) => value !== entity.id)))} />{entity.name}</label>)}</div>{snapshot.entityTotal > snapshot.entities.length && <p>当前列出 {snapshot.entities.length}/{snapshot.entityTotal} 个可选实体。</p>}</details>
        <label>你的要求<textarea value={instruction} rows={3} maxLength={2000} disabled={blocked} onChange={(event) => editRequest(() => setInstruction(event.target.value))} /></label>
        <button className={shared.primaryButton} type="button" disabled={blocked || outlineDirty || proposalDirty || !connectionId || !anchorId || !instruction.trim()} onClick={() => void prepare()}>保存并预览本次请求</button>
      </section>
      {run && <section className={styles.proposal}><div className={styles.editorHeading}><h2>{kindLabels[detail!.kind]} · {detail?.adopted ? '已采纳' : run.state === 'running' ? '生成中' : run.state === 'succeeded' ? '待审阅' : run.state}</h2><div className={styles.actions}><button type="button" className={shared.button} disabled={tool.locked} onClick={() => { setPollStopped(false); void refreshRun() }}>核对原提案状态</button>{run.state === 'running' && <button type="button" className={shared.button} disabled={tool.locked} onClick={() => void control(run.active === false ? 'interrupt' : 'cancel')}>{run.active === false ? '标记无会话运行为中断' : '取消并保留输出'}</button>}</div></div>
        <details><summary>本次固定发送内容 · {run.model} · 估算输入 {run.context.estimatedInputTokens} tokens</summary>{run.context.messages.map((message, index) => <pre key={index}>{message.role}{'\n'}{message.content}</pre>)}</details>
        {run.state === 'prepared' && <><p className={styles.note}>{matchesPreview ? '输入与预览一致，确认后发起模型请求。' : '当前输入与原预览不一致。重新准备预览后可发送。'}</p><button className={shared.primaryButton} type="button" disabled={blocked || !matchesPreview || outlineDirty || proposalDirty} onClick={() => void control('start')}>确认发送给模型</button></>}
        {detail?.parseError && <p className={styles.warning}>{detail.parseError}</p>}
        {run.error && <p className={styles.warning}>{run.error}</p>}
        {proposal?.kind === 'memory' && <><label>本章摘要<textarea rows={4} value={proposal.summary.text} maxLength={8000} disabled={!editableProposal} onChange={(event) => editProposal({ ...proposal, summary: { ...proposal.summary, text: event.target.value } })} /></label><p className={styles.note}>摘要作为整理资料保存。下方事件和状态可修改性质、编辑说明或取消采用，引文保持原样。</p>
          {proposal.events.map((event, index) => <fieldset className={styles.reviewItem} key={`event-${index}`}><legend>{event.title}</legend><select aria-label={`${event.title}的知识性质`} value={event.nature} disabled={!editableProposal} onChange={(value) => editProposal({ ...proposal, events: proposal.events.map((item, at) => at === index ? { ...item, nature: value.target.value as typeof event.nature } : item) })}>{Object.entries(natureLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><textarea aria-label={`${event.title}的说明`} value={event.text} rows={3} maxLength={8000} disabled={!editableProposal} onChange={(value) => editProposal({ ...proposal, events: proposal.events.map((item, at) => at === index ? { ...item, text: value.target.value } : item) })} />{event.citations.map((citation, at) => <blockquote key={at}>{citation.quote}</blockquote>)}<button type="button" className={shared.button} disabled={!editableProposal} onClick={() => editProposal({ ...proposal, events: proposal.events.filter((_, at) => at !== index) })}>本次不采用此事件</button></fieldset>)}
          {proposal.states.map((state, index) => <fieldset className={styles.reviewItem} key={`state-${index}`}><legend>{snapshot.entities.find((entity) => entity.id === state.entityId)?.name ?? state.entityId} · {state.attribute}</legend><select aria-label={`${state.attribute}的知识性质`} value={state.nature} disabled={!editableProposal} onChange={(value) => editProposal({ ...proposal, states: proposal.states.map((item, at) => at === index ? { ...item, nature: value.target.value as typeof state.nature } : item) })}>{Object.entries(natureLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><textarea aria-label={`${state.attribute}的说明`} value={state.text} rows={3} maxLength={8000} disabled={!editableProposal} onChange={(value) => editProposal({ ...proposal, states: proposal.states.map((item, at) => at === index ? { ...item, text: value.target.value } : item) })} />{state.citations.map((citation, at) => <blockquote key={at}>{citation.quote}</blockquote>)}<button type="button" className={shared.button} disabled={!editableProposal} onClick={() => editProposal({ ...proposal, states: proposal.states.filter((_, at) => at !== index) })}>本次不采用此状态</button></fieldset>)}</>}
        {proposal?.kind === 'rebase' && <OutlineRebaseReview proposal={proposal} targets={detail?.targets ?? []} current={snapshot.outlines} sourceTitle={book.chapters.find((item) => item.id === run.chapterId)?.title ?? '固定来源章节'} adopted={detail?.adopted ?? false} disabled={!editableProposal} onChange={editProposal} />}
        {proposal?.kind === 'expand' && proposal.chapters.map((entry, index) => {
          const original = detail?.targets.find((item) => item.id === entry.chapterId)
          return <section className={styles.outlineDiff} key={entry.chapterId ?? index}>
            <h3>{entry.chapterId ? `修整：${original?.fields.title ?? ''}` : `新增章纲 ${index + 1}`}</h3>
            <div className={entry.chapterId ? styles.fieldGrid : styles.section}>
              {original && <div><h4>本次预览固定的原章纲 · 修订 {original.version}</h4><pre>{JSON.stringify(original.fields, null, 2)}</pre></div>}
              <div className={styles.section}><h4>待采纳章纲</h4><OutlineFieldsEditor fields={entry.fields} chapter disabled={!editableProposal}
                onChange={(next) => editProposal({ ...proposal, chapters: proposal.chapters.map((item, at) => at === index ? { ...item, fields: next } : item) })} /></div>
            </div>
          </section>
        })}
        {proposal && run.state === 'succeeded' && !detail?.adopted && <div className={styles.adoptBar}><button type="button" className={shared.primaryButton} disabled={!editableProposal || outlineDirty} onClick={() => proposal.kind === 'memory' ? void adopt() : setConfirmAdopt(true)}><StudioIcon name="check" size={20} />{proposal.kind === 'memory' ? '确认发布所选记忆' : `采纳 ${proposal.chapters.length} 项章纲`}</button>{proposal.kind === 'rebase' && <button type="button" className={shared.button} disabled={blocked} onClick={() => { setReviewingRebase(false); window.requestAnimationFrame(() => generationPanel.current?.scrollIntoView({ block: 'start' })) }}>返回核对手改与修纲范围</button>}<span>作品修订 {snapshot.bookRevision} · 提案修订 {run.version}</span></div>}
        <details open={run.state === 'running' || Boolean(detail?.parseError)}><summary>保留的模型原始输出（{run.outputText.length.toLocaleString()} 字符）</summary><pre>{run.outputText || '等待模型输出…'}</pre></details>
      </section>}
      {snapshot.runs.length > 0 && <section className={styles.runHistory}><h3>最近的整理与修纲提案</h3>{snapshot.runs.map((item) => <button className={shared.button} type="button" key={item.id} disabled={blocked || outlineDirty || proposalDirty || requestDirty} onClick={() => void refreshRun(item.id)}>{kindLabels[item.kind]} · {item.state} · {displayTime(item.createdAt)}</button>)}</section>}
    </div>}
    {confirmAdopt && proposal && proposal.kind !== 'memory' && run && snapshot && <DialogDisplayContext.Provider value="modal"><Dialog title="采纳本次章纲？" onClose={() => setConfirmAdopt(false)} busy={tool.busy}>
      <div className={styles.section}><p>{proposal.kind === 'expand' ? `将新增 ${proposal.chapters.length} 章。` : `将替换明确选择的 ${proposal.chapters.length} 项章纲；范围外的手改保持原样。`}</p>
        <p className={styles.note}>作品修订 {snapshot.bookRevision} · 提案修订 {run.version}。采用时继续核对来源、锁定状态和作者授权；版本变化会停止写入。</p>
        {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
        <div className={styles.actions}><button type="button" className={shared.button} disabled={tool.busy} onClick={() => setConfirmAdopt(false)}>返回审阅</button><button type="button" className={shared.primaryButton} disabled={!editableProposal || outlineDirty} onClick={() => void adopt()}>确认采纳</button></div>
      </div>
    </Dialog></DialogDisplayContext.Provider>}
  </div>
}

function OutlineTensionChart({ outlines, disabled, onSelect }: {
  outlines: LivingOutline[]; disabled: boolean; onSelect: (outline: LivingOutline) => void
}) {
  const gradient = useId()
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const x = (index: number) => outlines.length < 2 ? 492 : 48 + index * 888 / (outlines.length - 1)
  const y = (value: number) => 208 - value * 1.68
  const segments: { node: LivingOutline; x: number; y: number }[][] = []
  const bands: { start: number; end: number; kind: 'low' | 'high' }[] = []
  let segment: typeof segments[number] = []
  // 未评估章纲必须断开曲线；预警范围只覆盖实际连续达到阈值的章节。
  outlines.forEach((node, index) => {
    if (node.fields.tension === null) { if (segment.length) segments.push(segment); segment = []; return }
    segment.push({ node, x: x(index), y: y(node.fields.tension) })
  })
  if (segment.length) segments.push(segment)
  for (const kind of ['low', 'high'] as const) {
    let start = -1
    for (let index = 0; index <= outlines.length; index += 1) {
      const value = outlines[index]?.fields.tension
      const matches = value !== undefined && value !== null && (kind === 'low' ? value < 50 : value > 85)
      if (matches && start < 0) start = index
      if (!matches && start >= 0) {
        if (index - start >= (kind === 'low' ? 4 : 5)) bands.push({ start, end: index - 1, kind })
        start = -1
      }
    }
  }
  // 所有真实预警均保留；标签按章序就近排列，冲突时另起一行，不能挤压绘图区。
  const warningRows: number[] = []
  const warnings = [...bands].sort((a, b) => a.start - b.start).map((band) => {
    const left = Math.max(48, Math.min(692, (x(band.start) + x(band.end)) / 2 - 122))
    let row = warningRows.findIndex((right) => right + 12 <= left)
    if (row < 0) row = warningRows.length
    warningRows[row] = left + 244
    const count = band.end - band.start + 1
    return { ...band, left, row, label: `连续 ${count} 章${band.kind === 'low' ? '偏低 · 建议插入转折' : '过高 · 建议日常调剂'}` }
  })
  const warningOffset = Math.max(0, warningRows.length - 1) * 34
  const focused = outlines.find((item) => item.id === hoveredId) ?? outlines.find((item) => item.id === focusedId)
  const activeId = focused?.id
  return <figure className={styles.rhythm}>
    <figcaption><span><StudioIcon name="spark" size={20} />大纲沙盘</span><small>本卷最近 {outlines.length} 章 · 紧张度 0–100</small></figcaption>
    {outlines.length ? <div className={styles.rhythmPlot} tabIndex={0} role="region" aria-label="章节紧张度图表"><svg viewBox={`0 0 960 ${244 + warningOffset}`} role="group" aria-label="章节紧张度曲线，选择节点编辑对应章纲">
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className={styles.curveFillTop} /><stop offset="1" className={styles.curveFillBottom} /></linearGradient></defs>
      <g transform={`translate(0 ${warningOffset})`}>
      {bands.map((band) => <g key={`${band.kind}:${band.start}`} className={styles.warningBand} data-kind={band.kind}><rect x={x(band.start)} y="40" width={Math.max(8, x(band.end) - x(band.start))} height="168" /><title>{band.kind === 'low' ? '连续四章以上紧张度低于 50' : '连续五章以上紧张度高于 85'}</title></g>)}
      {[0, 25, 50, 75, 100].map((value) => <g key={value}><path d={`M48 ${y(value)}H936`} className={styles.gridLines} /><text x="34" y={y(value) + 4} textAnchor="end">{value}</text></g>)}
      {outlines.map((item, index) => (index === 0 || index === outlines.length - 1 || (index + 1) % 5 === 0) && <g key={item.id}><path d={`M${x(index)} 40V208`} className={styles.gridLines} /><text x={x(index)} y="232" textAnchor="middle">{item.position + 1}</text></g>)}
      {segments.map((items) => <g key={items[0]!.node.id}>
        {items.length > 1 && <><polygon points={`${items[0]!.x},208 ${items.map((item) => `${item.x},${item.y}`).join(' ')} ${items.at(-1)!.x},208`} fill={`url(#${gradient})`} /><polyline points={items.map((item) => `${item.x},${item.y}`).join(' ')} className={styles.curve} /></>}
        {items.map(({ node, x: cx, y: cy }) => <g key={node.id} className={styles.curvePoint} tabIndex={disabled ? -1 : 0} role="button" aria-disabled={disabled} aria-label={`${node.fields.title}，紧张度 ${node.fields.tension}，编辑章纲`} onMouseEnter={() => setHoveredId(node.id)} onMouseLeave={() => setHoveredId(null)} onFocus={() => setFocusedId(node.id)} onBlur={() => setFocusedId(null)} onClick={() => { if (!disabled) onSelect(node) }} onKeyDown={(event) => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelect(node) } }}>
          <circle cx={cx} cy={cy} r="16" className={styles.pointTarget} /><circle cx={cx} cy={cy} r={activeId === node.id ? 5 : 3.5} /><title>{node.fields.title}：{node.fields.tension}</title>
        </g>)}
      </g>)}
      </g>
      {warnings.map((warning) => <g key={`${warning.kind}:${warning.start}`} className={styles.warningLabel} data-kind={warning.kind} role="img" aria-label={`第 ${outlines[warning.start]!.position + 1}–${outlines[warning.end]!.position + 1} 章，${warning.label}，紧张度${warning.kind === 'low' ? '低于 50' : '高于 85'}`}>
        <path d={`M${warning.left + 122} ${32 + warning.row * 34}L${(x(warning.start) + x(warning.end)) / 2} ${40 + warningOffset}`} />
        <rect x={warning.left} y={4 + warning.row * 34} width="244" height="28" rx="8" />
        <text x={warning.left + 122} y={22 + warning.row * 34} textAnchor="middle">{warning.label}</text>
      </g>)}
    </svg></div> : <div className={styles.empty}><p>本卷尚无章纲，建立后在这里查看节奏。</p></div>}
    <div className={styles.rhythmLegend}><small aria-live="polite">{focused ? `${focused.fields.title} · 紧张度 ${focused.fields.tension}` : '空值保持未评估；分值仅供作者判断'}</small></div>
  </figure>
}

const outlineFieldLabels = { title: '标题', summary: '大纲内容', goal: '目标', conflict: '核心冲突', hook: '章末悬念', tension: '紧张度', beats: '场景节拍', beatSource: '节拍来源' } as const
function outlineFieldText(value: OutlineFields[keyof OutlineFields]) {
  if (value === null || value === undefined || value === '') return '尚未填写'
  if (Array.isArray(value)) return value.map((item) => `${item.title}：${item.action} → ${item.outcome}`).join('\n') || '尚未填写'
  return typeof value === 'object' ? value.title : String(value)
}

function OutlineRebaseReview({ proposal, targets, current, sourceTitle, adopted, disabled, onChange }: {
  proposal: OutlineProposal; targets: LivingOutline[]; current: LivingOutline[]; sourceTitle: string
  adopted: boolean; disabled: boolean; onChange: (proposal: OutlineProposal) => void
}) {
  const stale = targets.filter((target) => current.find((item) => item.id === target.id)?.stale)
  const changes = proposal.chapters.flatMap((entry, index) => {
    const original = targets.find((item) => item.id === entry.chapterId)
    return (Object.keys(outlineFieldLabels) as (keyof OutlineFields)[]).map((key) => {
      const before = original?.fields[key], after = entry.fields[key]
      return { index, key, before, after, state: same(before, after) ? 'kept' : before === null || before === undefined || before === '' || Array.isArray(before) && before.length === 0 ? 'added' : 'changed' }
    })
  })
  return <div className={styles.rebaseReview}>
    {stale.length > 0 && <div className={styles.rebaseBanner} role="status"><StudioIcon name="bolt" size={24} /><div><strong>上游来源变更 · 受影响章纲 {stale.length} 条</strong><p>{[...new Set(stale.map((item) => current.find((value) => value.id === item.id)?.staleReason).filter(Boolean))].join('；')}</p></div></div>}
    <div className={styles.rebaseColumns}>
      <section className={styles.rebaseCurrent}><h3><StudioIcon name="spark" size={20} />当前章纲</h3>{proposal.chapters.map((entry, index) => {
        const original = targets.find((item) => item.id === entry.chapterId)
        const live = current.find((item) => item.id === entry.chapterId)
        return <article key={entry.chapterId ?? index}><header><strong>{original?.fields.title ?? `章纲 ${index + 1}`}</strong>{original?.manual && <span className={styles.manualBadge}>作者手改</span>}</header>{!adopted && live && original && live.version !== original.version && <p className={styles.warning}>当前版本 {live.version} 与固定预览版本 {original.version} 不同，请重新准备预览。</p>}<p>{original?.fields.summary || '尚未填写大纲内容'}</p>{original && <details><summary>固定原章纲 · 修订 {original.version}</summary><dl>{(Object.keys(outlineFieldLabels) as (keyof OutlineFields)[]).map((key) => <div key={key}><dt>{outlineFieldLabels[key]}</dt><dd>{outlineFieldText(original.fields[key])}</dd></div>)}</dl></details>}</article>
      })}</section>
      <section className={styles.rebaseChanges}><h3><StudioIcon name="workflow" size={20} />差异清单</h3>{changes.map((change) => <article key={`${change.index}:${change.key}`} data-change={change.state}>
        <div><span className={styles.changeSymbol} aria-hidden="true">{change.state === 'added' ? '+' : change.state === 'kept' ? '=' : '~'}</span><strong>{change.state === 'added' ? '新增' : change.state === 'kept' ? '保留' : '修改'}：{outlineFieldLabels[change.key]}</strong></div><p>{outlineFieldText(change.after)}</p><small>{proposal.chapters[change.index]!.fields.title} · 来源：{sourceTitle}</small>
      </article>)}</section>
      <section className={styles.rebaseProposal}><h3><StudioIcon name="spark" size={20} />AI 修纲提案</h3>{proposal.chapters.map((entry, index) => <article key={entry.chapterId ?? index}>
        <strong>{entry.fields.title}</strong><p>{entry.fields.summary || '尚未填写大纲内容'}</p><details><summary>审阅并编辑完整提案</summary><div className={styles.section}><OutlineFieldsEditor fields={entry.fields} chapter disabled={disabled} onChange={(fields) => onChange({ ...proposal, chapters: proposal.chapters.map((item, at) => at === index ? { ...item, fields } : item) })} /></div></details>
      </article>)}</section>
    </div>
    <p className={styles.note}>手改章纲只有在本次请求范围内逐章授权后才允许替换。需要保留某章时，返回调整范围并重新预览；未采纳前不会改写当前章纲。</p>
  </div>
}

function OutlineFieldsEditor({ fields, chapter, disabled, onChange }: {
  fields: OutlineFields; chapter: boolean; disabled: boolean; onChange: (value: OutlineFields) => void
}) {
  return <>
    <label>标题<input value={fields.title} maxLength={120} disabled={disabled} onChange={(event) => onChange({ ...fields, title: event.target.value })} /></label>
    <div className={styles.fieldGrid}><label>大纲内容<textarea value={fields.summary} maxLength={16000} rows={5} disabled={disabled} placeholder="写下推进方向、转折与收束。计划可以随正文变化。" onChange={(event) => onChange({ ...fields, summary: event.target.value })} /></label>
    <label>目标<textarea value={fields.goal} maxLength={10000} rows={3} disabled={disabled} onChange={(event) => onChange({ ...fields, goal: event.target.value })} /></label>
    <label>核心冲突<textarea value={fields.conflict} maxLength={2000} rows={3} disabled={disabled} onChange={(event) => onChange({ ...fields, conflict: event.target.value })} /></label>
    <label>{chapter ? '章末悬念' : '高潮与收束方向'}<textarea value={fields.hook} maxLength={2000} rows={3} disabled={disabled} onChange={(event) => onChange({ ...fields, hook: event.target.value })} /></label></div>
    {chapter && <>
      <label className={styles.tension}>紧张度（留空表示未评估）<input type="number" min={0} max={100} step={1} value={fields.tension ?? ''} disabled={disabled} onChange={(event) => onChange({ ...fields, tension: event.target.value === '' ? null : Number(event.target.value) })} /></label>
      <div className={styles.beatsHeading}><h3>场景节拍</h3><button className={shared.button} type="button" disabled={disabled || fields.beats.length >= 6} onClick={() => onChange({ ...fields, beats: [...fields.beats, { title: `节拍 ${fields.beats.length + 1}`, action: '', outcome: '' }] })}>添加节拍</button></div>
      {fields.beats.map((beat, index) => <fieldset key={index} className={styles.beat}><legend>节拍 {index + 1}</legend>
        <label>名称<input value={beat.title} maxLength={120} disabled={disabled} onChange={(event) => onChange({ ...fields, beats: fields.beats.map((item, at) => at === index ? { ...item, title: event.target.value } : item) })} /></label>
        <label>行动<textarea value={beat.action} maxLength={2000} rows={2} disabled={disabled} onChange={(event) => onChange({ ...fields, beats: fields.beats.map((item, at) => at === index ? { ...item, action: event.target.value } : item) })} /></label>
        <label>发生什么变化<textarea value={beat.outcome} maxLength={2000} rows={2} disabled={disabled} onChange={(event) => onChange({ ...fields, beats: fields.beats.map((item, at) => at === index ? { ...item, outcome: event.target.value } : item) })} /></label>
        <button type="button" className={shared.button} disabled={disabled} onClick={() => onChange({ ...fields, beats: fields.beats.filter((_, at) => at !== index) })}>移除此节拍</button>
      </fieldset>)}
    </>}
  </>
}
