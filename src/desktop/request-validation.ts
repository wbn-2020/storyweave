import { DomainError, isRecord, requiredId, requiredInteger, requiredText, optionalText, parseCreateBookInput, type ServiceRequest, type TextEncoding, type TextSplitMode } from '../contracts/api'
import { parseManuscript } from '../contracts/manuscript'
import { MAX_DRAFT_FILE_BYTES, parseDraftFile } from '../contracts/draft'
import { parseCreateKnowledgeItem, parseKnowledgeItemInput, parseKnowledgeStatusInput, parseListKnowledgeItems, parseUpdateKnowledgeItem, parseUpgradeKnowledgeInput } from '../contracts/knowledge'
import { parseCreateStoryRecord, parseListStoryRecords, parseStoryRecordInput, parseStoryRevisionInput, parseUpdateStoryRecord } from '../contracts/story'
import { parseStoryTimelineInput } from '../contracts/story-timeline'
import { parseStoryGalaxyInput } from '../contracts/story-galaxy'
import { parseWorldMapInput } from '../contracts/world-map'
import { parseAppearanceMatrixInput, parseForeshadowRadarInput } from '../contracts/story-control'
import { parseCreateNoteInput, parseListNotesInput, parseNoteInput, parsePromoteNoteInput, parseSetNoteChaptersInput, parseUpdateNoteInput } from '../contracts/notes'
import { parseReadNoteThumbnailInput } from '../contracts/note-thumbnail'
import { parseReadForeshadowThumbnailInput } from '../contracts/foreshadow-thumbnail'
import { parseReadInspirationThumbnailInput, parseUpgradeInspirationsInput } from '../contracts/inspiration-thumbnail'
import { parseMemoryBookInput, parseMemoryControlInput, parseMemoryEvidenceInput, parseMemorySearchInput, parseMemoryStartInput, parseMemoryTaskInput } from '../contracts/memory'
import { parseAiAdoptInput, parseAiBookInput, parseAiCheckpointInput, parseAiConnectionSaveInput, parseAiFinishInput, parseAiListInput, parseAiMemoryAdoptInput, parseAiPrepareServiceInput, parseAiRunInput, parseAiStartInput, parseAiVersionInput } from '../contracts/ai'
import { parseAiMemoryTaskControlInput, parseAiMemoryTaskInput, parseAiMemoryTaskReadInput, parseAiMemoryTaskStartInput } from '../contracts/ai-memory-task'
import { parseAiMemoryMaintenanceInput } from '../contracts/ai-memory-maintenance'
import { parseAiSummaryAdoptInput, parseAiSummaryControlInput, parseAiSummaryNodeInput, parseAiSummaryReadInput, parseAiSummaryStartInput, parseAiSummaryTaskInput } from '../contracts/ai-summary'
import { parseAiContextSummaryInput } from '../contracts/ai-context-summary'
import { parseAiContextRecommendationInput } from '../contracts/ai-context-recommendation'
import { parseMemoryVectorFinishInput, parseMemoryVectorPrepareServiceInput, parseMemoryVectorProfileServiceInput, parseMemoryVectorReadInput, parseMemoryVectorStartInput, parseMemoryVectorVersionInput } from '../contracts/memory-vector'
import { parseBookRecoveryExportServiceInput, parseBookRecoveryPrepareInput, parseBookRecoveryRestoreInput } from '../contracts/book-recovery'
import { parseCopyInspirationInput, parseListInspirationInput, parseLogWritingSessionInput, parseSaveBriefInput, parseSaveInspirationInput, parseSaveReviewIssueInput, parseSaveSceneInput, parseSaveWritingGoalInput, parseWorkbenchBookInput } from '../contracts/workbench'
import { parseApplyReviewIssueInput, parseReorderScenesInput } from '../contracts/workbench'
import { parseImportInspirationsInput } from '../contracts/workbench'
import { parseGetWritingCalendarInput, parseSaveCalendarEntryInput } from '../contracts/writing-calendar'
import { parseWeaveReadInput, parseWeaveMutationInput } from '../contracts/weave-system'
import { parseRealmReadInput, parseRealmMutationInput, parseRealmSimulationInput } from '../contracts/realm'
import { parseStudyAdoptInput, parseStudySavedInput } from '../contracts/study'
import { parseGetAiPresetsInput, parseSaveAiPresetInput } from '../contracts/ai-presets'
import { parseGetBookMediaInput, parseReadBookMediaInput, parseSaveBookMediaInput, parseExportBookMediaServiceInput } from '../contracts/book-media'
import { parseRevisionMergeInput } from '../contracts/revision-merge'
import { parseBookExportPrepareInput, parseBookExportChapterInput, parseBookExportCommitServiceInput } from '../contracts/export'
import { parseStudioAiConnectionInput, parseKickstartDraftInput, parseGenerationReadInput, parseGenerationPrepareInput, parseGenerationStartInput, parseGenerationCheckpointInput, parseGenerationFinishInput, parseGenerationVersionInput, parseGenerationSelectionInput, parseGenerationAdoptInput } from '../contracts/generation'
import { parseLivingAdoptInput, parseLivingPrepareInput, parseLivingRunInput, parseOutlineHistoryInput, parseRestoreOutlineInput, parseSaveOutlineInput, parseMemoryArchiveInput } from '../contracts/living'
import { parseForgeReadInput, parseForgePrepareInput, parseForgeRunInput, parseForgeAdoptInput } from '../contracts/forge'

export function parseServiceRequest(value: unknown): ServiceRequest {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length > 64) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '请求格式无效。' })
  }
  const id = requiredId(value.id)
  const command = value.command
  const payload = value.payload
  if (command === 'workspace.get' || command === 'service.close' || command === 'workspace.orphans' || command === 'generation.connections') {
    if (payload !== undefined) throw invalidRequest()
    return { id, command, payload: undefined }
  }
  if (!isRecord(payload)) throw invalidRequest()
  switch (command) {
    case 'living.get': return { id, command, payload: parseAiBookInput(payload) }
    case 'living.archive': return { id, command, payload: parseMemoryArchiveInput(payload) }
    case 'living.save': return { id, command, payload: parseSaveOutlineInput(payload) }
    case 'living.history': return { id, command, payload: parseOutlineHistoryInput(payload) }
    case 'living.restore': return { id, command, payload: parseRestoreOutlineInput(payload) }
    case 'living.prepare': return { id, command, payload: parseLivingPrepareInput(payload) }
    case 'living.run': return { id, command, payload: parseLivingRunInput(payload) }
    case 'living.adopt': return { id, command, payload: parseLivingAdoptInput(payload) }
    case 'forge.get': return { id, command, payload: parseForgeReadInput(payload) }
    case 'forge.prepare': return { id, command, payload: parseForgePrepareInput(payload) }
    case 'forge.run': return { id, command, payload: parseForgeRunInput(payload) }
    case 'forge.adopt': return { id, command, payload: parseForgeAdoptInput(payload) }
    case 'generation.connection.save': return { id, command, payload: parseStudioAiConnectionInput(payload) }
    case 'generation.draft': return { id, command, payload: parseKickstartDraftInput(payload) }
    case 'generation.get': return { id, command, payload: parseGenerationReadInput(payload) }
    case 'generation.prepare': return { id, command, payload: parseGenerationPrepareInput(payload) }
    case 'generation.claim': return { id, command, payload: parseGenerationStartInput(payload) }
    case 'generation.checkpoint': return { id, command, payload: parseGenerationCheckpointInput(payload) }
    case 'generation.finish': return { id, command, payload: parseGenerationFinishInput(payload) }
    case 'generation.interrupt': return { id, command, payload: parseGenerationVersionInput(payload) }
    case 'generation.select': return { id, command, payload: parseGenerationSelectionInput(payload) }
    case 'generation.adopt': return { id, command, payload: parseGenerationAdoptInput(payload) }
    case 'revision.merge': return { id, command, payload: parseRevisionMergeInput(payload) }
    case 'book.export.prepare': return { id, command, payload: parseBookExportPrepareInput(payload) }
    case 'book.export.chapter': return { id, command, payload: parseBookExportChapterInput(payload) }
    case 'book.export.commit': return { id, command, payload: parseBookExportCommitServiceInput(payload) }
    case 'workbench.get': return { id, command, payload: parseWorkbenchBookInput(payload) }
    case 'workbench.brief': return { id, command, payload: parseSaveBriefInput(payload) }
    case 'workbench.scene': return { id, command, payload: parseSaveSceneInput(payload) }
    case 'workbench.scenes.reorder': return { id, command, payload: parseReorderScenesInput(payload) }
    case 'workbench.issue': return { id, command, payload: parseSaveReviewIssueInput(payload) }
    case 'workbench.applyIssue': return { id, command, payload: parseApplyReviewIssueInput(payload) }
    case 'workbench.goal': return { id, command, payload: parseSaveWritingGoalInput(payload) }
    case 'workbench.session': return { id, command, payload: parseLogWritingSessionInput(payload) }
    case 'inspiration.list': return { id, command, payload: parseListInspirationInput(payload) }
    case 'inspiration.thumbnail': return { id, command, payload: parseReadInspirationThumbnailInput(payload) }
    case 'inspiration.upgrade': return { id, command, payload: parseUpgradeInspirationsInput(payload) }
    case 'inspiration.save': return { id, command, payload: parseSaveInspirationInput(payload) }
    case 'inspiration.copy': return { id, command, payload: parseCopyInspirationInput(payload) }
    case 'inspiration.import': return { id, command, payload: parseImportInspirationsInput(payload) }
    case 'calendar.get': return { id, command, payload: parseGetWritingCalendarInput(payload) }
    case 'calendar.save': return { id, command, payload: parseSaveCalendarEntryInput(payload) }
    case 'weave.get': return { id, command, payload: parseWeaveReadInput(payload) }
    case 'weave.mutate': return { id, command, payload: parseWeaveMutationInput(payload) }
    case 'realm.get': return { id, command, payload: parseRealmReadInput(payload) }
    case 'realm.mutate': return { id, command, payload: parseRealmMutationInput(payload) }
    case 'realm.simulate': return { id, command, payload: parseRealmSimulationInput(payload) }
    case 'study.adopt': return { id, command, payload: parseStudyAdoptInput(payload) }
    case 'study.saved': return { id, command, payload: parseStudySavedInput(payload) }
    case 'ai.presets.get': return { id, command, payload: parseGetAiPresetsInput(payload) }
    case 'ai.presets.save': return { id, command, payload: parseSaveAiPresetInput(payload) }
    case 'book.media.get': return { id, command, payload: parseGetBookMediaInput(payload) }
    case 'book.media.read': return { id, command, payload: parseReadBookMediaInput(payload) }
    case 'book.media.save': return { id, command, payload: parseSaveBookMediaInput(payload) }
    case 'book.media.export': return { id, command, payload: parseExportBookMediaServiceInput(payload) }
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
    case 'memory.vector.list': return { id, command, payload: parseMemoryBookInput(payload) }
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
    case 'story.worldMap': return { id, command, payload: parseWorldMapInput(payload) }
    case 'story.matrix': return { id, command, payload: parseAppearanceMatrixInput(payload) }
    case 'story.radar': return { id, command, payload: parseForeshadowRadarInput(payload) }
    case 'story.get': return { id, command, payload: parseStoryRecordInput(payload) }
    case 'story.thumbnail': return { id, command, payload: parseReadForeshadowThumbnailInput(payload) }
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
    case 'notes.thumbnail': return { id, command, payload: parseReadNoteThumbnailInput(payload) }
    case 'notes.create': return { id, command, payload: parseCreateNoteInput(payload) }
    case 'notes.update': return { id, command, payload: parseUpdateNoteInput(payload) }
    case 'notes.promote': return { id, command, payload: parsePromoteNoteInput(payload) }
    case 'notes.chapters': return { id, command, payload: parseSetNoteChaptersInput(payload) }
    case 'workspace.open':
      return { id, command, payload: { rootPath: requiredText(payload.rootPath, '书库目录', 32767) } }
    case 'book.create':
      return { id, command, payload: parseCreateBookInput(payload) }
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
