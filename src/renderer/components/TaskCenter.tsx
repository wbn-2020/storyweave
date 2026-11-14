import { useEffect, useId, useRef, useState } from 'react'
import type { StudioApi } from '../../contracts/api'
import { request, displayTime } from '../request'
import { readTaskCenterSnapshot, taskStateLabel, type TaskEntry, type TaskStopResult, type TaskStopTarget } from '../task-center'
import type { TaskAiTarget, TaskDestination } from '../task-center'
import { StudioIcon, type StudioIconName } from './StudioIcon'
import { StellarTooltip } from './stellar/StellarTooltip'
import { localDate } from './workbench-ui'
import styles from './StellarTasks.module.css'

export type { TaskAiTarget, TaskDestination } from '../task-center'
export interface StudioNotice {
  id: string; title: string; detail: string; tone: 'warning' | 'danger' | 'info'; time?: string
  destination?: TaskDestination; aiTarget?: TaskAiTarget; taskId?: string
}
const icons: Record<TaskDestination, StudioIconName> = { ai: 'spark', memory: 'layers', aiMemoryTasks: 'read', aiSummary: 'notes', media: 'image', vector: 'layers' }
const clock = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

export function TaskCenter({ api, bookId, notices, seen, onSeen, onClose, onNavigate, onStop, disabled, pendingMessage, checkingReceipt, onCheckReceipt, onRecover }: {
  api?: StudioApi; bookId?: string; notices: StudioNotice[]; seen: Set<string>; onSeen: (ids: string[]) => void
  onClose: () => void; onNavigate: (destination: TaskDestination, target?: TaskAiTarget, taskId?: string) => void; disabled: boolean
  onStop: (target: TaskStopTarget) => Promise<TaskStopResult>; pendingMessage?: string | null
  checkingReceipt: boolean; onCheckReceipt: () => void; onRecover: () => void
}) {
  const [tab, setTab] = useState<'notices' | 'tasks'>('notices')
  const [tasks, setTasks] = useState<TaskEntry[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [reading, setReading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState<TaskEntry | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopMessage, setStopMessage] = useState<string | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)
  const stopLock = useRef(false)
  const mounted = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const panelId = useId()
  const keepTask = useRef<HTMLButtonElement>(null)
  const stopTrigger = useRef<HTMLButtonElement | null>(null)
  const previousPending = useRef(pendingMessage)
  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement
    dialog.current?.showModal()
    return () => { mounted.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    if (confirmStop) keepTask.current?.focus()
    else if (stopTrigger.current) {
      if (stopTrigger.current.isConnected) stopTrigger.current.focus()
      else dialog.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
      stopTrigger.current = null
    }
  }, [confirmStop])
  useEffect(() => {
    if (previousPending.current && !pendingMessage) {
      setStopError(null); setStopMessage('原操作已核对，正在重新读取任务状态。'); setRefresh((value) => value + 1)
    }
    previousPending.current = pendingMessage
  }, [pendingMessage])
  useEffect(() => {
    setTasks([]); setErrors([]); setReadAt(null); setReading(false); setConfirmStop(null)
    if (!api || !bookId) return
    let active = true
    setReading(true)
    // 只读取已有任务快照，不在通知抽屉调度生成、整理或重发任务。
    void Promise.all([
      request(() => api.listAiRuns({ bookId })),
      request(() => api.getMemoryStatus({ bookId })),
      request(() => api.getAiMemoryTaskStatus({ bookId })),
      request(() => api.getAiSummaryStatus({ bookId })),
      request(() => api.listImageGenerations({ bookId })),
      request(() => api.listMemoryVectorRuns({ bookId })),
    ]).then(([runs, index, chapters, summary, images, vectors]) => {
      if (!active) return
      const snapshot = readTaskCenterSnapshot(bookId, { runs, index, chapters, summary, images, vectors })
      setTasks(snapshot.tasks); setErrors(snapshot.errors); setReadAt(new Date().toISOString())
    }).catch(() => { if (active) setErrors(['任务读取未完成，请重新读取。']) })
      .finally(() => { if (active) setReading(false) })
    return () => { active = false }
  }, [api, bookId, refresh])
  const activeTasks = tasks.filter((item) => ['running', 'planning'].includes(item.state))
  const taskNotices: StudioNotice[] = tasks.filter((item) => item.error || ['failed', 'interrupted', 'superseded'].includes(item.state)).map((item) => ({
    id: `${bookId}:${item.id}:${item.time}:${item.state}`, title: `${item.title} · ${taskStateLabel(item)}`,
    detail: item.error ?? (item.timeLabel ? `${item.detail} · 创建于 ${displayTime(item.time)}，详情请查看原任务。`
      : item.state === 'failed' ? `${item.detail}。未返回错误详情，可打开任务记录核对。` : item.detail),
    tone: item.state === 'failed' ? 'danger' : 'warning', time: item.timeLabel ? undefined : item.time,
    destination: item.destination, aiTarget: item.aiTarget, taskId: item.taskId,
  }))
  const allNotices = [...new Map([...notices, ...taskNotices].map((item) => [item.id, item])).values()]
    .sort((a, b) => (b.time ? Date.parse(b.time) : Number.MAX_SAFE_INTEGER) - (a.time ? Date.parse(a.time) : Number.MAX_SAFE_INTEGER))
  const groups = new Map<string, StudioNotice[]>()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const todayKey = localDate(), yesterdayKey = localDate(yesterday)
  for (const notice of allNotices) {
    const date = notice.time ? localDate(new Date(notice.time)) : null
    const day = date === todayKey ? '今天' : date === yesterdayKey ? '昨天' : date ?? '当前状态'
    groups.set(day, [...(groups.get(day) ?? []), notice])
  }
  async function stopConfirmed() {
    const target = confirmStop, latest = tasks.find((item) => item.id === target?.id)
    if (!target?.stop || stopLock.current || disabled || reading || pendingMessage) return
    if (!latest?.stop || latest.version !== target.version || latest.state !== target.state) {
      setConfirmStop(null); setStopMessage('任务检查点已变化，请刷新后重新确认。'); return
    }
    stopLock.current = true; setStopping(true); setStopMessage(null); setStopError(null)
    try {
      const result = await onStop(target.stop)
      if (mounted.current) {
        setConfirmStop(null)
        setStopError(result.confirmed ? null : result.message)
        setStopMessage(result.confirmed ? '任务状态已确认，正在重新读取。' : null)
        setRefresh((value) => value + 1)
      }
    } catch { if (mounted.current) setStopError('停止结果尚未确认，请核对原回执。') }
    finally { stopLock.current = false; if (mounted.current) setStopping(false) }
  }
  function taskRow(task: TaskEntry) {
    const measurable = task.done !== undefined && task.total !== undefined && task.total > 0 && task.state !== 'planning'
    const pending = ['running', 'planning'].includes(task.state)
    return <li key={task.id} data-state={task.state} data-kind={task.destination}>
      <span className={styles.taskMark} aria-hidden="true"><StudioIcon name={icons[task.destination]} size={24} /></span>
      <div className={styles.taskInfo}><strong>{task.title}</strong><div className={styles.taskMeta}><p>{task.detail}</p><span className={styles.taskState}>{taskStateLabel(task)} · {task.timeLabel && `${task.timeLabel} `}
        <time dateTime={task.time} title={`${task.timeLabel ?? '更新'}于 ${displayTime(task.time)}`}>{clock(task.time)}</time></span></div></div>
      <div className={styles.taskProgress}>{measurable ? <><progress aria-label={`${task.title}数量进度`} value={task.done} max={task.total} /><span>{Math.floor(task.done! * 100 / task.total!)}%</span></>
        : pending ? <><progress aria-label={`${task.title}${taskStateLabel(task)}`} /><span>{taskStateLabel(task)}</span></> : <span>{taskStateLabel(task)}</span>}</div>
      <div className={styles.taskActions}>{task.stop && <button type="button" className={styles.stopButton} disabled={disabled || reading || stopping || Boolean(pendingMessage)}
        aria-label={`停止：${task.title}`} onClick={(event) => { stopTrigger.current = event.currentTarget; setStopMessage(null); setStopError(null); setConfirmStop(task) }}>停止</button>}
        <button type="button" className={styles.viewButton} disabled={disabled || stopping} title={disabled ? '请先处理当前操作' : '打开原任务面板'} onClick={() => onNavigate(task.destination, task.aiTarget, task.taskId)}>查看</button></div>
      {task.error && <p className={styles.taskError}>{task.error}</p>}
    </li>
  }
  return <dialog ref={dialog} className={styles.drawer} aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (confirmStop && !stopping) setConfirmStop(null); else onClose() }}>
    <h2 id={headingId} className={styles.visuallyHidden}>通知与任务</h2>
    <header className={styles.heading}><div className={styles.tabs} role="tablist" aria-label="通知任务视图" onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || confirmStop) return
      event.preventDefault()
      const next = event.key === 'Home' ? 'notices' : event.key === 'End' ? 'tasks' : tab === 'notices' ? 'tasks' : 'notices'
      setTab(next); dialog.current?.querySelector<HTMLButtonElement>(`[id="${panelId}-${next}"]`)?.focus()
    }}>
      <button type="button" id={`${panelId}-notices`} role="tab" aria-selected={tab === 'notices'} aria-controls={panelId} tabIndex={tab === 'notices' ? 0 : -1} disabled={Boolean(confirmStop)} onClick={() => setTab('notices')}><StudioIcon name="bell" size={22} />通知 <span>{allNotices.filter((item) => !seen.has(item.id)).length}</span></button>
      <button type="button" id={`${panelId}-tasks`} role="tab" aria-selected={tab === 'tasks'} aria-controls={panelId} tabIndex={tab === 'tasks' ? 0 : -1} disabled={Boolean(confirmStop)} onClick={() => setTab('tasks')}><StudioIcon name="check" size={22} />任务 <span>{tasks.length}</span></button>
    </div><StellarTooltip><button className={styles.close} type="button" onClick={onClose} aria-label="关闭通知与任务" title="关闭"><StudioIcon name="close" size={20} /></button></StellarTooltip></header>
    {pendingMessage && <section className={styles.pending} role="alert"><p>{pendingMessage}</p><div><button type="button" className={styles.button} disabled={checkingReceipt} onClick={onCheckReceipt}>{checkingReceipt ? '正在核对…' : '查询原回执'}</button><button type="button" className={styles.button} disabled={checkingReceipt} onClick={onRecover}>进入草稿与恢复</button></div></section>}
    <div id={panelId} className={styles.content} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} tabIndex={0} inert={Boolean(confirmStop)}>
      {errors.map((error) => <p className={styles.error} role="alert" key={error}>{error}</p>)}
      {reading && <p className={styles.note} role="status">正在读取本书任务…</p>}
      {stopMessage && <p className={styles.note} role="status">{stopMessage}</p>}
      {stopError && !pendingMessage && <p className={styles.error} role="alert">{stopError}</p>}
      {tab === 'notices' ? <>
      {[...groups].map(([day, values]) => <section className={styles.group} key={day}><h3>{day}</h3><ul className={styles.notices}>{values.map((item) => <li key={item.id} data-tone={item.tone} data-unread={!seen.has(item.id)}>
        <span className={styles.noticeMark} aria-hidden="true"><StudioIcon name={item.tone === 'danger' ? 'warning' : item.destination ? icons[item.destination] : 'bell'} size={28} /></span><div className={styles.noticeInfo}><strong>{item.title}</strong><p>{item.detail}</p></div>
        {item.time && <time dateTime={item.time} title={displayTime(item.time)}>{clock(item.time)}</time>}
        <StellarTooltip><button type="button" title={item.destination ? '查看通知' : '标为已读'} aria-label={`${item.destination ? '查看' : '标为已读'}：${item.title}`} disabled={item.destination ? disabled || stopping : seen.has(item.id)}
          onClick={() => { onSeen([item.id]); if (item.destination) onNavigate(item.destination, item.aiTarget, item.taskId) }}><StudioIcon name={item.destination ? 'chevron' : 'check'} size={20} /></button></StellarTooltip>
      </li>)}</ul></section>)}
      {!reading && !allNotices.length && <div className={styles.empty}><StudioIcon name="bell" size={28} /><p>{errors.length ? '通知暂时无法完整读取' : '暂无通知'}</p></div>}
      {activeTasks.length > 0 && <section className={styles.active}><h3>运行中的任务</h3><ul className={styles.tasks}>{activeTasks.slice(0, 3).map(taskRow)}</ul>{activeTasks.length > 3 && <button type="button" className={styles.button} onClick={() => setTab('tasks')}>查看全部 {activeTasks.length} 项任务</button>}</section>}
    </> : <><ul className={styles.tasks}>{tasks.map(taskRow)}</ul>{!reading && !tasks.length && <div className={styles.empty}><StudioIcon name="list" size={28} /><p>{bookId ? errors.length ? '任务暂时无法完整读取' : '暂无任务记录' : '打开作品后查看任务'}</p></div>}</>}</div>
    {confirmStop && <section className={styles.confirmation} role="alert"><strong>停止“{confirmStop.title}”？</strong><p>{confirmStop.destination === 'media' ? '只停止这次图片请求，并核对原任务终态；已有结果仍保留，不会自动重发或保存到本书。'
      : confirmStop.stop?.kind === 'vector' ? confirmStop.state === 'prepared' ? '取消这份尚未发送的预览，不会发送模型请求。'
        : confirmStop.stop.task.active ? '取消这次向量网络请求并核对原任务终态；已保存的批次仍保留，不会自动开始下一批。'
          : '这条运行记录已无本机活动请求，将明确标记为中断；已有向量和检索快照仍保留，不会重发。'
      : confirmStop.destination === 'ai' ? '已生成的输出仍保留，不会自动重发请求。' : '已保存的记录和作者决定仍保留。若模型仍在生成，须先停止对应生成。'}</p><div><button ref={keepTask} type="button" className={styles.button} disabled={stopping} onClick={() => setConfirmStop(null)}>继续保留</button><button type="button" className={styles.stopButton} disabled={disabled || stopping || Boolean(pendingMessage)} onClick={() => void stopConfirmed()}>{stopping ? '正在停止…' : '确认停止'}</button></div></section>}
    <footer className={styles.footer} inert={Boolean(confirmStop)}><StellarTooltip><button type="button" className={styles.refreshButton} aria-label="刷新任务与通知" title={readAt ? `最近读取 ${displayTime(readAt)}` : '刷新'} disabled={reading || stopping || !bookId || !api || Boolean(pendingMessage)} onClick={() => setRefresh((value) => value + 1)}><StudioIcon name="refresh" size={18} /></button></StellarTooltip>
      {tab === 'notices' && <button type="button" className={styles.readAll} disabled={!allNotices.some((item) => !seen.has(item.id))} onClick={() => onSeen(allNotices.map((item) => item.id))}><span className={styles.readMark} aria-hidden="true"><StudioIcon name="check" size={20} /></span>全部标为已读</button>}
    </footer>
  </dialog>
}
