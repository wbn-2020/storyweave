import { DomainError, isRecord, optionalText, requiredId, requiredInteger } from './api'
import { KNOWLEDGE_KINDS, type AuthorDecision, type ConflictState, type KnowledgeFreshness, type KnowledgeKind } from './knowledge'
import type { Disclosure, ForeshadowStage, PlannedPayoff } from './story'
import type { ForeshadowThumbnailMetadata } from './foreshadow-thumbnail'

export const APPEARANCE_ENTITY_PAGE = 12
export const APPEARANCE_CHAPTER_PAGE = 24
export const FORESHADOW_RADAR_PAGE = 20
export const RADAR_SCOPES = ['open', 'due', 'closed', 'all'] as const
export type RadarScope = typeof RADAR_SCOPES[number]
export type RadarDue = 'overdue' | 'due' | 'upcoming' | 'unplaced' | 'unconfirmed' | 'closed'
export interface ControlVersions { bookRevision: number; knowledgeRevision: number }
interface VersionInput { bookId: string; expectedBookRevision?: number; expectedKnowledgeRevision?: number }
export interface AppearanceMatrixInput extends VersionInput {
  kind?: KnowledgeKind
  search?: string
  entityOffset?: number
  chapterOffset?: number
}
export interface AppearanceCell {
  entityId: string
  chapterId: string
  present: number
  mentioned: number
  absent: number
  stale: number
  /** 每类最多一个代表记录；计数覆盖全部命中，不能把代表记录数当成总数。 */
  recordIds: string[]
}
export interface AppearanceMatrixPage extends ControlVersions {
  bookId: string
  entityOffset: number
  chapterOffset: number
  entities: { id: string; name: string; kind: KnowledgeKind }[]
  chapters: { id: string; title: string; position: number; revisionId: string }[]
  cells: AppearanceCell[]
  entityTotal: number
  chapterTotal: number
  nextEntityOffset: number | null
  nextChapterOffset: number | null
}
export interface ForeshadowRadarInput extends VersionInput {
  /** 作者明确选择的核对进度，不把最后一个已建章节视作已写进度。 */
  asOfChapterId?: string
  scope?: RadarScope
  search?: string
  offset?: number
}
export interface ForeshadowRadarItem {
  id: string
  revision: number
  title: string
  description: string
  stage: ForeshadowStage
  authorDecision: AuthorDecision
  freshness: KnowledgeFreshness
  conflictState: ConflictState
  plannedPayoff: PlannedPayoff
  actualPayoff: Disclosure
  due: RadarDue
  overdueChapters: number | null
  thumbnail: ForeshadowThumbnailMetadata | null
  source: { sourceType: 'chapter_text' | 'author_input' | 'external'; quote: string; referenceState: 'current' | 'historical' | null } | null
}
export interface ForeshadowRadarPage extends ControlVersions {
  bookId: string
  asOfChapterId: string | null
  scope: RadarScope
  offset: number
  items: ForeshadowRadarItem[]
  total: number
  counts: Record<RadarDue, number>
  nextOffset: number | null
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function input(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) return invalid('控盘查询格式无效或包含不支持的字段。')
  return value
}
function versions(value: Record<string, unknown>, paged: boolean): VersionInput {
  const hasBook = value.expectedBookRevision !== undefined, hasKnowledge = value.expectedKnowledgeRevision !== undefined
  if (hasBook !== hasKnowledge || paged && !hasBook) return invalid('翻页需要同时提供作品与知识版本，请刷新第一页。')
  return { bookId: requiredId(value.bookId).toLowerCase(), ...(hasBook ? {
    expectedBookRevision: requiredInteger(value.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(value.expectedKnowledgeRevision, '知识版本'),
  } : {}) }
}
export function parseAppearanceMatrixInput(value: unknown): AppearanceMatrixInput {
  const v = input(value, ['bookId', 'kind', 'search', 'entityOffset', 'chapterOffset', 'expectedBookRevision', 'expectedKnowledgeRevision'])
  const entityOffset = v.entityOffset === undefined ? 0 : requiredInteger(v.entityOffset, '实体位置', 200_000)
  const chapterOffset = v.chapterOffset === undefined ? 0 : requiredInteger(v.chapterOffset, '章节位置', 200_000)
  if (v.kind !== undefined && !KNOWLEDGE_KINDS.includes(v.kind as KnowledgeKind)) return invalid('矩阵实体类型无效。')
  return { ...versions(v, entityOffset > 0 || chapterOffset > 0), entityOffset, chapterOffset,
    ...(v.kind === undefined ? {} : { kind: v.kind as KnowledgeKind }),
    ...(v.search === undefined ? {} : { search: optionalText(v.search, '实体名称', 200) }) }
}
export function parseForeshadowRadarInput(value: unknown): ForeshadowRadarInput {
  const v = input(value, ['bookId', 'asOfChapterId', 'scope', 'search', 'offset', 'expectedBookRevision', 'expectedKnowledgeRevision'])
  const offset = v.offset === undefined ? 0 : requiredInteger(v.offset, '伏笔位置', 200_000)
  const scope = v.scope === undefined ? 'open' : v.scope
  if (!RADAR_SCOPES.includes(scope as RadarScope)) return invalid('伏笔雷达范围无效。')
  return { ...versions(v, offset > 0), offset, scope: scope as RadarScope,
    ...(v.asOfChapterId === undefined ? {} : { asOfChapterId: requiredId(v.asOfChapterId).toLowerCase() }),
    ...(v.search === undefined ? {} : { search: optionalText(v.search, '伏笔名称', 200) }) }
}

export function appearanceState(cell: AppearanceCell | undefined): 'present' | 'mentioned' | 'absent' | 'conflict' | 'stale' | 'unknown' {
  if (!cell) return 'unknown'
  if (cell.absent > 0 && cell.present + cell.mentioned > 0) return 'conflict'
  if (cell.present > 0) return 'present'
  if (cell.mentioned > 0) return 'mentioned'
  if (cell.absent > 0) return 'absent'
  return cell.stale > 0 ? 'stale' : 'unknown'
}
