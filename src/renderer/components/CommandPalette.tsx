import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import styles from './StellarCommands.module.css'
import { StudioIcon, type StudioIconName } from './StudioIcon'

export interface StudioCommand {
  id: string
  label: string
  group: string
  keywords?: string
  shortcut?: string
  disabledReason?: string
  run: () => void | Promise<void>
}
function commandGroup(command: StudioCommand): string {
  if (['review', 'finalize', 'publishedMemory'].includes(command.id)) return '审稿'
  if (command.id === 'write') return '跳转'
  if (command.id === 'living') return '生成'
  if (['显示', '设置'].includes(command.group) || ['workspace', 'backup', 'recovery'].includes(command.id)) return '设置'
  if (['AI', '创作'].includes(command.group)) return '生成'
  return command.group === '正文' ? '正文' : '跳转'
}
function commandIcon(command: StudioCommand): StudioIconName {
  if (command.id.startsWith('chapter:')) return 'read'
  if (command.id.startsWith('theme:')) return 'palette'
  const icons: Record<string, StudioIconName> = {
    world: 'globe', abilities: 'sword', tasks: 'bell', home: 'home', shelf: 'books', overview: 'grid', workspace: 'folder',
    newBook: 'spark', import: 'folder', write: 'pen', save: 'save', newChapter: 'plus', newVolume: 'plus',
    chapterDetails: 'notes', history: 'history', finalize: 'check', ai: 'spark', review: 'read', living: 'layers',
    forge: 'user', knowledge: 'archive', galaxy: 'galaxy', matrix: 'grid', radar: 'compass', story: 'timeline',
    timeline: 'timeline', notes: 'notes', inspiration: 'bulb', calendar: 'calendar', media: 'image', reader: 'read',
    export: 'export', backup: 'archive', memory: 'search', aiMemoryTasks: 'workflow', aiSummary: 'layers',
    continue: 'spark', expand: 'layers', rebase: 'workflow',
    publishedMemory: 'check', bookDetails: 'books', recovery: 'history', preferences: 'settings', models: 'workflow', focus: 'focus',
  }
  return icons[command.id] ?? 'arrow'
}
const groupIcons: Record<string, StudioIconName> = { 跳转: 'navigation', 生成: 'spark', 审稿: 'shield', 设置: 'settings', 正文: 'pen' }
const COMMAND_PAGE_SIZE = 60
export function CommandPalette({ commands, onClose }: { commands: StudioCommand[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const locked = useRef(false)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const heading = useId(), listId = useId(), keyboardHint = useId()
  const matches = useMemo(() => {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    return commands.map((command) => ({ ...command, group: commandGroup(command) }))
      .filter((command) => terms.every((term) => `${command.label} ${command.group} ${command.keywords ?? ''}`.toLocaleLowerCase().includes(term)))
  }, [commands, query])
  const expanded = Boolean(query.trim()) || showAll
  const pageCount = Math.max(1, Math.ceil(matches.length / COMMAND_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  useEffect(() => { setPage((value) => Math.min(value, pageCount - 1)) }, [pageCount])
  const results = useMemo(() => {
    // 默认四组与参考图一致；完整目录仍可一键展开，搜索始终覆盖全部命令。
    const preferred = ['write', 'forge', 'galaxy', 'continue', 'expand', 'rebase', 'review', 'publishedMemory', 'preferences', 'backup']
    // 先从完整匹配中分页，再沿用页内分组；60 项是渲染上限，不能丢弃后续章节。
    const visible = expanded ? matches.slice(currentPage * COMMAND_PAGE_SIZE, (currentPage + 1) * COMMAND_PAGE_SIZE)
      : preferred.flatMap((id) => matches.find((command) => command.id === id) ?? [])
    const groups = new Map<string, StudioCommand[]>()
    for (const command of visible) groups.set(command.group, [...(groups.get(command.group) ?? []), command])
    return ['跳转', '生成', '审稿', '设置', '正文'].flatMap((group) => groups.get(group) ?? [])
  }, [matches, expanded, currentPage])
  const enabled = results.filter((command) => !command.disabledReason)
  const active = enabled.find((command) => command.id === selectedId) ?? enabled[0]
  const activeIndex = active ? results.indexOf(active) : -1
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.showModal(); input.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, active?.id, listId])
  function execute(command: StudioCommand | undefined) {
    if (!command || command.disabledReason || locked.current) return
    locked.current = true
    // 先释放模态焦点，再走 App 的原保存门禁；命令本身不直接替换编辑器或清空表单。
    onClose()
    void command.run()
  }
  return <dialog ref={dialog} className={styles.palette} aria-labelledby={heading}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        if (!event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) onClose()
        return
      }
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      // 原生模态会阻止 App 的全局快捷键；打开后的开关由面板自身接续处理。
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault(); event.stopPropagation()
        if (!event.repeat) onClose()
      }
    }}
    onClose={(event) => { if (event.target === event.currentTarget && !event.currentTarget.open) onClose() }}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose() }} onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    }}>
    <h2 id={heading} className={styles.visuallyHidden}>搜索与命令</h2>
    <header className={styles.heading}><StudioIcon name="search" size={24} />
      <input ref={input} className={styles.search} role="combobox" aria-label="搜索命令、章节或主题" aria-describedby={keyboardHint} aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
      aria-activedescendant={activeIndex < 0 ? undefined : `${listId}-${activeIndex}`} value={query} maxLength={200} placeholder="章节、人物、伏笔、主题…" onChange={(event) => { setQuery(event.target.value); setPage(0); setSelectedId(null) }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!enabled.length) return
          const index = active ? enabled.indexOf(active) : -1
          setSelectedId(enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]!.id)
        } else if (event.key === 'Enter') { event.preventDefault(); execute(active) }
      }} />
      <kbd>Ctrl+K</kbd><button type="button" onClick={onClose} aria-label="关闭命令面板" title="关闭 · Esc"><StudioIcon name="close" size={20} /></button>
    </header>
    {/* 选项由搜索框统一处理上下键，列表不另占 Tab 焦点。 */}
    <ul id={listId} className={styles.results} role="listbox" tabIndex={-1} aria-label="匹配命令">{results.map((command, index) => <Fragment key={command.id}>
      {(index === 0 || results[index - 1].group !== command.group) && <li className={styles.groupHeading} role="presentation"><StudioIcon name={groupIcons[command.group]} size={18} />{command.group}</li>}
      <li id={`${listId}-${index}`} role="option" aria-label={`${command.group}，${command.label}${command.disabledReason ? `，${command.disabledReason}` : ''}`} aria-selected={command.id === active?.id} aria-disabled={Boolean(command.disabledReason)}>
      <button type="button" tabIndex={-1} disabled={Boolean(command.disabledReason)} onPointerMove={() => { if (!command.disabledReason) setSelectedId(command.id) }} onClick={() => execute(command)}>
        <StudioIcon name={commandIcon(command)} size={20} /><span><strong>{command.label}</strong>{command.disabledReason && <small>{command.disabledReason}</small>}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}
      </button>
    </li></Fragment>)}</ul>
    {!results.length && <p className={styles.empty}>没有匹配命令，试试“章节”“伏笔”或“主题”。</p>}
    <footer className={styles.footer}>
      <span id={keyboardHint} className={styles.keyboardHints}><span><kbd>↑ ↓</kbd> 选择</span>{' '}<span><kbd>Enter</kbd> 执行</span>{' '}<span><kbd>Esc</kbd> 关闭</span></span>
      <span aria-live="polite" aria-atomic="true">{expanded ? `${matches.length} 项匹配${pageCount > 1 ? ` · 第 ${currentPage + 1} / ${pageCount} 页` : ''}` : `${results.length} 项常用命令`}</span>
      {expanded && pageCount > 1 && <div className={styles.pages} role="group" aria-label="命令结果分页">
        <button type="button" aria-controls={listId} disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelectedId(null); input.current?.focus() }}>上一页</button>
        <button type="button" aria-controls={listId} disabled={currentPage === pageCount - 1} onClick={() => { setPage(currentPage + 1); setSelectedId(null); input.current?.focus() }}>下一页</button>
      </div>}
      {!query.trim() && <button type="button" onClick={() => { setShowAll((value) => !value); setPage(0); setSelectedId(null); input.current?.focus() }}>{showAll ? '常用命令' : `全部命令 · ${matches.length}`}</button>}
    </footer>
  </dialog>
}
