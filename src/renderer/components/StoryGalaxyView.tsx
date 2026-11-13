import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { galaxyKey, type GalaxyEdge, type GalaxyNode, type GalaxyTarget } from '../../contracts/story-galaxy'
import { StudioIcon } from './StudioIcon'
import styles from './StellarGraph.module.css'

interface Props {
  nodes: GalaxyNode[]
  edges: GalaxyEdge[]
  focus: GalaxyTarget | null
  selected: GalaxyTarget | null
  disabled: boolean
  onSelect: (target: GalaxyTarget) => void
}
interface Point { node: GalaxyNode; key: string; x: number; y: number; z: number; radius: number }
interface View { yaw: number; x: number; y: number; zoom: number }
interface Drag { id: number; x: number; y: number; view: View; moved: boolean; mouse: boolean }
const INITIAL_VIEW: View = { yaw: 0, x: 0, y: 0, zoom: 1 }

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }

export function StoryGalaxyView({ nodes, edges, focus, selected, disabled, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const stage = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const [width, setWidth] = useState(760)
  const [height, setHeight] = useState(480)
  const [view, setView] = useState<View>(INITIAL_VIEW)
  const [hovered, setHovered] = useState<string | null>(null)
  const focusKey = focus ? galaxyKey(focus) : null
  const selectedKey = selected ? galaxyKey(selected) : null

  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => { setWidth(Math.max(200, element.clientWidth)); setHeight(Math.max(240, stage.current?.clientHeight ?? 480)) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (stage.current) observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => { setView(INITIAL_VIEW); setHovered(null); drag.current = null }, [nodes, focusKey])
  useEffect(() => { if (disabled) { drag.current = null; setHovered(null) } }, [disabled])

  const layout = useMemo(() => {
    const sorted = [...nodes].sort((a, b) => galaxyKey(a).localeCompare(galaxyKey(b)))
    const peers = sorted.filter((node) => galaxyKey(node) !== focusKey)
    // 固定环列只用于排布本页对象；中心与连线仍来自明确的直接引用，不编码强度和时长。
    return sorted.map((node) => {
      const key = galaxyKey(node), index = peers.indexOf(node), ring = Math.floor(index / 14)
      const count = Math.min(14, peers.length - ring * 14), angle = (index % 14) / Math.max(1, count) * Math.PI * 2 - Math.PI / 2 + ring * .19
      const radius = 145 + ring * 65
      return { node, key, x: key === focusKey ? 0 : Math.cos(angle) * radius, y: key === focusKey ? 0 : Math.sin(angle) * radius * .85 }
    })
  }, [nodes, focusKey])
  const points = useMemo((): Point[] => layout.map((point) => {
    const extent = Math.max(145, ...layout.map((entry) => Math.hypot(entry.x, entry.y / .85)))
    const scale = Math.min((width - 100) / (extent * 2 + 80), (height - 100) / (extent * 1.7 + 50)) * view.zoom
    const x = point.x * Math.cos(view.yaw) - point.y * Math.sin(view.yaw)
    const y = point.x * Math.sin(view.yaw) + point.y * Math.cos(view.yaw)
    return { ...point, x: width / 2 + x * scale + view.x, y: height / 2 + y * scale + view.y,
      z: point.key === focusKey ? 1 : 0, radius: point.key === focusKey ? 28 : 18 }
  }), [layout, width, height, view, focusKey])
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
      if (point.x < 10 || point.x > width - 10 || point.y < 10 || point.y > height - 10) continue
      const characters = Array.from(point.node.title)
      const text = characters.length > 12 ? `${characters.slice(0, 12).join('')}…` : point.node.title
      const labelWidth = Math.min(width - 16, Array.from(text).length * 14 + 8)
      const vertical = Math.abs(point.x - width / 2 - view.x) < 36
      const x = clamp(point.key === focusKey || vertical ? point.x - labelWidth / 2 : point.x < width / 2 + view.x ? point.x - labelWidth - 28 : point.x + 28, 8, width - labelWidth - 8)
      const y = clamp(point.key === focusKey ? point.y + 52 : vertical ? point.y + (point.y < height / 2 + view.y ? -32 : 40) : point.y + 5, 18, height - 8)
      if (chosen.some((other) => x < other.x + other.width + 8 && x + labelWidth + 8 > other.x && Math.abs(y - other.y) < 24)) continue
      chosen.push({ key: point.key, text, x, y, width: labelWidth })
    }
    return chosen
  }, [frontToBack, activeKey, width, height, focusKey, view.x, view.y])

  function hit(event: PointerEvent<SVGSVGElement>): Point | undefined {
    const svg = stage.current, matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return
    // 使用 SVG 的真实变换处理缩放和留白，避免窗口比例改变后点击命中偏移。
    const screen = svg.createSVGPoint()
    screen.x = event.clientX; screen.y = event.clientY
    const { x, y } = screen.matrixTransform(matrix.inverse())
    // 先按绘制遮挡顺序命中可见形状，避免后景中心更近时穿过前景对象。
    for (const point of frontToBack) if (Math.hypot(point.x - x, point.y - y) <= point.radius + 6) return point
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
    // 触屏保留页面纵向滚动，平移和缩放也提供键盘可达的控件。
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
      const matrix = stage.current?.getScreenCTM()
      if (matrix?.a && matrix.d) setView({ ...saved.view, x: saved.view.x + dx / matrix.a, y: saved.view.y + dy / matrix.d })
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
    <svg ref={stage} className={styles.stage} viewBox={`0 0 ${width} ${height}`} role="group"
      aria-label="本页记忆星图" data-disabled={disabled} data-hovered={Boolean(hovered)}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
      onPointerCancel={() => { drag.current = null; setHovered(null) }} onLostPointerCapture={() => { drag.current = null }}
      onPointerLeave={() => { if (!drag.current) setHovered(null) }}>
      <g className={styles.orbits} aria-hidden="true" transform={`translate(${width / 2 + view.x} ${height / 2 + view.y})`}>
        <ellipse rx={Math.min(width * .43,360) * view.zoom} ry={height * .42 * view.zoom} />
        <ellipse rx={Math.min(width * .32,270) * view.zoom} ry={height * .31 * view.zoom} />
        {focusKey && <><circle r={84 * view.zoom} /><circle r={112 * view.zoom} strokeDasharray="2 12" /></>}
      </g>
      <g>
        {edges.map((edge) => {
          const from = pointMap.get(galaxyKey(edge.from)), to = pointMap.get(galaxyKey(edge.to))
          if (!from || !to) return null
          const active = from.key === activeKey || to.key === activeKey
          return <line aria-hidden="true" key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={active ? styles.activeEdge : styles.edge} />
        })}
        {[...frontToBack].reverse().map((point) => {
          const active = point.key === selectedKey || point.key === focusKey || point.key === hovered
          const r = point.radius, kind = point.node.kind
          const state = point.node.conflictState === 'candidate' ? 'conflict' : point.node.freshness !== 'current' || point.node.nature === 'ai_inference' ? 'review'
            : point.node.authorDecision !== 'adopted' || !['clear', 'explained'].includes(point.node.conflictState) ? 'unknown' : 'known'
          return <g key={point.key} transform={`translate(${point.x} ${point.y})`} className={styles.node} data-kind={kind} data-state={state}
            data-focused={point.key === focusKey} role="button" aria-label={`${point.node.title} · ${kind}`} aria-pressed={point.key === selectedKey}
            aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onKeyDown={(event) => {
              if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelect({ source: point.node.source, id: point.node.id }) }
            }}
            opacity={activeKey && !related.has(point.key) ? .55 : 1}>
            <title>{point.node.title} · {point.node.excerpt || '点击查看登记来源与关联'}</title>
            <circle r={r + 5} className={styles.nodeDisc} />
            {active && <><circle r={r + 10} className={styles.selection} /><circle r={r + 17} className={styles.outerHalo} /></>}
            {kind === 'person' ? <path d={`M 0 ${-r} Q ${r * .2} ${-r * .2} ${r} 0 Q ${r * .2} ${r * .2} 0 ${r} Q ${-r * .2} ${r * .2} ${-r} 0 Q ${-r * .2} ${-r * .2} 0 ${-r} Z`} />
              : kind === 'place' ? <path d={`M 0 ${r * 1.2} Q ${-r * 1.4} ${-r * .3} ${-r * .6} ${-r * .9} Q 0 ${-r * 1.5} ${r * .6} ${-r * .9} Q ${r * 1.4} ${-r * .3} 0 ${r * 1.2} Z`} />
              : kind === 'foreshadow' ? <path d={`M 0 ${-r * 1.3} L ${r * 1.15} ${r} L ${-r * 1.15} ${r} Z`} />
                : kind === 'event' ? <path d={`M ${-r} 0 L ${-r / 2} ${-r} L ${r / 2} ${-r} L ${r} 0 L ${r / 2} ${r} L ${-r / 2} ${r} Z`} />
                  : kind === 'object' ? <><path d={`M ${-r} ${-r * .5} L 0 ${-r} L ${r} ${-r * .5} L ${r} ${r * .5} L 0 ${r} L ${-r} ${r * .5} Z`} /><path className={styles.symbolLine} d={`M 0 ${r} V 0 L ${-r} ${-r * .5} M 0 0 L ${r} ${-r * .5}`} /></>
                  : <path d={`M 0 ${-r * 1.2} L ${r * 1.2} 0 L 0 ${r * 1.2} L ${-r * 1.2} 0 Z`} />}
          </g>
        })}
        {labels.map((label) => <text aria-hidden="true" key={label.key} x={label.x} y={label.y} className={label.key === activeKey ? styles.activeLabel : styles.label}>{label.text}</text>)}
      </g>
    </svg>
    <div className={styles.controls} role="group" aria-label="星海视角">
      <button type="button" disabled={disabled} aria-label="向左旋转星图" title="向左旋转星图" onClick={() => setView((value) => ({ ...value, yaw: value.yaw - .35 }))}><StudioIcon name="undo" /></button>
      <button type="button" disabled={disabled} aria-label="向右旋转星图" title="向右旋转星图" onClick={() => setView((value) => ({ ...value, yaw: value.yaw + .35 }))}><StudioIcon name="redo" /></button>
      <button type="button" disabled={disabled} aria-label="向左平移星图" title="向左平移星图" onClick={() => setView((value) => ({ ...value, x: value.x - 40 }))}><StudioIcon name="chevron" style={{ transform: 'rotate(180deg)' }} /></button>
      <button type="button" disabled={disabled} aria-label="向右平移星图" title="向右平移星图" onClick={() => setView((value) => ({ ...value, x: value.x + 40 }))}><StudioIcon name="chevron" /></button>
      <button type="button" disabled={disabled || view.zoom <= .65} aria-label="缩小记忆星图" title={view.zoom <= .65 ? '已到最小缩放' : '缩小记忆星图'} onClick={() => setView((value) => ({ ...value, zoom: clamp(value.zoom - .15, .65, 1.75) }))}><StudioIcon name="minus" /></button>
      <output aria-label="记忆星图缩放">{Math.round(view.zoom * 100)}%</output>
      <button type="button" disabled={disabled || view.zoom >= 1.75} aria-label="放大记忆星图" title={view.zoom >= 1.75 ? '已到最大缩放' : '放大记忆星图'} onClick={() => setView((value) => ({ ...value, zoom: clamp(value.zoom + .15, .65, 1.75) }))}><StudioIcon name="plus" /></button>
      <button type="button" disabled={disabled} aria-label="复位记忆星图" title="复位记忆星图" onClick={() => { setView(INITIAL_VIEW); setHovered(null) }}><StudioIcon name="focus" /></button>
    </div>
  </div>
}
