import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { DomainError, optionalText, requiredText, type AppError, type BookSnapshot, type ChapterSnapshot, type ChapterSummary, type RevisionSnapshot, type StudioApi, type UpdateChapterInput } from '../../contracts/api'
import type { AiRun, AiRunPage } from '../../contracts/ai'
import type { KnowledgeItemPage } from '../../contracts/knowledge'
import type { ManuscriptBlock } from '../../contracts/manuscript'
import {
  REVIEW_KINDS, REVIEW_STATES, WRITING_METRICS, WORKBENCH_SCHEMA_VERSION,
  parseApplyReviewIssueInput, parseLogWritingSessionInput, parseSaveBriefInput, parseSaveReviewIssueInput, parseSaveSceneInput, parseSaveWritingGoalInput, reviewReplacement,
  type LogWritingSessionInput, type ManuscriptAnchor, type ReviewIssue, type ReviewIssueFields,
  type SaveBriefInput, type SaveReviewIssueInput, type SaveSceneInput, type SaveWritingGoalInput,
  type SceneCard, type SceneFields, type WorkbenchSnapshot, type WritingGoal, type WritingGoalFields,
} from '../../contracts/workbench'
import { displayTime, request, statusLabels } from '../request'
import { localDate, sameFields, useToolSession } from './workbench-ui'
import styles from './WorkbenchPanel.module.css'
import { LanguageReviewPanel, ReaderReviewPanel, type LanguageFinding } from './LanguageReviewPanel'
import { AiTextDiff } from './AiTextDiff'

export interface WorkbenchPanelProps {
  api: StudioApi
  book: BookSnapshot
  chapter: ChapterSnapshot | null
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onBookChange: (book: BookSnapshot) => void
  onChapterChange: (chapter: ChapterSnapshot) => void
  onNavigate: (chapterId: string) => void
  onUnknown?: (error: AppError) => void
  onRecover?: () => void
  onReview?: (instruction: string) => void
}

type Tab = 'outline' | 'scenes' | 'architect' | 'brief' | 'review' | 'detector' | 'readers' | 'activity'
type Draft =
  | { kind: 'chapter'; input: Omit<UpdateChapterInput, 'status'> & { status: ChapterSummary['status'] } }
  | { kind: 'brief'; input: SaveBriefInput }
  | { kind: 'scene'; input: SaveSceneInput }
  | { kind: 'issue'; input: SaveReviewIssueInput }
  | { kind: 'goal'; input: SaveWritingGoalInput }
  | { kind: 'session'; input: LogWritingSessionInput }
interface ReviewReplacement { issue: ReviewIssue; original: string; bookRevision: number; confirmed: boolean }

const tabs: { id: Tab; label: string }[] = [
  { id: 'outline', label: '跨章大纲' },
  { id: 'scenes', label: '场景节拍卡' },
  { id: 'architect', label: '🏗️ 故事建筑师' },
  { id: 'brief', label: '创作约定' },
  { id: 'review', label: '审稿问题' },
  { id: 'detector', label: '语言与句式提示' },
  { id: 'readers', label: '👥 多维读者模拟' },
  { id: 'activity', label: '写作统计' },
]
const sceneStatuses: Record<SceneFields['status'], string> = { planned: '计划中', drafted: '已写出', revised: '已修订' }
const issueKinds: Record<ReviewIssueFields['kind'], string> = { structure: '结构', causality: '因果', cognition: '人物知情', foreshadow: '伏笔', language: '语言', dialogue: '对话' }
const issueStates: Record<ReviewIssueFields['status'], string> = { open: '待处理', recheck: '待复核', resolved: '已解决', intentional: '有意安排', dismissed: '已忽略' }
const metricLabels: Record<WritingGoalFields['metric'], string> = { added: '编辑新增字数（估算）', net: '编辑净增字数', minutes: '手工记录分钟', revisedChapters: '改稿章次' }
const sourceLabels = { manual: '常规编辑 / 手工记录', ai: 'AI 采用', import: '导入', restore: '恢复' }
function blockText(block: ManuscriptBlock) {
  return block.type === 'horizontalRule' ? '—— 分场线 ——' : (block.content ?? []).map((node) => node.type === 'text' ? node.text : '\n').join('') || '（空段落）'
}
function validSnapshot(value: WorkbenchSnapshot, bookId: string) {
  return Boolean(value && value.bookId === bookId && Number.isSafeInteger(value.bookRevision) && value.bookRevision >= 0
    && Array.isArray(value.scenes) && Array.isArray(value.issues) && Array.isArray(value.goals) && Array.isArray(value.activity)
    && value.brief && typeof value.requiresUpgrade === 'boolean' && typeof value.archived === 'boolean')
}
function activityStartDate() { const day = new Date(); day.setDate(day.getDate() - 365); return localDate(day) }

export function WorkbenchPanel(props: WorkbenchPanelProps) {
  return <WorkbenchContent key={props.book.book.id} {...props} />
}

function WorkbenchContent({ api, book, chapter, disabled, onDirtyChange, onBookChange, onChapterChange, onNavigate, onUnknown, onRecover, onReview }: WorkbenchPanelProps) {
  const bookId = book.book.id
  const prefix = useId()
  const [tab, setTab] = useState<Tab>('outline')
  const [catalog, setCatalog] = useState(book)
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [discard, setDiscard] = useState(false)
  const [recoveryPreserved, setRecoveryPreserved] = useState(false)
  const [syncRequired, setSyncRequired] = useState(false)
  const syncRef = useRef(false)
  const latestBookRevision = useRef(book.book.revision)
  latestBookRevision.current = book.book.revision
  const initialRead = useRef(true)
  const tool = useToolSession({ api, disabled, onUnknown, onDirtyChange, isProtected: () => syncRef.current })
  const [search, setSearch] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [issueFilter, setIssueFilter] = useState<'all' | ReviewIssueFields['status']>('open')
  const [showAi, setShowAi] = useState(false)
  const [replacement, setReplacement] = useState<ReviewReplacement | null>(null)
  const editorRef = useRef<HTMLFormElement>(null)
  const replacementRef = useRef<HTMLElement>(null)
  const [date, setDate] = useState(localDate)
  const [period, setPeriod] = useState<'day' | 'week'>('day')
  const externalChange = Boolean(snapshot && book.book.revision > snapshot.bookRevision)
  const readonly = Boolean(book.book.archivedAt || snapshot?.archived)
  const blocked = tool.locked || syncRequired || externalChange || readonly || !snapshot || snapshot.requiresUpgrade
  const currentChapter = chapter?.bookId === bookId ? chapter : null
  const scenes = useMemo(() => (snapshot?.scenes ?? []).filter((item) => (includeArchived || !item.archived)
    && (!search.trim() || `${item.title} ${item.goal} ${item.plotline}`.includes(search.trim())))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)), [snapshot, includeArchived, search])
  const issues = (snapshot?.issues ?? []).filter((item) => (issueFilter === 'all' || item.status === issueFilter)
    && (!search.trim() || `${item.title} ${item.reason} ${item.evidence} ${item.originalReason ?? ''} ${item.originalEvidence ?? ''}`.includes(search.trim())))
  const editingIssueId = draft?.kind === 'issue' ? draft.input.id : null
  const editingIssue = snapshot?.issues.find((item) => item.id === editingIssueId)
  const mutation = () => ({ bookId, expectedBookRevision: snapshot!.bookRevision })
  const editingKey = draft ? `${draft.kind}:${'id' in draft.input ? draft.input.id : 'chapterId' in draft.input ? draft.input.chapterId : bookId}` : null

  useEffect(() => { setCatalog(book) }, [book])
  useEffect(() => {
    if (!disabled && initialRead.current) { initialRead.current = false; void reload() }
  }, [bookId, disabled])
  useEffect(() => () => { initialRead.current = true }, [])
  useEffect(() => { if (editingKey) { editorRef.current?.scrollIntoView({ block: 'nearest' }); editorRef.current?.focus({ preventScroll: true }) } }, [editingKey])
  useEffect(() => { if (replacement) replacementRef.current?.scrollIntoView({ block: 'nearest' }) }, [replacement?.issue.id])
  useEffect(() => { setRecoveryPreserved(false) }, [tool.pending])

  async function reload() {
    // 同步保护只阻止离开和再次写入；这里必须允许已确认回执继续重读。
    if (tool.hasChanges() || tool.hasPending()) { tool.setError('请先保存或放弃当前更改，再刷新资料。'); return }
    await tool.read(async () => {
      const nextBook = await api.getBook({ bookId })
      if (!nextBook.ok) return nextBook
      const next = await api.getWorkbench({ bookId })
      if (!next.ok) return next
      if (!validSnapshot(next.data, bookId) || nextBook.data.book.id !== bookId || next.data.bookRevision !== nextBook.data.book.revision) {
        return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '读取期间作品已改变，请再次刷新。' } }
      }
      return { ok: true as const, data: { book: nextBook.data, workbench: next.data } }
    }, (value) => {
      // 读取期间收到新目录或编辑事件时，迟到结果不能覆盖较新的状态和未保存表单。
      if (tool.hasChanges() || tool.hasPending()) { tool.setError('读取期间表单已有更改，输入已保留。请先处理当前更改，再刷新资料。'); return }
      if (value.book.book.revision < latestBookRevision.current) { tool.setError('作品目录已有更新，已忽略较早的读取结果，请再次刷新。'); return }
      setCatalog(value.book)
      setSnapshot(value.workbench)
      // App 接收新目录后才解除保护；通知失败时保留“重试同步”入口。
      onBookChange(value.book)
      syncRef.current = false
      setSyncRequired(false)
      setDraft(null); setReplacement(null)
    })
  }
  function changed(next: Draft) { setDraft(next); setDiscard(false); tool.setDirty(true); tool.setNotice(null) }
  function canSwitch() {
    if (!tool.canLeave() || syncRef.current) { tool.setError('当前内容尚未处理完，请先保存、放弃更改或核对原请求。'); return false }
    return true
  }
  function selectTab(next: Tab) {
    if (next === tab || !canSwitch()) return
    setTab(next); setDraft(null); setReplacement(null); setSearch(''); setDiscard(false); setShowAi(false); tool.setError(null)
  }
  function edit(next: Draft, initialDirty = false) {
    if (blocked || !canSwitch()) return false
    setDraft(next); setReplacement(null); setDiscard(false); tool.setDirty(initialDirty); tool.setError(null); tool.setNotice(null)
    return true
  }
  function dropDraft() {
    if (tool.locked) return
    if (tool.dirty && !discard) { setDiscard(true); return }
    setDraft(null); setDiscard(false); tool.setDirty(false); tool.setError(null)
  }
  function saved(value: WorkbenchSnapshot) {
    setSnapshot(value)
    setDraft(null)
    setDiscard(false)
    syncRef.current = true
    setSyncRequired(true)
  }
  function receipt(value: WorkbenchSnapshot, expected: number) {
    return validSnapshot(value, bookId) && !value.requiresUpgrade && value.bookRevision === expected + 1
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft || blocked) return
    let success = false
    try {
      if (draft.kind === 'brief') {
        const input = parseSaveBriefInput(draft.input)
        success = await tool.write('workbench.brief', () => api.saveWritingBrief(input), (value) => receipt(value, input.expectedBookRevision) && sameFields(value.brief, input.brief), saved, '创作约定已保存。')
      } else if (draft.kind === 'scene') {
        const input = parseSaveSceneInput(draft.input)
        success = await tool.write('workbench.scene', () => api.saveScene(input), (value) => {
          const item = value?.scenes?.find((entry) => entry.id === input.id)
          return receipt(value, input.expectedBookRevision) && Boolean(item && item.revision === input.expectedRevision + 1 && sameFields(item, input.fields))
        }, saved, '场景卡已保存。')
      } else if (draft.kind === 'issue') {
        const input = parseSaveReviewIssueInput(draft.input)
        if (input.fields.status === 'resolved' && catalog.chapters.find((item) => item.id === input.fields.anchor.chapterId)?.revisionId !== input.fields.anchor.revisionId) {
          tool.setError('正文已变化，请更新正文来源并重新复核，再标记已解决。'); return
        }
        success = await tool.write('workbench.issue', () => api.saveReviewIssue(input), (value) => {
          const item = value?.issues?.find((entry) => entry.id === input.id)
          return receipt(value, input.expectedBookRevision) && Boolean(item && item.revision === input.expectedRevision + 1 && sameFields(item, input.fields))
        }, saved, '审稿问题已保存。')
      } else if (draft.kind === 'goal') {
        const input = parseSaveWritingGoalInput(draft.input)
        success = await tool.write('workbench.goal', () => api.saveWritingGoal(input), (value) => {
          const item = value?.goals?.find((entry) => entry.id === input.id)
          return receipt(value, input.expectedBookRevision) && Boolean(item && item.revision === input.expectedRevision + 1 && sameFields(item, input.fields))
        }, saved, '写作目标已保存。')
      } else if (draft.kind === 'session') {
        const input = parseLogWritingSessionInput(draft.input)
        if (input.date < activityStartDate() || input.date > localDate()) { tool.setError('请记录最近一年内的写作时段。'); return }
        const before = snapshot!.activity.filter((item) => item.date === input.date && item.source === 'manual').reduce((sum, item) => sum + item.minutes, 0)
        success = await tool.write('workbench.session', () => api.logWritingSession(input), (value) => receipt(value, input.expectedBookRevision)
          && value.activity.filter((item) => item.date === input.date && item.source === 'manual').reduce((sum, item) => sum + item.minutes, 0) >= before + input.minutes, saved, '手工填写的写作时段已保存。')
      } else {
        if (draft.input.status === 'finalized') { tool.setError('编辑已定稿章节的规划前，请明确选择新的章节状态。'); return }
        const input: UpdateChapterInput = { ...draft.input, status: draft.input.status, title: requiredText(draft.input.title, '章节名', 120),
          goal: optionalText(draft.input.goal, '章节目标', 10000), viewpoint: optionalText(draft.input.viewpoint, '章节视角', 500), notes: optionalText(draft.input.notes, '章节备注', 20000) }
        success = await tool.write('chapter.update', () => api.updateChapter(input), (value) => value.bookId === bookId && value.id === input.chapterId
          && value.bookRevision === input.expectedBookRevision + 1 && sameFields(value, { title: input.title.trim(), volumeId: input.volumeId,
            goal: input.goal, viewpoint: input.viewpoint, targetCharacters: input.targetCharacters, notes: input.notes, status: input.status }), (value) => {
          setDraft(null); syncRef.current = true; setSyncRequired(true)
          if (currentChapter?.id === value.id) onChapterChange(value)
        }, '章节规划已保存。')
      }
    } catch (failure) { tool.setError(failure instanceof DomainError ? failure.detail.message : '请检查表单内容后重试。') }
    if (success) await reloadAfterWrite()
  }
  async function reloadAfterWrite() {
    // 已确认写入后先同步目录版本；同步失败只重读，不能重复提交已成功的写入。
    await reload()
  }
  async function checkWriteReceipt() {
    // await 后 pending/dirty/busy 的 ref 已清理；不经过仍由 syncRef 保护的切换门禁。
    if (await tool.checkReceipt()) await reloadAfterWrite()
  }
  async function upgrade() {
    if (!snapshot || !canSwitch() || readonly) return
    const expectedBookRevision = snapshot.bookRevision
    const success = await tool.write('knowledge.upgrade', () => api.upgradeKnowledge({ bookId, expectedBookRevision }), (value) => value.bookId === bookId
      && value.schemaVersion >= WORKBENCH_SCHEMA_VERSION && !value.requiresUpgrade && value.bookRevision >= expectedBookRevision,
    () => { syncRef.current = true; setSyncRequired(true) }, '作品备份和升级已完成。')
    if (success) await reloadAfterWrite()
  }
  function editChapter(item: ChapterSummary) {
    edit({ kind: 'chapter', input: { ...mutation(), chapterId: item.id, title: item.title, volumeId: item.volumeId,
      goal: item.goal, viewpoint: item.viewpoint, targetCharacters: item.targetCharacters, notes: item.notes, status: item.status } })
  }
  function editScene(item?: SceneCard, source?: { run: AiRun; text: string }) {
    const opened = edit({ kind: 'scene', input: { ...mutation(), id: item?.id ?? crypto.randomUUID(), expectedRevision: item?.revision ?? 0,
      fields: item ? { title: item.title, chapterId: item.chapterId, position: item.position, goal: item.goal, conflict: item.conflict,
        outcome: item.outcome, viewpoint: item.viewpoint, characterIds: [...item.characterIds], locationId: item.locationId,
        storyTime: item.storyTime, plotline: item.plotline, status: item.status, targetCharacters: item.targetCharacters, anchor: item.anchor, archived: item.archived }
        : { title: source ? `${source.run.chapterTitle} · 场景计划`.slice(0, 120) : '', chapterId: source?.run.chapterId ?? currentChapter?.id ?? null, position: Math.min(100_000, Math.max(0, ...(snapshot?.scenes.map((entry) => entry.position) ?? [])) + 1),
          goal: source?.text ?? '', conflict: '', outcome: '', viewpoint: '', characterIds: [], locationId: null, storyTime: '', plotline: '',
          status: 'planned', targetCharacters: null, anchor: null, archived: false } } }, Boolean(source))
    if (opened && source) { setShowAi(false); tool.setNotice('已将 AI 规划带入场景目标。请确认并保存场景卡；正文不会改变。') }
  }
  function editIssue(item?: ReviewIssue, source?: { run: AiRun; text: string }) {
    const target = currentChapter ?? catalog.chapters[0]
    if (!item && !source && !target) { tool.setError('请先创建章节，再记录有正文基线的审稿问题。'); return }
    const fields: ReviewIssueFields = item ? { title: item.title, kind: item.kind, status: item.status, reason: item.reason, evidence: item.evidence,
      suggestion: item.suggestion, resolution: item.resolution, anchor: item.anchor, aiRunId: item.aiRunId,
      ...(item.replacement === undefined ? {} : { replacement: item.replacement }), ...(item.candidateSource ? { candidateSource: item.candidateSource } : {}) }
      : { title: source ? `${source.run.chapterTitle} · AI 建议待核对`.slice(0, 160) : '', kind: 'structure', status: 'open', reason: '', evidence: '',
        suggestion: source?.text ?? '', resolution: '', anchor: source ? { chapterId: source.run.chapterId,
          revisionId: source.run.context.chapterRevisionId, blockIds: source.run.context.selectedBlockIds.length <= 500 ? source.run.context.selectedBlockIds : [] }
          : { chapterId: target!.id, revisionId: target!.revisionId, blockIds: [] }, aiRunId: source?.run.id ?? null }
    if (edit({ kind: 'issue', input: { ...mutation(), id: item?.id ?? crypto.randomUUID(), expectedRevision: item?.revision ?? 0, fields } }, Boolean(source))) setShowAi(false)
  }
  function editGoal(item?: WritingGoal) {
    edit({ kind: 'goal', input: { ...mutation(), id: item?.id ?? crypto.randomUUID(), expectedRevision: item?.revision ?? 0,
      fields: item ? { period: item.period, metric: item.metric, target: item.target, active: item.active } : { period: 'day', metric: 'added', target: 1000, active: true } } })
  }
  async function previewReplacement(issue: ReviewIssue) {
    if (blocked || !canSwitch() || !snapshot) return
    if (issue.status !== 'open' || issue.stale || !reviewReplacement(issue).trim() || !issue.anchor.blockIds.length || issue.candidateSource?.item.requirement) {
      tool.setError('请先保存待处理问题、填写可直接替换的正文建议，并选择当前修订中的连续段落。'); return
    }
    const expectedRevision = snapshot.bookRevision
    await tool.read<RevisionSnapshot>(() => api.readRevision({ bookId, chapterId: issue.anchor.chapterId, revisionId: issue.anchor.revisionId }), (value) => {
      if (value.bookId !== bookId || value.chapterId !== issue.anchor.chapterId || value.id !== issue.anchor.revisionId) throw new Error('Mismatched revision')
      const ids = new Set(issue.anchor.blockIds)
      const indexes = value.document.content.flatMap((block, index) => ids.has(block.attrs.id) ? [index] : [])
      if (indexes.length !== ids.size || indexes.some((index, offset) => index !== indexes[0] + offset)) {
        tool.setError('所选段落不连续。请重新定位为连续段落并保存问题，再预览替换。'); return
      }
      setDraft(null); setShowAi(false)
      setReplacement({ issue, bookRevision: expectedRevision, original: indexes.map((index) => blockText(value.document.content[index])).join('\n\n'), confirmed: false })
    })
  }
  async function applyReplacement() {
    if (!replacement?.confirmed || blocked || !canSwitch()) return
    const intended = replacement
    const input = parseApplyReviewIssueInput({ bookId, expectedBookRevision: intended.bookRevision, id: intended.issue.id,
      expectedRevision: intended.issue.revision, expectedRevisionId: intended.issue.anchor.revisionId })
    const success = await tool.write('workbench.applyIssue', () => api.applyReviewIssue(input), (value) => {
      const issue = value?.workbench?.issues.find((item) => item.id === input.id)
      return receipt(value.workbench, input.expectedBookRevision) && value.chapter.bookId === bookId
        && value.chapter.id === intended.issue.anchor.chapterId && value.chapter.revisionId !== input.expectedRevisionId
        && value.chapter.bookRevision === value.workbench.bookRevision && Boolean(issue && issue.revision === input.expectedRevision + 1
          && issue.status === 'recheck' && issue.stale && sameFields(issue.anchor, intended.issue.anchor))
    }, (value) => { saved(value.workbench); setReplacement(null); onChapterChange(value.chapter) }, '已保存新的正文版本，问题转为待复核。请重新定位改稿后的段落，再判断是否解决。')
    if (success) await reloadAfterWrite()
  }

  return <section className={styles.panel} aria-label="创作工具" aria-busy={tool.busy}>
    <div className={styles.heading}><div><h3>{catalog.book.title}</h3><p className={styles.muted}>规划故事，记录判断，安排自己的写作节奏。</p></div>
      <button type="button" className={styles.button} disabled={tool.locked || tool.dirty} onClick={() => void reload()}>{syncRequired ? '重试同步' : '刷新资料'}</button></div>
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
    {tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {tool.pending && <div className={styles.warning}><p>保存结果尚未确认。当前表单已保留，请勿重新提交。</p>
      {tool.pending.error.requestId ? <button type="button" className={styles.button} disabled={tool.busy}
        onClick={() => void checkWriteReceipt()}>核对原请求</button>
        : <p>没有可查询的请求编号，请通过主窗口恢复流程核对。</p>}
      {onRecover && <><label className={styles.check}><input type="checkbox" checked={recoveryPreserved} onChange={(event) => setRecoveryPreserved(event.target.checked)} />我已留存所需内容，可以离开本面板进行恢复</label><button type="button" className={styles.button} disabled={tool.busy || !recoveryPreserved} onClick={onRecover}>打开主窗口恢复</button></>}
      <p>服务连接中断时，先保留当前输入，再从主窗口的草稿恢复入口重新连接并核对资料。</p></div>}
    {(draft || replacement) && (tool.pending || externalChange || tool.error) && <details className={styles.details}><summary>查看并复制当前内容留存</summary><textarea readOnly rows={10} value={JSON.stringify(draft?.input ?? replacement, null, 2)} aria-label="尚未确认的表单内容与来源标识" /></details>}
    {syncRequired && !tool.pending && <p className={styles.warning} role="status">{tool.busy ? '写入已确认，正在同步作品目录…' : '写入已确认，作品目录尚未同步。请点“重试同步”继续读取，成功后可继续编辑；无需再次保存。'}</p>}
    {externalChange && <p className={styles.warning}>作品已在其他操作中改变。请保留当前输入，处理完后刷新，再基于新版本编辑。</p>}
    {readonly && <p className={styles.warning}>作品已归档，创作工具仅供查看。恢复作品后可继续编辑。</p>}
    {!snapshot ? <p className={styles.empty} role="status">{tool.busy ? '正在读取创作资料…' : '尚未取得创作资料，可点击“刷新资料”重试。'}</p>
      : snapshot.requiresUpgrade ? <div className={styles.empty}><h4>为这部作品启用创作工具</h4><p>升级前会保存作品数据库备份，升级后可使用场景、创作约定、审稿和写作记录。</p>
        <button type="button" className={styles.primaryButton} disabled={tool.locked || readonly} onClick={() => void upgrade()}>备份并升级作品</button></div>
        : <>
          <div className={styles.tabs} role="tablist" aria-label="创作工具分类">{tabs.map((item, index) => <button key={item.id} type="button" role="tab"
            id={`${prefix}-${item.id}`} aria-controls={`${prefix}-content`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
            disabled={tool.locked} onClick={() => selectTab(item.id)} onKeyDown={(event) => {
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
              if (next === null) return
              event.preventDefault()
              if (canSwitch()) { selectTab(tabs[next].id); document.getElementById(`${prefix}-${tabs[next].id}`)?.focus() }
            }}>{item.label}</button>)}</div>
          <div id={`${prefix}-content`} role="tabpanel" aria-labelledby={`${prefix}-${tab}`} className={styles.content}>
            {tab === 'outline' && <>
              <div className={styles.toolbar}><label>查找章节<input type="search" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} placeholder="章节名、目标或视角" /></label><p className={styles.muted}>{catalog.chapters.length} 章 · {catalog.chapters.reduce((sum, item) => sum + item.characterCount, 0).toLocaleString()} 字</p></div>
              {!catalog.chapters.length ? <p className={styles.empty}>先在章节目录新建第一章，再填写目标或规划场景。</p> : <div className={styles.tableScroll} tabIndex={0} aria-label="章节大纲表，可横向滚动"><table className={styles.table}>
                <thead><tr><th scope="col">章节</th><th scope="col">目标</th><th scope="col">视角</th><th scope="col">状态</th><th scope="col">实际 / 计划字数</th><th scope="col">操作</th></tr></thead>
                <tbody>{catalog.chapters.filter((item) => `${item.title} ${item.goal} ${item.viewpoint}`.includes(search.trim())).map((item) => <tr key={item.id}>
                  <th scope="row">{item.title}<small>{catalog.volumes.find((volume) => volume.id === item.volumeId)?.title ?? '未分卷'}</small></th>
                  <td className={styles.proseCell}>{item.goal || '未填写'}</td><td>{item.viewpoint || '未指定'}</td><td>{statusLabels[item.status]}</td>
                  <td className={styles.number}>{item.characterCount.toLocaleString()} / {item.targetCharacters?.toLocaleString() ?? '未设定'}</td>
                  <td><div className={styles.actions}><button className={styles.button} type="button" disabled={blocked} onClick={() => editChapter(item)}>编辑</button>
                    <button className={styles.button} type="button" disabled={tool.locked || syncRequired} onClick={() => { if (canSwitch()) onNavigate(item.id) }}>写作</button></div></td></tr>)}</tbody>
              </table></div>}
            </>}
            {tab === 'scenes' && <>
              <div className={styles.toolbar}><label>查找场景<input type="search" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} /></label>
                <label className={styles.check}><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />显示已归档</label>
                <button className={styles.primaryButton} type="button" disabled={blocked} onClick={() => editScene()}>添加场景</button>
                <button className={styles.button} type="button" disabled={blocked} onClick={() => { if (canSwitch()) { setDraft(null); setShowAi((value) => !value) } }}>从 AI 规划载入</button></div>
              {showAi && <AiSuggestionPicker key="scene-plan" api={api} bookId={bookId} disabled={blocked || tool.dirty} planOnly onSelect={(run, text) => editScene(undefined, { run, text })} />}
              <p className={styles.muted}>场景顺序是计划顺序；调整场景卡不会移动正文。可以先写正文，再补场景卡和来源。</p>
              {scenes.length ? <ol className={styles.records}>{scenes.map((item) => <li key={item.id}><div className={styles.recordHeading}><div><strong>{item.position}. {item.title}</strong>
                <p className={styles.muted}>{catalog.chapters.find((entry) => entry.id === item.chapterId)?.title ?? '未归属章节'} · {sceneStatuses[item.status]}{item.archived ? ' · 已归档' : ''}{item.stale ? ' · 正文基线已改变' : ''}</p></div>
                <button className={styles.button} type="button" disabled={blocked} onClick={() => editScene(item)}>编辑场景</button></div>
                {(item.goal || item.conflict || item.outcome) && <dl className={styles.summary}><div><dt>目标</dt><dd>{item.goal || '待补充'}</dd></div><div><dt>冲突</dt><dd>{item.conflict || '待补充'}</dd></div><div><dt>结束变化</dt><dd>{item.outcome || '待补充'}</dd></div></dl>}
                <p className={styles.muted}>{[item.viewpoint && `视角：${item.viewpoint}`, item.storyTime && `故事时间：${item.storyTime}`, item.plotline && `情节线：${item.plotline}`].filter(Boolean).join(' · ')}</p></li>)}</ol>
                : <div className={styles.empty}><h4>{search || includeArchived ? '没有符合条件的场景' : '把一个转折写成场景'}</h4><p>从角色想要什么、遇到什么阻碍、结束时改变了什么开始。章节和正文关联都可以稍后补上。</p><button className={styles.button} type="button" disabled={blocked} onClick={() => editScene()}>创建第一张场景卡</button></div>}
            </>}
            {tab === 'brief' && <>
              <div className={styles.toolbar}><p className={styles.muted}>创作约定随作品保存。AI 实际使用哪些约定，以发送前的上下文预览为准。</p><button className={styles.primaryButton} type="button" disabled={blocked} onClick={() => edit({ kind: 'brief', input: { ...mutation(), brief: { ...snapshot.brief } } })}>编辑创作约定</button></div>
              <dl className={styles.brief}>{([['premise', '故事前提'], ['style', '风格约定'], ['narrator', '叙述人称'], ['tense', '叙述时态'], ['rules', '不可违背的规则']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{snapshot.brief[key] || '尚未填写'}</dd></div>)}</dl>
            </>}
            {tab === 'review' && <>
              <div className={styles.toolbar}><label>查找问题<input type="search" value={search} maxLength={200} placeholder="标题、当前或原始依据" onChange={(event) => setSearch(event.target.value)} /></label>
                <label>处理状态<select value={issueFilter} onChange={(event) => setIssueFilter(event.target.value as typeof issueFilter)}><option value="all">全部状态</option>{REVIEW_STATES.map((state) => <option key={state} value={state}>{issueStates[state]}</option>)}</select></label>
                <button type="button" className={styles.primaryButton} disabled={blocked || !catalog.chapters.length} onClick={() => editIssue()}>记录问题</button>
                {onReview && <button type="button" className={styles.button} disabled={blocked || tool.dirty || !currentChapter} onClick={() => onReview('综合审阅本章结构、因果、人物知情、伏笔、语言和对白。每项保留固定段落引文及反证；需要核对缺失事项时明确选入章纲要求，不推断未提供的前文。')}>准备 AI 审稿</button>}
                <button type="button" className={styles.button} disabled={blocked} onClick={() => { if (canSwitch()) { setDraft(null); setShowAi((value) => !value) } }}>从 AI 历史选取</button></div>
              {showAi && <AiSuggestionPicker key="review" api={api} bookId={bookId} disabled={blocked || tool.dirty} onSelect={(run, text) => editIssue(undefined, { run, text })} />}
              {issues.length ? <ul className={styles.records}>{issues.map((item) => <li key={item.id}><div className={styles.recordHeading}><div><strong>{item.title}</strong>
                <p className={styles.muted}>{issueKinds[item.kind]} · {issueStates[item.status]} · {catalog.chapters.find((entry) => entry.id === item.anchor.chapterId)?.title ?? '历史章节'}{item.aiRunId ? ' · 来源于 AI 历史' : ''}</p></div>
                <div className={styles.actions}><button type="button" className={styles.button} disabled={blocked} onClick={() => editIssue(item)}>查看 / 处理</button>
                  {item.status === 'open' && reviewReplacement(item).trim() && item.anchor.blockIds.length > 0 && !item.candidateSource?.item.requirement && <button type="button" className={styles.button} disabled={blocked || item.stale} onClick={() => void previewReplacement(item)}>预览正文替换</button>}</div></div>
                {item.candidateSource && <details className={styles.details}><summary>固定模型建议与可能反证</summary><p>{item.candidateSource.item.counterpoint || '模型未提供反证。'}</p>{item.candidateSource.item.requirement && <blockquote>章纲要求：{item.candidateSource.item.requirement.text}<small>{item.candidateSource.item.requirement.revisionId}</small></blockquote>}<pre>{JSON.stringify(item.candidateSource.item, null, 2)}</pre></details>}
                {item.stale && <p className={styles.warning}>当前复核定位对应的正文已改变，请重新核对。原始依据与已有处理结论仍保留。</p>}
                <p className={styles.excerpt}>{item.reason || item.suggestion || '尚未填写理由或建议。'}</p>
                <ReviewOriginalEvidence api={api} book={catalog} issue={item} currentAnchor={item.anchor} disabled={tool.locked} />
                <p className={styles.muted}>更新于 {displayTime(item.updatedAt)}</p></li>)}</ul>
                : <div className={styles.empty}><h4>把审稿判断留到下次也找得到</h4><p>记录理由、证据与建议，改稿后标为“待复核”。“有意安排”和“误报”也会保留判断。</p><button className={styles.button} type="button" disabled={blocked || !catalog.chapters.length} onClick={() => editIssue()}>记录一条审稿问题</button></div>}
            </>}
            {tab === 'architect' && (
              <StoryArchitectView
                book={catalog}
                snapshot={snapshot}
                disabled={blocked}
                onApplyBrief={(brief: WorkbenchSnapshot['brief']) => edit({ kind: 'brief', input: { ...mutation(), brief } }, true)}
                onCreateScene={(sceneGoal: string) => {
                  setTab('scenes')
                  edit({
                    kind: 'scene',
                    input: {
                      ...mutation(),
                      id: crypto.randomUUID(),
                      expectedRevision: 0,
                      fields: {
                        title: '开篇黄金第一场 · 危机入局',
                        chapterId: currentChapter?.id ?? catalog.chapters[0]?.id ?? null,
                        position: (snapshot.scenes.length || 0) + 1,
                        goal: sceneGoal,
                        conflict: '核心阻碍突发降临，退路被断',
                        outcome: '主角被迫亮出底牌，悬念钩子抛出',
                        viewpoint: snapshot.brief.narrator || '第三人称限知',
                        characterIds: [],
                        locationId: null,
                        storyTime: '开篇第一日',
                        plotline: '主线开局',
                        status: 'planned',
                        targetCharacters: 2500,
                        anchor: null,
                        archived: false,
                      },
                    },
                  }, true)
                }}
              />
            )}
            {tab === 'detector' && (
              <LanguageReviewPanel
                chapter={currentChapter}
                disabled={blocked}
                onReview={onReview}
                onRegister={(finding: LanguageFinding) => {
                  const target = currentChapter
                  if (!target) return
                  setTab('review')
                  edit({
                    kind: 'issue',
                    input: {
                      ...mutation(),
                      id: crypto.randomUUID(),
                      expectedRevision: 0,
                      fields: {
                        title: `语言提示 · ${finding.category}`,
                        kind: 'language',
                        status: 'open',
                        reason: finding.reason,
                        evidence: finding.quote,
                        suggestion: '结合上下文检查是否需要更具体的动作与感官细节；允许保留刻意表达。',
                        replacement: '',
                        resolution: '',
                        anchor: {
                          chapterId: target.id,
                          revisionId: target.revisionId,
                          blockIds: finding.blockId ? [finding.blockId] : [],
                        },
                        aiRunId: null,
                      },
                    },
                  }, true)
                }}
              />
            )}
            {tab === 'readers' && (
              <ReaderReviewPanel chapter={currentChapter} disabled={blocked || tool.dirty} onReview={onReview} />
            )}
            {tab === 'activity' && <>
              <div className={styles.toolbar}><label>查看日期<input type="date" min={activityStartDate()} max={localDate()} value={date} onChange={(event) => { if (event.target.value && event.target.validity.valid) setDate(event.target.value) }} /></label><label>统计范围<select value={period} onChange={(event) => setPeriod(event.target.value as 'day' | 'week')}><option value="day">当日</option><option value="week">所在周（周一起）</option></select></label>
                <button className={styles.primaryButton} type="button" disabled={blocked} onClick={() => edit({ kind: 'session', input: { ...mutation(), id: crypto.randomUUID(), date, minutes: 0, revisedChapterId: null } })}>手工记录写作时段</button>
                <button className={styles.button} type="button" disabled={blocked} onClick={() => editGoal()}>添加目标</button></div>
              <ActivitySummary snapshot={snapshot} date={date} period={period} onEditGoal={editGoal} disabled={blocked} />
            </>}
            {replacement && <section ref={replacementRef} className={styles.editor} aria-label="确认正文替换"><h4>把建议作为替换正文</h4><p className={styles.muted}>针对“{replacement.issue.title}”的 {replacement.issue.anchor.blockIds.length} 个连续段落。替换按纯文本写入新版本，旧稿仍可回看。</p>
              <AiTextDiff originalText={replacement.original} suggestedText={reviewReplacement(replacement.issue)} disabled={blocked} onAcceptText={(text) => {
                editIssue(replacement.issue); setDraft({ kind: 'issue', input: { ...mutation(), id: replacement.issue.id, expectedRevision: replacement.issue.revision,
                  fields: { ...replacement.issue, replacement: text } } }); setReplacement(null); tool.setDirty(true)
              }} />
              <div className={styles.comparison}><label>原文 · 固定修订<textarea readOnly rows={10} value={replacement.original} /></label><label>将写入的替换正文<textarea readOnly rows={10} value={reviewReplacement(replacement.issue)} /></label></div>
              <label className={styles.check}><input type="checkbox" checked={replacement.confirmed} disabled={blocked} onChange={(event) => setReplacement({ ...replacement, confirmed: event.target.checked })} />我已核对，建议内容是可直接写入小说的替换正文；分析性说明应保留在问题记录中。</label>
              <div className={styles.actions}><button type="button" className={styles.primaryButton} disabled={blocked || !replacement.confirmed || replacement.bookRevision !== snapshot.bookRevision} onClick={() => void applyReplacement()}>确认替换并进入待复核</button><button type="button" className={styles.button} disabled={tool.locked} onClick={() => setReplacement(null)}>取消替换</button></div>
            </section>}
            {draft && <form ref={editorRef} tabIndex={-1} className={styles.editor} onSubmit={(event) => void submit(event)}>
              <div className={styles.heading}><h4>{draft.kind === 'chapter' ? '编辑章节规划' : draft.kind === 'brief' ? '编辑创作约定' : draft.kind === 'scene' ? '编辑场景卡' : draft.kind === 'issue' ? '记录与处理审稿问题' : draft.kind === 'goal' ? '编辑写作目标' : '手工记录写作时段'}</h4><span className={styles.muted}>{tool.dirty ? '有未保存更改' : '尚未修改'}</span></div>
              {draft.kind === 'issue' && (editingIssue
                ? <ReviewOriginalEvidence key={editingIssue.id} api={api} book={catalog} issue={editingIssue} currentAnchor={draft.input.fields.anchor} disabled={tool.locked} />
                : <p className={styles.muted}>首次保存后，正文来源、证据与理由会保留为只读的原始依据。</p>)}
              <fieldset disabled={blocked}>
                {draft.kind === 'chapter' && <ChapterFields input={draft.input} book={catalog} onChange={(input) => changed({ kind: 'chapter', input })} />}
                {draft.kind === 'brief' && <div className={styles.fields}>{([['premise', '故事前提', 5000, '主角想要什么，又被什么阻碍？'], ['style', '风格约定', 5000, '语言、节奏、氛围与需要避免的写法'], ['narrator', '叙述人称', 500, '例如：第三人称限知'], ['tense', '叙述时态', 500, '例如：过去时'], ['rules', '不可违背的规则', 10000, '世界规则、人物边界和连续性约定']] as const).map(([key, label, max, placeholder]) => <label key={key}>{label}<textarea rows={key === 'narrator' || key === 'tense' ? 2 : 4} maxLength={max} placeholder={placeholder} value={draft.input.brief[key]} onChange={(event) => changed({ ...draft, input: { ...draft.input, brief: { ...draft.input.brief, [key]: event.target.value } } })} /></label>)}</div>}
                {draft.kind === 'scene' && <SceneEditor api={api} book={catalog} chapter={currentChapter} fields={draft.input.fields} disabled={blocked} onChange={(fields) => changed({ ...draft, input: { ...draft.input, fields } })} />}
                {draft.kind === 'issue' && <IssueEditor book={catalog} chapter={currentChapter} fields={draft.input.fields} onChange={(fields) => changed({ ...draft, input: { ...draft.input, fields } })} />}
                {draft.kind === 'goal' && <GoalEditor fields={draft.input.fields} onChange={(fields) => changed({ ...draft, input: { ...draft.input, fields } })} />}
                {draft.kind === 'session' && <div className={styles.fieldGrid}>
                  <label>写作日期<input type="date" required min={activityStartDate()} max={localDate()} value={draft.input.date} onChange={(event) => changed({ ...draft, input: { ...draft.input, date: event.target.value } })} /></label>
                  <label>手工填写时长（分钟）<input type="number" required min={0} max={1440} step={1} value={Number.isFinite(draft.input.minutes) ? draft.input.minutes : ''} onChange={(event) => changed({ ...draft, input: { ...draft.input, minutes: event.target.valueAsNumber } })} /></label>
                  <label>本次完成改稿的章节<select value={draft.input.revisedChapterId ?? ''} onChange={(event) => changed({ ...draft, input: { ...draft.input, revisedChapterId: event.target.value || null } })}><option value="">仅记录时长</option>{catalog.chapters.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
                  <p className={styles.muted}>时长由你手工填写，当前没有自动计时。同一章同一天的改稿只计一次；字数另按正文保存前后的差异统计。</p>
                </div>}
              </fieldset>
              {draft.input.expectedBookRevision !== snapshot.bookRevision && <p className={styles.warning}>表单来自较早的作品版本。输入已保留，请放弃更改并刷新后重新编辑。</p>}
              <div className={styles.actions}><button className={styles.primaryButton} type="submit" disabled={blocked || draft.input.expectedBookRevision !== snapshot.bookRevision}>{tool.busy ? '正在保存…' : '保存'}</button>
                <button className={styles.button} type="button" disabled={tool.locked} onClick={dropDraft}>{tool.dirty ? '放弃未保存更改' : '收起编辑'}</button></div>
              {discard && <div className={styles.warning} role="alert"><p>确定放弃这份表单的未保存更改？已保存的内容会保留。</p><div className={styles.actions}><button className={styles.button} type="button" onClick={dropDraft}>确认放弃</button><button className={styles.button} type="button" onClick={() => setDiscard(false)}>继续编辑</button></div></div>}
            </form>}
          </div>
        </>}
  </section>
}

function ChapterFields({ input, book, onChange }: { input: Extract<Draft, { kind: 'chapter' }>['input']; book: BookSnapshot; onChange: (value: Extract<Draft, { kind: 'chapter' }>['input']) => void }) {
  return <div className={styles.fields}><div className={styles.fieldGrid}><label>章节名称<input value={input.title} required maxLength={120} onChange={(event) => onChange({ ...input, title: event.target.value })} /></label><label>所属卷<select value={input.volumeId ?? ''} onChange={(event) => onChange({ ...input, volumeId: event.target.value || null })}><option value="">未分卷</option>{book.volumes.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>视角<input value={input.viewpoint} maxLength={500} onChange={(event) => onChange({ ...input, viewpoint: event.target.value })} /></label><label>计划字数<input type="number" min={0} max={1000000} step={1} value={input.targetCharacters ?? ''} onChange={(event) => onChange({ ...input, targetCharacters: event.target.value === '' ? null : event.target.valueAsNumber })} /></label><label>章节状态<select value={input.status} onChange={(event) => onChange({ ...input, status: event.target.value as ChapterSummary['status'] })}>{input.status === 'finalized' && <option value="finalized">已定稿 · 请明确选择编辑后的状态</option>}<option value="planned">待写</option><option value="writing">草稿</option><option value="review">待审</option></select></label></div>{input.status === 'finalized' && <p className={styles.warning}>保存规划需要将本章转回待写、草稿或待审。既有定稿版本仍保留，可在版本历史中查看。</p>}<label>章节目标<textarea rows={3} maxLength={10000} value={input.goal} onChange={(event) => onChange({ ...input, goal: event.target.value })} /></label><label>章节备注<textarea rows={4} maxLength={20000} value={input.notes} onChange={(event) => onChange({ ...input, notes: event.target.value })} /></label></div>
}

function GoalEditor({ fields, onChange }: { fields: WritingGoalFields; onChange: (fields: WritingGoalFields) => void }) {
  return <div className={styles.fieldGrid}>
    <label>目标周期<select value={fields.period} onChange={(event) => onChange({ ...fields, period: event.target.value as 'day' | 'week' })}><option value="day">每天</option><option value="week">每周（周一至周日）</option></select></label>
    <label>衡量方式<select value={fields.metric} onChange={(event) => onChange({ ...fields, metric: event.target.value as WritingGoalFields['metric'] })}>{WRITING_METRICS.map((metric) => <option key={metric} value={metric}>{metricLabels[metric]}</option>)}</select></label>
    <label>目标数量<input type="number" required min={1} max={1000000} step={1} value={Number.isFinite(fields.target) ? fields.target : ''} onChange={(event) => onChange({ ...fields, target: event.target.valueAsNumber })} /></label>
    <label className={styles.check}><input type="checkbox" checked={fields.active} onChange={(event) => onChange({ ...fields, active: event.target.checked })} />启用目标</label>
  </div>
}

function SceneEditor({ api, book, chapter, fields, disabled, onChange }: {
  api: StudioApi; book: BookSnapshot; chapter: ChapterSnapshot | null; fields: SceneFields; disabled: boolean; onChange: (value: SceneFields) => void
}) {
  return <div className={styles.fields}><div className={styles.fieldGrid}>
    <label>场景名称<input required maxLength={120} value={fields.title} onChange={(event) => onChange({ ...fields, title: event.target.value })} /></label>
    <label>归属章节<select value={fields.chapterId ?? ''} onChange={(event) => onChange({ ...fields, chapterId: event.target.value || null, anchor: null })}><option value="">暂不归属章节</option>{book.chapters.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <label>计划顺序<input type="number" required min={0} max={100000} step={1} value={Number.isFinite(fields.position) ? fields.position : ''} onChange={(event) => onChange({ ...fields, position: event.target.valueAsNumber })} /></label>
    <label>状态<select value={fields.status} onChange={(event) => onChange({ ...fields, status: event.target.value as SceneFields['status'] })}>{Object.entries(sceneStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>视角<input maxLength={500} value={fields.viewpoint} onChange={(event) => onChange({ ...fields, viewpoint: event.target.value })} /></label>
    <label>计划字数<input type="number" min={0} max={1000000} step={1} value={fields.targetCharacters ?? ''} onChange={(event) => onChange({ ...fields, targetCharacters: event.target.value === '' ? null : event.target.valueAsNumber })} /></label>
    <label>故事时间<input maxLength={1000} value={fields.storyTime} onChange={(event) => onChange({ ...fields, storyTime: event.target.value })} placeholder="可用相对时间，如第二天清晨" /></label>
    <label>情节线<input maxLength={500} value={fields.plotline} onChange={(event) => onChange({ ...fields, plotline: event.target.value })} /></label>
  </div>{([['goal', '角色目标'], ['conflict', '阻碍与冲突'], ['outcome', '结束时的变化']] as const).map(([key, label]) => <label key={key}>{label}<textarea rows={3} maxLength={10000} value={fields[key]} onChange={(event) => onChange({ ...fields, [key]: event.target.value })} /></label>)}
    <EntityPicker api={api} bookId={book.book.id} kind="person" value={fields.characterIds} disabled={disabled} onChange={(characterIds) => onChange({ ...fields, characterIds })} />
    <EntityPicker api={api} bookId={book.book.id} kind="place" value={fields.locationId ? [fields.locationId] : []} disabled={disabled} onChange={(ids) => onChange({ ...fields, locationId: ids[0] ?? null })} />
    <AnchorEditor value={fields.anchor} chapter={chapter} target={book.chapters.find((item) => item.id === fields.chapterId) ?? null} optional onChange={(anchor) => onChange({ ...fields, anchor })} />
    <label className={styles.check}><input type="checkbox" checked={fields.archived} onChange={(event) => onChange({ ...fields, archived: event.target.checked })} />归档场景卡（保留内容与来源）</label>
  </div>
}

function EntityPicker({ api, bookId, kind, value, disabled, onChange }: {
  api: StudioApi; bookId: string; kind: 'person' | 'place'; value: string[]; disabled: boolean; onChange: (ids: string[]) => void
}) {
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [page, setPage] = useState<KnowledgeItemPage | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ticket = useRef(0)
  const active = useRef(true)
  const locked = disabled || loading
  useEffect(() => { active.current = true; return () => { active.current = false; ticket.current += 1 } }, [])
  async function load(query: string, nextOffset: number) {
    if (locked) return
    const expected = ++ticket.current
    setLoading(true); setError(null)
    const result = await request(() => api.listKnowledgeItems({ bookId, kind, search: query.trim(), limit: 20, offset: nextOffset }))
    if (!active.current || ticket.current !== expected) return
    setLoading(false)
    if (!result.ok) { setError(result.error.message); return }
    if (result.data.bookId !== bookId || result.data.items.some((item) => item.kind !== kind || item.bookId !== bookId)) { setError('资料回执不匹配，请重新查询。'); return }
    setPage(result.data); setOffset(nextOffset); setAppliedSearch(query)
    setNames((previous) => ({ ...previous, ...Object.fromEntries(result.data.items.map((item) => [item.id, item.name])) }))
  }
  return <details className={styles.details}><summary>关联{kind === 'person' ? '人物' : '地点'} · 已选 {value.length}</summary>
    {value.length > 0 && <ul className={styles.selection}>{value.map((id) => <li key={id}><span>{names[id] ?? `已关联条目 ${id}`}</span><button className={styles.button} type="button" disabled={locked} onClick={() => onChange(value.filter((item) => item !== id))}>取消关联</button></li>)}</ul>}
    <div className={styles.toolbar}><label>{kind === 'person' ? '查找人物' : '查找地点'}<input type="search" maxLength={200} value={search} disabled={locked} onChange={(event) => setSearch(event.target.value)} /></label><button className={styles.button} type="button" disabled={locked} onClick={() => void load(search, 0)}>{loading ? '查找中…' : '查找已有条目'}</button></div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {page && <><ul className={styles.selection}>{page.items.map((item) => <li key={item.id}><span>{item.name}<small>{item.summary.slice(0, 100)}</small></span><button className={styles.button} type="button" disabled={locked || value.includes(item.id) || (kind === 'person' && value.length >= 100)} onClick={() => onChange(kind === 'place' ? [item.id] : [...value, item.id])}>{value.includes(item.id) ? '已关联' : kind === 'place' && value.length ? '改用此地点' : '关联'}</button></li>)}</ul>{!page.items.length && <p className={styles.muted}>没有匹配的条目。可以先保存场景，再到资料库创建人物或地点。</p>}<div className={styles.actions}><button className={styles.button} type="button" disabled={locked || offset === 0} onClick={() => void load(appliedSearch, Math.max(0, offset - 20))}>上一页</button><span className={styles.muted}>共 {page.total} 项</span><button className={styles.button} type="button" disabled={locked || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) void load(appliedSearch, page.nextOffset) }}>下一页</button></div></>}
  </details>
}

function AnchorEditor({ value, chapter, target, optional = false, title = '固定正文来源', onChange }: {
  value: ManuscriptAnchor | null; chapter: ChapterSnapshot | null; target: ChapterSummary | null; optional?: boolean; title?: string; onChange: (value: ManuscriptAnchor | null) => void
}) {
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const current = target && chapter && chapter.id === target.id && chapter.revisionId === target.revisionId ? chapter : null
  const canSelectBlocks = Boolean(value && current && value.chapterId === current.id && value.revisionId === current.revisionId)
  const blocks = useMemo(() => current?.document.content.filter((item) => !query.trim() || blockText(item).includes(query.trim())) ?? [], [current, query])
  useEffect(() => { setOffset(0); setQuery('') }, [value?.chapterId, value?.revisionId])
  return <section className={styles.anchor} aria-label={title}><div className={styles.heading}><h4>{title}</h4><span className={styles.muted}>{value ? value.blockIds.length ? `已选 ${value.blockIds.length} 段` : '关联整章修订' : '尚未关联正文'}</span></div>
    {value && <p className={styles.identity}>章节：{target?.title ?? value.chapterId}<br />固定修订：{value.revisionId}</p>}
    {value && target && value.revisionId !== target.revisionId && <p className={styles.warning}>这份证据来自历史修订。若正文已经调整，请重新核对后再更新来源。</p>}
    <div className={styles.actions}><button className={styles.button} type="button" disabled={!target} onClick={() => { if (target) onChange({ chapterId: target.id, revisionId: target.revisionId, blockIds: [] }) }}>{value ? '更新为本章当前修订（清空选段）' : '关联本章当前修订'}</button>{optional && value && <button className={styles.button} type="button" onClick={() => onChange(null)}>解除正文关联</button>}</div>
    {!target ? <p className={styles.muted}>选择所属章节后，可关联正文。</p> : !current ? <p className={styles.muted}>当前仅有本章摘要。先保存表单，再打开这章写作，可在这里选择具体段落；整章修订已经可以作为来源。</p>
      : canSelectBlocks && value ? <details className={styles.details}><summary>选择当前章的具体段落</summary><p className={styles.muted}>不选段落表示关联整章。最多选择 500 段，分页只影响显示。</p><label>查找段落<input type="search" value={query} maxLength={200} onChange={(event) => { setQuery(event.target.value); setOffset(0) }} /></label>
        <div className={styles.blockList}>{blocks.slice(offset, offset + 40).map((block) => <label className={styles.block} key={block.attrs.id}><input type="checkbox" checked={value.blockIds.includes(block.attrs.id)} disabled={!value.blockIds.includes(block.attrs.id) && value.blockIds.length >= 500} onChange={(event) => onChange({ ...value, blockIds: event.target.checked ? [...value.blockIds, block.attrs.id] : value.blockIds.filter((id) => id !== block.attrs.id) })} /><span>{blockText(block).slice(0, 350)}</span></label>)}</div><div className={styles.actions}><button className={styles.button} type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 40))}>上一页</button><span className={styles.muted}>{blocks.length ? `${offset + 1}–${Math.min(offset + 40, blocks.length)} / ${blocks.length} 段` : '没有匹配段落'}</span><button className={styles.button} type="button" disabled={offset + 40 >= blocks.length} onClick={() => setOffset(offset + 40)}>下一页</button></div></details> : null}
  </section>
}

function ReviewOriginalEvidence({ api, book, issue, currentAnchor, disabled }: {
  api: StudioApi; book: BookSnapshot; issue: ReviewIssue; currentAnchor: ManuscriptAnchor; disabled: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const anchor = issue.originalAnchor
  const available = anchor && typeof issue.originalEvidence === 'string' && typeof issue.originalReason === 'string'
  return <details className={`${styles.details} ${styles.originalEvidence}`} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>查看原始依据 · 首次记录 · 只读</summary>
    {expanded && (available ? <>
      <p className={styles.muted}>{sameFields(currentAnchor, anchor) ? '当前复核定位与首次记录相同。' : '当前复核定位已调整，以下仍是首次记录的依据。'}后续编辑与重新定位不会覆盖这里的内容。</p>
      <dl className={styles.evidenceFields}>
        <div><dt>原始固定来源</dt><dd>{book.chapters.find((item) => item.id === anchor.chapterId)?.title ?? '历史章节'}
          <p className={styles.identity}>章节标识：{anchor.chapterId}<br />固定修订：{anchor.revisionId}</p>
          <p>{anchor.blockIds.length ? `原始证据关联 ${anchor.blockIds.length} 个段落。` : '原始证据关联整章修订，未限定段落。'}</p>
          {anchor.blockIds.length > 0 && <details className={styles.details}><summary>查看原始段落标识</summary><p className={styles.identity}>{anchor.blockIds.join('\n')}</p></details>}
        </dd></div>
        <div><dt>原始证据与引用</dt><dd>{issue.originalEvidence || '首次记录未填写证据与引用。'}</dd></div>
        <div><dt>原始理由</dt><dd>{issue.originalReason || '首次记录未填写理由。'}</dd></div>
      </dl>
      <OriginalRevisionPreview key={`${book.book.id}:${JSON.stringify(anchor)}`} api={api} bookId={book.book.id} anchor={anchor} disabled={disabled} />
    </> : <p className={styles.warning}>尚未取得原始依据。请处理完当前编辑后刷新资料；当前复核内容不会被当作首次记录展示。</p>)}
  </details>
}

function OriginalRevisionPreview({ api, bookId, anchor, disabled }: {
  api: StudioApi; bookId: string; anchor: ReviewIssue['originalAnchor']; disabled: boolean
}) {
  const [preview, setPreview] = useState<{ sequence: number; createdAt: string; blocks: { block: ManuscriptBlock; position: number }[] } | null>(null)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const loadingRef = useRef(false)
  const ticket = useRef(0)
  useEffect(() => { active.current = true; return () => { active.current = false; ticket.current += 1 } }, [])
  async function load() {
    if (disabled || loadingRef.current || !active.current) return
    const expected = ++ticket.current
    loadingRef.current = true
    setLoading(true); setError(null); setPreview(null); setOffset(0)
    // 原始证据单独按固定版本读取；不切换编辑章，也不清理父面板的 dirty 状态。
    const result = await request(() => api.readRevision({ bookId, chapterId: anchor.chapterId, revisionId: anchor.revisionId }))
    if (!active.current || ticket.current !== expected) return
    loadingRef.current = false
    setLoading(false)
    if (!result.ok) { setError(result.error.message); return }
    const value = result.data
    if (value.bookId !== bookId || value.chapterId !== anchor.chapterId || value.id !== anchor.revisionId || !Array.isArray(value.document?.content)) {
      setError('固定版本回执与原始来源不一致，未展示正文。请重试读取。'); return
    }
    const ids = new Set(anchor.blockIds)
    const blocks = value.document.content.flatMap((block, index) => !ids.size || ids.has(block.attrs.id) ? [{ block, position: index + 1 }] : [])
    const matchedIds = new Set(blocks.map(({ block }) => block.attrs.id))
    if (ids.size !== anchor.blockIds.length || matchedIds.size !== blocks.length || ids.size > 0 && matchedIds.size !== ids.size) {
      setError('原始段落标识与固定版本不一致，未展示不完整的证据。'); return
    }
    setPreview({ sequence: value.sequence, createdAt: value.createdAt, blocks })
  }
  return <section aria-label="原始固定版本正文" aria-busy={loading}>
    <button type="button" className={styles.button} disabled={disabled || loading} onClick={() => void load()}>{loading ? '正在读取原始固定版本…' : preview ? '重新读取原始固定版本' : '查看原始固定版本正文'}</button>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {preview && <>
      <p className={styles.muted}>原始固定版本第 {preview.sequence} 版 · {displayTime(preview.createdAt)} · {anchor.blockIds.length ? '仅展示原始选段' : '展示原始整章'}，共 {preview.blocks.length} 段</p>
      <div className={styles.revisionExcerpt} role="region" tabIndex={0} aria-label="原始正文，可滚动阅读">{preview.blocks.slice(offset, offset + 40).map(({ block, position }) => <div key={block.attrs.id}>
        <span className={styles.muted}>原稿第 {position} 段</span><p>{blockText(block)}</p>
      </div>)}{!preview.blocks.length && <p className={styles.muted}>此固定版本没有正文段落。</p>}</div>
      {preview.blocks.length > 40 && <div className={styles.actions}>
        <button type="button" className={styles.button} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 40))}>上一页原文</button>
        <span className={styles.muted}>{offset + 1}–{Math.min(offset + 40, preview.blocks.length)} / {preview.blocks.length} 段</span>
        <button type="button" className={styles.button} disabled={offset + 40 >= preview.blocks.length} onClick={() => setOffset(offset + 40)}>下一页原文</button>
      </div>}
    </>}
  </section>
}

function IssueEditor({ book, chapter, fields, onChange }: { book: BookSnapshot; chapter: ChapterSnapshot | null; fields: ReviewIssueFields; onChange: (value: ReviewIssueFields) => void }) {
  const stale = book.chapters.find((item) => item.id === fields.anchor.chapterId)?.revisionId !== fields.anchor.revisionId
  return <div className={styles.fields}><div className={styles.fieldGrid}><label>问题标题<input required maxLength={160} value={fields.title} onChange={(event) => onChange({ ...fields, title: event.target.value })} /></label><label>问题类型<select value={fields.kind} onChange={(event) => onChange({ ...fields, kind: event.target.value as ReviewIssueFields['kind'] })}>{REVIEW_KINDS.map((kind) => <option key={kind} value={kind}>{issueKinds[kind]}</option>)}</select></label><label>处理状态<select value={fields.status} onChange={(event) => onChange({ ...fields, status: event.target.value as ReviewIssueFields['status'] })}>{REVIEW_STATES.map((state) => <option key={state} value={state}>{issueStates[state]}</option>)}</select></label><label>所在章节<select value={fields.anchor.chapterId} onChange={(event) => { const target = book.chapters.find((item) => item.id === event.target.value); if (target) onChange({ ...fields, anchor: { chapterId: target.id, revisionId: target.revisionId, blockIds: [] }, status: 'recheck' }) }}>{book.chapters.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
    {([['reason', '当前问题理由', 10000], ['evidence', '当前证据与引用', 10000], ['suggestion', '修改建议', 20000], ['resolution', '处理说明', 10000]] as const).map(([key, label, max]) => <label key={key}>{label}<textarea rows={key === 'suggestion' ? 5 : 3} maxLength={max} value={fields[key]} onChange={(event) => onChange({ ...fields, [key]: event.target.value })} /></label>)}
    {fields.replacement !== undefined && <label>可直接写入的替换正文<textarea rows={6} maxLength={20000} disabled={Boolean(fields.candidateSource?.item.requirement)} value={fields.replacement} onChange={(event) => onChange({ ...fields, replacement: event.target.value })} /><small className={styles.muted}>分析保留在修改建议中。缺失事项需要补写或调整计划，不替换已有段落。</small></label>}
    <p className={styles.muted}>下方定位用于本次复核；重新定位和编辑理由、证据不会覆盖首次记录的原始依据。完成改稿后可先标为“待复核”，重新检查正文再决定是否已解决。</p>
    {stale && fields.status === 'resolved' && <p className={styles.warning}>证据仍指向旧正文，暂不能保存为“已解决”。请在下方更新来源，核对段落后再确认结论。</p>}
    {fields.aiRunId && <p className={styles.identity}>AI 历史来源：{fields.aiRunId}。此关联保留来源，不代表建议已被采用。</p>}
    <AnchorEditor title="当前复核定位" value={fields.anchor} chapter={chapter} target={book.chapters.find((item) => item.id === fields.anchor.chapterId) ?? null} onChange={(anchor) => { if (anchor) onChange({ ...fields, anchor, status: 'recheck' }) }} />
  </div>
}

function AiSuggestionPicker({ api, bookId, disabled, planOnly = false, onSelect }: { api: StudioApi; bookId: string; disabled: boolean; planOnly?: boolean; onSelect: (run: AiRun, text: string) => void }) {
  const [page, setPage] = useState<AiRunPage | null>(null)
  const [run, setRun] = useState<AiRun | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const ticket = useRef(0)
  const maximum = planOnly ? 10000 : 20000
  const candidates = (page?.runs ?? []).filter((item) => (!planOnly || (item.kind === 'plan' && item.purpose !== 'review'))
    && item.outputCharacters > 0 && ['succeeded', 'adopted'].includes(item.state))
    .sort((left, right) => Number(right.purpose === 'review') - Number(left.purpose === 'review'))
  useEffect(() => { active.current = true; return () => { active.current = false; ticket.current += 1 } }, [])
  async function load(before?: string) {
    if (disabled || busy) return
    const expected = ++ticket.current
    setBusy(true); setError(null)
    const result = await request(() => api.listAiRuns({ bookId, ...(before ? { before } : {}) }))
    if (!active.current || ticket.current !== expected) return
    setBusy(false)
    if (!result.ok) { setError(result.error.message); return }
    if (result.data.bookId !== bookId) { setError('AI 历史回执不匹配。'); return }
    setPage(result.data); setRun(null); setText('')
  }
  async function select(runId: string) {
    if (disabled || busy) return
    const expected = ++ticket.current
    setBusy(true); setError(null)
    const result = await request(() => api.getAiRun({ bookId, runId }))
    if (!active.current || ticket.current !== expected) return
    setBusy(false)
    if (!result.ok) { setError(result.error.message); return }
    if (result.data.bookId !== bookId || result.data.id !== runId || result.data.context.bookId !== bookId || result.data.context.chapterId !== result.data.chapterId
      || (planOnly && (result.data.kind !== 'plan' || result.data.purpose === 'review' || result.data.context.purpose === 'review'))
      || !['succeeded', 'adopted'].includes(result.data.state)) { setError('AI 建议来源、用途或状态不匹配。'); return }
    setRun(result.data)
    // 保留完整来源；超长输出由作者主动选段，不能静默截断成不完整的建议。
    setText(result.data.outputText.length <= maximum ? result.data.outputText : '')
  }
  return <section className={styles.editor} aria-label={planOnly ? '选择已有 AI 规划' : '选择已有 AI 建议'}><div className={styles.heading}><h4>{planOnly ? '选取章节规划提议' : '选取已有 AI 输出'}</h4><button className={styles.button} type="button" disabled={disabled || busy} onClick={() => void load()}>读取最近历史</button></div><p className={styles.muted}>{planOnly ? '把规划提议带入新场景的目标，编辑后明确保存。这里只创建计划，不改写正文。' : '本页优先显示审稿候选，也可从其他已保存输出中挑选线索，再补充自己的理由和证据。'}</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {page && <><ul className={styles.selection}>{candidates.map((item) => <li key={item.id}><span>{item.chapterTitle}<small>{item.purpose === 'review' ? '审稿候选' : item.kind === 'plan' ? '规划提议' : '其他输出'} · {displayTime(item.createdAt)} · {item.outputCharacters.toLocaleString()} 字符</small></span><button className={styles.button} type="button" disabled={disabled || busy} onClick={() => void select(item.id)}>查看输出</button></li>)}</ul>{!candidates.length && <p className={styles.muted}>{planOnly ? '这页没有可引用的已完成规划。' : '这页没有可引用的已完成输出。'}</p>}<button className={styles.button} type="button" disabled={disabled || busy || page.nextBefore === null} onClick={() => { if (page.nextBefore) void load(page.nextBefore) }}>查看更早历史</button></>}
    {run && <div className={styles.fields}><label>AI 原始输出（可选中需要的部分）<textarea rows={8} readOnly value={run.outputText} onSelect={(event) => {
      const { selectionStart, selectionEnd } = event.currentTarget
      const selected = run.outputText.slice(selectionStart, selectionEnd)
      if (selected.length > maximum) { setText(''); setError(`所选内容超过 ${maximum.toLocaleString()} 字符，请缩小范围。`) }
      else if (selected.trim()) { setText(selected); setError(null) }
    }} /></label>{run.outputText.length > maximum && <p className={styles.warning} role="status">原始输出共 {run.outputText.length.toLocaleString()} 字符，超过目标字段的 {maximum.toLocaleString()} 字符限制。请在上方手动选取需要的部分，核对下方预览后再带入；系统不会自动截断。</p>}
      <label>{planOnly ? '将带入场景目标的规划' : '将带入的建议'}<textarea rows={5} readOnly value={text} /></label>
      {text && text !== run.outputText && <p className={styles.notice} role="status">本次仅带入选中的 {text.length.toLocaleString()} / {run.outputText.length.toLocaleString()} 字符，其余内容保留在 AI 历史中。</p>}
      <button className={styles.button} type="button" disabled={disabled || busy || !text.trim()} onClick={() => onSelect(run, text)}>{planOnly ? '带入场景目标并编辑' : '带入审稿表单并补充判断'}</button></div>}
  </section>
}

function ActivitySummary({ snapshot, date, period, disabled, onEditGoal }: { snapshot: WorkbenchSnapshot; date: string; period: 'day' | 'week'; disabled: boolean; onEditGoal: (item: WritingGoal) => void }) {
  const day = new Date(`${date}T12:00:00`)
  const weekStart = new Date(day)
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)
  const start = period === 'day' ? date : localDate(weekStart)
  const end = period === 'day' ? date : localDate(weekEnd)
  const activity = snapshot.activity.filter((item) => item.date >= start && item.date <= end)
    .sort((left, right) => right.date.localeCompare(left.date) || left.source.localeCompare(right.source))
  const goals = snapshot.goals
  function progress(goal: WritingGoal) {
    const first = goal.period === 'day' ? date : localDate(weekStart)
    const last = goal.period === 'day' ? date : localDate(weekEnd)
    return snapshot.activity.filter((item) => item.source === 'manual' && item.date >= first && item.date <= last)
      .reduce((sum, item) => sum + item[goal.metric], 0)
  }
  return <><p className={styles.muted}>{start}{start !== end ? ` 至 ${end}` : ''} · 仅展示最近一年有记录的活动，升级前的历史不回填。</p>
    <p className={styles.muted}>新增、删除字数按每个稳定段落的保存前后文本估算：去除共同的开头与结尾，再统计中间部分。同一段落内多处编辑时，中间未变的文字也会计入新增和删除，因此不代表精确敲键次数。净增是准确的保存字数差；字数按 Unicode 字符计数，含标点、不含空白。</p>
    {start < activityStartDate() && <p className={styles.warning}>这一周的起始日期早于统计范围，周目标仅显示范围内的进度。</p>}
    {goals.length ? <ul className={styles.goals}>{goals.map((goal) => { const actual = progress(goal); return <li key={goal.id}><div><strong>{goal.period === 'day' ? '每天' : '每周'} · {metricLabels[goal.metric]}</strong><span className={styles.muted}>{goal.active ? `${actual.toLocaleString()} / ${goal.target.toLocaleString()}` : '已暂停'}</span>{goal.active && <progress max={goal.target} value={Math.max(0, actual)} aria-label={`${metricLabels[goal.metric]}：${actual} / ${goal.target}`} />}</div><button className={styles.button} type="button" disabled={disabled} onClick={() => onEditGoal(goal)}>编辑目标</button></li> })}</ul> : <p className={styles.empty}>还没有写作目标。可设置每日字数、每周手工记录时长或改稿章次。</p>}
    {activity.length ? <div className={styles.tableScroll} tabIndex={0} aria-label="写作活动表，可横向滚动"><table className={styles.table}><thead><tr><th scope="col">日期 / 来源</th><th scope="col">新增（估算）</th><th scope="col">删除（估算）</th><th scope="col">净增</th><th scope="col">手工分钟</th><th scope="col">改稿章次</th></tr></thead><tbody>{activity.map((item) => <tr key={`${item.date}-${item.source}`}><th scope="row">{item.date}<small>{sourceLabels[item.source]}</small></th><td>{item.added.toLocaleString()}</td><td>{item.removed.toLocaleString()}</td><td>{item.net.toLocaleString()}</td><td>{item.minutes.toLocaleString()}</td><td>{item.revisedChapters.toLocaleString()}</td></tr>)}</tbody></table></div> : <p className={styles.empty}>这个时段没有写作活动。可以手工补记写作时长和完成改稿的章节。</p>}
    <p className={styles.muted}>目标进度只计入常规编辑和手工记录，AI 采用、导入与恢复另列。分钟数来自手工填写，当前没有自动计时。改稿按每天完成的章次累计；同一章跨天改稿会分别计数。</p>
  </>
}

// ============================================================
// StarWriter V2.4.8 同款扩展组件：故事建筑师 / 朱雀 AI 检测 / 多维读者模拟
// ============================================================

const DEFAULT_IDEAS = [
  { id: '1', title: '末日重生反套路', tag: '开篇脑洞', content: '开篇第1分钟主角发现自己虽然重生，但这次变异力量提早了3天降临，所有前世记忆全部产生偏差。' },
  { id: '2', title: '金手指代价限制', tag: '系统设定', content: '系统每次提供神级功法或技能，必须献祭一件与自身强烈情感羁绊的旧物，防止力量过分膨胀。' },
  { id: '3', title: '双面身份博弈', tag: '人物张力', content: '主角白天是官方镇魔司里唯唯诺诺的档案录入员，夜晚是黑市深渊里令各方枭雄闻风丧胆的暗行者。' },
  { id: '4', title: '第三卷核心反转', tag: '主线伏笔', content: '一直引导主角探索深渊裂隙的神秘信使，其实是十年后战死在绝巅之上的主角自己残留的执念投影。' },
]

function StoryArchitectView({ book, snapshot, disabled, onApplyBrief, onCreateScene }: {
  book: BookSnapshot
  snapshot: WorkbenchSnapshot
  disabled: boolean
  onApplyBrief: (brief: WorkbenchSnapshot['brief']) => void
  onCreateScene: (sceneGoal: string) => void
}) {
  const [selectedIdeas, setSelectedIdeas] = useState<string[]>(['1', '2'])
  const [ideas, setIdeas] = useState(DEFAULT_IDEAS)
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [generatedBrief, setGeneratedBrief] = useState<WorkbenchSnapshot['brief'] | null>(null)

  function toggleIdea(id: string) {
    setSelectedIdeas((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
  }

  function addCustomIdea(e: FormEvent) {
    e.preventDefault()
    if (!newTitle.trim()) return
    const item = { id: crypto.randomUUID(), title: newTitle.trim(), tag: '自定想法', content: newContent.trim() || newTitle.trim() }
    setIdeas((cur) => [...cur, item])
    setSelectedIdeas((cur) => [...cur, item.id])
    setNewTitle('')
    setNewContent('')
  }

  const selectedTexts = ideas.filter((i) => selectedIdeas.includes(i.id)).map((i) => `【${i.tag} · ${i.title}】\n${i.content}`).join('\n\n')

  const promptPackage = `【故事建筑师指令包 · 专用于给大模型生成长篇骨架】
《${book.book.title}》创作空间想法箱勾选内容：

${selectedTexts || '（尚未选择想法箱条目）'}

当前创作约定参考：
- 叙述人称：${snapshot.brief.narrator || '第三人称'}
- 预设文风：${snapshot.brief.style || '极简动词白描，紧凑悬念，有烟火气'}
- 核心规则禁忌：${snapshot.brief.rules || '不可违背世界观力量代价；角色只能使用已知信息。'}

请根据以上构思，为我构建：
1. 一句话故事核心前提与两卷主线冲突
2. 主角核心动机、执念与致命弱点
3. 第一卷前五章连贯大纲与开篇第1章黄金场景节拍`

  function buildBrief() {
    const brief: WorkbenchSnapshot['brief'] = {
      premise: ideas.filter((i) => selectedIdeas.includes(i.id)).map((i) => i.content).join('；') || snapshot.brief.premise,
      style: '去AI味极简动词白描，拒绝空洞浮夸修辞，保持市井生活细节与真实物理反馈',
      narrator: '第三人称限知视角',
      tense: '现在时',
      rules: '超能或金手指必有消耗代价；各方博弈只能使用已知信息，禁止未卜先知。',
    }
    setGeneratedBrief(brief)
  }

  return <section className={styles.architectSection} aria-label="故事建筑师">
    <div className={styles.architectHero}>
      <div>
        <h4>故事建筑师 · 从想法箱到骨架流水线</h4>
        <p>勾选想法箱若干条，一键打包成高阶提示词喂给大模型；或直接将生成的故事前提、人设与首章节拍回填入库。</p>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.primaryButton} disabled={disabled || !selectedIdeas.length} onClick={buildBrief}>
          + 智能生成故事前提与约定
        </button>
      </div>
    </div>

    <div className={styles.fieldGrid}>
      <div>
        <h5 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 650 }}>想法箱（勾选用于打包）</h5>
        <div className={styles.ideaCardsGrid}>
          {ideas.map((item) => {
            const active = selectedIdeas.includes(item.id)
            return <div key={item.id} className={styles.ideaBoxItem} style={{ borderColor: active ? 'var(--color-accent)' : undefined, background: active ? 'var(--color-accent-soft)' : undefined }} onClick={() => toggleIdea(item.id)}>
              <div className={styles.ideaItemHeader}>
                <span className={styles.ideaTag}>{item.tag}</span>
                <span style={{ fontSize: 12, color: active ? 'var(--color-accent)' : 'var(--color-muted)' }}>{active ? '✓ 已选入' : '点击勾选'}</span>
              </div>
              <strong>{item.title}</strong>
              <p>{item.content}</p>
            </div>
          })}
        </div>

        <form onSubmit={addCustomIdea} style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-ink)' }}>+ 添加新念头到想法箱</span>
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="脑洞或悬念标题…" maxLength={100} style={{ padding: '6px 10px' }} />
          <textarea value={newContent} onChange={(e) => setNewContent(e.target.value)} placeholder="具体构思内容，如主角获得的奇怪信物…" rows={2} style={{ padding: '6px 10px' }} />
          <button type="submit" className={styles.button} disabled={!newTitle.trim()}>添加念头</button>
        </form>
      </div>

      <div className={styles.architectConsole}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 13.5 }}>故事建筑师 · 指令打包区</strong>
          <button type="button" className={styles.button} onClick={() => navigator.clipboard.writeText(promptPackage)}>复制完整指令</button>
        </div>
        <textarea className={styles.promptPackageBox} readOnly rows={12} value={promptPackage} />

        {generatedBrief && <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--color-accent)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-accent)' }}>已提炼出故事约定草案：</span>
          <p style={{ fontSize: 12.5, margin: 0 }}><strong>故事前提：</strong>{generatedBrief.premise}</p>
          <p style={{ fontSize: 12, margin: 0, color: 'var(--color-muted)' }}><strong>文风：</strong>{generatedBrief.style} | <strong>视角：</strong>{generatedBrief.narrator}</p>
          <div className={styles.actions} style={{ marginTop: 6 }}>
            <button type="button" className={styles.primaryButton} onClick={() => onApplyBrief(generatedBrief)}>应用为此书正式创作约定</button>
            <button type="button" className={styles.button} onClick={() => onCreateScene(generatedBrief.premise)}>一键生成黄金第1场景</button>
          </div>
        </div>}
      </div>
    </div>
  </section>
}
