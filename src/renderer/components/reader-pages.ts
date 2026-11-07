import type { InlineNode, ManuscriptDocument } from '../../contracts/manuscript'

export const READER_PAGE_CHARACTERS = 12_000
export const READER_PAGE_BLOCKS = 60
export const READER_PAGE_INLINE_NODES = 600

export interface ReaderBlock {
  id: string
  part: number
  type: 'paragraph' | 'heading' | 'horizontalRule'
  level?: 1 | 2 | 3
  content: InlineNode[]
  continued: boolean
  continues: boolean
}

export interface ReaderPage { blocks: ReaderBlock[] }

/** 阅读分页只切分显示片段，保留原段落身份、文字格式及空段，不修改稿件。 */
export function paginateReaderDocument(document: ManuscriptDocument): ReaderPage[] {
  const pages: ReaderPage[] = []
  let page: ReaderPage = { blocks: [] }
  let characters = 0
  let inlineNodes = 0
  let fragment: ReaderBlock | null = null

  function nextPage() {
    if (page.blocks.length) pages.push(page)
    page = { blocks: [] }; characters = 0; inlineNodes = 0; fragment = null
  }

  function requireRoom() {
    if (characters >= READER_PAGE_CHARACTERS || inlineNodes >= READER_PAGE_INLINE_NODES ||
        (!fragment && page.blocks.length >= READER_PAGE_BLOCKS)) nextPage()
  }

  for (const block of document.content) {
    fragment = null
    let previousFragment: ReaderBlock | null = null
    let part = 0

    function currentFragment(): ReaderBlock {
      if (fragment) return fragment
      fragment = {
        id: block.attrs.id, part: part++, type: block.type,
        ...(block.type === 'heading' ? { level: block.attrs.level } : {}),
        content: [], continued: previousFragment !== null, continues: false,
      }
      if (previousFragment) previousFragment.continues = true
      previousFragment = fragment
      page.blocks.push(fragment)
      return fragment
    }

    if (block.type === 'horizontalRule' || !block.content?.length) {
      requireRoom(); currentFragment()
      continue
    }

    for (let nodeIndex = 0; nodeIndex < block.content.length; nodeIndex += 1) {
      const node = block.content[nodeIndex]
      if (node.type === 'hardBreak') {
        requireRoom()
        currentFragment().content.push({ type: 'hardBreak' })
        characters += 1; inlineNodes += 1
        continue
      }

      let offset = 0
      const nextNode = block.content[nodeIndex + 1]
      const pairedAcrossNodes = isHighSurrogate(node.text.charCodeAt(node.text.length - 1)) &&
        nextNode?.type === 'text' && isLowSurrogate(nextNode.text.charCodeAt(0))
      while (offset < node.text.length) {
        requireRoom()
        let end = Math.min(node.text.length, offset + READER_PAGE_CHARACTERS - characters)
        // UTF-16 边界不能拆开一个代理对；剩余一格容不下时从下一页继续。
        if (end < node.text.length && isHighSurrogate(node.text.charCodeAt(end - 1)) &&
            isLowSurrogate(node.text.charCodeAt(end))) end -= 1
        // 相邻格式片段也可能各含半个代理对，须为下一片段预留一个字符和一个节点。
        if (pairedAcrossNodes && end === node.text.length &&
            (characters + end - offset + 1 > READER_PAGE_CHARACTERS || inlineNodes + 2 > READER_PAGE_INLINE_NODES)) end -= 1
        if (end === offset) { nextPage(); continue }
        currentFragment().content.push({ type: 'text', text: node.text.slice(offset, end),
          ...(node.marks ? { marks: node.marks } : {}) })
        characters += end - offset; inlineNodes += 1; offset = end
      }
    }
  }
  if (page.blocks.length || pages.length === 0) pages.push(page)
  return pages
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff }
