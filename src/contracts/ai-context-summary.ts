import { DomainError, isRecord, requiredId, requiredInteger, requiredText } from './api'
import { AI_SUMMARY_TEXT_LIMIT } from './ai-summary'

export const AI_CONTEXT_SUMMARY_PROMPT_VERSION = 4
export const AI_CONTEXT_SUMMARY_LIMIT = 4
export const AI_CONTEXT_SUMMARY_PAGE = 20

export interface AiContextSummaryCursor { taskId: string; nodeId: string }
export interface AiContextSummaryRef extends AiContextSummaryCursor { runId: string; manifestHash: string }
export interface AiContextSummaryChapter { id: string; revisionId: string; title: string; position: number }
export interface AiContextSummarySnapshot extends AiContextSummaryRef {
  scopeTitle: string
  title: string
  level: number
  coveredChapters: number
  firstChapter: AiContextSummaryChapter
  lastChapter: AiContextSummaryChapter
  coverageHash: string
  text: string
  approvedAt: string
}
export interface AiContextSummaryInput {
  bookId: string
  chapterId: string
  expectedBookRevision: number
  expectedKnowledgeRevision: number
  expectedRevisionId: string
  after?: AiContextSummaryCursor
}
export interface AiContextSummaryPage {
  bookId: string
  chapterId: string
  chapterRevisionId: string
  bookRevision: number
  knowledgeRevision: number
  items: AiContextSummarySnapshot[]
  scannedNodes: number
  nextAfter: AiContextSummaryCursor | null
}

function invalid(message = '创作摘要引用格式无效。'): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid()
  return value
}
function id(value: unknown): string { return requiredId(value).toLowerCase() }
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid()
  return value
}
function reference(value: unknown): AiContextSummaryRef {
  const data = record(value, ['taskId', 'nodeId', 'runId', 'manifestHash'])
  return { taskId: id(data.taskId), nodeId: id(data.nodeId), runId: id(data.runId), manifestHash: hash(data.manifestHash) }
}
export function contextSummaryRef(value: AiContextSummarySnapshot): AiContextSummaryRef {
  return { taskId: value.taskId, nodeId: value.nodeId, runId: value.runId, manifestHash: value.manifestHash }
}
export function parseAiContextSummaryRefs(value: unknown): AiContextSummaryRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > AI_CONTEXT_SUMMARY_LIMIT) invalid('一次最多选择 4 份完整摘要。')
  const refs = value.map(reference)
  if (new Set(refs.map((item) => item.nodeId)).size !== refs.length) invalid('所选摘要不能重复。')
  return refs
}
function chapter(value: unknown): AiContextSummaryChapter {
  const data = record(value, ['id', 'revisionId', 'title', 'position'])
  return { id: id(data.id), revisionId: id(data.revisionId), title: requiredText(data.title, '来源章标题', 120),
    position: requiredInteger(data.position, '来源章位置') }
}
export function parseAiContextSummarySnapshots(value: unknown): AiContextSummarySnapshot[] {
  if (!Array.isArray(value) || !value.length || value.length > AI_CONTEXT_SUMMARY_LIMIT) invalid()
  const snapshots = value.map((value): AiContextSummarySnapshot => {
    const data = record(value, ['taskId', 'nodeId', 'runId', 'manifestHash', 'scopeTitle', 'title', 'level', 'coveredChapters',
      'firstChapter', 'lastChapter', 'coverageHash', 'text', 'approvedAt'])
    const first = chapter(data.firstChapter); const last = chapter(data.lastChapter)
    const count = requiredInteger(data.coveredChapters, '摘要覆盖章节数', 20_000)
    if (count < 1 || first.position > last.position || (count === 1) !== (first.id === last.id) ||
      (count === 1 ? JSON.stringify(first) !== JSON.stringify(last) : first.position >= last.position || first.revisionId === last.revisionId || count > last.position - first.position + 1) ||
      typeof data.approvedAt !== 'string' || data.approvedAt.length > 40 || !Number.isFinite(Date.parse(data.approvedAt))) invalid()
    return { ...reference({ taskId: data.taskId, nodeId: data.nodeId, runId: data.runId, manifestHash: data.manifestHash }),
      scopeTitle: requiredText(data.scopeTitle, '摘要范围', 120), title: requiredText(data.title, '摘要标题', 120),
      level: requiredInteger(data.level, '摘要层级', 30), coveredChapters: count, firstChapter: first, lastChapter: last,
      coverageHash: hash(data.coverageHash), text: requiredText(data.text, '采用摘要', AI_SUMMARY_TEXT_LIMIT), approvedAt: data.approvedAt }
  })
  parseAiContextSummaryRefs(snapshots.map(contextSummaryRef))
  if (snapshots.some((item, index) => snapshots.slice(index + 1).some((other) => item.firstChapter.position <= other.lastChapter.position && other.firstChapter.position <= item.lastChapter.position))) {
    invalid('摘要快照的覆盖范围不能重复。')
  }
  return snapshots
}
export function parseAiContextSummaryInput(value: unknown): AiContextSummaryInput {
  const data = record(value, ['bookId', 'chapterId', 'expectedBookRevision', 'expectedKnowledgeRevision', 'expectedRevisionId', 'after'])
  const after = data.after === undefined ? undefined : record(data.after, ['taskId', 'nodeId'])
  return { bookId: id(data.bookId), chapterId: id(data.chapterId), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识版本'), expectedRevisionId: id(data.expectedRevisionId),
    ...(after ? { after: { taskId: id(after.taskId), nodeId: id(after.nodeId) } } : {}) }
}
