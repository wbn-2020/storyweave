import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { StudioApi } from '../../contracts/api'
import { isBookMediaImage, isBookMediaSnapshot, type BookMediaMetadata } from '../../contracts/book-media'
import { request } from '../request'
import { queueBackgroundRead } from '../background-reads'

export function useSavedPortraits(api: StudioApi, bookId: string, bookRevision: number, refreshKey: object | null = null) {
  const media = useSavedMedia(api, bookId, bookRevision, refreshKey)
  return { ...media, items: media.items.filter((item) => item.kind === 'portrait') }
}

export function useSavedMedia(api: StudioApi, bookId: string, bookRevision: number, refreshKey: object | null = null, enabled = true) {
  const [value, setValue] = useState<{ api: StudioApi; bookId: string; revision: number; refreshKey: object | null; items: BookMediaMetadata[]; error: string | null } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void request(() => api.getBookMedia({ bookId })).then((result) => {
      if (!active) return
      const valid = result.ok && isBookMediaSnapshot(result.data, bookId) && result.data.bookRevision === bookRevision
      setValue({ api, bookId, revision: bookRevision, refreshKey, items: valid ? result.data.items : [],
        error: !result.ok ? result.error.message : valid ? null : '图片资料与当前作品版本不一致，请刷新资料。' })
    })
    return () => { active = false }
  }, [api, bookId, bookRevision, refreshKey, enabled])
  const current = value?.api === api && value.bookId === bookId && value.revision === bookRevision && value.refreshKey === refreshKey ? value : null
  return { items: enabled ? current?.items ?? [] : [], error: enabled ? current?.error ?? null : null, loading: enabled && current === null }
}

export function SavedPortrait({ api, bookId, personId, metadata, name, fallback, className }: {
  api: StudioApi; bookId: string; personId: string; metadata?: BookMediaMetadata; name: string; fallback: ReactNode; className?: string
}) {
  return <SavedMediaImage api={api} bookId={bookId} metadata={metadata?.kind === 'portrait' && metadata.personId === personId ? metadata : undefined}
    name={`${name}的已保存立绘`} fallback={fallback} className={className} />
}

export function SavedMediaImage({ api, bookId, metadata, name, fallback, className }: {
  api: StudioApi; bookId: string; metadata?: BookMediaMetadata; name: string; fallback: ReactNode; className?: string
}) {
  const host = useRef<HTMLSpanElement>(null)
  const [image, setImage] = useState<{ api: StudioApi; key: string; src: string } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const key = `${bookId}:${metadata?.id ?? ''}:${metadata?.sha256 ?? ''}`
  const currentImage = image?.api === api && image.key === key ? image : null
  const currentError = error?.key === key ? error.message : null
  useEffect(() => {
    let active = true, started = false, inView = false
    setImage(null); setError(null)
    const element = host.current
    if (!element || !metadata) return
    const fail = (message: string) => { if (active) setError({ key, message }) }
    function load() {
      if (!active || started || !inView || !metadata || document.visibilityState === 'hidden') return
      started = true
      void queueBackgroundRead(async () => {
        if (!active || !inView || document.visibilityState === 'hidden' || !metadata) { started = false; return }
        try {
          const result = await request(() => api.readBookMedia({ bookId, id: metadata.id }))
          if (!active) return
          if (!result.ok) { fail(result.error.message); return }
          const picture = result.data
          if (!isBookMediaImage(picture, bookId, metadata.id) ||
              Object.entries(metadata).some(([field, value]) => picture[field as keyof BookMediaMetadata] !== value)) {
            fail('图片与所选固定资源不一致。'); return
          }
          // 原图只在进入视口后读取，摘要与完整元信息核对防止错用或损坏资源。
          const bytes = Uint8Array.from(atob(picture.dataBase64), (character) => character.charCodeAt(0))
          const hash = await crypto.subtle.digest('SHA-256', bytes.buffer)
          if (!active) return
          if (Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') !== picture.sha256) { fail('图片内容校验失败。'); return }
          setImage({ api, key, src: `data:${picture.mime};base64,${picture.dataBase64}` })
        } catch { fail('图片读取失败。') }
      })
    }
    const observer = new IntersectionObserver((entries) => { inView = Boolean(entries.at(-1)?.isIntersecting); void load() }, { threshold: .01 })
    const onVisibility = () => { void load() }
    observer.observe(element)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { active = false; observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [api, bookId, metadata, key])
  return <span ref={host} className={className} title={currentError ?? undefined} aria-busy={Boolean(metadata && !currentImage && !currentError)}>
    {currentImage && !currentError ? <img src={currentImage.src} alt={metadata?.alt || name} onError={() => setError({ key, message: '图片无法解码。' })} /> : fallback}
    {currentError && <small role="status">图片暂不可用</small>}
  </span>
}
