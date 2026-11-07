import { DomainError, isRecord, requiredId, requiredInteger, requiredText } from './api'
import type { AiContextPerspective } from './ai'
import { parseAiCharacterScope, type AiCharacterScope } from './ai-character-context'
import type { MemorySearchHit } from './memory'
import type { MemoryVectorSearchResultPage } from './memory-vector'

export const AI_RECOMMENDATION_QUERY_LIMIT = 8
export const AI_RECOMMENDATION_CANDIDATE_LIMIT = 120
export const AI_RECOMMENDATION_RESULT_LIMIT = 20

export interface AiContextRecommendationInput {
  bookId: string
  chapterId: string
  expectedBookRevision: number
  expectedKnowledgeRevision: number
  expectedRevisionId: string
  kind: 'plan' | 'continue' | 'rewrite'
  instruction: string
  contextScope: 'chapter' | 'nearby'
  perspective?: AiContextPerspective
  characterScope?: AiCharacterScope
  selectedBlockIds: string[]
  /** 只复用作者明确选择的成功检索结果，不为当前要求发起新的向量请求。 */
  vectorRunId?: string
}
export interface AiContextRecommendationQuery { text: string; source: 'instruction' | 'chapter' | 'character' }
export interface AiContextRecommendationHit extends MemorySearchHit { queryIndexes: number[]; vectorRunId?: string }
export interface AiContextRecommendationPage {
  request: AiContextRecommendationInput
  bookId: string
  chapterId: string
  chapterRevisionId: string
  bookRevision: number
  knowledgeRevision: number
  publicationVersion: number
  queries: AiContextRecommendationQuery[]
  items: AiContextRecommendationHit[]
  scannedCandidates: number
  excludedCandidates: number
  truncated: boolean
  warnings: string[]
  vectorRuns: MemoryVectorSearchResultPage
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function id(value: unknown): string { return requiredId(value).toLowerCase() }

export function parseAiContextRecommendationInput(value: unknown): AiContextRecommendationInput {
  const keys = ['bookId', 'chapterId', 'expectedBookRevision', 'expectedKnowledgeRevision', 'expectedRevisionId',
    'kind', 'instruction', 'contextScope', 'perspective', 'characterScope', 'selectedBlockIds', 'vectorRunId']
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('资料推荐请求格式无效或包含不支持的字段。')
  if (value.kind !== 'plan' && value.kind !== 'continue' && value.kind !== 'rewrite') invalid('资料推荐仅用于章节规划、续写和改写。')
  if (value.contextScope !== 'chapter' && value.contextScope !== 'nearby') invalid('推荐的正文范围无效。')
  if (value.perspective !== undefined && value.perspective !== 'author' && value.perspective !== 'reader' && value.perspective !== 'character') invalid('推荐的资料视角无效。')
  if (value.perspective !== 'character' && value.characterScope !== undefined) invalid('只有人物视角可以指定人物与故事时点。')
  const characterScope = value.perspective === 'character' ? parseAiCharacterScope(value.characterScope) : undefined
  if (!Array.isArray(value.selectedBlockIds) || value.selectedBlockIds.length > 200) invalid('改写最多选择 200 个连续段落。')
  const selectedBlockIds = value.selectedBlockIds.map(id)
  if (new Set(selectedBlockIds).size !== selectedBlockIds.length || (value.kind === 'rewrite') !== (selectedBlockIds.length > 0)) invalid('改写须选择不重复的连续段落，其他任务不指定改写目标。')
  return { bookId: id(value.bookId), chapterId: id(value.chapterId), expectedBookRevision: requiredInteger(value.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(value.expectedKnowledgeRevision, '知识版本'), expectedRevisionId: id(value.expectedRevisionId),
    kind: value.kind, instruction: requiredText(value.instruction, '协作要求', 6000), contextScope: value.contextScope, selectedBlockIds,
    ...(value.perspective === 'reader' ? { perspective: 'reader' as const } : {}),
    ...(characterScope ? { perspective: 'character' as const, characterScope } : {}),
    ...(value.vectorRunId === undefined ? {} : { vectorRunId: id(value.vectorRunId) }) }
}
