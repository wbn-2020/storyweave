import { DomainError, isRecord, requiredId, requiredInteger } from './api'

export type StudyCardKind = 'beat' | 'style'
export interface StudyBeat { title: string; action: string; outcome: string }
interface StudyCardBase { version: 1; analysis: string; application: string; limits: string }
export interface BeatCard extends StudyCardBase { beats: StudyBeat[] }
export interface StyleCard extends StudyCardBase { rhythm: string; dialogue: string; senses: string; diction: string }
export interface BeatCardSource { id: string; revision: number; title: string; body: string }

function invalid(): never { throw new DomainError({ code: 'INVALID_INPUT', message: '节拍或文风卡格式无效，请核对适用范围、限制和各项内容。' }) }
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || required && !value.trim()) return invalid()
  return value
}
export function isStudyCardKind(kind: string): kind is StudyCardKind { return kind === 'beat' || kind === 'style' }
export function parseStudyCard(kind: StudyCardKind, value: unknown, draft = false): BeatCard | StyleCard {
  const keys = ['version', 'analysis', 'application', 'limits', ...(kind === 'beat' ? ['beats'] : ['rhythm', 'dialogue', 'senses', 'diction'])]
  if (!isRecord(value) || value.version !== 1 || Object.keys(value).some((key) => !keys.includes(key))) return invalid()
  const base: StudyCardBase = { version: 1, analysis: text(value.analysis, 8000), application: text(value.application, 2000), limits: text(value.limits, 2000) }
  if (kind === 'style') return { ...base, rhythm: text(value.rhythm, 4000), dialogue: text(value.dialogue, 4000), senses: text(value.senses, 4000), diction: text(value.diction, 4000) }
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
