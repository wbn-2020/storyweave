import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, type BookInput, type BookMutationInput, type Result } from './api'

export const WEAVE_SCHEMA_VERSION = 18
export const MAX_WEAVE_FIELDS_BYTES = 256 * 1024
export const MAX_WEAVE_HISTORY = 10_000
export const MAX_WEAVE_HISTORY_BYTES = 64 * 1024 * 1024
export const MAX_WEAVE_VALUE = 1_000_000_000
export const MAX_WEAVE_MINUTE = 525_600_000
export interface WeaveItem { name: string; quantity: number }
export interface WeaveReward { points: number; experience: number; items: WeaveItem[] }
export interface WeaveStep { id: string; title: string; done: boolean }
export interface WeaveTask {
  id: string; kind: 'main' | 'daily'; active: boolean; title: string; chapterId: string | null
  steps: WeaveStep[]; reward: WeaveReward; claimed: boolean
}
export interface WeaveOffer {
  id: string; active: boolean; name: string; description: string; price: number; quantity: number
  stock: number | null; cooldownMinutes: number; availableAt: number; purchased: number
}
export interface WeaveState {
  name: string; currency: string; points: number; experience: number
  // 使用作者推进的剧情分钟；不得将真实写作打卡或电脑时间作为小说任务进度。
  storyMinute: number; activityDay: number | null; idleDays: number; cooldownUntil: number
  penalty: { description: string; afterDays: number; cooldownMinutes: number }
  tasks: WeaveTask[]; offers: WeaveOffer[]; inventory: WeaveItem[]
}
export type WeaveAction =
  | { kind: 'configure'; fields: WeaveState }
  | { kind: 'step'; taskId: string; stepId: string; done: boolean }
  | { kind: 'claim'; taskId: string }
  | { kind: 'redeem'; offerId: string }
  | { kind: 'refresh'; storyMinute: number }
export interface WeaveMutationInput extends BookMutationInput {
  expectedRevision: number; operationId: string; action: WeaveAction
}
export interface WeaveSnapshot {
  bookId: string; bookRevision: number; archived: boolean; schemaVersion: number; requiresUpgrade: boolean
  revision: number; updatedAt: string | null; operationId: string | null; fields: WeaveState | null
}
export interface WeaveSystemApi {
  getWeaveSystem(input: BookInput): Promise<Result<WeaveSnapshot>>
  mutateWeaveSystem(input: WeaveMutationInput): Promise<Result<WeaveSnapshot>>
}
function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function object(value: unknown) {
  if (!isRecord(value)) return invalid('织星系统参数无效。')
  return value
}
function list<T>(value: unknown, maximum: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid(`织星系统列表不得超过 ${maximum} 项。`)
  return value.map(parse)
}
function text(value: unknown, label: string, maximum = 160) {
  const result = requiredText(value, label, maximum)
  if (result.includes('\0')) return invalid(`${label}含无效字符。`)
  return result
}
function note(value: unknown) {
  const result = optionalText(value, '说明', 2_000)
  if (result.includes('\0')) return invalid('说明含无效字符。')
  return result
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid('任务状态必须明确为是或否。')
  return value
}
function number(value: unknown, label = '数值', maximum = MAX_WEAVE_VALUE) { return requiredInteger(value, label, maximum) }
function unique<T>(items: T[], key: (item: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) return invalid('织星系统中存在重复的身份或物品名称。')
  return items
}
function parseItem(value: unknown): WeaveItem {
  const v = object(value), quantity = number(v.quantity, '物品数量')
  if (!quantity) return invalid('物品数量必须大于零。')
  return { name: text(v.name, '物品名称', 80), quantity }
}
export function parseWeaveReward(value: unknown): WeaveReward {
  const v = object(value)
  return { points: number(v.points, '奖励积分'), experience: number(v.experience, '奖励经验'), items: unique(list(v.items, 8, parseItem), (item) => item.name) }
}
export function parseWeaveState(value: unknown): WeaveState {
  const v = object(value), penalty = object(v.penalty)
  const tasks = unique(list(v.tasks, 60, (raw): WeaveTask => {
    const task = object(raw)
    if (task.kind !== 'main' && task.kind !== 'daily') return invalid('任务必须属于主线或每日任务。')
    const steps = unique(list(task.steps, 16, (item): WeaveStep => {
      const step = object(item)
      return { id: requiredId(step.id).toLowerCase(), title: text(step.title, '任务步骤'), done: flag(step.done) }
    }), (item) => item.id)
    if (!steps.length) return invalid('每个任务至少需要一个步骤。')
    const claimed = flag(task.claimed)
    if (claimed && steps.some((item) => !item.done)) return invalid('已领取奖励的任务必须完成全部步骤。')
    return { id: requiredId(task.id).toLowerCase(), kind: task.kind, active: flag(task.active), title: text(task.title, '任务名称'),
      chapterId: task.chapterId === null ? null : requiredId(task.chapterId).toLowerCase(), steps, reward: parseWeaveReward(task.reward), claimed }
  }), (item) => item.id)
  const offers = unique(list(v.offers, 40, (raw): WeaveOffer => {
    const offer = object(raw), quantity = number(offer.quantity, '单次兑换数量')
    if (!quantity) return invalid('单次兑换数量必须大于零。')
    return { id: requiredId(offer.id).toLowerCase(), active: flag(offer.active), name: text(offer.name, '商品名称', 80),
      description: note(offer.description), price: number(offer.price, '兑换价格'), quantity,
      stock: offer.stock === null ? null : number(offer.stock, '剩余库存'), cooldownMinutes: number(offer.cooldownMinutes, '兑换冷却分钟', MAX_WEAVE_MINUTE),
      availableAt: number(offer.availableAt, '兑换冷却截至', MAX_WEAVE_MINUTE), purchased: number(offer.purchased, '已兑换次数') }
  }), (item) => item.id)
  const afterDays = number(penalty.afterDays, '惩罚阈值', 365_000)
  const cooldownMinutes = number(penalty.cooldownMinutes, '惩罚冷却分钟', MAX_WEAVE_MINUTE)
  if ((afterDays === 0) !== (cooldownMinutes === 0)) return invalid('启用惩罚时须同时填写未完成天数和冷却分钟；均为零表示停用。')
  const idleDays = number(v.idleDays, '连续未完成天数', 365_000)
  if (afterDays && idleDays >= afterDays) return invalid('连续未完成天数须小于惩罚阈值。')
  const storyMinute = number(v.storyMinute, '剧情时间', MAX_WEAVE_MINUTE)
  return { name: text(v.name, '系统名称', 80), currency: text(v.currency, '积分名称', 30), points: number(v.points, '积分余额'), experience: number(v.experience, '经验'),
    storyMinute, activityDay: v.activityDay === null ? null : number(v.activityDay, '最近完成剧情日', Math.floor(storyMinute / 1440)),
    idleDays, cooldownUntil: number(v.cooldownUntil, '惩罚冷却截至', MAX_WEAVE_MINUTE),
    penalty: { description: note(penalty.description), afterDays, cooldownMinutes }, tasks, offers,
    inventory: unique(list(v.inventory, 128, parseItem), (item) => item.name) }
}
export function parseWeaveReadInput(value: unknown): BookInput {
  return { bookId: requiredId(object(value).bookId).toLowerCase() }
}
export function parseWeaveMutationInput(value: unknown): WeaveMutationInput {
  const v = object(value), raw = object(v.action)
  let action: WeaveAction
  switch (raw.kind) {
    case 'configure': action = { kind: raw.kind, fields: parseWeaveState(raw.fields) }; break
    case 'step': action = { kind: raw.kind, taskId: requiredId(raw.taskId).toLowerCase(), stepId: requiredId(raw.stepId).toLowerCase(), done: flag(raw.done) }; break
    case 'claim': action = { kind: raw.kind, taskId: requiredId(raw.taskId).toLowerCase() }; break
    case 'redeem': action = { kind: raw.kind, offerId: requiredId(raw.offerId).toLowerCase() }; break
    case 'refresh': action = { kind: raw.kind, storyMinute: number(raw.storyMinute, '剧情时间', MAX_WEAVE_MINUTE) }; break
    default: return invalid('未知的织星系统操作。')
  }
  return { ...parseWeaveReadInput(v), expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本'),
    expectedRevision: requiredInteger(v.expectedRevision, '系统版本'), operationId: requiredId(v.operationId).toLowerCase(), action }
}
export function weaveTaskComplete(task: WeaveTask): boolean { return task.steps.length > 0 && task.steps.every((step) => step.done) }
function add(left: number, right: number): number { return number(left + right, '变更后的数值') }
function addItem(fields: WeaveState, item: WeaveItem) {
  const existing = fields.inventory.find((entry) => entry.name === item.name)
  if (existing) existing.quantity = add(existing.quantity, item.quantity)
  else {
    if (fields.inventory.length >= 128) return invalid('系统背包已达 128 种物品，未扣除积分或发放奖励。')
    fields.inventory.push({ ...item })
  }
}
/** 领取、扣款和刷新共享同一状态转换；恢复时从不可变历史逐条重放核对。 */
export function applyWeaveAction(previous: WeaveState | null, action: WeaveAction): WeaveState {
  if (action.kind === 'configure') return parseWeaveState(action.fields)
  if (!previous) return invalid('请先录入本书的系统设定。')
  const fields = parseWeaveState(previous)
  if (action.kind === 'step' || action.kind === 'claim') {
    const task = fields.tasks.find((item) => item.id === action.taskId && item.active)
    if (!task) return invalid('任务不存在或已停用。')
    if (task.claimed) return invalid('该任务本轮奖励已领取，不能再次修改进度或领取。')
    if (action.kind === 'step') {
      const step = task.steps.find((item) => item.id === action.stepId)
      if (!step) return invalid('任务步骤不存在。')
      if (step.done === action.done) return invalid('该步骤已经处于目标状态，请重新读取。')
      step.done = action.done
      if (weaveTaskComplete(task)) fields.activityDay = Math.floor(fields.storyMinute / 1440)
    } else {
      if (!weaveTaskComplete(task)) return invalid('完成全部步骤后才能领取奖励。')
      if (task.kind === 'daily' && fields.cooldownUntil > fields.storyMinute) return invalid('剧情惩罚冷却期间不能领取每日奖励。')
      fields.points = add(fields.points, task.reward.points)
      fields.experience = add(fields.experience, task.reward.experience)
      task.reward.items.forEach((item) => addItem(fields, item))
      task.claimed = true
    }
  } else if (action.kind === 'redeem') {
    const offer = fields.offers.find((item) => item.id === action.offerId && item.active)
    if (!offer) return invalid('商品不存在或已停用。')
    if (offer.stock !== null && offer.stock < offer.quantity) return invalid('商品库存不足以完成本次兑换。')
    if (offer.availableAt > fields.storyMinute) return invalid('该商品尚处于剧情冷却中。')
    if (fields.points < offer.price) return invalid('积分不足，未扣款。')
    fields.points -= offer.price
    if (offer.stock !== null) offer.stock -= offer.quantity
    offer.availableAt = number(fields.storyMinute + offer.cooldownMinutes, '兑换冷却截至', MAX_WEAVE_MINUTE)
    offer.purchased = add(offer.purchased, 1)
    addItem(fields, { name: offer.name, quantity: offer.quantity })
  } else {
    if (action.storyMinute <= fields.storyMinute) return invalid('刷新须明确推进剧情时间，不能重复刷新或回退时间。')
    const days = Math.floor(action.storyMinute / 1440) - Math.floor(fields.storyMinute / 1440)
    if (days > 0) {
      const completed = fields.activityDay === Math.floor(fields.storyMinute / 1440)
      const idle = completed ? days - 1 : fields.idleDays + days
      const threshold = fields.penalty.afterDays
      if (threshold && idle >= threshold) {
        // 跳过多天时直接计算最后一次触发日，避免按天循环；冷却只限制虚构系统奖励。
        const lastTriggerDay = Math.floor(action.storyMinute / 1440) - idle % threshold
        fields.cooldownUntil = number(Math.max(fields.cooldownUntil, lastTriggerDay * 1440 + fields.penalty.cooldownMinutes), '惩罚冷却截至', MAX_WEAVE_MINUTE)
      }
      fields.idleDays = threshold ? idle % threshold : 0
      for (const task of fields.tasks) if (task.kind === 'daily') {
        task.claimed = false
        task.steps.forEach((step) => { step.done = false })
      }
    }
    fields.storyMinute = action.storyMinute
  }
  return parseWeaveState(fields)
}
export function isWeaveSnapshot(value: unknown, bookId: string): value is WeaveSnapshot {
  try {
    const v = object(value)
    const bookRevision = requiredInteger(v.bookRevision, '作品版本'), revision = requiredInteger(v.revision, '系统版本')
    const schema = requiredInteger(v.schemaVersion, '格式版本')
    if (v.bookId !== bookId || typeof v.archived !== 'boolean' || v.requiresUpgrade !== (schema < WEAVE_SCHEMA_VERSION) || revision > bookRevision) return false
    if (revision === 0) return v.fields === null && v.updatedAt === null && v.operationId === null
    if (schema < WEAVE_SCHEMA_VERSION || typeof v.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v.updatedAt)
      || new Date(v.updatedAt).toISOString() !== v.updatedAt || requiredId(v.operationId).toLowerCase() !== v.operationId) return false
    return JSON.stringify(parseWeaveState(v.fields)) === JSON.stringify(v.fields)
  } catch { return false }
}
