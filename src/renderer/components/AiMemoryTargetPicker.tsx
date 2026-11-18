import { useEffect, useRef, useState } from 'react'
import { requiredId, type StudioApi } from '../../contracts/api'
import { parseKnowledgeFields, type KnowledgeItemDetail, type KnowledgeItemPage, type KnowledgeKind } from '../../contracts/knowledge'
import { request } from '../request'
import { StudioIcon } from './StudioIcon'
import shared from '../StellarShared.module.css'
import styles from './StellarAi.module.css'
import archive from './StellarArchive.module.css'

interface Props {
  api: StudioApi
  bookId: string
  knowledgeRevision: number
  kind: KnowledgeKind
  name: string
  disabled: boolean
  onSelect: (item: KnowledgeItemDetail) => void
}

const targetIcons = { person: 'user', place: 'compass', organization: 'workflow', object: 'archive', rule: 'read', theme: 'spark', other: 'grid' } as const

/** 名称与别名搜索只提供候选，由作者明确选择身份；异步回执不能覆盖后来切换的审阅。 */
export function AiMemoryTargetPicker(props: Props) {
  const [query, setQuery] = useState(props.name)
  const [page, setPage] = useState<KnowledgeItemPage | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState<{ kind: 'search'; offset: number } | { kind: 'read'; id: string } | null>(null)
  const busy = loading !== null
  const searching = loading?.kind === 'search' && loading.offset === 0
  const paging = loading?.kind === 'search' && loading.offset > 0
  const epoch = useRef(0)
  const messageRef = useRef<HTMLParagraphElement>(null)
  const live = useRef(props)
  live.current = props
  useEffect(() => () => { epoch.current += 1 }, [])
  useEffect(() => { epoch.current += 1; setPage(null); setLoading(null) }, [props.bookId, props.knowledgeRevision, props.disabled])
  useEffect(() => {
    if (!message) return
    messageRef.current?.focus({ preventScroll: true })
    messageRef.current?.scrollIntoView({ block: 'nearest' })
  }, [message])

  async function search(offset = 0) {
    if (props.disabled || busy) return
    const at = ++epoch.current
    setLoading({ kind: 'search', offset }); setMessage(null)
    const result = await request(() => props.api.listKnowledgeItems({ bookId: props.bookId, kind: props.kind, search: query, offset, limit: 20 }))
    if (at !== epoch.current || live.current.disabled) return
    setLoading(null)
    if (!result.ok) { setMessage(result.error.message); return }
    if (result.data.bookId !== props.bookId || result.data.knowledgeRevision !== props.knowledgeRevision ||
      result.data.items.length > 20 || result.data.items.some((item) => item.bookId !== props.bookId || item.kind !== props.kind) ||
      new Set(result.data.items.map((item) => item.id)).size !== result.data.items.length) {
      setMessage('知识库已变化，请刷新候选后重新核对实体。'); return
    }
    setPage(result.data)
  }
  async function choose(id: string) {
    if (props.disabled || busy) return
    const at = ++epoch.current
    setLoading({ kind: 'read', id }); setMessage(null)
    const result = await request(() => props.api.getKnowledgeItem({ bookId: props.bookId, id }))
    if (at !== epoch.current || live.current.disabled) return
    setLoading(null)
    if (!result.ok) { setMessage(result.error.message); return }
    const item = result.data
    if (item.bookId !== props.bookId || item.id !== id || item.kind !== props.kind || item.knowledgeRevision !== props.knowledgeRevision ||
      item.revisions[0]?.itemId !== id) { setMessage('目标身份或版本不符，请重新搜索。'); return }
    try {
      const revision = item.revisions[0]!
      requiredId(revision.id)
      const fields = parseKnowledgeFields({ kind: item.kind, name: item.name, aliases: item.aliases, summary: item.summary,
        ...(item.characterProfile === undefined ? {} : { characterProfile: item.characterProfile }),
        nature: item.nature, authorDecision: item.authorDecision, freshness: item.freshness, conflictState: item.conflictState })
      if (JSON.stringify(fields) !== JSON.stringify(parseKnowledgeFields(revision.fields))) throw new Error('Invalid revision')
      live.current.onSelect(item)
    } catch { setMessage('实体字段与固定修订无法核对，请重新读取。') }
  }
  return <div className={archive.targetPicker} role="group" aria-label="关联或修订目标实体" aria-busy={busy}>
    <label>查找已有实体（名称、别名或说明）<span className={archive.targetSearch}><StudioIcon name="search" size={20} /><input value={query} maxLength={200} disabled={props.disabled || busy}
      onChange={(event) => { setQuery(event.target.value); setPage(null) }} /></span></label>
    <button type="button" className={shared.button} aria-busy={searching} disabled={props.disabled || busy} onClick={() => void search()}>
      {searching && <span className={`${shared.spinner} ${archive.saving}`} aria-hidden="true" />}{searching ? '正在查找…' : '查找同类实体'}</button>
    {busy && <p className={styles.note} role="status">{loading.kind === 'read' ? '正在读取实体…' : '正在查找实体…'}</p>}
    {message && <p ref={messageRef} className={shared.formError} role="alert" tabIndex={-1}>{message}</p>}
    {page && <>
      <p className={styles.note}>找到 {page.total} 个候选。名称相同也可能是不同实体，请核对说明。</p>
      <ul className={archive.targetResults}>{page.items.map((item) => {
        const reading = loading?.kind === 'read' && loading.id === item.id
        return <li key={item.id}><button type="button"
          className={`${shared.button} ${archive.targetOption}`} aria-label={`选择 ${item.name}`} aria-busy={reading} disabled={props.disabled || busy}
          onClick={() => void choose(item.id)}>{reading ? <span className={`${shared.spinner} ${archive.saving}`} aria-hidden="true" /> : <StudioIcon name={targetIcons[item.kind]} size={24} />}
          <span><strong>{reading ? `正在读取 ${item.name}…` : `选择 ${item.name}`}</strong><small>{item.aliases.join('、')} · {item.summary.slice(0, 160)}</small></span>
        </button></li>
      })}</ul>
      {page.nextOffset !== null && <button type="button" className={shared.button} aria-busy={paging} disabled={props.disabled || busy}
        onClick={() => void search(page.nextOffset!)}>{paging && <span className={`${shared.spinner} ${archive.saving}`} aria-hidden="true" />}{paging ? '正在读取下一页…' : '下一页'}</button>}
    </>}
  </div>
}
