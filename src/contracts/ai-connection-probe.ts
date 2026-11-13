import { DomainError, isRecord, requiredId, requiredInteger } from './api'

export type AiConnectionProbeInput = { requestId: string; connectionId: string; expectedVersion: number } &
  ({ scope: 'studio' } | { scope: 'book'; bookId: string })
export interface AiConnectionProbeResult {
  requestId: string
  connectionId: string
  connectionVersion: number
  state: 'succeeded' | 'failed' | 'cancelled'
  latencyMs: number | null
  httpStatus: number | null
  checkedAt: string
  message: string
}
export function parseConnectionProbeInput(value: unknown): AiConnectionProbeInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['scope', 'bookId', 'requestId', 'connectionId', 'expectedVersion'].includes(key)) ||
      !['studio', 'book'].includes(String(value.scope)) || value.scope === 'studio' && value.bookId !== undefined) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '连接探测参数无效。' })
  }
  const input = { requestId: requiredId(value.requestId).toLowerCase(), connectionId: requiredId(value.connectionId).toLowerCase(),
    expectedVersion: requiredInteger(value.expectedVersion, '连接版本') }
  return value.scope === 'book' ? { ...input, scope: 'book', bookId: requiredId(value.bookId).toLowerCase() } : { ...input, scope: 'studio' }
}
export function parseConnectionProbeCancel(value: unknown): { requestId: string } {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'requestId')) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '连接探测编号无效。' })
  }
  return { requestId: requiredId(value.requestId).toLowerCase() }
}
