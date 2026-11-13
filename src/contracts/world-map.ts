import { DomainError, isRecord, requiredId, requiredInteger } from './api'
import type { AuthorDecision, ConflictState, KnowledgeFreshness, KnowledgeNature } from './knowledge'

export const WORLD_MAP_PAGE_SIZE = 40
export const WORLD_MAP_LINK_LIMIT = 160
export const WORLD_MAP_RELATED_LIMIT = 12
export const WORLD_ROUTE_TYPE = '航道'
export const WORLD_TERRITORY_TYPE = '领属'

export interface WorldMapInput {
  bookId: string
  asOfChapterId?: string
  offset?: number
  expectedBookRevision?: number
  expectedKnowledgeRevision?: number
}
export interface WorldMapSource {
  chapterId: string
  chapterTitle: string
  chapterPosition: number
  revisionId: string
  blockId: string
  quote: string
}
export interface WorldMapStatus {
  nature: KnowledgeNature
  authorDecision: AuthorDecision
  freshness: KnowledgeFreshness
  conflictState: ConflictState
}
export interface WorldMapReference { id: string; name: string }
export interface WorldMapEvent extends WorldMapReference { source: WorldMapSource | null }
export interface WorldMapPlace extends WorldMapReference, WorldMapStatus {
  excerpt: string
  firstAppearance: WorldMapSource | null
  people: WorldMapReference[]
  events: WorldMapEvent[]
  relatedTruncated: boolean
}
export interface WorldMapRoute extends WorldMapStatus {
  id: string
  title: string
  fromId: string
  toId: string
  direction: 'directed' | 'mutual'
}
export interface WorldMapTerritory extends WorldMapReference {
  placeIds: string[]
}
export interface WorldMapPage {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  asOfChapterId: string | null
  offset: number
  total: number
  places: WorldMapPlace[]
  routes: WorldMapRoute[]
  territories: WorldMapTerritory[]
  linksTruncated: boolean
  nextOffset: number | null
}

export function parseWorldMapInput(value: unknown): WorldMapInput {
  const allowed = ['bookId', 'asOfChapterId', 'offset', 'expectedBookRevision', 'expectedKnowledgeRevision']
  const invalid = (message: string): never => { throw new DomainError({ code: 'INVALID_INPUT', message }) }
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) return invalid('世界地图请求包含不支持的字段。')
  const offset = value.offset === undefined ? 0 : requiredInteger(value.offset, '地图位置', 100_000)
  const hasBook = value.expectedBookRevision !== undefined
  if (hasBook !== (value.expectedKnowledgeRevision !== undefined) || offset > 0 && !hasBook) {
    return invalid('地图翻页须同时固定作品与知识版本，请重新读取第一页。')
  }
  return { bookId: requiredId(value.bookId).toLowerCase(), offset,
    ...(value.asOfChapterId === undefined ? {} : { asOfChapterId: requiredId(value.asOfChapterId).toLowerCase() }),
    ...(hasBook ? { expectedBookRevision: requiredInteger(value.expectedBookRevision, '作品版本'),
      expectedKnowledgeRevision: requiredInteger(value.expectedKnowledgeRevision, '知识版本') } : {}) }
}
