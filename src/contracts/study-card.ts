import { DomainError, isRecord, requiredId, requiredInteger } from './api'

export type StudyCardKind = 'beat' | 'style'
export interface StudyBeat { title: string; action: string; outcome: string }
interface StudyCardBase { analysis: string; application: string; limits: string }
export interface BeatCard extends StudyCardBase { version: 1; beats: StudyBeat[] }
export const STUDY_SENSE_LABELS = { visual: '视觉', auditory: '听觉', tactile: '触觉', olfactory: '嗅觉', gustatory: '味觉' } as const
export interface StudyStyleAnnotations {
  senses: { sense: keyof typeof STUDY_SENSE_LABELS; quote: string }[]
  verbs: { word: string; quote: string }[]
}
interface StyleCardFields extends StudyCardBase { rhythm: string; dialogue: string; senses: string; diction: string }
export type StyleCard = StyleCardFields & ({ version: 1; annotations?: never } | { version: 2; annotations: StudyStyleAnnotations })
export interface BeatCardSource { id: string; revision: number; title: string; body: string }

function invalid(): never { throw new DomainError({ code: 'INVALID_INPUT', message: '节拍或文风卡格式无效，请核对适用范围、限制和各项内容。' }) }
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || required && !value.trim()) return invalid()
  return value
}
function parseStyleAnnotations(value: unknown): StudyStyleAnnotations {
  if (!isRecord(value) || Object.keys(value).some((key) => !['senses', 'verbs'].includes(key)) ||
    !Array.isArray(value.senses) || value.senses.length > 24 || !Array.isArray(value.verbs) || value.verbs.length > 8) return invalid()
  const senses = value.senses.map((entry): StudyStyleAnnotations['senses'][number] => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !['sense', 'quote'].includes(key)) ||
      typeof entry.sense !== 'string' || !Object.hasOwn(STUDY_SENSE_LABELS, entry.sense)) return invalid()
    return { sense: entry.sense as keyof typeof STUDY_SENSE_LABELS, quote: text(entry.quote, 240, true) }
  })
  const verbs = value.verbs.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !['word', 'quote'].includes(key))) return invalid()
    const word = text(entry.word, 16, true), quote = text(entry.quote, 240, true)
    if (!/^[\p{L}\p{M}]+$/u.test(word) || !quote.includes(word)) return invalid()
    return { word, quote }
  })
  if (new Set(senses.map((entry) => JSON.stringify(entry))).size !== senses.length ||
    new Set(verbs.map((entry) => entry.word)).size !== verbs.length) return invalid()
  return { senses, verbs }
}
export function validateStudyStyleSource(card: StyleCard, sourceText: string): void {
  if (card.version === 1) return
  // 标注仅允许引用同一固定参考；词性和感官归类仍是待作者核对的模型判断。
  if ([...card.annotations.senses, ...card.annotations.verbs].some((entry) => !sourceText.includes(entry.quote))) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '文风标注引文不在同一固定参考原文中，原结果已保留，请核对来源。' })
  }
}
export function isStudyCardKind(kind: string): kind is StudyCardKind { return kind === 'beat' || kind === 'style' }
export function parseStudyCard(kind: StudyCardKind, value: unknown, draft = false): BeatCard | StyleCard {
  if (!isRecord(value) || value.version !== 1 && !(kind === 'style' && value.version === 2)) return invalid()
  const keys = ['version', 'analysis', 'application', 'limits', ...(kind === 'beat' ? ['beats'] : ['rhythm', 'dialogue', 'senses', 'diction', ...(value.version === 2 ? ['annotations'] : [])])]
  if (Object.keys(value).some((key) => !keys.includes(key))) return invalid()
  const base = { version: 1 as const, analysis: text(value.analysis, 8000), application: text(value.application, 2000), limits: text(value.limits, 2000) }
  if (kind === 'style') {
    const fields = { ...base, rhythm: text(value.rhythm, 4000), dialogue: text(value.dialogue, 4000), senses: text(value.senses, 4000), diction: text(value.diction, 4000) }
    return value.version === 2 ? { ...fields, version: 2, annotations: parseStyleAnnotations(value.annotations) } : fields
  }
  if (!Array.isArray(value.beats) || value.beats.length < 1 || value.beats.length > 6) return invalid()
  return { ...base, beats: value.beats.map((beat) => {
    if (!isRecord(beat) || Object.keys(beat).some((key) => !['title', 'action', 'outcome'].includes(key))) return invalid()
    return { title: text(beat.title, 120, !draft), action: text(beat.action, 2000), outcome: text(beat.outcome, 2000) }
  }) }
}
export function readStudyCard(kind: StudyCardKind, body: string, draft = false): BeatCard | StyleCard {
  if (typeof body !== 'string' || body.length > 40000) return invalid()
  let value: unknown
  try { value = JSON.parse(body) } catch { return invalid() }
  return parseStudyCard(kind, value, draft)
}
export function emptyStudyCard(kind: StudyCardKind, analysis = ''): string {
  const base = { version: 1, analysis, application: '', limits: '' }
  return JSON.stringify(kind === 'beat' ? { ...base, beats: [{ title: '节拍 1', action: '', outcome: '' }] }
    : { ...base, rhythm: '', dialogue: '', senses: '', diction: '' })
}
export function studyMaterialText(kind: string, body: string): string {
  if (!isStudyCardKind(kind)) return body
  const card = readStudyCard(kind, body)
  return [`分析：${card.analysis}`, `适用范围：${card.application || '待作者明确'}`, `复用限制：${card.limits || '待作者明确'}`,
    ...('beats' in card ? card.beats.map((beat, index) => `节拍 ${index + 1}：${beat.title}\n行动：${beat.action}\n变化：${beat.outcome}`)
      : [`句式节奏：${card.rhythm}`, `对白组织：${card.dialogue}`, `感官偏好：${card.senses}`, `措辞与动词：${card.diction}`]),
    '仅借用抽象结构与表达技法；使用当前作品的人物、地点与设定，不复制参考原文。'].join('\n\n')
}
export function parseBeatCardSource(value: unknown): BeatCardSource {
  if (!isRecord(value) || Object.keys(value).some((key) => !['id', 'revision', 'title', 'body'].includes(key))) return invalid()
  const revision = requiredInteger(value.revision, '节拍来源版本')
  if (revision < 1) return invalid()
  const body = text(value.body, 40000, true)
  readStudyCard('beat', body)
  return { id: requiredId(value.id).toLowerCase(), revision, title: text(value.title, 160, true), body }
}
