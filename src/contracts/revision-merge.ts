import { DomainError, isRecord, requiredId, requiredInteger, type SaveChapterOutput } from './api'
import { MAX_CHAPTER_BLOCKS, countCharacters, documentToText, parseManuscript } from './manuscript'

export interface RevisionMergeInput {
  bookId: string
  chapterId: string
  expectedBookRevision: number
  expectedRevisionId: string
  sourceRevisionId: string
  selectedBlockIds: string[]
}
export interface RevisionMergeOutput extends SaveChapterOutput {
  sourceRevisionId: string
  selectedBlockIds: string[]
}

export function parseRevisionMergeInput(value: unknown): RevisionMergeInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['bookId', 'chapterId', 'expectedBookRevision', 'expectedRevisionId', 'sourceRevisionId', 'selectedBlockIds'].includes(key))
    || !Array.isArray(value.selectedBlockIds) || !value.selectedBlockIds.length || value.selectedBlockIds.length > MAX_CHAPTER_BLOCKS * 2) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '请选择有效的段落差异，并保留对照时的版本。' })
  }
  const selectedBlockIds = value.selectedBlockIds.map((id) => requiredId(id).toLowerCase())
  if (new Set(selectedBlockIds).size !== selectedBlockIds.length) throw new DomainError({ code: 'INVALID_INPUT', message: '所选段落差异重复。' })
  return { bookId: requiredId(value.bookId).toLowerCase(), chapterId: requiredId(value.chapterId).toLowerCase(),
    expectedBookRevision: requiredInteger(value.expectedBookRevision, '作品版本'), expectedRevisionId: requiredId(value.expectedRevisionId).toLowerCase(),
    sourceRevisionId: requiredId(value.sourceRevisionId).toLowerCase(), selectedBlockIds }
}

export function isRevisionMergeOutputFor(input: RevisionMergeInput, output: RevisionMergeOutput): boolean {
  try {
    const data = parseRevisionMergeInput(input)
    if (!output || typeof output.changed !== 'boolean' || output.sourceRevisionId !== data.sourceRevisionId
      || !Array.isArray(output.selectedBlockIds) || output.selectedBlockIds.length !== data.selectedBlockIds.length
      || output.selectedBlockIds.some((id, index) => id !== data.selectedBlockIds[index])) return false
    const chapter = output.chapter
    if (!chapter || chapter.bookId !== data.bookId || chapter.id !== data.chapterId
      || chapter.bookRevision !== data.expectedBookRevision + (output.changed ? 1 : 0)) return false
    requiredId(chapter.revisionId)
    if (output.changed ? chapter.revisionId === data.expectedRevisionId || chapter.status !== 'writing' : chapter.revisionId !== data.expectedRevisionId) return false
    const text = documentToText(parseManuscript(chapter.document))
    return chapter.plainText === text && chapter.characterCount === countCharacters(text)
  } catch { return false }
}
