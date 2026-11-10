import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { DomainError, type AppError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import {
  CALENDAR_KINDS, CALENDAR_SCHEMA_VERSION, MAX_CALENDAR_ENTRIES, MIN_CALENDAR_MONTH, MAX_CALENDAR_MONTH,
  calendarMonthDates, calendarStatistics, isCalendarSnapshot, parseCalendarEntryFields, parseCalendarMonth, parseSaveCalendarEntryInput,
  type CalendarEntry, type CalendarEntryFields, type CalendarSnapshot, type SaveCalendarEntryInput, type WritingCalendarApi,
} from '../../contracts/writing-calendar'
import { localDate, sameFields, useToolSession } from './workbench-ui'
import styles from './WritingCalendarPanel.module.css'

export interface WritingCalendarPanelProps {
  api: StudioApi & WritingCalendarApi
  book: BookSnapshot
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onBookChange: (book: BookSnapshot) => void
  onUnknown?: (error: AppError) => void
  onRecover?: () => void
}

const kindLabels: Record<CalendarEntryFields['kind'], string> = { writing: '写作计划', deadline: '截止日期', publication: '发布计划', idea: '灵感整理' }
const sourceLabels = { manual: '常规编辑 / 手工记录', ai: 'AI 采用', import: '导入', restore: '恢复' }
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
function adjacentMonth(month: string, offset: number): string {
  const date = new Date(`${month}-01T12:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + offset)
  return date.toISOString().slice(0, 7)
}
function monthLabel(month: string) { return `${Number(month.slice(0, 4))} 年 ${Number(month.slice(5))} 月` }
function signed(value: number) { return `${value > 0 ? '+' : ''}${value.toLocaleString()}` }

export function WritingCalendarPanel(props: WritingCalendarPanelProps) {
  return <CalendarContent key={props.book.book.id} {...props} />
}

function CalendarContent({ api, book, disabled, onDirtyChange, onBookChange, onUnknown, onRecover }: WritingCalendarPanelProps) {
  const bookId = book.book.id
  const prefix = useId()
  const [month, setMonth] = useState(() => localDate().slice(0, 7))
  const [selectedDate, setSelectedDate] = useState(localDate)
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null)
  const [draft, setDraft] = useState<SaveCalendarEntryInput | null>(null)
  const [discard, setDiscard] = useState(false)
  const [syncRequired, setSyncRequired] = useState(false)
  const [recoveryPreserved, setRecoveryPreserved] = useState(false)
  const [conflict, setConflict] = useState<CalendarSnapshot | null>(null)
  const syncRef = useRef(false)
  const monthRef = useRef(month)
  const snapshotRef = useRef(snapshot)
  const bookRevisionRef = useRef(book.book.revision)
  const needsRead = useRef(true)
  const editorRef = useRef<HTMLFormElement>(null)
  bookRevisionRef.current = book.book.revision
  const tool = useToolSession({ api, disabled, onDirtyChange, onUnknown, isProtected: () => syncRef.current })
  const today = localDate()
  const dates = useMemo(() => calendarMonthDates(month), [month])
  const leading = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7
  const readonly = Boolean(book.book.archivedAt || snapshot?.archived)
  const externalChange = Boolean(snapshot && book.book.revision > snapshot.bookRevision)
  const blocked = tool.locked || syncRequired || readonly || externalChange || !snapshot || snapshot.requiresUpgrade || snapshot.month !== month
  const navigationBlocked = tool.locked || tool.dirty || syncRequired
  const days = useMemo(() => new Map(dates.map((date) => {
    const events = snapshot?.events.filter((item) => item.date === date) ?? []
    const activity = snapshot?.activity.filter((item) => item.date === date) ?? []
    return [date, { events, activity, statistics: calendarStatistics(events, activity, today) }]
  })), [dates, snapshot, today])
  const selected = days.get(selectedDate)
  const statistics = snapshot ? calendarStatistics(snapshot.events, snapshot.activity, today) : null
  const conflictEntry = conflict?.events.find((entry) => entry.id === draft?.id)

  function receive(value: CalendarSnapshot) { snapshotRef.current = value; setSnapshot(value) }
  useEffect(() => {
    if (!disabled && needsRead.current) { needsRead.current = false; void reload() }
  }, [disabled, month])
  useEffect(() => () => { needsRead.current = true }, [])
  useEffect(() => {
    if (draft) { editorRef.current?.scrollIntoView({ block: 'nearest' }); editorRef.current?.focus({ preventScroll: true }) }
  }, [draft?.id])
  useEffect(() => { setRecoveryPreserved(false) }, [tool.pending])

  async function reload() {
    if (tool.hasChanges() || tool.hasPending()) { tool.setError('请先处理当前输入或核对原请求，再刷新日历。'); return }
    const requestedMonth = monthRef.current
    await tool.read(async () => {
      const catalog = await api.getBook({ bookId })
      if (!catalog.ok) return catalog
      const calendar = await api.getWritingCalendar({ bookId, month: requestedMonth })
      if (!calendar.ok) return calendar
      if (!isCalendarSnapshot(calendar.data, bookId, requestedMonth) || catalog.data.book.id !== bookId || calendar.data.bookRevision !== catalog.data.book.revision) {
        return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '读取期间作品发生变化，请再次刷新日历。' } }
      }
      return { ok: true as const, data: { catalog: catalog.data, calendar: calendar.data } }
    }, ({ catalog, calendar }) => {
      // 月份、作品版本或表单发生变化时，不接纳迟到结果。
      if (requestedMonth !== monthRef.current || tool.hasChanges() || tool.hasPending() || calendar.bookRevision < bookRevisionRef.current || calendar.bookRevision < (snapshotRef.current?.bookRevision ?? 0)) {
        tool.setError('读取结果已经过期，当前输入已保留，请重新读取。'); return
      }
      receive(calendar)
      onBookChange(catalog)
      syncRef.current = false; setSyncRequired(false)
      setDraft(null); setDiscard(false); setConflict(null)
    })
  }
  function canSwitch() {
    if (!tool.canLeave() || syncRef.current) { tool.setError('请先保存、放弃更改或核对原请求，再切换日期。'); return false }
    return true
  }
  function changeMonth(next: string, date?: string) {
    if (!canSwitch()) return
    try { parseCalendarMonth(next) } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '月份无效。'); return }
    setSelectedDate(date ?? (today.startsWith(next) ? today : `${next}-01`))
    setDraft(null); setConflict(null); setDiscard(false)
    if (next === monthRef.current) return
    monthRef.current = next
    snapshotRef.current = null; setSnapshot(null)
    needsRead.current = true; setMonth(next)
    tool.setError(null); tool.setNotice(null)
  }
  function selectDate(date: string) {
    if (date === selectedDate || !canSwitch()) return
    setSelectedDate(date); setDraft(null); setConflict(null); setDiscard(false)
    tool.setError(null)
  }
  function navigateDay(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1
      : event.key === 'ArrowDown' ? index + 7 : event.key === 'ArrowUp' ? index - 7
        : event.key === 'Home' ? Math.max(0, index - (index + leading) % 7)
          : event.key === 'End' ? Math.min(dates.length - 1, index + 6 - (index + leading) % 7) : null
    if (next === null) return
    event.preventDefault()
    if (next < 0 || next >= dates.length || !canSwitch()) return
    selectDate(dates[next])
    document.getElementById(`${prefix}-${dates[next]}`)?.focus()
  }
  function edit(item?: CalendarEntry) {
    if (blocked || !canSwitch() || !snapshot) return
    if (!item && snapshot.totalEntries >= MAX_CALENDAR_ENTRIES) { tool.setError('本书已达到 2,000 条日程上限，可继续编辑已有日程。'); return }
    setDraft({ bookId, expectedBookRevision: snapshot.bookRevision, id: item?.id ?? crypto.randomUUID(), expectedRevision: item?.revision ?? 0, month,
      fields: item ? parseCalendarEntryFields(item) : { date: selectedDate, title: '', kind: 'writing', notes: '', done: false, targetCharacters: null } })
    setConflict(null); setDiscard(false); tool.setDirty(!item); tool.setError(null); tool.setNotice(null)
  }
  function change(fields: Partial<CalendarEntryFields>) {
    if (!draft || tool.locked) return
    setDraft({ ...draft, fields: { ...draft.fields, ...fields } })
    setDiscard(false); tool.setDirty(true); tool.setNotice(null)
  }
  function dropDraft() {
    if (tool.locked) return
    if (tool.hasChanges() && !discard) { setDiscard(true); return }
    setDraft(null); setConflict(null); setDiscard(false); tool.setDirty(false); tool.setError(null)
  }
  function saved(value: CalendarSnapshot) {
    receive(value)
    setDraft(null); setConflict(null); setDiscard(false)
    syncRef.current = true; setSyncRequired(true)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || blocked || draft.expectedBookRevision !== snapshot?.bookRevision) return
    try {
      const input = parseSaveCalendarEntryInput(draft)
      const success = await tool.write('calendar.save', () => api.saveCalendarEntry(input), (value) => {
        const item = value?.savedEntry
        return isCalendarSnapshot(value, bookId, input.month) && !value.requiresUpgrade && !value.archived
          && value.bookRevision === input.expectedBookRevision + 1 && Boolean(item && item.id === input.id
            && item.revision === input.expectedRevision + 1 && sameFields(item, input.fields))
      }, saved, `日程已保存至 ${input.fields.date}。`)
      if (success) await reload()
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请检查日程内容后重试。') }
  }
  async function checkReceipt() { if (await tool.checkReceipt()) await reload() }
  async function compareLatest() {
    if (!draft || tool.locked || syncRef.current) return
    const intended = draft
    const requestedMonth = intended.month ?? monthRef.current
    await tool.read(() => api.getWritingCalendar({ bookId, month: requestedMonth }), (value) => {
      if (!isCalendarSnapshot(value, bookId, requestedMonth) || value.bookRevision < bookRevisionRef.current || value.bookRevision < intended.expectedBookRevision) throw new Error('Stale calendar')
      setConflict(value)
      tool.setNotice('已读取最新版本，当前输入仍保留。请比较后明确选择是否沿用输入。')
    })
  }
  function rebase() {
    if (!draft || !conflict || tool.locked || conflict.archived || conflict.requiresUpgrade || conflict.bookRevision < bookRevisionRef.current) return
    // 修改已有日程时必须在所查月份找到同一身份；跨月移动不能当成“条目已删除”并重建。
    if (draft.expectedRevision > 0 && !conflictEntry) { tool.setError('原日程可能已被改到其他月份，请留存输入后重新查找，不能覆盖未知的新版本。'); return }
    setDraft({ ...draft, expectedBookRevision: conflict.bookRevision, expectedRevision: conflictEntry?.revision ?? 0, month: conflict.month })
    monthRef.current = conflict.month; setMonth(conflict.month); needsRead.current = false
    setSelectedDate(conflictEntry?.date ?? (draft.fields.date.startsWith(conflict.month) ? draft.fields.date : `${conflict.month}-01`)); receive(conflict)
    setConflict(null); tool.setDirty(true); tool.setError(null); tool.setNotice('已明确沿用当前输入，请再次检查并保存。')
  }
  async function upgrade() {
    if (!snapshot || readonly || !canSwitch()) return
    const expectedBookRevision = snapshot.bookRevision
    const success = await tool.write('knowledge.upgrade', () => api.upgradeKnowledge({ bookId, expectedBookRevision }),
      (value) => value.bookId === bookId && value.schemaVersion >= CALENDAR_SCHEMA_VERSION && !value.requiresUpgrade && value.bookRevision >= expectedBookRevision,
      () => { syncRef.current = true; setSyncRequired(true) }, '作品备份和升级已确认。')
    if (success) await reload()
  }

  return <section className={styles.panel} aria-label="创作日历">
    <header className={styles.heading}><div><h3>创作日历</h3><p className={styles.muted}>安排写作、截止日期与发布计划。日程由你完成标记，不会自动投稿或发送外部提醒。</p></div>
      <button type="button" className={styles.button} disabled={tool.locked || tool.dirty} onClick={() => void reload()}>{syncRequired ? '重试同步' : '刷新日历'}</button></header>
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
    {tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {tool.pending && <div className={styles.warning}><p>保存结果尚未确认，当前输入已保留。核对原请求前暂停提交。</p>
      {tool.pending.error.requestId ? <button type="button" className={styles.button} disabled={tool.busy} onClick={() => void checkReceipt()}>核对原请求</button>
        : <p>缺少可查询的请求编号，请保留输入并通过主窗口恢复。</p>}
      {onRecover && <><label className={styles.check}><input type="checkbox" checked={recoveryPreserved} onChange={(event) => setRecoveryPreserved(event.target.checked)} />我已留存输入，可以离开本面板进行恢复</label>
        <button type="button" className={styles.button} disabled={tool.busy || !recoveryPreserved} onClick={onRecover}>打开主窗口恢复</button></>}
    </div>}
    {draft && <details className={styles.details}><summary>查看并复制当前日程内容</summary><textarea readOnly rows={8} aria-label="当前输入及版本信息" value={JSON.stringify(draft, null, 2)} /></details>}
    {syncRequired && <p className={styles.warning} role="status">写入已经确认，正在等待作品目录同步；同步失败时可点“重试同步”。</p>}
    {externalChange && <p className={styles.warning}>作品已有新版本，当前输入仍保留。可读取最新日程作比较，或处理输入后刷新。</p>}
    {readonly && <p className={styles.warning}>作品已归档，日历仅供查看。</p>}
    <nav className={styles.monthNav} aria-label="选择月份">
      <button type="button" className={styles.button} disabled={navigationBlocked || month === MIN_CALENDAR_MONTH} onClick={() => changeMonth(adjacentMonth(month, -1))}>上一月</button>
      <label>月份<input type="month" min={MIN_CALENDAR_MONTH} max={MAX_CALENDAR_MONTH} value={month} disabled={navigationBlocked} onChange={(event) => changeMonth(event.target.value)} /></label>
      <button type="button" className={styles.button} disabled={navigationBlocked || month === MAX_CALENDAR_MONTH} onClick={() => changeMonth(adjacentMonth(month, 1))}>下一月</button>
      <button type="button" className={styles.button} disabled={navigationBlocked} onClick={() => changeMonth(today.slice(0, 7), today)}>今天</button>
    </nav>
    {!snapshot ? <p className={styles.empty} role="status">{tool.busy ? '正在读取本月日程与写作记录…' : '尚未取得本月日历，请点击“刷新日历”重试。'}</p>
      : snapshot.requiresUpgrade ? <div className={styles.empty}><h4>启用这部作品的创作日历</h4><p>备份并升级作品后，即可保存日程和查看月度写作记录。</p>
        <button type="button" className={styles.primaryButton} disabled={tool.locked || readonly} onClick={() => void upgrade()}>备份并升级作品</button></div>
        : <>
          <p className={styles.monthSummary} role="status">{monthLabel(month)} · {statistics?.scheduled} 条日程，已完成 {statistics?.completed} 条，逾期 {statistics?.overdue} 条</p>
          <div className={styles.layout}>
            <div className={styles.calendar}>
              <div className={styles.weekdays} aria-hidden="true">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
              <div className={styles.grid} role="group" aria-label={`${monthLabel(month)}，方向键选择日期`}>
                {Array.from({ length: leading }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}
                {dates.map((date, index) => {
                  const day = days.get(date)!
                  const due = day.events.some((entry) => entry.kind === 'deadline' && !entry.done)
                  return <button key={date} id={`${prefix}-${date}`} type="button" className={styles.day} data-selected={date === selectedDate} data-today={date === today}
                    tabIndex={date === selectedDate ? 0 : -1} aria-pressed={date === selectedDate} aria-current={date === today ? 'date' : undefined}
                    aria-label={`${date}，${day.events.length} 条日程${due ? '，有待完成截止日程' : ''}，计划 ${day.statistics.plannedCharacters} 字，净增 ${day.statistics.net} 字`}
                    disabled={navigationBlocked} onClick={() => selectDate(date)} onKeyDown={(event) => navigateDay(event, index)}>
                    <span className={styles.dayNumber}>{Number(date.slice(8))}{date === today && <span className={styles.today}>今</span>}</span>
                    <span className={styles.dayEvents}>{day.events.length ? `${day.events.length} 项${due ? ' · 截止' : ''}` : '—'}</span>
                    {day.activity.length > 0 && <span className={styles.dayCount}>{signed(day.statistics.net)} 字</span>}
                  </button>
                })}
              </div>
              <p className={styles.muted}>本月计划 {statistics?.plannedCharacters.toLocaleString()} 字 · 实际净增 {signed(statistics?.net ?? 0)} 字</p>
              <p className={styles.muted}>字数取自保存记录；计划完成标记不增加实际字数。全书日程 {snapshot.totalEntries.toLocaleString()} / 2,000 条。</p>
            </div>
            <section className={styles.dayDetails} aria-label={`${selectedDate} 日程和记录`}>
              <div className={styles.heading}><h4><time dateTime={selectedDate}>{selectedDate}</time></h4>
                <button type="button" className={styles.primaryButton} disabled={blocked || tool.dirty || snapshot.totalEntries >= MAX_CALENDAR_ENTRIES} onClick={() => edit()}>添加日程</button></div>
              <p className={styles.daySummary}>计划 {selected?.statistics.plannedCharacters.toLocaleString() ?? 0} 字 · 净增 {signed(selected?.statistics.net ?? 0)} 字 · 记录 {selected?.statistics.minutes ?? 0} 分钟</p>
              {!selected?.events.length ? <p className={styles.empty}>这天还没有日程。可以添加写作目标、截止日期或发布计划。</p>
                : <ul className={styles.events}>{selected.events.map((item) => <li key={item.id}>
                  <div className={styles.eventHeading}><strong>{item.title}</strong><span className={styles.state} data-overdue={!item.done && item.date < today}>{item.done ? '已完成' : item.date < today ? '逾期未完成' : '待完成'}</span></div>
                  <p className={styles.muted}>{kindLabels[item.kind]}{item.targetCharacters !== null && item.targetCharacters !== undefined ? ` · 计划 ${item.targetCharacters.toLocaleString()} 字` : ''}</p>
                  {item.notes && <p className={styles.notes}>{item.notes}</p>}
                  <button type="button" className={styles.button} disabled={blocked || tool.dirty} onClick={() => edit(item)}>编辑 / 标记完成</button>
                </li>)}</ul>}
              <h4 className={styles.activityHeading}>当天写作记录</h4>
              {!selected?.activity.length ? <p className={styles.muted}>这天没有已保存的写作记录。</p> : <ul className={styles.activity}>{selected.activity.map((day) => <li key={day.source}>
                <strong>{sourceLabels[day.source]}</strong><span>新增 {day.added.toLocaleString()} · 删除 {day.removed.toLocaleString()} · 净增 {signed(day.net)} 字</span>
                <span>{day.minutes} 分钟 · 改稿 {day.revisedChapters} 章</span>
              </li>)}</ul>}
            </section>
          </div>
        </>}
    {draft && <form ref={editorRef} className={styles.editor} tabIndex={-1} onSubmit={(event) => void save(event)} aria-label="编辑日程">
      <h4>{draft.expectedRevision ? '编辑日程' : '新建日程'}</h4>
      <fieldset disabled={tool.locked || syncRequired || readonly} className={styles.fields}>
        <label>日程标题<input required maxLength={160} value={draft.fields.title} onChange={(event) => change({ title: event.target.value })} /></label>
        <div className={styles.fieldGrid}><label>日期<input type="date" required min={`${MIN_CALENDAR_MONTH}-01`} max={`${MAX_CALENDAR_MONTH}-31`} value={draft.fields.date} onChange={(event) => change({ date: event.target.value })} /></label>
          <label>类型<select value={draft.fields.kind} onChange={(event) => change({ kind: event.target.value as CalendarEntryFields['kind'] })}>{CALENDAR_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label></div>
        <label>计划字数（可选）<input type="number" min={0} max={1_000_000} step={1} value={draft.fields.targetCharacters ?? ''} onChange={(event) => change({ targetCharacters: event.target.value === '' ? null : event.target.valueAsNumber })} /></label>
        <label>备注（可选）<textarea rows={4} maxLength={4_000} value={draft.fields.notes} onChange={(event) => change({ notes: event.target.value })} /></label>
        <label className={styles.check}><input type="checkbox" checked={draft.fields.done} onChange={(event) => change({ done: event.target.checked })} />我已完成这项日程</label>
        {draft.fields.date < today && !draft.fields.done && <p className={styles.muted}>日期已过，保存后会显示为逾期未完成；仍可补记或调整日期。</p>}
      </fieldset>
      <div className={styles.actions}><button type="submit" className={styles.primaryButton} disabled={blocked || draft.expectedBookRevision !== snapshot?.bookRevision}>{tool.busy ? '处理中…' : '保存日程'}</button>
        <button type="button" className={styles.button} disabled={tool.locked} onClick={dropDraft}>{discard ? '确认放弃当前更改' : tool.dirty ? '放弃更改' : '关闭编辑'}</button>
        <button type="button" className={styles.button} disabled={tool.locked || syncRequired || !/^\d{4}-\d{2}-\d{2}$/.test(draft.fields.date)} onClick={() => void compareLatest()}>保留输入，读取最新版本</button></div>
      {conflict && <div className={styles.comparison}><h4>最新已保存版本</h4>
        {conflictEntry ? <><p><strong>{conflictEntry.title}</strong> · {conflictEntry.date} · {kindLabels[conflictEntry.kind]} · {conflictEntry.done ? '已完成' : '待完成'}</p><p>计划字数：{conflictEntry.targetCharacters ?? '未设定'}</p><p className={styles.notes}>{conflictEntry.notes || '无备注'}</p></>
          : <p>{draft.expectedRevision > 0 ? '所查月份找不到这条日程，它可能已被改期。请先留存输入，再到其他月份查找。' : '所查月份没有同一标识的日程。'}</p>}
        <button type="button" className={styles.button} disabled={tool.locked || conflict.archived || conflict.requiresUpgrade || conflict.bookRevision < bookRevisionRef.current || (draft.expectedRevision > 0 && !conflictEntry)} onClick={rebase}>我已比较，沿用当前输入</button>
      </div>}
    </form>}
  </section>
}
