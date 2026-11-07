import { DomainError, isRecord, requiredId, requiredInteger, requiredText, type SaveDraftCopyInput } from './api'
import { documentToText, parseManuscript } from './manuscript'

export const MAX_DRAFT_FILE_BYTES = 16 * 1024 * 1024

export interface ChapterDraftFile extends SaveDraftCopyInput {
  format: 'storyweave.chapter-draft'
  version: 1
  description: string
  createdAt: string
  plainText: string
  checkpoint?: { id: string; editorSessionId: string; editSequence: number }
}

function invalid(message: string): never {
  throw new DomainError({ code: 'INVALID_INPUT', message })
}

export function parseDraftFile(bytes: unknown): ChapterDraftFile {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_DRAFT_FILE_BYTES) {
    return invalid('草稿文件必须包含有效内容，且不能超过 16 MiB。')
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return invalid('草稿文件必须是 UTF-8 编码的有效 JSON。') }
  if (!isRecord(value) || value.format !== 'storyweave.chapter-draft' || value.version !== 1) {
    return invalid('这不是当前版本支持的织章单章草稿副本。')
  }
  const allowed = ['format', 'version', 'description', 'createdAt', 'bookId', 'chapterId', 'baseRevisionId', 'title', 'document', 'plainText', 'checkpoint']
  if (Object.keys(value).some((key) => !allowed.includes(key))) return invalid('草稿含未知字段，请保留原文件并检查来源版本。')
  const document = parseManuscript(value.document)
  const plainText = documentToText(document)
  // 同时校验两份表示，避免用户预览的纯文本与实际恢复的正文不一致。
  if (value.plainText !== plainText) return invalid('草稿正文与纯文本摘要不一致，未导入任何内容。')
  if (typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
    return invalid('草稿创建时间无效。')
  }
  let checkpoint: ChapterDraftFile['checkpoint']
  if (value.checkpoint !== undefined) {
    if (!isRecord(value.checkpoint) || Object.keys(value.checkpoint).some((key) => !['id', 'editorSessionId', 'editSequence'].includes(key))) {
      return invalid('草稿检查点身份无效。')
    }
    checkpoint = {
      id: requiredId(value.checkpoint.id).toLowerCase(), editorSessionId: requiredId(value.checkpoint.editorSessionId).toLowerCase(),
      editSequence: requiredInteger(value.checkpoint.editSequence, '草稿编辑序号'),
    }
  }
  return {
    format: 'storyweave.chapter-draft', version: 1, description: requiredText(value.description, '草稿说明', 500),
    createdAt: value.createdAt, bookId: requiredId(value.bookId).toLowerCase(), chapterId: requiredId(value.chapterId).toLowerCase(),
    baseRevisionId: requiredId(value.baseRevisionId).toLowerCase(), title: requiredText(value.title, '章节名称', 120),
    document, plainText, ...(checkpoint ? { checkpoint } : {}),
  }
}
