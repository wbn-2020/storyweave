import type { WorkspaceSnapshot } from '../contracts/api'

export interface RecentBookOpen { bookId: string; openedAt: string }
type LibraryScope = Pick<WorkspaceSnapshot, 'rootPath'>
const maximum = 20
const memory = new Map<string, readonly RecentBookOpen[]>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function key(workspace: LibraryScope): string | null {
  // 恢复编号会随重新绑定变化；持久偏好按目录归属，在 App 完成分支另核对本次恢复范围。
  return workspace.rootPath ? `storyweave.recent-book-opens.v1:${workspace.rootPath.replaceAll('\\', '/').toLowerCase()}` : null
}

export function recentBookOpens(workspace: LibraryScope): readonly RecentBookOpen[] {
  const storageKey = key(workspace)
  if (!storageKey) return []
  const cached = memory.get(storageKey)
  if (cached) return cached
  const entries: RecentBookOpen[] = []
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw && raw.length <= 8192) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const seen = new Set<string>()
        for (const candidate of parsed.slice(0, maximum)) {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
          const entry = candidate as Partial<RecentBookOpen>
          if (typeof entry.bookId !== 'string' || !UUID.test(entry.bookId) || seen.has(entry.bookId)
            || typeof entry.openedAt !== 'string' || entry.openedAt.length !== 24) continue
          const time = Date.parse(entry.openedAt)
          if (!Number.isFinite(time) || new Date(time).toISOString() !== entry.openedAt) continue
          entries.push({ bookId: entry.bookId, openedAt: entry.openedAt })
          seen.add(entry.bookId)
        }
      }
    }
  } catch { /* 偏好不可用或损坏时不推算历史，后续成功打开仍保留本会话记录。 */ }
  memory.set(storageKey, entries)
  return entries
}

export function rememberBookOpen(workspace: LibraryScope, bookId: string): void {
  const storageKey = key(workspace)
  if (!storageKey || !UUID.test(bookId)) return
  // 由成功进入作品的分支调用；不从修改时间、自动保存或后台预览伪造打开记录。
  const entries = [{ bookId, openedAt: new Date().toISOString() },
    ...recentBookOpens(workspace).filter((entry) => entry.bookId !== bookId)].slice(0, maximum)
  memory.set(storageKey, entries)
  try { localStorage.setItem(storageKey, JSON.stringify(entries)) } catch { /* 偏好写入失败不阻断正文或页面导航。 */ }
}
