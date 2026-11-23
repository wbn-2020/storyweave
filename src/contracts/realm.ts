import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, type BookInput, type BookMutationInput, type Result } from './api'

export const REALM_SCHEMA_VERSION = 19
export const MAX_REALM_FIELDS_BYTES = 256 * 1024
export const MAX_REALM_HISTORY = 10_000
export const MAX_REALM_HISTORY_BYTES = 64 * 1024 * 1024
export const MAX_REALM_VALUE = 1_000_000_000
export const MAX_REALM_LEVELS = 32
export const COMBAT_AXES = ['attack', 'defense', 'health', 'speed', 'magic', 'accuracy'] as const
export type CombatAxis = typeof COMBAT_AXES[number]
export const COMBAT_LABELS: Record<CombatAxis, string> = { attack: '攻击', defense: '防御', health: '生命', speed: '速度', magic: '法力', accuracy: '精准' }
export interface RealmCondition { id: string; name: string; kind: 'quantity' | 'milestone'; required: number; consume: boolean }
export interface RealmLevel { id: string; name: string; description: string; conditions: RealmCondition[] }
export interface CombatCharacter {
  personId: string; realmId: string | null; stage: string
  abilities: Partial<Record<CombatAxis, number>>
  totalPower: number | null; projectedPower: number | null
  progress: { conditionId: string; value: number | null }[]
}
export interface RealmState { levels: RealmLevel[]; characters: CombatCharacter[]; protagonistId: string | null }
export type RealmAction = { kind: 'configure'; fields: RealmState } | { kind: 'breakthrough'; personId: string }
export interface RealmMutationInput extends BookMutationInput { expectedRevision: number; operationId: string; action: RealmAction }
export interface RealmSimulationInput extends BookMutationInput { expectedRevision: number; personId: string }
export interface RealmSnapshot {
  bookId: string; bookRevision: number; knowledgeRevision: number; schemaVersion: number; requiresUpgrade: boolean; archived: boolean
  revision: number; operationId: string | null; updatedAt: string | null; fields: RealmState | null
  people: { id: string; name: string }[]
}
export interface RealmSimulation {
  bookId: string; bookRevision: number; revision: number; personId: string
  fromId: string; toId: string; projectedPower: number | null
  checks: { id: string; name: string; kind: 'quantity' | 'milestone'; required: number; available: number | null; consume: boolean; met: boolean }[]
  ready: boolean
}
export interface RealmApi {
  getRealm(input: BookInput): Promise<Result<RealmSnapshot>>
  mutateRealm(input: RealmMutationInput): Promise<Result<RealmSnapshot>>
  simulateRealm(input: RealmSimulationInput): Promise<Result<RealmSimulation>>
}
function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) return invalid('境界参数格式无效或包含不支持的字段。')
  return value
}
function text(value: unknown, label: string, maximum: number, optional = false): string {
  const result = optional ? optionalText(value, label, maximum) : requiredText(value, label, maximum)
  if (result.includes('\0')) return invalid(`${label}不能包含空字符。`)
  return result
}
function list<T>(value: unknown, maximum: number, parse: (item: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid(`境界列表不得超过 ${maximum} 项。`)
  const result = value.map(parse)
  if (new Set(result.map(key)).size !== result.length) return invalid('境界设定包含重复身份。')
  return result
}
function id(value: unknown) { return requiredId(value).toLowerCase() }
function number(value: unknown, label: string) { return requiredInteger(value, label, MAX_REALM_VALUE) }
function nullableNumber(value: unknown, label: string) { return value === null ? null : number(value, label) }
export function parseRealmState(value: unknown): RealmState {
  const v = object(value, ['levels', 'characters', 'protagonistId'])
  const levels = list(v.levels, MAX_REALM_LEVELS, (raw): RealmLevel => {
    const level = object(raw, ['id', 'name', 'description', 'conditions'])
    const conditions = list(level.conditions, 12, (entry): RealmCondition => {
      const condition = object(entry, ['id', 'name', 'kind', 'required', 'consume'])
      if (condition.kind !== 'quantity' && condition.kind !== 'milestone' || typeof condition.consume !== 'boolean') return invalid('突破条件类型或扣减选项无效。')
      const required = number(condition.required, '突破所需数量')
      if (required === 0 || condition.kind === 'milestone' && (required !== 1 || condition.consume)) return invalid('条件数量须大于零；里程碑以完成为准且不能扣减。')
      return { id: id(condition.id), name: text(condition.name, '条件名称', 120), kind: condition.kind, required, consume: condition.consume }
    }, (item) => item.id)
    if (new Set(conditions.map((item) => `${item.kind}:${item.name}`)).size !== conditions.length) return invalid('同一境界不能重复登记相同条件。')
    return { id: id(level.id), name: text(level.name, '境界名称', 40), description: text(level.description, '境界说明', 500, true), conditions }
  }, (item) => item.id)
  if (!levels.length) return invalid('请按从低到高的顺序填写至少一级境界。')
  if (new Set(levels.map((item) => item.name)).size !== levels.length) return invalid('境界名称不能重复。')
  const conditions = new Map(levels.flatMap((level) => level.conditions).map((item) => [item.id, item]))
  if (conditions.size !== levels.reduce((count, level) => count + level.conditions.length, 0)) return invalid('不同境界的条件身份不能重复。')
  const characters = list(v.characters, 200, (raw): CombatCharacter => {
    const character = object(raw, ['personId', 'realmId', 'stage', 'abilities', 'totalPower', 'projectedPower', 'progress'])
    const rawAbilities = object(character.abilities, COMBAT_AXES), abilities: CombatCharacter['abilities'] = {}
    for (const axis of COMBAT_AXES) if (rawAbilities[axis] !== undefined) abilities[axis] = requiredInteger(rawAbilities[axis], COMBAT_LABELS[axis], 100)
    const realmId = character.realmId === null ? null : id(character.realmId)
    if (realmId && !levels.some((level) => level.id === realmId)) return invalid('人物境界不在本书阶梯中。')
    const progress = list(character.progress, MAX_REALM_LEVELS * 12, (entry) => {
      const progress = object(entry, ['conditionId', 'value']), conditionId = id(progress.conditionId)
      const condition = conditions.get(conditionId), value = nullableNumber(progress.value, '当前条件数量')
      if (!condition || condition.kind === 'milestone' && value !== null && value > 1) return invalid('人物条件不属于本书或里程碑状态无效。')
      return { conditionId, value }
    }, (item) => item.conditionId)
    const resources = new Map<string, number | null>()
    for (const entry of progress) {
      const condition = conditions.get(entry.conditionId)!
      if (condition.kind !== 'quantity') continue
      if (resources.has(condition.name) && resources.get(condition.name) !== entry.value) return invalid('同一人物的同名资源须使用相同余额，不能按不同境界重复记账。')
      resources.set(condition.name, entry.value)
    }
    return { personId: id(character.personId), realmId, stage: text(character.stage, '境界阶段', 40, true), abilities,
      totalPower: nullableNumber(character.totalPower, '总战力'), projectedPower: nullableNumber(character.projectedPower, '预期战力'), progress }
  }, (item) => item.personId)
  const protagonistId = v.protagonistId === null ? null : id(v.protagonistId)
  if (protagonistId && !characters.some((item) => item.personId === protagonistId)) return invalid('主角必须来自已登记战力的人物。')
  return { levels, characters, protagonistId }
}
export function parseRealmReadInput(value: unknown): BookInput { return { bookId: id(object(value, ['bookId']).bookId) } }
export function parseRealmMutationInput(value: unknown): RealmMutationInput {
  const v = object(value, ['bookId', 'expectedBookRevision', 'expectedRevision', 'operationId', 'action'])
  if (!isRecord(v.action)) return invalid('境界操作无效。')
  let action: RealmAction
  if (v.action.kind === 'configure') {
    const raw = object(v.action, ['kind', 'fields']); action = { kind: 'configure', fields: parseRealmState(raw.fields) }
  } else {
    const raw = object(v.action, ['kind', 'personId'])
    if (raw.kind !== 'breakthrough') return invalid('未知的境界操作。')
    action = { kind: 'breakthrough', personId: id(raw.personId) }
  }
  return { bookId: id(v.bookId), expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本'),
    expectedRevision: requiredInteger(v.expectedRevision, '境界版本'), operationId: id(v.operationId), action }
}
export function parseRealmSimulationInput(value: unknown): RealmSimulationInput {
  const v = object(value, ['bookId', 'expectedBookRevision', 'expectedRevision', 'personId'])
  return { bookId: id(v.bookId), expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本'),
    expectedRevision: requiredInteger(v.expectedRevision, '境界版本'), personId: id(v.personId) }
}
export function realmAvailable(fields: RealmState, character: CombatCharacter, condition: RealmCondition): number | null {
  if (condition.kind === 'milestone') return character.progress.find((item) => item.conditionId === condition.id)?.value ?? null
  const resourceIds = new Set(fields.levels.flatMap((level) => level.conditions)
    .filter((item) => item.kind === 'quantity' && item.name === condition.name).map((item) => item.id))
  return character.progress.find((item) => resourceIds.has(item.conditionId))?.value ?? null
}
export function realmBreakthrough(fields: RealmState, personId: string) {
  const character = fields.characters.find((item) => item.personId === personId)
  if (!character?.realmId) return invalid('请先登记人物当前境界。')
  const index = fields.levels.findIndex((item) => item.id === character.realmId)
  const next = fields.levels[index + 1]
  if (!next) return invalid('已达到本书阶梯最高境界。')
  if (!next.conditions.length) return invalid('尚未登记下一境界的突破条件。')
  const checks = next.conditions.map((condition) => {
    const available = realmAvailable(fields, character, condition)
    return { ...condition, available, met: available !== null && available >= condition.required }
  })
  return { fromId: character.realmId, toId: next.id, projectedPower: character.projectedPower, checks, ready: checks.every((item) => item.met) }
}
/** 突破只推进已登记的下一阶；资源扣减和境界推进必须是同一历史动作。 */
export function applyRealmAction(previous: RealmState | null, action: RealmAction): RealmState {
  if (action.kind === 'configure') return parseRealmState(action.fields)
  if (!previous) return invalid('请先录入本书境界与战力。')
  const fields = parseRealmState(previous), result = realmBreakthrough(fields, action.personId)
  if (!result.ready) return invalid('突破条件尚未满足，未改变境界或扣减资源。')
  const character = fields.characters.find((item) => item.personId === action.personId)!
  for (const check of result.checks) if (check.consume) {
    const resourceIds = new Set(fields.levels.flatMap((level) => level.conditions)
      .filter((item) => item.kind === 'quantity' && item.name === check.name).map((item) => item.id))
    for (const entry of character.progress) if (resourceIds.has(entry.conditionId)) entry.value = check.available! - check.required
  }
  character.realmId = result.toId
  character.stage = ''
  // 未录入预期战力时，突破后的数值保持未知，不能沿用旧总战力假装已计算。
  character.totalPower = result.projectedPower
  character.projectedPower = null
  return parseRealmState(fields)
}
export function isRealmSnapshot(value: unknown, bookId: string): value is RealmSnapshot {
  try {
    if (!isRecord(value) || value.bookId !== bookId || typeof value.archived !== 'boolean') return false
    const revision = requiredInteger(value.revision, '境界版本'), bookRevision = requiredInteger(value.bookRevision, '作品版本')
    requiredInteger(value.knowledgeRevision, '知识版本')
    const schema = requiredInteger(value.schemaVersion, '格式版本')
    if (value.requiresUpgrade !== (schema < REALM_SCHEMA_VERSION) || revision > bookRevision || !Array.isArray(value.people)) return false
    if (!revision) return value.fields === null && value.operationId === null && value.updatedAt === null && value.people.length === 0
    if (schema < REALM_SCHEMA_VERSION || typeof value.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value.updatedAt)
      || new Date(value.updatedAt).toISOString() !== value.updatedAt || id(value.operationId) !== value.operationId) return false
    const fields = parseRealmState(value.fields)
    if (JSON.stringify(fields) !== JSON.stringify(value.fields) || value.people.length !== fields.characters.length) return false
    const ids = new Set<string>()
    for (const person of value.people) {
      if (!isRecord(person) || id(person.id) !== person.id || ids.has(person.id) || text(person.name, '人物名称', 120) !== person.name) return false
      ids.add(person.id)
    }
    return fields.characters.every((character) => ids.has(character.personId))
  } catch { return false }
}
