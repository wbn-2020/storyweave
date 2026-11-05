import { DomainError, failure, isRecord, requiredId, type Result, type CommandMap, type ServiceCommand, type ServiceRequest } from '../../contracts/api'
import { StudioRepository } from '../../infrastructure/storage/studio-repository'
import { parseServiceRequest } from '../request-validation'
import { writeNewText } from '../file-access'
import { ImportSessions } from './import-sessions'

const parentPort = process.parentPort
if (!parentPort) throw new Error('作品服务只能由桌面主进程启动。')
const repository = new StudioRepository()
const imports = new ImportSessions(repository)

function dispatch(request: ServiceRequest): CommandMap[ServiceCommand]['output'] {
  switch (request.command) {
    case 'workspace.get': return repository.getWorkspace()
    case 'workspace.open': {
      const workspace = repository.openWorkspace(request.payload.rootPath)
      imports.clear()
      return workspace
    }
    case 'book.create': return repository.createBook(request.payload)
    case 'book.get': return repository.getBook(request.payload)
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
    case 'book.export': {
      const output = writeNewText(request.payload.filePath, (write) => repository.exportBookText(request.payload, write))
      return { ...output.receipt, ...output.value }
    }
    case 'service.close': imports.clear(); repository.close(); return null
  }
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
      const result = error instanceof DomainError
        ? { ok: false, error: error.detail }
        : failure('INVALID_INPUT', '请求格式无效。')
      parentPort.postMessage({ id, result })
    } catch { /* 没有合法身份的消息不参与响应。 */ }
    return
  }
  let result: Result<CommandMap[ServiceCommand]['output']>
  try {
    result = { ok: true, data: dispatch(request) }
  } catch (error) {
    result = error instanceof DomainError
      ? { ok: false, error: error.detail }
      : failure('STORAGE_ERROR', '本地数据操作失败，未确认保存成功，请保留当前稿件。')
  }
  parentPort.postMessage({ id: request.id, result })
})

process.once('exit', () => {
  try { repository.close() } catch { /* 退出阶段不继续写入数据。 */ }
})
