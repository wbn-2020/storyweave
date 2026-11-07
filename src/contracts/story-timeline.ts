import { DomainError, isRecord, optionalText, requiredId, requiredInteger } from './api'
import { AUTHOR_DECISIONS, KNOWLEDGE_NATURES, type AuthorDecision, type KnowledgeNature } from './knowledge'
import { MAX_STORY_RECORDS, type Disclosure, type EventFields, type StoryTime } from './story'

export const TIMELINE_ORDERS = ['story', 'disclosure'] as const
export type TimelineOrder = typeof TIMELINE_ORDERS[number]
export const MAX_TIMELINE_PAGE_SIZE = 50

export interface StoryTimelineInput {
  bookId: string
  order: TimelineOrder
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

export interface StoryTimelineItem extends Pick<EventFields, 'title' | 'description' | 'nature' | 'authorDecision' | 'freshness' | 'conflictState'> {
  id: string
  bookId: string
  time: StoryTime
  disclosure: TimelineDisclosure
}

export interface StoryTimelinePage {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  order: TimelineOrder
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
  const allowed = ['bookId', 'order', 'search', 'nature', 'authorDecision', 'limit', 'offset', 'expectedBookRevision', 'expectedKnowledgeRevision']
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) return invalid('时间线请求格式无效或包含不支持的字段。')
  const limit = value.limit === undefined ? MAX_TIMELINE_PAGE_SIZE : requiredInteger(value.limit, '每页数量', MAX_TIMELINE_PAGE_SIZE)
  if (limit < 1) return invalid('每页数量必须在 1 到 50 之间。')
  const offset = value.offset === undefined ? 0 : requiredInteger(value.offset, '时间线位置', MAX_STORY_RECORDS)
  const hasBookRevision = value.expectedBookRevision !== undefined
  const hasKnowledgeRevision = value.expectedKnowledgeRevision !== undefined
  if (hasBookRevision !== hasKnowledgeRevision || (offset > 0 && !hasBookRevision)) {
    return invalid('继续查看时间线时需要同时提供作品版本与知识版本，请重新读取第一页。')
  }
  return {
    bookId: requiredId(value.bookId).toLowerCase(),
    order: choice(value.order, TIMELINE_ORDERS, '时间线排序'), limit, offset,
    ...(value.search === undefined ? {} : { search: optionalText(value.search, '搜索内容', 200) }),
    ...(value.nature === undefined ? {} : { nature: choice(value.nature, KNOWLEDGE_NATURES, '事件性质') }),
    ...(value.authorDecision === undefined ? {} : { authorDecision: choice(value.authorDecision, AUTHOR_DECISIONS, '作者决定') }),
    ...(hasBookRevision ? {
      expectedBookRevision: requiredInteger(value.expectedBookRevision, '作品版本'),
      expectedKnowledgeRevision: requiredInteger(value.expectedKnowledgeRevision, '知识版本'),
    } : {}),
  }
}
