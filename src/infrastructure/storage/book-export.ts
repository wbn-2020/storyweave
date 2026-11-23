import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeSync, type Stats } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { activeChapterSql } from './chapter-lifecycle'
import { DomainError, requiredId, requiredInteger, requiredText, type ChapterStatus } from '../../contracts/api'
import {
  BOOK_EXPORT_PREVIEW_TTL, MAX_EXPORT_BYTES, MAX_EXPORT_CHAPTERS, bookExportExtension,
  parseBookExportChapterInput, parseBookExportCommitServiceInput, parseBookExportPrepareInput,
  type BookExportChapterEntry, type BookExportChapterInput, type BookExportChapterPreview,
  type BookExportCommitServiceInput, type BookExportManifest, type BookExportPrepareInput,
  type BookExportPreview, type BookExportReceipt, type BookExportReference,
} from '../../contracts/export'
import { countCharacters, documentToText, MAX_CHAPTER_LENGTH, parseManuscript, type InlineNode, type ManuscriptDocument } from '../../contracts/manuscript'
import { renderTextExport } from '../text/manuscript-text'
import { docxDocumentParts, docxMetadata, renderDocxChapter } from './docx-export'
import type { StudioRepository } from './studio-repository'

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const EPUB_STYLES = 'body{font-family:serif;line-height:1.8;margin:5%;}h1,h2,h3,h4{line-height:1.4;break-after:avoid;}p,h1,h2,h3,h4{white-space:pre-wrap;overflow-wrap:anywhere;}p{margin:.75em 0;}hr{border:0;border-top:1px solid currentColor;width:25%;margin:1.5em auto;}nav ol{padding-inline-start:1.5em;}'
const EPUB_CONTAINER = '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'

interface OutlineRow {
  id: string; title: string; position: number; volume_id: string | null; volume_title: string | null
  current_revision_id: string; finalized_revision_id: string | null; status: ChapterStatus
}
interface RevisionRow {
  document_json: string | null; plain_text: string | null; content_hash: string; character_count: number; sequence: number; created_at: string
}
interface CheckedRevision { row: RevisionRow; document: ManuscriptDocument }
interface PreparedExport { preview: BookExportPreview; outlineHash: string; rootPath: string; generation: number }
interface ZipEntry { name: string; bytes: number }

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function conflict(): never { throw new DomainError({ code: 'REVISION_CONFLICT', message: '作品、章节顺序或正文版本已改变，请重新生成导出预览。' }) }
function storageFailure(message = '导出资料读取失败，请保留作品文件，检查章节与版本是否完整。'): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

function storedId(value: unknown): string {
  try {
    const id = requiredId(value)
    if (id !== id.toLowerCase()) throw storageFailure()
    return id
  } catch { throw storageFailure() }
}
function storedTitle(value: unknown): string {
  try {
    const title = requiredText(value, '章节或卷名', 120)
    if (title !== value) throw storageFailure()
    return title
  } catch { throw storageFailure() }
}
function storedTime(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw storageFailure()
  return value
}

function readOutline(db: Database.Database): OutlineRow[] {
  // 从目录出发，不能用正文内连接；版本丢失的章节也必须进入交付清单。
  const rows = db.prepare(`SELECT c.id, c.title, c.position, c.volume_id, v.title AS volume_title,
    c.current_revision_id, c.finalized_revision_id, c.status
    FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id WHERE ${activeChapterSql(db)} ORDER BY c.position, c.id LIMIT ?`).all(MAX_EXPORT_CHAPTERS + 1) as OutlineRow[]
  if (rows.length > MAX_EXPORT_CHAPTERS) throw storageFailure('作品章节数超过导出上限，请先检查目录。')
  return rows.map((row) => {
    if (!Number.isSafeInteger(row.position) || row.position < 0 || !['planned', 'writing', 'review', 'finalized'].includes(row.status)) throw storageFailure()
    if ((row.volume_id === null) !== (row.volume_title === null)) throw storageFailure('章节关联的卷不存在，无法确定交付目录。')
    return { id: storedId(row.id), title: storedTitle(row.title), position: row.position,
      volume_id: row.volume_id === null ? null : storedId(row.volume_id),
      volume_title: row.volume_title === null ? null : storedTitle(row.volume_title),
      current_revision_id: storedId(row.current_revision_id),
      finalized_revision_id: row.finalized_revision_id === null ? null : storedId(row.finalized_revision_id), status: row.status }
  })
}

function requireBook(db: Database.Database, bookId: string, revision: number): string {
  const row = db.prepare('SELECT id, title, revision FROM book_meta WHERE singleton = 1').get() as { id: string; title: string; revision: number } | undefined
  if (!row || storedId(row.id) !== bookId) throw storageFailure()
  if (row.revision !== revision) return conflict()
  return storedTitle(row.title)
}

function readRevision(db: Database.Database, chapterId: string, revisionId: string): CheckedRevision {
  const row = db.prepare(`SELECT
    CASE WHEN length(CAST(document_json AS BLOB)) <= @maxBytes THEN document_json END AS document_json,
    CASE WHEN length(CAST(plain_text AS BLOB)) <= @maxBytes THEN plain_text END AS plain_text,
    content_hash, character_count, sequence, created_at FROM chapter_revisions WHERE chapter_id = @chapterId AND id = @revisionId`
  ).get({ chapterId, revisionId, maxBytes: MAX_DOCUMENT_BYTES }) as RevisionRow | undefined
  if (!row) throw storageFailure('所指向的正文版本不存在，请检查历史或恢复资料。')
  try {
    if (typeof row.document_json !== 'string' || typeof row.plain_text !== 'string' || !/^[a-f0-9]{64}$/.test(row.content_hash)) throw storageFailure()
    const document = parseManuscript(JSON.parse(row.document_json))
    if (hash(row.document_json) !== row.content_hash || documentToText(document) !== row.plain_text ||
        countCharacters(row.plain_text) !== row.character_count || row.sequence < 1) throw storageFailure()
    requiredInteger(row.sequence, '正文版本序号')
    requiredInteger(row.character_count, '正文字数', MAX_CHAPTER_LENGTH)
    storedTime(row.created_at)
    return { row, document }
  } catch { throw storageFailure('正文版本未通过内容、摘要或字数核对，请保留原稿并检查恢复资料。') }
}

function fixedRevision(db: Database.Database, entry: BookExportChapterEntry): ManuscriptDocument {
  if (entry.state !== 'included' || !entry.revisionId) return invalid('该章节未包含在已确认的导出清单中。')
  const { row, document } = readRevision(db, entry.chapterId, entry.revisionId)
  if (row.content_hash !== entry.contentHash || row.sequence !== entry.revisionSequence ||
      row.created_at !== entry.revisionCreatedAt || row.character_count !== entry.characterCount) return conflict()
  return document
}

function xml(value: string): string {
  // XML 不允许部分控制字符；报错保留原稿，不能为了成品可打开而悄悄删字。
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) {
      return invalid('内容含 EPUB 无法表示的控制字符，请先修正对应章节或改用 TXT 导出。')
    }
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\r/g, '&#13;')
}

function inlineXhtml(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '<br/>'
    let text = xml(node.text)
    if (node.marks?.some((mark) => mark.type === 'italic')) text = `<em>${text}</em>`
    if (node.marks?.some((mark) => mark.type === 'bold')) text = `<strong>${text}</strong>`
    return text
  }).join('')
}

function xhtmlPage(title: string, language: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(language)}" lang="${xml(language)}"><head><meta charset="utf-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body>${body}</body></html>`
}

export function renderBookExportChapter(document: ManuscriptDocument, title: string,
  options: Pick<BookExportManifest, 'outputFormat' | 'includeChapterTitles' | 'language'>): string {
  if (options.outputFormat === 'docx') return renderDocxChapter(document, title, options)
  if (options.outputFormat !== 'epub') return renderTextExport([{ title, document }], options.outputFormat, options.includeChapterTitles)
  const body = parseManuscript(document).content.map((block) => {
    if (block.type === 'horizontalRule') return '<hr/>'
    const tag = block.type === 'heading' ? `h${block.attrs.level + (options.includeChapterTitles ? 1 : 0)}` : 'p'
    return `<${tag}>${inlineXhtml(block.content ?? []) || '<br/>'}</${tag}>`
  }).join('\n')
  return xhtmlPage(title, options.language, `${options.includeChapterTitles ? `<h1>${xml(title)}</h1>` : ''}${body}`)
}

function includedChapters(manifest: BookExportManifest): BookExportChapterEntry[] {
  return manifest.chapters.filter((entry) => entry.state === 'included')
}
function chapterFile(index: number): string { return `chapter-${index + 1}.xhtml` }

function epubMetadata(manifest: BookExportManifest): { name: string; text: string }[] {
  const chapters = includedChapters(manifest)
  const navigation = xhtmlPage(manifest.bookTitle, manifest.language,
    `<h1>${xml(manifest.bookTitle)}</h1>${manifest.author ? `<p>${xml(manifest.author)}</p>` : ''}<nav epub:type="toc" id="toc"><h2>目录</h2><ol>${chapters.map((entry, index) => `<li><a href="${chapterFile(index)}">${xml(entry.title)}</a></li>`).join('')}</ol></nav>`)
  const packageDocument = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="${xml(manifest.language)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="publication-id">urn:uuid:${manifest.exportId}</dc:identifier><dc:title>${xml(manifest.bookTitle)}</dc:title><dc:language>${xml(manifest.language)}</dc:language>${manifest.author ? `<dc:creator>${xml(manifest.author)}</dc:creator>` : ''}<meta property="dcterms:modified">${manifest.createdAt.replace(/\.\d{3}Z$/, 'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="styles.css" media-type="text/css"/>${chapters.map((_, index) => `<item id="chapter-${index + 1}" href="${chapterFile(index)}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine><itemref idref="nav"/>${chapters.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`).join('')}</spine></package>`
  return [
    { name: 'mimetype', text: 'application/epub+zip' },
    { name: 'META-INF/container.xml', text: EPUB_CONTAINER },
    { name: 'EPUB/package.opf', text: packageDocument },
    { name: 'EPUB/nav.xhtml', text: navigation },
    { name: 'EPUB/styles.css', text: EPUB_STYLES },
  ]
}

function estimateBytes(manifest: BookExportManifest): number {
  const chapters = includedChapters(manifest)
  const contentBytes = chapters.reduce((sum, entry) => sum + (entry.contentBytes ?? 0), 0)
  if (manifest.outputFormat !== 'epub' && manifest.outputFormat !== 'docx') return contentBytes + Math.max(0, chapters.length - 1) * 2
  const parts = manifest.outputFormat === 'docx' ? docxDocumentParts(manifest) : null
  const entries: ZipEntry[] = parts
    ? [...docxMetadata(manifest).map((entry) => ({ name: entry.name, bytes: Buffer.byteLength(entry.text, 'utf8') })),
      { name: 'word/document.xml', bytes: contentBytes + Buffer.byteLength(parts.start, 'utf8') + Buffer.byteLength(parts.end, 'utf8') }]
    : [...epubMetadata(manifest).map((entry) => ({ name: entry.name, bytes: Buffer.byteLength(entry.text, 'utf8') })),
      ...chapters.map((entry, index) => ({ name: `EPUB/${chapterFile(index)}`, bytes: entry.contentBytes ?? 0 }))]
  // DOCX 的正文流在条目后写入 16 字节数据描述符，预览必须计入该开销。
  return 22 + (parts ? 16 : 0) + entries.reduce((sum, entry) => sum + 30 + 46 + Buffer.byteLength(entry.name, 'utf8') * 2 + entry.bytes, 0)
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function updateCrc32(bytes: Uint8Array, previous = 0xffffffff): number {
  let crc = previous
  for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 0xff]! ^ (crc >>> 8)
  return crc
}

class StoredZipWriter {
  private offset = 0
  private readonly directory: Buffer[] = []
  private readonly dosTime: number
  private readonly dosDate: number

  constructor(private readonly write: (bytes: Uint8Array) => void, createdAt: string) {
    const date = new Date(createdAt)
    this.dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2)
    this.dosDate = ((Math.max(1980, Math.min(2107, date.getUTCFullYear())) - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  }

  add(name: string, text: string | Iterable<string>, expectedBytes?: number): void {
    const filename = Buffer.from(name, 'utf8')
    const body = typeof text === 'string' ? Buffer.from(text, 'utf8') : null
    const size = body?.length ?? expectedBytes
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) return invalid('导出条目长度无效，请重新生成预览。')
    let checksum = body ? (updateCrc32(body) ^ 0xffffffff) >>> 0 : 0
    const descriptorBytes = body ? 0 : 16
    if (this.directory.length >= 0xffff || this.offset + size + filename.length + 30 + descriptorBytes > MAX_EXPORT_BYTES) return invalid('导出文件超过 2 GiB 上限，请减少导出章节。')
    // OCF 要求 mimetype 为首个无压缩条目，且局部头不能包含扩展字段。
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(body ? 10 : 20, 4)
    local.writeUInt16LE(body ? 0x0800 : 0x0808, 6)
    local.writeUInt16LE(this.dosTime, 10)
    local.writeUInt16LE(this.dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body ? size : 0, 18)
    local.writeUInt32LE(body ? size : 0, 22)
    local.writeUInt16LE(filename.length, 26)
    this.write(local); this.write(filename)
    if (body) this.write(body)
    else {
      // 正文 XML 按章流式写入同一 ZIP 条目，避免长篇作品占用整书内存。
      let written = 0
      let crc = 0xffffffff
      for (const part of text) {
        const chunk = Buffer.from(part, 'utf8')
        if (written + chunk.length > size) return conflict()
        this.write(chunk)
        written += chunk.length
        crc = updateCrc32(chunk, crc)
      }
      if (written !== size) return conflict()
      checksum = (crc ^ 0xffffffff) >>> 0
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(checksum, 4)
      descriptor.writeUInt32LE(size, 8)
      descriptor.writeUInt32LE(size, 12)
      this.write(descriptor)
    }
    const central = Buffer.alloc(46 + filename.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(body ? 10 : 20, 6)
    central.writeUInt16LE(body ? 0x0800 : 0x0808, 8)
    central.writeUInt16LE(this.dosTime, 12)
    central.writeUInt16LE(this.dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(filename.length, 28)
    central.writeUInt32LE(this.offset, 42)
    filename.copy(central, 46)
    this.offset += local.length + filename.length + size + descriptorBytes
    this.directory.push(central)
  }

  finish(): void {
    const size = this.directory.reduce((sum, entry) => sum + entry.length, 0)
    if (this.offset + size + 22 > MAX_EXPORT_BYTES) return invalid('导出文件超过 2 GiB 上限，请减少导出章节。')
    for (const entry of this.directory) this.write(entry)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.directory.length, 8)
    end.writeUInt16LE(this.directory.length, 10)
    end.writeUInt32LE(size, 12)
    end.writeUInt32LE(this.offset, 16)
    this.write(end)
  }
}

export function writeBookExport(manifest: BookExportManifest,
  readDocument: (entry: BookExportChapterEntry) => ManuscriptDocument, write: (bytes: Uint8Array) => void): void {
  const chapters = includedChapters(manifest)
  const chapterText = (entry: BookExportChapterEntry): string => {
    const text = renderBookExportChapter(readDocument(entry), entry.title, manifest)
    if (Buffer.byteLength(text, 'utf8') !== entry.contentBytes) return conflict()
    return text
  }
  if (manifest.outputFormat === 'docx') {
    const archive = new StoredZipWriter(write, manifest.createdAt)
    const parts = docxDocumentParts(manifest)
    for (const entry of docxMetadata(manifest)) archive.add(entry.name, entry.text)
    const documentBytes = chapters.reduce((sum, entry) => sum + (entry.contentBytes ?? 0), 0)
      + Buffer.byteLength(parts.start, 'utf8') + Buffer.byteLength(parts.end, 'utf8')
    function* documentParts(): Generator<string> {
      yield parts.start
      for (const entry of chapters) yield chapterText(entry)
      yield parts.end
    }
    archive.add('word/document.xml', documentParts(), documentBytes)
    archive.finish()
  } else if (manifest.outputFormat === 'epub') {
    const archive = new StoredZipWriter(write, manifest.createdAt)
    for (const entry of epubMetadata(manifest)) archive.add(entry.name, entry.text)
    chapters.forEach((entry, index) => archive.add(`EPUB/${chapterFile(index)}`, chapterText(entry)))
    archive.finish()
  } else {
    chapters.forEach((entry, index) => {
      if (index > 0) write(Buffer.from('\n\n', 'utf8'))
      write(Buffer.from(chapterText(entry), 'utf8'))
    })
  }
}

function targetPaths(filePath: string, format: BookExportManifest['outputFormat']): { target: string; manifestPath: string; parent: string; parentInfo: Stats } {
  if (!/^[a-z]:[\\/]/i.test(filePath) || filePath.slice(2).includes(':') || filePath.includes('\0')) return invalid('请选择本机磁盘中的普通导出文件。')
  const requested = resolve(filePath)
  const name = basename(requested)
  if (!name || /[<>:"|?*\x00-\x1f]/.test(name) || /[ .]$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(name)) return invalid('导出文件名无效，请使用普通文件名。')
  if (extname(requested).toLowerCase() !== `.${bookExportExtension(format)}`) return invalid(`文件扩展名必须是 .${bookExportExtension(format)}。`)
  const parent = realpathSync.native(dirname(requested))
  const parentInfo = lstatSync(parent)
  if (!/^[a-z]:[\\/]/i.test(parent) || resolve(parent).toLowerCase() !== dirname(requested).toLowerCase() ||
      !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) return invalid('不支持链接目录或网络位置，请选择本机普通目录。')
  const target = join(parent, name)
  const manifestPath = `${target}.manifest.json`
  for (const path of [target, manifestPath]) {
    if (lstatSync(path, { throwIfNoEntry: false })) return invalid(`同名文件已存在，未覆盖任何内容：${path}。请选择新的文件名。`)
  }
  return { target, manifestPath, parent, parentInfo }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written === 0) throw storageFailure('文件未能完整写入。')
    offset += written
  }
}

function writeFiles(filePath: string, preview: BookExportPreview, producer: (write: (bytes: Uint8Array) => void) => void): BookExportReceipt {
  const paths = targetPaths(filePath, preview.manifest.outputFormat)
  const created: string[] = []
  let outputFd: number | undefined
  let manifestFd: number | undefined
  let bytes = 0
  const outputHash = createHash('sha256')
  const checkParent = () => {
    const current = lstatSync(paths.parent)
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== paths.parentInfo.dev || current.ino !== paths.parentInfo.ino ||
        realpathSync.native(paths.parent).toLowerCase() !== paths.parent.toLowerCase()) throw storageFailure('导出目标目录在操作期间发生变化。')
  }
  try {
    checkParent()
    // 两个文件均以 wx 独占新建；失败保留已创建文件，不移除或覆盖作者资产。
    outputFd = openSync(paths.target, 'wx')
    created.push(paths.target)
    manifestFd = openSync(paths.manifestPath, 'wx')
    created.push(paths.manifestPath)
    const outputIdentity = fstatSync(outputFd)
    const manifestIdentity = fstatSync(manifestFd)
    if (!outputIdentity.isFile() || outputIdentity.nlink !== 1 || !manifestIdentity.isFile() || manifestIdentity.nlink !== 1) throw storageFailure('导出目标必须是新建的普通文件。')
    producer((chunk) => {
      if (bytes + chunk.length > MAX_EXPORT_BYTES) return invalid('导出文件超过 2 GiB 上限，请减少导出章节。')
      writeAll(outputFd!, chunk)
      outputHash.update(chunk)
      bytes += chunk.length
    })
    if (bytes !== preview.estimatedBytes) throw storageFailure('实际导出长度与预览清单不一致。')
    fsyncSync(outputFd)
    const sha256 = outputHash.digest('hex')
    const manifestBytes = Buffer.from(JSON.stringify({ format: 'storyweave-export-receipt', version: 1,
      manifest: preview.manifest, manifestHash: preview.manifestHash, output: { bytes, sha256 } }, null, 2) + '\n', 'utf8')
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw storageFailure('版本清单超过容量上限。')
    writeAll(manifestFd, manifestBytes)
    fsyncSync(manifestFd)
    checkParent()
    for (const [path, identity, size] of [[paths.target, outputIdentity, bytes], [paths.manifestPath, manifestIdentity, manifestBytes.length]] as const) {
      const current = lstatSync(path)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino || current.size !== size) throw storageFailure('导出文件在写入期间发生变化，请核对保留文件。')
    }
    closeSync(outputFd); outputFd = undefined
    closeSync(manifestFd); manifestFd = undefined
    return { exportId: preview.manifest.exportId, bookId: preview.manifest.bookId, bookRevision: preview.manifest.bookRevision,
      chapterCount: preview.chapterCount, characterCount: preview.characterCount, skippedCount: preview.skippedCount,
      filePath: paths.target, bytes, manifestPath: paths.manifestPath, manifestBytes: manifestBytes.length,
      manifestHash: preview.manifestHash, sha256 }
  } catch (error) {
    const detail = error instanceof DomainError ? error.detail : { code: 'STORAGE_ERROR' as const, message: '成品或版本清单写入失败，请检查磁盘与目标文件。' }
    throw new DomainError({ ...detail, message: `${detail.message}${created.length ? ` 本次未完成，已创建文件保留在：${created.join('；')}。请核对后另选文件名。` : ''}` })
  } finally {
    for (const fd of [outputFd, manifestFd]) if (fd !== undefined) { try { closeSync(fd) } catch { /* 保留文件，由调用方报告写入未完成。 */ } }
  }
}

export class BookExportRepository {
  private prepared: PreparedExport | null = null

  constructor(private readonly studio: StudioRepository) {}

  clear(): void { this.prepared = null }

  prepare(input: BookExportPrepareInput): BookExportPreview {
    return perform(() => {
      const data = parseBookExportPrepareInput(input)
      const source = this.studio.getBookRecoverySource(data.bookId, data.expectedBookRevision)
      return source.db.transaction(() => {
        const title = requireBook(source.db, data.bookId, data.expectedBookRevision)
        const outline = readOutline(source.db)
        const availableIds = new Set(outline.map((row) => row.id))
        if (data.chapterIds.some((id) => !availableIds.has(id))) return invalid('所选章节已不在作品目录中，请刷新作品后重新选择。')
        const selected = new Set(data.chapterIds)
        const manifest: BookExportManifest = { format: 'storyweave-book-export', version: 1, exportId: randomUUID(),
          createdAt: new Date().toISOString(), bookId: data.bookId, bookTitle: title, bookRevision: data.expectedBookRevision,
          outputFormat: data.format, scope: data.scope, includeChapterTitles: data.includeChapterTitles, author: data.author,
          language: data.language, ...(data.docx ? { docx: data.docx } : {}), chapters: [] }
        if (data.format === 'epub') { xml(title); xml(data.author) }
        for (const row of outline) {
          const isSelected = selected.has(row.id)
          const revisionId = data.scope === 'working' ? row.current_revision_id : row.finalized_revision_id
          const entry: BookExportChapterEntry = { chapterId: row.id, title: row.title, position: row.position,
            volumeId: row.volume_id, volumeTitle: row.volume_title, status: row.status, selected: isSelected,
            state: !isSelected ? 'not_selected' : revisionId === null ? 'not_finalized' : 'included',
            reason: !isSelected ? '未勾选，不在本次交付范围。' : revisionId === null ? '没有作者定稿，本次将跳过。' : null,
            revisionId, revisionSequence: null, revisionCreatedAt: null, contentHash: null, characterCount: null, contentBytes: null }
          if (entry.state === 'included' && revisionId) {
            try {
              const { row: revision, document } = readRevision(source.db, row.id, revisionId)
              const text = renderBookExportChapter(document, row.title, manifest)
              Object.assign(entry, { revisionSequence: revision.sequence, revisionCreatedAt: revision.created_at,
                contentHash: revision.content_hash, characterCount: revision.character_count, contentBytes: Buffer.byteLength(text, 'utf8') })
            } catch (error) {
              if (!(error instanceof DomainError)) throw error
              entry.state = 'unavailable'
              entry.reason = error.detail.message
            }
          }
          manifest.chapters.push(entry)
        }
        const included = includedChapters(manifest)
        const skippedCount = manifest.chapters.filter((entry) => entry.state === 'not_selected' || entry.state === 'not_finalized').length
        const emptyCount = included.filter((entry) => entry.characterCount === 0).length
        const unavailable = manifest.chapters.filter((entry) => entry.state === 'unavailable')
        const estimatedBytes = estimateBytes(manifest)
        const blockingReasons: string[] = []
        if (unavailable.length) blockingReasons.push(`${unavailable.length} 个已选章节的正文不可用，请逐章查看原因。`)
        if (!included.length) blockingReasons.push('当前选择没有可导出的章节。')
        if (estimatedBytes > MAX_EXPORT_BYTES) blockingReasons.push('成品预计超过 2 GiB，请减少导出章节。')
        if (Buffer.byteLength(JSON.stringify({ manifest }, null, 2), 'utf8') > MAX_MANIFEST_BYTES - 4096) blockingReasons.push('版本清单超过容量上限，请减少目录规模后重试。')
        const warnings: string[] = []
        if (skippedCount) warnings.push(`本次有 ${skippedCount} 个章节不进入成品，原因已列在清单中。`)
        if (emptyCount) warnings.push(`${emptyCount} 个已选章节正文为空，仍会作为章节导出。`)
        if (data.scope === 'finalized') warnings.push('使用各章最后一次作者定稿；其后对工作稿的修改不会进入成品。')
        const preview: BookExportPreview = { token: manifest.exportId, manifestHash: hash(JSON.stringify(manifest)), manifest,
          expiresAt: new Date(Date.parse(manifest.createdAt) + BOOK_EXPORT_PREVIEW_TTL).toISOString(), chapterCount: included.length,
          characterCount: included.reduce((sum, entry) => sum + (entry.characterCount ?? 0), 0), skippedCount, emptyCount,
          estimatedBytes, requiresAcknowledgement: skippedCount > 0 || emptyCount > 0, canExport: blockingReasons.length === 0,
          warnings, blockingReasons }
        this.prepared = { preview, outlineHash: hash(JSON.stringify(outline)), rootPath: source.rootPath, generation: source.generation }
        return structuredClone(preview)
      })()
    })
  }

  readChapter(input: BookExportChapterInput): BookExportChapterPreview {
    const data = parseBookExportChapterInput(input)
    return this.withPrepared(data, (db, preview) => {
      const entry = preview.manifest.chapters.find((chapter) => chapter.chapterId === data.chapterId)
      if (!entry || entry.state !== 'included' || !entry.revisionId) return invalid('请选择清单中可导出的章节进行预览。')
      const document = fixedRevision(db, entry)
      return { bookId: data.bookId, chapterId: entry.chapterId, revisionId: entry.revisionId, title: entry.title,
        format: preview.manifest.outputFormat, language: preview.manifest.language, includeChapterTitles: preview.manifest.includeChapterTitles, document,
        text: preview.manifest.outputFormat === 'epub' || preview.manifest.outputFormat === 'docx'
          ? documentToText(document) : renderBookExportChapter(document, entry.title, preview.manifest) }
    })
  }

  export(input: BookExportCommitServiceInput): BookExportReceipt {
    const data = parseBookExportCommitServiceInput(input)
    return this.withPrepared(data, (db, preview) => {
      if (data.format !== preview.manifest.outputFormat) return invalid('文件格式与预览不一致，请重新生成预览。')
      if (!preview.canExport) return invalid(preview.blockingReasons.join(' '))
      if (preview.requiresAcknowledgement && !data.acknowledgeOmissions) return invalid('请确认跳过与空白章节后再导出。')
      return writeFiles(data.filePath, preview, (write) => writeBookExport(preview.manifest, (entry) => fixedRevision(db, entry), write))
    })
  }

  private withPrepared<T>(input: BookExportReference, operation: (db: Database.Database, preview: BookExportPreview) => T): T {
    return perform(() => {
      const prepared = this.prepared
      if (!prepared || prepared.preview.token !== input.token || prepared.preview.manifestHash !== input.manifestHash ||
          prepared.preview.manifest.bookId !== input.bookId || prepared.preview.manifest.bookRevision !== input.expectedBookRevision) {
        return invalid('导出预览已失效，请重新生成预览。')
      }
      if (Date.now() > Date.parse(prepared.preview.expiresAt)) return invalid('导出预览已超过 30 分钟，请重新核对清单。')
      const source = this.studio.getBookRecoverySource(input.bookId, input.expectedBookRevision)
      if (source.rootPath !== prepared.rootPath || source.generation !== prepared.generation) return conflict()
      return source.db.transaction(() => {
        if (requireBook(source.db, input.bookId, input.expectedBookRevision) !== prepared.preview.manifest.bookTitle ||
            hash(JSON.stringify(readOutline(source.db))) !== prepared.outlineHash) return conflict()
        // 正文只按清单中固定的修订读取；同时固定作品版本，防止晚到回执跨书库或跨目录生效。
        return operation(source.db, prepared.preview)
      })()
    })
  }
}
