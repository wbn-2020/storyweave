import { useState } from 'react'
import type { StudioApi } from '../../contracts/api'
import { readStudyCard, type BeatCardSource, type StudyBeat } from '../../contracts/study-card'
import { request } from '../request'
import ui from './WorkbenchPanel.module.css'

export function BeatCardPicker({ api, disabled, onApply }: { api: StudioApi; disabled: boolean; onApply: (source: BeatCardSource, beats: StudyBeat[]) => void }) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<{ items: BeatCardSource[]; next: number | null; offset: number } | null>(null)
  const [selected, setSelected] = useState<BeatCardSource | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  async function load(offset: number) {
    if (disabled || busy) return
    setBusy(true); setError(null)
    const result = await request(() => api.listInspirations({ search: query.trim(), offset }))
    setBusy(false)
    if (!result.ok) { setError(result.error.message); return }
    setPage({ items: result.data.items.filter((item) => item.kind === 'beat' && !item.archived).map((item) => ({ id: item.id, revision: item.revision, title: item.title, body: item.body })), next: result.data.nextOffset, offset })
    setSelected(null); setConfirmed(false)
  }
  const parsed = selected ? readStudyCard('beat', selected.body) : null
  return <details className={ui.details}><summary>套用全局节拍骨架</summary><p className={ui.muted}>载入后先形成当前表单，再保存大纲新修订。原节拍会被本次选择替换，已有正文保持原样。</p>
    <div className={ui.toolbar}><label>搜索卡片<input value={query} maxLength={200} disabled={disabled || busy} onChange={(event) => setQuery(event.target.value)} /></label><button className={ui.button} type="button" disabled={disabled || busy} onClick={() => void load(0)}>查找节拍卡</button></div>
    {error && <p className={ui.error} role="alert">{error}</p>}
    {page && <><ul className={ui.records}>{page.items.map((item) => <li key={item.id}><label className={ui.check}><input type="radio" name="chapter-beat-source" disabled={disabled || busy} checked={selected?.id === item.id} onChange={() => { setSelected(item); setConfirmed(false) }} />{item.title} · v{item.revision}</label></li>)}</ul>
      {!page.items.length && <p className={ui.muted}>本页没有节拍卡，可换个关键词或继续翻页。</p>}
      <div className={ui.actions}><button className={ui.button} type="button" disabled={disabled || busy || page.offset === 0} onClick={() => void load(Math.max(0, page.offset - 50))}>上一页</button><button className={ui.button} type="button" disabled={disabled || busy || page.next === null} onClick={() => void load(page.next!)}>下一页</button></div></>}
    {selected && parsed && 'beats' in parsed && <><p>适用范围：{parsed.application || '尚未填写'}</p><p>复用限制：{parsed.limits || '尚未填写'}</p><ol>{parsed.beats.map((beat, index) => <li key={index}><strong>{beat.title}</strong><p>{beat.action}</p><p>变化：{beat.outcome}</p></li>)}</ol>
      <label className={ui.check}><input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => setConfirmed(event.target.checked)} />将当前表单中的节拍替换为这张卡的骨架，我会改写为本书情节再保存</label><button className={ui.primaryButton} type="button" disabled={disabled || busy || !confirmed} onClick={() => { onApply(selected, parsed.beats); setSelected(null); setConfirmed(false) }}>载入本章大纲表单</button></>}
  </details>
}
