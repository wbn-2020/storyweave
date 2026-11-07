import { DomainError } from '../../contracts/api'
import {
  AI_RECOMMENDATION_CANDIDATE_LIMIT, AI_RECOMMENDATION_QUERY_LIMIT, AI_RECOMMENDATION_RESULT_LIMIT,
  parseAiContextRecommendationInput, type AiContextRecommendationHit, type AiContextRecommendationInput,
  type AiContextRecommendationPage, type AiContextRecommendationQuery,
} from '../../contracts/ai-context-recommendation'
import type { AiContextBlock } from '../../contracts/ai'
import { documentToText } from '../../contracts/manuscript'
import type { MemoryEvidence, MemorySearchHit } from '../../contracts/memory'
import type { MemorySearchRepository } from '../memory/search-repository'
import type { MemoryVectorRepository } from '../memory/vector-repository'
import type { StudioRepository } from '../storage/studio-repository'
import { createAiCharacterContextReader } from './character-context'
import { checkEvidence, checkReaderEvidence, selectChapterContext } from './context'

const TEXT_SAMPLE_LIMIT = 6000
const QUERY_RESULT_LIMIT = 30
const CHUNKS_PER_SOURCE = 3
const STOP_WORDS = new Set(('的 了 在 是 和 与 及 或 而 就 都 也 很 又 还 被 把 让 将 对 为 从 到 向 以 于 着 过 ' +
  '这个 那个 一个 这些 那些 他们 她们 我们 你们 自己 什么 怎么 为什么 可以 需要 已经 没有 不能 不要 请 继续 ' +
  '章节 正文 续写 改写 段落 规划 帮我 根据 使用 输出 内容 描写 小说 要求 进行 一些 一下 然后 但是 因为 所以 ' +
  'the a an and or to of in on at for with from by as is are was were be been this that these those it its ' +
  'he she they we you i his her their our my not no do does did can could would should please write rewrite continue chapter text').split(' '))

interface BookState { id: string; revision: number; knowledge_revision: number; index_publication_version: number; archived_at: string | null }
interface Candidate { hit: MemorySearchHit; score: number; queryIndexes: Set<number>; vectorRunId?: string }
function conflict(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
function storageFailure(): DomainError { return new DomainError({ code: 'STORAGE_ERROR', message: '资料推荐的固定来源无法核对，请保留当前选择并检查作品资料。' }) }

function sampleText(blocks: AiContextBlock[], tail: boolean): string {
  const parts: string[] = []
  let remaining = TEXT_SAMPLE_LIMIT
  for (let offset = 0; offset < blocks.length && remaining > 0; offset += 1) {
    const block = blocks[tail ? blocks.length - offset - 1 : offset]!
    const part = (tail ? block.text.slice(-remaining) : block.text.slice(0, remaining))
      .replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '')
    parts.push(part)
    remaining -= part.length + 1
  }
  return (tail ? parts.reverse() : parts).join('\n')
}

function queryTerms(text: string, limit: number): string[] {
  const words = new Map<string, { count: number; first: number }>()
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  for (const part of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
    const word = part.segment
    if (!part.isWordLike || word.length < 2 || word.length > 40 || STOP_WORDS.has(word) || !/\p{L}/u.test(word)) continue
    const previous = words.get(word)
    if (previous) previous.count += 1
    else words.set(word, { count: 1, first: part.index })
  }
  return Array.from(words).sort((left, right) => right[1].count - left[1].count || left[1].first - right[1].first)
    .slice(0, limit).map(([word]) => word)
}

function queriesFor(data: AiContextRecommendationInput, blocks: AiContextBlock[]): AiContextRecommendationQuery[] {
  const queries: AiContextRecommendationQuery[] = data.characterScope ? [{ text: '', source: 'character' }] : []
  // 长句直接进入现有 AND 检索容易过窄；仅提取少量分词，不推断实体在场或人物知情。
  const seen = new Set<string>()
  for (const text of queryTerms(data.instruction, 4)) { queries.push({ text, source: 'instruction' }); seen.add(text) }
  const sample = sampleText(data.kind === 'rewrite' ? blocks.filter((block) => data.selectedBlockIds.includes(block.blockId)) : blocks, data.kind === 'continue')
  for (const text of queryTerms(sample, AI_RECOMMENDATION_QUERY_LIMIT)) {
    if (queries.length === AI_RECOMMENDATION_QUERY_LIMIT) break
    if (seen.has(text)) continue
    queries.push({ text, source: 'chapter' }); seen.add(text)
  }
  return queries
}

export class AiContextRecommendationRepository {
  constructor(private readonly studio: StudioRepository, private readonly memorySearch: MemorySearchRepository,
    private readonly memoryVectors: MemoryVectorRepository) {}

  recommend(input: AiContextRecommendationInput): AiContextRecommendationPage {
    const data = parseAiContextRecommendationInput(input)
    try {
      const db = this.studio.getMemoryDatabase(data.bookId)
      if ((db.pragma('user_version', { simple: true }) as number) < 6) {
        throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级作品，再使用协作资料推荐。' })
      }
      return db.transaction(() => {
        const book = db.prepare('SELECT id, revision, knowledge_revision, index_publication_version, archived_at FROM book_meta WHERE singleton = 1').get() as BookState | undefined
        if (!book || book.id !== data.bookId || [book.revision, book.knowledge_revision, book.index_publication_version]
          .some((value) => !Number.isSafeInteger(value) || value < 0)) throw storageFailure()
        if (book.archived_at !== null) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请先取消归档再推荐创作资料。' })
        if (book.revision !== data.expectedBookRevision || book.knowledge_revision !== data.expectedKnowledgeRevision) conflict('作品或知识库已有新版本，请重新读取状态后推荐资料。')
        const chapter = this.studio.readChapter({ bookId: data.bookId, chapterId: data.chapterId })
        if (chapter.bookId !== data.bookId || chapter.id !== data.chapterId || chapter.bookRevision !== book.revision ||
          chapter.revisionId !== data.expectedRevisionId) conflict('目标章节已有新稿，请重新读取固定版本后推荐资料。')
        if (documentToText(chapter.document) !== chapter.plainText) throw storageFailure()
        const selected = selectChapterContext(chapter, data)
        const queries = queriesFor(data, selected.blocks)
        const characterReader = data.characterScope ? createAiCharacterContextReader(this.studio, book.id, book.revision, book.knowledge_revision, data.characterScope) : null
        const readerLimited = data.perspective === 'reader' || data.characterScope?.readerLimited === true
        const vectorRuns = this.memoryVectors.listSearchResults({ bookId: book.id, expectedPublicationVersion: book.index_publication_version })
        const candidates = new Map<number, Candidate>()
        const warnings = ['推荐只使用本地资料：要求取至多 4 个词，固定正文取样至多 6,000 字符，合计至多 8 路查询；最多核对 120 个候选，展示 20 个，每个来源至多 3 个片段。分词和有界排名可能遗漏相关资料，可补充手工检索。',
          '推荐结果须由作者逐项选入；最终发送预览会再次核对来源、视角资格和完整预算。推荐不会改变已有选择或发起模型请求。']
        let truncated = false
        let incompleteIndex = false
        const merge = (hits: MemorySearchHit[], queryIndex?: number, vectorRunId?: string) => {
          hits.forEach((hit, rank) => {
            const previous = candidates.get(hit.chunkId)
            if (previous && (previous.hit.sourceKind !== hit.sourceKind || previous.hit.sourceId !== hit.sourceId ||
              previous.hit.revisionId !== hit.revisionId || previous.hit.blockId !== hit.blockId)) throw storageFailure()
            const candidate: Candidate = previous ?? { hit, score: 0, queryIndexes: new Set<number>() }
            candidate.score += (queryIndex !== undefined && queries[queryIndex]!.source === 'instruction' ? 2 : 1) / (60 + rank + 1)
            if (queryIndex !== undefined) candidate.queryIndexes.add(queryIndex)
            if (vectorRunId) candidate.vectorRunId = vectorRunId
            if (previous) candidate.hit = { ...previous.hit, reasons: Array.from(new Set([...previous.hit.reasons, ...hit.reasons])) }
            candidates.set(hit.chunkId, candidate)
          })
        }
        queries.forEach((query, queryIndex) => {
          const page = this.memorySearch.search({ bookId: book.id, query: query.text, includeUnreviewed: false, includeAffected: false, limit: QUERY_RESULT_LIMIT,
            ...(data.perspective === 'reader' ? { sourceKind: 'story' as const } : {}),
            ...(data.characterScope ? { sourceKind: 'story' as const, entityId: data.characterScope.personId, nature: 'character_belief' as const } : {}) })
          if (page.bookId !== book.id || page.publicationVersion !== book.index_publication_version || page.status.bookId !== book.id ||
            page.status.bookRevision !== book.revision || page.status.knowledgeRevision !== book.knowledge_revision ||
            page.status.publicationVersion !== book.index_publication_version) throw storageFailure()
          truncated ||= page.truncated
          incompleteIndex ||= !page.status.current
          merge(page.hits, queryIndex)
        })
        if (data.vectorRunId) {
          const run = this.memoryVectors.get({ bookId: book.id, runId: data.vectorRunId })
          if (run.bookId !== book.id || run.id !== data.vectorRunId) throw storageFailure()
          if (run.kind !== 'search' || run.state !== 'succeeded' || !run.result || !run.context.search) {
            throw new DomainError({ code: 'INVALID_INPUT', message: '只能复用已有的成功向量检索结果。' })
          }
          if (run.publicationVersion !== book.index_publication_version || run.result.publicationVersion !== book.index_publication_version) conflict('所选向量检索属于旧索引批次，请重新选择当前批次的成功检索。')
          truncated ||= run.result.truncated
          incompleteIndex ||= !run.result.status.current || run.result.status.bookRevision !== book.revision || run.result.status.knowledgeRevision !== book.knowledge_revision
          merge(run.result.hits, undefined, run.id)
          warnings.push(`已复用“${run.context.search.query}”的历史混合检索候选；未为当前要求重新计算向量。每个候选仍按当前资料与视角重新核对，未采用历史摘录作为当前证据。`)
        }
        if (incompleteIndex || book.index_publication_version === 0) warnings.push('本地索引尚未完整覆盖当前作品，推荐只覆盖当前仍有效的已发布片段；结果为空不表示没有相关资料。')
        if (!queries.length) warnings.push('当前要求和正文未提取到可用检索词，请补充具体名称或通过手工检索选择资料。')
        if (readerLimited) warnings.push('附加资料仅推荐披露锚点位于当前原稿且严格早于目标章的故事记录；当前章与协作要求仍须由作者核对。')
        if (data.characterScope) warnings.push('人物推荐仅核对显式认知和形成时点，不重建遗忘、替代或完整历史心智，也不据关联实体推导人物知情。')
        const ranked = Array.from(candidates.values()).sort((left, right) => right.score - left.score || left.hit.chunkId - right.hit.chunkId)
        if (ranked.length > AI_RECOMMENDATION_CANDIDATE_LIMIT) truncated = true
        const inspected = ranked.slice(0, AI_RECOMMENDATION_CANDIDATE_LIMIT)
        const items: AiContextRecommendationHit[] = []
        const sources = new Map<string, number>()
        let excludedCandidates = 0
        for (const candidate of inspected) {
          let item: MemoryEvidence
          try { item = this.memorySearch.evidence({ bookId: book.id, chunkId: candidate.hit.chunkId }) }
          catch (error) {
            // 历史向量结果可能仍属本批次，但其来源已变；损坏与读取失败不能伪装成无命中。
            if (error instanceof DomainError && error.detail.code === 'REVISION_CONFLICT') { excludedCandidates += 1; continue }
            throw error
          }
          if (item.chunkId !== candidate.hit.chunkId || item.publicationVersion !== book.index_publication_version ||
            item.sourceKind !== candidate.hit.sourceKind || item.sourceId !== candidate.hit.sourceId ||
            item.revisionId !== candidate.hit.revisionId || item.blockId !== candidate.hit.blockId) throw storageFailure()
          try {
            checkEvidence(item, book.id)
            if (readerLimited) checkReaderEvidence(this.studio, item, chapter)
            if (characterReader) characterReader([item])
          } catch (error) {
            if (error instanceof DomainError && (error.detail.code === 'INVALID_INPUT' || error.detail.code === 'REVISION_CONFLICT')) {
              excludedCandidates += 1; continue
            }
            throw error
          }
          const sourceKey = `${item.sourceKind}:${item.sourceId}`
          const sourceCount = sources.get(sourceKey) ?? 0
          if (items.length === AI_RECOMMENDATION_RESULT_LIMIT || sourceCount === CHUNKS_PER_SOURCE) { truncated = true; continue }
          sources.set(sourceKey, sourceCount + 1)
          const excerpt = item.text.slice(0, 360).replace(/[\uD800-\uDBFF]$/, '')
          items.push({ chunkId: item.chunkId, sourceKind: item.sourceKind, sourceId: item.sourceId, revisionId: item.revisionId,
            blockId: item.blockId, title: item.title, nature: item.nature, authorDecision: item.authorDecision,
            freshness: item.freshness, conflictState: item.conflictState, dependencyState: item.dependencyState,
            ...(item.readerDisclosure ? { readerDisclosure: item.readerDisclosure } : {}), excerpt: excerpt + (excerpt.length < item.text.length ? '…' : ''),
            reasons: candidate.hit.reasons, queryIndexes: Array.from(candidate.queryIndexes),
            ...(candidate.vectorRunId ? { vectorRunId: candidate.vectorRunId } : {}) })
        }
        return { request: data, bookId: book.id, chapterId: chapter.id, chapterRevisionId: chapter.revisionId,
          bookRevision: book.revision, knowledgeRevision: book.knowledge_revision, publicationVersion: book.index_publication_version,
          queries, items, scannedCandidates: inspected.length, excludedCandidates, truncated, warnings, vectorRuns }
      })()
    } catch (error) { if (error instanceof DomainError) throw error; throw storageFailure() }
  }
}
