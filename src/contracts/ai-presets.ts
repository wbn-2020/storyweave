import { DomainError, isRecord, requiredId, requiredInteger, requiredText, type Result } from './api'

export const AI_PRESETS_SCHEMA_VERSION = 14
export const AI_SUMMARY_PRESETS_SCHEMA_VERSION = 25
export const AI_PRESET_KINDS = ['plan', 'continue', 'rewrite', 'review', 'study', 'summarize'] as const
export const AI_PRESETS_COMMANDS = { get: 'ai.presets.get', save: 'ai.presets.save' } as const
export const MAX_AI_PRESETS = 200
export const MAX_AI_PRESET_INSTRUCTION = 6_000
export const MAX_AI_PRESET_FIELDS_BYTES = 32 * 1024
export const MAX_AI_PRESETS_BYTES = 4 * 1024 * 1024
export const MAX_AI_PRESET_HISTORY = 50_000
export const MAX_AI_PRESET_HISTORY_BYTES = 64 * 1024 * 1024
export type AiPresetKind = typeof AI_PRESET_KINDS[number]

export interface AiPresetFields {
  title: string
  kind: AiPresetKind
  instruction: string
  connectionId: string | null
  /** 每书、每种任务最多一个未归档的默认预设。 */
  defaultForTask: boolean
  archived: boolean
}
export interface AiPreset extends AiPresetFields { id: string; revision: number; updatedAt: string }
export type AiComposerPreset = AiPreset & { kind: Exclude<AiPresetKind, 'summarize'> }
export interface AiPresetUsage {
  /** 已进入生成流程的本地运行数；不代表供应商确认的计费次数。 */
  runCount: number
  knownUsageRuns: number
  unknownUsageRuns: number
  inputTokens: number
  outputTokens: number
  unknownInputRuns: number
  unknownOutputRuns: number
}
export interface AiPresetsSnapshot {
  bookId: string
  bookRevision: number
  requiresUpgrade: boolean
  /** 旧书仍可使用原五类预设，摘要预设须显式备份升级后启用。 */
  supportsSummary: boolean
  archived: boolean
  presets: AiPreset[]
  usage: AiPresetUsage
}
export interface GetAiPresetsInput { bookId: string }
export interface SaveAiPresetInput extends GetAiPresetsInput {
  expectedBookRevision: number
  id: string
  /** 新建时为 0；已有预设必须携带读取时的版本。 */
  expectedRevision: number
  fields: AiPresetFields
}
export interface AiPresetsApi {
  getAiPresets(input: GetAiPresetsInput): Promise<Result<AiPresetsSnapshot>>
  saveAiPreset(input: SaveAiPresetInput): Promise<Result<AiPresetsSnapshot>>
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) return invalid('任务预设参数无效或包含不支持的字段。')
  return value
}
function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) return invalid(`${label}无效或超过 ${maximum} 个字符。`)
  return requiredText(value, label, maximum)
}
export function aiPresetFields(value: AiPresetFields): AiPresetFields {
  const { title, kind, instruction, connectionId, defaultForTask, archived } = value
  return { title, kind, instruction, connectionId, defaultForTask, archived }
}
export function parseAiPresetFields(value: unknown): AiPresetFields {
  const v = record(value, ['title', 'kind', 'instruction', 'connectionId', 'defaultForTask', 'archived'])
  if (!AI_PRESET_KINDS.includes(v.kind as AiPresetKind)) return invalid('任务类型无效。')
  if (typeof v.defaultForTask !== 'boolean' || typeof v.archived !== 'boolean') return invalid('预设默认状态与归档状态须为布尔值。')
  if (v.archived && v.defaultForTask) return invalid('归档预设不能设为默认。')
  return { title: text(v.title, '预设名称', 120), kind: v.kind as AiPresetKind,
    instruction: text(v.instruction, '协作要求', MAX_AI_PRESET_INSTRUCTION),
    connectionId: v.connectionId === null ? null : requiredId(v.connectionId).toLowerCase(),
    defaultForTask: v.defaultForTask, archived: v.archived }
}
export function parseGetAiPresetsInput(value: unknown): GetAiPresetsInput {
  const v = record(value, ['bookId'])
  return { bookId: requiredId(v.bookId).toLowerCase() }
}
export function parseSaveAiPresetInput(value: unknown): SaveAiPresetInput {
  const v = record(value, ['bookId', 'expectedBookRevision', 'id', 'expectedRevision', 'fields'])
  const expectedBookRevision = requiredInteger(v.expectedBookRevision, '作品版本', Number.MAX_SAFE_INTEGER - 1)
  const expectedRevision = requiredInteger(v.expectedRevision, '预设版本', expectedBookRevision)
  return { bookId: requiredId(v.bookId).toLowerCase(), expectedBookRevision,
    id: requiredId(v.id).toLowerCase(), expectedRevision, fields: parseAiPresetFields(v.fields) }
}
export function isAiPresetsSnapshot(value: unknown, bookId: string): value is AiPresetsSnapshot {
  try {
    if (!isRecord(value) || value.bookId !== bookId || requiredId(value.bookId).toLowerCase() !== value.bookId ||
      typeof value.requiresUpgrade !== 'boolean' || typeof value.supportsSummary !== 'boolean' || typeof value.archived !== 'boolean' || !Array.isArray(value.presets) ||
      (value.requiresUpgrade && value.supportsSummary) ||
      value.presets.length > MAX_AI_PRESETS || (value.requiresUpgrade && value.presets.length > 0)) return false
    const revision = requiredInteger(value.bookRevision, '作品版本')
    const ids = new Set<string>(), defaults = new Set<AiPresetKind>()
    for (const raw of value.presets) {
      if (!isRecord(raw) || requiredId(raw.id).toLowerCase() !== raw.id || ids.has(raw.id) ||
        requiredInteger(raw.revision, '预设版本', revision) < 1 || typeof raw.updatedAt !== 'string' ||
        raw.updatedAt.length !== 24 || new Date(raw.updatedAt).toISOString() !== raw.updatedAt) return false
      const fields = aiPresetFields(raw as unknown as AiPreset)
      if (JSON.stringify(parseAiPresetFields(fields)) !== JSON.stringify(fields)) return false
      if (fields.kind === 'summarize' && !value.supportsSummary) return false
      if (fields.defaultForTask && defaults.has(fields.kind)) return false
      if (fields.defaultForTask) defaults.add(fields.kind)
      ids.add(raw.id)
    }
    const usage = value.usage
    if (!isRecord(usage)) return false
    for (const key of ['runCount', 'knownUsageRuns', 'unknownUsageRuns', 'inputTokens', 'outputTokens', 'unknownInputRuns', 'unknownOutputRuns']) {
      requiredInteger(usage[key], '用量统计')
    }
    const u = usage as unknown as AiPresetUsage
    return u.knownUsageRuns + u.unknownUsageRuns === u.runCount && u.unknownInputRuns <= u.unknownUsageRuns &&
      u.unknownOutputRuns <= u.unknownUsageRuns && u.unknownUsageRuns <= u.unknownInputRuns + u.unknownOutputRuns &&
      (u.runCount !== u.unknownInputRuns || u.inputTokens === 0) && (u.runCount !== u.unknownOutputRuns || u.outputTokens === 0)
  } catch { return false }
}
export function isAiPresetSaveReceipt(value: unknown, input: SaveAiPresetInput): value is AiPresetsSnapshot {
  if (!isAiPresetsSnapshot(value, input.bookId) || value.requiresUpgrade || value.archived || value.bookRevision !== input.expectedBookRevision + 1) return false
  const saved = value.presets.find((preset) => preset.id === input.id)
  return Boolean(saved && saved.revision === input.expectedRevision + 1 && JSON.stringify(aiPresetFields(saved)) === JSON.stringify(input.fields))
}

/** 审稿和拆书沿用已有 plan 存储类型，composer 仍由用户确认后发送。 */
export function aiPresetComposerTask(kind: AiComposerPreset['kind']): { kind: 'plan' | 'continue' | 'rewrite'; purpose?: 'review' | 'study' } {
  return kind === 'review' || kind === 'study' ? { kind: 'plan', purpose: kind } : { kind }
}
