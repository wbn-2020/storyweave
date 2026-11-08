import { useEffect, useRef, useState } from 'react'
import type { CreateBookInput } from '../../contracts/api'
import { Dialog } from './Dialog'
import styles from '../App.module.css'

interface Props {
  busy: boolean; error?: string | null; onSubmit: (input: CreateBookInput) => void; onImport: () => void
  onClose: () => void; onDirtyChange: (dirty: boolean) => void
  onKeepEditing: () => void
  confirmCloseRequested?: boolean
  pendingRecovery?: { message: string; checking: boolean; onCheck: () => void; onRecover: () => void }
}
export function NewBookDialog({ busy, error, onSubmit, onImport, onClose, onDirtyChange, onKeepEditing, confirmCloseRequested, pendingRecovery }: Props) {
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'write' | 'seed'>('write')
  const [firstChapterTitle, setChapterTitle] = useState('第一章')
  const [protagonist, setProtagonist] = useState('')
  const [desire, setDesire] = useState('')
  const [obstacle, setObstacle] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const [preservedSnapshot, setPreservedSnapshot] = useState<string | null>(null)
  const callback = useRef(onDirtyChange)
  callback.current = onDirtyChange
  const dirty = Boolean(title || protagonist || desire || obstacle || firstChapterTitle !== '第一章')
  const formSnapshot = JSON.stringify({ mode, title, firstChapterTitle, protagonist, desire, obstacle }, null, 2)
  const preserved = preservedSnapshot === formSnapshot
  useEffect(() => { if (confirmCloseRequested) setConfirmClose(true) }, [confirmCloseRequested])
  useEffect(() => { callback.current(dirty || busy) }, [dirty, busy])
  useEffect(() => () => callback.current(false), [])
  function close() {
    if (busy) return
    if (dirty) setConfirmClose(true)
    else onClose()
  }
  return <Dialog title="开始一部作品" className={styles.lightDialog} onClose={close}>
    <form onSubmit={(event) => { event.preventDefault(); if (busy) return; setPreservedSnapshot(null); onSubmit({ title: title.trim(), starter: {
      firstChapterTitle: firstChapterTitle.trim(), protagonist: mode === 'seed' ? protagonist : '', desire: mode === 'seed' ? desire : '', obstacle: mode === 'seed' ? obstacle : '',
    } }) }}>
      <p>可以直接写第一章，也可以用三个问题留下故事前提。种子内容都可以跳过或稍后修改。</p>
      <div className={styles.formActions}><button type="button" className={styles.button} aria-pressed={mode === 'write'} onClick={() => setMode('write')} disabled={busy}>直接写作</button><button type="button" className={styles.button} aria-pressed={mode === 'seed'} onClick={() => setMode('seed')} disabled={busy}>从故事种子开始</button><button type="button" className={styles.button} onClick={onImport} disabled={busy || dirty}>导入已有稿件</button></div>
      <label>作品名<input autoFocus required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label>
      <label>第一章名称<input required maxLength={120} value={firstChapterTitle} onChange={(event) => setChapterTitle(event.target.value)} disabled={busy} /></label>
      {mode === 'seed' && <><label>主角是谁？<input maxLength={500} value={protagonist} onChange={(event) => setProtagonist(event.target.value)} disabled={busy} /></label><label>主角想要什么？<textarea maxLength={2_000} rows={3} value={desire} onChange={(event) => setDesire(event.target.value)} disabled={busy} /></label><label>什么在阻止主角？<textarea maxLength={2_000} rows={3} value={obstacle} onChange={(event) => setObstacle(event.target.value)} disabled={busy} /></label><p>这些内容会成为作品前提；愿望同时填入第一章目标，之后可在规划与审稿中调整。</p></>}
      {error && <p role="alert">{error}</p>}
      {pendingRecovery && <div><p role="alert">{pendingRecovery.message}</p><button type="button" className={styles.button} onClick={pendingRecovery.onCheck} disabled={pendingRecovery.checking}>核对原请求</button><label>复制新作品表单留存<textarea readOnly rows={7} value={formSnapshot} /></label><label><input type="checkbox" checked={preserved} onChange={(event) => setPreservedSnapshot(event.target.checked ? formSnapshot : null)} />已留存表单，重连后先核对作品书架，避免重复建立</label><button type="button" className={styles.button} disabled={!preserved || pendingRecovery.checking} onClick={pendingRecovery.onRecover}>进入恢复</button></div>}
      {confirmClose ? <div className={styles.formActions}><span>离开将放弃这份尚未建立的作品表单。</span><button type="button" className={styles.button} onClick={() => { setConfirmClose(false); onKeepEditing() }}>继续填写</button><button type="button" className={styles.button} onClick={() => { callback.current(false); onClose() }} disabled={busy}>放弃表单并关闭</button></div>
        : <div className={styles.formActions}><button type="button" className={styles.button} onClick={close} disabled={busy}>取消</button><button type="submit" className={styles.primaryButton} disabled={busy || !title.trim() || !firstChapterTitle.trim()}>建立并开始写作</button></div>}
    </form>
  </Dialog>
}
