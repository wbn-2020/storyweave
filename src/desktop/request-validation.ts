import { DomainError, isRecord, requiredId, requiredInteger, requiredText, optionalText, type ServiceRequest, type TextEncoding, type TextSplitMode } from '../contracts/api'
import { parseManuscript } from '../contracts/manuscript'

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
