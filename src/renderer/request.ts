import type { Result } from '../contracts/api'

export async function request<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
  try { return await operation() } catch {
    return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '本地服务暂时不可用，请保留当前窗口并重试。' } }
  }
}

export const statusLabels = { planned: '待写', writing: '草稿', review: '待审', finalized: '已定稿' }
export function displayTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
