import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { DomainError, requiredId, requiredText, type BookSnapshot, type ChapterSnapshot, type CompletedRequest, type Result, type StudioApi } from '../../contracts/api'
import { AI_OUTPUT_LIMIT, isAiAdoptReceiptFor, isAiMemoryAdoptReceiptFor, isAiMemoryTask, parseAiConnectionConfig, parseAiMemoryAdoptInput, parseAiPrepareInput, type AiAdoptInput, type AiAdoptReceipt, type AiConnection, type AiConnectionConfig, type AiConnectionPage, type AiContextPacket, type AiContextPerspective, type AiMemoryAdoptInput, type AiMemoryAdoptReceipt, type AiPrepareInput, type AiRun, type AiRunPage, type AiRunState, type AiRunSummary, type AiTaskKind } from '../../contracts/ai'
import { AI_CONTEXT_SUMMARY_LIMIT, AI_CONTEXT_SUMMARY_PAGE, contextSummaryRef, parseAiContextSummaryInput, parseAiContextSummarySnapshots, type AiContextSummaryCursor, type AiContextSummaryPage, type AiContextSummarySnapshot } from '../../contracts/ai-context-summary'
import { characterScopeOf, isAiCharacterContextPromptVersion, parseAiCharacterContext, parseAiCharacterScope, type AiCharacterContext, type AiCharacterScope } from '../../contracts/ai-character-context'
import { AI_RECOMMENDATION_CANDIDATE_LIMIT, AI_RECOMMENDATION_QUERY_LIMIT, AI_RECOMMENDATION_RESULT_LIMIT, parseAiContextRecommendationInput, type AiContextRecommendationInput, type AiContextRecommendationPage, type AiContextRecommendationQuery } from '../../contracts/ai-context-recommendation'
import type { KnowledgeNature, KnowledgeStatus } from '../../contracts/knowledge'
import type { CognitionAttitude } from '../../contracts/story'
import type { ManuscriptBlock } from '../../contracts/manuscript'
import type { MemorySearchHit, MemorySearchPage } from '../../contracts/memory'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import { AiMemoryReview, aiMemoryReviewEntries, createAiMemoryDrafts, type AiMemoryDraft } from './AiMemoryReview'
import { AiTextDiff } from './AiTextDiff'
import shared from '../App.module.css'
import layout from './KnowledgePanel.module.css'
import styles from './AiPanel.module.css'

interface Props {
  api: StudioApi
  book: BookSnapshot
  chapter: ChapterSnapshot
  busy: boolean
  error?: string | null
  pendingMessage?: string | null
  checkingReceipt: boolean
  onCheckReceipt: () => void
  onRecover: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  onUpgrade: (accept: (status: KnowledgeStatus) => void) => Promise<void>
  onAdopt: (input: AiAdoptInput, source: AiRun, accept: (receipt: AiAdoptReceipt) => boolean) => Promise<void>
  onAdoptMemory: (input: AiMemoryAdoptInput, source: AiRun, accept: (receipt: AiMemoryAdoptReceipt) => boolean) => Promise<void>
  onRegisterReview?: (run: AiRun) => void
}

interface PendingWrite {
  requestId?: string
  label: string
  receive: (response: CompletedRequest) => boolean
}
interface DiscardAction { label: string; proceed: () => void }
interface CharacterPerson { id: string; name: string }
interface CharacterPersonPage { items: CharacterPerson[]; offset: number; total: number; nextOffset: number | null }
interface CharacterDraft { person: CharacterPerson | null; storyOrder: string; readerLimited: boolean }
interface RecommendationResult {
  page: AiContextRecommendationPage
  input: AiContextRecommendationInput | null
  bookRevision: number
  chapterBookRevision: number
}
type SelectedMemoryHit = MemorySearchHit & { characterScope?: AiCharacterScope }
const PERSON_PAGE_SIZE = 20
const taskLabels: Record<AiTaskKind, string> = { plan: '章节规划', continue: '接着写', rewrite: '改写段落', summarize: '章节摘要', extract: '提取知识建议' }
const stateLabels: Record<AiRunState, string> = { prepared: '等待发送', running: '生成中', succeeded: '待作者审阅', failed: '生成失败', cancelled: '已取消', interrupted: '已中断', rejected: '作者已拒绝', adopted: '作者已采用' }
const natureLabels: Record<KnowledgeNature, string> = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '人物认知', ai_derived: 'AI 整理', ai_inference: 'AI 推断', external_reference: '外部参考' }
const sourceLabels = { chapter: '正文', knowledge: '知识条目', story: '故事记录' }
const attitudeLabels: Record<CognitionAttitude, string> = { knows: '知道', believes: '相信', misunderstands: '误解', suspects: '怀疑' }
const recommendationQueryLabels: Record<AiContextRecommendationQuery['source'], string> = { instruction: '本次要求', chapter: '固定正文', character: '人物关联认知' }
const memoryReasonLabels: Record<MemorySearchHit['reasons'][number], string> = { keyword: '正文词语', title: '标题', entity: '关联实体', semantic: '历史向量相似候选' }
function sameCharacterScope(left: AiCharacterScope | undefined, right: AiCharacterScope | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.personId === right.personId && left.storyOrder === right.storyOrder && left.readerLimited === right.readerLimited
}
function emptyCharacterDraft(): CharacterDraft { return { person: null, storyOrder: '', readerLimited: false } }
function perspectiveKey(perspective: AiContextPerspective, draft: CharacterDraft): string {
  return JSON.stringify([perspective, ...(perspective === 'character' ? [draft.person?.id ?? '', draft.storyOrder, draft.readerLimited] : [])])
}
function scopeFromContext(context: AiContextPacket): AiCharacterScope | undefined {
  if (context.perspective !== 'character') {
    if (context.characterContext !== undefined) throw new Error('Unexpected character context')
    return undefined
  }
  if (!isAiCharacterContextPromptVersion(context.promptVersion) || isAiMemoryTask(context.kind) || context.summary !== undefined || context.contextSummaries?.length) throw new Error('Invalid character context')
  const fixed = parseAiCharacterContext(context.characterContext)
  const scope = characterScopeOf(fixed)
  if (fixed.cognitions.length !== context.evidence.length || new Set(context.evidence.map((item) => item.chunkId)).size !== context.evidence.length) throw new Error('Invalid cognition identities')
  for (const item of fixed.cognitions) {
    const evidence = context.evidence.find((entry) => entry.chunkId === item.chunkId)
    if (!evidence || evidence.bookId !== context.bookId || evidence.sourceKind !== 'story' ||
      evidence.nature !== 'character_belief' || evidence.sourceId !== item.recordId || evidence.revisionId !== item.revisionId ||
      evidence.authorDecision !== 'adopted' || evidence.freshness !== 'current' || evidence.dependencyState !== 'current' ||
      (scope.readerLimited && evidence.readerDisclosure?.state !== 'located') ||
      (evidence.conflictState !== 'clear' && evidence.conflictState !== 'explained')) throw new Error('Invalid cognition snapshot')
  }
  return scope
}
function matchesPerspective(context: AiContextPacket, perspective: AiContextPerspective, scope?: AiCharacterScope): boolean {
  try { return (context.perspective ?? 'author') === perspective && sameCharacterScope(scopeFromContext(context), scope) }
  catch { return false }
}
function freshConnection(): AiConnectionConfig { return { id: crypto.randomUUID(), name: '', baseUrl: '', model: '', contextWindow: 32_000, maxOutputTokens: 2048 } }
function connectionConfig(value: AiConnection): AiConnectionConfig {
  const { id, name, baseUrl, model, contextWindow, maxOutputTokens } = value
  return { id, name, baseUrl, model, contextWindow, maxOutputTokens }
}
function runSummary(value: AiRun): AiRunSummary {
  const { id, bookId, chapterId, chapterTitle, kind, purpose, state, version, connectionName, model, outputCharacters, error, createdAt, updatedAt } = value
  return { id, bookId, chapterId, chapterTitle, kind, purpose, state, version, connectionName, model, outputCharacters, error, createdAt, updatedAt }
}
function blockText(block: ManuscriptBlock): string { return block.type === 'horizontalRule' ? '' : (block.content ?? []).map((node) => node.type === 'hardBreak' ? '\n' : node.text).join('') }
function unusableMemory(hit: MemorySearchHit, perspective: AiContextPerspective = 'author'): string | null {
  if (perspective === 'reader' && hit.sourceKind !== 'story') return '读者已披露资料范围只允许符合披露条件的故事资料'
  if (perspective === 'character' && (hit.sourceKind !== 'story' || hit.nature !== 'character_belief')) return '人物模式只允许所选人物的认知故事片段，请移除其他资料'
  if (hit.freshness !== 'current' || hit.dependencyState !== 'current') return '资料或引用原稿受影响，需要先复核'
  // 正文原稿作为叙述证据发送，未判断冲突的状态不能被误写成作者已证实。
  if (hit.sourceKind === 'chapter') return hit.nature === 'narrative_claim' && hit.conflictState === 'unchecked' ? null : '正文片段状态不符，请重新整理后核对'
  if (hit.authorDecision !== 'adopted') return '尚未由作者采纳'
  if (hit.conflictState === 'candidate') return '存在冲突候选，需要先处理'
  if (hit.conflictState === 'unchecked') return '尚未判断冲突，暂不能加入'
  if (perspective === 'character' && hit.conflictState !== 'clear' && hit.conflictState !== 'explained') return '认知冲突须已明确或已解释'
  return null
}
function overlappingSummary(item: AiContextSummarySnapshot, selected: AiContextSummarySnapshot[]): boolean {
  return selected.some((other) => other.nodeId !== item.nodeId && item.firstChapter.position <= other.lastChapter.position && other.firstChapter.position <= item.lastChapter.position)
}
function SummarySources({ items }: { items: AiContextSummarySnapshot[] }) {
  return <ul className={layout.sources}>{items.map((item) => <li key={item.nodeId}>
    <div><strong>{item.scopeTitle} · {item.title}</strong><span>作者已采用 · {item.coveredChapters} 章 · {item.text.length.toLocaleString()} 字符</span></div>
    <p className={styles.note}>{item.firstChapter.title} → {item.lastChapter.title}</p>
    <blockquote>{item.text}</blockquote>
    <p className={layout.sourceIds}>任务 {item.taskId} · 节点 {item.nodeId} · 采用记录 {item.runId}<br />来源清单 {item.manifestHash} · 覆盖指纹 {item.coverageHash}</p>
  </li>)}</ul>
}

function ContextPreview({ context }: { context: AiContextPacket }) {
  const character: AiCharacterContext | undefined = context.perspective === 'character' ? context.characterContext : undefined
  return <section className={styles.preview} aria-label="实际发送预览">
    <div className={styles.heading}><h3>实际发送内容</h3><span>固定预览 · 提示版本 {context.promptVersion}</span></div>
    {context.purpose === 'review' && <p className={styles.note}><strong>用途：审稿。</strong>输出为待核对的问题建议，作者逐项确认后登记为持久审稿问题。</p>}
    <dl className={styles.facts}><div><dt>接口</dt><dd>{context.connection.baseUrl}/chat/completions</dd></div><div><dt>模型</dt><dd>{context.connection.model}</dd></div><div><dt>输入估算</dt><dd>{context.estimatedInputTokens.toLocaleString()} tokens</dd></div><div><dt>输出预算</dt><dd>{context.reservedOutputTokens.toLocaleString()} / 窗口 {context.connection.contextWindow.toLocaleString()}</dd></div></dl>
    <p className={styles.note}><strong>附加资料范围：{context.perspective === 'character' ? '人物视角资料' : context.perspective === 'reader' ? '读者已披露资料' : '作者资料'}</strong>{context.perspective === 'reader' && '。仅限制附加资料；当前章、要求、章节目标和备注仍为作者输入，整次发送不保证防剧透，人物知情未知。'}</p>
    {context.writingContext ? <details className={styles.sources} open><summary>本次作品创作约定 · {context.writingContext.settingsRevision === null ? '作品资料' : `约定版本 ${context.writingContext.settingsRevision}`}</summary>
      <dl>{([['genre', '类型'], ['synopsis', '简介'], ['premise', '故事前提'], ['style', '文风'], ['narrator', '叙述方式'], ['tense', '时态'], ['rules', '创作规则']] as const).map(([key, label]) =>
        <div key={key}><dt>{label}</dt><dd className={layout.body}>{context.writingContext![key] || '未填写'}</dd></div>)}</dl>
    </details> : (context.perspective === 'character' || context.perspective === 'reader') && <p className={styles.note}>受限视角不附加作品简介与自由文本创作约定，避免引入未披露的结局或人物未知信息。</p>}
    {character && <>
      <dl className={styles.facts}><div><dt>固定人物</dt><dd>{character.personName}<br />人物 {character.personId}<br />人物修订 {character.personRevisionId}</dd></div><div><dt>故事时点</dt><dd>作者排序值 {character.storyOrder}<br />{character.readerLimited ? '同时限制为读者已披露资料' : '按人物认知范围选择资料'}</dd></div></dl>
      <p className={styles.note}>人物身份仅使用固定名称、标识和修订。创作输入使用原文与本次要求，不附带章节目标、视角备注或章节备注，也不附带完整前文摘要。认知态度与隐瞒标记独立保留；原文、要求和认知描述仍可能包含越界信息，不保证逐句防剧透。</p>
      <ul className={layout.sources}>{character.cognitions.map((item) => <li key={item.chunkId}>
        <div><strong>{context.evidence.find((entry) => entry.chunkId === item.chunkId)?.title ?? `认知片段 ${item.chunkId}`}</strong><span>人物认知 · {attitudeLabels[item.attitude]} · {item.concealed ? '人物隐瞒' : '未标记隐瞒'}</span></div>
        <p className={styles.note}>形成于 {item.formedAt.label} · 作者排序值 {item.formedAt.order}。{item.attitude === 'knows' ? '保留记录中的“知道”态度，不据此证明客观事实。' : '保留主观认知，不改写为确定事实。'}</p>
        <p className={layout.sourceIds}>片段 {item.chunkId} · 记录 {item.recordId} · 修订 {item.revisionId}</p>
      </li>)}</ul>
    </>}
    <p className={styles.note}>输入量为估算，计费以接口返回的用量为准。发送后，以下正文、要求和所选资料将交给这个接口。</p>
    {context.warnings.length > 0 && <ul className={shared.warningList}>{context.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    <details className={styles.messages}><summary>逐条查看实际 messages（{context.messages.length} 条）</summary>{context.messages.map((message, index) => <div key={index}><h4>{message.role === 'system' ? '系统要求' : '创作输入'}</h4><pre>{message.content}</pre></div>)}</details>
    <details className={styles.sources}><summary>本次引用的资料（{context.evidence.length} 个片段）</summary>{context.evidence.length ? <ul className={layout.sources}>{context.evidence.map((item) => <li key={item.chunkId}><div><strong>{item.title}</strong><span>{natureLabels[item.nature]} · {sourceLabels[item.sourceKind]}</span></div><p className={layout.sourceIds}>对象 {item.sourceId} · 修订 {item.revisionId}{item.blockId ? ` · 段落 ${item.blockId}` : ''}</p><blockquote>{item.text}</blockquote></li>)}</ul> : <p className={styles.note}>本次没有额外资料片段。章节上下文仍按预览中的 messages 发送。</p>}</details>
    {context.contextSummaries?.length ? <details className={styles.sources}><summary>本次完整前文摘要（{context.contextSummaries.length} 份）</summary><SummarySources items={context.contextSummaries} /></details> : null}
    <p className={styles.identity}>作品版本 {context.bookRevision} · 知识版本 {context.knowledgeRevision} · 章节修订 {context.chapterRevisionId}<br />输入指纹 {context.contextHash}</p>
  </section>
}

function OutputReview({ run, text, disabled, onChange }: { run: AiRun; text: string; disabled: boolean; onChange: (text: string) => void }) {
  const editable = run.state === 'succeeded' && run.context.purpose !== 'review'
  return <section className={styles.output} aria-label="提议与改稿">
    <div className={styles.heading}><h3>{run.context.purpose === 'review' ? '审稿问题建议' : run.kind === 'plan' ? '规划提议' : '正文提议'}</h3><span>{text.length.toLocaleString()} 字符</span></div>
    {editable && (run.kind === 'rewrite' || run.kind === 'continue') && <>
      <AiTextDiff key={run.id} originalText={run.kind === 'rewrite' ? run.context.originalText : ''}
        suggestedText={run.outputText} disabled={disabled} onAcceptText={onChange} />
      <p className={styles.note}>采用所选差异会替换下方审阅稿；核对后再点击本页最终采用按钮写入章节。</p>
    </>}
    <div className={run.kind === 'rewrite' ? styles.comparison : undefined}>
      {run.kind === 'rewrite' && <div><h4>原文 · 固定版本</h4><pre className={styles.original}>{run.context.originalText}</pre></div>}
      <div>{run.kind === 'rewrite' && <h4>新稿 · 作者可编辑</h4>}{editable ? <textarea className={styles.acceptedText} value={text} maxLength={AI_OUTPUT_LIMIT} rows={14} disabled={disabled} aria-label="作者审阅后的采用内容" onChange={(event) => onChange(event.target.value)} /> : <pre className={styles.original}>{(run.acceptedText ?? run.outputText) || '尚无输出。'}</pre>}</div>
    </div>
    {run.state === 'running' && <p className={styles.note} role="status">输出随检查点更新。取消会保留已经保存的部分内容。</p>}
    {['failed', 'cancelled', 'interrupted'].includes(run.state) && <p className={styles.note}>已保留部分输出与本次输入。只有成功结束的提议可直接采用；重新生成需要新建预览并再次确认发送。</p>}
    {run.usage && <p className={styles.note}>接口返回用量：输入 {run.usage.inputTokens ?? '未知'} · 输出 {run.usage.outputTokens ?? '未知'} · 总计 {run.usage.totalTokens ?? '未知'} tokens{run.finishReason ? ` · 结束原因 ${run.finishReason}` : ''}</p>}
  </section>
}

export function AiPanel(props: Props) {
  return <AiPanelSession key={`${props.book.book.id}:${props.chapter.id}`} {...props} />
}

function AiPanelSession({ api, book, chapter, busy, error, pendingMessage, checkingReceipt, onCheckReceipt, onRecover, onClose, onDirtyChange, onUpgrade, onAdopt, onAdoptMemory, onRegisterReview }: Props) {
  const [connections, setConnections] = useState<AiConnectionPage | null>(null)
  const [knowledge, setKnowledge] = useState<KnowledgeStatus | null>(null)
  const [history, setHistory] = useState<AiRunPage | null>(null)
  const [before, setBefore] = useState<string | undefined>()
  const [run, setRun] = useState<AiRun | null>(null)
  const [config, setConfig] = useState<AiConnectionConfig>(freshConnection)
  const [configDirty, setConfigDirty] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [kind, setKind] = useState<AiTaskKind>('continue')
  const [purpose, setPurpose] = useState<'review' | undefined>()
  const [instruction, setInstruction] = useState('')
  const [contextScope, setContextScope] = useState<'chapter' | 'nearby'>('chapter')
  const [perspective, setPerspective] = useState<AiContextPerspective>('author')
  const [character, setCharacter] = useState<CharacterDraft>(emptyCharacterDraft)
  const [personQuery, setPersonQuery] = useState('')
  const [personPage, setPersonPage] = useState<CharacterPersonPage | null>(null)
  const perspectiveHintId = useId()
  const [firstBlock, setFirstBlock] = useState('')
  const [lastBlock, setLastBlock] = useState('')
  const [composeDirty, setComposeDirty] = useState(false)
  const [memoryQuery, setMemoryQuery] = useState('')
  const [memoryPage, setMemoryPage] = useState<MemorySearchPage | null>(null)
  const [memoryPageScope, setMemoryPageScope] = useState<string | null>(null)
  const [recommendation, setRecommendation] = useState<RecommendationResult | null>(null)
  const [recommendationVectorRunId, setRecommendationVectorRunId] = useState('')
  const [recommending, setRecommending] = useState(false)
  const [selectedMemory, setSelectedMemory] = useState<SelectedMemoryHit[]>([])
  const [summaryPage, setSummaryPage] = useState<AiContextSummaryPage | null>(null)
  const [selectedSummaries, setSelectedSummaries] = useState<AiContextSummarySnapshot[]>([])
  const [acceptedText, setAcceptedText] = useState('')
  const [memoryDrafts, setMemoryDrafts] = useState<AiMemoryDraft[]>([])
  const [outputDirty, setOutputDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingWrite | null>(null)
  const [checkingLocal, setCheckingLocal] = useState(false)
  const [refreshRequested, setRefreshRequested] = useState(true)
  const [requestedRunId, setRequestedRunId] = useState<string | null>(null)
  const [pollStopped, setPollStopped] = useState(false)
  const [pollCycle, setPollCycle] = useState(0)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [backupPath, setBackupPath] = useState<string | null>(null)
  const [discard, setDiscard] = useState<DiscardAction | null>(null)
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const mounted = useRef(false)
  const epoch = useRef(0)
  const ticket = useRef(0)
  const lock = useRef(false)
  const runRef = useRef<AiRun | null>(null)
  const configDirtyRef = useRef(false)
  const composeDirtyRef = useRef(false)
  const perspectiveRef = useRef(perspectiveKey(perspective, character))
  const callback = useRef(onDirtyChange)
  callback.current = onDirtyChange
  configDirtyRef.current = configDirty
  composeDirtyRef.current = composeDirty
  perspectiveRef.current = perspectiveKey(perspective, character)
  const scope = `${book.book.id}:${chapter.id}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const archived = Boolean(book.book.archivedAt)
  const generating = run?.state === 'running'
  const blocked = busy || loading || reading || Boolean(operation || pending || pendingMessage)
  const ready = knowledge !== null && knowledge.schemaVersion >= 6 && connections !== null && !connections.requiresUpgrade && history !== null && !history.requiresUpgrade
  const memoryTask = isAiMemoryTask(kind)
  const characterMode = perspective === 'character'
  const characterRequiresUpgrade = characterMode && (!knowledge || knowledge.schemaVersion < 4)
  const characterSelection = useMemo(() => {
    if (!character.person) return { scope: undefined, error: '请从本书人物列表中选择视角人物。' }
    if (!character.storyOrder.trim()) return { scope: undefined, error: '请填写故事时点的作者排序值，不能留空或从章节顺序推导。' }
    try { return { scope: parseAiCharacterScope({ personId: character.person.id, storyOrder: Number(character.storyOrder), readerLimited: character.readerLimited }), error: null } }
    catch (cause) { return { scope: undefined, error: cause instanceof DomainError ? cause.detail.message : '人物范围无效，请重新选择。' } }
  }, [character])
  const summaryBlocked = perspective !== 'author' && selectedSummaries.length > 0
  const characterTaskBlocked = characterMode && memoryTask
  const characterMemoryBlocked = characterMode && selectedMemory.some((hit) => unusableMemory(hit, perspective) || !characterSelection.scope || !sameCharacterScope(hit.characterScope, characterSelection.scope))
  const memoryRequiresUpgrade = memoryTask && (!knowledge || knowledge.schemaVersion < 7)
  const edited = configDirty || composeDirty || outputDirty
  const dirty = blocked || generating || edited
  const selectedConnection = connections?.connections.find((item) => item.id === config.id)
  const prepareForm = useMemo(() => ({ kind, purpose, instruction, contextScope, perspective, character, firstBlock, lastBlock,
    selectedMemory, selectedSummaries, config, configDirty, selectedConnection, knowledge, book, chapter, acceptedText }),
   [kind, purpose, instruction, contextScope, perspective, character, firstBlock, lastBlock, selectedMemory, selectedSummaries,
    config, configDirty, selectedConnection, knowledge, book, chapter, acceptedText])
  const prepareFormRef = useRef(prepareForm)
  prepareFormRef.current = prepareForm
  const localUnknown = Boolean(pending)
  const panelError = [message, error].filter((value, index, values) => value && value !== pendingMessage && values.indexOf(value) === index).join(' ') || null
  const blocks = useMemo(() => chapter.document.content.flatMap((block, index) => block.type === 'horizontalRule' ? [] : [{ id: block.attrs.id, index, label: `${index + 1}. ${blockText(block).replace(/\s+/g, ' ').slice(0, 65) || '空段落'}` }]), [chapter.document])
  const selection = useMemo(() => {
    if (kind !== 'rewrite') return { ids: [] as string[], error: null as string | null }
    const start = chapter.document.content.findIndex((block) => block.attrs.id === firstBlock)
    const end = chapter.document.content.findIndex((block) => block.attrs.id === lastBlock)
    if (start < 0 || end < 0) return { ids: [], error: '请选择改写的首段和末段。' }
    if (end < start) return { ids: [], error: '末段必须位于首段之后。' }
    const chosen = chapter.document.content.slice(start, end + 1)
    if (chosen.length > 200) return { ids: [], error: '一次最多改写 200 个连续段落。' }
    if (chosen.some((block) => block.type === 'horizontalRule')) return { ids: [], error: '改写范围不能跨过分场线，请缩小范围。' }
    return { ids: chosen.map((block) => block.attrs.id), error: null }
  }, [kind, firstBlock, lastBlock, chapter.document])
  const recommendationInput = useMemo(() => {
    if (!knowledge || knowledge.bookId !== book.book.id || chapter.bookId !== book.book.id || memoryTask || selection.error ||
      (characterMode && (characterRequiresUpgrade || !characterSelection.scope))) return null
    try {
      return parseAiContextRecommendationInput({ bookId: book.book.id, chapterId: chapter.id,
        expectedBookRevision: knowledge.bookRevision, expectedKnowledgeRevision: knowledge.knowledgeRevision, expectedRevisionId: chapter.revisionId,
        kind, instruction, contextScope, selectedBlockIds: selection.ids,
        ...(perspective !== 'author' ? { perspective } : {}), ...(characterMode ? { characterScope: characterSelection.scope } : {}),
        ...(recommendationVectorRunId ? { vectorRunId: recommendationVectorRunId } : {}) })
    } catch { return null }
  }, [book.book.id, book.book.revision, chapter.bookId, chapter.id, chapter.revisionId, chapter.bookRevision, chapter.position, chapter.document,
    knowledge, kind, instruction, contextScope, perspective, character, characterMode, characterRequiresUpgrade, characterSelection.scope,
    firstBlock, lastBlock, memoryTask, selection, recommendationVectorRunId])
  const recommendationInputRef = useRef(recommendationInput)
  recommendationInputRef.current = recommendationInput
  // 保存请求对象身份，输入改过再改回也不能重新启用旧候选。
  const currentRecommendation = recommendation?.input && recommendation.input === recommendationInput ? recommendation.page : null
  const recommendationVectorRuns = recommendation && knowledge && recommendation.page.bookId === book.book.id &&
    recommendation.page.chapterId === chapter.id && recommendation.page.chapterRevisionId === chapter.revisionId &&
    recommendation.page.bookRevision === knowledge.bookRevision && recommendation.page.knowledgeRevision === knowledge.knowledgeRevision &&
    recommendation.bookRevision === book.book.revision && recommendation.chapterBookRevision === chapter.bookRevision ? recommendation.page.vectorRuns : null
  const selectedRecommendationVector = recommendationVectorRuns?.items.find((item) => item.id === recommendationVectorRunId)

  function active(at: number, identity = scope): boolean { return mounted.current && epoch.current === at && scopeRef.current === identity }
  function invalidateRecommendations() { recommendationInputRef.current = null }
  function clearSearchPages() {
    setMemoryPage(null); setMemoryPageScope(null); setSummaryPage(null); setPersonPage(null)
    invalidateRecommendations(); setRecommendation(null); setRecommendationVectorRunId('')
  }
  function changePerspective(value: AiContextPerspective) {
    if (blocked || generating || archived || lock.current || (value === 'character' && (!knowledge || knowledge.schemaVersion < 4))) return
    perspectiveRef.current = perspectiveKey(value, character)
    setPerspective(value); setComposeDirty(true); composeDirtyRef.current = true; setDiscard(null); clearSearchPages()
  }
  function changeCharacter(patch: Partial<CharacterDraft>) {
    if (blocked || generating || archived || lock.current) return
    const next = { ...character, ...patch }
    perspectiveRef.current = perspectiveKey(perspective, next)
    invalidateRecommendations()
    setCharacter(next); setComposeDirty(true); composeDirtyRef.current = true; setDiscard(null); setMemoryPage(null); setMemoryPageScope(null)
  }
  function memorySelectionReason(hit: SelectedMemoryHit): string | null {
    return unusableMemory(hit, perspective) ?? (characterMode && (!characterSelection.scope || !sameCharacterScope(hit.characterScope, characterSelection.scope)) ? '选择时的人物范围与当前不符，请移除后在当前范围重新检索选择' : null)
  }
  function acceptConnections(value: AiConnectionPage): boolean {
    if (value.bookId !== book.book.id) { setMessage('连接列表的作品身份不符。'); return false }
    setConnections(value)
    if (!configDirtyRef.current) {
      const saved = value.connections.find((item) => item.id === config.id) ?? value.connections[0]
      if (saved) setConfig(connectionConfig(saved))
    }
    return true
  }
  function acceptRun(value: AiRun, expectedId?: string): boolean {
    const current = runRef.current
    if (value.context.summary !== undefined) { setMessage('这是卷或全书汇总记录，请在分层汇总任务中查看与审阅。'); return false }
    if (value.bookId !== book.book.id || (expectedId && value.id !== expectedId) || value.context.bookId !== value.bookId || value.context.chapterId !== value.chapterId) { setMessage('提议的作品、章节或任务身份不符。'); return false }
    if (current?.id === value.id && value.version < current.version) return false
    try {
      scopeFromContext(value.context)
      if (value.context.perspective === 'character' && value.context.kind !== value.kind) throw new Error('Character task mismatch')
      // 同一提议的固定人物快照不能随生成进度或迟到回执切换。
      if (current?.id === value.id && (current.context.perspective === 'character' || value.context.perspective === 'character') &&
        (value.kind !== current.kind || value.context.kind !== value.kind || value.context.contextHash !== current.context.contextHash ||
          !matchesPerspective(value.context, current.context.perspective ?? 'author', scopeFromContext(current.context)) ||
          JSON.stringify(value.context.characterContext) !== JSON.stringify(current.context.characterContext))) throw new Error('Character context changed')
    } catch { setMessage('提议的人物范围、认知修订或固定预览不符，已保留本地选择。'); return false }
    if (current?.id !== value.id || !composeDirtyRef.current) {
      const nextPerspective = value.context.perspective ?? 'author'
      const fixed = value.context.characterContext
      const nextCharacter: CharacterDraft = fixed ? { person: { id: fixed.personId, name: fixed.personName }, storyOrder: String(fixed.storyOrder), readerLimited: fixed.readerLimited } : emptyCharacterDraft()
      const nextScope = perspectiveKey(nextPerspective, nextCharacter)
      if (current?.id !== value.id || nextScope !== perspectiveRef.current) clearSearchPages()
      perspectiveRef.current = nextScope; setPerspective(nextPerspective); setCharacter(nextCharacter)
      if (current?.id !== value.id) { setKind(value.kind); setPurpose(value.context.purpose) }
      if (nextPerspective === 'character') {
        setKind(value.kind); setContextScope(value.context.contextScope); setInstruction(value.context.instruction)
        setFirstBlock(value.context.selectedBlockIds[0] ?? ''); setLastBlock(value.context.selectedBlockIds[value.context.selectedBlockIds.length - 1] ?? '')
        // 与人物范围共用恢复条件；保留固定片段和修订，让后端拒绝过时资料。
        if (fixed) {
          const characterScope = characterScopeOf(fixed)
          setSelectedMemory(value.context.evidence.map((item) => ({ sourceKind: item.sourceKind, sourceId: item.sourceId, revisionId: item.revisionId,
            title: item.title, nature: item.nature, authorDecision: item.authorDecision, freshness: item.freshness, conflictState: item.conflictState,
            ...(item.readerDisclosure ? { readerDisclosure: item.readerDisclosure } : {}), chunkId: item.chunkId, blockId: item.blockId,
            excerpt: item.text, dependencyState: item.dependencyState, reasons: [], characterScope })))
        }
      }
    }
    if (!current || current.id !== value.id || current.version !== value.version) setDiscard(null)
    runRef.current = value; setRun(value)
    if (current?.id !== value.id || !outputDirty || value.state === 'adopted') {
      setAcceptedText(value.acceptedText ?? value.outputText)
      try { setMemoryDrafts(isAiMemoryTask(value.kind) && value.state === 'succeeded' ? createAiMemoryDrafts(value) : []) }
      catch { setMemoryDrafts([]) }
      if (current?.id !== value.id || value.state === 'adopted') setOutputDirty(false)
    }
    // 历史列表只保留摘要；浏览多个候选不会把完整上下文与原输出累积到列表状态。
    const summary = runSummary(value)
    setHistory((page) => page ? { ...page, runs: page.runs.map((item) => item.id === value.id ? summary : item) } : page)
    return true
  }
  function clearLocalEdits() {
    setConfigDirty(false); configDirtyRef.current = false; setApiKey(''); setComposeDirty(false); composeDirtyRef.current = false; setOutputDirty(false)
    setInstruction(''); setPurpose(undefined); setPerspective('author'); setSelectedMemory([]); setSelectedSummaries([]); setFirstBlock(''); setLastBlock(''); setMemoryDrafts([])
    setCharacter(emptyCharacterDraft()); setPersonQuery(''); perspectiveRef.current = perspectiveKey('author', emptyCharacterDraft()); clearSearchPages()
  }
  function close() {
    if (blocked || lock.current) return
    if (generating) { setMessage('本次生成仍未结束。请先取消生成，或核对状态后显式标记中断。'); return }
    if (edited) { setDiscard({ label: '放弃本页尚未保存的连接、创作要求与改稿，并关闭？已经保存的提议和部分输出会保留。', proceed: () => { clearLocalEdits(); callback.current(false); onClose() } }); return }
    callback.current(false); onClose()
  }
  function begin(label: string): number | null {
    if (lock.current || blocked) return null
    lock.current = true; ticket.current += 1; setOperation(label); setMessage(null); setDiscard(null); callback.current(true)
    return epoch.current
  }
  function finish(at: number) { if (active(at)) { lock.current = false; setOperation(null) } }

  useEffect(() => {
    mounted.current = true; setRefreshRequested(true)
    return () => { mounted.current = false; epoch.current += 1; ticket.current += 1; callback.current(false) }
  }, [api, book.book.id, chapter.id])
  useEffect(() => { callback.current(dirty) }, [dirty])
  useEffect(() => { setRecoveryConfirmed(false) }, [pending, pendingMessage, edited, acceptedText, memoryDrafts, instruction, kind, purpose, contextScope, perspective, character, firstBlock, lastBlock, selectedMemory, selectedSummaries])

  async function initialize() {
    const at = epoch.current; const identity = scope; const currentTicket = ++ticket.current
    setLoading(true); setMessage(null); setSummaryPage(null); setPersonPage(null)
    const results = await Promise.allSettled([
      request(() => api.listAiConnections({ bookId: book.book.id })),
      request(() => api.getKnowledgeStatus({ bookId: book.book.id })),
      request(() => api.listAiRuns({ bookId: book.book.id })),
    ])
    if (!active(at, identity) || currentTicket !== ticket.current) return
    setLoading(false)
    const [connectionResult, knowledgeResult, historyResult] = results
    if (connectionResult.status === 'fulfilled' && connectionResult.value.ok) acceptConnections(connectionResult.value.data)
    else setMessage(connectionResult.status === 'fulfilled' && !connectionResult.value.ok ? connectionResult.value.error.message : '读取连接列表失败，请重试。')
    if (knowledgeResult.status === 'fulfilled' && knowledgeResult.value.ok && knowledgeResult.value.data.bookId === book.book.id) setKnowledge(knowledgeResult.value.data)
    else setMessage(knowledgeResult.status === 'fulfilled' && !knowledgeResult.value.ok ? knowledgeResult.value.error.message : '读取作品版本失败，请重试。')
    if (historyResult.status === 'fulfilled' && historyResult.value.ok && historyResult.value.data.bookId === book.book.id) {
      setHistory(historyResult.value.data); setBefore(undefined)
      const running = historyResult.value.data.runs.find((item) => item.state === 'running')
      if (running && !runRef.current) setRequestedRunId(running.id)
    } else setMessage(historyResult.status === 'fulfilled' && !historyResult.value.ok ? historyResult.value.error.message : '读取提议记录失败，请重试。')
  }
  useEffect(() => {
    if (!refreshRequested || busy || operation || pending || pendingMessage || lock.current || reading) return
    setRefreshRequested(false); void initialize()
  }, [refreshRequested, busy, operation, pending, pendingMessage, reading])

  // 未确认的写入只查询原请求，不保存可重发的请求闭包，也不把会话密钥写入恢复资料。
  async function write<T>(label: string, send: () => Promise<Result<T>>, accept: (value: T) => boolean, receive: (response: CompletedRequest) => boolean): Promise<boolean> {
    const at = begin(label)
    if (at === null) return false
    try {
      const result = await request(send)
      if (!active(at)) return false
      if (result.ok) {
        if (accept(result.data)) return true
        setPending({ label, receive }); return false
      }
      setMessage(result.error.message)
      if (result.error.code === 'REQUEST_TIMEOUT' || result.error.code === 'SERVICE_UNAVAILABLE') setPending({ requestId: result.error.requestId, label, receive })
      return false
    } finally { finish(at) }
  }
  function runReceipt(response: CompletedRequest, commands: CompletedRequest['command'][], id?: string): boolean {
    if (!commands.includes(response.command)) return false
    if (!response.result.ok) { setMessage(response.result.error.message); return true }
    // 这里只处理声明为 AiRun 的命令；字段身份仍由 acceptRun 再核对。
    return acceptRun(response.result.data as AiRun, id)
  }
  function sourceReadReceipt(response: CompletedRequest): boolean {
    if (response.command === 'ai.connection.list') {
      if (!response.result.ok) { setMessage(response.result.error.message); return true }
      if (!acceptConnections(response.result.data)) return false
      setMessage('前置读取请求已确认；后续操作未执行。当前编辑保留，请核对后明确操作。')
      return true
    }
    return false
  }
  function generationReceipt(response: CompletedRequest, id: string): boolean {
    // 连接读取也可能发生在 claim 之后；仅凭该回执不能判断候选尚未登记。
    if (response.command === 'ai.connection.list') {
      if (!response.result.ok) setMessage(response.result.error.message)
      else if (response.result.data.bookId !== book.book.id) return false
      else setMessage('原生成流程的连接读取已确认，正在核对候选与活动请求状态；不会自动发送或重发。')
      setRequestedRunId(id); setPollStopped(false)
      return true
    }
    if (!runReceipt(response, ['ai.get', 'ai.claim', 'ai.checkpoint', 'ai.finish'], id)) return false
    if (response.result.ok) {
      setRequestedRunId(id); setPollStopped(false)
      setMessage('原生成进度请求已确认，正在重新读取状态；不会重复发送。')
    }
    return true
  }
  async function checkLocalReceipt() {
    if (!pending || checkingLocal || checkingReceipt || busy || pendingMessage) return
    if (!pending.requestId) { setMessage('本次操作没有可查询的回执编号。请留存需要的改稿，再进入恢复核对记录。'); return }
    const at = epoch.current; const captured = pending
    setCheckingLocal(true)
    try {
      const result = await request(() => api.getRequestStatus({ requestId: captured.requestId! }))
      if (!active(at)) return
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.state !== 'completed') { setMessage(result.data.state === 'pending' ? '原请求仍在处理中，请稍后再核对。' : '原回执已不可用，请留存改稿后进入恢复。'); return }
      const completed = result.data.response
      if (!completed.result.ok && ['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(completed.result.error.code)) { setMessage(completed.result.error.message); return }
      if (!captured.receive(completed)) { setMessage('回执的操作或对象身份不符，已保持锁定。'); return }
      setPending(null)
    } finally { if (active(at)) setCheckingLocal(false) }
  }
  function editConfig(patch: Partial<AiConnectionConfig>) { setConfig((value) => ({ ...value, ...patch })); setConfigDirty(true); configDirtyRef.current = true }
  function resetConfig(id?: string) {
    const saved = connections?.connections.find((item) => item.id === (id ?? config.id))
    setConfig(saved ? connectionConfig(saved) : freshConnection()); setConfigDirty(false); configDirtyRef.current = false; setApiKey(''); setMessage(null)
  }
  async function saveConnection(event: FormEvent) {
    event.preventDefault()
    if (archived || generating || !ready) return
    let value: AiConnectionConfig
    try { value = parseAiConnectionConfig(config) } catch (cause) { setMessage(cause instanceof DomainError ? cause.detail.message : '连接配置无效。'); return }
    let secret = apiKey; setApiKey('')
    const expectedVersion = selectedConnection?.version ?? null
    try {
      await write('保存连接', () => api.configureAiConnection({ bookId: book.book.id, connection: value, expectedVersion, ...(secret ? { apiKey: secret } : {}) }), (page) => {
        if (page.bookId !== book.book.id || !page.connections.some((item) => item.id === value.id)) { setMessage('连接保存回执不符，请核对原记录。'); return false }
        setConfigDirty(false); configDirtyRef.current = false; setConfig(value)
        acceptConnections(page); setMessage('连接已保存；会话密钥仅在桌面进程内存中使用。'); return true
      }, (response) => {
        if (response.command === 'ai.connection.list') {
          if (!sourceReadReceipt(response)) return false
          if (response.result.ok) setMessage('前置读取已确认，连接配置尚未提交。当前配置保留；如需密钥请重新填写，再明确保存。')
          return true
        }
        if (response.command !== 'ai.connection.save') return false
        if (!response.result.ok) { setMessage(response.result.error.message); return true }
        if (response.result.data.id !== value.id) return false
        setConfigDirty(false); configDirtyRef.current = false; setConfig(value); setRefreshRequested(true)
        setMessage('原连接请求已确认。重新读取连接与会话密钥状态；不会再次提交密钥或配置。'); return true
      })
    } finally { secret = '' }
  }
  async function upgrade() {
    if (!upgradeConfirmed || archived || generating) return
    const at = begin('备份并启用 AI 协作')
    if (at === null) return
    try {
      await onUpgrade((value) => {
        if (!active(at)) return
        if (value.bookId !== book.book.id || value.schemaVersion < 11) { setMessage('升级回执尚未确认 v11 可用，请核对状态。'); setPending({ label: '核对升级', receive: () => false }); return }
        setBackupPath(value.backupPath ?? null); setUpgradeConfirmed(false); setRefreshRequested(true)
      })
    } catch { if (active(at)) { setMessage('升级结果尚未确认，请保留窗口并进入恢复核对。'); setPending({ label: '核对升级', receive: () => false }) } }
    finally { finish(at) }
  }
  async function readPeople(offset = 0) {
    if (blocked || generating || archived || lock.current || !characterMode || !knowledge || knowledge.schemaVersion < 4) return
    const at = epoch.current; const currentTicket = ++ticket.current; const requestedScope = perspectiveRef.current
    const search = personQuery.trim()
    lock.current = true; setReading(true); setMessage(null)
    const result = await request(() => api.listKnowledgeItems({ bookId: book.book.id, kind: 'person', search, limit: PERSON_PAGE_SIZE, offset }))
    if (!active(at) || currentTicket !== ticket.current) return
    lock.current = false; setReading(false)
    if (requestedScope !== perspectiveRef.current) return
    if (!result.ok) { setMessage(result.error.message); return }
    try {
      const page = result.data
      if (page.bookId !== book.book.id || !Array.isArray(page.items) || page.items.length > PERSON_PAGE_SIZE ||
        !Number.isSafeInteger(page.total) || page.total < 0 || page.items.some((item) => item.bookId !== book.book.id || item.kind !== 'person') ||
        (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== offset + page.items.length || page.nextOffset <= offset || page.nextOffset >= page.total))) throw new Error('Person page mismatch')
      // 仅保留身份白名单，人物 summary 和别名不进入视角选择或恢复包。
      const items = page.items.map((item) => ({ id: requiredId(item.id).toLowerCase(), name: requiredText(item.name, '人物名称', 120) }))
      if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('Duplicate person')
      setPersonPage({ items, offset, total: page.total, nextOffset: page.nextOffset })
    } catch { setMessage('人物列表的作品、类型或分页身份不符，请重新检索。') }
  }
  async function searchMemory(event: FormEvent) {
    event.preventDefault()
    if (blocked || generating || lock.current || (!characterMode && !memoryQuery.trim())) return
    if (characterMode && (characterRequiresUpgrade || !characterSelection.scope)) { setMessage(characterRequiresUpgrade ? '人物模式需要 v4 或以上的故事记录格式，请先升级作品。' : characterSelection.error); return }
    const at = epoch.current; const currentTicket = ++ticket.current; const requestedScope = perspectiveRef.current
    lock.current = true; setReading(true); setMessage(null); setMemoryPage(null); setMemoryPageScope(null)
    const result = await request(() => api.searchMemory({ bookId: book.book.id, query: memoryQuery, includeUnreviewed: false, includeAffected: false, limit: 30,
      ...(characterMode ? { sourceKind: 'story' as const, entityId: characterSelection.scope!.personId, nature: 'character_belief' as const } : {}) }))
    if (!active(at) || currentTicket !== ticket.current) return
    lock.current = false; setReading(false)
    if (requestedScope !== perspectiveRef.current) return
    if (result.ok && result.data.bookId === book.book.id) {
      setMemoryPage(result.data); setMemoryPageScope(requestedScope)
      const latest = result.data
      setRecommendation((value) => value && (value.page.publicationVersion !== latest.publicationVersion ||
        value.page.bookRevision !== latest.status.bookRevision || value.page.knowledgeRevision !== latest.status.knowledgeRevision)
        ? null : value)
    }
    else setMessage(result.ok ? '资料检索的作品身份不符。' : result.error.message)
  }
  async function readRecommendations() {
    if (blocked || generating || archived || lock.current || memoryTask || !recommendationInput || recommendationInputRef.current !== recommendationInput) return
    const at = epoch.current; const currentTicket = ++ticket.current; const requestedScope = perspectiveRef.current
    const input = recommendationInput
    const accept = (page: AiContextRecommendationPage): boolean => {
      if (recommendationInputRef.current !== input || requestedScope !== perspectiveRef.current) {
        setMessage('原推荐读取已结束，创作要求、资料范围或版本已变化，请按当前输入重新推荐。'); return true
      }
      try {
        const echoed = parseAiContextRecommendationInput(page.request)
        if (JSON.stringify(echoed) !== JSON.stringify(input) || page.bookId !== input.bookId || page.chapterId !== input.chapterId ||
          page.chapterRevisionId !== input.expectedRevisionId || page.bookRevision !== input.expectedBookRevision ||
          page.knowledgeRevision !== input.expectedKnowledgeRevision || !Number.isSafeInteger(page.publicationVersion) || page.publicationVersion < 0 ||
          !Array.isArray(page.queries) || page.queries.length > AI_RECOMMENDATION_QUERY_LIMIT ||
          page.queries.some((query) => !['instruction', 'chapter', 'character'].includes(query.source) || typeof query.text !== 'string' || query.text.length > 200 ||
            (query.source === 'character' ? input.perspective !== 'character' || query.text !== '' : !query.text.trim())) ||
          !Array.isArray(page.items) || page.items.length > AI_RECOMMENDATION_RESULT_LIMIT ||
          !Number.isSafeInteger(page.scannedCandidates) || page.scannedCandidates < 0 || page.scannedCandidates > AI_RECOMMENDATION_CANDIDATE_LIMIT ||
          !Number.isSafeInteger(page.excludedCandidates) || page.excludedCandidates < 0 || page.excludedCandidates + page.items.length > page.scannedCandidates ||
          typeof page.truncated !== 'boolean' || !Array.isArray(page.warnings) || page.warnings.some((warning) => typeof warning !== 'string')) throw new Error('Recommendation page mismatch')
        const vectors = page.vectorRuns
        if (vectors.bookId !== input.bookId || vectors.publicationVersion !== page.publicationVersion || !Array.isArray(vectors.items) ||
          typeof vectors.truncated !== 'boolean' || new Set(vectors.items.map((item) => item.id)).size !== vectors.items.length) throw new Error('Vector result page mismatch')
        for (const option of vectors.items) {
          requiredId(option.id)
          requiredText(option.query, '历史检索要求', 200)
          requiredText(option.connectionName, '历史连接名称', 80)
          requiredText(option.embeddingModel, '历史向量模型', 200)
          if (!Number.isFinite(Date.parse(option.updatedAt)) || !Number.isSafeInteger(option.hitCount) || option.hitCount < 0 ||
            typeof option.truncated !== 'boolean') throw new Error('Vector result option mismatch')
        }
        if (new Set(page.items.map((hit) => hit.chunkId)).size !== page.items.length) throw new Error('Duplicate recommendation')
        for (const hit of page.items) {
          requiredId(hit.sourceId); requiredId(hit.revisionId)
          if (hit.blockId !== null) requiredId(hit.blockId)
          if (!Number.isSafeInteger(hit.chunkId) || hit.chunkId < 1 || !['chapter', 'knowledge', 'story'].includes(hit.sourceKind) ||
            !Object.keys(natureLabels).includes(hit.nature) || typeof hit.title !== 'string' || typeof hit.excerpt !== 'string' ||
            !Array.isArray(hit.reasons) || hit.reasons.some((reason) => !Object.keys(memoryReasonLabels).includes(reason)) ||
            !Array.isArray(hit.queryIndexes) || new Set(hit.queryIndexes).size !== hit.queryIndexes.length ||
            hit.queryIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= page.queries.length) ||
            (hit.vectorRunId !== undefined && hit.vectorRunId !== input.vectorRunId) || (!hit.queryIndexes.length && !hit.vectorRunId) ||
            unusableMemory(hit, input.perspective ?? 'author') ||
            ((input.perspective === 'reader' || input.characterScope?.readerLimited) && hit.readerDisclosure?.state !== 'located')) throw new Error('Recommendation source mismatch')
        }
        setRecommendation({ page: { ...page, request: echoed }, input, bookRevision: book.book.revision, chapterBookRevision: chapter.bookRevision })
        return true
      } catch { setMessage('推荐回执的要求、版本、视角或来源身份不符，已保留原选择，请重新推荐。'); return false }
    }
    lock.current = true; setReading(true); setRecommending(true); setMessage(null)
    setRecommendation((value) => value ? { ...value, input: null } : null)
    try {
      const result = await request(() => api.recommendAiContext(input))
      if (!active(at) || currentTicket !== ticket.current) return
      if (!result.ok) {
        setMessage(result.error.message)
        // 只读请求超时也占用服务的未确认名额，须能补领原回执后解除阻塞，不能反复重发。
        if (result.error.code === 'REQUEST_TIMEOUT' || result.error.code === 'SERVICE_UNAVAILABLE') {
          setPending({ requestId: result.error.requestId, label: '读取资料推荐', receive: (response) => {
            if (response.command !== 'ai.context.recommend') return false
            if (!response.result.ok) { setMessage(response.result.error.message); return true }
            return accept(response.result.data)
          } })
        }
        return
      }
      accept(result.data)
    } finally {
      if (active(at) && currentTicket === ticket.current) { lock.current = false; setReading(false); setRecommending(false) }
    }
  }
  function chooseRecommendationVector(id: string) {
    if (blocked || generating || archived || lock.current) return
    if (id && !recommendationVectorRuns?.items.some((item) => item.id === id)) { setMessage('请从当前推荐回执中的历史查询列表选择。'); return }
    invalidateRecommendations(); setRecommendationVectorRunId(id)
  }
  function toggleMemory(hit: SelectedMemoryHit, source: 'search' | 'recommendation' = 'search') {
    if (blocked || generating || lock.current) return
    const selected = selectedMemory.some((item) => item.chunkId === hit.chunkId)
    if (!selected && unusableMemory(hit, perspective)) return
    const recommended = source === 'recommendation' && currentRecommendation && recommendationInput !== null &&
      recommendationInputRef.current === recommendationInput && perspectiveRef.current === perspectiveKey(perspective, character) &&
      currentRecommendation.items.some((item) => item === hit)
    if (!selected && source === 'recommendation' && !recommended) { setMessage('推荐条件已变化，请重新推荐后再选择。'); return }
    if (!selected && characterMode && (!characterSelection.scope || (!recommended && (memoryPageScope !== perspectiveRef.current ||
      !memoryPage?.hits.some((item) => item.chunkId === hit.chunkId && item.revisionId === hit.revisionId))))) { setMessage('请在当前人物范围重新检索或推荐资料后再选择。'); return }
    if (!selected && selectedMemory.length >= 12) { setMessage('最多选择 12 个资料片段。'); return }
    // 推荐只贡献片段选择；查询词和历史检索信息不混入恢复包与固定预览资料。
    const chosen: SelectedMemoryHit = { chunkId: hit.chunkId, sourceKind: hit.sourceKind, sourceId: hit.sourceId, revisionId: hit.revisionId,
      blockId: hit.blockId, title: hit.title, nature: hit.nature, authorDecision: hit.authorDecision, freshness: hit.freshness,
      conflictState: hit.conflictState, dependencyState: hit.dependencyState, excerpt: hit.excerpt, reasons: hit.reasons,
      ...(hit.readerDisclosure ? { readerDisclosure: hit.readerDisclosure } : {}),
      ...(characterMode && characterSelection.scope ? { characterScope: characterSelection.scope } : {}) }
    setSelectedMemory((items) => selected ? items.filter((item) => item.chunkId !== hit.chunkId) : [...items, chosen]); setComposeDirty(true); composeDirtyRef.current = true
  }
  async function readSummaries(after?: AiContextSummaryCursor) {
    if (blocked || generating || archived || perspective !== 'author' || lock.current || !knowledge || knowledge.schemaVersion < 9) return
    const at = epoch.current; const currentTicket = ++ticket.current; const requestedScope = perspectiveRef.current
    const baseline = { bookId: book.book.id, chapterId: chapter.id, expectedBookRevision: knowledge.bookRevision,
      expectedKnowledgeRevision: knowledge.knowledgeRevision, expectedRevisionId: chapter.revisionId }
    lock.current = true; setReading(true); setMessage(null)
    const result = await request(() => api.listAiContextSummaries({ ...baseline, ...(after ? { after } : {}) }))
    if (!active(at) || currentTicket !== ticket.current) return
    lock.current = false; setReading(false)
    if (requestedScope !== perspectiveRef.current) return
    if (!result.ok) { setMessage(result.error.message); return }
    try {
      const page = result.data
      if (page.bookId !== baseline.bookId || page.chapterId !== baseline.chapterId || page.chapterRevisionId !== baseline.expectedRevisionId ||
        page.bookRevision !== baseline.expectedBookRevision || page.knowledgeRevision !== baseline.expectedKnowledgeRevision ||
        !Array.isArray(page.items) || page.items.length > AI_CONTEXT_SUMMARY_PAGE || !Number.isSafeInteger(page.scannedNodes) || page.scannedNodes < page.items.length || page.scannedNodes > AI_CONTEXT_SUMMARY_PAGE ||
        page.items.some((item) => item.lastChapter.position >= chapter.position)) throw new Error('Summary page identity mismatch')
      if (page.nextAfter !== null) {
        parseAiContextSummaryInput({ ...baseline, after: page.nextAfter })
        if (page.scannedNodes !== AI_CONTEXT_SUMMARY_PAGE || JSON.stringify(page.nextAfter) === JSON.stringify(after)) throw new Error('Summary cursor mismatch')
      }
      // 每个候选复用快照解析；整页候选数量与单次可选数量分别受限。
      const items = page.items.map((item) => parseAiContextSummarySnapshots([item])[0]!)
      if (new Set(items.map((item) => item.nodeId)).size !== items.length) throw new Error('Duplicate summary node')
      setSummaryPage({ ...page, items })
    } catch { setMessage('摘要列表的作品、章节、版本或来源身份不符，请重新读取。') }
  }
  function toggleSummary(item: AiContextSummarySnapshot) {
    if (blocked || generating || archived) return
    const selected = selectedSummaries.some((entry) => entry.nodeId === item.nodeId)
    if (!selected && perspective !== 'author') { setMessage('读者与人物资料范围不能添加完整前文摘要；已选摘要可逐一移除。'); return }
    if (!selected && selectedSummaries.length >= AI_CONTEXT_SUMMARY_LIMIT) { setMessage('最多选择 4 份完整摘要。'); return }
    if (!selected && overlappingSummary(item, selectedSummaries)) { setMessage('摘要覆盖范围重复，请移除其中一份后再选择。'); return }
    setSelectedSummaries((items) => selected ? items.filter((entry) => entry.nodeId !== item.nodeId) : [...items, item]); setComposeDirty(true)
  }
  async function prepare() {
    if (summaryBlocked) { setMessage('读者与人物资料范围不能发送完整前文摘要，请先移除全部已选摘要。'); return }
    if (characterTaskBlocked) { setMessage('人物模式不支持章节摘要或知识提取，请明确更换任务；已选内容仍保留。'); return }
    if (characterMode && (characterRequiresUpgrade || !characterSelection.scope)) { setMessage(characterRequiresUpgrade ? '人物模式需要 v4 或以上的故事记录格式，请先升级作品。' : characterSelection.error); return }
    if (characterMemoryBlocked) { setMessage('已选片段包含其他范围的资料，请逐一移除，并在当前人物范围重新检索选择。'); return }
    if (!ready || !knowledge || archived || generating || configDirty || !selectedConnection || selection.error || !instruction.trim() || memoryRequiresUpgrade) return
    if (outputDirty) {
      setDiscard({ label: '放弃当前尚未采用的输出修改，并保存新的发送预览？原模型输出仍保留。', proceed: () => {
        // 确认期间仍可编辑；旧确认不能提交旧表单并覆盖新要求或资料选择。
        if (prepareFormRef.current !== prepareForm) { setMessage('创作要求、资料或改稿已变化，已保留当前内容，请重新保存预览。'); return }
        setOutputDirty(false); void prepareConfirmed()
      } })
      return
    }
    await prepareConfirmed()
  }
  async function prepareConfirmed() {
    if (!knowledge || !selectedConnection) return
    if (perspectiveKey(perspective, character) !== perspectiveRef.current) { setMessage('人物范围已修改，请按当前选择重新准备预览。'); return }
    let input: AiPrepareInput
    try {
      // 范围切换保留选择，由作者明确移除不兼容的资料，避免静默漏发。
      if (summaryBlocked) throw new DomainError({ code: 'INVALID_INPUT', message: '读者与人物资料范围不能发送完整前文摘要，请先移除全部已选摘要。' })
      if (characterMode && (characterTaskBlocked || characterRequiresUpgrade || !characterSelection.scope || characterMemoryBlocked)) throw new DomainError({ code: 'INVALID_INPUT', message: '请核对人物、故事时点、任务和已选资料，移除不符合当前范围的选择后再准备。' })
      input = parseAiPrepareInput({ bookId: book.book.id, chapterId: chapter.id, expectedBookRevision: knowledge.bookRevision,
        expectedKnowledgeRevision: knowledge.knowledgeRevision, expectedRevisionId: chapter.revisionId, connectionId: config.id, kind, purpose, instruction,
        contextScope: memoryTask ? 'chapter' : contextScope, ...(perspective !== 'author' ? { perspective } : {}),
        ...(characterMode ? { characterScope: characterSelection.scope } : {}),
        selectedBlockIds: selection.ids, memoryChunkIds: memoryTask ? [] : selectedMemory.map((item) => item.chunkId),
        summaryRefs: memoryTask ? [] : selectedSummaries.map(contextSummaryRef) })
    } catch (cause) { setMessage(cause instanceof DomainError ? cause.detail.message : '创作要求或资料选择无效，请核对后重新预览。'); return }
    const selected = memoryTask ? [] : selectedSummaries
    const connection = selectedConnection
    const requestedScope = perspectiveKey(perspective, character)
    const accept = (value: AiRun): boolean => {
      try {
        const context = value.context
        const summaries = context.contextSummaries === undefined ? [] : parseAiContextSummarySnapshots(context.contextSummaries)
        // 正常回执和迟到回执均须对应本次完整输入；身份不符时保留本地要求与选择。
        if (value.state !== 'prepared' || value.version !== 0 || value.bookId !== input.bookId || value.chapterId !== input.chapterId || value.kind !== input.kind ||
          context.summary !== undefined || context.bookRevision !== input.expectedBookRevision || context.knowledgeRevision !== input.expectedKnowledgeRevision ||
          context.chapterRevisionId !== input.expectedRevisionId || context.purpose !== input.purpose || context.instruction !== input.instruction || context.contextScope !== input.contextScope ||
          requestedScope !== perspectiveRef.current || !matchesPerspective(context, input.perspective ?? 'author', input.characterScope) ||
          JSON.stringify(context.connection) !== JSON.stringify(connection) || JSON.stringify(context.selectedBlockIds) !== JSON.stringify(input.selectedBlockIds) ||
          JSON.stringify(context.evidence.map((item) => item.chunkId)) !== JSON.stringify(input.memoryChunkIds) || JSON.stringify(summaries) !== JSON.stringify(selected) ||
          (input.perspective === 'character' && context.evidence.some((item, index) => item.sourceId !== selectedMemory[index]?.sourceId || item.revisionId !== selectedMemory[index]?.revisionId)) ||
          !acceptRun(value)) return false
        setComposeDirty(false); composeDirtyRef.current = false; setOutputDirty(false); setPollStopped(false); setRefreshRequested(true); return true
      } catch { setMessage('发送预览回执与本次输入无法核对，请保留要求并查询原回执。'); return false }
    }
    await write('保存发送预览', () => api.prepareAiRun(input), accept, (response) => {
      if (response.command === 'ai.connection.list') return sourceReadReceipt(response)
      if (response.command !== 'ai.prepare') return false
      if (!response.result.ok) { setMessage(response.result.error.message); return true }
      return accept(response.result.data as AiRun)
    })
  }
  async function readRun(id: string, polling = false) {
    if (blocked || lock.current || (outputDirty && !polling)) return
    const at = epoch.current; const currentTicket = ++ticket.current
    if (!polling) { lock.current = true; setReading(true); setMessage(null) }
    const result = await request(() => api.getAiRun({ bookId: book.book.id, runId: id }))
    if (!active(at) || currentTicket !== ticket.current) return
    if (!polling) { lock.current = false; setReading(false) }
    if (result.ok && acceptRun(result.data, id)) { setPollStopped(false); setPollCycle((value) => value + 1) }
    else {
      setMessage(result.ok ? '读取的提议身份不符。' : result.error.message); setPollStopped(true)
      if (!result.ok && ['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(result.error.code)) {
        setPending({ requestId: result.error.requestId, label: '读取生成进度', receive: (response) => generationReceipt(response, id) })
      }
    }
  }
  useEffect(() => {
    if (!requestedRunId || blocked || lock.current) return
    const id = requestedRunId; setRequestedRunId(null); void readRun(id)
  }, [requestedRunId, blocked])
  useEffect(() => {
    if (!run || run.state !== 'running' || run.active === false || blocked || pollStopped) return
    const timer = window.setTimeout(() => { void readRun(run.id, true) }, 1200)
    return () => window.clearTimeout(timer)
  }, [run?.id, run?.state, run?.active, run?.version, pollCycle, blocked, pollStopped])
  async function sendRun() {
    const current = runRef.current
    if (!current || current.context.summary !== undefined || current.state !== 'prepared' || current.chapterId !== chapter.id || archived || configDirty || composeDirty) return
    if (!matchesPerspective(current.context, perspective, characterMode ? characterSelection.scope : undefined) || characterRequiresUpgrade || characterTaskBlocked || summaryBlocked || characterMemoryBlocked) { setMessage('当前人物或资料范围与固定预览不符，请保留选择并重新准备预览。'); return }
    if (current.context.perspective === 'reader' && (isAiMemoryTask(current.kind) || current.context.contextSummaries?.length)) { setMessage('这份读者资料预览包含不支持的章节整理任务或完整摘要，请重新准备预览。'); return }
    await write('确认发送并生成', () => api.startAiRun({ bookId: book.book.id, runId: current.id, expectedVersion: current.version, contextHash: current.context.contextHash }), (value) => {
      if (!acceptRun(value, current.id)) return false
      setPollStopped(false); return true
    }, (response) => generationReceipt(response, current.id))
  }
  async function stopRun() {
    const current = runRef.current
    if (!current || current.state !== 'running') return
    await write('取消生成并保留输出', () => api.cancelAiRun({ bookId: book.book.id, runId: current.id }), (value) => acceptRun(value, current.id), (response) => generationReceipt(response, current.id))
  }
  async function interruptRun() {
    const current = runRef.current
    if (!current || current.state !== 'running' || current.active !== false) return
    await write('标记中断', () => api.interruptAiRun({ bookId: book.book.id, runId: current.id, expectedVersion: current.version }), (value) => acceptRun(value, current.id), (response) => runReceipt(response, ['ai.interrupt'], current.id))
  }
  async function rejectRun(target: { bookId: string; runId: string; expectedVersion: number }) {
    const current = runRef.current
    // 确认只授权当时那份提议；切换记录或版本变化后必须重新确认。
    if (!current || target.bookId !== book.book.id || current.bookId !== target.bookId || current.id !== target.runId || current.version !== target.expectedVersion) {
      setMessage('提议或版本已变化，请重新核对后再确认拒绝。'); return
    }
    if (['running', 'adopted', 'rejected'].includes(current.state) || archived) return
    await write('拒绝本次提议', () => api.rejectAiRun(target), (value) => {
      if (!acceptRun(value, target.runId)) return false
      setOutputDirty(false); setAcceptedText(value.outputText); return true
    }, (response) => {
      if (!runReceipt(response, ['ai.reject'], target.runId)) return false
      if (response.result.ok) { setOutputDirty(false); setAcceptedText(runRef.current?.outputText ?? '') }
      return true
    })
  }
  async function adopt() {
    const current = runRef.current
    if (!current || current.context.summary !== undefined || current.context.purpose === 'review' || isAiMemoryTask(current.kind) || current.state !== 'succeeded' || current.chapterId !== chapter.id || !acceptedText.trim() || archived) return
    const input: AiAdoptInput = { bookId: book.book.id, runId: current.id, expectedVersion: current.version, acceptedText }
    const at = begin('采用作者审阅后的内容')
    if (at === null) return
    try {
      await onAdopt(input, current, (receipt) => {
        if (!active(at)) return false
        if (!isAiAdoptReceiptFor(input, current, receipt) || !acceptRun(receipt.run, current.id)) {
          setMessage('采用回执与固定提议不符，请保留改稿并核对。'); setPending({ label: '核对采用', receive: () => false }); return false
        }
        setRefreshRequested(true); return true
      })
    } catch { if (active(at)) { setMessage('采用结果尚未确认，请留存改稿并进入恢复核对。'); setPending({ label: '核对采用', receive: () => false }) } }
    finally { finish(at) }
  }
  async function adoptMemory() {
    const current = runRef.current
    if (!current || current.context.summary !== undefined || !isAiMemoryTask(current.kind) || current.state !== 'succeeded' || current.chapterId !== chapter.id || archived) return
    let input: AiMemoryAdoptInput
    try { input = parseAiMemoryAdoptInput({ bookId: book.book.id, runId: current.id, expectedVersion: current.version,
      entries: aiMemoryReviewEntries(memoryDrafts) }) }
    catch (cause) { setMessage(cause instanceof DomainError ? cause.detail.message : '请核对所选整理内容。'); return }
    const at = begin('采用已审阅的知识建议')
    if (at === null) return
    try {
      await onAdoptMemory(input, current, (receipt) => {
        if (!active(at)) return false
        if (!isAiMemoryAdoptReceiptFor(input, current, receipt) || !acceptRun(receipt.run, current.id)) {
          setMessage('知识采用回执与固定提议不符，请保留审阅内容并核对记录。'); setPending({ label: '核对知识采用', receive: () => false }); return false
        }
        setKnowledge(receipt.status); setRefreshRequested(true); return true
      })
    } catch { if (active(at)) { setMessage('知识采用结果尚未确认，请留存审阅内容并进入恢复核对。'); setPending({ label: '核对知识采用', receive: () => false }) } }
    finally { finish(at) }
  }
  function openHistory(item: AiRunSummary) {
    if (blocked || generating) return
    const open = () => {
      setDiscard(null)
      setOutputDirty(false); setComposeDirty(false); composeDirtyRef.current = false; setInstruction(''); setSelectedMemory([]); setSelectedSummaries([]); setFirstBlock(''); setLastBlock('')
      setCharacter(emptyCharacterDraft()); setPersonQuery(''); setPerspective('author'); perspectiveRef.current = perspectiveKey('author', emptyCharacterDraft()); clearSearchPages()
      setRequestedRunId(item.id); setPollStopped(false)
    }
    if (outputDirty || composeDirty) setDiscard({ label: '放弃本页尚未保存的创作要求与改稿，查看这次提议？', proceed: open })
    else open()
  }
  async function historyPage(cursor?: string) {
    if (blocked || generating || lock.current) return
    const at = epoch.current; const currentTicket = ++ticket.current
    lock.current = true; setReading(true); setMessage(null)
    const result = await request(() => api.listAiRuns({ bookId: book.book.id, ...(cursor ? { before: cursor } : {}) }))
    if (!active(at) || currentTicket !== ticket.current) return
    lock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id) { setHistory(result.data); setBefore(cursor) }
    else setMessage(result.ok ? '提议记录的作品身份不符。' : result.error.message)
  }
  function recover() {
    if (checkingLocal || checkingReceipt || operation || (edited && !recoveryConfirmed)) return
    setApiKey(''); callback.current(false); onRecover()
  }

  const recoveryText = JSON.stringify({ bookId: book.book.id, chapterId: chapter.id, runId: run?.id ?? null,
    composition: composeDirty ? { kind, purpose, instruction, connectionId: config.id, contextScope, ...(perspective !== 'author' ? { perspective } : {}),
      ...(characterMode ? { characterScope: characterSelection.scope } : {}),
      ...(character.person || character.storyOrder || character.readerLimited ? { characterDraft: character } : {}), firstBlock, lastBlock, selectedMemory, selectedSummaries } : undefined,
    characterContext: run?.context.characterContext,
    acceptedText: outputDirty ? acceptedText : undefined,
    memoryReview: outputDirty && run && isAiMemoryTask(run.kind) ? memoryDrafts : undefined,
    connection: configDirty ? config : undefined }, null, 2)
  const taskCurrent = run?.chapterId === chapter.id
  const runScopeMatches = !run || matchesPerspective(run.context, perspective, characterMode ? characterSelection.scope : undefined)
  return <Dialog title="AI 创作协作" wide busy={blocked} onClose={close} error={panelError}>
    <div className={layout.intro}><p>《{book.book.title}》 · {chapter.title}</p><span>预览 → 明确发送 → 作者审阅 → 采用</span></div>
    <p className={styles.note}>你决定章节方向与定稿。规划存入章节备注，续写追加到章尾，改写替换选中的连续段落。章节摘要与知识建议需逐条审阅、核对引文后，另行选择入库。</p>
    {operation && <p className={styles.note} role="status">{operation}…</p>}
    {(localUnknown || pendingMessage) && <section className={layout.pending} role="alert"><h3>本次操作结果未确认</h3><p>{pendingMessage ?? `${pending?.label}尚未收到确定结果。新的写入已暂停，请查询原请求。`}</p><p>不会自动重发生成、密钥或采用请求。恢复后请先核对提议记录与磁盘正文。</p>{edited && <><label>需要留存的本页内容<textarea className={styles.recoveryCopy} value={recoveryText} readOnly rows={7} onFocus={(event) => event.target.select()} /></label><label className={shared.checkLabel}><input type="checkbox" checked={recoveryConfirmed} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />我已留存需要的创作要求与改稿，允许进入恢复</label></>}<div className={styles.actions}><button className={shared.button} type="button" disabled={checkingLocal || checkingReceipt} onClick={pendingMessage ? onCheckReceipt : () => void checkLocalReceipt()}>{checkingLocal || checkingReceipt ? '正在核对…' : '查询原回执'}</button><button className={shared.button} type="button" disabled={checkingLocal || checkingReceipt || (edited && !recoveryConfirmed)} onClick={recover}>进入草稿与恢复</button></div></section>}
    {loading && <p className={styles.note} role="status">正在读取连接、版本与提议记录…</p>}
    {!loading && (!connections || !knowledge || !history) && <button className={shared.button} type="button" disabled={blocked} onClick={() => setRefreshRequested(true)}>重新读取状态</button>}
    {!loading && knowledge && (knowledge.schemaVersion < 9 || connections?.requiresUpgrade || history?.requiresUpgrade) && <section className={layout.upgrade}><h3>{knowledge.schemaVersion >= 7 ? '为本书启用前文摘要' : knowledge.schemaVersion >= 6 ? '为本书启用章节整理与前文摘要' : '为本书启用 AI 协作与章节整理'}</h3><p>当前作品格式 v{knowledge.schemaVersion}。先建立独立数据库备份，再升级到当前作品格式。连接、固定预览、原输出与采用记录保存在本书；已有 v6 创作协作可继续使用。</p><label className={layout.upgradeCheck}><input type="checkbox" checked={upgradeConfirmed} disabled={blocked || archived || generating} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />同意创建本书数据库备份并升级</label><button className={shared.primaryButton} type="button" disabled={blocked || archived || generating || !upgradeConfirmed} onClick={() => void upgrade()}>备份并启用</button></section>}
    {backupPath && <p className={layout.backupPath}>升级前数据库副本：{backupPath}</p>}
    {ready && <>
      <details className={styles.connection} open={!selectedConnection || configDirty}><summary>模型连接 · {selectedConnection?.name ?? '请先配置'}</summary><form className={layout.editorForm} onSubmit={(event) => void saveConnection(event)}>
        <div className={styles.connectionChoice}><label>已保存连接<select value={selectedConnection?.id ?? ''} disabled={blocked || generating || configDirty} onChange={(event) => resetConfig(event.target.value)}><option value="" disabled>选择连接</option>{connections?.connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className={shared.button} type="button" disabled={blocked || generating || configDirty || archived} onClick={() => { setConfig(freshConnection()); setConfigDirty(true); configDirtyRef.current = true; setApiKey('') }}>新建连接</button></div>
        <div className={layout.twoColumns}><label>连接名称<input value={config.name} required maxLength={80} disabled={blocked || generating || archived} onChange={(event) => editConfig({ name: event.target.value })} /></label><label>模型名称<input value={config.model} required maxLength={200} disabled={blocked || generating || archived} placeholder="填写接口支持的模型名" onChange={(event) => editConfig({ model: event.target.value })} /></label></div>
        <label>接口基础地址<input value={config.baseUrl} required maxLength={2000} disabled={blocked || generating || archived} placeholder="https://api.example.com/v1" autoCapitalize="none" spellCheck={false} onChange={(event) => editConfig({ baseUrl: event.target.value })} /></label>
        <div className={layout.twoColumns}><label>上下文窗口（tokens）<input type="number" min={1024} max={2_000_000} step={1} value={config.contextWindow} required disabled={blocked || generating || archived} onChange={(event) => editConfig({ contextWindow: Number(event.target.value) })} /></label><label>最大输出（tokens）<input type="number" min={1} max={16_384} step={1} value={config.maxOutputTokens} required disabled={blocked || generating || archived} onChange={(event) => editConfig({ maxOutputTokens: Number(event.target.value) })} /></label></div>
        <label>本次桌面会话密钥<input type="password" value={apiKey} maxLength={8192} autoComplete="new-password" disabled={blocked || generating || archived} placeholder={connections?.sessionKeyIds.includes(config.id) ? '本会话已设置；留空保留' : '按接口需要填写；不会保存到文件'} onChange={(event) => { setApiKey(event.target.value); setConfigDirty(true); configDirtyRef.current = true }} /></label>
        <p className={styles.note}>使用兼容 Chat Completions 的接口。密钥不回显、不写入作品文件；退出桌面进程后需重新填写。本机无鉴权接口可留空。修改配置后须先保存。</p>
        <div className={styles.actions}><button className={shared.primaryButton} type="submit" disabled={blocked || generating || archived}>保存连接</button>{configDirty && <button className={shared.button} type="button" disabled={blocked || generating} onClick={() => resetConfig()}>放弃连接修改</button>}</div>
      </form></details>
      <section className={styles.composer} aria-label="创作要求"><div className={styles.heading}><h3>准备一次创作协作</h3><span>先在本地保存预览</span></div><div className={layout.twoColumns}><label>任务<select value={purpose === 'review' ? 'review' : kind} disabled={blocked || generating || archived} onChange={(event) => { invalidateRecommendations(); const review = event.target.value === 'review'; setKind(review ? 'plan' : event.target.value as AiTaskKind); setPurpose(review ? 'review' : undefined); if (review && !instruction.trim()) setInstruction('审阅本章的结构、因果、人物知情、伏笔、语言与对白。逐项提供固定段落引文、理由、反证与修改建议；证据不足时明确说明。'); setComposeDirty(true) }}>{Object.entries(taskLabels).map(([value, label]) => <option key={value} value={value} disabled={perspective !== 'author' && (value === 'summarize' || value === 'extract')}>{label}</option>)}<option value="review">审稿 · 核对问题与证据</option></select></label><label>正文上下文<select value={memoryTask ? 'chapter' : contextScope} disabled={blocked || generating || archived || memoryTask} onChange={(event) => { invalidateRecommendations(); setContextScope(event.target.value as 'chapter' | 'nearby'); setComposeDirty(true) }}><option value="chapter">当前整章</option><option value="nearby">相关段落附近</option></select></label></div>
        <div className={styles.perspective}><label>附加资料范围<select value={perspective} aria-describedby={perspectiveHintId} disabled={blocked || generating || archived} onChange={(event) => { const value = event.target.value; if (value === 'author' || value === 'reader' || value === 'character') changePerspective(value) }}><option value="author">作者资料（默认）</option><option value="reader" disabled={memoryTask}>读者已披露资料</option><option value="character" disabled={!knowledge || knowledge.schemaVersion < 4}>人物视角资料</option></select></label>
          <p id={perspectiveHintId} className={styles.note}>{characterMode ? '只附加所选人物在指定故事时点之前形成的认知片段；态度与隐瞒标记独立保留。人物身份仅含名称与固定标识。原文和要求仍需作者核对，不保证逐句防剧透。' : memoryTask ? '章节摘要和知识提取仅支持作者资料范围。' : perspective === 'reader' ? '附加资料仅限披露章严格早于本章、且披露锚点仍在当前原稿中的故事片段；准备预览时核对。当前章、要求、章节目标和备注仍为作者输入，整次发送不保证防剧透；人物知情未知。' : '按现有采纳与来源规则选择附加资料，可选入完整前文摘要。读者披露与人物知情互不推导。'}</p>
        </div>
        {characterMode && <section className={styles.selection} aria-label="人物视角范围">
          <form className={styles.search} onSubmit={(event) => { event.preventDefault(); void readPeople() }}>
            <label>查找本书人物<input value={personQuery} maxLength={200} disabled={blocked || generating || archived || characterRequiresUpgrade} onChange={(event) => { setPersonQuery(event.target.value); setPersonPage(null) }} placeholder="输入人物名称；留空浏览全部人物" /></label>
            <button className={shared.button} type="submit" disabled={blocked || generating || archived || characterRequiresUpgrade}>检索人物</button>
          </form>
          {personPage ? <>
            <p className={styles.note} role="status">找到 {personPage.total} 位人物 · 本页 {personPage.items.length} 位{personPage.total > 0 ? ` · 第 ${Math.floor(personPage.offset / PERSON_PAGE_SIZE) + 1} 页` : ''}。选择后会保留人物，翻页不会改变选择。</p>
            {personPage.items.length ? <ul className={styles.memoryResults}>{personPage.items.map((person) => <li key={person.id}><label className={shared.checkLabel}>
              <input type="radio" name={`${perspectiveHintId}-person`} checked={character.person?.id === person.id} disabled={blocked || generating || archived} onChange={() => changeCharacter({ person })} />
              <span><strong>{person.name}</strong><small>人物标识 {person.id}</small></span>
            </label></li>)}</ul> : <p className={styles.note}>本页没有人物。可换一个名称检索，或先在知识库创建人物条目。</p>}
            <div className={styles.actions}><button className={shared.button} type="button" disabled={blocked || generating || archived || personPage.offset === 0} onClick={() => void readPeople(Math.max(0, personPage.offset - PERSON_PAGE_SIZE))}>上一页人物</button><button className={shared.button} type="button" disabled={blocked || generating || archived || personPage.nextOffset === null} onClick={() => { if (personPage.nextOffset !== null) void readPeople(personPage.nextOffset) }}>下一页人物</button></div>
          </> : <p className={styles.note}>检索后按页选择人物，无需填写标识。人物说明与别名不会作为身份资料发送。</p>}
          <p className={styles.note} role="status">{character.person ? `已选人物：${character.person.name} · ${character.person.id}` : '尚未选择视角人物。'}</p>
          <label>故事时点（作者排序值）<input type="number" min={-1_000_000_000} max={1_000_000_000} step={1} required value={character.storyOrder} disabled={blocked || generating || archived || characterRequiresUpgrade} aria-describedby={`${perspectiveHintId}-time`} aria-invalid={Boolean(character.storyOrder) && (!Number.isSafeInteger(Number(character.storyOrder)) || Math.abs(Number(character.storyOrder)) > 1_000_000_000)} onChange={(event) => changeCharacter({ storyOrder: event.target.value })} /></label>
          <p id={`${perspectiveHintId}-time`} className={styles.note}>填写与认知记录相同尺度的整数，范围为 −10 亿至 10 亿，包含该时点。不会根据章序或日期推断。</p>
          <label className={shared.checkLabel}><input type="checkbox" checked={character.readerLimited} disabled={blocked || generating || archived || characterRequiresUpgrade} aria-describedby={`${perspectiveHintId}-reader`} onChange={(event) => changeCharacter({ readerLimited: event.target.checked })} />同时限制为读者已披露资料</label>
          <p id={`${perspectiveHintId}-reader`} className={styles.note}>开启后，还需披露章严格早于本章，且披露锚点仍在当前原稿中。人物知情与读者披露分别核验。</p>
          {characterSelection.error && <p className={styles.note}>{characterSelection.error}</p>}
          <p className={styles.note}>人物模式的创作输入只使用原文与本次要求，不发送章节目标、视角备注或章节备注；固定预览会展示实际发送内容。</p>
        </section>}
        <label>你的要求<textarea value={instruction} required maxLength={6000} rows={4} disabled={blocked || generating || archived} placeholder="写下场景目标、希望推进的变化，以及需要保持的边界。" onChange={(event) => { invalidateRecommendations(); setInstruction(event.target.value); setComposeDirty(true) }} /></label>
        {kind === 'rewrite' && <div className={styles.selection}><div className={layout.twoColumns}><label>改写首段<select value={firstBlock} disabled={blocked || generating || archived} onChange={(event) => { invalidateRecommendations(); setFirstBlock(event.target.value); if (!lastBlock) setLastBlock(event.target.value); setComposeDirty(true) }}><option value="">选择首段</option>{blocks.map((block) => <option key={block.id} value={block.id}>{block.label}</option>)}</select></label><label>改写末段<select value={lastBlock} disabled={blocked || generating || archived} onChange={(event) => { invalidateRecommendations(); setLastBlock(event.target.value); setComposeDirty(true) }}><option value="">选择末段</option>{blocks.map((block) => <option key={block.id} value={block.id}>{block.label}</option>)}</select></label></div><p className={styles.note}>{selection.error ?? `已选择 ${selection.ids.length} 个连续段落；范围不能跨过分场线。`}</p></div>}
        {!memoryTask && <details className={styles.memory}>
          <summary>推荐资料 · 按当前创作任务选择</summary>
          <p className={styles.note}>根据本次要求、固定正文与资料范围查找本地候选，无需配置模型连接。勾选后与手工检索共用 {selectedMemory.length} / 12 个资料名额，再保存发送预览核对实际内容。</p>
          {(recommendation || recommendationVectorRunId) && <>
            <label>复用已有的成功向量检索<select value={recommendationVectorRunId} disabled={blocked || generating || archived} onChange={(event) => chooseRecommendationVector(event.target.value)}>
              <option value="">不复用历史查询（默认）</option>
              {recommendationVectorRunId && !selectedRecommendationVector && <option value={recommendationVectorRunId}>此前选择的历史检索（已不在当前列表）</option>}
              {recommendationVectorRuns?.items.map((item) => <option key={item.id} value={item.id}>{item.query} · {item.connectionName} / {item.embeddingModel} · {displayTime(item.updatedAt)}</option>)}
            </select></label>
            <p className={styles.note}>选择后点击“重新推荐”才会合并历史候选。复用的是旧查询的有限结果，当前要求不会重新计算向量；资料资格仍按当前范围核对。</p>
            {selectedRecommendationVector && <p className={styles.note}>已选历史查询：“{selectedRecommendationVector.query}” · {selectedRecommendationVector.hitCount} 个已有候选{selectedRecommendationVector.truncated ? ' · 原结果已截断' : ''}。{selectedRecommendationVector.connectionName} / {selectedRecommendationVector.embeddingModel} · {displayTime(selectedRecommendationVector.updatedAt)}</p>}
            {recommendationVectorRunId && !selectedRecommendationVector && <p className={styles.note}>保留此前选择的历史检索，重新推荐时核对它是否仍属当前发布批次；也可选择“不复用历史查询”取消。</p>}
            {recommendationVectorRuns ? <p className={styles.note}>当前批次最近 {recommendationVectorRuns.items.length} 条成功查询，最多列出 6 条{recommendationVectorRuns.truncated ? '；更早记录未列出' : ''}。{!recommendationVectorRuns.items.length ? '暂无可复用记录，可直接使用本地词语推荐。' : ''}</p> : <p className={styles.note}>作品或章节版本已变化，重新推荐后刷新历史查询列表。</p>}
          </>}
          <div className={styles.actions}><button className={shared.button} type="button" disabled={blocked || generating || archived || !recommendationInput} onClick={() => void readRecommendations()}>{recommending ? '正在推荐…' : recommendation ? '重新推荐' : '推荐资料'}</button><span className={styles.note}>读取候选，不发起模型请求，不自动选入资料。</span></div>
          {!recommendationInput && <p className={styles.note}>请先填写本次要求，并完成任务所需的段落或人物范围选择。</p>}
          {recommending && <p className={styles.note} role="status">正在按当前要求读取与核对候选…</p>}
          {recommendation && !currentRecommendation && !recommending && <p className={styles.note} role="status">原推荐已停用。请按当前要求、上下文、段落、视角与版本重新推荐；已选片段仍保留。</p>}
          {currentRecommendation && <>
            <p className={styles.note} role="status">已核对 {currentRecommendation.scannedCandidates} 个候选，排除 {currentRecommendation.excludedCandidates} 个不符合当前来源或视角条件的候选，展示 {currentRecommendation.items.length} 个。最多 {AI_RECOMMENDATION_QUERY_LIMIT} 路查询、核对 {AI_RECOMMENDATION_CANDIDATE_LIMIT} 个、展示 {AI_RECOMMENDATION_RESULT_LIMIT} 个；发布批次 {currentRecommendation.publicationVersion}。</p>
            {currentRecommendation.truncated && <p className={styles.note}>部分候选因检索、数量或每来源片段上限未展示。此列表不代表全部相关资料，可补充手工检索。</p>}
            {currentRecommendation.queries.length > 0 && <details className={styles.sources}><summary>查看检索词与来源（{currentRecommendation.queries.length} 路）</summary><ol className={styles.note}>{currentRecommendation.queries.map((query, index) => <li key={index}>{recommendationQueryLabels[query.source]}：{query.text || '所选人物的关联认知'}</li>)}</ol></details>}
            {currentRecommendation.warnings.length > 0 && <ul className={shared.warningList}>{currentRecommendation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            {currentRecommendation.items.length ? <ul className={styles.memoryResults}>{currentRecommendation.items.map((hit) => {
              const reason = unusableMemory(hit, perspective)
              const selected = selectedMemory.some((item) => item.chunkId === hit.chunkId)
              return <li key={hit.chunkId}><label className={shared.checkLabel}>
                <input type="checkbox" checked={selected} disabled={blocked || generating || archived || (!selected && (Boolean(reason) || selectedMemory.length >= 12))} onChange={() => toggleMemory(hit, 'recommendation')} />
                <span><strong>{hit.title}</strong><small>{natureLabels[hit.nature]} · {sourceLabels[hit.sourceKind]}{reason ? ` · ${reason}` : hit.sourceKind === 'chapter' ? ' · 未判断冲突的原文陈述' : ''}</small></span>
              </label><blockquote>{hit.excerpt}</blockquote>
                <p className={styles.note}>命中原因：{hit.queryIndexes.map((index) => { const query = currentRecommendation.queries[index]!; return `${recommendationQueryLabels[query.source]}「${query.text || '所选人物的关联认知'}」` }).concat(hit.vectorRunId ? ['复用所选历史查询候选'] : []).join('；')}{hit.reasons.length ? `。检索方式：${hit.reasons.map((reason) => memoryReasonLabels[reason]).join('、')}` : ''}</p>
              </li>
            })}</ul> : <p className={styles.note}>本次没有符合条件的候选，可补充具体要求或使用手工检索；这不代表本书没有相关资料。</p>}
          </>}
        </details>}
        {(!memoryTask || characterMode) && <details className={styles.memory}><summary>选择本书资料 · {selectedMemory.length} / 12 个片段</summary><p className={styles.note}>{characterMode ? '仅检索所选人物关联、性质为人物认知的故事片段；资料须由作者采纳、来源当前，冲突已明确或已解释。准备预览时再核验认知主体、形成时间与修订。切换范围保留已选片段，不适用的选择需手动移除。' : '知识与故事资料须由作者采纳、来源当前，且冲突明确。正文摘录可作为未判断冲突的叙述证据；原文存在不代表陈述真实。人物认知、未来计划与 AI 推断保持各自性质。'}</p><form className={styles.search} onSubmit={(event) => void searchMemory(event)}><label>查找资料<input value={memoryQuery} maxLength={200} disabled={blocked || generating} onChange={(event) => setMemoryQuery(event.target.value)} placeholder={characterMode ? '留空浏览所选人物的关联认知，或输入关键词' : '人物、地点、事件或原文词语'} /></label><button className={shared.button} type="submit" disabled={blocked || generating || (!characterMode && !memoryQuery.trim()) || (characterMode && (!characterSelection.scope || characterRequiresUpgrade))}>检索</button></form>
          {selectedMemory.length > 0 && <ul className={styles.selectedMemory}>{selectedMemory.map((hit) => <li key={hit.chunkId}><span>{hit.title} · {natureLabels[hit.nature]}{characterMode && memorySelectionReason(hit) ? ` · ${memorySelectionReason(hit)}` : ''}</span><button className={shared.textButton} type="button" disabled={blocked || generating} onClick={() => toggleMemory(hit)}>移除</button></li>)}</ul>}
          {memoryPage && memoryPageScope === perspectiveKey(perspective, character) && <><p className={styles.note}>{memoryPage.hits.length} 个片段{memoryPage.truncated ? '；还有更多候选，请缩小范围' : ''} · 发布批次 {memoryPage.publicationVersion}</p><ul className={styles.memoryResults}>{memoryPage.hits.map((hit) => { const reason = unusableMemory(hit, perspective); const selected = selectedMemory.some((item) => item.chunkId === hit.chunkId); return <li key={hit.chunkId}><label className={shared.checkLabel}><input type="checkbox" checked={selected} disabled={blocked || generating || (!selected && (Boolean(reason) || selectedMemory.length >= 12))} onChange={() => toggleMemory(hit)} /><span><strong>{hit.title}</strong><small>{natureLabels[hit.nature]} · {sourceLabels[hit.sourceKind]}{reason ? ` · ${reason}` : hit.sourceKind === 'chapter' ? ' · 未判断冲突的原文陈述' : ''}</small></span></label><blockquote>{hit.excerpt}</blockquote></li> })}</ul></>}
        </details>}
        {(!memoryTask || characterMode) && ((knowledge && knowledge.schemaVersion >= 9) || selectedSummaries.length > 0) && <details className={styles.memory}>
          <summary>选择已采用的前文摘要 · {selectedSummaries.length} / {AI_CONTEXT_SUMMARY_LIMIT} 份</summary>
          {perspective !== 'author' && <p id={`${perspectiveHintId}-summaries`} className={styles.note}>{characterMode ? '完整前文摘要没有逐条人物认知和获知时间证明，人物模式禁用摘要。' : '完整摘要未逐条核对读者披露位置，不能加入读者已披露资料范围。'}摘要勾选已禁用；已有选择会保留，请用“移除摘要”逐一移除后再准备。</p>}
          <p className={styles.note}>只列出覆盖范围完整结束在当前章之前的已采用节点。摘要是作者采用的 AI 整理结果，可能压缩细节或包含推断；选择后会在实际发送预览中完整展示。覆盖重复章节的摘要不能同时选择。</p>
          <div className={styles.actions}><button className={shared.button} type="button" disabled={blocked || generating || archived || perspective !== 'author'} onClick={() => void readSummaries()}>读取最新摘要</button>
            {summaryPage?.nextAfter && <button className={shared.button} type="button" disabled={blocked || generating || archived || perspective !== 'author'} onClick={() => void readSummaries(summaryPage.nextAfter!)}>下一页摘要</button>}</div>
          {selectedSummaries.length > 0 && <><ul className={styles.selectedMemory}>{selectedSummaries.map((item) => <li key={item.nodeId}>
            <span>{item.scopeTitle} · {item.firstChapter.title} → {item.lastChapter.title} · {item.coveredChapters} 章</span>
            <button className={shared.textButton} type="button" disabled={blocked || generating || archived} onClick={() => toggleSummary(item)}>移除摘要</button>
          </li>)}</ul><details className={styles.sources}><summary>查看已选摘要全文</summary><SummarySources items={selectedSummaries} /></details></>}
          {summaryPage ? <>
            <p className={styles.note}>本页检查 {summaryPage.scannedNodes} 个节点，显示 {summaryPage.items.length} 份可选摘要。</p>
            {summaryPage.items.length ? <ul className={styles.memoryResults}>{summaryPage.items.map((item) => {
              const selected = selectedSummaries.some((entry) => entry.nodeId === item.nodeId)
              const overlap = !selected && overlappingSummary(item, selectedSummaries)
              return <li key={`${item.taskId}:${item.nodeId}`}><label className={shared.checkLabel}>
                <input type="checkbox" checked={selected} aria-describedby={perspective !== 'author' ? `${perspectiveHintId}-summaries` : undefined} disabled={blocked || generating || archived || perspective !== 'author' || (!selected && (overlap || selectedSummaries.length >= AI_CONTEXT_SUMMARY_LIMIT))} onChange={() => toggleSummary(item)} />
                <span><strong>{item.scopeTitle} · {item.title}</strong><small>{item.coveredChapters} 章 · {item.firstChapter.title} → {item.lastChapter.title}{overlap ? ' · 与已选摘要范围重复' : ''}</small></span>
              </label><blockquote>{item.text}</blockquote></li>
            })}</ul> : <p className={styles.note}>{summaryPage.nextAfter ? '本页没有符合条件的摘要，可继续读取下一页。' : '本页没有可用摘要，且已到记录末尾。可先在分层汇总中生成并采用前文摘要，再重新读取。'}</p>}
          </> : <p className={styles.note}>读取后按页显示来源仍为当前、作者已采用的前文摘要；每页最多 20 个节点。</p>}
        </details>}
        {memoryTask && !characterMode && <p className={styles.note}>整理只读取完整本章已保存原稿，超出预算会拒绝。不会将章节目标、备注或额外资料中的计划混入正文证据；每条结果需要匹配本次固定段落的逐字引文。{memoryRequiresUpgrade ? ' 请先备份并启用 v7 章节整理。' : ''}</p>}
        {configDirty && <p className={styles.note}>连接配置尚未保存，请先保存或放弃连接修改。</p>}
        {summaryBlocked && <p className={shared.formError} role="alert">已选 {selectedSummaries.length} 份完整前文摘要，请先在摘要选择中移除全部摘要，才能准备{characterMode ? '人物' : '读者已披露资料'}预览。</p>}
        {characterTaskBlocked && <p className={shared.formError} role="alert">人物模式不支持当前的“{taskLabels[kind]}”任务。已保留任务和资料选择，请明确更换为规划、续写或改写，或切回作者资料范围。</p>}
        {characterMemoryBlocked && <p className={shared.formError} role="alert">已选片段包含不符合当前人物范围的选择。请展开“选择本书资料”逐一移除，再按当前人物和时点重新检索选择。</p>}
        <div className={styles.actions}><button className={shared.primaryButton} type="button" disabled={blocked || generating || archived || configDirty || !selectedConnection || !instruction.trim() || Boolean(selection.error) || memoryRequiresUpgrade || summaryBlocked || characterTaskBlocked || characterMemoryBlocked || (characterMode && (!characterSelection.scope || characterRequiresUpgrade))} onClick={() => void prepare()}>保存并预览发送内容</button><span className={styles.note}>这一步只在本地保存，不发起模型调用。</span></div>
      </section>
      {run && <section className={styles.run} aria-label="当前提议"><div className={styles.heading}><h3>{run.context.purpose === 'review' ? '审稿' : taskLabels[run.kind]} · {stateLabels[run.state]}</h3><span>{run.chapterTitle} · {displayTime(run.updatedAt)}</span></div>{!taskCurrent && <p className={styles.note}>这是其他章节的记录。回到对应章节后才能发送或采用。</p>}{run.error && <p className={shared.formError}>{run.error}</p>}<ContextPreview context={run.context} />
        {run.state === 'prepared' && <><p className={styles.note}>{composeDirty || configDirty || !runScopeMatches ? '要求、人物范围或配置已有修改，请保存新的预览后再发送。' : '确认上面的接口、模型与实际内容后，再发送这份固定预览。'}</p><button className={shared.primaryButton} type="button" disabled={blocked || archived || !taskCurrent || composeDirty || configDirty || !runScopeMatches || characterRequiresUpgrade || characterTaskBlocked || summaryBlocked || characterMemoryBlocked} onClick={() => void sendRun()}>确认发送并开始生成</button></>}
        {run.state !== 'prepared' && (isAiMemoryTask(run.kind)
          ? <AiMemoryReview api={api} run={run} drafts={memoryDrafts} disabled={blocked || archived || !taskCurrent} onChange={(value) => { setMemoryDrafts(value); setOutputDirty(true) }} onAdopt={() => void adoptMemory()} />
          : <OutputReview run={run} text={acceptedText} disabled={blocked || archived} onChange={(value) => { setAcceptedText(value); setOutputDirty(value !== (run.acceptedText ?? run.outputText)) }} />)}
        {run.state === 'running' && <div className={styles.actions}>{run.active === false ? <><p className={styles.note}>本次记录仍显示生成中，但桌面进程已无活动请求。已停止自动查询；不会重发。核对后可明确标记中断并保留输出。</p><button className={shared.button} type="button" disabled={blocked} onClick={() => void interruptRun()}>标记中断并保留输出</button></> : <button className={shared.button} type="button" disabled={blocked} onClick={() => void stopRun()}>取消生成并保留输出</button>}{pollStopped && <button className={shared.button} type="button" disabled={blocked} onClick={() => setRequestedRunId(run.id)}>重新读取生成状态</button>}</div>}
        {run.state === 'succeeded' && run.context.purpose === 'review' && <><p className={styles.note}>请在审稿问题中逐项确认理由、引文和建议，并关联这次候选及固定原稿。候选编号：{run.id}</p>{onRegisterReview && <button className={shared.primaryButton} type="button" disabled={blocked || archived || !taskCurrent || edited} onClick={() => onRegisterReview(run)}>登记审稿问题</button>}</>}
        {run.state === 'succeeded' && run.context.purpose !== 'review' && !isAiMemoryTask(run.kind) && <><p className={styles.note}>{run.kind === 'plan' ? '采用后将规划追加至本章备注。' : run.kind === 'continue' ? '采用后将新稿追加至本章末尾，并保留原稿历史。' : '采用后将替换预览中选定的连续段落，并保留原稿历史。'}{outputDirty ? ' 当前改稿尚未保存；采用时会一并记录。' : ''}</p><div className={styles.actions}><button className={shared.primaryButton} type="button" disabled={blocked || archived || !taskCurrent || !acceptedText.trim()} onClick={() => void adopt()}>{run.kind === 'plan' ? '采用为章节备注' : run.kind === 'continue' ? '采用并追加至章尾' : '采用并替换所选段落'}</button>{outputDirty && <button className={shared.button} type="button" disabled={blocked} onClick={() => setDiscard({ label: '放弃尚未采用的输出修改，恢复模型原提议？', proceed: () => { setAcceptedText(run.outputText); setOutputDirty(false) } })}>放弃改稿</button>}</div></>}
        {!['running', 'adopted', 'rejected'].includes(run.state) && <button className={`${shared.textButton} ${styles.reject}`} type="button" disabled={blocked || archived} onClick={() => {
          const target = { bookId: run.bookId, runId: run.id, expectedVersion: run.version }
          setDiscard({ label: '拒绝这次提议并放弃尚未采用的输出修改？输入、原输出和拒绝记录都会保留。', proceed: () => void rejectRun(target) })
        }}>作者拒绝这次提议</button>}
      </section>}
      <details className={styles.history}><summary>本书提议记录 · 每页最多 30 条</summary><div className={styles.actions}><button className={shared.button} type="button" disabled={blocked || generating} onClick={() => void historyPage()}>最新记录</button>{history?.nextBefore && <button className={shared.button} type="button" disabled={blocked || generating} onClick={() => void historyPage(history.nextBefore!)}>更早记录</button>}{before && <span className={styles.note}>正在查看历史分页</span>}</div>{history?.runs.length ? <ul>{history.runs.map((item) => <li key={item.id}><button className={styles.historyItem} type="button" disabled={blocked || generating} aria-current={run?.id === item.id ? 'true' : undefined} onClick={() => openHistory(item)}><span><strong>{item.chapterTitle} · {item.purpose === 'review' ? '审稿' : taskLabels[item.kind]}</strong><small>{item.connectionName} · {item.model} · {displayTime(item.createdAt)}</small></span><span>{stateLabels[item.state]}<small>{item.outputCharacters.toLocaleString()} 字符</small></span></button></li>)}</ul> : <p className={styles.note}>保存一次发送预览后，这里会留下输入、输出和作者决定。</p>}</details>
      {archived && <p className={styles.note}>作品已归档，可查看已有记录；解除归档后再配置、生成或采用。</p>}
    </>}
    {discard && <section className={styles.discard} role="alert"><p>{discard.label}</p><div className={styles.actions}><button className={shared.button} type="button" disabled={blocked} onClick={() => setDiscard(null)}>继续保留</button><button className={shared.button} type="button" disabled={blocked} onClick={() => { const action = discard.proceed; setDiscard(null); action() }}>确认放弃并继续</button></div></section>}
    <div className={styles.footer}><button className={shared.button} type="button" disabled={blocked} onClick={close}>{edited ? '关闭并处理未保存内容' : '关闭'}</button></div>
  </Dialog>
}
