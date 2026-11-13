import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DomainError, type StudioApi } from '../../contracts/api'
import { isAiMemoryTask, parseAiMemoryAdoptInput, parseAiMemoryProposal, type AiMemoryCitation, type AiMemoryProposal, type AiMemoryReviewAction, type AiMemoryReviewEntry, type AiRun } from '../../contracts/ai'
import { CONFLICT_STATES, KNOWLEDGE_KINDS, parseKnowledgeFields, type ConflictState, type KnowledgeItemDetail, type KnowledgeItemFields, type KnowledgeKind, type KnowledgeNature } from '../../contracts/knowledge'
import { AiMemoryTargetPicker } from './AiMemoryTargetPicker'
import { StudioIcon } from './StudioIcon'
import shared from '../StellarShared.module.css'
import layout from './StellarKnowledge.module.css'
import styles from './StellarAi.module.css'
import archive from './StellarArchive.module.css'

export interface AiMemoryDraft extends AiMemoryReviewEntry { selected: boolean; targetSnapshot?: KnowledgeItemFields }
type ArchiveConfirmation = { kind: 'close' } | {
  kind: 'adopt'; version: number; contextHash: string; outputText: string; drafts: AiMemoryDraft[]
}

export function aiMemoryReviewEntries(drafts: AiMemoryDraft[]): AiMemoryReviewEntry[] {
  return drafts.filter((draft) => draft.selected).map(({ selected: _selected, targetSnapshot: _targetSnapshot, ...entry }) => entry)
}

interface Props {
  api: StudioApi
  run: AiRun
  drafts: AiMemoryDraft[]
  disabled: boolean
  error?: string | null
  onChange: (drafts: AiMemoryDraft[]) => void
  onAdopt: () => Promise<void>
}

const kindLabels: Record<KnowledgeKind, string> = { person: '人物', place: '地点', organization: '组织', object: '物品', rule: '世界规则', theme: '主题', other: '其他' }
const natureLabels: Record<KnowledgeNature, string> = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '角色信念', ai_derived: 'AI 整理', ai_inference: '模型推断', external_reference: '外部参考' }
const conflictLabels: Record<ConflictState, string> = { unchecked: '未检查冲突', clear: '作者未发现已知冲突', candidate: '存在候选冲突', explained: '作者已解释冲突' }
const actionLabels: Record<AiMemoryReviewAction, string> = { create: '新建知识条目', link: '关联已有实体，仅追加来源', revise: '修订已有实体并追加来源', ignore: '忽略本条提议' }

export function createAiMemoryDrafts(run: AiRun): AiMemoryDraft[] {
  return parseAiMemoryProposal(run.outputText, run.context).items.map((item, sourceIndex) => ({
    sourceIndex, selected: false,
    fields: { kind: item.kind, name: item.name, aliases: [...item.aliases], summary: item.summary, nature: item.nature,
      authorDecision: 'adopted', freshness: 'current', conflictState: 'unchecked' },
  }))
}

function FixedCitations({ citations }: { citations: AiMemoryCitation[] }) {
  return <>
    <div className={layout.sectionHeading}><h4>固定正文引文</h4><span>{citations.length} 处</span></div>
    <ul className={layout.sources}>{citations.map((citation, index) => <li key={`${citation.blockId}:${index}`}>
      <p className={layout.sourceIds}>段落 {citation.blockId}</p><blockquote>{citation.quote}</blockquote>
    </li>)}</ul>
  </>
}

export function AiMemoryReview(props: Props) {
  return <AiMemoryReviewSession key={props.run.id} {...props} />
}

function AiMemoryReviewSession({ api, run, drafts, disabled, error, onChange, onAdopt }: Props) {
  const [open, setOpen] = useState(['succeeded', 'adopted'].includes(run.state))
  const [confirmation, setConfirmation] = useState<ArchiveConfirmation | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const confirmationButton = useRef<HTMLButtonElement>(null)
  const confirmationTrigger = useRef<HTMLElement | null>(null)
  const wasConfirming = useRef(false)
  const submitLock = useRef(false)
  const headingId = useId(), confirmationId = useId(), validationId = useId()
  const drawerMode = ['succeeded', 'adopted'].includes(run.state)
  useEffect(() => {
    if (run.state === 'succeeded') setOpen(true)
  }, [run.state])
  useEffect(() => {
    if (!open || !drawerMode) return
    const element = dialog.current
    if (!element) return
    element.showModal()
    return () => {
      if (element.open) element.close()
      if (launcher.current?.isConnected) launcher.current.focus({ preventScroll: true })
    }
  }, [open, drawerMode])
  useEffect(() => {
    if (confirmation) confirmationButton.current?.focus({ preventScroll: true })
    else if (wasConfirming.current) {
      const trigger = confirmationTrigger.current
      if (trigger?.isConnected && !trigger.matches(':disabled')) trigger.focus({ preventScroll: true })
      else {
        const close = dialog.current?.querySelector<HTMLButtonElement>('[data-archive-close]:not(:disabled)')
        const fallback = close ?? dialog.current?.querySelector<HTMLHeadingElement>('h2')
        fallback?.focus({ preventScroll: true })
      }
      confirmationTrigger.current = null
    }
    wasConfirming.current = confirmation !== null
  }, [confirmation])
  useEffect(() => {
    // 候选、版本或可写状态变化后必须重新确认，不能提交旧摘要对应的决定。
    setConfirmation((value) => value?.kind === 'adopt' ? null : value)
  }, [run.version, run.context.contextHash, run.outputText, drafts, disabled])
  const parsed = useMemo<{ proposal: AiMemoryProposal | null; error: string | null }>(() => {
    if (run.state !== 'succeeded') return { proposal: null, error: null }
    // 证据只从原始输出和固定上下文解析，作者字段编辑不能重写引文。
    try { return { proposal: parseAiMemoryProposal(run.outputText, run.context), error: null } }
    catch (cause) { return { proposal: null, error: cause instanceof DomainError ? cause.detail.message : '整理结果无法解析，原输出已完整保留。请重新生成或复制后手工整理。' } }
  }, [run.state, run.outputText, run.context])
  if (!isAiMemoryTask(run.kind)) return null

  const proposal = parsed.proposal
  const matchingDrafts = proposal !== null && drafts.length === proposal.items.length &&
    new Set(drafts.map((draft) => draft.sourceIndex)).size === drafts.length && drafts.every((draft) => {
      const item = proposal.items[draft.sourceIndex]
      const existing = draft.action === 'link' || draft.action === 'revise'
      return Number.isInteger(draft.sourceIndex) && item !== undefined && (existing || (draft.fields.nature === item.nature &&
        draft.fields.authorDecision === 'adopted' && draft.fields.freshness === 'current')) &&
        (run.kind !== 'summarize' || draft.fields.kind === 'other')
    })
  const editable = run.state === 'succeeded' && matchingDrafts && !disabled && !submitting
  const selectedCount = matchingDrafts ? drafts.filter((draft) => draft.selected).length : 0
  const missingTarget = drafts.some((draft) => draft.selected && (draft.action === 'link' || draft.action === 'revise') &&
    (!draft.targetItemId || !draft.expectedTargetRevisionId || !draft.targetSnapshot))
  const decisionCounts = { create: 0, link: 0, revise: 0, ignore: 0 }
  for (const draft of drafts) if (draft.selected) decisionCounts[draft.action ?? 'create'] += 1
  let decisionError: string | undefined
  if (matchingDrafts && selectedCount && !missingTarget) {
    // 复用正式提交合同，重复目标、空字段和超限内容不能进入确认后才报错。
    try { parseAiMemoryAdoptInput({ bookId: run.bookId, runId: run.id, expectedVersion: run.version, entries: aiMemoryReviewEntries(drafts) }) }
    catch (cause) { decisionError = cause instanceof DomainError ? cause.detail.message : '请核对所选条目的字段与作者决定。' }
  }
  const archiveReason = submitting ? '正在保存作者决定' : disabled ? '当前候选不可提交，请收起后核对面板状态'
    : !matchingDrafts ? '审阅草稿与原提议不匹配' : !selectedCount ? '请先勾选需要归档的候选'
      : missingTarget ? '请先为关联或修订决定选择目标实体' : decisionError
  function requestConfirmation(kind: 'close' | 'adopt') {
    confirmationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setConfirmation(kind === 'close' ? { kind } : { kind, version: run.version,
      contextHash: run.context.contextHash, outputText: run.outputText, drafts })
  }
  function requestClose() {
    if (submitLock.current) return
    if (run.state === 'succeeded') requestConfirmation('close')
    else setOpen(false)
  }
  function keepReviewing() {
    setConfirmation(null)
  }
  async function confirmArchive() {
    if (submitLock.current || !editable || archiveReason || confirmation?.kind !== 'adopt') return
    // 确认仅授权当时的候选和整份草稿；异步换稿或重新勾选后必须再次确认。
    if (confirmation.version !== run.version || confirmation.contextHash !== run.context.contextHash ||
      confirmation.outputText !== run.outputText || confirmation.drafts !== drafts) { setConfirmation(null); return }
    submitLock.current = true; setSubmitting(true); setConfirmation(null)
    try { await onAdopt() }
    finally { submitLock.current = false; setSubmitting(false) }
  }

  function update(sourceIndex: number, patch: Partial<Pick<KnowledgeItemFields, 'kind' | 'name' | 'aliases' | 'summary' | 'conflictState'>>) {
    if (!editable) return
    onChange(drafts.map((draft) => draft.sourceIndex === sourceIndex ? { ...draft, fields: { ...draft.fields, ...patch } } : draft))
  }
  function select(sourceIndex: number, selected: boolean) {
    if (!editable) return
    onChange(drafts.map((draft) => draft.sourceIndex === sourceIndex ? { ...draft, selected } : draft))
  }
  function chooseAction(sourceIndex: number, action: AiMemoryReviewAction) {
    if (!editable) return
    const original = createAiMemoryDrafts(run)[sourceIndex]!
    onChange(drafts.map((draft): AiMemoryDraft => {
      if (draft.sourceIndex !== sourceIndex) return draft
      const existing = action === 'link' || action === 'revise'
      if (existing && draft.targetSnapshot) return { ...draft, selected: true, action,
        fields: action === 'link' ? draft.targetSnapshot : { ...draft.fields, authorDecision: 'adopted', freshness: 'current' } }
      return { ...original, selected: true, action }
    }))
  }
  function chooseTarget(sourceIndex: number, target: KnowledgeItemDetail) {
    if (!editable || target.bookId !== run.bookId || target.knowledgeRevision !== run.context.knowledgeRevision) return
    const targetSnapshot = parseKnowledgeFields(target.revisions[0]!.fields)
    onChange(drafts.map((draft): AiMemoryDraft => draft.sourceIndex !== sourceIndex || (draft.action !== 'link' && draft.action !== 'revise') ? draft : {
      ...draft, targetItemId: target.id, expectedTargetRevisionId: target.revisions[0]!.id, targetSnapshot,
      fields: draft.action === 'link' ? targetSnapshot : { ...targetSnapshot, authorDecision: 'adopted', freshness: 'current' },
    }))
  }

  const content = <>
    {parsed.error && <p className={shared.formError} role="alert">{parsed.error} 原模型输出保留在下方；本次结果不能直接采用。</p>}
    {run.state === 'succeeded' && proposal && <>
      {!matchingDrafts && <p className={shared.formError} role="alert">审阅草稿与原提议不匹配，请重新读取这次提议。原输出仍保留。</p>}
      {proposal.items.length === 0 && <p className={styles.note}>本次未抽取到条目，原输出已保留。可以调整创作要求后，另建一次预览。</p>}
      <div className={archive.candidates}>{matchingDrafts && proposal.items.map((item, sourceIndex) => {
        const draft = drafts.find((entry) => entry.sourceIndex === sourceIndex)!
        const fields = draft.fields
        const existing = draft.action === 'link' || draft.action === 'revise'
        const fieldsDisabled = !editable || draft.action === 'link' || draft.action === 'ignore' || (existing && !draft.targetItemId)
        const citation = item.citations[0]
        const blockPosition = citation ? run.context.chapterBlocks.findIndex((block) => block.blockId === citation.blockId) + 1 : 0
        return <section className={archive.candidate} data-selected={draft.selected} key={sourceIndex} aria-label={`审阅第 ${sourceIndex + 1} 条`}>
          <label className={archive.checkbox}><input type="checkbox" checked={draft.selected} disabled={!editable}
            aria-label={`选择第 ${sourceIndex + 1} 条 · ${fields.name || '尚未填写名称'}`} onChange={(event) => select(sourceIndex, event.target.checked)} /><StudioIcon name="check" size={16} /></label>
          <details className={archive.candidateDetails}>
            <summary aria-label={`改判与详情：${fields.name || `第 ${sourceIndex + 1} 条`}`}>
              <span className={archive.nature} data-nature={item.nature}>{natureLabels[item.nature]}</span>
              <span className={archive.candidateText}><strong>{fields.name || '尚未填写名称'}{fields.summary && `：${fields.summary}`}</strong>
                <span title={citation?.quote}>{citation ? `原文：“${citation.quote}”` : '尚无固定正文引文'}{blockPosition > 0 ? ` · 第 ${blockPosition} 段` : ''}{item.citations.length > 1 ? ` · 共 ${item.citations.length} 处` : ''}</span>
              </span>
              <StudioIcon name="chevron" size={20} />
            </summary>
            <div className={archive.candidateEditor}>
          <div className={layout.labels}><span>{kindLabels[fields.kind]}</span><span>{conflictLabels[fields.conflictState]}</span><span>{actionLabels[draft.action ?? 'create']}</span></div>
          {run.kind === 'extract' && <label>作者决定<select value={draft.action ?? 'create'} disabled={!editable}
            onChange={(event) => chooseAction(sourceIndex, event.target.value as AiMemoryReviewAction)}>{Object.entries(actionLabels).map(([action, label]) => <option key={action} value={action}>{label}</option>)}</select></label>}
          {existing && <>
            <p className={styles.note}>原提议：{item.name} · {natureLabels[item.nature]}<br />{item.summary}</p>
            <AiMemoryTargetPicker key={`${run.id}:${sourceIndex}:${draft.action}`} api={api} bookId={run.bookId}
              knowledgeRevision={run.context.knowledgeRevision} kind={item.kind} name={item.name} disabled={!editable}
              onSelect={(target) => chooseTarget(sourceIndex, target)} />
            {draft.targetSnapshot && <details open><summary>目标实体原值 · {draft.targetSnapshot.name}</summary>
              <p className={layout.sourceIds}>实体 {draft.targetItemId} · 修订 {draft.expectedTargetRevisionId}</p>
              <p className={styles.note}>性质：{natureLabels[draft.targetSnapshot.nature]} · 别名：{draft.targetSnapshot.aliases.join('、') || '无'}</p>
              <p className={layout.body}>{draft.targetSnapshot.summary}</p>
            </details>}
            <p className={styles.note}>{draft.action === 'link' ? '仅把本章固定引文追加到选定实体，保留全部原字段和审阅状态。' : '下方是最终保存内容。请将本条提议中需要保留的变化明确编辑进去；原字段与修订将记入采用审计。'}</p>
          </>}
          <div className={layout.editorForm}>
            <div className={layout.twoColumns}>
              <label>名称<input value={fields.name} maxLength={120} required disabled={fieldsDisabled} onChange={(event) => update(sourceIndex, { name: event.target.value })} /></label>
              <label>类型<select value={fields.kind} disabled={fieldsDisabled || existing || run.kind === 'summarize'} onChange={(event) => update(sourceIndex, { kind: event.target.value as KnowledgeKind })}>{KNOWLEDGE_KINDS.map((kind) => <option value={kind} key={kind}>{kindLabels[kind]}</option>)}</select></label>
            </div>
            <label>普通别名（每行一个，最多 50 个）<textarea value={fields.aliases.join('\n')} maxLength={6049} rows={2} disabled={fieldsDisabled}
              onChange={(event) => update(sourceIndex, { aliases: event.target.value ? event.target.value.split(/\r?\n/) : [] })}
              onBlur={() => {
                const aliases = fields.aliases.map((alias) => alias.trim()).filter(Boolean)
                if (aliases.join('\n') !== fields.aliases.join('\n')) update(sourceIndex, { aliases })
              }} /></label>
            <label>内容与适用范围<textarea value={fields.summary} maxLength={existing ? 20_000 : 8000} rows={6} required disabled={fieldsDisabled} onChange={(event) => update(sourceIndex, { summary: event.target.value })} /></label>
            <label>冲突状态<select value={fields.conflictState} disabled={fieldsDisabled} onChange={(event) => update(sourceIndex, { conflictState: event.target.value as ConflictState })}>{CONFLICT_STATES.map((state) => <option value={state} key={state}>{conflictLabels[state]}</option>)}</select></label>
          </div>
          <FixedCitations citations={item.citations} />
            </div>
          </details>
        </section>
      })}</div>
      <details className={archive.reviewNotes}><summary>审阅口径与固定来源 · 已选择 {selectedCount} / {proposal.items.length} 条</summary>
        <p>采用表示作者决定保存，冲突默认仍为“未检查”；正文陈述、人物认知与 AI 推断保留原性质。忽略只记入审阅历史。同批关联同一实体时，请合并内容并忽略重复提议。</p>
        <p className={layout.sourceIds}>章节 {run.context.chapterId}<br />固定正文修订 {run.context.chapterRevisionId}</p>
      </details>
    </>}
    {run.state === 'adopted' && <>
      <p className={styles.note}>以下内容是本次采用时保存的快照。知识库之后的修改不会改变这里的历史记录。</p>
      {/* 采用历史只显示持久快照，不能以当前草稿或知识库可变字段替代。 */}
      {run.memoryAdoptions?.length ? run.memoryAdoptions.map((entry) => <section className={styles.composer} key={entry.sourceIndex} aria-label={`审阅记录：${entry.fields.name}`}>
        <div className={styles.heading}><h3>{entry.fields.name}</h3><span>原提议第 {entry.sourceIndex + 1} 条</span></div>
        <p className={styles.note}>{actionLabels[entry.action ?? 'create']}{entry.changed === false && entry.action !== 'ignore' ? ' · 来源已存在，本次无知识变更' : ''}</p>
        <div className={layout.labels}><span>{kindLabels[entry.fields.kind]}</span><span>{natureLabels[entry.fields.nature]}</span><span>{conflictLabels[entry.fields.conflictState]}</span></div>
        {entry.itemId && <p className={layout.sourceIds}>知识条目 {entry.itemId}{entry.resultingRevisionId ? ` · 保存修订 ${entry.resultingRevisionId}` : ''}</p>}
        {entry.previousFields && <details><summary>修订前字段</summary><pre>{JSON.stringify(entry.previousFields, null, 2)}</pre></details>}
        {entry.fields.aliases.length > 0 && <p className={styles.note}>采用时的别名：{entry.fields.aliases.join('、')}</p>}
        <p className={layout.body}>{entry.fields.summary}</p>
        <FixedCitations citations={entry.citations} />
      </section>) : <p className={shared.formError} role="alert">本次读取没有提供采用条目快照，请重新读取提议详情。原模型输出仍保留。</p>}
    </>}
    {run.state === 'running' && <p className={styles.note} role="status">正在整理，已收到的部分输出随检查点更新。成功结束后才能逐条审阅采用。</p>}
    {['failed', 'cancelled', 'interrupted'].includes(run.state) && <p className={styles.note}>本次整理未成功完成，部分输出与固定输入仍保留。重新整理需要另建预览并确认发送。</p>}
    {run.state === 'rejected' && <p className={styles.note}>作者已拒绝本次提议，原输出与输入记录仍保留。</p>}
    <details className={styles.messages} open={Boolean(parsed.error) || !['succeeded', 'adopted'].includes(run.state)}>
      <summary>原模型输出 · 只读 · {run.outputText.length.toLocaleString()} 字符</summary><pre>{run.outputText || '尚无输出。'}</pre>
    </details>
    {run.usage && <p className={styles.note}>接口返回用量：输入 {run.usage.inputTokens ?? '未知'} · 输出 {run.usage.outputTokens ?? '未知'} · 总计 {run.usage.totalTokens ?? '未知'} tokens{run.finishReason ? ` · 结束原因 ${run.finishReason}` : ''}</p>}
  </>
  return <section className={styles.output} aria-label={run.kind === 'summarize' ? '章节摘要审阅' : '章节知识抽取审阅'}>
    <div className={styles.heading}><h3>本章记忆归档</h3><span>{run.state === 'adopted' ? '采用时的固定记录' : proposal ? `已选择 ${selectedCount} / ${proposal.items.length} 条` : '作者审阅'}</span></div>
    <p className={layout.sourceIds}>《{run.context.chapterTitle}》</p>
    {drawerMode ? <>
      <button ref={launcher} type="button" className={shared.button} onClick={() => { setConfirmation(null); setOpen(true) }}>
        <StudioIcon name="spark" />{run.state === 'adopted' ? '查看本章归档记录' : '审阅本章记忆候选'}
      </button>
      {open && createPortal(<dialog ref={dialog} className={archive.drawer} aria-labelledby={headingId}
        onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!submitLock.current) confirmation ? keepReviewing() : requestClose() }}>
        <header className={archive.header} inert={confirmation !== null}><StudioIcon name="spark" size={28} /><h2 id={headingId} tabIndex={-1} title={`${run.context.chapterTitle} · 本章记忆归档`}>{run.context.chapterTitle} · 本章记忆归档</h2>
          <button type="button" data-archive-close className={archive.closeButton} disabled={submitting} aria-label="收起本章记忆归档" title="收起本章记忆归档" onClick={requestClose}><StudioIcon name="close" size={24} /></button>
        </header>
        {error && <p className={archive.error} role="alert">{error}</p>}
        {decisionError && decisionError !== error && <p id={validationId} className={archive.error} role="status">{decisionError}</p>}
        <div className={archive.body} inert={confirmation !== null || submitting}>{content}</div>
        {confirmation && <section className={archive.confirmation} role="alertdialog" aria-labelledby={confirmationId}>
          <h3 id={confirmationId}>{confirmation.kind === 'close' ? '收起本章记忆归档？' : `确认提交 ${selectedCount} 项作者决定？`}</h3>
          {confirmation.kind === 'close' ? <p>当前勾选与修改保留在本页，尚未提交的决定不会写入设定库。</p> : <>
            <p>新建 {decisionCounts.create} · 关联 {decisionCounts.link} · 修订 {decisionCounts.revise} · 忽略 {decisionCounts.ignore}</p>
            <p>仅关联会保留原字段；修订会按已编辑内容保存新版本。忽略只记录审阅历史。本次候选只能提交一次。</p>
          </>}
          <div className={archive.confirmActions}><button ref={confirmationButton} type="button" className={shared.button} onClick={keepReviewing}>继续审阅</button>
            <button type="button" className={shared.primaryButton} disabled={submitting || (confirmation.kind === 'adopt' && Boolean(archiveReason))}
              onClick={() => { if (confirmation.kind === 'close') { setConfirmation(null); setOpen(false) } else void confirmArchive() }}>{confirmation.kind === 'close' ? '保留草稿并收起' : '确认归档'}</button>
          </div>
        </section>}
        <footer className={archive.footer} inert={confirmation !== null}>
          {run.state === 'succeeded' ? <button type="button" className={archive.archiveButton} disabled={Boolean(archiveReason) || confirmation !== null} title={archiveReason}
            aria-describedby={decisionError && decisionError !== error ? validationId : undefined}
            onClick={() => requestConfirmation('adopt')}><StudioIcon name="spark" size={20} />{submitting ? '正在归档…' : '确认归档'}</button>
            : <button type="button" className={archive.archiveButton} onClick={requestClose}><StudioIcon name="check" size={20} />完成</button>}
          <span><StudioIcon name="info" size={16} />{run.state === 'adopted' ? '已保留采用时的快照' : '确认前不会改写设定'}</span>
        </footer>
      </dialog>, document.body)}
    </> : content}
  </section>
}
