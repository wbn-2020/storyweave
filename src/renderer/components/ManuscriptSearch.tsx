import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { MAX_CHAPTER_LENGTH, parseManuscript } from '../../contracts/manuscript'
import { findLiteralMatches, manuscriptLength, MAX_SEARCH_MATCHES, searchHighlightKey, type MatchResult, type SearchHighlight } from './manuscript-search'
import styles from './StellarEditor.module.css'

interface Props {
  editor: Editor
  disabled: boolean
  readOnly: boolean
  composing: boolean
  replaceOpen: boolean
  focusRequest: number
  onToggleReplace: () => void
  onClose: () => void
}
interface SearchSnapshot extends MatchResult { document: ProseMirrorNode; query: string; caseSensitive: boolean; activeIndex: number }

export function ManuscriptSearch({ editor, disabled, readOnly, composing, replaceOpen, focusRequest, onToggleReplace, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [document, setDocument] = useState(editor.state.doc)
  const [snapshot, setSnapshot] = useState<SearchSnapshot | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [inputComposing, setInputComposing] = useState(false)
  const inputComposition = useRef(false)
  const access = useRef({ disabled, readOnly, composing })
  access.current = { disabled, readOnly, composing }
  const queryInput = useRef<HTMLInputElement>(null)
  const queryId = useId(), replacementId = useId()
  const inactive = disabled || composing || inputComposing
  const ready = snapshot !== null && snapshot.document === document && snapshot.document === editor.state.doc && snapshot.query === query && snapshot.caseSensitive === caseSensitive
  const current = ready ? snapshot : null

  function highlight(state: SearchHighlight) {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, state).setMeta('addToHistory', false))
  }

  useEffect(() => {
    const onTransaction = () => { if (editor.state.doc !== document) setDocument(editor.state.doc) }
    editor.on('transaction', onTransaction)
    return () => { editor.off('transaction', onTransaction) }
  }, [editor, document])

  useEffect(() => {
    queryInput.current?.focus()
    queryInput.current?.select()
  }, [focusRequest])

  useEffect(() => {
    if (inactive || editor.isDestroyed) return
    const timer = setTimeout(() => {
      if (access.current.disabled || access.current.composing || editor.isDestroyed || editor.view.composing || inputComposition.current || editor.state.doc !== document) return
      const result = findLiteralMatches(document, query, caseSensitive)
      const nextAtSelection = result.matches.findIndex((match) => match.from >= editor.state.selection.from)
      const activeIndex = result.matches.length ? Math.max(0, nextAtSelection) : -1
      setSnapshot({ ...result, document, query, caseSensitive, activeIndex })
      highlight({ matches: result.matches, activeIndex })
    }, 120)
    return () => clearTimeout(timer)
  }, [editor, document, query, caseSensitive, inactive])

  useEffect(() => () => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(searchHighlightKey, { matches: [], activeIndex: -1 } satisfies SearchHighlight).setMeta('addToHistory', false))
  }, [editor])

  function canAct(replacing = false) {
    return !access.current.disabled && !access.current.composing && !inputComposition.current && !editor.isDestroyed && !editor.view.composing && (!replacing || (!access.current.readOnly && editor.isEditable))
  }

  function navigate(direction: -1 | 1) {
    if (!canAct() || !current?.matches.length || current.document !== editor.state.doc) return
    const activeIndex = (current.activeIndex + direction + current.matches.length) % current.matches.length
    const match = current.matches[activeIndex]!
    setSnapshot({ ...current, activeIndex }); setMessage(null)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
      .setMeta(searchHighlightKey, { matches: current.matches, activeIndex } satisfies SearchHighlight).setMeta('addToHistory', false).scrollIntoView())
  }

  function replace(all: boolean) {
    if (!canAct(true) || !current?.matches.length || current.document !== editor.state.doc || (all && current.truncated)) return
    if (replacement.includes('\n') || replacement.includes('\r')) { setMessage('替换内容需在同一行内，不支持插入段落或换行。'); return }
    const targets = all ? current.matches : [current.matches[current.activeIndex]!]
    const length = manuscriptLength(editor.state.doc) + targets.reduce((delta, match) => delta + replacement.length - (match.to - match.from), 0)
    if (length > MAX_CHAPTER_LENGTH) { setMessage('替换后会超过单章 100 万字符上限，请缩小范围或缩短替换内容。'); return }
    const transaction = closeHistory(editor.state.tr)
    let changed = 0
    try {
      // 从后向前改文字范围，段落节点与块 ID 不变；整批仅派发一个正文事务。
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        const match = targets[index]!
        if (transaction.doc.textBetween(match.from, match.to) === replacement) continue
        if (replacement) {
          const start = transaction.doc.resolve(match.from)
          const marks = start.nodeAfter?.marks ?? start.marks()
          transaction.replaceWith(match.from, match.to, transaction.doc.type.schema.text(replacement, marks))
        } else transaction.delete(match.from, match.to)
        changed += 1
      }
      if (!changed) { setMessage('替换内容与所选文字相同，正文未修改。'); return }
      parseManuscript(transaction.doc.toJSON())
      const nextPosition = transaction.mapping.map(targets[0]!.to, 1)
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(nextPosition)))
    } catch { setMessage('替换内容未能通过正文结构检查，未提交本次替换。请缩小范围后重试。'); return }
    editor.view.dispatch(transaction.scrollIntoView())
    // 与前后键入分开分组，使 Ctrl+Z 一次撤销整次替换。
    editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false))
    editor.view.focus()
    setMessage('已替换 ' + changed.toLocaleString() + ' 处，可用 Ctrl+Z 撤销。')
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || inputComposition.current || event.keyCode === 229) { event.stopPropagation(); return }
    if (event.key === 'Enter') { event.preventDefault(); navigate(event.shiftKey ? -1 : 1) }
  }

  return <section className={styles.searchPanel} aria-label="当前章节查找与替换">
    <div className={styles.searchRow}>
      <label className={styles.searchField} htmlFor={queryId}><span>查找</span><input id={queryId} ref={queryInput} value={query} maxLength={500} placeholder="输入要查找的文字" autoComplete="off" disabled={disabled || composing}
        onCompositionStart={() => { inputComposition.current = true; setInputComposing(true) }} onCompositionEnd={() => { inputComposition.current = false; setInputComposing(false) }}
        onChange={(event) => { setQuery(event.target.value); setMessage(null) }} onKeyDown={keyDown} /></label>
      <span className={styles.searchCount} role="status">{!query ? '输入关键词' : !current ? '查找中…' : !current.matches.length ? '0 处匹配' : (current.activeIndex + 1) + ' / ' + current.matches.length.toLocaleString() + (current.truncated ? '+' : '')}</span>
      <div className={styles.searchButtons}><button type="button" onClick={() => navigate(-1)} disabled={inactive || !current?.matches.length} title="上一个（Shift+Enter）">上一处</button><button type="button" onClick={() => navigate(1)} disabled={inactive || !current?.matches.length} title="下一个（Enter）">下一处</button><button type="button" onClick={onClose} disabled={inactive} aria-label="关闭查找（Escape）">×</button></div>
    </div>
    <div className={styles.searchOptions}><label><input type="checkbox" checked={caseSensitive} onChange={(event) => { setCaseSensitive(event.target.checked); setMessage(null) }} disabled={inactive} />区分大小写</label><button type="button" onClick={onToggleReplace} disabled={inactive} aria-expanded={replaceOpen}>{replaceOpen ? '收起替换' : '展开替换'}</button><span>仅本章 · 字面匹配 · 不跨段落或换行</span></div>
    {replaceOpen && <div className={styles.searchRow}><label className={styles.searchField} htmlFor={replacementId}><span>替换为</span><input id={replacementId} value={replacement} maxLength={5000} placeholder="留空将删除匹配文字" autoComplete="off" disabled={disabled || readOnly || composing}
      onCompositionStart={() => { inputComposition.current = true; setInputComposing(true) }} onCompositionEnd={() => { inputComposition.current = false; setInputComposing(false) }} onChange={(event) => { setReplacement(event.target.value); setMessage(null) }} onKeyDown={keyDown} /></label>
      <div className={styles.searchButtons}><button type="button" disabled={inactive || readOnly || !current?.matches.length} onClick={() => replace(false)}>替换当前</button><button type="button" disabled={inactive || readOnly || !current?.matches.length || current.truncated} onClick={() => replace(true)}>全部替换</button></div>
    </div>}
    {readOnly && <p className={styles.searchHint}>当前作品只读，可以查找与定位；解除归档后才能替换。</p>}
    {current?.truncated && <p className={styles.searchWarning} role="status">匹配超过 {MAX_SEARCH_MATCHES.toLocaleString()} 处，仅展示前 {MAX_SEARCH_MATCHES.toLocaleString()} 处；全部替换已停用，请缩小关键词范围。</p>}
    {replaceOpen && !readOnly && <p className={styles.searchHint}>替换文字沿用匹配起点格式；其余正文格式保留。</p>}
    {message && <p className={styles.searchHint} role="status">{message}</p>}
  </section>
}
