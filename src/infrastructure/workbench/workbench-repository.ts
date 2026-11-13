import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredInteger, requiredText, type BookInput, type BookMutationInput } from '../../contracts/api'
import { parseManuscript } from '../../contracts/manuscript'
import {
  MAX_REVIEW_ISSUES, MAX_SCENES, MAX_WORKBENCH_FIELDS_BYTES, MAX_WORKBENCH_SNAPSHOT_BYTES,
  MAX_WORKBENCH_DOCUMENT_BYTES, MAX_WORKBENCH_ANCHOR_BYTES, WORKBENCH_SCHEMA_VERSION, parseLogWritingSessionInput, parseApplyReviewIssueInput,
  parseReviewIssueFields, reviewReplacement, parseSaveBriefInput, parseSaveReviewIssueInput, parseSaveSceneInput,
  parseSaveWritingGoalInput, parseSceneFields, parseWorkbenchBookInput, parseWritingBrief, parseWritingGoalFields, parseReorderScenesInput,
  type LogWritingSessionInput, type ManuscriptAnchor, type ReviewIssue, type SaveBriefInput, type SaveReviewIssueInput,
  type SaveSceneInput, type ReorderScenesInput, type SaveWritingGoalInput, type SceneCard, type WorkbenchSnapshot, type WritingDay, type WritingGoal, type ApplyReviewIssueInput, type ApplyReviewIssueReceipt,
} from '../../contracts/workbench'
import type { StudioRepository } from '../storage/studio-repository'
import { localWritingDate } from './writing-activity'
import { textToDocument } from '../text/manuscript-text'
import { readStoredAiRun } from '../ai/ai-repository'
import { reviewSourceMatches } from '../../contracts/review'
import { currentOutlineNodes } from './living-state'

interface State { id: string; revision: number; archived_at: string | null }
interface EntityRow { id: string; revision: number; fields_json: string; updated_at: string }
type EntityTable = 'scene_cards' | 'review_issues' | 'writing_goals'
interface AnchorCache { revisions: Map<string, { bytes: number; blocks: Set<string> }>; bytes: number }
const EMPTY_BRIEF = { premise: '', style: '', narrator: '', tense: '', rules: '' }

function fail(message: string, code: 'STORAGE_ERROR' | 'INVALID_INPUT' | 'REVISION_CONFLICT' | 'FORBIDDEN' = 'STORAGE_ERROR'): never {
  throw new DomainError({ code, message })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    return fail('创作资料读写失败，请保留当前编辑并检查作品文件。')
  }
}
function state(db: Database.Database, bookId: string): State {
  const row = db.prepare('SELECT id, revision, archived_at FROM book_meta WHERE singleton = 1').get() as State | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0) return fail('作品状态无效。')
  return row
}
function writable(db: Database.Database, input: BookMutationInput): State {
  if (Number(db.pragma('user_version', { simple: true })) < WORKBENCH_SCHEMA_VERSION) return fail('请先备份并升级作品，再编辑创作工具。', 'FORBIDDEN')
  const current = state(db, input.bookId)
  if (current.archived_at) return fail('作品已归档，请先取消归档。', 'FORBIDDEN')
  if (current.revision !== input.expectedBookRevision) return fail('作品已有新版本，请保留输入，重新读取后比较再保存。', 'REVISION_CONFLICT')
  if (current.revision >= Number.MAX_SAFE_INTEGER) return fail('作品版本超出支持范围。')
  return current
}
function advance(db: Database.Database, current: State, now: string): void {
  const result = db.prepare('UPDATE book_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1 AND id = ? AND revision = ? AND archived_at IS NULL')
    .run(now, current.id, current.revision)
  if (result.changes !== 1) return fail('作品版本发生变化。', 'REVISION_CONFLICT')
}
function fieldsJson(value: unknown, code: 'INVALID_INPUT' | 'STORAGE_ERROR' = 'INVALID_INPUT'): string {
  const json = JSON.stringify(value)
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_WORKBENCH_FIELDS_BYTES) return fail('创作条目序列化后超过 256 KiB，请缩短内容或减少关联段落。', code)
  return json
}
function storedFields(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_WORKBENCH_FIELDS_BYTES) return fail('创作条目超过 256 KiB 或格式无效。')
  return JSON.parse(value)
}
function checkReviewSource(db: Database.Database, bookId: string, fields: ReturnType<typeof parseReviewIssueFields>, initial = false): void {
  const source = fields.candidateSource
  if (!source) return
  if (!fields.aiRunId) return fail('结构化审稿问题缺少候选来源。')
  const run = readStoredAiRun(db, bookId, fields.aiRunId)
  // 拒绝任务会增加候选版本，原始建议仍可追溯；后续状态不能抹去首次登记来源。
  const sourceRun = run.state === 'rejected' && run.version === source.runVersion + 1 ? { ...run, state: 'succeeded' as const, version: source.runVersion } : run
  if (!reviewSourceMatches(source, sourceRun)) return fail('审稿问题与固定候选内容不一致。')
  if (initial && (fields.anchor.chapterId !== run.chapterId || fields.anchor.revisionId !== run.context.chapterRevisionId ||
    JSON.stringify(fields.anchor.blockIds) !== JSON.stringify(source.item.blockIds) || fields.evidence !== source.item.quote)) return fail('审稿首次记录的原稿、引文或段落不匹配。')
}
function checkReviewApplication(db: Database.Database, issueId: string, revision: number, fields: ReturnType<typeof parseReviewIssueFields>, verified?: Set<string>): boolean | undefined {
  const application = fields.application
  if (!application) return undefined
  if (application.issueRevision > revision) return fail('审稿应用凭据超出问题历史。')
  const history = (at: number) => {
    const row = db.prepare(`SELECT CASE WHEN length(CAST(fields_json AS BLOB)) <= ? THEN fields_json END AS fields_json
      FROM workbench_revisions WHERE kind = 'review' AND entity_id = ? AND revision = ?`).get(MAX_WORKBENCH_FIELDS_BYTES, issueId, at) as { fields_json: string } | undefined
    return parseReviewIssueFields(storedFields(row?.fields_json))
  }
  const applied = history(application.issueRevision), before = history(application.issueRevision - 1)
  if (before.status !== 'open' || !reviewReplacement(before).trim() || !before.anchor.blockIds.length || before.candidateSource?.item.requirement ||
    before.anchor.chapterId !== application.chapterId || before.anchor.revisionId !== application.sourceRevisionId ||
    JSON.stringify(applied) !== JSON.stringify({ ...before, status: 'recheck', application }) ||
    (revision === application.issueRevision && JSON.stringify(fields) !== JSON.stringify(applied))) return fail('审稿应用凭据与不可变问题历史不一致。')
  const target = db.prepare(`SELECT r.parent_revision_id, r.reason, c.current_revision_id FROM chapter_revisions r
    JOIN chapters c ON c.id = r.chapter_id WHERE r.chapter_id = ? AND r.id = ?`).get(application.chapterId, application.revisionId) as
    { parent_revision_id: string | null; reason: string; current_revision_id: string } | undefined
  if (!target || target.reason !== 'saved' || target.parent_revision_id !== application.sourceRevisionId) return fail('审稿应用凭据与正文修订不一致。')
  const key = `${issueId}:${application.issueRevision}`
  // 恢复时逐份核对真正写入的文档；有界缓存避免后续手工状态重复核对同一次应用。
  if (verified && !verified.has(key)) {
    const readDocument = (revisionId: string) => {
      const row = db.prepare(`SELECT CASE WHEN length(CAST(document_json AS BLOB)) <= ? THEN document_json END AS document_json,
        CASE WHEN length(CAST(content_hash AS BLOB)) = 64 THEN content_hash END AS content_hash
        FROM chapter_revisions WHERE chapter_id = ? AND id = ?`).get(MAX_WORKBENCH_DOCUMENT_BYTES, application.chapterId, revisionId) as
        { document_json: string; content_hash: string } | undefined
      if (!row || typeof row.document_json !== 'string' || createHash('sha256').update(row.document_json, 'utf8').digest('hex') !== row.content_hash) return fail('审稿应用正文校验失败。')
      return parseManuscript(JSON.parse(row.document_json))
    }
    const original = readDocument(application.sourceRevisionId), document = readDocument(application.revisionId)
    const selected = new Set(before.anchor.blockIds)
    const indexes = original.content.flatMap((block, index) => selected.has(block.attrs.id) ? [index] : [])
    if (indexes.length !== selected.size || indexes.some((index, offset) => index !== indexes[0]! + offset)) return fail('审稿应用历史的原段落不连续。')
    const replacement = textToDocument(reviewReplacement(before)).content.map((block, offset) => ({
      ...block, attrs: { ...block.attrs, id: document.content[indexes[0]! + offset]?.attrs.id },
    }))
    const expected = { type: 'doc', content: [...original.content.slice(0, indexes[0]), ...replacement, ...original.content.slice(indexes[indexes.length - 1]! + 1)] }
    if (JSON.stringify(document) !== JSON.stringify(expected)) return fail('审稿应用正文与当时确认的替换稿不一致。')
    if (verified.size >= MAX_REVIEW_ISSUES) verified.delete(verified.values().next().value!)
    verified.add(key)
  }
  return target.current_revision_id === application.revisionId
}
function anchorCache(): AnchorCache { return { revisions: new Map(), bytes: 0 } }
function prepareAnchors(db: Database.Database, anchors: ManuscriptAnchor[], cache: AnchorCache): (anchor: ManuscriptAnchor) => boolean {
  const sources = new Map<string, { bytes: number; current_revision_id: string }>()
  let total = 0
  // 先只读字节数，全部固定修订的合计预算通过后才取正文；同一修订只计一次。
  for (const anchor of anchors) {
    const key = `${anchor.chapterId}:${anchor.revisionId}`
    if (sources.has(key)) continue
    const source = db.prepare(`SELECT length(CAST(r.document_json AS BLOB)) AS bytes,
      CASE WHEN length(CAST(c.current_revision_id AS BLOB)) = 36 THEN c.current_revision_id END AS current_revision_id FROM chapter_revisions r
      JOIN chapters c ON c.id = r.chapter_id WHERE r.chapter_id = ? AND r.id = ?`).get(anchor.chapterId, anchor.revisionId) as
      { bytes: number; current_revision_id: string } | undefined
    if (!source) return fail('正文证据对应的章节版本不存在。', 'INVALID_INPUT')
    requiredId(source.current_revision_id)
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > MAX_WORKBENCH_DOCUMENT_BYTES) return fail('正文证据的单份修订超过 32 MiB 或格式无效。')
    total += source.bytes
    if (total > MAX_WORKBENCH_ANCHOR_BYTES) return fail('工作台关联的不同正文修订合计超过 64 MiB，请减少正文关联。')
    sources.set(key, source)
  }
  return (anchor) => {
    const key = `${anchor.chapterId}:${anchor.revisionId}`
    const source = sources.get(key)
    if (!source) return fail('正文证据未经容量核对。')
    let cached = cache.revisions.get(key)
    if (!cached) {
      const row = db.prepare(`SELECT CASE WHEN length(CAST(document_json AS BLOB)) <= ? THEN document_json END AS document_json,
        CASE WHEN length(CAST(content_hash AS BLOB)) = 64 THEN content_hash END AS content_hash
        FROM chapter_revisions WHERE chapter_id = ? AND id = ?`).get(MAX_WORKBENCH_DOCUMENT_BYTES, anchor.chapterId, anchor.revisionId) as
        { document_json: string | null; content_hash: string | null } | undefined
      if (!row || typeof row.document_json !== 'string' || Buffer.byteLength(row.document_json, 'utf8') !== source.bytes ||
        createHash('sha256').update(row.document_json, 'utf8').digest('hex') !== row.content_hash) return fail('正文证据校验失败。')
      const document = parseManuscript(JSON.parse(row.document_json))
      cached = { bytes: source.bytes, blocks: new Set(document.content.map((block) => block.attrs.id)) }
      // 历史恢复校验会流式读取更多修订；缓存也受相同预算约束，不随历史永久增长。
      while (cache.bytes + cached.bytes > MAX_WORKBENCH_ANCHOR_BYTES) {
        const oldest = cache.revisions.entries().next().value
        if (!oldest) return fail('正文证据缓存状态无效。')
        cache.bytes -= oldest[1].bytes
        cache.revisions.delete(oldest[0])
      }
      cache.revisions.set(key, cached)
      cache.bytes += cached.bytes
    }
    const blocks = cached.blocks
    if (anchor.blockIds.some((id) => !blocks.has(id))) return fail('所选段落不属于该固定版本。', 'INVALID_INPUT')
    return source.current_revision_id !== anchor.revisionId
  }
}
function checkSnapshotBudget(db: Database.Database): void {
  let total = 0
  for (const [table, maximum] of [['scene_cards', MAX_SCENES], ['review_issues', MAX_REVIEW_ISSUES], ['writing_goals', 100]] as const) {
    const size = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(fields_json AS BLOB)) + length(CAST(id AS BLOB)) + length(CAST(updated_at AS BLOB))), 0) AS bytes,
      COALESCE(MAX(length(CAST(fields_json AS BLOB))), 0) AS largest FROM ${table}`).get() as { count: number; bytes: number; largest: number }
    if (size.count > maximum || size.largest > MAX_WORKBENCH_FIELDS_BYTES) return fail('创作条目数量或单条字节数超出支持范围。')
    total += size.bytes
  }
  const originals = db.prepare(`SELECT COALESCE(SUM(length(CAST(h.fields_json AS BLOB))), 0) AS bytes,
    COALESCE(MAX(length(CAST(h.fields_json AS BLOB))), 0) AS largest,
    COALESCE(SUM(CASE WHEN h.id IS NULL THEN 1 ELSE 0 END), 0) AS missing
    FROM review_issues i LEFT JOIN workbench_revisions h ON h.kind = 'review' AND h.entity_id = i.id AND h.revision = 1`).get() as
    { bytes: number; largest: number; missing: number }
  if (originals.missing || originals.largest > MAX_WORKBENCH_FIELDS_BYTES) return fail('审稿原始历史缺失或超过 256 KiB，不能以当前依据替代。')
  const brief = db.prepare(`SELECT length(CAST(premise AS BLOB)) + length(CAST(style AS BLOB)) + length(CAST(narrator AS BLOB)) +
    length(CAST(tense AS BLOB)) + length(CAST(rules AS BLOB)) AS bytes FROM workbench_settings WHERE singleton = 1`).get() as { bytes: number } | undefined
  if (!brief || brief.bytes > MAX_WORKBENCH_FIELDS_BYTES) return fail('创作约定缺失或超过字节预算。')
  total += originals.bytes + brief.bytes
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_WORKBENCH_SNAPSHOT_BYTES) return fail('完整工作台资料超过 16 MiB，请缩短条目内容；未截断任何资料。')
}
function entityRows(db: Database.Database, table: EntityTable, maximum: number): EntityRow[] {
  const rows = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) = 36 THEN id END AS id, revision,
    CASE WHEN length(CAST(fields_json AS BLOB)) <= ? THEN fields_json END AS fields_json,
    CASE WHEN length(CAST(updated_at AS BLOB)) <= 32 THEN updated_at END AS updated_at
    FROM ${table} ORDER BY updated_at DESC, id LIMIT ?`).all(MAX_WORKBENCH_FIELDS_BYTES, maximum + 1) as EntityRow[]
  if (rows.length > maximum) return fail('创作条目数量超出本版本支持范围。')
  for (const row of rows) {
    requiredId(row.id)
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.updated_at !== 'string' ||
      typeof row.fields_json !== 'string' || Buffer.byteLength(row.fields_json, 'utf8') > MAX_WORKBENCH_FIELDS_BYTES) return fail('创作条目格式无效。')
  }
  return rows
}

function readSnapshot(db: Database.Database, bookId: string, cache = anchorCache()): WorkbenchSnapshot {
  const current = state(db, bookId)
  const schemaVersion = Number(db.pragma('user_version', { simple: true }))
  const result: WorkbenchSnapshot = { bookId, bookRevision: current.revision, archived: current.archived_at !== null,
    schemaVersion, requiresUpgrade: schemaVersion < WORKBENCH_SCHEMA_VERSION, brief: EMPTY_BRIEF, scenes: [], sceneLabels: {}, issues: [], goals: [], activity: [] }
  if (result.requiresUpgrade) return result
  checkSnapshotBudget(db)
  result.brief = parseWritingBrief(db.prepare('SELECT premise, style, narrator, tense, rules FROM workbench_settings WHERE singleton = 1').get())
  fieldsJson(result.brief, 'STORAGE_ERROR')
  const scenes = entityRows(db, 'scene_cards', MAX_SCENES).map((row) => ({ row, fields: parseSceneFields(storedFields(row.fields_json)) }))
  const issues = entityRows(db, 'review_issues', MAX_REVIEW_ISSUES).map((row) => ({ row, fields: parseReviewIssueFields(storedFields(row.fields_json)) }))
  const originals = new Map<string, ReturnType<typeof parseReviewIssueFields>>()
  const rows = db.prepare(`SELECT i.id, CASE WHEN length(CAST(h.fields_json AS BLOB)) <= ? THEN h.fields_json END AS fields_json
    FROM review_issues i JOIN workbench_revisions h ON h.kind = 'review' AND h.entity_id = i.id AND h.revision = 1
    ORDER BY i.id LIMIT ?`).all(MAX_WORKBENCH_FIELDS_BYTES, MAX_REVIEW_ISSUES + 1) as { id: string; fields_json: string }[]
  if (rows.length !== issues.length) return fail('审稿原始历史不完整。')
  for (const row of rows) originals.set(row.id, parseReviewIssueFields(storedFields(row.fields_json)))
  const anchors = [...scenes.flatMap(({ fields }) => fields.anchor ? [fields.anchor] : []),
    ...issues.map(({ fields }) => fields.anchor), ...Array.from(originals.values(), (fields) => fields.anchor)]
  const anchorState = prepareAnchors(db, anchors, cache)
  result.scenes = scenes.map(({ row, fields }): SceneCard => ({ ...fields, id: row.id, revision: row.revision,
    updatedAt: row.updated_at, stale: fields.anchor ? anchorState(fields.anchor) : false }))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  const sceneEntities = [...new Set(result.scenes.flatMap((scene) => [...scene.characterIds, ...(scene.locationId ? [scene.locationId] : [])]))]
  if (sceneEntities.length) {
    const labels = db.prepare(`SELECT id, CASE WHEN length(CAST(name AS BLOB)) <= 480 THEN name END AS name
      FROM knowledge_items WHERE book_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?`)
      .all(bookId, JSON.stringify(sceneEntities), sceneEntities.length + 1) as { id: string; name: string }[]
    if (labels.length !== sceneEntities.length) return fail('场景关联的人物或地点资料缺失。')
    result.sceneLabels = Object.fromEntries(labels.map((item) => [requiredId(item.id), requiredText(item.name, '关联资料名称', 120)]))
  }
  const requirementOutlines = issues.some(({ fields }) => fields.candidateSource?.item.requirement)
    ? new Map(currentOutlineNodes(db, bookId).outlines.map((node) => [node.id, node])) : null
  result.issues = issues.map(({ row, fields }): ReviewIssue => {
    const original = originals.get(row.id)
    if (!original) return fail('审稿原始历史缺失。')
    anchorState(original.anchor)
    const requirement = fields.candidateSource?.item.requirement
    const outline = requirement ? requirementOutlines?.get(requirement.outlineId) : undefined
    return { ...fields, id: row.id, revision: row.revision, updatedAt: row.updated_at,
      ...(fields.application ? { applicationCurrent: checkReviewApplication(db, row.id, row.revision, fields) } : {}),
      stale: anchorState(fields.anchor) || Boolean(requirement && (outline?.revisionId !== requirement.revisionId || outline?.stale)),
      originalAnchor: original.anchor, originalEvidence: original.evidence, originalReason: original.reason }
  })
  result.goals = entityRows(db, 'writing_goals', 100).map((row): WritingGoal => ({ ...parseWritingGoalFields(storedFields(row.fields_json)), id: row.id, revision: row.revision }))
  const today = new Date(), since = new Date(today)
  since.setDate(since.getDate() - 365)
  result.activity = db.prepare(`SELECT CASE WHEN length(CAST(date AS BLOB)) = 10 THEN date END AS date,
    CASE WHEN length(CAST(source AS BLOB)) <= 7 THEN source END AS source, SUM(added) AS added, SUM(removed) AS removed,
    SUM(added - removed) AS net, SUM(minutes) AS minutes, COUNT(DISTINCT CASE WHEN revised = 1 THEN chapter_id END) AS revisedChapters
    FROM writing_activity WHERE date BETWEEN ? AND ? GROUP BY date, source ORDER BY date DESC, source LIMIT ?`)
    .all(localWritingDate(since), localWritingDate(today), 366 * 4 + 1) as WritingDay[]
  if (result.activity.length > 366 * 4) return fail('写作统计日期或来源超出支持范围，未截断记录。')
  for (const day of result.activity) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !['manual', 'ai', 'import', 'restore'].includes(day.source) || !Number.isSafeInteger(day.net)) return fail('写作统计格式无效。')
    for (const count of [day.added, day.removed, day.minutes, day.revisedChapters]) requiredInteger(count, '写作统计')
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_WORKBENCH_SNAPSHOT_BYTES) return fail('完整工作台快照超过 16 MiB，请缩短条目内容；未截断任何资料。')
  return result
}

/** 恢复包在只读连接中校验作者可读取的领域数据；不能把合法 JSON 当作有效业务资料。 */
export function validateWorkbenchDatabase(db: Database.Database, bookId: string): void {
  if (Number(db.pragma('user_version', { simple: true })) < WORKBENCH_SCHEMA_VERSION) return
  const current = state(db, bookId)
  const cache = anchorCache()
  const snapshot = readSnapshot(db, bookId, cache)
  const verifiedApplications = new Set<string>()
  const settings = db.prepare('SELECT revision FROM workbench_settings WHERE singleton = 1').get() as Record<string, unknown> | undefined
  if (!settings) return fail('缺少创作约定。')
  requiredInteger(settings.revision, '约定版本', current.revision)
  const validateScene = (fields: ReturnType<typeof parseSceneFields>, historical = false) => {
    if (fields.chapterId && !db.prepare('SELECT id FROM chapters WHERE id = ?').get(fields.chapterId)) return fail('场景章节不存在。')
    for (const id of fields.characterIds) if (!db.prepare("SELECT id FROM knowledge_items WHERE id = ? AND (? = 1 OR kind = 'person')").get(id, historical ? 1 : 0)) return fail('场景人物不存在。')
    if (fields.locationId && !db.prepare("SELECT id FROM knowledge_items WHERE id = ? AND (? = 1 OR kind = 'place')").get(fields.locationId, historical ? 1 : 0)) return fail('场景地点不存在。')
    if (fields.anchor) prepareAnchors(db, [fields.anchor], cache)(fields.anchor)
  }
  const validateIssue = (fields: ReturnType<typeof parseReviewIssueFields>) => {
    prepareAnchors(db, [fields.anchor], cache)(fields.anchor)
    if (fields.aiRunId && !db.prepare('SELECT id FROM ai_runs WHERE id = ? AND book_id = ?').get(fields.aiRunId, bookId)) return fail('审稿 AI 来源不存在。')
    checkReviewSource(db, bookId, fields)
  }
  for (const fields of snapshot.scenes) {
    requiredId(fields.id)
    validateScene(fields)
    const indexed = db.prepare('SELECT chapter_id, position FROM scene_cards WHERE id = ?').get(fields.id) as { chapter_id: string | null; position: number }
    if (indexed.chapter_id !== fields.chapterId || indexed.position !== fields.position) return fail('场景目录与字段不一致。')
  }
  for (const fields of snapshot.issues) {
    requiredId(fields.id)
    validateIssue(fields)
    checkReviewApplication(db, fields.id, fields.revision, parseReviewIssueFields(fields), verifiedApplications)
    const latest = db.prepare(`SELECT CASE WHEN length(CAST(fields_json AS BLOB)) <= ? THEN fields_json END AS fields_json
      FROM workbench_revisions WHERE kind = 'review' AND entity_id = ? AND revision = ?`).get(MAX_WORKBENCH_FIELDS_BYTES, fields.id, fields.revision) as { fields_json: string } | undefined
    if (JSON.stringify(fields.application) !== JSON.stringify(parseReviewIssueFields(storedFields(latest?.fields_json)).application)) return fail('当前审稿记录的应用凭据与历史不一致。')
    const indexed = db.prepare('SELECT chapter_id FROM review_issues WHERE id = ?').get(fields.id) as { chapter_id: string }
    if (indexed.chapter_id !== fields.anchor.chapterId) return fail('审稿目录与来源不一致。')
  }
  for (const goal of snapshot.goals) requiredId(goal.id)
  // 全部历史逐条核验，每次先取字节数再取 JSON，不给历史总条数设置截断点。
  for (const value of db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) = 36 THEN id END AS id,
    CASE WHEN length(CAST(entity_id AS BLOB)) = 36 THEN entity_id END AS entity_id,
    CASE WHEN length(CAST(kind AS BLOB)) <= 8 THEN kind END AS kind,
    revision, length(CAST(fields_json AS BLOB)) AS bytes FROM workbench_revisions`).iterate()) {
    const row = value as { id: string; entity_id: string; kind: string; revision: number; bytes: number }
    requiredId(row.id); requiredId(row.entity_id); requiredInteger(row.revision, '创作历史版本', current.revision)
    if (row.revision < 1 || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_WORKBENCH_FIELDS_BYTES) return fail('创作历史格式无效。')
    const history = db.prepare('SELECT CASE WHEN length(CAST(fields_json AS BLOB)) <= ? THEN fields_json END AS fields_json FROM workbench_revisions WHERE id = ?')
      .get(MAX_WORKBENCH_FIELDS_BYTES, row.id) as { fields_json: string } | undefined
    const fields = storedFields(history?.fields_json)
    if (row.kind === 'brief') { if (row.entity_id !== bookId) return fail('创作约定归属错误。'); parseWritingBrief(fields) }
    else if (row.kind === 'scene') validateScene(parseSceneFields(fields), true)
    else if (row.kind === 'review') {
      const issue = parseReviewIssueFields(fields)
      validateIssue(issue); checkReviewSource(db, bookId, issue, row.revision === 1)
      checkReviewApplication(db, row.entity_id, row.revision, issue, verifiedApplications)
      if (row.revision > 1 && issue.application?.issueRevision !== row.revision) {
        const previous = db.prepare(`SELECT CASE WHEN length(CAST(fields_json AS BLOB)) <= ? THEN fields_json END AS fields_json
          FROM workbench_revisions WHERE kind = 'review' AND entity_id = ? AND revision = ?`).get(MAX_WORKBENCH_FIELDS_BYTES, row.entity_id, row.revision - 1) as { fields_json: string } | undefined
        if (JSON.stringify(issue.application) !== JSON.stringify(parseReviewIssueFields(storedFields(previous?.fields_json)).application)) return fail('审稿历史不能抹去或替换既有应用凭据。')
      }
    }
    else if (row.kind === 'goal') parseWritingGoalFields(fields)
    else return fail('创作历史类型无效。')
  }
  for (const value of db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) = 36 THEN id END AS id,
    CASE WHEN revision_id IS NULL OR length(CAST(revision_id AS BLOB)) = 36 THEN revision_id ELSE '' END AS revision_id,
    CASE WHEN chapter_id IS NULL OR length(CAST(chapter_id AS BLOB)) = 36 THEN chapter_id ELSE '' END AS chapter_id,
    CASE WHEN length(CAST(date AS BLOB)) = 10 THEN date END AS date,
    CASE WHEN length(CAST(source AS BLOB)) <= 7 THEN source END AS source,
    added, removed, minutes, revised FROM writing_activity`).iterate()) {
    const row = value as { id: string; revision_id: string | null; chapter_id: string | null; date: string; source: string; added: number; removed: number; minutes: number; revised: number }
    requiredId(row.id)
    if (!['manual', 'ai', 'import', 'restore'].includes(row.source) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date) return fail('写作记录日期或来源无效。')
    requiredInteger(row.added, '新增字符'); requiredInteger(row.removed, '删除字符'); requiredInteger(row.minutes, '写作分钟', 1_440)
    if (row.chapter_id !== null) requiredId(row.chapter_id)
    if (row.revision_id !== null) requiredId(row.revision_id)
    if (row.revision_id && (!row.chapter_id || !db.prepare('SELECT id FROM chapter_revisions WHERE id = ? AND chapter_id = ?').get(row.revision_id, row.chapter_id))) return fail('写作记录修订不属于对应章节。')
    if (!row.revision_id && (row.source !== 'manual' || row.added !== 0 || row.removed !== 0 || !row.minutes && !row.revised)) return fail('手工时段不能伪造正文变化。')
    if (row.revised && !row.chapter_id) return fail('改稿记录缺少章节。')
  }
}

export class WorkbenchRepository {
  constructor(private readonly studio: StudioRepository) {}

  get(input: BookInput): WorkbenchSnapshot {
    return perform(() => {
      const { bookId } = parseWorkbenchBookInput(input)
      const db = this.studio.getMemoryDatabase(bookId)
      return db.transaction(() => readSnapshot(db, bookId))()
    })
  }

  saveBrief(input: SaveBriefInput): WorkbenchSnapshot {
    return perform(() => {
      const data = parseSaveBriefInput(input)
      return this.write(data, (db, now) => {
        fieldsJson(data.brief)
        const before = db.prepare('SELECT revision FROM workbench_settings WHERE singleton = 1').get() as { revision: number }
        const revision = requiredInteger(before.revision, '创作约定版本') + 1
        db.prepare('UPDATE workbench_settings SET revision = ?, premise = ?, style = ?, narrator = ?, tense = ?, rules = ? WHERE singleton = 1')
          .run(revision, data.brief.premise, data.brief.style, data.brief.narrator, data.brief.tense, data.brief.rules)
        this.audit(db, 'brief', data.bookId, revision, data.brief, now)
      })
    })
  }

  saveScene(input: SaveSceneInput): WorkbenchSnapshot {
    return perform(() => {
      const data = parseSaveSceneInput(input)
      return this.write(data, (db, now) => {
        const fields = data.fields
        if (fields.chapterId && !db.prepare('SELECT id FROM chapters WHERE id = ?').get(fields.chapterId)) return fail('场景所属章节不存在。', 'INVALID_INPUT')
        for (const id of fields.characterIds) {
          if (!db.prepare("SELECT id FROM knowledge_items WHERE id = ? AND kind = 'person'").get(id)) return fail('场景人物必须选择本书人物条目。', 'INVALID_INPUT')
        }
        if (fields.locationId && !db.prepare("SELECT id FROM knowledge_items WHERE id = ? AND kind = 'place'").get(fields.locationId)) return fail('场景地点必须选择本书地点条目。', 'INVALID_INPUT')
        this.entity(db, 'scene_cards', 'scene', MAX_SCENES, data, now)
      })
    })
  }

  reorderScenes(input: ReorderScenesInput): WorkbenchSnapshot {
    return perform(() => {
      const data = parseReorderScenesInput(input)
      return this.write(data, (db, now) => {
        if (data.chapterId && !db.prepare('SELECT id FROM chapters WHERE id = ?').get(data.chapterId)) return fail('场景所属章节不存在。', 'INVALID_INPUT')
        checkSnapshotBudget(db)
        const scenes = entityRows(db, 'scene_cards', MAX_SCENES)
          .map((row) => ({ row, fields: parseSceneFields(storedFields(row.fields_json)) }))
          .filter(({ fields }) => !fields.archived && fields.chapterId === data.chapterId)
        const byId = new Map(scenes.map((scene) => [scene.row.id, scene]))
        // 整组身份与作品版本在同一事务内核对，拒绝跨章、归档或缺项的排序。
        if (scenes.length !== data.sceneIds.length || data.sceneIds.some((id) => !byId.has(id))) return fail('本章场景集合已改变，请刷新后重新排序。', 'REVISION_CONFLICT')
        data.sceneIds.forEach((id, index) => {
          const scene = byId.get(id)!
          const position = index + 1
          if (scene.fields.position === position) return
          this.entity(db, 'scene_cards', 'scene', MAX_SCENES, {
            ...data, id, expectedRevision: scene.row.revision, fields: { ...scene.fields, position },
          }, now)
        })
      })
    })
  }

  saveIssue(input: SaveReviewIssueInput): WorkbenchSnapshot {
    return perform(() => {
      const data = parseSaveReviewIssueInput(input)
      return this.write(data, (db, now) => {
        const chapter = db.prepare('SELECT current_revision_id FROM chapters WHERE id = ?').get(data.fields.anchor.chapterId) as { current_revision_id: string } | undefined
        if (!chapter) return fail('正文证据对应的章节不存在。', 'INVALID_INPUT')
        if (chapter.current_revision_id !== data.fields.anchor.revisionId && data.fields.status === 'resolved') return fail('正文已变化，请先重新定位并复核问题，再标记已解决。', 'INVALID_INPUT')
        if (data.fields.aiRunId && !db.prepare('SELECT id FROM ai_runs WHERE id = ? AND book_id = ?').get(data.fields.aiRunId, data.bookId)) return fail('AI 建议不属于当前作品。', 'INVALID_INPUT')
        checkReviewSource(db, data.bookId, data.fields)
        const previous = db.prepare('SELECT fields_json FROM review_issues WHERE id = ?').get(data.id) as { fields_json: string } | undefined
        const original = previous ? parseReviewIssueFields(storedFields(previous.fields_json)) : null
        if (data.fields.application && JSON.stringify(data.fields.application) !== JSON.stringify(original?.application)) return fail('正文应用凭据只能由确认替换事务生成。', 'INVALID_INPUT')
        if (original && (original.candidateSource || data.fields.candidateSource) && (JSON.stringify(original.candidateSource) !== JSON.stringify(data.fields.candidateSource) || original.aiRunId !== data.fields.aiRunId)) return fail('首次登记的审稿候选来源不能被替换。', 'INVALID_INPUT')
        const source = data.fields.candidateSource
        if (source?.item.requirement && data.fields.status === 'resolved') {
          const requirement = source.item.requirement
          const outline = currentOutlineNodes(db, data.bookId).outlines.find((node) => node.id === requirement.outlineId)
          if (outline?.revisionId !== requirement.revisionId || outline?.stale) return fail('所引章纲要求已变化，请保留原建议，重新审阅新章纲后登记结论。', 'REVISION_CONFLICT')
        }
        if (source && !previous) {
          const run = readStoredAiRun(db, data.bookId, data.fields.aiRunId!)
          if (run.state !== 'succeeded' || run.version !== source.runVersion ||
            data.fields.anchor.chapterId !== run.chapterId || data.fields.anchor.revisionId !== run.context.chapterRevisionId ||
            JSON.stringify(data.fields.anchor.blockIds) !== JSON.stringify(source.item.blockIds) || data.fields.evidence !== source.item.quote ||
            !['open', 'intentional', 'dismissed'].includes(data.fields.status)) return fail('首次登记必须保留本次候选的固定原稿、引文与段落。', 'INVALID_INPUT')
          const prior = db.prepare(`SELECT entity_id FROM workbench_revisions WHERE kind = 'review' AND revision = 1
            AND json_extract(fields_json, '$.aiRunId') = ? AND json_extract(fields_json, '$.candidateSource.index') = ? LIMIT 1`)
            .get(run.id, source.index) as { entity_id: string } | undefined
          if (prior) return fail('这一审稿建议已经登记，请在审稿清单中继续处理。', 'REVISION_CONFLICT')
        }
        const fields = { ...data.fields, ...(original?.application ? { application: original.application } : {}) }
        this.entity(db, 'review_issues', 'review', MAX_REVIEW_ISSUES, { ...data, fields }, now)
      })
    })
  }

  saveGoal(input: SaveWritingGoalInput): WorkbenchSnapshot {
    return perform(() => {
      const data = parseSaveWritingGoalInput(input)
      return this.write(data, (db, now) => this.entity(db, 'writing_goals', 'goal', 100, data, now))
    })
  }

  applyIssue(input: ApplyReviewIssueInput): ApplyReviewIssueReceipt {
    return perform(() => {
      const data = parseApplyReviewIssueInput(input)
      const db = this.studio.getMemoryDatabase(data.bookId)
      const result = db.transaction(() => {
        writable(db, data)
        checkSnapshotBudget(db)
        const cache = anchorCache()
        const row = db.prepare('SELECT revision, CASE WHEN length(CAST(fields_json AS BLOB)) <= ? THEN fields_json END AS fields_json FROM review_issues WHERE id = ?')
          .get(MAX_WORKBENCH_FIELDS_BYTES, data.id) as { revision: number; fields_json: string } | undefined
        if (!row || row.revision !== data.expectedRevision) return fail('审稿问题已有新版本，请重读后核对。', 'REVISION_CONFLICT')
        const fields = parseReviewIssueFields(storedFields(row.fields_json))
        const replacementText = reviewReplacement(fields)
        if (fields.status !== 'open' || !replacementText.trim() || fields.anchor.blockIds.length === 0 || fields.candidateSource?.item.requirement) return fail('仅能应用待处理问题中的替换正文；请先填写建议并选择连续段落。', 'INVALID_INPUT')
        if (prepareAnchors(db, [fields.anchor], cache)(fields.anchor) || fields.anchor.revisionId !== data.expectedRevisionId) return fail('原稿已变化，请重新定位并复核建议，当前正文未被覆盖。', 'REVISION_CONFLICT')
        const current = this.studio.readChapter({ bookId: data.bookId, chapterId: fields.anchor.chapterId })
        const selected = new Set(fields.anchor.blockIds)
        const indexes = current.document.content.flatMap((block, index) => selected.has(block.attrs.id) ? [index] : [])
        if (indexes.length !== selected.size || indexes.some((index, offset) => index !== indexes[0]! + offset)) return fail('替换正文需要选择同一章内的连续段落。', 'INVALID_INPUT')
        const replacement = textToDocument(replacementText).content
        const document = parseManuscript({ type: 'doc', content: [
          ...current.document.content.slice(0, indexes[0]), ...replacement, ...current.document.content.slice(indexes[indexes.length - 1]! + 1),
        ] })
        // 正文与问题处理状态同事务提交，采用只进入待复核，不等同于问题已解决。
        const saved = this.studio.saveChapter({ bookId: data.bookId, chapterId: current.id, expectedRevisionId: data.expectedRevisionId, document }, fields.aiRunId ? 'ai' : 'manual')
        if (!saved.changed || saved.chapter.revisionId === data.expectedRevisionId) return fail('没有生成新的正文修订，未登记应用状态。')
        this.entity(db, 'review_issues', 'review', MAX_REVIEW_ISSUES, { ...data, fields: { ...fields, status: 'recheck', application: {
          chapterId: current.id, sourceRevisionId: data.expectedRevisionId, revisionId: saved.chapter.revisionId, issueRevision: row.revision + 1,
        } } }, new Date().toISOString())
        return { chapter: saved.chapter, workbench: readSnapshot(db, data.bookId, cache) }
      }).immediate()
      this.studio.refreshKnowledgeCatalog(data.bookId)
      return result
    })
  }

  logSession(input: LogWritingSessionInput): WorkbenchSnapshot {
    return perform(() => {
      const data = parseLogWritingSessionInput(input)
      return this.write(data, (db, now) => {
        if (data.date > localWritingDate(new Date())) return fail('不能把未来日期记为已完成写作。', 'INVALID_INPUT')
        if (data.revisedChapterId && !db.prepare('SELECT id FROM chapters WHERE id = ?').get(data.revisedChapterId)) return fail('改稿章节不存在。', 'INVALID_INPUT')
        if (db.prepare('SELECT id FROM writing_activity WHERE id = ?').get(data.id)) return fail('这次写作记录已保存，请重新读取。', 'REVISION_CONFLICT')
        const total = db.prepare('SELECT COALESCE(SUM(minutes), 0) AS minutes FROM writing_activity WHERE date = ?').get(data.date) as { minutes: number }
        if (total.minutes + data.minutes > 1_440) return fail('当天累计写作时长不能超过 24 小时。', 'INVALID_INPUT')
        db.prepare(`INSERT INTO writing_activity (id, revision_id, chapter_id, date, source, added, removed, minutes, revised, created_at)
          VALUES (?, NULL, ?, ?, 'manual', 0, 0, ?, ?, ?)`).run(data.id, data.revisedChapterId, data.date, data.minutes, data.revisedChapterId ? 1 : 0, now)
      })
    })
  }

  private write(input: BookMutationInput, action: (db: Database.Database, now: string) => void): WorkbenchSnapshot {
    const db = this.studio.getMemoryDatabase(input.bookId)
    const snapshot = db.transaction(() => {
      const current = writable(db, input)
      const now = new Date().toISOString()
      action(db, now)
      advance(db, current, now)
      // 完整回执在提交前核验；任何条目、原始证据或整体预算失败都会回滚本次修改。
      return readSnapshot(db, input.bookId)
    }).immediate()
    this.studio.refreshKnowledgeCatalog(input.bookId)
    return snapshot
  }

  private entity(db: Database.Database, table: 'scene_cards' | 'review_issues' | 'writing_goals', kind: 'scene' | 'review' | 'goal', maximum: number,
    data: SaveSceneInput | SaveReviewIssueInput | SaveWritingGoalInput, now: string): void {
    const previous = db.prepare(`SELECT revision FROM ${table} WHERE id = ?`).get(data.id) as { revision: number } | undefined
    if ((previous?.revision ?? 0) !== data.expectedRevision) return fail('条目已有新版本，请保留输入并重新读取。', 'REVISION_CONFLICT')
    if (data.expectedRevision >= Number.MAX_SAFE_INTEGER) return fail('条目版本超出支持范围。')
    if (!previous && (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count >= maximum) return fail(`条目数量已达到 ${maximum} 条上限。`, 'INVALID_INPUT')
    const revision = data.expectedRevision + 1
    const json = fieldsJson(data.fields)
    if (previous) db.prepare(`UPDATE ${table} SET revision = ?, fields_json = ?, updated_at = ? WHERE id = ? AND revision = ?`).run(revision, json, now, data.id, previous.revision)
    else if (table === 'scene_cards' && 'position' in data.fields) db.prepare('INSERT INTO scene_cards (id, revision, chapter_id, position, fields_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(data.id, revision, data.fields.chapterId, data.fields.position, json, now)
    else if (table === 'review_issues' && 'anchor' in data.fields && data.fields.anchor) db.prepare('INSERT INTO review_issues (id, revision, chapter_id, fields_json, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(data.id, revision, data.fields.anchor.chapterId, json, now)
    else if (table === 'writing_goals') db.prepare('INSERT INTO writing_goals (id, revision, fields_json, updated_at) VALUES (?, ?, ?, ?)').run(data.id, revision, json, now)
    else return fail('创作条目类型不匹配。')
    if (table === 'scene_cards' && 'position' in data.fields) db.prepare('UPDATE scene_cards SET chapter_id = ?, position = ? WHERE id = ?').run(data.fields.chapterId, data.fields.position, data.id)
    if (table === 'review_issues' && 'anchor' in data.fields && data.fields.anchor) db.prepare('UPDATE review_issues SET chapter_id = ? WHERE id = ?').run(data.fields.anchor.chapterId, data.id)
    this.audit(db, kind, data.id, revision, data.fields, now)
  }

  private audit(db: Database.Database, kind: string, id: string, revision: number, fields: unknown, now: string): void {
    db.prepare('INSERT INTO workbench_revisions (id, entity_id, kind, revision, fields_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), id, kind, revision, fieldsJson(fields), now)
  }
}
