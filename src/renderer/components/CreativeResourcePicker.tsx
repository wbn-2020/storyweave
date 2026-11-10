import { useEffect, useRef, useState } from 'react'
import type { StudioApi } from '../../contracts/api'
import { MAX_CREATIVE_RESOURCES, WRITING_METHODS, creativeRef, type CreativeResourceRef, type CreativeSelection } from '../../contracts/creative-resources'
import { request } from '../request'
import styles from './WorkbenchPanel.module.css'
import { studyMaterialText } from '../../contracts/study-card'

interface Option extends CreativeResourceRef { title: string; description: string }
interface Props { api: StudioApi; bookId: string; chapterId: string; bookRevision: number; disabled: boolean; limited: boolean; studyOnly?: boolean; value: CreativeSelection; onChange: (value: CreativeSelection) => void }
const labels = { scene: '本章场景', builtin: '写作方法', note: '本书笔记', inspiration: '全局灵感与拆书', foreshadow: '待回收伏笔' }
export function CreativeResourcePicker({ api, bookId, chapterId, bookRevision, disabled, limited, studyOnly = false, value, onChange }: Props) {
  const [selectedSource, setSource] = useState<CreativeResourceRef['source']>('scene')
  const source = studyOnly ? 'inspiration' : selectedSource
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<{ items: Option[]; total: number; next: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const names = useRef(new Map<string, string>())
  const radarVersion = useRef<{ key: string; bookRevision: number; knowledgeRevision: number } | null>(null)
  useEffect(() => {
    let active = true
    setLoading(true); setPage(null); setError(null)
    async function read() {
      let items: Option[] = [], total = 0, next: number | null = null
      if (source === 'builtin') {
        items = WRITING_METHODS.filter((item) => `${item.title} ${item.text}`.includes(submitted)).map((item) => ({ ...creativeRef(item), title: item.title, description: item.text }))
        total = items.length
      } else if (source === 'scene') {
        const result = await request(() => api.getWorkbench({ bookId }))
        if (!result.ok) throw new Error(result.error.message)
        if (result.data.bookRevision !== bookRevision) throw new Error('作品已有新版本，请刷新 AI 面板后重选场景。')
        if (result.data.requiresUpgrade) throw new Error('请在规划与审稿中备份升级作品，再使用场景。')
        items = result.data.scenes.filter((item) => !item.archived && !item.stale && (!item.chapterId || item.chapterId === chapterId) && `${item.title} ${item.goal}`.includes(submitted))
          .map((item) => ({ source: 'scene', id: item.id, revision: item.revision, title: item.title, description: [item.goal, item.conflict, item.outcome].filter(Boolean).join(' · ') }))
        total = items.length
        items = items.slice(offset, offset + 40); next = offset + items.length < total ? offset + items.length : null
      } else if (source === 'note') {
        const result = await request(() => api.listNotes({ bookId, search: submitted, offset, limit: 40, expectedBookRevision: bookRevision }))
        if (!result.ok) throw new Error(result.error.message)
        items = result.data.items.map((item) => ({ source: 'note', id: item.id, revision: item.revision, title: item.title, description: `${item.category === 'method' ? '写作方法' : '参考资料'} · ${item.excerpt}` }))
        total = result.data.total; next = result.data.nextOffset
      } else if (source === 'foreshadow') {
        const key = `${bookId}:${chapterId}:${bookRevision}:${submitted}`
        const fixed = radarVersion.current
        if (offset > 0 && (!fixed || fixed.key !== key)) throw new Error('伏笔列表版本已变化，请从第一页重新查找。')
        const result = await request(() => api.listForeshadowRadar({ bookId, asOfChapterId: chapterId, search: submitted, offset,
          scope: 'open', ...(offset > 0 && fixed ? { expectedBookRevision: fixed.bookRevision, expectedKnowledgeRevision: fixed.knowledgeRevision } : {}) }))
        if (!result.ok) throw new Error(result.error.message)
        if (!active) return
        if (result.data.bookId !== bookId || result.data.bookRevision !== bookRevision) throw new Error('作品已有新版本，请刷新面板后重选伏笔。')
        radarVersion.current = { key, bookRevision: result.data.bookRevision, knowledgeRevision: result.data.knowledgeRevision }
        items = result.data.items.filter((item) => item.authorDecision === 'adopted' && item.freshness === 'current' && item.conflictState !== 'candidate').map((item) => ({
          source: 'foreshadow', id: item.id, revision: item.revision, title: item.title,
          description: `${item.due === 'overdue' ? '已过计划位置' : item.due === 'due' ? '本章／本卷到期' : '待回收'} · ${item.description}`,
        }))
        total = result.data.total; next = result.data.nextOffset
      } else {
        const result = await request(() => api.listInspirations({ search: submitted, offset }))
        if (!result.ok) throw new Error(result.error.message)
        items = result.data.items.map((item) => ({ source: 'inspiration', id: item.id, revision: item.revision, title: item.title,
          description: `${item.kind === 'beat' ? '节拍骨架 · ' : item.kind === 'style' ? '文风卡 · ' : ''}${studyMaterialText(item.kind, item.body).slice(0, 180)}` }))
        total = result.data.total; next = result.data.nextOffset
      }
      if (!active) return
      for (const item of items) names.current.set(`${item.source}:${item.id}`, item.title)
      setPage({ items, total, next })
    }
    void read().catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : '读取资料失败。') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, bookId, chapterId, bookRevision, source, submitted, offset, refresh])
  function toggle(item: Option) {
    const exists = value.refs.some((ref) => ref.source === item.source && ref.id === item.id)
    const refs = exists ? value.refs.filter((ref) => ref.source !== item.source || ref.id !== item.id) : [...value.refs, creativeRef(item)]
    onChange({ refs, application: refs.length ? value.application : '' })
  }
  return <details className={styles.panel}>
    <summary>场景、资料与写作方法 · 已选 {value.refs.length}/{MAX_CREATIVE_RESOURCES}</summary>
    <p className={styles.muted}>{studyOnly ? '选择已导入的参考原文，随后在发送预览中核对完整内容。拆书仅接受全局资料，请移除其他来源的旧选择。' : '选择本场计划、笔记或拆书方法，随后在发送预览中核对完整内容。每项都保留选择时的版本。'}</p>
    {limited && <p className={styles.warning}>这些资料只用于作者创作。当前视角或任务不支持附加，请先移除已有选择。</p>}
    {!!value.refs.length && <ul>{value.refs.map((ref) => <li key={`${ref.source}:${ref.id}`}>
      {names.current.get(`${ref.source}:${ref.id}`) ?? `${labels[ref.source]} ${ref.id}`} · v{ref.revision}
      <button type="button" className={styles.button} disabled={disabled} onClick={() => {
        const refs = value.refs.filter((item) => item.source !== ref.source || item.id !== ref.id)
        onChange({ refs, application: refs.length ? value.application : '' })
      }}>移除</button>
    </li>)}</ul>}
    <div className={styles.toolbar}><label>资料来源<select disabled={disabled || limited || studyOnly} value={source} onChange={(event) => { setSource(event.target.value as typeof source); setOffset(0) }}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>查找<input value={query} maxLength={200} disabled={disabled || limited} onChange={(event) => setQuery(event.target.value)} /></label>
      <button className={styles.button} type="button" disabled={disabled || limited || loading} onClick={() => { setSubmitted(query.trim()); setOffset(0); setRefresh((count) => count + 1) }}>查找 / 刷新</button></div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {loading && <p role="status">正在读取资料…</p>}
    {page && <><p className={styles.muted}>共 {page.total} 项；按标题或内容搜索可定位其他资料。</p><ul className={styles.records}>{page.items.map((item) => {
      const selected = value.refs.some((ref) => ref.source === item.source && ref.id === item.id)
      return <li key={`${item.source}:${item.id}`}><label className={styles.check}><input type="checkbox" checked={selected} disabled={disabled || limited || (!selected && value.refs.length >= MAX_CREATIVE_RESOURCES)} onChange={() => toggle(item)} /><span><strong>{item.title}</strong><br /><span className={styles.muted}>{item.description || '尚未填写内容'}</span></span></label></li>
    })}</ul>{!page.items.length && <p className={styles.muted}>没有符合条件的资料，可以换个来源，或先在规划、笔记和灵感中保存内容。</p>}
      <div className={styles.actions}><button className={styles.button} type="button" disabled={disabled || limited || loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - (source === 'inspiration' ? 50 : source === 'foreshadow' ? 20 : 40)))}>上一页</button><button className={styles.button} type="button" disabled={disabled || limited || loading || page.next === null} onClick={() => setOffset(page.next!)}>下一页</button></div></>}
    {!!value.refs.length && <label>本次如何使用<textarea rows={2} maxLength={2000} disabled={disabled || limited} value={value.application} placeholder="例如：按场景目标写对峙，使用对白与潜台词方法，保留结局悬念。" onChange={(event) => onChange({ ...value, application: event.target.value })} /></label>}
  </details>
}
