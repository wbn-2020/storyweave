import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result, StudioApi } from '../../contracts/api'
import { BOOK_MEDIA_MIMES, MAX_BOOK_MEDIA_ITEM_BYTES, validateBookMediaPayload, type BookMediaMime } from '../../contracts/book-media'
import { isNoteThumbnailImage, parseNoteThumbnailFields, sameNoteThumbnail, type NoteThumbnailFields, type NoteThumbnailMetadata } from '../../contracts/note-thumbnail'
import { isInspirationThumbnailImage, sameInspirationThumbnail, type InspirationThumbnailMetadata } from '../../contracts/inspiration-thumbnail'
import { queueBackgroundRead } from '../background-reads'
import { request } from '../request'
import { StudioIcon } from './StudioIcon'
import styles from './StellarNotes.module.css'

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function readNoteThumbnailFile(file: File): Promise<NoteThumbnailFields> {
  if (!BOOK_MEDIA_MIMES.includes(file.type as BookMediaMime) || !/\.(png|jpe?g|webp)$/i.test(file.name)
    || file.size < 4 || file.size > MAX_BOOK_MEDIA_ITEM_BYTES) throw new Error('请选择不超过 2 MiB 的本地 PNG、JPEG 或 WebP 图片。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  const dataBase64 = btoa(binary), mime = file.type as BookMediaMime
  if (bytes.byteLength !== file.size || validateBookMediaPayload(mime, dataBase64) !== file.size) throw new Error('缩略图读取长度或文件签名不一致。')
  const image = new Image()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    image.src = `data:${mime};base64,${dataBase64}`
    await Promise.race([image.decode(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('缩略图解码超时。')), 10000) })])
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 4096 || image.naturalHeight > 4096) throw new Error('缩略图尺寸须在 1 到 4096 像素之间。')
  } finally { clearTimeout(timeout); image.src = '' }
  return parseNoteThumbnailFields({ mime, dataBase64, sha256: await digest(bytes), alt: file.name.slice(0, 2000) })
}

export function NoteThumbnail({ api, bookId, metadata, name, className }: {
  api: StudioApi; bookId: string; metadata: NoteThumbnailMetadata | null; name: string; className?: string
}) {
  const read = useCallback(async (): Promise<Result<NoteThumbnailFields>> => {
    if (!metadata) return { ok: false, error: { code: 'NOT_FOUND', message: '未设置素材配图。' } }
    const input = { bookId, id: metadata.noteId, imageRevision: metadata.noteRevision }
    const result = await api.readNoteThumbnail(input)
    if (!result.ok) return result
    if (!isNoteThumbnailImage(result.data, input)) return { ok: false, error: { code: 'STORAGE_ERROR', message: '缩略图回执与当前固定版本不一致。' } }
    const { bookId: _bookId, dataBase64, ...saved } = result.data
    if (!sameNoteThumbnail(saved, metadata)) return { ok: false, error: { code: 'STORAGE_ERROR', message: '缩略图元数据与当前固定版本不一致。' } }
    return { ok: true, data: { mime: saved.mime, sha256: saved.sha256, alt: saved.alt, dataBase64 } }
  }, [api, bookId, metadata])
  return <MaterialThumbnail read={metadata ? read : null} name={name} className={className} />
}

export function InspirationThumbnail({ api, metadata, name, className }: {
  api: StudioApi; metadata: InspirationThumbnailMetadata | null; name: string; className?: string
}) {
  const read = useCallback(async (): Promise<Result<NoteThumbnailFields>> => {
    if (!metadata) return { ok: false, error: { code: 'NOT_FOUND', message: '未设置灵感配图。' } }
    const input = { id: metadata.inspirationId, imageRevision: metadata.inspirationRevision }
    const result = await api.readInspirationThumbnail(input)
    if (!result.ok) return result
    if (!isInspirationThumbnailImage(result.data, input)) return { ok: false, error: { code: 'STORAGE_ERROR', message: '灵感图片回执与当前固定版本不一致。' } }
    const { dataBase64, ...saved } = result.data
    if (!sameInspirationThumbnail(saved, metadata)) return { ok: false, error: { code: 'STORAGE_ERROR', message: '灵感图片元数据与当前固定版本不一致。' } }
    return { ok: true, data: { mime: saved.mime, sha256: saved.sha256, alt: saved.alt, dataBase64 } }
  }, [api, metadata])
  return <MaterialThumbnail read={metadata ? read : null} name={name} className={className} />
}

function MaterialThumbnail({ read, name, className }: {
  read: (() => Promise<Result<NoteThumbnailFields>>) | null; name: string; className?: string
}) {
  const host = useRef<HTMLSpanElement>(null)
  const [value, setValue] = useState<{ read: typeof read; src?: string; alt?: string; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const current = value?.read === read ? value : null
  useEffect(() => {
    let active = true, started = false, visible = false
    const element = host.current, fetchImage = read
    setValue(null)
    if (!fetchImage || !element) return
    const fail = (message: string) => { if (active) setValue({ read, error: message }) }
    const load = () => {
      if (!active || started || !visible || document.visibilityState === 'hidden') return
      started = true
      void queueBackgroundRead(async () => {
        if (!active || !visible || document.visibilityState === 'hidden') { started = false; return }
        try {
          const result = await request(fetchImage)
          if (!active) return
          if (!result.ok) { fail(result.error.message); return }
          const { dataBase64, mime, sha256, alt } = result.data
          const bytes = Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0))
          if (await digest(bytes) !== sha256) { fail('缩略图内容校验失败。'); return }
          if (active) setValue({ read, src: `data:${mime};base64,${dataBase64}`, alt })
        } catch { fail('缩略图读取失败，请在详情重试。') }
      })
    }
    const observer = new IntersectionObserver((entries) => { visible = Boolean(entries.at(-1)?.isIntersecting); load() }, { threshold: .01 })
    observer.observe(element)
    document.addEventListener('visibilitychange', load)
    return () => { active = false; observer.disconnect(); document.removeEventListener('visibilitychange', load) }
  }, [read, attempt])
  return <span ref={host} className={className} title={current?.error} aria-busy={Boolean(read && !current)}>
    {current?.src ? <img src={current.src} alt={current.alt || name} decoding="async" onError={() => setValue({ read, error: '缩略图无法解码。' })} />
      : <span className={styles.thumbnailEmpty}><StudioIcon name="notes" size={24} /><small>{current?.error ? '图片暂不可用' : read ? '读取图片…' : '未配图'}</small></span>}
    {current?.error && <button type="button" className={styles.thumbnailRetry} title={current.error} aria-label={`重试读取缩略图：${name}`}
      onClick={() => { setValue(null); setAttempt((value) => value + 1) }}>重试</button>}
  </span>
}
