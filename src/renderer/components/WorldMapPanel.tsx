import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { AppError, BookSnapshot, StudioApi } from '../../contracts/api'
import { isRecord } from '../../contracts/api'
import { AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_NATURES } from '../../contracts/knowledge'
import {
  WORLD_MAP_LINK_LIMIT, WORLD_MAP_PAGE_SIZE, WORLD_MAP_RELATED_LIMIT,
  type WorldMapInput, type WorldMapPage, type WorldMapPlace, type WorldMapSource,
} from '../../contracts/world-map'
import type { CompanionNavigateTarget } from './CompanionPanel'
import { request } from '../request'
import { Dialog } from './Dialog'
import { StudioIcon, type StudioIconName } from './StudioIcon'
import { SavedMediaImage, SavedPortrait, useSavedMedia } from './SavedPortrait'
import shared from '../StellarShared.module.css'
import styles from './StellarWorldMap.module.css'

interface Props {
  api: StudioApi
  book: BookSnapshot
  busy: boolean
  error?: string | null
  onClose: () => void
  onOpenKnowledge: (id?: string) => void | Promise<void>
  onOpenRecords: (kind?: 'relation' | 'event', id?: string, initialCreate?: boolean) => void | Promise<void>
  onNavigate: (target: CompanionNavigateTarget) => void | Promise<void>
  onGalaxy: () => void
  onOpenScene?: (placeId: string, offset: number) => void
  initialPlaceId?: string
  initialOffset?: number
}
interface Point { x: number; y: number }
type Mode = 'stars' | 'land'
type Positions = Record<string, Partial<Record<Mode, Point>>>
interface ReadState { input: WorldMapInput; nonce: number }
const WIDTH = 1000
const HEIGHT = 720
const MAX_POSITIONS = 2000
const LAYERS: { key: 'places' | 'territories' | 'routes' | 'events'; label: string; icon: StudioIconName }[] = [
  { key: 'places', label: '地点', icon: 'planet' }, { key: 'territories', label: '势力', icon: 'crown' },
  { key: 'routes', label: '航道', icon: 'navigation' }, { key: 'events', label: '事件', icon: 'crystal' },
]
const storageKey = (bookId: string) => `storyweave.world-layout.v1:${bookId}`
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value))
const shorten = (text: string, maximum: number) => Array.from(text).length > maximum ? `${Array.from(text).slice(0, maximum).join('')}…` : text

function readPositions(bookId: string): Positions {
  try {
    const raw = localStorage.getItem(storageKey(bookId))
    if (!raw || raw.length > 400_000) return {}
    const parsed = JSON.parse(raw)
    if (parsed?.bookId !== bookId || parsed.version !== 1 || !parsed.positions || typeof parsed.positions !== 'object' || Array.isArray(parsed.positions)) return {}
    const positions: Positions = {}
    for (const [id, modes] of Object.entries(parsed.positions).slice(-MAX_POSITIONS)) {
      if (!/^[0-9a-f-]{36}$/i.test(id) || !modes || typeof modes !== 'object' || Array.isArray(modes)) continue
      for (const mode of ['stars', 'land'] as const) {
        const point = (modes as Partial<Record<Mode, Point>>)[mode]
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1) {
          positions[id] = { ...positions[id], [mode]: point }
        }
      }
    }
    return positions
  } catch { return {} }
}

function validPage(page: unknown, input: WorldMapInput, book: BookSnapshot): page is WorldMapPage {
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)
  const text = (value: unknown, maximum: number) => typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= maximum
  const choice = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value)
  const status = (value: Record<string, unknown>) => choice(value.nature, KNOWLEDGE_NATURES) && choice(value.authorDecision, AUTHOR_DECISIONS) &&
    choice(value.freshness, KNOWLEDGE_FRESHNESS) && choice(value.conflictState, CONFLICT_STATES)
  const confirmed = (value: Record<string, unknown>) => ['author_setting', 'narrative_claim'].includes(value.nature as string) &&
    value.authorDecision === 'adopted' && value.freshness === 'current' && ['clear', 'explained'].includes(value.conflictState as string)
  const cutoff = input.asOfChapterId ? book.chapters.find((chapter) => chapter.id === input.asOfChapterId)?.position : null
  if (cutoff === undefined) return false
  const validSource = (source: unknown) => {
    if (source === null) return true
    if (!isRecord(source) || !validId(source.chapterId) || !validId(source.revisionId) || !validId(source.blockId) ||
      !text(source.quote, 2000) || (source.quote as string).length > 2000) return false
    const chapter = book.chapters.find((item) => item.id === source.chapterId)
    return chapter !== undefined && source.revisionId === chapter.revisionId && source.chapterTitle === chapter.title &&
      source.chapterPosition === chapter.position && (cutoff === null || chapter.position <= cutoff)
  }
  const reference = (value: unknown): value is Record<string, unknown> & { id: string; name: string } => isRecord(value) && validId(value.id) && text(value.name, 120)
  // 先检查容器与有界结构，再读取字段；异常回包不能变成空库，更不能越过章节出处边界。
  if (!isRecord(page) || !Array.isArray(page.places) || !Array.isArray(page.routes) || !Array.isArray(page.territories) ||
    page.places.length > WORLD_MAP_PAGE_SIZE || page.routes.length > WORLD_MAP_LINK_LIMIT || page.territories.length > WORLD_MAP_LINK_LIMIT ||
    typeof page.total !== 'number' || typeof page.offset !== 'number' || typeof page.bookRevision !== 'number' ||
    typeof page.knowledgeRevision !== 'number' || typeof page.linksTruncated !== 'boolean') return false
  if (!page.places.every((place) => reference(place) && isRecord(place) && status(place) &&
    typeof place.excerpt === 'string' && place.excerpt.length <= 2000 && validSource(place.firstAppearance) &&
    typeof place.relatedTruncated === 'boolean' && Array.isArray(place.people) && place.people.length <= WORLD_MAP_RELATED_LIMIT &&
    place.people.every(reference) && new Set(place.people.map((person) => person.id)).size === place.people.length &&
    Array.isArray(place.events) && place.events.length <= WORLD_MAP_RELATED_LIMIT &&
    place.events.every((event) => reference(event) && isRecord(event) && validSource(event.source) &&
      (cutoff === null || book.chapters.some((chapter) => chapter.position <= cutoff && event.name === `${chapter.title} · 已登记事件`))) &&
    new Set(place.events.map((event) => event.id)).size === place.events.length &&
    (cutoff === null || confirmed(place) && isRecord(place.firstAppearance) &&
      place.excerpt === place.firstAppearance.quote && place.excerpt.includes(place.name)))) return false
  const ids = new Set(page.places.map((place) => place.id))
  return page.bookId === input.bookId && page.asOfChapterId === (input.asOfChapterId ?? null) && page.offset === (input.offset ?? 0) &&
    Number.isSafeInteger(page.total) && page.total >= 0 && page.total <= 100_000 && Number.isSafeInteger(page.bookRevision) && page.bookRevision >= 0 &&
    Number.isSafeInteger(page.knowledgeRevision) && page.knowledgeRevision >= 0 &&
    (input.expectedBookRevision === undefined || page.bookRevision === input.expectedBookRevision && page.knowledgeRevision === input.expectedKnowledgeRevision) &&
    page.places.length === Math.min(WORLD_MAP_PAGE_SIZE, Math.max(0, page.total - page.offset)) && ids.size === page.places.length &&
    page.nextOffset === (page.offset + page.places.length < page.total ? page.offset + page.places.length : null) &&
    page.routes.length <= WORLD_MAP_LINK_LIMIT &&
    page.routes.every((route) => isRecord(route) && validId(route.id) && text(route.title, 120) && status(route) &&
      ids.has(route.fromId) && ids.has(route.toId) && ['directed', 'mutual'].includes(route.direction as string) &&
      (cutoff === null || confirmed(route) && route.title === '航道')) &&
    new Set(page.routes.map((route) => route.id)).size === page.routes.length &&
    page.territories.length <= WORLD_MAP_LINK_LIMIT &&
    page.territories.every((territory) => reference(territory) && isRecord(territory) && Array.isArray(territory.placeIds) &&
      territory.placeIds.length > 0 && territory.placeIds.length <= WORLD_MAP_PAGE_SIZE &&
      new Set(territory.placeIds).size === territory.placeIds.length && territory.placeIds.every((id) => ids.has(id))) &&
    new Set(page.territories.map((territory) => territory.id)).size === page.territories.length
}

export function WorldMapPanel({ api, book, busy, error, onClose, onOpenKnowledge, onOpenRecords, onNavigate, onGalaxy, onOpenScene, initialPlaceId, initialOffset = 0 }: Props) {
  const bookId = book.book.id
  const [reading, setReading] = useState<ReadState>({ input: { bookId, offset: 0 }, nonce: 0 })
  const [page, setPage] = useState<WorldMapPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [pending, setPending] = useState<AppError | null>(null)
  const [checking, setChecking] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(initialPlaceId ?? null)
  const [mode, setMode] = useState<Mode>('stars')
  const [layers, setLayers] = useState({ places: true, territories: true, routes: true, events: true })
  const [zoom, setZoom] = useState(1)
  const [positions, setPositions] = useState<Positions>(() => readPositions(bookId))
  const [notice, setNotice] = useState<string | null>(null)
  const epoch = useRef(0)
  const lock = useRef(false)
  const mounted = useRef(false)
  const startedRead = useRef<ReadState | null>(null)
  const latestBook = useRef(book)
  const restoreOffset = useRef(initialOffset)
  latestBook.current = book
  // 当前场景和立绘不具备历史时点，章节模式不读取也不展示，避免泄漏未来信息。
  const media = useSavedMedia(api, bookId, book.book.revision, reading, !reading.input.asOfChapterId)
  const disabled = busy || loading || pending !== null || checking
  const current = page && page.bookRevision === book.book.revision ? page : null
  const selected = current?.places.find((place) => place.id === selectedId) ?? null
  const scene = selected && !current?.asOfChapterId ? media.items.find((item) => item.kind === 'scene' && item.placeId === selected.id) : undefined

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current += 1 } }, [])
  useEffect(() => {
    if (busy || startedRead.current === reading) return
    startedRead.current = reading
    const ticket = ++epoch.current
    lock.current = true; setLoading(true); setPage(null); setReadError(null)
    void request(() => api.getWorldMap(reading.input)).then((result) => {
      if (!mounted.current || ticket !== epoch.current) return
      lock.current = false; setLoading(false)
      if (!result.ok) {
        if (result.error.code === 'REQUEST_TIMEOUT') setPending(result.error)
        setReadError(result.error.message); return
      }
      if (!validPage(result.data, reading.input, latestBook.current) || result.data.bookRevision !== latestBook.current.book.revision) {
        setReadError('地图身份、章节范围或双版本与当前作品不符，请刷新。'); return
      }
      if (restoreOffset.current > 0) {
        // 场景保存会推进作品版本，先读第一页取得新双版本，再恢复原分页。
        const offset = Math.min(restoreOffset.current, Math.floor(Math.max(0, result.data.total - 1) / WORLD_MAP_PAGE_SIZE) * WORLD_MAP_PAGE_SIZE)
        restoreOffset.current = 0
        if (offset > 0) {
          lock.current = true; setLoading(true)
          setReading((previous) => ({ input: { bookId, offset, expectedBookRevision: result.data.bookRevision,
            expectedKnowledgeRevision: result.data.knowledgeRevision }, nonce: previous.nonce + 1 }))
          return
        }
      }
      setPage(result.data)
      setSelectedId((previous) => result.data.places.some((place) => place.id === previous) ? previous : result.data.places[0]?.id ?? null)
    })
    // 外部忙碌只延后首次读取，不取消已发出的请求，保留未知回执。
  }, [api, reading, busy])

  function read(input: WorldMapInput) {
    if (busy || lock.current || pending || checking) return
    epoch.current += 1; lock.current = true
    // 读取中隐藏旧详情，选中身份留待新快照核对，避免刷新重试跳到其他地点。
    setPage(null); setLoading(true); setReadError(null)
    setReading((previous) => ({ input, nonce: previous.nonce + 1 }))
  }
  function refresh() { read({ bookId, ...(reading.input.asOfChapterId ? { asOfChapterId: reading.input.asOfChapterId } : {}), offset: 0 }) }
  function movePage(offset: number) {
    if (current) read({ ...reading.input, offset, expectedBookRevision: current.bookRevision, expectedKnowledgeRevision: current.knowledgeRevision })
  }
  async function checkPending() {
    if (!pending?.requestId || checking || busy) return
    setChecking(true)
    const result = await request(() => api.getRequestStatus({ requestId: pending.requestId! }))
    if (!mounted.current) return
    setChecking(false)
    if (!result.ok) { setReadError(result.error.message); return }
    if (result.data.state === 'pending') { setReadError('原地图读取仍在执行，请稍后再核对。'); return }
    if (result.data.state === 'completed' && result.data.response.command !== 'story.worldMap') {
      setReadError('回执命令与原地图读取不符，请返回并恢复服务。'); return
    }
    setPending(null); setReadError('原地图读取已结束，请明确刷新以读取当前快照。')
  }
  function savePositions(next: Positions) {
    const bounded = Object.fromEntries(Object.entries(next).slice(-MAX_POSITIONS))
    setPositions(bounded)
    try {
      // 星域与大陆分别保留作者的画布位置，只是显示偏好，不写正文、知识或地理事实。
      localStorage.setItem(storageKey(bookId), JSON.stringify({ version: 1, bookId, positions: bounded }))
      setNotice('地图位置已保存。')
    } catch { setNotice('位置保留在当前会话，暂未能保存布局。') }
  }
  function jump(source: WorldMapSource) {
    const chapter = book.chapters.find((item) => item.id === source.chapterId)
    if (!disabled && current && chapter) void onNavigate({ bookId, chapterId: chapter.id,
      expectedRevisionId: chapter.revisionId, sourceRevisionId: source.revisionId, blockId: source.blockId })
  }
  const factions = selected ? current?.territories.filter((territory) => territory.placeIds.includes(selected.id)) ?? [] : []
  const source = selected?.firstAppearance
  const pageChanged = page !== null && current === null

  return <Dialog title="世界星域地图" className={styles.page} wide busy={busy} onClose={onClose} error={error}
    toolbar={<div className={styles.toolbar}>
      <div className={styles.mode} role="group" aria-label="地图视图">
        <button type="button" className={shared.button} aria-pressed={mode === 'stars'} onClick={() => setMode('stars')}><StudioIcon name="spark" size={20} />星域</button>
        <button type="button" className={shared.button} aria-pressed={mode === 'land'} onClick={() => setMode('land')}><StudioIcon name="globe" size={20} />大陆</button>
      </div>
      <div className={styles.layers} role="group" aria-label="地图图层">{LAYERS.map((layer) => <button key={layer.key} type="button" className={shared.button}
        aria-pressed={layers[layer.key]} title={layer.label} onClick={() => setLayers((value) => ({ ...value, [layer.key]: !value[layer.key] }))}><StudioIcon name={layer.icon} size={20} /><span>{layer.label}</span></button>)}</div>
      <label className={styles.chapterFilter}><span className={styles.srOnly}>按章节筛选地图</span><select disabled={disabled} value={reading.input.asOfChapterId ?? ''}
        onChange={(event) => read({ bookId, offset: 0, ...(event.target.value ? { asOfChapterId: event.target.value } : {}) })}>
        <option value="">全部章节 · 作者视图</option>{book.chapters.map((chapter, index) => <option key={chapter.id} value={chapter.id}>{`截至第${index + 1}章 · ${chapter.title}`}</option>)}
      </select></label>
      <div className={styles.zoom} role="group" aria-label="地图缩放">
        <button type="button" className={styles.iconButton} aria-label="缩小地图" title="缩小地图" disabled={zoom <= .6} onClick={() => setZoom((value) => clamp(value - .2, .6, 2))}><StudioIcon name="minus" size={20} /></button>
        <input aria-label="地图缩放比例" type="range" min={60} max={200} step={10} value={Math.round(zoom * 100)} onChange={(event) => setZoom(Number(event.target.value) / 100)} />
        <button type="button" className={styles.iconButton} aria-label="放大地图" title="放大地图" disabled={zoom >= 2} onClick={() => setZoom((value) => clamp(value + .2, .6, 2))}><StudioIcon name="plus" size={20} /></button>
      </div>
    </div>}>
    {(readError || pageChanged) && <div className={styles.notice}><p role="alert">{pageChanged ? '作品已变化，请刷新地图。' : readError}</p>
      {pending ? <button type="button" className={shared.button} disabled={busy || checking || !pending.requestId} onClick={() => void checkPending()}>{checking ? '正在核对…' : '核对原读取'}</button>
        : <button type="button" className={shared.button} disabled={disabled} onClick={refresh}>刷新地图</button>}</div>}
    <div className={styles.workspace}>
      <section className={styles.canvasPane} aria-label="世界地图画布" aria-busy={loading}>
        {loading ? <div className={styles.empty} role="status"><StudioIcon name="globe" size={32} /><p>{busy ? '等待当前操作结束…' : '正在读取世界地图…'}</p></div>
          : current && current.places.length ? <WorldMapCanvas page={current} mode={mode} layers={layers} zoom={zoom} positions={positions}
            disabled={disabled} selectedId={selectedId} onSelect={setSelectedId} onPositions={savePositions} onEvent={(event) => {
              if (current.asOfChapterId) { if (event.source) jump(event.source) }
              else void onOpenRecords('event', event.id)
            }} />
            : <div className={styles.empty}><StudioIcon name="globe" size={32} /><p>{!current ? '地图暂不可用，请按上方提示恢复。' : current.asOfChapterId ? '截至本章，尚无已登记出场的地点。' : '还没有地点设定。'}</p>
              {current && <button type="button" className={shared.primaryButton} onClick={() => current.asOfChapterId ? read({ bookId, offset: 0 }) : void onOpenKnowledge()}>{current.asOfChapterId ? '查看全部章节' : '建立地点设定'}</button>}</div>}
        <div className={styles.canvasFooter}>
          <div className={styles.legend}><span data-tone="located">已定位</span><span data-tone="unknown">未定位</span><span data-tone="route">航道</span></div>
          <span role="status">{notice ?? (current ? `${current.places.length} / ${current.total} 个地点` : '等待读取')}</span>
          <button type="button" className={styles.iconButton} title="刷新地图" aria-label="刷新地图" disabled={disabled} onClick={refresh}><StudioIcon name="refresh" /></button>
        </div>
      </section>
      <aside className={styles.detail} aria-label="地图地点详情">
        {selected ? <><div className={styles.detailContent}>
          {!current?.asOfChapterId && <button type="button" className={styles.sceneButton} disabled={disabled || !onOpenScene}
            aria-label={`管理${selected.name}的场景图`} title={onOpenScene ? `查看或更换${selected.name}的场景图` : '场景图管理入口不可用'}
            onClick={() => onOpenScene?.(selected.id, current?.offset ?? 0)}>
            <SavedMediaImage api={api} bookId={bookId} key={`${selected.id}:${reading.nonce}`}
              metadata={scene}
              name={`${selected.name}的已保存场景图`} className={styles.locationMark}
              fallback={<><StudioIcon name="image" size={48} />{!scene && <small>{media.loading ? '正在读取场景…' : media.error ? '场景资料暂不可用' : '未设置场景图'}</small>}</>} />
          </button>}
          {!current?.asOfChapterId && media.error && <p className={styles.muted} role="status">{media.error} 可刷新地图重试。</p>}
          <div className={styles.detailHeading}><h3>{selected.name}</h3>
            {!current?.asOfChapterId && <button type="button" className={styles.iconButton} aria-label="编辑地点设定" title="编辑地点设定"
              disabled={disabled} onClick={() => void onOpenKnowledge(selected.id)}><StudioIcon name="pen" size={20} /></button>}
          </div>
          <dl className={styles.facts}><dt>类型</dt><dd>地点</dd><dt>所属势力</dt><dd>{factions.length ? factions.map((faction) => <span key={faction.id} className={styles.faction}
            data-tone={(current?.territories.findIndex((territory) => territory.id === faction.id) ?? 0) % 3}><StudioIcon name="crystal" size={20} />{faction.name}</span>) : '未登记'}</dd>
            <dt>首次登记出场</dt><dd>{source ? source.chapterTitle : '未登记当前稿出处'}</dd></dl>
          <p className={styles.description}>{selected.excerpt || '暂无补充说明。'}</p>
          <section className={styles.related}><h4>关联人物</h4>
            <div className={styles.people}>{selected.people.map((person) => <button type="button" key={person.id} disabled={disabled || Boolean(current?.asOfChapterId)}
              aria-label={`查看${person.name}`}
              title={current?.asOfChapterId ? '章节模式仅显示已登记出场姓名' : `查看${person.name}`} onClick={() => void onOpenKnowledge(person.id)}>
              {current?.asOfChapterId ? <span className={styles.personFallback}>{Array.from(person.name)[0]}</span> : <SavedPortrait api={api} bookId={bookId} personId={person.id}
                metadata={media.items.find((item) => item.kind === 'portrait' && item.personId === person.id)} name={person.name} fallback={Array.from(person.name)[0]} className={styles.personFallback} />}
              <span className={current?.asOfChapterId ? undefined : styles.srOnly}>{person.name}</span>
            </button>)}</div>{selected.people.length === 0 && <p className={styles.muted}>暂无已登记关联人物</p>}
            {!current?.asOfChapterId && selected.people.length > 0 && media.loading &&
              <p className={styles.muted} role="status">正在读取立绘资料…</p>}
          </section>
          <section className={styles.related}><h4>关联事件</h4>{selected.events.length ? <ul className={styles.events}>{selected.events.map((event) => <li key={event.id}>
            <button type="button" disabled={disabled || Boolean(current?.asOfChapterId && !event.source)} title={current?.asOfChapterId && !event.source ? '当前范围没有可核对的正文出处' : event.name}
              onClick={() => current?.asOfChapterId ? event.source && jump(event.source) : void onOpenRecords('event', event.id)}><StudioIcon name="crystal" size={20} /><span>{event.name}</span><StudioIcon name="chevron" size={16} /></button>
          </li>)}</ul> : <p className={styles.muted}>暂无已登记关联事件</p>}
            {selected.relatedTruncated && <p className={styles.muted}>关联超过当前显示范围，完整记录可在作者视图查看。</p>}
          </section>
          {current?.asOfChapterId && source && <blockquote className={styles.quote}>{source.quote}</blockquote>}
          </div><div className={styles.detailActions}>
          <button type="button" className={`${shared.primaryButton} ${styles.jump}`} disabled={disabled || !source}
            title={!source ? '请先为地点登记当前稿正文出处' : '跳到地点的固定出处段落'} onClick={() => { if (source) jump(source) }}><StudioIcon name="spark" size={24} />跳到正文</button>
          </div>
        </> : <div className={styles.detailEmpty}><StudioIcon name="compass" size={32} /><p>选择地点查看详情</p></div>}
      </aside>
    </div>
    <footer className={styles.footer}>
      <button type="button" className={shared.button} disabled={disabled || !current || current.offset === 0} onClick={() => { if (current && current.offset > 0) movePage(Math.max(0, current.offset - WORLD_MAP_PAGE_SIZE)) }} title="地点分页" aria-label="上一页地图地点">上一页</button>
      <span>{current ? `${current.offset + (current.places.length ? 1 : 0)}–${current.offset + current.places.length} / ${current.total}` : '—'}</span>
      <button type="button" className={shared.button} disabled={disabled || current?.nextOffset == null} onClick={() => { if (current?.nextOffset != null) movePage(current.nextOffset) }}>下一页</button>
      {current?.linksTruncated && <span className={styles.caution}>本页关联已达到显示上限</span>}
      <div className={styles.footerActions}><button type="button" className={shared.button} disabled={disabled || Boolean(book.book.archivedAt)} title={book.book.archivedAt ? '作品已归档，须先取消归档' : '建立地点之间的航道，或地点到势力的领属关系'} onClick={() => void onOpenRecords('relation', undefined, true)}>登记航道与领属</button>
        <button type="button" className={shared.button} disabled={disabled} onClick={onGalaxy}>记忆星图</button></div>
    </footer>
  </Dialog>
}

function WorldMapCanvas({ page, mode, layers, zoom, positions, disabled, selectedId, onSelect, onPositions, onEvent }: {
  page: WorldMapPage; mode: Mode; layers: Record<'places' | 'territories' | 'routes' | 'events', boolean>; zoom: number
  positions: Positions; disabled: boolean; selectedId: string | null; onSelect: (id: string) => void
  onPositions: (positions: Positions) => void; onEvent: (event: WorldMapPlace['events'][number]) => void
}) {
  const stage = useRef<SVGSVGElement>(null)
  const drag = useRef<{ pointer: number; id: string | null; start: Point; base: Point; point: Point; moved: boolean } | null>(null)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [moving, setMoving] = useState<{ id: string; point: Point } | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const revealId = useRef<string | null>(null)
  const [visibleLabels, setVisibleLabels] = useState<Set<string>>(() => new Set())
  const arrowId = `world-map-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const viewWidth = WIDTH / zoom, viewHeight = HEIGHT / zoom
  const view = { x: WIDTH / 2 - viewWidth / 2 + pan.x, y: HEIGHT / 2 - viewHeight / 2 + pan.y }
  useEffect(() => { drag.current = null; setMoving(null); setFocusedId(null); setPan({ x: 0, y: 0 }) }, [mode, page])
  const points = useMemo(() => new Map(page.places.map((place, index) => {
    const saved = positions[place.id]?.[mode]
    const angle = index * 2.399963229728653 - 1.4
    const radius = page.places.length === 1 ? 0 : Math.sqrt((index + .5) / page.places.length)
    return [place.id, moving?.id === place.id ? moving.point : saved ? { x: 80 + saved.x * 840, y: 70 + saved.y * 560 }
      : { x: 500 + Math.cos(angle) * radius * 380, y: 350 + Math.sin(angle) * radius * 240 }]
  })), [page, positions, mode, moving])
  useLayoutEffect(() => {
    const id = revealId.current
    revealId.current = null
    // 等焦点字号、文字方向和节点坐标提交后再测量，避免缩放时只露出半个名称。
    if (id) revealPlace(id)
  })
  useLayoutEffect(() => {
    const svg = stage.current
    if (!svg) return
    function measure() {
      if (!svg) return
      const margin = Number.parseFloat(getComputedStyle(svg).getPropertyValue('--space-1')) || 0
      const labels = [...svg.querySelectorAll<SVGGElement>('[data-place-id],[data-territory-id]')].flatMap((element) => {
        const text = element.querySelector('text'), point = element.querySelector(`.${styles.point}`)
        return text ? [{ id: element.dataset.placeId ?? `territory:${element.dataset.territoryId}`,
          text: text.getBoundingClientRect(), point: point?.getBoundingClientRect() ?? null }] : []
      })
      const priority = (id: string) => id === focusedId ? 0 : id === selectedId ? 1 : id.startsWith('territory:') ? 2 : positions[id]?.[mode] ? 3 : 4
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right + margin && a.right + margin > b.left && a.top < b.bottom + margin && a.bottom + margin > b.top
      const accepted: DOMRect[] = []
      const next = new Set<string>()
      // 地点与势力共同按真实文字边界避让；优先焦点和选中地点，只收起文字，不改变节点与领属。
      for (const label of [...labels].sort((a, b) => priority(a.id) - priority(b.id))) {
        if (accepted.some((rect) => overlaps(rect, label.text)) || labels.some((other) => other.id !== label.id && other.point && overlaps(other.point, label.text))) continue
        accepted.push(label.text); next.add(label.id)
      }
      setVisibleLabels((previous) => previous.size === next.size && [...next].every((id) => previous.has(id)) ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [focusedId, layers.places, layers.territories, mode, points, positions, selectedId, view.x, view.y, viewWidth, viewHeight])
  function coordinate(event: PointerEvent<SVGSVGElement>): Point | null {
    const matrix = stage.current?.getScreenCTM()
    if (!matrix || !stage.current) return null
    const point = stage.current.createSVGPoint()
    point.x = event.clientX; point.y = event.clientY
    return point.matrixTransform(matrix.inverse())
  }
  function savePoint(id: string, point: Point) {
    const next = { ...positions }
    delete next[id]
    next[id] = { ...positions[id], [mode]: { x: clamp((point.x - 80) / 840, 0, 1), y: clamp((point.y - 70) / 560, 0, 1) } }
    onPositions(next)
  }
  function revealPlace(id: string) {
    const svg = stage.current, point = points.get(id)
    const element = svg?.querySelector<SVGGElement>(`[data-place-id="${id}"]`)
    if (!svg || !point || !element || drag.current) return
    const bounds = element.getBBox()
    const scale = svg.getScreenCTM()?.a
    if (!scale) return
    const margin = (Number.parseFloat(getComputedStyle(svg).getPropertyValue('--space-3')) || 0) / scale
    const left = point.x + bounds.x - margin, right = left + bounds.width + margin * 2
    const top = point.y + bounds.y - margin, bottom = top + bounds.height + margin * 2
    const dx = left < view.x ? left - view.x : right > view.x + viewWidth ? right - view.x - viewWidth : 0
    const dy = top < view.y ? top - view.y : bottom > view.y + viewHeight ? bottom - view.y - viewHeight : 0
    if (dx || dy) setPan((previous) => ({ x: clamp(previous.x + dx, -WIDTH, WIDTH), y: clamp(previous.y + dy, -HEIGHT, HEIGHT) }))
  }
  function down(event: PointerEvent<SVGSVGElement>) {
    if (disabled || !event.isPrimary || event.button !== 0 || drag.current) return
    const point = coordinate(event)
    if (!point) return
    const target = (event.target as Element).closest<SVGGElement>('[data-place-id],[data-place-proxy]')
    if ((event.target as Element).closest('[data-map-event]')) return
    const id = target?.dataset.placeId ?? target?.dataset.placeProxy ?? null
    const base = id ? points.get(id)! : pan
    drag.current = { pointer: event.pointerId, id, start: point, base, point: base, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (id) {
      event.preventDefault()
      stage.current?.querySelector<SVGGElement>(`[data-place-id="${id}"]`)?.focus()
    }
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const saved = drag.current, point = coordinate(event)
    if (!saved || saved.pointer !== event.pointerId || !point || disabled) return
    const dx = point.x - saved.start.x, dy = point.y - saved.start.y
    if (!saved.moved && Math.hypot(dx, dy) < 5 / zoom) return
    saved.moved = true
    if (saved.id) {
      // 指针坐标即时留存，松开时不依赖尚未提交的 React 绘制状态。
      saved.point = { x: clamp(saved.base.x + dx, 80, 920), y: clamp(saved.base.y + dy, 70, 630) }
      setMoving({ id: saved.id, point: saved.point })
    }
    else {
      const next = { x: clamp(pan.x - dx, -WIDTH, WIDTH), y: clamp(pan.y - dy, -HEIGHT, HEIGHT) }
      setPan(next)
    }
  }
  function end(event: PointerEvent<SVGSVGElement>, cancel = false) {
    const saved = drag.current
    if (!saved || saved.pointer !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!cancel && !disabled && saved.id) {
      if (saved.moved) savePoint(saved.id, saved.point)
      else if (!saved.moved) onSelect(saved.id)
    }
    setMoving(null)
  }
  function key(event: KeyboardEvent<SVGGElement>, id: string) {
    if (disabled || drag.current) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); revealId.current = id; onSelect(id); return }
    const point = points.get(id)
    const directions: Record<string, Point> = { ArrowLeft: { x: -8, y: 0 }, ArrowRight: { x: 8, y: 0 }, ArrowUp: { x: 0, y: -8 }, ArrowDown: { x: 0, y: 8 } }
    const direction = directions[event.key]
    if (point && direction) {
      event.preventDefault()
      const next = { x: clamp(point.x + direction.x, 80, 920), y: clamp(point.y + direction.y, 70, 630) }
      revealId.current = id; savePoint(id, next)
    }
  }
  const active = page.places.find((place) => place.id === selectedId)
  // 当前页最多 40 个地点，全部保留键盘入口；前景副本不参与 Tab 顺序。
  const paintPriority = (id: string) => id === focusedId ? 2 : id === selectedId ? 1 : 0
  const foregroundPlaces = page.places.filter((place) => paintPriority(place.id) > 0)
    .sort((a, b) => paintPriority(a.id) - paintPriority(b.id))
  function placeMark(place: WorldMapPlace) {
    const point = points.get(place.id)!
    const located = Boolean(positions[place.id]?.[mode])
    return <>
      <title>{place.name} · {located ? '已定位' : '未定位'}</title>
      <circle r={18} className={styles.hitArea} />
      <foreignObject x={-36} y={-36} width={72} height={72} className={styles.nodeGlow} aria-hidden="true"><div /></foreignObject>
      {selectedId === place.id && <><circle r={25} className={styles.selectedRing} /><circle r={32} className={styles.outerRing} /></>}
      <circle r={selectedId === place.id ? 7 : located ? 4 : 6} className={styles.point} />
      <path d="M -26 0 H 26 M 0 -26 V 26" className={styles.nodeRays} aria-hidden="true" />
      <text x={(point.x > 740 ? -1 : 1) * (selectedId === place.id || focusedId === place.id ? 42 : 20)} y={5} textAnchor={point.x > 740 ? 'end' : 'start'}>{shorten(place.name, 12)}</text>
    </>
  }
  return <div className={styles.map} data-mode={mode}>
    <div className={styles.nebula} aria-hidden="true"><div className={styles.nebulaArms}><span /><span /></div><span className={styles.nebulaCore} /></div>
    <svg ref={stage} viewBox={`${view.x} ${view.y} ${viewWidth} ${viewHeight}`} className={styles.stage} aria-label="世界地点、航道与已登记领属范围"
      onPointerDown={down} onPointerMove={move} onPointerUp={(event) => end(event)} onPointerCancel={(event) => end(event, true)}
      onLostPointerCapture={(event) => { if (drag.current?.pointer === event.pointerId) { drag.current = null; setMoving(null) } }}>
      <defs><marker id={arrowId} viewBox="0 0 10 10" refX="21" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
      <g className={styles.grid} aria-hidden="true">{mode === 'stars' ? [1, 2, 3, 4, 5].map((ring) => <ellipse key={ring} cx={500} cy={350} rx={ring * 100} ry={ring * 66} />)
        : <>{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => <line key={`v${index}`} x1={index * 100} y1={0} x2={index * 100} y2={HEIGHT} />)}
          {[1, 2, 3, 4, 5, 6].map((index) => <line key={`h${index}`} x1={0} y1={index * 100} x2={WIDTH} y2={index * 100} />)}</>}
        <line x1={500} y1={0} x2={500} y2={HEIGHT} /><line x1={0} y1={350} x2={WIDTH} y2={350} /></g>
      {layers.territories && page.territories.map((territory, index) => {
        const members = territory.placeIds.flatMap((id) => points.has(id) ? [points.get(id)!] : [])
        const located = territory.placeIds.every((id) => positions[id]?.[mode])
        return <g key={territory.id} className={styles.territory} data-located={located} data-tone={index % 3}
          data-territory-id={territory.id} data-label-visible={visibleLabels.has(`territory:${territory.id}`)}>
          <title>{territory.name} · 已登记领属地点范围</title><path d={territoryPath(hull(members.flatMap((point) => [
            { x: point.x - 56, y: point.y - 48 }, { x: point.x + 56, y: point.y - 48 },
            { x: point.x + 56, y: point.y + 48 }, { x: point.x - 56, y: point.y + 48 },
          ])))} />
          {members[0] && <text x={members[0].x} y={Math.max(24, members[0].y - 64)} textAnchor="middle">{shorten(territory.name, 12)}</text>}
        </g>
      })}
      {layers.routes && page.routes.map((route) => {
        const from = points.get(route.fromId), to = points.get(route.toId)
        if (!from || !to) return null
        return <line key={route.id} className={styles.route} data-conflict={route.conflictState === 'candidate'}
          data-known={positions[route.fromId]?.[mode] && positions[route.toId]?.[mode] && route.authorDecision === 'adopted' && route.freshness === 'current' && ['clear', 'explained'].includes(route.conflictState) ? 'true' : 'false'}
          x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd={route.direction === 'directed' ? `url(#${arrowId})` : undefined}><title>{route.title}</title></line>
      })}
      {layers.places && page.places.map((place) => {
        const point = points.get(place.id)!
        const territoryIndex = page.territories.findIndex((territory) => territory.placeIds.includes(place.id))
        const located = Boolean(positions[place.id]?.[mode])
        return <g key={place.id} role="button" tabIndex={disabled ? -1 : 0} aria-label={`地点：${place.name}`} aria-pressed={selectedId === place.id}
          aria-disabled={disabled} data-place-id={place.id} data-located={located} className={styles.place}
          data-selected={selectedId === place.id} data-focused={focusedId === place.id}
          data-tone={territoryIndex < 0 ? undefined : territoryIndex % 3} data-label-visible={visibleLabels.has(place.id)}
          transform={`translate(${point.x} ${point.y})`} onFocus={() => { if (!drag.current) revealId.current = place.id; setFocusedId(place.id) }}
          onBlur={() => setFocusedId(null)} onKeyDown={(event) => key(event, place.id)}
          onClick={(event) => { if (event.detail === 0 && !disabled) { revealId.current = place.id; onSelect(place.id) } }}>
          {placeMark(place)}
        </g>
      })}
      {layers.places && foregroundPlaces.map((place) => {
        const point = points.get(place.id)!
        const territoryIndex = page.territories.findIndex((territory) => territory.placeIds.includes(place.id))
        return <g key={place.id} aria-hidden="true" focusable="false" data-place-proxy={place.id}
          className={`${styles.place} ${styles.placeProxy}`} data-located={Boolean(positions[place.id]?.[mode])}
          data-selected={selectedId === place.id} data-focused={focusedId === place.id}
          data-tone={territoryIndex < 0 ? undefined : territoryIndex % 3} data-label-visible={visibleLabels.has(place.id)}
          transform={`translate(${point.x} ${point.y})`}>
          {placeMark(place)}
        </g>
      })}
      {layers.events && active && points.has(active.id) && active.events.slice(0, 3).map((event, index) => {
        const point = points.get(active.id)!
        return <g key={event.id} data-map-event role="button" tabIndex={disabled || page.asOfChapterId && !event.source ? -1 : 0}
          aria-label={`地图事件：${event.name}`} aria-disabled={disabled || Boolean(page.asOfChapterId && !event.source)} className={styles.mapEvent}
          transform={`translate(${point.x - 40 + index * 40} ${point.y + 52})`}
          onClick={() => { if (!disabled && (!page.asOfChapterId || event.source)) onEvent(event) }}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !disabled && (!page.asOfChapterId || event.source)) { e.preventDefault(); onEvent(event) } }}>
          <title>{event.name}</title><path d="M 0 -9 L 9 0 L 0 9 L -9 0 Z" />
          <path d="M 0 -5 L 1.5 -1.5 L 5 0 L 1.5 1.5 L 0 5 L -1.5 1.5 L -5 0 L -1.5 -1.5 Z" className={styles.eventCore} aria-hidden="true" />
          <rect x={-16} y={-16} width={32} height={32} className={styles.hitArea} />
        </g>
      })}
    </svg>
    <button type="button" className={`${styles.iconButton} ${styles.reset}`} title="复位地图视角" aria-label="复位地图视角" onClick={() => setPan({ x: 0, y: 0 })}><StudioIcon name="focus" /></button>
  </div>
}

function territoryPath(points: Point[]): string {
  if (points.length < 3) return ''
  // 曲线控制点仍在原凸包内，只平滑已登记领属的显示外沿，不推断地理边界。
  const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const start = middle(points.at(-1)!, points[0])
  return `M ${start.x} ${start.y} ` + points.map((point, index) => {
    const end = middle(point, points[(index + 1) % points.length])
    return `Q ${point.x} ${point.y} ${end.x} ${end.y}`
  }).join(' ') + ' Z'
}

function hull(points: Point[]): Point[] {
  // 势力范围仅包围明确领属的本页地点；不按距离猜测其他地点归属。
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (sorted.length < 3) return sorted
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const lower: Point[] = [], upper: Point[] = []
  for (const point of sorted) { while (lower.length > 1 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop(); lower.push(point) }
  for (const point of [...sorted].reverse()) { while (upper.length > 1 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop(); upper.push(point) }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}
