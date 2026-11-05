import { useEffect, useLayoutEffect, useRef } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import UniqueID from '@tiptap/extension-unique-id'
import type { ManuscriptDocument } from '../../contracts/manuscript'
import styles from './ManuscriptEditor.module.css'

interface Props {
  document: ManuscriptDocument
  disabled: boolean
  onChange: (document: unknown, plainText: string) => void
  onComposition: (active: boolean) => void
}

export function ManuscriptEditor({ document, disabled, onChange, onComposition }: Props) {
  const callbacks = useRef({ onChange, onComposition })
  callbacks.current = { onChange, onComposition }
  const composing = useRef(false)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] }, blockquote: false, bulletList: false,
        code: false, codeBlock: false, link: false, listItem: false,
        listKeymap: false, orderedList: false, strike: false, underline: false,
        trailingNode: false,
      }),
      UniqueID.configure({ attributeName: 'id', types: ['paragraph', 'heading', 'horizontalRule'] }),
    ],
    content: document,
    injectCSS: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { 'aria-label': '章节正文', 'aria-multiline': 'true', role: 'textbox', spellcheck: 'false' },
      handleDOMEvents: {
        compositionstart: () => {
          composing.current = true
          callbacks.current.onComposition(true)
          return false
        },
        compositionend: () => {
          // 输入法最终事务落下后才允许保存或切换，避免截断正在组合的汉字。
          setTimeout(() => {
            composing.current = false
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
    if (editor && !composing.current) editor.setEditable(!disabled, false)
  }, [disabled, editor])

  useEffect(() => () => { callbacks.current.onComposition(false) }, [])

  if (!editor) return <p className={styles.loading} role="status">正在打开正文…</p>

  function command(run: () => void) {
    if (disabledRef.current || composing.current) return
    run()
  }

  return <div className={styles.editor}>
    <div className={styles.toolbar} role="toolbar" aria-label="正文格式">
      <div className={styles.toolGroup}>
        <button type="button" disabled={disabled} aria-pressed={active?.bold ?? false}
          title="加粗（Ctrl+B）" onClick={() => command(() => editor.chain().focus().toggleBold().run())}>加粗</button>
        <button type="button" disabled={disabled} aria-pressed={active?.italic ?? false}
          title="斜体（Ctrl+I）" onClick={() => command(() => editor.chain().focus().toggleItalic().run())}>斜体</button>
        <button type="button" disabled={disabled} aria-pressed={active?.heading ?? false}
          onClick={() => command(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}>小标题</button>
        <button type="button" disabled={disabled}
          onClick={() => command(() => editor.chain().focus().setHorizontalRule().run())}>分场线</button>
      </div>
      <div className={styles.toolGroup}>
        <button type="button" disabled={disabled || !active?.canUndo}
          title="撤销（Ctrl+Z）" onClick={() => command(() => editor.chain().focus().undo().run())}>撤销</button>
        <button type="button" disabled={disabled || !active?.canRedo}
          title="重做（Ctrl+Shift+Z）" onClick={() => command(() => editor.chain().focus().redo().run())}>重做</button>
      </div>
    </div>
    <EditorContent editor={editor} className={styles.content} />
  </div>
}
