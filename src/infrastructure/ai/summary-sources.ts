import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, isRecord, requiredId, requiredText } from '../../contracts/api'
import { AI_MEMORY_PROMPT_VERSION, type AiRunState } from '../../contracts/ai'
import { parseAiMemoryTaskScope, type AiMemoryTaskScope, type AiMemoryTaskState } from '../../contracts/ai-memory-task'
import { AI_SUMMARY_TEXT_LIMIT, type AiSummarySource } from '../../contracts/ai-summary'
import { BOOK_SCHEMA_VERSION } from '../storage/schema'
import type { AiRepository } from './ai-repository'

export interface SummaryBook {
  id: string; title: string; revision: number; knowledge_revision: number; archived_at: string | null; updated_at: string
}
export interface SummaryChapter {
  id: string; title: string; revisionId: string; position: number; volumeId: string | null
  volumeTitle: string | null; volumePosition: number | null; summaryRunId: string | null
}
export interface SummaryManifest {
  bookId: string; bookTitle: string; scope: AiMemoryTaskScope; scopeTitle: string; chapters: SummaryChapter[]
}
export interface SummaryTaskRow {
  id: string; book_id: string; version: number; state: AiMemoryTaskState; phase: 'planning' | 'reviewing'
  scope_kind: 'book' | 'volume'; scope_volume_id: string | null; scope_title: string; manifest_hash: string; manifest_json: string
  fan_in: 2 | 4 | 8; total_chapters: number; total_nodes: number; planned_nodes: number; approved_nodes: number
  connection_id: string; connection_name: string; model: string; instruction: string
  source_book_revision: number; source_knowledge_revision: number; error: string | null; created_at: string; updated_at: string
}
export interface SummarySourceRef { kind: 'chapter' | 'node'; id: string; ordinal: number }
export interface SummaryNodeRow {
  id: string; task_id: string; book_id: string; ordinal: number; level: number; position: number; title: string
  first_chapter_ordinal: number; last_chapter_ordinal: number; chapter_count: number
  anchor_chapter_id: string; anchor_revision_id: string; anchor_chapter_title: string; sources_json: string
  state: 'pending' | 'approved'; run_id: string | null; attempts: number; accepted_text: string | null; approved_at: string | null
  run_state: AiRunState | null; run_book_id: string | null; run_chapter_id: string | null; run_kind: string | null
  run_accepted_text: string | null; run_adopted_revision_id: string | null
  attempt_count: number; attempt_maximum: number; latest_run_id: string | null
}
export interface SummaryNodePlan {
  ordinal: number; level: number; position: number; first: number; last: number; sources: number[]
}

export const SUMMARY_ACTIVE_SQL = "state IN ('planning', 'ready', 'paused', 'failed')"
export const SUMMARY_ACTIVE_STATES: readonly AiMemoryTaskState[] = ['planning', 'ready', 'paused', 'failed']
const TASK_STATES: readonly AiMemoryTaskState[] = [...SUMMARY_ACTIVE_STATES, 'completed', 'superseded', 'cancelled']
const RUN_STATES: readonly AiRunState[] = ['prepared', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'rejected', 'adopted']
export const SUMMARY_TASK_COLUMNS = `id, book_id, version, state, phase, scope_kind, scope_volume_id, scope_title,
  manifest_hash, manifest_json, fan_in, total_chapters, total_nodes, planned_nodes, approved_nodes, connection_id,
  connection_name, model, instruction, source_book_revision, source_knowledge_revision, error, created_at, updated_at`
export const SUMMARY_NODE_COLUMNS = `n.*, r.state AS run_state, r.book_id AS run_book_id, r.chapter_id AS run_chapter_id,
  r.kind AS run_kind, r.accepted_text AS run_accepted_text, r.adopted_revision_id AS run_adopted_revision_id,
  (SELECT count(*) FROM ai_summary_attempts a WHERE a.node_id = n.id) AS attempt_count,
  (SELECT COALESCE(max(attempt), 0) FROM ai_summary_attempts a WHERE a.node_id = n.id) AS attempt_maximum,
  (SELECT run_id FROM ai_summary_attempts a WHERE a.node_id = n.id ORDER BY attempt DESC LIMIT 1) AS latest_run_id`
export const SUMMARY_NODE_FROM = 'FROM ai_summary_nodes n LEFT JOIN ai_runs r ON r.id = n.run_id'
// 同一次读取中的分页节点共用已核对清单，避免每个节点重新解析整部作品的元数据。
const parsedManifests = new WeakMap<SummaryTaskRow, SummaryManifest>()

export function summaryStorageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '分层摘要来源或采用记录无法核对，请保留作品与已有候选后检查资料。' })
}
export function summaryInvalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
export function summaryConflict(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
export function summaryInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}
export function summaryId(value: unknown): string {
  try { const id = requiredId(value); if (id !== id.toLowerCase()) throw summaryStorageFailure(); return id }
  catch { throw summaryStorageFailure() }
}
export function summaryText(value: unknown, maximum: number): string {
  try { const text = requiredText(value, '摘要资料', maximum); if (text !== value || text.includes('\0')) throw summaryStorageFailure(); return text }
  catch { throw summaryStorageFailure() }
}
export function summaryTimestamp(value: unknown): void {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw summaryStorageFailure()
}
export function summaryHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
export function summarySchemaVersion(db: Database.Database): number {
  const version = db.pragma('user_version', { simple: true })
  if (!summaryInteger(version, BOOK_SCHEMA_VERSION) || version < 2) throw summaryStorageFailure()
  return version
}
export function requireSummary(db: Database.Database): void {
  if (summarySchemaVersion(db) < 9) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级至 v9，再使用分层摘要。' })
}
export function readSummaryBook(db: Database.Database, bookId: string): SummaryBook {
  const row = db.prepare('SELECT id, title, revision, knowledge_revision, archived_at, updated_at FROM book_meta WHERE singleton = 1')
    .get() as SummaryBook | undefined
  if (!row || summaryId(row.id) !== bookId || !summaryInteger(row.revision) || !summaryInteger(row.knowledge_revision)) throw summaryStorageFailure()
  summaryText(row.title, 120)
  summaryTimestamp(row.updated_at)
  if (row.archived_at !== null) summaryTimestamp(row.archived_at)
  return row
}
export function writableSummaryBook(book: SummaryBook): void {
  if (book.archived_at !== null) throw new DomainError({ code: 'FORBIDDEN', message: '作品已归档，请先取消归档再继续分层摘要。' })
}
export function summaryScope(task: SummaryTaskRow): AiMemoryTaskScope {
  if (task.scope_kind === 'book' && task.scope_volume_id === null) return { kind: 'book' }
  if (task.scope_kind !== 'volume') throw summaryStorageFailure()
  return { kind: 'volume', volumeId: task.scope_volume_id === null ? null : summaryId(task.scope_volume_id) }
}

function checkChapters(chapters: SummaryChapter[], scope: AiMemoryTaskScope): void {
  if (chapters.length > 20_000) throw summaryStorageFailure()
  const ids = new Set<string>()
  let position = -1
  for (const chapter of chapters) {
    summaryId(chapter.id)
    summaryId(chapter.revisionId)
    summaryText(chapter.title, 120)
    if (!summaryInteger(chapter.position) || chapter.position <= position || ids.has(chapter.id)) throw summaryStorageFailure()
    position = chapter.position
    ids.add(chapter.id)
    if (chapter.summaryRunId !== null) summaryId(chapter.summaryRunId)
    if (chapter.volumeId === null) {
      if (chapter.volumeTitle !== null || chapter.volumePosition !== null) throw summaryStorageFailure()
    } else {
      summaryId(chapter.volumeId)
      summaryText(chapter.volumeTitle, 120)
      if (!summaryInteger(chapter.volumePosition)) throw summaryStorageFailure()
    }
    if (scope.kind === 'volume' && chapter.volumeId !== scope.volumeId) throw summaryStorageFailure()
  }
}

/** 只取身份、修订、章序和摘要 ID；全书正文及候选上下文不装入内存。 */
export function readCurrentSummaryManifest(db: Database.Database, book: SummaryBook, scope: AiMemoryTaskScope): SummaryManifest | null {
  let scopeTitle = book.title
  if (scope.kind === 'volume') {
    if (scope.volumeId === null) scopeTitle = '未分卷章节'
    else {
      const volume = db.prepare('SELECT title FROM volumes WHERE id = ?').get(scope.volumeId) as { title: string } | undefined
      if (!volume) return null
      scopeTitle = summaryText(volume.title, 120)
    }
  }
  const summaryRun = summarySchemaVersion(db) < 7 ? 'NULL' : `(SELECT r.id FROM ai_runs r
    WHERE r.book_id = @bookId AND r.chapter_id = c.id AND r.chapter_title = c.title AND r.kind = 'summarize' AND r.state = 'adopted'
      AND CASE WHEN json_valid(r.context_json) THEN json_extract(r.context_json, '$.promptVersion') = 2
        AND json_type(r.context_json, '$.summary') IS NULL
        AND json_extract(r.context_json, '$.chapterRevisionId') = c.current_revision_id
        AND json_extract(r.context_json, '$.chapterTitle') = c.title ELSE 0 END
      AND EXISTS (SELECT 1 FROM ai_memory_adoptions a WHERE a.run_id = r.id AND a.book_id = @bookId)
    ORDER BY r.sequence DESC LIMIT 1)`
  const chapters = db.prepare(`SELECT c.id, c.title, c.current_revision_id AS revisionId, c.position, c.volume_id AS volumeId,
    v.title AS volumeTitle, v.position AS volumePosition, ${summaryRun} AS summaryRunId
    FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id
    WHERE (SELECT id FROM book_meta WHERE singleton = 1) = @bookId
      AND (@scope = 'book' OR c.volume_id IS @volumeId) ORDER BY c.position, c.id LIMIT 20001`)
    .all({ bookId: book.id, scope: scope.kind, volumeId: scope.kind === 'volume' ? scope.volumeId : null }) as SummaryChapter[]
  checkChapters(chapters, scope)
  return { bookId: book.id, bookTitle: book.title, scope, scopeTitle, chapters }
}

export function readStoredSummaryManifest(task: SummaryTaskRow): SummaryManifest {
  const cached = parsedManifests.get(task)
  if (cached) return cached
  try {
    if (typeof task.manifest_json !== 'string' || task.manifest_json.length > 24_000_000 || summaryHash(task.manifest_json) !== task.manifest_hash) throw summaryStorageFailure()
    const value: unknown = JSON.parse(task.manifest_json)
    if (!isRecord(value) || value.bookId !== task.book_id || !Array.isArray(value.chapters) || value.chapters.length !== task.total_chapters) throw summaryStorageFailure()
    const scope = parseAiMemoryTaskScope(value.scope)
    if (JSON.stringify(scope) !== JSON.stringify(summaryScope(task)) || value.scopeTitle !== task.scope_title) throw summaryStorageFailure()
    const chapters = value.chapters.map((value): SummaryChapter => {
      if (!isRecord(value)) throw summaryStorageFailure()
      const chapter: SummaryChapter = { id: summaryId(value.id), title: summaryText(value.title, 120), revisionId: summaryId(value.revisionId),
        position: value.position as number, volumeId: value.volumeId === null ? null : summaryId(value.volumeId),
        volumeTitle: value.volumeTitle === null ? null : summaryText(value.volumeTitle, 120), volumePosition: value.volumePosition as number | null,
        summaryRunId: summaryId(value.summaryRunId) }
      if (JSON.stringify(chapter) !== JSON.stringify(value)) throw summaryStorageFailure()
      return chapter
    })
    checkChapters(chapters, scope)
    const manifest: SummaryManifest = { bookId: task.book_id, bookTitle: summaryText(value.bookTitle, 120), scope,
      scopeTitle: summaryText(value.scopeTitle, 120), chapters }
    if (JSON.stringify(manifest) !== task.manifest_json) throw summaryStorageFailure()
    parsedManifests.set(task, manifest)
    return manifest
  } catch { throw summaryStorageFailure() }
}

export function summarySourceCurrent(db: Database.Database, book: SummaryBook, task: SummaryTaskRow, cache?: Map<string, SummaryManifest | null>): boolean {
  const scope = summaryScope(task)
  const key = JSON.stringify(scope)
  const manifest = cache?.has(key) ? cache.get(key)! : readCurrentSummaryManifest(db, book, scope)
  cache?.set(key, manifest)
  return manifest !== null && summaryHash(JSON.stringify(manifest)) === task.manifest_hash
}

export function summaryTotalNodes(chapters: number, fanIn: 2 | 4 | 8): number {
  if (!summaryInteger(chapters, 20_000) || chapters < 1) throw summaryStorageFailure()
  let inputs = chapters
  let total = 0
  do { inputs = Math.ceil(inputs / fanIn); total += inputs } while (inputs > 1)
  if (!summaryInteger(total, 40_000) || total < 1) throw summaryStorageFailure()
  return total
}

/** 各层顺序连续且覆盖无空洞，单章也生成一个根节点。 */
export function summaryNodePlan(task: Pick<SummaryTaskRow, 'total_chapters' | 'fan_in' | 'total_nodes'>, ordinal: number): SummaryNodePlan {
  if (!summaryInteger(ordinal, task.total_nodes) || ordinal < 1) throw summaryStorageFailure()
  let inputs = task.total_chapters
  let base = 0
  let previousBase = 0
  let coverage = 1
  let level = 0
  while (level <= 30) {
    const nodes = Math.ceil(inputs / task.fan_in)
    if (ordinal <= base + nodes) {
      const position = ordinal - base - 1
      const first = position * coverage * task.fan_in + 1
      const last = Math.min(task.total_chapters, first + coverage * task.fan_in - 1)
      const length = Math.min(task.fan_in, inputs - position * task.fan_in)
      const start = level === 0 ? first : previousBase + position * task.fan_in + 1
      return { ordinal, level, position, first, last, sources: Array.from({ length }, (_, index) => start + index) }
    }
    previousBase = base
    base += nodes
    inputs = nodes
    coverage *= task.fan_in
    level += 1
  }
  throw summaryStorageFailure()
}

export function summaryNodeTitle(plan: SummaryNodePlan): string {
  return `第 ${plan.level + 1} 层 · 第 ${plan.position + 1} 组（第 ${plan.first}–${plan.last} 章）`
}

export function readSummaryTask(db: Database.Database, bookId: string, taskId: string): SummaryTaskRow {
  const task = db.prepare(`SELECT ${SUMMARY_TASK_COLUMNS} FROM ai_summary_tasks WHERE id = ? AND book_id = ?`)
    .get(taskId, bookId) as SummaryTaskRow | undefined
  if (!task) throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个分层摘要任务。' })
  summaryId(task.id)
  if (summaryId(task.book_id) !== bookId || !TASK_STATES.includes(task.state) || (task.phase !== 'planning' && task.phase !== 'reviewing') ||
    ![2, 4, 8].includes(task.fan_in) || !summaryInteger(task.total_chapters, 20_000) || task.total_chapters < 1 ||
    task.total_nodes !== summaryTotalNodes(task.total_chapters, task.fan_in) || !summaryInteger(task.planned_nodes, task.total_nodes) ||
    !summaryInteger(task.approved_nodes, task.planned_nodes) || !summaryInteger(task.version) || !summaryInteger(task.source_book_revision) ||
    !summaryInteger(task.source_knowledge_revision) || typeof task.manifest_hash !== 'string' || !/^[0-9a-f]{64}$/.test(task.manifest_hash) ||
    (task.error !== null && (typeof task.error !== 'string' || task.error.length > 500)) ||
    (task.phase === 'reviewing' && task.planned_nodes !== task.total_nodes) || (task.phase === 'planning' && task.approved_nodes !== 0) ||
    (task.state === 'planning' && task.phase !== 'planning') || (task.state === 'ready' && task.phase !== 'reviewing') ||
    (task.state === 'completed' && task.approved_nodes !== task.total_nodes)) throw summaryStorageFailure()
  summaryScope(task)
  summaryId(task.connection_id)
  summaryText(task.scope_title, 120)
  summaryText(task.connection_name, 80)
  summaryText(task.model, 200)
  summaryText(task.instruction, 6000)
  summaryTimestamp(task.created_at)
  summaryTimestamp(task.updated_at)
  readStoredSummaryManifest(task)
  const counts = db.prepare(`SELECT count(*) AS total, COALESCE(max(ordinal), 0) AS maximum,
    COALESCE(sum(CASE WHEN state = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
    COALESCE(max(CASE WHEN state = 'approved' THEN ordinal ELSE 0 END), 0) AS last_approved
    FROM ai_summary_nodes WHERE task_id = ? AND book_id = ?`).get(task.id, bookId) as
      { total: number; maximum: number; approved: number; last_approved: number } | undefined
  if (!counts || counts.total !== task.planned_nodes || counts.maximum !== counts.total ||
    counts.approved !== task.approved_nodes || counts.last_approved !== task.approved_nodes) throw summaryStorageFailure()
  return task
}

export function summaryNodeRefs(db: Database.Database, task: SummaryTaskRow, manifest: SummaryManifest, plan: SummaryNodePlan): SummarySourceRef[] {
  return plan.sources.map((ordinal): SummarySourceRef => {
    if (plan.level === 0) {
      const chapter = manifest.chapters[ordinal - 1]
      if (!chapter?.summaryRunId) throw summaryStorageFailure()
      return { kind: 'chapter', id: chapter.summaryRunId, ordinal }
    }
    const child = db.prepare('SELECT id FROM ai_summary_nodes WHERE task_id = ? AND book_id = ? AND ordinal = ?')
      .get(task.id, task.book_id, ordinal) as { id: string } | undefined
    if (!child) throw summaryStorageFailure()
    return { kind: 'node', id: summaryId(child.id), ordinal }
  })
}

export function checkSummaryNode(db: Database.Database, task: SummaryTaskRow, row: SummaryNodeRow): SummaryNodeRow {
  const plan = summaryNodePlan(task, row.ordinal)
  const manifest = readStoredSummaryManifest(task)
  const anchor = manifest.chapters[plan.first - 1]!
  if (summaryId(row.task_id) !== task.id || summaryId(row.book_id) !== task.book_id || row.level !== plan.level || row.position !== plan.position ||
    row.ordinal > task.planned_nodes || row.first_chapter_ordinal !== plan.first || row.last_chapter_ordinal !== plan.last ||
    row.chapter_count !== plan.last - plan.first + 1 || row.title !== summaryNodeTitle(plan) ||
    row.anchor_chapter_id !== anchor.id || row.anchor_revision_id !== anchor.revisionId || row.anchor_chapter_title !== anchor.title ||
    row.sources_json !== JSON.stringify(summaryNodeRefs(db, task, manifest, plan)) ||
    (row.state !== 'pending' && row.state !== 'approved') || !summaryInteger(row.attempts) ||
    row.attempt_count !== row.attempts || row.attempt_maximum !== row.attempts ||
    (row.attempts === 0) !== (row.latest_run_id === null)) throw summaryStorageFailure()
  summaryId(row.id)
  if (row.latest_run_id !== null) summaryId(row.latest_run_id)
  if (row.run_id === null) {
    if (row.run_state !== null || row.run_book_id !== null || row.run_chapter_id !== null || row.run_kind !== null ||
      row.run_accepted_text !== null || row.run_adopted_revision_id !== null) throw summaryStorageFailure()
  } else if (summaryId(row.run_id) !== row.latest_run_id || row.run_book_id !== task.book_id ||
    row.run_chapter_id !== anchor.id || row.run_kind !== 'summarize' || row.run_state === null || !RUN_STATES.includes(row.run_state)) throw summaryStorageFailure()
  if (row.state === 'approved') {
    summaryText(row.accepted_text, AI_SUMMARY_TEXT_LIMIT)
    summaryTimestamp(row.approved_at)
    if (row.run_id === null || row.run_state !== 'adopted' || row.run_accepted_text !== row.accepted_text ||
      row.run_adopted_revision_id !== anchor.revisionId || row.ordinal > task.approved_nodes) throw summaryStorageFailure()
  } else if (row.accepted_text !== null || row.approved_at !== null || row.run_state === 'adopted' || row.ordinal <= task.approved_nodes) throw summaryStorageFailure()
  return row
}

export function readSummaryNode(db: Database.Database, task: SummaryTaskRow, nodeId: string): SummaryNodeRow {
  const row = db.prepare(`SELECT ${SUMMARY_NODE_COLUMNS} ${SUMMARY_NODE_FROM} WHERE n.id = ? AND n.task_id = ? AND n.book_id = ?`)
    .get(nodeId, task.id, task.book_id) as SummaryNodeRow | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '当前汇总任务中不存在这个节点。' })
  return checkSummaryNode(db, task, row)
}

export function currentSummaryNode(db: Database.Database, task: SummaryTaskRow): SummaryNodeRow | null {
  if (task.phase === 'planning') return null
  const row = db.prepare(`SELECT ${SUMMARY_NODE_COLUMNS} ${SUMMARY_NODE_FROM}
    WHERE n.task_id = ? AND n.book_id = ? AND n.state = 'pending' ORDER BY n.ordinal LIMIT 1`)
    .get(task.id, task.book_id) as SummaryNodeRow | undefined
  return row ? checkSummaryNode(db, task, row) : null
}

export function readSummarySources(db: Database.Database, ai: AiRepository, task: SummaryTaskRow, node: SummaryNodeRow): AiSummarySource[] | null {
  const manifest = readStoredSummaryManifest(task)
  const refs = summaryNodeRefs(db, task, manifest, summaryNodePlan(task, node.ordinal))
  if (node.level > 0) {
    const children = refs.map((ref) => readSummaryNode(db, task, ref.id))
    if (children.some((child) => child.state !== 'approved')) return null
    return children.map((child): AiSummarySource => ({ id: child.id, kind: 'node', title: child.title,
      text: summaryText(child.accepted_text, AI_SUMMARY_TEXT_LIMIT), chapterCount: child.chapter_count,
      chapterId: child.anchor_chapter_id, chapterRevisionId: child.anchor_revision_id, chapterTitle: child.anchor_chapter_title, citations: [] }))
  }
  return refs.map((ref): AiSummarySource => {
    const chapter = manifest.chapters[ref.ordinal - 1]!
    const candidate = ai.get({ bookId: task.book_id, runId: ref.id })
    const entries = candidate.memoryAdoptions
    const entry = entries?.[0]
    if (candidate.id !== ref.id || candidate.bookId !== task.book_id || candidate.kind !== 'summarize' || candidate.state !== 'adopted' ||
      candidate.context.promptVersion !== AI_MEMORY_PROMPT_VERSION || candidate.context.summary !== undefined || candidate.chapterId !== chapter.id ||
      candidate.chapterTitle !== chapter.title || candidate.context.chapterRevisionId !== chapter.revisionId ||
      candidate.context.chapterTitle !== chapter.title || candidate.adoptedRevisionId !== chapter.revisionId ||
      entries?.length !== 1 || !entry || entry.sourceIndex !== 0 || entry.fields.kind !== 'other' || entry.fields.nature !== 'ai_derived' ||
      entry.citations.length < 1 || entry.citations.length > 8) throw summaryStorageFailure()
    return { id: ref.id, kind: 'chapter', title: chapter.title, text: summaryText(entry.fields.summary, AI_SUMMARY_TEXT_LIMIT), chapterCount: 1,
      chapterId: chapter.id, chapterRevisionId: chapter.revisionId, chapterTitle: chapter.title,
      citations: entry.citations.map((citation) => ({ blockId: citation.blockId, quote: citation.quote })) }
  })
}
