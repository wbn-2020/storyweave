import { DomainError, isRecord, optionalText, requiredId, requiredInteger } from './api'
import { KNOWLEDGE_NATURES, type AuthorDecision, type ConflictState, type KnowledgeFreshness, type KnowledgeNature } from './knowledge'
import type { Disclosure } from './story'

export const MEMORY_SOURCE_KINDS = ['chapter', 'knowledge', 'story'] as const
export type MemorySourceKind = typeof MEMORY_SOURCE_KINDS[number]
export type MemoryTaskState = 'planning' | 'running' | 'paused' | 'completed' | 'superseded' | 'cancelled' | 'failed'
export type MemoryTaskPhase = 'planning' | 'indexing' | 'publishing'
export const MEMORY_PROJECTION_VERSION = 1
export const MEMORY_PLAN_PAGE = 100
export const MEMORY_CHUNK_SIZE = 1200
export const MEMORY_CHUNK_OVERLAP = 200
export const MEMORY_STEP_CHUNKS = 64

export interface MemoryBookInput { bookId: string }
export interface MemoryStartInput extends MemoryBookInput { expectedBookRevision: number; expectedKnowledgeRevision: number }
export interface MemoryTaskInput extends MemoryBookInput { taskId: string; expectedTaskVersion: number }
export interface MemoryControlInput extends MemoryTaskInput { action: 'pause' | 'resume' | 'cancel' | 'retry' }
export interface MemoryTaskSummary {
  id: string
  bookId: string
  version: number
  state: MemoryTaskState
  phase: MemoryTaskPhase
  targetBookRevision: number
  targetKnowledgeRevision: number
  plannedSources: number
  completedSources: number
  processedChunks: number
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface MemoryStatus {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  schemaVersion: number
  requiresUpgrade: boolean
  publicationVersion: number
  publishedBookRevision: number | null
  publishedKnowledgeRevision: number | null
  sourceCount: number
  indexedSourceCount: number
  changedDependencyCount: number
  pendingEventCount: number
  /** 作品版本与发布批次一致才表示整批覆盖当前作品；不表示模型理解或记忆效果达标。 */
  current: boolean
  activeTask: MemoryTaskSummary | null
  recentTasks: MemoryTaskSummary[]
}

export interface MemoryTaskReceipt { bookId: string; task: MemoryTaskSummary; status: MemoryStatus }
export interface MemorySearchInput extends MemoryBookInput {
  query: string
  sourceKind?: MemorySourceKind
  entityId?: string
  nature?: KnowledgeNature
  includeUnreviewed?: boolean
  includeAffected?: boolean
  limit?: number
}
export interface MemorySourceReference {
  sourceKind: MemorySourceKind
  sourceId: string
  revisionId: string
  title: string
  nature: KnowledgeNature
  authorDecision: AuthorDecision | null
  freshness: KnowledgeFreshness
  conflictState: ConflictState
  /** 缺省表示披露未知；位置信息仅来自作者显式标注。 */
  readerDisclosure?: Disclosure
}
export interface MemorySearchHit extends MemorySourceReference {
  chunkId: number
  blockId: string | null
  excerpt: string
  dependencyState: 'current' | 'source_changed'
  reasons: ('keyword' | 'title' | 'entity' | 'semantic')[]
}
export interface MemorySemanticScope {
  profileHash: string
  responseModel: string
  dimensions: number
  eligibleChunks: number
  indexedChunks: number
  scannedChunks: number
  scanLimit: number
}
export interface MemorySearchPage {
  bookId: string
  publicationVersion: number
  status: MemoryStatus
  hits: MemorySearchHit[]
  /** 有界候选排名不伪装成全库总命中数。 */
  truncated: boolean
  mode: 'local_keyword_entity' | 'hybrid_keyword_entity_vector'
  semantic?: MemorySemanticScope
}
export interface MemoryEvidenceInput extends MemoryBookInput { chunkId: number }
export interface MemoryEvidence extends MemorySourceReference {
  bookId: string
  chunkId: number
  blockId: string | null
  startOffset: number
  endOffset: number
  text: string
  publicationVersion: number
  /** 片段的直接来源仍属当前发布版本；其正文引用是否变化由 dependencyState 单独表达。 */
  referenceState: 'current'
  dependencyState: 'current' | 'source_changed'
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('记忆请求格式无效或包含不支持的字段。')
  return value
}
function bookId(value: unknown): string { return requiredId(value).toLowerCase() }
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') invalid('记忆筛选开关必须是布尔值。')
  return value
}

export function parseMemoryBookInput(value: unknown): MemoryBookInput {
  const data = record(value, ['bookId'])
  return { bookId: bookId(data.bookId) }
}
export function parseMemoryStartInput(value: unknown): MemoryStartInput {
  const data = record(value, ['bookId', 'expectedBookRevision', 'expectedKnowledgeRevision'])
  return { bookId: bookId(data.bookId), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识版本') }
}
export function parseMemoryTaskInput(value: unknown): MemoryTaskInput {
  const data = record(value, ['bookId', 'taskId', 'expectedTaskVersion'])
  return { bookId: bookId(data.bookId), taskId: bookId(data.taskId), expectedTaskVersion: requiredInteger(data.expectedTaskVersion, '任务版本') }
}
export function parseMemoryControlInput(value: unknown): MemoryControlInput {
  const data = record(value, ['bookId', 'taskId', 'expectedTaskVersion', 'action'])
  if (data.action !== 'pause' && data.action !== 'resume' && data.action !== 'cancel' && data.action !== 'retry') invalid('不支持这个任务操作。')
  return { ...parseMemoryTaskInput({ bookId: data.bookId, taskId: data.taskId, expectedTaskVersion: data.expectedTaskVersion }), action: data.action }
}
export function parseMemorySearchInput(value: unknown): MemorySearchInput {
  const data = record(value, ['bookId', 'query', 'sourceKind', 'entityId', 'nature', 'includeUnreviewed', 'includeAffected', 'limit'])
  const query = optionalText(data.query, '检索内容', 200)
  if (!query && data.entityId === undefined) invalid('请填写检索内容或选择关联实体。')
  if (data.sourceKind !== undefined && !MEMORY_SOURCE_KINDS.includes(data.sourceKind as MemorySourceKind)) invalid('检索来源类型无效。')
  if (data.nature !== undefined && !KNOWLEDGE_NATURES.includes(data.nature as KnowledgeNature)) invalid('检索知识性质无效。')
  const limit = data.limit === undefined ? 30 : requiredInteger(data.limit, '结果数量', 50)
  if (limit < 1) invalid('结果数量必须为 1 到 50。')
  return { bookId: bookId(data.bookId), query, includeUnreviewed: boolean(data.includeUnreviewed, true), includeAffected: boolean(data.includeAffected, false), limit,
    ...(data.sourceKind === undefined ? {} : { sourceKind: data.sourceKind as MemorySourceKind }),
    ...(data.entityId === undefined ? {} : { entityId: bookId(data.entityId) }),
    ...(data.nature === undefined ? {} : { nature: data.nature as KnowledgeNature }) }
}
export function parseMemoryEvidenceInput(value: unknown): MemoryEvidenceInput {
  const data = record(value, ['bookId', 'chunkId'])
  const chunkId = requiredInteger(data.chunkId, '检索片段编号')
  if (chunkId < 1) invalid('检索片段编号无效。')
  return { bookId: bookId(data.bookId), chunkId }
}
