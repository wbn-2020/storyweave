import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredText } from '../../contracts/api'
import { AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_NATURES } from '../../contracts/knowledge'
import {
  MEMORY_CHUNK_SIZE, MEMORY_SOURCE_KINDS, parseMemoryEvidenceInput, parseMemorySearchInput,
  type MemoryBookInput, type MemoryEvidence, type MemoryEvidenceInput, type MemorySearchHit,
  type MemorySearchInput, type MemorySearchPage, type MemorySemanticScope, type MemorySourceReference, type MemoryStatus,
} from '../../contracts/memory'
import { readMemoryProjection } from './source-projection'
import { toSearchQuery } from './search-text'
import { currentMemoryArtifactsSql } from './task-repository'

interface BookState { id: string; revision: number; knowledge_revision: number; index_publication_version: number }
interface ChunkRow {
  chunk_id: number; artifact_id: string; source_kind: MemorySourceReference['sourceKind']; source_id: string
  revision_id: string; title: string; nature: MemorySourceReference['nature']
  author_decision: MemorySourceReference['authorDecision']; freshness: MemorySourceReference['freshness']
  conflict_state: MemorySourceReference['conflictState']; content_hash: string; publication_version: number
  block_id: string | null; start_offset: number; end_offset: number; text: string
  dependency_state: MemorySearchHit['dependencyState']
}
interface Candidate { row: ChunkRow; score: number; reasons: Set<MemorySearchHit['reasons'][number]> }

const CANDIDATE_LIMIT = 100
const ENTITY_LIMIT = 20
const CHUNKS_PER_SOURCE = 3
const CHUNK_COLUMNS = `c.id AS chunk_id, c.artifact_id, c.block_id, c.start_offset, c.end_offset, c.text,
  a.source_kind, a.source_id, a.revision_id, a.title, a.nature, a.author_decision,
  a.freshness, a.conflict_state, a.content_hash, a.publication_version, a.dependency_state`
export const MEMORY_SEARCH_SOURCE_FILTER_SQL = `(SELECT id FROM book_meta WHERE singleton = 1) = @bookId
  AND (@sourceKind IS NULL OR a.source_kind = @sourceKind)
  AND (@nature IS NULL OR a.nature = @nature)
  AND (a.author_decision IS NULL OR a.author_decision != 'rejected')
  AND (@includeUnreviewed = 1 OR a.author_decision IS NULL OR a.author_decision = 'adopted')
  AND (@includeAffected = 1 OR (a.freshness = 'current' AND a.dependency_state = 'current'))
  AND (@entityId IS NULL OR EXISTS (SELECT 1 FROM memory_artifact_entities selected_entity
    WHERE selected_entity.artifact_id = a.id AND selected_entity.entity_id = @entityId))`
const current = (db: Database.Database) => `WITH current_artifacts AS (${currentMemoryArtifactsSql(db)})`
const SOURCE_FILTER = MEMORY_SEARCH_SOURCE_FILTER_SQL

export interface MemorySemanticCandidates { chunkIds: number[]; truncated: boolean; scope: MemorySemanticScope }

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '本地记忆检索资料无法核对，请保留作品文件并重新整理。' })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}
function requireMemory(db: Database.Database): void {
  if ((db.pragma('user_version', { simple: true }) as number) < 5) {
    throw new DomainError({ code: 'FORBIDDEN', message: '请先在记忆面板备份并升级这部作品，再使用本地检索。' })
  }
}
function readBook(db: Database.Database, bookId: string): BookState {
  const row = db.prepare(`SELECT id, revision, knowledge_revision, index_publication_version
    FROM book_meta WHERE singleton = 1`).get() as BookState | undefined
  if (!row || row.id !== bookId || [row.revision, row.knowledge_revision, row.index_publication_version]
    .some((value) => !Number.isSafeInteger(value) || value < 0)) throw storageFailure()
  return row
}
function reference(row: ChunkRow): MemorySourceReference {
  try {
    if (!MEMORY_SOURCE_KINDS.includes(row.source_kind) || !KNOWLEDGE_NATURES.includes(row.nature) ||
      !KNOWLEDGE_FRESHNESS.includes(row.freshness) || !CONFLICT_STATES.includes(row.conflict_state) ||
      (row.author_decision !== null && !AUTHOR_DECISIONS.includes(row.author_decision)) ||
      (row.source_kind === 'chapter') !== (row.author_decision === null) ||
      (row.dependency_state !== 'current' && row.dependency_state !== 'source_changed') ||
      (row.source_kind === 'chapter') !== (row.block_id !== null) ||
      !/^[0-9a-f]{64}$/.test(row.content_hash) || typeof row.text !== 'string' ||
      row.text.length === 0 || row.text.length > MEMORY_CHUNK_SIZE ||
      [row.chunk_id, row.publication_version].some((value) => !Number.isSafeInteger(value) || value < 1) ||
      [row.start_offset, row.end_offset].some((value) => !Number.isSafeInteger(value) || value < 0) ||
      row.end_offset - row.start_offset !== row.text.length) throw storageFailure()
    requiredId(row.artifact_id)
    if (row.block_id !== null) requiredId(row.block_id)
    const title = requiredText(row.title, '检索来源标题', 120)
    if (title !== row.title) throw storageFailure()
    return { sourceKind: row.source_kind, sourceId: requiredId(row.source_id), revisionId: requiredId(row.revision_id),
      title, nature: row.nature, authorDecision: row.author_decision, freshness: row.freshness, conflictState: row.conflict_state }
  } catch { throw storageFailure() }
}
function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}
function excerpt(text: string, query: string): string {
  const match = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  let start = Math.max(0, match < 0 ? 0 : match - 80)
  if (splitsSurrogate(text, start)) start -= 1
  let end = Math.min(text.length, start + 360)
  if (splitsSurrogate(text, end)) end -= 1
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export class MemorySearchRepository {
  constructor(
    private readonly getDatabase: (bookId: string) => Database.Database,
    private readonly getStatus: (input: MemoryBookInput) => MemoryStatus,
  ) {}

  search(input: MemorySearchInput, semantic?: MemorySemanticCandidates): MemorySearchPage {
    return perform(() => {
      const data = parseMemorySearchInput(input)
      const db = this.getDatabase(data.bookId)
      requireMemory(db)
      return db.transaction((): MemorySearchPage => {
        const book = readBook(db, data.bookId)
        const compiled = toSearchQuery(data.query)
        if (!compiled && !data.entityId && !semantic) {
          throw new DomainError({ code: 'INVALID_INPUT', message: '请填写可检索的文字，或选择一个关联实体。' })
        }
        if (data.entityId && !db.prepare('SELECT id FROM knowledge_items WHERE book_id = ? AND id = ?').get(data.bookId, data.entityId)) {
          throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个关联实体。' })
        }
        const params = { bookId: data.bookId, sourceKind: data.sourceKind ?? null, nature: data.nature ?? null,
          includeUnreviewed: data.includeUnreviewed === false ? 0 : 1,
          includeAffected: data.includeAffected === true ? 1 : 0, entityId: data.entityId ?? null }
        const candidates = new Map<number, Candidate>()
        let truncated = semantic?.truncated ?? false
        const merge = (rows: ChunkRow[], reason: MemorySearchHit['reasons'][number]) => {
          if (rows.length > CANDIDATE_LIMIT) truncated = true
          rows.slice(0, CANDIDATE_LIMIT).forEach((row, index) => {
            reference(row)
            if (row.publication_version !== book.index_publication_version) throw storageFailure()
            const candidate = candidates.get(row.chunk_id)
            const score = 1 / (60 + index + 1)
            if (candidate) { candidate.score += score; candidate.reasons.add(reason) }
            else candidates.set(row.chunk_id, { row, score, reasons: new Set([reason]) })
          })
        }
        // 每一路只领取有限候选；正文不因整书整理完成就一次全部载入检索内存。
        if (compiled) {
          const rows = db.prepare(`${current(db)}
            SELECT ${CHUNK_COLUMNS} FROM memory_chunks_fts
            JOIN memory_chunks c ON c.id = memory_chunks_fts.rowid
            JOIN current_artifacts a ON a.id = c.artifact_id
            WHERE memory_chunks_fts MATCH @query AND ${SOURCE_FILTER}
            ORDER BY bm25(memory_chunks_fts), c.id LIMIT @candidateLimit`)
            .all({ ...params, query: compiled, candidateLimit: CANDIDATE_LIMIT + 1 }) as ChunkRow[]
          merge(rows, 'keyword')
          const titleRows = db.prepare(`${current(db)}
            SELECT ${CHUNK_COLUMNS} FROM current_artifacts a JOIN memory_chunks c ON c.artifact_id = a.id AND c.ordinal = 0
            WHERE ${SOURCE_FILTER} AND (instr(lower(a.title), lower(@literal)) > 0 OR
              (a.source_kind = 'knowledge' AND EXISTS (SELECT 1 FROM knowledge_items k, json_each(k.aliases_json) alias
                WHERE k.id = a.source_id AND k.book_id = @bookId AND instr(lower(alias.value), lower(@literal)) > 0)))
            ORDER BY CASE WHEN lower(a.title) = lower(@literal) THEN 0 ELSE 1 END,
              a.title COLLATE NOCASE, a.source_kind, a.source_id, c.id LIMIT @candidateLimit`)
            .all({ ...params, literal: data.query, candidateLimit: CANDIDATE_LIMIT + 1 }) as ChunkRow[]
          merge(titleRows, 'title')
        }

        let entityIds: string[] = []
        if (data.entityId && !compiled) entityIds = [data.entityId]
        else if (!data.entityId && compiled) {
          // 名称／别名只用于扩展已经显式登记的关联，不能推导正文人物在场或知情。
          const rows = db.prepare(`SELECT k.id FROM knowledge_items k WHERE k.book_id = @bookId
            AND k.author_decision != 'rejected' AND (@includeUnreviewed = 1 OR k.author_decision = 'adopted')
            AND (@includeAffected = 1 OR k.freshness = 'current') AND
              (instr(lower(k.name), lower(@literal)) > 0 OR EXISTS (SELECT 1 FROM json_each(k.aliases_json) alias
                WHERE instr(lower(alias.value), lower(@literal)) > 0))
            ORDER BY CASE WHEN lower(k.name) = lower(@literal) THEN 0 ELSE 1 END, k.name COLLATE NOCASE, k.id LIMIT @entityLimit`)
            .all({ bookId: data.bookId, literal: data.query, includeUnreviewed: params.includeUnreviewed,
              includeAffected: params.includeAffected, entityLimit: ENTITY_LIMIT + 1 }) as { id: string }[]
          if (rows.length > ENTITY_LIMIT) truncated = true
          entityIds = rows.slice(0, ENTITY_LIMIT).map((row) => requiredId(row.id))
        }
        if (entityIds.length) {
          const rows = db.prepare(`${current(db)}
            SELECT ${CHUNK_COLUMNS} FROM current_artifacts a JOIN memory_chunks c ON c.artifact_id = a.id AND c.ordinal = 0
            WHERE ${SOURCE_FILTER} AND EXISTS (SELECT 1 FROM memory_artifact_entities e
              WHERE e.artifact_id = a.id AND e.entity_id IN (SELECT value FROM json_each(@entityIds)))
            ORDER BY a.source_kind, a.title COLLATE NOCASE, a.source_id, c.id LIMIT @candidateLimit`)
            .all({ ...params, entityIds: JSON.stringify(entityIds), candidateLimit: CANDIDATE_LIMIT + 1 }) as ChunkRow[]
          merge(rows, 'entity')
        }

        if (semantic) {
          if (semantic.chunkIds.length > CANDIDATE_LIMIT || new Set(semantic.chunkIds).size !== semantic.chunkIds.length ||
            semantic.chunkIds.some((value) => !Number.isSafeInteger(value) || value < 1)) throw storageFailure()
          const rows = db.prepare(`${current(db)}
            SELECT ${CHUNK_COLUMNS} FROM json_each(@chunkIds) ranked
            JOIN memory_chunks c ON c.id = ranked.value JOIN current_artifacts a ON a.id = c.artifact_id
            WHERE ${SOURCE_FILTER} ORDER BY CAST(ranked.key AS INTEGER)`)
            .all({ ...params, chunkIds: JSON.stringify(semantic.chunkIds) }) as ChunkRow[]
          // 向量排名仍走相同来源门禁，不能借语义召回放行失效或被拒绝的资料。
          if (rows.length !== semantic.chunkIds.length) throw storageFailure()
          merge(rows, 'semantic')
        }

        const sourceCounts = new Map<string, number>()
        const hits: MemorySearchHit[] = []
        const limit = data.limit ?? 30
        for (const candidate of Array.from(candidates.values()).sort((a, b) => b.score - a.score || a.row.chunk_id - b.row.chunk_id)) {
          const row = candidate.row
          const sourceKey = `${row.source_kind}:${row.source_id}`
          const count = sourceCounts.get(sourceKey) ?? 0
          if (hits.length === limit || count === CHUNKS_PER_SOURCE) { truncated = true; continue }
          sourceCounts.set(sourceKey, count + 1)
          hits.push({ ...reference(row), chunkId: row.chunk_id, blockId: row.block_id,
            excerpt: excerpt(row.text, data.query), dependencyState: row.dependency_state, reasons: Array.from(candidate.reasons) })
        }
        const status = this.getStatus({ bookId: data.bookId })
        if (status.bookId !== data.bookId || status.schemaVersion < 5 || status.publicationVersion !== book.index_publication_version ||
          status.bookRevision !== book.revision || status.knowledgeRevision !== book.knowledge_revision) throw storageFailure()
        return { bookId: data.bookId, publicationVersion: book.index_publication_version, status, hits, truncated,
          mode: semantic ? 'hybrid_keyword_entity_vector' : 'local_keyword_entity', ...(semantic ? { semantic: semantic.scope } : {}) }
      })()
    })
  }

  evidence(input: MemoryEvidenceInput): MemoryEvidence {
    return perform(() => {
      const data = parseMemoryEvidenceInput(input)
      const db = this.getDatabase(data.bookId)
      requireMemory(db)
      return db.transaction((): MemoryEvidence => {
        const book = readBook(db, data.bookId)
        const row = db.prepare(`${current(db)} SELECT ${CHUNK_COLUMNS} FROM current_artifacts a
          JOIN memory_chunks c ON c.artifact_id = a.id WHERE c.id = ?`).get(data.chunkId) as ChunkRow | undefined
        if (!row) {
          throw new DomainError({ code: 'REVISION_CONFLICT', message: '这个片段已不属于当前可用索引。请重新检索；不会改为显示其他版本的原稿。' })
        }
        const source = reference(row)
        if (row.publication_version !== book.index_publication_version) throw storageFailure()
        const projection = readMemoryProjection(db, data.bookId, source)
        const block = projection.blocks.find((item) => item.blockId === row.block_id)
        // 出处重新读取同一不可变修订并核对片段边界，派生索引不能替代原稿证据。
        if (projection.contentHash !== row.content_hash || projection.nature !== row.nature ||
          projection.authorDecision !== row.author_decision || projection.freshness !== row.freshness ||
          projection.conflictState !== row.conflict_state || !block || row.end_offset > block.text.length ||
          splitsSurrogate(block.text, row.start_offset) || splitsSurrogate(block.text, row.end_offset) ||
          block.text.slice(row.start_offset, row.end_offset) !== row.text) throw storageFailure()
        return { ...source, bookId: data.bookId, chunkId: row.chunk_id, blockId: row.block_id,
          startOffset: row.start_offset, endOffset: row.end_offset, text: row.text,
          publicationVersion: row.publication_version, referenceState: 'current', dependencyState: row.dependency_state,
          readerDisclosure: projection.readerDisclosure }
      })()
    })
  }
}
