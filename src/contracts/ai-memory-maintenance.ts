import { DomainError, isRecord, requiredId, requiredInteger } from './api'
import type { AiBookInput } from './ai'
import { parseAiMemoryTaskScope, type AiMemoryTaskKind, type AiMemoryTaskScope } from './ai-memory-task'

export const AI_MEMORY_MAINTENANCE_PAGE = 50
export const AI_MEMORY_MAINTENANCE_BATCH = 100
export interface AiMemoryMaintenanceInput extends AiBookInput {
  expectedBookRevision: number
  expectedKnowledgeRevision: number
  kind: AiMemoryTaskKind
  scope: AiMemoryTaskScope
  afterOrdinal?: number
  expectedCoverageHash?: string
}
export interface AiMemoryMaintenanceChapter {
  ordinal: number
  chapterId: string
  chapterTitle: string
  chapterRevisionId: string
  volumeId: string | null
  reason: 'unreviewed' | 'changed'
}
export interface AiMemoryMaintenancePage {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  schemaVersion: number
  kind: AiMemoryTaskKind
  scope: AiMemoryTaskScope
  scopeTitle: string
  coverageHash: string
  totalChapters: number
  reviewedChapters: number
  pendingChapters: number
  unreviewedChapters: number
  changedChapters: number
  afterOrdinal: number
  chapters: AiMemoryMaintenanceChapter[]
  nextAfterOrdinal: number | null
}

export function parseAiMemoryCoverageHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '待维护清单指纹无效，请重新读取清单。' })
  }
  return value
}
export function parseAiMemoryMaintenanceInput(value: unknown): AiMemoryMaintenanceInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['bookId', 'expectedBookRevision', 'expectedKnowledgeRevision', 'kind', 'scope', 'afterOrdinal', 'expectedCoverageHash'].includes(key)) ||
    (value.kind !== 'summarize' && value.kind !== 'extract')) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '增量维护请求格式或整理类型无效。' })
  }
  const afterOrdinal = value.afterOrdinal === undefined ? 0 : requiredInteger(value.afterOrdinal, '待维护分页位置', 20_000)
  if (afterOrdinal > 0 && value.expectedCoverageHash === undefined) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '继续分页需要原清单指纹，请重新读取待维护清单。' })
  }
  return { bookId: requiredId(value.bookId).toLowerCase(), expectedBookRevision: requiredInteger(value.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(value.expectedKnowledgeRevision, '知识版本'), kind: value.kind,
    scope: parseAiMemoryTaskScope(value.scope), afterOrdinal,
    ...(value.expectedCoverageHash === undefined ? {} : { expectedCoverageHash: parseAiMemoryCoverageHash(value.expectedCoverageHash) }) }
}

export function isAiMemoryMaintenancePageFor(value: AiMemoryMaintenancePage, input: AiMemoryMaintenanceInput): boolean {
  try {
    if (value.bookId !== input.bookId || value.bookRevision !== input.expectedBookRevision || value.knowledgeRevision !== input.expectedKnowledgeRevision ||
      !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 11 || value.kind !== input.kind || JSON.stringify(value.scope) !== JSON.stringify(input.scope) ||
      typeof value.scopeTitle !== 'string' || value.scopeTitle.trim().length === 0 || value.scopeTitle.length > 120 ||
      !Number.isSafeInteger(value.afterOrdinal) || value.afterOrdinal < 0 || value.afterOrdinal > 20_000 ||
      value.afterOrdinal !== (input.afterOrdinal ?? 0) || (input.expectedCoverageHash !== undefined && value.coverageHash !== input.expectedCoverageHash) ||
      [value.totalChapters, value.reviewedChapters, value.pendingChapters, value.unreviewedChapters, value.changedChapters].some((count) => !Number.isSafeInteger(count) || count < 0 || count > 20_000) ||
      value.reviewedChapters + value.pendingChapters !== value.totalChapters || value.unreviewedChapters + value.changedChapters !== value.pendingChapters ||
      !Array.isArray(value.chapters) || value.chapters.length !== Math.min(AI_MEMORY_MAINTENANCE_PAGE, Math.max(0, value.pendingChapters - value.afterOrdinal)) ||
      new Set(value.chapters.map((chapter) => chapter.chapterId)).size !== value.chapters.length) return false
    parseAiMemoryCoverageHash(value.coverageHash)
    const end = value.afterOrdinal + value.chapters.length
    if (value.afterOrdinal > value.pendingChapters || value.nextAfterOrdinal !== (end < value.pendingChapters ? end : null)) return false
    return value.chapters.every((chapter, index) => {
      requiredId(chapter.chapterId); requiredId(chapter.chapterRevisionId)
      if (chapter.volumeId !== null) requiredId(chapter.volumeId)
      return chapter.ordinal === value.afterOrdinal + index + 1 && typeof chapter.chapterTitle === 'string' &&
        (input.scope.kind === 'book' || chapter.volumeId === input.scope.volumeId) &&
        chapter.chapterTitle.trim().length > 0 && chapter.chapterTitle.length <= 120 && (chapter.reason === 'unreviewed' || chapter.reason === 'changed')
    })
  } catch { return false }
}
