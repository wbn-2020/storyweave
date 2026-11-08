import { DomainError, requiredId } from './api'
import { parseManuscript, type ManuscriptBlock, type ManuscriptDocument } from './manuscript'

export interface ParagraphChange {
  blockId: string
  /** 以当前稿为起点、来源稿为目标；added 表示来源稿独有。 */
  kind: 'added' | 'removed' | 'modified' | 'moved'
  current: ManuscriptBlock | null
  source: ManuscriptBlock | null
  currentIndex: number | null
  sourceIndex: number | null
  moved: boolean
  contentChanged: boolean
}

export function paragraphText(block: ManuscriptBlock): string {
  return block.type === 'horizontalRule' ? '' : (block.content ?? []).map((node) => node.type === 'hardBreak' ? '\n' : node.text).join('')
}

function compare(current: ManuscriptDocument, source: ManuscriptDocument): ParagraphChange[] {
  const currentById = new Map(current.content.map((block, index) => [block.attrs.id, { block, index }]))
  const sourceById = new Map(source.content.map((block, index) => [block.attrs.id, { block, index }]))
  const common = source.content.flatMap((block) => {
    const previous = currentById.get(block.attrs.id)
    return previous ? [{ id: block.attrs.id, index: previous.index }] : []
  })
  // 用共同段落的最长递增子序列确定顺序锚点；插入一段不会把其后所有段落误报为移动。
  const tails: number[] = []
  const predecessors = new Array<number>(common.length).fill(-1)
  common.forEach((entry, index) => {
    let left = 0, right = tails.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (common[tails[middle]].index < entry.index) left = middle + 1
      else right = middle
    }
    if (left) predecessors[index] = tails[left - 1]
    tails[left] = index
  })
  const stationary = new Set<string>()
  for (let index = tails.length ? tails[tails.length - 1] : -1; index !== -1; index = predecessors[index]) stationary.add(common[index].id)
  const changes: ParagraphChange[] = []
  for (const [blockId, next] of sourceById) {
    const previous = currentById.get(blockId)
    const moved = Boolean(previous && !stationary.has(blockId))
    const contentChanged = Boolean(previous && JSON.stringify(previous.block) !== JSON.stringify(next.block))
    if (!previous || moved || contentChanged) changes.push({ blockId, kind: !previous ? 'added' : moved ? 'moved' : 'modified',
      current: previous?.block ?? null, source: next.block, currentIndex: previous?.index ?? null, sourceIndex: next.index, moved, contentChanged })
  }
  for (const [blockId, previous] of currentById) {
    if (!sourceById.has(blockId)) changes.push({ blockId, kind: 'removed', current: previous.block, source: null,
      currentIndex: previous.index, sourceIndex: null, moved: false, contentChanged: false })
  }
  return changes
}

export function compareParagraphs(current: ManuscriptDocument, source: ManuscriptDocument): ParagraphChange[] {
  return compare(parseManuscript(current), parseManuscript(source))
}

/** 只采用明确选中的整段差异；不会修改传入文档，也不会重新生成已有段落的身份。 */
export function applyParagraphChanges(current: ManuscriptDocument, source: ManuscriptDocument, selectedBlockIds: readonly string[]): ManuscriptDocument {
  const original = parseManuscript(current), target = parseManuscript(source)
  const changes = new Map(compare(original, target).map((change) => [change.blockId, change]))
  const selected = new Set(selectedBlockIds.map((id) => requiredId(id).toLowerCase()))
  if (!selected.size || selected.size !== selectedBlockIds.length || [...selected].some((id) => !changes.has(id))) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '所选差异已失效或重复，请重新比较后选择。' })
  }
  const relocated = new Set([...selected].filter((id) => changes.get(id)!.kind === 'added' || changes.get(id)!.moved))
  const retained = original.content.flatMap((block) => {
    if (!selected.has(block.attrs.id)) return [block]
    const change = changes.get(block.attrs.id)!
    if (!change.source || relocated.has(block.attrs.id)) return []
    return [change.source]
  })
  const retainedIds = new Set(retained.map((block) => block.attrs.id))
  const before = new Map<string | null, ManuscriptBlock[]>()
  let anchor: string | null = null
  // 移动与内容采用同属一个选择；只以顺序未变的段落为锚点，避免另一处未选移动把本次恢复抵消。
  for (let index = target.content.length - 1; index >= 0; index -= 1) {
    const block = target.content[index]
    if (relocated.has(block.attrs.id)) {
      const group = before.get(anchor) ?? []
      group.push(block); before.set(anchor, group)
    } else if (retainedIds.has(block.attrs.id) && !changes.get(block.attrs.id)?.moved) anchor = block.attrs.id
  }
  const content: ManuscriptBlock[] = []
  for (const block of retained) {
    content.push(...(before.get(block.attrs.id) ?? []).reverse(), block)
  }
  content.push(...(before.get(null) ?? []).reverse())
  if (!content.length) throw new DomainError({ code: 'INVALID_INPUT', message: '不能只移除全部正文块。请同时选择要恢复的来源段落，或在编辑器中清空正文。' })
  return parseManuscript({ type: 'doc', content })
}
