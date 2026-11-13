import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { DomainError, type AppError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import {
  MAX_WEAVE_MINUTE, WEAVE_SCHEMA_VERSION, applyWeaveAction, isWeaveSnapshot,
  parseWeaveMutationInput, weaveTaskComplete, type WeaveAction, type WeaveMutationInput, type WeaveSnapshot, type WeaveState, type WeaveTask,
} from '../../contracts/weave-system'
import { usePanelLeave, type RegisterPanelLeaveGuard } from '../hooks/usePanelLeave'
import { Dialog, DialogDisplayContext } from './Dialog'
import { StudioIcon } from './StudioIcon'
import { WeaveSystemEditor } from './WeaveSystemEditor'
import { useToolSession } from './workbench-ui'
import styles from './StellarWeave.module.css'

interface Props {
  api: StudioApi; book: BookSnapshot; disabled: boolean
  onClose: () => void; onChapter: (id: string) => void; onBookChange: (book: BookSnapshot) => void
  onDirtyChange: (dirty: boolean) => void; registerLeaveGuard: RegisterPanelLeaveGuard
  onUnknown: (error: AppError) => void; onRecover: () => void
}
function initialState(): WeaveState {
  return { name: '', currency: '', points: 0, experience: 0, storyMinute: 0, activityDay: null, idleDays: 0, cooldownUntil: 0,
    penalty: { description: '', afterDays: 0, cooldownMinutes: 0 }, tasks: [], offers: [], inventory: [] }
}
function duration(minutes: number): string {
  const value = Math.max(0, minutes)
  return `${Math.floor(value / 1440)} 天 ${Math.floor(value % 1440 / 60)} 时 ${value % 60} 分`
}
function clock(minute: number): string {
  return `剧情第 ${Math.floor(minute / 1440) + 1} 日 ${String(Math.floor(minute % 1440 / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}
export function WeaveSystemPanel({ api, book, disabled, onClose, onChapter, onBookChange, onDirtyChange, registerLeaveGuard, onUnknown, onRecover }: Props) {
  const bookId = book.book.id
  const [snapshot, setSnapshot] = useState<WeaveSnapshot | null>(null)
  const [draft, setDraft] = useState<WeaveState | null>(null)
  const [conflict, setConflict] = useState<WeaveSnapshot | null>(null)
  const [selectedMain, setSelectedMain] = useState('')
  const [selectedReward, setSelectedReward] = useState('')
  const [selectedOffer, setSelectedOffer] = useState('')
  const [confirmation, setConfirmation] = useState<Extract<WeaveAction, { kind: 'claim' | 'redeem' }> | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshDay, setRefreshDay] = useState('1')
  const [refreshTime, setRefreshTime] = useState('00:00')
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [preserved, setPreserved] = useState<string | null>(null)
  const [syncRequired, setSyncRequired] = useState(false)
  const snapshotRef = useRef(snapshot), bookRef = useRef(book), syncRef = useRef(false)
  const intended = useRef<WeaveMutationInput | null>(null)
  const needsRead = useRef(true)
  bookRef.current = book
  const tool = useToolSession({ api, disabled, onDirtyChange, onUnknown, isProtected: () => syncRef.current })
  const leave = usePanelLeave({
    register: registerLeaveGuard,
    blockedReason: () => tool.locked ? '系统正在读写或原回执尚未确认，请先核对请求。'
      : syncRef.current ? '写入已确认，请先同步作品目录后再离开。' : null,
    hasChanges: tool.hasChanges, onBlocked: tool.setError,
    onDiscard: () => { setDraft(null); setConflict(null); tool.setDirty(false) },
  })
  const fields = snapshot?.fields
  const archived = Boolean(book.book.archivedAt || snapshot?.archived)
  const stale = Boolean(snapshot && book.book.revision > snapshot.bookRevision)
  const blocked = tool.locked || syncRequired || stale || archived || !snapshot || snapshot.requiresUpgrade || Boolean(draft)
  const mains = fields?.tasks.filter((task) => task.active && task.kind === 'main') ?? []
  const daily = fields?.tasks.filter((task) => task.active && task.kind === 'daily') ?? []
  const main = mains.find((task) => task.id === selectedMain) ?? mains[0]
  const rewardTasks = fields?.tasks.filter((task) => task.active) ?? []
  const rewardTask = rewardTasks.find((task) => task.id === selectedReward)
    ?? rewardTasks.find((task) => weaveTaskComplete(task) && !task.claimed) ?? main ?? daily[0]
  const offers = fields?.offers.filter((offer) => offer.active) ?? []
  const offer = offers.find((item) => item.id === selectedOffer) ?? offers[0]
  const confirmationTaskId = confirmation?.kind === 'claim' ? confirmation.taskId : null
  const confirmationOfferId = confirmation?.kind === 'redeem' ? confirmation.offerId : null
  const confirmationTask = fields?.tasks.find((task) => task.id === confirmationTaskId)
  const confirmationOffer = fields?.offers.find((item) => item.id === confirmationOfferId)
  const sections = Number(Boolean(main)) + Number(daily.length > 0) + Number(Boolean(rewardTask) || offers.length > 0)
  const hasData = sections > 0 || Boolean(fields?.inventory.length)
  const claimReason = !rewardTask ? '没有可领取的任务' : rewardTask.claimed ? '奖励已领取' : !weaveTaskComplete(rewardTask) ? '请先完成全部步骤'
    : fields && rewardTask.kind === 'daily' && fields.cooldownUntil > fields.storyMinute ? `惩罚冷却 ${duration(fields.cooldownUntil - fields.storyMinute)}` : null
  const redeemReason = !offer ? '请选择商品' : offer.stock !== null && offer.stock < offer.quantity ? '库存不足' : fields && offer.availableAt > fields.storyMinute
    ? `冷却 ${duration(offer.availableAt - fields.storyMinute)}` : fields && offer.price > fields.points ? '积分不足' : null
  const recoveryText = JSON.stringify({ bookId, bookRevision: snapshot?.bookRevision, systemRevision: snapshot?.revision,
    requestId: tool.pending?.error.requestId ?? tool.readFailure?.requestId ?? null, command: tool.pending?.command ?? null,
    input: intended.current, draft, confirmed: snapshot }, null, 2)

  useEffect(() => {
    if (!disabled && needsRead.current) { needsRead.current = false; void reload() }
  }, [disabled])
  useEffect(() => () => { needsRead.current = true }, [])
  function receive(value: WeaveSnapshot) { snapshotRef.current = value; setSnapshot(value) }
  function requireSync() { syncRef.current = true; setSyncRequired(true) }
  async function reload() {
    if (tool.hasChanges() || tool.hasPending()) { tool.setError('请先处理输入或核对原回执，再重新读取。'); return }
    await tool.read(async () => {
      const catalog = await api.getBook({ bookId })
      if (!catalog.ok) return catalog
      const result = await api.getWeaveSystem({ bookId })
      if (!result.ok) return result
      if (catalog.data.book.id !== bookId || !isWeaveSnapshot(result.data, bookId) || result.data.bookRevision !== catalog.data.book.revision) {
        return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '作品在读取期间变化，请再次读取系统。' } }
      }
      return { ok: true as const, data: { catalog: catalog.data, system: result.data } }
    }, ({ catalog, system }) => {
      if (tool.hasChanges() || tool.hasPending() || system.bookRevision < bookRef.current.book.revision || system.bookRevision < (snapshotRef.current?.bookRevision ?? 0)) throw new Error('Stale weave snapshot')
      receive(system); onBookChange(catalog)
      syncRef.current = false; setSyncRequired(false)
      intended.current = null; setDraft(null); setConflict(null); setPreserved(null)
    })
  }
  async function mutate(action: WeaveAction): Promise<boolean> {
    const baseline = snapshotRef.current
    if (!baseline || tool.locked || syncRef.current || baseline.requiresUpgrade) return false
    if (stale || archived) { tool.setError(archived ? '作品已归档，当前输入保留，不能写入。' : '作品已有新版本，请先读取最新版本进行比较。'); return false }
    try {
      const input = parseWeaveMutationInput({ bookId, expectedBookRevision: baseline.bookRevision, expectedRevision: baseline.revision, operationId: crypto.randomUUID(), action })
      const expected = applyWeaveAction(baseline.fields, input.action)
      if (action.kind === 'configure' && JSON.stringify(expected) === JSON.stringify(baseline.fields)) {
        setDraft(null); tool.setDirty(false); tool.setNotice('系统设定未变化。'); return true
      }
      intended.current = input; setPreserved(null)
      const oldPoints = baseline.fields?.points ?? 0, oldExperience = baseline.fields?.experience ?? 0
      const delta = `积分 ${expected.points - oldPoints >= 0 ? '+' : ''}${expected.points - oldPoints} · 经验 ${expected.experience - oldExperience >= 0 ? '+' : ''}${expected.experience - oldExperience}`
      const success = await tool.write('weave.mutate', () => api.mutateWeaveSystem(input),
        (value) => isWeaveSnapshot(value, bookId) && !value.requiresUpgrade && value.bookRevision === input.expectedBookRevision + 1
          && value.revision === input.expectedRevision + 1 && value.operationId === input.operationId && JSON.stringify(value.fields) === JSON.stringify(expected),
        (value) => { receive(value); setDraft(null); setConflict(null); setConfirmation(null); setRefreshing(false); requireSync() },
        action.kind === 'configure' ? '系统设定已保存。' : action.kind === 'claim' || action.kind === 'redeem' ? `已确认${action.kind === 'claim' ? '领取' : '兑换'}：${delta}。` : action.kind === 'refresh' ? '剧情时间与每日任务已刷新。' : '任务进度已保存。')
      if (success) await reload()
      return success
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请核对系统设定后重试。'); return false }
  }
  async function upgrade() {
    if (!snapshot?.requiresUpgrade || !upgradeConfirmed || tool.locked || archived) return
    const expected = snapshot.bookRevision
    const success = await tool.write('knowledge.upgrade', () => api.upgradeKnowledge({ bookId, expectedBookRevision: expected }),
      (value) => value.bookId === bookId && value.schemaVersion >= WEAVE_SCHEMA_VERSION && !value.requiresUpgrade && value.bookRevision === expected + 1 && Boolean(value.backupPath),
      () => { requireSync(); setUpgradeConfirmed(false) }, '备份与格式升级已确认，请同步作品。')
    if (success) await reload()
  }
  function edit() {
    if (blocked || !snapshot) return
    setDraft(fields ? structuredClone(fields) : initialState()); setConflict(null); setConfirmation(null); setRefreshing(false)
    tool.setDirty(!fields); tool.setError(null); tool.setNotice(null)
  }
  function change(next: WeaveState) { if (!tool.locked) { setDraft(next); tool.setDirty(true); tool.setNotice(null) } }
  async function compare() {
    if (tool.locked || !draft || syncRef.current) return
    await tool.read(() => api.getWeaveSystem({ bookId }), (value) => {
      if (!isWeaveSnapshot(value, bookId) || value.bookRevision < bookRef.current.book.revision || value.bookRevision < (snapshotRef.current?.bookRevision ?? 0)) throw new Error('Stale comparison')
      if (value.revision === snapshotRef.current?.revision && value.bookRevision === snapshotRef.current.bookRevision) {
        setConflict(null); tool.setNotice('最新版本与当前基线一致，输入保留，可以继续保存。'); return
      }
      setConflict(value)
    })
  }
  function step(task: WeaveTask, id: string, done: boolean) {
    if (!blocked) void mutate({ kind: 'step', taskId: task.id, stepId: id, done })
  }
  function startRefresh() {
    if (!fields || blocked) return
    setRefreshDay(String(Math.floor(fields.storyMinute / 1440) + 2)); setRefreshTime('00:00'); setRefreshing(true)
  }
  function confirmRefresh(event: FormEvent) {
    event.preventDefault()
    const [hour, minute] = refreshTime.split(':').map(Number)
    const total = (Number(refreshDay) - 1) * 1440 + hour * 60 + minute
    void mutate({ kind: 'refresh', storyMinute: total })
  }
  function taskSteps(task: WeaveTask) {
    return <ul className={styles.steps}>{task.steps.map((item) => <li key={item.id}><label data-done={item.done}>
      <input type="checkbox" checked={item.done} disabled={blocked || task.claimed} onChange={(event) => step(task, item.id, event.target.checked)} />
      <span className={styles.stepMark} aria-hidden="true">{item.done && <StudioIcon name="check" size={20} />}</span><span>{item.title}</span>
    </label></li>)}</ul>
  }
  const modal = (title: string, content: ReactNode, close: () => void, wide = false) =>
    <DialogDisplayContext.Provider value="modal"><Dialog title={title} busy={tool.busy} onClose={close} wide={wide}><div className={styles.panel}>{content}</div></Dialog></DialogDisplayContext.Provider>

  return <Dialog title="织星系统" className={styles.page} onClose={onClose} busy={tool.busy} toolbar={<div className={styles.toolbar}>
    <button className={styles.iconButton} type="button" title="重新读取系统" aria-label="重新读取系统" disabled={tool.locked || tool.dirty} onClick={() => void reload()}><StudioIcon name="refresh" /></button>
    <button className={styles.iconButton} type="button" title="系统设定" aria-label="系统设定" disabled={blocked} onClick={edit}><StudioIcon name="settings" /></button>
    {archived && <span>归档 · 只读</span>}
  </div>}><div className={styles.panel}>
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
    {tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {tool.readFailure?.requestId && <button className={styles.button} type="button" disabled={tool.locked} onClick={() => void tool.checkReadReceipt()}>核对原读取请求</button>}
    {(stale || syncRequired) && <p className={styles.warning}>作品目录需要同步。<button className={styles.button} type="button" disabled={tool.locked || tool.dirty} onClick={() => void reload()}>重新读取作品与系统</button></p>}
    {!snapshot && <p className={styles.note} role="status">{tool.busy ? '正在读取系统设定…' : '系统尚未读取，可重新读取。'}</p>}
    {snapshot?.requiresUpgrade && <section className={styles.upgrade}><h3>启用织星系统</h3><p>当前格式 v{snapshot.schemaVersion}。先为本书建立独立备份并核对，再升级至 v{WEAVE_SCHEMA_VERSION}；未录入系统数据时不显示任务栏。</p>
      <label className={styles.check}><input type="checkbox" checked={upgradeConfirmed} disabled={tool.locked || archived} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />同意先备份，再升级本书</label>
      <button className={styles.button} type="button" disabled={tool.locked || archived || !upgradeConfirmed} onClick={() => void upgrade()}>备份并启用</button></section>}
    {snapshot && !snapshot.requiresUpgrade && !fields && <div className={styles.setup}><button className={styles.primaryButton} type="button" disabled={blocked} onClick={edit}><StudioIcon name="plus" />录入本书系统设定</button></div>}
    {fields && hasData && <>
      <header className={styles.systemBar}><StudioIcon name="spark" size={44} /><div><h2>{fields.name}</h2><span>{clock(fields.storyMinute)}</span></div><dl><div><dt>{fields.currency}</dt><dd>{fields.points.toLocaleString()}</dd></div><div><dt>经验</dt><dd>{fields.experience.toLocaleString()}</dd></div></dl></header>
      {sections > 0 && <div className={styles.columns} data-sections={sections}>
        {main && <section className={styles.main}><h3><StudioIcon name="spark" size={25} />主线任务</h3>
          {mains.length > 1 && <select aria-label="选择主线任务" value={main.id} disabled={blocked} onChange={(event) => setSelectedMain(event.target.value)}>{mains.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select>}
          <h4>{main.title}</h4><span className={styles.count}>{main.steps.filter((item) => item.done).length} / {main.steps.length}</span>
          <progress className={styles.progress} value={main.steps.filter((item) => item.done).length} max={main.steps.length} aria-label={`${main.title}完成进度`} />
          {taskSteps(main)}<StudioIcon name="orbit" size={180} />
          <button className={styles.primaryButton} type="button" disabled={blocked || !main.chapterId || !book.chapters.some((chapter) => chapter.id === main.chapterId)}
            title={main.chapterId ? '前往关联章节' : '请先在系统设定中关联章节'} onClick={() => { if (main.chapterId) onChapter(main.chapterId) }}><StudioIcon name="navigation" size={25} />前往</button>
        </section>}
        {daily.length > 0 && <section className={styles.daily}><h3><StudioIcon name="crystal" size={25} />每日任务</h3><ul className={styles.taskList}>{daily.map((task, index) => <li key={task.id} data-claimed={task.claimed}>
          <details><summary><span className={styles.taskIcon}><StudioIcon name={(['pen', 'read', 'users', 'spark', 'notes'] as const)[index % 5]} size={28} /></span>
            <span className={styles.dailyText}><strong>{task.title}</strong><progress className={styles.progress} value={task.steps.filter((item) => item.done).length} max={task.steps.length} aria-label={`${task.title}完成进度`} /></span>
            <span className={styles.completion} data-done={weaveTaskComplete(task)} aria-label={task.claimed ? '奖励已领取' : weaveTaskComplete(task) ? '已完成' : '未完成'}>{weaveTaskComplete(task) && <StudioIcon name="check" size={20} />}</span>
            <small>{task.claimed ? '已领取' : `+${task.reward.experience} 经验`}</small></summary>
            {taskSteps(task)}<div className={styles.actions}><button className={styles.button} type="button" disabled={blocked || task.claimed || !weaveTaskComplete(task) || fields.cooldownUntil > fields.storyMinute} onClick={() => { setSelectedReward(task.id); setConfirmation({ kind: 'claim', taskId: task.id }) }}>领取</button>
              {task.chapterId && <button className={styles.button} type="button" disabled={blocked || !book.chapters.some((chapter) => chapter.id === task.chapterId)} onClick={() => onChapter(task.chapterId!)}>前往</button>}</div>
          </details></li>)}</ul></section>}
        {(rewardTask || offers.length > 0) && <aside className={styles.right}>
          {rewardTask && <section className={styles.rewards} data-claimed={rewardTask.claimed}><h3><StudioIcon name="gift" size={25} />奖励与词条</h3>
            <select aria-label="选择奖励对应任务" value={rewardTask.id} disabled={blocked} onChange={(event) => setSelectedReward(event.target.value)}>{rewardTasks.map((task) => <option key={task.id} value={task.id}>{task.title}{task.claimed ? ' · 已领取' : ''}</option>)}</select>
            <div className={styles.rewardList}>
              {rewardTask.reward.points > 0 && <div className={styles.reward}><StudioIcon name="crystal" size={64} /><strong>× {rewardTask.reward.points}</strong><span>{fields.currency}</span></div>}
              {rewardTask.reward.experience > 0 && <div className={styles.reward}><StudioIcon name="star" size={64} /><strong>× {rewardTask.reward.experience}</strong><span>经验</span></div>}
              {rewardTask.reward.items.map((item) => <div className={styles.reward} key={item.name}><StudioIcon name="read" size={64} /><strong>× {item.quantity}</strong><span>{item.name}</span></div>)}
            </div><button className={styles.primaryButton} type="button" disabled={blocked || Boolean(claimReason)} title={claimReason ?? undefined} onClick={() => setConfirmation({ kind: 'claim', taskId: rewardTask.id })}><StudioIcon name="gift" size={23} />{rewardTask.claimed ? '奖励已领取' : '领取奖励'}</button>
            {claimReason && <small className={styles.note}>{claimReason}</small>}
          </section>}
          {offers.length > 0 && <section className={styles.shop}><h3><StudioIcon name="spark" size={25} />积分商店</h3><div className={styles.offerList} role="group" aria-label="选择兑换商品">{offers.map((item, index) => <button className={styles.offer} key={item.id} type="button" aria-pressed={item.id === offer?.id} disabled={blocked} onClick={() => setSelectedOffer(item.id)} title={item.description || item.name}>
            <StudioIcon name={(['compass', 'notes', 'crystal'] as const)[index % 3]} size={42} /><strong>{item.name}</strong><span>× {item.price}</span><small>{item.stock === null ? '不限库存' : `剩余 ${item.stock}`}</small></button>)}</div>
            {offer && <small className={styles.note}>{offer.description} · 每次 {offer.quantity} 件 · 已兑换 {offer.purchased} 次</small>}
            <button className={styles.button} type="button" disabled={blocked || Boolean(redeemReason)} title={redeemReason ?? undefined} onClick={() => { if (offer) setConfirmation({ kind: 'redeem', offerId: offer.id }) }}><StudioIcon name="cart" size={23} />兑换</button>
            {redeemReason && <small className={styles.note}>{redeemReason}</small>}
          </section>}
        </aside>}
      </div>}
      <footer className={styles.footer}><StudioIcon name={fields.cooldownUntil > fields.storyMinute ? 'clock' : 'warning'} size={27} /><div>
        {fields.cooldownUntil > fields.storyMinute ? <p>每日奖励冷却：{duration(fields.cooldownUntil - fields.storyMinute)}<small>按剧情时间计算</small></p>
          : fields.penalty.afterDays > 0 ? <p>惩罚：{fields.penalty.description || `连续 ${fields.penalty.afterDays} 天未完成任务，进入 ${duration(fields.penalty.cooldownMinutes)} 冷却。`}</p> : <p>未启用惩罚规则</p>}
      </div><button className={styles.refreshButton} type="button" disabled={blocked || fields.storyMinute >= MAX_WEAVE_MINUTE} onClick={startRefresh}><StudioIcon name="refresh" size={24} />刷新任务</button></footer>
      {fields.inventory.length > 0 && <details className={styles.inventory}><summary>已领取物品 · {fields.inventory.length} 种</summary><ul>{fields.inventory.map((item) => <li key={item.name}><span>{item.name}</span><strong>× {item.quantity}</strong></li>)}</ul></details>}
    </>}
    {draft && !tool.pending && !leave.confirming && modal('系统设定', <WeaveSystemEditor fields={draft} book={book} disabled={tool.locked} onChange={change}
      error={tool.error} notice={tool.notice} onSave={() => void mutate({ kind: 'configure', fields: draft })} onCancel={() => { if (tool.hasChanges()) void onClose(); else setDraft(null) }}
      onCompare={() => void compare()} conflict={conflict} onUseLatest={() => {
        if (!conflict || tool.locked) return
        receive(conflict); setDraft(null); setConflict(null); tool.setDirty(false); requireSync()
        void reload()
      }} />, () => { if (tool.hasChanges()) void onClose(); else setDraft(null) }, true)}
    {confirmation && !tool.pending && modal(confirmation.kind === 'claim' ? '确认领取奖励' : '确认兑换', <>
      <p>{confirmation.kind === 'claim' ? `领取「${confirmationTask?.title ?? ''}」的设定奖励。`
        : `兑换「${confirmationOffer?.name ?? ''}」，扣除 ${confirmationOffer?.price ?? 0} ${fields?.currency ?? ''}。`}</p>
      <p>变更写入当前作品的系统历史。</p>{tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
      <div className={styles.actions}><button className={styles.button} type="button" disabled={tool.locked} onClick={() => setConfirmation(null)}>取消</button><button className={styles.primaryButton} type="button" disabled={blocked} onClick={() => void mutate(confirmation)}>确认</button></div>
    </>, () => { if (!tool.locked) setConfirmation(null) })}
    {refreshing && !tool.pending && modal('刷新任务', <form className={styles.editor} onSubmit={confirmRefresh}>
      <p>当前为{clock(fields?.storyMinute ?? 0)}。跨日将重置每日任务及未领取奖励；依据本书规则结算未完成天数和冷却。</p>
      <div className={styles.fieldGrid}><label>推进至剧情第几日<input type="number" min={1} max={Math.floor(MAX_WEAVE_MINUTE / 1440) + 1} required value={refreshDay} disabled={tool.locked} onChange={(event) => setRefreshDay(event.target.value)} /></label>
        <label>时刻<input type="time" required value={refreshTime} disabled={tool.locked} onChange={(event) => setRefreshTime(event.target.value)} /></label></div>
      {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}<div className={styles.actions}><button className={styles.button} type="button" disabled={tool.locked} onClick={() => setRefreshing(false)}>取消</button><button className={styles.primaryButton} type="submit" disabled={blocked}>确认推进并刷新</button></div>
    </form>, () => { if (!tool.locked) setRefreshing(false) })}
    {(tool.pending || syncRequired) && <section className={styles.warning}><p>{tool.pending ? '原写入结果尚未确认，暂停重发、领取、兑换和离开。' : '写入已确认，作品目录尚未同步。可重新读取；同步失败时留存记录后进入恢复。'}</p>
      {tool.pending && <button className={styles.button} type="button" disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void tool.checkReceipt().then((ok) => { if (ok) void reload() })}>核对原写入</button>}
      <textarea rows={6} aria-label="织星系统恢复记录" readOnly value={recoveryText} />
      <label className={styles.check}><input type="checkbox" checked={preserved === recoveryText} onChange={(event) => setPreserved(event.target.checked ? recoveryText : null)} />已留存当前输入、操作编号和原请求编号</label>
      <button className={styles.button} type="button" disabled={tool.busy || preserved !== recoveryText} onClick={onRecover}>进入恢复</button></section>}
    {leave.confirming && modal('离开织星系统？', <><p>系统设定有未保存修改。</p><div className={styles.actions}>
      <button className={styles.button} type="button" onClick={leave.keepEditing}>{leave.source === 'window' ? '返回保存' : '继续编辑'}</button>
      <button className={styles.button} type="button" disabled={tool.locked} onClick={leave.discardAndLeave}>放弃修改并离开</button>
    </div></>, leave.keepEditing)}
  </div></Dialog>
}
