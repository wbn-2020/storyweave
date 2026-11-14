import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DomainError, type BookSnapshot } from '../../contracts/api'
import {
  KNOWLEDGE_RESOLUTIONS, MAX_KNOWLEDGE_ADJUDICATIONS, knowledgeAdjudicationFields, parseUpdateKnowledgeItem,
  type KnowledgeItemDetail, type KnowledgeResolution, type KnowledgeSource, type UpdateKnowledgeItemInput,
} from '../../contracts/knowledge'
import { displayTime } from '../request'
import { StudioIcon } from './StudioIcon'
import shared from '../StellarShared.module.css'
import styles from './StellarAdjudication.module.css'

interface Props {
  book: BookSnapshot
  detail: KnowledgeItemDetail
  disabled: boolean
  onUpdate: (input: UpdateKnowledgeItemInput, accept: (saved: KnowledgeItemDetail) => void) => Promise<void>
  onSaved: (saved: KnowledgeItemDetail) => void
  onDirtyChange: (dirty: boolean) => void
  onDraftChange: (draft: string | null) => void
  onShowSource: (source: KnowledgeSource) => void
  onBack: () => void
}

const resolutionLabels: Record<KnowledgeResolution, string> = { keep_a: '保留 A', keep_b: '保留 B', intentional: '标为有意安排' }
const resolutionIcons = { keep_a: 'read', keep_b: 'read', intentional: 'warning' } as const

function sourceTitle(source: KnowledgeSource, book: BookSnapshot): string {
  if (source.sourceType !== 'chapter_text') return source.sourceType === 'author_input' ? '作者输入' : '外部资料'
  const chapter = book.chapters.find((entry) => entry.id === source.chapterId)
  return chapter ? `第 ${chapter.position + 1} 章 · ${chapter.title}` : `章节 ${source.chapterId}`
}

export function KnowledgeAdjudicationPanel(props: Props) {
  const { detail, book } = props
  const [aId, setAId] = useState(''), [bId, setBId] = useState('')
  const [resolution, setResolution] = useState<KnowledgeResolution | null>(null)
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [writing, setWriting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [historyLimit, setHistoryLimit] = useState(20)
  const operationId = useRef(crypto.randomUUID())
  const lock = useRef(false), mounted = useRef(false), live = useRef(props)
  live.current = props
  const a = detail.sources.find((source) => source.id === aId), b = detail.sources.find((source) => source.id === bId)
  const dirty = Boolean(aId || bId || resolution || note)
  const disabled = props.disabled || writing
  const archived = Boolean(book.book.archivedAt)
  const currentRevision = detail.revisions[0]
  const stale = detail.bookRevision !== book.book.revision
  const history = detail.adjudications ?? []
  const complete = Boolean(a && b && a.id !== b.id && a.validity === 'valid' && b.validity === 'valid')
  const preview = complete && resolution && a && b ? knowledgeAdjudicationFields(detail, a, b, resolution) : null
  const draft = JSON.stringify({ format: 'storyweave-knowledge-adjudication-draft', version: 1,
    operation: 'knowledge.update', bookId: detail.bookId, itemId: detail.id, expectedKnowledgeRevision: detail.knowledgeRevision,
    expectedBookRevision: detail.bookRevision, expectedItemRevisionId: currentRevision?.id ?? null,
    adjudicationId: operationId.current, sourceA: a ?? null, sourceB: b ?? null, resolution, note, fields: preview,
    previousSummary: detail.summary, previousAuthorDecision: detail.authorDecision, previousConflictState: detail.conflictState }, null, 2)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; live.current.onDirtyChange(false); live.current.onDraftChange(null) }
  }, [])
  useEffect(() => {
    live.current.onDirtyChange(dirty)
    live.current.onDraftChange(dirty ? draft : null)
  }, [dirty, draft])

  function changed(markDirty = true) {
    setConfirmed(false); setMessage(null)
    if (markDirty) live.current.onDirtyChange(true)
  }
  function discard() {
    if (disabled || lock.current) return
    setAId(''); setBId(''); setResolution(null); setNote(''); changed(false)
    live.current.onDirtyChange(false); live.current.onDraftChange(null)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (disabled || lock.current || archived || stale || !confirmed || !complete || !preview || !currentRevision || !resolution ||
        history.length >= MAX_KNOWLEDGE_ADJUDICATIONS) return
    let input: UpdateKnowledgeItemInput
    try {
      input = parseUpdateKnowledgeItem({ bookId: detail.bookId, id: detail.id, expectedKnowledgeRevision: detail.knowledgeRevision,
        fields: preview, adjudication: { id: operationId.current, expectedBookRevision: detail.bookRevision,
          expectedItemRevisionId: currentRevision.id, sourceAId: aId, sourceBId: bId, resolution, note } })
    } catch (error) {
      setMessage(error instanceof DomainError ? error.detail.message : '裁决内容无效，请重新核对。'); return
    }
    lock.current = true; setWriting(true); setMessage(null)
    try {
      // 统一写入入口核对固定裁决回执；超时沿用原请求查询，草稿不能当作成功而清空。
      await props.onUpdate(input, (saved) => {
        if (!mounted.current) return
        live.current.onDirtyChange(false); live.current.onDraftChange(null); live.current.onSaved(saved)
      })
    } catch { if (mounted.current) setMessage('裁决结果尚未确认，请保留草稿并核对原回执。') }
    finally { lock.current = false; if (mounted.current) setWriting(false) }
  }

  return <section className={styles.panel} aria-label="知识冲突裁决" aria-busy={writing}>
    <header className={styles.header}>
      <div><h3><StudioIcon name="warning" size={24} />冲突裁决</h3><p>{detail.name}</p></div>
      <button className={shared.button} type="button" disabled={disabled || dirty} onClick={props.onBack}><StudioIcon name="arrow" size={16} />返回设定详情</button>
    </header>
    {archived && <p className={shared.helpText}>作品已归档，当前仅可查阅裁决历史。</p>}
    {stale && <p className={shared.inlineNotice}>作品版本已变化。请先保留或放弃草稿，返回详情重新读取后再裁决。</p>}
    {detail.sources.filter((source) => source.validity === 'valid').length < 2 && <p className={shared.inlineNotice}>尚无两条可核对的来源。返回编辑卡片，追加来源后再进行裁决。</p>}
    {history.length >= MAX_KNOWLEDGE_ADJUDICATIONS && <p className={shared.inlineNotice}>本条目的裁决记录已达 {MAX_KNOWLEDGE_ADJUDICATIONS} 条上限，现有证据与历史可继续查阅。</p>}
    <form onSubmit={(event) => void save(event)}>
      <div className={styles.comparison}>
        {(['A', 'B'] as const).map((side) => {
          const selected = side === 'A' ? a : b, value = side === 'A' ? aId : bId, other = side === 'A' ? bId : aId
          return <section key={side} className={styles.evidence} data-side={side} aria-label={`证据 ${side}`}>
            <label>证据 {side}<select value={value} disabled={disabled || archived} onChange={(event) => {
              if (side === 'A') setAId(event.target.value); else setBId(event.target.value)
              setResolution(null); changed()
            }}><option value="">选择已登记来源</option>{detail.sources.map((source, index) => <option key={source.id} value={source.id} disabled={source.id === other || source.validity !== 'valid'}>
              {index + 1}. {sourceTitle(source, book)} · {source.quote.slice(0, 45)}{source.validity !== 'valid' ? '（出处待补全）' : ''}
            </option>)}</select></label>
            {selected ? <>
              <strong><StudioIcon name="read" size={18} />{sourceTitle(selected, book)}</strong>
              <blockquote>{selected.quote}</blockquote>
              <small>{selected.sourceType === 'chapter_text' ? `${selected.referenceState === 'historical' ? '引用历史稿' : '引用固定正文稿'} · ${selected.validity === 'valid' ? '出处可查' : '出处待复核'}` : '手工来源记录，不代表正文事实'}</small>
              {selected.sourceType === 'chapter_text' && <><code>修订 {selected.revisionId}<br />段落 {selected.blockId}</code>
                <button className={shared.textButton} type="button" disabled={disabled} onClick={() => props.onShowSource(selected)}>查看此版本原文</button></>}
            </> : <p className={styles.emptyEvidence}>尚未选择证据 {side}</p>}
          </section>
        })}
        <span className={styles.versus} aria-hidden="true">VS</span>
      </div>
      <div className={styles.decisions} role="group" aria-label="作者裁决">
        {KNOWLEDGE_RESOLUTIONS.map((value) => <button key={value} type="button" className={`${shared.button} ${styles.decision}`}
          data-resolution={value} aria-pressed={resolution === value} disabled={disabled || archived || stale || !complete || history.length >= MAX_KNOWLEDGE_ADJUDICATIONS}
          onClick={() => { if (value !== resolution) { setResolution(value); changed() } }}>
          <StudioIcon name={resolutionIcons[value]} size={20} />{resolutionLabels[value]}
        </button>)}
      </div>
      {preview && resolution && <section className={styles.confirmation} aria-label="确认裁决">
        <h4>{resolutionLabels[resolution]}</h4>
        <p>{resolution === 'intentional' ? '当前说明与采纳状态保留，冲突记为作者已解释，请说明这一安排。' : `将当前说明替换为证据 ${resolution === 'keep_a' ? 'A' : 'B'} 的引文，记为作者已采纳、冲突已解释。知识性质、档案与两侧原出处保留。`}</p>
        <div className={styles.fieldPreview}><div><h5>当前说明</h5><p>{detail.summary || '尚未填写说明。'}</p></div><div><h5>裁决后说明</h5><p>{preview.summary || '尚未填写说明。'}</p></div></div>
        <label>裁决说明{resolution === 'intentional' ? '（必填）' : '（选填）'}<textarea rows={3} maxLength={2000} value={note} required={resolution === 'intentional'} disabled={disabled || archived} onChange={(event) => { setNote(event.target.value); changed() }} /></label>
        <label className={`${shared.checkLabel} ${styles.confirmCheck}`}><input type="checkbox" checked={confirmed} disabled={disabled || archived} onChange={(event) => setConfirmed(event.target.checked)} />我已核对两侧固定来源与修改结果，确认保存此裁决。</label>
        <button className={shared.primaryButton} type="submit" disabled={disabled || archived || stale || !confirmed || (resolution === 'intentional' && !note.trim())}>
          <StudioIcon name="save" size={18} />{writing ? '正在保存裁决…' : '确认保存裁决'}
        </button>
      </section>}
      {message && <p className={shared.formError} role="alert">{message}</p>}
      {dirty && <div className={styles.draftActions}><span role="status">裁决尚未保存</span><button className={shared.button} type="button" disabled={disabled} onClick={discard}>放弃本次裁决</button></div>}
    </form>
    <section className={styles.history} aria-label="已保存裁决">
      <h4><StudioIcon name="history" size={20} />已保存裁决 · {history.length}</h4>
      {history[0]?.revisionId === currentRevision?.id && <p className={shared.helpText} role="status">裁决已保存，两侧原出处和前后修订已留存。</p>}
      {!history.length && <p className={shared.helpText}>尚无已保存的独立裁决。</p>}
      <ol>{history.slice(0, historyLimit).map((entry) => <li key={entry.id}>
        <details><summary><strong>{resolutionLabels[entry.resolution]}</strong><time dateTime={entry.createdAt}>{displayTime(entry.createdAt)}</time>
          <span>{entry.revisionId === currentRevision?.id ? '当前条目修订' : '固定历史裁决，之后已有条目修订'}</span></summary>
          <div className={styles.historyEvidence}>{[entry.sourceAId, entry.sourceBId].map((id, index) => {
            const source = detail.sources.find((value) => value.id === id)
            return <div key={id}><strong>证据 {index === 0 ? 'A' : 'B'}{source ? ` · ${sourceTitle(source, book)}` : ''}</strong>
              <blockquote>{source?.quote ?? '来源身份无法核对，请重新读取。'}</blockquote>
              {source?.sourceType === 'chapter_text' && <button className={shared.textButton} type="button" disabled={disabled} onClick={() => props.onShowSource(source)}>查看此版本原文</button>}
            </div>
          })}</div>
          <p className={styles.note}>{entry.note || '未另附裁决说明。'}</p>
          <code>裁决 {entry.id}<br />前修订 {entry.previousRevisionId}<br />后修订 {entry.revisionId}<br />作品版本 {entry.bookRevision} · 知识版本 {entry.knowledgeRevision}</code>
        </details>
      </li>)}</ol>
      {historyLimit < history.length && <button className={shared.button} type="button" disabled={disabled} onClick={() => setHistoryLimit((value) => value + 20)}>再显示 20 条裁决</button>}
    </section>
  </section>
}
