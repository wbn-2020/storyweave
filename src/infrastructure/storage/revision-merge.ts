import { DomainError } from '../../contracts/api'
import { applyParagraphChanges } from '../../contracts/paragraph-diff'
import { parseRevisionMergeInput, type RevisionMergeInput, type RevisionMergeOutput } from '../../contracts/revision-merge'
import type { StudioRepository } from './studio-repository'

export function mergeRevision(studio: StudioRepository, input: RevisionMergeInput): RevisionMergeOutput {
  const data = parseRevisionMergeInput(input)
  const db = studio.getMemoryDatabase(data.bookId)
  try {
    // 在同书写事务内读取双方版本、重算差异并保存；界面提交的段落 ID 不能代替服务端的来源核对。
    const result = db.transaction((): RevisionMergeOutput => {
      const current = studio.readChapter({ bookId: data.bookId, chapterId: data.chapterId })
      if (current.revisionId !== data.expectedRevisionId || current.bookRevision !== data.expectedBookRevision) {
        throw new DomainError({ code: 'REVISION_CONFLICT', message: '对照后作品或正文已有修改，未采用任何差异。请保留当前草稿并重新比较。', currentRevisionId: current.revisionId })
      }
      const source = studio.readRevision({ bookId: data.bookId, chapterId: data.chapterId, revisionId: data.sourceRevisionId })
      const document = applyParagraphChanges(current.document, source.document, data.selectedBlockIds)
      // 修订不可更新；恢复来源必须随新修订一并插入，不能在保存后补写。
      const saved = studio.saveChapter({ bookId: data.bookId, chapterId: data.chapterId, expectedRevisionId: data.expectedRevisionId, document }, 'restore', data.sourceRevisionId)
      return { ...saved, sourceRevisionId: data.sourceRevisionId, selectedBlockIds: data.selectedBlockIds }
    }).immediate()
    if (result.changed && !db.inTransaction) studio.refreshKnowledgeCatalog(data.bookId)
    return result
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError({ code: 'STORAGE_ERROR', message: '局部恢复未完成，原稿与历史仍保留，请重新读取后核对。' })
  }
}
