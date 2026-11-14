import { DomainError, isRecord, requiredId } from './api'

export type AiKeySessionInput = { sessionId: string } & ({ scope: 'studio' } | { scope: 'book'; bookId: string })
export interface AiKeySessionReceipt { sessionId: string }

export function parseAiKeySessionInput(value: unknown): AiKeySessionInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['sessionId', 'scope', 'bookId'].includes(key)) ||
    !['studio', 'book'].includes(String(value.scope)) || value.scope === 'studio' && value.bookId !== undefined) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '模型页面会话参数无效。' })
  }
  const sessionId = requiredId(value.sessionId).toLowerCase()
  return value.scope === 'book' ? { sessionId, scope: 'book', bookId: requiredId(value.bookId).toLowerCase() } : { sessionId, scope: 'studio' }
}

export function parseAiKeySessionClose(value: unknown): AiKeySessionReceipt {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'sessionId')) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '模型页面会话编号无效。' })
  }
  return { sessionId: requiredId(value.sessionId).toLowerCase() }
}
