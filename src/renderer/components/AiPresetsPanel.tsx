import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { DomainError, type AppError, type StudioApi } from '../../contracts/api'
import {
  AI_PRESET_KINDS, AI_PRESETS_COMMANDS, MAX_AI_PRESETS, MAX_AI_PRESET_INSTRUCTION,
  aiPresetFields, isAiPresetsSnapshot, isAiPresetSaveReceipt, parseSaveAiPresetInput,
  type AiPreset, type AiPresetFields, type AiPresetKind, type AiPresetsApi, type AiPresetsSnapshot, type SaveAiPresetInput,
} from '../../contracts/ai-presets'
import { useToolSession } from './workbench-ui'
import { StudioIcon, type StudioIconName } from './StudioIcon'
import styles from './StellarPresets.module.css'

export interface AiPresetsPanelProps {
  api: StudioApi & AiPresetsApi
  bookId: string
  bookRevision: number
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  /** 仅填入 composer；调用方负责保护已有输入，不能在此回调中自动发送模型请求。 */
  onApply: (preset: AiPreset) => void
  /** 保存回执确认后同步父层作品版本；失败时面板保留“重试同步”入口。 */
  onChanged?: (snapshot: AiPresetsSnapshot) => void | Promise<void>
  onUnknown?: (error: AppError) => void
  onRecover?: () => void
  connections?: readonly { id: string; name: string; model: string }[]
  initialTitle?: string
  initialKind?: AiPresetKind
  initialInstruction?: string
  initialConnectionId?: string | null
  layout?: 'presets' | 'routing'
  onSummary?: (preset?: AiPreset) => void
  routingNotice?: ReactNode
}

const labels: Record<AiPresetKind, string> = { plan: '规划', continue: '续写', rewrite: '改写', review: '审稿', study: '拆书', summarize: '摘要' }

export function AiPresetsPanel(props: AiPresetsPanelProps) {
  return <PresetsContent key={props.bookId} {...props} />
}

function PresetsContent({ api, bookId, bookRevision, disabled, onDirtyChange, onApply, onChanged, onUnknown, onRecover,
  connections, initialTitle, initialKind, initialInstruction, initialConnectionId, layout = 'presets', onSummary, routingNotice }: AiPresetsPanelProps) {
  const headingId = useId()
  const [snapshot, setSnapshot] = useState<AiPresetsSnapshot | null>(null)
  const [draft, setDraft] = useState<SaveAiPresetInput | null>(null)
  const [submitted, setSubmitted] = useState<SaveAiPresetInput | null>(null)
  const [preserved, setPreserved] = useState<string | null>(null)
  const [conflict, setConflict] = useState<AiPresetsSnapshot | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [defaultConfirmed, setDefaultConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncState, setSyncState] = useState<'idle' | 'needed' | 'busy'>('idle')
  const [syncError, setSyncError] = useState<AppError | null>(null)
  const syncRef = useRef(false)
  const mounted = useRef(true)
  const needsRead = useRef(true)
  const snapshotRef = useRef(snapshot)
  const revisionRef = useRef(bookRevision)
  const callbacks = useRef({ onChanged, onApply, onSummary })
  const formRef = useRef<HTMLFormElement>(null)
  revisionRef.current = bookRevision
  callbacks.current = { onChanged, onApply, onSummary }
  const tool = useToolSession({ api, disabled, onDirtyChange, onUnknown, isProtected: () => syncRef.current })
  const externalChange = Boolean(snapshot && bookRevision > snapshot.bookRevision)
  const blocked = tool.locked || syncState !== 'idle' || !snapshot || snapshot.requiresUpgrade || snapshot.archived || externalChange
  const visible = snapshot?.presets.filter((item) => showArchived || !item.archived) ?? []
  const latest = conflict?.presets.find((item) => item.id === draft?.id)
  const oldDefault = draft && snapshot?.presets.find((item) => item.defaultForTask && item.kind === draft.fields.kind && item.id !== draft.id)
  const replacingDefault = Boolean(draft?.fields.defaultForTask && oldDefault)
  const routeIcons: Record<AiPresetKind, StudioIconName> = { plan: 'layers', continue: 'pen', rewrite: 'refresh', review: 'check', study: 'read', summarize: 'notes' }
  const recoveryRecord = JSON.stringify({ version: 1, bookId, bookRevision: snapshot?.bookRevision ?? bookRevision,
    command: AI_PRESETS_COMMANDS.save, requestId: tool.pending?.error.requestId ?? null, input: submitted, draft,
    savedPreset: syncRef.current ? snapshot?.presets.find((item) => item.id === submitted?.id) : undefined, syncError,
    readRequestId: tool.readFailure?.requestId ?? null }, null, 2)

  useEffect(() => {
    mounted.current = true
    if (!disabled && needsRead.current) { needsRead.current = false; void reload() }
    return () => { mounted.current = false; needsRead.current = true }
  }, [disabled])
  useEffect(() => {
    if (draft) { formRef.current?.scrollIntoView({ block: 'nearest' }); formRef.current?.focus({ preventScroll: true }) }
  }, [draft?.id])

  function receive(value: AiPresetsSnapshot) { snapshotRef.current = value; setSnapshot(value) }
  async function reload() {
    if (tool.hasChanges() || tool.hasPending() || syncRef.current) { tool.setError('请先处理当前输入或核对原请求，再刷新预设。'); return }
    await tool.read(() => api.getAiPresets({ bookId }), (value) => {
      if (!isAiPresetsSnapshot(value, bookId) || value.bookRevision < revisionRef.current || value.bookRevision < (snapshotRef.current?.bookRevision ?? 0)) throw new Error('Stale presets')
      if (tool.hasChanges()) { tool.setError('当前输入已保留，请处理后重新读取。'); return }
      receive(value); setDraft(null); setConflict(null); setDiscard(false)
    })
  }
  function canSwitch() {
    if (!tool.canLeave() || syncRef.current) { tool.setError('请先保存、放弃更改或核对原请求，再切换预设。'); return false }
    return true
  }
  function edit(item?: AiPreset, useCurrent = false, routeKind?: AiPresetKind) {
    if (blocked || !snapshot || !canSwitch()) return
    if ((item?.kind ?? routeKind ?? (useCurrent ? initialKind : undefined)) === 'summarize' && !snapshot.supportsSummary) {
      tool.setError('请先打开分层汇总，备份并启用摘要默认路由。原五类预设仍可使用。'); return
    }
    if (!item && snapshot.presets.length >= MAX_AI_PRESETS) { tool.setError('本书已达到 200 条预设上限（含归档），可继续编辑已有预设。'); return }
    setDraft({ bookId, expectedBookRevision: snapshot.bookRevision, id: item?.id ?? crypto.randomUUID(), expectedRevision: item?.revision ?? 0,
      fields: item ? aiPresetFields(item) : { title: useCurrent ? initialTitle ?? '' : '', kind: routeKind ?? (useCurrent ? initialKind ?? 'continue' : 'continue'),
        instruction: useCurrent ? initialInstruction ?? '' : '', connectionId: useCurrent ? initialConnectionId ?? null : null,
        defaultForTask: Boolean(routeKind), archived: false } })
    setSubmitted(null); setPreserved(null); setConflict(null); setDiscard(false); setDefaultConfirmed(false); tool.setDirty(!item); tool.setError(null); tool.setNotice(null)
  }
  function change(fields: Partial<AiPresetFields>) {
    if (!draft || tool.locked || syncRef.current) return
    const next = { ...draft, fields: { ...draft.fields, ...fields } }
    const original = snapshot?.presets.find((item) => item.id === next.id)
    setDraft(next); setSubmitted(null); setPreserved(null); setConflict(null); setDiscard(false); setDefaultConfirmed(false)
    tool.setDirty(!original || JSON.stringify(next.fields) !== JSON.stringify(aiPresetFields(original)))
    tool.setNotice(null)
  }
  function closeDraft() {
    if (tool.locked || syncRef.current) return
    if (tool.hasChanges() && !discard) { setDiscard(true); return }
    setDraft(null); setSubmitted(null); setPreserved(null); setConflict(null); setDiscard(false); tool.setDirty(false); tool.setError(null)
  }
  function saved(value: AiPresetsSnapshot) {
    receive(value); setDraft(null); setPreserved(null); setConflict(null); setDiscard(false); setSyncError(null)
    syncRef.current = Boolean(callbacks.current.onChanged)
    setSyncState(syncRef.current ? 'needed' : 'idle')
    if (!syncRef.current) setSubmitted(null)
  }
  async function synchronize() {
    const value = snapshotRef.current
    if (!syncRef.current || !value || syncState === 'busy' || syncError?.requestId) return
    setSyncState('busy'); setPreserved(null)
    try {
      await callbacks.current.onChanged?.(value)
      if (!mounted.current) return
      syncRef.current = false; setSyncState('idle'); setSubmitted(null); setSyncError(null); tool.setDirty(false); tool.setError(null)
    } catch (error) {
      if (!mounted.current) return
      const failure: AppError = error instanceof DomainError ? error.detail : { code: 'SERVICE_UNAVAILABLE', message: '父层作品信息尚未同步。' }
      setSyncError((previous) => previous?.requestId ? previous : failure); setSyncState('needed'); tool.setError(`预设已保存。${failure.message} 请先核对未确认的读取，再重新同步；也可以留存记录后进入恢复。`)
    }
  }
  async function checkSyncReceipt() {
    const requestId = syncError?.requestId
    if (!requestId || tool.busy || syncState !== 'needed') return
    await tool.read(() => api.getRequestStatus({ requestId }), (status) => {
      if (status.state === 'pending') { tool.setError('原同步读取仍在处理中，请稍后核对。'); return }
      if (status.state === 'unknown') { tool.setError('无法查询原同步读取，请保留记录并进入恢复。'); return }
      if (status.response.command !== 'knowledge.status' && status.response.command !== 'book.get') {
        tool.setError('原同步请求的操作不匹配，请保留记录并进入恢复。'); return
      }
      const result = status.response.result
      if (!result.ok && (result.error.code === 'REQUEST_TIMEOUT' || result.error.code === 'SERVICE_UNAVAILABLE')) {
        tool.setError(result.error.message); return
      }
      // 这里只确认读取已结束；父层仍通过重新读取核对作品身份，不重发预设保存。
      setSyncError(null); setPreserved(null); tool.setError(null)
      tool.setNotice('原同步读取已结束，请点击“重试同步”更新作品信息。')
    })
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || blocked || !tool.hasChanges() || replacingDefault && !defaultConfirmed || draft.expectedBookRevision !== snapshot?.bookRevision) return
    try {
      const input = parseSaveAiPresetInput(draft)
      setSubmitted(input); setPreserved(null); setDiscard(false)
      setSaving(true)
      const success = await tool.write(AI_PRESETS_COMMANDS.save, () => api.saveAiPreset(input),
        (value) => isAiPresetSaveReceipt(value, input), saved, input.fields.archived ? '预设已归档，历史仍保留。' : '预设已保存。')
      if (success) await synchronize()
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请检查任务预设内容后重试。') }
    finally { setSaving(false) }
  }
  async function checkReceipt() { if (await tool.checkReceipt()) await synchronize() }
  async function compareLatest() {
    if (!draft || tool.locked || syncRef.current) return
    const intended = draft
    await tool.read(() => api.getAiPresets({ bookId }), (value) => {
      if (!isAiPresetsSnapshot(value, bookId) || value.bookRevision < revisionRef.current || value.bookRevision < intended.expectedBookRevision) throw new Error('Stale presets')
      setConflict(value); tool.setNotice('已读取最新版本，当前输入仍保留。请比较后明确选择是否沿用输入。')
    })
  }
  function rebase() {
    if (!draft || !conflict || tool.locked || conflict.archived || conflict.requiresUpgrade || conflict.bookRevision < revisionRef.current) return
    if (draft.expectedRevision > 0 && !latest) { tool.setError('最新记录中找不到原预设，不能将它当作新预设覆盖，请保留输入并检查作品。'); return }
    receive(conflict)
    setDraft({ ...draft, expectedBookRevision: conflict.bookRevision, expectedRevision: latest?.revision ?? 0 })
    setConflict(null); setDefaultConfirmed(false); tool.setDirty(true); tool.setError(null); tool.setNotice('已沿用当前输入，请再次检查并保存。')
  }
  function apply(item: AiPreset) {
    if (blocked || item.archived || !canSwitch()) return
    if (item.connectionId && connections && !connections.some((connection) => connection.id === item.connectionId)) {
      tool.setError('预设绑定的连接当前不可用，请编辑预设并重新选择。'); return
    }
    try {
      if (item.kind === 'summarize') {
        if (!callbacks.current.onSummary) { tool.setError('当前入口不支持分层汇总，请从模型路由中心打开。'); return }
        callbacks.current.onSummary(item)
      } else callbacks.current.onApply(item)
    }
    catch { tool.setError('未能填入协作要求，请检查 composer 中的当前输入。') }
  }
  function connectionName(id: string | null) {
    if (id === null) return '使用当前协作连接'
    const value = connections?.find((connection) => connection.id === id)
    return value ? `${value.name} · ${value.model}` : `绑定连接 ${id}`
  }
  const routing = layout === 'routing'
  const tokenTotal = snapshot ? snapshot.usage.inputTokens + snapshot.usage.outputTokens : 0
  // 路由模式隐藏通用标题栏，未读和已读两种状态都需要可见的原刷新入口。
  const refreshButton = <button type="button" className={styles.button} aria-label={routing ? '刷新任务路由与用量' : undefined}
    disabled={tool.locked || tool.dirty || syncState !== 'idle'} onClick={() => void reload()}>刷新</button>

  return <section className={styles.panel} aria-labelledby={headingId} data-layout={layout}>
    <header className={styles.heading}><div><h3 id={headingId}>任务预设与用量</h3><p className={styles.muted}>保存这部作品常用的协作要求。应用预设会填入编辑框，由你确认后发送。</p></div>
      {refreshButton}</header>
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
    {tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {tool.readFailure?.requestId && <div className={styles.actions}>
      <button type="button" className={styles.button} disabled={tool.locked || syncState === 'busy'} onClick={() => void tool.checkReadReceipt()}>核对原读取</button>
      <span className={styles.muted}>原读取编号：<code>{tool.readFailure.requestId}</code></span>
    </div>}
    {tool.pending && <div className={styles.warning}><p>保存结果尚未确认，当前输入已保留。</p>
      {tool.pending.error.requestId ? <button type="button" className={styles.button} disabled={tool.busy} onClick={() => void checkReceipt()}>核对原请求</button>
        : <p>缺少可查询的请求编号，请通过主窗口恢复流程核对作品。</p>}
      <p>若原请求已无法查询，请先复制下方完整输入与提交记录，再进入恢复流程。</p>
    </div>}
    {syncState !== 'idle' && <div className={styles.warning} role="status"><p>预设写入已确认，等待父层作品信息同步。</p>
      {syncError?.requestId && <button type="button" className={styles.button} disabled={disabled || tool.busy || syncState === 'busy'} onClick={() => void checkSyncReceipt()}>核对原同步读取</button>}
      <button type="button" className={styles.button} aria-busy={syncState === 'busy'} disabled={disabled || tool.busy || syncState === 'busy' || Boolean(syncError?.requestId)} onClick={() => void synchronize()}>{syncState === 'busy' ? '正在同步…' : '重试同步'}</button></div>}
    {externalChange && <p className={styles.warning}>作品已有新版本。当前输入仍保留，可读取最新预设作比较，或处理输入后刷新。</p>}
    {snapshot?.archived && <p className={styles.warning}>作品已归档，任务预设仅供查看。</p>}
    {routing && !snapshot && <div className={styles.actions}>{refreshButton}</div>}
    {!snapshot ? <p className={styles.empty} role="status">{tool.busy ? '正在读取预设与累计用量…' : '尚未取得任务预设，请点击“刷新”重试。'}</p> : <>
      {routing && <section className={styles.routing} aria-label="任务路由矩阵">
        <header className={styles.routeHeading}><h3><StudioIcon name="workflow" size={20} />任务路由矩阵</h3><span>本书默认预设</span>{refreshButton}</header>
        <div className={styles.matrixScroll} tabIndex={0} role="region" aria-label="任务路由矩阵，可横向滚动"><table className={styles.matrix}>
          <thead><tr><th scope="col">任务类型</th>{connections?.map((connection) => <th scope="col" key={connection.id} title={connection.name}>{connection.model}</th>)}<th scope="col">当前协作连接</th></tr></thead>
          <tbody>{AI_PRESET_KINDS.map((kind) => {
            const route = snapshot.presets.find((item) => item.kind === kind && item.defaultForTask && !item.archived)
            const missing = route?.connectionId && !connections?.some((item) => item.id === route.connectionId)
            const needsSummaryUpgrade = kind === 'summarize' && !snapshot.supportsSummary
            return <tr key={kind}><th scope="row"><button type="button" className={styles.routeEdit} disabled={blocked || tool.dirty || needsSummaryUpgrade} aria-label={`编辑${labels[kind]}默认预设`} title={needsSummaryUpgrade ? '请先打开分层汇总，备份并启用摘要默认路由' : blocked || tool.dirty ? '请先保存、放弃或核对当前操作' : `编辑${labels[kind]}默认预设`} onClick={() => edit(route, false, kind)}><StudioIcon name={routeIcons[kind]} size={18} /><span>{labels[kind]}</span><span className={styles.routeEditHint}><StudioIcon name="pen" size={14} /></span></button></th>
              {connections?.map((connection, index) => <td key={connection.id}>{route?.connectionId === connection.id ? <span className={styles.assignment} data-tone={index % 3}><i />{connection.model}</span> : <span className={styles.noRoute}>—</span>}</td>)}
              <td>{needsSummaryUpgrade ? <span className={styles.unavailable}>备份升级后启用</span> : !route ? <span className={styles.noRoute}>未设置</span> : missing ? <span className={styles.unavailable}>绑定连接不可用</span> : route.connectionId === null ? <span className={styles.assignment}><i />发送前选择</span> : <span className={styles.noRoute}>—</span>}</td>
            </tr>
          })}
          </tbody>
        </table></div>
      </section>}
      <div className={routing ? styles.routingSummary : undefined}>
      <section className={styles.usage} aria-label="本书累计模型用量"><h4>{routing && <StudioIcon name="chart" size={20} />}Token 用量统计</h4>
        {routing && <div className={styles.tokenBars}>
          <label>输入 Token<meter value={snapshot.usage.inputTokens} max={Math.max(1, tokenTotal)} /><output><strong>{tokenTotal > 0 ? `${(snapshot.usage.inputTokens / tokenTotal * 100).toFixed(1)}%` : '—'}</strong><span title={`${snapshot.usage.inputTokens.toLocaleString()} / ${tokenTotal.toLocaleString()}`}>{snapshot.usage.inputTokens.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })} / {tokenTotal.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}</span></output></label>
          <label>输出 Token<meter value={snapshot.usage.outputTokens} max={Math.max(1, tokenTotal)} /><output><strong>{tokenTotal > 0 ? `${(snapshot.usage.outputTokens / tokenTotal * 100).toFixed(1)}%` : '—'}</strong><span title={`${snapshot.usage.outputTokens.toLocaleString()} / ${tokenTotal.toLocaleString()}`}>{snapshot.usage.outputTokens.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })} / {tokenTotal.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}</span></output></label>
        </div>}
        <details className={styles.usageDetails} open={!routing}><summary>累计运行与统计口径</summary>
        <dl><div><dt>运行次数</dt><dd>{snapshot.usage.runCount.toLocaleString()}</dd></div>
          <div><dt>已知输入 tokens</dt><dd>{snapshot.usage.inputTokens.toLocaleString()}</dd></div>
          <div><dt>已知输出 tokens</dt><dd>{snapshot.usage.outputTokens.toLocaleString()}</dd></div>
          <div><dt>用量完整的运行</dt><dd>{snapshot.usage.knownUsageRuns.toLocaleString()}</dd></div>
          <div><dt>用量未知或不完整</dt><dd>{snapshot.usage.unknownUsageRuns.toLocaleString()}</dd></div></dl>
        <p className={styles.muted}>输入未知 {snapshot.usage.unknownInputRuns.toLocaleString()} 次，输出未知 {snapshot.usage.unknownOutputRuns.toLocaleString()} 次；两者可能重叠。token 合计仅包含已知部分；未知用量单独计数，不估算费用。</p>
        <p className={styles.muted}>运行次数包含开书与书内协作，以及进入生成流程后失败、中断和仍在生成的记录；未发送的预览不计入，不代表供应商的计费次数。</p>
        {routing && <p className={styles.muted}>{snapshot.usage.knownUsageRuns.toLocaleString()} 次用量完整，{snapshot.usage.unknownUsageRuns.toLocaleString()} 次用量未知或不完整；条形与占比仅按接口已返回的输入和输出合计。</p>}
        </details>
      </section>
      {routing && routingNotice}
      </div>
      {snapshot.requiresUpgrade ? <p className={styles.warning}>请通过作品工具备份并升级这部作品，再刷新本面板以保存任务预设。</p> : <>
        <div className={styles.actions}><div className={styles.actions}>
          <button type="button" className={styles.primaryButton} disabled={blocked || tool.dirty} onClick={() => edit()}>新建预设</button>
          {onSummary && <button type="button" className={styles.button} disabled={tool.locked || tool.dirty || syncState !== 'idle'} onClick={() => onSummary()}>打开分层汇总</button>}
          {initialInstruction?.trim() && <button type="button" className={styles.button} disabled={blocked || tool.dirty} onClick={() => edit(undefined, true)}>将当前要求存为模板</button>}
        </div><label className={styles.check}><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />显示已归档</label></div>
        <ul className={styles.list}>{visible.map((item) => <li key={item.id}>
          <div className={styles.rowHeading}><div><strong>{item.title}</strong><span className={styles.tag}>{labels[item.kind]}</span>{item.defaultForTask && <span className={styles.tag}>默认</span>}{item.archived && <span className={styles.tag}>已归档</span>}</div>
            <div className={styles.actions}><button type="button" className={styles.button} disabled={blocked || tool.dirty || item.archived || item.kind === 'summarize' && !onSummary} onClick={() => apply(item)}>{item.kind === 'summarize' ? '应用到分层汇总' : '应用到协作'}</button>
              <button type="button" className={styles.button} disabled={blocked || tool.dirty} onClick={() => edit(item)}>{item.archived ? '查看 / 恢复' : '编辑 / 归档'}</button></div></div>
          <p className={styles.muted}>{connectionName(item.connectionId)} · 版本 {item.revision}</p>
          <details className={styles.details}><summary>查看协作要求</summary><p className={styles.instruction}>{item.instruction}</p></details>
        </li>)}</ul>
        {visible.length === 0 && <p className={styles.empty}>{snapshot.presets.length ? '当前没有启用的预设，可勾选“显示已归档”查看。' : '还没有任务预设。把常用的续写、改写或审稿要求保存下来，下次直接填入。'}</p>}
      </>}
    </>}
    {routing && !snapshot && routingNotice}
    {draft && <form className={styles.editor} onSubmit={(event) => void save(event)} ref={formRef} tabIndex={-1} aria-label="编辑任务预设">
      <h4>{draft.expectedRevision ? '编辑预设' : '新建预设'}</h4>
      <fieldset disabled={tool.locked || syncState !== 'idle'}>
        <div className={styles.fields}><label>名称<input required maxLength={120} value={draft.fields.title} onChange={(event) => change({ title: event.target.value })} /></label>
          <label>任务<select value={draft.fields.kind} onChange={(event) => change({ kind: event.target.value as AiPresetKind })}>{AI_PRESET_KINDS.map((kind) => <option key={kind} value={kind} disabled={kind === 'summarize' && !snapshot?.supportsSummary}>{labels[kind]}</option>)}</select></label></div>
        <label>协作要求<textarea required rows={7} maxLength={MAX_AI_PRESET_INSTRUCTION} value={draft.fields.instruction} onChange={(event) => change({ instruction: event.target.value })} /></label>
        <p className={styles.muted}>{draft.fields.instruction.length.toLocaleString()} / {MAX_AI_PRESET_INSTRUCTION.toLocaleString()} 字符</p>
        <label>模型连接<select value={draft.fields.connectionId ?? ''} onChange={(event) => change({ connectionId: event.target.value || null })}>
          <option value="">使用当前协作连接</option>
          {draft.fields.connectionId && !connections?.some((item) => item.id === draft.fields.connectionId) && <option value={draft.fields.connectionId}>{connectionName(draft.fields.connectionId)}（未载入）</option>}
          {connections?.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
        </select></label>
        <label className={styles.check}><input type="checkbox" disabled={draft.fields.archived} checked={draft.fields.defaultForTask} onChange={(event) => change({ defaultForTask: event.target.checked })} />设为{labels[draft.fields.kind]}的首选预设（优先显示，手动填入）</label>
        {replacingDefault && <label className={styles.check}><input type="checkbox" checked={defaultConfirmed} onChange={(event) => setDefaultConfirmed(event.target.checked)} />确认替换“{oldDefault?.title}”的默认状态；两份预设都保留。</label>}
        <label className={styles.check}><input type="checkbox" checked={draft.fields.archived} onChange={(event) => change({ archived: event.target.checked, defaultForTask: event.target.checked ? false : draft.fields.defaultForTask })} />归档此预设（保留内容与历史）</label>
      </fieldset>
      <div className={styles.actions}><button className={styles.primaryButton} type="submit" aria-busy={saving} disabled={blocked || !tool.dirty || replacingDefault && !defaultConfirmed} title={replacingDefault && !defaultConfirmed ? '请先确认默认预设替换' : !tool.dirty ? '预设内容尚未修改' : undefined}>{saving ? '正在保存…' : '保存预设'}</button>
        <button type="button" className={styles.button} disabled={tool.locked || syncState !== 'idle'} onClick={() => void compareLatest()}>读取最新版本作比较</button>
        <button type="button" className={styles.button} disabled={tool.locked || syncState !== 'idle'} onClick={closeDraft}>{discard ? '确认放弃当前更改' : tool.dirty ? '放弃更改' : '关闭编辑'}</button></div>
      {discard && <p className={styles.warning}>再次点击将放弃本次未保存的编辑，已有预设不受影响。</p>}
      {conflict && <div className={styles.comparison}><h4>最新保存内容</h4>
        {latest ? <><p>{latest.title} · {labels[latest.kind]} · 版本 {latest.revision}</p><p className={styles.muted}>{connectionName(latest.connectionId)} · {latest.defaultForTask ? '默认' : '非默认'} · {latest.archived ? '已归档' : '启用中'}</p>
          <textarea readOnly rows={5} value={latest.instruction} aria-label="最新保存的协作要求" /></> : <p>最新版本中尚无此预设。</p>}
        <button type="button" className={styles.button} disabled={tool.locked || conflict.archived || conflict.requiresUpgrade || conflict.bookRevision < bookRevision || (draft.expectedRevision > 0 && !latest)} onClick={rebase}>我已比较，沿用当前输入</button></div>}
    </form>}
    {(draft || tool.pending || tool.readFailure || syncState !== 'idle') && <details className={styles.details} open={Boolean(tool.pending || syncState === 'needed')}><summary>查看并复制完整输入与提交记录</summary><textarea readOnly rows={8} aria-label="完整预设输入、版本与原请求记录" value={recoveryRecord} /></details>}
    {(tool.pending || syncState === 'needed') && onRecover && <div className={styles.warning}><label className={styles.check}><input type="checkbox" checked={preserved === recoveryRecord} disabled={tool.busy}
      onChange={(event) => setPreserved(event.target.checked ? recoveryRecord : null)} />我已留存当前输入、预设标识和请求记录</label>
      <button type="button" className={styles.button} disabled={tool.busy || preserved !== recoveryRecord} onClick={() => {
        if ((tool.hasPending() || syncRef.current) && !tool.busy && preserved === recoveryRecord) onRecover()
      }}>打开主窗口恢复</button></div>}
  </section>
}
