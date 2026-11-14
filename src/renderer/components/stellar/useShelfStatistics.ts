import { useEffect, useRef, useState } from 'react'
import { isRecord, type BookSummary, type StudioApi } from '../../../contracts/api'
import { queueBackgroundRead } from '../../background-reads'
import { request } from '../../request'

interface CachedBook { revision: number; summary: BookSummary }
interface SummaryCache { api: StudioApi; scope: string; items: Map<string, CachedBook> }

export function useShelfStatistics(api: StudioApi | undefined, scope: string | undefined, books: readonly BookSummary[]) {
  const cache = useRef<SummaryCache | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; api: StudioApi; error?: string } | null>(null)
  const key = JSON.stringify([scope, attempt, books.map((book) => [book.id, book.revision, book.archivedAt, book.lifecycle])])
  const current = cache.current && cache.current.api === api && cache.current.scope === scope ? cache.current : null
  const available = Boolean(api && scope && typeof api.getBookSummary === 'function')
  let activeCount = 0, finishedCount = 0, unknown = 0
  // 跟随书卡的归档优先级；孵化和未知状态不能补算为连载或完结。
  for (const book of books) {
    if (book.archivedAt) continue
    const cached = current?.items.get(book.id)
    const summary = cached?.revision === book.revision ? cached.summary : book
    if (summary.archivedAt) continue
    if (summary.lifecycle === 'active') activeCount += 1
    else if (summary.lifecycle === 'finished') finishedCount += 1
    else if (summary.lifecycle !== 'kickstarting') unknown += 1
  }

  useEffect(() => {
    if (!api || !scope || typeof api.getBookSummary !== 'function') return
    const source = cache.current && cache.current.api === api && cache.current.scope === scope
      ? cache.current : { api, scope, items: new Map<string, CachedBook>() }
    cache.current = source
    const service = api
    const ids = new Set(books.map((book) => book.id))
    for (const id of source.items.keys()) if (!ids.has(id)) source.items.delete(id)
    let active = true
    async function load() {
      let error: string | undefined
      for (const book of books) {
        if (!active) return
        if (book.archivedAt || book.lifecycle !== undefined || source.items.get(book.id)?.revision === book.revision) continue
        // 逐本进入已有辅助队列，离页后不继续排队；相同书库／服务／版本复用本页缓存。
        const response = await queueBackgroundRead(async () => active ? request(() => service.getBookSummary({ bookId: book.id })) : null)
        if (!active || !response) return
        if (!response.ok) {
          error ??= response.error.message
          if (['SERVICE_UNAVAILABLE', 'WORKSPACE_REQUIRED', 'WORKSPACE_BUSY', 'REQUEST_TIMEOUT'].includes(response.error.code)) break
          continue
        }
        const summary = response.data
        if (!isRecord(summary) || summary.id !== book.id || !Number.isSafeInteger(summary.revision) || summary.revision < book.revision
          || !(summary.archivedAt === null || typeof summary.archivedAt === 'string' && Number.isFinite(Date.parse(summary.archivedAt)))
          || summary.lifecycle !== undefined && !['kickstarting', 'active', 'finished'].includes(summary.lifecycle)) {
          error ??= '作品身份、版本或状态无效，请重新读取。'
          continue
        }
        source.items.set(book.id, { revision: book.revision, summary })
      }
      if (active) setResult({ key, api: service, error })
    }
    void load()
    return () => { active = false }
  }, [api, scope, key])

  const loaded = result?.key === key && result.api === api ? result : null
  return { activeCount, finishedCount, unknown, canRetry: available,
    error: loaded?.error ?? (unknown && !available ? '作品状态读取入口暂不可用。' : undefined),
    loading: Boolean(unknown && available && !loaded),
    retry: () => setAttempt((value) => value + 1) }
}
