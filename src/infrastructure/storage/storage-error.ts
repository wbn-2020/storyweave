import { DomainError, isRecord, type AppError } from '../../contracts/api'

export function storageFailureReason(error: unknown): AppError['storageReason'] {
  if (!isRecord(error)) return undefined
  // 仅使用原生错误码；数据库容量限制不能直接认定为物理磁盘已满。
  if (error.code === 'ENOSPC') return 'disk-full'
  if (error.code === 'SQLITE_FULL') return 'database-full'
  return undefined
}

export function storageError(error: unknown, message: string): DomainError {
  const storageReason = storageFailureReason(error)
  if (!storageReason) return new DomainError({ code: 'STORAGE_ERROR', message })
  const explanation = storageReason === 'disk-full'
    ? '磁盘空间不足。'
    : '数据库可用空间不足，请检查磁盘、临时存储空间及数据库容量限制。'
  return new DomainError({ code: 'STORAGE_ERROR', storageReason, message: `${explanation}${message}` })
}
