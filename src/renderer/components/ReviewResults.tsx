import { useEffect, useRef, useState } from 'react'
import { DomainError, type StudioApi } from '../../contracts/api'
import type { AiRun } from '../../contracts/ai'
import { REVIEW_LENS_LABELS, parseReviewProposal, type ReviewProposal } from '../../contracts/review'
import { parseSaveReviewIssueInput, type SaveReviewIssueInput, type WorkbenchSnapshot } from '../../contracts/workbench'
import { sameFields, useToolSession } from './workbench-ui'
import { AiTextDiff } from './AiTextDiff'
import ui from './WorkbenchPanel.module.css'

interface Draft { id: string; reason: string; suggestion: string; replacement: string }
interface Props {
  api: StudioApi; run: AiRun; bookRevision: number; disabled: boolean; onDirtyChange: (value: boolean) => void
  onChanged: (value: WorkbenchSnapshot) => Promise<void>; onRecover: () => void
}

export function ReviewResults({ api, run, bookRevision, disabled, onDirtyChange, onChanged, onRecover }: Props) {
  const [source] = useState(run)
  const [parsed] = useState<{ proposal: ReviewProposal | null; error: string | null }>(() => {
    try { return { proposal: parseReviewProposal(run.outputText, run.context), error: null } }
    catch (error) { return { proposal: null, error: error instanceof DomainError ? error.detail.message : '无法核对这次审稿结果。' } }
  })
  const [drafts, setDrafts] = useState<Draft[]>(() => parsed.proposal?.items.map((item) => ({ id: crypto.randomUUID(), reason: item.reason, suggestion: item.suggestion, replacement: item.replacement })) ?? [])
  const draftsRef = useRef(drafts)
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null)
  const snapshotRef = useRef(snapshot)
  const [submitted, setSubmitted] = useState<SaveReviewIssueInput | null>(null)
  const [sync, setSync] = useState(false)
  const [syncRequestId, setSyncRequestId] = useState<string | null>(null)
  const syncBusy = useRef(false)
  const syncRef = useRef(false)
  const [preserved, setPreserved] = useState(false)
  const [discard, setDiscard] = useState(false)
  const needsRead = useRef(true)
  const mounted = useRef(true)
  const changedRun = source.id !== run.id || source.version !== run.version || source.outputText !== run.outputText || source.context.contextHash !== run.context.contextHash
  const savedItem = (index: number, value = snapshotRef.current) => value?.issues.find((item) => item.aiRunId === source.id && item.candidateSource?.index === index)
  function hasEdits(values: Draft[]) {
    return values.some((draft, index) => !savedItem(index) && (draft.reason !== parsed.proposal?.items[index]?.reason || draft.suggestion !== parsed.proposal?.items[index]?.suggestion || draft.replacement !== parsed.proposal?.items[index]?.replacement))
  }
  const tool = useToolSession({ api, disabled: disabled || changedRun, onDirtyChange, isProtected: () => syncRef.current || hasEdits(draftsRef.current) })
  const blocked = tool.locked || sync || !snapshot || snapshot.requiresUpgrade || snapshot.archived || snapshot.bookRevision !== bookRevision
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; needsRead.current = true } }, [])
  useEffect(() => { if (!disabled && needsRead.current && parsed.proposal) { needsRead.current = false; void load() } }, [disabled])
  async function load() {
    if (tool.hasChanges() || tool.hasPending() || syncRef.current) return
    await tool.read(() => api.getWorkbench({ bookId: source.bookId }), (value) => {
      if (value.bookId !== source.bookId || value.bookRevision < bookRevision || !Array.isArray(value.issues)) throw new Error('Review snapshot mismatch')
      snapshotRef.current = value; setSnapshot(value)
    })
  }
  function edit(index: number, patch: Partial<Pick<Draft, 'reason' | 'suggestion' | 'replacement'>>) {
    if (blocked || savedItem(index)) return
    const next = draftsRef.current.map((item, at) => at === index ? { ...item, ...patch } : item)
    draftsRef.current = next; setDrafts(next); setDiscard(false); setPreserved(false); tool.setDirty(hasEdits(next)); tool.setNotice(null)
  }
  async function synchronize(value = snapshotRef.current) {
    if (!value || !syncRef.current || syncRequestId || syncBusy.current) return
    syncBusy.current = true
    try {
      await onChanged(value)
      if (!mounted.current) return
      syncRef.current = false; setSync(false); setSubmitted(null); tool.setDirty(hasEdits(draftsRef.current)); tool.setError(null)
    } catch (error) {
      if (mounted.current) {
        if (error instanceof DomainError && error.detail.requestId) setSyncRequestId(error.detail.requestId)
        tool.setError(`问题写入已确认，作品信息仍待同步。${error instanceof DomainError ? error.detail.message : '请重试同步或留存后恢复。'}`)
      }
    } finally { syncBusy.current = false }
  }
  async function checkSync() {
    if (!syncRequestId || syncBusy.current) return
    await tool.read(() => api.getRequestStatus({ requestId: syncRequestId }), (value) => {
      if (value.state !== 'completed') { tool.setError('原同步读取仍待核对。请稍后再查，或留存后进入恢复。'); return }
      if (value.response.command !== 'knowledge.status' && value.response.command !== 'book.get') throw new Error('Sync request mismatch')
      if (!value.response.result.ok && ['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(value.response.result.error.code)) return
      setSyncRequestId(null); tool.setNotice('原同步读取已结束，可重新同步作品信息。')
    })
  }
  async function save(index: number, status: 'open' | 'dismissed' | 'intentional') {
    if (blocked || !parsed.proposal || !snapshot || savedItem(index)) return
    const item = parsed.proposal.items[index]!, draft = draftsRef.current[index]!
    let input: SaveReviewIssueInput
    try {
      input = parseSaveReviewIssueInput({ bookId: source.bookId, expectedBookRevision: snapshot.bookRevision, id: draft.id, expectedRevision: 0,
        fields: { title: item.title, kind: item.kind, status, reason: draft.reason, evidence: item.quote, suggestion: draft.suggestion, replacement: draft.replacement,
          resolution: status === 'dismissed' ? '作者已审阅，暂不采用此建议。' : status === 'intentional' ? '作者确认这是有意安排，保留原稿。' : '',
          anchor: { chapterId: source.chapterId, revisionId: source.context.chapterRevisionId, blockIds: item.blockIds }, aiRunId: source.id,
          candidateSource: { version: 1, index, runVersion: source.version, contextHash: source.context.contextHash, item } } })
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '请检查问题内容。'); return }
    setSubmitted(input); setPreserved(false)
    const success = await tool.write('workbench.issue', () => api.saveReviewIssue(input), (value) => {
      const saved = value?.issues?.find((issue) => issue.id === input.id)
      return value.bookId === input.bookId && value.bookRevision === input.expectedBookRevision + 1 && Boolean(saved && saved.revision === 1 && sameFields(saved, input.fields))
    }, (value) => { snapshotRef.current = value; setSnapshot(value); syncRef.current = true; setSync(true) }, status === 'open' ? '已登记。可在审稿清单中查看差异并确认替换。' : '已保存作者决定，正文保持原样。')
    if (success) await synchronize()
  }
  function discardEdits() {
    if (tool.locked || sync) return
    if (!discard) { setDiscard(true); return }
    const next = draftsRef.current.map((draft, index) => {
      const item = parsed.proposal!.items[index]!
      return savedItem(index) ? draft : { ...draft, reason: item.reason, suggestion: item.suggestion, replacement: item.replacement }
    })
    draftsRef.current = next; setDrafts(next); setDiscard(false); tool.setDirty(false)
  }
  return <section className={ui.panel} aria-label="审稿候选逐项审阅" aria-busy={tool.busy}>
    <h3>审阅本次建议</h3><p className={ui.muted}>读者角度属于模型建议。登记、忽略或标为刻意安排均保留固定来源；替换正文须另行查看差异并确认。</p>
    {parsed.error && <p className={ui.warning} role="alert">{parsed.error}</p>}
    {changedRun && <p className={ui.warning}>候选版本已变化，当前编辑仍保留。请先留存后重新打开结果。</p>}
    {tool.error && <p className={ui.error} role="alert">{tool.error}</p>}{tool.notice && <p className={ui.notice} role="status">{tool.notice}</p>}
    {tool.pending && <div className={ui.warning}><p>登记结果尚未确认。请先查询原请求，当前表单和标识已保留。</p><button className={ui.button} type="button" disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void tool.checkReceipt()}>核对原请求</button></div>}
    {syncRequestId && <button className={ui.button} type="button" disabled={disabled || tool.busy} onClick={() => void checkSync()}>核对原同步读取</button>}
    {sync && <button className={ui.button} type="button" disabled={disabled || tool.busy || Boolean(syncRequestId)} onClick={() => void synchronize()}>同步作品信息</button>}
    {snapshot && snapshot.bookRevision !== bookRevision && !sync && <p className={ui.warning}>作品版本已变化，当前编辑保留。请处理编辑后刷新，再登记。</p>}
    <div className={ui.actions}><button className={ui.button} type="button" disabled={tool.locked || sync || tool.dirty} onClick={() => void load()}>刷新审稿清单</button>
      {hasEdits(drafts) && <button className={ui.button} type="button" disabled={tool.locked || sync} onClick={discardEdits}>{discard ? '确认放弃未登记编辑' : '放弃未登记编辑'}</button>}</div>
    {(tool.pending || sync || changedRun || hasEdits(drafts)) && <details className={ui.details}><summary>留存本次审阅内容</summary><textarea readOnly rows={8} value={JSON.stringify({ bookId: source.bookId, runId: source.id, runVersion: source.version, requestId: tool.pending?.error.requestId, syncRequestId, input: submitted, drafts }, null, 2)} />
      <label className={ui.check}><input type="checkbox" checked={preserved} onChange={(event) => setPreserved(event.target.checked)} />我已留存输入和登记标识</label><button className={ui.button} type="button" disabled={tool.busy || !preserved} onClick={onRecover}>进入恢复</button></details>}
    {parsed.proposal?.items.length === 0 && <p className={ui.empty}>本次没有可定位的建议。这不代表全书没有问题。</p>}
    {parsed.proposal?.items.map((item, index) => {
      const draft = drafts[index]!, saved = savedItem(index)
      const original = item.blockIds.map((id) => source.context.chapterBlocks.find((block) => block.blockId === id)?.text ?? '').join('\n\n')
      return <article className={ui.panel} key={draft.id}><h4>{index + 1}. {item.title} · {REVIEW_LENS_LABELS[item.lens]}</h4>
        {item.requirement ? <blockquote>章纲要求：{item.requirement.text}<p className={ui.identity}>固定大纲修订 {item.requirement.revisionId}</p></blockquote> : <blockquote>{item.quote}<p className={ui.identity}>固定正文修订 {source.context.chapterRevisionId} · {item.blockIds.length} 个段落</p></blockquote>}
        <p>可能的反证或其他解释：{item.counterpoint || '模型未提供，请作者另行核对。'}</p>
        <fieldset disabled={blocked || Boolean(saved)} className={ui.fields}>
          <label>理由<textarea value={draft.reason} rows={3} maxLength={10000} onChange={(event) => edit(index, { reason: event.target.value })} /></label>
          <label>修改方向<textarea value={draft.suggestion} rows={3} maxLength={20000} onChange={(event) => edit(index, { suggestion: event.target.value })} /></label>
          {!item.requirement && <label>替换正文（可留空）<textarea value={draft.replacement} rows={4} maxLength={20000} onChange={(event) => edit(index, { replacement: event.target.value })} /></label>}
        </fieldset>
        {draft.replacement.trim() && !item.requirement && <AiTextDiff originalText={original} suggestedText={draft.replacement} disabled={blocked || Boolean(saved)} onAcceptText={(replacement) => edit(index, { replacement })} />}
        {saved ? <p className={ui.notice}>已登记：{saved.status === 'dismissed' ? '已忽略' : saved.status === 'intentional' ? '刻意安排' : '在审稿清单中继续处理'}</p>
          : <div className={ui.actions}><button className={ui.primaryButton} type="button" disabled={blocked} onClick={() => void save(index, 'open')}>登记问题</button><button className={ui.button} type="button" disabled={blocked} onClick={() => void save(index, 'dismissed')}>记录为忽略</button><button className={ui.button} type="button" disabled={blocked} onClick={() => void save(index, 'intentional')}>这是刻意安排</button></div>}
      </article>
    })}
  </section>
}
