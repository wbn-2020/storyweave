import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, type BookInput, type BookMutationInput, type ChapterSnapshot } from './api'
import { isStudyCardKind, readStudyCard } from './study-card'
import { parseReviewCandidateSource, type ReviewCandidateSource } from './review'
import { parseNoteChapterIds } from './notes'
import { parseNoteThumbnailFields, type NoteThumbnailFields } from './note-thumbnail'
import type { InspirationThumbnailMetadata } from './inspiration-thumbnail'

export const WORKBENCH_SCHEMA_VERSION = 13
export const MAX_SCENES = 2_000
export const MAX_REVIEW_ISSUES = 2_000
// 字节预算按序列化后的 UTF-8 计算；保存与完整快照读取使用相同限制。
export const MAX_WORKBENCH_FIELDS_BYTES = 256 * 1024
export const MAX_WORKBENCH_SNAPSHOT_BYTES = 16 * 1024 * 1024
export const MAX_WORKBENCH_DOCUMENT_BYTES = 32 * 1024 * 1024
export const MAX_WORKBENCH_ANCHOR_BYTES = 64 * 1024 * 1024
export interface WritingBrief { premise: string; style: string; narrator: string; tense: string; rules: string }
export interface ManuscriptAnchor { chapterId: string; revisionId: string; blockIds: string[] }
export interface SceneFields {
  title: string; chapterId: string | null; position: number; goal: string; conflict: string; outcome: string
  viewpoint: string; characterIds: string[]; locationId: string | null; storyTime: string; plotline: string
  status: 'planned' | 'drafted' | 'revised'; targetCharacters: number | null; anchor: ManuscriptAnchor | null; archived: boolean
}
export interface SceneCard extends SceneFields { id: string; revision: number; updatedAt: string; stale: boolean }
export const REVIEW_KINDS = ['structure', 'causality', 'cognition', 'foreshadow', 'language', 'dialogue'] as const
export const REVIEW_STATES = ['open', 'recheck', 'resolved', 'intentional', 'dismissed'] as const
export interface ReviewApplication {
  chapterId: string; sourceRevisionId: string; revisionId: string; issueRevision: number
}
export interface ReviewIssueFields {
  title: string; kind: typeof REVIEW_KINDS[number]; status: typeof REVIEW_STATES[number]
  reason: string; evidence: string; suggestion: string; resolution: string; anchor: ManuscriptAnchor
  aiRunId: string | null
  /** 分析性建议与可直接替换的正文分开；旧记录沿用 suggestion。 */
  replacement?: string
  candidateSource?: ReviewCandidateSource
  /** 仅正文应用事务生成；手工保存只能原样保留，不能补写应用事实。 */
  readonly application?: ReviewApplication
}
export interface ReviewIssue extends ReviewIssueFields {
  id: string; revision: number; updatedAt: string; stale: boolean
  readonly applicationCurrent?: boolean
  // 原始依据只从首次不可变历史读取；当前 anchor/evidence/reason 用于后续复核。
  readonly originalAnchor: Readonly<{ chapterId: string; revisionId: string; blockIds: readonly string[] }>
  readonly originalEvidence: string
  readonly originalReason: string
}
export const WRITING_METRICS = ['added', 'net', 'minutes', 'revisedChapters'] as const
export interface WritingGoalFields {
  period: 'day' | 'week'; metric: typeof WRITING_METRICS[number]; target: number; active: boolean
}
export interface WritingGoal extends WritingGoalFields { id: string; revision: number }
export interface WritingDay {
  date: string; source: 'manual' | 'ai' | 'import' | 'restore'; added: number; removed: number; net: number
  minutes: number; revisedChapters: number
}
export interface WorkbenchSnapshot {
  bookId: string; bookRevision: number; archived: boolean; schemaVersion: number; requiresUpgrade: boolean
  brief: WritingBrief; scenes: SceneCard[]; sceneLabels: Record<string, string>; issues: ReviewIssue[]; goals: WritingGoal[]; activity: WritingDay[]
}
export interface SaveBriefInput extends BookMutationInput { brief: WritingBrief }
export interface SaveSceneInput extends BookMutationInput { id: string; expectedRevision: number; fields: SceneFields }
export interface ReorderScenesInput extends BookMutationInput { chapterId: string | null; sceneIds: string[] }
export interface SaveReviewIssueInput extends BookMutationInput { id: string; expectedRevision: number; fields: ReviewIssueFields }
export interface ApplyReviewIssueInput extends BookMutationInput { id: string; expectedRevision: number; expectedRevisionId: string }
export interface ApplyReviewIssueReceipt { workbench: WorkbenchSnapshot; chapter: ChapterSnapshot }
export interface SaveWritingGoalInput extends BookMutationInput { id: string; expectedRevision: number; fields: WritingGoalFields }
export interface LogWritingSessionInput extends BookMutationInput {
  id: string; date: string; minutes: number; revisedChapterId: string | null
}
export const INSPIRATION_KINDS = ['idea', 'reference', 'observation', 'excerpt', 'technique', 'method', 'beat', 'style'] as const
export interface InspirationFields {
  kind: typeof INSPIRATION_KINDS[number]; title: string; body: string; source: string; tags: string[]
  parentId: string | null; bookId: string | null; archived: boolean
}
export interface InspirationItem extends InspirationFields {
  id: string; revision: number; createdAt: string; updatedAt: string; thumbnail: InspirationThumbnailMetadata | null
}
export interface InspirationPage { items: InspirationItem[]; total: number; nextOffset: number | null; schemaVersion: number }
export interface ListInspirationInput { search?: string; bookId?: string; offset?: number; includeArchived?: boolean }
export interface SaveInspirationInput { id: string; expectedRevision: number; fields: InspirationFields; thumbnail?: NoteThumbnailFields | null }
export interface ImportInspirationsInput { items: SaveInspirationInput[] }
export interface ImportInspirationsReceipt { items: InspirationItem[] }
export interface CopyInspirationInput extends BookMutationInput { id: string; expectedRevision: number; noteId: string; chapterIds?: string[] }

export function reviewReplacement(fields: ReviewIssueFields): string { return fields.replacement ?? fields.suggestion }

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new DomainError({ code: 'INVALID_INPUT', message: '创作工具参数无效。' })
  return value
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new DomainError({ code: 'INVALID_INPUT', message: '创作工具选项无效。' })
  return value as T
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DomainError({ code: 'INVALID_INPUT', message: '开关选项无效。' })
  return value
}
function text(value: unknown, label: string, maximum = 10_000): string {
  const result = optionalText(value, label, maximum)
  if (result.includes('\0')) throw new DomainError({ code: 'INVALID_INPUT', message: `${label}含有无效字符。` })
  return result
}
function exactText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw new DomainError({ code: 'INVALID_INPUT', message: `${label}无效或超过 ${maximum} 个字符。` })
  return value
}
function id(value: unknown): string { return requiredId(value).toLowerCase() }
function nullableId(value: unknown): string | null { return value === null ? null : id(value) }
function ids(value: unknown, maximum = 100): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new DomainError({ code: 'INVALID_INPUT', message: '关联条目数量超出范围。' })
  const result = value.map(id)
  if (new Set(result).size !== result.length) throw new DomainError({ code: 'INVALID_INPUT', message: '关联条目不能重复。' })
  return result
}
export function parseWorkbenchBookInput(value: unknown): BookInput { const v = object(value); return { bookId: id(v.bookId) } }
function mutation(value: unknown): BookMutationInput {
  const v = object(value)
  return { ...parseWorkbenchBookInput(v), expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本') }
}
function identity(value: Record<string, unknown>): { id: string; expectedRevision: number } {
  return { id: id(value.id), expectedRevision: requiredInteger(value.expectedRevision, '条目版本') }
}
export function parseWritingBrief(value: unknown): WritingBrief {
  const v = object(value)
  return { premise: text(v.premise, '故事前提', 5_000), style: text(v.style, '风格约定', 5_000),
    narrator: text(v.narrator, '叙述人称', 500), tense: text(v.tense, '叙述时态', 500), rules: text(v.rules, '创作规则', 10_000) }
}
export function parseManuscriptAnchor(value: unknown): ManuscriptAnchor {
  const v = object(value)
  return { chapterId: id(v.chapterId), revisionId: id(v.revisionId), blockIds: ids(v.blockIds, 500) }
}
export function parseSceneFields(value: unknown): SceneFields {
  const v = object(value)
  const chapterId = nullableId(v.chapterId)
  const anchor = v.anchor === null ? null : parseManuscriptAnchor(v.anchor)
  if (anchor && anchor.chapterId !== chapterId) throw new DomainError({ code: 'INVALID_INPUT', message: '场景正文证据必须属于所选章节。' })
  return { title: requiredText(v.title, '场景名称', 120), chapterId, position: requiredInteger(v.position, '计划位置', 100_000),
    goal: text(v.goal, '场景目标'), conflict: text(v.conflict, '场景冲突'), outcome: text(v.outcome, '结束变化'),
    viewpoint: text(v.viewpoint, '视角', 500), characterIds: ids(v.characterIds), locationId: nullableId(v.locationId),
    storyTime: text(v.storyTime, '故事时间', 1_000), plotline: text(v.plotline, '情节线', 500),
    status: choice(v.status, ['planned', 'drafted', 'revised']), targetCharacters: v.targetCharacters === null ? null : requiredInteger(v.targetCharacters, '计划字数', 1_000_000),
    anchor, archived: flag(v.archived) }
}
export function parseReviewIssueFields(value: unknown): ReviewIssueFields {
  const v = object(value)
  let application: ReviewApplication | undefined
  if (v.application !== undefined) {
    const saved = object(v.application)
    application = { chapterId: id(saved.chapterId), sourceRevisionId: id(saved.sourceRevisionId), revisionId: id(saved.revisionId),
      issueRevision: requiredInteger(saved.issueRevision, '应用时的问题版本') }
    if (application.issueRevision < 2 || application.sourceRevisionId === application.revisionId) throw new DomainError({ code: 'INVALID_INPUT', message: '审稿应用凭据无效。' })
  }
  return { title: requiredText(v.title, '问题标题', 160), kind: choice(v.kind, REVIEW_KINDS), status: choice(v.status, REVIEW_STATES),
    reason: text(v.reason, '问题理由'), evidence: v.candidateSource === undefined ? text(v.evidence, '证据') : exactText(v.evidence, '证据', 10000), suggestion: text(v.suggestion, '修改建议', 20_000),
    resolution: text(v.resolution, '处理说明'), anchor: parseManuscriptAnchor(v.anchor), aiRunId: nullableId(v.aiRunId),
    ...(v.replacement === undefined ? {} : { replacement: exactText(v.replacement, '替换正文', 20000) }),
    ...(v.candidateSource === undefined ? {} : { candidateSource: parseReviewCandidateSource(v.candidateSource) }),
    ...(application ? { application } : {}) }
}
export function parseWritingGoalFields(value: unknown): WritingGoalFields {
  const v = object(value)
  const target = requiredInteger(v.target, '目标数量', 1_000_000)
  if (!target) throw new DomainError({ code: 'INVALID_INPUT', message: '写作目标须大于零。' })
  return { period: choice(v.period, ['day', 'week']), metric: choice(v.metric, WRITING_METRICS), target, active: flag(v.active) }
}
export function parseSaveBriefInput(value: unknown): SaveBriefInput { const v = object(value); return { ...mutation(v), brief: parseWritingBrief(v.brief) } }
export function parseSaveSceneInput(value: unknown): SaveSceneInput { const v = object(value); return { ...mutation(v), ...identity(v), fields: parseSceneFields(v.fields) } }
export function parseReorderScenesInput(value: unknown): ReorderScenesInput {
  const v = object(value)
  const sceneIds = ids(v.sceneIds, MAX_SCENES)
  if (!sceneIds.length) throw new DomainError({ code: 'INVALID_INPUT', message: '请选择需要排序的场景。' })
  return { ...mutation(v), chapterId: nullableId(v.chapterId), sceneIds }
}
export function parseSaveReviewIssueInput(value: unknown): SaveReviewIssueInput { const v = object(value); return { ...mutation(v), ...identity(v), fields: parseReviewIssueFields(v.fields) } }
export function parseApplyReviewIssueInput(value: unknown): ApplyReviewIssueInput { const v = object(value); return { ...mutation(v), ...identity(v), expectedRevisionId: id(v.expectedRevisionId) } }
export function parseSaveWritingGoalInput(value: unknown): SaveWritingGoalInput { const v = object(value); return { ...mutation(v), ...identity(v), fields: parseWritingGoalFields(v.fields) } }
export function parseLogWritingSessionInput(value: unknown): LogWritingSessionInput {
  const v = object(value)
  if (typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !Number.isFinite(Date.parse(`${v.date}T12:00:00Z`)) || new Date(`${v.date}T12:00:00Z`).toISOString().slice(0, 10) !== v.date) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '写作日期无效。' })
  }
  const minutes = requiredInteger(v.minutes, '写作分钟', 1_440)
  const revisedChapterId = nullableId(v.revisedChapterId)
  if (minutes === 0 && revisedChapterId === null) throw new DomainError({ code: 'INVALID_INPUT', message: '请记录写作时长或完成改稿的章节。' })
  return { ...mutation(v), id: id(v.id), date: v.date, minutes, revisedChapterId }
}
export function parseInspirationFields(value: unknown): InspirationFields {
  const v = object(value)
  if (!Array.isArray(v.tags) || v.tags.length > 20) throw new DomainError({ code: 'INVALID_INPUT', message: '标签最多 20 个。' })
  const tags = [...new Set(v.tags.map((tag) => requiredText(tag, '标签', 50)))]
  if (typeof v.body !== 'string' || v.body.length > 40_000 || v.body.includes('\0')) throw new DomainError({ code: 'INVALID_INPUT', message: '灵感内容不能超过 40,000 个字符，且不能包含空字符。' })
  if (typeof v.kind === 'string' && isStudyCardKind(v.kind)) readStudyCard(v.kind, v.body)
  // 原文缩进与分段换行属于内容；保存、读取和幂等核对都保留相同字符。
  return { kind: choice(v.kind, INSPIRATION_KINDS), title: requiredText(v.title, '灵感标题', 160), body: v.body,
    source: text(v.source, '参考出处', 2_000), tags, parentId: nullableId(v.parentId), bookId: nullableId(v.bookId), archived: flag(v.archived) }
}
export function parseListInspirationInput(value: unknown): ListInspirationInput {
  const v = object(value)
  return { search: v.search === undefined ? undefined : text(v.search, '搜索', 200), bookId: v.bookId === undefined ? undefined : id(v.bookId),
    offset: v.offset === undefined ? undefined : requiredInteger(v.offset, '页位置', 10_000), includeArchived: v.includeArchived === undefined ? false : flag(v.includeArchived) }
}
export function parseSaveInspirationInput(value: unknown): SaveInspirationInput {
  const v = object(value)
  return { ...identity(v), fields: parseInspirationFields(v.fields),
    ...(v.thumbnail === undefined ? {} : { thumbnail: v.thumbnail === null ? null : parseNoteThumbnailFields(v.thumbnail) }) }
}
export function parseImportInspirationsInput(value: unknown): ImportInspirationsInput {
  const v = object(value)
  if (!Array.isArray(v.items) || !v.items.length || v.items.length > 50 || JSON.stringify(v).length > 1_200_000) throw new DomainError({ code: 'INVALID_INPUT', message: '一次最多导入 50 个分段，文本合计不超过 120 万字符。' })
  const items = v.items.map(parseSaveInspirationInput)
  if (items.some((entry) => entry.expectedRevision !== 0 || entry.thumbnail !== undefined)
    || new Set(items.map((entry) => entry.id)).size !== items.length) throw new DomainError({ code: 'INVALID_INPUT', message: '文本导入只能建立具有独立标识且不携带图片的新条目。' })
  return { items }
}
export function parseCopyInspirationInput(value: unknown): CopyInspirationInput {
  const v = object(value)
  return { ...mutation(v), ...identity(v), noteId: id(v.noteId),
    ...(v.chapterIds === undefined ? {} : { chapterIds: parseNoteChapterIds(v.chapterIds) }) }
}
