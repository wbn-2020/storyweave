import { DomainError, isRecord } from './api'

export const MAX_CHAPTER_LENGTH = 1_000_000
export const MAX_CHAPTER_BLOCKS = 20_000
const MAX_INLINE_NODES = 100_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TextNode {
  type: 'text'
  text: string
  marks?: { type: 'bold' | 'italic' }[]
}

export interface HardBreakNode { type: 'hardBreak' }
export type InlineNode = TextNode | HardBreakNode
export interface ParagraphBlock {
  type: 'paragraph'
  attrs: { id: string }
  content?: InlineNode[]
}
export interface HeadingBlock {
  type: 'heading'
  attrs: { id: string; level: 1 | 2 | 3 }
  content?: InlineNode[]
}
export interface HorizontalRuleBlock {
  type: 'horizontalRule'
  attrs: { id: string }
}
export type ManuscriptBlock = ParagraphBlock | HeadingBlock | HorizontalRuleBlock
export interface ManuscriptDocument { type: 'doc'; content: ManuscriptBlock[] }

function invalid(message: string): never {
  throw new DomainError({ code: 'INVALID_INPUT', message })
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid('正文含当前版本不支持的字段，请保留原稿后检查编辑格式。')
  }
}

// 严格校验后重建允许的结构，避免不支持的节点被悄悄丢掉而仍显示保存成功。
export function parseManuscript(value: unknown): ManuscriptDocument {
  if (!isRecord(value) || value.type !== 'doc' || !Array.isArray(value.content)) {
    return invalid('正文必须是有效的章节文档。')
  }
  fields(value, ['type', 'content'])
  if (value.content.length === 0 || value.content.length > MAX_CHAPTER_BLOCKS) {
    return invalid(`章节应包含 1 至 ${MAX_CHAPTER_BLOCKS} 个段落或分隔块。`)
  }

  const blockIds = new Set<string>()
  let textLength = value.content.length - 1
  let inlineCount = 0
  const content: ManuscriptBlock[] = Array.from(value.content, (block: unknown) => {
    if (!isRecord(block) || !['paragraph', 'heading', 'horizontalRule'].includes(String(block.type))) {
      return invalid('正文含当前版本不支持的块类型。')
    }
    fields(block, block.type === 'horizontalRule' ? ['type', 'attrs'] : ['type', 'attrs', 'content'])
    if (!isRecord(block.attrs) || typeof block.attrs.id !== 'string' || !UUID.test(block.attrs.id)) {
      return invalid('正文段落缺少有效的来源标识，未保存本次修改。')
    }
    fields(block.attrs, block.type === 'heading' ? ['id', 'level'] : ['id'])
    const id = block.attrs.id.toLowerCase()
    if (blockIds.has(id)) return invalid('正文存在重复的段落标识，未保存本次修改。')
    blockIds.add(id)
    if (block.type === 'horizontalRule') return { type: 'horizontalRule', attrs: { id } }
    if (block.type === 'heading' && (typeof block.attrs.level !== 'number' || ![1, 2, 3].includes(block.attrs.level))) {
      return invalid('章节标题层级只支持数字 1 至 3。')
    }
    if (block.content !== undefined && !Array.isArray(block.content)) {
      return invalid('段落内容格式无效。')
    }
    const rawContent: unknown[] = (block.content as unknown[] | undefined) ?? []
    inlineCount += rawContent.length
    if (inlineCount > MAX_INLINE_NODES) return invalid('章节格式片段过多，请拆分章节后再保存。')
    const inline: InlineNode[] = Array.from(rawContent, (node: unknown) => {
      if (!isRecord(node)) return invalid('段落含无效内容。')
      if (node.type === 'hardBreak') {
        fields(node, ['type'])
        textLength += 1
        return { type: 'hardBreak' }
      }
      if (node.type !== 'text' || typeof node.text !== 'string' || node.text.length === 0) {
        return invalid('段落仅支持文字与换行。')
      }
      fields(node, ['type', 'text', 'marks'])
      textLength += node.text.length
      if (textLength > MAX_CHAPTER_LENGTH) return invalid('单章超过 100 万 UTF-16 字符，请拆分后再保存。')
      // 孤立代理字符在 UTF-8 入库时会被替换，导致 JSON 原文与纯文本无法一致回读。
      for (const character of node.text) {
        const code = character.charCodeAt(0)
        if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) {
          return invalid('正文含不完整的 Unicode 字符，未保存本次修改。请保留原稿并修正异常字符。')
        }
      }
      if (node.marks !== undefined && !Array.isArray(node.marks)) return invalid('文字格式标记无效。')
      const rawMarks: unknown[] = (node.marks as unknown[] | undefined) ?? []
      if (rawMarks.length > 2) return invalid('文字仅支持加粗与斜体。')
      const markTypes = new Set<'bold' | 'italic'>()
      for (const mark of rawMarks) {
        if (!isRecord(mark) || (mark.type !== 'bold' && mark.type !== 'italic')) {
          return invalid('文字含不支持的格式标记。')
        }
        fields(mark, ['type'])
        if (markTypes.has(mark.type)) return invalid('文字含重复的格式标记。')
        markTypes.add(mark.type)
      }
      const marks = (['bold', 'italic'] as const).filter((type) => markTypes.has(type)).map((type) => ({ type }))
      return marks.length ? { type: 'text', text: node.text, marks } : { type: 'text', text: node.text }
    })
    const children = inline.length ? { content: inline } : {}
    if (block.type === 'heading') {
      return { type: 'heading', attrs: { id, level: block.attrs.level as 1 | 2 | 3 }, ...children }
    }
    return { type: 'paragraph', attrs: { id }, ...children }
  })
  if (textLength > MAX_CHAPTER_LENGTH) return invalid('单章超过 100 万 UTF-16 字符，请拆分后再保存。')
  return { type: 'doc', content }
}

export function documentToText(document: ManuscriptDocument): string {
  return document.content.map((block) => block.type === 'horizontalRule'
    ? ''
    : (block.content ?? []).map((node) => node.type === 'hardBreak' ? '\n' : node.text).join('')).join('\n')
}

export function countCharacters(text: string): number {
  let count = 0
  for (const character of text) if (!/\s/u.test(character)) count += 1
  return count
}

export function emptyDocument(): ManuscriptDocument {
  return { type: 'doc', content: [{ type: 'paragraph', attrs: { id: globalThis.crypto.randomUUID() } }] }
}
