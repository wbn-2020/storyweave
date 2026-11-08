import { DomainError, isRecord, requiredId, requiredInteger, requiredText } from './api'
import { COGNITION_ATTITUDES, parseStoryTime, type CognitionAttitude, type StoryTime } from './story'

export const AI_CHARACTER_CONTEXT_LEGACY_PROMPT_VERSION = 6
export const AI_CHARACTER_CONTEXT_PROMPT_VERSION = 7

export function isAiCharacterContextPromptVersion(value: unknown): value is 6 | 7 {
  return value === AI_CHARACTER_CONTEXT_LEGACY_PROMPT_VERSION || value === AI_CHARACTER_CONTEXT_PROMPT_VERSION
}

export interface AiCharacterScope {
  personId: string
  /** 与认知形成时间共用作者填写的排序值，不从章序或日期猜测。 */
  storyOrder: number
  readerLimited: boolean
}

export interface AiCharacterCognition {
  chunkId: number
  recordId: string
  revisionId: string
  formedAt: Exclude<StoryTime, { kind: 'unknown' }>
  attitude: CognitionAttitude
  concealed: boolean
}

export interface AiCharacterContext extends AiCharacterScope {
  personName: string
  personRevisionId: string
  cognitions: AiCharacterCognition[]
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('人物上下文格式无效或包含不支持的字段。')
  return value
}

export function parseAiCharacterScope(value: unknown): AiCharacterScope {
  const data = record(value, ['personId', 'storyOrder', 'readerLimited'])
  if (typeof data.storyOrder !== 'number' || !Number.isSafeInteger(data.storyOrder) || Math.abs(data.storyOrder) > 1_000_000_000) {
    invalid('人物视角的故事时点须为绝对值不超过 10 亿的整数，并与认知记录使用同一排序尺度。')
  }
  if (typeof data.readerLimited !== 'boolean') invalid('是否叠加读者披露限制必须明确选择。')
  return { personId: requiredId(data.personId).toLowerCase(), storyOrder: data.storyOrder, readerLimited: data.readerLimited }
}

export function characterScopeOf(context: AiCharacterContext): AiCharacterScope {
  return { personId: context.personId, storyOrder: context.storyOrder, readerLimited: context.readerLimited }
}

export function parseAiCharacterContext(value: unknown): AiCharacterContext {
  const data = record(value, ['personId', 'storyOrder', 'readerLimited', 'personName', 'personRevisionId', 'cognitions'])
  const scope = parseAiCharacterScope({ personId: data.personId, storyOrder: data.storyOrder, readerLimited: data.readerLimited })
  if (!Array.isArray(data.cognitions) || data.cognitions.length > 12) invalid('人物上下文最多包含 12 个认知片段。')
  const cognitions = data.cognitions.map((value): AiCharacterCognition => {
    const item = record(value, ['chunkId', 'recordId', 'revisionId', 'formedAt', 'attitude', 'concealed'])
    const chunkId = requiredInteger(item.chunkId, '认知片段编号')
    if (chunkId < 1) invalid('认知片段编号必须大于零。')
    const formedAt = parseStoryTime(item.formedAt)
    if (formedAt.kind === 'unknown' || formedAt.order === null || formedAt.order > scope.storyOrder) invalid('认知形成时间未知或晚于所选故事时点。')
    if (typeof item.attitude !== 'string' || !COGNITION_ATTITUDES.includes(item.attitude as CognitionAttitude) || typeof item.concealed !== 'boolean') {
      invalid('人物认知态度或隐瞒标记无效。')
    }
    return { chunkId, recordId: requiredId(item.recordId).toLowerCase(), revisionId: requiredId(item.revisionId).toLowerCase(),
      formedAt, attitude: item.attitude as CognitionAttitude, concealed: item.concealed }
  })
  if (new Set(cognitions.map((item) => item.chunkId)).size !== cognitions.length) invalid('认知片段不能重复。')
  return { ...scope, personName: requiredText(data.personName, '人物名称', 120),
    personRevisionId: requiredId(data.personRevisionId).toLowerCase(), cognitions }
}
