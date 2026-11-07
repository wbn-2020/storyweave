import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import UniqueID from '@tiptap/extension-unique-id'
import type { ManuscriptDocument } from '../../contracts/manuscript'
import { displayPreferenceStyle, type DisplayPreferences } from '../display-preferences'
import { ManuscriptSearchHighlights } from './manuscript-search'
import { ManuscriptSearch } from './ManuscriptSearch'
import styles from './ManuscriptEditor.module.css'
import paper from './PaperSurface.module.css'

interface Props {
  document: ManuscriptDocument
  disabled: boolean
  readOnly?: boolean
  displayPreferences: DisplayPreferences
  onChange: (document: unknown, plainText: string) => void
  onComposition: (active: boolean) => void
}

export function ManuscriptEditor({ document, disabled, readOnly = false, displayPreferences, onChange, onComposition }: Props) {
  const callbacks = useRef({ onChange, onComposition })
  callbacks.current = { onChange, onComposition }
  const composing = useRef(false)
  const [compositionActive, setCompositionActive] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [searchFocus, setSearchFocus] = useState(0)
  const container = useRef<HTMLDivElement>(null)
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
  })

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
      if (!editor || editor.isDestroyed || disabledRef.current || composing.current || editor.view.composing || event.isComposing || event.keyCode === 229) return
      if (globalThis.document.querySelector('dialog[open]')) return
      const target = event.target
      if (target instanceof HTMLElement && !container.current?.contains(target) && target.closest('input, textarea, select, [contenteditable="true"]')) return
      const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'h')
      if (shortcut) {
        event.preventDefault()
        setSearchOpen(true)
        if (event.key.toLowerCase() === 'h') setReplaceOpen(true)
        setSearchFocus((current) => current + 1)
      } else if (event.key === 'Escape' && searchOpen) {
        event.preventDefault(); setSearchOpen(false); editor.view.focus()
      }
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  }, [editor, searchOpen])

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

  return <div ref={container} className={`${styles.editor} ${paper.surface}`} data-paper-tone={displayPreferences.paperTone} style={displayPreferenceStyle(displayPreferences)}>
    <div className={styles.toolbar} role="toolbar" aria-label="正文格式">
      <div className={styles.toolGroup}>
        <button type="button" disabled={editingDisabled} aria-pressed={active?.bold ?? false}
          title="加粗（Ctrl+B）" onClick={() => command(() => editor.chain().focus().toggleBold().run())}>加粗</button>
        <button type="button" disabled={editingDisabled} aria-pressed={active?.italic ?? false}
          title="斜体（Ctrl+I）" onClick={() => command(() => editor.chain().focus().toggleItalic().run())}>斜体</button>
        <button type="button" disabled={editingDisabled} aria-pressed={active?.heading ?? false}
          onClick={() => command(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}>小标题</button>
        <button type="button" disabled={editingDisabled}
          onClick={() => command(() => editor.chain().focus().setHorizontalRule().run())}>分场线</button>
      </div>
      <div className={styles.toolGroup}>
        <button type="button" disabled={editingDisabled || !active?.canUndo}
          title="撤销（Ctrl+Z）" onClick={() => command(() => editor.chain().focus().undo().run())}>撤销</button>
        <button type="button" disabled={editingDisabled || !active?.canRedo}
          title="重做（Ctrl+Shift+Z）" onClick={() => command(() => editor.chain().focus().redo().run())}>重做</button>
        <button type="button" disabled={disabled || compositionActive} title="查找（Ctrl+F）" aria-expanded={searchOpen} onClick={() => openSearch(false)}>查找</button>
        <button type="button" disabled={disabled || compositionActive || readOnly} title="替换（Ctrl+H）" onClick={() => openSearch(true)}>替换</button>
      </div>
    </div>
    {searchOpen && <ManuscriptSearch editor={editor} disabled={disabled} readOnly={readOnly} composing={compositionActive} replaceOpen={replaceOpen} focusRequest={searchFocus}
      onToggleReplace={() => setReplaceOpen((current) => !current)} onClose={() => { setSearchOpen(false); editor.view.focus() }} />}
    <EditorContent editor={editor} className={styles.content} />
  </div>
}
