import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import UniqueID from '@tiptap/extension-unique-id'
import type { ManuscriptDocument } from '../../contracts/manuscript'
import { displayPreferenceStyle, type DisplayPreferences } from '../display-preferences'
import { ManuscriptSearchHighlights } from './manuscript-search'
import { ManuscriptSearch } from './ManuscriptSearch'
import styles from './StellarEditor.module.css'
import paper from './PaperSurface.module.css'
import type { WritingPosition } from '../writing-location'
import { StudioIcon } from './StudioIcon'
import { StellarTooltip } from './stellar/StellarTooltip'

interface Props {
  title: string
  document: ManuscriptDocument
  disabled: boolean
  readOnly?: boolean
  displayPreferences: DisplayPreferences
  onChange: (document: unknown, plainText: string) => void
  onComposition: (active: boolean) => void
  initialPosition?: WritingPosition | null
  onPositionChange?: (position: WritingPosition) => void
  onSelectionAction?: (instruction: string, range: { firstBlockId: string; lastBlockId: string }) => void
  footer?: ReactNode
}

function selectionPosition(selection: Selection): WritingPosition | null {
  const node = selection instanceof NodeSelection ? selection.node : selection.$from.depth > 0 ? selection.$from.node(1) : null
  return typeof node?.attrs.id === 'string'
    ? { blockId: node.attrs.id, offset: selection instanceof NodeSelection ? 0 : selection.$from.parentOffset } : null
}

function nativeTextSelection(view: EditorView): TextSelection | null {
  const native = view.dom.ownerDocument.getSelection()
  if (!view.hasFocus() || !native?.anchorNode || !native.focusNode
    || !view.dom.contains(native.anchorNode) || !view.dom.contains(native.focusNode)) return null
  try {
    const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset)
    const head = view.posAtDOM(native.focusNode, native.focusOffset)
    if (!view.state.doc.resolve(anchor).parent.inlineContent || !view.state.doc.resolve(head).parent.inlineContent) return null
    return TextSelection.create(view.state.doc, anchor, head)
  } catch { return null }
}

export function ManuscriptEditor({ title, document, disabled, readOnly = false, displayPreferences, onChange, onComposition, initialPosition, onPositionChange, onSelectionAction, footer }: Props) {
  const callbacks = useRef({ onChange, onComposition, onPositionChange })
  callbacks.current = { onChange, onComposition, onPositionChange }
  const openingPosition = useRef(initialPosition)
  const composing = useRef(false)
  const [compositionActive, setCompositionActive] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [searchFocus, setSearchFocus] = useState(0)
  const [locationNotice, setLocationNotice] = useState<string | null>(null)
  const [selectionToolbar, setSelectionToolbar] = useState<{ top: number; left: number; width: number } | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const selectionTools = useRef<HTMLDivElement>(null)
  const dismissedSelection = useRef<string | null>(null)
  const compositionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] }, blockquote: false, bulletList: false,
        code: false, codeBlock: false, link: false, listItem: false,
        listKeymap: false, orderedList: false, strike: false, underline: false,
        trailingNode: false,
      }),
      UniqueID.configure({ attributeName: 'id', types: ['paragraph', 'heading', 'horizontalRule'] }),
      ManuscriptSearchHighlights,
    ],
    content: document,
    injectCSS: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { 'aria-label': '章节正文', 'aria-multiline': 'true', role: 'textbox', spellcheck: 'false' },
      handleDOMEvents: {
        keydown: (view, event) => {
          if (event.defaultPrevented || disabledRef.current || readOnlyRef.current || composing.current || view.composing
            || event.isComposing || event.keyCode === 229 || !(event.ctrlKey || event.metaKey) || event.altKey
            || event.shiftKey || !['b', 'i'].includes(event.key.toLowerCase())) return false
          // 原生光标移动的 selectionchange 可能晚于下一按键；格式命令不能写回旧选区。
          const selection = nativeTextSelection(view)
          if (selection && !selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false))
          return false
        },
        compositionstart: () => {
          if (compositionTimer.current !== null) clearTimeout(compositionTimer.current)
          composing.current = true
          setCompositionActive(true)
          callbacks.current.onComposition(true)
          return false
        },
        compositionend: () => {
          // 输入法最终事务落下后才允许保存或切换，避免截断正在组合的汉字。
          compositionTimer.current = setTimeout(() => {
            compositionTimer.current = null
            composing.current = false
            setCompositionActive(false)
            callbacks.current.onComposition(false)
          }, 0)
          return false
        },
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      callbacks.current.onChange(activeEditor.getJSON(), activeEditor.getText({ blockSeparator: '\n' }))
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      const position = selectionPosition(activeEditor.state.selection)
      if (position) callbacks.current.onPositionChange?.(position)
    },
  })

  useLayoutEffect(() => {
    const position = openingPosition.current
    if (!editor || editor.isDestroyed || !position?.blockId) return
    let targetOffset = -1
    editor.state.doc.forEach((block, offset) => {
      if (targetOffset >= 0 || block.attrs.id !== position.blockId) return
      targetOffset = offset
      if (block.isTextblock) {
        const inside = Number.isSafeInteger(position.offset) ? Math.max(0, Math.min(position.offset!, block.content.size)) : 0
        editor.commands.setTextSelection(offset + 1 + inside)
      } else {
        // 横线没有合法文本光标，使用节点选区；未来不可选节点则退到附近合法位置。
        const selection = NodeSelection.isSelectable(block) ? NodeSelection.create(editor.state.doc, offset) : Selection.near(editor.state.doc.resolve(offset))
        editor.view.dispatch(editor.state.tr.setSelection(selection))
      }
    })
    if (targetOffset < 0) {
      setLocationNotice(position.reveal ? '定位段落已不存在，已打开章节开头。正文未修改。' : '原光标所在段落已不存在，已保留原滚动位置。')
      if (position.reveal) editor.view.dispatch(editor.state.tr.setSelection(Selection.atStart(editor.state.doc)))
    }
    const restoredPosition = selectionPosition(editor.state.selection)
    if (restoredPosition) callbacks.current.onPositionChange?.(restoredPosition)
    if (!position.reveal) return
    const selection = editor.state.selection
    // 等待父级布局完成后显式滚动；普通恢复不主动滚动，以免覆盖 App 保存的 scrollTop。
    const frame = requestAnimationFrame(() => {
      if (editor.isDestroyed || !container.current?.isConnected || !editor.state.selection.eq(selection)) return
      const target = targetOffset >= 0 ? editor.view.nodeDOM(targetOffset) : null
      if (target instanceof Element) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
      else container.current.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' })
      if (!disabledRef.current && !readOnlyRef.current && !composing.current) editor.view.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [editor])

  const active = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor?.isActive('bold') ?? false,
      italic: currentEditor?.isActive('italic') ?? false,
      heading: currentEditor?.isActive('heading') ?? false,
      canUndo: currentEditor?.can().undo() ?? false,
      canRedo: currentEditor?.can().redo() ?? false,
    }),
  })

  useLayoutEffect(() => {
    if (editor && !composing.current) editor.setEditable(!disabled && !readOnly, false)
  }, [disabled, readOnly, editor, compositionActive])

  useEffect(() => () => {
    if (compositionTimer.current !== null) clearTimeout(compositionTimer.current)
    callbacks.current.onComposition(false)
  }, [])

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (!editor || editor.isDestroyed || event.defaultPrevented || disabledRef.current || composing.current || editor.view.composing || event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape' && globalThis.document.querySelector('[data-stellar-tooltip]:popover-open')) return
      if (globalThis.document.querySelector('dialog[open]')) return
      const target = event.target
      if (target instanceof HTMLElement && !container.current?.contains(target) && target.closest('input, textarea, select, [contenteditable="true"]')) return
      const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'h')
      if (shortcut) {
        event.preventDefault()
        setSearchOpen(true)
        if (event.key.toLowerCase() === 'h') setReplaceOpen(true)
        setSearchFocus((current) => current + 1)
      } else if (event.key === 'Escape' && searchOpen && !selectionTools.current) {
        event.preventDefault(); setSearchOpen(false); editor.view.focus()
      }
    }
    // Esc 依次交给提示、选区工具条和查找；较早注册的监听不能抢先收起下层。
    window.addEventListener('keydown', keyDown, true)
    return () => window.removeEventListener('keydown', keyDown, true)
  }, [editor, searchOpen])

  useEffect(() => {
    if (!editor || disabled || readOnly || compositionActive || !onSelectionAction) { setSelectionToolbar(null); return }
    const update = () => {
      if (editor.isDestroyed || !container.current) { setSelectionToolbar(null); return }
      const { from, to, empty } = editor.state.selection
      const rangeKey = `${from}:${to}`
      if (empty || dismissedSelection.current !== rangeKey) dismissedSelection.current = null
      if (empty || dismissedSelection.current === rangeKey || (!editor.isFocused && !selectionTools.current?.contains(globalThis.document.activeElement))) { setSelectionToolbar(null); return }
      const start = editor.view.coordsAtPos(from)
      const end = editor.view.coordsAtPos(to)
      const bounds = container.current.getBoundingClientRect()
      const width = Math.min(432, bounds.width - 24)
      setSelectionToolbar({ top: Math.max(64, start.top - bounds.top - 48),
        left: Math.max(12, Math.min(bounds.width - width - 12, (start.left + end.right) / 2 - bounds.left - width / 2)), width })
    }
    const dismiss = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || composing.current || editor.view.composing
        || globalThis.document.querySelector('[data-stellar-tooltip]:popover-open')) return
      if (event.key === 'Escape' && !event.defaultPrevented && !globalThis.document.querySelector('dialog[open]') && selectionTools.current) {
        event.preventDefault()
        // 捕获阶段可能早于原生 selectionchange；按眼前的 DOM 选区关闭，避免迟到同步重新展开。
        const selection = nativeTextSelection(editor.view) ?? editor.state.selection
        dismissedSelection.current = `${selection.from}:${selection.to}`
        if (selectionTools.current?.contains(globalThis.document.activeElement)) editor.view.focus()
        setSelectionToolbar(null)
      }
    }
    // blur 事务早于浏览器提交新焦点，延后检查，避免 Tab 目标在获焦前被卸载。
    let blurFrame = 0
    const refresh = () => {
      cancelAnimationFrame(blurFrame)
      if (!editor.isFocused) blurFrame = requestAnimationFrame(update)
      else update()
    }
    editor.on('selectionUpdate', refresh)
    editor.on('transaction', refresh)
    editor.on('blur', refresh)
    globalThis.document.addEventListener('focusin', update)
    globalThis.document.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    window.addEventListener('keydown', dismiss, true)
    return () => {
      cancelAnimationFrame(blurFrame)
      editor.off('selectionUpdate', refresh); editor.off('transaction', refresh); editor.off('blur', refresh)
      globalThis.document.removeEventListener('focusin', update)
      globalThis.document.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update); window.removeEventListener('keydown', dismiss, true)
    }
  }, [editor, disabled, readOnly, compositionActive, onSelectionAction])

  if (!editor) return <p className={styles.loading} role="status">正在打开正文…</p>

  function command(run: () => void) {
    if (disabledRef.current || readOnlyRef.current || composing.current || editor.view.composing) return
    run()
  }

  function openSearch(replace: boolean) {
    if (disabledRef.current || composing.current || editor.view.composing) return
    setSearchOpen(true); setReplaceOpen(replace); setSearchFocus((current) => current + 1)
  }

  const editingDisabled = disabled || readOnly || compositionActive
  function selectionAction(label: string) {
    if (editingDisabled || composing.current || editor.view.composing || editor.state.selection.empty || !onSelectionAction) return
    const { from, to } = editor.state.selection
    const ids: string[] = []
    editor.state.doc.nodesBetween(from, to, (node, position) => {
      // 选区只触及下一段的起点时，不能把未选中文字的整段也交给改写。
      if (node.isTextblock && from < position + 1 + node.content.size && to > position + 1 && typeof node.attrs.id === 'string') ids.push(node.attrs.id)
      return !node.isTextblock
    })
    if (!ids.length) return
    // 只传稳定段落 ID；由原改写流程保存正文、固定版本并让作者复核整段替换范围。
    onSelectionAction(`${label}。保留情节事实与人物视角，修改选中片段所在的段落。\n选中片段：\n${editor.state.doc.textBetween(from, to, '\n').slice(0, 2000)}`, { firstBlockId: ids[0]!, lastBlockId: ids.at(-1)! })
    setSelectionToolbar(null)
  }

  return <div ref={container} className={`${styles.editor} ${paper.surface}`} data-paper-tone={displayPreferences.paperTone} style={displayPreferenceStyle(displayPreferences)}>
    <div className={styles.toolbar} role="toolbar" aria-label="正文格式">
      <div className={styles.toolGroup}>
        <StellarTooltip><button type="button" disabled={editingDisabled} aria-pressed={active?.bold ?? false}
          aria-label="加粗" title="加粗（Ctrl+B）" onClick={() => command(() => editor.chain().focus().toggleBold().run())}><b>B</b></button></StellarTooltip>
        <StellarTooltip><button type="button" disabled={editingDisabled} aria-pressed={active?.italic ?? false}
          aria-label="斜体" title="斜体（Ctrl+I）" onClick={() => command(() => editor.chain().focus().toggleItalic().run())}><i>I</i></button></StellarTooltip>
        <StellarTooltip><button type="button" disabled={editingDisabled} aria-pressed={active?.heading ?? false}
          aria-label="小标题" title="小标题" onClick={() => command(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}>H2</button></StellarTooltip>
        <StellarTooltip><button type="button" disabled={editingDisabled}
          aria-label="插入分场线" title="分场线" onClick={() => command(() => editor.chain().focus().setHorizontalRule().run())}><StudioIcon name="minus" size={20} /></button></StellarTooltip>
      </div>
      <div className={styles.toolGroup}>
        <StellarTooltip><button type="button" disabled={disabled || compositionActive} title="查找（Ctrl+F）" aria-label="查找正文" aria-expanded={searchOpen} onClick={() => openSearch(false)}><StudioIcon name="search" size={20} /></button></StellarTooltip>
        <StellarTooltip><button type="button" disabled={disabled || compositionActive || readOnly} title="替换（Ctrl+H）" onClick={() => openSearch(true)}>替换</button></StellarTooltip>
      </div>
    </div>
    {selectionToolbar && <div ref={selectionTools} className={styles.selectionToolbar} role="toolbar" aria-label="选区 AI 改写" style={selectionToolbar}
      onMouseDown={(event) => event.preventDefault()}>
      {['去 AI 味', '扩写', '强化潜台词', '按文风仿写'].map((label) => <button type="button" key={label} disabled={editingDisabled} onClick={() => selectionAction(label)}>{label}</button>)}
    </div>}
    {searchOpen && <ManuscriptSearch editor={editor} disabled={disabled} readOnly={readOnly} composing={compositionActive} replaceOpen={replaceOpen} focusRequest={searchFocus}
      onToggleReplace={() => setReplaceOpen((current) => !current)} onClose={() => { setSearchOpen(false); editor.view.focus() }} />}
    <h2 className={styles.visuallyHidden}>{title}</h2>
    {readOnly && <p className={styles.readOnlyNote}>归档作品 · 只读</p>}
    {locationNotice && <p className={styles.searchHint} role="status">{locationNotice}</p>}
    <EditorContent editor={editor} className={styles.content} />
    <footer className={styles.paperFooter}>
      <div className={styles.footerInfo}>{footer ?? <span>{readOnly ? '归档作品 · 只读' : '工作稿'}</span>}</div>
      <div className={styles.toolGroup}>
        <StellarTooltip><button type="button" disabled={editingDisabled || !active?.canUndo}
          aria-label="撤销" title="撤销（Ctrl+Z）" onClick={() => command(() => editor.chain().focus().undo().run())}><StudioIcon name="undo" size={20} /></button></StellarTooltip>
        <StellarTooltip><button type="button" disabled={editingDisabled || !active?.canRedo}
          aria-label="重做" title="重做（Ctrl+Shift+Z）" onClick={() => command(() => editor.chain().focus().redo().run())}><StudioIcon name="redo" size={20} /></button></StellarTooltip>
      </div>
    </footer>
  </div>
}
