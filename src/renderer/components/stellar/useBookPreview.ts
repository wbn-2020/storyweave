import { useEffect, useState } from 'react'
import type { BookSnapshot, BookSummary, StudioApi } from '../../../contracts/api'
import { request } from '../../request'
import { queueBackgroundRead } from '../../background-reads'

export function useBookPreview(api: StudioApi | undefined, scope: string | undefined, book: BookSummary | undefined, supplied?: BookSnapshot | null) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; api: StudioApi; snapshot?: BookSnapshot; error?: string } | null>(null)
  const key = JSON.stringify([scope, book?.id, book?.revision, attempt])
  const current = supplied?.book.id === book?.id && supplied && supplied.book.revision >= (book?.revision ?? 0) ? supplied : null
  useEffect(() => {
    if (!api || !scope || !book || current) return
    let active = true
    void queueBackgroundRead(async () => {
      if (!active) return
      const value = await request(() => api.getBook({ bookId: book.id }))
      if (!active) return
      // 新版本或新书库先隔离旧数据，迟到回包不得把旧稿的统计带进当前卡片。
      setResult(!value.ok ? { key, api, error: value.error.message }
        : value.data.book.id !== book.id || value.data.book.revision < book.revision
          ? { key, api, error: '作品版本已变化，请重新读取。' }
          : { key, api, snapshot: value.data })
    })
    return () => { active = false }
  }, [api, scope, book?.id, book?.revision, key, current])
  const loaded = result?.key === key && result.api === api ? result : null
  return { snapshot: current ?? loaded?.snapshot ?? null, error: loaded?.error,
    loading: Boolean(api && scope && book && !current && !loaded), retry: () => setAttempt((value) => value + 1) }
}
