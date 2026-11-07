import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CLOSE_CANCELLED_CHANNEL, CLOSE_REQUEST_CHANNEL, CLOSE_RESPONSE_CHANNEL, IPC_CHANNEL, type Result, type StudioApi, type RendererCommand } from '../../contracts/api'

async function invoke<T>(command: RendererCommand, payload?: unknown): Promise<Result<T>> {
  try {
    return await ipcRenderer.invoke(IPC_CHANNEL, command, payload) as Result<T>
  } catch {
    return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '桌面连接已中断，请保留当前稿件。' } }
  }
}

let closeListener: ((_event: IpcRendererEvent, requestId: unknown) => void) | null = null
let cancelListener: (() => void) | null = null
const api: StudioApi = {
  getWorkspace: () => invoke('workspace.get'),
  selectWorkspace: () => invoke('workspace.select'),
  createBook: (input) => invoke('book.create', input),
  getBook: (input) => invoke('book.get', input),
  updateBook: (input) => invoke('book.update', input),
  createVolume: (input) => invoke('volume.create', input),
  renameVolume: (input) => invoke('volume.rename', input),
  reorderVolumes: (input) => invoke('volume.reorder', input),
  reorderChapters: (input) => invoke('chapter.reorder', input),
  updateChapter: (input) => invoke('chapter.update', input),
  finalizeChapter: (input) => invoke('chapter.finalize', input),
  createChapter: (input) => invoke('chapter.create', input),
  readChapter: (input) => invoke('chapter.read', input),
  saveChapter: (input) => invoke('chapter.save', input),
  listRevisions: (input) => invoke('revision.list', input),
  readRevision: (input) => invoke('revision.read', input),
  restoreRevision: (input) => invoke('revision.restore', input),
  findOrphanBooks: () => invoke('workspace.orphans'),
  registerOrphanBook: (input) => invoke('workspace.register', input),
  selectTextImport: (input) => invoke('import.select', input),
  reparseTextImport: (input) => invoke('import.reparse', input),
  readImportChapter: (input) => invoke('import.chapter', input),
  commitTextImport: (input) => invoke('import.commit', input),
  exportBook: (input) => invoke('book.exportFile', input),
  exportBookRecovery: (input) => invoke('recovery.exportFile', input),
  selectBookRecovery: () => invoke('recovery.select'),
  restoreBookRecovery: (input) => invoke('recovery.restore', input),
  saveDraftCopy: (input) => invoke('draft.copy', input),
  checkpointDraft: (input) => invoke('draft.checkpoint', input),
  listRecoveryDrafts: (input) => invoke('draft.list', input),
  selectDraftImport: (input) => invoke('draft.select', input),
  previewRecoveryDraft: (input) => invoke('draft.preview', input),
  commitDraftImport: (input) => invoke('draft.commit', input),
  getKnowledgeStatus: (input) => invoke('knowledge.status', input),
  upgradeKnowledge: (input) => invoke('knowledge.upgrade', input),
  listKnowledgeItems: (input) => invoke('knowledge.list', input),
  getKnowledgeItem: (input) => invoke('knowledge.get', input),
  createKnowledgeItem: (input) => invoke('knowledge.create', input),
  updateKnowledgeItem: (input) => invoke('knowledge.update', input),
  listNotes: (input) => invoke('notes.list', input),
  getNote: (input) => invoke('notes.get', input),
  createNote: (input) => invoke('notes.create', input),
  updateNote: (input) => invoke('notes.update', input),
  promoteNote: (input) => invoke('notes.promote', input),
  listStoryRecords: (input) => invoke('story.list', input),
  listStoryTimeline: (input) => invoke('story.timeline', input),
  listStoryGalaxy: (input) => invoke('story.galaxy', input),
  getStoryRecord: (input) => invoke('story.get', input),
  readStoryRevision: (input) => invoke('story.revision', input),
  createStoryRecord: (input) => invoke('story.create', input),
  updateStoryRecord: (input) => invoke('story.update', input),
  getMemoryStatus: (input) => invoke('memory.status', input),
  startMemoryTask: (input) => invoke('memory.start', input),
  stepMemoryTask: (input) => invoke('memory.step', input),
  controlMemoryTask: (input) => invoke('memory.control', input),
  searchMemory: (input) => invoke('memory.search', input),
  readMemoryEvidence: (input) => invoke('memory.evidence', input),
  getMemoryVectorStatus: (input) => invoke('memory.vector.status', input),
  getMemoryVectorRun: (input) => invoke('memory.vector.get', input),
  prepareMemoryVectorRun: (input) => invoke('memory.vector.prepare', input),
  startMemoryVectorRun: (input) => invoke('memory.vector.start', input),
  cancelMemoryVectorRun: (input) => invoke('memory.vector.cancel', input),
  interruptMemoryVectorRun: (input) => invoke('memory.vector.interrupt', input),
  listAiConnections: (input) => invoke('ai.connection.list', input),
  configureAiConnection: (input) => invoke('ai.configure', input),
  listAiRuns: (input) => invoke('ai.list', input),
  getAiRun: (input) => invoke('ai.get', input),
  prepareAiRun: (input) => invoke('ai.prepare', input),
  listAiContextSummaries: (input) => invoke('ai.context.summaries', input),
  recommendAiContext: (input) => invoke('ai.context.recommend', input),
  startAiRun: (input) => invoke('ai.start', input),
  cancelAiRun: (input) => invoke('ai.cancel', input),
  rejectAiRun: (input) => invoke('ai.reject', input),
  interruptAiRun: (input) => invoke('ai.interrupt', input),
  adoptAiRun: (input) => invoke('ai.adopt', input),
  adoptAiMemory: (input) => invoke('ai.memory.adopt', input),
  getAiMemoryTaskStatus: (input) => invoke('ai.task.status', input),
  listAiMemoryMaintenance: (input) => invoke('ai.task.maintenance', input),
  getAiMemoryTask: (input) => invoke('ai.task.get', input),
  startAiMemoryTask: (input) => invoke('ai.task.start', input),
  stepAiMemoryTask: (input) => invoke('ai.task.step', input),
  controlAiMemoryTask: (input) => invoke('ai.task.control', input),
  getAiSummaryStatus: (input) => invoke('ai.summary.status', input),
  getAiSummaryTask: (input) => invoke('ai.summary.get', input),
  getAiSummaryNode: (input) => invoke('ai.summary.node', input),
  startAiSummaryTask: (input) => invoke('ai.summary.start', input),
  stepAiSummaryTask: (input) => invoke('ai.summary.step', input),
  controlAiSummaryTask: (input) => invoke('ai.summary.control', input),
  adoptAiSummary: (input) => invoke('ai.summary.adopt', input),
  restartService: () => invoke('service.restart'),
  getRequestStatus: (input) => invoke('request.status', input),
  onCloseRequested: (handler) => {
    if (closeListener) ipcRenderer.removeListener(CLOSE_REQUEST_CHANNEL, closeListener)
    const listener = (_event: IpcRendererEvent, requestId: unknown): void => {
      if (typeof requestId !== 'string' || requestId.length > 64) return
      Promise.resolve().then(handler).then(
        (ready) => ipcRenderer.send(CLOSE_RESPONSE_CHANNEL, requestId, ready === true),
        () => ipcRenderer.send(CLOSE_RESPONSE_CHANNEL, requestId, false),
      )
    }
    closeListener = listener
    ipcRenderer.on(CLOSE_REQUEST_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(CLOSE_REQUEST_CHANNEL, listener)
      if (closeListener === listener) closeListener = null
    }
  },
  onCloseCancelled: (handler) => {
    if (cancelListener) ipcRenderer.removeListener(CLOSE_CANCELLED_CHANNEL, cancelListener)
    const listener = (): void => { handler() }
    cancelListener = listener
    ipcRenderer.on(CLOSE_CANCELLED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(CLOSE_CANCELLED_CHANNEL, listener)
      if (cancelListener === listener) cancelListener = null
    }
  },
}

contextBridge.exposeInMainWorld('storyweave', api)
