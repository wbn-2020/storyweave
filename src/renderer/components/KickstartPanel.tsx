import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DomainError, type BookSummary, type StudioApi } from '../../contracts/api'
import { parseAiConnectionConfig, type AiConnectionConfig } from '../../contracts/ai'
import {
  parseKickstartSeed, type GenerationPart, type GenerationRun, type KickstartSeed,
  type KickstartSnapshot, type StudioAiConnection,
} from '../../contracts/generation'
import { CHARACTER_PROFILE_FIELDS, CHARACTER_PROFILE_LABELS, CHARACTER_ABILITIES, CHARACTER_ABILITY_LABELS } from '../../contracts/character-profile'
import { Dialog } from './Dialog'
import { StudioIcon } from './StudioIcon'
import { useToolSession } from './workbench-ui'
import styles from './KickstartPanel.module.css'

interface Props {
  api: StudioApi; bookId?: string; disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onBookChange: (book: BookSummary) => void
  onAdopted: (snapshot: KickstartSnapshot) => Promise<boolean>
  onClose: () => void; onManual: () => void; onRecover: () => void
}
const emptySeed: KickstartSeed = { idea: '', genre: '', template: 'adaptive', scale: 'long' }
const templateLabels: Record<KickstartSeed['template'], string> = { adaptive: '随题材生长', adventure: '冒险与成长', mystery: '谜团与揭示', relationships: '关系与人物弧光' }
const partLabels: Record<GenerationPart, string> = { all: '完整开书包', titles: '书名', cast: '角色班底', rules: '世界规则', outline: '三层大纲' }
const stateLabels: Record<GenerationRun['state'], string> = { prepared: '等待确认发送', running: '正在生成', succeeded: '可以审阅', failed: '生成未完成', cancelled: '已中止', interrupted: '会话已中断' }
const newConnection = (): AiConnectionConfig => ({ id: crypto.randomUUID(), name: '', baseUrl: '', model: '', contextWindow: 32_000, maxOutputTokens: 8192 })
const fieldsOf = (connection: StudioAiConnection): AiConnectionConfig => ({ id: connection.id, name: connection.name, baseUrl: connection.baseUrl, model: connection.model, contextWindow: connection.contextWindow, maxOutputTokens: connection.maxOutputTokens })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function KickstartPanel({ api, bookId, disabled, onDirtyChange, onBookChange, onAdopted, onClose, onManual, onRecover }: Props) {
  const identity = useRef(bookId ?? crypto.randomUUID())
  const [snapshot, setSnapshot] = useState<KickstartSnapshot | null>(null)
  const [seed, setSeed] = useState<KickstartSeed>({ ...emptySeed })
  const [savedSeed, setSavedSeed] = useState<KickstartSeed>({ ...emptySeed })
  const [connections, setConnections] = useState<StudioAiConnection[]>([])
  const [keyIds, setKeyIds] = useState<string[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [configuration, setConfiguration] = useState<AiConnectionConfig>(newConnection)
  const [isDefault, setDefault] = useState(true)
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
  const configDirty = apiKey.length > 0 || (original ? !same(configuration, fieldsOf(original)) || original.isDefault !== isDefault
    : Boolean(configuration.name || configuration.baseUrl || configuration.model))
  const seedDirty = !same(seed, savedSeed)
  const locked = tool.locked || opening || run?.state === 'running'
  const proposal = run?.state === 'succeeded' ? run.proposal : null
  const selection = new Set(run?.selectedIds ?? [])
  const seedMatchesRun = Boolean(run && same(seed, run.seed))
  const selectedConnection = connections.find((connection) => connection.id === connectionId)
  const connectionMatchesRun = Boolean(run && selectedConnection && selectedConnection.version === run.connection.version
    && same(fieldsOf(selectedConnection), fieldsOf({ ...run.connection, isDefault: false })))
  const protagonist = proposal?.cast.find((candidate) => candidate.value.slot === 'protagonist')?.value

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
    if (restoreSeed) { setSeed(value.seed); setSavedSeed(value.seed) }
    guard.current.running = value.run?.state === 'running'; report()
    if (value.recoveryWarning) tool.setError(value.recoveryWarning)
    callbacks.current.onBookChange(value.book.book)
  }
  function receiveRun(value: GenerationRun) {
    if (value.bookId !== identity.current) throw new Error('Run identity mismatch')
    setSnapshot((current) => current ? { ...current, run: value, adoption: null,
      history: current.history.some((item) => item.id === value.id) ? current.history.map((item) => item.id === value.id ? value : item)
        : [value, ...current.history].slice(0, 100) } : current)
    guard.current.running = value.state === 'running'; report()
  }
  function editConfiguration(connection?: StudioAiConnection) {
    if (locked || configDirty) { tool.setError('请先保存或放弃当前模型配置修改。'); return }
    setConfiguration(connection ? fieldsOf(connection) : newConnection()); setDefault(connection?.isDefault ?? connections.length === 0); setApiKey('')
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
  async function configure(event: FormEvent) {
    event.preventDefault()
    if (locked) return
    try {
      const connection = parseAiConnectionConfig(configuration), expectedVersion = original?.version ?? null
      const input = { connection, expectedVersion, isDefault, ...(apiKey ? { apiKey } : {}) }
      await tool.write('generation.connection.save', () => api.configureStudioAiConnection(input),
        (value) => value.id === connection.id && value.version === (expectedVersion === null ? 0 : expectedVersion + 1) && same(fieldsOf(value), connection) && value.isDefault === isDefault,
        (value) => {
          setConnections((current) => [...current.filter((item) => item.id !== value.id).map((item) => value.isDefault ? { ...item, isDefault: false } : item), value])
          setConfiguration(fieldsOf(value)); setDefault(value.isDefault); setConnectionId(value.id); setConnectionsReady(true); setApiKey(''); setConfigOpen(false)
          if (input.apiKey) setKeyIds((ids) => [...new Set([...ids, value.id])])
        }, '模型配置已保存。若刚才核对了超时回执，请重新填写会话密钥并保存一次。')
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请检查模型配置。') }
  }
  async function saveDraft(): Promise<KickstartSnapshot | null> {
    if (locked || !draftReady) return null
    try {
      const value = parseKickstartSeed(seed), input = { bookId: identity.current, seed: value, ...(snapshot ? { expectedBookRevision: snapshot.book.book.revision } : {}) }
      let saved: KickstartSnapshot | null = null
      await tool.write('generation.draft', () => api.createKickstartDraft(input),
        (result) => result.book.book.id === input.bookId && same(result.seed, value),
        (result) => { saved = result; receive(result); setSavedSeed(value) }, '脑洞已保存在开书草稿中，可以稍后从书架继续。')
      return saved
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请填写脑洞和题材。'); return null }
  }
  async function prepare(part: GenerationPart) {
    if (locked || configDirty || !connectionsReady || !connectionId || snapshot?.adoption) return
    const saved = await saveDraft()
    if (!saved || !mounted.current) return
    const source = run?.state === 'succeeded' && run.proposal ? run : null
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
    if (!run || !proposal || locked || snapshot?.adoption) return
    let selectedIds = title ? [...run.selectedIds.filter((item) => !proposal.titles.some((candidate) => candidate.candidateId === item)), id]
      : selection.has(id) ? run.selectedIds.filter((item) => item !== id) : [...run.selectedIds, id]
    const person = proposal.cast.find((candidate) => candidate.candidateId === id)
    if (person && selection.has(id) && proposal.outline.value.chapters.some((chapter) => chapter.castSlots.includes(person.value.slot))) selectedIds = selectedIds.filter((item) => item !== proposal.outline.candidateId)
    const input = { bookId: run.bookId, runId: run.id, expectedVersion: run.version, selectedIds }
    await tool.write('generation.select', () => api.selectGenerationCandidates(input),
      (value) => value.id === input.runId && value.bookId === input.bookId && value.version === input.expectedVersion + 1 && same(value.selectedIds, selectedIds), receiveRun, '选用范围已保存。')
  }
  async function adopt() {
    if (!snapshot || !run || !proposal || locked || seedDirty || configDirty || !seedMatchesRun) return
    const input = { bookId: run.bookId, runId: run.id, expectedVersion: run.version,
      expectedBookRevision: snapshot.book.book.revision, expectedKnowledgeRevision: run.knowledgeRevision }
    await tool.write('generation.adopt', () => api.adoptGeneration(input),
      (value) => value.book.book.id === input.bookId && value.run?.id === input.runId && value.adoption?.runId === input.runId
        && value.book.book.lifecycle === 'active' && value.book.chapters.some((chapter) => chapter.id === value.adoption?.firstChapterId),
      (value) => { receive(value); setAutoOpen(true) }, '开书包已采用，正在打开第一章。')
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
    tool.setError(null)
  }
  async function copyRecovery() {
    try {
      // 密钥从不放进副本；副本只帮助人工核对，不能作为自动重发指令。
      await navigator.clipboard.writeText(JSON.stringify({ format: 'storyweave.kickstart-review', bookId: identity.current,
        seed, snapshot, requestId: tool.pending?.error.requestId ?? null, connection: configuration }, null, 2))
      if (mounted.current) { setCopied(true); tool.setNotice('草稿与回执信息已复制，不含会话密钥。请先粘贴到本机文件留存。') }
    } catch { tool.setError('复制未完成，请在下方原文或脑洞输入框中手动选中留存。') }
  }

  return <Dialog title="故事孵化 · 从脑洞到第一章" wide inline onClose={onClose} busy={tool.busy || opening}>
    <div className={styles.panel}>
      <header className={styles.intro}><p>开书只需一个脑洞与题材，细节可以边写边长。未配置模型时也能先保存种子。</p>
        <div className={styles.actions}><button type="button" onClick={onManual} disabled={locked || seedDirty || configDirty}>手工建立作品</button><button type="button" onClick={() => setConfigOpen(!configOpen)} disabled={locked}><StudioIcon name="settings" size={15} />工作区模型</button></div>
      </header>
      {(tool.error || tool.notice) && <div className={tool.error ? styles.error : styles.notice} role={tool.error ? 'alert' : 'status'}>{tool.error ?? tool.notice}</div>}
      {tool.error && !tool.pending && <div className={styles.actions}><button type="button" onClick={() => void copyRecovery()}>复制草稿与已读输出</button><button type="button" disabled={!copied || tool.busy} onClick={onRecover}>已留存，进入恢复</button></div>}
      {tool.pending && <div className={styles.recovery}><p>原写入尚未确认。核对前暂停生成与采用，避免重复请求。</p><div className={styles.actions}><button type="button" disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void tool.checkReceipt()}>核对原请求</button><button type="button" onClick={() => void copyRecovery()}>复制草稿与回执</button><button type="button" disabled={!copied || tool.busy} onClick={onRecover}>已留存，进入恢复</button></div></div>}
      {!connectionsReady && !tool.busy && <button type="button" onClick={() => void load()}>重新读取模型与草稿</button>}
      {configOpen && <form className={styles.connection} onSubmit={(event) => void configure(event)}>
        <div className={styles.sectionHeading}><h3>工作区模型连接</h3><span>{keyIds.includes(configuration.id) ? '当前会话已填写密钥' : '密钥仅在本次桌面会话保留'}</span></div>
        {connections.length > 0 && <label>编辑已有连接<select value={original?.id ?? ''} disabled={locked || configDirty} onChange={(event) => editConfiguration(connections.find((item) => item.id === event.target.value))}><option value="">新连接</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <fieldset disabled={locked} className={styles.fields}>
          <label>连接名称<input required maxLength={80} value={configuration.name} onChange={(event) => setConfiguration({ ...configuration, name: event.target.value })} placeholder="我的创作模型" /></label>
          <label>模型名称<input required maxLength={200} value={configuration.model} onChange={(event) => setConfiguration({ ...configuration, model: event.target.value })} placeholder="填写服务方提供的模型名称" /></label>
          <label className={styles.full}>兼容 Chat Completions 的基础地址<input required type="url" value={configuration.baseUrl} onChange={(event) => setConfiguration({ ...configuration, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
          <label>上下文窗口（token）<input required type="number" min={1024} max={2_000_000} value={configuration.contextWindow} onChange={(event) => setConfiguration({ ...configuration, contextWindow: Number(event.target.value) })} /></label>
          <label>最大输出（token）<input required type="number" min={1} max={16_384} value={configuration.maxOutputTokens} onChange={(event) => setConfiguration({ ...configuration, maxOutputTokens: Number(event.target.value) })} /></label>
          <label className={styles.full}>本次会话密钥<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={keyIds.includes(configuration.id) ? '留空沿用已填写的会话密钥' : '远程接口必填，本机模型可留空'} /></label>
          <label className={styles.check}><input type="checkbox" checked={isDefault} onChange={(event) => setDefault(event.target.checked)} />作为工作区默认连接</label>
        </fieldset>
        <p className={styles.hint}>首次在旧书库保存连接，会先在 studio-backups 留存目录库备份，再增加配置表。作品正文不参与这次升级。</p>
        <button type="submit" disabled={locked || !configDirty}>保存模型配置</button>
      </form>}
      <section className={styles.seed} aria-labelledby="kickstart-seed-heading">
        <div className={styles.sectionHeading}><h3 id="kickstart-seed-heading">01 / 故事种子</h3><span>{snapshot ? '已有本机草稿' : '保存时建立本机草稿'}</span></div>
        <fieldset disabled={locked || !draftReady || Boolean(snapshot?.adoption)} className={styles.fields}>
          <label className={styles.full}>一句话脑洞<textarea maxLength={2000} rows={4} value={seed.idea} onChange={(event) => { setSeed({ ...seed, idea: event.target.value }); setCopied(false) }} placeholder="例如：一个以贩卖记忆为生的人，收到了一段属于明天的记忆。" /></label>
          <label>题材<input maxLength={80} value={seed.genre} onChange={(event) => setSeed({ ...seed, genre: event.target.value })} placeholder="科幻悬疑、都市情感……" /></label>
          <label>预期篇幅<select value={seed.scale} onChange={(event) => setSeed({ ...seed, scale: event.target.value as KickstartSeed['scale'] })}><option value="short">短篇</option><option value="medium">中篇</option><option value="long">长篇</option></select></label>
          <label>叙事模板<select value={seed.template} onChange={(event) => setSeed({ ...seed, template: event.target.value as KickstartSeed['template'] })}>{Object.entries(templateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>本次使用模型<select value={connectionId} disabled={configDirty} onChange={(event) => setConnectionId(event.target.value)}><option value="">请选择连接</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
        </fieldset>
        {!snapshot?.adoption && <div className={styles.actions}><button type="button" disabled={locked || !draftReady || !seed.idea.trim() || !seed.genre.trim()} onClick={() => void saveDraft()}>保存草稿</button><button className={styles.primary} type="button" disabled={locked || !draftReady || !connectionId || configDirty || !seed.idea.trim() || !seed.genre.trim()} onClick={() => void prepare('all')}><StudioIcon name="spark" size={16} />预览完整开书请求</button></div>}
        {(seedDirty || configDirty) && <button className={styles.textButton} type="button" disabled={locked} onClick={discardForms}>放弃本次未保存的表单修改</button>}
        {!draftReady && !tool.busy && <button type="button" onClick={() => void reload(true)}>重新读取开书草稿</button>}
      </section>
      {snapshot && snapshot.history.length > 1 && <label>最近的开书尝试（最多显示 100 次）<select value={run?.id ?? ''} disabled={locked || seedDirty || configDirty || Boolean(snapshot.adoption)} onChange={(event) => void reload(true, event.target.value)}>{snapshot.history.map((item) => <option key={item.id} value={item.id}>{partLabels[item.part]} · {stateLabels[item.state]} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}</select></label>}
      {run && <section className={styles.preview} aria-labelledby="kickstart-preview-heading">
        <div className={styles.sectionHeading}><h3 id="kickstart-preview-heading">02 / 发送预览</h3><span role="status">{partLabels[run.part]} · {stateLabels[run.state]}</span></div>
        <p>{run.connection.name} / {run.connection.model} · 预估输入 {run.estimatedInputTokens.toLocaleString()} token · 输出上限 {run.connection.maxOutputTokens.toLocaleString()} token</p>
        <p className={styles.hint}>输入量为本机粗估。将把下列创作资料发送到 {run.connection.baseUrl}，最终费用以服务方账单为准。</p>
        <details><summary>查看实际发送内容</summary>{run.messages.map((message, index) => <div key={index}><strong>{message.role}</strong><pre className={styles.raw}>{message.content}</pre></div>)}</details>
        {run.state === 'prepared' && <div className={styles.actions}><button className={styles.primary} type="button" disabled={locked || !seedMatchesRun || !connectionMatchesRun || seedDirty || configDirty} onClick={() => void start()}>确认发送并生成{partLabels[run.part]}</button>{(!seedMatchesRun || !connectionMatchesRun) && <span>脑洞或模型连接已改变，请重新预览。</span>}</div>}
        {run.state === 'running' && <div className={styles.actions}><span className={styles.generating}>故事正在生长… 已收到 {run.outputText.length.toLocaleString()} 字符</span><button type="button" disabled={tool.locked} onClick={() => void cancel()}>中止本次生成</button></div>}
        {run.error && <p className={styles.error} role="alert">{run.error}</p>}
        {run.outputText && <details open={!proposal}><summary>模型输出原文（可选中留存）</summary><pre className={styles.raw}>{run.outputText}</pre></details>}
        {run.usage && <p className={styles.hint}>服务方报告用量：输入 {run.usage.inputTokens ?? '未知'} / 输出 {run.usage.outputTokens ?? '未知'} / 合计 {run.usage.totalTokens ?? '未知'} token</p>}
        {run.parentRunId && !snapshot?.adoption && <button type="button" disabled={locked || seedDirty || configDirty} onClick={() => void reload(true, run.parentRunId!)}>查看上一份提案</button>}
        {(run.state === 'failed' || run.state === 'interrupted') && <div className={styles.actions}><button type="button" disabled={tool.locked} onClick={() => void copyRecovery()}>复制草稿与输出</button><button type="button" disabled={!copied || tool.busy} onClick={onRecover}>已留存，进入恢复</button></div>}
      </section>}
      {proposal && run && <section className={styles.proposal} aria-labelledby="kickstart-proposal-heading">
        <div className={styles.sectionHeading}><h3 id="kickstart-proposal-heading" ref={proposalHeading} tabIndex={-1}>03 / 选择留下的故事</h3><span>采用前都是候选</span></div>
        <h2 className={styles.logline}>{proposal.logline}</h2><details><summary>展开故事简介</summary><p className={styles.synopsis}>{proposal.synopsis}</p></details>
        {(['cast', 'rules'].includes(run.part)) && !snapshot?.adoption && <p className={styles.hint}>人物或规则已重生成，旧章纲已取消选用。请核对一致性后重新勾选，或重生成章纲。</p>}
        <div className={styles.sectionHeading}><h4>一个合适的书名</h4><button type="button" disabled={locked || seedDirty || configDirty || Boolean(snapshot?.adoption)} onClick={() => void prepare('titles')}>换一批书名</button></div>
        <fieldset disabled={locked || Boolean(snapshot?.adoption)} className={styles.titles}><legend className={styles.srOnly}>选择一个书名</legend>{proposal.titles.map((candidate) => <label key={candidate.candidateId} className={styles.titleChoice}><input type="radio" name="kickstart-title" checked={selection.has(candidate.candidateId)} onChange={() => void choose(candidate.candidateId, true)} /><span><strong>{candidate.value.title}</strong><small>{candidate.value.angle}</small></span></label>)}</fieldset>
        <div className={styles.quickLook}><article><h4>故事中心 · {protagonist?.name}</h4><p>{protagonist?.summary}</p></article><article><h4>第一章 · {proposal.outline.value.chapters[0]?.title}</h4><p>冲突：{proposal.outline.value.chapters[0]?.conflict}</p><p>悬念：{proposal.outline.value.chapters[0]?.hook}</p></article></div>
        <details><summary>角色班底 · 已选 {proposal.cast.filter((candidate) => selection.has(candidate.candidateId)).length} 位</summary>
        <div className={styles.sectionHeading}><h4>角色班底</h4><button type="button" disabled={locked || seedDirty || configDirty || Boolean(snapshot?.adoption)} onClick={() => void prepare('cast')}>重生成人物</button></div>
        <div className={styles.cards}>{proposal.cast.map((candidate) => <article key={candidate.candidateId} className={styles.card}><label className={styles.check}><input type="checkbox" disabled={locked || Boolean(snapshot?.adoption)} checked={selection.has(candidate.candidateId)} onChange={() => void choose(candidate.candidateId)} /><strong>{candidate.value.name}</strong><small>{candidate.value.slot === 'protagonist' ? '主角' : candidate.value.slot}</small></label><p>{candidate.value.summary}</p><details><summary>人物动机与表达</summary><dl>
          {CHARACTER_PROFILE_FIELDS.filter((key) => candidate.value.profile[key]).map((key) => <div key={key}><dt>{CHARACTER_PROFILE_LABELS[key]}</dt><dd>{candidate.value.profile[key]}</dd></div>)}
          {CHARACTER_ABILITIES.filter((key) => candidate.value.profile.abilities?.[key] !== undefined).map((key) => <div key={key}><dt>能力 · {CHARACTER_ABILITY_LABELS[key]}</dt><dd>{candidate.value.profile.abilities?.[key]}</dd></div>)}
        </dl></details></article>)}</div>
        </details><details><summary>世界规则 · 已选 {proposal.rules.filter((candidate) => selection.has(candidate.candidateId)).length} 条</summary>
        <div className={styles.sectionHeading}><h4>世界的规则与代价</h4><button type="button" disabled={locked || seedDirty || configDirty || Boolean(snapshot?.adoption)} onClick={() => void prepare('rules')}>重生成规则</button></div>
        <div className={styles.cards}>{proposal.rules.map((candidate) => <article className={styles.card} key={candidate.candidateId}><label className={styles.check}><input type="checkbox" disabled={locked || Boolean(snapshot?.adoption)} checked={selection.has(candidate.candidateId)} onChange={() => void choose(candidate.candidateId)} /><strong>{candidate.value.name}</strong></label><p>{candidate.value.summary}</p></article>)}</div>
        </details><details><summary>三层大纲 · {selection.has(proposal.outline.candidateId) ? '已选用' : '未选用'}</summary>
        <div className={styles.sectionHeading}><h4>总纲 → 首卷 → 前几章</h4><button type="button" disabled={locked || seedDirty || configDirty || Boolean(snapshot?.adoption)} onClick={() => void prepare('outline')}>重生成大纲</button></div>
        <label className={styles.check}><input type="checkbox" disabled={locked || Boolean(snapshot?.adoption)} checked={selection.has(proposal.outline.candidateId)} onChange={() => void choose(proposal.outline.candidateId)} />采用这份大纲与章纲。未采用时只建立空白第一章。</label>
        <ol className={styles.acts}>{proposal.outline.value.acts.map((act, index) => <li key={index}><strong>{act.title}</strong><p>{act.summary}</p></li>)}</ol>
        <div className={styles.volume}><h4>{proposal.outline.value.volume.title}</h4><p>目标：{proposal.outline.value.volume.goal}</p><p>冲突：{proposal.outline.value.volume.conflict}</p><p>高潮：{proposal.outline.value.volume.climax}</p></div>
        <div className={styles.chapters}>{proposal.outline.value.chapters.map((chapter, index) => <details key={index} open={index === 0}><summary>{index + 1}. {chapter.title} <small>紧张度 {chapter.tension === null ? '未评估' : `${chapter.tension}/100`}</small></summary><p>目标：{chapter.goal}</p><p>冲突：{chapter.conflict}</p><p>章末悬念：{chapter.hook}</p><ol>{chapter.beats.map((beat) => <li key={beat.id}><strong>{beat.title}</strong> · {beat.action} → {beat.outcome}</li>)}</ol></details>)}</div>
        </details>
        {snapshot?.adoption ? <div className={styles.adoption}><strong>故事已经落地。</strong><p>书名、所选人物与规则、卷章已保存。</p><button className={styles.primary} type="button" disabled={locked} onClick={() => void enter(snapshot)}>打开第一章</button></div>
          : <footer className={styles.adoption}><p>选择会保存在草稿中。采用将一次建立作品资料、所选设定与首章，并沿用本次生成时的模型连接。</p><button className={styles.primary} type="button" disabled={locked || seedDirty || configDirty || !seedMatchesRun} onClick={() => void adopt()}>采用开书包，开始第一章<StudioIcon name="arrow" size={16} /></button></footer>}
      </section>}
    </div>
  </Dialog>
}
