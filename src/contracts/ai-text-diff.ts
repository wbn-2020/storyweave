export interface AiTextHunk {
  readonly id: number
  readonly originalStart: number
  readonly originalEnd: number
  readonly originalText: string
  readonly suggestedText: string
  readonly coarse: boolean
}

export interface AiTextComparison {
  readonly originalText: string
  readonly suggestedText: string
  readonly hunks: readonly AiTextHunk[]
}

export const AI_TEXT_DIFF_MAX_CHARACTERS = 200_000
const MAX_PARAGRAPHS = 10_000
const MAX_LCS_CELLS = 250_000
interface Paragraph { start: number; key: number }
interface Anchor { original: number; suggested: number }

function paragraphs(text: string, keys: Map<string, number>): Paragraph[] | null {
  const result: Paragraph[] = []
  // 换行属于原段落，空行、缩进及 CRLF 都保留原字节；合并时不 trim 或重新拼接分隔符。
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) continue
    if (result.length === MAX_PARAGRAPHS) return null
    let key = keys.get(match[0])
    if (key === undefined) { key = keys.size; keys.set(match[0], key) }
    const start = match.index!
    result.push({ start, key })
  }
  return result
}

function uniquePositions(items: Paragraph[], start: number, end: number): Map<number, number> {
  const positions = new Map<number, number>()
  for (let index = start; index < end; index += 1) {
    const key = items[index].key
    positions.set(key, positions.has(key) ? -1 : index)
  }
  return positions
}

function anchors(original: Paragraph[], suggested: Paragraph[], start: number, originalEnd: number, suggestedEnd: number): Anchor[] {
  const left = uniquePositions(original, start, originalEnd)
  const right = uniquePositions(suggested, start, suggestedEnd)
  const candidates: Anchor[] = []
  for (let index = start; index < originalEnd; index += 1) {
    const key = original[index].key
    const other = right.get(key)
    if (left.get(key) === index && other !== undefined && other >= 0) candidates.push({ original: index, suggested: other })
  }
  // 唯一相同段落按最长递增序列对齐；不依赖模型提供的段落 ID，也不把交叉的移动当成相同位置。
  const tails: number[] = []
  const previous = new Array<number>(candidates.length).fill(-1)
  candidates.forEach((candidate, index) => {
    let low = 0, high = tails.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (candidates[tails[middle]].suggested < candidate.suggested) low = middle + 1
      else high = middle
    }
    if (low) previous[index] = tails[low - 1]
    tails[low] = index
  })
  const result: Anchor[] = []
  for (let index = tails.length ? tails[tails.length - 1] : -1; index !== -1; index = previous[index]) result.push(candidates[index])
  return result.reverse()
}

export function compareAiText(originalText: string, suggestedText: string): AiTextComparison {
  if (originalText.length + suggestedText.length > AI_TEXT_DIFF_MAX_CHARACTERS) {
    throw new RangeError('两份文本合计超过 200,000 字符，请缩小改写范围后再逐段比较。')
  }
  if (originalText === suggestedText) return { originalText, suggestedText, hunks: [] }
  const keys = new Map<string, number>()
  const original = paragraphs(originalText, keys), suggested = paragraphs(suggestedText, keys)
  if (!original || !suggested) return { originalText, suggestedText, hunks: [
    { id: 0, originalStart: 0, originalEnd: originalText.length, originalText, suggestedText, coarse: true },
  ] }
  const hunks: AiTextHunk[] = []
  const offset = (items: Paragraph[], index: number, text: string) => items[index]?.start ?? text.length
  function add(a: number, endA: number, b: number, endB: number, coarse = false) {
    if (a === endA && b === endB) return
    const originalStart = offset(original!, a, originalText), originalEnd = offset(original!, endA, originalText)
    hunks.push({ id: hunks.length, originalStart, originalEnd, originalText: originalText.slice(originalStart, originalEnd),
      suggestedText: suggestedText.slice(offset(suggested!, b, suggestedText), offset(suggested!, endB, suggestedText)), coarse })
  }

  let budget = MAX_LCS_CELLS
  function gap(a: number, endA: number, b: number, endB: number) {
    if (a === endA || b === endB) { add(a, endA, b, endB); return }
    const rows = endA - a + 1, columns = endB - b + 1
    const cells = rows * columns
    // 整次比较共用计算预算；超限区间整体审阅，避免重复段落引起无界的 O(n*m) 分配。
    if (cells > budget) { add(a, endA, b, endB, true); return }
    budget -= cells
    const lengths = new Uint32Array(cells)
    for (let i = rows - 2; i >= 0; i -= 1) {
      for (let j = columns - 2; j >= 0; j -= 1) {
        lengths[i * columns + j] = original![a + i].key === suggested![b + j].key
          ? lengths[(i + 1) * columns + j + 1] + 1
          : Math.max(lengths[(i + 1) * columns + j], lengths[i * columns + j + 1])
      }
    }
    let i = a, j = b, fromA = a, fromB = b
    while (i < endA && j < endB) {
      if (original![i].key === suggested![j].key) {
        add(fromA, i, fromB, j)
        i += 1; j += 1; fromA = i; fromB = j
      } else if (lengths[(i - a + 1) * columns + j - b] >= lengths[(i - a) * columns + j - b + 1]) i += 1
      else j += 1
    }
    add(fromA, endA, fromB, endB)
  }

  let start = 0, endA = original.length, endB = suggested.length
  while (start < endA && start < endB && original[start].key === suggested[start].key) start += 1
  while (endA > start && endB > start && original[endA - 1].key === suggested[endB - 1].key) { endA -= 1; endB -= 1 }
  let a = start, b = start
  for (const anchor of anchors(original, suggested, start, endA, endB)) {
    gap(a, anchor.original, b, anchor.suggested)
    a = anchor.original + 1; b = anchor.suggested + 1
  }
  gap(a, endA, b, endB)
  return { originalText, suggestedText, hunks }
}

/** 返回完整选区文本；未选差异与未变段落从原文逐字保留，增删或拆并段落按整个 hunk 原子采用。 */
export function applyAiTextHunks(comparison: AiTextComparison, selectedHunkIds: readonly number[]): string {
  const selected = new Set(selectedHunkIds)
  if (selected.size !== selectedHunkIds.length || selectedHunkIds.some((id) => !Number.isSafeInteger(id) || id < 0 || comparison.hunks[id]?.id !== id)) {
    throw new RangeError('所选文本差异已失效或重复，请重新选择。')
  }
  let cursor = 0
  const pieces: string[] = []
  for (const hunk of comparison.hunks) {
    if (!selected.has(hunk.id)) continue
    if (hunk.originalStart < cursor || hunk.originalEnd < hunk.originalStart || hunk.originalEnd > comparison.originalText.length
      || comparison.originalText.slice(hunk.originalStart, hunk.originalEnd) !== hunk.originalText) {
      throw new RangeError('文本差异与原文基线不一致，未合并内容。')
    }
    pieces.push(comparison.originalText.slice(cursor, hunk.originalStart), hunk.suggestedText)
    cursor = hunk.originalEnd
  }
  pieces.push(comparison.originalText.slice(cursor))
  return pieces.join('')
}
