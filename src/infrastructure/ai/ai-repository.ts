import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, isRecord, requiredId, requiredInteger, type ChapterSnapshot } from '../../contracts/api'
import {
  AI_CONTEXT_LIMIT, AI_OUTPUT_LIMIT, AI_PROMPT_VERSION, AI_MEMORY_PROMPT_VERSION, AI_READER_CONTEXT_PROMPT_VERSION, isAiMemoryTask,
  parseAiAdoptInput, parseAiBookInput, parseAiCheckpointInput, parseAiConnectionConfig, parseAiConnectionSaveInput,
  parseAiFinishInput, parseAiListInput, parseAiMemoryAdoptInput, parseAiMemoryProposal, parseAiPrepareInput, parseAiRunInput, parseAiStartInput, parseAiVersionInput, parseAiWritingContext,
  type AiAdoptInput, type AiAdoptReceipt, type AiBookInput, type AiCheckpointInput, type AiConnection, type AiMaintenanceBaseline,
  type AiConnectionPage, type AiConnectionSaveInput, type AiContextPacket, type AiFinishInput, type AiListInput,
  type AiPrepareServiceInput, type AiRun, type AiRunInput, type AiRunPage, type AiRunState, type AiRunSummary,
  type AiStartInput, type AiTaskKind, type AiUsage, type AiVersionInput, type AiMemoryAdoptInput, type AiMemoryAdoptReceipt, type AiMemoryAdoptedEntry,
} from '../../contracts/ai'
import { AI_SUMMARY_PROMPT_VERSION, parseAiSummaryContext } from '../../contracts/ai-summary'
import { AI_CONTEXT_SUMMARY_PROMPT_VERSION, contextSummaryRef, parseAiContextSummarySnapshots } from '../../contracts/ai-context-summary'
import { characterScopeOf, isAiCharacterContextPromptVersion, parseAiCharacterContext } from '../../contracts/ai-character-context'
import { parseManuscript } from '../../contracts/manuscript'
import { parseKnowledgeFields, resolveKnowledgeFields } from '../../contracts/knowledge'
import { parseDisclosure } from '../../contracts/story'
import { KnowledgeRepository } from '../knowledge/knowledge-repository'
import type { MemorySearchRepository } from '../memory/search-repository'
import type { StudioRepository } from '../storage/studio-repository'
import { BOOK_SCHEMA_VERSION } from '../storage/schema'
import { textToDocument } from '../text/manuscript-text'
import { buildAiContext, validateAiContext } from './context'
import { validateAiSummaryContext } from './summary-context'
import { creativeRef, parseCreativeResources } from '../../contracts/creative-resources'
import { AiMemoryTaskRepository } from './memory-task-repository'
import { parseLivingWritingContext } from '../../contracts/living'
import { REVIEW_PROMPT_VERSION } from '../../contracts/review'
import { STUDY_CARDS_PROMPT_VERSION } from '../../contracts/study'
import { requireLiving } from '../workbench/living-state'
import { requireForge } from '../workbench/forge-state'
import { forgeInstructionKind, forgeUsesChapter } from '../../contracts/forge'

interface BookState { id: string; revision: number; knowledge_revision: number; archived_at: string | null }
interface ConnectionRow {
  id: string; book_id: string; version: number; name: string; base_url: string; model: string
  context_window: number; max_output_tokens: number; updated_at: string
}
interface SummaryRow {
  sequence: number; id: string; book_id: string; chapter_id: string; chapter_title: string; kind: AiTaskKind
  purpose: 'review' | 'study' | 'living' | 'forge' | null
  state: AiRunState; version: number; connection_id: string; connection_name: string; model: string
  output_characters: number; error: string | null; created_at: string; updated_at: string
}
interface RunRow extends SummaryRow {
  context_hash: string; context_integrity_hash: string; context_json: string; output_text: string
  accepted_text: string | null; adopted_revision_id: string | null; usage_json: string | null; finish_reason: string | null
}
const MAX_CONNECTIONS = 8
const PAGE_SIZE = 30
const RUN_STATES: readonly AiRunState[] = ['prepared', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'rejected', 'adopted']
const SUMMARY_COLUMNS = `sequence, id, book_id, chapter_id, chapter_title, kind, state, version, connection_id,
  connection_name, model, length(output_text) AS output_characters, error, created_at, updated_at,
  CASE WHEN json_valid(context_json) THEN json_extract(context_json, '$.purpose') ELSE NULL END AS purpose`
const RUN_COLUMNS = `${SUMMARY_COLUMNS}, context_hash, context_integrity_hash, context_json, output_text,
  accepted_text, adopted_revision_id, usage_json, finish_reason`
const CONNECTION_COLUMNS = 'id, book_id, version, name, base_url, model, context_window, max_output_tokens, updated_at'

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: 'AI 协作记录无法核对，请保留候选和作品文件后检查资料。' })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}
function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function conflict(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }
function schemaVersion(db: Database.Database): number {
  const version = db.pragma('user_version', { simple: true })
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 2 || version > BOOK_SCHEMA_VERSION) throw storageFailure()
  return version
}
function requireAi(db: Database.Database): void {
  if (schemaVersion(db) < 6) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级这部作品，再使用 AI 协作。' })
}
function readBook(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, revision, knowledge_revision, archived_at FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!row || row.id !== bookId || [row.revision, row.knowledge_revision].some((number) => !Number.isSafeInteger(number) || number < 0)) throw storageFailure()
  return row
}
function writable(book: BookState): void {
  if (book.archived_at) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请先取消归档再生成或采用候选。' })
}
function connection(row: ConnectionRow, bookId: string): AiConnection {
  try {
    if (row.book_id !== bookId || !Number.isSafeInteger(row.version) || row.version < 0 ||
      typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw storageFailure()
    const fields = parseAiConnectionConfig({ id: row.id, name: row.name, baseUrl: row.base_url, model: row.model,
      contextWindow: row.context_window, maxOutputTokens: row.max_output_tokens })
    if (fields.id !== row.id || fields.name !== row.name || fields.baseUrl !== row.base_url || fields.model !== row.model) throw storageFailure()
    return { ...fields, version: row.version, updatedAt: row.updated_at }
  } catch { throw storageFailure() }
}
function checkedConnection(value: unknown): AiConnection {
  if (!isRecord(value) || Object.keys(value).some((key) => !['id', 'name', 'baseUrl', 'model', 'contextWindow', 'maxOutputTokens', 'version', 'updatedAt'].includes(key))) {
    invalid('连接快照无效。')
  }
  const fields = parseAiConnectionConfig({ id: value.id, name: value.name, baseUrl: value.baseUrl, model: value.model,
    contextWindow: value.contextWindow, maxOutputTokens: value.maxOutputTokens })
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) invalid('连接快照时间无效。')
  return { ...fields, version: requiredInteger(value.version, '连接版本'), updatedAt: value.updatedAt }
}
function sameConnection(left: AiConnection, right: AiConnection): boolean {
  return left.id === right.id && left.version === right.version && left.name === right.name && left.baseUrl === right.baseUrl &&
    left.model === right.model && left.contextWindow === right.contextWindow && left.maxOutputTokens === right.maxOutputTokens && left.updatedAt === right.updatedAt
}
function summary(row: SummaryRow, bookId: string): AiRunSummary {
  try {
    if (row.book_id !== bookId || !['plan', 'continue', 'rewrite', 'summarize', 'extract'].includes(row.kind) || !RUN_STATES.includes(row.state) ||
      [row.sequence, row.version, row.output_characters].some((number) => !Number.isSafeInteger(number) || number < 0) ||
      (row.purpose !== null && (!['review', 'study', 'living', 'forge'].includes(row.purpose) || row.kind !== 'plan')) ||
      row.output_characters > AI_OUTPUT_LIMIT || typeof row.chapter_title !== 'string' || row.chapter_title.length > 120 ||
      typeof row.connection_name !== 'string' || row.connection_name.length > 80 || typeof row.model !== 'string' || row.model.length > 200 ||
      (row.error !== null && (typeof row.error !== 'string' || row.error.length > 500))) throw storageFailure()
    requiredId(row.connection_id)
    return { id: requiredId(row.id), bookId, chapterId: requiredId(row.chapter_id), chapterTitle: row.chapter_title,
      ...(row.purpose === 'review' || row.purpose === 'study' || row.purpose === 'living' || row.purpose === 'forge' ? { purpose: row.purpose } : {}),
      kind: row.kind, state: row.state, version: row.version, connectionName: row.connection_name, model: row.model,
      outputCharacters: row.output_characters, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }
  } catch { throw storageFailure() }
}
function storedContext(row: RunRow, bookId: string): AiContextPacket {
  try {
    if (!/^[0-9a-f]{64}$/.test(row.context_hash) || !/^[0-9a-f]{64}$/.test(row.context_integrity_hash) ||
      hash(row.context_json) !== row.context_integrity_hash || row.context_json.length > AI_CONTEXT_LIMIT * 24) throw storageFailure()
    const value: unknown = JSON.parse(row.context_json)
    if (!isRecord(value) || value.bookId !== bookId || value.chapterId !== row.chapter_id || value.kind !== row.kind ||
      value.chapterTitle !== row.chapter_title || value.contextHash !== row.context_hash ||
      !Array.isArray(value.evidence) || value.evidence.length > 12 || !Array.isArray(value.chapterBlocks) ||
      !Array.isArray(value.messages) || !Array.isArray(value.warnings) || typeof value.originalText !== 'string' ||
      value.originalText.length > AI_CONTEXT_LIMIT) throw storageFailure()
    const config = checkedConnection(value.connection)
    if (config.id !== row.connection_id || config.name !== row.connection_name || config.model !== row.model) throw storageFailure()
    const contextSummaries = value.contextSummaries === undefined ? [] : parseAiContextSummarySnapshots(value.contextSummaries)
    const characterContext = value.characterContext === undefined ? undefined : parseAiCharacterContext(value.characterContext)
    const creativeResources = value.creativeResources === undefined ? undefined : parseCreativeResources(value.creativeResources)
    const livingContext = value.livingContext === undefined ? undefined : parseLivingWritingContext(value.livingContext)
    if (livingContext && JSON.stringify(livingContext) !== JSON.stringify(value.livingContext)) throw storageFailure()
    if (creativeResources && JSON.stringify(creativeResources) !== JSON.stringify(value.creativeResources)) throw storageFailure()
    if (value.purpose === 'study' && (value.writingContext !== undefined || value.chapterBlocks.length || value.originalText !== '')) throw storageFailure()
    if (value.purpose === 'living' && (value.writingContext !== undefined || value.originalText !== '' || value.summary !== undefined)) throw storageFailure()
    if (value.purpose === 'forge' && (value.writingContext !== undefined || value.creativeResources !== undefined || value.livingContext !== undefined || value.summary !== undefined ||
      value.perspective !== undefined || value.evidence.length || contextSummaries.length || value.originalText !== '' ||
      !forgeUsesChapter(forgeInstructionKind(value.instruction as string)) && value.chapterBlocks.length)) throw storageFailure()
    if (value.writingContext !== undefined && (isAiMemoryTask(row.kind) || value.perspective === 'reader' || value.perspective === 'character' ||
      JSON.stringify(parseAiWritingContext(value.writingContext)) !== JSON.stringify(value.writingContext))) throw storageFailure()
    if ((value.perspective === 'character') !== Boolean(characterContext)) throw storageFailure()
    parseAiPrepareInput({ bookId, chapterId: value.chapterId, expectedBookRevision: value.bookRevision,
      expectedKnowledgeRevision: value.knowledgeRevision, expectedRevisionId: value.chapterRevisionId, connectionId: config.id,
      kind: value.kind, purpose: value.purpose, instruction: value.instruction, contextScope: value.contextScope, perspective: value.perspective,
      selectedBlockIds: value.selectedBlockIds, memoryChunkIds: value.evidence.map((item) => isRecord(item) ? item.chunkId : null),
      ...(characterContext ? { characterScope: characterScopeOf(characterContext) } : {}),
      ...(contextSummaries.length ? { summaryRefs: contextSummaries.map(contextSummaryRef) } : {}),
      ...(livingContext ? { useLivingContext: true } : {}),
      ...(creativeResources ? { resourceRefs: creativeResources.items.map(creativeRef), resourceApplication: creativeResources.application } : {}) })
    if (value.messages.some((item) => !isRecord(item) || (item.role !== 'system' && item.role !== 'user') || typeof item.content !== 'string') ||
      value.messages.reduce((length: number, item: unknown) => length + (isRecord(item) && typeof item.content === 'string' ? item.content.length : 0), 0) > AI_CONTEXT_LIMIT) throw storageFailure()
    if (value.summary !== undefined) {
      const summaryContext = parseAiSummaryContext(value.summary)
      const anchor = summaryContext.sources[0]!
      const estimated = Math.ceil(Buffer.byteLength(JSON.stringify(value.messages), 'utf8') * 1.1) + 1024
      if (row.kind !== 'summarize' || value.promptVersion !== AI_SUMMARY_PROMPT_VERSION || value.contextScope !== 'chapter' || contextSummaries.length ||
        !Array.isArray(value.selectedBlockIds) || value.selectedBlockIds.length || value.originalText !== '' || value.chapterBlocks.length || value.evidence.length ||
        value.chapterId !== anchor.chapterId || value.chapterRevisionId !== anchor.chapterRevisionId || value.chapterTitle !== anchor.chapterTitle ||
        value.messages.length !== 2 || !isRecord(value.messages[0]) || value.messages[0].role !== 'system' ||
        !isRecord(value.messages[1]) || value.messages[1].role !== 'user' || value.warnings.some((warning) => typeof warning !== 'string') ||
        value.perspective !== undefined || characterContext !== undefined || value.estimatedInputTokens !== estimated || value.reservedOutputTokens !== config.maxOutputTokens ||
        estimated + config.maxOutputTokens > config.contextWindow) throw storageFailure()
    } else {
      const supportedPrompt = value.purpose === 'review' && value.promptVersion === REVIEW_PROMPT_VERSION || value.purpose === 'study' && value.promptVersion === STUDY_CARDS_PROMPT_VERSION ? true : characterContext ? isAiCharacterContextPromptVersion(value.promptVersion)
        : value.promptVersion === (isAiMemoryTask(row.kind) ? AI_MEMORY_PROMPT_VERSION : value.perspective === 'reader' ? AI_READER_CONTEXT_PROMPT_VERSION : contextSummaries.length ? AI_CONTEXT_SUMMARY_PROMPT_VERSION : AI_PROMPT_VERSION)
      if (!supportedPrompt) throw storageFailure()
    }
    if (characterContext) {
      // 历史记录保留当次身份、时点与认知，不从当前人物条目重新补全旧预览。
      if (JSON.stringify(characterContext) !== JSON.stringify(value.characterContext) ||
        characterContext.cognitions.length !== value.evidence.length || value.evidence.some((item, index) => {
          const cognition = characterContext.cognitions[index]!
          return !isRecord(item) || item.bookId !== bookId || item.chunkId !== cognition.chunkId || item.sourceKind !== 'story' ||
            item.sourceId !== cognition.recordId || item.revisionId !== cognition.revisionId || item.nature !== 'character_belief' ||
            item.authorDecision !== 'adopted' || item.freshness !== 'current' || item.referenceState !== 'current' ||
            item.dependencyState !== 'current' || (item.conflictState !== 'clear' && item.conflictState !== 'explained')
        })) throw storageFailure()
    }
    if (value.perspective === 'reader' || characterContext?.readerLimited) {
      if (contextSummaries.length || value.summary !== undefined || value.evidence.some((item) => {
        if (!isRecord(item) || item.sourceKind !== 'story') return true
        const disclosure = parseDisclosure(item.readerDisclosure)
        return disclosure.state !== 'located' || JSON.stringify(disclosure) !== JSON.stringify(item.readerDisclosure)
      })) throw storageFailure()
    }
    if (contextSummaries.length || value.perspective === 'reader' || characterContext || value.writingContext !== undefined || creativeResources || livingContext || value.purpose === 'living' || value.purpose === 'forge' || value.purpose === 'review' && value.promptVersion === REVIEW_PROMPT_VERSION) {
      const estimated = Math.ceil(Buffer.byteLength(JSON.stringify(value.messages), 'utf8') * 1.1) + 1024
      if (value.messages.length !== 2 || !isRecord(value.messages[0]) || value.messages[0].role !== 'system' ||
        !isRecord(value.messages[1]) || value.messages[1].role !== 'user' || value.warnings.some((warning) => typeof warning !== 'string') ||
        value.estimatedInputTokens !== estimated || value.reservedOutputTokens !== config.maxOutputTokens || estimated + config.maxOutputTokens > config.contextWindow) throw storageFailure()
    }
    return value as unknown as AiContextPacket
  } catch { throw storageFailure() }
}
function readRunRow(db: Database.Database, bookId: string, runId: string): RunRow {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM ai_runs WHERE id = ? AND book_id = ?`).get(runId, bookId) as RunRow | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个 AI 候选。' })
  return row
}
function run(row: RunRow, bookId: string): AiRun {
  const base = summary(row, bookId)
  try {
    const usage: unknown = row.usage_json === null ? null : JSON.parse(row.usage_json)
    const finish = parseAiFinishInput({ bookId, runId: row.id, state: 'interrupted', outputText: row.output_text,
      usage, finishReason: row.finish_reason, error: row.error })
    if (row.output_characters !== Array.from(row.output_text).length || (row.accepted_text !== null &&
      (typeof row.accepted_text !== 'string' || !row.accepted_text.trim() || row.accepted_text.length > AI_OUTPUT_LIMIT)) ||
      (row.state === 'adopted') !== (row.accepted_text !== null && row.adopted_revision_id !== null)) throw storageFailure()
    if (row.adopted_revision_id !== null) requiredId(row.adopted_revision_id)
    return { ...base, context: storedContext(row, bookId), outputText: row.output_text, acceptedText: row.accepted_text,
      adoptedRevisionId: row.adopted_revision_id, usage: finish.usage, finishReason: row.finish_reason }
  } catch { throw storageFailure() }
}

/** 作品恢复校验使用传入的只读连接，保持候选的来源与完整性检查一致。 */
export function readStoredAiRun(db: Database.Database, bookId: string, runId: string): AiRun {
  return run(readRunRow(db, bookId, runId), bookId)
}

function memoryAdoptions(db: Database.Database, candidate: AiRun): AiRun {
  if (candidate.context.summary !== undefined || !isAiMemoryTask(candidate.kind) || candidate.state !== 'adopted') return candidate
  const row = db.prepare('SELECT book_id, review_json FROM ai_memory_adoptions WHERE run_id = ?').get(candidate.id) as { book_id: string; review_json: string } | undefined
  try {
    if (!row || row.book_id !== candidate.bookId || row.review_json !== candidate.acceptedText || candidate.adoptedRevisionId !== candidate.context.chapterRevisionId) throw storageFailure()
    const value: unknown = JSON.parse(row.review_json)
    if (!isRecord(value) || Object.keys(value).some((key) => key !== 'entries') || !Array.isArray(value.entries)) throw storageFailure()
    const entries = value.entries
    const checked = parseAiMemoryAdoptInput({ bookId: candidate.bookId, runId: candidate.id, expectedVersion: candidate.version,
      entries: entries.map((entry: unknown) => isRecord(entry) ? { sourceIndex: entry.sourceIndex, fields: entry.fields,
        ...(entry.action === undefined ? {} : { action: entry.action }),
        ...(entry.targetItemId === undefined ? {} : { targetItemId: entry.targetItemId, expectedTargetRevisionId: entry.expectedTargetRevisionId }) } : null) }, 'history')
    const proposal = parseAiMemoryProposal(candidate.outputText, candidate.context, 'history')
    const ids = new Set<string>()
    const adopted: AiMemoryAdoptedEntry[] = checked.entries.map((entry, index) => {
      const saved = entries[index]
      if (!isRecord(saved) || Object.keys(saved).some((key) => !['itemId', 'sourceIndex', 'fields', 'citations', 'action', 'targetItemId', 'expectedTargetRevisionId', 'changed', 'previousFields', 'resultingRevisionId'].includes(key))) throw storageFailure()
      const action = entry.action ?? 'create'
      const existing = action === 'link' || action === 'revise'
      const itemId = action === 'ignore' && saved.itemId === null ? null : requiredId(saved.itemId)
      const original = proposal.items[entry.sourceIndex]
      if ((itemId !== null && ids.has(itemId)) || !original || (!existing && original.nature !== entry.fields.nature) ||
        (candidate.kind === 'summarize' && (entry.fields.kind !== 'other' || action !== 'create')) || JSON.stringify(saved.citations) !== JSON.stringify(original.citations)) throw storageFailure()
      if (saved.changed !== undefined && typeof saved.changed !== 'boolean') throw storageFailure()
      if (action === 'ignore' && (itemId !== null || saved.changed !== false || saved.resultingRevisionId !== undefined || saved.previousFields !== undefined)) throw storageFailure()
      if (action === 'create' && (saved.changed === false || saved.previousFields !== undefined)) throw storageFailure()
      const previousFields = existing ? parseKnowledgeFields(saved.previousFields) : undefined
      if (existing && (itemId !== entry.targetItemId || typeof saved.changed !== 'boolean' ||
        previousFields!.kind !== entry.fields.kind || previousFields!.nature !== entry.fields.nature ||
        (action === 'link' && JSON.stringify(previousFields) !== JSON.stringify(entry.fields)))) throw storageFailure()
      const resultingRevisionId = saved.resultingRevisionId === undefined ? undefined : requiredId(saved.resultingRevisionId)
      if (existing && !resultingRevisionId) throw storageFailure()
      if (existing && (entry.fields.kind !== original.kind || (saved.changed === false &&
        (resultingRevisionId !== entry.expectedTargetRevisionId || JSON.stringify(previousFields) !== JSON.stringify(entry.fields))))) throw storageFailure()
      if (itemId !== null) ids.add(itemId)
      return { ...entry, itemId, citations: original.citations,
        ...(saved.changed === undefined ? {} : { changed: saved.changed as boolean }),
        ...(previousFields ? { previousFields } : {}), ...(resultingRevisionId ? { resultingRevisionId } : {}) }
    })
    return { ...candidate, memoryAdoptions: adopted }
  } catch { throw storageFailure() }
}
function expectedVersion(row: RunRow, version: number): void {
  if (row.version !== version) conflict('候选已有新状态，请刷新后再操作；当前内容已保留。')
}
function requireRunning(row: RunRow): void {
  if (row.state !== 'running') conflict('这个候选已不在生成中，本次输出没有覆盖已有结果。')
}
function prefix(row: RunRow, output: string): void {
  if (!output.startsWith(row.output_text)) conflict('输出检查点必须保留已保存前缀，本次写入没有覆盖已有输出。')
}

export class AiRepository {
  constructor(private readonly studio: StudioRepository, private readonly memorySearch: MemorySearchRepository) {}

  listConnections(input: AiBookInput): AiConnectionPage {
    const data = parseAiBookInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      readBook(db, data.bookId)
      if (schemaVersion(db) < 6) return { bookId: data.bookId, requiresUpgrade: true, connections: [], sessionKeyIds: [] }
      const rows = db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM ai_connections WHERE book_id = ? ORDER BY name, id LIMIT ?`)
        .all(data.bookId, MAX_CONNECTIONS + 1) as ConnectionRow[]
      if (rows.length > MAX_CONNECTIONS) throw storageFailure()
      return { bookId: data.bookId, requiresUpgrade: false, connections: rows.map((row) => connection(row, data.bookId)), sessionKeyIds: [] }
    })
  }

  saveConnection(input: AiConnectionSaveInput): AiConnection {
    const data = parseAiConnectionSaveInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireAi(db)
      return db.transaction(() => {
        writable(readBook(db, data.bookId))
        const existing = db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM ai_connections WHERE id = ? AND book_id = ?`)
          .get(data.connection.id, data.bookId) as ConnectionRow | undefined
        if (existing) {
          const previous = connection(existing, data.bookId)
          if (data.expectedVersion !== previous.version) conflict('连接配置已有新版本，请刷新后再保存。')
          if (previous.version >= Number.MAX_SAFE_INTEGER) throw storageFailure()
          const fields = data.connection
          const updated = db.prepare(`UPDATE ai_connections SET name = ?, base_url = ?, model = ?, context_window = ?, max_output_tokens = ?,
            version = version + 1, updated_at = ? WHERE id = ? AND book_id = ? AND version = ?`).run(fields.name, fields.baseUrl, fields.model,
            fields.contextWindow, fields.maxOutputTokens, new Date().toISOString(), fields.id, data.bookId, previous.version)
          if (updated.changes !== 1) conflict('连接配置已变化，本次修改没有覆盖新配置。')
        } else {
          if (data.expectedVersion !== null) conflict('这个连接已不存在，请另建连接。')
          const total = db.prepare('SELECT count(*) AS total FROM ai_connections WHERE book_id = ?').get(data.bookId) as { total: number }
          if (total.total >= MAX_CONNECTIONS) invalid(`每部作品最多保存 ${MAX_CONNECTIONS} 个模型连接。`)
          const fields = data.connection
          db.prepare(`INSERT INTO ai_connections (id, book_id, name, base_url, model, context_window, max_output_tokens, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(fields.id, data.bookId, fields.name, fields.baseUrl, fields.model,
              fields.contextWindow, fields.maxOutputTokens, new Date().toISOString())
        }
        return this.readConnection(db, data.bookId, data.connection.id)
      }).immediate()
    })
  }

  list(input: AiListInput): AiRunPage {
    const data = parseAiListInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      readBook(db, data.bookId)
      if (schemaVersion(db) < 6) return { bookId: data.bookId, requiresUpgrade: true, runs: [], nextBefore: null }
      let before: number | null = null
      if (data.before) {
        const cursor = db.prepare("SELECT sequence FROM ai_runs WHERE id = ? AND book_id = ? AND json_type(context_json, '$.summary') IS NULL").get(data.before, data.bookId) as { sequence: number } | undefined
        if (!cursor || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1) invalid('候选分页位置无效，请重新读取候选列表。')
        before = cursor.sequence
      }
      const rows = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM ai_runs WHERE book_id = ? AND json_type(context_json, '$.summary') IS NULL AND (? IS NULL OR sequence < ?)
        ORDER BY sequence DESC LIMIT ?`).all(data.bookId, before, before, PAGE_SIZE + 1) as SummaryRow[]
      const runs = rows.slice(0, PAGE_SIZE).map((row) => summary(row, data.bookId))
      return { bookId: data.bookId, requiresUpgrade: false, runs, nextBefore: rows.length > PAGE_SIZE ? runs[runs.length - 1].id : null }
    })
  }

  prepare(input: AiPrepareServiceInput): AiRun {
    if (!isRecord(input) || Object.keys(input).some((key) => !['bookId', 'chapterId', 'expectedBookRevision', 'expectedKnowledgeRevision',
      'expectedRevisionId', 'connectionId', 'kind', 'purpose', 'instruction', 'contextScope', 'perspective', 'characterScope', 'selectedBlockIds', 'memoryChunkIds', 'summaryRefs', 'resourceRefs', 'resourceApplication', 'useLivingContext', 'connection'].includes(key))) invalid('准备请求格式无效。')
    const { connection: requestedConnection, ...request } = input
    const data = parseAiPrepareInput(request)
    const config = checkedConnection(requestedConnection)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireAi(db)
      if (data.purpose === 'forge') {
        requireForge(db)
        if (!db.inTransaction) invalid('请从角色与世界工坊准备固定预览。')
      }
      if (isAiMemoryTask(data.kind) && schemaVersion(db) < 7) throw new DomainError({ code: 'FORBIDDEN', message: '章节整理需要先备份并升级至 v7；已有创作协作仍可使用。' })
      return db.transaction(() => {
        const book = readBook(db, data.bookId)
        writable(book)
        const stored = this.readConnection(db, data.bookId, data.connectionId)
        if (!sameConnection(stored, config)) conflict('连接配置已变化，请刷新后重新预览。')
        const context = buildAiContext(this.studio, this.memorySearch, { ...data, connection: stored })
        if (context.bookId !== data.bookId || context.chapterId !== data.chapterId || context.bookRevision !== book.revision ||
          context.knowledgeRevision !== book.knowledge_revision || context.chapterRevisionId !== data.expectedRevisionId ||
          context.kind !== data.kind || context.purpose !== data.purpose || (context.perspective ?? 'author') !== (data.perspective ?? 'author') ||
          JSON.stringify(context.characterContext ? characterScopeOf(context.characterContext) : undefined) !== JSON.stringify(data.characterScope) ||
          !sameConnection(context.connection, stored) || !/^[0-9a-f]{64}$/.test(context.contextHash)) throw storageFailure()
        const id = randomUUID()
        const now = new Date().toISOString()
        const contextJson = JSON.stringify(context)
        db.prepare(`INSERT INTO ai_runs (id, book_id, chapter_id, chapter_title, kind, connection_id, connection_name, model,
          context_hash, context_integrity_hash, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, data.bookId, data.chapterId, context.chapterTitle, data.kind, stored.id, stored.name, stored.model,
            context.contextHash, hash(contextJson), contextJson, now, now)
        return run(readRunRow(db, data.bookId, id), data.bookId)
      }).immediate()
    })
  }

  prepareSummary(packet: AiContextPacket): AiRun {
    return perform(() => {
      const { bookId } = parseAiBookInput({ bookId: packet.bookId })
      const db = this.studio.getMemoryDatabase(bookId)
      if (schemaVersion(db) < 9) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级至 v9，再使用卷与全书分层汇总。' })
      return db.transaction(() => {
        const book = readBook(db, bookId)
        writable(book)
        if (packet.bookId !== bookId || packet.kind !== 'summarize' || packet.promptVersion !== AI_SUMMARY_PROMPT_VERSION || packet.summary === undefined) throw storageFailure()
        if (packet.bookRevision !== book.revision || packet.knowledgeRevision !== book.knowledge_revision) conflict('作品或知识已有新版本，请重新预览汇总来源。')
        const config = checkedConnection(packet.connection)
        const stored = this.readConnection(db, bookId, config.id)
        if (!sameConnection(stored, config)) conflict('连接配置已变化，请刷新后重新预览汇总。')
        validateAiSummaryContext(this.studio, this, packet)
        const id = randomUUID()
        const now = new Date().toISOString()
        const contextJson = JSON.stringify(packet)
        // 章修订只充当既有运行表的外键锚点；发送依据由汇总校验器核对全部有序子来源。
        db.prepare(`INSERT INTO ai_runs (id, book_id, chapter_id, chapter_title, kind, connection_id, connection_name, model,
          context_hash, context_integrity_hash, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, bookId, packet.chapterId, packet.chapterTitle, 'summarize', stored.id, stored.name, stored.model,
            packet.contextHash, hash(contextJson), contextJson, now, now)
        return run(readRunRow(db, bookId, id), bookId)
      }).immediate()
    })
  }

  get(input: AiRunInput): AiRun {
    const data = parseAiRunInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireAi(db)
      readBook(db, data.bookId)
      return memoryAdoptions(db, run(readRunRow(db, data.bookId, data.runId), data.bookId))
    })
  }

  claim(input: AiStartInput): AiRun {
    const data = parseAiStartInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireAi(db)
      return db.transaction(() => {
        const row = readRunRow(db, data.bookId, data.runId)
        const candidate = run(row, data.bookId)
        expectedVersion(row, data.expectedVersion)
        if (row.state !== 'prepared') conflict('这个候选已开始或结束，请查看已保存结果；不会重新发送。')
        if (candidate.context.contextHash !== data.contextHash) conflict('预览指纹不匹配，请重新核对上下文。')
        this.verifyBaseline(db, candidate, true, data.maintenanceBaseline)
        const running = db.prepare("SELECT id FROM ai_runs WHERE book_id = ? AND state = 'running' LIMIT 1").get(data.bookId)
        if (running) conflict('当前作品已有生成中的候选，请先停止或核对该候选。')
        this.advance(db, row, { state: 'running' })
        return run(readRunRow(db, data.bookId, data.runId), data.bookId)
      }).immediate()
    })
  }

  checkpoint(input: AiCheckpointInput): AiRun {
    const data = parseAiCheckpointInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireAi(db)
      return db.transaction(() => {
        const row = readRunRow(db, data.bookId, data.runId)
        requireRunning(row)
        prefix(row, data.outputText)
        if (row.output_text !== data.outputText) this.advance(db, row, { outputText: data.outputText })
        return run(readRunRow(db, data.bookId, data.runId), data.bookId)
      }).immediate()
    })
  }

  finish(input: AiFinishInput): AiRun {
    const data = parseAiFinishInput(input)
    if (data.state === 'succeeded' && (!data.outputText.trim() || data.error !== null)) invalid('成功候选必须含完整输出且没有错误说明。')
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireAi(db)
      return db.transaction(() => {
        const row = readRunRow(db, data.bookId, data.runId)
        if (row.state !== 'running') {
          if (row.state === data.state && row.output_text === data.outputText && row.usage_json === (data.usage === null ? null : JSON.stringify(data.usage)) &&
            row.finish_reason === data.finishReason && row.error === data.error) return run(row, data.bookId)
          conflict('候选已结束，本次结果没有覆盖已有终态；不会自动重发。')
        }
        prefix(row, data.outputText)
        this.advance(db, row, { state: data.state, outputText: data.outputText, usage: data.usage, finishReason: data.finishReason, error: data.error })
        return run(readRunRow(db, data.bookId, data.runId), data.bookId)
      }).immediate()
    })
  }

  reject(input: AiVersionInput): AiRun {
    const data = parseAiVersionInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireAi(db)
      return db.transaction(() => {
        const row = readRunRow(db, data.bookId, data.runId)
        expectedVersion(row, data.expectedVersion)
        if (row.state === 'running' || row.state === 'adopted' || row.state === 'rejected') invalid('请先停止生成；已采用或已拒绝的候选不能再次拒绝。')
        this.advance(db, row, { state: 'rejected' })
        return run(readRunRow(db, data.bookId, data.runId), data.bookId)
      }).immediate()
    })
  }

  interrupt(input: AiVersionInput): AiRun {
    const data = parseAiVersionInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireAi(db)
      return db.transaction(() => {
        const row = readRunRow(db, data.bookId, data.runId)
        expectedVersion(row, data.expectedVersion)
        requireRunning(row)
        // 主进程确认没有活动网络后才调用；中断只保存现有部分输出，不重放远程请求。
        this.advance(db, row, { state: 'interrupted', error: '生成连接已中断，已保存的部分输出保留；请另建候选继续。' })
        return run(readRunRow(db, data.bookId, data.runId), data.bookId)
      }).immediate()
    })
  }

  adopt(input: AiAdoptInput): AiAdoptReceipt {
    const data = parseAiAdoptInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireAi(db)
      try {
        return db.transaction(() => {
          const row = readRunRow(db, data.bookId, data.runId)
          expectedVersion(row, data.expectedVersion)
          const candidate = run(row, data.bookId)
          if (row.state !== 'succeeded') invalid('只有已成功完成的候选可以采用，部分输出请先复制另行处理。')
          if (candidate.context.summary !== undefined) invalid('分层汇总须在汇总任务中审阅，不能写入正文或章节备注。')
          if (isAiMemoryTask(candidate.kind)) invalid('章节整理结果须逐条审阅后采用为知识，不能写入正文或章节备注。')
          if (candidate.context.purpose) invalid('审稿或拆书候选须在对应审阅入口逐项确认，不能采用为章节备注或正文。')
          const previous = this.verifyBaseline(db, candidate, false)
          if (!previous) throw storageFailure()
          if (candidate.context.bookRevision >= Number.MAX_SAFE_INTEGER) throw storageFailure()
          let chapter: ChapterSnapshot
          let adoptedNotes: string | null = null
          if (candidate.kind === 'plan') {
            adoptedNotes = previous.notes ? `${previous.notes}\n\n${data.acceptedText}` : data.acceptedText
            if (adoptedNotes.length > 20_000) invalid('采用后章节备注超过 20,000 个字符，请缩短采用内容。')
            chapter = this.appendPlan(db, previous, candidate.context, adoptedNotes)
          } else {
            const blocks = textToDocument(data.acceptedText).content
            let content = [...previous.document.content]
            if (candidate.kind === 'continue') content.push(...blocks)
            else {
              const ids = candidate.context.selectedBlockIds
              const start = content.findIndex((block) => block.attrs.id === ids[0])
              if (start < 0 || ids.some((id, index) => content[start + index]?.attrs.id !== id)) conflict('改写目标已变化，请保留候选并重新选择段落。')
              content.splice(start, ids.length, ...blocks)
            }
            // 新文字只生成纯文本段落；其余富文本块和独立定稿指针沿用原稿。
            const document = parseManuscript({ type: 'doc', content })
            chapter = this.studio.saveChapter({ bookId: data.bookId, chapterId: candidate.chapterId,
              expectedRevisionId: candidate.context.chapterRevisionId, document }, 'ai').chapter
          }
          db.prepare(`INSERT INTO ai_adoptions (run_id, book_id, chapter_id, original_output, accepted_text,
            previous_revision_id, adopted_revision_id, previous_notes, adopted_notes, book_revision, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(candidate.id, data.bookId, candidate.chapterId,
              candidate.outputText, data.acceptedText, previous.revisionId, chapter.revisionId,
              candidate.kind === 'plan' ? previous.notes : null, adoptedNotes, chapter.bookRevision, new Date().toISOString())
          this.advance(db, row, { state: 'adopted', acceptedText: data.acceptedText, adoptedRevisionId: chapter.revisionId })
          return { bookId: data.bookId, run: run(readRunRow(db, data.bookId, data.runId), data.bookId), chapter }
        }).immediate()
      } finally {
        // 书内采用事务完成或回滚后再纠正目录缓存，避免嵌套正文保存留下未提交修订。
        this.studio.refreshKnowledgeCatalog(data.bookId)
      }
    })
  }

  adoptMemory(input: AiMemoryAdoptInput): AiMemoryAdoptReceipt {
    const data = parseAiMemoryAdoptInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      if (schemaVersion(db) < 7) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级至 v7，再采用章节整理结果。' })
      try {
        return db.transaction(() => {
          const row = readRunRow(db, data.bookId, data.runId)
          expectedVersion(row, data.expectedVersion)
          const candidate = run(row, data.bookId)
          if (candidate.context.summary !== undefined) invalid('分层汇总须在汇总任务中采用，不能作为单章知识提议采用。')
          if (!isAiMemoryTask(candidate.kind) || candidate.state !== 'succeeded') invalid('只有成功完成的章节整理候选可以采用为知识。')
          const previous = this.verifyBaseline(db, candidate, false, data.maintenanceBaseline)
          if (!previous) throw storageFailure()
          const proposal = parseAiMemoryProposal(candidate.outputText, candidate.context)
          const entries = data.entries.map((entry) => {
            const original = proposal.items[entry.sourceIndex]
            const action = entry.action ?? 'create'
            if (!original || ((action === 'create' || action === 'ignore') && entry.fields.nature !== original.nature) ||
              (candidate.kind === 'summarize' && (entry.fields.kind !== 'other' || action !== 'create'))) invalid('所选条目、操作或知识性质与固定原提议不符；章节摘要须独立新建。')
            return { ...entry, citations: original.citations }
          })
          const knowledge = new KnowledgeRepository(this.studio)
          let revision = candidate.context.knowledgeRevision
          const adopted: AiMemoryAdoptedEntry[] = []
          for (const entry of entries) {
            const action = entry.action ?? 'create'
            if (action === 'ignore') { adopted.push({ ...entry, itemId: null, changed: false }); continue }
            const sources = entry.citations.map((citation) => ({ sourceType: 'chapter_text' as const, bookId: data.bookId,
              chapterId: candidate.chapterId, revisionId: candidate.context.chapterRevisionId, blockId: citation.blockId, quote: citation.quote }))
            // 来源、作者选择、实体修订和候选终态在同一事务提交；重复来源可能是无变化的关联。
            const target = action === 'create' ? null : knowledge.getItem({ bookId: data.bookId, id: entry.targetItemId! })
            const previousFields = target ? parseKnowledgeFields(target.revisions[0]!.fields) : undefined
            const resolvedFields = resolveKnowledgeFields(entry.fields, previousFields)
            if (target && (target.revisions[0]?.id !== entry.expectedTargetRevisionId || target.knowledgeRevision !== revision)) conflict('目标实体已变化，请重新读取后审阅。')
            if (previousFields && (previousFields.kind !== proposal.items[entry.sourceIndex]!.kind || previousFields.kind !== entry.fields.kind || previousFields.nature !== entry.fields.nature ||
              (action === 'link' && JSON.stringify(previousFields) !== JSON.stringify(resolvedFields)))) invalid('关联只能追加来源；显式修订须保持目标实体类型与知识性质，请重新核对。')
            const change = { bookId: data.bookId, expectedKnowledgeRevision: revision, fields: entry.fields }
            const saved = target
              ? knowledge.updateItemWithSources({ ...change, id: target.id }, entry.expectedTargetRevisionId!, sources)
              : knowledge.createItemWithSources(change, sources)
            const changed = saved.knowledgeRevision !== revision
            if (saved.knowledgeRevision !== revision + (changed ? 1 : 0)) throw storageFailure()
            revision = saved.knowledgeRevision
            adopted.push({ ...entry, fields: parseKnowledgeFields(saved.revisions[0]!.fields), itemId: saved.id, changed, resultingRevisionId: saved.revisions[0]!.id,
              ...(previousFields ? { previousFields } : {}) })
          }
          const reviewJson = JSON.stringify({ entries: adopted })
          if (reviewJson.length > AI_OUTPUT_LIMIT) invalid('采用内容与来源合计超过 60,000 字符，请减少条目或缩短说明。')
          db.prepare('INSERT INTO ai_memory_adoptions (run_id, book_id, review_json, created_at) VALUES (?, ?, ?, ?)')
            .run(candidate.id, data.bookId, reviewJson, new Date().toISOString())
          // 记忆采用保留原章修订作为来源锚点，正文与独立定稿指针不变。
          this.advance(db, row, { state: 'adopted', acceptedText: reviewJson, adoptedRevisionId: previous.revisionId })
          return { bookId: data.bookId, run: memoryAdoptions(db, run(readRunRow(db, data.bookId, data.runId), data.bookId)),
            status: this.studio.getKnowledgeStatus({ bookId: data.bookId }), itemIds: adopted.flatMap((entry) => entry.itemId === null ? [] : [entry.itemId]) }
        }).immediate()
      } finally { this.studio.refreshKnowledgeCatalog(data.bookId) }
    })
  }

  private readConnection(db: Database.Database, bookId: string, connectionId: string): AiConnection {
    const row = db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM ai_connections WHERE id = ? AND book_id = ?`).get(connectionId, bookId) as ConnectionRow | undefined
    if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个模型连接。' })
    return connection(row, bookId)
  }

  private verifyBaseline(db: Database.Database, candidate: AiRun, checkConnection: boolean, maintenanceBaseline?: AiMaintenanceBaseline): ChapterSnapshot | null {
    const context = candidate.context
    const book = readBook(db, candidate.bookId)
    writable(book)
    if (maintenanceBaseline) new AiMemoryTaskRepository(this.studio, this).verifyMaintenanceBaseline(candidate, maintenanceBaseline)
    else if (book.revision !== context.bookRevision || book.knowledge_revision !== context.knowledgeRevision) conflict('作品或知识已变化，请保留候选并按当前版本重新预览。')
    if (context.purpose === 'living') {
      requireLiving(db)
      const fixed = db.prepare('SELECT envelope_json FROM living_runs WHERE run_id = ?').get(candidate.id) as { envelope_json: string } | undefined
      if (!fixed || fixed.envelope_json !== context.instruction) conflict('演进提案缺少匹配的固定来源，请从演进沙盘重新准备。')
    }
    if (context.purpose === 'forge') {
      requireForge(db)
      const fixed = db.prepare('SELECT envelope_json FROM forge_runs WHERE run_id = ?').get(candidate.id) as { envelope_json: string } | undefined
      if (!fixed || fixed.envelope_json !== context.instruction) conflict('工坊任务缺少匹配的固定来源，请从工坊重新准备。')
    }
    if (checkConnection && !sameConnection(this.readConnection(db, candidate.bookId, context.connection.id), context.connection)) {
      conflict('模型连接已变化，请按当前配置重新预览。')
    }
    if (context.summary !== undefined) {
      if (schemaVersion(db) < 9) throw storageFailure()
      validateAiSummaryContext(this.studio, this, context)
      return null
    }
    const chapter = this.studio.readChapter({ bookId: candidate.bookId, chapterId: candidate.chapterId })
    if (chapter.revisionId !== context.chapterRevisionId || chapter.title !== context.chapterTitle) conflict('章节已变化，请保留候选并按当前版本重新预览。')
    validateAiContext(this.studio, this.memorySearch, context, maintenanceBaseline?.expectedBookRevision)
    return chapter
  }

  private appendPlan(db: Database.Database, previous: ChapterSnapshot, context: AiContextPacket, notes: string): ChapterSnapshot {
    const now = new Date().toISOString()
    const changed = db.prepare('UPDATE chapters SET notes = ?, updated_at = ? WHERE id = ? AND current_revision_id = ?')
      .run(notes, now, previous.id, context.chapterRevisionId)
    if (changed.changes !== 1) conflict('章节已经变化，本次规划没有覆盖新的备注。')
    const advanced = db.prepare(`UPDATE book_meta SET revision = revision + 1, updated_at = ?
      WHERE singleton = 1 AND id = ? AND revision = ? AND knowledge_revision = ? AND archived_at IS NULL`)
      .run(now, context.bookId, context.bookRevision, context.knowledgeRevision)
    if (advanced.changes !== 1) conflict('作品版本已变化，本次规划没有覆盖新资料。')
    db.prepare(`INSERT INTO outbox (id, kind, chapter_id, revision_id, book_revision, created_at)
      VALUES (?, 'chapter.metadata', ?, ?, ?, ?)`).run(randomUUID(), previous.id, context.chapterRevisionId, context.bookRevision + 1, now)
    return this.studio.readChapter({ bookId: context.bookId, chapterId: context.chapterId })
  }

  private advance(db: Database.Database, row: RunRow, change: {
    state?: AiRunState; outputText?: string; acceptedText?: string; adoptedRevisionId?: string
    usage?: AiUsage | null; finishReason?: string | null; error?: string | null
  }): void {
    if (!Number.isSafeInteger(row.version) || row.version >= Number.MAX_SAFE_INTEGER) throw storageFailure()
    const updated = db.prepare(`UPDATE ai_runs SET state = @state, version = version + 1, output_text = @output,
      accepted_text = @accepted, adopted_revision_id = @adoptedRevision, usage_json = @usage,
      finish_reason = @finishReason, error = @error, updated_at = @now WHERE id = @id AND book_id = @bookId AND version = @version`)
      .run({ id: row.id, bookId: row.book_id, version: row.version, state: change.state ?? row.state,
        output: change.outputText ?? row.output_text, accepted: change.acceptedText ?? row.accepted_text,
        adoptedRevision: change.adoptedRevisionId ?? row.adopted_revision_id,
        usage: change.usage === undefined ? row.usage_json : change.usage === null ? null : JSON.stringify(change.usage),
        finishReason: change.finishReason === undefined ? row.finish_reason : change.finishReason,
        error: change.error === undefined ? row.error : change.error, now: new Date().toISOString() })
    if (updated.changes !== 1) conflict('候选状态已变化，本次操作没有覆盖新结果。')
  }
}
