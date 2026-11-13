import { useCallback } from 'react'
import type { Result, StudioApi } from '../../contracts/api'
import { isForeshadowThumbnailImage, sameForeshadowThumbnail, type ForeshadowThumbnailFields, type ForeshadowThumbnailMetadata } from '../../contracts/foreshadow-thumbnail'
import { MaterialThumbnail } from './NoteThumbnail'

export function ForeshadowThumbnail({ api, bookId, recordId, metadata, name, className, retryable = true }: {
  api: StudioApi; bookId: string; recordId: string; metadata: ForeshadowThumbnailMetadata | null; name: string; className?: string; retryable?: boolean
}) {
  const read = useCallback(async (): Promise<Result<ForeshadowThumbnailFields>> => {
    if (!metadata) return { ok: false, error: { code: 'NOT_FOUND', message: '未设置伏笔配图。' } }
    if (metadata.recordId !== recordId) return { ok: false, error: { code: 'STORAGE_ERROR', message: '配图不属于当前伏笔，未读取其他记录的图片。' } }
    const input = { bookId, id: recordId, imageRevision: metadata.knowledgeRevision }
    const result = await api.readForeshadowThumbnail(input)
    if (!result.ok) return result
    if (!isForeshadowThumbnailImage(result.data, input)) return { ok: false, error: { code: 'STORAGE_ERROR', message: '伏笔配图回执与固定版本不一致。' } }
    const { bookId: _owner, dataBase64, ...saved } = result.data
    if (!sameForeshadowThumbnail(saved, metadata)) return { ok: false, error: { code: 'STORAGE_ERROR', message: '伏笔配图元信息与固定版本不一致。' } }
    return { ok: true, data: { mime: saved.mime, sha256: saved.sha256, alt: saved.alt, dataBase64 } }
  }, [api, bookId, recordId, metadata])
  return <MaterialThumbnail read={metadata ? read : null} name={name} className={className} retryable={retryable} emptyIcon="image" />
}
