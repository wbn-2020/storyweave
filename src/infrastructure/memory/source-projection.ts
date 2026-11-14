import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredText } from '../../contracts/api'
import { MAX_KNOWLEDGE_SOURCES, parseKnowledgeFields } from '../../contracts/knowledge'
import { CHARACTER_ABILITIES, CHARACTER_ABILITY_LABELS, CHARACTER_PROFILE_FIELDS, CHARACTER_PROFILE_LABELS } from '../../contracts/character-profile'
import { countCharacters, documentToText, parseManuscript } from '../../contracts/manuscript'
import {
  MEMORY_CHUNK_OVERLAP, MEMORY_CHUNK_SIZE, MEMORY_SOURCE_KINDS, MEMORY_STEP_CHUNKS,
  type MemorySourceKind, type MemorySourceReference,
} from '../../contracts/memory'
import { parseStoryFields, plannedPayoffText, type Disclosure, type StoryRecordFields, type StoryTime } from '../../contracts/story'
import { toSearchText } from './search-text'
import { readKnowledgeAdjudicationContext } from '../knowledge/knowledge-repository'

export interface MemorySourceIdentity {
  sourceKind: MemorySourceKind
  sourceId: string
  revisionId: string
  title: string
}

export interface MemoryProjection extends MemorySourceReference {
  blocks: { blockId: string | null; text: string }[]
  entityIds: string[]
  chapterDependencies: { chapterId: string; revisionId: string }[]
  contentHash: string
}

export interface MemoryChunkCursor { blockIndex: number; offset: number }

interface ChapterRow {
  source_id: string; revision_id: string; title: string
  document_json: string; plain_text: string; content_hash: string; character_count: number
}

interface FieldsRow {
  source_id: string; revision_id: string; book_id: string; kind: string; fields_json: string
}

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '记忆来源快照或处理断点无效，请保留作品文件后重新整理。' })
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function timeText(time: StoryTime): string {
  if (time.kind === 'unknown') return '未知'
  return `${time.kind === 'date' ? '日期' : '相对时间'}：${time.label}${time.order === null ? '' : `；作者排序值：${time.order}`}`
}

function disclosureText(location: Disclosure): string {
  if (location.state !== 'located') return location.state === 'unknown' ? '未知' : '未披露'
  return `章节 ${location.chapterId}；修订 ${location.revisionId}；段落 ${location.blockId}`
}

const STORY_LABELS = { relation: '人物关系', event: '事件', foreshadow: '伏笔', cognition: '人物认知' } as const
const KNOWLEDGE_LABELS = { person: '人物', place: '地点', organization: '组织', object: '物品', rule: '规则', theme: '主题', other: '其他' } as const
const STAGE_LABELS = { planned: '计划', planted: '埋设', advanced: '推进', revealed: '揭示', resolved: '回收', abandoned: '放弃' } as const
const ATTITUDE_LABELS = { knows: '知道', believes: '相信', misunderstands: '误解', suspects: '怀疑' } as const

function storyText(fields: StoryRecordFields): { text: string; entityIds: string[] } {
  const lines = [fields.title, `记录类型：${STORY_LABELS[fields.kind]}`, fields.description, `读者披露：${disclosureText(fields.disclosure)}`]
  let entityIds: string[]
  // 仅使用快照中的文字与显式关联 ID，避免当前实体改名使同一修订的投影发生漂移。
  if (fields.kind === 'relation') {
    entityIds = [fields.fromEntityId, fields.toEntityId]
    lines.push(`起点实体：${fields.fromEntityId}`, `终点实体：${fields.toEntityId}`, `关系类型：${fields.relationType}`,
      `关系方向：${fields.direction === 'mutual' ? '双向' : '有向'}`, `有效起始：${timeText(fields.validFrom)}`,
      `有效截止：${timeText(fields.validUntil)}`)
    if (fields.startEventId) lines.push(`起始关联事件：${fields.startEventId}`)
    if (fields.endEventId) lines.push(`结束关联事件：${fields.endEventId}`)
  } else if (fields.kind === 'event') {
    entityIds = [...fields.participantIds, ...fields.mentionedEntityIds, ...fields.stateChanges.map((change) => change.entityId)]
    lines.push(`故事时间：${timeText(fields.storyTime)}`)
    if (fields.participantIds.length) lines.push(`显式参与实体：${fields.participantIds.join('、')}`)
    if (fields.mentionedEntityIds.length) lines.push(`仅被提及实体：${fields.mentionedEntityIds.join('、')}`)
    if (fields.appearanceCheck) {
      const check = fields.appearanceCheck
      entityIds.push(...check.absentEntityIds)
      lines.push(`作者整章核对（仅适用于固定稿）：章节 ${check.chapterId}；修订 ${check.revisionId}`,
        `明确缺席实体：${check.absentEntityIds.join('、')}`, check.note)
    }
    for (const change of fields.stateChanges) {
      lines.push(`状态变化记录：实体 ${change.entityId}；属性 ${change.attribute}`, `变化前：${change.before}`, `变化后：${change.after}`)
    }
  } else if (fields.kind === 'foreshadow') {
    entityIds = fields.entityIds
    lines.push(`故事时间：${timeText(fields.storyTime)}`, `伏笔阶段：${STAGE_LABELS[fields.stage]}`)
    if (fields.entityIds.length) lines.push(`关联实体：${fields.entityIds.join('、')}`)
    if (fields.eventIds.length) lines.push(`关联事件：${fields.eventIds.join('、')}`)
    lines.push(`计划回收位置：${plannedPayoffText(fields.plannedPayoff)}`, `实际回收位置：${disclosureText(fields.actualPayoff)}`)
    for (const milestone of fields.milestones) {
      lines.push(`伏笔里程碑：${STAGE_LABELS[milestone.stage]}；故事时间：${timeText(milestone.storyTime)}`,
        milestone.note, `里程碑披露：${disclosureText(milestone.disclosure)}`)
    }
  } else {
    entityIds = [fields.personId]
    // 人物的认知态度独立记录，不因参与事件、被提及或读者已知而补全为人物知道。
    lines.push(`认知主体：${fields.personId}`, `人物认知态度：${ATTITUDE_LABELS[fields.attitude]}`,
      `认知形成时间：${timeText(fields.storyTime)}`, `人物是否隐瞒：${fields.concealed ? '是' : '否'}`)
    if (fields.acquisitionEventId) lines.push(`获知关联事件：${fields.acquisitionEventId}`)
    if (fields.evolution) {
      const labels = { formed: '形成', revised: '修正', refuted: '推翻', concealed: '隐瞒', forgotten: '遗忘' }
      lines.push(`认知变化：${labels[fields.evolution.kind]}`, `认知有效截止：${timeText(fields.evolution.validUntil)}`)
      if (fields.evolution.previousId) lines.push(`前一认知状态：${fields.evolution.previousId}`)
      if (fields.evolution.knowledgeOrigin) lines.push(`转换来源：知识 ${fields.evolution.knowledgeOrigin.itemId}；修订 ${fields.evolution.knowledgeOrigin.revisionId}`)
    }
  }
  return { text: lines.filter((line) => line !== '').join('\n'), entityIds: Array.from(new Set(entityIds)) }
}

function chapterDependencies(db: Database.Database, kind: 'knowledge' | 'story', bookId: string, sourceId: string) {
  const sql = kind === 'knowledge'
    ? `SELECT s.chapter_id, s.revision_id, r.sequence FROM knowledge_sources s
       JOIN chapter_revisions r ON r.chapter_id = s.chapter_id AND r.id = s.revision_id
       WHERE s.book_id = ? AND s.item_id = ? AND s.source_type = 'chapter_text' LIMIT ?`
    : `SELECT s.chapter_id, s.revision_id, r.sequence FROM story_sources s
       JOIN chapter_revisions r ON r.chapter_id = s.chapter_id AND r.id = s.revision_id
       WHERE s.book_id = ? AND s.record_id = ? AND s.source_type = 'chapter_text' LIMIT ?`
  const rows = db.prepare(sql).all(bookId, sourceId, MAX_KNOWLEDGE_SOURCES + 1) as { chapter_id: string; revision_id: string; sequence: number }[]
  if (rows.length > MAX_KNOWLEDGE_SOURCES) throw storageFailure()
  const byChapter = new Map<string, { chapterId: string; revisionId: string; sequence: number }>()
  // 作者补充该章较新稿的固定引文，即推进该条目对该章的复核基线；旧引用仍完整保留。
  // 用不可变章节序号选择最新已引用修订，不用时间戳、UUID 或重新整理动作推测作者复核。
  for (const row of rows) {
    const chapterId = requiredId(row.chapter_id)
    const revisionId = requiredId(row.revision_id)
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) throw storageFailure()
    if ((byChapter.get(chapterId)?.sequence ?? 0) < row.sequence) byChapter.set(chapterId, { chapterId, revisionId, sequence: row.sequence })
  }
  return Array.from(byChapter.values(), ({ chapterId, revisionId }) => ({ chapterId, revisionId }))
}

export function readMemoryProjection(db: Database.Database, bookId: string, identity: MemorySourceIdentity): MemoryProjection {
  try {
    const source = { sourceKind: identity.sourceKind, sourceId: requiredId(identity.sourceId).toLowerCase(),
      revisionId: requiredId(identity.revisionId).toLowerCase(), title: requiredText(identity.title, '记忆来源标题', 120) }
    const book = requiredId(bookId).toLowerCase()
    if (!MEMORY_SOURCE_KINDS.includes(source.sourceKind) || source.title !== identity.title) throw storageFailure()
    const state = db.prepare('SELECT id FROM book_meta WHERE singleton = 1').get() as { id: string } | undefined
    if (state?.id !== book) throw storageFailure()

    if (source.sourceKind === 'chapter') {
      const row = db.prepare(`SELECT c.id AS source_id, r.id AS revision_id, c.title,
        r.document_json, r.plain_text, r.content_hash, r.character_count
        FROM chapter_revisions r JOIN chapters c ON c.id = r.chapter_id
        WHERE c.id = ? AND r.id = ?`).get(source.sourceId, source.revisionId) as ChapterRow | undefined
      if (!row || row.source_id !== source.sourceId || row.revision_id !== source.revisionId || row.title !== source.title) throw storageFailure()
      const document = parseManuscript(JSON.parse(row.document_json))
      // 校验存储的原始 JSON 字节摘要，不能用解析后重排字段的 JSON 代替原稿校验。
      if (hash(row.document_json) !== row.content_hash || documentToText(document) !== row.plain_text ||
          countCharacters(row.plain_text) !== row.character_count) throw storageFailure()
      // 正文出现位置不等于作者标注的读者披露，保持未知。
      return { ...source, nature: 'narrative_claim', authorDecision: null, freshness: 'current', conflictState: 'unchecked', readerDisclosure: { state: 'unknown' },
        contentHash: row.content_hash, entityIds: [], chapterDependencies: [], blocks: document.content.map((block) => ({
          blockId: block.attrs.id, text: block.type === 'horizontalRule' ? '' :
            (block.content ?? []).map((node) => node.type === 'hardBreak' ? '\n' : node.text).join(''),
        })) }
    }

    if (source.sourceKind === 'knowledge') {
      const row = db.prepare(`SELECT i.id AS source_id, r.id AS revision_id, i.book_id, i.kind, r.fields_json
        FROM knowledge_item_revisions r JOIN knowledge_items i ON i.id = r.item_id
        WHERE i.book_id = ? AND i.id = ? AND r.id = ?`).get(book, source.sourceId, source.revisionId) as FieldsRow | undefined
      if (!row || row.book_id !== book || row.source_id !== source.sourceId || row.revision_id !== source.revisionId) throw storageFailure()
      const fields = parseKnowledgeFields(JSON.parse(row.fields_json))
      if (fields.name !== source.title) throw storageFailure()
      const adjudication = readKnowledgeAdjudicationContext(db, book, source.sourceId, source.revisionId)
      // 知识条目的类型允许后续修改，历史投影始终以该修订内的类型为准。
      const text = [fields.name, `知识类型：${KNOWLEDGE_LABELS[fields.kind]}`,
        ...(fields.aliases.length ? [`别名：${fields.aliases.join('、')}`] : []), fields.summary,
        ...(adjudication ? [adjudication] : []),
        ...CHARACTER_PROFILE_FIELDS.flatMap((key) => fields.characterProfile?.[key] ? [`${CHARACTER_PROFILE_LABELS[key]}：${fields.characterProfile[key]}`] : []),
        ...CHARACTER_ABILITIES.flatMap((key) => fields.characterProfile?.abilities?.[key] === undefined ? [] : [`作者设定能力·${CHARACTER_ABILITY_LABELS[key]}：${fields.characterProfile.abilities[key]}/100`])]
        .filter((line) => line !== '').join('\n')
      // 一个合成块使 blockId=null 的偏移也能唯一回查；索引状态不回写作者的新鲜度。
      return { ...source, nature: fields.nature, authorDecision: fields.authorDecision, freshness: fields.freshness,
        conflictState: fields.conflictState, readerDisclosure: { state: 'unknown' },
        contentHash: hash(adjudication ? `${row.fields_json}\n${adjudication}` : row.fields_json), entityIds: [source.sourceId],
        chapterDependencies: chapterDependencies(db, 'knowledge', book, source.sourceId), blocks: [{ blockId: null, text }] }
    }

    const row = db.prepare(`SELECT s.id AS source_id, r.id AS revision_id, s.book_id, s.kind, r.fields_json
      FROM story_record_revisions r JOIN story_records s ON s.id = r.record_id
      WHERE s.book_id = ? AND s.id = ? AND r.id = ?`).get(book, source.sourceId, source.revisionId) as FieldsRow | undefined
    if (!row || row.book_id !== book || row.source_id !== source.sourceId || row.revision_id !== source.revisionId) throw storageFailure()
    const fields = parseStoryFields(JSON.parse(row.fields_json), book)
    if (fields.kind !== row.kind || fields.title !== source.title) throw storageFailure()
    const projected = storyText(fields)
    // 伏笔投影合并了计划回收和全部里程碑，首次披露不能证明整段内容已对读者公开。
    const readerDisclosure: Disclosure = fields.kind === 'foreshadow' ? { state: 'unknown' } : fields.disclosure
    return { ...source, nature: fields.nature, authorDecision: fields.authorDecision, freshness: fields.freshness,
      conflictState: fields.conflictState, readerDisclosure, contentHash: hash(row.fields_json), entityIds: projected.entityIds,
      chapterDependencies: chapterDependencies(db, 'story', book, source.sourceId),
      blocks: [{ blockId: null, text: projected.text }] }
  } catch { throw storageFailure() }
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

export function projectMemoryChunks(projection: MemoryProjection, cursor: MemoryChunkCursor, limit = MEMORY_STEP_CHUNKS): {
  chunks: { blockId: string | null; startOffset: number; endOffset: number; text: string; searchText: string }[]
  cursor: MemoryChunkCursor
  complete: boolean
} {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_STEP_CHUNKS ||
      !Number.isSafeInteger(cursor.blockIndex) || cursor.blockIndex < 0 || cursor.blockIndex > projection.blocks.length ||
      !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw storageFailure()
  const first = projection.blocks[cursor.blockIndex]
  if ((!first && cursor.offset !== 0) || (first && (cursor.offset > first.text.length || splitsSurrogate(first.text, cursor.offset)))) throw storageFailure()
  const next = { ...cursor }
  const chunks: { blockId: string | null; startOffset: number; endOffset: number; text: string; searchText: string }[] = []
  while (next.blockIndex < projection.blocks.length && chunks.length < limit) {
    const block = projection.blocks[next.blockIndex]!
    if (next.offset === block.text.length) { next.blockIndex += 1; next.offset = 0; continue }
    let end = Math.min(next.offset + MEMORY_CHUNK_SIZE, block.text.length)
    // UTF-16 偏移与正文锚点一致；边界落在有效代理对中间时向前退一个码元。
    if (splitsSurrogate(block.text, end)) end -= 1
    const text = block.text.slice(next.offset, end)
    chunks.push({ blockId: block.blockId, startOffset: next.offset, endOffset: end, text, searchText: toSearchText(text) })
    if (end === block.text.length) { next.blockIndex += 1; next.offset = 0 }
    else {
      // 长段落保留查询长度的重叠区，避免恰好跨分片的中文名字无法召回；偏移仍指向固定原文。
      let resume = end - MEMORY_CHUNK_OVERLAP
      if (splitsSurrogate(block.text, resume)) resume -= 1
      if (resume <= next.offset) throw storageFailure()
      next.offset = resume
    }
  }
  while (next.blockIndex < projection.blocks.length && projection.blocks[next.blockIndex]!.text.length === 0) next.blockIndex += 1
  return { chunks, cursor: next, complete: next.blockIndex === projection.blocks.length }
}
