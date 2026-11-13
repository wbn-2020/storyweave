import { DomainError, isRecord, optionalText, requiredId, requiredInteger } from './api'
import { AUTHOR_DECISIONS, KNOWLEDGE_NATURES, type AuthorDecision, type KnowledgeNature } from './knowledge'
import { MAX_FORESHADOW_MILESTONES, MAX_STORY_RECORDS, type CognitionChangeKind, type Disclosure, type ForeshadowStage, type StoryRecordFields, type StoryTime } from './story'

export const TIMELINE_ORDERS = ['story', 'disclosure'] as const
export type TimelineOrder = typeof TIMELINE_ORDERS[number]
export const TIMELINE_TRACKS = ['event', 'cognition', 'relation', 'foreshadow'] as const
export type TimelineTrack = typeof TIMELINE_TRACKS[number]
export type TimelinePoint = 'record' | 'relation_start' | 'relation_end' | 'foreshadow_milestone'
export const MAX_TIMELINE_PAGE_SIZE = 50
/** 一条伏笔登记最多展开为登记本身和 200 条里程碑，分页上限按展开条目计算。 */
export const MAX_TIMELINE_ITEMS = MAX_STORY_RECORDS * (MAX_FORESHADOW_MILESTONES + 1)

export interface StoryTimelineInput {
  bookId: string
  order: TimelineOrder
  /** 缺省沿用事件轨道；选择多条轨道时合并排序，不能传入空集合。 */
  tracks?: TimelineTrack[]
  search?: string
  nature?: KnowledgeNature
  authorDecision?: AuthorDecision
  limit?: number
  offset?: number
  /** 翻页时同时锁定作品目录、正文与知识版本，避免混合两次读取的顺序。 */
  expectedBookRevision?: number
  expectedKnowledgeRevision?: number
}

export type TimelineDisclosure = Exclude<Disclosure, { state: 'located' }> | (Extract<Disclosure, { state: 'located' }> & {
  chapterTitle: string | null
  chapterPosition: number | null
  /** 仅核对章节与版本登记；具体段落及引文在打开原稿时核对。 */
  referenceState: 'current' | 'historical' | 'missing'
})

export interface StoryTimelineItem extends Pick<StoryRecordFields, 'title' | 'description' | 'nature' | 'authorDecision' | 'freshness' | 'conflictState'> {
  /** 展示条目的稳定身份；通用详情必须使用 sourceRecordId。 */
  id: string
  sourceRecordId: string
  milestoneId: string | null
  kind: TimelineTrack
  point: TimelinePoint
  bookId: string
  time: StoryTime
  disclosure: TimelineDisclosure
  /** 同一快照中登记关联的人物；事件只取参与者，不把提及或状态变化当作参与。 */
  people: { id: string; name: string }[]
  stage?: ForeshadowStage
  cognitionChange?: CognitionChangeKind
}

export function timelineItemId(sourceRecordId: string, point: TimelinePoint, milestoneId: string | null): string {
  return point === 'record' ? sourceRecordId : `${sourceRecordId}:${point}${milestoneId === null ? '' : `:${milestoneId}`}`
}

export interface StoryTimelinePage {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  order: TimelineOrder
  tracks: TimelineTrack[]
  items: StoryTimelineItem[]
  total: number
  nextOffset: number | null
}

function invalid(message: string): never {
  throw new DomainError({ code: 'INVALID_INPUT', message })
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return invalid(`${label}无效。`)
  return value as T
}

export function parseStoryTimelineInput(value: unknown): StoryTimelineInput {
  const allowed = ['bookId', 'order', 'tracks', 'search', 'nature', 'authorDecision', 'limit', 'offset', 'expectedBookRevision', 'expectedKnowledgeRevision']
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) return invalid('时间线请求格式无效或包含不支持的字段。')
  const limit = value.limit === undefined ? MAX_TIMELINE_PAGE_SIZE : requiredInteger(value.limit, '每页数量', MAX_TIMELINE_PAGE_SIZE)
  if (limit < 1) return invalid('每页数量必须在 1 到 50 之间。')
  const offset = value.offset === undefined ? 0 : requiredInteger(value.offset, '时间线位置', MAX_TIMELINE_ITEMS)
  const requestedTracks = value.tracks === undefined ? ['event'] : value.tracks
  if (!Array.isArray(requestedTracks) || requestedTracks.length < 1 || requestedTracks.length > TIMELINE_TRACKS.length) {
    return invalid('请至少选择一条时间线轨道，最多四条。')
  }
  const tracks = requestedTracks.map((track: unknown) => choice(track, TIMELINE_TRACKS, '时间线轨道'))
  if (new Set(tracks).size !== tracks.length) return invalid('时间线轨道不能重复。')
  const hasBookRevision = value.expectedBookRevision !== undefined
  const hasKnowledgeRevision = value.expectedKnowledgeRevision !== undefined
  if (hasBookRevision !== hasKnowledgeRevision || (offset > 0 && !hasBookRevision)) {
    return invalid('继续查看时间线时需要同时提供作品版本与知识版本，请重新读取第一页。')
  }
  return {
    bookId: requiredId(value.bookId).toLowerCase(),
    order: choice(value.order, TIMELINE_ORDERS, '时间线排序'),
    tracks: TIMELINE_TRACKS.filter((track) => tracks.includes(track)), limit, offset,
    ...(value.search === undefined ? {} : { search: optionalText(value.search, '搜索内容', 200) }),
    ...(value.nature === undefined ? {} : { nature: choice(value.nature, KNOWLEDGE_NATURES, '记录性质') }),
    ...(value.authorDecision === undefined ? {} : { authorDecision: choice(value.authorDecision, AUTHOR_DECISIONS, '作者决定') }),
    ...(hasBookRevision ? {
      expectedBookRevision: requiredInteger(value.expectedBookRevision, '作品版本'),
      expectedKnowledgeRevision: requiredInteger(value.expectedKnowledgeRevision, '知识版本'),
    } : {}),
  }
}
