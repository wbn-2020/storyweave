import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { DomainError, type TextEncoding, type TextExportFormat, type TextSplitMode } from '../../contracts/api'
import { documentToText, MAX_CHAPTER_BLOCKS, MAX_CHAPTER_LENGTH, parseManuscript, type InlineNode, type ManuscriptDocument, type ParagraphBlock } from '../../contracts/manuscript'

export const MAX_IMPORT_BYTES = 32 * 1024 * 1024
const MAX_IMPORT_CHAPTERS = 20_000

function invalid(message: string): never {
  throw new DomainError({ code: 'INVALID_INPUT', message })
}

export function decodeText(bytes: Uint8Array, encoding: TextEncoding): { text: string; warnings: string[] } {
  if (bytes.byteLength > MAX_IMPORT_BYTES) invalid('文本文件超过 32 MiB，请拆分后导入。')
  if (!['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(encoding)) invalid('请选择支持的文本编码。')
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8'
    : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null
  if (bom && bom !== encoding) invalid(`文件的字节序标记为 ${bom}，请改用对应编码。`)
  let decoder: TextDecoder
  try { decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: false }) } catch {
    return invalid('当前运行环境不支持该编码，请先将原稿副本另存为 UTF-8。')
  }
  if (!decoder.fatal) invalid('当前运行环境不能严格校验文本编码，已停止导入。')
  let text: string
  try { text = decoder.decode(bytes) } catch {
    return invalid('文件不能按所选编码完整解码，请选择原稿使用的编码后重试。')
  }
  if (text.includes('\0')) invalid('文本中含空字符，可能选错编码或选到了非文本文件，请检查原稿。')
  const warnings: string[] = []
  if (bom) warnings.push('文件开头的编码标记不会进入正文，原始文件副本保留该标记。')
  if (text.includes('\r')) warnings.push('正文换行统一为 LF；原始文件副本保留原来的换行字节。')
  if (text.includes('\ufffd')) warnings.push('原文包含替换字符“�”，请在预览中核对是否已有乱码。')
  return { text: text.replace(/\r\n?/g, '\n'), warnings }
}

function headingTitle(line: string): string | null {
  const value = line.trim()
  if (!value || value.length > 120) return null
  const markdown = /^(#{1,2})[\t ]+(.+?)(?:[\t ]+#+)?$/.exec(value)
  if (markdown) return markdown[2]!.trim()
  if (/^第[零〇一二三四五六七八九十百千万两\d０-９]+[章回节卷](?:[\t 　:：、.．\-—].*)?$/.test(value)) return value
  if (/^(?:序章|楔子|引子|尾声|终章|后记)(?:[\t 　:：、.．\-—].*)?$/.test(value)) return value
  return null
}

export function splitText(text: string, mode: TextSplitMode, fallbackTitle: string): { title: string; text: string }[] {
  if (mode !== 'none' && mode !== 'headings') invalid('分章方式无效。')
  const fallback = fallbackTitle.trim().slice(0, 120) || '导入正文'
  if (mode === 'none') return [{ title: fallback, text }]
  const boundaries: { start: number; title: string }[] = []
  let start = 0
  // 仅记录切点，不重组或 trim 正文；所有章节切片拼接后仍等于规范化原文。
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline
    const title = headingTitle(text.slice(start, end))
    if (title) {
      boundaries.push({ start, title })
      if (boundaries.length > MAX_IMPORT_CHAPTERS) invalid('识别到的章节超过 20,000 个，请调整分章方式或拆分原稿。')
    }
    if (newline < 0) break
    start = newline + 1
  }
  if (!boundaries.length) return [{ title: fallback, text }]
  if (boundaries[0]!.start > 0) boundaries.unshift({ start: 0, title: '卷首文字' })
  if (boundaries.length > MAX_IMPORT_CHAPTERS) invalid('包含卷首文字后超过 20,000 章，请拆分原稿。')
  return boundaries.map((boundary, index) => ({
    title: boundary.title,
    text: text.slice(boundary.start, boundaries[index + 1]?.start ?? text.length),
  }))
}

export function textToDocument(text: string): ManuscriptDocument {
  if (text.length > MAX_CHAPTER_LENGTH) invalid('分出的单章超过 100 万 UTF-16 字符，请修改原稿中的章标题或先拆分文件。')
  const content: ParagraphBlock[] = []
  let start = 0
  while (start <= text.length) {
    if (content.length >= MAX_CHAPTER_BLOCKS) invalid('分出的单章超过 20,000 个段落，请先拆分文件。')
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline
    const line = text.slice(start, end)
    content.push({ type: 'paragraph', attrs: { id: randomUUID() }, ...(line ? { content: [{ type: 'text' as const, text: line }] } : {}) })
    if (newline < 0) break
    start = newline + 1
  }
  return parseManuscript({ type: 'doc', content })
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+.!<>|~&\-])/g, '\\$1')
}

function markdownWhitespace(value: string): string {
  // 用字符引用保留缩进，避免四个空格或 Tab 把普通小说段落变成代码块。
  return value.replace(/ /g, '&#32;').replace(/\t/g, '&#9;')
}

function inlineMarkdown(node: InlineNode): string {
  if (node.type === 'hardBreak') return '  \n'
  return node.text.split('\n').map((line) => {
    const leading = /^\s*/u.exec(line)![0]
    const trailing = /\s*$/u.exec(line)![0]
    if (leading.length === line.length) return markdownWhitespace(line)
    let value = escapeMarkdown(line.slice(leading.length, line.length - trailing.length))
    if (node.marks?.some((mark) => mark.type === 'italic')) value = `*${value}*`
    if (node.marks?.some((mark) => mark.type === 'bold')) value = `**${value}**`
    return markdownWhitespace(leading) + value + markdownWhitespace(trailing)
  }).join('  \n')
}

export function documentToMarkdown(document: ManuscriptDocument): string {
  const normalized = parseManuscript(document)
  return normalized.content.map((block) => {
    if (block.type === 'horizontalRule') return '---'
    const text = (block.content ?? []).map(inlineMarkdown).join('')
    return block.type === 'heading' ? `${'#'.repeat(block.attrs.level)} ${text}` : text
  }).join('\n\n')
}

export function renderTextExport(chapters: { title: string; document: ManuscriptDocument }[], format: TextExportFormat, includeChapterTitles: boolean): string {
  if (format !== 'txt' && format !== 'markdown') invalid('导出格式无效。')
  // 正文导出不携带来源 ID、版本和资料，完整恢复包由独立功能负责。
  return chapters.map((chapter) => {
    const document = parseManuscript(chapter.document)
    const text = format === 'markdown' ? documentToMarkdown(document) : documentToText(document)
    if (!includeChapterTitles) return text
    const title = format === 'markdown' ? `# ${escapeMarkdown(chapter.title)}` : chapter.title
    return `${title}\n\n${text}`
  }).join('\n\n')
}
