import type Database from 'better-sqlite3'
import { DomainError, isRecord } from '../../contracts/api'
import { AI_CONTEXT_LIMIT } from '../../contracts/ai'
import { AI_SUMMARY_PROMPT_VERSION, parseAiSummaryContext } from '../../contracts/ai-summary'
import {
  AI_CONTEXT_SUMMARY_PAGE, parseAiContextSummaryInput, parseAiContextSummaryRefs,
  type AiContextSummaryChapter, type AiContextSummaryInput, type AiContextSummaryPage,
  type AiContextSummaryRef, type AiContextSummarySnapshot,
} from '../../contracts/ai-context-summary'
import type { StudioRepository } from '../storage/studio-repository'
import {
  readCurrentSummaryManifest, readStoredSummaryManifest, readSummaryBook, readSummaryNode, readSummaryTask, requireSummary,
  summaryConflict, summaryHash, summaryId, summaryInteger, summaryStorageFailure,
  type SummaryBook, type SummaryChapter, type SummaryManifest, type SummaryNodeRow, type SummaryTaskRow,
} from './summary-sources'

interface TargetChapter { id: string; revisionId: string; position: number }
interface CandidateRow { taskId: string; nodeId: string }

function targetChapter(db: Database.Database, chapterId: string, expectedRevisionId: string): TargetChapter {
  const row = db.prepare('SELECT id, current_revision_id AS revisionId, position FROM chapters WHERE id = ?')
    .get(chapterId) as TargetChapter | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '本书中不存在目标章节。' })
  if (row.id !== chapterId || !summaryInteger(row.position)) throw summaryStorageFailure()
  summaryId(row.revisionId)
  if (row.revisionId !== expectedRevisionId) summaryConflict('目标章节已有新稿，请重新读取后选择摘要。')
  return row
}
function edge(chapter: SummaryChapter): AiContextSummaryChapter {
  return { id: chapter.id, revisionId: chapter.revisionId, title: chapter.title, position: chapter.position }
}
function coverage(task: SummaryTaskRow, node: SummaryNodeRow): SummaryChapter[] {
  const chapters = readStoredSummaryManifest(task).chapters.slice(node.first_chapter_ordinal - 1, node.last_chapter_ordinal)
  if (chapters.length !== node.chapter_count) throw summaryStorageFailure()
  return chapters
}
function coverageCurrent(db: Database.Database, book: SummaryBook, task: SummaryTaskRow, chapters: SummaryChapter[],
  cache: Map<string, SummaryManifest | null>): boolean {
  const stored = readStoredSummaryManifest(task)
  const key = JSON.stringify(stored.scope)
  if (!cache.has(key)) cache.set(key, readCurrentSummaryManifest(db, book, stored.scope))
  const current = cache.get(key)
  if (!current || current.bookTitle !== stored.bookTitle || current.scopeTitle !== stored.scopeTitle) return false
  // 仅比较此节点的完整覆盖范围；后续追加章节不使已采用的前文摘要失效。
  const first = chapters[0]!.position; const last = chapters[chapters.length - 1]!.position
  const present = current.chapters.filter((chapter) => chapter.position >= first && chapter.position <= last)
  return JSON.stringify(present) === JSON.stringify(chapters)
}
function snapshot(db: Database.Database, task: SummaryTaskRow, node: SummaryNodeRow, chapters: SummaryChapter[]): AiContextSummarySnapshot {
  if (node.state !== 'approved' || node.run_id === null || node.accepted_text === null || node.approved_at === null) throw summaryStorageFailure()
  const row = db.prepare('SELECT context_json, context_hash, context_integrity_hash FROM ai_runs WHERE id = ? AND book_id = ?')
    .get(node.run_id, task.book_id) as { context_json: string; context_hash: string; context_integrity_hash: string } | undefined
  if (!row || typeof row.context_json !== 'string' || row.context_json.length > AI_CONTEXT_LIMIT * 24 ||
    !/^[0-9a-f]{64}$/.test(row.context_hash) || summaryHash(row.context_json) !== row.context_integrity_hash) throw summaryStorageFailure()
  try {
    const context: unknown = JSON.parse(row.context_json)
    if (!isRecord(context) || context.bookId !== task.book_id || context.chapterId !== node.anchor_chapter_id ||
      context.chapterRevisionId !== node.anchor_revision_id || context.chapterTitle !== node.anchor_chapter_title ||
      context.kind !== 'summarize' || context.promptVersion !== AI_SUMMARY_PROMPT_VERSION || context.contextHash !== row.context_hash ||
      context.contextSummaries !== undefined || context.instruction !== task.instruction || !isRecord(context.connection) || context.connection.id !== task.connection_id) throw summaryStorageFailure()
    const summary = parseAiSummaryContext(context.summary)
    if (summary.taskId !== task.id || summary.nodeId !== node.id || summary.manifestHash !== task.manifest_hash ||
      summary.scopeTitle !== task.scope_title || JSON.stringify(summary.scope) !== JSON.stringify(readStoredSummaryManifest(task).scope) ||
      summary.level !== node.level || summary.position !== node.position || summary.coveredChapters !== node.chapter_count || summary.fanIn !== task.fan_in) throw summaryStorageFailure()
  } catch { throw summaryStorageFailure() }
  return { taskId: task.id, nodeId: node.id, runId: node.run_id, manifestHash: task.manifest_hash,
    scopeTitle: task.scope_title, title: node.title, level: node.level, coveredChapters: node.chapter_count,
    firstChapter: edge(chapters[0]!), lastChapter: edge(chapters[chapters.length - 1]!),
    coverageHash: summaryHash(JSON.stringify(chapters)), text: node.accepted_text, approvedAt: node.approved_at }
}

/** 只回读已采用节点和章节元数据；整份摘要不截断，多个节点不能重复覆盖同一章。 */
export function readAiContextSummaries(db: Database.Database, bookId: string, chapterId: string,
  expectedRevisionId: string, input: AiContextSummaryRef[]): AiContextSummarySnapshot[] {
  const refs = parseAiContextSummaryRefs(input)
  if (!refs.length) return []
  requireSummary(db)
  const book = readSummaryBook(db, bookId)
  const target = targetChapter(db, chapterId, expectedRevisionId)
  const tasks = new Map<string, SummaryTaskRow>()
  const manifests = new Map<string, SummaryManifest | null>()
  const used = new Set<string>()
  const ranges: { first: number; last: number }[] = []
  return refs.map((ref) => {
    let task = tasks.get(ref.taskId)
    if (!task) { task = readSummaryTask(db, bookId, ref.taskId); tasks.set(task.id, task) }
    if (task.phase !== 'reviewing' || task.manifest_hash !== ref.manifestHash) summaryConflict('所选摘要任务或固定清单身份不符，请重新选择。')
    const node = readSummaryNode(db, task, ref.nodeId)
    if (node.state !== 'approved' || node.run_id !== ref.runId) summaryConflict('所选摘要尚未采用或采用身份已变化，请重新选择。')
    const chapters = coverage(task, node)
    if (!coverageCurrent(db, book, task, chapters, manifests)) summaryConflict('所选摘要覆盖范围内的原稿、标题、顺序或章节摘要已变化，请重新整理并选择。')
    if (chapters.some((chapter) => chapter.id === target.id || chapter.position >= target.position)) {
      summaryConflict('创作摘要只能覆盖目标章节之前的内容，请选择完整位于前文的摘要。')
    }
    const first = chapters[0]!.position; const last = chapters[chapters.length - 1]!.position
    if (ranges.some((range) => first <= range.last && range.first <= last)) {
      throw new DomainError({ code: 'INVALID_INPUT', message: '摘要首末章范围重叠，请选择范围互不重叠的完整节点。' })
    }
    ranges.push({ first, last })
    for (const chapter of chapters) {
      if (used.has(chapter.id)) throw new DomainError({ code: 'INVALID_INPUT', message: '所选摘要覆盖了重复章节，请保留其中一份或选择互不重叠的节点。' })
      used.add(chapter.id)
    }
    return snapshot(db, task, node, chapters)
  })
}

export class AiContextSummaryRepository {
  constructor(private readonly studio: StudioRepository) {}

  list(input: AiContextSummaryInput): AiContextSummaryPage {
    const data = parseAiContextSummaryInput(input)
    try {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireSummary(db)
      return db.transaction(() => {
        const book = readSummaryBook(db, data.bookId)
        if (book.revision !== data.expectedBookRevision || book.knowledge_revision !== data.expectedKnowledgeRevision) {
          summaryConflict('作品或知识库已有新版本，请重新读取状态后选择摘要。')
        }
        const target = targetChapter(db, data.chapterId, data.expectedRevisionId)
        const afterTask = data.after ? readSummaryTask(db, data.bookId, data.after.taskId) : null
        const afterNode = afterTask && data.after ? readSummaryNode(db, afterTask, data.after.nodeId) : null
        // 每页最多检查 20 个节点；来源过期的节点也推进游标，空页不代表全库没有候选。
        const rows = db.prepare(`SELECT n.task_id AS taskId, n.id AS nodeId FROM ai_summary_tasks t
          JOIN ai_summary_nodes n ON n.task_id = t.id AND n.book_id = t.book_id
          WHERE t.book_id = @bookId AND t.phase = 'reviewing' AND n.state = 'approved'
            AND (@afterId IS NULL OR t.created_at < @afterCreated OR (t.created_at = @afterCreated AND
              (t.id < @afterId OR (t.id = @afterId AND (n.level < @afterLevel OR (n.level = @afterLevel AND n.ordinal > @afterOrdinal))))))
          ORDER BY t.created_at DESC, t.id DESC, n.level DESC, n.ordinal LIMIT @limit`)
          .all({ bookId: data.bookId, afterId: afterTask?.id ?? null, afterCreated: afterTask?.created_at ?? null,
            afterLevel: afterNode?.level ?? null, afterOrdinal: afterNode?.ordinal ?? null, limit: AI_CONTEXT_SUMMARY_PAGE + 1 }) as CandidateRow[]
        const tasks = new Map<string, SummaryTaskRow>()
        const manifests = new Map<string, SummaryManifest | null>()
        const scanned = rows.slice(0, AI_CONTEXT_SUMMARY_PAGE)
        const items: AiContextSummarySnapshot[] = []
        for (const row of scanned) {
          let task = tasks.get(row.taskId)
          if (!task) { task = readSummaryTask(db, book.id, summaryId(row.taskId)); tasks.set(task.id, task) }
          const node = readSummaryNode(db, task, summaryId(row.nodeId))
          const chapters = coverage(task, node)
          if (chapters.every((chapter) => chapter.id !== target.id && chapter.position < target.position) && coverageCurrent(db, book, task, chapters, manifests)) {
            items.push(snapshot(db, task, node, chapters))
          }
        }
        return { bookId: book.id, chapterId: target.id, chapterRevisionId: target.revisionId,
          bookRevision: book.revision, knowledgeRevision: book.knowledge_revision, items, scannedNodes: scanned.length,
          nextAfter: rows.length > AI_CONTEXT_SUMMARY_PAGE ? scanned[scanned.length - 1]! : null }
      })()
    } catch (error) { if (error instanceof DomainError) throw error; throw summaryStorageFailure() }
  }
}
