import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WritingCalendarApi } from '../../contracts/writing-calendar'
import { calendarMonthDates, isCalendarSnapshot } from '../../contracts/writing-calendar'
import { request } from '../request'
import { StudioIcon } from './StudioIcon'
import styles from './StellarCalendar.module.css'

interface DayTotal { added: number; removed: number; net: number }
interface YearSnapshot { revision: number; days: Map<string, DayTotal> }
const trendAxisNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

export function CalendarYearHeatmap({ api, bookId, bookRevision, month, today, disabled, compact = false, children }: {
  api: WritingCalendarApi; bookId: string; bookRevision: number; month: string; today: string; disabled: boolean; compact?: boolean; children?: ReactNode
}) {
  const gradient = useId()
  const year = month.slice(0, 4)
  const months = useMemo(() => Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`), [year])
  const [data, setData] = useState<YearSnapshot | null>(null)
  const [reading, setReading] = useState(false)
  const [completed, setCompleted] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestEpoch = useRef(0)
  const locked = useRef(false)
  const revision = useRef(bookRevision)
  revision.current = bookRevision
  useEffect(() => () => { requestEpoch.current += 1 }, [])
  const stale = Boolean(data && data.revision !== bookRevision)
  const activeDays = data ? [...data.days.values()].filter((day) => day.added + day.removed > 0).length : 0
  const monthlyNet = months.map((item) => data ? [...data.days].filter(([date]) => date.startsWith(item)).reduce((sum, [, day]) => sum + day.net, 0) : 0)
  const minimumNet = Math.min(0, ...monthlyNet)
  const maximumNet = Math.max(1, ...monthlyNet)
  const trendY = (value: number) => 152 - (value - minimumNet) / (maximumNet - minimumNet) * 136
  const trendPoints = monthlyNet.map((net, index) => `${64 + index * 48},${trendY(net)}`).join(' ')

  async function load() {
    if (disabled || locked.current) return
    locked.current = true
    const at = ++requestEpoch.current, expectedRevision = bookRevision
    setReading(true); setCompleted(0); setError(null); setNotice(null); setData(null)
    const days = new Map<string, DayTotal>()
    try {
      // 逐月顺序读取并核对同一作品版本，失败或版本变化时不将缺失月份补成零。
      for (const item of months) {
        const result = await request(() => api.getWritingCalendar({ bookId, month: item }))
        if (at !== requestEpoch.current) return
        if (!result.ok) { setError(`${item} 读取失败：${result.error.message}`); return }
        if (!isCalendarSnapshot(result.data, bookId, item) || result.data.bookRevision !== expectedRevision || revision.current !== expectedRevision) {
          setError('读取期间作品版本发生变化，全年数据未合并。请刷新日历后重新读取。'); return
        }
        if (result.data.requiresUpgrade) { setError('请先完成作品的日历升级，再读取全年记录。'); return }
        for (const date of calendarMonthDates(item)) days.set(date, { added: 0, removed: 0, net: 0 })
        for (const day of result.data.activity) {
          const total = days.get(day.date)!
          total.added += day.added; total.removed += day.removed; total.net += day.net
        }
        setCompleted((value) => value + 1)
      }
      setData({ revision: expectedRevision, days })
    } finally {
      if (at === requestEpoch.current) { locked.current = false; setReading(false) }
    }
  }
  function cancel() {
    requestEpoch.current += 1; locked.current = false; setReading(false)
    setNotice('已取消全年读取。尚未完成的月份未计入统计。')
  }

  if (compact) return <section className={styles.compactAnnual} aria-label={`${year} 年创作热力图`}>
    <header className={styles.compactHeading}><h4>创作热力图{data ? ` · ${data.days.size} 天` : ` · ${year}`}</h4>
      {reading ? <button type="button" className={styles.button} onClick={cancel}>取消</button>
        : <button type="button" className={styles.button} disabled={disabled} onClick={() => void load()}>{data ? '刷新' : '读取全年'}</button>}
    </header>
    {reading && <p className={styles.muted} role="status">正在读取 {completed} / 12 个月…</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.muted} role="status">{notice}</p>}
    {stale && <p className={styles.warning}>统计已过期，请刷新。</p>}
    {data ? <>
      <div className={styles.compactCells} role="img" aria-label={`${year} 年 ${data.days.size} 天的每日新增字数，${activeDays} 天有增删记录`}>
        {Array.from({ length: new Date(`${year}-01-01T12:00:00`).getDay() }, (_, index) => <span key={`offset:${index}`} />)}
        {[...data.days].map(([date, day]) => <span key={date} className={styles.heatCell}
          data-level={date > today && !day.added && !day.removed ? 'future' : day.added === 0 ? 0 : day.added < 500 ? 1 : day.added < 1500 ? 2 : day.added < 3000 ? 3 : 4}
          title={`${date} · 新增 ${day.added.toLocaleString()} 字，净增 ${day.net.toLocaleString()} 字`} />)}
      </div>
      <div className={styles.compactMonths}>{months.filter((_, index) => index % 2 === 0 || index === 11).map((item) => <span key={item}>{Number(item.slice(5))} 月</span>)}</div>
    </> : !reading && !error && <p className={styles.muted}>尚未读取全年记录</p>}
    <p className={styles.compactScope}>当前作品 · 已保存版本 · 每日新增字数</p>
  </section>

  return <><section className={styles.annual} aria-label={`${year} 年创作热力图`}>
    <header className={styles.calendarHeading}><h4><StudioIcon name="grid" size={24} />{data ? `${data.days.size} 天热力图` : '全年创作热力图'}</h4><span className={styles.yearLabel}>{year}</span>
      {reading ? <button type="button" className={styles.button} onClick={cancel}>取消读取</button>
        : <button type="button" className={styles.button} disabled={disabled} title={disabled ? '请先处理当前输入或刷新作品版本' : '读取所选年份的十二个月'} onClick={() => void load()}><StudioIcon name="refresh" size={14} />{data ? '刷新全年' : '读取全年'}</button>}
    </header>
    {reading && <p className={styles.muted} role="status">正在读取 {completed} / 12 个月…</p>}
    {notice && <p className={styles.muted} role="status">{notice}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {stale && <p className={styles.warning}>作品已有新版本，下面保留的是旧统计，请刷新全年记录。</p>}
    {!data ? <div className={styles.yearEmpty}><span aria-hidden="true">01 · 02 · 03 · 04 · 05 · 06 · 07 · 08 · 09 · 10 · 11 · 12</span><p>{reading ? '全年记录正在汇集' : '读取全年后显示每日热度和月度趋势'}</p></div> : <>
      <div className={styles.heatmapScroll} tabIndex={0} role="region" aria-label="全年每日新增字数表">
        <table className={styles.heatmap}>
          <caption className={styles.visuallyHidden}>{year} 年每日新增字数，颜色不扣除删除量</caption>
          <thead className={styles.visuallyHidden}><tr><th scope="col">月份</th>{Array.from({ length: 31 }, (_, index) => <th scope="col" key={index}>{index + 1}</th>)}</tr></thead>
          <tbody>{months.map((item) => <tr key={item} data-current={item === month}>
            <th scope="row">{Number(item.slice(5))} 月</th>{Array.from({ length: 31 }, (_, index) => {
              const date = `${item}-${String(index + 1).padStart(2, '0')}`, day = data.days.get(date)
              if (!day) return <td key={index} />
              const future = date > today && !day.added && !day.removed
              const level = day.added === 0 ? 0 : day.added < 500 ? 1 : day.added < 1500 ? 2 : day.added < 3000 ? 3 : 4
              const label = future ? `${date}：尚未到来` : `${date}：新增 ${day.added.toLocaleString()}，删除 ${day.removed.toLocaleString()}，净增 ${day.net.toLocaleString()} 字`
              return <td key={index}><span className={styles.heatCell} data-level={future ? 'future' : level} title={label}><span className={styles.visuallyHidden}>{label}</span></span></td>
            })}
          </tr>)}</tbody>
        </table>
      </div>
      <div className={styles.heatLegend} aria-label="每日新增字数图例">{['0 字', '1–499', '500–1499', '1500–2999', '3000 及以上'].map((label, index) => <span key={label}><i className={styles.heatCell} data-level={index} />{label}</span>)}</div>
      <p className={styles.muted}>{activeDays} 天有增删记录 · 颜色表示新增字数，不扣除删除量；虚线表示尚未到来的空白日期。</p>
    </>}
  </section>
    <div className={styles.annualAnalytics}>
      <section className={styles.annualTrend} aria-label="全年月度净增趋势"><h4><StudioIcon name="chart" size={24} />月度趋势<span>{year} 年 · 净增字数</span></h4>
        {!data ? <div className={styles.trendEmpty}><StudioIcon name="chart" size={28} /><p>{reading ? '正在汇集全年记录…' : '尚未读取全年记录'}</p></div> : <>
          <svg className={styles.monthlyTrend} viewBox="0 0 620 188" role="img" aria-label={`${year} 年各月净增字数，包含删除后的净变化${stale ? '，统计已过期' : ''}`}>
            <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className={styles.trendFillTop} /><stop offset="1" className={styles.trendFillBottom} /></linearGradient></defs>
            {months.map((item, index) => <line key={item} x1={64 + index * 48} y1="16" x2={64 + index * 48} y2="152" />)}
            {[0, 1, 2, 3, 4].map((step) => { const value = minimumNet + (maximumNet - minimumNet) * step / 4, y = trendY(value); return <g key={step}><line x1="64" y1={y} x2="592" y2={y} /><text x="56" y={y + 4} textAnchor="end"><title>{Math.round(value).toLocaleString()} 字</title>{trendAxisNumber.format(Math.round(value))}</text></g> })}
            <path className={styles.trendArea} fill={`url(#${gradient})`} d={`M64,${trendY(0)} L${trendPoints} L592,${trendY(0)} Z`} />
            <polyline className={styles.trendLine} points={trendPoints} />
            {monthlyNet.map((net, index) => <g key={months[index]}><circle cx={64 + index * 48} cy={trendY(net)} r="3" data-negative={net < 0}><title>{months[index]}：净增 {net.toLocaleString()} 字</title></circle><text x={64 + index * 48} y="178" textAnchor="middle">{index + 1} 月</text></g>)}
          </svg>
          <p className={styles.muted}>当前作品 · 已保存版本 · 作品版本 {data.revision}{stale ? '，统计已过期' : ''}</p>
        </>}
      </section>
      {children}
    </div>
  </>
}
