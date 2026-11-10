import { DomainError } from '../../contracts/api'
import type { BookExportManifest } from '../../contracts/export'
import { parseManuscript, type InlineNode, type ManuscriptDocument } from '../../contracts/manuscript'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function xml(value: string): string {
  // XML 1.0 无法表示的字符必须报错，不能静默删去作者原文。
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) {
      throw new DomainError({ code: 'INVALID_INPUT', message: '内容含 DOCX 无法表示的字符，请先修正对应文字或改用 TXT 导出。' })
    }
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\r/g, '&#13;')
}

function inline(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '<w:r><w:br/></w:r>'
    const marks = `${node.marks?.some((mark) => mark.type === 'bold') ? '<w:b/><w:bCs/>' : ''}${node.marks?.some((mark) => mark.type === 'italic') ? '<w:i/><w:iCs/>' : ''}`
    // Word 的换行与制表符是独立节点；保留行首尾空格和文字原有格式。
    const text = node.text.split(/(\r\n|\r|\n|\t)/).map((part) => part === '\t' ? '<w:tab/>'
      : /^(?:\r\n|\r|\n)$/.test(part) ? '<w:br/>' : `<w:t xml:space="preserve">${xml(part)}</w:t>`).join('')
    return `<w:r>${marks ? `<w:rPr>${marks}</w:rPr>` : ''}${text}</w:r>`
  }).join('')
}

function paragraph(style: string, content: string, newPage = false): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${newPage ? '<w:pageBreakBefore/>' : ''}</w:pPr>${content}</w:p>`
}

function textParagraph(style: string, text: string, newPage = false): string {
  return paragraph(style, inline([{ type: 'text', text }]), newPage)
}

export function renderDocxChapter(document: ManuscriptDocument, title: string,
  options: Pick<BookExportManifest, 'includeChapterTitles'>): string {
  const blocks = parseManuscript(document).content.map((block, index) => {
    const newPage = !options.includeChapterTitles && index === 0
    if (block.type === 'horizontalRule') return textParagraph('SceneBreak', '* * *', newPage)
    const style = block.type === 'heading' ? `Heading${block.attrs.level + (options.includeChapterTitles ? 1 : 0)}` : 'Normal'
    return paragraph(style, inline(block.content ?? []), newPage)
  }).join('')
  return `${options.includeChapterTitles ? textParagraph('Heading1', title, true) : ''}${blocks}`
}

function note(title: string, text: string | undefined): string {
  if (!text) return ''
  return textParagraph('Heading1', title, true) + text.split(/\r\n|\r|\n/).map((line) => textParagraph('Normal', line)).join('')
}

export function docxDocumentParts(manifest: BookExportManifest): { start: string; end: string } {
  const title = textParagraph('Title', manifest.bookTitle) + (manifest.author ? textParagraph('Author', manifest.author) : '')
  const section = `<w:sectPr>${manifest.docx?.submissionLayout ? '<w:footerReference w:type="default" r:id="footer"/>' : ''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`
  return {
    start: `${XML}<w:document xmlns:w="${WORD_NS}" xmlns:r="${OFFICE_REL_NS}"><w:body>${title}${note('前言', manifest.docx?.preface)}`,
    end: `${note('后记', manifest.docx?.afterword)}${section}</w:body></w:document>`,
  }
}

function styles(manifest: BookExportManifest): string {
  const submission = manifest.docx?.submissionLayout ?? false
  const paragraphDefaults = `<w:spacing w:after="${submission ? 0 : 160}" w:line="${submission ? 480 : 360}" w:lineRule="auto"/><w:ind w:firstLineChars="${submission ? 200 : 0}"/>`
  const headingStyles = [1, 2, 3, 4].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="160"/><w:ind w:firstLineChars="0"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${36 - level * 2}"/><w:szCs w:val="${36 - level * 2}"/></w:rPr></w:style>`).join('')
  const centered = (id: string, size: number) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="240"/><w:ind w:firstLineChars="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`
  return `${XML}<w:styles xmlns:w="${WORD_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="${xml(manifest.language)}" w:eastAsia="${xml(manifest.language)}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/>${paragraphDefaults}</w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${headingStyles}${centered('Title', 40)}${centered('Author', 24)}${centered('SceneBreak', 24)}${centered('Footer', 20)}</w:styles>`
}

export function docxMetadata(manifest: BookExportManifest): { name: string; text: string }[] {
  const submission = manifest.docx?.submissionLayout ?? false
  const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml'
  return [
    { name: '[Content_Types].xml', text: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${wordType}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${wordType}.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${submission ? `<Override PartName="/word/footer.xml" ContentType="${wordType}.footer+xml"/>` : ''}</Types>` },
    { name: '_rels/.rels', text: `${XML}<Relationships xmlns="${REL_NS}"><Relationship Id="document" Type="${OFFICE_REL_NS}/officeDocument" Target="word/document.xml"/><Relationship Id="core" Type="${REL_NS}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', text: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(manifest.bookTitle)}</dc:title><dc:creator>${xml(manifest.author)}</dc:creator><dc:language>${xml(manifest.language)}</dc:language><dc:identifier>urn:uuid:${xml(manifest.exportId)}</dc:identifier><dcterms:created xsi:type="dcterms:W3CDTF">${xml(manifest.createdAt)}</dcterms:created></cp:coreProperties>` },
    { name: 'word/_rels/document.xml.rels', text: `${XML}<Relationships xmlns="${REL_NS}"><Relationship Id="styles" Type="${OFFICE_REL_NS}/styles" Target="styles.xml"/>${submission ? `<Relationship Id="footer" Type="${OFFICE_REL_NS}/footer" Target="footer.xml"/>` : ''}</Relationships>` },
    { name: 'word/styles.xml', text: styles(manifest) },
    ...(submission ? [{ name: 'word/footer.xml', text: `${XML}<w:ftr xmlns:w="${WORD_NS}"><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>` }] : []),
  ]
}
