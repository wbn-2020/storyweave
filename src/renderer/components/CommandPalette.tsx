import { useEffect, useId, useMemo, useRef, useState } from 'react'
import styles from './CommandPalette.module.css'

export interface StudioCommand {
  id: string
  label: string
  group: string
  keywords?: string
  shortcut?: string
  disabledReason?: string
  run: () => void | Promise<void>
}
export function CommandPalette({ commands, onClose }: { commands: StudioCommand[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const locked = useRef(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const heading = useId(), listId = useId()
  const results = useMemo(() => {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    return commands.filter((command) => terms.every((term) => `${command.label} ${command.group} ${command.keywords ?? ''}`.toLocaleLowerCase().includes(term))).slice(0, 60)
  }, [commands, query])
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
  }, [activeIndex, listId])
  function execute(command: StudioCommand | undefined) {
    if (!command || command.disabledReason || locked.current) return
    locked.current = true
    // 先释放模态焦点，再走 App 的原保存门禁；命令本身不直接替换编辑器或清空表单。
    onClose()
    void command.run()
  }
  return <dialog ref={dialog} className={styles.palette} aria-labelledby={heading}
    onCancel={(event) => { event.preventDefault(); onClose() }} onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    }}>
    <header className={styles.heading}><h2 id={heading}>搜索与命令</h2><button type="button" onClick={onClose} aria-label="关闭命令面板">Esc</button></header>
    <input ref={input} className={styles.search} role="combobox" aria-label="搜索命令、章节或主题" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
      aria-activedescendant={activeIndex < 0 ? undefined : `${listId}-${activeIndex}`} value={query} maxLength={200} placeholder="章节、人物、伏笔、主题…" onChange={(event) => { setQuery(event.target.value); setSelectedId(null) }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!enabled.length) return
          const index = active ? enabled.indexOf(active) : -1
          setSelectedId(enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]!.id)
        } else if (event.key === 'Enter') { event.preventDefault(); execute(active) }
      }} />
    <ul id={listId} className={styles.results} role="listbox" aria-label="匹配命令">{results.map((command, index) => <li id={`${listId}-${index}`} key={command.id} role="option" aria-selected={command.id === active?.id} aria-disabled={Boolean(command.disabledReason)}>
      <button type="button" tabIndex={-1} disabled={Boolean(command.disabledReason)} onPointerMove={() => { if (!command.disabledReason) setSelectedId(command.id) }} onClick={() => execute(command)}>
        <span><strong>{command.label}</strong><small>{command.disabledReason ?? command.group}</small></span>{command.shortcut && <kbd>{command.shortcut}</kbd>}
      </button>
    </li>)}</ul>
    {!results.length && <p className={styles.empty}>没有匹配命令，试试“章节”“伏笔”或“主题”。</p>}
    <footer className={styles.footer}>↑ ↓ 选择 · Enter 执行 · Esc 关闭 · Ctrl+K 打开。未保存表单仍由原面板保护。</footer>
  </dialog>
}
