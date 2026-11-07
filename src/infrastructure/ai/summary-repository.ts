import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError } from '../../contracts/api'
import { parseAiBookInput, type AiBookInput, type AiConnection, type AiRun } from '../../contracts/ai'
import {
  AI_SUMMARY_NODE_PAGE, AI_SUMMARY_PLAN_PAGE, AI_SUMMARY_PROMPT_VERSION, parseAiSummaryAdoptInput,
  parseAiSummaryControlInput, parseAiSummaryNodeInput, parseAiSummaryProposal, parseAiSummaryReadInput,
  parseAiSummaryStartInput, parseAiSummaryTaskInput, type AiSummaryAdoptInput, type AiSummaryAdoptReceipt,
  type AiSummaryControlInput, type AiSummaryNodeDetail, type AiSummaryNodeInput, type AiSummaryNodeSummary,
  type AiSummaryReadInput, type AiSummaryReceipt, type AiSummaryStartInput, type AiSummaryStatus,
  type AiSummaryTaskDetail, type AiSummaryTaskInput, type AiSummaryTaskSummary, type AiSummarySource,
} from '../../contracts/ai-summary'
import type { StudioRepository } from '../storage/studio-repository'
import type { AiRepository } from './ai-repository'
import { buildAiSummaryContext, validateAiSummaryContext } from './summary-context'
import {
  SUMMARY_ACTIVE_SQL, SUMMARY_ACTIVE_STATES, SUMMARY_NODE_COLUMNS, SUMMARY_NODE_FROM,
  checkSummaryNode, currentSummaryNode, readCurrentSummaryManifest, readStoredSummaryManifest, readSummaryBook,
  readSummaryNode, readSummarySources, readSummaryTask, requireSummary, summaryConflict, summaryHash, summaryId,
  summaryInteger, summaryInvalid, summaryNodePlan, summaryNodeRefs, summaryNodeTitle, summarySchemaVersion,
  summaryScope, summarySourceCurrent, summaryStorageFailure, summaryTotalNodes, writableSummaryBook,
  type SummaryBook, type SummaryManifest, type SummaryNodeRow, type SummaryTaskRow,
} from './summary-sources'

function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) { if (error instanceof DomainError) throw error; throw summaryStorageFailure() }
}
function checkVersion(task: SummaryTaskRow, expected: number): void {
  if (task.version !== expected) summaryConflict('分层摘要已有新进度，请刷新后继续；当前检查点未被覆盖。')
  if (task.version >= Number.MAX_SAFE_INTEGER) throw summaryStorageFailure()
}
function advance(db: Database.Database, task: SummaryTaskRow): void {
  if (!summaryInteger(task.version) || task.version >= Number.MAX_SAFE_INTEGER) throw summaryStorageFailure()
  const changed = db.prepare(`UPDATE ai_summary_tasks SET version = version + 1, state = @state, phase = @phase,
    planned_nodes = @planned, approved_nodes = @approved, error = @error, updated_at = @now
    WHERE id = @id AND book_id = @bookId AND version = @version`).run({ id: task.id, bookId: task.book_id,
    version: task.version, state: task.state, phase: task.phase, planned: task.planned_nodes,
    approved: task.approved_nodes, error: task.error, now: new Date().toISOString() })
  if (changed.changes !== 1) summaryConflict('分层摘要检查点已变化，请刷新后继续。')
}
function supersede(task: SummaryTaskRow): void {
  task.state = 'superseded'
  task.error = '范围内原稿、标题、顺序或已采用的章节摘要已变化，请按当前完整来源创建新任务。'
}
function fail(task: SummaryTaskRow, message: string): void { task.state = 'failed'; task.error = message.slice(0, 500) }
function recoverable(error: unknown): error is DomainError {
  return error instanceof DomainError && ['INVALID_INPUT', 'REVISION_CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(error.detail.code)
}

export class AiSummaryRepository {
  constructor(private readonly studio: StudioRepository, private readonly ai: AiRepository) {}

  status(input: AiBookInput): AiSummaryStatus {
    const data = parseAiBookInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => this.readStatus(db, data.bookId))()
    })
  }

  get(input: AiSummaryReadInput): AiSummaryTaskDetail {
    const data = parseAiSummaryReadInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireSummary(db)
      return db.transaction(() => this.detail(db, readSummaryTask(db, data.bookId, data.taskId), data.afterOrdinal ?? 0))()
    })
  }

  node(input: AiSummaryNodeInput): AiSummaryNodeDetail {
    const data = parseAiSummaryNodeInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireSummary(db)
      return db.transaction(() => this.nodeDetail(db, readSummaryTask(db, data.bookId, data.taskId), data.nodeId))()
    })
  }

  start(input: AiSummaryStartInput): AiSummaryReceipt {
    const data = parseAiSummaryStartInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireSummary(db)
      return db.transaction(() => {
        const book = readSummaryBook(db, data.bookId)
        writableSummaryBook(book)
        if (book.revision !== data.expectedBookRevision || book.knowledge_revision !== data.expectedKnowledgeRevision) {
          summaryConflict('作品或知识已有新版本，请刷新后开始分层摘要。')
        }
        const manifest = readCurrentSummaryManifest(db, book, data.scope)
        if (!manifest) summaryInvalid('所选卷已不存在，请刷新作品目录。')
        if (!manifest.chapters.length) summaryInvalid('所选范围没有章节，请先添加原稿并采用章节摘要。')
        const missing = manifest.chapters.filter((chapter) => chapter.summaryRunId === null)
        if (missing.length) {
          summaryInvalid(`还有 ${missing.length} 章缺少当前稿、当前标题的已采用章节摘要：${missing.slice(0, 3).map((chapter) => chapter.title).join('、')}${missing.length > 3 ? '等' : ''}。请先完成全部章节摘要，汇总不会跳过章节。`)
        }
        const connection = this.connection(data.bookId, data.connectionId)
        const existing = db.prepare(`SELECT id FROM ai_summary_tasks WHERE book_id = ? AND ${SUMMARY_ACTIVE_SQL}`)
          .get(data.bookId) as { id: string } | undefined
        if (existing) {
          const previous = readSummaryTask(db, data.bookId, summaryId(existing.id))
          if (summarySourceCurrent(db, book, previous)) summaryConflict('已有可继续的分层摘要任务，请继续或取消该任务。')
          const current = currentSummaryNode(db, previous)
          if (current?.run_state === 'running') summaryInvalid('旧汇总仍在生成，请先停止模型生成，再创建新的汇总任务。')
          supersede(previous)
          advance(db, previous)
        }
        const id = randomUUID()
        const now = new Date().toISOString()
        const manifestJson = JSON.stringify(manifest)
        db.prepare(`INSERT INTO ai_summary_tasks (id, book_id, state, phase, scope_kind, scope_volume_id, scope_title,
          manifest_hash, manifest_json, fan_in, total_chapters, total_nodes, connection_id, connection_name, model,
          instruction, source_book_revision, source_knowledge_revision, created_at, updated_at)
          VALUES (?, ?, 'planning', 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, data.bookId, data.scope.kind, data.scope.kind === 'volume' ? data.scope.volumeId : null,
            manifest.scopeTitle, summaryHash(manifestJson), manifestJson, data.fanIn, manifest.chapters.length,
            summaryTotalNodes(manifest.chapters.length, data.fanIn), connection.id, connection.name, connection.model,
            data.instruction, book.revision, book.knowledge_revision, now, now)
        return this.receipt(db, data.bookId, id)
      }).immediate()
    })
  }

  step(input: AiSummaryTaskInput): AiSummaryReceipt {
    const data = parseAiSummaryTaskInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireSummary(db)
      return db.transaction(() => {
        const book = readSummaryBook(db, data.bookId)
        const task = readSummaryTask(db, data.bookId, data.taskId)
        checkVersion(task, data.expectedTaskVersion)
        if (task.state !== 'planning' && task.state !== 'ready') summaryInvalid('请先继续或显式重试任务，再处理下一节点。')
        if (!summarySourceCurrent(db, book, task)) supersede(task)
        else {
          writableSummaryBook(book)
          if (task.phase === 'planning') this.plan(db, task)
          else this.prepareCurrent(db, task)
        }
        advance(db, task)
        return this.receipt(db, data.bookId, task.id)
      }).immediate()
    })
  }

  control(input: AiSummaryControlInput): AiSummaryReceipt {
    const data = parseAiSummaryControlInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireSummary(db)
      return db.transaction(() => {
        const book = readSummaryBook(db, data.bookId)
        const task = readSummaryTask(db, data.bookId, data.taskId)
        checkVersion(task, data.expectedTaskVersion)
        if (!SUMMARY_ACTIVE_STATES.includes(task.state)) summaryInvalid('汇总任务已结束，不能再改变进度。')
        const current = currentSummaryNode(db, task)
        const candidate = current?.run_id ? this.runFor(db, task, current) : null
        if ((data.action === 'cancel' || data.action === 'retry') && candidate?.state === 'running') {
          summaryInvalid('当前节点仍在生成，请先停止模型生成，再取消或重试汇总任务。')
        }
        if (!summarySourceCurrent(db, book, task)) supersede(task)
        else if (data.action === 'cancel') { task.state = 'cancelled'; task.error = null }
        else if (data.action === 'pause') {
          if (task.state !== 'planning' && task.state !== 'ready') summaryInvalid('只有可继续处理的汇总任务可以暂停。')
          // 暂停保存队列意图，已发出的模型请求仍由现有生成控制管理。
          task.state = 'paused'
        } else {
          writableSummaryBook(book)
          if (data.action === 'resume' && task.state !== 'paused') summaryInvalid('只有暂停的汇总任务可以继续。')
          if (data.action === 'retry') {
            if (task.state !== 'failed') summaryInvalid('只有失败的汇总任务可以显式重试。')
            if (current && candidate) {
              if (candidate.state === 'adopted') throw summaryStorageFailure()
              if (candidate.state === 'prepared' || candidate.state === 'succeeded') {
                this.ai.reject({ bookId: data.bookId, runId: candidate.id, expectedVersion: candidate.version })
              }
              const changed = db.prepare(`UPDATE ai_summary_nodes SET run_id = NULL
                WHERE id = ? AND task_id = ? AND book_id = ? AND state = 'pending' AND run_id = ?`)
                .run(current.id, task.id, task.book_id, candidate.id)
              if (changed.changes !== 1) throw summaryStorageFailure()
            }
          }
          // 原尝试保持不可变；下一次 step 才会显式准备新的候选，不发送或重放网络请求。
          task.state = task.phase === 'planning' ? 'planning' : 'ready'
          task.error = null
        }
        advance(db, task)
        return this.receipt(db, data.bookId, task.id)
      }).immediate()
    })
  }

  adopt(input: AiSummaryAdoptInput): AiSummaryAdoptReceipt {
    const data = parseAiSummaryAdoptInput(input)
    return perform(() => {
      const db = this.studio.getMemoryDatabase(data.bookId)
      requireSummary(db)
      try {
        return db.transaction(() => {
          const book = readSummaryBook(db, data.bookId)
          writableSummaryBook(book)
          if (book.revision >= Number.MAX_SAFE_INTEGER) throw summaryStorageFailure()
          const task = readSummaryTask(db, data.bookId, data.taskId)
          checkVersion(task, data.expectedTaskVersion)
          if (task.phase !== 'reviewing' || (task.state !== 'ready' && task.state !== 'paused')) summaryInvalid('请先恢复当前汇总任务，再采用节点摘要。')
          const node = currentSummaryNode(db, task)
          if (!node || node.id !== data.nodeId || node.run_id !== data.runId) summaryConflict('当前节点或关联候选已变化，请刷新后重新审阅。')
          const candidate = this.runFor(db, task, node)
          if (candidate.state !== 'succeeded') summaryInvalid('只有成功完成的汇总候选可以采用。')
          if (candidate.version !== data.expectedRunVersion) summaryConflict('汇总候选已有新状态，请刷新后采用。')
          if (candidate.version >= Number.MAX_SAFE_INTEGER) throw summaryStorageFailure()
          validateAiSummaryContext(this.studio, this.ai, candidate.context, 'adopt')
          if (!candidate.context.summary) throw summaryStorageFailure()
          parseAiSummaryProposal(candidate.outputText, candidate.context.summary)
          const now = new Date().toISOString()
          const savedRun = db.prepare(`UPDATE ai_runs SET state = 'adopted', version = version + 1, accepted_text = ?,
            adopted_revision_id = ?, error = NULL, updated_at = ? WHERE id = ? AND book_id = ? AND state = 'succeeded' AND version = ?`)
            .run(data.acceptedText, node.anchor_revision_id, now, candidate.id, data.bookId, candidate.version)
          if (savedRun.changes !== 1) summaryConflict('汇总候选已变化，本次采用没有覆盖新状态。')
          const savedNode = db.prepare(`UPDATE ai_summary_nodes SET state = 'approved', accepted_text = ?, approved_at = ?
            WHERE id = ? AND task_id = ? AND book_id = ? AND state = 'pending' AND run_id = ?`)
            .run(data.acceptedText, now, node.id, task.id, data.bookId, candidate.id)
          if (savedNode.changes !== 1) summaryConflict('汇总节点已变化，本次采用没有覆盖新摘要。')
          const savedBook = db.prepare(`UPDATE book_meta SET revision = revision + 1, updated_at = ?
            WHERE singleton = 1 AND id = ? AND revision = ? AND knowledge_revision = ? AND archived_at IS NULL`)
            .run(now, data.bookId, candidate.context.bookRevision, candidate.context.knowledgeRevision)
          if (savedBook.changes !== 1) summaryConflict('作品或知识已有新版本，本次汇总采用已撤回。')
          // 汇总采用是作品资料变更；知识版本与正文来源保持各自语义，索引由其消费者另行追平。
          db.prepare("INSERT INTO outbox (id, kind, book_revision, created_at) VALUES (?, 'book.metadata', ?, ?)")
            .run(randomUUID(), book.revision + 1, now)
          task.approved_nodes += 1
          task.error = null
          if (task.approved_nodes === task.total_nodes) task.state = 'completed'
          advance(db, task)
          const receipt = this.receipt(db, data.bookId, task.id)
          const adoptedNode = this.nodeDetail(db, readSummaryTask(db, data.bookId, task.id), node.id)
          if (!adoptedNode.run) throw summaryStorageFailure()
          return { ...receipt, adoptedNode, adoptedRun: adoptedNode.run }
        }).immediate()
      } finally { this.studio.refreshKnowledgeCatalog(data.bookId) }
    })
  }

  private connection(bookId: string, connectionId: string): AiConnection {
    const connection = this.ai.listConnections({ bookId }).connections.find((item) => item.id === connectionId)
    if (!connection) throw new DomainError({ code: 'NOT_FOUND', message: '所选模型连接已不存在，请核对后继续。' })
    return connection
  }

  private summary(db: Database.Database, task: SummaryTaskRow, book: SummaryBook, cache?: Map<string, SummaryManifest | null>): AiSummaryTaskSummary {
    return { id: task.id, bookId: task.book_id, version: task.version, state: task.state, phase: task.phase,
      scope: summaryScope(task), scopeTitle: task.scope_title, manifestHash: task.manifest_hash, fanIn: task.fan_in,
      connectionId: task.connection_id, connectionName: task.connection_name, model: task.model, instruction: task.instruction,
      sourceBookRevision: task.source_book_revision, sourceKnowledgeRevision: task.source_knowledge_revision,
      sourceCurrent: summarySourceCurrent(db, book, task, cache), totalChapters: task.total_chapters, totalNodes: task.total_nodes,
      plannedNodes: task.planned_nodes, approvedNodes: task.approved_nodes, error: task.error, createdAt: task.created_at, updatedAt: task.updated_at }
  }

  private nodeSummary(node: SummaryNodeRow): AiSummaryNodeSummary {
    return { id: node.id, taskId: node.task_id, ordinal: node.ordinal, level: node.level, position: node.position, title: node.title,
      firstChapterOrdinal: node.first_chapter_ordinal, lastChapterOrdinal: node.last_chapter_ordinal, chapterCount: node.chapter_count,
      state: node.state, runId: node.run_id, runState: node.run_state, attempts: node.attempts }
  }

  private detail(db: Database.Database, task: SummaryTaskRow, afterOrdinal: number): AiSummaryTaskDetail {
    const rows = db.prepare(`SELECT ${SUMMARY_NODE_COLUMNS} ${SUMMARY_NODE_FROM}
      WHERE n.task_id = ? AND n.book_id = ? AND n.ordinal > ? ORDER BY n.ordinal LIMIT ?`)
      .all(task.id, task.book_id, afterOrdinal, AI_SUMMARY_NODE_PAGE + 1) as SummaryNodeRow[]
    const nodes = rows.slice(0, AI_SUMMARY_NODE_PAGE).map((row) => this.nodeSummary(checkSummaryNode(db, task, row)))
    const current = currentSummaryNode(db, task)
    return { ...this.summary(db, task, readSummaryBook(db, task.book_id)), nodes, currentNode: current ? this.nodeSummary(current) : null,
      nextAfterOrdinal: rows.length > AI_SUMMARY_NODE_PAGE ? nodes[nodes.length - 1]!.ordinal : null }
  }

  private nodeDetail(db: Database.Database, task: SummaryTaskRow, nodeId: string): AiSummaryNodeDetail {
    const node = readSummaryNode(db, task, nodeId)
    const sources = readSummarySources(db, this.ai, task, node)
    return { ...this.nodeSummary(node), acceptedText: node.accepted_text, approvedAt: node.approved_at,
      sources, run: node.run_id ? this.runFor(db, task, node, sources) : null }
  }

  private runFor(db: Database.Database, task: SummaryTaskRow, node: SummaryNodeRow,
    sources: AiSummarySource[] | null = readSummarySources(db, this.ai, task, node)): AiRun {
    if (!node.run_id) throw summaryStorageFailure()
    const candidate = this.ai.get({ bookId: task.book_id, runId: node.run_id })
    const summary = candidate.context.summary
    if (candidate.id !== node.run_id || candidate.bookId !== task.book_id || candidate.kind !== 'summarize' ||
      candidate.chapterId !== node.anchor_chapter_id || candidate.chapterTitle !== node.anchor_chapter_title ||
      candidate.context.chapterRevisionId !== node.anchor_revision_id || candidate.context.chapterTitle !== node.anchor_chapter_title ||
      candidate.context.promptVersion !== AI_SUMMARY_PROMPT_VERSION || candidate.context.connection.id !== task.connection_id ||
      candidate.context.instruction !== task.instruction || !summary || summary.taskId !== task.id || summary.nodeId !== node.id ||
      summary.manifestHash !== task.manifest_hash || summary.scopeTitle !== task.scope_title ||
      JSON.stringify(summary.scope) !== JSON.stringify(summaryScope(task)) || summary.level !== node.level || summary.position !== node.position ||
      summary.fanIn !== task.fan_in || summary.coveredChapters !== node.chapter_count || !sources || JSON.stringify(summary.sources) !== JSON.stringify(sources)) throw summaryStorageFailure()
    return candidate
  }

  private readStatus(db: Database.Database, bookId: string): AiSummaryStatus {
    const version = summarySchemaVersion(db)
    const book = readSummaryBook(db, bookId)
    const manifest = readCurrentSummaryManifest(db, book, { kind: 'book' })
    if (!manifest) throw summaryStorageFailure()
    const base: Omit<AiSummaryStatus, 'activeTask' | 'recentTasks'> = { bookId, bookRevision: book.revision,
      knowledgeRevision: book.knowledge_revision, updatedAt: book.updated_at, schemaVersion: version, requiresUpgrade: version < 9,
      totalChapters: manifest.chapters.length, availableChapterSummaries: manifest.chapters.filter((chapter) => chapter.summaryRunId !== null).length }
    if (version < 9) return { ...base, activeTask: null, recentTasks: [] }
    const cache = new Map<string, SummaryManifest | null>([[JSON.stringify({ kind: 'book' }), manifest]])
    const active = db.prepare(`SELECT id FROM ai_summary_tasks WHERE book_id = ? AND ${SUMMARY_ACTIVE_SQL} LIMIT 2`).all(bookId) as { id: string }[]
    if (active.length > 1) throw summaryStorageFailure()
    const recent = db.prepare('SELECT id FROM ai_summary_tasks WHERE book_id = ? ORDER BY created_at DESC, id DESC LIMIT 10')
      .all(bookId) as { id: string }[]
    return { ...base, activeTask: active.length ? this.summary(db, readSummaryTask(db, bookId, summaryId(active[0]!.id)), book, cache) : null,
      recentTasks: recent.map((row) => this.summary(db, readSummaryTask(db, bookId, summaryId(row.id)), book, cache)) }
  }

  private receipt(db: Database.Database, bookId: string, taskId: string): AiSummaryReceipt {
    const task = readSummaryTask(db, bookId, taskId)
    const detail = this.detail(db, task, 0)
    return { bookId, task: detail, status: this.readStatus(db, bookId),
      node: detail.currentNode ? this.nodeDetail(db, task, detail.currentNode.id) : null }
  }

  private plan(db: Database.Database, task: SummaryTaskRow): void {
    const manifest = readStoredSummaryManifest(task)
    const insert = db.prepare(`INSERT INTO ai_summary_nodes (id, task_id, book_id, ordinal, level, position, title,
      first_chapter_ordinal, last_chapter_ordinal, chapter_count, anchor_chapter_id, anchor_revision_id, anchor_chapter_title, sources_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const last = Math.min(task.total_nodes, task.planned_nodes + AI_SUMMARY_PLAN_PAGE)
    for (let ordinal = task.planned_nodes + 1; ordinal <= last; ordinal += 1) {
      const plan = summaryNodePlan(task, ordinal)
      const anchor = manifest.chapters[plan.first - 1]!
      const refs = summaryNodeRefs(db, task, manifest, plan)
      insert.run(randomUUID(), task.id, task.book_id, ordinal, plan.level, plan.position, summaryNodeTitle(plan),
        plan.first, plan.last, plan.last - plan.first + 1, anchor.id, anchor.revisionId, anchor.title, JSON.stringify(refs))
      task.planned_nodes = ordinal
    }
    if (task.planned_nodes === task.total_nodes) { task.phase = 'reviewing'; task.state = 'ready' }
  }

  private prepareCurrent(db: Database.Database, task: SummaryTaskRow): void {
    const node = currentSummaryNode(db, task)
    if (!node) throw summaryStorageFailure()
    if (node.run_id === null) {
      if (node.attempts >= Number.MAX_SAFE_INTEGER) throw summaryStorageFailure()
      try {
        // 候选、节点关联与尝试审计共用保存点；失败后只提交队列失败检查点。
        db.transaction(() => {
          const connection = this.connection(task.book_id, task.connection_id)
          const packet = buildAiSummaryContext(this.studio, this.ai, task.book_id, task.id, node.id, connection)
          const candidate = this.ai.prepareSummary(packet)
          const changed = db.prepare(`UPDATE ai_summary_nodes SET run_id = ?, attempts = attempts + 1
            WHERE id = ? AND task_id = ? AND book_id = ? AND state = 'pending' AND run_id IS NULL AND attempts = ?`)
            .run(candidate.id, node.id, task.id, task.book_id, node.attempts)
          if (changed.changes !== 1) throw summaryStorageFailure()
          db.prepare(`INSERT INTO ai_summary_attempts (node_id, task_id, book_id, anchor_chapter_id, attempt, run_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(node.id, task.id, task.book_id, node.anchor_chapter_id, node.attempts + 1, candidate.id, new Date().toISOString())
        })()
      } catch (error) {
        if (!recoverable(error)) throw error
        fail(task, error.detail.message)
      }
      return
    }
    const candidate = this.runFor(db, task, node)
    if (['failed', 'cancelled', 'interrupted', 'rejected'].includes(candidate.state)) {
      fail(task, '当前汇总候选已失败、取消、中断或拒绝；旧尝试已保留，请显式重试。')
    } else if (candidate.state === 'prepared' || candidate.state === 'succeeded') {
      try { validateAiSummaryContext(this.studio, this.ai, candidate.context, candidate.state === 'succeeded' ? 'adopt' : 'send') } catch (error) {
        if (!recoverable(error)) throw error
        fail(task, error.detail.message)
      }
    } else if (candidate.state !== 'running') throw summaryStorageFailure()
  }
}
