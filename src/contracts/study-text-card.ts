import { DomainError, isRecord } from './api'

export type StudyTextCardKind = 'method' | 'technique' | 'excerpt'
interface StudyTextCardBase { version: 1; analysis: string; application: string; limits: string }
export interface StudyFormulaCard extends StudyTextCardBase { format: 'study-formula'; stages: string[] }
export interface StudyVocabularyCard extends StudyTextCardBase { format: 'study-vocabulary'; words: { word: string; quote: string }[] }
export type StudyTextCard = StudyFormulaCard | StudyVocabularyCard

function invalid(): never {
  throw new DomainError({ code: 'INVALID_INPUT', message: '技法公式或词汇卡格式无效，请核对阶段、词汇及其逐字证据。' })
}
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || required && !value.trim()) return invalid()
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) return invalid()
  }
  return value
}
export function isStudyTextCardKind(kind: string): kind is StudyTextCardKind {
  return kind === 'method' || kind === 'technique' || kind === 'excerpt'
}
// 同类型的旧版普通文本也会返回 false，格式检查不能排除其素材类型。
export function hasStudyTextCard(kind: string, body: string): boolean {
  if (!isStudyTextCardKind(kind) || body.length > 40000) return false
  try {
    const value: unknown = JSON.parse(body)
    return isRecord(value) && (value.format === 'study-formula' || value.format === 'study-vocabulary')
  } catch { return false }
}
export function parseStudyTextCard(kind: StudyTextCardKind, value: unknown, draft = false): StudyTextCard {
  const vocabulary = kind === 'excerpt'
  if (!isRecord(value) || value.version !== 1 || value.format !== (vocabulary ? 'study-vocabulary' : 'study-formula') ||
    Object.keys(value).some((key) => !['version', 'format', 'analysis', 'application', 'limits', vocabulary ? 'words' : 'stages'].includes(key))) return invalid()
  const base = { version: 1 as const, analysis: text(value.analysis, 8000), application: text(value.application, 2000), limits: text(value.limits, 2000) }
  if (!vocabulary) {
    if (!Array.isArray(value.stages) || value.stages.length > 4) return invalid()
    return { ...base, format: 'study-formula', stages: value.stages.map((stage) => text(stage, 40, !draft)) }
  }
  if (!Array.isArray(value.words) || value.words.length > 8) return invalid()
  const words = value.words.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !['word', 'quote'].includes(key))) return invalid()
    const word = text(entry.word, 16, true), quote = text(entry.quote, 240, true)
    if (!/^[\p{L}\p{M}]+$/u.test(word) || !quote.includes(word)) return invalid()
    return { word, quote }
  })
  if (new Set(words.map((entry) => entry.word)).size !== words.length) return invalid()
  return { ...base, format: 'study-vocabulary', words }
}
export function readStudyTextCard(kind: string, body: string, draft = false): StudyTextCard | null {
  // 仅显式格式标记启用新卡；历史普通文本与无关 JSON 不猜测、不转换。
  if (!isStudyTextCardKind(kind) || !hasStudyTextCard(kind, body)) return null
  return parseStudyTextCard(kind, JSON.parse(body), draft)
}
export function validateStudyTextSource(card: StudyTextCard, sourceText: string): void {
  if (card.format === 'study-vocabulary' && card.words.some((entry) => !sourceText.includes(entry.quote))) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '词汇引文不在同一固定参考原文中，原结果已保留，请核对来源。' })
  }
}
