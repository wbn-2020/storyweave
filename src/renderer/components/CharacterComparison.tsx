import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DomainError, type AppError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import type { KnowledgeItemSummary } from '../../contracts/knowledge'
import {
  COMBAT_AXES, COMBAT_LABELS, REALM_SCHEMA_VERSION, applyRealmAction, isRealmSnapshot, parseRealmMutationInput, realmBreakthrough,
  type RealmAction, type RealmMutationInput, type RealmSimulation, type RealmSnapshot, type RealmState,
} from '../../contracts/realm'
import { usePanelLeave, type RegisterPanelLeaveGuard } from '../hooks/usePanelLeave'
import { Dialog, DialogDisplayContext } from './Dialog'
import { CharacterProfileView } from './CharacterProfileEditor'
import { RealmEditor, RealmPersonPicker } from './RealmEditor'
import { SavedPortrait, useSavedPortraits } from './SavedPortrait'
import { StudioIcon, type StudioIconName } from './StudioIcon'
import { useToolSession } from './workbench-ui'
import styles from './StellarCharacters.module.css'

interface Props {
  api: StudioApi; book: BookSnapshot; disabled: boolean; onClose: () => void; onOpen: (id?: string) => void
  onPlan: () => void; onBookChange: (book: BookSnapshot) => void
  onDirtyChange: (dirty: boolean) => void; registerLeaveGuard: RegisterPanelLeaveGuard
  onUnknown: (error: AppError) => void; onRecover: () => void
}
const axisIcons: Record<typeof COMBAT_AXES[number], StudioIconName> = { attack: 'sword', defense: 'shield', health: 'heart', speed: 'bolt', magic: 'spark', accuracy: 'focus' }
function initialState(): RealmState {
  return { levels: Array.from({ length: 5 }, () => ({ id: crypto.randomUUID(), name: '', description: '', conditions: [] })), characters: [], protagonistId: null }
}
export function CharacterComparison({ api, book, disabled, onClose, onOpen, onPlan, onBookChange, onDirtyChange, registerLeaveGuard, onUnknown, onRecover }: Props) {
  const bookId = book.book.id
  const [snapshot, setSnapshot] = useState<RealmSnapshot | null>(null)
  const [draft, setDraft] = useState<RealmState | null>(null)
  const [conflict, setConflict] = useState<RealmSnapshot | null>(null)
  const [known, setKnown] = useState<KnowledgeItemSummary[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [focus, setFocus] = useState('')
  const [picker, setPicker] = useState(false), [discardEditor, setDiscardEditor] = useState(false)
  const [simulation, setSimulation] = useState<RealmSimulation | null>(null), [simulating, setSimulating] = useState(false)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [syncRequired, setSyncRequired] = useState(false), [preserved, setPreserved] = useState<string | null>(null)
  const snapshotRef = useRef(snapshot), bookRef = useRef(book), syncRef = useRef(false), selectedRef = useRef(selected)
  const intended = useRef<RealmMutationInput | null>(null), needsRead = useRef(true)
  bookRef.current = book; selectedRef.current = selected
  const tool = useToolSession({ api, disabled, onDirtyChange, onUnknown, isProtected: () => syncRef.current })
  const leave = usePanelLeave({ register: registerLeaveGuard,
    blockedReason: () => tool.locked ? '正在读取、保存或等待原回执，请先核对请求。' : syncRef.current ? '写入已确认，请先同步作品目录。' : null,
    hasChanges: tool.hasChanges, onBlocked: tool.setError,
    onDiscard: () => { setDraft(null); setConflict(null); setDiscardEditor(false); tool.setDirty(false) },
  })
  const portraits = useSavedPortraits(api, bookId, book.book.revision, snapshot)
  const fields = snapshot?.fields
  const archived = Boolean(book.book.archivedAt || snapshot?.archived)
  const stale = Boolean(snapshot && snapshot.bookRevision !== book.book.revision)
  const blocked = tool.locked || syncRequired || stale || archived || !snapshot || snapshot.requiresUpgrade || Boolean(draft)
  const people = new Map([...known.map((person) => [person.id, { id: person.id, name: person.name }] as const),
    ...(snapshot?.people ?? []).map((person) => [person.id, person] as const)])
  const characters = selected.map((id) => people.get(id)).filter((person): person is { id: string; name: string } => Boolean(person))
  const active = characters.find((person) => person.id === focus) ?? characters[0]
  const activeCharacter = fields?.characters.find((person) => person.personId === active?.id)
  let breakthrough: ReturnType<typeof realmBreakthrough> | null = null
  let unavailable = !active ? '请选择人物' : !fields ? '请先录入本书境界与战力' : null
  if (fields && active) try { breakthrough = realmBreakthrough(fields, active.id) }
  catch (error) { unavailable = error instanceof DomainError ? error.detail.message : '当前境界资料不可用于推演。' }
  const insufficient = breakthrough?.checks.some((item) => !item.met) ?? false
  const protagonist = fields?.characters.find((person) => person.personId === fields.protagonistId)
  const protagonistName = protagonist ? people.get(protagonist.personId)?.name ?? '主角' : '主角'
  const stronger = characters.flatMap((person) => {
    const power = fields?.characters.find((item) => item.personId === person.id)?.totalPower
    if (person.id === protagonist?.personId || power == null || protagonist?.totalPower == null || power <= protagonist.totalPower) return []
    return [{ id: person.id, name: person.name, power, difference: protagonist.totalPower === 0 ? null : (power - protagonist.totalPower) / protagonist.totalPower * 100 }]
  })
  const validSimulation = simulation && simulation.bookRevision === book.book.revision && simulation.revision === snapshot?.revision &&
    simulation.personId === active?.id ? simulation : null
  const recoveryText = JSON.stringify({ bookId, bookRevision: snapshot?.bookRevision, realmRevision: snapshot?.revision,
    requestId: tool.pending?.error.requestId ?? tool.readFailure?.requestId ?? null, command: tool.pending?.command ?? null,
    input: intended.current, draft, confirmed: snapshot }, null, 2)

  useEffect(() => {
    if (!disabled && needsRead.current) { needsRead.current = false; void reload() }
  }, [disabled])
  useEffect(() => () => { needsRead.current = true }, [])
  function receive(value: RealmSnapshot) { snapshotRef.current = value; setSnapshot(value); setSimulation(null) }
  function requireSync() { syncRef.current = true; setSyncRequired(true) }
  async function reload() {
    if (tool.hasChanges() || tool.hasPending()) { tool.setError('请先处理未保存输入或核对原回执。'); return }
    await tool.read(async () => {
      const catalog = await api.getBook({ bookId })
      if (!catalog.ok) return catalog
      const realm = await api.getRealm({ bookId })
      if (!realm.ok) return realm
      if (catalog.data.book.id !== bookId || !isRealmSnapshot(realm.data, bookId) || realm.data.bookRevision !== catalog.data.book.revision) {
        return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '境界资料与作品版本不一致，请重新读取。' } }
      }
      // v2 尚无知识表，先显示显式备份升级入口，不能让人物列表失败遮住升级操作。
      if (realm.data.schemaVersion < 3) return { ok: true as const, data: { catalog: catalog.data, realm: realm.data, items: [] as KnowledgeItemSummary[] } }
      const roster = await api.listKnowledgeItems({ bookId, kind: 'person', limit: 30, offset: 0 })
      if (!roster.ok) return roster
      if (roster.data.bookId !== bookId || roster.data.bookRevision !== realm.data.bookRevision || roster.data.knowledgeRevision !== realm.data.knowledgeRevision ||
        !Array.isArray(roster.data.items) || roster.data.items.some((person) => person.bookId !== bookId || person.kind !== 'person')) {
        return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '作品或人物在读取期间变化，请重新读取。' } }
      }
      const items = [...roster.data.items]
      for (const id of selectedRef.current) if (!items.some((person) => person.id === id)) {
        const result = await api.getKnowledgeItem({ bookId, id })
        if (!result.ok) return result
        if (result.data.bookId !== bookId || result.data.id !== id || result.data.kind !== 'person' || result.data.bookRevision !== realm.data.bookRevision ||
          result.data.knowledgeRevision !== realm.data.knowledgeRevision) return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '比较人物版本已变化，请重新读取。' } }
        items.push(result.data)
      }
      return { ok: true as const, data: { catalog: catalog.data, realm: realm.data, items } }
    }, ({ catalog, realm, items }) => {
      if (tool.hasChanges() || tool.hasPending() || realm.bookRevision < bookRef.current.book.revision || realm.bookRevision < (snapshotRef.current?.bookRevision ?? 0)) throw new Error('Stale realm snapshot')
      receive(realm); setKnown(items); onBookChange(catalog)
      syncRef.current = false; setSyncRequired(false); setDraft(null); setConflict(null); setPreserved(null); intended.current = null
      const ids = new Set([...realm.people.map((person) => person.id), ...items.map((person) => person.id)])
      setSelected((current) => {
        const kept = current.filter((id) => ids.has(id))
        return kept.length ? kept : (realm.fields?.characters.map((person) => person.personId) ?? items.map((person) => person.id)).slice(0, 3)
      })
    })
  }
  async function mutate(action: RealmAction) {
    const baseline = snapshotRef.current
    if (!baseline || tool.locked || syncRef.current || baseline.requiresUpgrade) return
    if (archived || stale) { tool.setError(archived ? '作品已归档，输入保留，不能写入。' : '作品已有新版本，请核对最新版本后继续编辑。'); return }
    try {
      const input = parseRealmMutationInput({ bookId, expectedBookRevision: baseline.bookRevision, expectedRevision: baseline.revision, operationId: crypto.randomUUID(), action })
      const expected = applyRealmAction(baseline.fields, input.action)
      if (JSON.stringify(expected) === JSON.stringify(baseline.fields)) { setDraft(null); tool.setDirty(false); tool.setNotice('境界设定未变化。'); return }
      intended.current = input; setPreserved(null)
      const success = await tool.write('realm.mutate', () => api.mutateRealm(input),
        (value) => isRealmSnapshot(value, bookId) && !value.requiresUpgrade && value.bookRevision === input.expectedBookRevision + 1 &&
          value.revision === input.expectedRevision + 1 && value.operationId === input.operationId && JSON.stringify(value.fields) === JSON.stringify(expected),
        (value) => { receive(value); setDraft(null); setConflict(null); setDiscardEditor(false); requireSync() },
        action.kind === 'configure' ? '境界与战力设定已保存。' : '突破已登记，境界与资源变更已保存。')
      if (success) await reload()
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请核对境界设定后重试。') }
  }
  async function upgrade() {
    if (!snapshot?.requiresUpgrade || !upgradeConfirmed || tool.locked || archived) return
    const expected = snapshot.bookRevision
    const success = await tool.write('knowledge.upgrade', () => api.upgradeKnowledge({ bookId, expectedBookRevision: expected }),
      (value) => value.bookId === bookId && value.schemaVersion >= REALM_SCHEMA_VERSION && !value.requiresUpgrade && value.bookRevision === expected + 1 && Boolean(value.backupPath),
      () => { requireSync(); setUpgradeConfirmed(false) }, '独立备份与格式升级已确认。')
    if (success) await reload()
  }
  function edit() {
    if (blocked || !snapshot) return
    setDraft(fields ? structuredClone(fields) : initialState()); setConflict(null); setSimulation(null)
    tool.setDirty(!fields); tool.setError(null); tool.setNotice(null)
  }
  function closeEditor() {
    if (tool.locked) return
    if (tool.hasChanges()) setDiscardEditor(true)
    else { setDraft(null); setConflict(null) }
  }
  async function compare() {
    if (tool.locked || !draft || syncRef.current) return
    await tool.read(() => api.getRealm({ bookId }), (value) => {
      if (!isRealmSnapshot(value, bookId) || value.bookRevision < bookRef.current.book.revision || value.bookRevision < (snapshotRef.current?.bookRevision ?? 0)) throw new Error('Stale realm comparison')
      if (value.revision === snapshotRef.current?.revision && value.bookRevision === snapshotRef.current.bookRevision) {
        setConflict(null); tool.setNotice('基线与最新记录一致，当前输入保留。')
      } else setConflict(value)
    })
  }
  async function continueOnLatest() {
    if (!draft || !conflict || tool.locked || syncRef.current) return
    const expected = conflict
    await tool.read(async () => {
      const catalog = await api.getBook({ bookId })
      if (!catalog.ok) return catalog
      const result = await api.getRealm({ bookId })
      if (!result.ok) return result
      if (catalog.data.book.id !== bookId || !isRealmSnapshot(result.data, bookId) ||
        result.data.bookRevision !== catalog.data.book.revision || result.data.bookRevision !== expected.bookRevision ||
        result.data.revision !== expected.revision) return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '最新版本再次变化，请重新核对。' } }
      return { ok: true as const, data: { catalog: catalog.data, realm: result.data } }
    }, ({ catalog, realm }) => {
      if (realm.bookRevision < bookRef.current.book.revision) throw new Error('Stale realm rebase')
      // 作者明确选择保留本地输入后才推进写入基线，不自动拼接两份余额。
      receive(realm); onBookChange(catalog); setConflict(null); tool.setDirty(true); tool.setNotice('当前输入已保留，请核对后保存。')
    })
  }
  async function simulate() {
    if (blocked || !active || !fields || !snapshot || !breakthrough || insufficient) return
    const personId = active.id, baseline = snapshot, expected = realmBreakthrough(fields, personId)
    setSimulation(null); setSimulating(true)
    try {
      await tool.read(() => api.simulateRealm({ bookId, expectedBookRevision: baseline.bookRevision, expectedRevision: baseline.revision, personId }), (value) => {
        if (value.bookId !== bookId || value.bookRevision !== baseline.bookRevision || bookRef.current.book.revision !== baseline.bookRevision ||
          value.revision !== baseline.revision || value.personId !== personId || value.fromId !== expected.fromId || value.toId !== expected.toId ||
          value.projectedPower !== expected.projectedPower || value.ready !== expected.ready || JSON.stringify(value.checks) !== JSON.stringify(expected.checks)) throw new Error('Mismatched realm simulation')
        setSimulation(value)
      })
    } finally { setSimulating(false) }
  }
  function toggle(person: KnowledgeItemSummary) {
    setKnown((current) => [...current.filter((item) => item.id !== person.id), person])
    setSelected((current) => current.includes(person.id) ? current.filter((id) => id !== person.id) : current.length < 3 ? [...current, person.id] : current)
    setFocus(person.id); setSimulation(null)
  }
  const modal = (title: string, content: ReactNode, close: () => void, wide = false) =>
    <DialogDisplayContext.Provider value="modal"><Dialog title={title} busy={tool.busy} onClose={close} wide={wide}><div className={styles.panel}>{content}</div></Dialog></DialogDisplayContext.Provider>
  return <Dialog title="境界与战力" onClose={onClose} busy={tool.busy} wide className={styles.page} toolbar={<div className={styles.toolbar}>
    <button className={styles.iconButton} type="button" title="重新读取" aria-label="重新读取境界与战力" disabled={tool.locked || tool.dirty} onClick={() => void reload()}><StudioIcon name="refresh" size={20} /></button>
    <button className={styles.iconButton} type="button" title="选择对比人物" aria-label="选择对比人物" disabled={tool.locked || Boolean(draft) || syncRequired || stale || !snapshot || snapshot.schemaVersion < 3} onClick={() => setPicker(true)}><StudioIcon name="users" size={20} /></button>
    <button className={styles.iconButton} type="button" title="境界与战力设定" aria-label="境界与战力设定" disabled={blocked} onClick={edit}><StudioIcon name="settings" size={20} /></button>
    <span>{archived ? '归档 · 只读' : '境界与战力'}</span>
  </div>}><div className={styles.panel}>
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
    {tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {tool.readFailure?.requestId && <button className={styles.button} type="button" disabled={tool.locked} onClick={() => void tool.checkReadReceipt()}>核对原读取请求</button>}
    {(stale || syncRequired) && <p className={styles.warning}>作品或境界基线需要同步。<button className={styles.button} type="button" disabled={tool.locked || tool.dirty} onClick={() => void reload()}>重新读取作品与境界</button></p>}
    {!snapshot && <p className={styles.note} role="status">{tool.busy ? '正在读取境界与人物…' : '资料尚未读取，可重新读取。'}</p>}
    {snapshot?.requiresUpgrade && <section className={styles.upgrade}><h3>启用境界与战力</h3><p>本书格式 v{snapshot.schemaVersion}，启用前须建立并核对独立备份，再升级至 v{REALM_SCHEMA_VERSION}。</p>
      <label className={styles.check}><input type="checkbox" checked={upgradeConfirmed} disabled={tool.locked || archived} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />同意先备份，再升级本书</label>
      <button className={styles.button} type="button" disabled={tool.locked || archived || !upgradeConfirmed} onClick={() => void upgrade()}>备份并启用</button></section>}
    {snapshot && !snapshot.requiresUpgrade && !fields && <div className={styles.setup}><button className={styles.button} type="button" disabled={blocked} onClick={edit}><StudioIcon name="plus" size={20} />录入本书境界与战力</button></div>}
    {snapshot && <div className={styles.workspace}>
      <aside className={styles.ladder}><h3>境界阶梯 <StudioIcon name="spark" size={20} /></h3>
        {fields ? <ol>{[...fields.levels].reverse().map((level, index) => <li key={level.id} data-current={level.id === activeCharacter?.realmId} data-rank={index}>
          <span className={styles.realmMark} aria-hidden="true"><StudioIcon name="spark" size={40} /><StudioIcon name="star" size={24} /></span>
          <div><strong>{level.name}</strong>{level.id === activeCharacter?.realmId && <span className={styles.current}>当前</span>}<p>{level.description}</p>
            <small>{level.conditions.length ? level.conditions.map((item) => item.kind === 'quantity' ? `${item.name} ${item.required.toLocaleString()}` : item.name).join(' · ') : '突破条件未登记'}</small></div>
        </li>)}</ol> : <p className={styles.note}>尚未登记五级境界</p>}
        <div className={styles.ladderScene} aria-hidden="true"><StudioIcon name="city" size={96} /></div>
      </aside>
      <section className={styles.comparison}><h3>人物战力对比 <StudioIcon name="spark" size={20} /><button type="button" className={styles.iconButton} disabled={tool.locked || Boolean(draft) || syncRequired || stale || snapshot.schemaVersion < 3} aria-label="选择最多三位人物" title="选择人物" onClick={() => setPicker(true)}><StudioIcon name="users" size={20} /></button></h3>
        <div className={styles.comparisons}>{characters.map((person) => {
          const combat = fields?.characters.find((item) => item.personId === person.id), level = fields?.levels.find((item) => item.id === combat?.realmId)
          return <article key={person.id} className={styles.character} data-active={active?.id === person.id}>
            <button type="button" className={styles.identity} disabled={tool.locked || Boolean(draft)} aria-pressed={active?.id === person.id} onClick={() => { setFocus(person.id); setSimulation(null) }}>
              <SavedPortrait api={api} bookId={bookId} personId={person.id} metadata={portraits.items.find((item) => item.personId === person.id)} name={person.name} className={styles.portrait}
                fallback={<span className={styles.portraitFallback}><StudioIcon name="user" size={72} /><small>{portraits.loading ? '立绘读取中' : '未载入立绘'}</small></span>} />
              <h4>{person.name}</h4><span className={styles.stage}>{level ? `${level.name}${combat?.stage || ''}` : '境界未知'}</span>
            </button>
            <dl className={styles.axes}>{COMBAT_AXES.map((axis) => {
              const value = combat?.abilities[axis]
              return <div key={axis} data-unknown={value === undefined}><dt><StudioIcon name={axisIcons[axis]} size={20} />{COMBAT_LABELS[axis]}</dt>
                <dd><span className={styles.bar} role={value === undefined ? 'img' : 'meter'} aria-label={`${person.name}的${COMBAT_LABELS[axis]}${value === undefined ? '未知' : ''}`}
                  aria-valuemin={value === undefined ? undefined : 0} aria-valuemax={value === undefined ? undefined : 100} aria-valuenow={value}><i style={{ width: `${value ?? 0}%` }} /></span><span>{value ?? '未知'}</span></dd></div>
            })}</dl>
            <div className={styles.power}><span>总战力</span><strong data-long={(combat?.totalPower?.toLocaleString().length ?? 0) > 9}>{combat?.totalPower?.toLocaleString() ?? '未知'}</strong></div>
            <button type="button" className={styles.profileButton} disabled={tool.locked || Boolean(draft)} onClick={() => onOpen(person.id)} title="查看人物原始档案">人物档案<StudioIcon name="chevron" size={16} /></button>
          </article>
        })}</div>
        {!characters.length && <div className={styles.empty}><StudioIcon name="user" size={32} /><h4>尚未选择人物</h4><button className={styles.button} type="button" disabled={tool.locked || snapshot.schemaVersion < 3} onClick={() => setPicker(true)}>选择人物</button><button className={styles.button} type="button" disabled={tool.locked} onClick={() => onOpen()}>建立人物档案</button></div>}
      </section>
      <aside className={styles.conditions}><h3>突破条件 <StudioIcon name="spark" size={20} /></h3>
        {active && <div className={styles.target}><span>{active.name}</span><small>{breakthrough ? `下一阶 · ${fields?.levels.find((level) => level.id === breakthrough.toId)?.name}` : '未能确定下一境界'}</small></div>}
        {breakthrough && <ul>{breakthrough.checks.map((item) => <li key={item.id} data-met={item.met} data-unknown={item.available === null}>
          <StudioIcon name={item.kind === 'milestone' ? 'notes' : item.consume ? 'crystal' : 'spark'} size={40} /><div><strong>{item.name}</strong><span>{item.kind === 'milestone' ? item.available === null ? '未知' : item.met ? '已完成' : '未完成'
            : `${item.available?.toLocaleString() ?? '未知'} / ${item.required.toLocaleString()}`}</span>{item.consume && <small>突破时扣减</small>}</div>
          <span className={styles.conditionStatus} aria-label={item.met ? '已满足' : item.available === null ? '未知' : '不足'}><StudioIcon name={item.met ? 'check' : item.available === null ? 'info' : 'minus'} size={20} /></span>
        </li>)}</ul>}
        {simulating && <div className={styles.simulationProgress} role="status"><span>正在核对突破条件…</span><progress aria-label="突破推演进行中" /></div>}
        <div className={styles.simulationAction}><button type="button" className={styles.primaryButton} disabled={blocked || Boolean(unavailable) || insufficient} title={unavailable ?? (insufficient ? '条件不足或含未知项' : '推演下一境界')} onClick={() => void simulate()}><StudioIcon name="spark" size={28} />推演突破</button>
          {(unavailable || insufficient) && <p className={styles.note}>{unavailable ?? '条件不足或含未知项，请先核对设定。'}</p>}</div>
      </aside>
      <aside className={styles.balance} data-warning={stronger.length > 0}><StudioIcon name={stronger.length ? 'warning' : 'info'} size={32} /><div><h3>战力平衡提醒</h3>
        {!protagonist ? <p>尚未指定主角</p> : protagonist.totalPower === null ? <p>{protagonistName}的总战力未知，暂不能计算差距。</p> : stronger.length ? stronger.map((person) => <p key={person.id}>{person.name}高于{protagonistName}{person.difference === null ? `，当前战力 ${person.power.toLocaleString()}` : ` ${person.difference.toFixed(1)}%`}。</p>)
          : <p>{characters.some((person) => fields?.characters.find((item) => item.personId === person.id)?.totalPower == null) ? '对比人物含未知战力，提醒尚不完整。' : characters.some((person) => person.id !== protagonist.personId) ? '当前已知数值中，没有对比人物高于主角。' : '选择其他人物后核对战力差距。'}</p>}</div>
        <button type="button" className={styles.iconButton} title="前往章节规划" aria-label="前往章节规划" disabled={tool.locked || Boolean(draft)} onClick={onPlan}><StudioIcon name="chevron" size={20} /></button>
      </aside>
    </div>}
    {portraits.error && <p className={styles.note} role="status">立绘资料读取失败：{portraits.error}</p>}
    {active && known.find((person) => person.id === active.id)?.characterProfile && <details className={styles.legacy}><summary>{active.name} · 原始人物六维与成长档案</summary><CharacterProfileView profile={known.find((person) => person.id === active.id)?.characterProfile} /></details>}
    {picker && !leave.confirming && modal('选择对比人物', <><RealmPersonPicker api={api} book={book} selected={selected} maximum={3} disabled={tool.locked} onPick={toggle} />
      <div className={styles.selectedPeople}>{characters.map((person) => <button className={styles.button} key={person.id} type="button" disabled={tool.locked} onClick={() => { setSelected((current) => current.filter((id) => id !== person.id)); setSimulation(null) }}>{person.name}<StudioIcon name="close" size={16} /></button>)}</div>
      <button className={styles.button} type="button" disabled={tool.locked} onClick={() => setPicker(false)}>完成</button></>, () => setPicker(false))}
    {draft && !discardEditor && !tool.pending && !leave.confirming && modal('境界与战力设定', <RealmEditor api={api} book={book} fields={draft} people={[...people.values()]} disabled={tool.locked} error={tool.error} notice={tool.notice}
      onPerson={(person) => setKnown((current) => [...current.filter((item) => item.id !== person.id), person])}
      onChange={(value) => { setDraft(value); tool.setDirty(true); setSimulation(null) }} onSave={() => void mutate({ kind: 'configure', fields: draft })} onCancel={closeEditor}
      onCompare={() => void compare()} conflict={conflict} onContinue={() => void continueOnLatest()} onUseLatest={() => {
        if (!conflict || tool.locked) return
        receive(conflict); setDraft(null); setConflict(null); tool.setDirty(false); requireSync(); void reload()
      }} />, closeEditor, true)}
    {discardEditor && !tool.pending && !leave.confirming && modal('返回境界与战力？', <><p>设定有未保存修改。</p><div className={styles.actions}>
      <button className={styles.button} type="button" onClick={() => setDiscardEditor(false)}>继续编辑</button><button className={styles.button} type="button" onClick={() => { setDraft(null); setConflict(null); setDiscardEditor(false); tool.setDirty(false) }}>放弃修改并返回</button>
    </div></>, () => setDiscardEditor(false))}
    {validSimulation && !tool.pending && !leave.confirming && modal('突破推演', <div className={styles.simulationResult}>
      <h3>{people.get(validSimulation.personId)?.name} · {fields?.levels.find((level) => level.id === validSimulation.fromId)?.name} → {fields?.levels.find((level) => level.id === validSimulation.toId)?.name}</h3>
      <p>全部 {validSimulation.checks.length} 项已登记条件满足。</p><p>突破后总战力：{validSimulation.projectedPower?.toLocaleString() ?? '未知'}</p>
      <ul>{validSimulation.checks.filter((item) => item.consume).map((item) => <li key={item.id}>{item.name}：{item.available?.toLocaleString()} → {(item.available! - item.required).toLocaleString()}</li>)}</ul>
      <p className={styles.note}>预期战力采用作者录入值；登记会清空当前小阶段和下一阶预期值，六维保持原记录。本屏资源独立于织星背包。</p>
      {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}<div className={styles.actions}><button className={styles.button} type="button" disabled={tool.locked} onClick={() => setSimulation(null)}>返回</button>
        <button className={styles.primaryButton} type="button" disabled={blocked || !validSimulation.ready} onClick={() => void mutate({ kind: 'breakthrough', personId: validSimulation.personId })}>确认登记突破</button></div>
    </div>, () => { if (!tool.locked) setSimulation(null) })}
    {(tool.pending || syncRequired) && <section className={styles.warning}><p>{tool.pending ? '写入结果尚未确认，请先核对原请求。' : '写入已确认，作品目录尚未同步。可重新读取或留存记录后进入恢复。'}</p>
      {tool.pending && <button className={styles.button} type="button" disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void tool.checkReceipt().then((ok) => { if (ok) void reload() })}>核对原写入</button>}
      <textarea aria-label="境界与战力恢复记录" readOnly rows={6} value={recoveryText} /><label className={styles.check}><input type="checkbox" checked={preserved === recoveryText} onChange={(event) => setPreserved(event.target.checked ? recoveryText : null)} />已留存当前输入与原操作编号</label>
      <button className={styles.button} type="button" disabled={tool.busy || preserved !== recoveryText} onClick={onRecover}>进入恢复</button></section>}
    {leave.confirming && modal('离开境界与战力？', <><p>境界设定有未保存修改。</p><div className={styles.actions}><button className={styles.button} type="button" onClick={leave.keepEditing}>{leave.source === 'window' ? '返回保存' : '继续编辑'}</button>
      <button className={styles.button} type="button" disabled={tool.locked} onClick={leave.discardAndLeave}>放弃修改并离开</button></div></>, leave.keepEditing)}
  </div></Dialog>
}
