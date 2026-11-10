import { DomainError, failure, isRecord, requiredId, type Result, type CommandMap, type ServiceCommand, type ServiceRequest } from '../../contracts/api'
import { KnowledgeRepository } from '../../infrastructure/knowledge/knowledge-repository'
import { StoryRepository } from '../../infrastructure/story/story-repository'
import { StoryTimelineRepository } from '../../infrastructure/story/timeline-repository'
import { StoryGalaxyRepository } from '../../infrastructure/story/galaxy-repository'
import { StoryControlRepository } from '../../infrastructure/story/control-repository'
import { NotesRepository } from '../../infrastructure/notes/notes-repository'
import { WorkbenchRepository } from '../../infrastructure/workbench/workbench-repository'
import { InspirationRepository } from '../../infrastructure/workbench/inspiration-repository'
import { WritingCalendarRepository } from '../../infrastructure/workbench/calendar-repository'
import { StudyRepository } from '../../infrastructure/workbench/study-repository'
import { AiPresetRepository } from '../../infrastructure/ai/preset-repository'
import { BookMediaRepository } from '../../infrastructure/workbench/media-repository'
import { MemoryRepository } from '../../infrastructure/memory/task-repository'
import { MemorySearchRepository } from '../../infrastructure/memory/search-repository'
import { MemoryVectorRepository } from '../../infrastructure/memory/vector-repository'
import { AiRepository } from '../../infrastructure/ai/ai-repository'
import { GenerationRepository } from '../../infrastructure/ai/generation-repository'
import { LivingRepository } from '../../infrastructure/workbench/living-repository'
import { ForgeRepository } from '../../infrastructure/workbench/forge-repository'
import { AiMemoryTaskRepository } from '../../infrastructure/ai/memory-task-repository'
import { AiSummaryRepository } from '../../infrastructure/ai/summary-repository'
import { AiContextSummaryRepository } from '../../infrastructure/ai/context-summary'
import { AiContextRecommendationRepository } from '../../infrastructure/ai/context-recommendation'
import { StudioRepository } from '../../infrastructure/storage/studio-repository'
import { BookRecoveryRepository } from '../../infrastructure/storage/book-recovery-repository'
import { BookExportRepository } from '../../infrastructure/storage/book-export'
import { mergeRevision } from '../../infrastructure/storage/revision-merge'
import { parseServiceRequest } from '../request-validation'
import { writeNewText } from '../file-access'
import { ImportSessions } from './import-sessions'

const parentPort = process.parentPort
if (!parentPort) throw new Error('作品服务只能由桌面主进程启动。')
const repository = new StudioRepository()
const knowledge = new KnowledgeRepository(repository)
const story = new StoryRepository(repository)
const timeline = new StoryTimelineRepository(repository)
const galaxy = new StoryGalaxyRepository(repository)
const control = new StoryControlRepository(repository)
const notes = new NotesRepository(repository)
const workbench = new WorkbenchRepository(repository)
const inspirations = new InspirationRepository(repository, notes)
const calendar = new WritingCalendarRepository(repository)
const memory = new MemoryRepository((bookId) => repository.getMemoryDatabase(bookId))
const memorySearch = new MemorySearchRepository((bookId) => repository.getMemoryDatabase(bookId), (input) => memory.status(input))
const memoryVectors = new MemoryVectorRepository((bookId) => repository.getMemoryDatabase(bookId), memorySearch)
const ai = new AiRepository(repository, memorySearch)
const living = new LivingRepository(repository, ai)
const forge = new ForgeRepository(repository, ai)
const generation = new GenerationRepository(repository)
const studies = new StudyRepository(repository, ai)
const presets = new AiPresetRepository(repository)
const media = new BookMediaRepository(repository)
const aiMemoryTasks = new AiMemoryTaskRepository(repository, ai)
const aiSummaries = new AiSummaryRepository(repository, ai)
const aiContextSummaries = new AiContextSummaryRepository(repository)
const aiContextRecommendations = new AiContextRecommendationRepository(repository, memorySearch, memoryVectors)
const imports = new ImportSessions(repository)
const bookRecovery = new BookRecoveryRepository(repository)
const bookExports = new BookExportRepository(repository)
type ServiceOutput = CommandMap[ServiceCommand]['output']
const MAX_PENDING_REQUESTS = 8
let pendingRequests = 0
let requestQueue = Promise.resolve()

async function dispatch(request: ServiceRequest): Promise<ServiceOutput> {
  switch (request.command) {
    case 'living.get': return living.get(request.payload)
    case 'living.archive': return living.archive(request.payload)
    case 'living.save': return living.save(request.payload)
    case 'living.history': return living.history(request.payload)
    case 'living.restore': return living.restore(request.payload)
    case 'living.prepare': return living.prepare(request.payload)
    case 'living.run': return living.getRun(request.payload)
    case 'living.adopt': return living.adopt(request.payload)
    case 'forge.get': return forge.get(request.payload)
    case 'forge.prepare': return forge.prepare(request.payload)
    case 'forge.run': return forge.getRun(request.payload)
    case 'forge.adopt': return forge.adopt(request.payload)
    case 'generation.connections': return generation.connections()
    case 'generation.connection.save': return generation.saveConnection(request.payload)
    case 'generation.draft': return generation.draft(request.payload)
    case 'generation.get': return generation.get(request.payload)
    case 'generation.prepare': return generation.prepare(request.payload)
    case 'generation.claim': return generation.claim(request.payload)
    case 'generation.checkpoint': return generation.checkpoint(request.payload)
    case 'generation.finish': return generation.finish(request.payload)
    case 'generation.interrupt': return generation.interrupt(request.payload)
    case 'generation.select': return generation.select(request.payload)
    case 'generation.adopt': return generation.adopt(request.payload)
    case 'revision.merge': return mergeRevision(repository, request.payload)
    case 'book.export.prepare': return bookExports.prepare(request.payload)
    case 'book.export.chapter': return bookExports.readChapter(request.payload)
    case 'book.export.commit': return bookExports.export(request.payload)
    case 'workbench.get': return workbench.get(request.payload)
    case 'workbench.brief': return workbench.saveBrief(request.payload)
    case 'workbench.scene': return workbench.saveScene(request.payload)
    case 'workbench.issue': return workbench.saveIssue(request.payload)
    case 'workbench.applyIssue': return workbench.applyIssue(request.payload)
    case 'workbench.goal': return workbench.saveGoal(request.payload)
    case 'workbench.session': return workbench.logSession(request.payload)
    case 'inspiration.list': return inspirations.list(request.payload)
    case 'inspiration.save': return inspirations.save(request.payload)
    case 'inspiration.copy': return inspirations.copyToNote(request.payload)
    case 'inspiration.import': return inspirations.importItems(request.payload)
    case 'calendar.get': return calendar.getWritingCalendar(request.payload)
    case 'calendar.save': return calendar.saveCalendarEntry(request.payload)
    case 'study.adopt': return studies.adopt(request.payload)
    case 'ai.presets.get': return presets.getAiPresets(request.payload)
    case 'ai.presets.save': return presets.saveAiPreset(request.payload)
    case 'book.media.get': return media.getBookMedia(request.payload)
    case 'book.media.read': return media.readBookMedia(request.payload)
    case 'book.media.save': return media.saveBookMedia(request.payload)
    case 'workspace.get': return repository.getWorkspace()
    case 'workspace.open': {
      const workspace = repository.openWorkspace(request.payload.rootPath)
      imports.clear()
      bookRecovery.clear()
      bookExports.clear()
      return workspace
    }
    case 'book.create': return repository.createBook(request.payload)
    case 'book.get': return repository.getBook(request.payload)
    case 'knowledge.status': return repository.getKnowledgeStatus(request.payload)
    case 'knowledge.upgrade': return repository.upgradeKnowledge(request.payload)
    case 'knowledge.list': return knowledge.listItems(request.payload)
    case 'knowledge.get': return knowledge.getItem(request.payload)
    case 'knowledge.create': return knowledge.createItem(request.payload)
    case 'knowledge.update': return knowledge.updateItem(request.payload)
    case 'notes.list': return notes.list(request.payload)
    case 'notes.get': return notes.get(request.payload)
    case 'notes.create': return notes.create(request.payload)
    case 'notes.update': return notes.update(request.payload)
    case 'notes.promote': return notes.promote(request.payload)
    case 'story.list': return story.listRecords(request.payload)
    case 'story.timeline': return timeline.list(request.payload)
    case 'story.galaxy': return galaxy.list(request.payload)
    case 'story.matrix': return control.matrix(request.payload)
    case 'story.radar': return control.radar(request.payload)
    case 'story.get': return story.getRecord(request.payload)
    case 'story.revision': return story.readRevision(request.payload)
    case 'story.create': return story.createRecord(request.payload)
    case 'story.update': return story.updateRecord(request.payload)
    case 'memory.status': return memory.status(request.payload)
    case 'memory.start': return memory.start(request.payload)
    case 'memory.step': return memory.step(request.payload)
    case 'memory.control': return memory.control(request.payload)
    case 'memory.search': return memorySearch.search(request.payload)
    case 'memory.evidence': return memorySearch.evidence(request.payload)
    case 'memory.vector.status': return memoryVectors.status(request.payload)
    case 'memory.vector.get': return memoryVectors.get(request.payload)
    case 'memory.vector.prepare': return memoryVectors.prepare(request.payload)
    case 'memory.vector.claim': return memoryVectors.claim(request.payload)
    case 'memory.vector.finish': return memoryVectors.finish(request.payload)
    case 'memory.vector.cancel': return memoryVectors.cancel(request.payload)
    case 'memory.vector.interrupt': return memoryVectors.interrupt(request.payload)
    case 'ai.connection.list': return ai.listConnections(request.payload)
    case 'ai.connection.save': return ai.saveConnection(request.payload)
    case 'ai.list': return ai.list(request.payload)
    case 'ai.get': return ai.get(request.payload)
    case 'ai.prepare': return ai.prepare(request.payload)
    case 'ai.context.summaries': return aiContextSummaries.list(request.payload)
    case 'ai.context.recommend': return aiContextRecommendations.recommend(request.payload)
    case 'ai.claim': return ai.claim(request.payload)
    case 'ai.checkpoint': return ai.checkpoint(request.payload)
    case 'ai.finish': return ai.finish(request.payload)
    case 'ai.reject': return ai.reject(request.payload)
    case 'ai.interrupt': return ai.interrupt(request.payload)
    case 'ai.adopt': return ai.adopt(request.payload)
    case 'ai.memory.adopt': return ai.adoptMemory(request.payload)
    case 'ai.task.status': return aiMemoryTasks.status(request.payload)
    case 'ai.task.maintenance': return aiMemoryTasks.maintenance(request.payload)
    case 'ai.task.get': return aiMemoryTasks.get(request.payload)
    case 'ai.task.start': return aiMemoryTasks.start(request.payload)
    case 'ai.task.step': return aiMemoryTasks.step(request.payload)
    case 'ai.task.control': return aiMemoryTasks.control(request.payload)
    case 'ai.summary.status': return aiSummaries.status(request.payload)
    case 'ai.summary.get': return aiSummaries.get(request.payload)
    case 'ai.summary.node': return aiSummaries.node(request.payload)
    case 'ai.summary.start': return aiSummaries.start(request.payload)
    case 'ai.summary.step': return aiSummaries.step(request.payload)
    case 'ai.summary.control': return aiSummaries.control(request.payload)
    case 'ai.summary.adopt': return aiSummaries.adopt(request.payload)
    case 'chapter.create': return repository.createChapter(request.payload)
    case 'chapter.read': return repository.readChapter(request.payload)
    case 'chapter.save': return repository.saveChapter(request.payload)
    case 'book.update': return repository.updateBook(request.payload)
    case 'volume.create': return repository.createVolume(request.payload)
    case 'volume.rename': return repository.renameVolume(request.payload)
    case 'volume.reorder': return repository.reorderVolumes(request.payload)
    case 'chapter.reorder': return repository.reorderChapters(request.payload)
    case 'chapter.update': return repository.updateChapter(request.payload)
    case 'chapter.finalize': return repository.finalizeChapter(request.payload)
    case 'revision.list': return repository.listRevisions(request.payload)
    case 'revision.read': return repository.readRevision(request.payload)
    case 'revision.restore': return repository.restoreRevision(request.payload)
    case 'workspace.orphans': return repository.findOrphanBooks()
    case 'workspace.register': return repository.registerOrphanBook(request.payload)
    case 'import.prepare': return imports.prepare(request.payload)
    case 'import.reparse': return imports.reparse(request.payload)
    case 'import.chapter': return imports.readChapter(request.payload)
    case 'import.commit': return imports.commit(request.payload)
    case 'draft.import': return repository.importDraft(request.payload)
    case 'recovery.export': return bookRecovery.export(request.payload)
    case 'recovery.prepare': return bookRecovery.prepare(request.payload)
    case 'recovery.restore': return bookRecovery.restore(request.payload)
    case 'book.export': {
      const output = writeNewText(request.payload.filePath, (write) => repository.exportBookText(request.payload, write))
      return { ...output.receipt, ...output.value }
    }
    case 'service.close': imports.clear(); bookRecovery.clear(); bookExports.clear(); repository.close(); return null
  }
}

function respond(id: string, result: Result<ServiceOutput>): void {
  try { parentPort.postMessage({ id, result }) }
  catch { /* 回执投递失败不能重放已经执行的写入，也不能阻断后续关闭请求。 */ }
}

parentPort.on('message', (event: { data: unknown }) => {
  let request: ServiceRequest
  try {
    request = parseServiceRequest(event.data)
  } catch (error) {
    // 只回传已校验的请求身份，非法参数不应让调用方等待到超时。
    try {
      if (!isRecord(event.data)) return
      const id = requiredId(event.data.id)
      const result: Result<ServiceOutput> = error instanceof DomainError
        ? { ok: false, error: error.detail }
        : failure('INVALID_INPUT', '请求格式无效。')
      respond(id, result)
    } catch { /* 没有合法身份的消息不参与响应。 */ }
    return
  }
  if (pendingRequests >= MAX_PENDING_REQUESTS) {
    respond(request.id, failure('WORKSPACE_BUSY', '本地作品服务正在处理其他操作，本次操作未执行，请稍后再试。'))
    return
  }
  pendingRequests += 1
  // 备份升级会异步等待；读写、切库和关闭都排队，避免共享数据库在等待期间被更换或关闭。
  requestQueue = requestQueue.then(async () => {
    let result: Result<ServiceOutput>
    try {
      result = { ok: true, data: await dispatch(request) }
    } catch (error) {
      result = error instanceof DomainError
        ? { ok: false, error: error.detail }
        : failure('STORAGE_ERROR', '本地数据操作失败，未确认保存成功，请保留当前稿件。')
    } finally {
      pendingRequests -= 1
    }
    respond(request.id, result)
  })
})

process.once('exit', () => {
  try { repository.close() } catch { /* 退出阶段不继续写入数据。 */ }
})
