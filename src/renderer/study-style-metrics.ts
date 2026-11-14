import { countCharacters } from '../contracts/manuscript'

export interface StudyStyleMeasurement {
  sentences: number
  bins: { label: string; count: number }[]
  textCharacters: number
  quotedCharacters: number | null
}

export function measureStudyStyle(text: string): StudyStyleMeasurement | null {
  if (!text.trim() || text.length > 50_000 || text.includes('\0') || typeof Intl.Segmenter !== 'function') return null
  const bins = [
    { label: '1-10', count: 0 }, { label: '11-20', count: 0 }, { label: '21-40', count: 0 },
    { label: '41-60', count: 0 }, { label: '61+', count: 0 },
  ]
  let sentences = 0
  // 原生分句后沿用正文的非空白码点计数；标点、引号计入句长，纯标点片段不算句子。
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'sentence' })
  for (const { segment } of segmenter.segment(text)) {
    if (!/[\p{L}\p{N}]/u.test(segment)) continue
    const length = countCharacters(segment)
    const index = length <= 10 ? 0 : length <= 20 ? 1 : length <= 40 ? 2 : length <= 60 ? 3 : 4
    bins[index]!.count += 1
    sentences += 1
  }

  const opening = new Map([['“', '”'], ['「', '」'], ['『', '』']])
  const closing = new Set(opening.values())
  const quotes: string[] = []
  let textCharacters = 0, quotedCharacters = 0, balanced = true, escaped = false
  // 只统计引号覆盖，不将引用自动判为人物对白；嵌套只计一次，缺失配对时比例保持未知。
  for (const character of text) {
    const wasEscaped = escaped
    escaped = character === '\\' && !escaped
    if (character === '"' && !wasEscaped) {
      if (quotes.at(-1) === '"') quotes.pop()
      else quotes.push('"')
      continue
    }
    const expected = opening.get(character)
    if (expected) { quotes.push(expected); continue }
    if (closing.has(character)) {
      if (quotes.at(-1) === character) quotes.pop()
      else balanced = false
      continue
    }
    if (/\s/u.test(character)) continue
    textCharacters += 1
    if (quotes.length) quotedCharacters += 1
  }
  return { sentences, bins, textCharacters, quotedCharacters: balanced && !quotes.length ? quotedCharacters : null }
}
