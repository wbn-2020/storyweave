import { useMemo } from 'react'
import { DomainError, type StudioApi } from '../../contracts/api'
import { isAiMemoryTask, parseAiMemoryProposal, type AiMemoryCitation, type AiMemoryProposal, type AiMemoryReviewAction, type AiMemoryReviewEntry, type AiRun } from '../../contracts/ai'
import { CONFLICT_STATES, KNOWLEDGE_KINDS, parseKnowledgeFields, type ConflictState, type KnowledgeItemDetail, type KnowledgeItemFields, type KnowledgeKind, type KnowledgeNature } from '../../contracts/knowledge'
import { AiMemoryTargetPicker } from './AiMemoryTargetPicker'
import shared from '../App.module.css'
import layout from './KnowledgePanel.module.css'
import styles from './AiPanel.module.css'

export interface AiMemoryDraft extends AiMemoryReviewEntry { selected: boolean; targetSnapshot?: KnowledgeItemFields }

export function aiMemoryReviewEntries(drafts: AiMemoryDraft[]): AiMemoryReviewEntry[] {
  return drafts.filter((draft) => draft.selected).map(({ selected: _selected, targetSnapshot: _targetSnapshot, ...entry }) => entry)
}

interface Props {
  api: StudioApi
  run: AiRun
  drafts: AiMemoryDraft[]
  disabled: boolean
  onChange: (drafts: AiMemoryDraft[]) => void
  onAdopt: () => void
}

const kindLabels: Record<KnowledgeKind, string> = { person: '人物', place: '地点', organization: '组织', object: '物品', rule: '世界规则', theme: '主题', other: '其他' }
const natureLabels: Record<KnowledgeNature, string> = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '人物认知', ai_derived: 'AI 整理', ai_inference: 'AI 推断', external_reference: '外部参考' }
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

export function AiMemoryReview({ api, run, drafts, disabled, onChange, onAdopt }: Props) {
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
  const editable = run.state === 'succeeded' && matchingDrafts && !disabled
  const selectedCount = matchingDrafts ? drafts.filter((draft) => draft.selected).length : 0
  const missingTarget = drafts.some((draft) => draft.selected && (draft.action === 'link' || draft.action === 'revise') &&
    (!draft.targetItemId || !draft.expectedTargetRevisionId || !draft.targetSnapshot))

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

  return <section className={styles.output} aria-label={run.kind === 'summarize' ? '章节摘要审阅' : '章节知识抽取审阅'}>
    <div className={styles.heading}><h3>{run.kind === 'summarize' ? '章节摘要' : '知识抽取'} · 作者审阅</h3>
      {run.state === 'succeeded' && proposal && <span>已选择 {selectedCount} / {proposal.items.length} 条</span>}
      {run.state === 'adopted' && <span>采用时的固定记录</span>}
    </div>
    <p className={layout.sourceIds}>《{run.context.chapterTitle}》 · 章节 {run.context.chapterId}<br />固定正文修订 {run.context.chapterRevisionId}</p>
    {parsed.error && <p className={shared.formError} role="alert">{parsed.error} 原模型输出保留在下方；本次结果不能直接采用。</p>}
    {run.state === 'succeeded' && proposal && <>
      <p className={styles.note}>逐条核对内容与引文，再选择要保存的条目。采用只表示作者决定保存，冲突默认仍为“未检查”；正文陈述、人物认知与 AI 推断保留各自性质。</p>
      {!matchingDrafts && <p className={shared.formError} role="alert">审阅草稿与原提议不匹配，请重新读取这次提议。原输出仍保留。</p>}
      {proposal.items.length === 0 && <p className={styles.note}>本次未抽取到条目，原输出已保留。可以调整创作要求后，另建一次预览。</p>}
      {matchingDrafts && proposal.items.map((item, sourceIndex) => {
        const draft = drafts.find((entry) => entry.sourceIndex === sourceIndex)!
        const fields = draft.fields
        const existing = draft.action === 'link' || draft.action === 'revise'
        const fieldsDisabled = !editable || draft.action === 'link' || draft.action === 'ignore' || (existing && !draft.targetItemId)
        return <section className={styles.composer} key={sourceIndex} aria-label={`审阅第 ${sourceIndex + 1} 条`}>
          <label className={shared.checkLabel}><input type="checkbox" checked={draft.selected} disabled={!editable} onChange={(event) => select(sourceIndex, event.target.checked)} /><span>选择第 {sourceIndex + 1} 条 · {fields.name || '尚未填写名称'}</span></label>
          <div className={layout.labels}><span>{natureLabels[item.nature]}</span><span>{conflictLabels[fields.conflictState]}</span></div>
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
        </section>
      })}
      <p className={styles.note}>一次提交所选决定，忽略项只记入审阅历史。每份候选只能提交一次；确认前请完成全部选择与修改。同批关联同一实体时，请合并内容并忽略重复提议。</p>
      <div className={styles.actions}><button className={shared.primaryButton} type="button" disabled={!editable || selectedCount === 0 || missingTarget} onClick={onAdopt}>确认并保存 {selectedCount} 项决定</button></div>
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
  </section>
}
