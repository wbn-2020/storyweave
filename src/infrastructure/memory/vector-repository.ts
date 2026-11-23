import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, isRecord, requiredId, requiredText } from '../../contracts/api'
import { parseAiConnection, type AiConnection } from '../../contracts/ai'
import { AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_NATURES } from '../../contracts/knowledge'
import { MEMORY_CHUNK_SIZE, MEMORY_SOURCE_KINDS, parseMemoryBookInput, parseMemorySearchInput, type MemoryBookInput, type MemoryEvidence, type MemorySearchPage } from '../../contracts/memory'
import {
  MEMORY_VECTOR_BATCH_SIZE, MEMORY_VECTOR_CANDIDATES, MEMORY_VECTOR_SCAN_LIMIT, MEMORY_VECTOR_TASK_LIMIT,
  parseMemoryVectorFinishInput, parseMemoryVectorPrepareServiceInput, parseMemoryVectorProfileServiceInput,
  parseMemoryVectorReadInput, parseMemoryVectorSearchResultInput, parseMemoryVectorStartInput, parseMemoryVectorValues, parseMemoryVectorVersionInput,
  type MemoryVectorContext, type MemoryVectorFinishInput, type MemoryVectorPrepareServiceInput,
  type MemoryVectorProfileServiceInput, type MemoryVectorReadInput, type MemoryVectorRun, type MemoryVectorRunPage,
  type MemoryVectorRunSummary, type MemoryVectorSearchResultInput, type MemoryVectorSearchResultPage, type MemoryVectorStartInput, type MemoryVectorStatus,
  type MemoryVectorUsage, type MemoryVectorVersionInput,
} from '../../contracts/memory-vector'
import { parseDisclosure } from '../../contracts/story'
import { BOOK_SCHEMA_VERSION } from '../storage/schema'
import { MemorySearchRepository, MEMORY_SEARCH_SOURCE_FILTER_SQL } from './search-repository'
import { currentMemoryArtifactsSql } from './task-repository'

interface BookRow { id: string; index_publication_version: number; archived_at: string | null }
interface ProfileRow { profile_hash: string; response_model: string; dimensions: number }
interface RunRow {
  id: string; book_id: string; version: number; state: MemoryVectorRun['state']; kind: MemoryVectorRun['kind']
  publication_version: number; connection_id: string; connection_name: string; embedding_model: string
  profile_hash: string; input_count: number; context_hash: string; context_integrity_hash: string; context_json: string
  result_json: string | null; result_integrity_hash: string | null; usage_json: string | null; error: string | null; created_at: string; updated_at: string
}
const RUN_COLUMNS = `id, book_id, version, state, kind, publication_version, connection_id, connection_name,
  embedding_model, profile_hash, input_count, context_hash, context_integrity_hash, context_json,
  result_json, result_integrity_hash, usage_json, error, created_at, updated_at`
const STATES = ['prepared', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const
const current = (db: Database.Database) => `WITH current_artifacts AS (${currentMemoryArtifactsSql(db)})`
// 与 JS trim 的空白集合一致，保留原片段文本，只排除没有向量输入意义的片段。
const VECTOR_TEXT_FILTER = `instr(c.text, char(0)) = 0 AND length(trim(c.text, char(9, 10, 11, 12, 13, 32, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0`
const INDEX_FILTER = `${VECTOR_TEXT_FILTER} AND (a.author_decision IS NULL OR a.author_decision != 'rejected')
  AND a.freshness = 'current' AND a.dependency_state = 'current'`
const HASH = /^[a-f0-9]{64}$/

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function profileHash(connection: AiConnection, embeddingModel: string): string {
  return digest(JSON.stringify({ version: 1, connection, embeddingModel }))
}
function storageFailure(): DomainError { return new DomainError({ code: 'STORAGE_ERROR', message: '向量索引资料无法核对，请保留作品与任务记录。' }) }
function conflict(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) { if (error instanceof DomainError) throw error; throw storageFailure() }
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function schemaVersion(db: Database.Database): number {
  const value = db.pragma('user_version', { simple: true })
  if (!integer(value, 2, BOOK_SCHEMA_VERSION)) throw storageFailure()
  return value
}
function requireVectors(db: Database.Database): void {
  if (schemaVersion(db) < 10) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级至 v10，再使用向量索引与混合检索。' })
}
function readBook(db: Database.Database, bookId: string, writable = false): BookRow {
  const row = db.prepare('SELECT id, index_publication_version, archived_at FROM book_meta WHERE singleton = 1').get() as BookRow | undefined
  if (!row || row.id !== bookId || !integer(row.index_publication_version)) throw storageFailure()
  if (writable && row.archived_at) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请解除归档后再准备或发送向量请求。' })
  return row
}
function currentConnection(db: Database.Database, bookId: string, connection: AiConnection): void {
  const row = db.prepare(`SELECT id, name, base_url AS baseUrl, model, context_window AS contextWindow,
    max_output_tokens AS maxOutputTokens, version, updated_at AS updatedAt FROM ai_connections WHERE id = ? AND book_id = ?`)
    .get(connection.id, bookId)
  const current = row ? parseAiConnection(row) : null
  if (!current || current.id !== connection.id || current.name !== connection.name || current.baseUrl !== connection.baseUrl ||
    current.model !== connection.model || current.contextWindow !== connection.contextWindow || current.maxOutputTokens !== connection.maxOutputTokens ||
    current.version !== connection.version || current.updatedAt !== connection.updatedAt) conflict('连接配置已变化，请重新选择连接并准备预览。')
}
function readProfile(db: Database.Database, hash: string): ProfileRow | null {
  const row = db.prepare('SELECT profile_hash, response_model, dimensions FROM memory_vector_profiles WHERE profile_hash = ?').get(hash) as ProfileRow | undefined
  if (!row) return null
  if (row.profile_hash !== hash || !integer(row.dimensions, 1, 4096) || requiredText(row.response_model, '返回向量模型', 200) !== row.response_model) throw storageFailure()
  return row
}
function count(db: Database.Database, sql: string, params: Record<string, string | number | null>): number {
  const row = db.prepare(sql).get(params) as { total: number } | undefined
  if (!row || !integer(row.total)) throw storageFailure()
  return row.total
}
function budget(input: string[]): number {
  if (input.some((text) => Math.ceil(Buffer.byteLength(text, 'utf8') * 1.1) > 8192)) invalid('单个片段超出本地保守输入预算，请缩小来源后重试。')
  const value = Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') * 1.1) + 1024
  if (value > 32_000) invalid('本批向量文本超出本地保守输入预算。')
  return value
}
function normalize(value: unknown): number[] {
  const vector = parseMemoryVectorValues(value)
  const scale = Math.max(...vector.map(Math.abs))
  const scaled = vector.map((entry) => entry / scale)
  const norm = Math.sqrt(scaled.reduce((sum, entry) => sum + entry * entry, 0))
  if (!Number.isFinite(norm) || norm <= 0) throw storageFailure()
  return scaled.map((entry) => entry / norm)
}
function storedEvidence(value: unknown, bookId: string, publication: number): MemoryEvidence {
  if (!isRecord(value) || value.bookId !== bookId || value.publicationVersion !== publication ||
    !MEMORY_SOURCE_KINDS.includes(value.sourceKind as MemoryEvidence['sourceKind']) ||
    !KNOWLEDGE_NATURES.includes(value.nature as MemoryEvidence['nature']) ||
    !(value.authorDecision === null || AUTHOR_DECISIONS.includes(value.authorDecision as NonNullable<MemoryEvidence['authorDecision']>)) || value.authorDecision === 'rejected' ||
    value.freshness !== 'current' || !CONFLICT_STATES.includes(value.conflictState as MemoryEvidence['conflictState']) ||
    value.referenceState !== 'current' || value.dependencyState !== 'current' ||
    typeof value.text !== 'string' || !value.text.trim() || value.text.includes('\0') || value.text.length > MEMORY_CHUNK_SIZE ||
    !integer(value.chunkId, 1) || !integer(value.startOffset) || !integer(value.endOffset) ||
    value.endOffset - value.startOffset !== value.text.length ||
    (value.sourceKind === 'chapter') !== (value.blockId !== null) ||
    (value.sourceKind === 'chapter') !== (value.authorDecision === null)) throw storageFailure()
  requiredId(value.sourceId); requiredId(value.revisionId)
  if (value.blockId !== null) requiredId(value.blockId)
  requiredText(value.title, '片段来源标题', 120)
  if (value.readerDisclosure !== undefined) parseDisclosure(value.readerDisclosure)
  return value as unknown as MemoryEvidence
}
function context(row: RunRow): MemoryVectorContext {
  if (typeof row.context_json !== 'string' || row.context_json.length > 160_000 || digest(row.context_json) !== row.context_integrity_hash) throw storageFailure()
  const value: unknown = JSON.parse(row.context_json)
  if (!isRecord(value) || Object.keys(value).some((key) => !['bookId', 'kind', 'publicationVersion', 'connection', 'embeddingModel', 'profileHash', 'items', 'input', 'search', 'estimatedInputTokens', 'contextHash'].includes(key)) ||
    value.bookId !== row.book_id || value.kind !== row.kind || value.publicationVersion !== row.publication_version ||
    value.embeddingModel !== row.embedding_model || value.profileHash !== row.profile_hash || value.contextHash !== row.context_hash ||
    !Array.isArray(value.input) || value.input.length !== row.input_count || value.input.some((text) => typeof text !== 'string' || !text.trim() || text.includes('\0')) ||
    !Array.isArray(value.items)) throw storageFailure()
  const connection = parseAiConnection(value.connection)
  if (connection.id !== row.connection_id || connection.name !== row.connection_name || profileHash(connection, row.embedding_model) !== row.profile_hash) throw storageFailure()
  const { contextHash: savedHash, ...body } = value
  if (digest(JSON.stringify(body)) !== savedHash || budget(value.input as string[]) !== value.estimatedInputTokens) throw storageFailure()
  if (row.kind === 'index') {
    if (value.search !== undefined || value.items.length !== value.input.length) throw storageFailure()
    const ids = new Set<number>()
    value.items.forEach((item, index) => {
      const evidence = storedEvidence(item, row.book_id, row.publication_version)
      if (evidence.text !== (value.input as string[])[index] || ids.has(evidence.chunkId)) throw storageFailure()
      ids.add(evidence.chunkId)
    })
  } else {
    const search = parseMemorySearchInput(value.search)
    if (search.bookId !== row.book_id || value.items.length !== 0 || value.input.length !== 1 || value.input[0] !== search.query) throw storageFailure()
  }
  return value as unknown as MemoryVectorContext
}
function summary(row: RunRow, bookId: string): MemoryVectorRunSummary {
  if (row.book_id !== bookId || !STATES.includes(row.state) || (row.kind !== 'index' && row.kind !== 'search') ||
    !integer(row.version, 0, 2) || (row.state === 'prepared' && row.version !== 0) || (row.state === 'running' && row.version !== 1) ||
    (['succeeded', 'failed', 'interrupted'].includes(row.state) && row.version !== 2) || (row.state === 'cancelled' && row.version < 1) ||
    !integer(row.publication_version, 1) || !integer(row.input_count, 1, MEMORY_VECTOR_BATCH_SIZE) ||
    (row.kind === 'search' && row.input_count !== 1) || !HASH.test(row.context_hash) || !HASH.test(row.profile_hash) ||
    (row.error !== null && (typeof row.error !== 'string' || row.error.length > 500)) ||
    !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at))) throw storageFailure()
  return { id: requiredId(row.id), bookId, version: row.version, state: row.state, kind: row.kind,
    publicationVersion: row.publication_version, connectionName: requiredText(row.connection_name, '连接名称', 80),
    embeddingModel: requiredText(row.embedding_model, '向量模型', 200), inputCount: row.input_count,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }
}
function readRow(db: Database.Database, bookId: string, runId: string): RunRow {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM memory_vector_runs WHERE id = ? AND book_id = ?`).get(runId, bookId) as RunRow | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个向量请求。' })
  summary(row, bookId)
  return row
}
function detail(row: RunRow): MemoryVectorRun {
  const packet = context(row)
  if ((row.result_json === null) !== (row.result_integrity_hash === null) ||
    (row.result_json !== null && (row.result_json.length > 250_000 || digest(row.result_json) !== row.result_integrity_hash))) throw storageFailure()
  const result: unknown = row.result_json === null ? null : JSON.parse(row.result_json)
  const usage: unknown = row.usage_json === null ? null : JSON.parse(row.usage_json)
  if ((row.state === 'succeeded' && row.kind === 'search') !== (result !== null) ||
    (result !== null && (!isRecord(result) || result.bookId !== row.book_id || result.publicationVersion !== row.publication_version ||
      result.mode !== 'hybrid_keyword_entity_vector' || !Array.isArray(result.hits) || result.hits.length > 50 || !isRecord(result.semantic) || !isRecord(result.status))) ||
    (usage !== null && (!isRecord(usage) || ![usage.inputTokens, usage.totalTokens].every((entry) => entry === null || integer(entry))))) throw storageFailure()
  if (isRecord(result)) {
    const scope = result.semantic as Record<string, unknown>
    const status = result.status as Record<string, unknown>
    if (scope.profileHash !== row.profile_hash || typeof scope.responseModel !== 'string' || !integer(scope.dimensions, 1, 4096) ||
      !integer(scope.eligibleChunks) || !integer(scope.indexedChunks) || !integer(scope.scannedChunks) || !integer(scope.scanLimit) ||
      (scope.scanLimit !== MEMORY_VECTOR_SCAN_LIMIT && scope.scanLimit !== scope.indexedChunks) ||
      scope.scannedChunks > scope.indexedChunks || scope.indexedChunks > scope.eligibleChunks || scope.scannedChunks > scope.scanLimit ||
      status.bookId !== row.book_id || status.publicationVersion !== row.publication_version || !integer(status.schemaVersion, 10, BOOK_SCHEMA_VERSION) ||
      typeof result.truncated !== 'boolean') throw storageFailure()
    const ids = new Set<number>()
    for (const hit of result.hits as unknown[]) {
      if (!isRecord(hit) || !integer(hit.chunkId, 1) || ids.has(hit.chunkId) ||
        !MEMORY_SOURCE_KINDS.includes(hit.sourceKind as MemoryEvidence['sourceKind']) ||
        !KNOWLEDGE_NATURES.includes(hit.nature as MemoryEvidence['nature']) ||
        !KNOWLEDGE_FRESHNESS.includes(hit.freshness as MemoryEvidence['freshness']) ||
        !CONFLICT_STATES.includes(hit.conflictState as MemoryEvidence['conflictState']) ||
        !(hit.authorDecision === null || AUTHOR_DECISIONS.includes(hit.authorDecision as NonNullable<MemoryEvidence['authorDecision']>)) ||
        hit.authorDecision === 'rejected' || typeof hit.excerpt !== 'string' || hit.excerpt.length > 362 ||
        (hit.dependencyState !== 'current' && hit.dependencyState !== 'source_changed') || !Array.isArray(hit.reasons) ||
        hit.reasons.length < 1 || hit.reasons.some((reason) => !['keyword', 'title', 'entity', 'semantic'].includes(reason))) throw storageFailure()
      requiredId(hit.sourceId); requiredId(hit.revisionId); requiredText(hit.title, '检索来源', 120)
      if (hit.blockId !== null) requiredId(hit.blockId)
      ids.add(hit.chunkId)
    }
  }
  return { ...summary(row, row.book_id), context: packet, result: result as MemorySearchPage | null, usage: usage as MemoryVectorUsage | null }
}
function expected(row: RunRow, version: number): void {
  if (row.version !== version) conflict('向量请求已有新状态，请读取原请求后继续；不会覆盖检查点。')
}
function advance(db: Database.Database, row: RunRow, state: MemoryVectorRun['state'], result: MemorySearchPage | null = null, usage: MemoryVectorUsage | null = null, error: string | null = null): MemoryVectorRun {
  const json = result === null ? null : JSON.stringify(result)
  const changed = db.prepare(`UPDATE memory_vector_runs SET version = version + 1, state = ?, result_json = ?, result_integrity_hash = ?, usage_json = ?, error = ?, updated_at = ?
    WHERE id = ? AND book_id = ? AND version = ?`).run(state, json, json === null ? null : digest(json), usage === null ? null : JSON.stringify(usage), error,
      new Date().toISOString(), row.id, row.book_id, row.version)
  if (changed.changes !== 1) conflict('向量请求检查点已变化。')
  return detail(readRow(db, row.book_id, row.id))
}

export class MemoryVectorRepository {
  constructor(private readonly getDatabase: (bookId: string) => Database.Database, private readonly memorySearch: MemorySearchRepository) {}

  list(input: MemoryBookInput): MemoryVectorRunPage {
    return perform(() => {
      const data = parseMemoryBookInput(input)
      const db = this.getDatabase(data.bookId)
      return db.transaction(() => {
        readBook(db, data.bookId)
        if (schemaVersion(db) < 10) return { bookId: data.bookId, requiresUpgrade: true, runs: [], truncated: false }
        // 运行中优先；多读一行只判断截断，不读取任务输入或选择当前模型。
        const rows = db.prepare(`SELECT id, book_id, version, state, kind, publication_version,
          connection_name, embedding_model, input_count, context_hash, profile_hash, error, created_at, updated_at
          FROM memory_vector_runs WHERE book_id = ?
          ORDER BY CASE WHEN state = 'running' THEN 0 ELSE 1 END, sequence DESC LIMIT ?`)
          .all(data.bookId, MEMORY_VECTOR_TASK_LIMIT + 1) as RunRow[]
        return { bookId: data.bookId, requiresUpgrade: false,
          runs: rows.slice(0, MEMORY_VECTOR_TASK_LIMIT).map((row) => summary(row, data.bookId)),
          truncated: rows.length > MEMORY_VECTOR_TASK_LIMIT }
      })()
    })
  }

  status(input: MemoryVectorProfileServiceInput): MemoryVectorStatus {
    return perform(() => {
      const data = parseMemoryVectorProfileServiceInput(input)
      const db = this.getDatabase(data.bookId)
      return db.transaction(() => {
        const book = readBook(db, data.bookId)
        const hash = profileHash(data.connection, data.embeddingModel)
        const base = { bookId: data.bookId, publicationVersion: book.index_publication_version, profileHash: hash }
        if (schemaVersion(db) < 10) return { ...base, requiresUpgrade: true, eligibleChunks: 0, indexedChunks: 0, dimensions: null, responseModel: null, recentRuns: [] }
        currentConnection(db, data.bookId, data.connection)
        const profile = readProfile(db, hash)
        const counts = db.prepare(`${current(db)} SELECT count(*) AS eligible,
          count(v.chunk_id) AS indexed FROM current_artifacts a JOIN memory_chunks c ON c.artifact_id = a.id
          LEFT JOIN memory_vectors v ON v.chunk_id = c.id AND v.profile_hash = ? WHERE ${INDEX_FILTER}`).get(hash) as { eligible: number; indexed: number }
        if (!integer(counts.eligible) || !integer(counts.indexed) || counts.indexed > counts.eligible) throw storageFailure()
        const rows = db.prepare(`SELECT ${RUN_COLUMNS} FROM memory_vector_runs WHERE book_id = ? ORDER BY sequence DESC LIMIT 20`).all(data.bookId) as RunRow[]
        return { ...base, requiresUpgrade: false, eligibleChunks: counts.eligible, indexedChunks: counts.indexed,
          dimensions: profile?.dimensions ?? null, responseModel: profile?.response_model ?? null, recentRuns: rows.map((row) => summary(row, data.bookId)) }
      })()
    })
  }

  listSearchResults(input: MemoryVectorSearchResultInput): MemoryVectorSearchResultPage {
    return perform(() => {
      const data = parseMemoryVectorSearchResultInput(input)
      const db = this.getDatabase(data.bookId)
      return db.transaction(() => {
        const book = readBook(db, data.bookId)
        if (book.index_publication_version !== data.expectedPublicationVersion) conflict('本地索引发布批次已变化，请刷新后读取检索结果。')
        const base = { bookId: data.bookId, publicationVersion: book.index_publication_version }
        if (schemaVersion(db) < 10) return { ...base, items: [], truncated: false }
        const rows = db.prepare(`SELECT ${RUN_COLUMNS} FROM memory_vector_runs
          WHERE book_id = ? AND publication_version = ? AND kind = 'search' AND state = 'succeeded'
          ORDER BY sequence DESC LIMIT 7`).all(data.bookId, book.index_publication_version) as RunRow[]
        // 列表只复用当前发布批次的成功快照；每条返回项仍校验完整上下文和结果指纹。
        const items = rows.slice(0, 6).map((row) => {
          const run = detail(row)
          if (!run.context.search || !run.result) throw storageFailure()
          return { id: run.id, query: run.context.search.query, connectionName: run.connectionName,
            embeddingModel: run.embeddingModel, updatedAt: run.updatedAt, hitCount: run.result.hits.length,
            truncated: run.result.truncated }
        })
        return { ...base, items, truncated: rows.length > 6 }
      })()
    })
  }

  prepare(input: MemoryVectorPrepareServiceInput): MemoryVectorRun {
    return perform(() => {
      const data = parseMemoryVectorPrepareServiceInput(input)
      const db = this.getDatabase(data.bookId)
      requireVectors(db)
      return db.transaction(() => {
        const book = readBook(db, data.bookId, true)
        if (book.index_publication_version !== data.expectedPublicationVersion) conflict('本地索引发布批次已变化，请刷新后准备。')
        currentConnection(db, data.bookId, data.connection)
        const hash = profileHash(data.connection, data.embeddingModel)
        let items: MemoryEvidence[] = []
        if (data.kind === 'index') {
          const rows = db.prepare(`${current(db)} SELECT c.id FROM current_artifacts a JOIN memory_chunks c ON c.artifact_id = a.id
            WHERE ${INDEX_FILTER} AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.profile_hash = ? AND v.chunk_id = c.id)
            ORDER BY c.id LIMIT ?`).all(hash, MEMORY_VECTOR_BATCH_SIZE) as { id: number }[]
          if (!rows.length) invalid('当前发布资料已没有需要处理的有效片段，请刷新覆盖状态。')
          items = rows.map((row) => this.memorySearch.evidence({ bookId: data.bookId, chunkId: row.id }))
          items.forEach((item) => storedEvidence(item, data.bookId, book.index_publication_version))
          while (items.length > 1 && Math.ceil(Buffer.byteLength(JSON.stringify(items.map((item) => item.text)), 'utf8') * 1.1) + 1024 > 32_000) items.pop()
        } else this.verifySearchScope(db, hash, data.search!)
        const text = data.kind === 'index' ? items.map((item) => item.text) : [data.search!.query]
        const body = { bookId: data.bookId, kind: data.kind, publicationVersion: book.index_publication_version,
          connection: data.connection, embeddingModel: data.embeddingModel, profileHash: hash, items, input: text,
          ...(data.search ? { search: data.search } : {}), estimatedInputTokens: budget(text) }
        const packet: MemoryVectorContext = { ...body, contextHash: digest(JSON.stringify(body)) }
        const existing = db.prepare(`SELECT ${RUN_COLUMNS} FROM memory_vector_runs WHERE context_hash = ? AND state IN ('prepared', 'running')`).get(packet.contextHash) as RunRow | undefined
        if (existing) return detail(existing)
        const id = randomUUID()
        const now = new Date().toISOString()
        const json = JSON.stringify(packet)
        db.prepare(`INSERT INTO memory_vector_runs (id, book_id, kind, publication_version, connection_id, connection_name,
          embedding_model, profile_hash, input_count, context_hash, context_integrity_hash, context_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, data.bookId, data.kind, book.index_publication_version,
            data.connection.id, data.connection.name, data.embeddingModel, hash, text.length, packet.contextHash, digest(json), json, now, now)
        return detail(readRow(db, data.bookId, id))
      }).immediate()
    })
  }

  get(input: MemoryVectorReadInput): MemoryVectorRun {
    return perform(() => {
      const data = parseMemoryVectorReadInput(input)
      const db = this.getDatabase(data.bookId)
      requireVectors(db); readBook(db, data.bookId)
      return detail(readRow(db, data.bookId, data.runId))
    })
  }

  claim(input: MemoryVectorStartInput): MemoryVectorRun {
    return perform(() => {
      const data = parseMemoryVectorStartInput(input)
      const db = this.getDatabase(data.bookId)
      requireVectors(db)
      return db.transaction(() => {
        const row = readRow(db, data.bookId, data.runId)
        expected(row, data.expectedVersion)
        if (row.state !== 'prepared') conflict('这个请求已开始或结束，不会重新发送。')
        const run = detail(row)
        if (run.context.contextHash !== data.contextHash) conflict('向量预览指纹不匹配。')
        this.verifyLive(db, run, true)
        if (db.prepare("SELECT id FROM memory_vector_runs WHERE state = 'running' LIMIT 1").get()) conflict('已有向量请求尚未结束，请先核对原请求。')
        return advance(db, row, 'running')
      }).immediate()
    })
  }

  finish(input: MemoryVectorFinishInput): MemoryVectorRun {
    return perform(() => {
      const data = parseMemoryVectorFinishInput(input)
      const db = this.getDatabase(data.bookId)
      requireVectors(db)
      try {
        return db.transaction(() => {
          const row = readRow(db, data.bookId, data.runId)
          expected(row, data.expectedVersion)
          if (row.state !== 'running') conflict('这个向量请求已结束，请读取原结果。')
          if (data.state !== 'succeeded') return advance(db, row, data.state, null, null, data.error ?? null)
          const run = detail(row)
          this.verifyLive(db, run, false)
          const response = data.response!
          if (response.vectors.length !== run.context.input.length) invalid('向量结果数量与固定预览不符。')
          const vectors = response.vectors.map(normalize)
          const profile = readProfile(db, run.context.profileHash)
          if (profile && (profile.dimensions !== vectors[0].length || profile.response_model !== response.model)) {
            conflict('返回模型或向量维度已变化，请重新配置独立连接后整理，不能混用旧索引。')
          }
          if (!profile) {
            if (run.kind !== 'index') throw storageFailure()
            db.prepare('INSERT INTO memory_vector_profiles (profile_hash, response_model, dimensions, created_at) VALUES (?, ?, ?, ?)')
              .run(run.context.profileHash, response.model, vectors[0].length, new Date().toISOString())
          }
          if (run.kind === 'index') {
            run.context.items.forEach((item, index) => {
              const existing = db.prepare('SELECT text_hash FROM memory_vectors WHERE profile_hash = ? AND chunk_id = ?').get(run.context.profileHash, item.chunkId) as { text_hash: string } | undefined
              const textHash = digest(item.text)
              if (existing) { if (existing.text_hash !== textHash) throw storageFailure(); return }
              db.prepare('INSERT INTO memory_vectors (profile_hash, chunk_id, text_hash, vector_json, run_id) VALUES (?, ?, ?, ?, ?)')
                .run(run.context.profileHash, item.chunkId, textHash, JSON.stringify(vectors[index]), run.id)
            })
            return advance(db, row, 'succeeded', null, response.usage)
          }
          const result = this.hybrid(db, run, vectors[0], readProfile(db, run.context.profileHash)!)
          return advance(db, row, 'succeeded', result, response.usage)
        }).immediate()
      } catch (error) {
        if (data.state !== 'succeeded') throw error
        // 回滚整批向量后单独记录失败，来源失效不能留下半批缓存或永久占用 running。
        return db.transaction(() => {
          const row = readRow(db, data.bookId, data.runId)
          expected(row, data.expectedVersion)
          if (row.state !== 'running') throw error
          const message = error instanceof DomainError ? error.detail.message : '向量结果保存失败，已保留原请求，请核对来源后重新准备。'
          return advance(db, row, 'failed', null, null, message.slice(0, 500))
        }).immediate()
      }
    })
  }

  cancel(input: MemoryVectorVersionInput): MemoryVectorRun { return this.stop(input, 'prepared', 'cancelled') }
  interrupt(input: MemoryVectorVersionInput): MemoryVectorRun { return this.stop(input, 'running', 'interrupted') }

  private stop(input: MemoryVectorVersionInput, from: MemoryVectorRun['state'], to: MemoryVectorRun['state']): MemoryVectorRun {
    return perform(() => {
      const data = parseMemoryVectorVersionInput(input)
      const db = this.getDatabase(data.bookId)
      requireVectors(db)
      return db.transaction(() => {
        readBook(db, data.bookId)
        const row = readRow(db, data.bookId, data.runId)
        expected(row, data.expectedVersion)
        if (row.state !== from) conflict('请求状态已变化，请刷新后处理。')
        return advance(db, row, to)
      }).immediate()
    })
  }

  private verifyLive(db: Database.Database, run: MemoryVectorRun, writable: boolean): void {
    const book = readBook(db, run.bookId, writable)
    if (book.index_publication_version !== run.publicationVersion) conflict('本地索引已重新发布，本次向量请求不再适用于当前批次。')
    currentConnection(db, run.bookId, run.context.connection)
    if (run.kind === 'search') this.verifySearchScope(db, run.context.profileHash, parseMemorySearchInput(run.context.search))
    for (const item of run.context.items) {
      const current = this.memorySearch.evidence({ bookId: run.bookId, chunkId: item.chunkId })
      if (JSON.stringify(current) !== JSON.stringify(item)) conflict('固定片段或来源状态已变化，请重新准备预览。')
    }
  }

  private verifySearchScope(db: Database.Database, hash: string, input: MemoryVectorContext['search']): void {
    const search = parseMemorySearchInput(input)
    if (search.entityId && !db.prepare('SELECT id FROM knowledge_items WHERE book_id = ? AND id = ?').get(search.bookId, search.entityId)) {
      throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个关联实体。' })
    }
    if (!readProfile(db, hash)) invalid('请先为这个连接和向量模型整理至少一批资料。')
    const available = db.prepare(`${current(db)} SELECT c.id FROM current_artifacts a
      JOIN memory_chunks c ON c.artifact_id = a.id JOIN memory_vectors v ON v.chunk_id = c.id AND v.profile_hash = @profileHash
      WHERE ${MEMORY_SEARCH_SOURCE_FILTER_SQL} AND ${VECTOR_TEXT_FILTER} LIMIT 1`)
      .get({ bookId: search.bookId, sourceKind: search.sourceKind ?? null, nature: search.nature ?? null,
        entityId: search.entityId ?? null, includeUnreviewed: search.includeUnreviewed === false ? 0 : 1,
        includeAffected: search.includeAffected === true ? 1 : 0, profileHash: hash })
    if (!available) invalid('当前筛选范围没有可用向量，请先整理或调整范围。')
  }

  private hybrid(db: Database.Database, run: MemoryVectorRun, vector: number[], profile: ProfileRow): MemorySearchPage {
    const search = parseMemorySearchInput(run.context.search)
    const params = { bookId: run.bookId, sourceKind: search.sourceKind ?? null, nature: search.nature ?? null,
      entityId: search.entityId ?? null, includeUnreviewed: search.includeUnreviewed === false ? 0 : 1,
      includeAffected: search.includeAffected === true ? 1 : 0, profileHash: run.context.profileHash }
    const { profileHash: selectedProfile, ...filters } = params
    const eligible = count(db, `${current(db)} SELECT count(*) AS total FROM current_artifacts a
      JOIN memory_chunks c ON c.artifact_id = a.id WHERE ${MEMORY_SEARCH_SOURCE_FILTER_SQL} AND ${VECTOR_TEXT_FILTER}`, filters)
    const indexed = count(db, `${current(db)} SELECT count(*) AS total FROM current_artifacts a
      JOIN memory_chunks c ON c.artifact_id = a.id JOIN memory_vectors v ON v.chunk_id = c.id AND v.profile_hash = @profileHash
      WHERE ${MEMORY_SEARCH_SOURCE_FILTER_SQL} AND ${VECTOR_TEXT_FILTER}`, { ...filters, profileHash: selectedProfile })
    if (!indexed) invalid('当前筛选范围没有可用向量，请先整理或调整范围。')
    const rows = db.prepare(`${current(db)} SELECT c.id, c.text, v.text_hash, v.vector_json FROM current_artifacts a
      JOIN memory_chunks c ON c.artifact_id = a.id JOIN memory_vectors v ON v.chunk_id = c.id AND v.profile_hash = @profileHash
      WHERE ${MEMORY_SEARCH_SOURCE_FILTER_SQL} AND ${VECTOR_TEXT_FILTER} ORDER BY c.id`)
      .iterate(params) as Iterable<{ id: number; text: string; text_hash: string; vector_json: string }>
    const ranked: { id: number; score: number }[] = []
    let scanned = 0
    for (const row of rows) {
      if (!integer(row.id, 1) || typeof row.text !== 'string' || digest(row.text) !== row.text_hash ||
        typeof row.vector_json !== 'string' || row.vector_json.length > 160_000) throw storageFailure()
      const stored = parseMemoryVectorValues(JSON.parse(row.vector_json))
      if (stored.length !== profile.dimensions) throw storageFailure()
      const norm = stored.reduce((sum, entry) => sum + entry * entry, 0)
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.000001) throw storageFailure()
      const score = stored.reduce((sum, entry, index) => sum + entry * vector[index], 0)
      if (!Number.isFinite(score)) throw storageFailure()
      let low = 0, high = ranked.length
      while (low < high) {
        const middle = (low + high) >>> 1, entry = ranked[middle]!
        if (entry.score > score || entry.score === score && entry.id < row.id) low = middle + 1
        else high = middle
      }
      if (low < MEMORY_VECTOR_CANDIDATES) ranked.splice(low, 0, { id: row.id, score })
      if (ranked.length > MEMORY_VECTOR_CANDIDATES) ranked.pop()
      scanned += 1
    }
    // 流式比较筛选范围内全部有效向量，只保留全局候选，片段编号不决定召回资格。
    return this.memorySearch.search(search, { chunkIds: ranked.map((entry) => entry.id),
      truncated: indexed < eligible || scanned < indexed || scanned > MEMORY_VECTOR_CANDIDATES,
      scope: { profileHash: run.context.profileHash, responseModel: profile.response_model, dimensions: profile.dimensions,
        eligibleChunks: eligible, indexedChunks: indexed, scannedChunks: scanned, scanLimit: indexed } })
  }
}
