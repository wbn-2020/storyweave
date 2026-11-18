import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DomainError, type AppError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import {
  BOOK_MEDIA_MIMES, MEDIA_SCHEMA_VERSION, SCENE_MEDIA_SCHEMA_VERSION, MAX_BOOK_MEDIA_BYTES, MAX_BOOK_MEDIA_ITEM_BYTES, MAX_BOOK_MEDIA_ITEMS,
  isBookMediaImage, isBookMediaSnapshot, parseSaveBookMediaInput, validateBookMediaPayload,
  type BookMediaApi, type BookMediaFields, type BookMediaImage, type BookMediaKind, type BookMediaMetadata,
  type BookMediaMime, type BookMediaSnapshot, type SaveBookMediaInput, type BookMediaExportReceipt,
} from '../../contracts/book-media'
import type { KnowledgeItemPage } from '../../contracts/knowledge'
import { isImageGenerationPage, type ImageGenerationPage, type ImageGenerationRun } from '../../contracts/image-generation'
import { sameFields, useToolSession } from './workbench-ui'
import { StudioIcon } from './StudioIcon'
import { SavedMediaImage } from './SavedPortrait'
import { ImageGenerationEditor } from './ImageGenerationEditor'
import { Dialog, DialogDisplayContext } from './Dialog'
import { usePanelLeave, type RegisterPanelLeaveGuard } from '../hooks/usePanelLeave'
import { request } from '../request'
import styles from './StellarMedia.module.css'

export interface BookMediaPanelProps {
  api: StudioApi & BookMediaApi
  book: BookSnapshot
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onBookChange: (book: BookSnapshot) => void
  onUnknown?: (error: AppError) => void
  onRecover?: () => void
  onClose?: () => void
  onPerson?: (personId?: string) => void
  registerLeaveGuard: RegisterPanelLeaveGuard
  scenePlaceId?: string
  initialRunId?: string
}

type MediaOperation = 'reload' | 'image' | 'file' | 'people' | 'save' | 'compare' | 'upgrade' | 'readReceipt' | 'writeReceipt' | 'export'

function sizeLabel(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(2)} MiB` }
function encode(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return btoa(binary)
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function decodeImage(mime: BookMediaMime, dataBase64: string): Promise<void> {
  const image = new Image()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    image.src = `data:${mime};base64,${dataBase64}`
    await Promise.race([image.decode(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('decode timeout')), 10000)
    })])
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('empty image')
  } finally { clearTimeout(timeout); image.src = '' }
}

/** 只接收经过契约检查的内存图片；解码失败保留元信息，并允许重试显示。 */
function MediaPreview({ fields, onDecoded }: { fields: Pick<BookMediaFields, 'title' | 'alt' | 'mime' | 'dataBase64'>; onDecoded: (ready: boolean) => void }) {
  const [failed, setFailed] = useState(false), [loaded, setLoaded] = useState(false), [original, setOriginal] = useState(false), [attempt, setAttempt] = useState(0)
  return <figure className={styles.preview}>
    {failed ? <div className={styles.warning} role="alert"><p>原图无法解码或显示。图片记录仍保留，可以重试，或选择其他有效图片追加新版本。</p>
      <button type="button" className={styles.button} onClick={() => { setFailed(false); setLoaded(false); setAttempt(attempt + 1) }}>重试显示</button></div>
      : <div className={styles.imageViewport} data-original={original} tabIndex={original ? 0 : undefined} aria-label={original ? '原图，可滚动查看' : undefined}>
        {!loaded && <p role="status">正在解码原图…</p>}
        <img key={attempt} className={styles.image} src={`data:${fields.mime};base64,${fields.dataBase64}`} alt={fields.alt || fields.title}
          decoding="async" onLoad={() => { setLoaded(true); onDecoded(true) }} onError={() => { setFailed(true); setLoaded(false); onDecoded(false) }} />
      </div>}
    <figcaption><strong>{fields.title}</strong>{fields.alt && <p className={styles.notes}>{fields.alt}</p>}</figcaption>
    <div className={styles.actions}><button type="button" className={styles.button} disabled={failed || !loaded} aria-pressed={original} onClick={() => setOriginal(!original)}>
      {original ? '适应面板' : '按原图尺寸查看'}</button></div>
  </figure>
}

export function BookMediaPanel(props: BookMediaPanelProps) { return <MediaContent key={`${props.book.book.id}:${props.scenePlaceId ?? ''}:${props.initialRunId ?? ''}`} {...props} /> }

function MediaContent({ api, book, disabled, onDirtyChange, onBookChange, onUnknown, onRecover, onClose, onPerson, registerLeaveGuard, scenePlaceId, initialRunId }: BookMediaPanelProps) {
  const bookId = book.book.id
  const sceneMode = scenePlaceId !== undefined
  const requiredSchema = sceneMode ? SCENE_MEDIA_SCHEMA_VERSION : MEDIA_SCHEMA_VERSION
  const [placeName, setPlaceName] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<BookMediaSnapshot | null>(null)
  const [kind, setKind] = useState<BookMediaKind>(sceneMode ? 'scene' : 'portrait')
  const [personFilter, setPersonFilter] = useState('')
  const [roleFilter, setRoleFilter] = useState('all'), [portraitOffset, setPortraitOffset] = useState(0), [coverOffset, setCoverOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [image, setImage] = useState<BookMediaImage | null>(null)
  const [imageDecoded, setImageDecoded] = useState(false), [draftDecoded, setDraftDecoded] = useState(false)
  const [draft, setDraft] = useState<SaveBookMediaInput | null>(null)
  const [draftHash, setDraftHash] = useState('')
  const [draftBytes, setDraftBytes] = useState(0)
  const [discard, setDiscard] = useState(false)
  const [conflict, setConflict] = useState<BookMediaSnapshot | null>(null)
  const [conflictPlaceName, setConflictPlaceName] = useState<string | null>(null)
  const [syncRequired, setSyncRequired] = useState(false)
  const [recoveryPreserved, setRecoveryPreserved] = useState(false)
  const [generationPage, setGenerationPage] = useState<ImageGenerationPage | null>(null), [generationWarning, setGenerationWarning] = useState<string | null>(null)
  const [readingGenerations, setReadingGenerations] = useState(false)
  const generationRead = useRef<Promise<ImageGenerationPage | undefined> | null>(null)
  const mounted = useRef(true), lifetime = useRef(0)
  const [operation, setOperation] = useState<MediaOperation | null>(null)
  const operationRef = useRef<MediaOperation | null>(null), returnFocus = useRef<HTMLElement | null>(null)
  const [generator, setGenerator] = useState<{ kind: 'cover' | 'portrait'; runId?: string } | null>(null)
  const initialGeneration = useRef(sceneMode ? undefined : initialRunId)
  const [generationState, setGenerationState] = useState({ dirty: false, locked: false, running: false })
  const generationRef = useRef(generationState), mediaGuard = useRef(false), dirtyCallback = useRef(onDirtyChange)
  dirtyCallback.current = onDirtyChange
  const [people, setPeople] = useState<KnowledgeItemPage | null>(null)
  const [query, setQuery] = useState(''), [submittedQuery, setSubmittedQuery] = useState(''), [offset, setOffset] = useState(0)
  const names = useRef(new Map<string, string>()), syncRef = useRef(false), needsRead = useRef(true)
  const snapshotRef = useRef(snapshot), bookRevisionRef = useRef(book.book.revision), editorRef = useRef<HTMLFormElement>(null)
  const fileInput = useRef<HTMLInputElement>(null), imageAttempt = useRef<string | null>(null), editTrigger = useRef<HTMLButtonElement>(null)
  bookRevisionRef.current = book.book.revision
  const tool = useToolSession({ api, disabled, onDirtyChange: (value) => {
    mediaGuard.current = value; dirtyCallback.current(value || generationRef.current.dirty || generationRef.current.locked)
  }, onUnknown, isProtected: () => syncRef.current })
  const readonly = Boolean(book.book.archivedAt || snapshot?.archived)
  const externalChange = Boolean(snapshot && book.book.revision > snapshot.bookRevision)
  const requiresUpgrade = Boolean(snapshot && snapshot.schemaVersion < requiredSchema)
  const awaitingInitial = !sceneMode && Boolean(initialGeneration.current)
  const blocked = tool.locked || syncRequired || readonly || externalChange || !snapshot || requiresUpgrade || !!generator || awaitingInitial
  const navigationBlocked = tool.locked || tool.dirty || syncRequired || !!generator || awaitingInitial
  const budgetFull = Boolean(snapshot && (snapshot.items.length >= MAX_BOOK_MEDIA_ITEMS || snapshot.totalBytes >= MAX_BOOK_MEDIA_BYTES))
  const draftFits = Boolean(snapshot && snapshot.items.length < MAX_BOOK_MEDIA_ITEMS && snapshot.totalBytes + draftBytes <= MAX_BOOK_MEDIA_BYTES)
  const selected = snapshot?.items.find((item) => item.id === selectedId)
  const covers = snapshot?.items.filter((item) => item.kind === 'cover') ?? []
  const items = snapshot?.items.filter((item) => {
    if (sceneMode) return item.kind === 'scene' && item.placeId === scenePlaceId
    if (item.kind !== 'portrait' || (personFilter && item.personId !== personFilter)) return false
    const person = snapshot.people.find((entry) => entry.id === item.personId)
    return roleFilter === 'all' || (roleFilter === 'viewpoint' ? person?.isViewpoint : roleFilter === 'review' ? person?.needsReview : person && !person.isViewpoint && !person.needsReview)
  }) ?? []
  const portraitStart = Math.min(portraitOffset, Math.max(0, Math.floor((items.length - 1) / 6) * 6))
  const coverStart = Math.min(coverOffset, Math.max(0, Math.floor((covers.length - 1) / 3) * 3))
  const cover = selected?.kind === 'cover' ? selected : covers[0]
  const selectedPerson = snapshot?.people.find((person) => person.id === selected?.personId)
  const pendingGeneration = generationPage?.runs.find((run) => run.state !== 'saved')
  const selectedSource = generationPage?.runs.find((run) => run.state === 'saved' && run.mediaId === selected?.id && run.sha256 === selected?.sha256)
  const leave = usePanelLeave({
    register: registerLeaveGuard,
    blockedReason: () => tool.locked || syncRef.current || generationRef.current.locked || !sceneMode && initialGeneration.current ? '图片操作尚未结束或回执待核对，请在当前面板处理后再离开。' : null,
    hasChanges: () => tool.hasChanges() || generationRef.current.dirty,
    onBlocked: tool.setError,
    onDiscard: () => { clearDraft(); setGenerator(null) },
  })
  const currentIds = new Set<string>()
  const owners = new Set<string>()
  for (const item of snapshot?.items ?? []) {
    const owner = item.kind === 'cover' ? 'cover' : item.kind === 'scene' ? `scene:${item.placeId}` : `portrait:${item.personId}`
    if (!owners.has(owner)) { currentIds.add(item.id); owners.add(owner) }
  }
  // 每个入口只显示自己的忙态；原请求锁和版本核对仍由 tool 管理。
  async function perform<T>(next: MediaOperation, action: () => Promise<T>): Promise<T | undefined> {
    if (!mounted.current || operationRef.current) return
    operationRef.current = next; setOperation(next)
    try { return await action() }
    finally { operationRef.current = null; if (mounted.current) setOperation(null) }
  }
  const processing = (next: MediaOperation) => tool.busy && operation === next
  function rememberFocus() { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }
  function restoreFocus() {
    requestAnimationFrame(() => {
      const target = returnFocus.current?.isConnected ? returnFocus.current : editTrigger.current
      if (target && !target.matches(':disabled')) target.focus({ preventScroll: true })
    })
  }
  function receive(value: BookMediaSnapshot) {
    snapshotRef.current = value; setSnapshot(value)
    for (const person of value.people) names.current.set(person.id, person.name)
    const scoped = value.items.filter((item) => sceneMode ? item.kind === 'scene' && item.placeId === scenePlaceId : item.kind !== 'scene')
    setSelectedId((previous) => scoped.some((item) => item.id === previous) ? previous : scoped.find((item) => item.kind !== 'cover')?.id ?? (sceneMode ? null : value.activeCoverId))
  }
  useEffect(() => {
    mounted.current = true; setReadingGenerations(false)
    return () => { mounted.current = false; lifetime.current += 1; generationRead.current = null; needsRead.current = true }
  }, [])
  useEffect(() => { if (!disabled && needsRead.current) { needsRead.current = false; void reload() } }, [disabled])
  useEffect(() => { setRecoveryPreserved(false) }, [tool.pending, draft])
  useEffect(() => { if (draft) { editorRef.current?.scrollIntoView({ block: 'nearest' }); editorRef.current?.focus({ preventScroll: true }) } }, [draft?.id])
  useEffect(() => {
    if (selected && !draft && !generator && !initialGeneration.current && !tool.locked && imageAttempt.current !== selected.id) {
      imageAttempt.current = selected.id
      void view(selected)
    }
  }, [selected, draft, generator, tool.locked])

  async function reload() {
    if (!mounted.current) return
    if (tool.hasChanges() || tool.hasPending() || generationRef.current.dirty || generationRef.current.locked) { tool.setError('请先保存、放弃当前输入或核对原请求，再刷新图片资料。'); return }
    const epoch = lifetime.current
    await perform('reload', () => tool.read(async () => {
      const catalog = await api.getBook({ bookId })
      if (!catalog.ok) return catalog
      const media = await api.getBookMedia({ bookId })
      if (!media.ok) return media
      if (!isBookMediaSnapshot(media.data, bookId) || catalog.data.book.id !== bookId || media.data.bookRevision !== catalog.data.book.revision) {
        return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '读取期间作品版本发生变化，请重新刷新。' } }
      }
      let name: string | null = null
      if (scenePlaceId) {
        const place = await api.getKnowledgeItem({ bookId, id: scenePlaceId })
        if (!place.ok) return place
        if (place.data.bookId !== bookId || place.data.id !== scenePlaceId || place.data.kind !== 'place' ||
          place.data.bookRevision !== media.data.bookRevision || typeof place.data.name !== 'string' || !place.data.name.trim()) {
          return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '地点身份、类型或作品版本发生变化，请核对后重新读取。' } }
        }
        name = place.data.name
      }
      return { ok: true as const, data: { catalog: catalog.data, media: media.data, name } }
    }, ({ catalog, media, name }) => {
      if (tool.hasChanges() || tool.hasPending() || media.bookRevision < bookRevisionRef.current || media.bookRevision < (snapshotRef.current?.bookRevision ?? 0)) throw new Error('stale media')
      receive(media); setPlaceName(name); onBookChange(catalog)
      syncRef.current = false; setSyncRequired(false); setConflict(null)
      setPeople(null)
    }))
    if (!sceneMode && mounted.current && epoch === lifetime.current) {
      const page = await refreshGenerations()
      if (mounted.current && epoch === lifetime.current && initialGeneration.current) {
        const runId = initialGeneration.current
        initialGeneration.current = undefined
        // 先结束媒体首读再打开原任务，避免生成编辑器的忙锁阻断作品版本同步。
        const initialKind = page?.runs.find((run) => run.runId === runId)?.kind ?? 'cover'
        setKind(initialKind); setGenerator({ kind: initialKind, runId })
      }
    }
  }
  function refreshGenerations(): Promise<ImageGenerationPage | undefined> {
    if (!mounted.current) return Promise.resolve(undefined)
    // 主进程串行核对图片资料；复用同次读取，避免重试入口互相触发“服务忙”。
    if (generationRead.current) return generationRead.current
    const epoch = lifetime.current
    setReadingGenerations(true)
    generationRead.current = request(() => api.listImageGenerations({ bookId })).then((result) => {
      if (!mounted.current || epoch !== lifetime.current) return
      if (!result.ok || !isImageGenerationPage(result.data, bookId)) {
        setGenerationWarning(result.ok ? '图片任务列表格式不符，请重新核对。' : result.error.message); return
      }
      setGenerationPage(result.data); setGenerationWarning(result.data.warning)
      return result.data
    }).finally(() => {
      if (!mounted.current || epoch !== lifetime.current) return
      generationRead.current = null; setReadingGenerations(false)
    })
    return generationRead.current
  }
  function generationChanged(value: typeof generationState) {
    generationRef.current = value; setGenerationState(value)
    dirtyCallback.current(mediaGuard.current || value.dirty || value.locked)
  }
  function openGenerator(next: 'cover' | 'portrait', runId?: string) {
    // 原任务核对不受作品写入条件限制，归档、旧快照和满预算仍须能恢复与取消。
    if (sceneMode || draft || (runId ? navigationBlocked : blocked || budgetFull) || !canSwitch()) return
    rememberFocus(); setGenerator({ kind: next, ...(runId ? { runId } : {}) }); tool.setError(null)
  }
  function closeGenerator() { setGenerator(null); restoreFocus(); void refreshGenerations() }
  async function useGenerated(run: ImageGenerationRun) {
    if (run.input.bookId !== bookId || run.state !== 'succeeded' || !run.image || !run.sha256 || tool.locked || !snapshot || readonly) throw new Error('当前生成结果不可采用，请先核对原任务。')
    const { dataBase64, byteLength, mime } = run.image
    if (validateBookMediaPayload(mime, dataBase64) !== byteLength) throw new Error('生成原图长度不符。')
    const bytes = Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0))
    if (await digest(bytes) !== run.sha256) throw new Error('生成原图摘要不符。')
    await decodeImage(mime, dataBase64)
    if (run.input.personId) {
      const person = await request(() => api.getKnowledgeItem({ bookId, id: run.input.personId! }))
      if (!person.ok) throw new Error(person.error.message)
      if (person.data.bookId !== bookId || person.data.id !== run.input.personId || person.data.kind !== 'person' || !person.data.name.trim()) throw new Error('生成后关联人物已变化，请保留原任务并核对人物资料。')
      names.current.set(person.data.id, person.data.name)
    }
    // 仍使用生成时的作品基线；有并发改动时必须明确比较，不能静默换成当前版本。
    setDraft({ bookId, id: run.input.mediaId, expectedBookRevision: run.input.expectedBookRevision, fields: {
      kind: run.input.kind, personId: run.input.personId, title: run.input.title, alt: '', mime, dataBase64,
    } })
    setDraftHash(run.sha256); setDraftBytes(byteLength); setDraftDecoded(false); setConflict(null); setDiscard(false)
    tool.setDirty(true); setGenerator(null); tool.setNotice(run.jpegSource ? 'JPEG 入库副本已读入，原图保留在任务文件；请核对人物、名称、预算和作品版本后保存。' : '生成原图已读入；请核对人物、名称、预算和作品版本后保存。')
    await refreshGenerations()
  }
  function canSwitch(): boolean {
    if (!tool.canLeave() || syncRef.current || generationRef.current.dirty || generationRef.current.locked) { tool.setError('请先处理未保存的图片或原请求，再切换资料。'); return false }
    return true
  }
  function switchKind(next: BookMediaKind) {
    if (!canSwitch()) return
    setKind(next); tool.setError(null)
    const target = snapshot?.items.find((item) => item.kind === next)
    if (target) void view(target)
    else {
      // 空分类不能沿用另一用途的详情；清除读取标记，后续刷新仍可重读原资源。
      setSelectedId(null); setImage(null); setImageDecoded(false); imageAttempt.current = null
    }
  }
  async function view(item: BookMediaMetadata) {
    if (!canSwitch()) return
    if (sceneMode ? item.kind !== 'scene' || item.placeId !== scenePlaceId : item.kind === 'scene') return
    imageAttempt.current = item.id
    setKind(item.kind); setSelectedId(item.id); setImage(null); setImageDecoded(false)
    await perform('image', () => tool.read(async () => {
      const result = await api.readBookMedia({ bookId, id: item.id })
      if (!result.ok) return result
      if (!isBookMediaImage(result.data, bookId, item.id) || !sameFields(result.data, item)) {
        return { ok: false as const, error: { code: 'STORAGE_ERROR' as const, message: '原图回执与所选记录不一致，请重新读取。' } }
      }
      const bytes = Uint8Array.from(atob(result.data.dataBase64), (char) => char.charCodeAt(0))
      if (await digest(bytes) !== item.sha256) return { ok: false as const, error: { code: 'STORAGE_ERROR' as const, message: '原图摘要不匹配，已停止显示，请保留作品数据并检查恢复包。' } }
      return result
    }, setImage))
  }
  function chooseFile(next: BookMediaKind) {
    if (blocked || draft || budgetFull || !canSwitch()) return
    rememberFocus(); setKind(next)
    fileInput.current?.click()
  }
  async function pickFile(file: File) {
    if (blocked || draft || !snapshot || !canSwitch()) return
    const baseline = snapshot.bookRevision, selectedKind = kind
    await perform('file', () => tool.read(async () => {
      try {
        if (!BOOK_MEDIA_MIMES.includes(file.type as BookMediaMime) || !/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('请选择本地 PNG、JPEG 或 WebP 图片。')
        if (!file.size || file.size > MAX_BOOK_MEDIA_ITEM_BYTES) throw new Error('单张原图必须大于 0 字节且不超过 2 MiB。')
        if (snapshot.items.length >= MAX_BOOK_MEDIA_ITEMS || snapshot.totalBytes + file.size > MAX_BOOK_MEDIA_BYTES) throw new Error('加入这张图会超过本书 100 张 / 64 MiB 原图预算。')
        const bytes = new Uint8Array(await file.arrayBuffer()), mime = file.type as BookMediaMime, dataBase64 = encode(bytes)
        if (bytes.byteLength !== file.size || validateBookMediaPayload(mime, dataBase64) !== file.size) throw new Error('文件读取长度与声明不一致。')
        try { await decodeImage(mime, dataBase64) } catch { throw new Error('文件签名可识别，但原图解码失败或超时，请选择有效图片。') }
        return { ok: true as const, data: { dataBase64, mime, sha256: await digest(bytes), byteLength: file.size } }
      } catch (error) {
        return { ok: false as const, error: { code: 'INVALID_INPUT' as const, message: error instanceof Error ? error.message : '图片读取失败，请重新选择。' } }
      }
    }, (value) => {
      setDraft({ bookId, expectedBookRevision: baseline, id: crypto.randomUUID(), fields: { kind: selectedKind,
        personId: selectedKind === 'portrait' && personFilter ? personFilter : null,
        ...(sceneMode ? { placeId: scenePlaceId } : {}),
        title: file.name.replace(/\.[^.]+$/, '').slice(0, 120) || '未命名图片', alt: '', mime: value.mime, dataBase64: value.dataBase64 } })
      setDraftHash(value.sha256); setDraftBytes(value.byteLength); setDraftDecoded(false); setConflict(null); setDiscard(false); tool.setDirty(true)
      tool.setNotice(sceneMode ? '场景图已读入，核对地点、名称和备注后保存到本书。' : '图片已读入，填写名称、人物关联和备注后保存到本书。')
    }))
  }
  function reuseImage() {
    if (blocked || !image || !imageDecoded || !snapshot || !canSwitch()) return
    if (snapshot.items.length >= MAX_BOOK_MEDIA_ITEMS || snapshot.totalBytes + image.byteLength > MAX_BOOK_MEDIA_BYTES) { tool.setError('追加此图会超过本书容量；旧资产仍保留。'); return }
    rememberFocus(); setDraft({ bookId, expectedBookRevision: snapshot.bookRevision, id: crypto.randomUUID(), fields: { kind: image.kind, personId: image.personId,
      ...(image.kind === 'scene' ? { placeId: image.placeId } : {}),
      title: image.title, alt: image.alt, mime: image.mime, dataBase64: image.dataBase64 } })
    setDraftHash(image.sha256); setDraftBytes(image.byteLength); setDraftDecoded(false); setConflict(null); setDiscard(false); tool.setDirty(true)
    tool.setNotice('将追加一张新资产。保存后会成为所选用途的当前图片，旧资产继续保留并计入预算。')
  }
  function change(fields: Partial<BookMediaFields>) {
    if (!draft || tool.locked || syncRef.current || readonly) return
    setDraft({ ...draft, fields: { ...draft.fields, ...fields } }); setDiscard(false); setConflict(null); tool.setDirty(true); tool.setNotice(null)
  }
  function dropDraft() {
    if (tool.locked || syncRef.current) return
    if (tool.hasChanges() && !discard) { setDiscard(true); return }
    clearDraft()
  }
  function clearDraft() {
    setDraft(null); setDraftHash(''); setDraftBytes(0); setDiscard(false); setConflict(null); tool.setDirty(false); tool.setError(null); restoreFocus()
  }
  async function searchPeople(search: string, pageOffset: number) {
    if (tool.locked || !snapshot || snapshot.requiresUpgrade) return
    await perform('people', () => tool.read(() => api.listKnowledgeItems({ bookId, kind: 'person', search, offset: pageOffset, limit: 40 }), (value) => {
      if (value.bookId !== bookId || value.bookRevision !== snapshot.bookRevision || !Array.isArray(value.items) || value.items.length > 40
        || value.items.some((person) => person.bookId !== bookId || person.kind !== 'person')) throw new Error('wrong people')
      for (const person of value.items) names.current.set(person.id, person.name)
      setPeople(value); setOffset(pageOffset); setSubmittedQuery(search)
    }))
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || blocked || !draftFits || !draftDecoded || draft.expectedBookRevision !== snapshot?.bookRevision) return
    try {
      const input = parseSaveBookMediaInput(draft), hash = draftHash, bytes = draftBytes
      const success = await perform('save', () => tool.write('book.media.save', () => api.saveBookMedia(input), (value) => {
        if (!isBookMediaSnapshot(value, bookId) || value.schemaVersion < requiredSchema) return false
        const item = value.savedMedia
        return Boolean(item && item.id === input.id && item.bookRevision === input.expectedBookRevision + 1 && item.sha256 === hash && item.byteLength === bytes
          && item.placeId === input.fields.placeId
          && sameFields(item, { kind: input.fields.kind, personId: input.fields.personId, title: input.fields.title, alt: input.fields.alt, mime: input.fields.mime }))
      }, (value) => {
        receive(value); setDraft(null); setConflict(null); setDiscard(false)
        // 新资产排在首位，解除旧筛选和页码，让刚保存的版本立即可见。
        setKind(input.fields.kind); setPersonFilter(''); setRoleFilter('all'); setPortraitOffset(0); setCoverOffset(0); setSelectedId(input.id)
        setImageDecoded(false); setImage({ ...value.savedMedia!, bookId, dataBase64: input.fields.dataBase64 })
        syncRef.current = true; setSyncRequired(true)
      }, '图片已保存到本书，旧资产继续保留。'))
      if (success) await reload()
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '图片保存前校验失败，请检查输入。') }
  }
  async function checkReceipt() { if (await perform('writeReceipt', () => tool.checkReceipt())) await reload() }
  async function compareLatest() {
    if (!draft || tool.locked || syncRef.current) return
    await perform('compare', () => tool.read(async () => {
      const media = await api.getBookMedia({ bookId })
      if (!media.ok) return media
      if (!isBookMediaSnapshot(media.data, bookId)) throw new Error('invalid media')
      let name: string | null = null
      if (scenePlaceId) {
        const place = await api.getKnowledgeItem({ bookId, id: scenePlaceId })
        if (!place.ok) return place
        if (place.data.bookId !== bookId || place.data.id !== scenePlaceId || place.data.kind !== 'place' ||
          place.data.bookRevision !== media.data.bookRevision || typeof place.data.name !== 'string' || !place.data.name.trim()) throw new Error('wrong place')
        name = place.data.name
      }
      return { ok: true as const, data: { media: media.data, name } }
    }, ({ media, name }) => {
      if (media.bookRevision < bookRevisionRef.current || media.bookRevision < draft.expectedBookRevision) throw new Error('stale snapshot')
      setConflict(media); setConflictPlaceName(name); tool.setNotice('最新图片列表已读取，当前图片和备注仍保留；请核对后明确沿用输入。')
    }))
  }
  function rebase() {
    if (!draft || !conflict || tool.locked || conflict.archived || conflict.schemaVersion < requiredSchema || conflict.bookRevision < bookRevisionRef.current) return
    if (conflict.items.some((item) => item.id === draft.id)) { tool.setError('本次素材 ID 已存在，请核对原请求或进入恢复流程，不能覆盖已有图片。'); return }
    setDraft({ ...draft, expectedBookRevision: conflict.bookRevision }); receive(conflict); setConflict(null); setPeople(null)
    if (sceneMode) setPlaceName(conflictPlaceName)
    tool.setDirty(true); tool.setError(null); tool.setNotice(sceneMode ? '已沿用场景图与备注；请核对最新地点、容量后再次保存。' : '已沿用当前图片与备注；请核对容量和人物关联后再次保存。')
  }
  async function upgrade() {
    if (!snapshot || readonly || !canSwitch()) return
    const expectedBookRevision = snapshot.bookRevision
    const success = await perform('upgrade', () => tool.write('knowledge.upgrade', () => api.upgradeKnowledge({ bookId, expectedBookRevision }),
      (value) => value.bookId === bookId && value.schemaVersion >= requiredSchema && !value.requiresUpgrade && value.bookRevision >= expectedBookRevision,
      () => { syncRef.current = true; setSyncRequired(true) }, '作品备份和升级已确认。'))
    if (success) await reload()
  }
  async function copyDraft() {
    if (!draft) return
    try { await navigator.clipboard.writeText(JSON.stringify(draft)); tool.setNotice('已复制完整素材请求，包含原图内容、ID 和版本。请粘贴留存后再进行恢复。') }
    catch { tool.setError('无法复制，请保留当前面板和原图文件，稍后重试。') }
  }
  async function exportImage() {
    if (!selected || !image || image.id !== selected.id || !imageDecoded || !canSwitch()) return
    const fixed = selected
    let receipt: BookMediaExportReceipt | null = null
    const success = await perform('export', () => tool.write('book.media.export', () => api.exportBookMedia({ bookId, id: fixed.id, expectedSha256: fixed.sha256, mime: fixed.mime }),
      (value) => value === null || Boolean(value && value.bookId === bookId && value.id === fixed.id && value.sha256 === fixed.sha256
        && value.bytes === fixed.byteLength && typeof value.filePath === 'string' && value.filePath.length > 0),
      (value) => { receipt = value }, '导出操作已结束。'))
    if (success) tool.setNotice(receipt ? `原图已导出：${(receipt as BookMediaExportReceipt).filePath}` : '已取消导出。')
  }
  function personName(id: string | null): string { return snapshot?.people.find((person) => person.id === id)?.name ?? (id ? names.current.get(id) ?? '人物资料待刷新' : book.book.title) }
  const uploadReason = readonly ? '作品已归档，图片资料仅供查看' : budgetFull ? '本书图片预算已用满' : draft ? '请先处理当前未保存图片' : blocked ? '请先完成资料读取或核对当前请求' : undefined
  const exporting = tool.pending?.command === 'book.media.export'
  const generationEditor = generator && <ImageGenerationEditor api={api} bookId={bookId} bookRevision={snapshot?.bookRevision ?? book.book.revision}
    initialKind={generator.kind} initialRunId={generator.runId} disabled={tool.locked || syncRequired}
    readOnly={readonly || !snapshot || requiresUpgrade} onStateChange={generationChanged} onUse={useGenerated} onClose={closeGenerator} />

  return <section className={styles.panel} aria-label={sceneMode ? '地点场景图' : '封面与人物立绘'} aria-busy={tool.busy || awaitingInitial}>
    <header className={styles.heading} data-scene={sceneMode}>
      <h2>{sceneMode ? `${placeName ?? '地点'} · 场景图` : '封面与人物立绘'}</h2>
      {!sceneMode && <div className={styles.switcher} role="group" aria-label="图片用途">
        <button type="button" disabled={navigationBlocked} aria-pressed={kind === 'cover'} onClick={() => switchKind('cover')}>封面</button>
        <button type="button" disabled={navigationBlocked} aria-pressed={kind === 'portrait'} onClick={() => switchKind('portrait')}>立绘</button>
      </div>}
      <div className={styles.headerActions}><button type="button" className={styles.iconButton} aria-label={processing('reload') ? '正在读取图片资料' : syncRequired ? '重试同步图片资料' : '刷新图片资料'} aria-busy={processing('reload')}
        title={tool.dirty ? '请先保存或明确放弃当前输入' : syncRequired ? '重试同步图片资料' : '刷新图片资料'} disabled={tool.locked || tool.dirty || !!generator || awaitingInitial} onClick={() => void reload()}><StudioIcon name="refresh" size={20} /></button>
        {onClose && <button type="button" className={styles.button} disabled={tool.locked || generationState.locked || awaitingInitial} onClick={onClose}><StudioIcon name="arrow" style={{ transform: 'rotate(180deg)' }} />返回</button>}</div>
    </header>
    {awaitingInitial && <p className={styles.muted} role="status">正在读取原图片任务的资料…</p>}
    <input ref={fileInput} className={styles.fileInput} type="file" aria-label="添加本地图片" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
      disabled={blocked || !!draft || budgetFull} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void pickFile(file) }} />
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
    {tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {!sceneMode && generationWarning && <div className={styles.warning} role="alert"><p>{generationWarning}</p>
      <button type="button" className={styles.button} disabled={navigationBlocked || readingGenerations} aria-busy={readingGenerations} onClick={() => void refreshGenerations()}>{readingGenerations ? '正在核对图片任务…' : '重新核对图片任务'}</button></div>}
    {!sceneMode && pendingGeneration && !generator && <div className={styles.notice}><p>本书有一份待处理的{pendingGeneration.kind === 'cover' ? '封面' : '立绘'}生成任务：{pendingGeneration.title}。</p>
      <button type="button" className={styles.button} disabled={navigationBlocked || !!draft} onClick={() => openGenerator(pendingGeneration.kind, pendingGeneration.runId)}>恢复原任务</button></div>}
    {tool.readFailure?.requestId && <div className={styles.warning}><p>图片资料读取尚待核对，当前输入仍保留。</p>
      <button type="button" className={styles.button} disabled={tool.locked} aria-busy={processing('readReceipt')} onClick={() => void perform('readReceipt', () => tool.checkReadReceipt())}>{processing('readReceipt') ? '正在核对原读取…' : '核对原读取'}</button></div>}
    {tool.pending && <div className={styles.warning}><p>{exporting ? '导出结果尚未确认，请核对原请求和所选文件；确认前暂停再次导出。' : '保存结果尚未确认，原图与输入已保留。核对原请求前暂停修改和切换。'}</p>
      {tool.pending.error.requestId ? <button type="button" className={styles.button} disabled={tool.busy} aria-busy={processing('writeReceipt')} onClick={() => void checkReceipt()}>{processing('writeReceipt') ? '正在核对原请求…' : '核对原请求'}</button> : <p>没有可查询的请求编号，请留存输入后通过主窗口恢复。</p>}
      {draft && <button type="button" className={styles.button} onClick={() => void copyDraft()}>复制完整素材请求以留存</button>}
      {onRecover && <><label className={styles.check}><input type="checkbox" checked={recoveryPreserved} onChange={(event) => setRecoveryPreserved(event.target.checked)} />我已留存原图和当前输入，可以离开本面板恢复</label>
        <button type="button" className={styles.button} disabled={tool.busy || !recoveryPreserved} onClick={onRecover}>打开主窗口恢复</button></>}
    </div>}
    {syncRequired && <p className={styles.warning}>图片写入已确认，等待作品目录同步；失败时可点“重试同步”。</p>}
    {externalChange && <p className={styles.warning}>作品已有新版本，当前输入仍保留。请先核对最新资料再保存。</p>}
    {readonly && <p className={styles.warning}>作品已归档，图片资料仅供查看。</p>}
    {(!snapshot || requiresUpgrade) && generationEditor}
    {!snapshot ? <p role="status" className={styles.empty}>{tool.busy ? '正在读取图片元信息…' : '尚未读取图片资料，请点击“刷新资料”重试。'}</p>
      : requiresUpgrade ? <div className={styles.empty}><h4>{sceneMode ? '启用地点场景图' : '启用本书图片资料'}</h4><p>{sceneMode ? '先备份并升级作品格式，再为地点保存场景图。原封面、立绘和旧版本继续保留。' : '先备份并升级作品格式，再保存封面与人物立绘。'}</p>
        <button type="button" className={styles.primaryButton} disabled={tool.locked || readonly} aria-busy={processing('upgrade')} onClick={() => void upgrade()}>{processing('upgrade') ? '正在备份并升级…' : '备份并升级作品'}</button></div>
        : <>
          {budgetFull && <p className={styles.warning}>本书图片预算已用满，仍可查看全部旧资产。</p>}
          <div className={styles.layout} data-scene={sceneMode}>
            {!sceneMode && <section className={styles.coverPane} aria-label="作品封面">
              <h3 className={styles.paneHeading}><StudioIcon name="spark" size={20} />作品封面</h3>
              <button type="button" className={styles.coverHero} disabled={!cover || navigationBlocked} aria-label={cover ? `查看封面：${cover.title}` : '尚未设置封面'}
                title={cover?.title ?? '请添加本地封面'} onClick={() => cover && void view(cover)}>
                <SavedMediaImage api={api} bookId={bookId} metadata={cover} name={cover?.title ?? book.book.title} className={styles.coverImage}
                  fallback={<span className={styles.coverFallback}><StudioIcon name="books" size={48} /><strong>{book.book.title}</strong><small>{cover ? '正在读取封面…' : '尚未设置封面'}</small></span>} />
                {cover && <span className={styles.coverBadge}>{currentIds.has(cover.id) ? '当前封面' : '历史版本'} · v{cover.bookRevision}</span>}
              </button>
              <div className={styles.coverVersions} aria-label="封面版本">
                {covers.slice(coverStart, coverStart + 3).map((item) => <button type="button" key={item.id} className={styles.version}
                  disabled={navigationBlocked} aria-pressed={cover?.id === item.id} aria-label={`封面版本 v${item.bookRevision}：${item.title}`} title={item.title} onClick={() => void view(item)}>
                  <SavedMediaImage api={api} bookId={bookId} metadata={item} name={item.title} className={styles.versionImage}
                    fallback={<StudioIcon name="image" size={24} />} /><span>v{item.bookRevision}</span>
                </button>)}
              </div>
              {covers.length > 3 && <div className={styles.pagination}><button type="button" className={styles.iconButton} disabled={navigationBlocked || coverStart === 0} aria-label="上一页封面版本" title="上一页封面版本" onClick={() => setCoverOffset(Math.max(0, coverStart - 3))}><StudioIcon name="chevron" style={{ transform: 'rotate(180deg)' }} /></button>
                <span>{coverStart + 1}–{Math.min(coverStart + 3, covers.length)} / {covers.length}</span>
                <button type="button" className={styles.iconButton} disabled={navigationBlocked || coverStart + 3 >= covers.length} aria-label="下一页封面版本" title="下一页封面版本" onClick={() => setCoverOffset(coverStart + 3)}><StudioIcon name="chevron" /></button></div>}
              <div className={styles.coverActions}><button type="button" className={styles.button} disabled={blocked || !!draft || budgetFull} title={uploadReason} onClick={() => chooseFile('cover')}><StudioIcon name="refresh" />{cover ? '更换封面' : '添加封面'}</button>
                <button type="button" className={styles.goldButton} disabled={blocked || !!draft || budgetFull} title={uploadReason} onClick={() => openGenerator('cover', pendingGeneration?.runId)}><StudioIcon name="spark" />生成封面</button></div>
            </section>}
            <section className={styles.galleryPane} aria-label={sceneMode ? '地点场景版本' : '人物立绘'}>
              <div className={styles.galleryHeading}><h3 className={styles.paneHeading}><StudioIcon name="spark" size={20} />{sceneMode ? '地点场景版本' : '人物立绘'} <small>{items.length}</small></h3>
                {!sceneMode && <details className={styles.filterMenu}><summary aria-label={personFilter || roleFilter !== 'all' ? '筛选人物立绘，当前已筛选' : '筛选人物立绘'} title="筛选人物立绘"><StudioIcon name="settings" size={16} /><span>{personFilter || roleFilter !== 'all' ? '已筛选' : '筛选'}</span></summary>
                  <div className={styles.galleryFilters}><label>角色范围<select value={roleFilter} disabled={navigationBlocked} onChange={(event) => { if (canSwitch()) { setRoleFilter(event.target.value); setPortraitOffset(0) } }}>
                    <option value="all">全部角色</option><option value="viewpoint">主视角</option><option value="person">其他人物</option><option value="review">待确认</option></select></label>
                    <label>关联人物<select value={personFilter} disabled={navigationBlocked} onChange={(event) => { if (canSwitch()) { setPersonFilter(event.target.value); setPortraitOffset(0) } }}>
                      <option value="">全部人物</option>{snapshot.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label></div>
                </details>}
                {!sceneMode && <button type="button" className={styles.iconButton} disabled={blocked || !!draft || budgetFull} aria-label="生成人物立绘" title={uploadReason ?? '生成人物立绘'} onClick={() => openGenerator('portrait', pendingGeneration?.runId)}><StudioIcon name="spark" size={20} /></button>}
                <button type="button" className={styles.iconButton} disabled={blocked || !!draft || budgetFull} aria-label={sceneMode ? '添加地点场景图' : '添加人物立绘'} title={uploadReason ?? (sceneMode ? '添加地点场景图' : '添加人物立绘')} onClick={() => chooseFile(sceneMode ? 'scene' : 'portrait')}><StudioIcon name="plus" size={20} /></button></div>
              {items.length ? <ul className={styles.items}>{items.slice(portraitStart, portraitStart + 6).map((item) => {
                const person = snapshot.people.find((entry) => entry.id === item.personId)
                return <li key={item.id}><button type="button" className={styles.item} disabled={navigationBlocked} aria-pressed={selectedId === item.id}
                  aria-label={`${sceneMode ? '场景' : '立绘'}：${sceneMode ? placeName : personName(item.personId)} · ${item.title} · v${item.bookRevision}`} onClick={() => void view(item)}>
                  <SavedMediaImage api={api} bookId={bookId} metadata={item} name={item.title} className={styles.portraitImage}
                    fallback={<span className={styles.portraitFallback}><StudioIcon name={sceneMode ? 'image' : 'user'} size={40} /><small>{sceneMode ? '读取场景' : '读取立绘'}</small></span>} />
                  {!sceneMode && <span className={styles.roleTag} data-tone={person?.needsReview ? 'review' : person?.isViewpoint ? 'viewpoint' : 'person'}>{person?.needsReview ? '待确认' : person?.isViewpoint ? '主视角' : '其他人物'}</span>}
                  <span className={styles.itemFooter}><strong title={sceneMode ? item.title : personName(item.personId)}>{sceneMode ? item.title : personName(item.personId)}</strong><small data-current={currentIds.has(item.id)}>{sceneMode ? `v${item.bookRevision} · ` : ''}{currentIds.has(item.id) ? '当前使用' : '未使用'}</small></span>
                </button></li>
              })}</ul> : <div className={styles.galleryEmpty}><StudioIcon name="image" size={36} /><h4>{sceneMode ? '尚未添加地点场景图' : personFilter || roleFilter !== 'all' ? '没有符合筛选的立绘' : '尚未添加人物立绘'}</h4>
                <button type="button" className={styles.primaryButton} disabled={blocked || !!draft || budgetFull} title={uploadReason} onClick={() => chooseFile(sceneMode ? 'scene' : 'portrait')}><StudioIcon name="plus" />{sceneMode ? '添加场景图' : '添加立绘'}</button>
                {!sceneMode && onPerson && <button type="button" className={styles.button} disabled={navigationBlocked} onClick={() => { if (canSwitch()) onPerson() }}>管理人物</button>}</div>}
              {items.length > 6 && <div className={styles.pagination}><button type="button" className={styles.iconButton} disabled={navigationBlocked || portraitStart === 0} aria-label={sceneMode ? '上一页场景版本' : '上一页立绘'} title={sceneMode ? '上一页场景版本' : '上一页立绘'} onClick={() => setPortraitOffset(Math.max(0, portraitStart - 6))}><StudioIcon name="chevron" style={{ transform: 'rotate(180deg)' }} /></button>
                <span>{portraitStart + 1}–{Math.min(portraitStart + 6, items.length)} / {items.length}</span>
                <button type="button" className={styles.iconButton} disabled={navigationBlocked || portraitStart + 6 >= items.length} aria-label={sceneMode ? '下一页场景版本' : '下一页立绘'} title={sceneMode ? '下一页场景版本' : '下一页立绘'} onClick={() => setPortraitOffset(portraitStart + 6)}><StudioIcon name="chevron" /></button></div>}
            </section>
            <aside className={styles.detail} aria-label={draft ? '编辑图片资料' : sceneMode ? '场景详情' : selected?.kind === 'cover' ? '封面详情' : '立绘详情'}>
              <h3 className={styles.paneHeading}><StudioIcon name="spark" size={20} />{generator ? '图片生成' : draft ? '编辑图片' : sceneMode ? '场景详情' : selected?.kind === 'cover' ? '封面详情' : '立绘详情'}</h3>
              <div className={styles.detailContent}>
              {generator ? generationEditor
                : draft ? <form ref={editorRef} tabIndex={-1} className={styles.editor} onSubmit={(event) => void save(event)}>
      <h4>保存新图片</h4><p className={styles.muted}>本次 {sizeLabel(draftBytes)}；保存后 {snapshot ? `${snapshot.items.length + 1} / 100 张 · ${sizeLabel(snapshot.totalBytes + draftBytes)} / 64 MiB` : '等待读取预算'}。</p>
      <MediaPreview key={draft.id} fields={draft.fields} onDecoded={setDraftDecoded} />
      <fieldset disabled={tool.locked || syncRequired || readonly} className={styles.fields}>
        {sceneMode ? <p>关联地点：{placeName ?? scenePlaceId}</p> : <label>图片用途<select value={draft.fields.kind} onChange={(event) => { const next = event.target.value as BookMediaKind; change({ kind: next, personId: null }) }}>
          <option value="cover">本书封面</option><option value="portrait">人物立绘</option></select></label>}
        {draft.fields.kind === 'portrait' && <div className={styles.people}><div className={styles.search}><label>查找已有的人物<input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} /></label>
          <button type="button" className={styles.button} disabled={tool.locked} aria-busy={processing('people')} onClick={() => void searchPeople(query.trim(), 0)}>{processing('people') ? '正在查找人物…' : '查找人物'}</button></div>
          <label>关联人物<select value={draft.fields.personId ?? ''} required onChange={(event) => change({ personId: event.target.value || null })}>
            <option value="">请选择本书已有的人物</option>
            {draft.fields.personId && !people?.items.some((person) => person.id === draft.fields.personId) && <option value={draft.fields.personId}>{names.current.get(draft.fields.personId) ?? draft.fields.personId}</option>}
            {people?.items.map((person) => <option value={person.id} key={person.id}>{person.name} · {person.id}</option>)}
          </select></label>
          {people ? <><p className={styles.muted}>符合条件的人物共 {people.total} 位；关联保存稳定 ID，同名人物不会自动合并。</p>
            <div className={styles.actions}><button type="button" className={styles.button} disabled={offset === 0} onClick={() => void searchPeople(submittedQuery, Math.max(0, offset - 40))}>上一页人物</button>
              <button type="button" className={styles.button} disabled={people.nextOffset === null} onClick={() => void searchPeople(submittedQuery, people.nextOffset!)}>下一页人物</button></div></>
            : <p className={styles.muted}>点“查找人物”读取候选。若还没有人物，请先留存或放弃当前输入，再到设定资料中创建。</p>}
        </div>}
        <label>图片名称<input required maxLength={120} value={draft.fields.title} onChange={(event) => change({ title: event.target.value })} /></label>
        <label>备注 / 替代文本<textarea rows={5} maxLength={2000} value={draft.fields.alt} onChange={(event) => change({ alt: event.target.value })} /></label>
        <p className={styles.muted}>{sceneMode ? '保存后，这张图成为该地点的当前场景；旧场景版本继续保留。' : '保存后，这张图成为本书封面或所选人物的当前立绘。'}</p>
      </fieldset>
      {!draftFits && <p className={styles.error} role="alert">本次保存会超过图片预算，请放弃本次输入或选择更小的原图。</p>}
      {draft.expectedBookRevision !== snapshot.bookRevision && <p className={styles.warning}>当前输入基于作品 v{draft.expectedBookRevision}，列表为 v{snapshot.bookRevision}；请先保留输入、读取并比较最新版本。</p>}
      <div className={styles.actions}><button type="submit" className={styles.primaryButton} aria-busy={processing('save')} disabled={blocked || !draftFits || !draftDecoded || draft.expectedBookRevision !== snapshot.bookRevision || (draft.fields.kind === 'portrait' && !draft.fields.personId)}>{processing('save') ? '正在保存图片…' : '保存到本书'}</button>
        <button type="button" className={styles.button} disabled={tool.locked || syncRequired} onClick={dropDraft}>{discard ? '确认放弃本次输入' : '放弃本次输入'}</button>
        <button type="button" className={styles.button} disabled={tool.locked || syncRequired} aria-busy={processing('compare')} onClick={() => void compareLatest()}>{processing('compare') ? '正在读取最新版本…' : '保留输入，读取最新版本'}</button>
        <button type="button" className={styles.button} onClick={() => void copyDraft()}>复制当前素材请求</button></div>
      {discard && <p className={styles.warning}>再次点击确认将放弃未保存的图片和备注；已存入本书的资产继续保留。</p>}
      {conflict && <div className={styles.comparison}><p>当前输入基于作品 v{draft.expectedBookRevision}，最新为 v{conflict.bookRevision}；已有 {conflict.items.length} 张、{sizeLabel(conflict.totalBytes)}。</p>
        {sceneMode && <p>最新地点：{conflictPlaceName} · {scenePlaceId}</p>}
        <p>{sceneMode ? '最新场景' : '最新封面'}：{conflict.items.find((item) => sceneMode ? item.kind === 'scene' && item.placeId === scenePlaceId : item.id === conflict.activeCoverId)?.title ?? '尚未设置'}。</p>
        <button type="button" className={styles.button} disabled={tool.locked || conflict.archived || conflict.schemaVersion < requiredSchema || conflict.items.some((item) => item.id === draft.id)} onClick={rebase}>确认沿用输入，改用最新版本</button></div>}
    </form> : selected ? <>
                {image && image.id === selected.id ? <MediaPreview key={image.id} fields={image} onDecoded={setImageDecoded} />
                  : <div className={styles.empty}><StudioIcon name="image" size={36} /><p role="status">{processing('image') ? '正在读取所选原图…' : '尚未取得原图'}</p><button type="button" className={styles.button} disabled={navigationBlocked} aria-busy={processing('image')} onClick={() => void view(selected)}>{processing('image') ? '正在读取原图…' : '重新读取原图'}</button></div>}
                <h3 className={styles.detailName}>{sceneMode ? placeName : personName(selected.personId)}</h3>
                <dl className={styles.facts}><dt>版本</dt><dd>v{selected.bookRevision} <span className={styles.muted}>{currentIds.has(selected.id) ? '当前使用' : '未使用'}</span></dd>
                  <dt>来源</dt><dd>{selectedSource ? `模型生成 · ${selectedSource.model}` : !sceneMode && (!generationPage || generationWarning) ? '来源待核对' : '未登记'}</dd></dl>
                {selectedPerson && <div className={styles.related}><h4>关联角色卡</h4><button type="button" className={styles.personLink} disabled={navigationBlocked || !onPerson} title={onPerson ? `打开${selectedPerson.name}的人物资料` : '人物资料入口不可用'}
                  onClick={() => { if (canSwitch()) onPerson?.(selectedPerson.id) }}><SavedMediaImage api={api} bookId={bookId} metadata={snapshot.items.find((item) => item.personId === selectedPerson.id)} name={selectedPerson.name} className={styles.personImage} fallback={<StudioIcon name="user" size={24} />} /><span>{selectedPerson.name}</span><StudioIcon name="chevron" /></button></div>}
                <details><summary>资源校验信息</summary><dl className={styles.facts}><dt>格式</dt><dd>{selected.mime.replace('image/', '').toUpperCase()} · {sizeLabel(selected.byteLength)}</dd>
                  <dt>保存时间</dt><dd>{new Date(selected.createdAt).toLocaleString('zh-CN')}</dd></dl><p className={styles.identity}>素材 ID：{selected.id}{selected.personId && <><br />人物 ID：{selected.personId}</>}{selected.placeId && <><br />地点 ID：{selected.placeId}</>}<br />SHA-256：{selected.sha256}</p></details>
              </> : <div className={styles.empty}><StudioIcon name="image" size={36} /><p>{sceneMode ? '选择场景版本查看详情。' : '选择封面或立绘查看详情。'}</p></div>}
              </div>
              {!draft && !generator && selected && <div className={styles.detailActions}>
                <button ref={editTrigger} type="button" className={styles.editButton} disabled={blocked || budgetFull || !imageDecoded || image?.id !== selected.id}
                  title={uploadReason ?? (!imageDecoded ? '请等待原图读取与解码' : '追加新版本，保留已有图片')} onClick={reuseImage}><StudioIcon name="pen" />{sceneMode ? '编辑场景图' : selected.kind === 'cover' ? '编辑封面' : '编辑立绘'}</button>
                <button type="button" className={styles.goldButton} disabled={navigationBlocked || !imageDecoded || image?.id !== selected.id} aria-busy={processing('export')}
                  title={!imageDecoded ? '请等待原图读取与解码' : '导出所选原图'} onClick={() => void exportImage()}><StudioIcon name="export" />{processing('export') ? '正在导出素材…' : '导出素材'}</button>
              </div>}
            </aside>
          </div>
          <footer className={styles.usage}><progress max={MAX_BOOK_MEDIA_BYTES} value={snapshot.totalBytes} aria-label="本书原图容量使用量" /><span>{snapshot.items.length} / 100 张 · {sizeLabel(snapshot.totalBytes)} / 64 MiB</span>
            <details><summary>图片预算</summary><p>PNG / JPEG / WebP · 每张 ≤ 2 MiB。旧资产继续保留并计入预算；Base64 {sizeLabel(snapshot.totalBase64Bytes)}，数据库索引与元信息另计。</p></details></footer>
        </>}
    {leave.confirming && <DialogDisplayContext.Provider value="modal"><Dialog title="离开图片资料？" onClose={leave.keepEditing} busy={tool.busy}>
      <p>图片、备注或生成提示尚未保存。返回可继续处理，明确放弃当前输入后才会离开；已落盘的生成结果仍可恢复。</p>
      <div className={styles.actions}><button type="button" className={styles.button} onClick={leave.keepEditing}>{leave.source === 'window' ? '返回保存' : '继续编辑'}</button>
        <button type="button" className={styles.button} disabled={tool.locked || syncRequired} onClick={leave.discardAndLeave}>放弃未保存输入并离开</button></div>
    </Dialog></DialogDisplayContext.Provider>}
  </section>
}
