import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DomainError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import { parseAiConnectionConfig, type AiConnection, type AiConnectionConfig, type AiConnectionPage } from '../../contracts/ai'
import type { StudioAiConnection } from '../../contracts/generation'
import type { AiPreset, AiPresetsSnapshot } from '../../contracts/ai-presets'
import type { AiConnectionProbeResult } from '../../contracts/ai-connection-probe'
import { AiPresetsPanel } from './AiPresetsPanel'
import { Dialog, DialogDisplayContext } from './Dialog'
import { StudioIcon } from './StudioIcon'
import { request } from '../request'
import { sameFields, useToolSession } from './workbench-ui'
import { usePanelLeave, type RegisterPanelLeaveGuard } from '../hooks/usePanelLeave'
import styles from './StellarModels.module.css'

interface Props {
  api: StudioApi
  book: BookSnapshot | null
  disabled: boolean
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  onBookChange: (book: BookSnapshot) => void
  onApply: (preset: AiPreset) => void
  onConfigureBook: () => void
  onSummary: () => void
  onRecover: () => void
  registerLeaveGuard: RegisterPanelLeaveGuard
}

function fieldsOf(connection: AiConnection): AiConnectionConfig {
  const { id, name, baseUrl, model, contextWindow, maxOutputTokens } = connection
  return { id, name, baseUrl, model, contextWindow, maxOutputTokens }
}
type ProbeState = Pick<AiConnectionProbeResult, 'state' | 'latencyMs' | 'message'> | { state: 'loading'; latencyMs: null; message: string }

export function ModelConnectionsPanel({ api, book, disabled, onClose, onDirtyChange, onBookChange, onApply, onConfigureBook, onSummary, onRecover, registerLeaveGuard }: Props) {
  const [scope, setScope] = useState<'studio' | 'book'>(book ? 'book' : 'studio')
  const [studioConnections, setStudioConnections] = useState<StudioAiConnection[]>([])
  const [bookPage, setBookPage] = useState<AiConnectionPage | null>(null)
  const [studioKeys, setStudioKeys] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [presetsDirty, setPresetsDirty] = useState(false)
  const [draft, setDraft] = useState<AiConnectionConfig | null>(null)
  const [secret, setSecret] = useState('')
  const [isDefault, setDefault] = useState(false)
  const [defaultConfirmed, setDefaultConfirmed] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [preserved, setPreserved] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  const probeRequests = useRef(new Map<string, string>())
  const probeEpoch = useRef(0)
  const needsRead = useRef(true)
  const guard = useRef({ connection: false, presets: false })
  const callback = useRef(onDirtyChange)
  callback.current = onDirtyChange
  const tool = useToolSession({ api, disabled, onDirtyChange: (dirty) => {
    guard.current.connection = dirty; callback.current(dirty || guard.current.presets)
  } })
  const connections = scope === 'studio' ? studioConnections : bookPage?.connections ?? []
  const keys = scope === 'studio' ? studioKeys : bookPage?.sessionKeyIds ?? []
  const original = connections.find((item) => item.id === draft?.id)
  const oldDefault = studioConnections.find((item) => item.isDefault && item.id !== draft?.id)
  const changedDefault = scope === 'studio' && isDefault && Boolean(oldDefault)
  const readOnly = scope === 'book' && Boolean(book?.book.archivedAt || bookPage?.requiresUpgrade)
  const recoveryText = JSON.stringify({ scope, bookId: scope === 'book' ? book?.book.id : undefined, connection: draft,
    expectedVersion: original?.version ?? null, isDefault, requestId: tool.pending?.error.requestId ?? null }, null, 2)
  const leave = usePanelLeave({
    register: registerLeaveGuard,
    blockedReason: () => tool.locked ? '连接正在处理或原写入尚未确认，请先核对回执。'
      : presetsDirty || guard.current.presets ? '任务预设还有未保存修改，请先在预设编辑区保存或放弃。' : null,
    hasChanges: tool.hasChanges,
    onBlocked: tool.setError,
    onDiscard: () => { setDraft(null); setSecret(''); setDiscard(false); tool.setDirty(false) },
  })

  useEffect(() => { needsRead.current = true; setLoaded(false) }, [scope, api, book?.book.id])
  useEffect(() => {
    if (!disabled && needsRead.current) { needsRead.current = false; void reload() }
  }, [scope, api, book?.book.id, disabled])
  useEffect(() => () => callback.current(false), [])
  useEffect(() => {
    probeEpoch.current += 1
    setProbes({})
    return () => {
      probeEpoch.current += 1
      for (const requestId of probeRequests.current.values()) void request(() => api.cancelAiConnectionTest({ requestId }))
      probeRequests.current.clear()
    }
  }, [api, scope, book?.book.id])
  useEffect(() => {
    const current = new Set(connections.map(probeKey))
    for (const [key, requestId] of probeRequests.current) {
      if (current.has(key)) continue
      probeRequests.current.delete(key)
      void request(() => api.cancelAiConnectionTest({ requestId }))
    }
  }, [api, connections, scope, book?.book.id])

  function probeKey(connection: AiConnection) { return JSON.stringify([scope, scope === 'book' ? book?.book.id : null, connection.id, connection.version]) }
  async function testConnection(connection: AiConnection) {
    const key = probeKey(connection)
    if (tool.locked || tool.hasChanges() || guard.current.presets || probeRequests.current.has(key) || scope === 'book' && !book) return
    const requestId = crypto.randomUUID(), epoch = probeEpoch.current
    probeRequests.current.set(key, requestId)
    setProbes((items) => ({ ...items, [key]: { state: 'loading', latencyMs: null, message: '正在测试连接…' } }))
    const input = { requestId, connectionId: connection.id, expectedVersion: connection.version }
    const result = await request(() => api.testAiConnection(scope === 'book' && book ? { ...input, scope: 'book', bookId: book.book.id } : { ...input, scope: 'studio' }))
    // 范围、连接版本和请求身份共同固定结果，离开后的迟到响应不能回填新卡片。
    if (epoch !== probeEpoch.current || probeRequests.current.get(key) !== requestId) return
    probeRequests.current.delete(key)
    const valid = result.ok && result.data.requestId === requestId && result.data.connectionId === connection.id && result.data.connectionVersion === connection.version
    setProbes((items) => ({ ...items, [key]: valid ? result.data : { state: 'failed', latencyMs: null, message: result.ok ? '测试回执与当前连接不一致，请刷新后重试。' : result.error.message } }))
  }
  async function cancelTest(connection: AiConnection) {
    const key = probeKey(connection), requestId = probeRequests.current.get(key), epoch = probeEpoch.current
    if (!requestId) return
    const result = await request(() => api.cancelAiConnectionTest({ requestId }))
    if (!result.ok && epoch === probeEpoch.current) tool.setError(result.error.message)
  }

  async function reload() {
    if (tool.hasChanges() || guard.current.presets) { tool.setError('请先保存或放弃当前修改。'); return }
    if (scope === 'studio') await tool.read(() => api.listStudioAiConnections(), (value) => {
      setStudioConnections(value.connections); setStudioKeys(value.sessionKeyIds); setLoaded(true)
    })
    else if (book) await tool.read(() => api.listAiConnections({ bookId: book.book.id }), (value) => {
      if (value.bookId !== book.book.id) throw new Error('Connection book mismatch')
      setBookPage(value); setLoaded(true)
    })
  }
  function changeScope(value: typeof scope) {
    if (value === scope) return
    if (!tool.canLeave() || guard.current.presets) { tool.setError('请先处理当前连接或预设修改。'); return }
    setDraft(null); setSecret(''); setLoaded(false); setScope(value)
  }
  function edit(connection?: AiConnection) {
    if (tool.locked || tool.hasChanges() || guard.current.presets || readOnly) return
    if (scope === 'book') { onConfigureBook(); return }
    setDraft(connection ? fieldsOf(connection) : { id: crypto.randomUUID(), name: '', baseUrl: '', model: '', contextWindow: 32_000, maxOutputTokens: 2048 })
    setDefault(scope === 'studio' && (studioConnections.find((item) => item.id === connection?.id)?.isDefault ?? !connections.length))
    setSecret(''); setDefaultConfirmed(false); setDiscard(false); tool.setDirty(!connection)
  }
  function change(value: Partial<AiConnectionConfig>) {
    if (!draft || tool.locked) return
    setDraft({ ...draft, ...value }); tool.setDirty(true); setPreserved(null)
  }
  async function save(event?: FormEvent): Promise<boolean> {
    event?.preventDefault()
    if (!draft || tool.locked || readOnly || changedDefault && !defaultConfirmed) return false
    try {
      const connection = parseAiConnectionConfig(draft), expectedVersion = original?.version ?? null
      const nextVersion = expectedVersion === null ? 0 : expectedVersion + 1
      const input = { connection, expectedVersion, ...(secret ? { apiKey: secret } : {}) }
      const accept = () => { setDraft(null); setSecret(''); setDiscard(false) }
      if (scope === 'studio') return await tool.write('generation.connection.save', () => api.configureStudioAiConnection({ ...input, isDefault }),
        (value) => value.id === connection.id && value.version === nextVersion && sameFields(fieldsOf(value), connection) && value.isDefault === isDefault,
        (value) => {
          setStudioConnections((items) => [...items.filter((item) => item.id !== value.id).map((item) => value.isDefault ? { ...item, isDefault: false } : item), value])
          accept()
        }, '连接配置已保存。可刷新查看本次会话密钥状态。')
      return false
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请检查连接名称、接口地址和模型参数。'); return false }
  }
  async function syncBook(snapshot: AiPresetsSnapshot) {
    if (!book) return
    const result = await request(() => api.getBook({ bookId: book.book.id }))
    if (!result.ok) throw new DomainError(result.error)
    if (result.data.book.id !== snapshot.bookId || result.data.book.revision < snapshot.bookRevision) throw new Error('Preset book mismatch')
    onBookChange(result.data)
  }
  const securityNote = <aside className={styles.securityNote} aria-label="密钥保存范围">
    <StudioIcon name="lock" size={28} />
    <div><h3>密钥仅保存在本次会话内存</h3><p>不写入作品文件，结束桌面会话后清除。</p>
      <p>连接测试仅读取模型列表；生成请求在固定预览经确认后发送。</p></div>
    <span className={styles.securityEmblem} aria-hidden="true"><StudioIcon name="shield" size={88} /><StudioIcon name="spark" size={30} /></span>
  </aside>
  return <Dialog title={<span className={styles.pageTitle}>模型路由中心<small>智能调度 · 高效协同 · 稳定可靠</small></span>} onClose={onClose} busy={tool.locked} wide>
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.tabs} aria-label="连接范围">
          <button type="button" aria-pressed={scope === 'studio'} disabled={tool.locked} onClick={() => changeScope('studio')}>工作室 · 开书模型</button>
          {book && <button type="button" aria-pressed={scope === 'book'} disabled={tool.locked} onClick={() => changeScope('book')}>《{book.book.title}》</button>}
        </div>
        <div className={styles.actions}><button className={styles.button} type="button" disabled={tool.locked || tool.dirty || guard.current.presets} onClick={() => void reload()}>刷新</button>
          <button className={styles.primaryButton} type="button" disabled={!loaded || tool.locked || tool.dirty || guard.current.presets || readOnly} onClick={() => edit()}><StudioIcon name="plus" />新增连接</button></div>
      </div>
      {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
      {tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
      {tool.busy && <p className={styles.muted} role="status">正在读取或保存连接…</p>}
      {tool.readFailure && <p className={styles.warning}>连接读取尚未确认。
        <button type="button" className={styles.button} disabled={tool.locked || !tool.readFailure.requestId} onClick={() => void tool.checkReadReceipt()}>核对原读取请求</button>
        <button type="button" className={styles.button} disabled={tool.busy} onClick={onRecover}>进入恢复</button>
      </p>}
      {readOnly && <p className={styles.warning}>{book?.book.archivedAt ? '归档作品的连接仅供查看。' : '请先通过作品工具备份并升级本书，再配置连接。'}</p>}
      <div className={styles.connections}>{connections.map((connection) => {
        const probe = probes[probeKey(connection)]
        return <article className={styles.connection} aria-label={connection.name} data-default={scope === 'studio' && studioConnections.find((item) => item.id === connection.id)?.isDefault} key={connection.id}>
        <header><span className={styles.connectionEmblem}><StudioIcon name="workflow" size={48} /></span><div><h3>{connection.name}</h3><p>{connection.model}</p></div>{scope === 'studio' && studioConnections.find((item) => item.id === connection.id)?.isDefault && <span className={styles.tag}><StudioIcon name="star" size={16} />默认</span>}</header>
        <dl className={styles.connectionMetrics}><div><dt>上下文窗口</dt><dd title={connection.contextWindow.toLocaleString()}>{connection.contextWindow.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}</dd></div><div className={styles.latency} data-state={probe?.state ?? 'idle'}><dt>连接延迟</dt><dd title="模型列表请求的响应头耗时，不代表生成速度"><i />延迟 {probe?.latencyMs != null ? `${probe.latencyMs} ms` : '—'}</dd></div></dl>
        <footer><details className={styles.connectionDetails}><summary>会话与连接信息</summary><p className={styles.endpoint}>{connection.baseUrl}</p><p>输出预算 {connection.maxOutputTokens.toLocaleString()} tokens</p><p>{keys.includes(connection.id) ? '本次会话已设置密钥' : '本次会话未设置密钥'}</p></details><div className={styles.actions}><button type="button" className={styles.button} disabled={tool.locked || tool.dirty || guard.current.presets || probe?.state === 'loading'} title="读取模型列表并核对模型名称，不发送正文或生成请求" onClick={() => void testConnection(connection)}><StudioIcon name="refresh" />{probe?.state === 'loading' ? '测试中…' : '测试连接'}</button>{probe?.state === 'loading' && <button type="button" className={styles.button} aria-label={`取消测试${connection.name}`} title="取消测试" onClick={() => void cancelTest(connection)}><StudioIcon name="close" /></button>}<button type="button" className={styles.button} disabled={tool.locked || tool.dirty || guard.current.presets || readOnly} aria-label={`编辑连接${connection.name}`} title={`编辑连接${connection.name}`} onClick={() => edit(connection)}><StudioIcon name="pen" size={16} /></button></div></footer>
        <p className={styles.probeStatus} role={probe?.state === 'failed' ? 'alert' : 'status'} data-state={probe?.state ?? 'idle'}>{probe?.message ?? '尚未测试连接'}</p>
      </article>})}</div>
      {loaded && !connections.length && <div className={styles.empty}><StudioIcon name="workflow" size={28} /><h3>还没有模型连接</h3><p>添加接口地址和模型，开始配置创作任务。</p></div>}
      {draft && <form className={styles.editor} onSubmit={(event) => void save(event)}>
        <h3>{original ? '编辑连接' : '新建连接'}</h3>
        <fieldset disabled={tool.locked}><div className={styles.fieldGrid}>
          <label>连接名称<input autoFocus required value={draft.name} onChange={(event) => change({ name: event.target.value })} /></label>
          <label>模型名称<input required value={draft.model} onChange={(event) => change({ model: event.target.value })} /></label>
          <label>接口地址<input required type="url" value={draft.baseUrl} onChange={(event) => change({ baseUrl: event.target.value })} /></label>
          <label>本次会话密钥<input type="password" autoComplete="new-password" maxLength={8192} value={secret} onChange={(event) => { setSecret(event.target.value); tool.setDirty(true) }} placeholder="留空保留当前会话密钥" /></label>
          <label>上下文窗口<input type="number" min={1} required value={draft.contextWindow} onChange={(event) => change({ contextWindow: Number(event.target.value) })} /></label>
          <label>最大输出 tokens<input type="number" min={1} required value={draft.maxOutputTokens} onChange={(event) => change({ maxOutputTokens: Number(event.target.value) })} /></label>
        </div>
          {scope === 'studio' && <label className={styles.check}><input type="checkbox" checked={isDefault} onChange={(event) => { setDefault(event.target.checked); setDefaultConfirmed(false); tool.setDirty(true) }} />设为开书默认连接</label>}
          {changedDefault && <label className={styles.check}><input type="checkbox" checked={defaultConfirmed} onChange={(event) => setDefaultConfirmed(event.target.checked)} />确认替换“{oldDefault?.name}”的默认状态</label>}
        </fieldset>
        <div className={styles.actions}><button type="submit" className={styles.primaryButton} disabled={tool.locked || !tool.dirty || changedDefault && !defaultConfirmed}>保存连接</button>
          <button type="button" className={styles.button} disabled={tool.locked} onClick={() => {
            if (tool.hasChanges() && !discard) { setDiscard(true); return }
            setDraft(null); setSecret(''); setDiscard(false); tool.setDirty(false)
          }}>{discard ? '确认放弃修改' : tool.dirty ? '放弃修改' : '关闭编辑'}</button></div>
      </form>}
      {tool.pending && <section className={styles.warning}><p>写入尚未确认，请核对原回执。恢复记录不包含密钥。</p><button type="button" className={styles.button} disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void tool.checkReceipt()}>核对原请求</button>
        <textarea aria-label="连接恢复记录" readOnly rows={7} value={recoveryText} /><label className={styles.check}><input type="checkbox" checked={preserved === recoveryText} onChange={(event) => setPreserved(event.target.checked ? recoveryText : null)} />已留存连接配置和原请求编号</label>
        <button type="button" className={styles.button} disabled={tool.busy || preserved !== recoveryText} onClick={() => { setSecret(''); onRecover() }}>进入恢复</button></section>}
      {scope === 'book' && book && loaded && <AiPresetsPanel api={api} bookId={book.book.id} bookRevision={book.book.revision} connections={connections} disabled={tool.locked || tool.dirty || Boolean(draft)} layout="routing" onSummary={onSummary}
        routingNotice={securityNote} onDirtyChange={(dirty) => { guard.current.presets = dirty; setPresetsDirty(dirty); callback.current(dirty || guard.current.connection) }} onApply={onApply} onChanged={syncBook} onRecover={onRecover} />}
      {!(scope === 'book' && book && loaded) && securityNote}
      {leave.confirming && <DialogDisplayContext.Provider value="modal"><Dialog title="离开模型配置？" onClose={leave.keepEditing} busy={tool.busy}>
        <p>当前连接有未保存修改。保存连接后离开，或明确放弃本次输入。</p>
        {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
        <div className={styles.actions}>
          <button className={styles.button} type="button" disabled={tool.busy} onClick={leave.keepEditing}>{leave.source === 'window' ? '返回保存' : '继续编辑'}</button>
          <button className={styles.button} type="button" disabled={tool.locked} onClick={leave.discardAndLeave}>放弃修改并离开</button>
          {leave.source !== 'window' && <button className={styles.primaryButton} type="button" disabled={tool.locked || readOnly || changedDefault && !defaultConfirmed}
            title={changedDefault && !defaultConfirmed ? '请先返回确认默认连接替换' : undefined}
            onClick={() => void save().then((saved) => { if (saved) leave.savedAndLeave() })}>保存连接并离开</button>}
        </div>
      </Dialog></DialogDisplayContext.Provider>}
    </div>
  </Dialog>
}
