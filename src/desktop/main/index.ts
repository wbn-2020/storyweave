import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLOSE_CANCELLED_CHANNEL, CLOSE_REQUEST_CHANNEL, CLOSE_RESPONSE_CHANNEL, DomainError, IPC_CHANNEL, failure, isRecord, requiredId, type CompletedRequest, type RendererCommand, type Result, type SaveChapterOutput, type WorkspaceSnapshot } from '../../contracts/api'
import { storageError, storageFailureReason } from '../../infrastructure/storage/storage-error'
import { parseServiceRequest } from '../request-validation'
import { checkedLocalDirectory } from '../file-access'
import { ServiceClient } from './service-client'
import { parseDraftCopy, saveDraftCopy } from './draft-copy'
import { DraftRecovery } from './draft-recovery'
import { DraftImports, parseDraftTarget } from './draft-imports'
import { AiSessions } from './ai-sessions'
import { GenerationSessions } from './generation-sessions'
import { ImageSessions } from './image-sessions'
import { ConnectionProbes } from './connection-probes'
import { parseConnectionProbeCancel, parseConnectionProbeInput } from '../../contracts/ai-connection-probe'
import { parseAiKeySessionClose, parseAiKeySessionInput } from '../../contracts/ai-key-session'
import type { AiConnectionPage } from '../../contracts/ai'
import { parseBookRecoveryExportInput, parseBookRecoveryRestoreInput } from '../../contracts/book-recovery'
import { bookExportExtension, parseBookExportFileInput, type BookExportReceipt } from '../../contracts/export'
import { parseExportBookMediaInput } from '../../contracts/book-media'

let mainWindow: BrowserWindow | null = null
let service: ServiceClient | null = null
let expectedRendererUrl = ''
let initialRendererLoadFailed = false
let rendererSessionStarted = false
let closing = false
let draining = false
let shutdownAuthorized = false
let choosingFile = false
let restarting = false
let pendingAiCommands = 0
let rememberedWorkspaceRoot: string | null = null
let recoveryService: ServiceClient | null = null
let recoveredInstance: ServiceClient | null = null
let recoveryRequestId: string | null = null
const previousReceipts = new Map<string, CompletedRequest>()
const exportedFiles = new Map<string, { root: string | null; filePath: string }>()
const exportDirectories = new Map<string, { root: string; directoryPath: string }>()
let closeResponse: { id: string; resolve: (value: boolean) => void } | null = null
let lastAiRecoveryNotice: string | null = null
const draftRecovery = new DraftRecovery()
const draftImports = new DraftImports()
const generationSessions = new GenerationSessions()
const connectionProbes = new ConnectionProbes()
const aiSessions = new AiSessions((root, connection) => generationSessions.sessionKey(root, connection))
const imageSessions = new ImageSessions()
let connectionKeyPage: { sessionId: string; root: string; bookId?: string } | null = null

function closeConnectionKeyPage(sessionId?: string): void {
  const page = connectionKeyPage
  // 旧页面的迟到卸载不能清除新页面会话；根目录固定于进入时，切库后也不会清错书库。
  if (!page || sessionId !== undefined && page.sessionId !== sessionId) return
  connectionKeyPage = null
  generationSessions.clearSessionKeys(page.root)
  if (page.bookId) aiSessions.clearSessionKeys(page.root, page.bookId)
  connectionProbes.abortAll()
}

const rendererCommands = new Set<RendererCommand>([
  'living.get', 'living.archive', 'living.save', 'living.history', 'living.restore', 'living.prepare', 'living.run', 'living.adopt',
  'forge.get', 'forge.prepare', 'forge.run', 'forge.adopt',
  'generation.connections', 'generation.configure', 'generation.draft', 'generation.get', 'generation.prepare',
  'generation.start', 'generation.cancel', 'generation.select', 'generation.adopt',
  'connection.probe', 'connection.probe.cancel',
  'connection.keys.open', 'connection.keys.close',
  'workspace.get', 'workspace.select', 'book.create', 'book.get', 'book.summary',
  'workbench.get', 'workbench.brief', 'workbench.scene', 'workbench.scenes.reorder', 'workbench.issue', 'workbench.applyIssue', 'workbench.goal', 'workbench.session',
  'inspiration.list', 'inspiration.thumbnail', 'inspiration.upgrade', 'inspiration.save', 'inspiration.copy', 'inspiration.import',
  'calendar.get', 'calendar.save',
  'weave.get', 'weave.mutate',
  'realm.get', 'realm.mutate', 'realm.simulate',
  'study.adopt', 'study.saved',
  'ai.presets.get', 'ai.presets.save',
  'book.media.get', 'book.media.read', 'book.media.save', 'book.media.exportFile',
  'book.image.list', 'book.image.get', 'book.image.start', 'book.image.cancel', 'book.image.discard',
  'chapter.create', 'chapter.read', 'chapter.save', 'request.status',
  'book.update', 'volume.create', 'volume.rename', 'volume.reorder', 'chapter.reorder', 'chapter.update', 'chapter.finalize',
  'revision.list', 'revision.read', 'revision.restore', 'workspace.orphans', 'workspace.register',
  'revision.merge', 'book.export.prepare', 'book.export.chapter', 'book.export.directory', 'book.export.commitFile', 'book.export.reveal',
  'import.select', 'import.reparse', 'import.chapter', 'import.commit', 'book.exportFile', 'draft.copy', 'service.restart',
  'recovery.exportFile', 'recovery.select', 'recovery.restore', 'recovery.catalog',
  'draft.checkpoint', 'draft.list', 'draft.rotate', 'draft.select', 'draft.preview', 'draft.commit',
  'knowledge.status', 'knowledge.upgrade', 'knowledge.list', 'knowledge.get', 'knowledge.create', 'knowledge.update',
  'notes.list', 'notes.get', 'notes.thumbnail', 'notes.create', 'notes.update', 'notes.promote', 'notes.chapters',
  'story.list', 'story.timeline', 'story.galaxy', 'story.worldMap', 'story.matrix', 'story.radar', 'story.get', 'story.thumbnail', 'story.revision', 'story.create', 'story.update',
  'memory.status', 'memory.start', 'memory.step', 'memory.control', 'memory.search', 'memory.evidence',
  'memory.vector.list', 'memory.vector.status', 'memory.vector.get', 'memory.vector.prepare', 'memory.vector.start', 'memory.vector.cancel', 'memory.vector.interrupt',
  'ai.connection.list', 'ai.configure', 'ai.list', 'ai.get', 'ai.prepare', 'ai.start', 'ai.cancel', 'ai.interrupt', 'ai.reject', 'ai.adopt',
  'ai.context.summaries', 'ai.context.recommend',
  'ai.memory.adopt',
  'ai.task.status', 'ai.task.maintenance', 'ai.task.get', 'ai.task.start', 'ai.task.step', 'ai.task.control',
  'ai.summary.status', 'ai.summary.get', 'ai.summary.node', 'ai.summary.start', 'ai.summary.step', 'ai.summary.control', 'ai.summary.adopt',
])

function createService(): ServiceClient {
  return new ServiceClient(join(__dirname, 'service.js'), (command, output, root) => {
    if (command === 'workspace.open' || command === 'workspace.get') {
      const snapshot = output as WorkspaceSnapshot
      rememberedWorkspaceRoot = snapshot.rootPath
      if (draftRecovery.bind(snapshot.rootPath)) draftImports.clear()
    } else if (command === 'chapter.save' || command === 'revision.merge') draftRecovery.saved(root, output as SaveChapterOutput)
    else if (command === 'book.export.commit') {
      const receipt = output as BookExportReceipt
      exportedFiles.set(receipt.exportId, { root, filePath: receipt.filePath })
      if (exportedFiles.size > 32) exportedFiles.delete(exportedFiles.keys().next().value!)
    }
  })
}

function workspaceResult<T extends WorkspaceSnapshot | null>(result: Result<T>): Result<T> {
  return result.ok && result.data !== null ? { ok: true, data: draftRecovery.attach(result.data) as T } : result
}

async function completeWorkspaceRead<T extends WorkspaceSnapshot | null>(client: ServiceClient, result: Result<T>): Promise<Result<T>> {
  if (result.ok && result.data?.rootPath && !closing && !draining) {
    const generationSettled = await generationSessions.restorePending(client)
    const settled = generationSettled.ok ? await aiSessions.restorePending(client) : generationSettled
    if (settled.ok) lastAiRecoveryNotice = null
    else {
      const notice = `${result.data.rootPath}:${settled.error.message}`
      if (notice !== lastAiRecoveryNotice && mainWindow && !mainWindow.isDestroyed()) {
        lastAiRecoveryNotice = notice
        await dialog.showMessageBox(mainWindow, { type: 'warning', title: '模型结果需要核对',
          message: '书库已打开，留存的模型结果尚未全部补存。',
          detail: `${settled.error.message} 请在原候选或向量任务中重新读取核对。不会再次向模型发送请求。`, buttons: ['返回工作室'] })
      }
    }
  }
  return workspaceResult(result)
}

function decorateReceipt(response: CompletedRequest): CompletedRequest {
  if (response.command === 'workspace.open' || response.command === 'workspace.get') return { ...response, result: workspaceResult(response.result) }
  return response
}

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

function checkedWorkspaceDirectory(path: string): string {
  if (!app.isPackaged || process.platform !== 'win32') return path
  try {
    const canonical = checkedLocalDirectory(path)
    const protectedDirectories = [
      checkedLocalDirectory(dirname(app.getPath('exe'))),
      checkedLocalDirectory(process.resourcesPath),
    ]
    // 安装目录与作品分离；按真实路径的目录段比较，避免误拦同名前缀的相邻目录。
    for (const directory of protectedDirectories) {
      const child = relative(directory.toLowerCase(), canonical.toLowerCase())
      if (child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep))) {
        throw new DomainError({ code: 'INVALID_INPUT', message: '应用安装目录、资源目录及其子目录不能用作书库，请选择这些目录之外的本地文件夹。' })
      }
    }
    return canonical
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError({ code: 'INVALID_INPUT', message: '无法核验书库或应用目录的本地真实路径，请确认目录存在、可访问且不是链接或网络位置。' })
  }
}

function setupIpc(): void {
  ipcMain.handle(IPC_CHANNEL, async (event, command: unknown, payload: unknown) => {
    if (!trustedSender(event)) return failure('FORBIDDEN', '不允许来自此页面的请求。')
    rendererSessionStarted = true
    if (typeof command !== 'string' || !rendererCommands.has(command as RendererCommand)) {
      return failure('INVALID_INPUT', '不支持此操作。')
    }
    try {
      if (command === 'book.export.reveal') {
        if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'exportId')) return failure('INVALID_INPUT', '导出标识无效。')
        const saved = exportedFiles.get(requiredId(payload.exportId))
        // 只定位本实例已确认、当前书库的导出回执；渲染层不能传入任意路径。
        if (!saved || !saved.root || saved.root !== service?.getWorkspaceRoot()) return failure('NOT_FOUND', '当前窗口没有这份导出的已确认记录，请在保存位置核对文件。')
        checkedLocalDirectory(dirname(saved.filePath))
        shell.showItemInFolder(saved.filePath)
        return { ok: true, data: null }
      }
      if (command === 'request.status') {
        if (!isRecord(payload)) return failure('INVALID_INPUT', '原请求标识无效。')
        const requestId = requiredId(payload.requestId)
        const current = service?.getRequestStatus(requestId)
        const previous = previousReceipts.get(requestId)
        if (requestId === recoveryRequestId && current?.state === 'completed' && current.response.result.ok) {
          recoveryService = null
          recoveryRequestId = null
        }
        const status = current && current.state !== 'unknown' ? current : previous ? { state: 'completed' as const, response: previous } : { state: 'unknown' as const }
        if (status.state === 'completed' && service && status.response.result.ok &&
            (status.response.command === 'workspace.open' || status.response.command === 'workspace.get') &&
            service.getWorkspaceRoot() === status.response.result.data?.rootPath) {
          await completeWorkspaceRead(service, status.response.result)
        }
        return { ok: true, data: status.state === 'completed' ? { ...status, response: decorateReceipt(status.response) } : status }
      }
      if (command === 'draft.copy') return await chooseDraftCopy(payload)
      if (command === 'connection.probe.cancel') {
        connectionProbes.cancel(parseConnectionProbeCancel(payload).requestId)
        return { ok: true, data: null }
      }
      // 释放内存不经过服务写入，关闭握手、切库或服务失联也不能阻止离页清理。
      if (command === 'connection.keys.close') {
        const input = parseAiKeySessionClose(payload)
        closeConnectionKeyPage(input.sessionId)
        return { ok: true, data: input }
      }
      // 检查点独立于业务进程；只有切库、关闭排空或恢复中才暂缓，防止保存到错误书库。
      if (command === 'draft.checkpoint' || command === 'draft.list' || command === 'draft.rotate') {
        if (choosingFile || restarting || draining) return failure('WORKSPACE_BUSY', '桌面正在切换或关闭，请稍后再处理草稿副本。')
        if (command === 'draft.rotate' && closing) return failure('WORKSPACE_BUSY', '正在关闭，请返回工作室后再建立检查点新代。')
        return { ok: true, data: command === 'draft.checkpoint' ? draftRecovery.checkpoint(payload)
          : command === 'draft.rotate' ? draftRecovery.rotate(payload) : draftRecovery.list(payload) }
      }
      if (command === 'service.restart') {
        if (payload !== undefined) return failure('INVALID_INPUT', '恢复服务不接受路径或重放请求。')
        // 已接收的模型结果保留在主进程，允许恢复已退出的服务后核对并补存。
        if (pendingAiCommands > 0 || aiSessions.hasActive(false) || generationSessions.hasActive(false) || imageSessions.hasActive(false)) return failure('WORKSPACE_BUSY', '请先处理 AI 请求并核对结束状态，再恢复本地服务。')
        if (closing || draining || choosingFile || restarting) return failure('WORKSPACE_BUSY', '请先完成当前操作，再恢复本地服务。')
        if (!service?.hasExited() && service !== recoveryService && service !== recoveredInstance) return failure('WORKSPACE_BUSY', '原服务尚未确认退出。不能重启或向活动服务重放未知操作。')
        restarting = true
        connectionProbes.abortAll()
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
            service = createService()
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
              return await completeWorkspaceRead(service, response.result)
            }
            if (response.result.error.code === 'REQUEST_TIMEOUT' || response.result.error.code === 'SERVICE_UNAVAILABLE') return response.result
            recoveryRequestId = null
          }
          // 已恢复的实例只续读当前书库，允许界面在后续章节读取失败时重试，不再次重开或重放旧操作。
          if (service === recoveredInstance && recoveryService !== service) {
            return await completeWorkspaceRead(service, await service.request('workspace.get', undefined))
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
          return await completeWorkspaceRead(service, result)
        } finally { restarting = false }
      }
      if (!service || draining) return failure('SERVICE_UNAVAILABLE', '本地作品服务正在关闭，请保留当前稿件。')
      if (restarting) return failure('WORKSPACE_BUSY', '本地服务正在恢复，本次操作未提交。')
      if (recoveryService === service) return failure('WORKSPACE_BUSY', '恢复进程尚未成功重开书库，请先完成恢复或查询原恢复请求。')
      if (choosingFile) return failure('WORKSPACE_BUSY', '请先完成当前文件选择，本次操作未提交。')
      if (closing && !['chapter.save', 'chapter.read', 'workspace.get'].includes(command)) {
        return failure('SERVICE_UNAVAILABLE', '正在保存并关闭，请等待当前操作完成。')
      }
      if (command === 'connection.keys.open') {
        const input = parseAiKeySessionInput(payload), root = service.getWorkspaceRoot()
        if (!root) return failure('WORKSPACE_REQUIRED', '请先选择作品库。')
        const bookId = input.scope === 'book' ? input.bookId : undefined
        if (connectionKeyPage?.sessionId === input.sessionId) {
          if (connectionKeyPage.root !== root || connectionKeyPage.bookId !== bookId) return failure('REVISION_CONFLICT', '模型页面范围已变化，请重新打开页面。')
        } else {
          closeConnectionKeyPage()
          connectionKeyPage = { sessionId: input.sessionId, root, bookId }
        }
        return { ok: true, data: { sessionId: input.sessionId } }
      }
      if (command === 'connection.probe') {
        const input = parseConnectionProbeInput(payload), client = service, root = client.getWorkspaceRoot()
        if (!root) return failure('WORKSPACE_REQUIRED', '请先选择作品库。')
        return await connectionProbes.run(root, input, async () => {
          // 先沿用原读取链路核对配置及迟到回执，密钥始终只在主进程内存中使用。
          if (input.scope === 'studio') {
            const page = await client.request('generation.connections', undefined)
            if (!page.ok) return page
            const connection = page.data.connections.find((item) => item.id === input.connectionId)
            return connection ? { ok: true, data: { connection, apiKey: generationSessions.sessionKey(root, connection) } } : failure('NOT_FOUND', '模型连接已不存在，请刷新。')
          }
          const page = await aiSessions.handle('ai.connection.list', { bookId: input.bookId }, client) as Result<AiConnectionPage>
          if (!page.ok) return page
          const connection = page.data.connections.find((item) => item.id === input.connectionId)
          return connection ? { ok: true, data: { connection, apiKey: aiSessions.sessionKey(root, input.bookId, connection) } } : failure('NOT_FOUND', '模型连接已不存在，请刷新。')
        }, () => service === client ? client.getWorkspaceRoot() : null)
      }
      if (command.startsWith('book.image.')) {
        if (command === 'book.image.start' && (aiSessions.hasActive() || generationSessions.hasActive())) return failure('WORKSPACE_BUSY', '其他模型任务尚未结束，请先核对。')
        pendingAiCommands += 1
        try { return await imageSessions.handle(command, payload, service, aiSessions) }
        finally { pendingAiCommands -= 1 }
      }
      if (command.startsWith('generation.')) {
        if (['generation.start', 'generation.configure'].includes(command) && (aiSessions.hasActive() || imageSessions.hasActive())) return failure('WORKSPACE_BUSY', '其他模型任务尚未结束，请先核对。')
        pendingAiCommands += 1
        try { return await generationSessions.handle(command, payload, service) }
        finally { pendingAiCommands -= 1 }
      }
      if (command.startsWith('ai.') || command.startsWith('memory.vector.')) {
        if (['ai.start', 'ai.configure', 'memory.vector.start'].includes(command) && (generationSessions.hasActive() || imageSessions.hasActive())) return failure('WORKSPACE_BUSY', '其他模型任务或待存结果尚未处理，请先核对。')
        // 多次 await 的上下文预览也固定书库，不能在读取配置后被切到另一作品库。
        pendingAiCommands += 1
        try { return await aiSessions.handle(command, payload, service) }
        finally { pendingAiCommands -= 1 }
      }
      if (command === 'workspace.select') {
        if (pendingAiCommands > 0 || aiSessions.hasActive() || generationSessions.hasActive() || imageSessions.hasActive()) return failure('WORKSPACE_BUSY', 'AI 请求仍在进行，请先处理并核对结束状态，再切换作品库。')
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
          const rootPath = checkedWorkspaceDirectory(selection.filePaths[0]!)
          connectionProbes.abortAll()
          const result = await service.request('workspace.open', { rootPath })
          if (result.ok) rememberedWorkspaceRoot = result.data.rootPath
          return await completeWorkspaceRead(service, result)
        } finally { choosingFile = false }
      }
      if (command === 'recovery.exportFile' || command === 'recovery.select' || command === 'recovery.restore') {
        if (pendingAiCommands > 0 || aiSessions.hasActive() || generationSessions.hasActive() || imageSessions.hasActive()) return failure('WORKSPACE_BUSY', '请先处理并核对正在进行的模型请求，再备份或恢复作品。')
        if (!service.getWorkspaceRoot()) return failure('WORKSPACE_REQUIRED', '请先选择用于保存作品的本地书库。')
        const exporting = command === 'recovery.exportFile' ? parseBookRecoveryExportInput(payload) : null
        const restoring = command === 'recovery.restore' ? parseBookRecoveryRestoreInput(payload) : null
        if (command === 'recovery.select' && payload !== undefined) return failure('INVALID_INPUT', '请从原生窗口选择恢复包目录。')
        const window = mainWindow
        if (!window) return failure('SERVICE_UNAVAILABLE', '桌面窗口不可用。')
        // 从原生选择直到请求返回，固定书库并阻止关闭；超时后的原请求由服务回执继续追踪。
        choosingFile = true
        try {
          if (restoring) return await service.request('recovery.restore', restoring)
          const selection = await dialog.showOpenDialog(window, {
            title: exporting ? '选择作品恢复包的保存位置' : '选择作品恢复包目录（包含 manifest.json）',
            buttonLabel: exporting ? '在此创建恢复包' : '校验并预览恢复包',
            properties: ['openDirectory'],
          })
          if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, data: null }
          if (closing || draining) return failure('WORKSPACE_BUSY', '正在关闭，未提交备份或恢复预览。')
          return exporting
            ? await service.request('recovery.export', { ...exporting, directoryPath: selection.filePaths[0]! })
            : await service.request('recovery.prepare', { packagePath: selection.filePaths[0]! })
        } finally { choosingFile = false }
      }
      if (command === 'draft.select') {
        const target = parseDraftTarget(payload)
        draftRecovery.requireScope(target.scope)
        const window = mainWindow
        if (!window) return failure('SERVICE_UNAVAILABLE', '桌面窗口不可用。')
        choosingFile = true
        try {
          const selected = await dialog.showOpenDialog(window, { title: '选择织章单章草稿副本', buttonLabel: '预览草稿', properties: ['openFile'], filters: [{ name: '织章单章草稿', extensions: ['json'] }] })
          if (selected.canceled || selected.filePaths.length !== 1) return { ok: true, data: null }
          if (closing || draining) return failure('WORKSPACE_BUSY', '正在关闭，未读取草稿。')
          draftRecovery.requireScope(target.scope)
          return { ok: true, data: draftImports.select(selected.filePaths[0]!, target) }
        } finally { choosingFile = false }
      }
      if (command === 'draft.preview') {
        const target = parseDraftTarget(payload)
        if (!isRecord(payload)) return failure('INVALID_INPUT', '草稿预览参数无效。')
        const id = requiredId(payload.checkpointId)
        const bytes = draftRecovery.read(target.scope, id, payload.generationId)
        return { ok: true, data: draftImports.prepare(bytes, `${id}.json`, target) }
      }
      if (command === 'draft.commit') {
        if (!isRecord(payload)) return failure('INVALID_INPUT', '草稿确认参数无效。')
        const scope = draftRecovery.requireScope(payload.scope)
        const input = draftImports.consume(payload, scope)
        return await service.request('draft.import', input)
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
      if (command === 'book.media.exportFile') {
        const input = parseExportBookMediaInput(payload), target = mainWindow
        if (!target) return failure('SERVICE_UNAVAILABLE', '桌面窗口不可用。')
        choosingFile = true
        try {
          const extension = input.mime === 'image/png' ? 'png' : input.mime === 'image/jpeg' ? 'jpg' : 'webp'
          const selection = await dialog.showSaveDialog(target, {
            title: '导出所选原图（仅新建文件）', buttonLabel: '导出原图',
            defaultPath: `图片素材-${input.id}.${extension}`, filters: [{ name: '图片原图', extensions: [extension] }],
          })
          if (selection.canceled || !selection.filePath) return { ok: true, data: null }
          if (closing || draining) return failure('WORKSPACE_BUSY', '正在关闭，未创建图片导出文件。')
          return await service.request('book.media.export', { ...input, filePath: selection.filePath })
        } finally { choosingFile = false }
      }
      if (command === 'book.export.directory') {
        if (payload !== undefined) return failure('INVALID_INPUT', '请从原生窗口选择导出目录。')
        const client = service, root = client.getWorkspaceRoot(), target = mainWindow
        if (!root) return failure('WORKSPACE_REQUIRED', '请先选择作品库。')
        if (!target) return failure('SERVICE_UNAVAILABLE', '桌面窗口不可用。')
        choosingFile = true
        try {
          const selection = await dialog.showOpenDialog(target, {
            title: '选择导出保存位置', buttonLabel: '使用此文件夹', properties: ['openDirectory'],
          })
          if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, data: null }
          if (closing || draining || service !== client || client.getWorkspaceRoot() !== root) return failure('WORKSPACE_BUSY', '作品库正在切换或关闭，请重新选择保存位置。')
          const directoryPath = checkedLocalDirectory(selection.filePaths[0]!)
          const id = randomUUID()
          // 路径只由主进程保管；前端持有当前书库内的有界会话编号，不能自行指定磁盘目录。
          exportDirectories.set(id, { root, directoryPath })
          if (exportDirectories.size > 32) exportDirectories.delete(exportDirectories.keys().next().value!)
          return { ok: true, data: { id, directoryPath } }
        } finally { choosingFile = false }
      }
      if (command === 'book.export.commitFile') {
        const { destination, ...input } = parseBookExportFileInput(payload)
        const directory = destination ? exportDirectories.get(destination.directoryId) : undefined
        if (destination && (!directory || directory.root !== service.getWorkspaceRoot())) return failure('INVALID_INPUT', '保存位置已失效，请重新选择文件夹。')
        const target = mainWindow
        if (!target) return failure('SERVICE_UNAVAILABLE', '桌面窗口不可用。')
        choosingFile = true
        try {
          let filePath: string
          if (destination && directory) filePath = join(checkedLocalDirectory(directory.directoryPath), destination.fileName)
          else {
            const extension = bookExportExtension(input.format)
            const selection = await dialog.showSaveDialog(target, {
              title: '按已确认预览导出（仅新建文件）', buttonLabel: '创建导出文件和清单',
              defaultPath: `作品导出-${Date.now()}.${extension}`,
              filters: [{ name: input.format === 'docx' ? 'Word 文档' : input.format === 'epub' ? 'EPUB 电子书' : input.format === 'markdown' ? 'Markdown 文本' : '纯文本', extensions: [extension] }],
            })
            if (selection.canceled || !selection.filePath) return { ok: true, data: null }
            filePath = selection.filePath
          }
          if (closing || draining) return failure('WORKSPACE_BUSY', '正在关闭，未创建导出文件。')
          // 导出模块按固定预览独占创建正文和清单，主进程只负责原生路径选择。
          return await service.request('book.export.commit', { ...input, filePath })
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
      if (request.command === 'workspace.get') return await completeWorkspaceRead(service, await service.request('workspace.get', undefined))
      return await service.request(request.command, request.payload)
    } catch (error) {
      return error instanceof DomainError
        ? { ok: false, error: error.detail }
        : storageFailureReason(error)
          ? { ok: false, error: storageError(error, '本地操作未完成，请保留当前稿件。').detail }
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

async function preservePendingAiResult(window: BrowserWindow): Promise<boolean> {
  if (!aiSessions.hasActive() && !generationSessions.hasActive() && !imageSessions.hasActive()) return true
  choosingFile = true
  try {
    const decision = await dialog.showMessageBox(window, {
      type: 'warning', title: '模型结果尚未保存', message: '已收到的模型结果还没有确认写入作品。',
      detail: '可返回原候选重新读取以补存，也可另存完整结果后返回工作室。副本需手工核对处理；之后请刷新原请求、处理未保存内容，再关闭窗口。',
      buttons: ['返回继续处理', '另存结果并返回'], defaultId: 0, cancelId: 0,
    })
    if (decision.response !== 1) return false
    const selection = await dialog.showSaveDialog(window, {
      title: '另存待存模型结果（仅新建文件）', buttonLabel: '保存结果副本',
      defaultPath: `模型结果留存-${Date.now()}.json`, filters: [{ name: '模型结果 JSON', extensions: ['json'] }],
    })
    if (selection.canceled || !selection.filePath) return false
    const copied = imageSessions.hasActive() ? imageSessions.savePendingResult(selection.filePath)
      : generationSessions.hasActive() ? generationSessions.savePendingResult(selection.filePath) : aiSessions.savePendingResult(selection.filePath)
    await dialog.showMessageBox(window, {
      type: 'info', title: copied ? '模型结果已留存' : '原保存请求已确认',
      message: copied ? '已保存结果副本，请返回工作室核对原请求。' : '模型结果的原保存回执已确认，无需另存副本。请返回工作室读取原记录。',
      detail: '请在原面板重新读取；仍显示生成中且没有本机活动时，可明确中断该记录。处理未保存内容后可再次关闭窗口。', buttons: ['返回工作室'],
    })
    return false
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: 'warning', title: '结果仍在本次会话保留', message: '模型结果副本未能确认保存，窗口将保留。',
      detail: error instanceof DomainError ? error.detail.message : '请检查保存位置后重新选择一个新文件名。', buttons: ['返回继续处理'],
    })
    return false
  } finally { choosingFile = false }
}

async function requestClose(): Promise<void> {
  const window = mainWindow
  if (!window || window.isDestroyed() || closing) return
  if (choosingFile || restarting || pendingAiCommands > 0 || aiSessions.hasActive(false) || generationSessions.hasActive(false) || imageSessions.hasActive(false)) {
    try { window.webContents.send(CLOSE_CANCELLED_CHANNEL) } catch { /* 保留当前窗口和未完成操作。 */ }
    return
  }
  closing = true
  connectionProbes.abortAll()
  try {
    if (!await preservePendingAiResult(window)) return
    // 仅首次加载失败且从未建立界面／书库会话时，才没有 renderer 草稿需要确认。
    const failedBeforeSession = initialRendererLoadFailed && !rendererSessionStarted &&
      rememberedWorkspaceRoot === null && (service === null || service.getWorkspaceRoot() === null)
    const ready = failedBeforeSession || await askRendererToSave(window)
    if (!ready) {
      await dialog.showMessageBox(window, {
        type: 'warning', title: '窗口已保留', message: '尚未确认稿件已经保存。',
        detail: '请回到编辑器检查保存状态。若界面已失去响应，请先保留可见稿件再处理故障。', buttons: ['返回编辑器'],
      })
      return
    }
    draining = true
    const result = failedBeforeSession && (service === null || service.hasExited())
      ? { ok: true as const, data: null }
      : service ? await service.close() : failure('SERVICE_UNAVAILABLE', '本地作品服务不可用。')
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
    title: '织章 · StoryWeave', backgroundColor: '#F1EBE1', show: false,
    icon: join(__dirname, '../../resources/storyweave.ico'),
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
  window.webContents.on('render-process-gone', () => closeConnectionKeyPage())
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
  window.on('closed', () => { closeConnectionKeyPage(); connectionProbes.abortAll(); aiSessions.abortAll(); generationSessions.abortAll(); imageSessions.abortAll(); mainWindow = null })
  window.once('ready-to-show', () => window.show())
  void window.loadURL(expectedRendererUrl).then(() => { rendererSessionStarted = true }).catch(() => {
    initialRendererLoadFailed = true
    if (window.isDestroyed()) return
    window.show()
    void dialog.showMessageBox(window, { type: 'error', message: '工作室界面加载失败。', detail: '请检查应用文件和构建配置；可以关闭窗口退出。', buttons: ['知道了'] })
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
    service = createService()
    setupIpc()
    createWindow()
  }).catch(() => {
    dialog.showErrorBox('无法打开工作室', '桌面组件启动失败，请检查应用文件和依赖配置。')
    // 启动阶段没有打开书库，也没有编辑中的稿件。
    shutdownAuthorized = true
    app.quit()
  })
}
