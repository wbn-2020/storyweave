import { useEffect, useRef, useState } from 'react'
import { DomainError, type BookSnapshot, type ChapterSnapshot, type StudioApi } from '../../contracts/api'
import type { AiConnection, AiRun } from '../../contracts/ai'
import { FORGE_KINDS, FORGE_LABELS, forgeUsesChapter, parseForgeAdoptInput, parseForgePrepareInput,
  type ForgeKind, type ForgePrepareInput, type ForgeProposal, type ForgeRunDetail, type ForgeSnapshot } from '../../contracts/forge'
import { CHARACTER_PROFILE_FIELDS, CHARACTER_PROFILE_LABELS, type CharacterProfileField } from '../../contracts/character-profile'
import { CharacterProfileView } from './CharacterProfileEditor'
import { ForgeProposalEditor } from './ForgeProposalEditor'
import { ForgeCharacterOverview } from './ForgeCharacterOverview'
import { timeLabel } from './StoryFieldsEditor'
import { useToolSession } from './workbench-ui'
import { displayTime } from '../request'
import shared from '../StellarShared.module.css'
import styles from './StellarForge.module.css'

interface Props {
  api: StudioApi; book: BookSnapshot; chapter: ChapterSnapshot | null; disabled: boolean
  initialPersonId?: string; initialKind?: ForgeKind
  onDirtyChange: (value: boolean) => void; onBookChange: (book: BookSnapshot) => void
  onConfigure: () => void; onKnowledge: (personId: string | null) => void; onRelations: () => void; onMedia: () => void; onRecover: () => void
  onClose?: () => void
}
const prompts: Record<ForgeKind, string> = {
  names: '给出有辨识度、便于区分的角色名字，解释创作意象，避开已有名字和谐音烂梗。',
  cast: '生成有行动动机和相互冲突的角色班底，每人给出八维档案、能力代价及两句有辨识度的台词。能力数值没有设定时留空。',
  fill: '保留人物已有内容，只补空白档案和空能力维度，让性格、语言与行动动机互相支撑。',
  extract: '从本章逐字证据提炼所选人物的空白档案；没有明确依据的字段保持未知，不推测能力分值。',
  world: '设计支撑故事冲突的力量体系、势力或地点，说明规则、资源稀缺与使用代价，输出可分别采用的卡片。',
  relations: '根据本章原文核对所选实体之间的表面和隐藏关系，保留引文，区分正文陈述、人物信念与推断。',
  audition: '对方把唯一的一枚疗伤丹药递给你。请按此刻的认知、性格和说话方式回应，演一段对手戏。',
}
const attitudes = { knows: '知道', believes: '相信', misunderstands: '误解', suspects: '怀疑' }
const runLabels: Record<AiRun['state'], string> = { prepared: '等待发送', running: '生成中', succeeded: '已生成', failed: '失败', cancelled: '已取消', interrupted: '已中断', rejected: '已拒绝', adopted: '已采用' }
const toggle = (items: string[], id: string, checked: boolean) => checked ? [...items, id] : items.filter((item) => item !== id)
const keysOf = (proposal: ForgeProposal | null) => proposal && proposal.kind !== 'names' ? (proposal.kind === 'relations' ? proposal.relations : proposal.cards).map((item) => item.key) : []

export function ForgePanel({ api, book, chapter, disabled, initialPersonId, initialKind = 'cast', onDirtyChange, onBookChange, onConfigure, onKnowledge, onRelations, onMedia, onRecover, onClose }: Props) {
  const [snapshot, setSnapshot] = useState<ForgeSnapshot | null>(null)
  const [kind, setKind] = useState<ForgeKind>(initialKind)
  const [personId, setPersonId] = useState(initialPersonId ?? '')
  const [storyOrder, setStoryOrder] = useState('')
  const [historyKey, setHistoryKey] = useState('')
  const [profileRevisionId, setProfileRevisionId] = useState('')
  const [traitFields, setTraitFields] = useState<CharacterProfileField[]>([])
  const [cognitionIds, setCognitionIds] = useState<string[]>([]), [stateIds, setStateIds] = useState<string[]>([])
  const [entityIds, setEntityIds] = useState<string[]>([])
  const [entityQuery, setEntityQuery] = useState(''), [entitySearch, setEntitySearch] = useState(''), [entityOffset, setEntityOffset] = useState(0)
  const [referenceRunId, setReferenceRunId] = useState('')
  const [excluded, setExcluded] = useState('')
  const [instruction, setInstruction] = useState(prompts[initialKind])
  const [count, setCount] = useState(3)
  const [anchorId, setAnchorId] = useState(chapter?.id ?? book.chapters[0]?.id ?? '')
  const [connections, setConnections] = useState<AiConnection[]>([]), [connectionId, setConnectionId] = useState('')
  const [detail, setDetail] = useState<ForgeRunDetail | null>(null)
  const [proposal, setProposal] = useState<ForgeProposal | null>(null), [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [previewInput, setPreviewInput] = useState<string | null>(null)
  const [requestDirty, setRequestDirty] = useState(false), [proposalDirty, setProposalDirty] = useState(false)
  const [uncertain, setUncertain] = useState(false), [pollStopped, setPollStopped] = useState(false)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false), [backupPath, setBackupPath] = useState<string | null>(null)
  const [preserved, setPreserved] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null)
  const [lastAttempt, setLastAttempt] = useState<{ command: string; input: unknown } | null>(null)
  const guard = useRef({ tool: false, request: false, proposal: false, running: false, uncertain: false })
  const callbacks = useRef({ onDirtyChange, onBookChange }); callbacks.current = { onDirtyChange, onBookChange }
  const initialRead = useRef(true), mounted = useRef(true)
  const taskControls = useRef<HTMLDetailsElement>(null)
  const report = () => callbacks.current.onDirtyChange(Object.values(guard.current).some(Boolean))
  const tool = useToolSession({ api, disabled, onDirtyChange: (value) => { guard.current.tool = value; report() } })
  const run = detail?.run ?? null
  const blocked = tool.locked || Boolean(book.book.archivedAt) || run?.state === 'running' || uncertain
  const editable = !blocked && run?.state === 'succeeded' && !detail?.adopted
  const needsPerson = ['fill', 'extract', 'audition'].includes(kind)
  const person = snapshot?.person && snapshot.person.entity.id === personId ? snapshot.person : null
  const setDirty = (target: 'request' | 'proposal' | 'uncertain', value: boolean) => {
    guard.current[target] = value; report()
    if (target === 'request') setRequestDirty(value)
    if (target === 'proposal') setProposalDirty(value)
    if (target === 'uncertain') setUncertain(value)
  }
  function edit(action: () => void) { action(); setDirty('request', true) }
  function editProposal(value: ForgeProposal) { setProposal(value); setDirty('proposal', true) }
  function selected(value: string, checked: boolean) { setSelectedKeys((current) => toggle(current, value, checked)); setDirty('proposal', true) }
  function parsedOrder(): number | null {
    if (!storyOrder.trim()) return null
    const value = Number(storyOrder)
    if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000) throw new Error('请填写明确的整数故事排序值。')
    return value
  }
  async function readSnapshot(targetId = personId, offset = entityOffset, historyOffset = 0, query = entitySearch) {
    let order: number | null
    try { order = parsedOrder() } catch { tool.setError('请填写有效的故事排序值，或留空查看未筛选历史。'); return false }
    const id = targetId || null
    return tool.read(() => api.getForge({ bookId: book.book.id, personId: id, storyOrder: order, entityQuery: query, entityOffset: offset, historyOffset }), (value) => {
      if (value.bookId !== book.book.id || id !== (value.person?.entity.id ?? null) && !value.requiresUpgrade) throw new Error('Forge identity mismatch')
      setSnapshot(value); setEntitySearch(query); setEntityOffset(offset); setHistoryKey(`${id ?? ''}:${order ?? ''}`)
    })
  }
  async function readConnections() {
    return tool.read(() => api.listAiConnections({ bookId: book.book.id }), (value) => {
      if (value.bookId !== book.book.id) throw new Error('Connection identity mismatch')
      setConnections(value.connections); setConnectionId((previous) => value.connections.some((item) => item.id === previous) ? previous : value.connections[0]?.id ?? '')
    })
  }
  async function syncBook() {
    return tool.read(() => api.getBook({ bookId: book.book.id }), (value) => {
      if (value.book.id !== book.book.id) throw new Error('Book mismatch')
      callbacks.current.onBookChange(value)
    })
  }
  async function load() {
    if (requestDirty || proposalDirty || blocked) { tool.setError('请先保留或放弃当前未保存输入，再刷新资料。'); return }
    if (!await readSnapshot() || !mounted.current) return
    await readConnections()
  }
  function inspectPerson(id: string) {
    if (blocked || requestDirty || proposalDirty) return
    setPersonId(id); setProfileRevisionId(''); setTraitFields([]); setCognitionIds([]); setStateIds([])
    if (needsPerson) setDirty('request', true)
    void readSnapshot(id)
  }
  function prepareTask(next: ForgeKind) {
    if (blocked || requestDirty || proposalDirty || ['fill', 'extract', 'audition'].includes(next) && !person) return
    // 展开预置流程没有作者输入；保持可前往配置模型，实际编辑后再登记未保存状态。
    setKind(next); setInstruction(prompts[next]); setDetail(null); setProposal(null); setSelectedKeys([]); setPreviewInput(null)
    setProfileRevisionId(''); setTraitFields([]); setCognitionIds([]); setStateIds([]); setEntityIds([]); setReferenceRunId('')
    if (taskControls.current) {
      taskControls.current.open = true
      taskControls.current.scrollIntoView({ block: 'start' })
      taskControls.current.querySelector<HTMLElement>('select')?.focus({ preventScroll: true })
    }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; initialRead.current = true; callbacks.current.onDirtyChange(false) } }, [])
  useEffect(() => { if (!disabled && initialRead.current) { initialRead.current = false; void load() } }, [disabled])
  useEffect(() => { guard.current.running = run?.state === 'running'; report() }, [run?.state])
  useEffect(() => {
    if (run?.state !== 'running' || tool.locked || pollStopped) return
    const timer = window.setTimeout(() => { void refreshRun() }, 1200)
    return () => window.clearTimeout(timer)
  }, [run?.id, run?.version, run?.state, tool.busy, tool.pending, disabled, pollStopped])

  function requestInput(): ForgePrepareInput {
    return parseForgePrepareInput({ bookId: book.book.id, expectedBookRevision: snapshot?.bookRevision, chapterId: anchorId, connectionId, kind, instruction,
      count: ['names', 'cast', 'world'].includes(kind) ? count : 1, personId: needsPerson ? personId || null : null,
      profileRevisionId: kind === 'audition' ? profileRevisionId || null : null, storyOrder: kind === 'audition' ? parsedOrder() : null,
      traitFields: kind === 'audition' ? traitFields : [], cognitionIds: kind === 'audition' ? cognitionIds : [], stateIds: kind === 'audition' ? stateIds : [],
      entityIds: kind === 'audition' ? [] : entityIds, referenceRunId: kind === 'world' ? referenceRunId || null : null,
      excludedNames: ['names', 'cast', 'world'].includes(kind) ? excluded.split(/[,，\n]/u).map((value) => value.trim()).filter(Boolean) : [] })
  }
  function restoreRequest(input: ForgePrepareInput) {
    setKind(input.kind); setInstruction(input.instruction); setAnchorId(input.chapterId); setConnectionId(input.connectionId); setCount(input.count)
    setPersonId(input.personId ?? ''); setStoryOrder(input.storyOrder === null ? '' : String(input.storyOrder)); setProfileRevisionId(input.profileRevisionId ?? '')
    setTraitFields(input.traitFields); setCognitionIds(input.cognitionIds); setStateIds(input.stateIds); setEntityIds(input.entityIds)
    setExcluded(input.excludedNames.join('\n')); setReferenceRunId(input.referenceRunId ?? '')
  }
  async function prepare() {
    if (blocked || proposalDirty || !snapshot || snapshot.requiresUpgrade) return
    let input: ForgePrepareInput
    try { input = requestInput() } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请核对人物、故事时点与模型连接。'); return }
    setLastAttempt({ command: 'forge.prepare', input })
    const saved = await tool.write('forge.prepare', () => api.prepareForge(input),
      (value) => value.bookId === book.book.id && JSON.stringify(value.request) === JSON.stringify(input) && value.run.bookId === book.book.id && value.run.context.purpose === 'forge' && value.run.state === 'prepared',
      (value) => { setDetail(value); setProposal(null); setSelectedKeys([]); setPreviewInput(JSON.stringify(input)); setDirty('request', false); setPollStopped(false) }, '固定预览已保存，确认发送后才会调用模型。')
    if (saved) await readSnapshot()
  }
  async function refreshRun(id = run?.id) {
    if (!id || tool.locked) return
    let auditionPersonId: string | null = null
    const loaded = await tool.read<ForgeRunDetail>(async () => {
      // 主进程先补存模型终态，再回读领域提案；不得绕过终态待写保护。
      const settled = await api.getAiRun({ bookId: book.book.id, runId: id })
      if (!settled.ok) return settled
      const result = await api.getForgeRun({ bookId: book.book.id, runId: id })
      if (result.ok && result.data.run.state === 'running') result.data.run.active = settled.data.active
      return result
    }, (value) => {
      if (value.bookId !== book.book.id || value.run.bookId !== book.book.id || value.run.id !== id || value.run.context.purpose !== 'forge') throw new Error('Forge run identity mismatch')
      if (id === run?.id && value.request.bookId === book.book.id && value.request.kind === 'audition'
        && value.request.personId === personId && ['succeeded', 'adopted'].includes(value.run.state)) auditionPersonId = value.request.personId
      if (id !== run?.id) { restoreRequest(value.request); setPreviewInput(JSON.stringify(value.request)); setDirty('request', false) }
      setDetail(value); setDirty('uncertain', false)
      if (!guard.current.proposal) { setProposal(value.proposal); setSelectedKeys(keysOf(value.proposal)) }
    })
    setPollStopped(!loaded)
    // 台词顺序由仓库的任务序号确定；完成后重读人物清单，不把当前任务直接插入最近两份。
    if (loaded && auditionPersonId && mounted.current) await readSnapshot(auditionPersonId)
  }
  async function control(action: 'start' | 'cancel' | 'interrupt') {
    if (!run || tool.locked || proposalDirty) return
    if (action === 'start') {
      try { if (JSON.stringify(requestInput()) !== previewInput) { tool.setError('输入或来源版本已变化，请重新准备预览。'); return } }
      catch { tool.setError('输入已变化，请重新准备预览。'); return }
    }
    setLastAttempt({ command: `ai.${action}`, input: { bookId: book.book.id, runId: run.id,
      ...(action === 'cancel' ? {} : { expectedVersion: run.version }), ...(action === 'start' ? { contextHash: run.context.contextHash } : {}) } })
    setDirty('uncertain', true)
    const success = await tool.read<AiRun>(() => action === 'start' ? api.startAiRun({ bookId: book.book.id, runId: run.id, expectedVersion: run.version, contextHash: run.context.contextHash })
      : action === 'cancel' ? api.cancelAiRun({ bookId: book.book.id, runId: run.id }) : api.interruptAiRun({ bookId: book.book.id, runId: run.id, expectedVersion: run.version }), (value) => {
      if (value.bookId !== book.book.id || value.id !== run.id || value.context.contextHash !== run.context.contextHash) throw new Error('Forge control mismatch')
      setDetail((previous) => previous ? { ...previous, run: value } : previous); setDirty('uncertain', false); setPollStopped(false)
    })
    if (success) await refreshRun()
  }
  async function adopt() {
    if (!run || !proposal || proposal.kind === 'names' || blocked || detail?.adopted || !snapshot) return
    let input: ReturnType<typeof parseForgeAdoptInput>
    try {
      const chosen = proposal.kind === 'relations' ? { ...proposal, relations: proposal.relations.filter((item) => selectedKeys.includes(item.key)) }
        : { ...proposal, cards: proposal.cards.filter((item) => selectedKeys.includes(item.key)) }
      input = parseForgeAdoptInput({ bookId: book.book.id, expectedBookRevision: snapshot.bookRevision, runId: run.id, expectedRunVersion: run.version, proposal: chosen })
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请核对采用内容。'); return }
    setLastAttempt({ command: 'forge.adopt', input })
    const saved = await tool.write('forge.adopt', () => api.adoptForge(input),
      (value) => value.bookId === book.book.id && value.runId === run.id && value.book.book.id === book.book.id && value.refs.length === selectedKeys.length && value.refs.every((ref) => selectedKeys.includes(ref.key)),
      (value) => { callbacks.current.onBookChange(value.book); setDirty('proposal', false); setDetail((previous) => previous ? { ...previous, adopted: true } : previous) }, '所选内容已采用，来源、领域修订与回执已一同保存。')
    if (saved) { await refreshRun(); await readSnapshot() }
  }
  async function upgrade() {
    if (!snapshot || !upgradeConfirmed || blocked) return
    const input = { bookId: book.book.id, expectedBookRevision: snapshot.bookRevision }
    setLastAttempt({ command: 'knowledge.upgrade', input })
    const saved = await tool.write('knowledge.upgrade', () => api.upgradeKnowledge(input),
      (value) => value.bookId === book.book.id && value.schemaVersion >= 17 && Boolean(value.backupPath),
      (value) => { setBackupPath(value.backupPath ?? null); setUpgradeConfirmed(false) }, '升级已确认，升级前备份已保留。')
    if (saved) {
      await readSnapshot()
      await readConnections(); await syncBook()
    }
  }
  async function checkReceipt() {
    const command = tool.pending?.command
    if (!await tool.checkReceipt()) return
    if (command === 'forge.adopt') await refreshRun()
    await readSnapshot()
    if (command === 'knowledge.upgrade') { await readConnections(); await syncBook() }
  }
  function discard() {
    if (blocked) return
    if (detail) restoreRequest(detail.request)
    else { setInstruction(prompts[kind]); setEntityIds([]); setExcluded(''); setTraitFields([]); setCognitionIds([]); setStateIds([]); setReferenceRunId('') }
    setProposal(detail?.proposal ?? null); setSelectedKeys(keysOf(detail?.proposal ?? null)); setPreviewInput(null)
    setDirty('request', false); setDirty('proposal', false); tool.setError(null)
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopyStatus('copied') } catch { setCopyStatus('failed') }
  }
  let matchesPreview = false
  try { matchesPreview = previewInput !== null && JSON.stringify(requestInput()) === previewInput } catch { /* 尚未形成有效预览。 */ }
  const historyCurrent = historyKey === `${personId}:${storyOrder.trim() === '' ? '' : Number(storyOrder)}`
  const profile = person?.profiles.find((value) => value.revisionId === profileRevisionId)
  const canLeave = !blocked && !requestDirty && !proposalDirty
  const recoveryRecord = tool.error || tool.pending || tool.readFailure || uncertain ? JSON.stringify({ version: 1, workflow: 'forge', bookId: book.book.id, bookRevision: snapshot?.bookRevision ?? book.book.revision,
    request: { kind, personId, storyOrder, profileRevisionId, traitFields, cognitionIds, stateIds, entityIds, referenceRunId,
      excludedNamesText: excluded, instruction, count, chapterId: anchorId, connectionId },
    requestDirty, detail, proposal, selectedKeys, proposalDirty, previewInput, uncertain, backupPath, lastAttempt, error: tool.error,
    pending: tool.pending ? { command: tool.pending.command, error: tool.pending.error } : null, readFailure: tool.readFailure }, null, 2) : ''

  return <div className={styles.panel} aria-busy={tool.busy}>
    <div className={styles.toolbar}><div className={styles.identityTools}><h2>角色工坊</h2>
      {snapshot && !snapshot.requiresUpgrade && <><label className={styles.personPicker}>人物<select aria-label="浏览人物档案" title={requestDirty || proposalDirty ? '请先保留或放弃当前未保存输入' : blocked ? '请先处理当前工坊任务' : '浏览本书人物档案'} value={personId} disabled={blocked || requestDirty || proposalDirty} onChange={(event) => inspectPerson(event.target.value)}><option value="">选择本书人物</option>{snapshot.entities.filter((item) => item.kind === 'person').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        {personId && !snapshot.entities.some((item) => item.id === personId) && <option value={personId}>{person?.entity.fields.name ?? personId}</option>}
      </select></label><span className={styles.entityScope}>当前页 {snapshot.entities.filter((item) => item.kind === 'person').length} 位人物 · 实体总数 {snapshot.entityTotal}</span></>}
      </div>
      <div className={styles.actions}><button type="button" className={shared.button} disabled={!canLeave} onClick={() => onKnowledge(person?.entity.id ?? null)}>手工设定与复核</button><button type="button" className={shared.button} disabled={!canLeave} onClick={onRelations}>关系画布</button><button type="button" className={shared.button} disabled={!canLeave} onClick={onMedia}>人物立绘</button><button type="button" className={shared.button} disabled={!canLeave} onClick={() => void load()}>刷新资料</button>{onClose && <button type="button" className={shared.button} disabled={tool.locked || uncertain || run?.state === 'running'} onClick={onClose}>返回作品</button>}</div>
    </div>
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}{tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {copyStatus && <p className={copyStatus === 'copied' ? styles.notice : styles.error} role={copyStatus === 'copied' ? 'status' : 'alert'}>{copyStatus === 'copied' ? '已复制，可返回正文粘贴后修改。' : '复制未成功，请选择下方原文手动复制。'}</p>}
    {tool.pending && <div className={styles.callout}><p>写入结果尚未确认，当前输入已保留。</p><button type="button" className={shared.button} disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void checkReceipt()}>核对原请求</button></div>}
    {tool.readFailure && <div className={styles.callout} role="status"><p>原读取或模型控制结果待核对。{tool.readFailure.requestId ? `请求编号：${tool.readFailure.requestId}` : '未取得可查询的编号，请留存后进入恢复。'}</p>
      <button type="button" className={shared.button} disabled={tool.locked || !tool.readFailure.requestId} onClick={() => void tool.checkReadReceipt()}>核对原读取请求</button></div>}
    {(tool.error || tool.pending || tool.readFailure || uncertain) && <details className={styles.callout} open={Boolean(tool.pending || tool.readFailure || uncertain)}><summary>留存工坊输入、候选与请求记录</summary>
      <p className={styles.help}>恢复会离开本页。请复制下方完整内容到安全位置；其中保留未保存编辑和已读取的模型输出。未补存的模型终态仍由桌面恢复流程处理。</p>
      <label>工坊内容与恢复记录<textarea readOnly rows={8} value={recoveryRecord} onFocus={(event) => event.target.select()} /></label>
      <label className={styles.check}><input type="checkbox" checked={preserved === recoveryRecord} disabled={disabled || tool.busy} onChange={(event) => setPreserved(event.target.checked ? recoveryRecord : null)} />我已留存当前完整内容</label>
      <button type="button" className={shared.button} disabled={disabled || tool.busy || preserved !== recoveryRecord} onClick={() => { if (!disabled && !tool.busy && preserved === recoveryRecord) onRecover() }}>已留存，进入草稿与服务恢复</button>
    </details>}
    {snapshot?.requiresUpgrade ? <section className={styles.callout}><h3>为本书启用角色与世界工坊</h3><p>会先保存本书数据库备份，再升级到 v17，加入工坊历史、采用回执、六维能力与关系层次。</p>
      <label className={styles.check}><input type="checkbox" checked={upgradeConfirmed} disabled={blocked} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />同意先备份本书，再升级格式</label><button type="button" className={shared.primaryButton} disabled={blocked || !upgradeConfirmed} onClick={() => void upgrade()}>备份并启用工坊</button></section>
      : snapshot && <><div className={styles.actions} role="search"><input type="search" aria-label="查找人物或设定" maxLength={120} value={entityQuery} disabled={blocked} onChange={(event) => setEntityQuery(event.target.value)} />
        <button type="button" className={shared.button} disabled={blocked} onClick={() => void readSnapshot(personId, 0, 0, entityQuery)}>查找人物或设定</button>
        <button type="button" className={shared.button} disabled={blocked || entityOffset === 0} onClick={() => void readSnapshot(personId, Math.max(0, entityOffset - 200))}>上一页实体</button>
        <button type="button" className={shared.button} disabled={blocked || entityOffset + snapshot.entities.length >= snapshot.entityTotal} onClick={() => void readSnapshot(personId, entityOffset + 200)}>下一页实体</button></div>
      <ForgeCharacterOverview api={api} snapshot={snapshot} selectedId={personId} disabled={blocked || requestDirty || proposalDirty}
        detail={detail} proposal={proposal} excluded={excluded} onPrepare={prepareTask}
        onKnowledge={() => onKnowledge(person?.entity.id ?? null)} onMedia={onMedia} onCopy={(text) => void copy(text)} />
      <details ref={taskControls} className={styles.taskControls} open={initialKind !== 'cast' ? true : undefined}><summary>工坊任务、发送与审阅{requestDirty || proposalDirty ? ' · 有未保存修改' : ''}</summary>
      <div className={styles.taskTabs} role="group" aria-label="工坊任务类型">{FORGE_KINDS.map((value) => <button key={value} type="button" aria-pressed={kind === value} disabled={blocked || requestDirty || proposalDirty} onClick={() => edit(() => {
        setKind(value); setInstruction(prompts[value]); setDetail(null); setProposal(null); setSelectedKeys([]); setPreviewInput(null)
        setProfileRevisionId(''); setTraitFields([]); setCognitionIds([]); setStateIds([]); setEntityIds([]); setReferenceRunId('')
        if (!['fill', 'extract', 'audition'].includes(value)) setPersonId('')
      })}>{FORGE_LABELS[value]}</button>)}</div><div className={styles.layout}>
        <section className={styles.compose} aria-label="工坊任务">
          <label>这次做什么<select value={kind} disabled={blocked || proposalDirty} onChange={(event) => edit(() => {
            const next = event.target.value as ForgeKind
            setKind(next); setInstruction(prompts[next]); setDetail(null); setProposal(null); setSelectedKeys([]); setPreviewInput(null)
            setProfileRevisionId(''); setTraitFields([]); setCognitionIds([]); setStateIds([]); setEntityIds([]); setReferenceRunId('')
            if (!['fill', 'extract', 'audition'].includes(next)) setPersonId('')
          })}>{FORGE_KINDS.map((value) => <option key={value} value={value}>{FORGE_LABELS[value]}</option>)}</select></label>
          {needsPerson && <label>目标人物<select value={personId} disabled={blocked || proposalDirty} onChange={(event) => edit(() => { setPersonId(event.target.value); setProfileRevisionId(''); setTraitFields([]); setCognitionIds([]); setStateIds([]) })}><option value="">选择人物</option>{snapshot.entities.filter((item) => item.kind === 'person').map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id.slice(0, 8)}</option>)}{personId && !snapshot.entities.some((item) => item.id === personId) && <option value={personId}>{person?.entity.fields.name ?? personId}</option>}</select></label>}
          {needsPerson && <div className={styles.history}>
            <label>故事时点 · 排序值<input type="number" step={1} min={-1000000000} max={1000000000} value={storyOrder} disabled={blocked} placeholder="试戏必填，不按章序推断" onChange={(event) => edit(() => { setStoryOrder(event.target.value); setCognitionIds([]); setStateIds([]) })} /></label>
            <button type="button" className={shared.button} disabled={blocked || !personId} onClick={() => void readSnapshot()}>读取该时点的人物历史</button>
            {person?.sourceWarning && <p className={styles.callout}>{person.sourceWarning}</p>}
            {person && historyCurrent && <div className={styles.actions}><button type="button" className={shared.button} disabled={blocked || !person.historyOffset} onClick={() => void readSnapshot(personId, entityOffset, Math.max(0, (person.historyOffset ?? 0) - 50))}>上一页历史</button>
              <button type="button" className={shared.button} disabled={blocked || (person.historyOffset ?? 0) + 50 >= (person.historyTotal ?? 0)} onClick={() => void readSnapshot(personId, entityOffset, (person.historyOffset ?? 0) + 50)}>下一页历史</button><small>每类历史每页 50 条；已选认知 {cognitionIds.length} 项、状态 {stateIds.length} 项，翻页保留。</small>
              <button type="button" className={shared.button} disabled={blocked || !cognitionIds.length && !stateIds.length} onClick={() => edit(() => { setCognitionIds([]); setStateIds([]) })}>清除历史选择</button></div>}
            {person && <><p className={styles.meta}>历史版本 {person.profileTotal} 份，本页列出最近 {person.profiles.length} 份。时点只筛选已记录认知和状态，档案版本由作者明确选择。</p><details><summary>当前人物档案</summary><CharacterProfileView profile={person.entity.fields.characterProfile} /></details></>}
            {kind === 'audition' && person && historyCurrent && <>
              <label>本次选用的历史档案<select value={profileRevisionId} disabled={blocked} onChange={(event) => edit(() => { setProfileRevisionId(event.target.value); setTraitFields([]) })}><option value="">不附加档案，未选字段未知</option>{person.profiles.map((item) => <option key={item.revisionId} value={item.revisionId}>{displayTime(item.createdAt)} · {item.revisionId.slice(0, 8)}</option>)}</select></label>
              {profile && <fieldset disabled={blocked}><legend>明确选择符合该时点的档案字段</legend>{CHARACTER_PROFILE_FIELDS.filter((key) => profile.fields.characterProfile?.[key]).map((key) => <label key={key} className={styles.check}><input type="checkbox" checked={traitFields.includes(key)} onChange={(event) => edit(() => setTraitFields(toggle(traitFields, key, event.target.checked) as CharacterProfileField[]))} />{CHARACTER_PROFILE_LABELS[key]}<small>{profile.fields.characterProfile?.[key]}</small></label>)}</fieldset>}
              <fieldset disabled={blocked}><legend>本次可用认知 · 最多12项</legend>{person.cognitions.length ? person.cognitions.map((item) => <label className={styles.check} key={item.id}><input type="checkbox" checked={cognitionIds.includes(item.id)} disabled={!item.usable || !cognitionIds.includes(item.id) && cognitionIds.length >= 12} onChange={(event) => edit(() => setCognitionIds(toggle(cognitionIds, item.id, event.target.checked)))} /><span>{item.title} · {attitudes[item.attitude]}{item.concealed ? ' · 隐瞒' : ''}{!item.usable ? ' · 此时不可用或待复核' : ''}<small>{item.description}</small><small>{timeLabel(item.formedAt)} → {timeLabel(item.effectiveUntil)} · 不含截止时点</small></span></label>) : <p className={styles.help}>没有已记录认知，未选信息保持未知。</p>}</fieldset>
              <fieldset disabled={blocked}><legend>本次可用状态 · 最多12项</legend>{person.states.length ? person.states.map((item) => <label className={styles.check} key={item.id}><input type="checkbox" checked={stateIds.includes(item.id)} disabled={!item.usable || !stateIds.includes(item.id) && stateIds.length >= 12} onChange={(event) => edit(() => setStateIds(toggle(stateIds, item.id, event.target.checked)))} /><span>{item.attribute}：{item.before || '未知'} → {item.after || '未知'}<small>{timeLabel(item.storyTime)}{!item.usable ? ' · 此时不可用、已被替代或存在冲突' : ''}</small></span></label>) : <p className={styles.help}>没有已记录状态。</p>}</fieldset>
            </>}
            {person && historyCurrent && <details><summary>此时的表面与隐藏关系 · {person.relations.length}</summary>{person.relations.map((item) => <p key={item.id}><strong>{item.fields.title}</strong> · {item.fields.layer === 'surface' ? '表面' : item.fields.layer === 'hidden' ? '隐藏' : '层次未标注'} · {item.active === 'active' ? '记录有效' : item.active === 'inactive' ? '记录无效' : '有效性未知'}<small>{item.fields.description}</small></p>)}<p className={styles.help}>关系不会自动变成人物已知信息。人物知情与读者披露须独立记录。</p></details>}
          </div>}
          <label>{forgeUsesChapter(kind) ? '本次完整正文来源' : '任务所属章节（正文内容不发送）'}<select value={anchorId} disabled={blocked} onChange={(event) => edit(() => setAnchorId(event.target.value))}><option value="">选择已保存章节</option>{book.chapters.map((item) => <option key={item.id} value={item.id}>第 {item.position + 1} 章 · {item.title}</option>)}</select></label>
          {kind !== 'audition' && <details><summary>明确选入的设定 · {entityIds.length}/20</summary><div className={styles.sourceList}>{snapshot.entities.map((item) => <label key={item.id} className={styles.check}><input type="checkbox" checked={entityIds.includes(item.id)} disabled={blocked || !entityIds.includes(item.id) && entityIds.length >= 20} onChange={(event) => edit(() => setEntityIds(toggle(entityIds, item.id, event.target.checked)))} />{item.name} · {item.kind}</label>)}</div><p className={styles.help}>当前第 {Math.floor(entityOffset / 200) + 1} 页，显示 {snapshot.entities.length} 个，共 {snapshot.entityTotal} 个匹配实体；翻页保留选择。选入资料须已采用、当前且完成冲突复核。关系推断至少选两项。</p></details>}
          {kind === 'world' && <label>接续一轮世界提案 · 选填<select value={referenceRunId} disabled={blocked} onChange={(event) => edit(() => setReferenceRunId(event.target.value))}><option value="">从本次要求开始</option>{snapshot.runs.filter((item) => item.kind === 'world' && ['succeeded', 'adopted'].includes(item.state)).map((item) => <option key={item.id} value={item.id}>{displayTime(item.createdAt)} · 原始提案 {item.id.slice(0, 8)}</option>)}{referenceRunId && !snapshot.runs.some((item) => item.id === referenceRunId) && <option value={referenceRunId}>{referenceRunId}</option>}</select></label>}
          <label>{kind === 'audition' ? '试戏情境与本轮台词' : '这次的创作要求'}<textarea value={instruction} rows={5} maxLength={2000} disabled={blocked} onChange={(event) => edit(() => setInstruction(event.target.value))} /></label>
          {['names', 'cast', 'world'].includes(kind) && <div className={styles.columns}><label>{kind === 'names' ? '名字组数 · 每组3个' : '候选卡片数'}<input type="number" min={1} max={4} step={1} value={count} disabled={blocked} onChange={(event) => edit(() => setCount(event.target.valueAsNumber))} /></label><label>避用名称 · 逗号或换行分隔<textarea rows={2} value={excluded} maxLength={12000} disabled={blocked} onChange={(event) => edit(() => setExcluded(event.target.value))} /></label></div>}
          <label>本次模型<select value={connectionId} disabled={blocked} onChange={(event) => edit(() => setConnectionId(event.target.value))}><option value="">选择已保存模型</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
          {!connections.length && <button type="button" className={shared.button} disabled={!canLeave} onClick={onConfigure}>配置模型连接</button>}
          <div className={styles.actions}><button type="button" className={shared.primaryButton} disabled={blocked || proposalDirty || !anchorId || !connectionId} onClick={() => void prepare()}>准备本次发送预览</button>{(requestDirty || proposalDirty) && <button type="button" className={shared.button} disabled={blocked} onClick={discard}>放弃未保存修改</button>}</div>
        </section>
        <section className={styles.result} aria-label="工坊结果">
          {run ? <>
            <div className={styles.resultHeader}><h3>{FORGE_LABELS[detail!.request.kind]}</h3><span>{runLabels[run.state]} · {run.model}</span></div>
            <p className={styles.meta}>作品版本 {run.context.bookRevision} · 知识版本 {run.context.knowledgeRevision} · 任务 {run.id.slice(0, 8)}</p>
            <details><summary>实际发送内容与来源</summary>{run.context.messages.map((message, index) => <div key={index}><strong>{message.role}</strong><pre className={styles.preview}>{message.content}</pre></div>)}</details>
            {run.context.warnings.map((warning, index) => <p key={index} className={styles.help}>{warning}</p>)}
            <div className={styles.actions}>
              {run.state === 'prepared' && <button type="button" className={shared.primaryButton} disabled={blocked || !matchesPreview} onClick={() => void control('start')}>确认发送给模型</button>}
              {(run.state === 'prepared' || run.state === 'running' && run.active !== false) && <button type="button" className={shared.button} disabled={tool.locked || uncertain} onClick={() => void control('cancel')}>取消本次生成</button>}
              {run.state === 'running' && run.active === false && <button type="button" className={shared.button} disabled={tool.locked || uncertain} onClick={() => void control('interrupt')}>确认中断历史任务</button>}
              <button type="button" className={shared.button} disabled={tool.locked} onClick={() => void refreshRun()}>读取原任务结果</button>
            </div>
            {run.state === 'prepared' && !matchesPreview && <p className={styles.help}>输入或版本已变化，请按当前资料重新准备。</p>}
            {uncertain && <p className={styles.callout}>模型操作结果尚未确认。请读取原任务结果；不会自动重发。</p>}
            {run.error && <p className={styles.error}>{run.error}</p>}{detail?.parseError && <p className={styles.error}>{detail.parseError}</p>}
            {proposal?.kind === 'names' && <ol className={styles.names}>{proposal.names.map((item) => <li key={item.name}><strong>{item.name}</strong><span>{item.meaning}</span><button type="button" className={shared.button} onClick={() => void copy(item.name)}>复制名字</button></li>)}</ol>}
            {proposal && proposal.kind !== 'names' && <><p className={styles.help}>{kind === 'fill' || kind === 'extract' ? '采用时只填入目标人物的空白字段，已有内容保持原值。' : '逐项选择与修改，采用后仍需在设定库或故事记录中完成冲突复核。'}</p><ForgeProposalEditor proposal={proposal} selected={selectedKeys} disabled={!editable} onChange={editProposal} onSelect={selected} /><button type="button" className={shared.primaryButton} disabled={!editable || !selectedKeys.length} onClick={() => void adopt()}>{detail?.adopted ? '已采用' : `采用所选 ${selectedKeys.length} 项`}</button></>}
            {run.outputText && <details open={detail?.request.kind === 'audition' || Boolean(detail?.parseError)}><summary>{detail?.request.kind === 'audition' ? '角色试戏 · 仅供作者核对' : '原始模型输出'}</summary><pre className={styles.output}>{run.outputText}</pre><button type="button" className={shared.button} onClick={() => void copy(run.outputText)}>复制原文</button></details>}
            {detail?.request.kind === 'world' && ['succeeded', 'adopted'].includes(run.state) && <button type="button" className={shared.button} disabled={blocked || proposalDirty} onClick={() => edit(() => { setKind('world'); setReferenceRunId(run.id); setInstruction('在上一轮构想基础上继续细化：'); setPreviewInput(null) })}>接着讨论这一轮世界构想</button>}
          </> : <div className={styles.empty}><h3>尚无{FORGE_LABELS[kind]}提案</h3><p>填写创作要求并准备发送预览。</p></div>}
          <details className={styles.history}><summary>最近工坊任务 · {snapshot.runs.length}</summary>{snapshot.runs.map((item) => <button key={item.id} type="button" className={styles.runLink} disabled={blocked || requestDirty || proposalDirty} onClick={() => void refreshRun(item.id)}><span>{FORGE_LABELS[item.kind]} · {runLabels[item.state]}</span><small>{displayTime(item.createdAt)}</small></button>)}</details>
        </section>
      </div></details></>}
    {!snapshot && <p className={styles.help}>正在读取工坊资料。读取失败时可使用“刷新资料”重试。</p>}
    {backupPath && <p className={styles.meta}>升级前备份：{backupPath}</p>}
  </div>
}
