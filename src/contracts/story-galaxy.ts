import { DomainError, isRecord, optionalText, requiredId, requiredInteger } from './api'
import { AUTHOR_DECISIONS, KNOWLEDGE_KINDS, KNOWLEDGE_NATURES, type AuthorDecision, type ConflictState, type KnowledgeFreshness, type KnowledgeKind, type KnowledgeNature } from './knowledge'
import { STORY_KINDS, type StoryKind } from './story'

export const GALAXY_PAGE_SIZE = 40
export const MAX_GALAXY_EDGES = 240
export const GALAXY_KINDS = [...KNOWLEDGE_KINDS, ...STORY_KINDS] as const
export const GALAXY_ROLES = ['relation_from', 'relation_to', 'participant', 'mentioned', 'state_change', 'foreshadow_entity', 'cognition_subject', 'relation_start', 'relation_end', 'foreshadow_event', 'acquisition'] as const
export type GalaxyKind = KnowledgeKind | StoryKind
export type GalaxyRole = typeof GALAXY_ROLES[number]
export interface GalaxyTarget { source: 'knowledge' | 'story'; id: string }

export interface StoryGalaxyInput {
  bookId: string
  search?: string
  kind?: GalaxyKind
  nature?: KnowledgeNature
  authorDecision?: AuthorDecision
  /** 聚焦模式仅展示选中对象与已登记的直接关联，不与全书筛选混用。 */
  focus?: GalaxyTarget
  offset?: number
  expectedBookRevision?: number
  expectedKnowledgeRevision?: number
}

export interface GalaxyNode extends GalaxyTarget {
  bookId: string
  kind: GalaxyKind
  title: string
  excerpt: string
  nature: KnowledgeNature
  authorDecision: AuthorDecision
  freshness: KnowledgeFreshness
  conflictState: ConflictState
}
/** 连线记录显式引用角色；不推断因果、人物知情或关系是否仍有效。 */
export interface GalaxyEdge { id: string; from: GalaxyTarget; to: GalaxyTarget; role: GalaxyRole }
export interface StoryGalaxyPage {
  bookId: string
  bookRevision: number
  knowledgeRevision: number
  focus: GalaxyTarget | null
  offset: number
  nodes: GalaxyNode[]
  edges: GalaxyEdge[]
  edgesTruncated: boolean
  /** 全书模式为匹配对象数；聚焦模式为直接相邻对象数，不包括中心。 */
  total: number
  nextOffset: number | null
}

export function galaxyKey(target: GalaxyTarget): string { return `${target.source}:${target.id}` }

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return invalid(`${label}无效。`)
  return value as T
}

export function parseStoryGalaxyInput(value: unknown): StoryGalaxyInput {
  const allowed = ['bookId', 'search', 'kind', 'nature', 'authorDecision', 'focus', 'offset', 'expectedBookRevision', 'expectedKnowledgeRevision']
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) return invalid('星海请求格式无效或包含不支持的字段。')
  const offset = value.offset === undefined ? 0 : requiredInteger(value.offset, '星海位置', 200_000)
  const hasBook = value.expectedBookRevision !== undefined
  const hasKnowledge = value.expectedKnowledgeRevision !== undefined
  if (hasBook !== hasKnowledge || (offset > 0 && !hasBook)) return invalid('星海翻页需要同时提供作品与知识版本，请重新读取第一页。')
  let focus: GalaxyTarget | undefined
  if (value.focus !== undefined) {
    if (!isRecord(value.focus) || Object.keys(value.focus).some((key) => !['source', 'id'].includes(key))) return invalid('星海聚焦对象无效。')
    if (['search', 'kind', 'nature', 'authorDecision'].some((key) => value[key] !== undefined)) return invalid('聚焦关联时不能混用全书搜索与筛选。')
    focus = { source: choice(value.focus.source, ['knowledge', 'story'] as const, '对象来源'), id: requiredId(value.focus.id).toLowerCase() }
  }
  return {
    bookId: requiredId(value.bookId).toLowerCase(), offset,
    ...(focus ? { focus } : {}),
    ...(value.search === undefined ? {} : { search: optionalText(value.search, '搜索内容', 200) }),
    ...(value.kind === undefined ? {} : { kind: choice(value.kind, GALAXY_KINDS, '对象类型') }),
    ...(value.nature === undefined ? {} : { nature: choice(value.nature, KNOWLEDGE_NATURES, '知识性质') }),
    ...(value.authorDecision === undefined ? {} : { authorDecision: choice(value.authorDecision, AUTHOR_DECISIONS, '作者决定') }),
    ...(hasBook ? { expectedBookRevision: requiredInteger(value.expectedBookRevision, '作品版本'),
      expectedKnowledgeRevision: requiredInteger(value.expectedKnowledgeRevision, '知识版本') } : {}),
  }
}
