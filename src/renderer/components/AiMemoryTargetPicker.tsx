import { useEffect, useRef, useState } from 'react'
import { requiredId, type StudioApi } from '../../contracts/api'
import { parseKnowledgeFields, type KnowledgeItemDetail, type KnowledgeItemPage, type KnowledgeKind } from '../../contracts/knowledge'
import { request } from '../request'
import shared from '../App.module.css'
import styles from './AiPanel.module.css'

interface Props {
  api: StudioApi
  bookId: string
  knowledgeRevision: number
  kind: KnowledgeKind
  name: string
  disabled: boolean
  onSelect: (item: KnowledgeItemDetail) => void
}

/** 名称与别名搜索只提供候选，由作者明确选择身份；异步回执不能覆盖后来切换的审阅。 */
export function AiMemoryTargetPicker(props: Props) {
  const [query, setQuery] = useState(props.name)
  const [page, setPage] = useState<KnowledgeItemPage | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  const live = useRef(props)
  live.current = props
  useEffect(() => () => { epoch.current += 1 }, [])
  useEffect(() => { epoch.current += 1; setPage(null); setBusy(false) }, [props.bookId, props.knowledgeRevision, props.disabled])

  async function search(offset = 0) {
    if (props.disabled || busy) return
    const at = ++epoch.current
    setBusy(true); setMessage(null)
    const result = await request(() => props.api.listKnowledgeItems({ bookId: props.bookId, kind: props.kind, search: query, offset, limit: 20 }))
    if (at !== epoch.current || live.current.disabled) return
    setBusy(false)
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
    setBusy(true); setMessage(null)
    const result = await request(() => props.api.getKnowledgeItem({ bookId: props.bookId, id }))
    if (at !== epoch.current || live.current.disabled) return
    setBusy(false)
    if (!result.ok) { setMessage(result.error.message); return }
    const item = result.data
    if (item.bookId !== props.bookId || item.id !== id || item.kind !== props.kind || item.knowledgeRevision !== props.knowledgeRevision ||
      item.revisions[0]?.itemId !== id) { setMessage('目标身份或版本不符，请重新搜索。'); return }
    try {
      const revision = item.revisions[0]!
      requiredId(revision.id)
      const fields = parseKnowledgeFields({ kind: item.kind, name: item.name, aliases: item.aliases, summary: item.summary,
        nature: item.nature, authorDecision: item.authorDecision, freshness: item.freshness, conflictState: item.conflictState })
      if (JSON.stringify(fields) !== JSON.stringify(parseKnowledgeFields(revision.fields))) throw new Error('Invalid revision')
      live.current.onSelect(item)
    } catch { setMessage('实体字段与固定修订无法核对，请重新读取。') }
  }
  return <div>
    <label>查找已有实体（名称、别名或说明）<input value={query} maxLength={200} disabled={props.disabled || busy}
      onChange={(event) => { setQuery(event.target.value); setPage(null) }} /></label>
    <button type="button" className={shared.button} disabled={props.disabled || busy} onClick={() => void search()}>查找同类实体</button>
    {busy && <p className={styles.note} role="status">正在读取实体…</p>}
    {message && <p className={shared.formError} role="alert">{message}</p>}
    {page && <>
      <p className={styles.note}>找到 {page.total} 个候选。名称相同也可能是不同实体，请核对说明。</p>
      {page.items.map((item) => <p key={item.id}><button type="button" className={shared.button} disabled={props.disabled || busy}
        onClick={() => void choose(item.id)}>选择 {item.name}</button> {item.aliases.join('、')} · {item.summary.slice(0, 160)}</p>)}
      {page.nextOffset !== null && <button type="button" className={shared.button} disabled={props.disabled || busy}
        onClick={() => void search(page.nextOffset!)}>下一页</button>}
    </>}
  </div>
}
