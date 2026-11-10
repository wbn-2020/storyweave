import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DomainError, type AppError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import {
  BOOK_MEDIA_MIMES, MEDIA_SCHEMA_VERSION, MAX_BOOK_MEDIA_BYTES, MAX_BOOK_MEDIA_ITEM_BYTES, MAX_BOOK_MEDIA_ITEMS,
  isBookMediaImage, isBookMediaSnapshot, parseSaveBookMediaInput, validateBookMediaPayload,
  type BookMediaApi, type BookMediaFields, type BookMediaImage, type BookMediaKind, type BookMediaMetadata,
  type BookMediaMime, type BookMediaSnapshot, type SaveBookMediaInput,
} from '../../contracts/book-media'
import type { KnowledgeItemPage } from '../../contracts/knowledge'
import { sameFields, useToolSession } from './workbench-ui'
import styles from './BookMediaPanel.module.css'

export interface BookMediaPanelProps {
  api: StudioApi & BookMediaApi
  book: BookSnapshot
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onBookChange: (book: BookSnapshot) => void
  onUnknown?: (error: AppError) => void
  onRecover?: () => void
}

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
    <div className={styles.actions}><button type="button" className={styles.button} disabled={failed || !loaded} aria-pressed={original} onClick={() => setOriginal(!original)}>
      {original ? '适应面板' : '按原图尺寸查看'}</button></div>
    {failed ? <div className={styles.warning} role="alert"><p>原图无法解码或显示。图片记录仍保留，可以重试，或选择其他有效图片新设封面 / 立绘。</p>
      <button type="button" className={styles.button} onClick={() => { setFailed(false); setLoaded(false); setAttempt(attempt + 1) }}>重试显示</button></div>
      : <div className={styles.imageViewport} data-original={original} tabIndex={original ? 0 : undefined} aria-label={original ? '原图，可滚动查看' : undefined}>
        {!loaded && <p role="status">正在解码原图…</p>}
        <img key={attempt} className={styles.image} src={`data:${fields.mime};base64,${fields.dataBase64}`} alt={fields.alt || fields.title}
          decoding="async" onLoad={() => { setLoaded(true); onDecoded(true) }} onError={() => { setFailed(true); setLoaded(false); onDecoded(false) }} />
      </div>}
    <figcaption><strong>{fields.title}</strong>{fields.alt && <p className={styles.notes}>{fields.alt}</p>}</figcaption>
  </figure>
}

export function BookMediaPanel(props: BookMediaPanelProps) { return <MediaContent key={props.book.book.id} {...props} /> }

function MediaContent({ api, book, disabled, onDirtyChange, onBookChange, onUnknown, onRecover }: BookMediaPanelProps) {
  const bookId = book.book.id
  const [snapshot, setSnapshot] = useState<BookMediaSnapshot | null>(null)
  const [kind, setKind] = useState<BookMediaKind>('cover')
  const [personFilter, setPersonFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [image, setImage] = useState<BookMediaImage | null>(null)
  const [imageDecoded, setImageDecoded] = useState(false), [draftDecoded, setDraftDecoded] = useState(false)
  const [draft, setDraft] = useState<SaveBookMediaInput | null>(null)
  const [draftHash, setDraftHash] = useState('')
  const [draftBytes, setDraftBytes] = useState(0)
  const [discard, setDiscard] = useState(false)
  const [conflict, setConflict] = useState<BookMediaSnapshot | null>(null)
  const [syncRequired, setSyncRequired] = useState(false)
  const [recoveryPreserved, setRecoveryPreserved] = useState(false)
  const [people, setPeople] = useState<KnowledgeItemPage | null>(null)
  const [query, setQuery] = useState(''), [submittedQuery, setSubmittedQuery] = useState(''), [offset, setOffset] = useState(0)
  const names = useRef(new Map<string, string>()), syncRef = useRef(false), needsRead = useRef(true)
  const snapshotRef = useRef(snapshot), bookRevisionRef = useRef(book.book.revision), editorRef = useRef<HTMLFormElement>(null)
  bookRevisionRef.current = book.book.revision
  const tool = useToolSession({ api, disabled, onDirtyChange, onUnknown, isProtected: () => syncRef.current })
  const readonly = Boolean(book.book.archivedAt || snapshot?.archived)
  const externalChange = Boolean(snapshot && book.book.revision > snapshot.bookRevision)
  const blocked = tool.locked || syncRequired || readonly || externalChange || !snapshot || snapshot.requiresUpgrade
  const navigationBlocked = tool.locked || tool.dirty || syncRequired
  const budgetFull = Boolean(snapshot && (snapshot.items.length >= MAX_BOOK_MEDIA_ITEMS || snapshot.totalBytes >= MAX_BOOK_MEDIA_BYTES))
  const draftFits = Boolean(snapshot && snapshot.items.length < MAX_BOOK_MEDIA_ITEMS && snapshot.totalBytes + draftBytes <= MAX_BOOK_MEDIA_BYTES)
  const selected = snapshot?.items.find((item) => item.id === selectedId)
  const items = snapshot?.items.filter((item) => item.kind === kind && (!personFilter || kind === 'cover' || item.personId === personFilter)) ?? []
  const personIds = [...new Set(snapshot?.items.flatMap((item) => item.personId ? [item.personId] : []) ?? [])]
  const currentIds = new Set<string>()
  const owners = new Set<string>()
  for (const item of snapshot?.items ?? []) {
    const owner = item.kind === 'cover' ? 'cover' : item.personId!
    if (!owners.has(owner)) { currentIds.add(item.id); owners.add(owner) }
  }
  function receive(value: BookMediaSnapshot) { snapshotRef.current = value; setSnapshot(value) }
  useEffect(() => { if (!disabled && needsRead.current) { needsRead.current = false; void reload() } }, [disabled])
  useEffect(() => () => { needsRead.current = true }, [])
  useEffect(() => { setRecoveryPreserved(false) }, [tool.pending, draft])
  useEffect(() => { if (draft) { editorRef.current?.scrollIntoView({ block: 'nearest' }); editorRef.current?.focus({ preventScroll: true }) } }, [draft?.id])

  async function reload() {
    if (tool.hasChanges() || tool.hasPending()) { tool.setError('请先保存、放弃当前输入或核对原请求，再刷新图片资料。'); return }
    await tool.read(async () => {
      const catalog = await api.getBook({ bookId })
      if (!catalog.ok) return catalog
      const media = await api.getBookMedia({ bookId })
      if (!media.ok) return media
      if (!isBookMediaSnapshot(media.data, bookId) || catalog.data.book.id !== bookId || media.data.bookRevision !== catalog.data.book.revision) {
        return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '读取期间作品版本发生变化，请重新刷新。' } }
      }
      return { ok: true as const, data: { catalog: catalog.data, media: media.data } }
    }, ({ catalog, media }) => {
      if (tool.hasChanges() || tool.hasPending() || media.bookRevision < bookRevisionRef.current || media.bookRevision < (snapshotRef.current?.bookRevision ?? 0)) throw new Error('stale media')
      receive(media); onBookChange(catalog)
      syncRef.current = false; setSyncRequired(false); setConflict(null)
      setPeople(null)
    })
  }
  function canSwitch(): boolean {
    if (!tool.canLeave() || syncRef.current) { tool.setError('请先处理未保存的图片或原请求，再切换资料。'); return false }
    return true
  }
  function switchKind(next: BookMediaKind) {
    if (!canSwitch()) return
    setKind(next); setPersonFilter(''); setSelectedId(null); setImage(null); tool.setError(null)
  }
  async function view(item: BookMediaMetadata) {
    if (!canSwitch()) return
    setSelectedId(item.id); setImage(null); setImageDecoded(false)
    await tool.read(async () => {
      const result = await api.readBookMedia({ bookId, id: item.id })
      if (!result.ok) return result
      if (!isBookMediaImage(result.data, bookId, item.id) || !sameFields(result.data, item)) {
        return { ok: false as const, error: { code: 'STORAGE_ERROR' as const, message: '原图回执与所选记录不一致，请重新读取。' } }
      }
      const bytes = Uint8Array.from(atob(result.data.dataBase64), (char) => char.charCodeAt(0))
      if (await digest(bytes) !== item.sha256) return { ok: false as const, error: { code: 'STORAGE_ERROR' as const, message: '原图摘要不匹配，已停止显示，请保留作品数据并检查恢复包。' } }
      return result
    }, setImage)
  }
  async function pickFile(file: File) {
    if (blocked || draft || !snapshot || !canSwitch()) return
    const baseline = snapshot.bookRevision, selectedKind = kind
    await tool.read(async () => {
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
        title: file.name.replace(/\.[^.]+$/, '').slice(0, 120) || '未命名图片', alt: '', mime: value.mime, dataBase64: value.dataBase64 } })
      setDraftHash(value.sha256); setDraftBytes(value.byteLength); setDraftDecoded(false); setConflict(null); setDiscard(false); tool.setDirty(true)
      tool.setNotice('图片已读入，填写名称、人物关联和备注后保存到本书。')
    })
  }
  function reuseImage() {
    if (blocked || !image || !imageDecoded || !snapshot || !canSwitch()) return
    if (snapshot.items.length >= MAX_BOOK_MEDIA_ITEMS || snapshot.totalBytes + image.byteLength > MAX_BOOK_MEDIA_BYTES) { tool.setError('追加此图会超过本书容量；旧资产仍保留。'); return }
    setDraft({ bookId, expectedBookRevision: snapshot.bookRevision, id: crypto.randomUUID(), fields: { kind: image.kind, personId: image.personId,
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
    setDraft(null); setDraftHash(''); setDraftBytes(0); setDiscard(false); setConflict(null); tool.setDirty(false); tool.setError(null)
  }
  async function searchPeople(search: string, pageOffset: number) {
    if (tool.locked || !snapshot || snapshot.requiresUpgrade) return
    await tool.read(() => api.listKnowledgeItems({ bookId, kind: 'person', search, offset: pageOffset, limit: 40 }), (value) => {
      if (value.bookId !== bookId || value.bookRevision !== snapshot.bookRevision || !Array.isArray(value.items) || value.items.length > 40
        || value.items.some((person) => person.bookId !== bookId || person.kind !== 'person')) throw new Error('wrong people')
      for (const person of value.items) names.current.set(person.id, person.name)
      setPeople(value); setOffset(pageOffset); setSubmittedQuery(search)
    })
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || blocked || !draftFits || !draftDecoded || draft.expectedBookRevision !== snapshot?.bookRevision) return
    try {
      const input = parseSaveBookMediaInput(draft), hash = draftHash, bytes = draftBytes
      const success = await tool.write('book.media.save', () => api.saveBookMedia(input), (value) => {
        if (!isBookMediaSnapshot(value, bookId) || value.requiresUpgrade) return false
        const item = value.savedMedia
        return Boolean(item && item.id === input.id && item.bookRevision === input.expectedBookRevision + 1 && item.sha256 === hash && item.byteLength === bytes
          && sameFields(item, { kind: input.fields.kind, personId: input.fields.personId, title: input.fields.title, alt: input.fields.alt, mime: input.fields.mime }))
      }, (value) => {
        receive(value); setDraft(null); setConflict(null); setDiscard(false)
        setKind(input.fields.kind); setPersonFilter(''); setSelectedId(input.id)
        setImageDecoded(false); setImage({ ...value.savedMedia!, bookId, dataBase64: input.fields.dataBase64 })
        syncRef.current = true; setSyncRequired(true)
      }, '图片已保存到本书，旧资产继续保留。')
      if (success) await reload()
    } catch (error) { tool.setError(error instanceof DomainError ? error.detail.message : '图片保存前校验失败，请检查输入。') }
  }
  async function checkReceipt() { if (await tool.checkReceipt()) await reload() }
  async function compareLatest() {
    if (!draft || tool.locked || syncRef.current) return
    await tool.read(() => api.getBookMedia({ bookId }), (value) => {
      if (!isBookMediaSnapshot(value, bookId) || value.bookRevision < bookRevisionRef.current || value.bookRevision < draft.expectedBookRevision) throw new Error('stale snapshot')
      setConflict(value); tool.setNotice('最新图片列表已读取，当前图片和备注仍保留；请核对后明确沿用输入。')
    })
  }
  function rebase() {
    if (!draft || !conflict || tool.locked || conflict.archived || conflict.requiresUpgrade || conflict.bookRevision < bookRevisionRef.current) return
    if (conflict.items.some((item) => item.id === draft.id)) { tool.setError('本次素材 ID 已存在，请核对原请求或进入恢复流程，不能覆盖已有图片。'); return }
    setDraft({ ...draft, expectedBookRevision: conflict.bookRevision }); receive(conflict); setConflict(null); setPeople(null)
    tool.setDirty(true); tool.setError(null); tool.setNotice('已沿用当前图片与备注；请核对容量和人物关联后再次保存。')
  }
  async function upgrade() {
    if (!snapshot || readonly || !canSwitch()) return
    const expectedBookRevision = snapshot.bookRevision
    const success = await tool.write('knowledge.upgrade', () => api.upgradeKnowledge({ bookId, expectedBookRevision }),
      (value) => value.bookId === bookId && value.schemaVersion >= MEDIA_SCHEMA_VERSION && !value.requiresUpgrade && value.bookRevision >= expectedBookRevision,
      () => { syncRef.current = true; setSyncRequired(true) }, '作品备份和升级已确认。')
    if (success) await reload()
  }
  async function copyDraft() {
    if (!draft) return
    try { await navigator.clipboard.writeText(JSON.stringify(draft)); tool.setNotice('已复制完整素材请求，包含原图内容、ID 和版本。请粘贴留存后再进行恢复。') }
    catch { tool.setError('无法复制，请保留当前面板和原图文件，稍后重试。') }
  }

  return <section className={styles.panel} aria-label="封面与人物立绘">
    <header className={styles.heading}><div><h3>封面与人物立绘</h3><p className={styles.muted}>整理本书的本地图片，随单书恢复包一起保留。</p></div>
      <button type="button" className={styles.button} disabled={tool.locked || tool.dirty} onClick={() => void reload()}>{syncRequired ? '重试同步' : '刷新资料'}</button></header>
    <p className={styles.budget}>PNG / JPEG / WebP · 每张 ≤ 2 MiB · 每书 ≤ 100 张、原图累计 ≤ 64 MiB</p>
    <p className={styles.muted}>旧封面、旧立绘和再次使用的图片都计入预算。Base64 存储另增加约三分之一体积，数据库索引与元信息另计。</p>
    {snapshot && !snapshot.requiresUpgrade && <div className={styles.usage}><progress max={MAX_BOOK_MEDIA_BYTES} value={snapshot.totalBytes} aria-label="本书原图容量使用量" />
      <span>已用 {snapshot.items.length} / 100 张 · {sizeLabel(snapshot.totalBytes)} / 64 MiB · Base64 {sizeLabel(snapshot.totalBase64Bytes)}</span></div>}
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}
    {tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {tool.pending && <div className={styles.warning}><p>保存结果尚未确认，原图与输入已保留。核对原请求前暂停修改和切换。</p>
      {tool.pending.error.requestId ? <button type="button" className={styles.button} disabled={tool.busy} onClick={() => void checkReceipt()}>核对原请求</button> : <p>没有可查询的请求编号，请留存输入后通过主窗口恢复。</p>}
      {draft && <button type="button" className={styles.button} onClick={() => void copyDraft()}>复制完整素材请求以留存</button>}
      {onRecover && <><label className={styles.check}><input type="checkbox" checked={recoveryPreserved} onChange={(event) => setRecoveryPreserved(event.target.checked)} />我已留存原图和当前输入，可以离开本面板恢复</label>
        <button type="button" className={styles.button} disabled={tool.busy || !recoveryPreserved} onClick={onRecover}>打开主窗口恢复</button></>}
    </div>}
    {syncRequired && <p className={styles.warning}>图片写入已确认，等待作品目录同步；失败时可点“重试同步”。</p>}
    {externalChange && <p className={styles.warning}>作品已有新版本，当前输入仍保留。请先核对最新资料再保存。</p>}
    {readonly && <p className={styles.warning}>作品已归档，图片资料仅供查看。</p>}
    {!snapshot ? <p role="status" className={styles.empty}>{tool.busy ? '正在读取图片元信息…' : '尚未读取图片资料，请点击“刷新资料”重试。'}</p>
      : snapshot.requiresUpgrade ? <div className={styles.empty}><h4>启用本书图片资料</h4><p>先备份并升级作品格式，再保存封面与人物立绘。</p>
        <button type="button" className={styles.primaryButton} disabled={tool.locked || readonly} onClick={() => void upgrade()}>备份并升级作品</button></div>
        : <>
          <div className={styles.toolbar}><div className={styles.switcher} role="group" aria-label="图片用途">
            <button type="button" disabled={navigationBlocked} aria-pressed={kind === 'cover'} onClick={() => switchKind('cover')}>封面</button>
            <button type="button" disabled={navigationBlocked} aria-pressed={kind === 'portrait'} onClick={() => switchKind('portrait')}>人物立绘</button></div>
            {kind === 'portrait' && <label>查看人物<select value={personFilter} disabled={navigationBlocked} onChange={(event) => {
              if (!canSwitch()) return
              setPersonFilter(event.target.value); setSelectedId(null); setImage(null)
            }}><option value="">全部人物</option>{personIds.map((id) => <option key={id} value={id}>{names.current.get(id) ?? `人物 ${id}`}</option>)}</select></label>}
          </div>
          <label className={styles.upload}>添加本地图片<input type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" disabled={blocked || !!draft || budgetFull}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void pickFile(file) }} /></label>
          {budgetFull && <p className={styles.warning}>本书图片预算已用满，仍可查看全部旧资产。</p>}
          {!draft && <div className={styles.layout}><div><h4>{kind === 'cover' ? '封面记录' : '人物立绘记录'} · {items.length}</h4>
            {!items.length && <p className={styles.empty}>{kind === 'cover' ? '添加一张本地图片，保存后成为本书当前封面。' : '添加立绘时选择本书已有的人物；尚无人物时，先在设定资料中创建。'}</p>}
            <ul className={styles.items}>{items.map((item) => <li key={item.id}><button type="button" className={styles.item} disabled={navigationBlocked} aria-pressed={selectedId === item.id} onClick={() => void view(item)}>
              <span className={styles.itemHeading}><strong>{item.title}</strong><span className={styles.tag}>{currentIds.has(item.id) ? '当前' : '历史'}</span></span>
              <span className={styles.muted}>{sizeLabel(item.byteLength)} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span>
              {item.personId && <span className={styles.muted}>{names.current.get(item.personId) ?? `人物 ${item.personId}`}</span>}
            </button></li>)}</ul></div>
            <div className={styles.detail}>{selected ? <><h4>{selected.kind === 'cover' ? '封面原图' : '人物立绘原图'}</h4>
              {image && image.id === selected.id ? <><MediaPreview key={image.id} fields={image} onDecoded={setImageDecoded} />
                <button type="button" className={styles.button} disabled={blocked || budgetFull || !imageDecoded} onClick={reuseImage}>以此图新设封面 / 立绘</button>
                <p className={styles.muted}>修改用途、人物或备注会追加一张新资产，旧记录继续保留。</p></>
                : <><p role="status">{tool.busy ? '正在读取所选原图…' : '尚未取得原图，可以重新读取。'}</p><button type="button" className={styles.button} disabled={navigationBlocked} onClick={() => void view(selected)}>读取原图</button></>}
              <p className={styles.identity}>素材 ID：{selected.id}{selected.personId && <><br />人物 ID：{selected.personId}</>}</p>
            </> : <p className={styles.empty}>选择一条记录查看原图。列表只读取元信息，每次仅载入所选图片。</p>}</div>
          </div>}
        </>}
    {draft && <form ref={editorRef} tabIndex={-1} className={styles.editor} onSubmit={(event) => void save(event)}>
      <h4>保存新图片</h4><p className={styles.muted}>本次 {sizeLabel(draftBytes)}；保存后 {snapshot ? `${snapshot.items.length + 1} / 100 张 · ${sizeLabel(snapshot.totalBytes + draftBytes)} / 64 MiB` : '等待读取预算'}。</p>
      <div className={styles.layout}><fieldset disabled={tool.locked || syncRequired || readonly} className={styles.fields}>
        <label>图片用途<select value={draft.fields.kind} onChange={(event) => { const next = event.target.value as BookMediaKind; change({ kind: next, personId: null }) }}>
          <option value="cover">本书封面</option><option value="portrait">人物立绘</option></select></label>
        {draft.fields.kind === 'portrait' && <div className={styles.people}><div className={styles.search}><label>查找已有的人物<input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} /></label>
          <button type="button" className={styles.button} onClick={() => void searchPeople(query.trim(), 0)}>查找人物</button></div>
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
        <p className={styles.muted}>保存后，这张图成为本书封面或所选人物的当前立绘。</p>
      </fieldset><MediaPreview key={draft.id} fields={draft.fields} onDecoded={setDraftDecoded} /></div>
      {!draftFits && <p className={styles.error} role="alert">本次保存会超过图片预算，请放弃本次输入或选择更小的原图。</p>}
      <div className={styles.actions}><button type="submit" className={styles.primaryButton} disabled={blocked || !draftFits || !draftDecoded || (draft.fields.kind === 'portrait' && !draft.fields.personId)}>保存到本书</button>
        <button type="button" className={styles.button} disabled={tool.locked || syncRequired} onClick={dropDraft}>{discard ? '确认放弃本次输入' : '放弃本次输入'}</button>
        <button type="button" className={styles.button} disabled={tool.locked || syncRequired} onClick={() => void compareLatest()}>保留输入，读取最新版本</button>
        <button type="button" className={styles.button} onClick={() => void copyDraft()}>复制当前素材请求</button></div>
      {discard && <p className={styles.warning}>再次点击确认将放弃未保存的图片和备注；已存入本书的资产继续保留。</p>}
      {conflict && <div className={styles.comparison}><p>当前输入基于作品 v{draft.expectedBookRevision}，最新为 v{conflict.bookRevision}；已有 {conflict.items.length} 张、{sizeLabel(conflict.totalBytes)}。</p>
        <p>最新封面：{conflict.items.find((item) => item.id === conflict.activeCoverId)?.title ?? '尚未设置'}。</p>
        <button type="button" className={styles.button} disabled={tool.locked || conflict.archived || conflict.requiresUpgrade || conflict.items.some((item) => item.id === draft.id)} onClick={rebase}>确认沿用输入，改用最新版本</button></div>}
    </form>}
  </section>
}
