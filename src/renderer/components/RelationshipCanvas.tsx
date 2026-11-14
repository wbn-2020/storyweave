import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { StudioApi } from '../../contracts/api'
import { galaxyKey, type GalaxyEdge, type GalaxyKind, type GalaxyNode, type GalaxyRole, type GalaxyTarget } from '../../contracts/story-galaxy'
import { StudioIcon, type StudioIconName } from './StudioIcon'
import { SavedPortrait, useSavedPortraits } from './SavedPortrait'
import shared from '../StellarShared.module.css'
import styles from './StellarGraph.module.css'

interface Props {
  api: StudioApi
  bookId: string
  bookRevision: number
  nodes: GalaxyNode[]
  edges: GalaxyEdge[]
  selected: GalaxyTarget | null
  disabled: boolean
  picking: boolean
  chosen: string[]
  kindLabels: Record<GalaxyKind, string>
  roleLabels: Record<GalaxyRole, string>
  onSelect: (target: GalaxyTarget) => void
  onConnect?: (fromEntityId: string, toEntityId: string, relationType?: string) => void
  onScan?: () => void
}
interface Position { x: number; y: number }
type Positions = Record<string, Position>
interface Drag { pointerId: number; key: string; start: Position; original: Position; moved: boolean }
const WIDTH = 1000
const NODE_WIDTH = 120
const NODE_HEIGHT = 140
const MAX_POSITIONS = 2000
const storageKey = (bookId: string) => `storyweave.relationship-layout.v1:${bookId}`
const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value))
const relationChoices: readonly { label: string; icon: StudioIconName; tone: string }[] = [
  { label: '师承', icon: 'graduate', tone: 'mentor' }, { label: '血亲', icon: 'drop', tone: 'kinship' },
  { label: '死敌', icon: 'sword', tone: 'enemy' }, { label: '同盟', icon: 'workflow', tone: 'ally' },
  { label: '暗恋', icon: 'heart', tone: 'affection' }, { label: '挚友', icon: 'users', tone: 'friend' },
  { label: '其他', icon: 'more', tone: 'unknown' },
]
function relationTone(value: string | undefined) {
  if (value && ['师承', '师徒', '师生'].includes(value)) return 'mentor'
  if (value && ['死敌', '宿敌', '敌对'].includes(value)) return 'enemy'
  if (value && ['同盟', '盟友'].includes(value)) return 'ally'
  if (value && ['暗恋', '爱慕'].includes(value)) return 'affection'
  if (value && ['血亲', '亲属'].includes(value)) return 'kinship'
  if (value && ['挚友', '朋友'].includes(value)) return 'friend'
  return 'unknown'
}

function readPositions(bookId: string): Positions {
  try {
    const raw = localStorage.getItem(storageKey(bookId))
    if (!raw || raw.length > 300_000) return {}
    const value = JSON.parse(raw)
    if (value?.version !== 1 || value.bookId !== bookId || !value.positions || typeof value.positions !== 'object' || Array.isArray(value.positions)) return {}
    return Object.fromEntries(Object.entries(value.positions).slice(-MAX_POSITIONS).filter((entry): entry is [string, Position] => {
      const point = entry[1] as Position | null
      return /^(knowledge|story):[a-zA-Z0-9-]+$/.test(entry[0]) && point !== null && typeof point === 'object' &&
        Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    }))
  } catch { return {} }
}

export function RelationshipCanvas({ api, bookId, bookRevision, nodes, edges, selected, disabled, picking, chosen, kindLabels, roleLabels, onSelect, onConnect, onScan }: Props) {
  const portraits = useSavedPortraits(api, bookId, bookRevision)
  const [positions, setPositions] = useState<Positions>(() => readPositions(bookId))
  const [notice, setNotice] = useState<string | null>(null)
  const [connectMode, setConnectMode] = useState(false)
  const [line, setLine] = useState<{ from: string; point: Position } | null>(null)
  const connection = useRef<{ pointerId: number; from: string } | null>(null)
  const [keyboardFrom, setKeyboardFrom] = useState<string | null>(null)
  const [layer, setLayer] = useState<'all' | 'surface' | 'hidden' | 'unmarked'>('all')
  const [storyOrder, setStoryOrder] = useState<number | null>(null)
  const [hideInactive, setHideInactive] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [choosing, setChoosing] = useState<{ from: GalaxyNode; to: GalaxyNode; center: Position } | null>(null)
  const positionRef = useRef(positions)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const svg = useRef<SVGSVGElement>(null)
  const picker = useRef<HTMLDialogElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const pan = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const helpId = useId()
  const arrowId = `relationship-arrow-${helpId.replace(/[^a-zA-Z0-9_-]/gu, '')}`
  const selectedKey = selected ? galaxyKey(selected) : null
  const completeRelations = useMemo(() => new Set(nodes.filter((node) => node.kind === 'relation' &&
    ['relation_from', 'relation_to'].every((role) => edges.some((edge) => galaxyKey(edge.from) === galaxyKey(node) && edge.role === role && edge.to.source === 'knowledge'))).map(galaxyKey)), [nodes, edges])
  const badges = useMemo(() => nodes.filter((node) => (node.source === 'knowledge' || node.kind === 'relation') && !completeRelations.has(galaxyKey(node))), [nodes, completeRelations])
  const height = Math.max(640, Math.ceil(badges.length / 12) * 640)
  const points = useMemo(() => new Map(badges.map((node, index) => {
    const key = galaxyKey(node)
    const normalized = positions[key]
    const ring = Math.floor(index / 12), count = Math.min(12, badges.length - ring * 12)
    const angle = -Math.PI * .66 + index % 12 / count * Math.PI * 2
    return [key, normalized ? { x: normalized.x * (WIDTH - NODE_WIDTH), y: normalized.y * (height - NODE_HEIGHT) }
      : { x: WIDTH / 2 + Math.cos(angle) * 380 - NODE_WIDTH / 2, y: ring * 640 + 320 + Math.sin(angle) * 230 - NODE_HEIGHT / 2 }]
  })), [badges, positions, height])
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [galaxyKey(node), node])), [nodes])
  function relationStatus(node: GalaxyNode): 'active' | 'inactive' | 'unknown' {
    const from = node.relationTime?.from, until = node.relationTime?.until
    if (storyOrder === null || !from || !until || from.kind === 'unknown' || from.order === null || until.kind !== 'unknown' && until.order === null ||
      node.authorDecision !== 'adopted' || node.freshness !== 'current' || !['clear', 'explained'].includes(node.conflictState)) return 'unknown'
    return storyOrder < from.order || until.kind !== 'unknown' && until.order !== null && storyOrder >= until.order ? 'inactive' : 'active'
  }
  const orders = nodes.flatMap((node) => [node.relationTime?.from, node.relationTime?.until].flatMap((time) => time && time.kind !== 'unknown' && time.order !== null ? [time.order] : []))
  const orderMin = Math.min(...orders), orderMax = Math.max(...orders)
  const visibleNodes = nodes.filter((node) => node.kind !== 'relation' ||
    (layer === 'all' || (layer === 'unmarked' ? node.relationLayer === undefined : node.relationLayer === layer)) && (!hideInactive || relationStatus(node) !== 'inactive'))
  const visibleKeys = new Set(visibleNodes.map(galaxyKey))
  const relations = visibleNodes.filter((node) => node.source === 'story' && node.kind === 'relation')
  const visibleBadges = visibleNodes.filter((node) => points.has(galaxyKey(node)))
  const visibleBounds = useRef({ left: 0, top: 0, right: WIDTH, bottom: height })
  const [bounds, setBounds] = useState(visibleBounds.current)
  function measureViewport() {
    const element = viewport.current, stage = svg.current
    if (!element || !stage) return
    const matrix = stage.getScreenCTM()
    if (!matrix) return
    const rect = element.getBoundingClientRect(), point = stage.createSVGPoint()
    point.x = rect.left; point.y = rect.top
    const from = point.matrixTransform(matrix.inverse())
    point.x = rect.right; point.y = rect.bottom
    const to = point.matrixTransform(matrix.inverse())
    visibleBounds.current = { left: from.x - NODE_WIDTH, top: from.y - NODE_HEIGHT, right: to.x + NODE_WIDTH, bottom: to.y + NODE_HEIGHT }
    setBounds(visibleBounds.current)
  }
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(measureViewport)
    observer.observe(element); measureViewport()
    return () => observer.disconnect()
  }, [zoom, height, nodes])
  useEffect(() => {
    if (!choosing) return
    const previous = document.activeElement
    picker.current?.showModal()
    return () => { if (previous instanceof HTMLElement || previous instanceof SVGElement) if (previous.isConnected) previous.focus() }
  }, [choosing])
  useEffect(() => { if (disabled || picking) setChoosing(null) }, [disabled, picking])
  function chooseConnection(fromKey: string, to: GalaxyNode) {
    const from = nodeMap.get(fromKey)
    if (!from || from.source !== 'knowledge' || to.source !== 'knowledge' || from.id === to.id || disabled || picking || !onConnect) return
    const rect = viewport.current?.getBoundingClientRect()
    // 选择器围绕可见画布定位；原生 dialog 只接管焦点，不遮住关系端点。
    const center = { x: rect ? (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2 : innerWidth / 2,
      y: rect ? (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2 : innerHeight / 2 }
    setConnectMode(false); setKeyboardFrom(null); setChoosing({ from, to, center })
  }

  function update(next: Positions) { positionRef.current = next; setPositions(next) }
  function persist(next: Positions) {
    // 布局仅存本书的坐标偏好；不保存名称、草稿，也不调用任何领域写入 API。
    const bounded = Object.fromEntries(Object.entries(next).slice(-MAX_POSITIONS))
    update(bounded)
    try {
      localStorage.setItem(storageKey(bookId), JSON.stringify({ version: 1, bookId, positions: bounded }))
      setNotice('本书布局偏好已保存。')
    } catch { setNotice('布局偏好未能持久保存，当前画布仍可使用。') }
  }
  function move(key: string, point: Position, save = false) {
    const next = { ...positionRef.current }
    delete next[key]
    next[key] = { x: clamp(point.x, WIDTH - NODE_WIDTH) / (WIDTH - NODE_WIDTH), y: clamp(point.y, height - NODE_HEIGHT) / (height - NODE_HEIGHT) }
    if (save) persist(next)
    else update(next)
  }
  function cancelDrag() {
    connection.current = null; setLine(null)
    const current = drag.current
    drag.current = null
    if (current?.moved) { suppressClick.current = true; move(current.key, current.original) }
  }
  useEffect(() => { if (disabled || picking || !onConnect) { cancelDrag(); setConnectMode(false); setKeyboardFrom(null) } }, [disabled, picking, Boolean(onConnect)])

  function coordinate(event: PointerEvent<SVGGElement>): Position | null {
    const matrix = svg.current?.getScreenCTM()
    if (!matrix || !svg.current) return null
    const point = svg.current.createSVGPoint()
    point.x = event.clientX; point.y = event.clientY
    return point.matrixTransform(matrix.inverse())
  }
  function pointerDown(event: PointerEvent<SVGGElement>, key: string) {
    if (disabled || event.button !== 0 || !event.isPrimary || drag.current) return
    const start = coordinate(event), original = points.get(key)
    if (!start || !original) return
    if (connectMode) {
      if (!onConnect || picking || !key.startsWith('knowledge:')) return
      connection.current = { pointerId: event.pointerId, from: key }
      setLine({ from: key, point: start }); suppressClick.current = true
      event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus()
      return
    }
    suppressClick.current = false
    drag.current = { pointerId: event.pointerId, key, start, original, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
  }
  function pointerMove(event: PointerEvent<SVGGElement>) {
    if (connection.current?.pointerId === event.pointerId && !disabled) {
      const point = coordinate(event)
      if (point) setLine({ from: connection.current.from, point })
      return
    }
    const current = drag.current, point = coordinate(event)
    if (!current || current.pointerId !== event.pointerId || !point || disabled) return
    const dx = point.x - current.start.x, dy = point.y - current.start.y
    if (!current.moved && Math.hypot(dx, dy) < 5) return
    current.moved = true
    move(current.key, { x: current.original.x + dx, y: current.original.y + dy })
  }
  function pointerUp(event: PointerEvent<SVGGElement>) {
    const linking = connection.current
    if (linking?.pointerId === event.pointerId) {
      const point = coordinate(event)
      connection.current = null; setLine(null); suppressClick.current = true
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      const target = point && visibleBadges.find((node) => {
        const key = galaxyKey(node), position = points.get(key)!
        return node.source === 'knowledge' && key !== linking.from && point.x >= position.x && point.x <= position.x + NODE_WIDTH && point.y >= position.y && point.y <= position.y + NODE_HEIGHT
      })
      if (target && !disabled && !picking && onConnect) chooseConnection(linking.from, target)
      else setNotice('请从一个知识实体拖到另一个实体，再松开指针。')
      return
    }
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    suppressClick.current = current.moved
    if (current.moved && !disabled) persist(positionRef.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function keyDown(event: KeyboardEvent<SVGGElement>, node: GalaxyNode) {
    if (disabled) return
    if (event.key === 'Escape') { cancelDrag(); setConnectMode(false); setKeyboardFrom(null); return }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (connectMode && onConnect && node.source === 'knowledge') {
        if (!keyboardFrom) { setKeyboardFrom(node.id); setNotice(`已选起点“${node.title}”，请聚焦终点后按 Enter。`) }
        else if (keyboardFrom !== node.id) chooseConnection(`knowledge:${keyboardFrom}`, node)
        return
      }
      if (!picking || node.source === 'knowledge') onSelect(node)
      return
    }
    const directions: Record<string, Position> = { ArrowLeft: { x: -16, y: 0 }, ArrowRight: { x: 16, y: 0 }, ArrowUp: { x: 0, y: -16 }, ArrowDown: { x: 0, y: 16 } }
    const delta = directions[event.key], key = galaxyKey(node), point = points.get(key)
    if (!delta || !point) return
    event.preventDefault(); move(key, { x: point.x + delta.x, y: point.y + delta.y }, true)
  }
  function endpoint(node: GalaxyNode, role: GalaxyRole) {
    const edge = edges.find((item) => galaxyKey(item.from) === galaxyKey(node) && item.role === role && item.to.source === 'knowledge')
    return edge ? nodeMap.get(galaxyKey(edge.to))?.title ?? '本页未显示' : '本页未显示'
  }

  return <section className={styles.canvas} aria-label="关系星网画布" onKeyDown={(event) => {
    if (event.key === 'Escape' && (connectMode || line)) {
      event.preventDefault(); event.stopPropagation(); cancelDrag(); setConnectMode(false); setKeyboardFrom(null)
    }
  }}>
    <div className={styles.relationshipToolbar}>
      <div className={styles.layerTabs} role="group" aria-label="关系层次">{([['surface', '表面关系'], ['hidden', '隐藏事实']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={layer === value} disabled={disabled || picking || connectMode} onClick={() => setLayer(value)}>{label}</button>)}
        <select aria-label="全部或未标注关系" value={layer === 'all' || layer === 'unmarked' ? layer : ''} disabled={disabled || picking || connectMode} onChange={(event) => { if (event.target.value === 'all' || event.target.value === 'unmarked') setLayer(event.target.value) }}>
          <option value="" disabled>更多</option><option value="all">全部</option><option value="unmarked">未标注</option>
        </select>
      </div>
      <div className={styles.storyControls}>
      <label className={styles.storyPoint}>故事时点<input type="number" aria-label="关系故事时点" min={-1000000000} max={1000000000} step={1} value={storyOrder ?? ''} placeholder="未知" disabled={disabled || connectMode || picking} onChange={(event) => {
        if (!event.target.value) setStoryOrder(null)
        else if (Number.isSafeInteger(event.target.valueAsNumber) && Math.abs(event.target.valueAsNumber) <= 1_000_000_000) setStoryOrder(event.target.valueAsNumber)
      }} /></label>
      <input className={styles.storySlider} aria-label="浏览本页已登记关系时间" type="range" min={orders.length ? orderMin : 0} max={orders.length && orderMin < orderMax ? orderMax : 1} step={1} value={storyOrder === null || !orders.length ? orders.length ? orderMin : 0 : Math.max(orderMin, Math.min(orderMax, storyOrder))} disabled={disabled || picking || connectMode || !orders.length || orderMin === orderMax} title={orders.length > 1 && orderMin < orderMax ? '按已登记的明确排序值浏览' : '本页没有可浏览的明确时间范围'} onChange={(event) => setStoryOrder(event.target.valueAsNumber)} />
      </div>
      <button type="button" className={styles.scanButton} disabled={disabled || picking || !onScan} title={onScan ? '准备正文关系提炼任务，确认后才发送' : '先打开已保存章节并解除归档'} onClick={onScan}><StudioIcon name="spark" size={20} />扫描正文补全关系</button>
    </div>
    {(connectMode || picking) && <p className={styles.help} role="status">{connectMode ? '选择关系起点和终点；可拖线，或依次聚焦两端按 Enter。Esc 退出。' : '请选择关系两端。'}</p>}
    <div className={styles.relationshipViewportShell}>
    <div className={styles.relationshipActions}>
      {onConnect && <button type="button" className={shared.button} aria-pressed={connectMode} disabled={disabled || picking} onClick={() => { cancelDrag(); setKeyboardFrom(null); setConnectMode(!connectMode) }}><StudioIcon name={connectMode ? 'close' : 'workflow'} size={20} />{connectMode ? '退出连线' : '建立关系'}</button>}
      <label><input type="checkbox" checked={hideInactive} disabled={disabled || picking || connectMode} onChange={(event) => setHideInactive(event.target.checked)} />隐藏已失效关系</label>
      <span>{visibleBadges.length} 个对象 · {relations.length} 条关系</span>
      <div className={styles.zoomButtons}>
        <button type="button" disabled={disabled || zoom <= .5 || connectMode} aria-label="缩小关系星网" title="缩小" onClick={() => setZoom((value) => Math.max(.5, value - .25))}><StudioIcon name="minus" size={20} /></button>
        <output aria-label="关系星网缩放比例">{Math.round(zoom * 100)}%</output>
        <button type="button" disabled={disabled || zoom >= 2 || connectMode} aria-label="放大关系星网" title="放大" onClick={() => setZoom((value) => Math.min(2, value + .25))}><StudioIcon name="plus" size={20} /></button>
        <button type="button" disabled={disabled || connectMode} aria-label="重排关系星网" title="重排本页布局" onClick={() => { const next = { ...positionRef.current }; for (const node of nodes) delete next[galaxyKey(node)]; persist(next); setZoom(1) }}><StudioIcon name="focus" size={20} /></button>
      </div>
    </div>
    <div ref={viewport} className={styles.relationshipViewport} tabIndex={0} aria-label="关系星网，可拖动画布及滚动" onScroll={measureViewport}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0 || !(event.target instanceof Element) || event.target.closest('[role="button"]') || !viewport.current) return
        pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.current.scrollLeft, top: viewport.current.scrollTop }
        event.currentTarget.setPointerCapture(event.pointerId)
      }} onPointerMove={(event) => {
        const current = pan.current
        if (!current || current.pointerId !== event.pointerId || !viewport.current) return
        viewport.current.scrollLeft = current.left - (event.clientX - current.x); viewport.current.scrollTop = current.top - (event.clientY - current.y)
      }} onPointerUp={(event) => { pan.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={() => { pan.current = null }}>
      {!visibleBadges.length && <p className={styles.help}>当前页尚无符合条件的人物、势力或关系端点，请调整筛选或翻页。</p>}
      <svg ref={svg} width={WIDTH} height={height} style={{ width: `${zoom * 100}%`, height: `${zoom * 100 * Math.max(1, Math.ceil(badges.length / 12))}%` }} viewBox={`0 0 ${WIDTH} ${height}`} className={styles.relationshipStage} role="group" aria-label="本页对象与命名关系">
        <defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" fill="none" stroke="context-stroke" strokeWidth="1.5" /></marker></defs>
        <g className={styles.relationshipOrbits} aria-hidden="true"><ellipse cx={500} cy={320} rx={470} ry={292} /><ellipse cx={500} cy={320} rx={482} ry={268} transform="rotate(-16 500 320)" /></g>
        <g aria-hidden="true">{edges.map((edge) => {
          if (!visibleKeys.has(galaxyKey(edge.from)) || !visibleKeys.has(galaxyKey(edge.to))) return null
          const a = points.get(galaxyKey(edge.from)), b = points.get(galaxyKey(edge.to))
          if (!a || !b) return null
          const active = galaxyKey(edge.from) === selectedKey || galaxyKey(edge.to) === selectedKey
          const relation = edge.role === 'relation_from' || edge.role === 'relation_to'
          const source = nodeMap.get(galaxyKey(edge.from)), status = source?.kind === 'relation' && storyOrder !== null ? relationStatus(source) : undefined
          const x1 = a.x + NODE_WIDTH / 2, y1 = a.y + 50, x2 = b.x + NODE_WIDTH / 2, y2 = b.y + 50
          // 页外端点使关系回退为引用连线时，仍沿用同一关系记录的颜色与层次。
          return <g key={edge.id} className={relation ? styles.relationReference : undefined} data-tone={relation ? relationTone(source?.relationType) : undefined}
            data-layer={relation ? source?.relationLayer : undefined} data-conflict={relation && source?.conflictState === 'candidate'} data-state={status} data-selected={active}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} className={active || relation ? styles.relationEdge : styles.edge} data-state={status} />
            {(relation || active) && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} className={styles.edgeLabel} textAnchor="middle">{roleLabels[edge.role]}</text>}</g>
        })}</g>
        {relations.filter((node) => completeRelations.has(galaxyKey(node))).map((node, index) => {
          const from = edges.find((edge) => galaxyKey(edge.from) === galaxyKey(node) && edge.role === 'relation_from')
          const to = edges.find((edge) => galaxyKey(edge.from) === galaxyKey(node) && edge.role === 'relation_to')
          const a = from && points.get(galaxyKey(from.to)), b = to && points.get(galaxyKey(to.to))
          if (!a || !b) return null
          const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy) || 1
          const start = { x: a.x + 60 + dx / distance * 46, y: a.y + 50 + dy / distance * 46 }
          const end = { x: b.x + 60 - dx / distance * 46, y: b.y + 50 - dy / distance * 46 }
          const offset = (index % 3 - 1) * 24, cx = (start.x + end.x) / 2 - dy / distance * offset, cy = (start.y + end.y) / 2 + dx / distance * offset
          const label = node.relationType || node.title, labelWidth = Math.min(244, Array.from(label).length * 13 + 24)
          return <g key={galaxyKey(node)} className={styles.namedRelation} data-tone={relationTone(node.relationType)} data-layer={node.relationLayer} data-conflict={node.conflictState === 'candidate'} data-state={storyOrder === null ? undefined : relationStatus(node)} data-selected={galaxyKey(node) === selectedKey}>
            <path d={`M${start.x} ${start.y} Q${cx} ${cy} ${end.x} ${end.y}`} markerEnd={`url(#${arrowId})`} markerStart={node.relationDirection === 'mutual' ? `url(#${arrowId})` : undefined} />
            <g transform={`translate(${(start.x + 2 * cx + end.x) / 4} ${(start.y + 2 * cy + end.y) / 4})`} role="button" tabIndex={disabled || picking ? -1 : 0} aria-label={`关系：${node.title}，${label}${node.relationLayer === 'hidden' ? '，隐藏关系' : ''}`} aria-disabled={disabled || picking} onClick={() => { if (!disabled && !picking) onSelect(node) }} onKeyDown={(event) => { if (['Enter', ' '].includes(event.key) && !disabled && !picking) { event.preventDefault(); onSelect(node) } }}>
              <title>{node.title}{node.conflictState === 'candidate' ? ' · 存在候选冲突' : ''}</title><rect x={-labelWidth / 2} y={-16} width={labelWidth} height={32} rx={8} /><text textAnchor="middle" y={5}>{Array.from(label).slice(0, 16).join('')}{Array.from(label).length > 16 ? '…' : ''}</text>
            </g>
          </g>
        })}
        {line && points.has(line.from) && <line x1={points.get(line.from)!.x + NODE_WIDTH / 2} y1={points.get(line.from)!.y + 50} x2={line.point.x} y2={line.point.y} className={styles.relationEdge} strokeDasharray="6 4" pointerEvents="none" aria-hidden="true" />}
        {visibleBadges.map((node) => {
          const key = galaxyKey(node), point = points.get(key)!
          // 视口外节点保留坐标及连线；聚焦对象仍渲染，避免键盘移动时丢失焦点。
          if ((point.x > bounds.right || point.y > bounds.bottom || point.x + NODE_WIDTH < bounds.left || point.y + NODE_HEIGHT < bounds.top) && key !== selectedKey && svg.current?.querySelector(`[data-node-key="${key}"]`) !== document.activeElement) return null
          const chosenIndex = node.source === 'knowledge' ? chosen.indexOf(node.id) : -1
          const title = Array.from(node.title)
          const displayTitle = title.length > 8 ? `${title.slice(0, 8).join('')}…` : node.title
          return <g key={key} transform={`translate(${point.x} ${point.y})`} tabIndex={disabled ? -1 : 0} role="button"
            aria-label={`${kindLabels[node.kind]}：${node.title}${chosenIndex >= 0 ? chosenIndex === 0 ? '，已选起点' : '，已选终点' : ''}`}
            aria-disabled={disabled || picking && node.source !== 'knowledge'} aria-pressed={key === selectedKey || chosenIndex >= 0}
            className={styles.badge} data-node-key={key} data-kind={node.kind} data-layer={node.relationLayer} data-conflict={node.conflictState === 'candidate'} data-chosen={chosenIndex >= 0} data-rejected={node.authorDecision === 'rejected'}
            onPointerDown={(event) => pointerDown(event, key)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
            onKeyDown={(event) => keyDown(event, node)} onClick={() => {
              if (suppressClick.current) { suppressClick.current = false; return }
              if (!disabled && !connectMode && (!picking || node.source === 'knowledge')) onSelect(node)
            }}>
            <title>{node.title} · {kindLabels[node.kind]}{node.authorDecision === 'rejected' ? ' · 作者已否决' : ''}</title>
            {node.kind === 'organization' ? <path className={styles.badgeFrame} d="M60 4 102 22 102 70 60 96 18 70 18 22Z" /> : <circle className={styles.badgeFrame} cx={60} cy={50} r={46} />}
            {node.kind === 'person' && portraits.items.some((item) => item.personId === node.id)
              ? <foreignObject x={16} y={6} width={88} height={88} pointerEvents="none"><SavedPortrait api={api} bookId={bookId} personId={node.id} metadata={portraits.items.find((item) => item.personId === node.id)} name={node.title} className={styles.badgePortrait} fallback={title.slice(0, 1).join('')} /></foreignObject>
              : <text x={60} y={60} textAnchor="middle" className={styles.badgeInitial}>{title.slice(0, 1).join('')}</text>}
            <rect x={0} y={91} width={NODE_WIDTH} height={28} rx={14} className={styles.badgeNameplate} />
            <text x={60} y={110} textAnchor="middle" className={styles.nodeTitle}>{displayTitle}</text>
            <text x={60} y={136} textAnchor="middle" className={styles.nodeKind}>{chosenIndex >= 0 ? chosenIndex === 0 ? '关系起点' : '关系终点' : kindLabels[node.kind]}{node.authorDecision === 'rejected' ? ' · 已否决' : ''}</text>
          </g>
        })}
      </svg>
    </div>
    <div className={styles.relationshipLegend} aria-label="关系类型图例">{relationChoices.filter((item) => ['mentor', 'enemy', 'ally', 'affection'].includes(item.tone)).map((item) => <span key={item.label} data-tone={item.tone}><i />{item.label}</span>)}<span data-tone="unknown"><i />未知</span><span data-layer="hidden"><i />隐藏关系</span></div></div>
    {notice && <p className={styles.help} role="status">{notice}</p>}
    {portraits.error && <p className={styles.help} role="status">{portraits.error}</p>}
    <details className={styles.relations}><summary>本页关系与时间范围 · {relations.length}</summary>
      <p className={styles.help}>有效期包含起点、不含截止；未登记时间或待复核时保持未知。仅显示本页登记引用。</p>
      <p className={styles.help}>名称取自已登记的关系记录；起点与终点为引用角色，方向和有效期请点选查看详情。页外端点需聚焦该关系查看。</p>
      {relations.length ? <ul>{relations.map((node) => <li key={node.id}>
        <button type="button" className={styles.relationName} disabled={disabled || picking} onClick={() => onSelect(node)}>{node.title}</button>
        <span>起点：{endpoint(node, 'relation_from')} · 终点：{endpoint(node, 'relation_to')}{storyOrder === null ? '' : relationStatus(node) === 'active' ? ' · 此时有效' : relationStatus(node) === 'inactive' ? ' · 此时失效' : ' · 此时有效性未知'}{node.authorDecision === 'rejected' ? ' · 作者已否决' : ''}</span>
      </li>)}</ul> : <p className={styles.help}>当前页没有关系记录。可切换对象范围，或选两个知识实体新建关系。</p>}
    </details>
    {choosing && <dialog ref={picker} className={styles.relationPicker} style={{ left: `clamp(var(--space-4), ${choosing.center.x - 168}px, calc(100dvw - 336px - var(--space-4)))`, top: `clamp(var(--space-4), ${choosing.center.y - 168}px, calc(100dvh - 336px - var(--space-4)))` }} aria-label={`选择${choosing.from.title}与${choosing.to.title}的关系类型`} onCancel={(event) => { event.preventDefault(); setChoosing(null) }}>
      <div className={styles.pickerWheel}><svg viewBox="0 0 336 336" aria-hidden="true"><circle cx={168} cy={168} r={166} /><circle cx={168} cy={168} r={58} />{relationChoices.map((item, index) => { const angle = -Math.PI / 2 + (index - .5) / 7 * Math.PI * 2; return <path key={item.label} d={`M${168 + Math.cos(angle) * 58} ${168 + Math.sin(angle) * 58} L${168 + Math.cos(angle) * 166} ${168 + Math.sin(angle) * 166}`} /> })}</svg>
        {relationChoices.map((item, index) => { const angle = -Math.PI / 2 + index / 7 * Math.PI * 2; return <button type="button" key={item.label} data-tone={item.tone} style={{ left: `${50 + Math.cos(angle) * 100 / 3}%`, top: `${50 + Math.sin(angle) * 100 / 3}%` }} onClick={() => { const choice = choosing; setChoosing(null); if (!disabled && !picking) onConnect?.(choice.from.id, choice.to.id, item.label === '其他' ? undefined : item.label) }}><StudioIcon name={item.icon} size={24} /><span>{item.label}</span></button> })}
        <button type="button" className={styles.pickerClose} aria-label="取消建立关系" title="取消" onClick={() => setChoosing(null)}><StudioIcon name="spark" size={40} /></button>
      </div>
    </dialog>}
  </section>
}
