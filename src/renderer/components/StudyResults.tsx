import { useRef, useState } from 'react'
import { DomainError, type AppError, type StudioApi } from '../../contracts/api'
import type { AiRun } from '../../contracts/ai'
import {
  MAX_STUDY_BODY, MAX_STUDY_TITLE, isStudyAdoptReceiptFor, parseStudyAdoptInput, parseStudyProposal, studyInspirationFields,
  type StudyAdoptInput, type StudyProposal, type StudyProposalItem,
} from '../../contracts/study'
import { useToolSession } from './workbench-ui'
import ui from './WorkbenchPanel.module.css'
import styles from './StudyResults.module.css'
import { isStudyCardKind } from '../../contracts/study-card'
import { StudyCardEditor } from './StudyCardEditor'

export interface StudyResultsProps {
  api: StudioApi
  run: AiRun
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onUnknown?: (error: AppError) => void
  onRecover?: () => void
}
interface Draft { id: string; title: string; body: string; selected: boolean; saved: boolean }
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

export function StudyResults({ api, run, disabled, onDirtyChange, onUnknown, onRecover }: StudyResultsProps) {
  // 一次审阅固定原候选与客户端 UUID；迟到回执必须核对这份快照，不能套用到新候选。
  const [source] = useState(run)
  const [parsed] = useState(() => readProposal(run))
  const [drafts, setDrafts] = useState<Draft[]>(() => (parsed.proposal?.items ?? []).map((item) => ({
    id: crypto.randomUUID(), title: item.title, body: item.body, selected: false, saved: false,
  })))
  const draftRef = useRef(drafts)
  const [submitted, setSubmitted] = useState<StudyAdoptInput | null>(null)
  const [discard, setDiscard] = useState(false)
  const [preserved, setPreserved] = useState<string | null>(null)
  const changedRun = run.bookId !== source.bookId || run.id !== source.id || run.version !== source.version || run.state !== source.state ||
    run.outputText !== source.outputText || run.context.contextHash !== source.context.contextHash || run.context.purpose !== source.context.purpose
  function changed(values: Draft[]) {
    return values.some((draft, index) => !draft.saved && (draft.selected || draft.title !== parsed.proposal?.items[index]?.title || draft.body !== parsed.proposal?.items[index]?.body))
  }
  const tool = useToolSession({ api, disabled: disabled || changedRun, onDirtyChange, onUnknown, isProtected: () => changed(draftRef.current) })
  const selected = drafts.filter((draft) => draft.selected && !draft.saved).length
  const snapshot = JSON.stringify({ version: 1, bookId: source.bookId, runId: source.id, runVersion: source.version,
    requestId: tool.pending?.error.requestId ?? null, input: submitted, drafts, proposal: parsed.proposal }, null, 2)

  function edit(index: number, patch: Partial<Pick<Draft, 'title' | 'body' | 'selected'>>) {
    if (tool.locked || drafts[index]?.saved) return
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
    if (tool.locked || !parsed.proposal || !selected) return
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
    }, `已将 ${input.entries.length} 项保存至全局资料与方法库，固定引文与来源版本已保留。`)
  }

  return <section className={`${ui.panel} ${styles.panel}`} aria-label="拆书结果审阅" aria-busy={tool.busy}>
    <div className={ui.heading}><div><h3>审阅拆书结果</h3><p className={ui.muted}>逐项核对原文，编辑分析后选择入库。内容保存在当前书库的全局资料与方法库；本书知识保持独立。</p></div></div>
    {parsed.error && <p className={ui.error} role="alert">{parsed.error}</p>}
    {changedRun && <p className={ui.warning} role="alert">候选版本已经改变，当前审阅内容仍保留。请先复制留存，再重新打开候选。</p>}
    {tool.error && <p className={ui.error} role="alert">{tool.error}</p>}
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
    {parsed.proposal && <ol className={styles.results}>{parsed.proposal.items.map((item, index) => {
      const draft = drafts[index]!
      const reference = source.context.creativeResources!.items.find((resource) => resource.source === 'inspiration' && resource.id === item.sourceId)!
      const titleInvalid = !draft.title.trim() || draft.title.length > MAX_STUDY_TITLE
      const bodyInvalid = !draft.body.trim() || draft.body.length > MAX_STUDY_BODY
      return <li key={draft.id} className={styles.result}>
        <div className={styles.itemHeading}><h4>{index + 1}. {kindLabels[item.kind]}</h4>
          {draft.saved ? <span className={styles.saved}>已入库</span> : <label className={ui.check}><input type="checkbox" checked={draft.selected} disabled={tool.locked} onChange={(event) => edit(index, { selected: event.target.checked })} />选择本项入库</label>}
        </div>
        <div className={styles.review}>
          <div className={styles.evidence}><p className={styles.caption}>固定原文证据</p><p className={ui.muted}>{reference.title} · 版本 {reference.revision}</p><blockquote>{item.quote}</blockquote>
            <details className={ui.details}><summary>对照完整参考原文</summary><p className={ui.identity}>来源 ID：{reference.id}</p><pre className={styles.original}>{reference.text}</pre></details>
          </div>
          <fieldset disabled={tool.locked || draft.saved} className={styles.editor}><legend className={styles.caption}>分析与方法</legend>
            <label>标题<input value={draft.title} aria-invalid={titleInvalid} onChange={(event) => edit(index, { title: event.target.value })} /><span className={titleInvalid ? styles.invalid : ui.muted}>{draft.title.length} / {MAX_STUDY_TITLE} 字符{titleInvalid ? '，请填写有效标题' : ''}</span></label>
            {isStudyCardKind(item.kind) ? <StudyCardEditor kind={item.kind} body={draft.body} disabled={tool.locked || draft.saved} onChange={(body) => edit(index, { body })} />
              : <label>分析或可复用的方法<textarea rows={7} value={draft.body} aria-invalid={bodyInvalid} onChange={(event) => edit(index, { body: event.target.value })} /></label>}
            <span className={bodyInvalid ? styles.invalid : ui.muted}>{draft.body.length} / {MAX_STUDY_BODY.toLocaleString()} 字符{bodyInvalid ? '，请调整内容后再入库' : ''}</span>
          </fieldset>
        </div>
      </li>
    })}</ol>}
    {Boolean(parsed.proposal?.items.length) && <div className={styles.footer}><p className={ui.muted}>已选择 {selected} 项。入库时会再次核对参考原文是否仍为当前版本。</p>
      <div className={ui.actions}><button className={ui.primaryButton} type="button" disabled={tool.locked || !selected} onClick={() => void adopt()}>确认将所选 {selected} 项保存至全局方法库</button>
        <button className={ui.button} type="button" disabled={tool.locked || !changed(drafts)} onClick={discardChanges}>{discard ? '确认放弃本次编辑与选择' : '放弃本次审阅更改'}</button>
        {discard && <button className={ui.button} type="button" disabled={tool.locked} onClick={() => setDiscard(false)}>继续审阅</button>}
      </div>
    </div>}
  </section>
}
