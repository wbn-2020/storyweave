import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredText } from '../../contracts/api'
import {
  MEMORY_PLAN_PAGE, MEMORY_PROJECTION_VERSION, MEMORY_SOURCE_KINDS, MEMORY_STEP_CHUNKS,
  parseMemoryBookInput, parseMemoryControlInput, parseMemoryStartInput, parseMemoryTaskInput,
  type MemoryBookInput, type MemoryControlInput, type MemorySourceKind, type MemoryStartInput,
  type MemoryStatus, type MemoryTaskInput, type MemoryTaskPhase, type MemoryTaskReceipt,
  type MemoryTaskState, type MemoryTaskSummary,
} from '../../contracts/memory'
import { projectMemoryChunks, readMemoryProjection, type MemoryProjection } from './source-projection'
import { toSearchText } from './search-text'
import { BOOK_SCHEMA_VERSION } from '../storage/schema'
import { activeChapterSql } from '../storage/chapter-lifecycle'
import { currentLivingProjectionSql } from '../workbench/living-projection'

interface BookState {
  id: string; revision: number; knowledge_revision: number; index_publication_version: number; archived_at: string | null
}
interface TaskRow {
  id: string; book_id: string; version: number; state: MemoryTaskState; phase: MemoryTaskPhase
  target_book_revision: number; target_knowledge_revision: number; expected_publication_version: number
  planning_kind: number; planning_after_id: string; planned_sources: number; completed_sources: number
  processed_chunks: number; error: string | null; created_at: string; updated_at: string
}
interface SourceRow { source_kind: MemorySourceKind; source_id: string; revision_id: string; title: string }
interface UnitRow extends SourceRow {
  id: number; task_id: string; artifact_id: string | null; state: 'pending' | 'processing' | 'completed'
  block_index: number; block_offset: number; next_ordinal: number
}
interface ArtifactRow extends SourceRow {
  id: string; projection_version: number; content_hash: string; complete: number; chunk_count: number
}
interface PublicationRow { version: number; book_revision: number; knowledge_revision: number; source_count: number }

const ACTIVE_STATES = ['planning', 'running', 'paused', 'failed'] as const
const TASK_STATES = [...ACTIVE_STATES, 'completed', 'superseded', 'cancelled'] as const
const TASK_PHASES = ['planning', 'indexing', 'publishing'] as const
const ACTIVE_SQL = "state IN ('planning', 'running', 'paused', 'failed')"
const TASK_COLUMNS = `id, book_id, version, state, phase, target_book_revision, target_knowledge_revision,
  expected_publication_version, planning_kind, planning_after_id, planned_sources, completed_sources,
  processed_chunks, error, created_at, updated_at`

/** 只读当前身份和修订；检索与覆盖统计共用，失效不会改写作者的 freshness。 */
export const MEMORY_CURRENT_SOURCES_SQL = `
  SELECT 'chapter' AS source_kind, c.id AS source_id, c.current_revision_id AS revision_id, c.title
    FROM chapters c
  UNION ALL
  SELECT 'knowledge' AS source_kind, k.id AS source_id,
    (SELECT r.id FROM knowledge_item_revisions r WHERE r.item_id = k.id ORDER BY r.knowledge_revision DESC LIMIT 1) AS revision_id,
    k.name AS title FROM knowledge_items k WHERE k.book_id = (SELECT id FROM book_meta WHERE singleton = 1)
  UNION ALL
  SELECT 'story' AS source_kind, s.id AS source_id,
    (SELECT r.id FROM story_record_revisions r WHERE r.record_id = s.id ORDER BY r.knowledge_revision DESC LIMIT 1) AS revision_id,
    s.title FROM story_records s WHERE s.book_id = (SELECT id FROM book_meta WHERE singleton = 1)
`
export function currentMemorySourcesSql(db: Database.Database): string {
  return MEMORY_CURRENT_SOURCES_SQL.replace('FROM chapters c', `FROM chapters c WHERE ${activeChapterSql(db)}`)
    .replace('WHERE k.book_id =', `WHERE ${currentLivingProjectionSql(db, 'k')} AND k.book_id =`)
}

/** 半批产物和历史批次均不可见；已发布来源也必须仍匹配当前原对象。 */
export const MEMORY_CURRENT_ARTIFACTS_SQL = `
  SELECT a.*, h.publication_version, CASE WHEN EXISTS (
    SELECT 1 FROM memory_artifact_dependencies d LEFT JOIN chapters dependency ON dependency.id = d.chapter_id
    WHERE d.artifact_id = a.id AND (dependency.id IS NULL OR dependency.current_revision_id != d.revision_id)
  ) THEN 'source_changed' ELSE 'current' END AS dependency_state FROM memory_heads h
  JOIN memory_artifacts a ON a.id = h.artifact_id AND a.source_kind = h.source_kind AND a.source_id = h.source_id
  JOIN (${MEMORY_CURRENT_SOURCES_SQL}) current ON current.source_kind = a.source_kind
    AND current.source_id = a.source_id AND current.revision_id = a.revision_id AND current.title = a.title
  WHERE h.publication_version = (SELECT index_publication_version FROM book_meta WHERE singleton = 1)
    AND a.complete = 1 AND a.projection_version = ${MEMORY_PROJECTION_VERSION}
`
export function currentMemoryArtifactsSql(db: Database.Database): string {
  return MEMORY_CURRENT_ARTIFACTS_SQL.replace(MEMORY_CURRENT_SOURCES_SQL, currentMemorySourcesSql(db))
    .replace('dependency.current_revision_id != d.revision_id', `dependency.current_revision_id != d.revision_id OR NOT (${activeChapterSql(db, 'dependency')})`)
}

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '记忆整理资料读写失败，请保留作品文件并检查磁盘与资料完整性。' })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}
function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function conflict(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
function count(db: Database.Database, sql: string, ...bindings: (string | number)[]): number {
  const row = db.prepare(sql).get(...bindings) as { total: number } | undefined
  if (!row || !Number.isSafeInteger(row.total) || row.total < 0) throw storageFailure()
  return row.total
}
function readBook(db: Database.Database, bookId: string): BookState {
  const row = db.prepare(`SELECT id, revision, knowledge_revision, index_publication_version, archived_at
    FROM book_meta WHERE singleton = 1`).get() as BookState | undefined
  if (!row || row.id !== bookId || [row.revision, row.knowledge_revision, row.index_publication_version]
    .some((value) => !Number.isSafeInteger(value) || value < 0)) throw storageFailure()
  return row
}
function versionOf(db: Database.Database): number {
  const value = db.pragma('user_version', { simple: true })
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 2 || value > BOOK_SCHEMA_VERSION) throw storageFailure()
  return value
}
function requireMemory(db: Database.Database): void {
  if (versionOf(db) < 5) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级这部作品，再使用记忆整理与检索。' })
}
function requireWritable(book: BookState): void {
  if (book.archived_at) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请先取消归档再继续整理。' })
}
function summary(row: TaskRow, bookId: string): MemoryTaskSummary {
  try {
    if (row.book_id !== bookId || !TASK_STATES.includes(row.state) || !TASK_PHASES.includes(row.phase) ||
      row.completed_sources > row.planned_sources || (row.error !== null && typeof row.error !== 'string') ||
      !Number.isInteger(row.planning_kind) || row.planning_kind < 0 || row.planning_kind > 3) throw storageFailure()
    const numbers = [row.version, row.target_book_revision, row.target_knowledge_revision, row.expected_publication_version,
      row.planned_sources, row.completed_sources, row.processed_chunks]
    if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0)) throw storageFailure()
    return { id: requiredId(row.id), bookId, version: row.version, state: row.state, phase: row.phase,
      targetBookRevision: row.target_book_revision, targetKnowledgeRevision: row.target_knowledge_revision,
      plannedSources: row.planned_sources, completedSources: row.completed_sources, processedChunks: row.processed_chunks,
      error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }
  } catch { throw storageFailure() }
}
function readTask(db: Database.Database, bookId: string, taskId: string): TaskRow {
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM memory_tasks WHERE id = ? AND book_id = ?`).get(taskId, bookId) as TaskRow | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个整理任务。' })
  summary(row, bookId)
  return row
}
function matches(task: TaskRow, book: BookState, db?: Database.Database): boolean {
  if (task.target_knowledge_revision !== book.knowledge_revision || task.expected_publication_version !== book.index_publication_version) return false
  if (task.target_book_revision === book.revision) return true
  if (!db || task.phase === 'planning') return false
  const current = count(db, `SELECT count(*) AS total FROM (${currentMemorySourcesSql(db)})`)
  if (current !== task.planned_sources) return false
  const matching = count(db, `SELECT count(*) AS total FROM memory_task_units u JOIN (${currentMemorySourcesSql(db)}) c
    ON c.source_kind = u.source_kind AND c.source_id = u.source_id AND c.revision_id = u.revision_id AND c.title = u.title WHERE u.task_id = ?`, task.id)
  return matching === current
}
function active(task: TaskRow): boolean { return (ACTIVE_STATES as readonly string[]).includes(task.state) }
function checkTaskVersion(task: TaskRow, expected: number): void {
  if (task.version !== expected) conflict('整理任务已有新进度，请刷新后继续；本次操作没有覆盖检查点。')
}
function advanceTask(db: Database.Database, task: TaskRow): void {
  if (task.version >= Number.MAX_SAFE_INTEGER) throw storageFailure()
  const changed = db.prepare(`UPDATE memory_tasks SET version = version + 1, state = @state, phase = @phase,
    planning_kind = @planningKind, planning_after_id = @afterId, planned_sources = @planned,
    completed_sources = @completed, processed_chunks = @chunks, error = @error, updated_at = @now
    WHERE id = @id AND book_id = @bookId AND version = @expected`).run({ id: task.id, bookId: task.book_id,
    expected: task.version, state: task.state, phase: task.phase, planningKind: task.planning_kind,
    afterId: task.planning_after_id, planned: task.planned_sources, completed: task.completed_sources,
    chunks: task.processed_chunks, error: task.error, now: new Date().toISOString() })
  if (changed.changes !== 1) conflict('整理任务检查点已变化，请刷新后继续。')
}
function sourceIdentity(row: SourceRow): SourceRow {
  try {
    if (!MEMORY_SOURCE_KINDS.includes(row.source_kind)) throw storageFailure()
    return { source_kind: row.source_kind, source_id: requiredId(row.source_id), revision_id: requiredId(row.revision_id),
      title: requiredText(row.title, '来源标题', 200) }
  } catch { throw storageFailure() }
}

export class MemoryRepository {
  constructor(private readonly getDatabase: (bookId: string) => Database.Database) {}

  status(input: MemoryBookInput): MemoryStatus {
    const data = parseMemoryBookInput(input)
    return perform(() => {
      const db = this.getDatabase(data.bookId)
      return db.transaction(() => this.readStatus(db, data.bookId))()
    })
  }

  start(input: MemoryStartInput): MemoryTaskReceipt {
    const data = parseMemoryStartInput(input)
    return perform(() => {
      const db = this.getDatabase(data.bookId)
      requireMemory(db)
      return db.transaction(() => {
        const book = readBook(db, data.bookId)
        requireWritable(book)
        if (book.revision !== data.expectedBookRevision || book.knowledge_revision !== data.expectedKnowledgeRevision) {
          conflict('作品已有新修订，请刷新资料状态后开始整理。')
        }
        const existing = db.prepare(`SELECT ${TASK_COLUMNS} FROM memory_tasks WHERE book_id = ? AND ${ACTIVE_SQL}`)
          .get(data.bookId) as TaskRow | undefined
        if (existing) {
          summary(existing, data.bookId)
          if (matches(existing, book, db)) conflict('已有可继续的整理任务，请继续、重试或取消该任务。')
          existing.state = 'superseded'
          existing.error = '作品输入或发布批次已变化，旧任务已停止。'
          advanceTask(db, existing)
        }
        const id = randomUUID()
        const now = new Date().toISOString()
        db.prepare(`INSERT INTO memory_tasks (id, book_id, state, phase, target_book_revision, target_knowledge_revision,
          expected_publication_version, created_at, updated_at) VALUES (?, ?, 'planning', 'planning', ?, ?, ?, ?, ?)`)
          .run(id, data.bookId, book.revision, book.knowledge_revision, book.index_publication_version, now, now)
        return this.receipt(db, data.bookId, id)
      }).immediate()
    })
  }

  step(input: MemoryTaskInput): MemoryTaskReceipt {
    const data = parseMemoryTaskInput(input)
    return perform(() => {
      const db = this.getDatabase(data.bookId)
      requireMemory(db)
      try {
        return db.transaction(() => {
          const book = readBook(db, data.bookId)
          const task = readTask(db, data.bookId, data.taskId)
          checkTaskVersion(task, data.expectedTaskVersion)
          if (task.state !== 'planning' && task.state !== 'running') invalid('这个任务当前不能处理下一批，请先继续或重试。')
          if (!matches(task, book, db)) {
            task.state = 'superseded'
            task.error = '原稿、资料或发布批次已变化，请按当前版本创建新任务。'
          } else {
            requireWritable(book)
            if (task.phase === 'planning') this.plan(db, data.bookId, task)
            else if (task.phase === 'indexing') this.index(db, data.bookId, task)
            else this.publish(db, data.bookId, task)
          }
          advanceTask(db, task)
          return this.receipt(db, data.bookId, task.id)
        }).immediate()
      } catch (error) {
        // 一批失败先回滚片段与游标，再单独登记失败状态；重试仍从最后一次已提交检查点继续。
        if (error instanceof DomainError && error.detail.code !== 'STORAGE_ERROR') throw error
        return db.transaction(() => {
          const task = readTask(db, data.bookId, data.taskId)
          checkTaskVersion(task, data.expectedTaskVersion)
          if (task.state !== 'planning' && task.state !== 'running') throw storageFailure()
          const book = readBook(db, data.bookId)
          task.state = matches(task, book, db) ? 'failed' : 'superseded'
          task.error = task.state === 'failed' ? '本批整理未完成，检查点已保留。请检查来源和磁盘后重试。' : '作品输入已变化，请按当前版本创建新任务。'
          advanceTask(db, task)
          return this.receipt(db, data.bookId, task.id)
        }).immediate()
      }
    })
  }

  control(input: MemoryControlInput): MemoryTaskReceipt {
    const data = parseMemoryControlInput(input)
    return perform(() => {
      const db = this.getDatabase(data.bookId)
      requireMemory(db)
      return db.transaction(() => {
        const task = readTask(db, data.bookId, data.taskId)
        const book = readBook(db, data.bookId)
        checkTaskVersion(task, data.expectedTaskVersion)
        if (!active(task)) invalid('任务已结束，不能再修改它的运行状态。')
        if (!matches(task, book, db)) {
          task.state = 'superseded'
          task.error = '作品输入或发布批次已变化，旧任务不能继续。'
        } else if (data.action === 'cancel') {
          task.state = 'cancelled'
          task.error = null
        } else if (data.action === 'pause') {
          if (task.state !== 'planning' && task.state !== 'running') invalid('只有正在整理的任务可以暂停。')
          task.state = 'paused'
        } else {
          requireWritable(book)
          if (data.action === 'resume' && task.state !== 'paused') invalid('只有暂停的任务可以继续。')
          if (data.action === 'retry' && task.state !== 'failed') invalid('只有失败的任务可以重试。')
          task.state = task.phase === 'planning' ? 'planning' : 'running'
          task.error = null
        }
        advanceTask(db, task)
        return this.receipt(db, data.bookId, task.id)
      }).immediate()
    })
  }

  private readStatus(db: Database.Database, bookId: string): MemoryStatus {
    const version = versionOf(db)
    const book = readBook(db, bookId)
    let sourceCount = count(db, `SELECT count(*) AS total FROM chapters c WHERE ${activeChapterSql(db)}`)
    let pendingEventCount = count(db, "SELECT count(*) AS total FROM outbox WHERE state = 'pending'")
    if (version >= 3) {
      sourceCount += count(db, 'SELECT count(*) AS total FROM knowledge_items WHERE book_id = ?', bookId)
      pendingEventCount += count(db, "SELECT count(*) AS total FROM knowledge_outbox WHERE state = 'pending'")
    }
    if (version >= 4) {
      sourceCount += count(db, 'SELECT count(*) AS total FROM story_records WHERE book_id = ?', bookId)
      pendingEventCount += count(db, "SELECT count(*) AS total FROM story_outbox WHERE state = 'pending'")
    }
    if (version >= 5) {
      // 覆盖进度属于本地索引消费者；不借用 outbox 的全局标记阻断后续模型、摘要等消费者。
      pendingEventCount = count(db, `SELECT count(*) AS total FROM (
        SELECT 'outbox' AS queue, id AS event_id FROM outbox
        UNION ALL SELECT 'knowledge_outbox' AS queue, id AS event_id FROM knowledge_outbox
        UNION ALL SELECT 'story_outbox' AS queue, id AS event_id FROM story_outbox
      ) event WHERE NOT EXISTS (SELECT 1 FROM memory_event_receipts receipt
        WHERE receipt.consumer = 'local_keyword_entity_v1' AND receipt.queue = event.queue AND receipt.event_id = event.event_id)`)
    }
    const base = { bookId, bookRevision: book.revision, knowledgeRevision: book.knowledge_revision, schemaVersion: version,
      requiresUpgrade: version < 5, publicationVersion: book.index_publication_version, sourceCount, pendingEventCount }
    if (version < 5) return { ...base, publishedBookRevision: null, publishedKnowledgeRevision: null,
      indexedSourceCount: 0, changedDependencyCount: 0, current: false, activeTask: null, recentTasks: [] }
    const publication = db.prepare('SELECT version, book_revision, knowledge_revision, source_count FROM memory_publications WHERE version = ?')
      .get(book.index_publication_version) as PublicationRow | undefined
    if (book.index_publication_version !== 0 && !publication) throw storageFailure()
    const indexedSourceCount = count(db, `SELECT count(*) AS total FROM (${currentMemoryArtifactsSql(db)})`)
    const changedDependencyCount = count(db, `SELECT count(*) AS total FROM (${currentMemoryArtifactsSql(db)}) WHERE dependency_state = 'source_changed'`)
    const rows = db.prepare(`SELECT ${TASK_COLUMNS} FROM memory_tasks WHERE book_id = ? ORDER BY updated_at DESC, id DESC LIMIT 10`)
      .all(bookId) as TaskRow[]
    const activeRow = db.prepare(`SELECT ${TASK_COLUMNS} FROM memory_tasks WHERE book_id = ? AND ${ACTIVE_SQL}`)
      .get(bookId) as TaskRow | undefined
    return { ...base, publishedBookRevision: publication?.book_revision ?? null,
      publishedKnowledgeRevision: publication?.knowledge_revision ?? null, indexedSourceCount, changedDependencyCount,
      current: !!publication && publication.book_revision === book.revision && publication.knowledge_revision === book.knowledge_revision &&
        publication.source_count === sourceCount && indexedSourceCount === sourceCount,
      activeTask: activeRow ? summary(activeRow, bookId) : null, recentTasks: rows.map((row) => summary(row, bookId)) }
  }

  private receipt(db: Database.Database, bookId: string, taskId: string): MemoryTaskReceipt {
    return { bookId, task: summary(readTask(db, bookId, taskId), bookId), status: this.readStatus(db, bookId) }
  }

  private plan(db: Database.Database, bookId: string, task: TaskRow): void {
    if (task.planning_kind >= MEMORY_SOURCE_KINDS.length) {
      task.phase = task.planned_sources === 0 ? 'publishing' : 'indexing'
      task.state = 'running'
      return
    }
    const kind = MEMORY_SOURCE_KINDS[task.planning_kind]
    const sql = kind === 'chapter'
      ? `SELECT 'chapter' AS source_kind, c.id AS source_id, c.current_revision_id AS revision_id, c.title
         FROM chapters c WHERE c.id > @afterId AND ${activeChapterSql(db)} ORDER BY c.id LIMIT @limit`
      : kind === 'knowledge'
        ? `SELECT 'knowledge' AS source_kind, k.id AS source_id, k.name AS title,
            (SELECT r.id FROM knowledge_item_revisions r WHERE r.item_id = k.id ORDER BY r.knowledge_revision DESC LIMIT 1) AS revision_id
           FROM knowledge_items k WHERE k.book_id = @bookId AND k.id > @afterId ORDER BY k.id LIMIT @limit`
        : `SELECT 'story' AS source_kind, s.id AS source_id, s.title,
            (SELECT r.id FROM story_record_revisions r WHERE r.record_id = s.id ORDER BY r.knowledge_revision DESC LIMIT 1) AS revision_id
           FROM story_records s WHERE s.book_id = @bookId AND s.id > @afterId ORDER BY s.id LIMIT @limit`
    const bindings = kind === 'chapter'
      ? { afterId: task.planning_after_id, limit: MEMORY_PLAN_PAGE }
      : { afterId: task.planning_after_id, limit: MEMORY_PLAN_PAGE, bookId }
    const sources = db.prepare(sql).all(bindings) as SourceRow[]
    const insert = db.prepare(`INSERT INTO memory_task_units (task_id, source_kind, source_id, revision_id, title) VALUES (?, ?, ?, ?, ?)`)
    for (const source of sources) {
      const identity = sourceIdentity(source)
      insert.run(task.id, identity.source_kind, identity.source_id, identity.revision_id, identity.title)
    }
    task.planned_sources += sources.length
    if (sources.length < MEMORY_PLAN_PAGE) {
      task.planning_kind += 1
      task.planning_after_id = ''
    } else task.planning_after_id = sources[sources.length - 1].source_id
    if (task.planning_kind === MEMORY_SOURCE_KINDS.length) {
      task.phase = task.planned_sources === 0 ? 'publishing' : 'indexing'
      task.state = 'running'
    }
  }

  private index(db: Database.Database, bookId: string, task: TaskRow): void {
    const unit = db.prepare(`SELECT id, task_id, source_kind, source_id, revision_id, title, artifact_id, state,
      block_index, block_offset, next_ordinal FROM memory_task_units WHERE task_id = ? AND state != 'completed' ORDER BY id LIMIT 1`)
      .get(task.id) as UnitRow | undefined
    if (!unit) {
      if (task.completed_sources !== task.planned_sources) throw storageFailure()
      task.phase = 'publishing'
      return
    }
    const identity = sourceIdentity(unit)
    if (!unit.artifact_id) {
      const reusable = db.prepare(`SELECT id, source_kind, source_id, revision_id, title, projection_version, content_hash, complete, chunk_count
        FROM memory_artifacts WHERE source_kind = ? AND source_id = ? AND revision_id = ? AND title = ? AND projection_version = ? AND complete = 1`)
        .get(identity.source_kind, identity.source_id, identity.revision_id, identity.title, MEMORY_PROJECTION_VERSION) as ArtifactRow | undefined
      if (reusable) {
        if (!Number.isSafeInteger(reusable.chunk_count) || reusable.chunk_count < 0) throw storageFailure()
        db.prepare("UPDATE memory_task_units SET artifact_id = ?, state = 'completed' WHERE id = ? AND task_id = ?")
          .run(reusable.id, unit.id, task.id)
        task.completed_sources += 1
        task.processed_chunks += reusable.chunk_count
        if (task.completed_sources === task.planned_sources) task.phase = 'publishing'
        return
      }
    }
    const projection = readMemoryProjection(db, bookId, { sourceKind: identity.source_kind, sourceId: identity.source_id,
      revisionId: identity.revision_id, title: identity.title })
    if (!unit.artifact_id) unit.artifact_id = this.createArtifact(db, projection)
    const artifact = db.prepare(`SELECT id, source_kind, source_id, revision_id, title, projection_version, content_hash, complete, chunk_count
      FROM memory_artifacts WHERE id = ?`).get(unit.artifact_id) as ArtifactRow | undefined
    if (!artifact || artifact.source_kind !== identity.source_kind || artifact.source_id !== identity.source_id ||
      artifact.revision_id !== identity.revision_id || artifact.title !== identity.title || artifact.projection_version !== MEMORY_PROJECTION_VERSION ||
      artifact.complete !== 0 || artifact.content_hash !== projection.contentHash || artifact.chunk_count !== unit.next_ordinal) throw storageFailure()
    const page = projectMemoryChunks(projection, { blockIndex: unit.block_index, offset: unit.block_offset }, MEMORY_STEP_CHUNKS)
    if (page.chunks.length > MEMORY_STEP_CHUNKS || (page.chunks.length === 0 && !page.complete &&
      page.cursor.blockIndex === unit.block_index && page.cursor.offset === unit.block_offset)) throw storageFailure()
    const insert = db.prepare(`INSERT INTO memory_chunks (artifact_id, ordinal, block_id, start_offset, end_offset, text, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const indexChunk = db.prepare('INSERT INTO memory_chunks_fts (rowid, search_text) VALUES (?, ?)')
    for (let index = 0; index < page.chunks.length; index += 1) {
      const chunk = page.chunks[index]
      const inserted = insert.run(unit.artifact_id, unit.next_ordinal + index, chunk.blockId, chunk.startOffset, chunk.endOffset, chunk.text, chunk.searchText)
      if (!Number.isSafeInteger(Number(inserted.lastInsertRowid)) || Number(inserted.lastInsertRowid) < 1) throw storageFailure()
      // trusted_schema 保持关闭，索引同步用同事务的顶层 SQL，不由虚拟表触发器间接写入。
      indexChunk.run(inserted.lastInsertRowid, chunk.searchText)
    }
    const totalChunks = unit.next_ordinal + page.chunks.length
    db.prepare('UPDATE memory_artifacts SET chunk_count = ?, complete = ? WHERE id = ? AND complete = 0')
      .run(totalChunks, page.complete ? 1 : 0, unit.artifact_id)
    db.prepare(`UPDATE memory_task_units SET artifact_id = ?, state = ?, block_index = ?, block_offset = ?, next_ordinal = ?
      WHERE id = ? AND task_id = ?`).run(unit.artifact_id, page.complete ? 'completed' : 'processing',
      page.cursor.blockIndex, page.cursor.offset, totalChunks, unit.id, task.id)
    task.processed_chunks += page.chunks.length
    if (page.complete) task.completed_sources += 1
    if (task.completed_sources === task.planned_sources) task.phase = 'publishing'
  }

  private createArtifact(db: Database.Database, projection: MemoryProjection): string {
    const id = randomUUID()
    db.prepare(`INSERT INTO memory_artifacts (id, source_kind, source_id, revision_id, title, title_search_text, projection_version,
      content_hash, nature, author_decision, freshness, conflict_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projection.sourceKind, projection.sourceId, projection.revisionId, projection.title, toSearchText(projection.title),
        MEMORY_PROJECTION_VERSION, projection.contentHash, projection.nature, projection.authorDecision, projection.freshness,
        projection.conflictState, new Date().toISOString())
    const entity = db.prepare('INSERT INTO memory_artifact_entities (artifact_id, entity_id) VALUES (?, ?)')
    for (const entityId of new Set(projection.entityIds)) entity.run(id, entityId)
    const dependency = db.prepare('INSERT INTO memory_artifact_dependencies (artifact_id, chapter_id, revision_id) VALUES (?, ?, ?)')
    for (const source of projection.chapterDependencies) dependency.run(id, source.chapterId, source.revisionId)
    return id
  }

  private publish(db: Database.Database, bookId: string, task: TaskRow): void {
    const book = readBook(db, bookId)
    if (!matches(task, book, db)) conflict('发布前作品已有新版本，本批整理没有覆盖新资料。')
    const sourceCount = count(db, `SELECT count(*) AS total FROM (${currentMemorySourcesSql(db)})`)
    const ready = count(db, `SELECT count(*) AS total FROM memory_task_units u
      JOIN memory_artifacts a ON a.id = u.artifact_id AND a.source_kind = u.source_kind AND a.source_id = u.source_id
        AND a.revision_id = u.revision_id AND a.title = u.title
      JOIN (${currentMemorySourcesSql(db)}) current ON current.source_kind = u.source_kind AND current.source_id = u.source_id
        AND current.revision_id = u.revision_id AND current.title = u.title
      WHERE u.task_id = ? AND u.state = 'completed' AND a.complete = 1 AND a.projection_version = ?`, task.id, MEMORY_PROJECTION_VERSION)
    if (task.completed_sources !== task.planned_sources || ready !== sourceCount || ready !== task.planned_sources ||
      count(db, 'SELECT count(*) AS total FROM memory_task_units WHERE task_id = ?', task.id) !== ready) throw storageFailure()
    if (book.index_publication_version >= Number.MAX_SAFE_INTEGER) throw storageFailure()
    const publicationVersion = book.index_publication_version + 1
    db.prepare(`INSERT INTO memory_publications (version, task_id, book_revision, knowledge_revision, source_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(publicationVersion, task.id, book.revision, book.knowledge_revision, sourceCount, new Date().toISOString())
    // 发布采用新批次指针；旧批次、片段和未采用产物保留，不通过删除旧资料实现替换。
    db.prepare(`INSERT INTO memory_heads (publication_version, source_kind, source_id, artifact_id)
      SELECT ?, source_kind, source_id, artifact_id FROM memory_task_units WHERE task_id = ? AND state = 'completed'`)
      .run(publicationVersion, task.id)
    const published = db.prepare(`UPDATE book_meta SET index_publication_version = ?
      WHERE singleton = 1 AND id = ? AND revision = ? AND knowledge_revision = ? AND index_publication_version = ?`)
      .run(publicationVersion, bookId, task.target_book_revision, task.target_knowledge_revision, task.expected_publication_version)
    if (published.changes !== 1) conflict('发布基线已变化，本批结果没有生效。')
    // 三个队列共用作品修订号；这里只确认本地索引已追平该输入，不代表摘要或模型维护完成。
    // 保留原始事件状态，未来消费者用自己的游标／回执推进，不会漏掉已被本地索引见过的事件。
    db.prepare(`INSERT INTO memory_event_receipts (consumer, queue, event_id, book_revision, task_id, publication_version)
      SELECT 'local_keyword_entity_v1', queue, event_id, book_revision, @taskId, @publication FROM (
        SELECT 'outbox' AS queue, id AS event_id, book_revision FROM outbox WHERE book_revision <= @target
        UNION ALL SELECT 'knowledge_outbox' AS queue, id AS event_id, book_revision FROM knowledge_outbox WHERE book_revision <= @target
        UNION ALL SELECT 'story_outbox' AS queue, id AS event_id, book_revision FROM story_outbox WHERE book_revision <= @target
      ) event WHERE NOT EXISTS (SELECT 1 FROM memory_event_receipts existing WHERE existing.consumer = 'local_keyword_entity_v1'
        AND existing.queue = event.queue AND existing.event_id = event.event_id)
      ORDER BY book_revision, queue, event_id`).run({ taskId: task.id, publication: publicationVersion, target: task.target_book_revision })
    task.state = 'completed'
    task.error = null
  }
}
