import { DomainError, isRecord, requiredId, requiredInteger, requiredText, type BookSnapshot, type Result } from './api'
import { parseAiConnectionConfig, type AiConnection, type AiConnectionConfig, type AiUsage } from './ai'
import { parseCharacterProfile, type CharacterProfile } from './character-profile'

export const GENERATION_PROMPT_VERSION = 1
export const GENERATION_OUTPUT_LIMIT = 60_000
export const GENERATION_PARTS = ['all', 'titles', 'cast', 'rules', 'outline'] as const
export type GenerationPart = typeof GENERATION_PARTS[number]
export type GenerationState = 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface StudioAiConnection extends AiConnection { isDefault: boolean }
export interface StudioAiConnections { connections: StudioAiConnection[]; sessionKeyIds: string[] }
export interface StudioAiConnectionInput { connection: AiConnectionConfig; expectedVersion: number | null; isDefault: boolean; apiKey?: string }
export interface KickstartSeed { idea: string; genre: string; template: 'adaptive' | 'adventure' | 'mystery' | 'relationships'; scale: 'short' | 'medium' | 'long' }
export interface GenerationCandidate<T> { candidateId: string; status: 'pending' | 'adopted' | 'discarded'; value: T }
export interface KickstartTitle { title: string; angle: string }
export interface KickstartCharacter { slot: string; name: string; summary: string; profile: CharacterProfile }
export interface KickstartRule { name: string; summary: string }
export interface OutlineBeat { id: string; title: string; action: string; outcome: string }
export interface KickstartChapter { title: string; goal: string; conflict: string; hook: string; tension: number | null; beats: OutlineBeat[]; castSlots: string[] }
export interface KickstartOutline {
  acts: { title: string; summary: string }[]
  volume: { title: string; goal: string; conflict: string; climax: string }
  chapters: KickstartChapter[]
}
export interface KickstartProposal {
  logline: string; synopsis: string
  titles: GenerationCandidate<KickstartTitle>[]
  cast: GenerationCandidate<KickstartCharacter>[]
  rules: GenerationCandidate<KickstartRule>[]
  outline: GenerationCandidate<KickstartOutline>
}
export interface GenerationRun {
  id: string; bookId: string; part: GenerationPart; parentRunId: string | null
  state: GenerationState; version: number; seed: KickstartSeed; connection: AiConnection
  promptVersion: number; messages: { role: 'system' | 'user'; content: string }[]
  contextHash: string; estimatedInputTokens: number; selectedIds: string[]
  proposal: KickstartProposal | null; outputText: string; usage: AiUsage | null
  bookRevision: number; knowledgeRevision: number; error: string | null; createdAt: string; updatedAt: string
}
export interface GenerationRef { candidateId: string; entityId: string; resultingRevisionId: string | null; kind: 'book' | 'knowledge' | 'outline' }
export interface GenerationAdoption { id: string; runId: string; firstChapterId: string; refs: GenerationRef[]; createdAt: string }
export interface KickstartSnapshot {
  book: BookSnapshot; seed: KickstartSeed; run: GenerationRun | null; adoption: GenerationAdoption | null
  history: Pick<GenerationRun, 'id' | 'part' | 'state' | 'createdAt'>[]
  recoveryWarning?: string
}
export interface KickstartDraftInput { bookId: string; seed: KickstartSeed; expectedBookRevision?: number }
export interface GenerationReadInput { bookId: string; runId?: string }
export interface GenerationPrepareInput extends KickstartDraftInput {
  runId: string; connectionId: string; expectedBookRevision: number; part: GenerationPart; parentRunId?: string
}
export interface GenerationVersionInput { bookId: string; runId: string; expectedVersion: number }
export interface GenerationStartInput extends GenerationVersionInput { contextHash: string }
export interface GenerationSelectionInput extends GenerationVersionInput { selectedIds: string[] }
export interface GenerationAdoptInput extends GenerationVersionInput { expectedBookRevision: number; expectedKnowledgeRevision: number }
export interface GenerationCheckpointInput extends GenerationVersionInput { outputText: string }
export interface GenerationFinishInput extends GenerationCheckpointInput { state: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; usage: AiUsage | null; error: string | null }
export interface GenerationApi {
  listStudioAiConnections(): Promise<Result<StudioAiConnections>>
  configureStudioAiConnection(input: StudioAiConnectionInput): Promise<Result<StudioAiConnection>>
  createKickstartDraft(input: KickstartDraftInput): Promise<Result<KickstartSnapshot>>
  getKickstart(input: GenerationReadInput): Promise<Result<KickstartSnapshot>>
  prepareGeneration(input: GenerationPrepareInput): Promise<Result<GenerationRun>>
  startGeneration(input: GenerationStartInput): Promise<Result<GenerationRun>>
  cancelGeneration(input: GenerationVersionInput): Promise<Result<GenerationRun>>
  selectGenerationCandidates(input: GenerationSelectionInput): Promise<Result<GenerationRun>>
  adoptGeneration(input: GenerationAdoptInput): Promise<Result<KickstartSnapshot>>
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('开书数据格式无效或含不支持的字段。')
  return value
}
function text(value: unknown, label: string, maximum = 2000): string {
  const result = requiredText(value, label, maximum)
  if (result.includes('\0')) invalid(`${label}不能包含空字符。`)
  return result
}
function list<T>(value: unknown, minimum: number, maximum: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(`候选列表须含 ${minimum} 至 ${maximum} 项。`)
  return value.map(parse)
}
export function parseKickstartSeed(value: unknown): KickstartSeed {
  const v = object(value, ['idea', 'genre', 'template', 'scale'])
  if (!['adaptive', 'adventure', 'mystery', 'relationships'].includes(String(v.template)) || !['short', 'medium', 'long'].includes(String(v.scale))) invalid('请选择有效的结构模板与篇幅。')
  return { idea: text(v.idea, '一句话脑洞', 2000), genre: text(v.genre, '题材', 80), template: v.template as KickstartSeed['template'], scale: v.scale as KickstartSeed['scale'] }
}
export function parseStudioAiConnectionInput(value: unknown): StudioAiConnectionInput {
  const v = object(value, ['connection', 'expectedVersion', 'isDefault', 'apiKey'])
  if (typeof v.isDefault !== 'boolean') invalid('默认连接标记无效。')
  if (v.apiKey !== undefined && (typeof v.apiKey !== 'string' || v.apiKey.length > 8192 || /[\r\n\0]/.test(v.apiKey))) invalid('会话密钥格式无效。')
  return { connection: parseAiConnectionConfig(v.connection), expectedVersion: v.expectedVersion === null ? null : requiredInteger(v.expectedVersion, '连接版本'), isDefault: v.isDefault,
    ...(typeof v.apiKey === 'string' ? { apiKey: v.apiKey.trim() } : {}) }
}
export function parseKickstartDraftInput(value: unknown): KickstartDraftInput {
  const v = object(value, ['bookId', 'seed', 'expectedBookRevision'])
  return { bookId: requiredId(v.bookId).toLowerCase(), seed: parseKickstartSeed(v.seed),
    ...(v.expectedBookRevision === undefined ? {} : { expectedBookRevision: requiredInteger(v.expectedBookRevision, '草稿作品版本') }) }
}
export function parseGenerationReadInput(value: unknown): GenerationReadInput {
  const v = object(value, ['bookId', 'runId'])
  return { bookId: requiredId(v.bookId).toLowerCase(), ...(v.runId === undefined ? {} : { runId: requiredId(v.runId).toLowerCase() }) }
}
export function parseGenerationPrepareInput(value: unknown): GenerationPrepareInput {
  const v = object(value, ['bookId', 'seed', 'runId', 'connectionId', 'expectedBookRevision', 'part', 'parentRunId'])
  if (!GENERATION_PARTS.includes(v.part as GenerationPart) || (v.part !== 'all' && v.parentRunId === undefined)) invalid('分区生成必须绑定原提案。')
  return { ...parseKickstartDraftInput({ bookId: v.bookId, seed: v.seed }), runId: requiredId(v.runId).toLowerCase(), connectionId: requiredId(v.connectionId).toLowerCase(),
    expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本'), part: v.part as GenerationPart,
    ...(v.parentRunId === undefined ? {} : { parentRunId: requiredId(v.parentRunId).toLowerCase() }) }
}
export function parseGenerationVersionInput(value: unknown): GenerationVersionInput {
  const v = object(value, ['bookId', 'runId', 'expectedVersion'])
  return { bookId: requiredId(v.bookId).toLowerCase(), runId: requiredId(v.runId).toLowerCase(), expectedVersion: requiredInteger(v.expectedVersion, '提案版本') }
}
function versionFields(v: Record<string, unknown>): GenerationVersionInput { return parseGenerationVersionInput({ bookId: v.bookId, runId: v.runId, expectedVersion: v.expectedVersion }) }
export function parseGenerationStartInput(value: unknown): GenerationStartInput {
  const v = object(value, ['bookId', 'runId', 'expectedVersion', 'contextHash'])
  if (typeof v.contextHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.contextHash)) invalid('输入指纹无效。')
  return { ...versionFields(v), contextHash: v.contextHash }
}
export function parseGenerationSelectionInput(value: unknown): GenerationSelectionInput {
  const v = object(value, ['bookId', 'runId', 'expectedVersion', 'selectedIds'])
  const selectedIds = list(v.selectedIds, 1, 40, (id) => requiredId(id).toLowerCase())
  if (new Set(selectedIds).size !== selectedIds.length) invalid('不能重复选用同一候选。')
  return { ...versionFields(v), selectedIds }
}
export function parseGenerationAdoptInput(value: unknown): GenerationAdoptInput {
  const v = object(value, ['bookId', 'runId', 'expectedVersion', 'expectedBookRevision', 'expectedKnowledgeRevision'])
  return { ...versionFields(v), expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本'), expectedKnowledgeRevision: requiredInteger(v.expectedKnowledgeRevision, '知识版本') }
}
export function parseGenerationCheckpointInput(value: unknown): GenerationCheckpointInput {
  const v = object(value, ['bookId', 'runId', 'expectedVersion', 'outputText'])
  if (typeof v.outputText !== 'string' || v.outputText.length > GENERATION_OUTPUT_LIMIT || v.outputText.includes('\0')) invalid('模型输出超过限制或含无效字符。')
  return { ...versionFields(v), outputText: v.outputText }
}
export function parseGenerationFinishInput(value: unknown): GenerationFinishInput {
  const v = object(value, ['bookId', 'runId', 'expectedVersion', 'outputText', 'state', 'usage', 'error'])
  if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(v.state))) invalid('生成结束状态无效。')
  let usage: AiUsage | null = null
  if (v.usage !== null) {
    const u = object(v.usage, ['inputTokens', 'outputTokens', 'totalTokens'])
    const count = (n: unknown) => n === null ? null : requiredInteger(n, '实际用量')
    usage = { inputTokens: count(u.inputTokens), outputTokens: count(u.outputTokens), totalTokens: count(u.totalTokens) }
  }
  return { ...parseGenerationCheckpointInput({ ...versionFields(v), outputText: v.outputText }), state: v.state as GenerationFinishInput['state'], usage,
    error: v.error === null ? null : text(v.error, '生成错误', 500) }
}

/** 模型只提供业务字段；候选和段落身份由本地分配，分区更新保留其余候选身份。 */
export function parseGeneratedKickstart(output: string, part: GenerationPart, base: KickstartProposal | null, nextId: () => string): KickstartProposal {
  if (output.length > GENERATION_OUTPUT_LIMIT) invalid('开书输出超过上限。')
  let raw: unknown
  try { raw = JSON.parse(output) } catch { return invalid('模型输出须是完整 JSON 对象；原文已保留，可重新生成。') }
  const keys = part === 'all' ? ['titles', 'logline', 'synopsis', 'cast', 'rules', 'outline'] : [part]
  const v = object(raw, keys)
  if (part !== 'all' && !base) invalid('未找到分区生成所依据的原提案。')
  const candidate = <T>(value: T): GenerationCandidate<T> => ({ candidateId: nextId(), status: 'pending', value })
  const titles = part === 'all' || part === 'titles' ? list(v.titles, 1, 6, (entry) => {
    const item = object(entry, ['title', 'angle'])
    return candidate({ title: text(item.title, '书名', 120), angle: text(item.angle, '书名角度', 200) })
  }) : base!.titles
  const cast = part === 'all' || part === 'cast' ? list(v.cast, 1, 6, (entry) => {
    const item = object(entry, ['slot', 'name', 'summary', 'profile'])
    const slot = text(item.slot, '角色职责', 40)
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(slot)) invalid('角色职责须为短英文标识。')
    return candidate({ slot, name: text(item.name, '人物姓名', 120), summary: text(item.summary, '精简人设', 1500), profile: parseCharacterProfile(item.profile) })
  }) : base!.cast
  if (new Set(cast.map((item) => item.value.slot)).size !== cast.length) invalid('角色职责不能重复。')
  if (!cast.some((item) => item.value.slot === 'protagonist')) invalid('角色班底需要包含 protagonist 主角职责。')
  if (new Set(cast.map((item) => item.value.name.toLocaleLowerCase())).size !== cast.length) invalid('人物姓名不能重复。')
  if (part === 'cast' && base && (cast.length !== base.cast.length || cast.some((item) => !base.cast.some((old) => old.value.slot === item.value.slot)))) invalid('分区重生成人物须保留原角色职责；调整角色数量请重新生成完整开书包。')
  const rules = part === 'all' || part === 'rules' ? list(v.rules, 1, 6, (entry) => {
    const item = object(entry, ['name', 'summary'])
    return candidate({ name: text(item.name, '规则名称', 120), summary: text(item.summary, '世界规则', 2000) })
  }) : base!.rules
  let outline = base?.outline
  if (part === 'all' || part === 'outline') {
    const o = object(v.outline, ['acts', 'volume', 'chapters'])
    const volume = object(o.volume, ['title', 'goal', 'conflict', 'climax'])
    outline = candidate({
      acts: list(o.acts, 2, 6, (entry) => { const act = object(entry, ['title', 'summary']); return { title: text(act.title, '总纲阶段', 120), summary: text(act.summary, '阶段摘要', 2000) } }),
      volume: { title: text(volume.title, '首卷标题', 120), goal: text(volume.goal, '卷目标'), conflict: text(volume.conflict, '卷冲突'), climax: text(volume.climax, '卷高潮') },
      chapters: list(o.chapters, 1, 6, (entry) => {
        const c = object(entry, ['title', 'goal', 'conflict', 'hook', 'tension', 'beats', 'castSlots'])
        const tension = c.tension === undefined || c.tension === null ? null : requiredInteger(c.tension, '紧张度')
        if (tension !== null && tension > 100) invalid('紧张度不能超过 100。')
        const castSlots = list(c.castSlots, 0, 6, (slot) => text(slot, '章纲人物职责', 40))
        if (new Set(castSlots).size !== castSlots.length) invalid('章纲不能重复引用同一角色职责。')
        if (castSlots.some((slot) => !cast.some((person) => person.value.slot === slot))) invalid('章纲引用了不存在的角色职责。')
        return { title: text(c.title, '章名', 120), goal: text(c.goal, '章目标'), conflict: text(c.conflict, '章冲突'), hook: text(c.hook, '章末悬念'), tension, castSlots,
          beats: list(c.beats, 1, 6, (entry) => { const b = object(entry, ['title', 'action', 'outcome']); return { id: nextId(), title: text(b.title, '节拍标题', 120), action: text(b.action, '节拍行动'), outcome: text(b.outcome, '节拍结果') } }) }
      }),
    })
  }
  if (!outline) invalid('开书提案缺少大纲。')
  return { titles, cast, rules, outline, logline: part === 'all' ? text(v.logline, '故事核', 500) : base!.logline, synopsis: part === 'all' ? text(v.synopsis, '简介', 3000) : base!.synopsis }
}

export function proposalCandidates(proposal: KickstartProposal): GenerationCandidate<unknown>[] { return [...proposal.titles, ...proposal.cast, ...proposal.rules, proposal.outline] }

/** 恢复时仍按同一业务契约解析，额外核对本地分配的候选与节拍身份。 */
export function parseStoredKickstart(value: unknown): KickstartProposal {
  const v = object(value, ['logline', 'synopsis', 'titles', 'cast', 'rules', 'outline'])
  const identities: string[] = [], statuses = new Map<string, GenerationCandidate<unknown>['status']>()
  const identity = (value: unknown): string => {
    const id = requiredId(value).toLowerCase()
    if (value !== id || identities.includes(id)) invalid('提案候选或节拍身份无效或重复。')
    identities.push(id)
    return id
  }
  const candidate = (value: unknown): unknown => {
    const item = object(value, ['candidateId', 'status', 'value']), id = identity(item.candidateId)
    if (!['pending', 'adopted', 'discarded'].includes(String(item.status))) invalid('候选状态无效。')
    statuses.set(id, item.status as GenerationCandidate<unknown>['status'])
    return item.value
  }
  const titles = list(v.titles, 1, 6, candidate), cast = list(v.cast, 1, 6, candidate), rules = list(v.rules, 1, 6, candidate)
  const wrapper = object(v.outline, ['candidateId', 'status', 'value'])
  const outline = object(wrapper.value, ['acts', 'volume', 'chapters'])
  const chapters = list(outline.chapters, 1, 6, (value) => {
    const chapter = object(value, ['title', 'goal', 'conflict', 'hook', 'tension', 'beats', 'castSlots'])
    return { ...chapter, beats: list(chapter.beats, 1, 6, (value) => {
      const beat = object(value, ['id', 'title', 'action', 'outcome'])
      identity(beat.id)
      return { title: beat.title, action: beat.action, outcome: beat.outcome }
    }) }
  })
  candidate(wrapper)
  let offset = 0
  const proposal = parseGeneratedKickstart(JSON.stringify({ titles, cast, rules, logline: v.logline, synopsis: v.synopsis, outline: { ...outline, chapters } }), 'all', null, () => identities[offset++]!)
  for (const entry of proposalCandidates(proposal)) entry.status = statuses.get(entry.candidateId)!
  return proposal
}
