import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { DomainError, type BookSnapshot, type CommitImportInput, type ImportChapterInput, type ImportChapterPreview, type ReparseImportInput, type TextImportOptions, type TextImportPreview } from '../../contracts/api'
import { countCharacters, documentToText, type ManuscriptDocument } from '../../contracts/manuscript'
import { decodeText, MAX_IMPORT_BYTES, splitText, textToDocument } from '../../infrastructure/text/manuscript-text'
import type { StudioRepository } from '../../infrastructure/storage/studio-repository'
import { readSelectedText } from '../file-access'

interface ImportSession {
  token: string
  rootPath: string
  expiresAt: number
  sourceName: string
  bytes: Uint8Array
  options: TextImportOptions
  chapters: { title: string; document: ManuscriptDocument }[]
  preview: TextImportPreview
  state: 'ready' | 'committing' | 'failed' | 'committed'
  result?: BookSnapshot
}

export class ImportSessions {
  private session: ImportSession | null = null
  private expirationTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly repository: StudioRepository) {}

  clear(): void {
    if (this.expirationTimer) clearTimeout(this.expirationTimer)
    this.expirationTimer = null
    this.session = null
  }

  prepare(input: TextImportOptions & { filePath: string }): TextImportPreview {
    const rootPath = this.requireRoot()
    const bytes = readSelectedText(input.filePath, MAX_IMPORT_BYTES)
    const sourceName = basename(input.filePath)
    const session = this.parse(bytes, sourceName, input, rootPath)
    this.remember(session)
    return session.preview
  }

  reparse(input: ReparseImportInput): TextImportPreview {
    const current = this.requireSession(input.token)
    if (current.state !== 'ready') throw unavailable('导入确认已经开始，不能再次调整预览。')
    const next = this.parse(current.bytes, current.sourceName, input, current.rootPath)
    this.remember(next)
    return next.preview
  }

  readChapter(input: ImportChapterInput): ImportChapterPreview {
    const session = this.requireSession(input.token)
    const chapter = session.chapters[input.index]
    if (!chapter) throw unavailable('预览章节不存在。')
    return { index: input.index, title: chapter.title, plainText: documentToText(chapter.document) }
  }

  commit(input: CommitImportInput): BookSnapshot {
    const session = this.requireSession(input.token)
    if (session.state === 'committed' && session.result) return session.result
    if (session.state !== 'ready') throw unavailable('该预览已经尝试导入。请先检查书架或待恢复作品，避免重复创建。')
    // 消费 token 在写入之前完成，失败也不能无提示重复执行可能已部分完成的建书。
    session.state = 'committing'
    try {
      const result = this.repository.importBook({
        title: input.title, sourceName: session.sourceName, encoding: session.options.encoding,
        sourceBytes: session.bytes, chapters: session.chapters,
      })
      session.result = result
      session.state = 'committed'
      session.bytes = new Uint8Array()
      session.chapters = []
      return result
    } catch (error) {
      session.state = 'failed'
      throw error
    }
  }

  private parse(bytes: Uint8Array, sourceName: string, options: TextImportOptions, rootPath: string): ImportSession {
    const decoded = decodeText(bytes, options.encoding)
    if (decoded.text.length > 8_000_000) throw unavailable('单次导入最多支持 800 万 UTF-16 字符，请分文件导入。')
    let paragraphCount = 1
    for (const character of decoded.text) {
      if (character === '\n') paragraphCount += 1
      if (paragraphCount > 200_000) throw unavailable('单次导入最多支持 20 万个段落，请分文件导入。')
    }
    const fallback = basename(sourceName, extname(sourceName)).slice(0, 120) || '导入正文'
    const parts = splitText(decoded.text, options.splitMode, fallback)
    if (parts.length === 0 || parts.length > 20_000) throw unavailable('分章结果无效或超过 20,000 章，请调整分章方式。')
    const chapters = parts.map((part) => ({ title: part.title, document: textToDocument(part.text) }))
    const warnings = [...decoded.warnings]
    if (['.md', '.markdown'].includes(extname(sourceName).toLowerCase())) warnings.push('Markdown 按字面文本导入，格式符号和原始标题行保留在正文中。')
    if (new Set(parts.map((part) => part.title)).size !== parts.length) warnings.push('检测到重复章节标题，请在预览中核对。')
    const token = randomUUID()
    const summaries = chapters.map((chapter, index) => ({ index, title: chapter.title, characterCount: countCharacters(documentToText(chapter.document)) }))
    const preview: TextImportPreview = {
      token, sourceName, sourceBytes: bytes.byteLength, encoding: options.encoding, splitMode: options.splitMode,
      totalCharacters: summaries.reduce((total, chapter) => total + chapter.characterCount, 0), chapters: summaries, warnings,
    }
    return { token, rootPath, bytes, options: { encoding: options.encoding, splitMode: options.splitMode }, sourceName, chapters, preview, expiresAt: Date.now() + 30 * 60_000, state: 'ready' }
  }

  private remember(session: ImportSession): void {
    this.clear()
    this.session = session
    this.expirationTimer = setTimeout(() => this.clear(), Math.max(0, session.expiresAt - Date.now()))
    this.expirationTimer.unref()
  }

  private requireRoot(): string {
    const rootPath = this.repository.getWorkspace().rootPath
    if (!rootPath) throw new DomainError({ code: 'WORKSPACE_REQUIRED', message: '请先选择作品数据目录，再导入正文。' })
    return rootPath
  }

  private requireSession(token: string): ImportSession {
    const session = this.session
    if (session && session.expiresAt < Date.now()) this.clear()
    if (!session || session.token !== token || session.expiresAt < Date.now() || session.rootPath !== this.requireRoot()) {
      throw unavailable('导入预览已失效，请重新选择文件并检查预览。')
    }
    return session
  }
}

function unavailable(message: string): DomainError {
  return new DomainError({ code: 'INVALID_INPUT', message })
}
