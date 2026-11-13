import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DomainError, type StudioApi } from '../../contracts/api'
import type { AiRun } from '../../contracts/ai'
import { REVIEW_LENS_LABELS, parseReviewProposal, type ReviewProposal } from '../../contracts/review'
import { parseSaveReviewIssueInput, type ReviewIssue, type SaveReviewIssueInput, type WorkbenchSnapshot } from '../../contracts/workbench'
import { sameFields, useToolSession } from './workbench-ui'
import { AiTextDiff } from './AiTextDiff'
import { Dialog, DialogDisplayContext } from './Dialog'
import { StudioIcon } from './StudioIcon'
import ui from './StellarPlanning.module.css'
import styles from './StellarReview.module.css'

interface Draft { id: string; reason: string; suggestion: string; replacement: string }
interface Props {
  api: StudioApi; run: AiRun; bookRevision: number; disabled: boolean; error?: string | null; onDirtyChange: (value: boolean) => void
  onChanged: (value: WorkbenchSnapshot) => Promise<void>; onRecover: () => void
  onOpenChecklist?: (issueId?: string) => void
  taskControls?: { disabled: boolean; onCancel: () => void; onInterrupt: () => void; onRefresh: () => void; onRetry?: () => void }
}

const readerLenses = [
  { key: 'pace', name: '爽点党', icon: 'flame' },
  { key: 'logic', name: '考据党', icon: 'read' },
  { key: 'emotion', name: 'CP 党', icon: 'rings' },
] as const

function decisionLabel(issue?: ReviewIssue): string {
  if (!issue) return '待作者审阅'
  const status = { open: issue.application ? '待处理' : '已采纳待应用', dismissed: '已忽略', intentional: '刻意安排', recheck: '待复核', resolved: '已解决' }[issue.status]
  return issue.application ? `${issue.applicationCurrent ? '建议已应用' : '曾应用，正文已有新版本'} · ${status}` : status
}

function ReviewWorkspace({ source, proposal, state, caption, readerNotice, selected = null, onFocusIssue, savedItem, onBlockRef }: {
  source: AiRun; proposal: ReviewProposal | null; state: string; caption: string; readerNotice?: string
  selected?: number | null; onFocusIssue?: (index: number) => void; savedItem?: (index: number) => ReviewIssue | undefined
  onBlockRef?: (id: string, element: HTMLDivElement | null) => void
}) {
  const reviewItems = proposal?.items ?? []
  return <div className={styles.workspace}>
    <section className={styles.manuscript} aria-label="审稿固定稿件"><header><StudioIcon name="notes" size={24} /><h3>{source.context.chapterTitle}</h3><span className={styles.reviewState} role="status"><StudioIcon name={proposal ? 'check' : 'clock'} size={14} />{state}</span></header>
      <p className={styles.sourceCaption}>{caption}</p>
      <div className={styles.manuscriptScroll}>{source.context.chapterBlocks.map((block) => {
        const indexes = reviewItems.flatMap((item, index) => item.blockIds.includes(block.blockId) ? [index] : [])
        const selectedItem = selected === null ? undefined : reviewItems[selected], quote = selectedItem?.blockIds.includes(block.blockId) ? selectedItem.quote : undefined
        const start = quote ? block.text.indexOf(quote) : -1
        return <div className={styles.manuscriptBlock} data-selected={selectedItem?.blockIds.includes(block.blockId)} key={block.blockId} ref={(element) => onBlockRef?.(block.blockId, element)}>
          <p>{start >= 0 && quote ? <>{block.text.slice(0, start)}<mark>{quote}</mark>{block.text.slice(start + quote.length)}</> : block.text}</p>
          <aside>{indexes.map((index) => <button type="button" key={index} className={styles.annotation} data-lens={reviewItems[index]!.lens} aria-label={`批注 ${index + 1}：${reviewItems[index]!.title}`} aria-pressed={selected === index} onClick={() => onFocusIssue?.(index)}><span>{index + 1}</span>{reviewItems[index]!.title}</button>)}</aside>
        </div>
      })}</div>
    </section>
    <aside className={styles.readers} aria-label="试读间"><h3><StudioIcon name="users" size={24} />试读间<StudioIcon name="chart" size={20} /></h3>
      {readerLenses.map((lens) => {
        const indexes = reviewItems.flatMap((item, index) => item.lens === lens.key ? [index] : [])
        const feedback = proposal?.readers?.find((reader) => reader.lens === lens.key)
        const score = feedback?.score ?? null
        return <section className={styles.reader} data-lens={lens.key} key={lens.key}>
          <header><span className={styles.readerSymbol}><StudioIcon name={lens.icon} size={40} /></span><h4>{lens.name}</h4>
            <span className={styles.readerScore} data-unknown={score === null} title="模型主观试读评分，满分 10 分" aria-label={score === null ? proposal ? '模型评分未提供' : '尚无已核对的模型评分' : `模型主观评分 ${score.toFixed(1)}，满分 10 分`}><StudioIcon name="star" size={20} />{score === null ? <small>{source.state === 'running' ? '待完成' : source.state === 'succeeded' ? '未提供' : '未载入'}</small> : score.toFixed(1)}</span></header>
          <p className={styles.readerComment}>{feedback?.comment || readerNotice || (indexes.length ? reviewItems[indexes[0]!]!.title : '本次未提供该角度的短评。')}</p>
          <div className={styles.comments}>{indexes.map((index) => <div key={index} data-selected={selected === index}>
            {indexes.length > 1 && <p>{reviewItems[index]!.title}</p>}
            <button type="button" className={styles.locateButton} onClick={() => onFocusIssue?.(index)} aria-label={`定位并改写：${reviewItems[index]!.title}`}><StudioIcon name="focus" size={18} />定位并改写</button>
            <small>{decisionLabel(savedItem?.(index))}</small></div>)}</div>
          {score !== null && <svg className={styles.scoreRing} width="36" height="36" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="14" /><circle cx="18" cy="18" r="14" pathLength="100" strokeDasharray={`${score * 10} 100`} /></svg>}
        </section>
      })}
      {reviewItems.some((item) => item.lens === 'editor') && <details className={styles.editorOpinions}><summary>综合审稿 · {reviewItems.filter((item) => item.lens === 'editor').length} 条</summary>{reviewItems.map((item, index) => item.lens === 'editor' ? <button type="button" className={ui.button} key={index} onClick={() => onFocusIssue?.(index)}>{item.title}</button> : null)}</details>}
    </aside>
  </div>
}

export function ReviewResults(props: Props) {
  const [expanded, setExpanded] = useState(true)
  const { run, disabled, error, taskControls } = props
  // 成功后才挂载固定候选编辑器，流式检查点不会被当成完整 JSON，也不会冻结为旧来源。
  if (run.state === 'succeeded') return <ReviewCompletedResults {...props} expanded={expanded} onExpandedChange={setExpanded} />
  const running = run.state === 'running', orphaned = running && run.active === false
  const state = run.state === 'running' ? orphaned ? '审稿待核对' : '审稿中'
    : ({ prepared: '等待发送', failed: '审稿失败', cancelled: '已取消', interrupted: '已中断', rejected: '已拒绝', adopted: '已采用' } as const)[run.state]
  const notice = running ? orphaned ? '任务记录尚未结束，当前桌面已无活动请求。请核对后明确标记中断。' : '正在审阅固定稿件，评分与批注待任务成功后核对。'
    : run.state === 'rejected' ? '作者已拒绝这份提议。原输入、原输出与已登记的审稿决定仍保留。'
      : '本次审稿未成功结束，部分输出不作为完整建议登记。原输入与已保存输出保留。'
  const locked = taskControls?.disabled ?? disabled
  return <section className={ui.panel} aria-label="审稿任务状态">
    <button type="button" className={ui.button} onClick={() => setExpanded(true)}><StudioIcon name="read" />打开审稿试读 · {state}</button>
    {expanded && createPortal(<DialogDisplayContext.Provider value="modal"><Dialog title="审稿试读" className={`${ui.panel} ${styles.dialog}`} wide onClose={() => setExpanded(false)}>
      {error && <p className={ui.error} role="alert">{error}</p>}
      {run.error && run.error !== error && <p className={ui.error} role="alert">{run.error}</p>}
      <p className={ui.muted} role="status">{notice}</p>
      <ReviewWorkspace source={run} proposal={null} state={state} caption={`固定稿件 · 已保存输出 ${run.outputText.length.toLocaleString()} 字符`} readerNotice={running ? orphaned ? '任务待核对，尚无完整评分。' : '审稿中，等待完整结果。' : `本次${state}，未载入可登记的试读结果。`} />
      <details className={styles.reviewTools}><summary>任务标识与已保存输出</summary><p className={ui.identity}>任务 {run.id} · 固定正文修订 {run.context.chapterRevisionId}</p><pre className={styles.partialOutput}>{run.outputText || '尚无已保存输出。'}</pre></details>
      <footer className={styles.footer}><span className={ui.muted}><StudioIcon name="info" size={16} />模型建议，非事实判定</span>
        {taskControls && running && <><button type="button" className={ui.button} disabled={locked} onClick={taskControls.onRefresh}><StudioIcon name="refresh" size={18} />核对任务状态</button><button type="button" className={ui.button} disabled={locked} onClick={orphaned ? taskControls.onInterrupt : taskControls.onCancel}>{orphaned ? '标记中断并保留输出' : '取消审稿并保留输出'}</button></>}
        {taskControls?.onRetry && ['failed', 'cancelled', 'interrupted'].includes(run.state) && <button type="button" className={ui.button} disabled={locked} onClick={() => { setExpanded(false); taskControls.onRetry?.() }}>重新准备本次要求</button>}
        <button type="button" className={ui.button} onClick={() => setExpanded(false)}>收起审稿试读</button>
      </footer>
    </Dialog></DialogDisplayContext.Provider>, document.body)}
  </section>
}

function ReviewCompletedResults({ api, run, bookRevision, disabled, error, onDirtyChange, onChanged, onRecover, onOpenChecklist, expanded, onExpandedChange: setExpanded }: Props & {
  expanded: boolean; onExpandedChange: (value: boolean) => void
}) {
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
  const [selected, setSelected] = useState<number | null>(null)
  const editors = useRef(new Map<number, HTMLDetailsElement>())
  const manuscriptBlocks = useRef(new Map<string, HTMLDivElement>())
  const issueOpener = useRef<HTMLElement | null>(null)
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
  useEffect(() => {
    if (expanded && !disabled && parsed.proposal && !tool.hasChanges() && !tool.hasPending() && !syncRef.current
      && (needsRead.current || snapshotRef.current?.bookRevision !== bookRevision)) { needsRead.current = false; void load() }
  }, [disabled, expanded, bookRevision])
  useLayoutEffect(() => { if (expanded && selected !== null) revealIssue(selected) }, [expanded, selected])
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
  function revealIssue(index: number) {
    const blockId = parsed.proposal?.items[index]?.blockIds[0]
    if (blockId) manuscriptBlocks.current.get(blockId)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    const element = editors.current.get(index)
    if (element) { element.open = true; element.scrollIntoView({ block: 'nearest', behavior: 'instant' }); element.querySelector('summary')?.focus({ preventScroll: true }) }
  }
  function focusIssue(index: number) {
    if (document.activeElement instanceof HTMLElement) issueOpener.current = document.activeElement
    if (selected === index) revealIssue(index); else setSelected(index)
  }
  function collapseIssue() { setSelected(null); if (issueOpener.current?.isConnected) issueOpener.current.focus({ preventScroll: true }) }
  function openDecision(issueId?: string) {
    if (!onOpenChecklist || tool.locked || syncRef.current || hasEdits(draftsRef.current)) return
    setExpanded(false); onOpenChecklist(issueId)
  }
  const decisions = snapshot?.issues.filter((issue) => issue.aiRunId === source.id) ?? []
  const applications = decisions.filter((issue) => issue.application)
  const applicationTarget = selected !== null ? savedItem(selected)
    : decisions.find((issue) => issue.status === 'open' && !issue.stale && issue.replacement?.trim() && issue.anchor.blockIds.length && !issue.candidateSource?.item.requirement) ?? decisions[0]
  const canPreviewTarget = applicationTarget?.status === 'open' && !applicationTarget.stale && Boolean(applicationTarget.replacement?.trim())
    && applicationTarget.anchor.blockIds.length > 0 && !applicationTarget.candidateSource?.item.requirement
  return <section className={ui.panel} aria-label="审稿候选逐项审阅" aria-busy={tool.busy}>
    <button type="button" className={ui.button} onClick={() => { needsRead.current = true; setExpanded(true) }}><StudioIcon name="read" />打开审稿试读</button>
    {expanded && createPortal(<DialogDisplayContext.Provider value="modal"><Dialog title="审稿试读" className={`${ui.panel} ${styles.dialog}`} wide busy={tool.busy} onClose={() => setExpanded(false)}>
    {parsed.error && <p className={ui.warning} role="alert">{parsed.error}</p>}
    {error && <p className={ui.error} role="alert">{error}</p>}
    {changedRun && <p className={ui.warning}>候选版本已变化，当前编辑仍保留。请先留存后重新打开结果。</p>}
    {tool.error && <p className={ui.error} role="alert">{tool.error}</p>}{tool.notice && <p className={ui.notice} role="status">{tool.notice}</p>}
    {tool.readFailure && <div className={ui.warning}><p>原读取尚待核对，当前稿件和审阅输入保留。</p>
      {tool.readFailure.requestId && <button className={ui.button} type="button" disabled={disabled || tool.busy} onClick={() => void tool.checkReadReceipt()}>核对原读取</button>}</div>}
    {tool.pending && <div className={ui.warning}><p>登记结果尚未确认。请先查询原请求，当前表单和标识已保留。</p><button className={ui.button} type="button" disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void tool.checkReceipt()}>核对原请求</button></div>}
    {syncRequestId && <button className={ui.button} type="button" disabled={disabled || tool.busy} onClick={() => void checkSync()}>核对原同步读取</button>}
    {sync && <button className={ui.button} type="button" disabled={disabled || tool.busy || Boolean(syncRequestId)} onClick={() => void synchronize()}>同步作品信息</button>}
    {snapshot && snapshot.bookRevision !== bookRevision && !sync && <p className={ui.warning}>作品版本已变化，当前编辑保留。请处理编辑后刷新，再登记。</p>}
    <details className={styles.reviewTools}><summary>审阅记录与操作</summary><p className={ui.muted}>评分是模型对固定稿的主观意见。采纳先保存为待处理建议，核对差异并确认后才写入正文。</p>
      <div className={ui.actions}><button className={ui.button} type="button" disabled={tool.locked || sync || tool.dirty} onClick={() => void load()}>刷新审稿清单</button>
      {hasEdits(drafts) && <button className={ui.button} type="button" disabled={tool.locked || sync} onClick={discardEdits}>{discard ? '确认放弃未登记编辑' : '放弃未登记编辑'}</button>}</div></details>
    {(tool.pending || tool.readFailure || sync || changedRun || hasEdits(drafts)) && <details className={ui.details}><summary>留存本次审阅内容</summary><textarea readOnly rows={8} value={JSON.stringify({ bookId: source.bookId, runId: source.id, runVersion: source.version, requestId: tool.pending?.error.requestId, readRequestId: tool.readFailure?.requestId, syncRequestId, input: submitted, drafts }, null, 2)} />
      <label className={ui.check}><input type="checkbox" checked={preserved} onChange={(event) => setPreserved(event.target.checked)} />我已留存输入和登记标识</label><button className={ui.button} type="button" disabled={tool.busy || !preserved} onClick={onRecover}>进入恢复</button></details>}
    {parsed.proposal?.items.length === 0 && <p className={ui.empty}>本次没有可定位的建议。这不代表全书没有问题。</p>}
    <ReviewWorkspace source={source} proposal={parsed.proposal} state={parsed.error ? '结果待核对' : applications.length ? '建议已应用' : '已完成'}
      caption={`固定原稿 · ${parsed.proposal?.items.length ?? 0} 条建议${applications.length ? ` · ${applications.length} 条有正文应用记录（${applications.filter((issue) => issue.applicationCurrent).length} 条对应当前修订）` : ''}`}
      selected={selected} onFocusIssue={focusIssue} savedItem={savedItem} onBlockRef={(id, element) => { if (element) manuscriptBlocks.current.set(id, element); else manuscriptBlocks.current.delete(id) }} />
    {parsed.proposal?.items.map((item, index) => {
      const draft = drafts[index]!, saved = savedItem(index)
      const original = item.blockIds.map((id) => source.context.chapterBlocks.find((block) => block.blockId === id)?.text ?? '').join('\n\n')
      // 隐藏非当前建议仍保留差异选择，切换批注不会丢掉尚未交回草稿的勾选。
      return <article className={`${ui.panel} ${styles.issue}`} hidden={selected !== index} key={draft.id}><details ref={(element) => { if (element) editors.current.set(index, element); else editors.current.delete(index) }}>
        <summary>{index + 1}. {item.title} · {REVIEW_LENS_LABELS[item.lens]} · {saved ? '已登记' : '审阅与改写'}</summary>
        <button type="button" className={ui.button} onClick={collapseIssue}>收起建议</button>
        {item.requirement ? <blockquote>章纲要求：{item.requirement.text}<p className={ui.identity}>固定大纲修订 {item.requirement.revisionId}</p></blockquote> : <blockquote>{item.quote}<p className={ui.identity}>固定正文修订 {source.context.chapterRevisionId} · {item.blockIds.length} 个段落</p></blockquote>}
        <p>可能的反证或其他解释：{item.counterpoint || '模型未提供，请作者另行核对。'}</p>
        <fieldset disabled={blocked || Boolean(saved)} className={ui.fields}>
          <label>理由<textarea value={saved?.reason ?? draft.reason} rows={3} maxLength={10000} onChange={(event) => edit(index, { reason: event.target.value })} /></label>
          <label>修改方向<textarea value={saved?.suggestion ?? draft.suggestion} rows={3} maxLength={20000} onChange={(event) => edit(index, { suggestion: event.target.value })} /></label>
          {!item.requirement && <label>替换正文（可留空）<textarea value={saved?.replacement ?? draft.replacement} rows={4} maxLength={20000} onChange={(event) => edit(index, { replacement: event.target.value })} /></label>}
        </fieldset>
        {draft.replacement.trim() && !item.requirement && !saved && <AiTextDiff originalText={original} suggestedText={draft.replacement} disabled={blocked} onAcceptText={(replacement) => edit(index, { replacement })} />}
        {saved ? <div className={ui.actions}><p className={ui.notice}>已登记：{decisionLabel(saved)}</p>
          {onOpenChecklist && <button type="button" className={ui.button} disabled={tool.locked || sync || hasEdits(drafts)} onClick={() => openDecision(saved.id)}>查看这条审稿决定</button>}</div>
          : <div className={ui.actions}><button className={ui.primaryButton} type="button" disabled={blocked} onClick={() => void save(index, 'open')}>采纳建议</button><button className={ui.button} type="button" disabled={blocked} onClick={() => void save(index, 'dismissed')}>忽略建议</button><button className={ui.button} type="button" disabled={blocked} onClick={() => void save(index, 'intentional')}>这是刻意安排</button></div>}
      </details></article>
    })}
    <footer className={styles.footer}><span><StudioIcon name="check" />采纳 {decisions.filter((item) => !['dismissed', 'intentional'].includes(item.status)).length} 条</span><span><StudioIcon name="close" />忽略 {decisions.filter((item) => item.status === 'dismissed').length} 条</span><span className={ui.muted}><StudioIcon name="info" size={16} />模型建议，非事实判定</span>
      {onOpenChecklist && <button type="button" className={ui.primaryButton} disabled={tool.locked || sync || hasEdits(drafts) || !applicationTarget}
        title={hasEdits(drafts) ? '请先采纳或放弃未保存的编辑' : !applicationTarget ? '请先采纳或忽略所选建议' : canPreviewTarget ? `核对“${applicationTarget.title}”的差异后确认应用` : '查看所选问题的状态、来源及作者决定'}
        onClick={() => openDecision(applicationTarget?.id)}><StudioIcon name="spark" size={20} />{canPreviewTarget ? '应用修改' : '查看审稿决定'}</button>}
    </footer>
    </Dialog></DialogDisplayContext.Provider>, document.body)}
  </section>
}
