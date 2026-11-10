import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, type BookInput, type BookMutationInput } from '../../contracts/api'
import { LIVING_INSTRUCTION_LIMIT, LIVING_SCHEMA_VERSION, LIVING_SNAPSHOT_BYTES,
  parseLivingAdoptInput, parseLivingPrepareInput, parseLivingProposal, parseLivingRunInput, parseLivingWritingContext, parseOutlineFields,
  parseOutlineHistoryInput, parseRestoreOutlineInput, parseSaveOutlineInput, parseMemoryArchiveInput,
  type LivingAdoptInput, type LivingAdoptReceipt, type LivingOutline, type LivingPrepareInput, type LivingProposal,
  type LivingRunDetail, type LivingRunInput, type LivingSnapshot, type MemoryProposal, type OutlineFields,
   type OutlineHistoryInput, type OutlineHistoryPage, type RestoreOutlineInput, type SaveOutlineInput, type MemoryArchiveInput, type MemoryArchivePage } from '../../contracts/living'
import type { AiRun } from '../../contracts/ai'
import { documentToText, emptyDocument, parseManuscript } from '../../contracts/manuscript'
import { parseKnowledgeFields } from '../../contracts/knowledge'
import { parseInspirationFields, parseWritingBrief, type WritingBrief } from '../../contracts/workbench'
import type { AiRepository } from '../ai/ai-repository'
import type { StudioRepository } from '../storage/studio-repository'
import { chapterToken, currentOutlineNodes, livingConflict, livingFailure, parseChapterToken, readMemoryBatch,
  requireLiving, storedJson, type LivingDependency } from './living-state'

interface BookState { id: string; revision: number; knowledge_revision: number; archived_at: string | null; lifecycle: string; logline: string }
interface LivingEnvelope {
  workflow: 'living-v1'; kind: LivingPrepareInput['kind']; goal: string; requestedCount: number
  targets: LivingOutline[]; sources: { outlines: LivingOutline[]; memories: ReturnType<typeof readMemoryBatch>[];
    entities: { id: string; name: string; kind: string; nature: string; summary: string; revisionId: string }[]; brief?: WritingBrief & { revision: number } }
  dependencies: LivingDependency[]
}
function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function perform<T>(operation: () => T): T { try { return operation() } catch (error) { if (error instanceof DomainError) throw error; return livingFailure() } }
function bookState(db: Database.Database, bookId: string): BookState {
  const book = db.prepare('SELECT id, revision, knowledge_revision, archived_at, lifecycle, logline FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!book || book.id !== bookId || !Number.isSafeInteger(book.revision) || !Number.isSafeInteger(book.knowledge_revision)) return livingFailure()
  return book
}
function writable(db: Database.Database, input: BookMutationInput): BookState {
  requireLiving(db)
  const book = bookState(db, input.bookId)
  if (book.archived_at || book.lifecycle === 'kickstarting') throw new DomainError({ code: 'FORBIDDEN', message: '请进入已激活且未归档的作品后继续创作。' })
  if (book.revision !== input.expectedBookRevision) return livingConflict('作品已有新版本，请保留当前表单并重新读取。')
  if (book.revision >= Number.MAX_SAFE_INTEGER) return livingFailure()
  return book
}
function parseOutput(run: AiRun): LivingProposal {
  if (run.outputText.length > 60000) return invalid('提案超过读取上限，原始输出已保留。')
  let value: unknown
  try { value = JSON.parse(run.outputText) } catch { return invalid('模型未返回完整 JSON 对象。原文已保留，可重新生成。') }
  return parseLivingProposal(value)
}
function validateMemory(proposal: MemoryProposal, run: AiRun, envelope: LivingEnvelope): void {
  const entities = new Set(envelope.sources.entities.filter((entity) => entity.kind === 'person').map((entity) => entity.id))
  for (const item of [proposal.summary, ...proposal.events, ...proposal.states]) for (const citation of item.citations) {
    const block = run.context.chapterBlocks.find((part) => part.blockId === citation.blockId)
    if (!block || !block.text.includes(citation.quote)) invalid('记忆引文必须逐字匹配这次固定定稿的同一段落。')
  }
  if (proposal.states.some((state) => !entities.has(state.entityId))) invalid('人物状态只能引用本次明确选入的人物实体。')
}
function validateProposal(proposal: LivingProposal, run: AiRun, request: LivingPrepareInput, envelope: LivingEnvelope): void {
  if (proposal.kind !== request.kind) invalid('模型提案类型与本次请求不符。')
  if (proposal.kind === 'memory') validateMemory(proposal, run, envelope)
  else if (proposal.chapters.some((chapter) => chapter.fields.beatSource !== undefined)) invalid('节拍来源须由作者从全局卡片明确选择，模型不能自行登记引用。')
  else if (proposal.kind === 'expand' ? proposal.chapters.length !== request.count
    : proposal.chapters.length !== request.targetIds.length || proposal.chapters.some((chapter) => !request.targetIds.includes(chapter.chapterId!))) invalid('提案章节数量或修纲范围与固定请求不符。')
}
function sameCitations(left: { citations: unknown }, right: { citations: unknown }): boolean { return JSON.stringify(left.citations) === JSON.stringify(right.citations) }
function checkedEnvelope(value: unknown, request: LivingPrepareInput): LivingEnvelope {
  if (!isRecord(value) || Object.keys(value).some((key) => !['workflow', 'kind', 'goal', 'requestedCount', 'targets', 'sources', 'dependencies'].includes(key)) ||
    value.workflow !== 'living-v1' || value.kind !== request.kind || value.goal !== request.instruction || value.requestedCount !== request.count ||
    !Array.isArray(value.targets) || value.targets.length > 10 || !isRecord(value.sources) ||
    Object.keys(value.sources).some((key) => !['outlines', 'memories', 'entities', 'brief'].includes(key)) ||
    !Array.isArray(value.sources.outlines) || value.sources.outlines.length > 5 || !Array.isArray(value.sources.entities) || value.sources.entities.length > 30 ||
    !Array.isArray(value.dependencies) || value.dependencies.length > 80) return livingFailure('固定创作资料的结构或范围不符。')
  const outline = (item: unknown, allowStale: boolean): LivingOutline => {
    if (!isRecord(item) || typeof item.stale !== 'boolean' || (!allowStale && item.stale) ||
      (item.staleReason !== null && (typeof item.staleReason !== 'string' || item.staleReason.length > 500))) return livingFailure()
    const parsed = parseLivingWritingContext({ version: 1, outlines: [{ ...item, stale: false, staleReason: null }], memories: [] }).outlines[0]!
    return { ...parsed, stale: item.stale, staleReason: item.staleReason as string | null }
  }
  const targets = value.targets.map((item) => outline(item, true))
  if (targets.length !== request.targetIds.length || targets.some((item) => item.scope !== 'chapter' || !request.targetIds.includes(item.id)) || new Set(targets.map((item) => item.id)).size !== targets.length) return livingFailure()
  const outlines = value.sources.outlines.map((item) => outline(item, false))
  const memories = parseLivingWritingContext({ version: 1, outlines: [], memories: value.sources.memories }).memories
  const entities = value.sources.entities.map((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) => !['id', 'name', 'kind', 'nature', 'summary', 'revisionId'].includes(key))) return livingFailure()
    return { id: requiredId(item.id).toLowerCase(), name: requiredText(item.name, '实体名称', 120), kind: requiredText(item.kind, '实体类型', 50),
      nature: requiredText(item.nature, '知识性质', 50), summary: optionalText(item.summary, '实体说明', 8000), revisionId: requiredId(item.revisionId).toLowerCase() }
  })
  if (entities.length !== request.entityIds.length || entities.some((item, index) => item.id !== request.entityIds[index])) return livingFailure()
  let brief: LivingEnvelope['sources']['brief']
  if (value.sources.brief !== undefined) {
    if (!isRecord(value.sources.brief)) return livingFailure()
    const { revision, ...fields } = value.sources.brief
    brief = { ...parseWritingBrief(fields), revision: requiredInteger(revision, '创作约定版本') }
  }
  if (request.kind === 'memory' && (outlines.length || memories.length || brief)) return livingFailure('单章整理不能混入计划或其他章节记忆。')
  if (request.kind !== 'memory' && !brief) return livingFailure('演进提案缺少固定创作约定。')
  const dependencies = value.dependencies.map((item): LivingDependency => {
    if (!isRecord(item) || Object.keys(item).some((key) => !['kind', 'id', 'revision'].includes(key)) || !['chapter', 'knowledge', 'outline', 'memory', 'brief'].includes(String(item.kind))) return livingFailure()
    return { kind: item.kind as LivingDependency['kind'], id: requiredId(item.id).toLowerCase(), revision: requiredText(item.revision, '来源版本', 1000) }
  })
  if (new Set(dependencies.map((item) => `${item.kind}:${item.id}`)).size !== dependencies.length) return livingFailure()
  const declared = [...outlines.map((node) => ({ kind: 'outline', id: node.id, revision: node.revisionId })),
    ...memories.map((memory) => ({ kind: 'memory', id: memory.id, revision: memory.id })),
    ...entities.map((entity) => ({ kind: 'knowledge', id: entity.id, revision: entity.revisionId })),
    ...(brief ? [{ kind: 'brief', id: request.bookId, revision: String(brief.revision) }] : [])]
  if (declared.some((source) => !dependencies.some((dependency) => dependency.kind === source.kind && dependency.id === source.id && dependency.revision === source.revision)) ||
    !dependencies.some((dependency) => dependency.kind === 'chapter' && dependency.id === request.chapterId)) return livingFailure('固定资料缺少完整来源依赖。')
  return { workflow: 'living-v1', kind: request.kind, goal: request.instruction, requestedCount: request.count,
    targets, sources: { outlines, memories, entities, ...(brief ? { brief } : {}) }, dependencies }
}
function validateSelection(accepted: LivingProposal, original: LivingProposal): void {
  if (accepted.kind !== original.kind) invalid('不能改变提案类型。')
  if (accepted.kind !== 'memory' || original.kind !== 'memory') return
  if (!sameCitations(accepted.summary, original.summary)) invalid('摘要编辑必须保留原始引文。')
  const eventIndices = new Set<number>(), stateIndices = new Set<number>()
  for (const event of accepted.events) {
    const index = original.events.findIndex((item, position) => !eventIndices.has(position) && sameCitations(event, item))
    if (index < 0) invalid('事件选择必须来自本次原始提案，并保留引文。')
    eventIndices.add(index)
  }
  for (const state of accepted.states) {
    const index = original.states.findIndex((item, position) => !stateIndices.has(position) && item.entityId === state.entityId && item.attribute === state.attribute && sameCitations(state, item))
    if (index < 0) invalid('状态选择必须保留原始实体、属性和引文。')
    stateIndices.add(index)
  }
}

export class LivingRepository {
  constructor(private readonly studio: StudioRepository, private readonly ai: AiRepository) {}

  get(input: BookInput): LivingSnapshot {
    return perform(() => {
      const bookId = requiredId(input.bookId).toLowerCase(), db = this.studio.getMemoryDatabase(bookId)
      return db.transaction(() => this.snapshot(db, bookId))()
    })
  }

  archive(input: MemoryArchiveInput): MemoryArchivePage {
    const data = parseMemoryArchiveInput(input), db = this.studio.getMemoryDatabase(data.bookId)
    return perform(() => db.transaction(() => {
      requireLiving(db)
      const book = bookState(db, data.bookId)
      if (data.chapterId && !db.prepare('SELECT 1 FROM chapters WHERE id = ?').get(data.chapterId)) invalid('归档章节不属于本书。')
      const before = data.beforeId ? db.prepare('SELECT id, chapter_id, created_at FROM living_memory_batches WHERE id = ?').get(data.beforeId) as { id: string; chapter_id: string; created_at: string } | undefined : undefined
      if (data.beforeId && (!before || data.chapterId && before.chapter_id !== data.chapterId)) invalid('归档分页来源不属于所选范围，请重新读取。')
      const total = (db.prepare('SELECT COUNT(*) AS count FROM living_memory_batches WHERE (? IS NULL OR chapter_id = ?)').get(data.chapterId ?? null, data.chapterId ?? null) as { count: number }).count
      const rows = db.prepare(`SELECT id FROM living_memory_batches WHERE (? IS NULL OR chapter_id = ?)
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 21`)
        .all(data.chapterId ?? null, data.chapterId ?? null, before?.id ?? null, before?.created_at ?? null, before?.created_at ?? null, before?.id ?? null) as { id: string }[]
      const stale = currentOutlineNodes(db, data.bookId).stale
      const items = rows.slice(0, 20).map((row) => readMemoryBatch(db, row.id, stale))
      const page: MemoryArchivePage = { bookId: data.bookId, bookRevision: book.revision, items, total, nextBeforeId: rows.length > 20 ? items[items.length - 1]!.id : null }
      if (Buffer.byteLength(JSON.stringify(page), 'utf8') > LIVING_SNAPSHOT_BYTES) return livingFailure('本页归档超过 8 MiB，未截断原始资料。')
      return page
    })())
  }

  save(input: SaveOutlineInput): LivingSnapshot {
    const data = parseSaveOutlineInput(input)
    return this.write(data, (db) => {
      const node = this.node(db, data.bookId, data.id)
      if (node.version !== data.expectedVersion) return livingConflict('大纲已有新版本，表单尚未覆盖新内容。')
      if (node.locked && data.locked && JSON.stringify(node.fields) !== JSON.stringify(data.fields)) invalid('请先解除大纲锁定，再修改内容。')
      const source = data.fields.beatSource
      if (source && JSON.stringify(source) !== JSON.stringify(node.fields.beatSource)) {
        if (node.scope !== 'chapter') invalid('参考节拍只能套用到章节大纲。')
        const row = this.studio.getInspirationDatabase()?.prepare('SELECT * FROM inspirations WHERE id = ?').get(source.id) as
          { revision: number; kind: string; title: string; body: string; source: string; tags_json: string; parent_id: string | null; book_id: string | null; archived: number } | undefined
        if (!row || row.revision !== source.revision || row.archived !== 0 || row.kind !== 'beat' || row.title !== source.title || row.body !== source.body) return livingConflict('节拍卡已修改或归档，请重新选择当前版本。')
        parseInspirationFields({ ...row, tags: JSON.parse(row.tags_json), parentId: row.parent_id, bookId: row.book_id, archived: false })
      }
      const lockOnly = node.locked !== data.locked && JSON.stringify(node.fields) === JSON.stringify(data.fields)
      const revisionId = this.appendOutline(db, node, data.fields, data.locked, 'manual', undefined, !lockOnly)
      // 切换锁定不表示作者已复核来源，也不应覆盖在其他入口修改的章节计划。
      if (lockOnly && node.revisionId) this.copyOutlineDependencies(db, node.revisionId, revisionId)
      this.touch(db)
      return this.snapshot(db, data.bookId)
    })
  }

  history(input: OutlineHistoryInput): OutlineHistoryPage {
    const data = parseOutlineHistoryInput(input), db = this.studio.getMemoryDatabase(data.bookId)
    return perform(() => db.transaction(() => {
      requireLiving(db); this.node(db, data.bookId, data.id)
      const rows = db.prepare(`SELECT id, version, fields_json, locked, origin, created_at FROM living_outline_revisions
        WHERE outline_id = ? AND version < ? ORDER BY version DESC LIMIT 31`).all(data.id, data.beforeVersion ?? Number.MAX_SAFE_INTEGER) as
        { id: string; version: number; fields_json: string; locked: number; origin: 'manual' | 'ai' | 'restored'; created_at: string }[]
      const page = rows.slice(0, 30)
      return { bookId: data.bookId, id: data.id, items: page.map((row) => ({ id: row.id, version: row.version,
        fields: parseOutlineFields(storedJson(row.fields_json)), locked: row.locked === 1, origin: row.origin, createdAt: row.created_at })),
        nextBeforeVersion: rows.length > 30 ? page[page.length - 1]!.version : null }
    })())
  }

  restore(input: RestoreOutlineInput): LivingSnapshot {
    const data = parseRestoreOutlineInput(input)
    return this.write(data, (db) => {
      const node = this.node(db, data.bookId, data.id)
      if (node.version !== data.expectedVersion) return livingConflict('大纲已有新版本，请重新读取后选择历史。')
      if (node.locked) invalid('请先解除当前大纲锁定，再恢复历史。')
      const row = db.prepare('SELECT fields_json, locked FROM living_outline_revisions WHERE id = ? AND outline_id = ?').get(data.revisionId, node.id) as
        { fields_json: string; locked: number } | undefined
      if (!row) invalid('这个历史版本不属于当前大纲。')
      // 恢复产生新的作者修订；旧来源不会被重新声明为已经追平当前正文。
      const restored = this.appendOutline(db, node, parseOutlineFields(storedJson(row.fields_json)), row.locked === 1, 'restored')
      this.copyOutlineDependencies(db, data.revisionId, restored)
      this.touch(db)
      return this.snapshot(db, data.bookId)
    })
  }

  prepare(input: LivingPrepareInput): LivingRunDetail {
    const data = parseLivingPrepareInput(input)
    return this.write(data, (db) => {
      const book = bookState(db, data.bookId)
      let state = currentOutlineNodes(db, data.bookId)
      const chapter = state.chapters.find((item) => item.id === data.chapterId)
      if (!chapter) invalid('请先选择本书中的章节。')
      if (data.kind === 'memory' && (chapter.finalized_revision_id !== chapter.current_revision_id || chapter.status !== 'finalized')) invalid('请先将当前工作稿定稿，再整理这个固定版本。')
      if (data.kind === 'rebase') for (const id of data.targetIds) {
        const target = state.chapters.find((item) => item.id === id), node = state.outlines.find((item) => item.id === id)
        if (!target || !node || target.status !== 'planned' || target.character_count !== 0 || target.finalized_revision_id) invalid('本阶段修纲只处理尚未写作的计划章节，已有正文请保留并单独复核。')
        if (node.locked) invalid('所选章纲包含锁定内容，请先明确解除锁定。')
        if (node.manual && !data.confirmManualIds.includes(id)) invalid('替换作者已有章纲需要逐章明确确认。')
      }
      if (data.kind === 'expand' && state.chapters.length > 20000 - data.count) invalid('新增章节将超出作品章节上限。')
      const firstTarget = data.kind === 'rebase' ? state.chapters.find((item) => data.targetIds.includes(item.id)) : undefined
      if (firstTarget && state.chapters.some((item) => data.targetIds.includes(item.id) && item.volume_id !== firstTarget.volume_id)) invalid('每次修纲请选择同一卷内最多十章，分别固定对应卷目标。')
      if (firstTarget && chapter.position > firstTarget.position) invalid('修纲参考章不能晚于首个修纲目标，请选择更早的参考章节。')
      const tail = (firstTarget ? state.chapters.filter((item) => item.position < firstTarget.position) : state.chapters).slice(-3)
      const volumeId = firstTarget ? firstTarget.volume_id : tail[tail.length - 1]?.volume_id ?? null
      const sourceIds = data.kind === 'memory' ? [] : [data.bookId, ...(volumeId ? [volumeId] : []), ...tail.map((item) => item.id)]
      // 第一次显式预览为沿用资料建立基线历史；只固定身份和内容，不改变作品语义或版本。
      for (const node of state.outlines) if ([...sourceIds, ...data.targetIds].includes(node.id) && !node.revisionId) this.appendOutline(db, node, node.fields, false, node.manual ? 'manual' : 'ai', undefined, false)
      state = currentOutlineNodes(db, data.bookId)
      const sources = state.outlines.filter((node) => sourceIds.includes(node.id) && !node.stale)
      const targets = state.outlines.filter((node) => data.targetIds.includes(node.id))
      const dependencies: LivingDependency[] = []
      if (data.kind === 'memory') dependencies.push({ kind: 'chapter', id: chapter.id, revision: chapterToken(chapter) })
      else {
        if (!tail.some((item) => item.id === chapter.id)) dependencies.push({ kind: 'chapter', id: chapter.id, revision: chapterToken(chapter) })
        for (const item of tail) dependencies.push({ kind: 'chapter', id: item.id, revision: chapterToken(item) })
        for (const node of sources) dependencies.push({ kind: 'outline', id: node.id, revision: node.revisionId! })
      }
      const entities = data.entityIds.map((id) => {
        const entity = db.prepare(`SELECT i.id, i.name, i.kind, i.nature, i.summary, (SELECT r.id FROM knowledge_item_revisions r WHERE r.item_id = i.id ORDER BY r.knowledge_revision DESC LIMIT 1) AS revisionId
          FROM knowledge_items i WHERE i.id = ? AND i.book_id = ? AND i.author_decision = 'adopted' AND i.freshness = 'current'
            AND i.conflict_state <> 'candidate'`).get(id, data.bookId) as LivingEnvelope['sources']['entities'][number] | undefined
        if (!entity?.revisionId) invalid('所选实体须已采用、标记为当前，且没有待处理的冲突候选。')
        dependencies.push({ kind: 'knowledge', id, revision: entity.revisionId }); return entity
      })
      const memories: ReturnType<typeof readMemoryBatch>[] = []
      if (data.kind !== 'memory') for (const item of tail) {
        const pointer = db.prepare('SELECT batch_id FROM living_memory_publications WHERE chapter_id = ?').get(item.id) as { batch_id: string } | undefined
        if (!pointer) continue
        const batch = readMemoryBatch(db, pointer.batch_id, state.stale)
        if (batch.state !== 'published') continue
        memories.push(batch); dependencies.push({ kind: 'memory', id: batch.id, revision: batch.id })
      }
      let brief: LivingEnvelope['sources']['brief']
      if (data.kind !== 'memory') {
        const row = db.prepare('SELECT revision, premise, style, narrator, tense, rules FROM workbench_settings WHERE singleton = 1').get() as WritingBrief & { revision: number }
        if (!row || !Number.isSafeInteger(row.revision)) return livingFailure()
        const { revision, ...fields } = row
        brief = { ...parseWritingBrief(fields), revision }
        dependencies.push({ kind: 'brief', id: data.bookId, revision: String(revision) })
      }
      const envelope: LivingEnvelope = { workflow: 'living-v1', kind: data.kind, goal: data.instruction, requestedCount: data.count,
        targets, sources: { outlines: sources, memories, entities, ...(brief ? { brief } : {}) }, dependencies }
      const instruction = JSON.stringify(envelope)
      if (instruction.length > LIVING_INSTRUCTION_LIMIT) invalid('本次固定资料超过预览预算，请减少实体或缩小修纲范围；资料未被截断。')
      const connection = this.ai.listConnections({ bookId: data.bookId }).connections.find((item) => item.id === data.connectionId)
      if (!connection) invalid('请先保存本书的模型连接，或从 AI 开书后继续。')
      const run = this.ai.prepare({ bookId: data.bookId, chapterId: data.chapterId, expectedBookRevision: book.revision,
        expectedKnowledgeRevision: book.knowledge_revision, expectedRevisionId: chapter.current_revision_id, connectionId: connection.id, connection,
        kind: 'plan', purpose: 'living', instruction, contextScope: 'chapter', selectedBlockIds: [], memoryChunkIds: [] })
      db.prepare('INSERT INTO living_runs (run_id, kind, request_json, envelope_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(run.id, data.kind, JSON.stringify(data), instruction, new Date().toISOString())
      return { bookId: data.bookId, kind: data.kind, request: data, targets, run, proposal: null, parseError: null, adopted: false }
    })
  }

  getRun(input: LivingRunInput): LivingRunDetail {
    const data = parseLivingRunInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => {
        const { run, request, envelope } = this.readRun(db, data.bookId, data.runId)
        let proposal: LivingProposal | null = null, parseError: string | null = null
        if (run.state === 'succeeded' || run.state === 'adopted') {
          try {
            const original = parseOutput(run)
            validateProposal(original, run, request, envelope)
            proposal = run.state === 'adopted' ? parseLivingProposal(storedJson(run.acceptedText)) : original
            validateProposal(proposal, run, request, envelope); validateSelection(proposal, original)
          }
          catch (error) { parseError = error instanceof DomainError ? error.detail.message : '提案无法解析，原始输出已保留。' }
        }
        return { bookId: data.bookId, kind: request.kind, request, targets: envelope.targets, run, proposal, parseError,
          adopted: Boolean(db.prepare('SELECT 1 FROM living_receipts WHERE run_id = ?').get(run.id)) }
      })()
    })
  }

  adopt(input: LivingAdoptInput): LivingAdoptReceipt {
    const data = parseLivingAdoptInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      try {
        const receipt = db.transaction(() => {
          requireLiving(db)
          const acceptedJson = JSON.stringify(data.proposal)
          const existing = db.prepare('SELECT accepted_json, refs_json FROM living_receipts WHERE run_id = ?').get(data.runId) as { accepted_json: string; refs_json: string } | undefined
          if (existing) {
            if (existing.accepted_json !== acceptedJson) return livingConflict('这个提案已经采用过其他内容，请查看原采用结果。')
            const refs = storedJson(existing.refs_json) as string[]
            if (!Array.isArray(refs) || refs.length !== (data.proposal.kind === 'memory' ? 1 : data.proposal.chapters.length) || new Set(refs).size !== refs.length) return livingFailure()
            refs.forEach(requiredId)
            return { bookId: data.bookId, runId: data.runId, refs, snapshot: this.snapshot(db, data.bookId) }
          }
          const book = writable(db, data), { run, request, envelope } = this.readRun(db, data.bookId, data.runId)
          if (run.state !== 'succeeded' || run.version !== data.expectedRunVersion) return livingConflict('提案状态已有变化，请重新读取原提案。')
          if (book.revision !== run.context.bookRevision || book.knowledge_revision !== run.context.knowledgeRevision) return livingConflict('生成后作品或设定已有变化，请保留提案并按当前版本重新预览。')
          const original = parseOutput(run)
          validateProposal(original, run, request, envelope)
          validateProposal(data.proposal, run, request, envelope)
          validateSelection(data.proposal, original)
          this.checkSources(db, data.bookId, envelope.dependencies)
          const refs: string[] = [], now = new Date().toISOString()
          if (data.proposal.kind === 'memory') {
            const state = currentOutlineNodes(db, data.bookId), chapter = state.chapters.find((item) => item.id === run.chapterId)
            if (!chapter || chapter.status !== 'finalized' || chapter.current_revision_id !== run.context.chapterRevisionId || chapter.finalized_revision_id !== run.context.chapterRevisionId) return livingConflict('定稿来源已变化，请按新定稿重新整理。')
            const batchId = randomUUID()
            const old = db.prepare('SELECT batch_id FROM living_memory_publications WHERE chapter_id = ?').get(chapter.id) as { batch_id: string } | undefined
            if (old) db.prepare("UPDATE living_memory_batches SET state = 'superseded' WHERE id = ?").run(old.batch_id)
            db.prepare(`INSERT INTO living_memory_batches (id, chapter_id, chapter_title, chapter_revision_id, run_id, state, proposal_json, created_at)
              VALUES (?, ?, ?, ?, ?, 'published', ?, ?)`).run(batchId, chapter.id, chapter.title, chapter.current_revision_id, run.id, acceptedJson, now)
            db.prepare(`INSERT INTO living_memory_publications (chapter_id, batch_id) VALUES (?, ?)
              ON CONFLICT(chapter_id) DO UPDATE SET batch_id = excluded.batch_id`).run(chapter.id, batchId)
            this.dependencies(db, 'memory', batchId, envelope.dependencies)
            refs.push(batchId)
          } else {
            const tail = currentOutlineNodes(db, data.bookId).chapters.slice(-1)[0]
            for (const entry of data.proposal.chapters) {
              let node: LivingOutline
              if (data.proposal.kind === 'expand') {
                const chapterId = this.appendPlannedChapter(db, entry.fields.title, tail?.volume_id ?? null, book.revision + 1, now)
                node = this.node(db, data.bookId, chapterId)
              } else {
                node = this.node(db, data.bookId, entry.chapterId!)
                const target = envelope.targets.find((item) => item.id === node.id)
                const chapter = currentOutlineNodes(db, data.bookId).chapters.find((item) => item.id === node.id)
                if (!target || target.revisionId !== node.revisionId || node.locked || !chapter || chapter.status !== 'planned' || chapter.character_count !== 0 || chapter.finalized_revision_id ||
                  (node.manual && !request.confirmManualIds.includes(node.id))) return livingConflict('修纲目标已有写作、手改或锁定变化，请重新确认范围。')
              }
              const revisionId = this.appendOutline(db, node, entry.fields, false, 'ai', run.id)
              this.dependencies(db, 'outline', revisionId, envelope.dependencies.filter((dependency) => !(['outline', 'chapter'].includes(dependency.kind) && request.targetIds.includes(dependency.id))))
              refs.push(node.id)
            }
          }
          const changed = db.prepare(`UPDATE ai_runs SET state = 'adopted', version = version + 1, accepted_text = ?, adopted_revision_id = ?, updated_at = ?
            WHERE id = ? AND state = 'succeeded' AND version = ?`).run(acceptedJson, run.context.chapterRevisionId, now, run.id, run.version)
          if (changed.changes !== 1) return livingConflict('候选已有新状态，本次采用未覆盖新结果。')
          db.prepare('INSERT INTO living_receipts (run_id, accepted_json, refs_json, created_at) VALUES (?, ?, ?, ?)').run(run.id, acceptedJson, JSON.stringify(refs), now)
          this.touch(db)
          return { bookId: data.bookId, runId: run.id, refs, snapshot: this.snapshot(db, data.bookId) }
        }).immediate()
        // 书架目录是另一个数据库，作品采纳提交后才能更新其可修复快照。
        return { ...receipt, book: this.studio.getBook({ bookId: data.bookId }) }
      } finally { this.studio.refreshKnowledgeCatalog(data.bookId) }
    })
  }

  validateBook(bookId: string): void {
    const db = this.studio.getMemoryDatabase(bookId)
    requireLiving(db)
    this.snapshot(db, bookId)
    for (const value of db.prepare('SELECT run_id FROM living_runs').iterate()) {
      const { run, request, envelope } = this.readRun(db, bookId, (value as { run_id: string }).run_id)
      for (const source of envelope.dependencies) this.verifySourceHistory(db, bookId, source)
      const source = db.prepare('SELECT document_json FROM chapter_revisions WHERE chapter_id = ? AND id = ?').get(run.chapterId, run.context.chapterRevisionId) as { document_json: string } | undefined
      if (!source) return livingFailure('创作提案缺少固定正文修订。')
      const document = parseManuscript(storedJson(source.document_json, 32 * 1024 * 1024))
      const blocks = document.content.map((block) => { const text = documentToText({ type: 'doc', content: [block] }); return { blockId: block.attrs.id, startOffset: 0, endOffset: text.length, text } })
      if (JSON.stringify(blocks) !== JSON.stringify(run.context.chapterBlocks) || run.context.originalText !== '') return livingFailure('创作提案正文与固定历史不一致。')
      for (const node of [...envelope.targets, ...envelope.sources.outlines]) {
        const history = db.prepare(`SELECT r.fields_json, r.version, r.locked, n.scope FROM living_outline_revisions r
          JOIN living_outlines n ON n.id = r.outline_id WHERE r.id = ? AND r.outline_id = ?`).get(node.revisionId, node.id) as
          { fields_json: string; version: number; locked: number; scope: string } | undefined
        if (!history || history.fields_json !== JSON.stringify(node.fields) || history.version !== node.version || history.locked !== Number(node.locked) || history.scope !== node.scope) return livingFailure('固定章纲与其历史修订不一致。')
      }
      for (const entity of envelope.sources.entities) {
        const history = db.prepare('SELECT fields_json FROM knowledge_item_revisions WHERE item_id = ? AND id = ?').get(entity.id, entity.revisionId) as { fields_json: string } | undefined
        if (!history) return livingFailure('固定实体缺少来源修订。')
        const fields = parseKnowledgeFields(storedJson(history.fields_json))
        if (fields.name !== entity.name || fields.kind !== entity.kind || fields.nature !== entity.nature || fields.summary !== entity.summary) return livingFailure('固定实体与来源修订不一致。')
      }
      for (const memory of envelope.sources.memories) {
        const history = readMemoryBatch(db, memory.id, new Map())
        if (history.chapterId !== memory.chapterId || history.chapterTitle !== memory.chapterTitle || history.revisionId !== memory.revisionId ||
          history.runId !== memory.runId || history.createdAt !== memory.createdAt || JSON.stringify(history.proposal) !== JSON.stringify(memory.proposal)) return livingFailure('固定记忆与历史批次不一致。')
      }
      const receipt = db.prepare('SELECT accepted_json, refs_json FROM living_receipts WHERE run_id = ?').get(run.id) as { accepted_json: string; refs_json: string } | undefined
      if ((run.state === 'adopted') !== Boolean(receipt)) return livingFailure('创作提案终态与采用回执不一致。')
      if (receipt) {
        const accepted = parseLivingProposal(storedJson(receipt.accepted_json)), original = parseOutput(run)
        validateProposal(original, run, request, envelope); validateProposal(accepted, run, request, envelope); validateSelection(accepted, original)
        if (receipt.accepted_json !== JSON.stringify(accepted) || run.acceptedText !== receipt.accepted_json || run.adoptedRevisionId !== run.context.chapterRevisionId) return livingFailure()
        const refs = storedJson(receipt.refs_json)
        if (!Array.isArray(refs) || refs.length !== (accepted.kind === 'memory' ? 1 : accepted.chapters.length) || new Set(refs).size !== refs.length) return livingFailure()
        for (const [index, ref] of refs.entries()) {
          requiredId(ref)
          if (accepted.kind === 'memory') {
            const record = db.prepare('SELECT proposal_json, chapter_id, chapter_revision_id, chapter_title FROM living_memory_batches WHERE id = ? AND run_id = ?').get(ref, run.id) as
              { proposal_json: string; chapter_id: string; chapter_revision_id: string; chapter_title: string } | undefined
            if (!record || record.proposal_json !== receipt.accepted_json || record.chapter_id !== run.chapterId ||
              record.chapter_revision_id !== run.context.chapterRevisionId || record.chapter_title !== run.chapterTitle) return livingFailure('记忆回执与固定定稿来源不一致。')
          } else {
            const records = db.prepare('SELECT fields_json, version, origin FROM living_outline_revisions WHERE outline_id = ? AND run_id = ?').all(ref, run.id) as
              { fields_json: string; version: number; origin: string }[]
            const entry = accepted.chapters[index]!, record = records[0]
            if (records.length !== 1 || !record || record.origin !== 'ai' || record.fields_json !== JSON.stringify(entry.fields) ||
              (accepted.kind === 'rebase' ? ref !== entry.chapterId : record.version !== 1)) return livingFailure('章纲回执与采用内容或目标不一致。')
          }
        }
      }
    }
    for (const value of db.prepare('SELECT id, fields_json FROM living_outline_revisions').iterate()) parseOutlineFields(storedJson((value as { fields_json: string }).fields_json))
    for (const value of db.prepare('SELECT id FROM living_memory_batches').iterate()) {
      const batch = readMemoryBatch(db, (value as { id: string }).id, new Map())
      if (!db.prepare('SELECT 1 FROM living_receipts WHERE run_id = ?').get(batch.runId)) return livingFailure('记忆批次缺少作者采用回执。')
    }
    for (const value of db.prepare('SELECT target_kind, target_id, source_kind, source_id, source_revision FROM living_dependencies').iterate()) {
      const row = value as { target_kind: string; target_id: string; source_kind: string; source_id: string; source_revision: string }
      const target = row.target_kind === 'outline'
        ? db.prepare('SELECT 1 FROM living_outline_revisions WHERE id = ?').get(row.target_id)
        : db.prepare('SELECT 1 FROM living_memory_batches WHERE id = ?').get(row.target_id)
      if (!target) return livingFailure('依赖记录缺少派生目标。')
      this.verifySourceHistory(db, bookId, { kind: row.source_kind as LivingDependency['kind'], id: row.source_id, revision: row.source_revision })
    }
  }

  private snapshot(db: Database.Database, bookId: string): LivingSnapshot {
    const schemaVersion = Number(db.pragma('user_version', { simple: true }))
    const basic = db.prepare('SELECT revision, knowledge_revision FROM book_meta WHERE id = ?').get(bookId) as { revision: number; knowledge_revision: number } | undefined
    if (!basic) return livingFailure()
    const result: LivingSnapshot = { bookId, bookRevision: basic.revision, knowledgeRevision: basic.knowledge_revision, schemaVersion, requiresUpgrade: schemaVersion < LIVING_SCHEMA_VERSION,
      outlines: [], memories: [], memoryTotal: 0, entities: [], entityTotal: 0, runs: [], health: { idea: 'empty', world: 'empty', cast: 'empty', outline: 'empty', manuscript: 'empty' } }
    if (result.requiresUpgrade) return result
    const state = currentOutlineNodes(db, bookId)
    result.outlines = state.outlines
    result.memoryTotal = (db.prepare('SELECT COUNT(*) AS count FROM living_memory_batches').get() as { count: number }).count
    const batches = db.prepare('SELECT id FROM living_memory_batches ORDER BY created_at DESC, id DESC LIMIT 50').all() as { id: string }[]
    result.memories = batches.map((row) => readMemoryBatch(db, row.id, state.stale))
    result.entities = db.prepare("SELECT id, name, kind FROM knowledge_items WHERE author_decision = 'adopted' AND freshness = 'current' AND conflict_state <> 'candidate' ORDER BY kind, name, id LIMIT 200").all() as LivingSnapshot['entities']
    result.runs = db.prepare(`SELECT l.run_id AS id, l.kind, r.state, l.created_at AS createdAt FROM living_runs l JOIN ai_runs r ON r.id = l.run_id
      ORDER BY r.sequence DESC LIMIT 30`).all() as LivingSnapshot['runs']
    const meta = bookState(db, bookId)
    const knowledgeCounts = db.prepare("SELECT kind, COUNT(*) AS count FROM knowledge_items WHERE author_decision = 'adopted' AND freshness = 'current' AND conflict_state <> 'candidate' GROUP BY kind").all() as { kind: string; count: number }[]
    result.entityTotal = knowledgeCounts.reduce((total, item) => total + item.count, 0)
    result.health.idea = meta.logline || state.outlines[0]?.fields.summary ? 'ready' : 'empty'
    result.health.cast = knowledgeCounts.some((item) => item.kind === 'person' && item.count > 0) ? 'ready' : 'empty'
    result.health.world = knowledgeCounts.some((item) => item.kind !== 'person' && item.count > 0) ? 'ready' : 'empty'
    result.health.outline = state.outlines.some((node) => node.stale) ? 'stale' : state.outlines.some((node) => node.fields.goal || node.fields.summary || node.fields.beats.length) ? 'ready' : 'empty'
    const stalePublication = db.prepare('SELECT batch_id FROM living_memory_publications').all() as { batch_id: string }[]
    result.health.manuscript = stalePublication.some((item) => state.stale.has(`memory:${item.batch_id}`)) ? 'stale'
      : state.chapters.some((item) => item.character_count > 0) ? 'in_progress' : 'empty'
    if (result.runs.some((run) => ['prepared', 'running', 'succeeded'].includes(run.state) && run.kind !== 'memory') && result.health.outline !== 'stale') result.health.outline = 'pending_proposal'
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LIVING_SNAPSHOT_BYTES) return livingFailure('创作快照超过 8 MiB，请缩小单项内容；资料未被截断。')
    return result
  }

  private node(db: Database.Database, bookId: string, id: string): LivingOutline {
    const node = currentOutlineNodes(db, bookId).outlines.find((item) => item.id === id)
    if (!node) invalid('本书中不存在这个大纲节点。')
    return node
  }

  private appendPlannedChapter(db: Database.Database, title: string, volumeId: string | null, bookRevision: number, now: string): string {
    const chapters = db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) AS maximum FROM chapters').get() as { count: number; maximum: number }
    const sequence = (db.prepare('SELECT COALESCE(MAX(sequence), 0) AS maximum FROM chapter_revisions').get() as { maximum: number }).maximum
    if (chapters.count >= 20000) invalid('新增章节将超出作品章节上限。')
    if (!Number.isSafeInteger(chapters.maximum) || chapters.maximum >= Number.MAX_SAFE_INTEGER - 1 ||
      !Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER - 1) return livingFailure()
    if (volumeId && !db.prepare('SELECT 1 FROM volumes WHERE id = ?').get(volumeId)) return livingConflict('补纲所在卷已变化，请重新预览。')
    const chapterId = randomUUID(), revisionId = randomUUID(), documentJson = JSON.stringify(emptyDocument())
    // 空章、章纲、索引事件和采用回执共用外层事务，整次采纳只推进一次作品版本。
    db.prepare('INSERT INTO chapters (id, title, position, volume_id, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(chapterId, title, chapters.maximum + 1, volumeId, revisionId, now, now)
    db.prepare(`INSERT INTO chapter_revisions (id, chapter_id, document_json, plain_text, content_hash, character_count, sequence, reason, created_at)
      VALUES (?, ?, ?, '', ?, 0, ?, 'created', ?)`).run(revisionId, chapterId, documentJson, createHash('sha256').update(documentJson).digest('hex'), sequence + 1, now)
    db.prepare("INSERT INTO outbox (id, kind, chapter_id, revision_id, book_revision, created_at) VALUES (?, 'chapter.changed', ?, ?, ?, ?)")
      .run(randomUUID(), chapterId, revisionId, bookRevision, now)
    return chapterId
  }

  private appendOutline(db: Database.Database, node: LivingOutline, fields: OutlineFields, locked: boolean,
    origin: 'manual' | 'ai' | 'restored', runId?: string, sync = true): string {
    const revisionId = randomUUID(), now = new Date().toISOString()
    if (node.version >= Number.MAX_SAFE_INTEGER) return livingFailure()
    if (!node.revisionId) db.prepare('INSERT INTO living_outlines (id, scope, current_revision_id) VALUES (?, ?, ?)').run(node.id, node.scope, revisionId)
    db.prepare(`INSERT INTO living_outline_revisions (id, outline_id, version, parent_revision_id, fields_json, locked, origin, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(revisionId, node.id, node.version + 1, node.revisionId, JSON.stringify(fields), locked ? 1 : 0, origin, runId ?? null, now)
    if (node.revisionId) {
      const changed = db.prepare('UPDATE living_outlines SET current_revision_id = ? WHERE id = ? AND current_revision_id = ?').run(revisionId, node.id, node.revisionId)
      if (changed.changes !== 1) return livingConflict('大纲指针已有变化。')
    }
    if (sync && node.scope === 'chapter') db.prepare('UPDATE chapters SET title = ?, goal = ?, conflict = ?, hook = ?, tension = ?, beats_json = ?, outline_stale = 0, updated_at = ? WHERE id = ?')
      .run(fields.title, fields.goal, fields.conflict, fields.hook, fields.tension, JSON.stringify(fields.beats.map((beat) => ({ id: randomUUID(), ...beat }))), now, node.id)
    if (sync && node.scope === 'volume') db.prepare('UPDATE volumes SET title = ?, goal = ?, conflict = ?, climax = ?, updated_at = ? WHERE id = ?')
      .run(fields.title, fields.goal, fields.conflict, fields.hook, now, node.id)
    return revisionId
  }

  private dependencies(db: Database.Database, kind: 'outline' | 'memory', target: string, dependencies: LivingDependency[]): void {
    const insert = db.prepare('INSERT INTO living_dependencies (target_kind, target_id, source_kind, source_id, source_revision) VALUES (?, ?, ?, ?, ?)')
    for (const dependency of dependencies) insert.run(kind, target, dependency.kind, dependency.id, dependency.revision)
  }

  private copyOutlineDependencies(db: Database.Database, sourceRevisionId: string, targetRevisionId: string): void {
    const dependencies = db.prepare("SELECT source_kind AS kind, source_id AS id, source_revision AS revision FROM living_dependencies WHERE target_kind = 'outline' AND target_id = ?")
      .all(sourceRevisionId) as LivingDependency[]
    this.dependencies(db, 'outline', targetRevisionId, dependencies)
  }

  private checkSources(db: Database.Database, bookId: string, dependencies: LivingDependency[]): void {
    const state = currentOutlineNodes(db, bookId)
    for (const source of dependencies) {
      let current: string | undefined
      if (source.kind === 'chapter') { const chapter = state.chapters.find((item) => item.id === source.id); current = chapter ? chapterToken(chapter) : undefined }
      if (source.kind === 'outline') { const node = state.outlines.find((item) => item.id === source.id); current = node && !node.stale ? node.revisionId ?? undefined : undefined }
      if (source.kind === 'memory') { const batch = readMemoryBatch(db, source.id, state.stale); current = batch.state === 'published' ? batch.id : undefined }
      if (source.kind === 'knowledge') current = (db.prepare(`SELECT r.id FROM knowledge_item_revisions r JOIN knowledge_items i ON i.id = r.item_id
        WHERE i.id = ? AND i.author_decision = 'adopted' AND i.freshness = 'current' AND i.conflict_state <> 'candidate'
        ORDER BY r.knowledge_revision DESC LIMIT 1`).get(source.id) as { id: string } | undefined)?.id
      if (source.kind === 'brief') current = String((db.prepare('SELECT revision FROM workbench_settings WHERE singleton = 1').get() as { revision: number }).revision)
      if (current !== source.revision) return livingConflict('依赖的来源或有效批次已变化，请按新来源重新生成。')
    }
  }

  private verifySourceHistory(db: Database.Database, bookId: string, source: LivingDependency): void {
    if (source.kind === 'chapter') {
      const token = parseChapterToken(source.revision)
      for (const revisionId of [token.revisionId, token.finalizedRevisionId]) if (revisionId &&
        !db.prepare('SELECT 1 FROM chapter_revisions WHERE chapter_id = ? AND id = ?').get(source.id, revisionId)) return livingFailure('依赖记录缺少正文或定稿历史。')
    }
    if (source.kind === 'knowledge' && !db.prepare('SELECT 1 FROM knowledge_item_revisions WHERE item_id = ? AND id = ?').get(source.id, source.revision)) return livingFailure('依赖记录缺少实体历史。')
    if (source.kind === 'outline' && !db.prepare('SELECT 1 FROM living_outline_revisions WHERE outline_id = ? AND id = ?').get(source.id, source.revision)) return livingFailure('依赖记录缺少大纲历史。')
    if (source.kind === 'memory' && (source.id !== source.revision || !db.prepare('SELECT 1 FROM living_memory_batches WHERE id = ?').get(source.id))) return livingFailure('依赖记录缺少记忆批次。')
    if (source.kind === 'brief') {
      const revision = Number(source.revision), current = db.prepare('SELECT revision FROM workbench_settings WHERE singleton = 1').get() as { revision: number } | undefined
      if (source.id !== bookId || !Number.isSafeInteger(revision) || revision < 0 || String(revision) !== source.revision || !current || revision > current.revision) return livingFailure('依赖记录中的创作约定版本无效。')
    }
  }

  private readRun(db: Database.Database, bookId: string, runId: string): { run: AiRun; request: LivingPrepareInput; envelope: LivingEnvelope } {
    requireLiving(db)
    const row = db.prepare('SELECT kind, request_json, envelope_json FROM living_runs WHERE run_id = ?').get(runId) as { kind: string; request_json: string; envelope_json: string } | undefined
    if (!row) invalid('本书中不存在这个创作提案。')
    const request = parseLivingPrepareInput(storedJson(row.request_json)), value = checkedEnvelope(storedJson(row.envelope_json), request)
    const run = this.ai.get({ bookId, runId })
    if (JSON.stringify(request) !== row.request_json || JSON.stringify(value) !== row.envelope_json || request.kind !== row.kind || request.bookId !== bookId ||
      run.context.purpose !== 'living' || run.kind !== 'plan' || run.context.instruction !== row.envelope_json || run.chapterId !== request.chapterId ||
      run.context.bookRevision !== request.expectedBookRevision || run.context.connection.id !== request.connectionId) return livingFailure()
    const chapterSource = value.dependencies.find((source) => source.kind === 'chapter' && source.id === request.chapterId)
    if (!chapterSource) return livingFailure('创作提案缺少固定正文依赖。')
    const token = parseChapterToken(chapterSource.revision)
    if (token.revisionId !== run.context.chapterRevisionId || (request.kind === 'memory' && (token.finalizedRevisionId !== token.revisionId || token.status !== 'finalized'))) return livingFailure('创作提案与固定正文依赖不一致。')
    return { run, request, envelope: value }
  }

  private touch(db: Database.Database): void {
    const now = new Date().toISOString()
    const changed = db.prepare('UPDATE book_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1 AND revision < ?').run(now, Number.MAX_SAFE_INTEGER)
    if (changed.changes !== 1) return livingFailure()
    const revision = (db.prepare('SELECT revision FROM book_meta WHERE singleton = 1').get() as { revision: number }).revision
    db.prepare("INSERT INTO outbox (id, kind, chapter_id, revision_id, book_revision, created_at) VALUES (?, 'book.structure', NULL, NULL, ?, ?)")
      .run(randomUUID(), revision, now)
  }

  private write<T>(input: BookMutationInput, operation: (db: Database.Database) => T): T {
    return perform(() => {
      const db = this.studio.getMemoryDatabase(input.bookId)
      try { return db.transaction(() => { writable(db, input); return operation(db) }).immediate() }
      finally { this.studio.refreshKnowledgeCatalog(input.bookId) }
    })
  }
}
