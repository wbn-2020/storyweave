import { DomainError, isRecord, requiredId, requiredInteger, requiredText, optionalText, type ServiceRequest, type TextEncoding, type TextSplitMode } from '../contracts/api'
import { parseManuscript } from '../contracts/manuscript'
import { MAX_DRAFT_FILE_BYTES, parseDraftFile } from '../contracts/draft'
import { parseCreateKnowledgeItem, parseKnowledgeItemInput, parseKnowledgeStatusInput, parseListKnowledgeItems, parseUpdateKnowledgeItem, parseUpgradeKnowledgeInput } from '../contracts/knowledge'
import { parseCreateStoryRecord, parseListStoryRecords, parseStoryRecordInput, parseStoryRevisionInput, parseUpdateStoryRecord } from '../contracts/story'
import { parseStoryTimelineInput } from '../contracts/story-timeline'
import { parseStoryGalaxyInput } from '../contracts/story-galaxy'
import { parseCreateNoteInput, parseListNotesInput, parseNoteInput, parsePromoteNoteInput, parseUpdateNoteInput } from '../contracts/notes'
import { parseMemoryBookInput, parseMemoryControlInput, parseMemoryEvidenceInput, parseMemorySearchInput, parseMemoryStartInput, parseMemoryTaskInput } from '../contracts/memory'
import { parseAiAdoptInput, parseAiBookInput, parseAiCheckpointInput, parseAiConnectionSaveInput, parseAiFinishInput, parseAiListInput, parseAiMemoryAdoptInput, parseAiPrepareServiceInput, parseAiRunInput, parseAiStartInput, parseAiVersionInput } from '../contracts/ai'
import { parseAiMemoryTaskControlInput, parseAiMemoryTaskInput, parseAiMemoryTaskReadInput, parseAiMemoryTaskStartInput } from '../contracts/ai-memory-task'
import { parseAiMemoryMaintenanceInput } from '../contracts/ai-memory-maintenance'
import { parseAiSummaryAdoptInput, parseAiSummaryControlInput, parseAiSummaryNodeInput, parseAiSummaryReadInput, parseAiSummaryStartInput, parseAiSummaryTaskInput } from '../contracts/ai-summary'
import { parseAiContextSummaryInput } from '../contracts/ai-context-summary'
import { parseAiContextRecommendationInput } from '../contracts/ai-context-recommendation'
import { parseMemoryVectorFinishInput, parseMemoryVectorPrepareServiceInput, parseMemoryVectorProfileServiceInput, parseMemoryVectorReadInput, parseMemoryVectorStartInput, parseMemoryVectorVersionInput } from '../contracts/memory-vector'
import { parseBookRecoveryExportServiceInput, parseBookRecoveryPrepareInput, parseBookRecoveryRestoreInput } from '../contracts/book-recovery'

export function parseServiceRequest(value: unknown): ServiceRequest {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length > 64) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '请求格式无效。' })
  }
  const id = requiredId(value.id)
  const command = value.command
  const payload = value.payload
  if (command === 'workspace.get' || command === 'service.close' || command === 'workspace.orphans') {
    if (payload !== undefined) throw invalidRequest()
    return { id, command, payload: undefined }
  }
  if (!isRecord(payload)) throw invalidRequest()
  switch (command) {
    case 'recovery.export': return { id, command, payload: parseBookRecoveryExportServiceInput(payload) }
    case 'recovery.prepare': return { id, command, payload: parseBookRecoveryPrepareInput(payload) }
    case 'recovery.restore': return { id, command, payload: parseBookRecoveryRestoreInput(payload) }
    case 'ai.connection.list': return { id, command, payload: parseAiBookInput(payload) }
    case 'ai.connection.save': return { id, command, payload: parseAiConnectionSaveInput(payload) }
    case 'ai.list': return { id, command, payload: parseAiListInput(payload) }
    case 'ai.get': return { id, command, payload: parseAiRunInput(payload) }
    case 'ai.prepare': return { id, command, payload: parseAiPrepareServiceInput(payload) }
    case 'ai.context.summaries': return { id, command, payload: parseAiContextSummaryInput(payload) }
    case 'ai.context.recommend': return { id, command, payload: parseAiContextRecommendationInput(payload) }
    case 'ai.claim': return { id, command, payload: parseAiStartInput(payload) }
    case 'ai.checkpoint': return { id, command, payload: parseAiCheckpointInput(payload) }
    case 'ai.finish': return { id, command, payload: parseAiFinishInput(payload) }
    case 'ai.reject': return { id, command, payload: parseAiVersionInput(payload) }
    case 'ai.interrupt': return { id, command, payload: parseAiVersionInput(payload) }
    case 'ai.adopt': return { id, command, payload: parseAiAdoptInput(payload) }
    case 'ai.memory.adopt': return { id, command, payload: parseAiMemoryAdoptInput(payload) }
    case 'ai.task.status': return { id, command, payload: parseAiBookInput(payload) }
    case 'ai.task.maintenance': return { id, command, payload: parseAiMemoryMaintenanceInput(payload) }
    case 'ai.task.get': return { id, command, payload: parseAiMemoryTaskReadInput(payload) }
    case 'ai.task.start': return { id, command, payload: parseAiMemoryTaskStartInput(payload) }
    case 'ai.task.step': return { id, command, payload: parseAiMemoryTaskInput(payload) }
    case 'ai.task.control': return { id, command, payload: parseAiMemoryTaskControlInput(payload) }
    case 'ai.summary.status': return { id, command, payload: parseAiBookInput(payload) }
    case 'ai.summary.get': return { id, command, payload: parseAiSummaryReadInput(payload) }
    case 'ai.summary.node': return { id, command, payload: parseAiSummaryNodeInput(payload) }
    case 'ai.summary.start': return { id, command, payload: parseAiSummaryStartInput(payload) }
    case 'ai.summary.step': return { id, command, payload: parseAiSummaryTaskInput(payload) }
    case 'ai.summary.control': return { id, command, payload: parseAiSummaryControlInput(payload) }
    case 'ai.summary.adopt': return { id, command, payload: parseAiSummaryAdoptInput(payload) }
    case 'memory.status': return { id, command, payload: parseMemoryBookInput(payload) }
    case 'memory.start': return { id, command, payload: parseMemoryStartInput(payload) }
    case 'memory.step': return { id, command, payload: parseMemoryTaskInput(payload) }
    case 'memory.control': return { id, command, payload: parseMemoryControlInput(payload) }
    case 'memory.search': return { id, command, payload: parseMemorySearchInput(payload) }
    case 'memory.evidence': return { id, command, payload: parseMemoryEvidenceInput(payload) }
    case 'memory.vector.status': return { id, command, payload: parseMemoryVectorProfileServiceInput(payload) }
    case 'memory.vector.get': return { id, command, payload: parseMemoryVectorReadInput(payload) }
    case 'memory.vector.prepare': return { id, command, payload: parseMemoryVectorPrepareServiceInput(payload) }
    case 'memory.vector.claim': return { id, command, payload: parseMemoryVectorStartInput(payload) }
    case 'memory.vector.finish': return { id, command, payload: parseMemoryVectorFinishInput(payload) }
    case 'memory.vector.cancel': return { id, command, payload: parseMemoryVectorVersionInput(payload) }
    case 'memory.vector.interrupt': return { id, command, payload: parseMemoryVectorVersionInput(payload) }
    case 'story.list': return { id, command, payload: parseListStoryRecords(payload) }
    case 'story.timeline': return { id, command, payload: parseStoryTimelineInput(payload) }
    case 'story.galaxy': return { id, command, payload: parseStoryGalaxyInput(payload) }
    case 'story.get': return { id, command, payload: parseStoryRecordInput(payload) }
    case 'story.revision': return { id, command, payload: parseStoryRevisionInput(payload) }
    case 'story.create': return { id, command, payload: parseCreateStoryRecord(payload) }
    case 'story.update': return { id, command, payload: parseUpdateStoryRecord(payload) }
    case 'knowledge.status': return { id, command, payload: parseKnowledgeStatusInput(payload) }
    case 'knowledge.upgrade': return { id, command, payload: parseUpgradeKnowledgeInput(payload) }
    case 'knowledge.list': return { id, command, payload: parseListKnowledgeItems(payload) }
    case 'knowledge.get': return { id, command, payload: parseKnowledgeItemInput(payload) }
    case 'knowledge.create': return { id, command, payload: parseCreateKnowledgeItem(payload) }
    case 'knowledge.update': return { id, command, payload: parseUpdateKnowledgeItem(payload) }
    case 'notes.list': return { id, command, payload: parseListNotesInput(payload) }
    case 'notes.get': return { id, command, payload: parseNoteInput(payload) }
    case 'notes.create': return { id, command, payload: parseCreateNoteInput(payload) }
    case 'notes.update': return { id, command, payload: parseUpdateNoteInput(payload) }
    case 'notes.promote': return { id, command, payload: parsePromoteNoteInput(payload) }
    case 'workspace.open':
      return { id, command, payload: { rootPath: requiredText(payload.rootPath, '书库目录', 32767) } }
    case 'book.create':
      return { id, command, payload: { title: requiredText(payload.title, '作品名称', 120) } }
    case 'book.get':
      return { id, command, payload: { bookId: requiredId(payload.bookId) } }
    case 'chapter.create':
      return { id, command, payload: { bookId: requiredId(payload.bookId), title: requiredText(payload.title, '章节名称', 120), volumeId: payload.volumeId === undefined ? undefined : payload.volumeId === null ? null : requiredId(payload.volumeId) } }
    case 'chapter.read':
      return { id, command, payload: { bookId: requiredId(payload.bookId), chapterId: requiredId(payload.chapterId) } }
    case 'chapter.save':
      return {
        id, command,
        payload: {
          bookId: requiredId(payload.bookId),
          chapterId: requiredId(payload.chapterId),
          expectedRevisionId: requiredId(payload.expectedRevisionId),
          document: parseManuscript(payload.document),
        },
      }
    case 'book.update':
      return { id, command, payload: {
        bookId: requiredId(payload.bookId), expectedBookRevision: requiredInteger(payload.expectedBookRevision, '作品版本'),
        title: requiredText(payload.title, '作品名称', 120), genre: optionalText(payload.genre, '作品类型', 120),
        synopsis: optionalText(payload.synopsis, '作品简介', 20_000), archived: requiredBoolean(payload.archived),
      } }
    case 'volume.create':
      return { id, command, payload: { bookId: requiredId(payload.bookId), expectedBookRevision: requiredInteger(payload.expectedBookRevision, '作品版本'), title: requiredText(payload.title, '卷名称', 120) } }
    case 'volume.rename':
      return { id, command, payload: { bookId: requiredId(payload.bookId), expectedBookRevision: requiredInteger(payload.expectedBookRevision, '作品版本'), volumeId: requiredId(payload.volumeId), title: requiredText(payload.title, '卷名称', 120) } }
    case 'volume.reorder':
      return { id, command, payload: { bookId: requiredId(payload.bookId), expectedBookRevision: requiredInteger(payload.expectedBookRevision, '作品版本'), volumeIds: requiredIdList(payload.volumeIds, '卷顺序') } }
    case 'chapter.reorder':
      return { id, command, payload: { bookId: requiredId(payload.bookId), expectedBookRevision: requiredInteger(payload.expectedBookRevision, '作品版本'), chapterIds: requiredIdList(payload.chapterIds, '章节顺序') } }
    case 'chapter.update':
      return { id, command, payload: {
        bookId: requiredId(payload.bookId), chapterId: requiredId(payload.chapterId), expectedBookRevision: requiredInteger(payload.expectedBookRevision, '作品版本'),
        title: requiredText(payload.title, '章节名称', 120), volumeId: payload.volumeId === null ? null : requiredId(payload.volumeId), goal: optionalText(payload.goal, '章节目标', 10_000), viewpoint: optionalText(payload.viewpoint, '叙事视角', 500),
        targetCharacters: payload.targetCharacters === null ? null : requiredInteger(payload.targetCharacters, '目标字数', 1_000_000), notes: optionalText(payload.notes, '章节备注', 20_000), status: parseChapterStatus(payload.status),
      } }
    case 'chapter.finalize':
      return { id, command, payload: { bookId: requiredId(payload.bookId), chapterId: requiredId(payload.chapterId), expectedBookRevision: requiredInteger(payload.expectedBookRevision, '作品版本'), expectedRevisionId: requiredId(payload.expectedRevisionId) } }
    case 'revision.list':
      return { id, command, payload: { bookId: requiredId(payload.bookId), chapterId: requiredId(payload.chapterId), beforeSequence: payload.beforeSequence === undefined ? undefined : requiredInteger(payload.beforeSequence, '版本序号') } }
    case 'revision.read':
      return { id, command, payload: { bookId: requiredId(payload.bookId), chapterId: requiredId(payload.chapterId), revisionId: requiredId(payload.revisionId) } }
    case 'revision.restore':
      return { id, command, payload: { bookId: requiredId(payload.bookId), chapterId: requiredId(payload.chapterId), revisionId: requiredId(payload.revisionId), expectedRevisionId: requiredId(payload.expectedRevisionId) } }
    case 'workspace.register':
      return { id, command, payload: { bookId: requiredId(payload.bookId) } }
    case 'import.prepare':
      return { id, command, payload: { filePath: requiredText(payload.filePath, '导入文件', 32767), encoding: parseEncoding(payload.encoding), splitMode: parseSplitMode(payload.splitMode) } }
    case 'import.reparse':
      return { id, command, payload: { token: requiredId(payload.token), encoding: parseEncoding(payload.encoding), splitMode: parseSplitMode(payload.splitMode) } }
    case 'import.chapter':
      return { id, command, payload: { token: requiredId(payload.token), index: requiredInteger(payload.index, '章节序号', 20_000) } }
    case 'import.commit':
      return { id, command, payload: { token: requiredId(payload.token), title: requiredText(payload.title, '作品名称', 120) } }
    case 'draft.import': {
      if (!(payload.sourceBytes instanceof Uint8Array) || payload.sourceBytes.byteLength > MAX_DRAFT_FILE_BYTES) throw invalidRequest()
      parseDraftFile(payload.sourceBytes)
      return { id, command, payload: {
        bookId: requiredId(payload.bookId), expectedBookRevision: requiredInteger(payload.expectedBookRevision, '作品版本'),
        title: requiredText(payload.title, '新章节名称', 120), sourceName: requiredText(payload.sourceName, '来源文件名', 255), sourceBytes: payload.sourceBytes,
      } }
    }
    case 'book.export':
      return { id, command, payload: {
        bookId: requiredId(payload.bookId), expectedBookRevision: requiredInteger(payload.expectedBookRevision, '作品版本'), format: parseExportFormat(payload.format), scope: parseExportScope(payload.scope), includeChapterTitles: requiredBoolean(payload.includeChapterTitles), filePath: requiredText(payload.filePath, '导出文件', 32767),
      } }
    default:
      throw invalidRequest()
  }
}

function requiredIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 20_000) throw new DomainError({ code: 'INVALID_INPUT', message: `${label}无效。` })
  return value.map((item) => requiredId(item).toLowerCase())
}
function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DomainError({ code: 'INVALID_INPUT', message: '布尔选项格式无效。' })
  return value
}
function parseChapterStatus(value: unknown): 'planned' | 'writing' | 'review' {
  if (value !== 'planned' && value !== 'writing' && value !== 'review') throw new DomainError({ code: 'INVALID_INPUT', message: '章节状态无效。' })
  return value
}
function parseEncoding(value: unknown): TextEncoding {
  if (value !== 'utf-8' && value !== 'utf-16le' && value !== 'utf-16be' && value !== 'gb18030') throw new DomainError({ code: 'INVALID_INPUT', message: '文本编码无效。' })
  return value
}
function parseSplitMode(value: unknown): TextSplitMode {
  if (value !== 'none' && value !== 'headings') throw new DomainError({ code: 'INVALID_INPUT', message: '分章模式无效。' })
  return value
}
function parseExportFormat(value: unknown): 'txt' | 'markdown' {
  if (value !== 'txt' && value !== 'markdown') throw new DomainError({ code: 'INVALID_INPUT', message: '导出格式无效。' })
  return value
}
function parseExportScope(value: unknown): 'working' | 'finalized' {
  if (value !== 'working' && value !== 'finalized') throw new DomainError({ code: 'INVALID_INPUT', message: '导出范围无效。' })
  return value
}

function invalidRequest(): DomainError {
  return new DomainError({ code: 'INVALID_INPUT', message: '请求命令或参数无效。' })
}
