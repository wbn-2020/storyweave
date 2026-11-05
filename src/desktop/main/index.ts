import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLOSE_CANCELLED_CHANNEL, CLOSE_REQUEST_CHANNEL, CLOSE_RESPONSE_CHANNEL, DomainError, IPC_CHANNEL, failure, isRecord, requiredId, type CompletedRequest, type RendererCommand } from '../../contracts/api'
import { parseServiceRequest } from '../request-validation'
import { ServiceClient } from './service-client'
import { parseDraftCopy, saveDraftCopy } from './draft-copy'

let mainWindow: BrowserWindow | null = null
let service: ServiceClient | null = null
let expectedRendererUrl = ''
let closing = false
let draining = false
let shutdownAuthorized = false
let choosingFile = false
let restarting = false
let rememberedWorkspaceRoot: string | null = null
let recoveryService: ServiceClient | null = null
let recoveredInstance: ServiceClient | null = null
let recoveryRequestId: string | null = null
const previousReceipts = new Map<string, CompletedRequest>()
let closeResponse: { id: string; resolve: (value: boolean) => void } | null = null

const rendererCommands = new Set<RendererCommand>([
  'workspace.get', 'workspace.select', 'book.create', 'book.get',
  'chapter.create', 'chapter.read', 'chapter.save', 'request.status',
  'book.update', 'volume.create', 'volume.rename', 'volume.reorder', 'chapter.reorder', 'chapter.update', 'chapter.finalize',
  'revision.list', 'revision.read', 'revision.restore', 'workspace.orphans', 'workspace.register',
  'import.select', 'import.reparse', 'import.chapter', 'import.commit', 'book.exportFile', 'draft.copy', 'service.restart',
])

function withoutHash(value: string): string {
  const url = new URL(value)
  url.hash = ''
  return url.href
}

function trustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false
  if (!event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame) return false
  try { return withoutHash(event.senderFrame.url) === expectedRendererUrl } catch { return false }
}

function rendererUrl(): string {
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!developmentUrl) return pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const url = new URL(developmentUrl)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('开发界面必须来自本机 HTTP 地址。')
  }
  return withoutHash(url.href)
}

function setupIpc(): void {
  ipcMain.handle(IPC_CHANNEL, async (event, command: unknown, payload: unknown) => {
    if (!trustedSender(event)) return failure('FORBIDDEN', '不允许来自此页面的请求。')
    if (typeof command !== 'string' || !rendererCommands.has(command as RendererCommand)) {
      return failure('INVALID_INPUT', '不支持此操作。')
    }
    try {
      if (command === 'request.status') {
        if (!isRecord(payload)) return failure('INVALID_INPUT', '原请求标识无效。')
        const requestId = requiredId(payload.requestId)
        const current = service?.getRequestStatus(requestId)
        const previous = previousReceipts.get(requestId)
        if (requestId === recoveryRequestId && current?.state === 'completed' && current.response.result.ok) {
          recoveryService = null
          recoveryRequestId = null
        }
        return { ok: true, data: current && current.state !== 'unknown' ? current : previous ? { state: 'completed', response: previous } : { state: 'unknown' } }
      }
      if (command === 'draft.copy') return await chooseDraftCopy(payload)
      if (command === 'service.restart') {
        if (payload !== undefined) return failure('INVALID_INPUT', '恢复服务不接受路径或重放请求。')
        if (closing || draining || choosingFile || restarting) return failure('WORKSPACE_BUSY', '请先完成当前操作，再恢复本地服务。')
        if (!service?.hasExited() && service !== recoveryService && service !== recoveredInstance) return failure('WORKSPACE_BUSY', '原服务尚未确认退出。不能重启或向活动服务重放未知操作。')
        restarting = true
        try {
          if (!service) return failure('SERVICE_UNAVAILABLE', '尚无可恢复的本地服务。')
          if (service.hasExited()) {
            rememberedWorkspaceRoot = service.getWorkspaceRoot() ?? rememberedWorkspaceRoot
            for (const [id, receipt] of service.takeReceipts()) previousReceipts.set(id, receipt)
            while (previousReceipts.size > 32) {
              const oldest = previousReceipts.keys().next().value
              if (oldest === undefined) break
              previousReceipts.delete(oldest)
            }
            service = new ServiceClient(join(__dirname, 'service.js'))
            recoveryService = service
            recoveredInstance = service
            recoveryRequestId = null
          }
          if (recoveryRequestId) {
            const status = service.getRequestStatus(recoveryRequestId)
            if (status.state !== 'completed') {
              return { ok: false, error: { code: 'REQUEST_TIMEOUT', requestId: recoveryRequestId, message: '书库重开结果尚未确认，请查询原恢复请求；本次没有重复执行。' } }
            }
            const response = status.response
            if (response.command !== 'workspace.open' && response.command !== 'workspace.get') return failure('SERVICE_UNAVAILABLE', '恢复请求身份不匹配，已保留当前稿件。')
            if (response.result.ok) {
              recoveryService = null
              recoveryRequestId = null
              return response.result
            }
            if (response.result.error.code === 'REQUEST_TIMEOUT' || response.result.error.code === 'SERVICE_UNAVAILABLE') return response.result
            recoveryRequestId = null
          }
          // 已恢复的实例只续读当前书库，允许界面在后续章节读取失败时重试，不再次重开或重放旧操作。
          if (service === recoveredInstance && recoveryService !== service) {
            return await service.request('workspace.get', undefined)
          }
          // 只有本次恢复创建的新进程可重试确定失败的重开，不重新启动仍活动的旧进程。
          const result = rememberedWorkspaceRoot
            ? await service.request('workspace.open', { rootPath: rememberedWorkspaceRoot })
            : await service.request('workspace.get', undefined)
          if (result.ok) {
            recoveryService = null
            recoveryRequestId = null
          } else {
            recoveryRequestId = result.error.requestId ?? null
          }
          return result
        } finally { restarting = false }
      }
      if (!service || draining) return failure('SERVICE_UNAVAILABLE', '本地作品服务正在关闭，请保留当前稿件。')
      if (restarting) return failure('WORKSPACE_BUSY', '本地服务正在恢复，本次操作未提交。')
      if (recoveryService === service) return failure('WORKSPACE_BUSY', '恢复进程尚未成功重开书库，请先完成恢复或查询原恢复请求。')
      if (choosingFile) return failure('WORKSPACE_BUSY', '请先完成当前文件选择，本次操作未提交。')
      if (closing && !['chapter.save', 'chapter.read', 'workspace.get'].includes(command)) {
        return failure('SERVICE_UNAVAILABLE', '正在保存并关闭，请等待当前操作完成。')
      }
      if (command === 'workspace.select') {
        if (payload !== undefined) return failure('INVALID_INPUT', '请选择本地书库目录。')
        if (choosingFile) return failure('WORKSPACE_BUSY', '已有一个文件选择窗口，请先完成该操作。')
        const target = mainWindow
        if (!target) return failure('SERVICE_UNAVAILABLE', '桌面窗口不可用。')
        choosingFile = true
        try {
          const selection = await dialog.showOpenDialog(target, {
            title: '选择作品数据目录',
            buttonLabel: '使用此目录',
            properties: ['openDirectory'],
          })
          if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, data: null }
          if (closing || draining) return failure('SERVICE_UNAVAILABLE', '正在关闭，未切换书库。')
          const result = await service.request('workspace.open', { rootPath: selection.filePaths[0]! })
          if (result.ok) rememberedWorkspaceRoot = result.data.rootPath
          return result
        } finally { choosingFile = false }
      }
      if (command === 'import.select') {
        if (!isRecord(payload)) return failure('INVALID_INPUT', '导入选项无效。')
        const validated = parseServiceRequest({ id: randomUUID(), command: 'import.prepare', payload: { ...payload, filePath: 'selected-by-native-dialog.txt' } })
        if (validated.command !== 'import.prepare') return failure('INVALID_INPUT', '导入选项无效。')
        if (choosingFile) return failure('WORKSPACE_BUSY', '请先完成当前文件选择。')
        const target = mainWindow
        if (!target) return failure('SERVICE_UNAVAILABLE', '桌面窗口不可用。')
        choosingFile = true
        try {
          const selection = await dialog.showOpenDialog(target, {
            title: '选择要导入的小说文本', buttonLabel: '预览导入', properties: ['openFile'],
            filters: [{ name: '小说文本', extensions: ['txt', 'md', 'markdown'] }],
          })
          if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, data: null }
          if (closing || draining) return failure('WORKSPACE_BUSY', '正在关闭，未读取导入文件。')
          return await service.request('import.prepare', { ...validated.payload, filePath: selection.filePaths[0]! })
        } finally { choosingFile = false }
      }
      if (command === 'book.exportFile') {
        if (!isRecord(payload)) return failure('INVALID_INPUT', '导出选项无效。')
        const validated = parseServiceRequest({ id: randomUUID(), command: 'book.export', payload: { ...payload, filePath: 'selected-by-native-dialog.txt' } })
        if (validated.command !== 'book.export') return failure('INVALID_INPUT', '导出选项无效。')
        if (choosingFile) return failure('WORKSPACE_BUSY', '请先完成当前文件选择。')
        const target = mainWindow
        if (!target) return failure('SERVICE_UNAVAILABLE', '桌面窗口不可用。')
        choosingFile = true
        try {
          const extension = validated.payload.format === 'markdown' ? 'md' : 'txt'
          const selection = await dialog.showSaveDialog(target, {
            title: '导出读者稿（仅新建文件）', buttonLabel: '创建导出文件',
            defaultPath: `作品导出-${Date.now()}.${extension}`,
            filters: [{ name: extension === 'md' ? 'Markdown 文本' : '纯文本', extensions: [extension] }],
          })
          if (selection.canceled || !selection.filePath) return { ok: true, data: null }
          if (closing || draining) return failure('WORKSPACE_BUSY', '正在关闭，未创建导出文件。')
          return await service.request('book.export', { ...validated.payload, filePath: selection.filePath })
        } finally { choosingFile = false }
      }
      const request = parseServiceRequest({ id: randomUUID(), command, payload })
      return await service.request(request.command, request.payload)
    } catch (error) {
      return error instanceof DomainError
        ? { ok: false, error: error.detail }
        : failure('SERVICE_UNAVAILABLE', '本地操作未完成，请保留当前稿件。')
    }
  })
  ipcMain.on(CLOSE_RESPONSE_CHANNEL, (event, requestId: unknown, ready: unknown) => {
    if (!trustedSender(event) || !closeResponse || requestId !== closeResponse.id) return
    closeResponse.resolve(ready === true)
  })
}

async function chooseDraftCopy(payload: unknown) {
  const draft = parseDraftCopy(payload)
  if (choosingFile || restarting || closing) return failure('WORKSPACE_BUSY', '请先完成当前操作，再另存草稿副本。')
  const target = mainWindow
  if (!target) return failure('SERVICE_UNAVAILABLE', '桌面窗口不可用。')
  choosingFile = true
  try {
    const selection = await dialog.showSaveDialog(target, {
      title: '另存单章草稿副本（不是完整作品备份）', buttonLabel: '创建草稿副本',
      defaultPath: `草稿副本-${Date.now()}.json`, filters: [{ name: '织章单章草稿', extensions: ['json'] }],
    })
    if (selection.canceled || !selection.filePath) return { ok: true as const, data: null }
    if (closing) return failure('WORKSPACE_BUSY', '正在关闭，未创建草稿副本。')
    return { ok: true as const, data: saveDraftCopy(selection.filePath, draft) }
  } finally { choosingFile = false }
}

function askRendererToSave(window: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    const id = randomUUID()
    const timer = setTimeout(() => finish(false), 45_000)
    const finish = (ready: boolean): void => {
      if (closeResponse?.id !== id) return
      clearTimeout(timer)
      closeResponse = null
      resolve(ready)
    }
    closeResponse = { id, resolve: finish }
    try {
      if (window.webContents.isDestroyed() || window.webContents.isCrashed()) finish(false)
      else window.webContents.send(CLOSE_REQUEST_CHANNEL, id)
    } catch { finish(false) }
  })
}

async function requestClose(): Promise<void> {
  const window = mainWindow
  if (!window || window.isDestroyed() || closing) return
  if (choosingFile || restarting) {
    try { window.webContents.send(CLOSE_CANCELLED_CHANNEL) } catch { /* 保留当前窗口和未完成操作。 */ }
    return
  }
  closing = true
  try {
    const ready = await askRendererToSave(window)
    if (!ready) {
      await dialog.showMessageBox(window, {
        type: 'warning', title: '窗口已保留', message: '尚未确认稿件已经保存。',
        detail: '请回到编辑器检查保存状态。若界面已失去响应，请先保留可见稿件再处理故障。', buttons: ['返回编辑器'],
      })
      return
    }
    draining = true
    const result = service ? await service.close() : failure('SERVICE_UNAVAILABLE', '本地作品服务不可用。')
    if (!result.ok) {
      draining = false
      await dialog.showMessageBox(window, {
        type: 'warning', title: '暂未关闭', message: '本地作品服务尚未确认安全关闭。',
        detail: result.error.message, buttons: ['保留窗口'],
      })
      return
    }
    shutdownAuthorized = true
    window.close()
    app.quit()
  } catch {
    // 关闭协调出错时仍保留窗口，不能把通信异常解释成保存成功。
    draining = false
  } finally {
    closing = false
    if (!shutdownAuthorized) {
      draining = false
      try {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(CLOSE_CANCELLED_CHANNEL)
      } catch { /* 失联的界面无法收到取消通知，主进程仍保留窗口。 */ }
    }
  }
}

function createWindow(): void {
  expectedRendererUrl = rendererUrl()
  const window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640,
    title: '织章 · StoryWeave', backgroundColor: '#131920', show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false,
    },
  })
  mainWindow = window
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.on('will-download', (event) => event.preventDefault())
  window.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) event.preventDefault()
  })
  window.on('close', (event) => {
    if (shutdownAuthorized) return
    event.preventDefault()
    void requestClose()
  })
  window.on('closed', () => { mainWindow = null })
  window.once('ready-to-show', () => window.show())
  void window.loadURL(expectedRendererUrl).catch(() => {
    window.show()
    void dialog.showMessageBox(window, { type: 'error', message: '工作室界面加载失败。', detail: '请检查应用文件和构建配置。', buttons: ['保留窗口'] })
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('before-quit', (event) => {
    if (shutdownAuthorized || !mainWindow) return
    event.preventDefault()
    void requestClose()
  })
  app.whenReady().then(() => {
    service = new ServiceClient(join(__dirname, 'service.js'))
    setupIpc()
    createWindow()
  }).catch(() => {
    dialog.showErrorBox('无法打开工作室', '桌面组件启动失败，请检查应用文件和依赖配置。')
    // 启动阶段没有打开书库，也没有编辑中的稿件。
    shutdownAuthorized = true
    app.quit()
  })
}
