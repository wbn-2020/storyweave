import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { galaxyKey, type GalaxyEdge, type GalaxyNode, type GalaxyTarget } from '../../contracts/story-galaxy'
import shared from '../App.module.css'
import styles from './StoryGalaxyView.module.css'

interface Props {
  nodes: GalaxyNode[]
  edges: GalaxyEdge[]
  focus: GalaxyTarget | null
  selected: GalaxyTarget | null
  disabled: boolean
  onSelect: (target: GalaxyTarget) => void
}
interface Point { node: GalaxyNode; key: string; x: number; y: number; z: number; radius: number }
interface View { yaw: number; pitch: number; zoom: number }
interface Drag { id: number; x: number; y: number; view: View; moved: boolean; mouse: boolean }
const INITIAL_VIEW: View = { yaw: 0, pitch: .18, zoom: 1 }
const HEIGHT = 350

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }

export function StoryGalaxyView({ nodes, edges, focus, selected, disabled, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const stage = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const [width, setWidth] = useState(760)
  const [view, setView] = useState<View>(INITIAL_VIEW)
  const [hovered, setHovered] = useState<string | null>(null)
  const focusKey = focus ? galaxyKey(focus) : null
  const selectedKey = selected ? galaxyKey(selected) : null

  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => setWidth(Math.max(200, element.clientWidth))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => { setView(INITIAL_VIEW); setHovered(null); drag.current = null }, [nodes, focusKey])
  useEffect(() => { if (disabled) { drag.current = null; setHovered(null) } }, [disabled])

  const points = useMemo(() => {
    const count = nodes.length - (focusKey && nodes.some((node) => galaxyKey(node) === focusKey) ? 1 : 0)
    const radius = Math.min(width * .34, HEIGHT * .36) * view.zoom
    let index = 0
    // 坐标只用于稳定排布，不编码重要性、因果或时间；中心是作者明确选中的聚焦对象。
    return nodes.map((node): Point => {
      const key = galaxyKey(node)
      if (key === focusKey) return { node, key, x: width / 2, y: HEIGHT / 2, z: 1.1, radius: 9 }
      const vertical = 1 - 2 * (index + .5) / Math.max(1, count)
      const angle = index++ * 2.399963229728653
      const ring = Math.sqrt(Math.max(0, 1 - vertical * vertical))
      const x = Math.cos(angle) * ring
      const z = Math.sin(angle) * ring
      const rotatedX = x * Math.cos(view.yaw) + z * Math.sin(view.yaw)
      const rotatedZ = z * Math.cos(view.yaw) - x * Math.sin(view.yaw)
      const rotatedY = vertical * Math.cos(view.pitch) - rotatedZ * Math.sin(view.pitch)
      const depth = vertical * Math.sin(view.pitch) + rotatedZ * Math.cos(view.pitch)
      const perspective = 1 + depth * .18
      return { node, key, x: width / 2 + rotatedX * radius * perspective,
        y: HEIGHT / 2 + rotatedY * radius * perspective, z: depth, radius: 5.5 + (depth + 1) * 1.2 }
    })
  }, [nodes, focusKey, width, view])
  const pointMap = useMemo(() => new Map(points.map((point) => [point.key, point])), [points])
  const frontToBack = useMemo(() => [...points].sort((a, b) => b.z - a.z), [points])
  const activeKey = hovered ?? selectedKey ?? focusKey
  const related = useMemo(() => {
    const keys = new Set<string>()
    if (!activeKey) return keys
    keys.add(activeKey)
    for (const edge of edges) {
      const from = galaxyKey(edge.from), to = galaxyKey(edge.to)
      if (from === activeKey) keys.add(to)
      if (to === activeKey) keys.add(from)
    }
    return keys
  }, [edges, activeKey])

  const labels = useMemo(() => {
    const chosen: { key: string; text: string; x: number; y: number; width: number }[] = []
    const ordered = [...frontToBack].sort((a, b) => Number(b.key === activeKey) - Number(a.key === activeKey))
    for (const point of ordered) {
      if (chosen.length >= (width < 460 ? 4 : 9)) break
      if (point.x < 10 || point.x > width - 10 || point.y < 10 || point.y > HEIGHT - 10) continue
      const characters = Array.from(point.node.title)
      const text = characters.length > 12 ? `${characters.slice(0, 12).join('')}…` : point.node.title
      const labelWidth = Math.min(width - 16, Array.from(text).length * 12 + 8)
      const x = clamp(point.x > width * .6 ? point.x - labelWidth - 13 : point.x + 13, 8, width - labelWidth - 8)
      const y = clamp(point.y + 4, 18, HEIGHT - 8)
      if (chosen.some((other) => x < other.x + other.width + 5 && x + labelWidth + 5 > other.x && Math.abs(y - other.y) < 20)) continue
      chosen.push({ key: point.key, text, x, y, width: labelWidth })
    }
    return chosen
  }, [frontToBack, activeKey, width])

  function hit(event: PointerEvent<SVGSVGElement>): Point | undefined {
    const bounds = stage.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return
    const x = (event.clientX - bounds.left) * width / bounds.width
    const y = (event.clientY - bounds.top) * HEIGHT / bounds.height
    // 先按绘制遮挡顺序命中可见形状，避免后景中心更近时穿过前景对象。
    for (const point of frontToBack) {
      const dx = Math.abs(point.x - x), dy = Math.abs(point.y - y)
      const inside = point.node.source === 'knowledge'
        ? Math.hypot(dx, dy) <= point.radius
        : dx + dy <= point.radius
      if (inside) return point
    }
    let nearest: Point | undefined
    let distance = 22
    for (const point of frontToBack) {
      const nextDistance = Math.hypot(point.x - x, point.y - y)
      if (nextDistance < distance) { nearest = point; distance = nextDistance }
    }
    return nearest
  }

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (disabled || !event.isPrimary || event.button !== 0) return
    const mouse = event.pointerType === 'mouse'
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view, moved: false, mouse }
    // 触屏保留页面纵向滚动，旋转也可通过按钮操作。
    if (mouse) event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    if (disabled) return
    const saved = drag.current
    if (!saved || saved.id !== event.pointerId) { setHovered(hit(event)?.key ?? null); return }
    const dx = event.clientX - saved.x, dy = event.clientY - saved.y
    if (Math.hypot(dx, dy) > 5) saved.moved = true
    if (saved.mouse && saved.moved) {
      setHovered(null)
      setView({ ...saved.view, yaw: saved.view.yaw + dx / 150, pitch: clamp(saved.view.pitch - dy / 150, -1.3, 1.3) })
    }
  }

  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    const saved = drag.current
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!disabled && saved?.id === event.pointerId && !saved.moved) {
      const point = hit(event)
      if (point) onSelect({ source: point.node.source, id: point.node.id })
    }
  }

  return <div className={styles.graph} ref={container}>
    <div className={styles.legend}><span><i className={styles.knowledgeMark} />知识条目</span><span><i className={styles.storyMark} />故事记录</span><span>只绘制本页登记引用</span></div>
    <svg ref={stage} className={styles.stage} viewBox={`0 0 ${width} ${HEIGHT}`} role="img"
      aria-label="本页故事对象的引用图。完整名称、类型与详情可在对象列表中选择。" data-disabled={disabled} data-hovered={Boolean(hovered)}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
      onPointerCancel={() => { drag.current = null; setHovered(null) }} onLostPointerCapture={() => { drag.current = null }}
      onPointerLeave={() => { if (!drag.current) setHovered(null) }}>
      <g aria-hidden="true">
        {edges.map((edge) => {
          const from = pointMap.get(galaxyKey(edge.from)), to = pointMap.get(galaxyKey(edge.to))
          if (!from || !to) return null
          const active = from.key === activeKey || to.key === activeKey
          return <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={active ? styles.activeEdge : styles.edge} />
        })}
        {[...frontToBack].reverse().map((point) => {
          const active = point.key === selectedKey || point.key === focusKey || point.key === hovered
          return <g key={point.key} transform={`translate(${point.x} ${point.y})`} className={point.node.source === 'knowledge' ? styles.knowledge : styles.story}
            opacity={activeKey && !related.has(point.key) ? .55 : 1}>
            {active && <circle r={point.radius + 5} className={styles.selection} />}
            {point.node.source === 'knowledge' ? <circle r={point.radius} /> : <path d={`M 0 ${-point.radius} L ${point.radius} 0 L 0 ${point.radius} L ${-point.radius} 0 Z`} />}
          </g>
        })}
        {labels.map((label) => <text key={label.key} x={label.x} y={label.y} className={label.key === activeKey ? styles.activeLabel : styles.label}>{label.text}</text>)}
      </g>
    </svg>
    <div className={styles.controls} role="group" aria-label="星海视角">
      <button className={shared.button} type="button" disabled={disabled} onClick={() => setView((value) => ({ ...value, yaw: value.yaw - .35 }))}>向左旋转</button>
      <button className={shared.button} type="button" disabled={disabled} onClick={() => setView((value) => ({ ...value, yaw: value.yaw + .35 }))}>向右旋转</button>
      <button className={shared.button} type="button" disabled={disabled || view.zoom <= .65} onClick={() => setView((value) => ({ ...value, zoom: clamp(value.zoom - .15, .65, 1.75) }))}>缩小</button>
      <button className={shared.button} type="button" disabled={disabled || view.zoom >= 1.75} onClick={() => setView((value) => ({ ...value, zoom: clamp(value.zoom + .15, .65, 1.75) }))}>放大</button>
      <button className={shared.button} type="button" disabled={disabled} onClick={() => { setView(INITIAL_VIEW); setHovered(null) }}>复位视角</button>
    </div>
    <p className={styles.help}>鼠标拖动旋转，点选对象查看详情；键盘和触屏可使用视角按钮及对象列表。位置与远近仅用于排布。</p>
  </div>
}
