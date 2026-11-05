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
  saveDraftCopy: (input) => invoke('draft.copy', input),
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
