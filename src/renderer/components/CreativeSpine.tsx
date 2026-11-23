import { useEffect, useRef, useState } from 'react'
import type { StudioApi } from '../../contracts/api'
import type { CreativeHealth, LivingOutline, LivingSnapshot } from '../../contracts/living'
import { request } from '../request'
import shared from '../StellarShared.module.css'
import { StudioIcon, type StudioIconName } from './StudioIcon'
import styles from './StellarLiving.module.css'

export type CreativeDomain = 'idea' | 'world' | 'cast' | 'outline' | 'manuscript'
const labels: Record<CreativeDomain, string> = { idea: '脑洞', world: '世界', cast: '角色', outline: '大纲', manuscript: '正文' }
const states: Record<CreativeHealth, string> = { empty: '待建立', pending_proposal: '有待处理提案', stale: '待复核', in_progress: '创作中', ready: '已有资料' }
const symbols: Record<CreativeDomain, StudioIconName> = { idea: 'bulb', world: 'globe', cast: 'user', outline: 'list', manuscript: 'pen' }

export function useLivingSnapshot(api: StudioApi | undefined, bookId: string | undefined, revision: number | undefined, outlineId?: string) {
  const [snapshot, setSnapshot] = useState<LivingSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const ticket = useRef(0)
  useEffect(() => {
    let active = true
    const current = ++ticket.current
    if (!api || !bookId) { setSnapshot(null); setReading(false); setError(null); return }
    setReading(true); setError(null)
    void request(() => api.getLiving({ bookId, ...(outlineId ? { outlineId } : {}) })).then((result) => {
      if (!active || current !== ticket.current) return
      setReading(false)
      if (!result.ok) { setError(result.error.message); return }
      if (result.data.bookId !== bookId || result.data.bookRevision < (revision ?? 0)) { setError('创作状态与当前作品版本不符，请刷新。'); return }
      setSnapshot(result.data)
    })
    return () => { active = false }
  }, [api, bookId, revision, outlineId, epoch])
  return { snapshot: snapshot && !error && snapshot.bookId === bookId && snapshot.bookRevision >= (revision ?? 0) ? snapshot : null,
    error, reading, reload: () => setEpoch((value) => value + 1), receive: (value: LivingSnapshot) => {
      if (value.bookId !== bookId || value.bookRevision < (revision ?? 0)) return
      if (outlineId && value.outlines.find((node) => node.id === outlineId)?.detailsLoaded === false) { setEpoch((current) => current + 1); return }
      // 保存回执带来的新快照优先；此前发出的读取即使迟到或失败，也不能覆盖这次确认。
      ticket.current += 1
      setSnapshot(value); setError(null); setReading(false)
    } }
}

export function CreativeSpine({ snapshot, reading, error, disabled, onNavigate, onReload, variant = 'compact' }: {
  snapshot: LivingSnapshot | null; reading: boolean; error: string | null; disabled: boolean
  onNavigate: (domain: CreativeDomain) => void; onReload: () => void
  variant?: 'compact' | 'orbit'
}) {
  return <nav className={`${styles.spine} ${variant === 'orbit' ? styles.orbitSpine : ''}`} aria-label="五域创作状态">
    {(Object.keys(labels) as CreativeDomain[]).map((domain) => <button key={domain} type="button" disabled={disabled}
      data-domain={domain} data-health={snapshot?.requiresUpgrade || reading ? undefined : snapshot?.health[domain]} onClick={() => onNavigate(domain)}
      title={`${labels[domain]} · ${reading ? '核对中' : snapshot?.requiresUpgrade ? '升级后查看' : snapshot ? states[snapshot.health[domain]] : '状态未知'}`}>
      {variant === 'orbit' && <span className={styles.spineSymbol}><StudioIcon name={symbols[domain]} size={24} /></span>}
      <span>{labels[domain]}</span><small>{reading ? '核对中' : snapshot?.requiresUpgrade ? '升级后查看' : snapshot ? states[snapshot.health[domain]] : '状态未知'}</small>
    </button>)}
    {error ? <button type="button" className={styles.spineNotice} disabled={disabled || reading} onClick={onReload} title={error}>状态读取未完成，点击重试</button>
      : variant !== 'orbit' && <span className={styles.spineNotice}>可先写正文，再补设定</span>}
  </nav>
}

export function ChapterBeatStrip({ outline, reading, disabled, onOpen, onExpand }: { outline: LivingOutline | undefined; reading: boolean; disabled: boolean; onOpen: () => void; onExpand: (instruction: string) => void }) {
  return <section className={styles.beatStrip} aria-label="本章目标、冲突与节拍">
    <h3>本章节拍</h3>
    {reading ? <p role="status">正在核对本章章纲…</p> : outline?.detailsLoaded === false ? <p>本章详情尚未读取，请打开本章大纲查看。</p> : outline ? <>
      {outline.stale && <p>本章计划依赖的资料已变化，请在演进大纲中复核。</p>}
      {outline.fields.goal && <p>目标：{outline.fields.goal}</p>}
      {outline.fields.conflict && <p>冲突：{outline.fields.conflict}</p>}
      {outline.fields.beats.length ? <ol>{outline.fields.beats.map((beat, index) => <li key={index}><strong>{beat.title}</strong>{beat.action && <p>{beat.action}</p>}{beat.outcome && <p>变化：{beat.outcome}</p>}<button className={shared.button} type="button" disabled={disabled || outline.stale} onClick={() => onExpand(`按本章有效章纲的第 ${index + 1} 个场景节拍续写正文。节拍：${beat.title}。行动：${beat.action}。变化：${beat.outcome}。只接续当前章尾，不重复已有正文；其他节拍留待后续推进。`)}>按此节拍扩写</button></li>)}</ol> : <p>写下这一章的目标与三个场景节拍，也可以直接开始正文。</p>}
      {outline.fields.hook && <p>章末悬念：{outline.fields.hook}</p>}
    </> : <p>可在演进大纲中规划本章。</p>}
    <button className={shared.button} type="button" disabled={disabled} onClick={onOpen}>编辑本章大纲</button>
  </section>
}
