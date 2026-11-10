import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { galaxyKey, type GalaxyEdge, type GalaxyKind, type GalaxyNode, type GalaxyRole, type GalaxyTarget } from '../../contracts/story-galaxy'
import shared from '../App.module.css'
import styles from './RelationshipCanvas.module.css'

interface Props {
  bookId: string
  nodes: GalaxyNode[]
  edges: GalaxyEdge[]
  selected: GalaxyTarget | null
  disabled: boolean
  picking: boolean
  chosen: string[]
  kindLabels: Record<GalaxyKind, string>
  roleLabels: Record<GalaxyRole, string>
  onSelect: (target: GalaxyTarget) => void
  onConnect?: (fromEntityId: string, toEntityId: string) => void
}
interface Position { x: number; y: number }
type Positions = Record<string, Position>
interface Drag { pointerId: number; key: string; start: Position; original: Position; moved: boolean }
const WIDTH = 1000
const NODE_WIDTH = 186
const NODE_HEIGHT = 56
const MAX_POSITIONS = 2000
const storageKey = (bookId: string) => `storyweave.relationship-layout.v1:${bookId}`
const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value))

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

export function RelationshipCanvas({ bookId, nodes, edges, selected, disabled, picking, chosen, kindLabels, roleLabels, onSelect, onConnect }: Props) {
  const [positions, setPositions] = useState<Positions>(() => readPositions(bookId))
  const [notice, setNotice] = useState<string | null>(null)
  const [connectMode, setConnectMode] = useState(false)
  const [line, setLine] = useState<{ from: string; point: Position } | null>(null)
  const connection = useRef<{ pointerId: number; from: string } | null>(null)
  const [keyboardFrom, setKeyboardFrom] = useState<string | null>(null)
  const [layer, setLayer] = useState<'all' | 'surface' | 'hidden' | 'unmarked'>('all')
  const [storyOrder, setStoryOrder] = useState<number | null>(null)
  const [hideInactive, setHideInactive] = useState(false)
  const positionRef = useRef(positions)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const svg = useRef<SVGSVGElement>(null)
  const helpId = useId()
  const height = Math.max(420, Math.ceil(nodes.length / 4) * 112 + 32)
  const selectedKey = selected ? galaxyKey(selected) : null
  const points = useMemo(() => new Map(nodes.map((node, index) => {
    const key = galaxyKey(node)
    const normalized = positions[key]
    return [key, normalized ? { x: normalized.x * (WIDTH - NODE_WIDTH), y: normalized.y * (height - NODE_HEIGHT) }
      : { x: 32 + index % 4 * 246, y: 24 + Math.floor(index / 4) * 112 }]
  })), [nodes, positions, height])
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
      const target = point && nodes.find((node) => {
        const key = galaxyKey(node), position = points.get(key)!
        return node.source === 'knowledge' && key !== linking.from && point.x >= position.x && point.x <= position.x + NODE_WIDTH && point.y >= position.y && point.y <= position.y + NODE_HEIGHT
      })
      if (target && !disabled && !picking && onConnect) { setConnectMode(false); setKeyboardFrom(null); onConnect(linking.from.slice('knowledge:'.length), target.id) }
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
        else if (keyboardFrom !== node.id) { onConnect(keyboardFrom, node.id); setConnectMode(false); setKeyboardFrom(null) }
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

  return <section className={styles.canvas} aria-label="二维关系画布">
    <div className={styles.toolbar}><span>知识实体 · 命名关系 · 已登记引用</span>
      <label className={styles.layerFilter}>本页关系层次<select value={layer} disabled={disabled || picking || connectMode} onChange={(event) => setLayer(event.target.value as typeof layer)}><option value="all">全部</option><option value="surface">表面关系</option><option value="hidden">隐藏关系</option><option value="unmarked">未标注</option></select></label>
      {onConnect && <button type="button" className={shared.button} aria-pressed={connectMode} disabled={disabled || picking} onClick={() => { cancelDrag(); setKeyboardFrom(null); setConnectMode(!connectMode) }}>{connectMode ? '退出连线模式' : '拖线建立关系'}</button>}
      <button type="button" className={shared.button} disabled={disabled || connectMode} onClick={() => {
      const next = { ...positionRef.current }
      for (const node of nodes) delete next[galaxyKey(node)]
      persist(next)
    }}>重排本页布局</button></div>
    <p id={helpId} className={styles.help}>{connectMode ? '从起点实体拖到终点实体后松开，填写关系并确认保存。键盘可依次聚焦两端并按 Enter，Esc 退出。' : picking ? '依次点选两个知识实体，或使用起点与终点选择框。' : '点选查看详情；拖动节点调整位置，聚焦节点后也可用方向键移动。布局仅为本书偏好。'}</p>
    <div className={styles.timeControls}>
      <label>故事时点<input type="number" min={-1000000000} max={1000000000} step={1} value={storyOrder ?? ''} placeholder="明确排序值" disabled={disabled || connectMode || picking} onChange={(event) => {
        if (!event.target.value) setStoryOrder(null)
        else if (Number.isSafeInteger(event.target.valueAsNumber) && Math.abs(event.target.valueAsNumber) <= 1_000_000_000) setStoryOrder(event.target.valueAsNumber)
      }} /></label>
      {orders.length > 1 && orderMin < orderMax && <label>浏览本页已登记时间<input type="range" min={orderMin} max={orderMax} step={1} value={storyOrder === null ? orderMin : Math.max(orderMin, Math.min(orderMax, storyOrder))} disabled={disabled || picking || connectMode} onChange={(event) => setStoryOrder(event.target.valueAsNumber)} /></label>}
      <label><input type="checkbox" checked={hideInactive} disabled={disabled || picking || connectMode} onChange={(event) => setHideInactive(event.target.checked)} />隐藏该时点已失效关系</label>
    </div>
    <p className={styles.help}>有效区间包含起点、不含截止。缺少明确时间或复核的关系显示未知，不按章节号推断故事时点；筛选只影响本页。</p>
    <div className={styles.viewport} tabIndex={0} aria-label="关系画布，可横向和纵向滚动">
      <svg ref={svg} width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`} className={styles.stage} role="group" aria-label="本页对象与命名关系" aria-describedby={helpId}>
        <g aria-hidden="true">{edges.map((edge) => {
          if (!visibleKeys.has(galaxyKey(edge.from)) || !visibleKeys.has(galaxyKey(edge.to))) return null
          const a = points.get(galaxyKey(edge.from)), b = points.get(galaxyKey(edge.to))
          if (!a || !b) return null
          const active = galaxyKey(edge.from) === selectedKey || galaxyKey(edge.to) === selectedKey
          const relation = edge.role === 'relation_from' || edge.role === 'relation_to'
          const source = nodeMap.get(galaxyKey(edge.from)), status = source?.kind === 'relation' && storyOrder !== null ? relationStatus(source) : undefined
          const x1 = a.x + NODE_WIDTH / 2, y1 = a.y + NODE_HEIGHT / 2, x2 = b.x + NODE_WIDTH / 2, y2 = b.y + NODE_HEIGHT / 2
          return <g key={edge.id}><line x1={x1} y1={y1} x2={x2} y2={y2} className={active || relation ? styles.relationEdge : styles.edge} data-state={status} />
            {(relation || active) && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} className={styles.edgeLabel} textAnchor="middle">{roleLabels[edge.role]}</text>}</g>
        })}</g>
        {line && points.has(line.from) && <line x1={points.get(line.from)!.x + NODE_WIDTH / 2} y1={points.get(line.from)!.y + NODE_HEIGHT / 2} x2={line.point.x} y2={line.point.y} className={styles.relationEdge} strokeDasharray="6 4" pointerEvents="none" aria-hidden="true" />}
        {visibleNodes.map((node) => {
          const key = galaxyKey(node), point = points.get(key)!
          const chosenIndex = node.source === 'knowledge' ? chosen.indexOf(node.id) : -1
          const title = Array.from(node.title)
          const displayTitle = title.length > 11 ? `${title.slice(0, 11).join('')}…` : node.title
          return <g key={key} transform={`translate(${point.x} ${point.y})`} tabIndex={disabled ? -1 : 0} role="button"
            aria-label={`${kindLabels[node.kind]}：${node.title}${chosenIndex >= 0 ? chosenIndex === 0 ? '，已选起点' : '，已选终点' : ''}`}
            aria-disabled={disabled || picking && node.source !== 'knowledge'} aria-pressed={key === selectedKey || chosenIndex >= 0}
            className={styles.node} data-relation={node.kind === 'relation'} data-layer={node.relationLayer} data-state={node.kind === 'relation' && storyOrder !== null ? relationStatus(node) : undefined} data-chosen={chosenIndex >= 0} data-rejected={node.authorDecision === 'rejected'}
            onPointerDown={(event) => pointerDown(event, key)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
            onKeyDown={(event) => keyDown(event, node)} onClick={() => {
              if (suppressClick.current) { suppressClick.current = false; return }
              if (!disabled && !connectMode && (!picking || node.source === 'knowledge')) onSelect(node)
            }}>
            <title>{node.title} · {kindLabels[node.kind]}{node.authorDecision === 'rejected' ? ' · 作者已否决' : ''}</title>
            <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={8} />
            <text x={14} y={22} className={styles.nodeTitle}>{displayTitle}</text>
            <text x={14} y={42} className={styles.nodeKind}>{chosenIndex >= 0 ? chosenIndex === 0 ? '① 关系起点' : '② 关系终点' : node.relationLayer === 'surface' ? '表面关系' : node.relationLayer === 'hidden' ? '隐藏关系' : kindLabels[node.kind]}{node.authorDecision === 'rejected' ? ' · 已否决' : ''}</text>
          </g>
        })}
      </svg>
    </div>
    {notice && <p className={styles.help} role="status">{notice}</p>}
    <div className={styles.relations}><h4>本页命名关系 · {relations.length}</h4>
      <p className={styles.help}>名称取自已登记的关系记录；起点与终点为引用角色，方向和有效期请点选查看详情。页外端点需聚焦该关系查看。</p>
      {relations.length ? <ul>{relations.map((node) => <li key={node.id}>
        <button type="button" className={styles.relationName} disabled={disabled || picking} onClick={() => onSelect(node)}>{node.title}</button>
        <span>起点：{endpoint(node, 'relation_from')} · 终点：{endpoint(node, 'relation_to')}{storyOrder === null ? '' : relationStatus(node) === 'active' ? ' · 此时有效' : relationStatus(node) === 'inactive' ? ' · 此时失效' : ' · 此时有效性未知'}{node.authorDecision === 'rejected' ? ' · 作者已否决' : ''}</span>
      </li>)}</ul> : <p className={styles.help}>当前页没有关系记录。可切换对象范围，或选两个知识实体新建关系。</p>}
    </div>
  </section>
}
