import type Database from 'better-sqlite3'
import { storedRunIds } from './stored-run-ids'
import { DomainError, requiredId, requiredText } from '../../contracts/api'
import { FORGE_INSTRUCTION_LIMIT, forgeUsesChapter, parseForgeAdoptInput, parseForgePrepareInput, parseForgeProposal, parseForgeReadInput, parseForgeRunInput,
  type ForgeAdoptInput, type ForgeAdoptReceipt, type ForgeCard, type ForgePrepareInput, type ForgeProposal, type ForgeReadInput, type ForgeRef, type ForgeRelationProposal, type ForgeRunDetail, type ForgeRunInput, type ForgeSnapshot } from '../../contracts/forge'
import { CHARACTER_ABILITIES, CHARACTER_PROFILE_FIELDS, type CharacterProfile } from '../../contracts/character-profile'
import type { AiRun } from '../../contracts/ai'
import { parseKnowledgeFields, resolveKnowledgeFields, type KnowledgeItemFields, type KnowledgeSourceInput } from '../../contracts/knowledge'
import { documentToText, parseManuscript } from '../../contracts/manuscript'
import { parseStoryFields } from '../../contracts/story'
import type { AiRepository } from '../ai/ai-repository'
import { KnowledgeRepository } from '../knowledge/knowledge-repository'
import { StoryRepository } from '../story/story-repository'
import type { StudioRepository } from '../storage/studio-repository'
import { forgeConflict, forgeEntity, forgeFailure, forgeInvalid, forgeJson, forgeReviewed, readForgePerson, requireForge } from './forge-state'

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function perform<T>(operation: () => T): T { try { return operation() } catch (error) { if (error instanceof DomainError) throw error; return forgeFailure() } }
function bookState(db: Database.Database, bookId: string) {
  const row = db.prepare('SELECT id, revision, knowledge_revision, archived_at FROM book_meta WHERE singleton = 1').get() as
    { id: string; revision: number; knowledge_revision: number; archived_at: string | null } | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || !Number.isSafeInteger(row.knowledge_revision)) return forgeFailure()
  return row
}
function writable(db: Database.Database, input: { bookId: string; expectedBookRevision: number }) {
  requireForge(db)
  const book = bookState(db, input.bookId)
  const meta = db.prepare('SELECT lifecycle FROM book_meta WHERE singleton = 1').get() as { lifecycle: string } | undefined
  if (!meta) return forgeFailure()
  if (book.archived_at || meta.lifecycle === 'kickstarting') throw new DomainError({ code: 'FORBIDDEN', message: '请进入已激活且未归档的作品后使用工坊。' })
  if (book.revision !== input.expectedBookRevision) return forgeConflict('作品已有新版本，请保留表单并重新读取资料。')
  return book
}
function sources(db: Database.Database, request: ForgePrepareInput, knowledgeRevision: number) {
  const entities = request.entityIds.map((id) => forgeEntity(db, request.bookId, id, knowledgeRevision))
  if (entities.some((entity) => !forgeReviewed(entity.fields))) return forgeInvalid('选入的实体须已采用、标记为当前，并完成冲突复核。')
  if (request.kind === 'audition') {
    const person = readForgePerson(db, request.bookId, request.personId!, request.storyOrder, knowledgeRevision)
    if (!forgeReviewed(person.entity.fields)) return forgeInvalid('试戏人物须先采用并完成复核。')
    let profile: { revisionId: string; values: CharacterProfile } | null = null
    if (request.profileRevisionId) {
      const row = db.prepare('SELECT fields_json FROM knowledge_item_revisions WHERE item_id = ? AND id = ? AND knowledge_revision <= ?')
        .get(request.personId, request.profileRevisionId, knowledgeRevision) as { fields_json: string } | undefined
      if (!row) return forgeInvalid('所选人物档案修订不存在于本次固定版本中。')
      const fields = parseKnowledgeFields(forgeJson(row.fields_json)), values: CharacterProfile = {}
      if (fields.kind !== 'person') return forgeInvalid('这份历史修订不是人物档案。')
      for (const key of request.traitFields) {
        if (!fields.characterProfile?.[key]) return forgeInvalid('所选历史档案中该字段为空，请取消选择或换用明确的版本。')
        values[key] = fields.characterProfile[key]
      }
      profile = { revisionId: request.profileRevisionId, values }
    }
    const cognitions = request.cognitionIds.map((id) => {
      const item = person.cognitions.find((value) => value.id === id)
      if (!item?.usable) return forgeInvalid('所选认知不属于该人物，或在所选时点无效、未知、遗忘、推翻或尚未复核。')
      const { id: recordId, revisionId, title, description, attitude, concealed, formedAt } = item
      return { id: recordId, revisionId, title, description, attitude, concealed, formedAt }
    })
    const states = request.stateIds.map((id) => {
      const item = person.states.find((value) => value.id === id)
      if (!item?.usable) return forgeInvalid('所选状态不是该时点可用的最后状态，或有同属性冲突。')
      return item
    })
    return { entities: [], person: { id: person.entity.id, revisionId: person.entity.revisionId, name: person.entity.fields.name },
      profile, storyOrder: request.storyOrder, cognitions, states }
  }
  const person = request.personId ? forgeEntity(db, request.bookId, request.personId, knowledgeRevision) : null
  if (person && (person.fields.kind !== 'person' || !forgeReviewed(person.fields))) return forgeInvalid('目标须是已采用且完成复核的人物。')
  return { entities, person, profile: null, storyOrder: null, cognitions: [], states: [] }
}
function envelope(db: Database.Database, request: ForgePrepareInput, knowledgeRevision: number, preparing = false) {
  let reference: { runId: string; contextHash: string; text: string } | null = null
  if (request.referenceRunId) {
    const row = db.prepare(`SELECT a.context_hash, a.output_text, a.state FROM forge_runs f JOIN ai_runs a ON a.id = f.run_id
      WHERE f.run_id = ? AND f.kind = 'world' AND a.book_id = ?`).get(request.referenceRunId, request.bookId) as
      { context_hash: string; output_text: string; state: string } | undefined
    if (!row || !(preparing ? ['succeeded', 'adopted'] : ['succeeded', 'adopted', 'rejected']).includes(row.state) || !row.output_text.trim() || row.output_text.length > 40000) return forgeInvalid('接续来源须是本书已完成、且不超过四万字符的世界提案。')
    reference = { runId: request.referenceRunId, contextHash: row.context_hash, text: row.output_text }
  }
  const existingNames = request.kind === 'names' || request.kind === 'cast' ? db.prepare(`SELECT json_extract(r.fields_json, '$.name') AS name,
    json_extract(r.fields_json, '$.aliases') AS aliases_json FROM knowledge_item_revisions r
    WHERE r.knowledge_revision <= ? AND NOT EXISTS (SELECT 1 FROM knowledge_item_revisions newer
      WHERE newer.item_id = r.item_id AND newer.knowledge_revision > r.knowledge_revision AND newer.knowledge_revision <= ?) ORDER BY r.item_id LIMIT 1001`)
    .all(knowledgeRevision, knowledgeRevision) as { name: string; aliases_json: string }[] : []
  if (existingNames.length > 1000) return forgeInvalid('全书避名检查超过本次一千实体范围，请在设定库核对名字，或使用指定人物补全。')
  const excludedNames = [...new Set([...request.excludedNames, ...existingNames.flatMap((row) => {
    const aliases = forgeJson(row.aliases_json)
    if (!Array.isArray(aliases) || aliases.length > 50) return forgeFailure()
    return [requiredText(row.name, '既有名称', 120), ...aliases.map((alias) => requiredText(alias, '既有别名', 120))]
  })])]
  return { workflow: 'forge-v1', kind: request.kind, goal: request.instruction, requestedCount: request.count,
    excludedNames, reference, sources: sources(db, request, knowledgeRevision) }
}
type Envelope = ReturnType<typeof envelope>
function output(run: AiRun): ForgeProposal {
  if (run.outputText.length > 60000) return forgeInvalid('工坊输出超过六万字符，原始输出已保留。')
  let value: unknown
  try { value = JSON.parse(run.outputText) } catch { return forgeInvalid('模型未返回完整 JSON 提案；原文已保留，可按原文核对后重新生成。') }
  return parseForgeProposal(value)
}
function validateProposal(proposal: ForgeProposal, request: ForgePrepareInput, run: AiRun, original?: ForgeProposal): void {
  if (proposal.kind !== request.kind || original && proposal.kind !== original.kind) return forgeInvalid('候选类型与固定请求不符。')
  const entries = proposal.kind === 'names' ? proposal.names : proposal.kind === 'relations' ? proposal.relations : proposal.cards
  if (!entries.length && proposal.kind !== 'relations') return forgeInvalid('模型返回了空候选。')
  if (proposal.kind === 'names') {
    if (proposal.names.length !== request.count * 3) return forgeInvalid('名字候选数量不符合本次组数。')
    if (proposal.names.some((item) => request.excludedNames.includes(item.name))) return forgeInvalid('名字候选包含本次避用名称，请修改要求后重新生成。')
    return
  }
  if ('cards' in proposal && (proposal.cards.some((card) => (request.kind !== 'world' && card.kind !== 'person') || (request.kind === 'world' && card.kind === 'person')) ||
    (!original && proposal.cards.length !== (request.kind === 'fill' || request.kind === 'extract' ? 1 : request.count)))) return forgeInvalid('卡片类型或数量不符合本次范围。')
  if (!original && proposal.kind === 'cast' && proposal.cards.some((card) => CHARACTER_PROFILE_FIELDS.some((key) => !card.profile?.[key]?.trim()))) return forgeInvalid('角色班底缺少完整八维文字档案，原始输出已保留。')
  for (const item of proposal.kind === 'relations' ? proposal.relations : proposal.cards) {
    if (forgeUsesChapter(request.kind) ? item.citations.length === 0 : item.citations.length !== 0) return forgeInvalid('正文提炼须保留引文；创建设定不能伪造正文引文。')
    for (const citation of item.citations) {
      const block = run.context.chapterBlocks.find((part) => part.blockId === citation.blockId)
      if (!block || !block.text.includes(citation.quote)) return forgeInvalid('引文须逐字匹配本次固定正文中的同一段落。')
    }
    if ('fromEntityId' in item && (!request.entityIds.includes(item.fromEntityId) || !request.entityIds.includes(item.toEntityId))) return forgeInvalid('关系端点只能使用本次明确选入的实体。')
    if (original && original.kind !== 'names') {
      const previous = (original.kind === 'relations' ? original.relations : original.cards).find((value) => value.key === item.key)
      if (!previous || !same(previous.citations, item.citations) || 'fromEntityId' in item && (!('fromEntityId' in previous) || previous.fromEntityId !== item.fromEntityId || previous.toEntityId !== item.toEntityId)) return forgeInvalid('采用须保留原候选身份、关系端点与引文。')
    }
  }
}
/** 补全只能填空；作者已写的档案、名称和说明不会被模型覆盖。 */
function filledFields(previous: KnowledgeItemFields, card: { name: string; summary: string; profile?: CharacterProfile }): KnowledgeItemFields {
  if (card.name !== previous.name) return forgeInvalid('补全须保留目标人物原名。')
  const profile: CharacterProfile = { ...previous.characterProfile }, abilities = { ...profile.abilities }
  for (const key of CHARACTER_PROFILE_FIELDS) if (!profile[key]?.trim() && card.profile?.[key]) profile[key] = card.profile[key]
  for (const key of CHARACTER_ABILITIES) {
    const value = card.profile?.abilities?.[key]
    if (abilities[key] === undefined && value !== undefined) abilities[key] = value
  }
  if (Object.keys(abilities).length) profile.abilities = abilities
  const fields = resolveKnowledgeFields(parseKnowledgeFields({ ...previous, summary: previous.summary.trim() ? previous.summary : card.summary, characterProfile: profile }))
  if (same(fields, previous)) return forgeInvalid('所选候选没有可填入的空白内容；已写字段保持原值。')
  return { ...fields, conflictState: 'unchecked' }
}
function cardFields(card: ForgeCard): KnowledgeItemFields {
  return resolveKnowledgeFields(parseKnowledgeFields({ kind: card.kind, name: card.name, aliases: [], summary: card.summary, nature: 'author_setting',
    authorDecision: 'adopted', freshness: 'current', conflictState: 'unchecked', ...(card.profile ? { characterProfile: card.profile } : {}) }))
}
function relationFields(relation: ForgeRelationProposal) {
  return { kind: 'relation' as const, title: relation.relationType, description: relation.description, nature: relation.nature,
    authorDecision: 'adopted' as const, freshness: 'current' as const, conflictState: 'unchecked' as const, disclosure: { state: 'unknown' as const },
    fromEntityId: relation.fromEntityId, toEntityId: relation.toEntityId, relationType: relation.relationType, direction: relation.direction, layer: relation.layer,
    validFrom: relation.validFrom, validUntil: relation.validUntil, startEventId: null, endEventId: null }
}

export class ForgeRepository {
  constructor(private readonly studio: StudioRepository, private readonly ai: AiRepository) {}

  get(input: ForgeReadInput): ForgeSnapshot {
    const data = parseForgeReadInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => {
        const book = bookState(db, data.bookId), schemaVersion = db.pragma('user_version', { simple: true }) as number
        const result: ForgeSnapshot = { bookId: data.bookId, bookRevision: book.revision, knowledgeRevision: book.knowledge_revision, schemaVersion, requiresUpgrade: schemaVersion < 17,
          entities: [], entityTotal: 0, person: null, runs: [], auditionRuns: [] }
        if (schemaVersion < 17) return result
        result.entityTotal = (db.prepare('SELECT COUNT(*) AS count FROM knowledge_items').get() as { count: number }).count
        result.entities = db.prepare('SELECT id, name, kind FROM knowledge_items ORDER BY kind, name, id LIMIT 200').all() as ForgeSnapshot['entities']
        if (data.personId) result.person = readForgePerson(db, data.bookId, data.personId, data.storyOrder, book.knowledge_revision)
        result.runs = db.prepare(`SELECT f.run_id AS id, f.kind, a.state, f.created_at AS createdAt FROM forge_runs f JOIN ai_runs a ON a.id = f.run_id
          WHERE a.book_id = ? ORDER BY a.sequence DESC LIMIT 30`).all(data.bookId) as ForgeSnapshot['runs']
        // 人物台词不受全书任务历史窗口影响，身份以不可变的准备请求为准。
        if (data.personId) result.auditionRuns = db.prepare(`SELECT f.run_id AS id, a.state, f.created_at AS createdAt
          FROM forge_runs f JOIN ai_runs a ON a.id = f.run_id
          WHERE a.book_id = ? AND f.kind = 'audition' AND a.state IN ('succeeded', 'adopted')
            AND json_extract(f.request_json, '$.personId') = ?
          ORDER BY a.sequence DESC LIMIT 2`).all(data.bookId, data.personId) as ForgeSnapshot['auditionRuns']
        return result
      })()
    })
  }

  prepare(input: ForgePrepareInput): ForgeRunDetail {
    const data = parseForgePrepareInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => {
        const book = writable(db, data)
        const chapter = this.studio.readChapter({ bookId: data.bookId, chapterId: data.chapterId })
        const instruction = JSON.stringify(envelope(db, data, book.knowledge_revision, true))
        if (instruction.length > FORGE_INSTRUCTION_LIMIT) return forgeInvalid('固定资料超过工坊预算，请减少选项或缩短要求；资料未被截断。')
        const connection = this.ai.listConnections({ bookId: data.bookId }).connections.find((item) => item.id === data.connectionId)
        if (!connection) return forgeInvalid('请先保存本书的模型连接。')
        const run = this.ai.prepare({ bookId: data.bookId, chapterId: chapter.id, expectedBookRevision: book.revision, expectedKnowledgeRevision: book.knowledge_revision,
          expectedRevisionId: chapter.revisionId, connectionId: connection.id, connection, kind: 'plan', purpose: 'forge', instruction,
          contextScope: 'chapter', selectedBlockIds: [], memoryChunkIds: [] })
        db.prepare('INSERT INTO forge_runs (run_id, kind, request_json, envelope_json, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(run.id, data.kind, JSON.stringify(data), instruction, new Date().toISOString())
        return { bookId: data.bookId, request: data, run, proposal: null, parseError: null, adopted: false }
      }).immediate()
    })
  }

  getRun(input: ForgeRunInput): ForgeRunDetail {
    const data = parseForgeRunInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => {
        const { run, request, fixed } = this.readRun(db, data.bookId, data.runId)
        let proposal: ForgeProposal | null = null, parseError: string | null = null
        if (request.kind !== 'audition' && ['succeeded', 'adopted'].includes(run.state)) {
          try {
            const original = output(run); validateProposal(original, request, run)
            if (original.kind === 'names' && original.names.some((item) => fixed.excludedNames.some((name) => name.normalize('NFKC').toLowerCase() === item.name.normalize('NFKC').toLowerCase()))) return forgeInvalid('模型名字与既有名字、别名或避用名称重复，原始输出已保留。')
            proposal = run.state === 'adopted' ? parseForgeProposal(forgeJson(run.acceptedText)) : original
            validateProposal(proposal, request, run, original)
          } catch (error) { proposal = null; parseError = error instanceof DomainError ? error.detail.message : '工坊提案无法解析，原文已保留。' }
        }
        return { bookId: data.bookId, request, run, proposal, parseError, adopted: Boolean(db.prepare('SELECT 1 FROM forge_receipts WHERE run_id = ?').get(run.id)) }
      })()
    })
  }

  adopt(input: ForgeAdoptInput): ForgeAdoptReceipt {
    const data = parseForgeAdoptInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      try {
        const refs = db.transaction(() => {
          requireForge(db)
          const acceptedJson = JSON.stringify(data.proposal), existing = db.prepare('SELECT accepted_json, refs_json FROM forge_receipts WHERE run_id = ?').get(data.runId) as
            { accepted_json: string; refs_json: string } | undefined
          if (existing) {
            if (existing.accepted_json !== acceptedJson) return forgeConflict('该候选已采用其他内容，请查看原回执。')
            const { run } = this.readRun(db, data.bookId, data.runId)
            if (run.state !== 'adopted' || run.acceptedText !== existing.accepted_json) return forgeFailure('工坊采用状态与回执无法对应。')
            return this.readRefs(existing.refs_json)
          }
          const book = writable(db, data), { run, request } = this.readRun(db, data.bookId, data.runId)
          if (run.state !== 'succeeded' || run.version !== data.expectedRunVersion || book.revision !== run.context.bookRevision || book.knowledge_revision !== run.context.knowledgeRevision) return forgeConflict('候选、作品或设定已有新版本，请重新读取并预览。')
          if (this.studio.readChapter({ bookId: data.bookId, chapterId: run.chapterId }).revisionId !== run.context.chapterRevisionId) return forgeConflict('作为来源的章节已经变化。')
          const original = output(run); validateProposal(original, request, run); validateProposal(data.proposal, request, run, original)
          const result: ForgeRef[] = [], knowledge = new KnowledgeRepository(this.studio), story = new StoryRepository(this.studio)
          let revision = book.knowledge_revision
          const source = (key: string, citations: { blockId: string; quote: string }[]): KnowledgeSourceInput[] => [
            { sourceType: 'author_input', bookId: data.bookId, quote: `作者采纳工坊提案 ${run.id}，候选 ${key}。` },
            ...citations.map((citation) => ({ sourceType: 'chapter_text' as const, bookId: data.bookId, chapterId: run.chapterId, revisionId: run.context.chapterRevisionId, ...citation })) ]
          if (data.proposal.kind === 'names') return forgeInvalid('名字与试戏文本仅供复制，不直接写入设定。')
          if (data.proposal.kind === 'relations') for (const relation of data.proposal.relations) {
            const saved = story.createRecordWithSources({ bookId: data.bookId, expectedKnowledgeRevision: revision, fields: relationFields(relation) }, source(relation.key, relation.citations))
            revision = saved.knowledgeRevision; result.push({ key: relation.key, kind: 'relation', id: saved.id, revisionId: saved.revisions[0]!.id })
          }
          else for (const card of data.proposal.cards) {
            const filling = request.kind === 'fill' || request.kind === 'extract'
            let fields: KnowledgeItemFields
            if (filling) fields = filledFields(forgeEntity(db, data.bookId, request.personId!, book.knowledge_revision).fields, card)
            else {
              const duplicate = db.prepare(`SELECT 1 FROM knowledge_items i WHERE i.name = ? COLLATE NOCASE OR EXISTS
                (SELECT 1 FROM json_each(i.aliases_json) alias WHERE alias.value = ? COLLATE NOCASE) LIMIT 1`).get(card.name, card.name)
              if (duplicate || request.excludedNames.includes(card.name)) return forgeInvalid('卡片名称与本书既有名称或避用名称重复，请编辑后再采用。')
              fields = cardFields(card)
            }
            const saved = filling ? knowledge.updateItemWithSources({ bookId: data.bookId, expectedKnowledgeRevision: revision, id: request.personId!, fields },
              forgeEntity(db, data.bookId, request.personId!, book.knowledge_revision).revisionId, source(card.key, card.citations))
              : knowledge.createItemWithSources({ bookId: data.bookId, expectedKnowledgeRevision: revision, fields }, source(card.key, card.citations))
            revision = saved.knowledgeRevision; result.push({ key: card.key, kind: 'knowledge', id: saved.id, revisionId: saved.revisions[0]!.id })
          }
          const now = new Date().toISOString(), changed = db.prepare(`UPDATE ai_runs SET state = 'adopted', version = version + 1, accepted_text = ?, adopted_revision_id = ?, updated_at = ?
            WHERE id = ? AND state = 'succeeded' AND version = ?`).run(acceptedJson, run.context.chapterRevisionId, now, run.id, run.version)
          if (changed.changes !== 1) return forgeConflict('候选已有新状态，本次采用已回滚。')
          db.prepare('INSERT INTO forge_receipts (run_id, accepted_json, refs_json, created_at) VALUES (?, ?, ?, ?)').run(run.id, acceptedJson, JSON.stringify(result), now)
          return result
        }).immediate()
        return { bookId: data.bookId, runId: data.runId, refs, book: this.studio.getBook({ bookId: data.bookId }) }
      } finally { this.studio.refreshKnowledgeCatalog(data.bookId) }
    })
  }

  validateBook(bookId: string): void {
    const db = this.studio.getMemoryDatabase(bookId)
    if ((db.pragma('user_version', { simple: true }) as number) < 17) return
    if (db.prepare(`SELECT 1 FROM ai_runs a WHERE json_extract(a.context_json, '$.purpose') = 'forge'
      AND NOT EXISTS (SELECT 1 FROM forge_runs f WHERE f.run_id = a.id) LIMIT 1`).get()) return forgeFailure('工坊模型记录缺少固定来源。')
    for (const runId of storedRunIds(db, 'forge_runs')) {
      const { run, request } = this.readRun(db, bookId, runId)
      const chapter = db.prepare('SELECT document_json FROM chapter_revisions WHERE chapter_id = ? AND id = ?').get(run.chapterId, run.context.chapterRevisionId) as { document_json: string } | undefined
      if (!chapter) return forgeFailure()
      const document = parseManuscript(forgeJson(chapter.document_json))
      const blocks = document.content.map((block) => {
        const text = documentToText({ type: 'doc', content: [block] })
        return { blockId: block.attrs.id, startOffset: 0, endOffset: text.length, text }
      })
      if (run.context.originalText !== '' || !same(run.context.chapterBlocks, forgeUsesChapter(request.kind) ? blocks : [])) return forgeFailure('工坊固定章稿与来源修订不一致。')
      const receipt = db.prepare('SELECT accepted_json, refs_json FROM forge_receipts WHERE run_id = ?').get(run.id) as { accepted_json: string; refs_json: string } | undefined
      if ((run.state === 'adopted') !== Boolean(receipt)) return forgeFailure('工坊终态与采用回执不一致。')
      if (!receipt) continue
      const original = output(run), accepted = parseForgeProposal(forgeJson(receipt.accepted_json))
      validateProposal(original, request, run); validateProposal(accepted, request, run, original)
      const refs = this.readRefs(receipt.refs_json)
      if (accepted.kind === 'names' || run.acceptedText !== JSON.stringify(accepted) || run.acceptedText !== receipt.accepted_json || run.adoptedRevisionId !== run.context.chapterRevisionId) return forgeFailure()
      const entries = accepted.kind === 'relations' ? accepted.relations : accepted.cards
      if (refs.length !== entries.length || refs.some((ref, index) => ref.key !== entries[index]!.key || ref.kind !== (accepted.kind === 'relations' ? 'relation' : 'knowledge'))) return forgeFailure()
      for (const ref of refs) {
        if (ref.kind === 'knowledge') {
          const row = db.prepare('SELECT fields_json FROM knowledge_item_revisions WHERE item_id = ? AND id = ?').get(ref.id, ref.revisionId) as { fields_json: string } | undefined
          if (!row || !('cards' in accepted)) return forgeFailure()
          const card = accepted.cards.find((item) => item.key === ref.key)!, fields = parseKnowledgeFields(forgeJson(row.fields_json))
          const expected = request.personId ? filledFields(forgeEntity(db, bookId, request.personId, run.context.knowledgeRevision).fields, card) : cardFields(card)
          if (!same(fields, expected) || request.personId && ref.id !== request.personId) return forgeFailure('工坊卡片回执与采用内容不一致。')
        } else {
          const row = db.prepare('SELECT fields_json FROM story_record_revisions WHERE record_id = ? AND id = ?').get(ref.id, ref.revisionId) as { fields_json: string } | undefined
          if (!row || accepted.kind !== 'relations') return forgeFailure()
          const relation = accepted.relations.find((item) => item.key === ref.key)!, fields = parseStoryFields(forgeJson(row.fields_json), bookId)
          if (!same(fields, parseStoryFields(relationFields(relation), bookId))) return forgeFailure('工坊关系回执与采用内容不一致。')
        }
        const entry = entries.find((item) => item.key === ref.key)!, authorQuote = `作者采纳工坊提案 ${run.id}，候选 ${ref.key}。`
        const author = ref.kind === 'knowledge' ? db.prepare("SELECT 1 FROM knowledge_sources WHERE item_id = ? AND source_type = 'author_input' AND quote = ?").get(ref.id, authorQuote)
          : db.prepare("SELECT 1 FROM story_sources WHERE record_id = ? AND source_type = 'author_input' AND quote = ?").get(ref.id, authorQuote)
        if (!author) return forgeFailure('工坊采用回执缺少作者确认来源。')
        for (const citation of entry.citations) {
          const params = [ref.id, run.chapterId, run.context.chapterRevisionId, citation.blockId, citation.quote]
          const found = ref.kind === 'knowledge' ? db.prepare("SELECT 1 FROM knowledge_sources WHERE item_id = ? AND source_type = 'chapter_text' AND chapter_id = ? AND revision_id = ? AND block_id = ? AND quote = ?").get(...params)
            : db.prepare("SELECT 1 FROM story_sources WHERE record_id = ? AND source_type = 'chapter_text' AND chapter_id = ? AND revision_id = ? AND block_id = ? AND quote = ?").get(...params)
          if (!found) return forgeFailure('工坊采用回执缺少对应的固定正文引文。')
        }
      }
    }
  }

  private readRefs(json: string): ForgeRef[] {
    const refs = forgeJson(json) as ForgeRef[]
    if (!Array.isArray(refs) || !refs.length || refs.length > 10 || new Set(refs.map((ref) => ref.key)).size !== refs.length || new Set(refs.map((ref) => `${ref.kind}:${ref.id}`)).size !== refs.length) return forgeFailure()
    for (const ref of refs) { requiredId(ref.id); requiredId(ref.revisionId); if (!['knowledge', 'relation'].includes(ref.kind) || !/^[a-z0-9_-]{1,40}$/.test(ref.key)) return forgeFailure() }
    return refs
  }

  private readRun(db: Database.Database, bookId: string, runId: string): { run: AiRun; request: ForgePrepareInput; fixed: Envelope } {
    requireForge(db)
    const row = db.prepare('SELECT kind, request_json, envelope_json FROM forge_runs WHERE run_id = ?').get(runId) as { kind: string; request_json: string; envelope_json: string } | undefined
    if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '本书中不存在这个工坊任务。' })
    const request = parseForgePrepareInput(forgeJson(row.request_json)), run = this.ai.get({ bookId, runId })
    if (request.bookId !== bookId || request.kind !== row.kind || request.chapterId !== run.chapterId || request.connectionId !== run.context.connection.id || request.expectedBookRevision !== run.context.bookRevision ||
      run.context.purpose !== 'forge' || run.kind !== 'plan' || run.context.instruction !== row.envelope_json || row.envelope_json.length > FORGE_INSTRUCTION_LIMIT) return forgeFailure()
    if (JSON.stringify(request) !== row.request_json || request.referenceRunId && !db.prepare('SELECT 1 FROM ai_runs earlier JOIN ai_runs target ON target.id = ? WHERE earlier.id = ? AND earlier.sequence < target.sequence')
      .get(runId, request.referenceRunId)) return forgeFailure('工坊任务引用顺序或固定请求无效。')
    const fixed = envelope(db, request, run.context.knowledgeRevision)
    if (JSON.stringify(fixed) !== row.envelope_json) return forgeFailure('工坊固定资料与历史修订无法对应。')
    return { request, run, fixed }
  }
}
