import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DomainError, requiredId, type AppError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import type { AiRun } from '../../contracts/ai'
import { MAX_CREATIVE_RESOURCES, type CreativeResourceRef } from '../../contracts/creative-resources'
import {
  MAX_STUDY_BODY, MAX_STUDY_TITLE, isStudyAdoptReceiptFor, parseStudyAdoptInput, parseStudyProposal, studyInspirationFields,
  type StudyAdoptInput, type StudyProposal, type StudyProposalItem,
} from '../../contracts/study'
import { useToolSession } from './workbench-ui'
import ui from './stellar/Workspace.module.css'
import styles from './StellarStudy.module.css'
import { isStudyCardKind, readStudyCard } from '../../contracts/study-card'
import { StudyCardEditor } from './StudyCardEditor'
import { Dialog, DialogDisplayContext } from './Dialog'
import { StudioIcon } from './StudioIcon'
import { parseInspirationFields, type InspirationFields } from '../../contracts/workbench'

export interface StudyResultsProps {
  api: StudioApi
  run: AiRun
  book: BookSnapshot
  chapterId: string
  disabled: boolean
  error?: string | null
  onDirtyChange: (dirty: boolean) => void
  onUnknown?: (error: AppError) => void
  onRecover?: () => void
  onUse?: (chapterId: string, refs: CreativeResourceRef[]) => void
}
interface Draft { id: string; kind: InspirationFields['kind']; title: string; body: string; selected: boolean; saved: boolean; archived: boolean }
const kindLabels: Record<StudyProposalItem['kind'], string> = {
  observation: '场景观察', excerpt: '摘录', technique: '手法分析', method: '方法卡', beat: '节拍骨架', style: '文风卡',
}
function readProposal(run: AiRun): { proposal: StudyProposal | null; error: string | null } {
  try {
    if (run.state !== 'succeeded' || run.purpose !== 'study' || run.bookId !== run.context.bookId) throw new Error('Invalid study run')
    return { proposal: parseStudyProposal(run.outputText, run.context), error: null }
  } catch (error) {
    return { proposal: null, error: error instanceof DomainError ? error.detail.message : '这份候选尚不能作为拆书结果审阅，请重新读取已完成的拆书候选。' }
  }
}

export function StudyResults({ api, run, book, chapterId, disabled, error, onDirtyChange, onUnknown, onRecover, onUse }: StudyResultsProps) {
  // 一次审阅固定原候选与客户端 UUID；迟到回执必须核对这份快照，不能套用到新候选。
  const [source] = useState(run)
  const [parsed] = useState(() => readProposal(run))
  const [drafts, setDrafts] = useState<Draft[]>(() => (parsed.proposal?.items ?? []).map((item) => ({
    id: crypto.randomUUID(), kind: item.kind, title: item.title, body: item.body, selected: false, saved: false, archived: false,
  })))
  const draftRef = useRef(drafts)
  const [submitted, setSubmitted] = useState<StudyAdoptInput | null>(null)
  const [discard, setDiscard] = useState(false)
  const [preserved, setPreserved] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [sourceId, setSourceId] = useState(() => run.context.creativeResources?.items[0]?.id ?? '')
  const [savedResources, setSavedResources] = useState<CreativeResourceRef[]>([])
  const [targetChapter, setTargetChapter] = useState(chapterId)
  const [useIds, setUseIds] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const needsRead = useRef(true)
  const editors = useRef(new Map<number, HTMLDetailsElement>())
  const changedRun = run.bookId !== source.bookId || run.id !== source.id || run.version !== source.version || run.state !== source.state ||
    run.outputText !== source.outputText || run.context.contextHash !== source.context.contextHash || run.context.purpose !== source.context.purpose
  function changed(values: Draft[]) {
    return values.some((draft, index) => !draft.saved && (draft.selected || draft.title !== parsed.proposal?.items[index]?.title || draft.body !== parsed.proposal?.items[index]?.body))
  }
  const tool = useToolSession({ api, disabled: disabled || changedRun, onDirtyChange, onUnknown, isProtected: () => changed(draftRef.current) })
  const locked = tool.locked || !loaded
  useEffect(() => {
    if (!disabled && needsRead.current && parsed.proposal) { needsRead.current = false; void loadSaved() }
  }, [disabled])
  async function loadSaved() {
    if (changed(draftRef.current) || tool.hasPending() || changedRun || !parsed.proposal) return
    await tool.read(() => api.readSavedStudyResults({ bookId: source.bookId, runId: source.id, expectedVersion: source.version }), (value) => {
      if (value.bookId !== source.bookId || value.runId !== source.id || value.expectedVersion !== source.version ||
        !Array.isArray(value.items) || value.items.length > parsed.proposal!.items.length ||
        new Set(value.items.map((entry) => entry.index)).size !== value.items.length ||
        new Set(value.items.map((entry) => entry.item.id)).size !== value.items.length) throw new Error('Saved study results mismatch')
      for (const entry of value.items) {
        const original = parsed.proposal!.items[entry.index], item = entry.item
        if (!original || requiredId(item.id) !== item.id || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
          !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error('Saved study item mismatch')
        const fields = parseInspirationFields(item)
        if (Object.keys(fields).some((key) => JSON.stringify(fields[key as keyof InspirationFields]) !== JSON.stringify(item[key as keyof InspirationFields]))) throw new Error('Saved study fields mismatch')
        const expected = studyInspirationFields({ bookId: source.bookId, runId: source.id, expectedVersion: source.version, entries: [] },
          source.context, original, { index: entry.index, id: item.id, title: original.title, body: original.body })
        if (entry.origin !== expected.source) throw new Error('Saved study origin mismatch')
      }
      // 只在未编辑时同步当前资料修订；首次入库历史识别身份，后续归档仍显示已入库但不允许套用。
      const saved = new Map(value.items.map((entry) => [entry.index, entry.item]))
      const next = draftRef.current.map((draft, index) => {
        const item = saved.get(index)
        return item ? { ...draft, id: item.id, kind: item.kind, title: item.title, body: item.body, saved: true, selected: false, archived: item.archived } : draft
      })
      draftRef.current = next; setDrafts(next)
      const refs: CreativeResourceRef[] = value.items.filter((entry) => !entry.item.archived)
        .map(({ item }) => ({ source: 'inspiration', id: item.id, revision: item.revision }))
      setSavedResources(refs); setUseIds(refs.slice(0, MAX_CREATIVE_RESOURCES).map((item) => item.id)); setLoaded(true)
    })
  }
  const selected = drafts.filter((draft) => draft.selected && !draft.saved).length
  const snapshot = JSON.stringify({ version: 1, bookId: source.bookId, runId: source.id, runVersion: source.version,
    requestId: tool.pending?.error.requestId ?? null, input: submitted, drafts, proposal: parsed.proposal }, null, 2)

  function edit(index: number, patch: Partial<Pick<Draft, 'title' | 'body' | 'selected'>>) {
    if (locked || drafts[index]?.saved) return
    const next = draftRef.current.map((draft, at) => at === index ? { ...draft, ...patch } : draft)
    draftRef.current = next; setDrafts(next); setSubmitted(null); setPreserved(null); setDiscard(false)
    tool.setDirty(changed(next)); tool.setError(null); tool.setNotice(null)
  }
  function discardChanges() {
    if (tool.locked || !parsed.proposal) return
    if (!discard) { setDiscard(true); return }
    const next = draftRef.current.map((draft, index) => draft.saved ? draft : {
      ...draft, title: parsed.proposal!.items[index]!.title, body: parsed.proposal!.items[index]!.body, selected: false,
    })
    draftRef.current = next; setDrafts(next); setSubmitted(null); setPreserved(null); setDiscard(false)
    tool.setDirty(false); tool.setError(null); tool.setNotice(null)
  }
  async function adopt() {
    if (locked || !parsed.proposal || !selected) return
    let input: StudyAdoptInput
    try {
      input = parseStudyAdoptInput({ bookId: source.bookId, runId: source.id, expectedVersion: source.version,
        entries: draftRef.current.flatMap((draft, index) => draft.selected && !draft.saved ? [{ index, id: draft.id, title: draft.title, body: draft.body }] : []) })
      // 界面先提示完整来源的容量问题，服务端仍会按原候选和当前来源再次独立核验。
      for (const entry of input.entries) studyInspirationFields(input, source.context, parsed.proposal.items[entry.index]!, entry)
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请检查所选条目的标题、分析和固定来源。'); return }
    setSubmitted(input); setPreserved(null); setDiscard(false)
    await tool.write('study.adopt', () => api.adoptStudyResults(input), (receipt) => isStudyAdoptReceiptFor(input, source, receipt), (receipt) => {
      const saved = new Map(receipt.items.map((item) => [item.id, item]))
      const next = draftRef.current.map((draft) => {
        const item = saved.get(draft.id)
        return item ? { ...draft, title: item.title, body: item.body, saved: true, selected: false } : draft
      })
      // 未选条目的编辑继续参与离开保护，已确认条目则不能在本次审阅中重复提交。
      draftRef.current = next; setDrafts(next); setSubmitted(null); setPreserved(null)
      const refs: CreativeResourceRef[] = receipt.items.map((item) => ({ source: 'inspiration', id: item.id, revision: item.revision }))
      setSavedResources((previous) => [...previous.filter((item) => !saved.has(item.id)), ...refs])
      setUseIds((previous) => [...new Set([...previous, ...refs.map((item) => item.id)])].slice(0, MAX_CREATIVE_RESOURCES))
    }, `已将 ${input.entries.length} 项保存至全局资料与方法库，固定引文与来源版本已保留。`)
  }
  const references = source.context.creativeResources?.items ?? []
  const reference = references.find((item) => item.id === sourceId) ?? references[0]
  const sourceItems = parsed.proposal?.items.filter((item) => item.sourceId === reference?.id) ?? []
  const categories = [
    { key: 'beat', label: '节拍骨架', kinds: ['beat'] },
    { key: 'style', label: '文风 DNA', kinds: ['style'] },
    { key: 'method', label: '技法公式', kinds: ['method', 'technique', 'observation'] },
    { key: 'excerpt', label: '佳句与词汇包', kinds: ['excerpt'] },
  ]
  function openEditor(index: number) {
    const element = editors.current.get(index)
    if (!element) return
    element.open = true; element.scrollIntoView({ block: 'start', behavior: 'instant' }); element.querySelector<HTMLElement>('summary')?.focus()
  }
  function highlightedReference() {
    const text = reference?.text ?? ''
    // 仅高亮逐字存在的固定引文；合并重叠范围，避免拼接或改写参考文本。
    const ranges = sourceItems.map((item) => ({ start: text.indexOf(item.quote), length: item.quote.length }))
      .filter((range) => range.start >= 0).sort((left, right) => left.start - right.start)
    const merged: { start: number; end: number }[] = []
    for (const range of ranges) {
      const previous = merged.at(-1), end = range.start + range.length
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, end)
      else merged.push({ start: range.start, end })
    }
    let offset = 0
    const parts = merged.map((range, index) => {
      const before = text.slice(offset, range.start); offset = range.end
      return <span key={index}>{before}<mark>{text.slice(range.start, range.end)}</mark></span>
    })
    return <>{parts}{text.slice(offset)}</>
  }
  function preview(index: number) {
    const draft = drafts[index]!
    if (!isStudyCardKind(draft.kind)) return <p>{draft.body}</p>
    try {
      const card = readStudyCard(draft.kind, draft.body, true)
      return 'beats' in card ? <ol className={styles.beats}>{card.beats.map((beat, at) => <li key={at} title={`行动：${beat.action || '待填写'}；变化：${beat.outcome || '待填写'}`}><span>{at + 1}</span><strong>{beat.title || '待填写'}</strong></li>)}</ol>
        : <dl className={styles.styleFacts}>{([['rhythm', '句式节奏'], ['dialogue', '对白组织'], ['senses', '感官偏好'], ['diction', '措辞与动词']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{card[key] || '尚未提供'}</dd></div>)}</dl>
    } catch { return <p className={ui.warning}>当前编辑需要核对格式，完整内容保留在审阅详情。</p> }
  }

  return <section className={`${ui.panel} ${styles.panel}`} aria-label="拆书结果审阅" aria-busy={tool.busy}>
    <button type="button" className={ui.button} onClick={() => setExpanded(true)}><StudioIcon name="layers" />打开拆书工坊</button>
    {expanded && createPortal(<DialogDisplayContext.Provider value="modal"><Dialog title="拆书工坊" className={`${ui.panel} ${styles.dialog}`} wide busy={tool.busy} onClose={() => setExpanded(false)}>
    {parsed.error && <p className={ui.error} role="alert">{parsed.error}</p>}
    {error && <p className={ui.error} role="alert">{error}</p>}
    {changedRun && <p className={ui.warning} role="alert">候选版本已经改变，当前审阅内容仍保留。请先复制留存，再重新打开候选。</p>}
    {tool.error && <p className={ui.error} role="alert">{tool.error}</p>}
    {!loaded && parsed.proposal && <p className={ui.muted} role="status">{tool.busy ? '正在核对已入库结果…' : '核对已有入库记录后可以继续审阅。'}</p>}
    {parsed.proposal && <div className={ui.actions}><button type="button" className={ui.button} disabled={tool.locked || changed(drafts)} onClick={() => void loadSaved()}>刷新入库状态</button>
      {tool.readFailure?.requestId && <button type="button" className={ui.button} disabled={tool.locked} onClick={() => void tool.checkReadReceipt()}>核对原读取</button>}</div>}
    {tool.notice && <p className={ui.notice} role="status">{tool.notice}</p>}
    {tool.pending && <div className={ui.warning} role="alert">
      <p>本次入库结果尚未确认。所选条目、编辑内容和入库标识已保留，确认原请求前暂停写入。</p>
      <div className={ui.actions}>{tool.pending.error.requestId && <button className={ui.button} type="button" disabled={tool.busy} onClick={() => void tool.checkReceipt()}>核对原请求</button>}</div>
      <p>若原请求已无法查询，请先复制下方审阅记录，再进入主窗口恢复流程核对全局资料。</p>
      {onRecover && <><label className={ui.check}><input type="checkbox" checked={preserved === snapshot} disabled={tool.busy} onChange={(event) => setPreserved(event.target.checked ? snapshot : null)} />我已留存当前审阅内容和入库标识</label>
        <button className={ui.button} type="button" disabled={tool.busy || preserved !== snapshot} onClick={onRecover}>打开主窗口恢复</button></>}
    </div>}
    {(tool.pending || tool.error || changedRun || changed(drafts)) && <details className={ui.details} open={Boolean(tool.pending || changedRun)}><summary>复制当前审阅记录留存</summary><textarea readOnly rows={8} value={snapshot} aria-label="拆书审阅内容与固定入库标识" /></details>}
    {parsed.error && <details className={ui.details}><summary>查看完整模型原输出</summary><pre className={styles.original}>{source.outputText}</pre></details>}
    {parsed.proposal && !parsed.proposal.items.length && <p className={ui.empty}>这次没有可入库的建议。可补充参考原文或调整拆书要求后重新生成。</p>}
    {parsed.proposal && <><div className={styles.workspace}>
      <aside className={styles.reference} aria-label="固定参考片段">
        <header><StudioIcon name="read" size={24} /><h3>参考片段 · 授权文本</h3><button type="button" className={ui.button} disabled={!sourceItems.length} title={!sourceItems.length ? '该参考暂无拆解条目' : '审阅该参考的拆解条目'} onClick={() => {
          const index = parsed.proposal!.items.findIndex((item) => item.sourceId === reference?.id)
          if (index >= 0) openEditor(index)
        }}>拆解</button></header>
        {references.length > 1 && <label>固定参考<select value={reference?.id ?? ''} onChange={(event) => setSourceId(event.target.value)}>{references.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>}
        <p className={ui.muted}>来源：{reference?.title ?? '固定来源缺失'} · v{reference?.revision ?? '未知'}</p>
        <div className={styles.referenceText}>{highlightedReference()}</div>
      </aside>
      <div className={styles.analysis}>{categories.map((category) => {
        const indexes = parsed.proposal!.items.flatMap((item, index) => category.kinds.includes(item.kind) ? [index] : [])
        return <section className={styles.analysisSection} data-kind={category.key} key={category.key} aria-label={category.label}>
          <h3><i aria-hidden="true" />{category.label}</h3>
          {!indexes.length && <p className={ui.muted}>本次未提供{category.label}。</p>}
          {indexes.map((index) => <div className={styles.analysisItem} key={index}><button type="button" className={styles.analysisTitle} onClick={() => openEditor(index)}>{drafts[index]!.title}<StudioIcon name="chevron" size={16} /></button>{preview(index)}
            <div className={styles.analysisActions}>{drafts[index]!.saved ? <label className={ui.check}><input type="checkbox" checked={useIds.includes(drafts[index]!.id)} disabled={locked || drafts[index]!.archived || (!useIds.includes(drafts[index]!.id) && useIds.length >= MAX_CREATIVE_RESOURCES)}
              title={useIds.length >= MAX_CREATIVE_RESOURCES && !useIds.includes(drafts[index]!.id) ? `最多选入 ${MAX_CREATIVE_RESOURCES} 项资料` : undefined}
              onChange={(event) => setUseIds((previous) => event.target.checked ? [...previous, drafts[index]!.id].slice(0, MAX_CREATIVE_RESOURCES) : previous.filter((id) => id !== drafts[index]!.id))} />{drafts[index]!.archived ? '已归档' : '选入创作'}</label>
              : <label className={ui.check}><input type="checkbox" checked={drafts[index]!.selected} disabled={locked} onChange={(event) => edit(index, { selected: event.target.checked })} />选择入库</label>}<button type="button" className={ui.button} onClick={() => openEditor(index)}>核对与编辑</button></div>
          </div>)}
        </section>
      })}</div>
    </div>
    <ol className={styles.results}>{parsed.proposal.items.map((item, index) => {
      const draft = drafts[index]!
      const reference = source.context.creativeResources!.items.find((resource) => resource.source === 'inspiration' && resource.id === item.sourceId)!
      const titleInvalid = !draft.title.trim() || draft.title.length > MAX_STUDY_TITLE
      const bodyInvalid = !draft.body.trim() || draft.body.length > MAX_STUDY_BODY
      return <li key={draft.id} className={styles.result}><details ref={(element) => { if (element) editors.current.set(index, element); else editors.current.delete(index) }}><summary>{index + 1}. {draft.title} · {kindLabels[item.kind]} · 审阅详情</summary>
        <div className={styles.itemHeading}><h4>{index + 1}. {kindLabels[item.kind]}</h4>
          {draft.saved ? <span className={styles.saved}>{draft.archived ? '已入库 · 已归档' : '已入库'}</span> : <label className={ui.check}><input type="checkbox" checked={draft.selected} disabled={locked} onChange={(event) => edit(index, { selected: event.target.checked })} />选择本项入库</label>}
        </div>
        <div className={styles.review}>
          <div className={styles.evidence}><p className={styles.caption}>固定原文证据</p><p className={ui.muted}>{reference.title} · 版本 {reference.revision}</p><blockquote>{item.quote}</blockquote>
            <details className={ui.details}><summary>对照完整参考原文</summary><p className={ui.identity}>来源 ID：{reference.id}</p><pre className={styles.original}>{reference.text}</pre></details>
          </div>
          <fieldset disabled={locked || draft.saved} className={styles.editor}><legend className={styles.caption}>分析与方法</legend>
            <label>标题<input value={draft.title} aria-invalid={titleInvalid} onChange={(event) => edit(index, { title: event.target.value })} /><span className={titleInvalid ? styles.invalid : ui.muted}>{draft.title.length} / {MAX_STUDY_TITLE} 字符{titleInvalid ? '，请填写有效标题' : ''}</span></label>
            {isStudyCardKind(draft.kind) ? <StudyCardEditor kind={draft.kind} body={draft.body} disabled={locked || draft.saved} onChange={(body) => edit(index, { body })} />
              : <label>分析或可复用的方法<textarea rows={7} value={draft.body} aria-invalid={bodyInvalid} onChange={(event) => edit(index, { body: event.target.value })} /></label>}
            <span className={bodyInvalid ? styles.invalid : ui.muted}>{draft.body.length} / {MAX_STUDY_BODY.toLocaleString()} 字符{bodyInvalid ? '，请调整内容后再入库' : ''}</span>
          </fieldset>
        </div>
      </details></li>
    })}</ol></>}
    {Boolean(parsed.proposal?.items.length) && <div className={styles.footer}><p className={ui.muted}>已选择 {selected} 项。入库时会再次核对参考原文是否仍为当前版本。</p>
      <div className={ui.actions}><button className={ui.primaryButton} type="button" disabled={locked || !selected} onClick={() => void adopt()}>确认将所选 {selected} 项保存至全局方法库</button>
        <button className={ui.button} type="button" disabled={tool.locked || !changed(drafts)} onClick={discardChanges}>{discard ? '确认放弃本次编辑与选择' : '放弃本次审阅更改'}</button>
        {discard && <button className={ui.button} type="button" disabled={tool.locked} onClick={() => setDiscard(false)}>继续审阅</button>}
      </div>
    </div>}
    {onUse && savedResources.length > 0 && <div className={styles.applyBar}><label>套用目标章节<select value={targetChapter} disabled={locked} onChange={(event) => setTargetChapter(event.target.value)}>{book.chapters.map((chapter) => <option value={chapter.id} key={chapter.id}>第 {chapter.position + 1} 章 · {chapter.title}</option>)}</select></label>
      <button type="button" className={ui.primaryButton} disabled={locked || changed(drafts) || !targetChapter || !useIds.length}
        title={changed(drafts) ? '请先保存或明确放弃未入库的编辑与选择' : !useIds.length ? '请先选入已入库的方法' : '把所选方法带入目标章的创作预览'}
        onClick={() => { const refs = savedResources.filter((item) => useIds.includes(item.id)); if (refs.length && !locked && !changed(drafts)) { setExpanded(false); onUse(targetChapter, refs) } }}><StudioIcon name="spark" />套用到所选章 · 生成节拍</button>
    </div>}
    </Dialog></DialogDisplayContext.Provider>, document.body)}
  </section>
}
