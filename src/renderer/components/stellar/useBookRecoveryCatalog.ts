import { useEffect, useState } from 'react'
import type { StudioApi } from '../../../contracts/api'
import { isBookRecoveryCatalogFor, type BookRecoveryCatalog } from '../../../contracts/book-recovery'
import { queueBackgroundRead } from '../../background-reads'
import { request } from '../../request'

export function useBookRecoveryCatalog(api: StudioApi | undefined, targetRoot: string | null, enabled: boolean, identity: string | number = 0) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ api: StudioApi; key: string; data?: BookRecoveryCatalog; error?: string } | null>(null)
  const key = JSON.stringify([targetRoot, identity, attempt, enabled])
  useEffect(() => {
    if (!api || !targetRoot || !enabled) return
    let active = true
    const service = api
    // 与其他辅助读取共用队列；切库、重新连接或离页后不接纳旧清单。
    void queueBackgroundRead(async () => active ? request(() => service.listBookRecoveries()) : null).then((response) => {
      if (!active || !response) return
      setResult({ api: service, key, ...(response.ok
        ? isBookRecoveryCatalogFor(response.data, targetRoot) ? { data: response.data } : { error: '恢复包清单身份无效，请重新读取。' }
        : { error: response.error.message }) })
    })
    return () => { active = false }
  }, [api, targetRoot, enabled, key])
  const current = enabled && result && result.api === api && result.key === key ? result : null
  return { data: current?.data, error: current?.error, loading: Boolean(enabled && api && targetRoot && !current),
    retry: () => setAttempt((value) => value + 1) }
}
