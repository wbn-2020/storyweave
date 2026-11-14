import { countCharacters } from '../contracts/manuscript'
import { STUDY_SENSE_LABELS, validateStudyStyleSource, type StyleCard } from '../contracts/study-card'

export function measureStudyStyleAnnotations(text: string, card: StyleCard) {
  if (card.version !== 2 || !text.trim() || text.length > 50_000 || text.includes('\0')) return null
  try { validateStudyStyleSource(card, text) } catch { return null }
  const senses = (Object.keys(STUDY_SENSE_LABELS) as (keyof typeof STUDY_SENSE_LABELS)[])
    .map((sense) => ({ sense, label: STUDY_SENSE_LABELS[sense], count: card.annotations.senses.filter((entry) => entry.sense === sense).length }))
    .filter((entry) => entry.count > 0)
  const verbs = card.annotations.verbs.map(({ word }) => {
    let count = 0, offset = 0
    // 候选由模型提出，本地只数不重叠的字面出现，不把子词命中或同形词当作词性结论。
    while ((offset = text.indexOf(word, offset)) >= 0) { count += 1; offset += word.length }
    return { word, count }
  }).sort((left, right) => right.count - left.count)
  return { senses, total: card.annotations.senses.length, verbs }
}

export interface StudyStyleMeasurement {
  sentences: number
  bins: { label: string; count: number }[]
  lengthCounts: { length: number; count: number }[]
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
  const lengthCounts = new Map<number, number>()
  // 原生分句后沿用正文的非空白码点计数；标点、引号计入句长，纯标点片段不算句子。
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'sentence' })
  for (const { segment } of segmenter.segment(text)) {
    if (!/[\p{L}\p{N}]/u.test(segment)) continue
    const length = countCharacters(segment)
    const index = length <= 10 ? 0 : length <= 20 ? 1 : length <= 40 ? 2 : length <= 60 ? 3 : 4
    bins[index]!.count += 1
    lengthCounts.set(length, (lengthCounts.get(length) ?? 0) + 1)
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
  return { sentences, bins, lengthCounts: [...lengthCounts].sort(([a], [b]) => a - b).map(([length, count]) => ({ length, count })),
    textCharacters, quotedCharacters: balanced && !quotes.length ? quotedCharacters : null }
}
