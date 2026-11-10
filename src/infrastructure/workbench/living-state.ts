import type Database from 'better-sqlite3'
import { DomainError, requiredId } from '../../contracts/api'
import { LIVING_SCHEMA_VERSION, parseLivingProposal, parseLivingWritingContext, parseOutlineFields,
  type LivingOutline, type LivingWritingContext, type OutlineFields, type OutlineScope, type PublishedMemory } from '../../contracts/living'

export interface LivingDependency { kind: 'chapter' | 'knowledge' | 'outline' | 'memory' | 'brief'; id: string; revision: string }
export interface OutlineRow { id: string; scope: OutlineScope; current_revision_id: string; version: number; fields_json: string; locked: number; origin: 'manual' | 'ai' | 'restored' }
export interface LivingChapter {
  id: string; title: string; position: number; volume_id: string | null; current_revision_id: string; finalized_revision_id: string | null
  status: string; character_count: number; goal: string; conflict: string; hook: string; tension: number | null; beats_json: string
}
export function livingFailure(message = '演进大纲或记忆来源无法核对，请保留作品后检查记录。'): never {
  throw new DomainError({ code: 'STORAGE_ERROR', message })
}
export function livingConflict(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
export function requireLiving(db: Database.Database): void {
  if (Number(db.pragma('user_version', { simple: true })) < LIVING_SCHEMA_VERSION) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级作品至 v16，再使用演进大纲与记忆发布。' })
}
export function storedJson(value: unknown, maximum = 512 * 1024): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) return livingFailure('记录超出读取预算，未截断原始资料。')
  try { return JSON.parse(value) } catch { return livingFailure() }
}
export function livingChapters(db: Database.Database): LivingChapter[] {
  const budget = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(goal || conflict || hook || beats_json AS BLOB))), 0) AS bytes FROM chapters').get() as { count: number; bytes: number }
  if (budget.count > 20000 || budget.bytes > 4 * 1024 * 1024) return livingFailure('章节计划超过当前快照预算，未截断资料。')
  const rows = db.prepare(`SELECT c.id, c.title, c.position, c.volume_id, c.current_revision_id, c.finalized_revision_id,
    c.status, r.character_count, c.goal, c.conflict, c.hook, c.tension, c.beats_json
    FROM chapters c JOIN chapter_revisions r ON r.chapter_id = c.id AND r.id = c.current_revision_id
    ORDER BY c.position LIMIT 20001`).all() as LivingChapter[]
  if (rows.length > 20000) return livingFailure('章节数量超出当前创作快照范围，未截断资料。')
  return rows
}
export function chapterToken(chapter: LivingChapter): string {
  return JSON.stringify([chapter.current_revision_id, chapter.finalized_revision_id, chapter.position, chapter.volume_id, chapter.title, chapter.status])
}
export function parseChapterToken(value: string): { revisionId: string; finalizedRevisionId: string | null; status: string } {
  const token = storedJson(value, 1000)
  if (!Array.isArray(token) || token.length !== 6 || JSON.stringify(token) !== value || !Number.isSafeInteger(token[2]) || token[2] < 0 ||
    (token[3] !== null && typeof token[3] !== 'string') || typeof token[4] !== 'string' || !token[4].trim() || token[4].length > 120 ||
    !['planned', 'writing', 'review', 'finalized'].includes(token[5])) return livingFailure('正文依赖的固定版本格式无效。')
  const revisionId = requiredId(token[0]), finalizedRevisionId = token[1] === null ? null : requiredId(token[1])
  if (token[3] !== null) requiredId(token[3])
  if (token[5] === 'finalized' && finalizedRevisionId !== revisionId) return livingFailure('定稿依赖与正文版本不一致。')
  return { revisionId, finalizedRevisionId, status: token[5] }
}
export function savedOutlineRows(db: Database.Database): OutlineRow[] {
  const budget = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(r.fields_json AS BLOB))), 0) AS bytes
    FROM living_outlines n JOIN living_outline_revisions r ON r.id = n.current_revision_id AND r.outline_id = n.id`).get() as { count: number; bytes: number }
  if (budget.count > 22500 || budget.bytes > 4 * 1024 * 1024) return livingFailure('当前大纲超过快照预算，未截断资料。')
  const rows = db.prepare(`SELECT n.id, n.scope, n.current_revision_id, r.version, r.fields_json, r.locked, r.origin
    FROM living_outlines n JOIN living_outline_revisions r ON r.outline_id = n.id AND r.id = n.current_revision_id LIMIT 22501`).all() as OutlineRow[]
  if (rows.length > 22500) return livingFailure('大纲条目超过当前快照范围，未截断资料。')
  return rows
}
function beats(value: string): OutlineFields['beats'] {
  const data = storedJson(value)
  if (!Array.isArray(data)) return livingFailure()
  return data.map((beat) => {
    if (!beat || typeof beat !== 'object') return livingFailure()
    const b = beat as Record<string, unknown>
    return { title: b.title, action: b.action, outcome: b.outcome } as OutlineFields['beats'][number]
  })
}
function baseFields(title: string): OutlineFields { return { title, summary: '', goal: '', conflict: '', hook: '', tension: null, beats: [] } }
export function readOutlineNodes(db: Database.Database, bookId: string, chapters = livingChapters(db), saved = savedOutlineRows(db)): LivingOutline[] {
  const meta = db.prepare('SELECT id, title, master_outline_json FROM book_meta WHERE singleton = 1').get() as { id: string; title: string; master_outline_json: string }
  if (!meta || meta.id !== bookId) return livingFailure()
  const master = storedJson(meta.master_outline_json)
  if (!master || typeof master !== 'object') return livingFailure()
  const summary = Array.isArray(master) ? master.map((act: Record<string, unknown>) => `${String(act.title ?? '')}：${String(act.summary ?? '')}`).join('\n') : ''
  const initial: { id: string; scope: OutlineScope; parentId: string | null; position: number; fields: OutlineFields }[] = [
    { id: bookId, scope: 'book', parentId: null, position: 0, fields: { ...baseFields('全书总纲'), summary } },
  ]
  const volumes = db.prepare('SELECT id, title, position, goal, conflict, climax FROM volumes ORDER BY position LIMIT 2001').all() as
    { id: string; title: string; position: number; goal: string; conflict: string; climax: string }[]
  if (volumes.length > 2000) return livingFailure('分卷数量超出当前快照范围。')
  for (const volume of volumes) initial.push({ id: volume.id, scope: 'volume', parentId: bookId, position: volume.position,
    fields: { ...baseFields(volume.title), goal: volume.goal, conflict: volume.conflict, hook: volume.climax } })
  for (const chapter of chapters) initial.push({ id: chapter.id, scope: 'chapter', parentId: chapter.volume_id ?? bookId, position: chapter.position,
    fields: { ...baseFields(chapter.title), goal: chapter.goal, conflict: chapter.conflict, hook: chapter.hook, tension: chapter.tension, beats: beats(chapter.beats_json) } })
  const byId = new Map(saved.map((row) => [row.id, row]))
  const seen = new Set<string>()
  const result = initial.map((node): LivingOutline => {
    if (seen.has(node.id)) return livingFailure('作品、分卷与章节的大纲身份冲突。')
    seen.add(node.id)
    const row = byId.get(node.id)
    const fields = parseOutlineFields(row ? storedJson(row.fields_json) : node.fields)
    if (row && (row.scope !== node.scope || !Number.isSafeInteger(row.version) || row.version < 1 || ![0, 1].includes(row.locked))) return livingFailure()
    const drift = row && node.scope !== 'book' && (fields.title !== node.fields.title || fields.goal !== node.fields.goal || fields.conflict !== node.fields.conflict || fields.hook !== node.fields.hook ||
      (node.scope === 'chapter' && (fields.tension !== node.fields.tension || JSON.stringify(fields.beats) !== JSON.stringify(node.fields.beats))))
    return { ...node, fields, revisionId: row ? requiredId(row.current_revision_id) : null, version: row?.version ?? 0,
      locked: row?.locked === 1, manual: row ? row.origin !== 'ai' : Boolean(fields.summary || fields.goal || fields.conflict || fields.hook || fields.beats.length),
      stale: Boolean(drift), staleReason: drift ? '章节或分卷资料已在其他入口修改，请复核并保存大纲新版本。' : null }
  })
  if (saved.some((row) => !seen.has(row.id))) return livingFailure('大纲身份缺少所属作品、分卷或章节。')
  return result
}

export function readLivingFreshness(db: Database.Database, chapters: LivingChapter[], outlines: LivingOutline[]): Map<string, string> {
  const rows = db.prepare('SELECT target_kind, target_id, source_kind, source_id, source_revision FROM living_dependencies LIMIT 100001').all() as
    { target_kind: string; target_id: string; source_kind: string; source_id: string; source_revision: string }[]
  if (rows.length > 100000) return livingFailure('依赖记录超过当前静态快照预算，未省略依赖或继续使用旧记忆。')
  const tokens = new Map<string, string>()
  for (const chapter of chapters) tokens.set(`chapter:${chapter.id}`, chapterToken(chapter))
  for (const node of outlines) if (node.revisionId) tokens.set(`outline:${node.id}`, node.revisionId)
  const entities = db.prepare(`SELECT i.id, (SELECT r.id FROM knowledge_item_revisions r WHERE r.item_id = i.id ORDER BY r.knowledge_revision DESC LIMIT 1) AS revision_id
    FROM knowledge_items i WHERE i.author_decision = 'adopted' AND i.freshness = 'current' AND i.conflict_state <> 'candidate'
      AND EXISTS (SELECT 1 FROM living_dependencies d WHERE d.source_kind = 'knowledge' AND d.source_id = i.id) LIMIT 100001`).all() as { id: string; revision_id: string }[]
  if (entities.length > 100000) return livingFailure()
  for (const item of entities) tokens.set(`knowledge:${item.id}`, item.revision_id)
  const publications = db.prepare(`SELECT b.id FROM living_memory_publications p JOIN living_memory_batches b ON b.id = p.batch_id AND b.chapter_id = p.chapter_id
    WHERE b.state = 'published' LIMIT 20001`).all() as { id: string }[]
  if (publications.length > 20000) return livingFailure()
  for (const item of publications) tokens.set(`memory:${item.id}`, item.id)
  const brief = db.prepare('SELECT revision FROM workbench_settings WHERE singleton = 1').get() as { revision: number } | undefined
  const book = db.prepare('SELECT id FROM book_meta WHERE singleton = 1').get() as { id: string }
  if (brief) tokens.set(`brief:${book.id}`, String(brief.revision))
  const stale = new Map<string, string>()
  const outgoing = new Map<string, string[]>()
  // 派生目标绑定不可变修订，来源身份绑定节点并核对固定修订；手工新修订不继承旧版本的失效边。
  for (const node of outlines) if (node.stale && node.revisionId) stale.set(`outline:${node.revisionId}`, node.staleReason!)
  for (const row of rows) {
    if (!['outline', 'memory'].includes(row.target_kind) || !['chapter', 'knowledge', 'outline', 'memory', 'brief'].includes(row.source_kind)) return livingFailure()
    const target = `${row.target_kind}:${row.target_id}`
    const token = tokens.get(`${row.source_kind}:${row.source_id}`)
    if (token !== row.source_revision) stale.set(target, '依赖的正文、实体、大纲或记忆批次已变化，需要复核。')
    const source = row.source_kind === 'outline' ? `outline:${row.source_revision}` : `${row.source_kind}:${row.source_id}`
    const targets = outgoing.get(source) ?? []
    targets.push(target); outgoing.set(source, targets)
  }
  // 按依赖边传播且每个目标只入队一次；环路不会导致死循环，锁定内容同样保留并提示复核。
  const queue = [...stale.keys()]
  for (let index = 0; index < queue.length; index++) for (const target of outgoing.get(queue[index]!) ?? []) {
    if (stale.has(target)) continue
    stale.set(target, '上游派生资料已失效，需要按新来源复核。'); queue.push(target)
  }
  return stale
}
export function currentOutlineNodes(db: Database.Database, bookId: string): { chapters: LivingChapter[]; outlines: LivingOutline[]; stale: Map<string, string> } {
  const chapters = livingChapters(db), outlines = readOutlineNodes(db, bookId, chapters)
  const stale = readLivingFreshness(db, chapters, outlines)
  for (const node of outlines) if (node.revisionId && stale.has(`outline:${node.revisionId}`)) {
    node.stale = true; node.staleReason = stale.get(`outline:${node.revisionId}`)!
  }
  return { chapters, outlines, stale }
}
export function readMemoryBatch(db: Database.Database, id: string, stale: Map<string, string>): PublishedMemory {
  const row = db.prepare(`SELECT b.id, b.chapter_id, b.chapter_title, b.chapter_revision_id, b.run_id, b.state, b.proposal_json, b.created_at,
    p.batch_id AS current_batch_id FROM living_memory_batches b LEFT JOIN living_memory_publications p ON p.chapter_id = b.chapter_id WHERE b.id = ?`).get(id) as
    { id: string; chapter_id: string; chapter_title: string; chapter_revision_id: string; run_id: string; state: string; proposal_json: string; created_at: string; current_batch_id: string | null } | undefined
  if (!row) return livingFailure()
  const proposal = parseLivingProposal(storedJson(row.proposal_json))
  if (proposal.kind !== 'memory' || !['published', 'superseded'].includes(row.state) || (row.state === 'published' ? row.current_batch_id !== row.id : row.current_batch_id === row.id)) return livingFailure()
  return { id: requiredId(row.id), chapterId: requiredId(row.chapter_id), chapterTitle: row.chapter_title, revisionId: requiredId(row.chapter_revision_id), runId: requiredId(row.run_id),
    state: row.state === 'superseded' ? 'superseded' : stale.has(`memory:${id}`) ? 'stale' : 'published', staleReason: stale.get(`memory:${id}`) ?? null,
    proposal, createdAt: row.created_at }
}
export function readLivingWritingContext(db: Database.Database, bookId: string, chapterId: string): LivingWritingContext {
  requireLiving(db)
  const state = currentOutlineNodes(db, bookId)
  const chapter = state.chapters.find((item) => item.id === chapterId)
  if (!chapter) return livingConflict('本书不存在目标章节。')
  const outlines = state.outlines.filter((node) => [bookId, chapter.volume_id, chapterId].includes(node.id) && !node.stale &&
    Boolean(node.fields.summary || node.fields.goal || node.fields.conflict || node.fields.hook || node.fields.beats.length))
  // 在最近三个前文章节范围内选有效批次，不能把更早的摘要冒充相邻三章，也不发送未来章记忆。
  const previous = state.chapters.filter((item) => item.position < chapter.position).slice(-3)
  const memories: PublishedMemory[] = []
  for (const item of previous) {
    const row = db.prepare('SELECT batch_id FROM living_memory_publications WHERE chapter_id = ?').get(item.id) as { batch_id: string } | undefined
    if (!row) continue
    const memory = readMemoryBatch(db, row.batch_id, state.stale)
    if (memory.state === 'published') memories.push(memory)
  }
  return parseLivingWritingContext({ version: 1, outlines, memories })
}
