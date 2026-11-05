import { DomainError, isRecord, requiredId, requiredText, type FileWriteReceipt, type SaveDraftCopyInput } from '../../contracts/api'
import { documentToText, parseManuscript } from '../../contracts/manuscript'
import { writeNewText } from '../file-access'

export function parseDraftCopy(value: unknown): SaveDraftCopyInput {
  if (!isRecord(value)) throw new DomainError({ code: 'INVALID_INPUT', message: '草稿副本内容无效。' })
  return {
    bookId: requiredId(value.bookId), chapterId: requiredId(value.chapterId), baseRevisionId: requiredId(value.baseRevisionId),
    title: requiredText(value.title, '章节名称', 120), document: parseManuscript(value.document),
  }
}

export function saveDraftCopy(filePath: string, input: SaveDraftCopyInput): FileWriteReceipt {
  // 副本独立于业务进程；数据库失联时仍能保存当前编辑内容和来源版本。
  const copy = {
    format: 'storyweave.chapter-draft', version: 1,
    description: '单章草稿副本，不是完整作品备份。', createdAt: new Date().toISOString(),
    ...input, plainText: documentToText(input.document),
  }
  return writeNewText(filePath, (write) => write(JSON.stringify(copy, null, 2) + '\n')).receipt
}
