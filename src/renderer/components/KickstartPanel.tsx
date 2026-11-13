import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DomainError, type BookSummary, type StudioApi } from '../../contracts/api'
import { parseAiConnectionConfig, type AiConnectionConfig } from '../../contracts/ai'
import {
  parseKickstartSeed, type GenerationPart, type GenerationRun, type KickstartSeed,
  type KickstartSnapshot, type StudioAiConnection,
} from '../../contracts/generation'
import { CHARACTER_PROFILE_FIELDS, CHARACTER_PROFILE_LABELS, CHARACTER_ABILITIES, CHARACTER_ABILITY_LABELS } from '../../contracts/character-profile'
import { Dialog, DialogDisplayContext } from './Dialog'
import { StudioIcon } from './StudioIcon'
import { useToolSession } from './workbench-ui'
import { GenrePicker, STELLAR_GENRES } from './stellar/Genres'
import { usePanelLeave, type RegisterPanelLeaveGuard } from '../hooks/usePanelLeave'
import styles from './StellarKickstart.module.css'

interface Props {
  api: StudioApi; bookId?: string; initialGenre?: string; disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onBookChange: (book: BookSummary) => void
  onAdopted: (snapshot: KickstartSnapshot) => Promise<boolean>
  onClose: () => void; onManual: () => void; onRecover: () => void
  registerLeaveGuard: RegisterPanelLeaveGuard
}
const emptySeed: KickstartSeed = { idea: '', genre: '', template: 'adaptive', scale: 'long' }
const templateLabels: Record<KickstartSeed['template'], string> = { adaptive: '随题材生长', adventure: '冒险与成长', mystery: '谜团与揭示', relationships: '关系与人物弧光' }
const partLabels: Record<GenerationPart, string> = { all: '完整开书包', titles: '书名', cast: '角色班底', rules: '世界规则', outline: '三层大纲' }
const stateLabels: Record<GenerationRun['state'], string> = { prepared: '等待确认发送', running: '正在生成', succeeded: '可以审阅', failed: '生成未完成', cancelled: '已中止', interrupted: '会话已中断' }
const newConnection = (): AiConnectionConfig => ({ id: crypto.randomUUID(), name: '', baseUrl: '', model: '', contextWindow: 32_000, maxOutputTokens: 8192 })
const fieldsOf = (connection: StudioAiConnection): AiConnectionConfig => ({ id: connection.id, name: connection.name, baseUrl: connection.baseUrl, model: connection.model, contextWindow: connection.contextWindow, maxOutputTokens: connection.maxOutputTokens })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function KickstartPanel({ api, bookId, initialGenre = '', disabled, onDirtyChange, onBookChange, onAdopted, onClose, onManual, onRecover, registerLeaveGuard }: Props) {
  const identity = useRef(bookId ?? crypto.randomUUID())
  const [snapshot, setSnapshot] = useState<KickstartSnapshot | null>(null)
  const [seed, setSeed] = useState<KickstartSeed>({ ...emptySeed, genre: initialGenre })
  const [savedSeed, setSavedSeed] = useState<KickstartSeed>({ ...emptySeed, genre: initialGenre })
  const [step, setStep] = useState(bookId ? 2 : 0)
  const [lastProposalRun, setLastProposalRun] = useState<GenerationRun | null>(null)
  const [confirmAdopt, setConfirmAdopt] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [connections, setConnections] = useState<StudioAiConnection[]>([])
  const [keyIds, setKeyIds] = useState<string[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [configuration, setConfiguration] = useState<AiConnectionConfig>(newConnection)
  const [isDefault, setDefault] = useState(true)
  const [defaultConfirmed, setDefaultConfirmed] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [configOpen, setConfigOpen] = useState(false)
  const [connectionsReady, setConnectionsReady] = useState(false)
  const [draftReady, setDraftReady] = useState(!bookId)
  const [opening, setOpening] = useState(false)
  const [copied, setCopied] = useState(false)
  const [autoOpen, setAutoOpen] = useState(false)
  const mounted = useRef(true)
  const initialReadNeeded = useRef(true)
  const proposalHeading = useRef<HTMLHeadingElement>(null)
  const callbacks = useRef({ onDirtyChange, onBookChange, onAdopted })
  callbacks.current = { onDirtyChange, onBookChange, onAdopted }
  const guard = useRef({ tool: false, forms: false, running: false, opening: false })
  const report = () => callbacks.current.onDirtyChange(Object.values(guard.current).some(Boolean))
  const tool = useToolSession({ api, disabled, onDirtyChange: (value) => { guard.current.tool = value; report() } })
  const run = snapshot?.run ?? null
  const original = connections.find((connection) => connection.id === configuration.id)
  const oldDefault = connections.find((connection) => connection.isDefault && connection.id !== configuration.id)
  const replacingDefault = isDefault && Boolean(oldDefault)
  const configDirty = apiKey.length > 0 || (original ? !same(configuration, fieldsOf(original)) || original.isDefault !== isDefault
    : Boolean(configuration.name || configuration.baseUrl || configuration.model))
  const seedDirty = !same(seed, savedSeed)
  const locked = tool.locked || opening || run?.state === 'running'
  // 分区重掷期间保留上一份已确认输出，但旧候选不能用于当前请求的选用或采纳。
  const proposalRun = run?.state === 'succeeded' ? run
    : lastProposalRun && run?.parentRunId === lastProposalRun.id && same(seed, lastProposalRun.seed) ? lastProposalRun : null
  const proposal = proposalRun?.proposal ?? null
  const selection = new Set(run?.selectedIds ?? [])
  const visibleSelection = new Set(proposalRun?.selectedIds ?? [])
  const proposalLocked = locked || run !== proposalRun || Boolean(snapshot?.adoption)
  const seedMatchesRun = Boolean(run && same(seed, run.seed))
  const selectedConnection = connections.find((connection) => connection.id === connectionId)
  const connectionMatchesRun = Boolean(run && selectedConnection && selectedConnection.version === run.connection.version
    && same(fieldsOf(selectedConnection), fieldsOf({ ...run.connection, isDefault: false })))
  const leave = usePanelLeave({
    register: registerLeaveGuard,
    blockedReason: () => opening ? '正在打开第一章，请稍候。'
      : tool.locked ? '开书操作正在处理或原写入尚未确认，请先核对回执。'
        : run?.state === 'running' ? '请先中止生成并确认已收到的输出，再离开开书房。' : null,
    hasChanges: () => seedDirty || configDirty,
    onBlocked: tool.setError,
    onDiscard: discardForms,
  })

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; initialReadNeeded.current = true; callbacks.current.onDirtyChange(false) }
  }, [])
  useEffect(() => {
    if (!disabled && initialReadNeeded.current) { initialReadNeeded.current = false; void load() }
  }, [disabled])
  useEffect(() => {
    guard.current.forms = seedDirty || configDirty
    guard.current.running = run?.state === 'running'
    guard.current.opening = opening
    report()
  }, [seedDirty, configDirty, run?.state, opening])
  useEffect(() => { setCopied(false) }, [seed, configuration, snapshot, tool.pending?.error.requestId])
  useEffect(() => {
    if (run?.state === 'succeeded') { proposalHeading.current?.focus({ preventScroll: true }); proposalHeading.current?.scrollIntoView({ block: 'start' }) }
  }, [run?.id, run?.state])
  useEffect(() => {
    if (run && connections.some((connection) => connection.id === run.connection.id)) setConnectionId(run.connection.id)
  }, [run?.id, connectionsReady])
  useEffect(() => {
    if (run?.state !== 'running' || tool.locked) return
    const timer = window.setTimeout(() => { void reload(false) }, 1000)
    return () => window.clearTimeout(timer)
  }, [run?.id, run?.version, run?.state, tool.busy, tool.pending, disabled])
  useEffect(() => {
    if (autoOpen && snapshot?.adoption && !tool.busy && !tool.pending) { setAutoOpen(false); void enter(snapshot) }
  }, [autoOpen, snapshot?.adoption?.id, tool.busy, tool.pending])

  function receive(value: KickstartSnapshot, restoreSeed = false) {
    if (value.book.book.id !== identity.current || value.run && value.run.bookId !== identity.current || value.adoption && value.adoption.runId !== value.run?.id) throw new Error('Draft identity mismatch')
    setSnapshot(value); setDraftReady(true)
    // 浏览旧提案不能把作者后来保存的脑洞回滚为旧输入。
    if (restoreSeed) { setSeed(value.seed); setSavedSeed(value.seed); setStep(2); setLastProposalRun(null); setConfigOpen(false) }
    if (value.run?.state === 'succeeded' && value.run.proposal) setLastProposalRun(value.run)
    guard.current.running = value.run?.state === 'running'; report()
    if (value.recoveryWarning) tool.setError(value.recoveryWarning)
    callbacks.current.onBookChange(value.book.book)
  }
  function receiveRun(value: GenerationRun) {
    if (value.bookId !== identity.current) throw new Error('Run identity mismatch')
    if (value.state === 'succeeded' && value.proposal) setLastProposalRun(value)
    setSnapshot((current) => current ? { ...current, run: value, adoption: null,
      history: current.history.some((item) => item.id === value.id) ? current.history.map((item) => item.id === value.id ? value : item)
        : [value, ...current.history].slice(0, 100) } : current)
    guard.current.running = value.state === 'running'; report(); setStep(2)
  }
  function editConfiguration(connection?: StudioAiConnection) {
    if (locked || configDirty) { tool.setError('请先保存或放弃当前模型配置修改。'); return }
    setConfiguration(connection ? fieldsOf(connection) : newConnection()); setDefault(connection?.isDefault ?? connections.length === 0); setApiKey('')
    setDefaultConfirmed(false)
    setConfigOpen(true)
  }
  async function load() {
    const read = await tool.read(() => api.listStudioAiConnections(), (value) => {
      setConnections(value.connections); setKeyIds(value.sessionKeyIds); setConnectionsReady(true)
      const selected = value.connections.find((connection) => connection.isDefault) ?? value.connections[0]
      if (selected) { setConnectionId(selected.id); setConfiguration(fieldsOf(selected)); setDefault(selected.isDefault) }
      else setConfigOpen(true)
    })
    if (mounted.current && bookId) await reload(true)
    else if (!read && mounted.current) setConfigOpen(true)
  }
  async function reload(restoreSeed: boolean, runId?: string) {
    if (restoreSeed && (seedDirty || configDirty)) { tool.setError('请先保存或放弃当前输入，再读取草稿。'); return }
    await tool.read(() => api.getKickstart({ bookId: identity.current, ...(runId ? { runId } : {}) }), (value) => receive(value, restoreSeed))
  }
  async function configure(event?: FormEvent): Promise<boolean> {
    event?.preventDefault()
    if (locked || replacingDefault && !defaultConfirmed) return false
    try {
      const connection = parseAiConnectionConfig(configuration), expectedVersion = original?.version ?? null
      const input = { connection, expectedVersion, isDefault, ...(apiKey ? { apiKey } : {}) }
      return await tool.write('generation.connection.save', () => api.configureStudioAiConnection(input),
        (value) => value.id === connection.id && value.version === (expectedVersion === null ? 0 : expectedVersion + 1) && same(fieldsOf(value), connection) && value.isDefault === isDefault,
        (value) => {
          setConnections((current) => [...current.filter((item) => item.id !== value.id).map((item) => value.isDefault ? { ...item, isDefault: false } : item), value])
          setConfiguration(fieldsOf(value)); setDefault(value.isDefault); setDefaultConfirmed(false); setConnectionId(value.id); setConnectionsReady(true); setApiKey(''); setConfigOpen(false)
          if (input.apiKey) setKeyIds((ids) => [...new Set([...ids, value.id])])
        }, '模型配置已保存。若刚才核对了超时回执，请重新填写会话密钥并保存一次。')
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请检查模型配置。'); return false }
  }
  async function saveDraft(): Promise<KickstartSnapshot | null> {
    if (locked || !draftReady) return null
    try {
      const value = parseKickstartSeed(seed), input = { bookId: identity.current, seed: value, ...(snapshot ? { expectedBookRevision: snapshot.book.book.revision } : {}) }
      let saved: KickstartSnapshot | null = null
      await tool.write('generation.draft', () => api.createKickstartDraft(input),
        (result) => result.book.book.id === input.bookId && same(result.seed, value),
        (result) => { saved = result; receive(result); setSeed(value); setSavedSeed(value) }, '脑洞已保存在开书草稿中，可以稍后从书架继续。')
      return saved
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请填写脑洞和题材。'); return null }
  }
  async function prepare(part: GenerationPart) {
    if (locked || configDirty || !connectionsReady || !connectionId || snapshot?.adoption) return
    const saved = await saveDraft()
    if (!saved || !mounted.current) return
    const source = run?.state === 'succeeded' && run.proposal ? run
      : lastProposalRun && same(lastProposalRun.seed, seed) ? lastProposalRun : null
    if (part !== 'all' && (!source?.proposal || source.state !== 'succeeded' || !same(source.seed, seed))) { tool.setError('分区重生成需要未修改脑洞的完整提案。'); return }
    const input = { bookId: identity.current, seed: parseKickstartSeed(seed), runId: crypto.randomUUID(), connectionId,
      expectedBookRevision: saved.book.book.revision, part, ...(source ? { parentRunId: source.id } : {}) }
    await tool.write('generation.prepare', () => api.prepareGeneration(input),
      (value) => value.bookId === input.bookId && value.id === input.runId && value.part === input.part && value.state === 'prepared' && same(value.seed, input.seed) && value.connection.id === input.connectionId,
      receiveRun, '发送预览已固定；确认内容后再开始生成。')
  }
  async function start() {
    if (!run || locked || run.state !== 'prepared' || !seedMatchesRun || !connectionMatchesRun || seedDirty || configDirty) return
    const input = { bookId: run.bookId, runId: run.id, expectedVersion: run.version, contextHash: run.contextHash }
    await tool.write('generation.claim', () => api.startGeneration(input),
      (value) => value.id === input.runId && value.bookId === input.bookId && value.contextHash === input.contextHash && value.state === 'running' && value.version === input.expectedVersion + 1,
      receiveRun, '生成已开始，收到的内容会逐步留存在本机。')
  }
  async function cancel() {
    if (!run || run.state !== 'running' || tool.locked) return
    await tool.read(() => api.cancelGeneration({ bookId: run.bookId, runId: run.id, expectedVersion: run.version }), receiveRun)
  }
  async function choose(id: string, title = false) {
    if (!run || !proposal || proposalLocked) return
    let selectedIds = title ? [...run.selectedIds.filter((item) => !proposal.titles.some((candidate) => candidate.candidateId === item)), id]
      : selection.has(id) ? run.selectedIds.filter((item) => item !== id) : [...run.selectedIds, id]
    const person = proposal.cast.find((candidate) => candidate.candidateId === id)
    if (person && selection.has(id) && proposal.outline.value.chapters.some((chapter) => chapter.castSlots.includes(person.value.slot))) selectedIds = selectedIds.filter((item) => item !== proposal.outline.candidateId)
    await selectCandidates(selectedIds)
  }
  async function selectCandidates(selectedIds: string[]) {
    if (!run || !proposal || proposalLocked) return
    const selectedSlots = new Set(proposal.cast.filter((item) => selectedIds.includes(item.candidateId)).map((item) => item.value.slot))
    if (selectedIds.includes(proposal.outline.candidateId)
      && proposal.outline.value.chapters.some((chapter) => chapter.castSlots.some((slot) => !selectedSlots.has(slot)))) {
      tool.setError('请先选用章纲引用的人物，再选用大纲；也可以不采用大纲。')
      return
    }
    const input = { bookId: run.bookId, runId: run.id, expectedVersion: run.version, selectedIds }
    await tool.write('generation.select', () => api.selectGenerationCandidates(input),
      (value) => value.id === input.runId && value.bookId === input.bookId && value.version === input.expectedVersion + 1 && same(value.selectedIds, selectedIds), receiveRun, '选用范围已保存。')
  }
  function chooseGroup(part: 'cast' | 'rules') {
    if (!proposal || !run || proposalLocked) return
    const ids = proposal[part].map((item) => item.candidateId)
    const removing = ids.every((id) => selection.has(id))
    let selectedIds = removing ? run.selectedIds.filter((id) => !ids.includes(id)) : [...new Set([...run.selectedIds, ...ids])]
    if (removing && part === 'cast') selectedIds = selectedIds.filter((id) => id !== proposal.outline.candidateId)
    void selectCandidates(selectedIds)
  }
  async function adopt() {
    if (!snapshot || !run || !proposal || locked || seedDirty || configDirty || !seedMatchesRun) return
    const input = { bookId: run.bookId, runId: run.id, expectedVersion: run.version,
      expectedBookRevision: snapshot.book.book.revision, expectedKnowledgeRevision: run.knowledgeRevision }
    await tool.write('generation.adopt', () => api.adoptGeneration(input),
      (value) => value.book.book.id === input.bookId && value.run?.id === input.runId && value.adoption?.runId === input.runId
        && value.book.book.lifecycle === 'active' && value.book.chapters.some((chapter) => chapter.id === value.adoption?.firstChapterId),
      (value) => { setConfirmAdopt(false); receive(value); setAutoOpen(true) }, '开书包已采用，正在打开第一章。')
  }
  async function enter(value: KickstartSnapshot) {
    if (!value.adoption || guard.current.opening) return
    guard.current.opening = true; report(); setOpening(true)
    try {
      const entered = await callbacks.current.onAdopted(value)
      if (!entered && mounted.current) tool.setError('作品已建立。请重试打开第一章，或返回书架继续。')
    } finally { if (mounted.current) { guard.current.opening = false; report(); setOpening(false) } }
  }
  function discardForms() {
    if (tool.locked || run?.state === 'running') return
    setSeed(savedSeed); setApiKey('')
    if (original) { setConfiguration(fieldsOf(original)); setDefault(original.isDefault) }
    else { setConfiguration(newConnection()); setDefault(connections.length === 0) }
    setDefaultConfirmed(false)
    tool.setError(null)
    guard.current.forms = false; report()
  }
  async function saveAndLeave() {
    if (locked) return
    if (configDirty && !await configure()) return
    if (seedDirty && !await saveDraft()) return
    guard.current.forms = false; report()
    leave.savedAndLeave()
  }
  async function copyRecovery() {
    try {
      // 密钥从不放进副本；副本只帮助人工核对，不能作为自动重发指令。
      await navigator.clipboard.writeText(JSON.stringify({ format: 'storyweave.kickstart-review', bookId: identity.current,
        seed, snapshot, requestId: tool.pending?.error.requestId ?? null, connection: configuration }, null, 2))
      if (mounted.current) { setCopied(true); tool.setNotice('草稿与回执信息已复制，不含会话密钥。请先粘贴到本机文件留存。') }
    } catch { tool.setError('复制未完成，请在下方原文或脑洞输入框中手动选中留存。') }
  }

  const canGenerate = !locked && draftReady && connectionsReady && Boolean(connectionId) && !configDirty
    && Boolean(seed.idea.trim() && seed.genre.trim()) && !snapshot?.adoption
  const rerollDisabled = locked || seedDirty || configDirty || !seedMatchesRun || Boolean(snapshot?.adoption)
  const selectedTitle = proposal?.titles.find((item) => visibleSelection.has(item.candidateId))
  const canAdopt = Boolean(proposal && selectedTitle && !proposalLocked && !seedDirty && !configDirty && seedMatchesRun)
  const feedback = <>
    {(tool.error || tool.notice) && <div className={tool.error ? styles.error : styles.notice} role={tool.error ? 'alert' : 'status'}>{tool.error ?? tool.notice}</div>}
    {tool.error && !tool.pending && <div className={styles.actions}><button type="button" onClick={() => void copyRecovery()}>复制草稿与已读输出</button><button type="button" disabled={!copied || tool.busy} onClick={onRecover}>已留存，进入恢复</button></div>}
    {tool.pending && <div className={styles.recovery}><p>原写入尚未确认。核对前暂停生成与采用，避免重复请求。</p><div className={styles.actions}><button type="button" disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void tool.checkReceipt()}>核对原请求</button><button type="button" onClick={() => void copyRecovery()}>复制草稿与回执</button><button type="button" disabled={!copied || tool.busy} onClick={onRecover}>已留存，进入恢复</button></div></div>}
    {tool.readFailure && <div className={styles.recovery}>读取尚未确认。<button type="button" disabled={tool.locked || !tool.readFailure.requestId} onClick={() => void tool.checkReadReceipt()}>核对原读取请求</button></div>}
    {!connectionsReady && !tool.busy && <button type="button" onClick={() => void load()}>重新读取模型与草稿</button>}
    {!draftReady && !tool.busy && <button type="button" onClick={() => void reload(true)}>重新读取开书草稿</button>}
  </>
  const seedOptions = <fieldset disabled={locked || !draftReady || Boolean(snapshot?.adoption)} className={styles.fields}>
    <label>题材<input maxLength={80} value={seed.genre} onChange={(event) => setSeed({ ...seed, genre: event.target.value })} placeholder="也可以填写自定义题材" /></label>
    <label>预期篇幅<select value={seed.scale} onChange={(event) => setSeed({ ...seed, scale: event.target.value as KickstartSeed['scale'] })}><option value="short">短篇</option><option value="medium">中篇</option><option value="long">长篇</option></select></label>
    <label>叙事模板<select value={seed.template} onChange={(event) => setSeed({ ...seed, template: event.target.value as KickstartSeed['template'] })}>{Object.entries(templateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>本次使用模型<select value={connectionId} disabled={configDirty} onChange={(event) => setConnectionId(event.target.value)}><option value="">请选择连接</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
  </fieldset>
  const connectionForm = configOpen && <form className={styles.connection} onSubmit={(event) => void configure(event)}>
    <div className={styles.sectionHeading}><h3>工作区模型连接</h3><span>{keyIds.includes(configuration.id) ? '当前会话已填写密钥' : '密钥仅在本次桌面会话保留'}</span></div>
    {connections.length > 0 && <label>编辑已有连接<select value={original?.id ?? ''} disabled={locked || configDirty} onChange={(event) => editConfiguration(connections.find((item) => item.id === event.target.value))}><option value="">新连接</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    <fieldset disabled={locked} className={styles.fields}>
      <label>连接名称<input required maxLength={80} value={configuration.name} onChange={(event) => setConfiguration({ ...configuration, name: event.target.value })} placeholder="我的创作模型" /></label>
      <label>模型名称<input required maxLength={200} value={configuration.model} onChange={(event) => setConfiguration({ ...configuration, model: event.target.value })} placeholder="填写服务方提供的模型名称" /></label>
      <label className={styles.full}>兼容 Chat Completions 的基础地址<input required type="url" value={configuration.baseUrl} onChange={(event) => setConfiguration({ ...configuration, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
      <label>上下文窗口（token）<input required type="number" min={1024} max={2_000_000} value={configuration.contextWindow} onChange={(event) => setConfiguration({ ...configuration, contextWindow: Number(event.target.value) })} /></label>
      <label>最大输出（token）<input required type="number" min={1} max={16_384} value={configuration.maxOutputTokens} onChange={(event) => setConfiguration({ ...configuration, maxOutputTokens: Number(event.target.value) })} /></label>
      <label className={styles.full}>本次会话密钥<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={keyIds.includes(configuration.id) ? '留空沿用已填写的会话密钥' : '远程接口必填，本机模型可留空'} /></label>
      <label className={styles.check}><input type="checkbox" checked={isDefault} onChange={(event) => { setDefault(event.target.checked); setDefaultConfirmed(false) }} />作为工作区默认连接</label>
      {replacingDefault && <label className={`${styles.check} ${styles.full}`}><input type="checkbox" checked={defaultConfirmed} onChange={(event) => setDefaultConfirmed(event.target.checked)} />确认替换“{oldDefault?.name}”的默认状态</label>}
    </fieldset>
    <p className={styles.hint}>首次在旧书库保存连接，会先在 studio-backups 留存目录库备份，再增加配置表。作品正文不参与这次升级。</p>
    <div className={styles.actions}><button className={styles.primary} type="submit" disabled={locked || !configDirty || replacingDefault && !defaultConfirmed} title={replacingDefault && !defaultConfirmed ? '请先确认替换原默认连接' : undefined}>保存模型配置</button>
      {configDirty && <button type="button" disabled={locked} onClick={onClose}>放弃修改或离开</button>}
      <button type="button" disabled={locked} onClick={() => setConfigOpen(false)}>收起配置</button>
    </div>
  </form>

  return <section className={styles.panel} aria-label={step < 2 ? '新建作品向导' : '开书房'}>
    {step < 2 ? <DialogDisplayContext.Provider value="modal"><Dialog title="新建作品" className={styles.wizard} wide onClose={onClose} busy={tool.busy || opening}>
      <nav className={styles.steps} aria-label="开书步骤">{['题材', '种子', '提案'].map((label, index) => <button key={label} type="button" aria-current={step === index ? 'step' : undefined}
        disabled={locked || index > step} onClick={() => setStep(index)}><span>{index + 1}</span>{label}</button>)}</nav>
      {feedback}
      {step === 0 ? <div className={styles.genreStep}>
        <GenrePicker value={seed.genre} disabled={locked || !draftReady} onSelect={(genre) => setSeed({ ...seed, genre })} />
        <label className={styles.ideaRow}><span><StudioIcon name="magic" size={20} />一句话脑洞</span><input autoFocus maxLength={2000} value={seed.idea} disabled={locked}
          onChange={(event) => setSeed({ ...seed, idea: event.target.value })} placeholder="比如：穿越到星际时代的普通人……" /></label>
        <div className={styles.examples}><span>示例：</span>{['星空下的遗迹之城', '被选中的平凡人', '末日后的新世界', '星际旅者的日记'].map((idea) => <button type="button" key={idea} disabled={locked} onClick={() => setSeed({ ...seed, idea })}>{idea}</button>)}</div>
        <details className={styles.customGenre}><summary>自定义题材</summary><label>题材名称<input value={seed.genre} maxLength={80} disabled={locked} onChange={(event) => setSeed({ ...seed, genre: event.target.value })} /></label></details>
      </div> : <div className={styles.seedStep}>
        <label>一句话脑洞<textarea autoFocus maxLength={2000} rows={3} value={seed.idea} disabled={locked} onChange={(event) => setSeed({ ...seed, idea: event.target.value })} /></label>
        {seedOptions}
        <button type="button" disabled={locked} onClick={() => setConfigOpen(!configOpen)}><StudioIcon name="settings" size={16} />工作区模型</button>
        {connectionForm}
        {!connectionId && <p className={styles.hint}>尚未配置模型。可以先保存故事种子，也可以手工建立作品。</p>}
      </div>}
      <footer className={styles.wizardActions}>
        <button type="button" onClick={step === 0 ? onClose : () => setStep(0)} disabled={locked}><StudioIcon name="arrow" size={16} style={{ transform: 'rotate(180deg)' }} />{step === 0 ? '上一步' : '返回题材'}</button>
        <button className={styles.textButton} type="button" disabled={locked} onClick={onManual}>手工建立作品</button>
        <button className={styles.primary} type="button" disabled={locked || !draftReady || !seed.idea.trim() || !seed.genre.trim() || step === 1 && configDirty}
          onClick={() => {
            if (step === 0) { setStep(1); return }
            if (connectionId) void prepare('all')
            else void saveDraft().then((saved) => { if (saved) { setStep(2); setConfigOpen(false) } })
          }}>{step === 0 ? '下一步 · 故事种子' : connectionId ? '下一步 · 生成提案' : '保存种子 · 进入开书房'}<StudioIcon name="arrow" size={16} /></button>
      </footer>
    </Dialog></DialogDisplayContext.Provider> : <>
      <header className={styles.seedBar}>
        <label className={styles.ideaInput}><span><StudioIcon name="spark" size={20} />灵感输入</span><textarea maxLength={2000} rows={2} value={seed.idea}
          disabled={locked || !draftReady || Boolean(snapshot?.adoption)} onChange={(event) => setSeed({ ...seed, idea: event.target.value })} placeholder="写下你的一句话脑洞" /></label>
        <fieldset className={styles.genreChips} disabled={locked || Boolean(snapshot?.adoption)}><legend>题材芯片</legend>
          {STELLAR_GENRES.map((genre) => <button key={genre.id} type="button" aria-pressed={seed.genre === genre.label} onClick={() => setSeed({ ...seed, genre: genre.label })}>{genre.label}</button>)}
        </fieldset>
        <div className={styles.generateActions}>
          {run?.state === 'running' ? <button type="button" disabled={tool.locked} onClick={() => void cancel()}><StudioIcon name="close" size={20} />中止本次生成</button>
            : <button className={styles.primary} type="button" disabled={!canGenerate} title={!connectionId ? '请先配置模型连接' : !seed.idea.trim() || !seed.genre.trim() ? '请填写脑洞和题材' : undefined}
              onClick={() => void prepare('all')}><StudioIcon name="spark" size={20} />{run && ['failed', 'cancelled', 'interrupted'].includes(run.state) ? '重新生成开书包' : '生成开书包'}</button>}
          <div className={styles.progressTrack} data-running={run?.state === 'running'} data-complete={run?.state === 'succeeded'} role={run?.state === 'running' ? 'progressbar' : undefined}
            aria-label={run?.state === 'running' ? '正在推演故事' : undefined} />
          <span className={styles.generationState} role="status">{run ? run.state === 'running' ? `推演中 · 已收到 ${run.outputText.length.toLocaleString()} 字符` : stateLabels[run.state] : '等待生成'}</span>
        </div>
      </header>
      <div className={styles.workspaceTools}>
        <div className={styles.actions}>
          <button type="button" disabled={locked} aria-expanded={optionsOpen} onClick={() => setOptionsOpen(!optionsOpen)}><StudioIcon name="settings" size={16} />创作选项</button>
          <button type="button" disabled={locked} aria-expanded={configOpen} onClick={() => setConfigOpen(!configOpen)}>工作区模型{selectedConnection ? ` · ${selectedConnection.name}` : ''}</button>
          {!snapshot?.adoption && <button type="button" disabled={locked || !draftReady || !seed.idea.trim() || !seed.genre.trim()} onClick={() => void saveDraft()}><StudioIcon name="save" size={16} />保存草稿</button>}
          <button type="button" disabled={locked} onClick={onManual}>手工建立作品</button>
        </div>
        <button className={styles.textButton} type="button" onClick={onClose} disabled={tool.busy || opening}><StudioIcon name="arrow" size={16} style={{ transform: 'rotate(180deg)' }} />返回</button>
      </div>
      {feedback}
      {optionsOpen && <section className={styles.options} aria-label="创作选项">{seedOptions}</section>}
      {connectionForm}
      {run?.state === 'prepared' && <section className={styles.requestPreview} aria-label="发送预览">
        <div><strong>发送预览 · {partLabels[run.part]}</strong><p>{run.connection.name} / {run.connection.model} · 预估输入 {run.estimatedInputTokens.toLocaleString()} token · 输出上限 {run.connection.maxOutputTokens.toLocaleString()} token</p>
          <p className={styles.hint}>将发送至 {run.connection.baseUrl}。输入量为本机粗估，最终费用以服务方账单为准。</p></div>
        <details><summary>查看实际发送内容</summary>{run.messages.map((message, index) => <div key={index}><strong>{message.role}</strong><pre className={styles.raw}>{message.content}</pre></div>)}</details>
        <div className={styles.actions}><button className={styles.primary} type="button" disabled={locked || !seedMatchesRun || !connectionMatchesRun || seedDirty || configDirty} onClick={() => void start()}>确认发送并生成</button>
          {(!seedMatchesRun || !connectionMatchesRun) && <span>脑洞或模型连接已改变，请重新生成发送预览。</span>}</div>
      </section>}
      {run?.error && <p className={styles.error} role="alert">{run.error}</p>}
      {proposalRun && run !== proposalRun && <p className={styles.recovery}>以下保留上一份提案供查看。当前重掷完成并核对后，才能继续选用和采纳。</p>}
      {run?.state === 'succeeded' && ['cast', 'rules'].includes(run.part) && !snapshot?.adoption && <p className={styles.hint}>人物或规则已重生成，旧章纲已取消选用。请核对一致性后重新勾选，或重生成章纲。</p>}
      <h2 className={styles.srOnly} ref={proposalHeading} tabIndex={-1}>开书提案</h2>
      <div className={styles.proposalLayout}>
        <div className={styles.proposalGrid}>
          <section className={styles.proposalPart} aria-labelledby="kickstart-titles">
            <header className={styles.partHeading}><h3 id="kickstart-titles"><StudioIcon name="spark" size={20} />书名候选</h3>
              <div className={styles.partActions}><button type="button" disabled={!proposal || rerollDisabled} onClick={() => void prepare('titles')} title="重新生成书名"><StudioIcon name="refresh" size={16} />重掷</button>
                <button type="button" className={styles.selectButton} disabled={proposalLocked || !proposal || Boolean(selectedTitle)} onClick={() => { if (proposal?.titles[0]) void choose(proposal.titles[0].candidateId, true) }}><StudioIcon name="check" size={16} />{selectedTitle ? '已选' : '选用'}</button></div>
            </header>
            {proposal ? <div className={styles.titleLayout}>
              <fieldset className={styles.titles} disabled={proposalLocked}><legend className={styles.srOnly}>选择一个书名</legend>
                {proposal.titles.map((candidate) => <label key={candidate.candidateId} className={styles.titleChoice} title={candidate.value.angle}>
                  <input type="radio" name="kickstart-title" checked={visibleSelection.has(candidate.candidateId)} onChange={() => void choose(candidate.candidateId, true)} />
                  <span>{candidate.value.title}</span>
                </label>)}
              </fieldset>
              <div className={styles.pitch}><h4>Logline</h4><p className={styles.logline}>{proposal.logline}</p>
                <p className={styles.synopsis}>{proposal.synopsis}</p>
                {selectedTitle && <small>{selectedTitle.value.angle}</small>}
              </div>
            </div> : <div className={styles.partEmpty}><StudioIcon name="spark" size={28} /><p>{run?.state === 'running' ? '正在推演书名与故事核心…' : '生成后选择书名与故事核心'}</p></div>}
          </section>
          <section className={styles.proposalPart} aria-labelledby="kickstart-cast">
            <header className={styles.partHeading}><h3 id="kickstart-cast"><StudioIcon name="user" size={20} />核心人物组</h3>
              <div className={styles.partActions}><button type="button" disabled={!proposal || rerollDisabled} onClick={() => void prepare('cast')} title="重新生成人物组"><StudioIcon name="refresh" size={16} />重掷</button>
                <button type="button" className={styles.selectButton} disabled={!proposal || proposalLocked} onClick={() => chooseGroup('cast')}><StudioIcon name="check" size={16} />{proposal?.cast.every((item) => visibleSelection.has(item.candidateId)) ? '已选' : '选用'}</button></div>
            </header>
            {proposal ? <div className={styles.castCards}>{proposal.cast.map((candidate) => <article key={candidate.candidateId} className={styles.person} data-selected={visibleSelection.has(candidate.candidateId)}>
              <div className={styles.portrait} aria-hidden="true"><StudioIcon name="user" size={48} /></div>
              <div className={styles.personBody}><label className={styles.check}><input type="checkbox" disabled={proposalLocked} checked={visibleSelection.has(candidate.candidateId)} onChange={() => void choose(candidate.candidateId)} /><strong>{candidate.value.name}</strong></label>
                <span className={styles.candidateState}>{candidate.value.slot === 'protagonist' ? '主角' : candidate.value.slot} · {visibleSelection.has(candidate.candidateId) ? '已选' : '待定'}</span>
                <p>{candidate.value.summary}</p>
                <details><summary>人物动机与表达</summary><dl>
                  {CHARACTER_PROFILE_FIELDS.filter((key) => candidate.value.profile[key]).map((key) => <div key={key}><dt>{CHARACTER_PROFILE_LABELS[key]}</dt><dd>{candidate.value.profile[key]}</dd></div>)}
                  {CHARACTER_ABILITIES.filter((key) => candidate.value.profile.abilities?.[key] !== undefined).map((key) => <div key={key}><dt>能力 · {CHARACTER_ABILITY_LABELS[key]}</dt><dd>{candidate.value.profile.abilities?.[key]}</dd></div>)}
                </dl></details>
              </div>
            </article>)}</div> : <div className={styles.partEmpty}><StudioIcon name="user" size={28} /><p>{run?.state === 'running' ? '正在推演人物班底…' : '生成后查看人物班底'}</p></div>}
          </section>
          <section className={styles.proposalPart} aria-labelledby="kickstart-rules">
            <header className={styles.partHeading}><h3 id="kickstart-rules"><StudioIcon name="globe" size={20} />世界底色与铁律</h3>
              <div className={styles.partActions}><button type="button" disabled={!proposal || rerollDisabled} onClick={() => void prepare('rules')} title="重新生成世界规则"><StudioIcon name="refresh" size={16} />重掷</button>
                <button type="button" className={styles.selectButton} disabled={!proposal || proposalLocked} onClick={() => chooseGroup('rules')}><StudioIcon name="check" size={16} />{proposal?.rules.every((item) => visibleSelection.has(item.candidateId)) ? '已选' : '选用'}</button></div>
            </header>
            {proposal ? <ol className={styles.rules}>{proposal.rules.map((candidate, index) => <li key={candidate.candidateId}>
              <span className={styles.ruleNumber}>{index + 1}</span><div><label className={styles.check}><input type="checkbox" disabled={proposalLocked} checked={visibleSelection.has(candidate.candidateId)} onChange={() => void choose(candidate.candidateId)} /><strong>{candidate.value.name}</strong><small>{visibleSelection.has(candidate.candidateId) ? '已选' : '待定'}</small></label><p>{candidate.value.summary}</p></div>
            </li>)}</ol> : <div className={styles.partEmpty}><StudioIcon name="globe" size={28} /><p>{run?.state === 'running' ? '正在推演世界的规则与代价…' : '生成后选择世界规则'}</p></div>}
          </section>
          <section className={styles.proposalPart} aria-labelledby="kickstart-outline">
            <header className={styles.partHeading}><h3 id="kickstart-outline"><StudioIcon name="workflow" size={20} />初版三层大纲</h3>
              <div className={styles.partActions}><button type="button" disabled={!proposal || rerollDisabled} onClick={() => void prepare('outline')} title="重新生成大纲"><StudioIcon name="refresh" size={16} />重掷</button>
                <button type="button" className={styles.selectButton} disabled={!proposal || proposalLocked} onClick={() => { if (proposal) void choose(proposal.outline.candidateId) }}><StudioIcon name="check" size={16} />{proposal && visibleSelection.has(proposal.outline.candidateId) ? '已选' : '选用'}</button></div>
            </header>
            {proposal ? <div className={styles.outline}>
              <details className={styles.outlineLevel}><summary><StudioIcon name="spark" size={16} />总纲</summary><ol>{proposal.outline.value.acts.map((act, index) => <li key={index}><strong>{act.title}</strong><p>{act.summary}</p></li>)}</ol><p>{proposal.outline.value.acts.map((act) => act.title).join(' → ')}</p></details>
              <details className={styles.outlineLevel}><summary><StudioIcon name="spark" size={16} />{proposal.outline.value.volume.title}</summary><p>目标：{proposal.outline.value.volume.goal}</p><p>冲突：{proposal.outline.value.volume.conflict}</p><p>高潮：{proposal.outline.value.volume.climax}</p></details>
              <div className={styles.chapterLevel}><h4><StudioIcon name="spark" size={16} />初版章纲</h4><div className={styles.chapters}>{proposal.outline.value.chapters.map((chapter, index) => <details key={index}>
                <summary><small>第 {index + 1} 章</small><strong>{chapter.title}</strong></summary><p>目标：{chapter.goal}</p><p>冲突：{chapter.conflict}</p><p>章末悬念：{chapter.hook}</p><p>紧张度：{chapter.tension === null ? '未评估' : `${chapter.tension}/100`}</p>
                <ol>{chapter.beats.map((beat) => <li key={beat.id}><strong>{beat.title}</strong> · {beat.action} → {beat.outcome}</li>)}</ol>
              </details>)}</div></div>
              <label className={styles.check}><input type="checkbox" disabled={proposalLocked} checked={visibleSelection.has(proposal.outline.candidateId)} onChange={() => void choose(proposal.outline.candidateId)} />采用大纲与章纲</label>
              <p className={styles.hint}>不采用大纲时只建立空白第一章。</p>
            </div> : <div className={styles.partEmpty}><StudioIcon name="workflow" size={28} /><p>{run?.state === 'running' ? '正在推演总纲、首卷与章纲…' : '生成后查看三层大纲'}</p></div>}
          </section>
        </div>
        <aside className={styles.selection} aria-label="本次纳入">
          <h3><StudioIcon name="spark" size={20} />本次纳入</h3>
          {proposal ? <ul>
            {proposal.titles.filter((item) => visibleSelection.has(item.candidateId)).map((item) => <li key={item.candidateId}><StudioIcon name="check" size={16} />{item.value.title}</li>)}
            {proposal.cast.filter((item) => visibleSelection.has(item.candidateId)).map((item) => <li key={item.candidateId}><StudioIcon name="check" size={16} />{item.value.name}</li>)}
            {proposal.rules.filter((item) => visibleSelection.has(item.candidateId)).map((item) => <li key={item.candidateId}><StudioIcon name="check" size={16} />{item.value.name}</li>)}
            {visibleSelection.has(proposal.outline.candidateId) && <li><StudioIcon name="check" size={16} />三层大纲 · {proposal.outline.value.chapters.length} 章</li>}
          </ul> : <p className={styles.selectionEmpty}>尚未选入候选</p>}
          {snapshot?.adoption ? <footer className={styles.adoption}><strong>开书包已采用</strong><p>书名、所选人物与规则、卷章已保存。</p><button className={styles.primary} type="button" disabled={locked} onClick={() => void enter(snapshot)}>打开第一章<StudioIcon name="arrow" size={16} /></button></footer>
            : <footer className={styles.adoption}><p>采纳前将核对作品与提案版本。</p><button className={styles.primary} type="button" disabled={!canAdopt} title={!selectedTitle ? '请先生成提案并选择书名' : proposalLocked ? '请先完成当前请求' : seedDirty || configDirty ? '请先保存或处理未保存修改' : undefined}
              onClick={() => setConfirmAdopt(true)}><StudioIcon name="spark" size={18} />采纳所选 · 进入第一章</button></footer>}
        </aside>
      </div>
      {snapshot && snapshot.history.length > 1 && <label className={styles.history}>最近的开书尝试（最多 100 次）<select value={run?.id ?? ''} disabled={locked || seedDirty || configDirty || Boolean(snapshot.adoption)} onChange={(event) => void reload(true, event.target.value)}>{snapshot.history.map((item) => <option key={item.id} value={item.id}>{partLabels[item.part]} · {stateLabels[item.state]} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}</select></label>}
      {run && <details className={styles.output} open={['failed', 'cancelled', 'interrupted'].includes(run.state)}><summary>生成记录与原始输出 · {stateLabels[run.state]}</summary>
        {run.outputText && <pre className={styles.raw}>{run.outputText}</pre>}
        {run.state !== 'prepared' && <details><summary>查看实际发送内容</summary>{run.messages.map((message, index) => <div key={index}><strong>{message.role}</strong><pre className={styles.raw}>{message.content}</pre></div>)}</details>}
        {run.usage && <p className={styles.hint}>服务方报告用量：输入 {run.usage.inputTokens ?? '未知'} / 输出 {run.usage.outputTokens ?? '未知'} / 合计 {run.usage.totalTokens ?? '未知'} token</p>}
        <div className={styles.actions}>
          {run.parentRunId && !snapshot?.adoption && <button type="button" disabled={locked || seedDirty || configDirty} onClick={() => void reload(true, run.parentRunId!)}>查看上一份提案</button>}
          <button type="button" onClick={() => void copyRecovery()}>复制草稿与输出</button>
          <button type="button" disabled={!copied || tool.busy} onClick={onRecover}>已留存，进入恢复</button>
        </div>
      </details>}
    </>}
    {leave.confirming && <DialogDisplayContext.Provider value="modal"><Dialog title="离开开书房？" onClose={leave.keepEditing} busy={tool.busy}>
      <div className={styles.leaveContent}><p>故事种子或模型配置有未保存修改。已经保存的草稿和提案会保留。</p>
        {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
        {tool.pending && <button type="button" disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void tool.checkReceipt()}>核对原请求</button>}
        <div className={styles.actions}><button type="button" disabled={tool.busy} onClick={leave.keepEditing}>{leave.source === 'window' ? '返回保存' : '继续编辑'}</button>
          <button type="button" disabled={locked} onClick={leave.discardAndLeave}>放弃未保存修改并离开</button>
          {leave.source !== 'window' && <button className={styles.primary} type="button" disabled={locked || configDirty && replacingDefault && !defaultConfirmed || seedDirty && (!seed.idea.trim() || !seed.genre.trim())} title={configDirty && replacingDefault && !defaultConfirmed ? '请先返回确认默认连接替换' : seedDirty && (!seed.idea.trim() || !seed.genre.trim()) ? '脑洞和题材不完整，可返回补全或明确放弃修改' : undefined} onClick={() => void saveAndLeave()}>保存并离开</button>}</div>
      </div>
    </Dialog></DialogDisplayContext.Provider>}
    {confirmAdopt && snapshot && run && <DialogDisplayContext.Provider value="modal"><Dialog title="采纳所选开书提案？" onClose={() => setConfirmAdopt(false)} busy={tool.busy || opening}>
      <div className={styles.leaveContent}><p>将建立《{selectedTitle?.value.title}》，写入所选人物、规则和大纲，并打开第一章。</p>
        <p className={styles.hint}>作品版本 {snapshot.book.book.revision} · 提案版本 {run.version} · 知识版本 {run.knowledgeRevision}。版本变化时停止采用，不覆盖现有修改。</p>
        {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
        <div className={styles.actions}><button type="button" disabled={tool.busy} onClick={() => setConfirmAdopt(false)}>返回核对</button><button className={styles.primary} type="button" disabled={!canAdopt} onClick={() => void adopt()}>确认采纳</button></div>
      </div>
    </Dialog></DialogDisplayContext.Provider>}
  </section>
}
