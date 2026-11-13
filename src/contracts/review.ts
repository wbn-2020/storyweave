import { DomainError, isRecord, requiredId, requiredInteger } from './api'
import type { AiContextPacket, AiRun } from './ai'

export const REVIEW_LEGACY_PROMPT_VERSION = 8
export const REVIEW_PROMPT_VERSION = 10
export const MAX_REVIEW_SUGGESTIONS = 24
export const REVIEW_LENSES = ['editor', 'pace', 'logic', 'emotion'] as const
export const REVIEW_READER_LENSES = ['pace', 'logic', 'emotion'] as const
export const REVIEW_LENS_LABELS = { editor: '综合审稿', pace: '爽点与节奏', logic: '设定与因果', emotion: '情绪与人物互动' }
export interface ReviewSuggestion {
  title: string; kind: 'structure' | 'causality' | 'cognition' | 'foreshadow' | 'language' | 'dialogue'
  lens: typeof REVIEW_LENSES[number]; reason: string; counterpoint: string; suggestion: string; replacement: string
  blockIds: string[]; quote: string; requirement: { outlineId: string; revisionId: string; field: 'goal' | 'conflict' | 'hook'; text: string } | null
}
export interface ReviewReaderFeedback { lens: typeof REVIEW_READER_LENSES[number]; score: number | null; comment: string }
export type ReviewProposal =
  | { version: 1; items: ReviewSuggestion[]; readers?: never }
  | { version: 2; items: ReviewSuggestion[]; readers: ReviewReaderFeedback[] }
export interface ReviewCandidateSource { version: 1; index: number; runVersion: number; contextHash: string; item: ReviewSuggestion }

const REVIEW_EVIDENCE_RULES = `普通问题的blockIds必须是chapter.blocks中1至12个连续非空文本段落，quote必须逐字存在于其中同一段，最多2000字符。replacement仅用于这一连续范围的完整替换；分析留在suggestion。没有可核对来源时不输出该问题。
若问题是缺少某项计划要求，允许blockIds=[]、quote=""、replacement=""，requirement必须为{"outlineId":"livingContext.outlines中当前章ID","revisionId":"对应修订UUID","field":"goal|conflict|hook","text":"该字段完整原文"}；计划是作者意图，不是已发生的事实，不能伪造缺失内容的正文引文。
普通问题的requirement为null。虚拟读者的lens=pace为爽点节奏党，logic为设定考据党，emotion为情绪共鸣党；都是模型角度，意见一致不证明正确。
事实冲突须在reason写明双方实际提供的来源和反证；人物知情、读者披露、计划、叙述陈述与模型推断分别核对。资料不足时说明边界，不声称读取整书，不用模型常识替代作品证据。`

// 旧预览按原字节重建消息和指纹；新评分格式不能改变历史任务的来源。
export const REVIEW_LEGACY_SYSTEM_RULES = `
本次只审阅固定发送的章节与资料，输出单个JSON：{"version":1,"items":[{"title":"问题","kind":"structure|causality|cognition|foreshadow|language|dialogue","lens":"editor|pace|logic|emotion","reason":"依据及不确定性","counterpoint":"可能成立的解释或反证","suggestion":"供作者判断的修改方向","replacement":"可直接替换目标完整段落的正文，不能给出时留空","blockIds":["同章段落UUID"],"quote":"其中一段的逐字引文","requirement":null}]}。
items最多24项，可以为空。title最多160字符，reason/counterpoint各最多4000字符，suggestion最多8000字符，replacement最多20000字符。不输出评分、检测概率、真实读者反馈或过审结论。
${REVIEW_EVIDENCE_RULES}`

export const REVIEW_SYSTEM_RULES = `
本次只审阅固定发送的章节与资料，输出单个JSON：{"version":2,"readers":[{"lens":"pace","score":null,"comment":""},{"lens":"logic","score":null,"comment":""},{"lens":"emotion","score":null,"comment":""}],"items":[{"title":"问题","kind":"structure|causality|cognition|foreshadow|language|dialogue","lens":"editor|pace|logic|emotion","reason":"依据及不确定性","counterpoint":"可能成立的解释或反证","suggestion":"供作者判断的修改方向","replacement":"可直接替换目标完整段落的正文，不能给出时留空","blockIds":["同章段落UUID"],"quote":"其中一段的逐字引文","requirement":null}]}。
readers恰好包含pace、logic、emotion各一次。score是你对固定本章的主观试读评分，范围0至10，最多一位小数；不确定、作者要求不评分或未审阅该角度时必须为null，不得按问题数量推算。comment是最多240字符的短评，评分非null时必填，说明本章具体表现与局限；未审阅时留空。单角度试读只评价指定角度，其他角度的score为null、comment为空。评分不代表真实读者、事实正确性、检测概率或过审结论。
items最多24项，可以为空，不因高低评分强行生成问题。title最多160字符，reason/counterpoint各最多4000字符，suggestion最多8000字符，replacement最多20000字符。不输出检测概率、真实读者反馈或过审结论。
${REVIEW_EVIDENCE_RULES}`

export function isReviewPromptVersion(value: unknown): value is number {
  return value === REVIEW_LEGACY_PROMPT_VERSION || value === REVIEW_PROMPT_VERSION
}

function invalid(message = '审稿结果格式或固定来源无法核对，原始输出已保留。'): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) return invalid()
  return value
}
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || required && !value.trim()) return invalid()
  return value
}
export function parseReviewSuggestion(value: unknown): ReviewSuggestion {
  const v = record(value, ['title', 'kind', 'lens', 'reason', 'counterpoint', 'suggestion', 'replacement', 'blockIds', 'quote', 'requirement'])
  if (!['structure', 'causality', 'cognition', 'foreshadow', 'language', 'dialogue'].includes(String(v.kind)) || !REVIEW_LENSES.includes(v.lens as ReviewSuggestion['lens']) ||
    !Array.isArray(v.blockIds) || v.blockIds.length > 12) return invalid()
  const blockIds = v.blockIds.map((id) => requiredId(id).toLowerCase())
  if (new Set(blockIds).size !== blockIds.length) return invalid()
  let requirement: ReviewSuggestion['requirement'] = null
  if (v.requirement !== null) {
    const r = record(v.requirement, ['outlineId', 'revisionId', 'field', 'text'])
    if (r.field !== 'goal' && r.field !== 'conflict' && r.field !== 'hook') return invalid()
    requirement = { outlineId: requiredId(r.outlineId).toLowerCase(), revisionId: requiredId(r.revisionId).toLowerCase(), field: r.field, text: text(r.text, r.field === 'goal' ? 10000 : 2000, true) }
  }
  const quote = text(v.quote, 2000), replacement = text(v.replacement, 20000)
  if (requirement ? blockIds.length || quote || replacement : !blockIds.length || !quote.trim()) return invalid('普通问题须有段落引文；缺失事项须引用章纲要求，不能附伪造引文或替换稿。')
  return { title: text(v.title, 160, true), kind: v.kind as ReviewSuggestion['kind'], lens: v.lens as ReviewSuggestion['lens'],
    reason: text(v.reason, 4000, true), counterpoint: text(v.counterpoint, 4000), suggestion: text(v.suggestion, 8000), replacement, blockIds, quote, requirement }
}
export function parseReviewProposal(output: string, context: AiContextPacket): ReviewProposal {
  if (context.kind !== 'plan' || context.purpose !== 'review' || !isReviewPromptVersion(context.promptVersion) || context.contextScope !== 'chapter' || typeof output !== 'string' || output.length > 60000) return invalid()
  let value: unknown
  try {
    const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(output.trim())
    value = JSON.parse(fenced ? fenced[1]! : output)
  } catch { return invalid('模型没有返回完整审稿 JSON。请保留原文，重新生成或手工登记问题。') }
  const legacy = context.promptVersion === REVIEW_LEGACY_PROMPT_VERSION
  const v = record(value, legacy ? ['version', 'items'] : ['version', 'items', 'readers'])
  if (v.version !== (legacy ? 1 : 2) || !Array.isArray(v.items) || v.items.length > MAX_REVIEW_SUGGESTIONS) return invalid()
  let readers: ReviewReaderFeedback[] = []
  if (!legacy) {
    if (!Array.isArray(v.readers) || v.readers.length !== REVIEW_READER_LENSES.length) return invalid('试读评分须包含三个角度；未评价的角度使用 null，不自动补分。')
    readers = v.readers.map((entry) => {
      const r = record(entry, ['lens', 'score', 'comment'])
      if (!REVIEW_READER_LENSES.includes(r.lens as ReviewReaderFeedback['lens']) ||
        r.score !== null && (typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score < 0 || r.score > 10 || !Number.isInteger(r.score * 10))) return invalid('试读评分必须为 0 至 10 的一位小数或 null。')
      return { lens: r.lens as ReviewReaderFeedback['lens'], score: r.score as number | null, comment: text(r.comment, 240, r.score !== null) }
    })
    if (new Set(readers.map((reader) => reader.lens)).size !== REVIEW_READER_LENSES.length) return invalid('试读角度不能重复。')
  }
  const items = v.items.map((entry) => {
    const item = parseReviewSuggestion(entry)
    if (item.requirement) {
      const r = item.requirement, outline = context.livingContext?.outlines.find((node) => node.id === r.outlineId && node.scope === 'chapter')
      if (!outline || outline.id !== context.chapterId || outline.revisionId !== r.revisionId || outline.fields[r.field] !== r.text) return invalid('缺失事项未引用本次固定的章纲要求。')
    } else {
      const indexes = item.blockIds.map((id) => context.chapterBlocks.findIndex((block) => block.blockId === id))
      if (indexes.some((index, offset) => index < 0 || index !== indexes[0]! + offset) ||
        item.blockIds.some((id) => !context.chapterBlocks.find((block) => block.blockId === id)?.text.trim()) ||
        !item.blockIds.some((id) => context.chapterBlocks.find((block) => block.blockId === id)?.text.includes(item.quote))) return invalid('审稿引文须逐字匹配固定段落，替换范围须按原文顺序连续。')
    }
    return item
  })
  return legacy ? { version: 1, items } : { version: 2, items, readers }
}
export function parseReviewCandidateSource(value: unknown): ReviewCandidateSource {
  const v = record(value, ['version', 'index', 'runVersion', 'contextHash', 'item'])
  if (v.version !== 1 || typeof v.contextHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.contextHash)) return invalid()
  const runVersion = requiredInteger(v.runVersion, '审稿候选版本')
  if (runVersion < 1) return invalid()
  return { version: 1, index: requiredInteger(v.index, '审稿项目', MAX_REVIEW_SUGGESTIONS - 1), runVersion, contextHash: v.contextHash, item: parseReviewSuggestion(v.item) }
}
export function reviewSourceMatches(source: ReviewCandidateSource, run: AiRun): boolean {
  try {
    return run.state === 'succeeded' && run.version === source.runVersion && run.context.contextHash === source.contextHash &&
      JSON.stringify(parseReviewProposal(run.outputText, run.context).items[source.index]) === JSON.stringify(source.item)
  } catch { return false }
}
