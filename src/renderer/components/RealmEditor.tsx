import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { BookSnapshot, StudioApi } from '../../contracts/api'
import type { KnowledgeItemPage, KnowledgeItemSummary } from '../../contracts/knowledge'
import { COMBAT_AXES, COMBAT_LABELS, MAX_REALM_VALUE, realmAvailable, type CombatCharacter, type RealmCondition, type RealmSnapshot, type RealmState } from '../../contracts/realm'
import { request } from '../request'
import { StudioIcon } from './StudioIcon'
import styles from './StellarCharacters.module.css'

export function RealmPersonPicker({ api, book, selected, maximum, disabled, onPick }: {
  api: StudioApi; book: BookSnapshot; selected: string[]; maximum: number; disabled: boolean; onPick: (person: KnowledgeItemSummary) => void
}) {
  const [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState<KnowledgeItemPage | null>(null)
  const [error, setError] = useState<string | null>(null), [reading, setReading] = useState(false)
  function findPeople() { if (!disabled && !reading) { setSearch(query.trim()); setOffset(0); setRefresh((value) => value + 1) } }
  useEffect(() => {
    if (disabled) return
    let active = true
    setPage(null); setReading(true); setError(null)
    void request(() => api.listKnowledgeItems({ bookId: book.book.id, kind: 'person', limit: 30, offset, search })).then((result) => {
      if (!active) return
      setReading(false)
      if (!result.ok) { setError(result.error.message); return }
      if (result.data.bookId !== book.book.id || result.data.bookRevision !== book.book.revision ||
        !Array.isArray(result.data.items) || result.data.items.some((item) => item.bookId !== book.book.id || item.kind !== 'person')) {
        setError('人物列表与当前作品版本不符，请先重新读取作品。'); return
      }
      setPage(result.data)
    })
    return () => { active = false }
  }, [api, book.book.id, book.book.revision, offset, search, refresh, disabled])
  return <section className={styles.picker}>
    <div className={styles.search} role="search">
      <input type="search" aria-label="查找人物" maxLength={200} value={query} disabled={disabled || reading} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); findPeople() } }} />
      <button className={styles.iconButton} type="button" disabled={disabled || reading} onClick={findPeople} aria-label="查找或刷新人物" title="查找或刷新人物"><StudioIcon name="search" size={20} /></button>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {reading && <p className={styles.note} role="status">正在读取人物…</p>}
    {page && <><ul className={styles.people}>{page.items.map((person) => <li key={person.id}><label className={styles.check}>
      <input type="checkbox" checked={selected.includes(person.id)} disabled={disabled || !selected.includes(person.id) && selected.length >= maximum} onChange={() => onPick(person)} />
      <span><strong>{person.name}</strong><small>{person.aliases.join(' · ') || '未登记别名'}</small></span>
    </label></li>)}</ul>
      {!page.items.length && <p className={styles.note}>没有匹配的人物</p>}
      <div className={styles.actions}><button className={styles.button} type="button" disabled={disabled || reading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</button>
        <button className={styles.button} type="button" disabled={disabled || reading || page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>下一页</button>
        <small>共 {page.total} 位 · 已选 {selected.length} / {maximum}</small></div></>}
  </section>
}
export function emptyCombatCharacter(personId: string): CombatCharacter {
  return { personId, realmId: null, stage: '', abilities: {}, totalPower: null, projectedPower: null, progress: [] }
}
export function RealmEditor({ api, book, fields, people, disabled, error, notice, onPerson, onChange, onSave, onCancel, onCompare, conflict, onContinue, onUseLatest }: {
  api: StudioApi; book: BookSnapshot; fields: RealmState; people: { id: string; name: string }[]; disabled: boolean; error: string | null; notice: string | null
  onChange: (fields: RealmState) => void; onSave: () => void; onCancel: () => void; onCompare: () => void
  onPerson: (person: KnowledgeItemSummary) => void
  conflict: RealmSnapshot | null; onContinue: () => void; onUseLatest: () => void
}) {
  const [activeId, setActiveId] = useState(fields.characters[0]?.personId ?? '')
  const names = useRef(new Map(people.map((person) => [person.id, person.name])))
  for (const person of people) names.current.set(person.id, person.name)
  const active = fields.characters.find((person) => person.personId === activeId) ?? fields.characters[0]
  function changeCharacter(patch: Partial<CombatCharacter>) {
    if (active) onChange({ ...fields, characters: fields.characters.map((item) => item.personId === active.personId ? { ...item, ...patch } : item) })
  }
  function progress(conditionId: string, value: number | null) {
    if (!active) return
    const conditions = fields.levels.flatMap((level) => level.conditions), target = conditions.find((item) => item.id === conditionId)
    const matching = target?.kind === 'quantity' ? conditions.filter((item) => item.kind === 'quantity' && item.name === target.name).map((item) => item.id) : [conditionId]
    changeCharacter({ progress: [...active.progress.filter((item) => !matching.includes(item.conditionId)), ...matching.map((id) => ({ conditionId: id, value }))] })
  }
  function condition(levelId: string, next: RealmCondition) {
    onChange({ ...fields, levels: fields.levels.map((level) => level.id === levelId ? { ...level, conditions: level.conditions.map((item) => item.id === next.id ? next : item) } : level) })
  }
  function submit(event: FormEvent) { event.preventDefault(); onSave() }
  return <form className={styles.editor} onSubmit={submit}>
    <fieldset disabled={disabled}>
      <section className={styles.settingsSection}><h3>境界阶梯 · 从低到高</h3>
        {fields.levels.map((level, index) => <details key={level.id} className={styles.levelEditor} open={index === 0}>
          <summary>第 {index + 1} 级 · {level.name || '未命名境界'}</summary>
          <div className={styles.fieldGrid}><label>境界名称<input required maxLength={40} value={level.name} onChange={(event) => onChange({ ...fields, levels: fields.levels.map((item) => item.id === level.id ? { ...item, name: event.target.value } : item) })} /></label>
            <label>境界说明<input maxLength={500} value={level.description} onChange={(event) => onChange({ ...fields, levels: fields.levels.map((item) => item.id === level.id ? { ...item, description: event.target.value } : item) })} /></label></div>
          <h4>进入此境界的条件</h4>
          {level.conditions.map((item) => <div className={styles.conditionEditor} key={item.id}>
            <label>{item.kind === 'milestone' ? '里程碑' : '资源名称'}<input required maxLength={120} value={item.name} onChange={(event) => condition(level.id, { ...item, name: event.target.value })} /></label>
            {item.kind === 'quantity' && <><label>所需数量<input type="number" required min={1} max={MAX_REALM_VALUE} step={1} value={item.required} onChange={(event) => { if (Number.isSafeInteger(event.target.valueAsNumber)) condition(level.id, { ...item, required: event.target.valueAsNumber }) }} /></label>
              <label className={styles.check}><input type="checkbox" checked={item.consume} onChange={(event) => condition(level.id, { ...item, consume: event.target.checked })} />突破时扣减</label></>}
            <button type="button" className={styles.iconButton} aria-label={`移除条件${item.name}`} title="移除条件及对应进度" onClick={() => onChange({ ...fields,
              levels: fields.levels.map((value) => value.id === level.id ? { ...value, conditions: value.conditions.filter((entry) => entry.id !== item.id) } : value),
              characters: fields.characters.map((character) => ({ ...character, progress: character.progress.filter((entry) => entry.conditionId !== item.id) })) })}><StudioIcon name="minus" size={20} /></button>
          </div>)}
          <div className={styles.actions}>{(['quantity', 'milestone'] as const).map((kind) => <button className={styles.button} type="button" key={kind} disabled={disabled || level.conditions.length >= 12}
            onClick={() => onChange({ ...fields, levels: fields.levels.map((item) => item.id === level.id ? { ...item, conditions: [...item.conditions, { id: crypto.randomUUID(), name: '', kind, required: 1, consume: false }] } : item) })}>
            <StudioIcon name="plus" size={20} />{kind === 'quantity' ? '数量条件' : '里程碑'}</button>)}</div>
        </details>)}
      </section>
      <section className={styles.settingsSection}><h3>人物战力</h3>
        <label>主角<select value={fields.protagonistId ?? ''} onChange={(event) => onChange({ ...fields, protagonistId: event.target.value || null })}><option value="">未指定</option>
          {fields.characters.map((person) => <option key={person.personId} value={person.personId}>{names.current.get(person.personId) ?? '未读取名称'}</option>)}</select></label>
        <details className={styles.levelEditor}><summary>添加或移除人物 · {fields.characters.length} / 200</summary>
          <RealmPersonPicker api={api} book={book} selected={fields.characters.map((person) => person.personId)} maximum={200} disabled={disabled} onPick={(person) => {
            names.current.set(person.id, person.name)
            onPerson(person)
            const included = fields.characters.some((item) => item.personId === person.id)
            onChange({ ...fields, protagonistId: included && fields.protagonistId === person.id ? null : fields.protagonistId,
              characters: included ? fields.characters.filter((item) => item.personId !== person.id) : [...fields.characters, emptyCombatCharacter(person.id)] })
            if (!included) setActiveId(person.id)
          }} />
        </details>
        {active && <><label>编辑人物<select value={active.personId} onChange={(event) => setActiveId(event.target.value)}>{fields.characters.map((person) => <option key={person.personId} value={person.personId}>{names.current.get(person.personId) ?? '未读取名称'}</option>)}</select></label>
          <div className={styles.fieldGrid}><label>当前境界<select value={active.realmId ?? ''} onChange={(event) => changeCharacter({ realmId: event.target.value || null, stage: '', projectedPower: null })}>
            <option value="">未知</option>{fields.levels.map((level, index) => <option key={level.id} value={level.id}>{level.name || `第 ${index + 1} 级`}</option>)}</select></label>
            <label>当前阶段<input maxLength={40} value={active.stage} onChange={(event) => changeCharacter({ stage: event.target.value })} /></label>
            <label>总战力<input type="number" min={0} max={MAX_REALM_VALUE} step={1} placeholder="未知" value={active.totalPower ?? ''} onChange={(event) => { if (event.target.value === '' || Number.isSafeInteger(event.target.valueAsNumber)) changeCharacter({ totalPower: event.target.value === '' ? null : event.target.valueAsNumber }) }} /></label>
            <label>下一阶预期总战力<input type="number" min={0} max={MAX_REALM_VALUE} step={1} placeholder="未知" value={active.projectedPower ?? ''} onChange={(event) => { if (event.target.value === '' || Number.isSafeInteger(event.target.valueAsNumber)) changeCharacter({ projectedPower: event.target.value === '' ? null : event.target.valueAsNumber }) }} /></label></div>
          <div className={styles.fieldGrid}>{COMBAT_AXES.map((axis) => <label key={axis}>{COMBAT_LABELS[axis]} · 0–100<input type="number" min={0} max={100} step={1} value={active.abilities[axis] ?? ''} placeholder="未知"
            onChange={(event) => { const abilities = { ...active.abilities }; if (event.target.value === '') delete abilities[axis]; else if (Number.isInteger(event.target.valueAsNumber)) abilities[axis] = event.target.valueAsNumber; else return; changeCharacter({ abilities }) }} /></label>)}</div>
          <h4>已登记资源与里程碑</h4><p className={styles.note}>同名数量条件共用该人物余额；突破时只扣减标记为消耗的资源。</p><div className={styles.fieldGrid}>{fields.levels.flatMap((level) => level.conditions.map((item) => {
            const value = realmAvailable(fields, active, item)
            return <label key={item.id}>{level.name || '未命名境界'} · {item.name || '未命名条件'}
              {item.kind === 'milestone' ? <select value={value === null ? '' : String(value)} onChange={(event) => progress(item.id, event.target.value === '' ? null : Number(event.target.value))}>
                <option value="">未知</option><option value="0">未完成</option><option value="1">已完成</option></select>
                : <input type="number" min={0} max={MAX_REALM_VALUE} step={1} placeholder="未知" value={value ?? ''} onChange={(event) => { if (event.target.value === '' || Number.isSafeInteger(event.target.valueAsNumber)) progress(item.id, event.target.value === '' ? null : event.target.valueAsNumber) }} />}
            </label>
          }))}</div></>}
      </section>
    </fieldset>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {conflict && <section className={styles.warning}><p>作品或境界版本已变化，当前输入保留。</p><details><summary>查看最新设定 · 境界版本 {conflict.revision}</summary><pre>{JSON.stringify(conflict.fields, null, 2)}</pre></details>
      <div className={styles.actions}><button className={styles.button} type="button" disabled={disabled} onClick={onContinue}>保留输入，以最新版本继续编辑</button><button className={styles.button} type="button" disabled={disabled} onClick={onUseLatest}>放弃输入并加载最新</button></div></section>}
    <div className={styles.actions}><button className={styles.primaryButton} type="submit" disabled={disabled || Boolean(conflict)}><StudioIcon name="save" size={20} />保存设定</button>
      <button className={styles.button} type="button" disabled={disabled} onClick={onCompare}>核对最新版本</button>
      <button className={styles.button} type="button" disabled={disabled} onClick={onCancel}>返回</button></div>
  </form>
}
