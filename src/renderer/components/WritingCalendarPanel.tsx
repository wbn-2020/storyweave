import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { DomainError, type AppError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import {
  CALENDAR_KINDS, CALENDAR_SCHEMA_VERSION, MAX_CALENDAR_ENTRIES, MIN_CALENDAR_MONTH, MAX_CALENDAR_MONTH,
  calendarMonthDates, calendarStatistics, isCalendarSnapshot, parseCalendarEntryFields, parseCalendarMonth, parseSaveCalendarEntryInput,
  type CalendarEntry, type CalendarEntryFields, type CalendarSnapshot, type SaveCalendarEntryInput, type WritingCalendarApi,
} from '../../contracts/writing-calendar'
import { localDate, sameFields, useToolSession } from './workbench-ui'
import { CalendarYearHeatmap } from './CalendarYearHeatmap'
import { StudioIcon } from './StudioIcon'
import styles from './StellarCalendar.module.css'

export interface WritingCalendarPanelProps {
  api: StudioApi & WritingCalendarApi
  book: BookSnapshot
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onBookChange: (book: BookSnapshot) => void
  onUnknown?: (error: AppError) => void
  onRecover?: () => void
  onClose: () => void
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

function CalendarContent({ api, book, disabled, onDirtyChange, onBookChange, onUnknown, onRecover, onClose }: WritingCalendarPanelProps) {
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
  const activeDates = new Set(snapshot?.activity.filter((item) => item.added > 0 || item.removed > 0).map((item) => item.date)).size
  const trendMaximum = Math.max(1, ...dates.map((date) => Math.abs(days.get(date)?.statistics.net ?? 0)))
  const sourceTotals = Object.entries(sourceLabels).map(([source, label]) => ({ source, label, added: snapshot?.activity.filter((item) => item.source === source).reduce((total, item) => total + item.added, 0) ?? 0 }))
  const totalAdded = sourceTotals.reduce((total, item) => total + item.added, 0)
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
  function closePanel() {
    if (!tool.canLeave() || syncRef.current) {
      tool.setError('日程还有未保存修改或待核对请求，请先保存、明确放弃更改或核对回执后再返回。')
      return
    }
    onClose()
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
    <header className={styles.heading}><div><h3>创作数据</h3><p className={styles.muted}>{book.book.title}</p></div>
      <div className={styles.actions}><button type="button" className={styles.button} disabled={tool.locked || tool.dirty} onClick={() => void reload()}><StudioIcon name="refresh" size={16} />{syncRequired ? '重试同步' : '刷新日历'}</button>
        <button type="button" className={styles.button} disabled={tool.locked} onClick={closePanel}><StudioIcon name="arrow" size={16} style={{ transform: 'rotate(180deg)' }} />返回</button></div></header>
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
    {!snapshot ? <p className={styles.empty} role="status">{tool.busy ? '正在读取本月日程与写作记录…' : '尚未取得本月日历，请点击“刷新日历”重试。'}</p>
      : snapshot.requiresUpgrade ? <div className={styles.empty}><h4>启用这部作品的创作日历</h4><p>备份并升级作品后，即可保存日程和查看月度写作记录。</p>
        <button type="button" className={styles.primaryButton} disabled={tool.locked || readonly} onClick={() => void upgrade()}>备份并升级作品</button></div>
        : <>
          <div className={styles.metrics} aria-label="本月创作指标">
            <div><span><StudioIcon name="spark" size={20} />本月净增</span><strong>{signed(statistics?.net ?? 0)}<small>字</small></strong><small>已保存版本 · {monthLabel(month)}</small></div>
            <div><span><StudioIcon name="calendar" size={20} />本月活跃日期</span><strong>{activeDates}<small>天</small></strong><small>有新增或删除记录的日期</small></div>
            <div><span><StudioIcon name="clock" size={20} />本月记录时长</span><strong>{statistics?.minutes.toLocaleString() ?? 0}<small>分钟</small></strong><small>作者登记的写作时段</small></div>
          </div>
          <div className={styles.dashboard}>
            <section className={styles.calendar} aria-label="月度创作日历">
              <header className={styles.calendarHeading}><h4><StudioIcon name="calendar" size={20} />创作日历</h4>
                <nav className={styles.monthNav} aria-label="选择月份">
                  <button type="button" className={styles.iconButton} aria-label="上一月" title="上一月" disabled={navigationBlocked || month === MIN_CALENDAR_MONTH} onClick={() => changeMonth(adjacentMonth(month, -1))}><StudioIcon name="chevron" size={16} style={{ transform: 'rotate(180deg)' }} /></button>
                  <label><span className={styles.visuallyHidden}>月份</span><input type="month" min={MIN_CALENDAR_MONTH} max={MAX_CALENDAR_MONTH} value={month} disabled={navigationBlocked} onChange={(event) => changeMonth(event.target.value)} /></label>
                  <button type="button" className={styles.iconButton} aria-label="下一月" title="下一月" disabled={navigationBlocked || month === MAX_CALENDAR_MONTH} onClick={() => changeMonth(adjacentMonth(month, 1))}><StudioIcon name="chevron" size={16} /></button>
                </nav>
              </header>
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
                    <span className={styles.dayNumber}>{Number(date.slice(8))}</span>
                    <span className={styles.dayMarker} data-active={day.activity.length > 0} data-due={due} data-event={day.events.length > 0} aria-hidden="true" />
                    <span className={styles.visuallyHidden}>{day.events.length} 项日程 · 净增 {signed(day.statistics.net)} 字</span>
                  </button>
                })}
              </div>
              <footer className={styles.calendarFooter}><span>{statistics?.scheduled} 条日程 · 已完成 {statistics?.completed} · 逾期 {statistics?.overdue}</span>
                <button type="button" className={styles.button} disabled={navigationBlocked} onClick={() => changeMonth(today.slice(0, 7), today)}>今天</button></footer>
            </section>
            <CalendarYearHeatmap key={`${bookId}:${month.slice(0, 4)}`} api={api} bookId={bookId} bookRevision={book.book.revision} month={month} today={today} disabled={navigationBlocked || externalChange}>
              <section className={styles.composition} aria-label="本月产出构成"><h4><StudioIcon name="layers" size={20} />产出构成<span>{Number(month.slice(5))} 月新增</span></h4>
                {!totalAdded && <p className={styles.muted}>本月尚无已保存的新增字数。</p>}
                <ul className={styles.sources}>{sourceTotals.map((item) => <li key={item.source}><span>{item.label}</span><progress aria-label={`${item.label}新增字数占比`} value={item.added} max={Math.max(1, totalAdded)} /><strong>{item.added.toLocaleString()} 字</strong></li>)}</ul>
                <p className={styles.muted}>常规编辑含手工记录；AI 仅计已采用内容。恢复与导入按保存来源分别统计。</p>
              </section>
            </CalendarYearHeatmap>
          </div>
          <p className={styles.scopeNote}>当前作品 · 字数取自已保存版本，净增＝新增－删除；时长为手工登记。计划完成不增加产出，全书日程 {snapshot.totalEntries.toLocaleString()} / 2,000 条。</p>
          <div className={styles.detailLayout}>
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
            <details className={styles.dailyTrend}><summary>本月每日净增</summary><svg className={styles.trend} viewBox="0 0 620 160" role="img" aria-label={`${monthLabel(month)}每日保存字数净增，零线上方新增、下方减少`}>
            <line x1="0" y1="76" x2="620" y2="76" />
            {dates.map((date, index) => { const net = days.get(date)?.statistics.net ?? 0, height = Math.abs(net) / trendMaximum * 60, x = index * 620 / dates.length; return <g key={date}>
              <rect x={x + 2} y={net >= 0 ? 76 - height : 76} width={620 / dates.length - 4} height={height} rx="2" data-negative={net < 0}><title>{date}：{signed(net)} 字</title></rect>
              {(index % 5 === 0 || index === dates.length - 1) && <text x={x + 4} y="154">{index + 1}</text>}</g> })}
            </svg></details>
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
