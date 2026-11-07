import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const MAX_SEARCH_MATCHES = 2000
export interface TextMatch { from: number; to: number }
export interface MatchResult { matches: TextMatch[]; truncated: boolean }
export interface SearchHighlight { matches: TextMatch[]; activeIndex: number }
export const searchHighlightKey = new PluginKey<DecorationSet>('manuscriptLiteralSearch')

export const ManuscriptSearchHighlights = Extension.create({
  name: 'manuscriptLiteralSearch',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: searchHighlightKey,
      state: {
        init: () => DecorationSet.empty,
        apply(transaction, previous) {
          const highlight = transaction.getMeta(searchHighlightKey) as SearchHighlight | undefined
          if (highlight) return DecorationSet.create(transaction.doc, highlight.matches.map((match, index) => Decoration.inline(match.from, match.to, {
            class: index === highlight.activeIndex ? 'manuscript-search-match manuscript-search-current' : 'manuscript-search-match',
          })))
          return transaction.docChanged ? previous.map(transaction.mapping, transaction.doc) : previous
        },
      },
      props: { decorations: (state) => searchHighlightKey.getState(state) ?? DecorationSet.empty },
    })]
  },
})

function foldedText(text: string): { text: string; boundaries: number[] } {
  const parts: string[] = []
  const boundaries = [0]
  let originalOffset = 0
  // 大小写转换可能改变 UTF-16 长度；保留原文边界，不能把折叠后的下标当正文位置。
  for (const character of text) {
    const folded = character.toLowerCase()
    parts.push(folded)
    for (let index = 1; index < folded.length; index += 1) boundaries.push(-1)
    originalOffset += character.length
    boundaries.push(originalOffset)
  }
  return { text: parts.join(''), boundaries }
}

export function findLiteralMatches(document: ProseMirrorNode, query: string, caseSensitive: boolean): MatchResult {
  const matches: TextMatch[] = []
  let truncated = false
  if (!query || query.includes('\n') || query.includes('\r')) return { matches, truncated }
  const needle = caseSensitive ? query : foldedText(query).text

  function scan(text: string, start: number) {
    if (!text || truncated) return
    const folded = caseSensitive ? null : foldedText(text)
    const haystack = folded?.text ?? text
    let offset = 0
    while (offset <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, offset)
      if (index === -1) break
      const from = folded ? folded.boundaries[index] : index
      const to = folded ? folded.boundaries[index + needle.length] : index + needle.length
      if (from === -1 || to === -1) { offset = index + 1; continue }
      if (matches.length === MAX_SEARCH_MATCHES) { truncated = true; break }
      matches.push({ from: start + from, to: start + to })
      offset = index + needle.length
    }
  }

  document.descendants((node, position) => {
    if (truncated) return false
    if (!node.isTextblock) return true
    let text = ''
    let start = position + 1
    node.forEach((child, offset) => {
      if (truncated) return
      if (child.isText) {
        if (!text) start = position + 1 + offset
        text += child.text ?? ''
      } else {
        // 同段落的不同 marks 可以合并查找；hardBreak 等非文字节点必须切断匹配。
        scan(text, start); text = ''
      }
    })
    scan(text, start)
    return false
  })
  return { matches, truncated }
}

export function manuscriptLength(document: ProseMirrorNode): number {
  let length = Math.max(0, document.childCount - 1)
  document.descendants((node) => {
    if (node.isText) length += node.text?.length ?? 0
    else if (node.type.name === 'hardBreak') length += 1
  })
  return length
}
