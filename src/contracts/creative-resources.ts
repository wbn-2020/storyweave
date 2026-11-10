import { DomainError, isRecord, requiredId, requiredInteger, requiredText } from './api'

export const MAX_CREATIVE_RESOURCES = 8
export const RESOURCE_SOURCES = ['scene', 'note', 'inspiration', 'builtin', 'foreshadow'] as const
export type CreativeResourceSource = typeof RESOURCE_SOURCES[number]
export interface CreativeResourceRef { source: CreativeResourceSource; id: string; revision: number }
export interface CreativeResource extends CreativeResourceRef { title: string; text: string; role: 'plan' | 'material' | 'method' }
export interface CreativeResources { version: 1; items: CreativeResource[]; application: string }
export interface CreativeSelection { refs: CreativeResourceRef[]; application: string }

// 方法是作者选用的写作步骤，不是故事事实；固定版本使历史发送预览可复核。
export const WRITING_METHODS: readonly CreativeResource[] = [
  { source: 'builtin', id: 'dethrone-ai', revision: 1, role: 'method', title: '去 AI 味润色', text: '清洗“仿佛、宛如、嘴角勾起一抹弧度、眼中闪过一丝精芒、倒吸一口凉气”等常见 AI 套话。转换为极简动词白描、富有生活烟火气的口语对话与带有体温的细节反应。' },
  { source: 'builtin', id: 'hook-opening', revision: 1, role: 'method', title: '黄金三章开篇', text: '建立开篇核心危机与强悬念钩子。迅速拉高主角动机与金手指/能力预期，安排快节奏的冲突对抗与压迫感，确保开篇三章牢牢抓住读者注意力。' },
  { source: 'builtin', id: 'action-breakdown', revision: 1, role: 'method', title: '打斗动作分解', text: '将笼统概括的战斗拆解为起手预备、发力机制、受创物理反馈、呼吸与心理动态，以及对周边环境的破坏交互，写出招招到肉、分寸可感的真实张力。' },
  { source: 'builtin', id: 'dialogue-subtext', revision: 1, role: 'method', title: '对白潜台词塑造', text: '为说话双方确定行动目标、隐瞒信息与心理攻防。通过称谓、停顿、微动作与言不由衷体现差异，拒绝信息直给，写出话里有话的张力。' },
  { source: 'builtin', id: 'escalation-tension', revision: 1, role: 'method', title: '情绪拉扯与控温', text: '先压后扬，设计多轮尝试与反转代价。让阻力层层升级，制造情绪悬崖与爽点爆发，避免剧情平铺直叙。' },
  { source: 'builtin', id: 'foreshadow-chain', revision: 1, role: 'method', title: '伏笔埋设与回收', text: '对照埋设、推进和计划回收资料，检查读者已知线索与隐藏真相。回收时务必引发人物理解或局势的重大震荡，形成前后照应。' },
  { source: 'builtin', id: 'iceberg-world', revision: 1, role: 'method', title: '冰山世界观白描', text: '杜绝大段设定说明文。通过人物的衣食住行、铜板银两、市井行话、规矩禁忌侧面带出世界观全貌，只露冰山一角。' },
  { source: 'builtin', id: 'cliffhanger-hook', revision: 1, role: 'method', title: '断章卡点制造', text: '在高潮即将来临的一瞬、重大秘密揭晓前半秒，或在突如其来的致命危机处落笔截断，制造强烈的悬念与期待感。' },
  { source: 'builtin', id: 'scene-senses', revision: 1, role: 'method', title: '场景多感官描写', text: '围绕当前人物的行动目标描写环境。选择两三项与动作有关的感官细节，让环境反作用于人物选择，避免罗列景物。' },
  { source: 'builtin', id: 'single-sense', revision: 1, role: 'method', title: '单感官沉浸段落', text: '选择一种主要感官（如听觉或触觉）组织段落，用具体细节推进情绪。不要替人物知道他尚未观察到的事。' },
  { source: 'builtin', id: 'motivation', revision: 1, role: 'method', title: '人物动机与执念', text: '梳理人物此刻想要什么、为什么必须现在行动、害怕失去什么，以及他愿意付出的代价。用选择和行动体现动机。' },
  { source: 'builtin', id: 'escalation', revision: 1, role: 'method', title: '冲突递增', text: '从当前目标与阻碍出发，提出尝试、反馈、代价和新选择。每次升级改变局面，不重复同一争执。' },
  { source: 'builtin', id: 'payoff', revision: 1, role: 'method', title: '伏笔回收', text: '说明读者已知什么、还欠什么。回收时改变人物的选择或理解；没有出处的伏笔标为待补充。' },
  { source: 'builtin', id: 'dialogue', revision: 1, role: 'method', title: '对白与潜台词', text: '为说话双方确定目标、隐瞒的信息和关系位置。用称谓、停顿与行动体现差异。' },
]

function invalid(): never { throw new DomainError({ code: 'INVALID_INPUT', message: '场景、资料或方法选择无效，请重新选择。' }) }
export function parseCreativeRefs(value: unknown): CreativeResourceRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_CREATIVE_RESOURCES) return invalid()
  const refs = value.map((entry): CreativeResourceRef => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !['source', 'id', 'revision'].includes(key)) || !RESOURCE_SOURCES.includes(entry.source as CreativeResourceSource)) return invalid()
    const source = entry.source as CreativeResourceSource
    const id = source === 'builtin' ? requiredText(entry.id, '方法标识', 80) : requiredId(entry.id).toLowerCase()
    const revision = requiredInteger(entry.revision, '资料版本')
    if (revision < 1 || (source === 'builtin' && !WRITING_METHODS.some((method) => method.id === id && method.revision === revision))) return invalid()
    return { source, id, revision }
  })
  if (new Set(refs.map((ref) => `${ref.source}:${ref.id}`)).size !== refs.length) return invalid()
  return refs
}
export function parseCreativeApplication(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 2_000 || value.includes('\0')) return invalid()
  return value
}
export function creativeRef(item: CreativeResourceRef): CreativeResourceRef { return { source: item.source, id: item.id, revision: item.revision } }
export function parseCreativeResources(value: unknown): CreativeResources {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items) || Object.keys(value).some((key) => !['version', 'items', 'application'].includes(key))) return invalid()
  const refs = parseCreativeRefs(value.items.map((item) => isRecord(item) ? creativeRef(item as unknown as CreativeResourceRef) : item))
  const items = value.items.map((item, index): CreativeResource => {
    if (!isRecord(item) || Object.keys(item).some((key) => !['source', 'id', 'revision', 'title', 'text', 'role'].includes(key)) || !['plan', 'material', 'method'].includes(String(item.role))) return invalid()
    const title = requiredText(item.title, '资料标题', 160)
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 50_000 || item.text.includes('\0')) return invalid()
    return { ...refs[index]!, title, text: item.text, role: item.role as CreativeResource['role'] }
  })
  return { version: 1, items, application: parseCreativeApplication(value.application) }
}
