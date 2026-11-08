export interface WritingPosition {
  blockId?: string
  offset?: number
  scrollTop?: number
  /** 仅用于本次显式跳转，由 App 的临时定位 ref 传入，不持久化。 */
  reveal?: boolean
}
interface BookPosition extends Omit<WritingPosition, 'reveal'> { chapterId: string }
interface LibraryPositions { lastBookId: string | null; books: Record<string, BookPosition> }
const memory = new Map<string, LibraryPositions>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function key(root: string): string { return `storyweave.writing-location.v1:${root.replaceAll('\\', '/').toLowerCase()}` }
function read(root: string): LibraryPositions {
  const storageKey = key(root)
  const cached = memory.get(storageKey)
  if (cached) return cached
  let value: LibraryPositions = { lastBookId: null, books: {} }
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw && raw.length < 500_000) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.books === 'object' && parsed.books !== null && !Array.isArray(parsed.books)) {
        for (const [bookId, unknownPosition] of Object.entries(parsed.books).slice(0, 1_000)) {
          const position = unknownPosition as BookPosition | null
          if (!UUID.test(bookId) || !position || !UUID.test(position.chapterId)) continue
          value.books[bookId] = { chapterId: position.chapterId,
            blockId: typeof position.blockId === 'string' && UUID.test(position.blockId) ? position.blockId : undefined,
            offset: Number.isSafeInteger(position.offset) && position.offset! >= 0 ? position.offset : undefined,
            scrollTop: Number.isFinite(position.scrollTop) && position.scrollTop! >= 0 ? position.scrollTop : undefined }
        }
        if (typeof parsed.lastBookId === 'string' && value.books[parsed.lastBookId]) value.lastBookId = parsed.lastBookId
      }
    }
  } catch { /* 偏好存储不可用时继续保留本会话位置，正文保存不受影响。 */ }
  memory.set(storageKey, value)
  return value
}

export function lastWritingBook(root: string | null): string | null { return root ? read(root).lastBookId : null }
export function writingPosition(root: string | null, bookId: string): BookPosition | null { return root ? read(root).books[bookId] ?? null : null }
export function rememberWritingPosition(root: string | null, bookId: string, chapterId: string, position: WritingPosition = {}): void {
  if (!root || !UUID.test(bookId) || !UUID.test(chapterId)) return
  const value = read(root)
  const previous = value.books[bookId]?.chapterId === chapterId ? value.books[bookId] : undefined
  // 换章清除旧位置；只保存持久字段，显式跳转标记不能泄漏到下次普通恢复。
  value.books[bookId] = { chapterId,
    blockId: 'blockId' in position ? position.blockId : previous?.blockId,
    offset: 'offset' in position ? position.offset : previous?.offset,
    scrollTop: 'scrollTop' in position ? position.scrollTop : previous?.scrollTop }
  value.lastBookId = bookId
  try { localStorage.setItem(key(root), JSON.stringify(value)) } catch { /* 内存位置仍可用于本次会话。 */ }
}
