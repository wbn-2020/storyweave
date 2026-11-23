import { createHash, randomUUID } from 'node:crypto'
import { activeChapterSql, supportsChapterArchive } from '../storage/chapter-lifecycle'
import type Database from 'better-sqlite3'
import { DomainError, isRecord, requiredId, requiredText } from '../../contracts/api'
import { parseAiBookInput, type AiBookInput, type AiConnection, type AiMaintenanceBaseline, type AiRun, type AiRunState } from '../../contracts/ai'
import {
  AI_MEMORY_TASK_CONSUMER, AI_MEMORY_TASK_PLAN_PAGE, AI_MEMORY_TASK_UNIT_PAGE,
  parseAiMemoryTaskControlInput, parseAiMemoryTaskInput, parseAiMemoryTaskReadInput, parseAiMemoryTaskScope, parseAiMemoryTaskStartInput,
  type AiMemoryTaskControlInput, type AiMemoryTaskDetail, type AiMemoryTaskInput, type AiMemoryTaskKind,
  type AiMemoryTaskReadInput, type AiMemoryTaskReceipt, type AiMemoryTaskScope, type AiMemoryTaskStartInput,
  type AiMemoryTaskState, type AiMemoryTaskStatus, type AiMemoryTaskSummary, type AiMemoryTaskUnit,
} from '../../contracts/ai-memory-task'
import {
  AI_MEMORY_MAINTENANCE_BATCH, AI_MEMORY_MAINTENANCE_PAGE, parseAiMemoryMaintenanceInput,
  type AiMemoryMaintenanceChapter, type AiMemoryMaintenanceInput, type AiMemoryMaintenancePage,
} from '../../contracts/ai-memory-maintenance'
import type { StudioRepository } from '../storage/studio-repository'
import { BOOK_SCHEMA_VERSION } from '../storage/schema'
import type { AiRepository } from './ai-repository'

interface BookState { id: string; title: string; revision: number; knowledge_revision: number; archived_at: string | null }
interface TaskRow {
  id: string; book_id: string; version: number; state: AiMemoryTaskState; phase: 'planning' | 'reviewing'
  kind: AiMemoryTaskKind; scope_kind: 'book' | 'volume'; scope_volume_id: string | null; scope_title: string
  manifest_hash: string; total_chapters: number; planned_chapters: number; reviewed_chapters: number; skipped_chapters: number
  connection_id: string; connection_name: string; model: string; instruction: string
  source_book_revision: number; source_knowledge_revision: number; error: string | null; created_at: string; updated_at: string
}
interface ChapterMetadata {
  id: string; title: string; current_revision_id: string; position: number
  volume_id: string | null; volume_title: string | null; volume_position: number | null
}
interface Manifest { hash: string | null; scopeTitle: string; chapters: ChapterMetadata[] }
interface SelectionSource { bookId: string; bookTitle: string; scope: AiMemoryTaskScope; scopeTitle: string; chapters: ChapterMetadata[] }
interface MaintenanceCoverage { manifest: Manifest; pending: { chapter: ChapterMetadata; reason: AiMemoryMaintenanceChapter['reason'] }[]; hash: string }
interface UnitRow {
  task_id: string; book_id: string; ordinal: number; chapter_id: string; chapter_revision_id: string; chapter_title: string
  volume_id: string | null; chapter_position: number; state: AiMemoryTaskUnit['state']; run_id: string | null; attempts: number
  run_state: AiRunState | null; run_book_id: string | null; run_chapter_id: string | null; run_kind: AiMemoryTaskKind | null
  run_chapter_title: string | null; attempt_count: number; attempt_maximum: number; latest_run_id: string | null
}

const MAX_CHAPTERS = 20_000
const MAX_SELECTION_JSON = 256_000
const CHAPTER_COLUMNS = 'c.id, c.title, c.current_revision_id, c.position, c.volume_id, v.title AS volume_title, v.position AS volume_position'
const ACTIVE_SQL = "state IN ('planning', 'ready', 'paused', 'failed')"
const ACTIVE_STATES: readonly AiMemoryTaskState[] = ['planning', 'ready', 'paused', 'failed']
const TASK_STATES: readonly AiMemoryTaskState[] = [...ACTIVE_STATES, 'completed', 'superseded', 'cancelled']
const RUN_STATES: readonly AiRunState[] = ['prepared', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'rejected', 'adopted']
const TASK_COLUMNS = `id, book_id, version, state, phase, kind, scope_kind, scope_volume_id, scope_title, manifest_hash,
  total_chapters, planned_chapters, reviewed_chapters, skipped_chapters, connection_id, connection_name, model, instruction,
  source_book_revision, source_knowledge_revision, error, created_at, updated_at`
const UNIT_COLUMNS = `u.task_id, u.book_id, u.ordinal, u.chapter_id, u.chapter_revision_id, u.chapter_title,
  u.volume_id, u.chapter_position, u.state, u.run_id, u.attempts, r.state AS run_state, r.book_id AS run_book_id,
  r.chapter_id AS run_chapter_id, r.kind AS run_kind, r.chapter_title AS run_chapter_title,
  (SELECT count(*) FROM ai_memory_task_attempts a WHERE a.task_id = u.task_id AND a.unit_ordinal = u.ordinal) AS attempt_count,
  (SELECT COALESCE(max(attempt), 0) FROM ai_memory_task_attempts a WHERE a.task_id = u.task_id AND a.unit_ordinal = u.ordinal) AS attempt_maximum,
  (SELECT run_id FROM ai_memory_task_attempts a WHERE a.task_id = u.task_id AND a.unit_ordinal = u.ordinal
    ORDER BY attempt DESC LIMIT 1) AS latest_run_id`
const UNIT_FROM = 'FROM ai_memory_task_units u LEFT JOIN ai_runs r ON r.id = u.run_id'

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '逐章整理队列或候选记录无法核对，请保留作品与已有候选后检查资料。' })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}
function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function conflict(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}
function storedId(value: unknown): string {
  try {
    const id = requiredId(value)
    if (id !== id.toLowerCase()) throw storageFailure()
    return id
  } catch { throw storageFailure() }
}
function storedText(value: unknown, maximum: number): string {
  try {
    const text = requiredText(value, '队列资料', maximum)
    if (text !== value) throw storageFailure()
    return text
  } catch { throw storageFailure() }
}
function timestamp(value: unknown): void {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw storageFailure()
}
function schemaVersion(db: Database.Database): number {
  const version = db.pragma('user_version', { simple: true })
  if (!integer(version, BOOK_SCHEMA_VERSION) || version < 2) throw storageFailure()
  return version
}
function requireQueue(db: Database.Database): void {
  if (schemaVersion(db) < 8) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级至 v8，再使用按书或卷的逐章模型整理。' })
}
function requireMaintenance(db: Database.Database): void {
  if (schemaVersion(db) < 11) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级至 v11，再读取待维护清单或创建增量任务。' })
}
function fingerprint(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function sourceJson(book: BookState, scope: AiMemoryTaskScope, scopeTitle: string, chapters: ChapterMetadata[]): string {
  return JSON.stringify({ bookId: book.id, bookTitle: book.title, scope, scopeTitle, chapters })
}
function checkChapters(chapters: ChapterMetadata[]): void {
  let previous = -1
  const ids = new Set<string>()
  for (const chapter of chapters) {
    if (!isRecord(chapter) || Object.keys(chapter).some((key) => !['id', 'title', 'current_revision_id', 'position', 'volume_id', 'volume_title', 'volume_position'].includes(key))) throw storageFailure()
    storedId(chapter.id)
    storedId(chapter.current_revision_id)
    storedText(chapter.title, 120)
    if (ids.has(chapter.id) || !integer(chapter.position) || chapter.position <= previous) throw storageFailure()
    ids.add(chapter.id)
    previous = chapter.position
    if (chapter.volume_id === null) {
      if (chapter.volume_title !== null || chapter.volume_position !== null) throw storageFailure()
    } else {
      storedId(chapter.volume_id)
      storedText(chapter.volume_title, 120)
      if (!integer(chapter.volume_position)) throw storageFailure()
    }
  }
}
function readBook(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, title, revision, knowledge_revision, archived_at FROM book_meta WHERE singleton = 1')
    .get() as BookState | undefined
  if (!row || storedId(row.id) !== bookId || !integer(row.revision) || !integer(row.knowledge_revision)) throw storageFailure()
  storedText(row.title, 120)
  if (row.archived_at !== null) timestamp(row.archived_at)
  return row
}
function writable(book: BookState): void {
  if (book.archived_at !== null) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请先取消归档再继续整理。' })
}
function scopeOf(task: TaskRow): AiMemoryTaskScope {
  if (task.scope_kind === 'book' && task.scope_volume_id === null) return { kind: 'book' }
  if (task.scope_kind !== 'volume') throw storageFailure()
  return { kind: 'volume', volumeId: task.scope_volume_id === null ? null : storedId(task.scope_volume_id) }
}
function checkTask(task: TaskRow, bookId: string): void {
  if (storedId(task.book_id) !== bookId || !TASK_STATES.includes(task.state) ||
    (task.phase !== 'planning' && task.phase !== 'reviewing') || (task.kind !== 'summarize' && task.kind !== 'extract') ||
    !integer(task.total_chapters, MAX_CHAPTERS) || task.total_chapters < 1 ||
    !integer(task.planned_chapters, task.total_chapters) || !integer(task.reviewed_chapters, task.planned_chapters) ||
    !integer(task.skipped_chapters, task.planned_chapters) || task.reviewed_chapters + task.skipped_chapters > task.planned_chapters ||
    !integer(task.version) || !integer(task.source_book_revision) || !integer(task.source_knowledge_revision) ||
    typeof task.manifest_hash !== 'string' || !/^[0-9a-f]{64}$/.test(task.manifest_hash) ||
    (task.error !== null && (typeof task.error !== 'string' || task.error.length > 500)) ||
    (task.phase === 'planning' && task.reviewed_chapters + task.skipped_chapters !== 0) ||
    (task.phase === 'reviewing' && task.planned_chapters !== task.total_chapters) ||
    (task.state === 'planning' && task.phase !== 'planning') || (task.state === 'ready' && task.phase !== 'reviewing') ||
    (task.state === 'completed' && task.reviewed_chapters + task.skipped_chapters !== task.total_chapters)) throw storageFailure()
  storedId(task.id)
  storedId(task.connection_id)
  storedText(task.scope_title, 120)
  storedText(task.connection_name, 80)
  storedText(task.model, 200)
  storedText(task.instruction, 6000)
  timestamp(task.created_at)
  timestamp(task.updated_at)
  scopeOf(task)
}
function readTask(db: Database.Database, bookId: string, taskId: string): TaskRow {
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM ai_memory_tasks WHERE id = ? AND book_id = ?`)
    .get(taskId, bookId) as TaskRow | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个逐章整理任务。' })
  checkTask(row, bookId)
  const counts = db.prepare(`SELECT count(*) AS total, COALESCE(max(ordinal), 0) AS maximum,
    COALESCE(sum(CASE WHEN state = 'reviewed' THEN 1 ELSE 0 END), 0) AS reviewed,
    COALESCE(sum(CASE WHEN state = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped
    FROM ai_memory_task_units WHERE task_id = ? AND book_id = ?`).get(taskId, bookId) as
      { total: number; maximum: number; reviewed: number; skipped: number } | undefined
  if (!counts || counts.total !== row.planned_chapters || counts.maximum !== counts.total ||
    counts.reviewed !== row.reviewed_chapters || counts.skipped !== row.skipped_chapters) throw storageFailure()
  return row
}
function checkVersion(task: TaskRow, expected: number): void {
  if (task.version !== expected) conflict('逐章整理任务已有新进度，请刷新后继续；本次操作没有覆盖检查点。')
  if (task.version >= Number.MAX_SAFE_INTEGER) throw storageFailure()
}
function advance(db: Database.Database, task: TaskRow): void {
  checkTask(task, task.book_id)
  if (task.version >= Number.MAX_SAFE_INTEGER) throw storageFailure()
  const changed = db.prepare(`UPDATE ai_memory_tasks SET version = version + 1, state = @state, phase = @phase,
    planned_chapters = @planned, reviewed_chapters = @reviewed, skipped_chapters = @skipped, error = @error, updated_at = @now
    WHERE id = @id AND book_id = @bookId AND version = @expected`).run({ id: task.id, bookId: task.book_id, expected: task.version,
    state: task.state, phase: task.phase, planned: task.planned_chapters, reviewed: task.reviewed_chapters,
    skipped: task.skipped_chapters, error: task.error, now: new Date().toISOString() })
  if (changed.changes !== 1) conflict('逐章整理检查点已变化，请刷新后继续。')
}
function supersede(task: TaskRow): void {
  task.state = 'superseded'
  task.error = '范围内原稿、标题、卷归属或顺序已变化，请按当前来源创建新任务。'
}
function fail(task: TaskRow, message: string): void { task.state = 'failed'; task.error = message.slice(0, 500) }
function sameConnection(left: AiConnection, right: AiConnection): boolean {
  return left.id === right.id && left.version === right.version && left.name === right.name && left.baseUrl === right.baseUrl &&
    left.model === right.model && left.contextWindow === right.contextWindow && left.maxOutputTokens === right.maxOutputTokens && left.updatedAt === right.updatedAt
}

export class AiMemoryTaskRepository {
  constructor(private readonly studio: StudioRepository, private readonly ai: AiRepository) {}

  status(input: AiBookInput): AiMemoryTaskStatus {
    const data = parseAiBookInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => this.readStatus(db, data.bookId))()
    })
  }

  get(input: AiMemoryTaskReadInput): AiMemoryTaskDetail {
    const data = parseAiMemoryTaskReadInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireQueue(db)
      return db.transaction(() => this.detail(db, readTask(db, data.bookId, data.taskId), readBook(db, data.bookId), data.afterOrdinal ?? 0))()
    })
  }

  maintenance(input: AiMemoryMaintenanceInput): AiMemoryMaintenancePage {
    const data = parseAiMemoryMaintenanceInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireMaintenance(db)
      return db.transaction(() => {
        const book = readBook(db, data.bookId)
        if (book.revision !== data.expectedBookRevision || book.knowledge_revision !== data.expectedKnowledgeRevision) {
          conflict('作品或知识已有新版本，请刷新后重新读取待维护清单。')
        }
        const coverage = this.coverage(db, book, data.kind, data.scope)
        if (data.expectedCoverageHash !== undefined && coverage.hash !== data.expectedCoverageHash) {
          conflict('原稿或作者审阅记录已变化，请从第一页重新读取待维护清单。')
        }
        const afterOrdinal = data.afterOrdinal ?? 0
        if (afterOrdinal > coverage.pending.length) invalid('待维护分页位置已超出清单，请重新读取。')
        const chapters = coverage.pending.slice(afterOrdinal, afterOrdinal + AI_MEMORY_MAINTENANCE_PAGE).map(({ chapter, reason }, index) => ({
          ordinal: afterOrdinal + index + 1, chapterId: chapter.id, chapterTitle: chapter.title,
          chapterRevisionId: chapter.current_revision_id, volumeId: chapter.volume_id, reason,
        }))
        const unreviewed = coverage.pending.filter((item) => item.reason === 'unreviewed').length
        const end = afterOrdinal + chapters.length
        return { bookId: book.id, bookRevision: book.revision, knowledgeRevision: book.knowledge_revision, schemaVersion: schemaVersion(db),
          kind: data.kind, scope: data.scope, scopeTitle: coverage.manifest.scopeTitle, coverageHash: coverage.hash,
          totalChapters: coverage.manifest.chapters.length, reviewedChapters: coverage.manifest.chapters.length - coverage.pending.length,
          pendingChapters: coverage.pending.length, unreviewedChapters: unreviewed, changedChapters: coverage.pending.length - unreviewed,
          afterOrdinal, chapters, nextAfterOrdinal: end < coverage.pending.length ? end : null }
      })()
    })
  }

  verifyMaintenanceBaseline(candidate: AiRun, baseline: AiMaintenanceBaseline): void {
    // 仅由发送/采用事务调用；未改动的单章候选可以沿用原消息，写入仍须匹配当前书、知识和队列版本。
    const db = this.studio.getMemoryDatabase(candidate.bookId)
    requireMaintenance(db)
    const book = readBook(db, candidate.bookId)
    const task = readTask(db, candidate.bookId, baseline.taskId)
    checkVersion(task, baseline.expectedTaskVersion)
    writable(book)
    if (book.revision !== baseline.expectedBookRevision || book.knowledge_revision !== baseline.expectedKnowledgeRevision ||
      baseline.expectedBookRevision < candidate.context.bookRevision || baseline.expectedKnowledgeRevision !== candidate.context.knowledgeRevision) {
      conflict('当前作品、知识或增量任务基线已变化，请刷新后核对候选。')
    }
    if (task.state !== 'ready' || task.phase !== 'reviewing' || this.selectionSource(db, task) === null || !this.sourceCurrent(db, book, task)) {
      conflict('增量任务的固定来源或状态已变化，不能发送或采用这个候选。')
    }
    const unit = this.currentUnit(db, task)
    const context = candidate.context
    if (!unit || unit.runId !== candidate.id || unit.chapterId !== candidate.chapterId || unit.chapterRevisionId !== context.chapterRevisionId ||
      unit.chapterTitle !== candidate.chapterTitle || unit.chapterTitle !== context.chapterTitle || task.kind !== candidate.kind ||
      task.instruction !== context.instruction || task.connection_id !== context.connection.id || context.summary !== undefined ||
      context.contextScope !== 'chapter' || context.selectedBlockIds.length || context.evidence.length || context.contextSummaries?.length || context.characterContext) {
      conflict('候选与当前增量任务章节不符，请重新读取任务。')
    }
  }

  start(input: AiMemoryTaskStartInput): AiMemoryTaskReceipt {
    const data = parseAiMemoryTaskStartInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireQueue(db)
      return db.transaction(() => {
        const book = readBook(db, data.bookId)
        writable(book)
        if (book.revision !== data.expectedBookRevision || book.knowledge_revision !== data.expectedKnowledgeRevision) {
          conflict('作品或知识已有新版本，请刷新后开始逐章整理。')
        }
        let manifest: Manifest
        let selectionJson: string | null = null
        if (data.selection === 'pending_review') {
          requireMaintenance(db)
          const coverage = this.coverage(db, book, data.kind, data.scope)
          if (coverage.hash !== data.expectedCoverageHash) conflict('待维护清单已变化，请重新读取后创建增量任务。')
          const chapters = coverage.pending.slice(0, AI_MEMORY_MAINTENANCE_BATCH).map((item) => item.chapter)
          if (!chapters.length) invalid('所选范围的当前稿已有作者审阅记录，没有待维护章节。')
          selectionJson = sourceJson(book, data.scope, coverage.manifest.scopeTitle, chapters)
          if (selectionJson.length > MAX_SELECTION_JSON) throw storageFailure()
          manifest = { hash: fingerprint(selectionJson), scopeTitle: coverage.manifest.scopeTitle, chapters }
        } else manifest = this.manifest(db, book, data.scope)
        if (manifest.hash === null) invalid('所选卷已不存在，请刷新作品目录。')
        if (!manifest.chapters.length) invalid('所选范围没有章节，请先添加原稿。')
        const connection = this.connection(data.bookId, data.connectionId)
        const existing = db.prepare(`SELECT ${TASK_COLUMNS} FROM ai_memory_tasks WHERE book_id = ? AND ${ACTIVE_SQL}`)
          .get(data.bookId) as TaskRow | undefined
        if (existing) {
          const previous = readTask(db, data.bookId, existing.id)
          if (this.sourceCurrent(db, book, previous)) conflict('这部作品已有可继续的逐章整理任务，请继续或取消该任务。')
          supersede(previous)
          advance(db, previous)
        }
        const id = randomUUID()
        const now = new Date().toISOString()
        db.prepare(`INSERT INTO ai_memory_tasks (id, book_id, state, phase, kind, scope_kind, scope_volume_id, scope_title,
          manifest_hash, total_chapters, connection_id, connection_name, model, instruction, source_book_revision,
          source_knowledge_revision, created_at, updated_at) VALUES (?, ?, 'planning', 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, data.bookId, data.kind, data.scope.kind, data.scope.kind === 'volume' ? data.scope.volumeId : null,
            manifest.scopeTitle, manifest.hash, manifest.chapters.length, connection.id, connection.name, connection.model,
            data.instruction, book.revision, book.knowledge_revision, now, now)
        if (selectionJson !== null) {
          db.prepare('INSERT INTO ai_memory_task_selections (task_id, book_id, source_json) VALUES (?, ?, ?)').run(id, book.id, selectionJson)
        }
        return this.receipt(db, data.bookId, id)
      }).immediate()
    })
  }

  step(input: AiMemoryTaskInput): AiMemoryTaskReceipt {
    const data = parseAiMemoryTaskInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireQueue(db)
      return db.transaction(() => {
        const book = readBook(db, data.bookId)
        const task = readTask(db, data.bookId, data.taskId)
        checkVersion(task, data.expectedTaskVersion)
        if (task.state !== 'planning' && task.state !== 'ready') invalid('请先继续或重试这个任务，再处理下一章。')
        const manifest = this.taskManifest(db, book, task)
        if (manifest.hash !== task.manifest_hash || manifest.chapters.length !== task.total_chapters) supersede(task)
        else {
          writable(book)
          if (task.phase === 'planning') this.plan(db, task, manifest)
          else this.review(db, task, book)
        }
        // 即使只返回正在等待的同一个候选，本次有效操作也只推进一次任务版本。
        advance(db, task)
        return this.receipt(db, data.bookId, task.id)
      }).immediate()
    })
  }

  control(input: AiMemoryTaskControlInput): AiMemoryTaskReceipt {
    const data = parseAiMemoryTaskControlInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireQueue(db)
      return db.transaction(() => {
        const book = readBook(db, data.bookId)
        const task = readTask(db, data.bookId, data.taskId)
        checkVersion(task, data.expectedTaskVersion)
        if (!ACTIVE_STATES.includes(task.state)) invalid('逐章整理任务已结束，不能再改变进度。')
        const unit = this.currentUnit(db, task)
        const candidate = unit?.runId ? this.runFor(task, unit) : null
        if ((data.action === 'cancel' || data.action === 'skip') && candidate?.state === 'running') {
          invalid('当前章节仍在生成，请先停止模型生成再取消任务或跳过章节。')
        }
        if (!this.sourceCurrent(db, book, task)) supersede(task)
        else if (data.action === 'cancel') { task.state = 'cancelled'; task.error = null }
        else if (data.action === 'pause') {
          if (task.state !== 'planning' && task.state !== 'ready') invalid('只有可继续处理的任务可以暂停。')
          // 暂停只记录队列意图，已经发出的网络请求由已有生成控制管理。
          task.state = 'paused'
        } else if (data.action === 'resume') {
          if (task.state !== 'paused') invalid('只有暂停的任务可以继续。')
          writable(book)
          task.state = task.phase === 'planning' ? 'planning' : 'ready'
          task.error = null
        } else if (data.action === 'retry') {
          if (task.state !== 'failed') invalid('只有失败的任务可以显式重试。')
          writable(book)
          if (candidate?.state === 'running') invalid('请先停止当前模型生成，再重试章节。')
          if (unit && candidate && candidate.state !== 'adopted' && candidate.state !== 'rejected') {
            if (candidate.state === 'prepared' || candidate.state === 'succeeded') {
              this.ai.reject({ bookId: data.bookId, runId: candidate.id, expectedVersion: candidate.version })
            }
            const changed = db.prepare(`UPDATE ai_memory_task_units SET run_id = NULL
              WHERE task_id = ? AND book_id = ? AND ordinal = ? AND state = 'pending' AND run_id = ?`)
              .run(task.id, task.book_id, unit.ordinal, candidate.id)
            if (changed.changes !== 1) throw storageFailure()
          }
          // 旧尝试永不覆盖；若作者刚完成审阅，则保留关联让下一步登记原决定。
          task.state = task.phase === 'planning' ? 'planning' : 'ready'
          task.error = null
        } else {
          writable(book)
          if (task.phase !== 'reviewing' || !unit) invalid('当前没有可跳过的章节。')
          if (candidate?.state === 'prepared' || candidate?.state === 'succeeded') {
            this.ai.reject({ bookId: data.bookId, runId: candidate.id, expectedVersion: candidate.version })
          }
          this.finishUnit(db, task, unit, 'skipped')
          task.error = null
          if (task.state !== 'paused') task.state = 'ready'
          this.complete(task)
        }
        advance(db, task)
        return this.receipt(db, data.bookId, task.id)
      }).immediate()
    })
  }

  private connection(bookId: string, connectionId: string): AiConnection {
    const connection = this.ai.listConnections({ bookId }).connections.find((item) => item.id === connectionId)
    if (!connection) throw new DomainError({ code: 'NOT_FOUND', message: '这个模型连接已不存在，请核对连接后重试或新建任务。' })
    return connection
  }

  private manifest(db: Database.Database, book: BookState, scope: AiMemoryTaskScope, selectedIds?: string[]): Manifest {
    let scopeTitle = book.title
    if (scope.kind === 'volume') {
      if (scope.volumeId === null) scopeTitle = '未分卷章节'
      else {
        const volume = db.prepare(`SELECT id, title FROM volumes WHERE id = ?${supportsChapterArchive(db) ? ' AND archived_at IS NULL' : ''}`).get(scope.volumeId) as { id: string; title: string } | undefined
        if (!volume) return { hash: null, scopeTitle: '', chapters: [] }
        if (storedId(volume.id) !== scope.volumeId) throw storageFailure()
        scopeTitle = storedText(volume.title, 120)
      }
    }
    // 只读取元数据来固定来源，不在任务建立或规划阶段装入全书正文。
    const selection = selectedIds === undefined ? '' : `AND c.id IN (${selectedIds.map(() => '?').join(', ')})`
    const chapters = db.prepare(`SELECT ${CHAPTER_COLUMNS} FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id
      WHERE (? = 'book' OR c.volume_id IS ?) AND ${activeChapterSql(db)} ${selection} ORDER BY c.position, c.id LIMIT ?`)
      .all(scope.kind, scope.kind === 'volume' ? scope.volumeId : null, ...(selectedIds ?? []), MAX_CHAPTERS + 1) as ChapterMetadata[]
    if (chapters.length > MAX_CHAPTERS) throw storageFailure()
    checkChapters(chapters)
    const hash = fingerprint(sourceJson(book, scope, scopeTitle, chapters))
    return { hash, scopeTitle, chapters }
  }

  private coverage(db: Database.Database, book: BookState, kind: AiMemoryTaskKind, scope: AiMemoryTaskScope): MaintenanceCoverage {
    const manifest = this.manifest(db, book, scope)
    if (manifest.hash === null) invalid('所选卷已不存在，请刷新作品目录。')
    // 当前覆盖只认这个消费者的逐章审阅回执，并核对任务、尝试与作者决定；不读取候选正文或借用索引回执。
    const rows = db.prepare(`SELECT c.id, r.run_id AS receipt_run_id,
      EXISTS (SELECT 1 FROM ai_memory_review_receipts h WHERE h.book_id = @bookId AND h.consumer = @consumer
        AND h.kind = @kind AND h.chapter_id = c.id) AS has_history,
      CASE WHEN t.kind = @kind AND t.book_id = @bookId AND u.book_id = @bookId AND u.state = 'reviewed'
        AND u.chapter_id = c.id AND u.chapter_revision_id = c.current_revision_id AND u.chapter_title = c.title AND u.run_id = r.run_id
        AND a.book_id = @bookId AND a.chapter_id = c.id AND a.attempt = u.attempts
        AND g.book_id = @bookId AND g.chapter_id = c.id AND g.chapter_title = c.title AND g.kind = @kind AND g.state = r.decision
        THEN 1 ELSE 0 END AS qualified
      FROM chapters c LEFT JOIN ai_memory_review_receipts r ON r.book_id = @bookId AND r.consumer = @consumer
        AND r.kind = @kind AND r.chapter_id = c.id AND r.chapter_revision_id = c.current_revision_id AND r.chapter_title = c.title
      LEFT JOIN ai_memory_tasks t ON t.id = r.task_id
      LEFT JOIN ai_memory_task_units u ON u.task_id = r.task_id AND u.ordinal = r.unit_ordinal
      LEFT JOIN ai_memory_task_attempts a ON a.task_id = r.task_id AND a.unit_ordinal = r.unit_ordinal AND a.run_id = r.run_id
      LEFT JOIN ai_runs g ON g.id = r.run_id
      WHERE (@scopeKind = 'book' OR c.volume_id IS @volumeId) AND ${activeChapterSql(db)} ORDER BY c.position, c.id LIMIT @limit`)
      .all({ bookId: book.id, consumer: AI_MEMORY_TASK_CONSUMER, kind, scopeKind: scope.kind,
        volumeId: scope.kind === 'volume' ? scope.volumeId : null, limit: MAX_CHAPTERS + 1 }) as
        { id: string; receipt_run_id: string | null; has_history: number; qualified: number }[]
    if (rows.length !== manifest.chapters.length) throw storageFailure()
    const pending: MaintenanceCoverage['pending'] = []
    for (const [index, row] of rows.entries()) {
      const chapter = manifest.chapters[index]
      if (row.id !== chapter.id || !integer(row.has_history, 1) || !integer(row.qualified, 1)) throw storageFailure()
      if (row.receipt_run_id !== null) {
        storedId(row.receipt_run_id)
        if (row.qualified !== 1 || row.has_history !== 1) throw storageFailure()
      } else {
        if (row.qualified !== 0) throw storageFailure()
        pending.push({ chapter, reason: row.has_history ? 'changed' : 'unreviewed' })
      }
    }
    const hash = fingerprint(JSON.stringify({ consumer: AI_MEMORY_TASK_CONSUMER, kind, manifestHash: manifest.hash,
      pending: pending.map((item) => ({ id: item.chapter.id, reason: item.reason })) }))
    return { manifest, pending, hash }
  }

  private selectionSource(db: Database.Database, task: TaskRow): SelectionSource | null {
    if (schemaVersion(db) < 11) return null
    const row = db.prepare('SELECT book_id, source_json FROM ai_memory_task_selections WHERE task_id = ?')
      .get(task.id) as { book_id: string; source_json: string } | undefined
    if (!row) return null
    if (row.book_id !== task.book_id || typeof row.source_json !== 'string' || row.source_json.length > MAX_SELECTION_JSON || fingerprint(row.source_json) !== task.manifest_hash) throw storageFailure()
    const value: unknown = JSON.parse(row.source_json)
    if (!isRecord(value) || Object.keys(value).some((key) => !['bookId', 'bookTitle', 'scope', 'scopeTitle', 'chapters'].includes(key)) ||
      value.bookId !== task.book_id || value.scopeTitle !== task.scope_title || !Array.isArray(value.chapters) ||
      value.chapters.length !== task.total_chapters || !value.chapters.length || value.chapters.length > AI_MEMORY_MAINTENANCE_BATCH) throw storageFailure()
    const bookTitle = storedText(value.bookTitle, 120)
    let scope: AiMemoryTaskScope
    try { scope = parseAiMemoryTaskScope(value.scope) } catch { throw storageFailure() }
    if (JSON.stringify(scope) !== JSON.stringify(scopeOf(task))) throw storageFailure()
    const chapters = value.chapters as ChapterMetadata[]
    checkChapters(chapters)
    if (scope.kind === 'volume' && chapters.some((chapter) => chapter.volume_id !== scope.volumeId)) throw storageFailure()
    return { bookId: task.book_id, bookTitle, scope, scopeTitle: task.scope_title, chapters }
  }

  private taskManifest(db: Database.Database, book: BookState, task: TaskRow, source = this.selectionSource(db, task)): Manifest {
    const current = this.manifest(db, book, scopeOf(task), source?.chapters.map((chapter) => chapter.id))
    if (source === null || current.hash === null) return current
    // 新增其他章节会重新连续编号。本批只核对已选章节的相对顺序，规划仍保留创建时的序号；
    // 修订、标题、归属、卷名或已选章节之间的次序变化仍会改变指纹，审阅回执则不参与来源比较。
    const chapters = current.chapters.map((chapter, index) => {
      const original = source.chapters[index]
      return original?.id === chapter.id ? { ...chapter, position: original.position,
        volume_position: chapter.volume_id === original.volume_id ? original.volume_position : chapter.volume_position } : chapter
    })
    return { ...current, chapters, hash: fingerprint(sourceJson(book, scopeOf(task), current.scopeTitle, chapters)) }
  }

  private sourceCurrent(db: Database.Database, book: BookState, task: TaskRow, cache?: Map<string, Manifest>): boolean {
    const scope = scopeOf(task)
    const source = this.selectionSource(db, task)
    const key = source ? task.id : JSON.stringify(scope)
    let manifest = cache?.get(key)
    if (!manifest) { manifest = this.taskManifest(db, book, task, source); cache?.set(key, manifest) }
    // 知识采用会提升两级版本；队列只比较固定来源，避免采用一章后自行失效。
    return manifest.hash === task.manifest_hash && manifest.chapters.length === task.total_chapters
  }

  private summary(db: Database.Database, book: BookState, task: TaskRow, cache?: Map<string, Manifest>): AiMemoryTaskSummary {
    checkTask(task, book.id)
    return { id: task.id, bookId: task.book_id, version: task.version, state: task.state, phase: task.phase,
      kind: task.kind, scope: scopeOf(task), scopeTitle: task.scope_title, connectionId: task.connection_id,
      ...(this.selectionSource(db, task) === null ? {} : { selection: 'pending_review' as const }),
      connectionName: task.connection_name, model: task.model, instruction: task.instruction,
      sourceBookRevision: task.source_book_revision, sourceKnowledgeRevision: task.source_knowledge_revision,
      sourceCurrent: this.sourceCurrent(db, book, task, cache), totalChapters: task.total_chapters,
      plannedChapters: task.planned_chapters, reviewedChapters: task.reviewed_chapters, skippedChapters: task.skipped_chapters,
      error: task.error, createdAt: task.created_at, updatedAt: task.updated_at }
  }

  private unit(row: UnitRow, task: TaskRow): AiMemoryTaskUnit {
    if (row.task_id !== task.id || row.book_id !== task.book_id || !integer(row.ordinal, task.planned_chapters) || row.ordinal < 1 ||
      !integer(row.chapter_position) || !integer(row.attempts) || !integer(row.attempt_count) || !integer(row.attempt_maximum) ||
      row.attempts !== row.attempt_count || row.attempts !== row.attempt_maximum ||
      !['pending', 'reviewed', 'skipped'].includes(row.state)) throw storageFailure()
    storedId(row.chapter_id)
    storedId(row.chapter_revision_id)
    storedText(row.chapter_title, 120)
    if (row.volume_id !== null) storedId(row.volume_id)
    if (row.latest_run_id !== null) storedId(row.latest_run_id)
    if ((row.attempts === 0) !== (row.latest_run_id === null)) throw storageFailure()
    if (row.run_id === null) {
      if (row.run_state !== null || row.run_book_id !== null || row.run_chapter_id !== null || row.run_kind !== null ||
        row.run_chapter_title !== null || row.state === 'reviewed') throw storageFailure()
    } else {
      storedId(row.run_id)
      if (row.run_id !== row.latest_run_id || row.run_book_id !== task.book_id || row.run_chapter_id !== row.chapter_id ||
        row.run_kind !== task.kind || row.run_chapter_title !== row.chapter_title || row.run_state === null || !RUN_STATES.includes(row.run_state) ||
        (row.state === 'reviewed' && row.run_state !== 'adopted' && row.run_state !== 'rejected') ||
        (row.state === 'skipped' && row.run_state === 'running')) throw storageFailure()
    }
    return { ordinal: row.ordinal, chapterId: row.chapter_id, chapterTitle: row.chapter_title, chapterRevisionId: row.chapter_revision_id,
      state: row.state, runId: row.run_id, runState: row.run_state, attempts: row.attempts }
  }

  private currentUnit(db: Database.Database, task: TaskRow): AiMemoryTaskUnit | null {
    if (task.phase === 'planning') return null
    const row = db.prepare(`SELECT ${UNIT_COLUMNS} ${UNIT_FROM}
      WHERE u.task_id = ? AND u.book_id = ? AND u.state = 'pending' ORDER BY u.ordinal LIMIT 1`)
      .get(task.id, task.book_id) as UnitRow | undefined
    return row ? this.unit(row, task) : null
  }

  private detail(db: Database.Database, task: TaskRow, book: BookState, afterOrdinal: number): AiMemoryTaskDetail {
    const rows = db.prepare(`SELECT ${UNIT_COLUMNS} ${UNIT_FROM}
      WHERE u.task_id = ? AND u.book_id = ? AND u.ordinal > ? ORDER BY u.ordinal LIMIT ?`)
      .all(task.id, task.book_id, afterOrdinal, AI_MEMORY_TASK_UNIT_PAGE + 1) as UnitRow[]
    const units = rows.slice(0, AI_MEMORY_TASK_UNIT_PAGE).map((row) => this.unit(row, task))
    return { ...this.summary(db, book, task), units, currentUnit: this.currentUnit(db, task),
      nextAfterOrdinal: rows.length > AI_MEMORY_TASK_UNIT_PAGE ? units[units.length - 1].ordinal : null }
  }

  private readStatus(db: Database.Database, bookId: string): AiMemoryTaskStatus {
    const version = schemaVersion(db)
    const book = readBook(db, bookId)
    const base: Omit<AiMemoryTaskStatus, 'activeTask' | 'recentTasks' | 'reviewedSourceCount'> = {
      bookId, bookRevision: book.revision, knowledgeRevision: book.knowledge_revision,
      schemaVersion: version, requiresUpgrade: version < 8, consumer: AI_MEMORY_TASK_CONSUMER }
    if (version < 8) return { ...base, activeTask: null, recentTasks: [], reviewedSourceCount: 0 }
    const cache = new Map<string, Manifest>()
    const active = db.prepare(`SELECT id FROM ai_memory_tasks WHERE book_id = ? AND ${ACTIVE_SQL} LIMIT 2`).all(bookId) as { id: string }[]
    if (active.length > 1) throw storageFailure()
    const recent = db.prepare('SELECT id FROM ai_memory_tasks WHERE book_id = ? ORDER BY created_at DESC, id DESC LIMIT 10')
      .all(bookId) as { id: string }[]
    const reviewed = db.prepare('SELECT count(*) AS total FROM ai_memory_review_receipts WHERE book_id = ? AND consumer = ?')
      .get(bookId, AI_MEMORY_TASK_CONSUMER) as { total: number } | undefined
    if (!reviewed || !integer(reviewed.total)) throw storageFailure()
    return { ...base, activeTask: active.length ? this.summary(db, book, readTask(db, bookId, storedId(active[0].id)), cache) : null,
      recentTasks: recent.map((row) => this.summary(db, book, readTask(db, bookId, storedId(row.id)), cache)), reviewedSourceCount: reviewed.total }
  }

  private receipt(db: Database.Database, bookId: string, taskId: string): AiMemoryTaskReceipt {
    const task = readTask(db, bookId, taskId)
    const detail = this.detail(db, task, readBook(db, bookId), 0)
    return { bookId, task: detail, status: this.readStatus(db, bookId),
      run: detail.currentUnit?.runId ? this.runFor(task, detail.currentUnit) : null }
  }

  private runFor(task: TaskRow, unit: AiMemoryTaskUnit): AiRun {
    if (!unit.runId) throw storageFailure()
    const candidate = this.ai.get({ bookId: task.book_id, runId: unit.runId })
    if (candidate.id !== unit.runId || candidate.bookId !== task.book_id || candidate.chapterId !== unit.chapterId ||
      candidate.chapterTitle !== unit.chapterTitle || candidate.kind !== task.kind ||
      candidate.context.chapterRevisionId !== unit.chapterRevisionId || candidate.context.chapterTitle !== unit.chapterTitle ||
      candidate.context.summary !== undefined || candidate.context.connection.id !== task.connection_id || candidate.context.instruction !== task.instruction ||
      candidate.context.contextScope !== 'chapter' || candidate.context.selectedBlockIds.length || candidate.context.evidence.length) throw storageFailure()
    return candidate
  }

  private plan(db: Database.Database, task: TaskRow, manifest: Manifest): void {
    const insert = db.prepare(`INSERT INTO ai_memory_task_units (task_id, book_id, ordinal, chapter_id, chapter_revision_id,
      chapter_title, volume_id, chapter_position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    const page = manifest.chapters.slice(task.planned_chapters, task.planned_chapters + AI_MEMORY_TASK_PLAN_PAGE)
    for (const chapter of page) {
      task.planned_chapters += 1
      insert.run(task.id, task.book_id, task.planned_chapters, chapter.id, chapter.current_revision_id, chapter.title, chapter.volume_id, chapter.position)
    }
    if (!page.length) throw storageFailure()
    if (task.planned_chapters === task.total_chapters) { task.phase = 'reviewing'; task.state = 'ready' }
  }

  private review(db: Database.Database, task: TaskRow, book: BookState): void {
    const unit = this.currentUnit(db, task)
    if (!unit) { this.complete(task); if (task.state !== 'completed') throw storageFailure(); return }
    if (!unit.runId) {
      if (unit.attempts >= Number.MAX_SAFE_INTEGER) throw storageFailure()
      let candidate: AiRun
      try {
        // 每次显式准备使用当前连接配置和最新知识版本，已有候选仍保留自己的固定快照。
        const connection = this.connection(task.book_id, task.connection_id)
        candidate = this.ai.prepare({ bookId: task.book_id, chapterId: unit.chapterId, expectedBookRevision: book.revision,
          expectedKnowledgeRevision: book.knowledge_revision, expectedRevisionId: unit.chapterRevisionId,
          connectionId: connection.id, connection, kind: task.kind, instruction: task.instruction,
          contextScope: 'chapter', selectedBlockIds: [], memoryChunkIds: [] })
      } catch (error) {
        // prepare 的嵌套事务先撤销候选；可恢复的预算/配置失败再保存为队列检查点。
        if (!(error instanceof DomainError) || !['INVALID_INPUT', 'REVISION_CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(error.detail.code)) throw error
        fail(task, error.detail.message)
        return
      }
      const changed = db.prepare(`UPDATE ai_memory_task_units SET run_id = ?, attempts = attempts + 1
        WHERE task_id = ? AND book_id = ? AND ordinal = ? AND state = 'pending' AND run_id IS NULL AND attempts = ?`)
        .run(candidate.id, task.id, task.book_id, unit.ordinal, unit.attempts)
      if (changed.changes !== 1) throw storageFailure()
      db.prepare(`INSERT INTO ai_memory_task_attempts (task_id, book_id, unit_ordinal, chapter_id, attempt, run_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(task.id, task.book_id, unit.ordinal, unit.chapterId, unit.attempts + 1, candidate.id, new Date().toISOString())
      return
    }
    const candidate = this.runFor(task, unit)
    if (candidate.state === 'adopted' || candidate.state === 'rejected') {
      // 独立消费者只记录作者的逐章决定；跳过章节不经此分支，也不借用本地索引回执。
      db.prepare(`INSERT INTO ai_memory_review_receipts (book_id, consumer, kind, chapter_id, chapter_revision_id,
        chapter_title, task_id, unit_ordinal, run_id, decision, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (book_id, consumer, kind, chapter_id, chapter_revision_id, chapter_title) DO NOTHING`)
        .run(task.book_id, AI_MEMORY_TASK_CONSUMER, task.kind, unit.chapterId, unit.chapterRevisionId, unit.chapterTitle,
          task.id, unit.ordinal, candidate.id, candidate.state, new Date().toISOString())
      this.finishUnit(db, task, unit, 'reviewed')
      this.complete(task)
    } else if (candidate.state === 'failed' || candidate.state === 'cancelled' || candidate.state === 'interrupted') {
      fail(task, '当前章节生成已失败、取消或中断；旧候选和尝试记录已保留，请显式重试或跳过。')
    } else if (candidate.state !== 'running') {
      let currentConnection: AiConnection | null = null
      if (candidate.state === 'prepared') {
        try { currentConnection = this.connection(task.book_id, task.connection_id) } catch (error) {
          if (!(error instanceof DomainError) || error.detail.code !== 'NOT_FOUND') throw error
        }
      }
      if ((candidate.context.bookRevision !== book.revision && this.selectionSource(db, task) === null) || candidate.context.knowledgeRevision !== book.knowledge_revision ||
        (candidate.state === 'prepared' && (!currentConnection || !sameConnection(currentConnection, candidate.context.connection)))) {
        fail(task, '当前候选的作品、知识或连接基线已变化；请保留旧候选，显式重试后重新预览。')
      }
    }
  }

  private finishUnit(db: Database.Database, task: TaskRow, unit: AiMemoryTaskUnit, state: 'reviewed' | 'skipped'): void {
    const changed = db.prepare(`UPDATE ai_memory_task_units SET state = ?
      WHERE task_id = ? AND book_id = ? AND ordinal = ? AND state = 'pending' AND run_id IS ?`)
      .run(state, task.id, task.book_id, unit.ordinal, unit.runId)
    if (changed.changes !== 1) throw storageFailure()
    if (state === 'reviewed') task.reviewed_chapters += 1
    else task.skipped_chapters += 1
  }

  private complete(task: TaskRow): void {
    if (task.reviewed_chapters + task.skipped_chapters === task.total_chapters) { task.state = 'completed'; task.error = null }
  }
}
