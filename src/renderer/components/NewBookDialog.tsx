import { useEffect, useRef, useState } from 'react'
import type { CreateBookInput } from '../../contracts/api'
import { Dialog } from './Dialog'
import styles from '../StellarShared.module.css'
import wizard from './StellarNewBook.module.css'
import { StudioIcon } from './StudioIcon'

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
  const [step, setStep] = useState(0)
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
  const submitDisabledReason = busy ? '正在建立作品，请勿重复提交'
    : !title.trim() ? '请先填写作品名' : !firstChapterTitle.trim() ? '请先填写第一章名称' : undefined
  useEffect(() => { if (confirmCloseRequested) setConfirmClose(true) }, [confirmCloseRequested])
  useEffect(() => { callback.current(dirty || busy) }, [dirty, busy])
  useEffect(() => () => callback.current(false), [])
  function close() {
    if (busy) return
    if (dirty) setConfirmClose(true)
    else onClose()
  }
  return <Dialog title="开始一部作品" className={`${styles.lightDialog} ${wizard.dialog}`} onClose={close} busy={busy}>
    <nav className={wizard.steps} aria-label="建立作品步骤">{['作品', '种子', '确认'].map((label, index) => <button type="button" key={label} disabled={busy || index > step} title={busy ? '正在建立作品，请稍候再切换步骤' : index > step ? '请先完成当前步骤，再点击下一步' : undefined} aria-current={index === step ? 'step' : undefined} onClick={() => setStep(index)}><span>{index + 1}</span>{label}</button>)}</nav>
    <form className={wizard.form} onSubmit={(event) => { event.preventDefault(); if (busy || !title.trim() || !firstChapterTitle.trim()) return; if (step < 2) { setStep(step + 1); return }; setPreservedSnapshot(null); onSubmit({ title: title.trim(), starter: {
      firstChapterTitle: firstChapterTitle.trim(), protagonist: mode === 'seed' ? protagonist : '', desire: mode === 'seed' ? desire : '', obstacle: mode === 'seed' ? obstacle : '',
    } }) }}>
      {step === 0 && <><label>作品名<input autoFocus required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label>
      <label>第一章名称<input required maxLength={120} value={firstChapterTitle} onChange={(event) => setChapterTitle(event.target.value)} disabled={busy} /></label>
      <button type="button" className={wizard.importButton} onClick={onImport} disabled={busy || dirty} title={busy ? '正在建立作品，请稍候再导入' : dirty ? '先清空或留存当前表单' : '导入已有稿件'}><StudioIcon name="folder" />导入已有稿件</button></>}
      {step === 1 && <><div className={wizard.modes} aria-label="创作起点"><button type="button" aria-pressed={mode === 'write'} onClick={() => setMode('write')} disabled={busy} title={busy ? '正在建立作品，请稍候再切换起点' : undefined}><StudioIcon name="pen" size={24} /><strong>直接写作</strong></button><button type="button" aria-pressed={mode === 'seed'} onClick={() => setMode('seed')} disabled={busy} title={busy ? '正在建立作品，请稍候再切换起点' : undefined}><StudioIcon name="spark" size={24} /><strong>故事种子</strong></button></div>
      {mode === 'seed' ? <><label>主角是谁？<input autoFocus maxLength={500} value={protagonist} onChange={(event) => setProtagonist(event.target.value)} disabled={busy} /></label><label>主角想要什么？<textarea maxLength={2_000} rows={3} value={desire} onChange={(event) => setDesire(event.target.value)} disabled={busy} /></label><label>什么在阻止主角？<textarea maxLength={2_000} rows={3} value={obstacle} onChange={(event) => setObstacle(event.target.value)} disabled={busy} /></label><p className={wizard.note}>愿望会同时填入第一章目标，所有种子字段均可留空。</p></> : <p className={wizard.note}>建立空白第一章。</p>}</>}
      {step === 2 && <section className={wizard.preview} aria-label="作品建立预览"><StudioIcon name="books" size={32} /><h3>{title}</h3><dl><dt>第一章</dt><dd>{firstChapterTitle}</dd><dt>起点</dt><dd>{mode === 'seed' ? '故事种子' : '空白正文'}</dd>{mode === 'seed' && <><dt>主角</dt><dd>{protagonist || '待定'}</dd><dt>愿望</dt><dd>{desire || '待定'}</dd><dt>阻力</dt><dd>{obstacle || '待定'}</dd></>}</dl></section>}
      {error && <p role="alert">{error}</p>}
      {pendingRecovery && <div><p role="alert">{pendingRecovery.message}</p><button type="button" className={styles.button} onClick={pendingRecovery.onCheck} disabled={pendingRecovery.checking} title={pendingRecovery.checking ? '正在核对原建书请求，请稍候' : undefined} aria-busy={pendingRecovery.checking}>核对原请求</button><label>复制新作品表单留存<textarea readOnly rows={7} value={formSnapshot} /></label><label><input type="checkbox" checked={preserved} onChange={(event) => setPreservedSnapshot(event.target.checked ? formSnapshot : null)} />已留存表单，重连后先核对作品书架，避免重复建立</label><button type="button" className={styles.button} disabled={!preserved || pendingRecovery.checking} title={pendingRecovery.checking ? '正在核对原建书请求，请稍候' : !preserved ? '请先复制留存当前表单，并勾选留存确认' : undefined} onClick={pendingRecovery.onRecover}>进入恢复</button></div>}
      {confirmClose ? <div className={styles.formActions}><span>离开将放弃这份尚未建立的作品表单。</span><button type="button" className={styles.button} onClick={(event) => {
        // 切回操作区可能把当前 DOM 节点复用为提交按钮，须先阻止本次点击的默认提交。
        event.preventDefault(); setConfirmClose(false); onKeepEditing()
      }}>继续填写</button><button type="button" className={styles.button} onClick={() => { callback.current(false); onClose() }} disabled={busy} title={busy ? '正在建立作品，请稍候再关闭' : undefined}>放弃表单并关闭</button></div>
        : <div className={wizard.actions}><button type="button" className={styles.button} onClick={step ? () => setStep(step - 1) : close} disabled={busy} title={busy ? '正在建立作品，请稍候再返回' : undefined}>{step ? '上一步' : '取消'}</button><button type="submit" className={styles.primaryButton} disabled={busy || !title.trim() || !firstChapterTitle.trim()} title={submitDisabledReason} aria-busy={busy}>{busy ? '正在建立…' : step === 2 ? '建立并开始写作' : '下一步'}<StudioIcon name="arrow" size={16} /></button></div>}
    </form>
  </Dialog>
}
