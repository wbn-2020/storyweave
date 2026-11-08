import { DomainError } from '../../contracts/api'
import { parseAiCharacterContext, type AiCharacterContext, type AiCharacterCognition, type AiCharacterScope } from '../../contracts/ai-character-context'
import type { MemoryEvidence } from '../../contracts/memory'
import { cognitionStateAt, type CognitionState, type StoryRevision } from '../../contracts/story'
import { KnowledgeRepository } from '../knowledge/knowledge-repository'
import { StoryRepository } from '../story/story-repository'
import type { StudioRepository } from '../storage/studio-repository'

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function conflict(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
function storageFailure(): never { throw new DomainError({ code: 'STORAGE_ERROR', message: '人物身份或认知修订无法核对，请保留候选后检查资料。' }) }
function readStored<T>(read: () => T): T {
  try { return read() } catch (error) {
    // 读取参数已经校验；仓储在解析历史字段时报的输入错误属于资料损坏，不能按资格不符略过。
    if (error instanceof DomainError && error.detail.code === 'INVALID_INPUT') storageFailure()
    throw error
  }
}

/** 读取器仅在调用方的同一作品读事务中复用，避免逐个推荐片段反复加载人物及认知历史。 */
export function createAiCharacterContextReader(studio: StudioRepository, bookId: string, bookRevision: number,
  knowledgeRevision: number, scope: AiCharacterScope): (evidence: MemoryEvidence[]) => AiCharacterContext {
  const person = readStored(() => new KnowledgeRepository(studio).getItem({ bookId, id: scope.personId }))
  const identity = person.revisions[0]
  if (person.bookId !== bookId || person.id !== scope.personId || person.bookRevision !== bookRevision ||
    person.knowledgeRevision !== knowledgeRevision || !identity || identity.itemId !== person.id) storageFailure()
  if (person.kind !== 'person') invalid('人物视角须选择当前作品中的人物条目。')
  if (identity.fields.kind !== person.kind || identity.fields.name !== person.name) storageFailure()

  const stories = new StoryRepository(studio)
  const revisions = new Map<string, StoryRevision>()
  const histories = new Map<string, CognitionState[]>()
  const cognition = (item: MemoryEvidence): AiCharacterCognition => {
    if (item.bookId !== bookId || item.sourceKind !== 'story' || item.nature !== 'character_belief') {
      invalid(`“${item.title}”不是标为人物认知的故事资料，请移除后选择该人物的认知片段。`)
    }
    let revision = revisions.get(item.sourceId)
    if (!revision) {
      const current = readStored(() => stories.getRecord({ bookId, id: item.sourceId }))
      if (current.bookId !== bookId || current.id !== item.sourceId || current.bookRevision !== bookRevision ||
        current.knowledgeRevision !== knowledgeRevision) storageFailure()
      if (!current.cognitionHistory?.some((state) => state.id === current.id)) invalid(`“${item.title}”不是可查询的显式人物认知状态。`)
      histories.set(item.sourceId, current.cognitionHistory)
      if (current.revisions[0]?.id !== item.revisionId) conflict(`“${item.title}”的认知记录已有新修订，请重新整理并选择当前片段。`)
      revision = readStored(() => stories.readRevision({ bookId, id: item.sourceId, revisionId: item.revisionId }))
      if (revision.bookId !== bookId || revision.recordId !== item.sourceId || revision.id !== item.revisionId ||
        JSON.stringify(revision.fields) !== JSON.stringify(current.fields)) storageFailure()
      revisions.set(item.sourceId, revision)
    }
    if (revision.id !== item.revisionId) conflict(`“${item.title}”的认知记录已有新修订，请重新整理并选择当前片段。`)
    const fields = revision.fields
    if (fields.kind !== 'cognition' || fields.personId !== scope.personId) invalid(`“${item.title}”不属于所选人物的显式认知记录，请移除该片段。`)
    if (fields.nature !== 'character_belief' || fields.authorDecision !== 'adopted' || fields.freshness !== 'current' ||
      (fields.conflictState !== 'clear' && fields.conflictState !== 'explained')) invalid(`“${item.title}”尚未满足人物认知的采用与复核条件。`)
    if (fields.title !== item.title || fields.nature !== item.nature || fields.authorDecision !== item.authorDecision ||
      fields.freshness !== item.freshness || fields.conflictState !== item.conflictState ||
      (scope.readerLimited && JSON.stringify(fields.disclosure) !== JSON.stringify(item.readerDisclosure))) storageFailure()
    const formedAt = fields.storyTime
    if (formedAt.kind === 'unknown' || formedAt.order === null) invalid(`“${item.title}”的认知形成时间缺少明确排序值，请补充后再使用人物视角。`)
    if (formedAt.order > scope.storyOrder) invalid(`“${item.title}”的认知形成晚于所选故事时点，请移除该片段或调整时点。`)
    const state = cognitionStateAt(histories.get(item.sourceId) ?? [], scope.storyOrder)
    // 后继变化只用于限定有效区间；不展开后继的真相、关联事件或普通知识内容。
    if (!state || state.id !== item.sourceId) invalid(`“${item.title}”在所选故事时点已失效或被后继状态替代，请选择当时有效的认知片段。`)
    if (fields.evolution?.kind === 'forgotten' || fields.evolution?.kind === 'refuted') {
      invalid(`“${item.title}”记录的是遗忘或推翻，不能作为该人物仍持有的认知发送；如人物形成新认识，请追加修正状态。`)
    }
    // 隐瞒是主体的表达状态；保留其标记，不能抹去本人认知或推导他人已知。
    return { chunkId: item.chunkId, recordId: item.sourceId, revisionId: revision.id, formedAt,
      attitude: fields.attitude, concealed: fields.concealed }
  }
  // 身份只进入名称与固定修订，人物简介、别名和关联事件不随身份选择展开。
  return (evidence) => {
    const cognitions = evidence.map(cognition)
    return readStored(() => parseAiCharacterContext({ ...scope, personName: person.name, personRevisionId: identity.id, cognitions }))
  }
}

/** 资格来自固定认知修订，检索片段只负责提供待发送文本。 */
export function readAiCharacterContext(studio: StudioRepository, bookId: string, bookRevision: number,
  knowledgeRevision: number, scope: AiCharacterScope, evidence: MemoryEvidence[]): AiCharacterContext {
  return createAiCharacterContextReader(studio, bookId, bookRevision, knowledgeRevision, scope)(evidence)
}
