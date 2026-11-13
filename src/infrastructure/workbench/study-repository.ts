import type Database from 'better-sqlite3'
import { DomainError } from '../../contracts/api'
import { parseInspirationFields, type InspirationFields, type InspirationItem } from '../../contracts/workbench'
import { MAX_STUDY_ITEMS, parseStudyAdoptInput, parseStudyProposal, parseStudySavedInput, studyInspirationFields,
  type StudyAdoptInput, type StudyAdoptReceipt, type StudySavedInput, type StudySavedResults } from '../../contracts/study'
import type { AiRepository } from '../ai/ai-repository'
import type { StudioRepository } from '../storage/studio-repository'
import { readInspirationThumbnailMetadata } from './inspiration-thumbnail-repository'

interface Row {
  id: string; revision: number; kind: string; title: string; body: string; source: string; tags_json: string
  parent_id: string | null; book_id: string | null; archived: number; created_at: string; updated_at: string
}
function failure(message: string, code: 'INVALID_INPUT' | 'REVISION_CONFLICT' | 'NOT_FOUND' | 'STORAGE_ERROR' = 'REVISION_CONFLICT'): never {
  throw new DomainError({ code, message })
}
function read(db: Database.Database, id: string): InspirationItem | null {
  const row = db.prepare('SELECT * FROM inspirations WHERE id = ?').get(id) as Row | undefined
  if (!row) return null
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || ![0, 1].includes(row.archived) ||
    typeof row.tags_json !== 'string' || row.tags_json.length > 8_000 || typeof row.created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.created_at)) || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) {
    return failure('全局资料格式无效，请保留拆书结果。', 'STORAGE_ERROR')
  }
  const fields = { kind: row.kind, title: row.title, body: row.body, source: row.source, tags: JSON.parse(row.tags_json),
    parentId: row.parent_id, bookId: row.book_id, archived: row.archived === 1 }
  const parsed = parseInspirationFields(fields)
  if (JSON.stringify(fields) !== JSON.stringify(parsed)) return failure('全局资料内容不符合保存格式，请保留拆书结果。', 'STORAGE_ERROR')
  const item = { ...parsed, id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
  return { ...item, thumbnail: readInspirationThumbnailMetadata(db, item) }
}
function sameFields(item: InspirationFields, expected: InspirationFields): boolean {
  return Object.keys(expected).every((key) => JSON.stringify(item[key as keyof InspirationFields]) === JSON.stringify(expected[key as keyof InspirationFields]))
}

export class StudyRepository {
  constructor(private readonly studio: StudioRepository, private readonly ai: AiRepository) {}

  saved(input: StudySavedInput): StudySavedResults {
    const data = parseStudySavedInput(input)
    try {
      const run = this.ai.get({ bookId: data.bookId, runId: data.runId })
      if (run.version !== data.expectedVersion || run.state !== 'succeeded' || run.kind !== 'plan' || run.purpose !== 'study' ||
        run.context.bookId !== data.bookId || run.context.chapterId !== run.chapterId) return failure('拆书候选版本已变化，请保留编辑并重新读取候选。')
      const proposal = parseStudyProposal(run.outputText, run.context)
      const db = this.studio.getInspirationDatabase()
      if (!db) return { ...data, items: [] }
      return db.transaction(() => {
        // 固定首次入库历史定位来源；后来改标题、出处或归档，仍不能被当成尚未入库的候选。
        const rows = db.prepare(`SELECT id, fields_json FROM inspiration_revisions WHERE revision = 1
          AND json_extract(fields_json, '$.source') IS NOT NULL
          AND json_extract(CASE WHEN json_valid(json_extract(fields_json, '$.source')) THEN json_extract(fields_json, '$.source') ELSE '{}' END, '$.type') = 'study'
          AND json_extract(CASE WHEN json_valid(json_extract(fields_json, '$.source')) THEN json_extract(fields_json, '$.source') ELSE '{}' END, '$.bookId') = ?
          AND json_extract(CASE WHEN json_valid(json_extract(fields_json, '$.source')) THEN json_extract(fields_json, '$.source') ELSE '{}' END, '$.runId') = ?
          LIMIT ?`).all(data.bookId, data.runId, MAX_STUDY_ITEMS + 1) as { id: string; fields_json: string }[]
        if (rows.length > MAX_STUDY_ITEMS) return failure('同一拆书任务的入库历史数量异常，请保留结果并核对资料。', 'STORAGE_ERROR')
        const indexes = new Set<number>()
        const items = rows.map((row) => {
          const first = parseInspirationFields(JSON.parse(row.fields_json))
          const provenance = JSON.parse(first.source) as { index?: unknown }
          const index = provenance.index
          if (!Number.isSafeInteger(index) || typeof index !== 'number' || !proposal.items[index] || indexes.has(index)) {
            return failure('拆书入库历史序号缺失或重复，请保留结果并核对资料。', 'STORAGE_ERROR')
          }
          indexes.add(index)
          const original = proposal.items[index]!
          const expected = studyInspirationFields({ ...data, entries: [] }, run.context, original, { index, id: row.id, title: first.title, body: first.body })
          if (!sameFields(first, expected)) return failure('拆书入库历史与固定来源不一致。', 'STORAGE_ERROR')
          const current = read(db, row.id)
          if (!current) return failure('拆书入库历史对应的资料已经缺失。', 'STORAGE_ERROR')
          return { index, origin: first.source, item: current }
        })
        return { ...data, items: items.sort((left, right) => left.index - right.index) }
      })()
    } catch (error) {
      if (error instanceof DomainError) throw error
      return failure('已入库拆书结果暂时无法读取，当前编辑保留。', 'STORAGE_ERROR')
    }
  }

  adopt(input: StudyAdoptInput): StudyAdoptReceipt {
    const data = parseStudyAdoptInput(input)
    try {
      const db = this.studio.getInspirationDatabase()
      if (!db) return failure('拆书参考资料不存在，请重新选择原文。', 'NOT_FOUND')
      return db.transaction(() => {
        const run = this.ai.get({ bookId: data.bookId, runId: data.runId })
        if (run.bookId !== data.bookId || run.id !== data.runId || run.version !== data.expectedVersion || run.state !== 'succeeded' ||
          run.kind !== 'plan' || run.purpose !== 'study' || run.context.bookId !== data.bookId || run.context.chapterId !== run.chapterId) {
          return failure('只有相同版本、已成功完成的拆书候选可以入库，请重新读取候选。')
        }
        const proposal = parseStudyProposal(run.outputText, run.context)
        const checkedSources = new Set<string>()
        const entries = data.entries.map((entry) => {
          const original = proposal.items[entry.index]
          if (!original) return failure('所选条目不属于这次固定拆书结果。', 'INVALID_INPUT')
          const source = run.context.creativeResources!.items.find((item) => item.source === 'inspiration' && item.id === original.sourceId)!
          if (!checkedSources.has(source.id)) {
            const current = read(db, source.id)
            if (!current || current.archived || current.revision !== source.revision) return failure('拆书参考原文已更新或归档，请基于最新资料重新生成并审阅。')
            if (current.title !== source.title || current.body !== source.text) return failure('固定参考内容与当前来源不一致，请重新选择原文。')
            checkedSources.add(source.id)
          }
          // 新记录只挂接固定来源；同时沿用全局资料父子链的防环和深度边界。
          const visited = new Set([entry.id])
          let parent: string | null = source.id
          while (parent) {
            if (visited.has(parent) || visited.size > 100) return failure('参考链不能形成循环或超过 100 层。', 'INVALID_INPUT')
            visited.add(parent)
            const ancestor = read(db, parent)
            if (!ancestor) return failure('参考链的原始资料已缺失，请先核对来源。')
            parent = ancestor.parentId
          }
          const fields = studyInspirationFields(data, run.context, original, entry)
          // 同一候选条目跨窗口仍只入库一次；重新打开审阅不能凭新 UUID 重复建立方法卡。
          const prior = db.prepare(`SELECT id FROM inspiration_revisions WHERE revision = 1
            AND json_extract(CASE WHEN json_valid(json_extract(fields_json, '$.source')) THEN json_extract(fields_json, '$.source') ELSE '{}' END, '$.type') = 'study'
            AND json_extract(CASE WHEN json_valid(json_extract(fields_json, '$.source')) THEN json_extract(fields_json, '$.source') ELSE '{}' END, '$.bookId') = ?
            AND json_extract(CASE WHEN json_valid(json_extract(fields_json, '$.source')) THEN json_extract(fields_json, '$.source') ELSE '{}' END, '$.runId') = ?
            AND json_extract(CASE WHEN json_valid(json_extract(fields_json, '$.source')) THEN json_extract(fields_json, '$.source') ELSE '{}' END, '$.index') = ? LIMIT 1`)
            .get(data.bookId, data.runId, entry.index) as { id: string } | undefined
          if (prior && prior.id !== entry.id) return failure(`第 ${entry.index + 1} 项已保存至全局资料。请取消选择该项，已有内容可在全局资料中继续编辑。`)
          const saved = read(db, entry.id)
          if (saved) {
            // 相同客户端 ID 只确认完整一致的首次保存，不能覆盖后续编辑或再次增加历史。
            const history = db.prepare('SELECT fields_json, created_at FROM inspiration_revisions WHERE id = ? AND revision = 1')
              .get(entry.id) as { fields_json: string; created_at: string } | undefined
            const revisions = (db.prepare('SELECT COUNT(*) AS total FROM inspiration_revisions WHERE id = ?').get(entry.id) as { total: number }).total
            if (saved.revision !== 1 || saved.thumbnail !== null || !sameFields(saved, fields) || saved.createdAt !== saved.updatedAt || !history ||
              history.fields_json !== JSON.stringify(fields) || history.created_at !== saved.createdAt || revisions !== 1) {
              return failure('这个入库标识已有不同内容或后续修订，本次没有覆盖；请保留输入并核对全局资料。')
            }
          }
          return { entry, fields, saved }
        })
        const fresh = entries.filter((entry) => !entry.saved)
        const total = (db.prepare('SELECT COUNT(*) AS total FROM inspirations').get() as { total: number }).total
        if (fresh.length && total + fresh.length > 10_000) return failure('全局资料最多支持 10,000 条，本次整批没有写入。', 'INVALID_INPUT')
        const now = new Date().toISOString()
        // 来源检查、新条目和不可变历史共用一个立即事务；任一条失败都会撤回本批新增。
        const items = entries.map(({ entry, fields, saved }): InspirationItem => {
          if (saved) return saved
          db.prepare(`INSERT INTO inspirations (id, revision, kind, title, body, source, tags_json, parent_id, book_id, archived, created_at, updated_at)
            VALUES (@id, 1, @kind, @title, @body, @source, @tags, @parentId, NULL, 0, @now, @now)`)
            .run({ id: entry.id, kind: fields.kind, title: fields.title, body: fields.body, source: fields.source,
              tags: JSON.stringify(fields.tags), parentId: fields.parentId, now })
          db.prepare('INSERT INTO inspiration_revisions (id, revision, fields_json, created_at) VALUES (?, 1, ?, ?)')
            .run(entry.id, JSON.stringify(fields), now)
          return { ...fields, id: entry.id, revision: 1, createdAt: now, updatedAt: now, thumbnail: null }
        })
        return { bookId: data.bookId, runId: data.runId, items }
      }).immediate()
    } catch (error) {
      if (error instanceof DomainError) throw error
      return failure('拆书结果入库失败，请保留当前审阅内容并核对原请求。', 'STORAGE_ERROR')
    }
  }
}
