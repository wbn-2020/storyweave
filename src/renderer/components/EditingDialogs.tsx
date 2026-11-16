import { useId, useLayoutEffect, useState, type FormEvent } from 'react'
import type { BookSummary, ChapterSnapshot, ExportBookInput, UpdateBookInput, UpdateChapterInput, VolumeSummary } from '../../contracts/api'
import { Dialog } from './Dialog'
import styles from '../StellarShared.module.css'

interface Common { busy: boolean; error?: string | null; onClose: () => void }
interface DetailsRecoveryProps { message: string; checking: boolean; onCheck: () => void; onRecover: () => void }
interface DetailsCommon extends Common {
  onDirtyChange: (dirty: boolean) => void
  confirmClose: boolean
  onKeepEditing: () => void
  pendingRecovery?: DetailsRecoveryProps
}
export type BookFields = Pick<UpdateBookInput, 'title' | 'genre' | 'synopsis' | 'archived'>
export type ChapterFields = Omit<UpdateChapterInput, 'bookId' | 'chapterId' | 'expectedBookRevision'>
export type ExportFields = Pick<ExportBookInput, 'format' | 'scope' | 'includeChapterTitles'>

export function NameDialog({ title, initialValue = '', submitLabel, onSubmit, ...common }: Common & { title: string; initialValue?: string; submitLabel: string; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState(initialValue)
  const id = useId()
  function submit(event: FormEvent) { event.preventDefault(); if (!common.busy && value.trim()) onSubmit(value.trim()) }
  return <Dialog title={title} className={styles.lightDialog} {...common}><form onSubmit={submit}>
    <label htmlFor={id}>名称</label><input id={id} autoFocus autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} maxLength={120} required disabled={common.busy} />
    <Actions {...common} label={submitLabel} disabled={!value.trim()} disabledReason="请先填写名称" />
  </form></Dialog>
}

export function BookDetailsDialog({ book, onSubmit, onDirtyChange, confirmClose, onKeepEditing, pendingRecovery, ...common }: DetailsCommon & { book: BookSummary; onSubmit: (fields: BookFields) => void }) {
  const [initialFields] = useState<BookFields>({ title: book.title, genre: book.genre, synopsis: book.synopsis, archived: Boolean(book.archivedAt) })
  const [fields, setFields] = useState(initialFields)
  const dirty = fields.title !== initialFields.title || fields.genre !== initialFields.genre || fields.synopsis !== initialFields.synopsis || fields.archived !== initialFields.archived
  useDetailsDirty(dirty, onDirtyChange)
  function submit(event: FormEvent) { event.preventDefault(); if (!common.busy) onSubmit({ ...fields, title: fields.title.trim() }) }
  return <Dialog title="作品资料" className={styles.lightDialog} {...common}><form onSubmit={submit} className={styles.fieldStack}>
    {pendingRecovery && <DetailsRecovery {...pendingRecovery} content={JSON.stringify({ bookId: book.id, baseBookRevision: book.revision, fields }, null, 2)} />}
    <label>作品名<input autoFocus value={fields.title} onChange={(event) => setFields({ ...fields, title: event.target.value })} maxLength={120} required disabled={common.busy} /></label>
    <label>类型<input value={fields.genre} onChange={(event) => setFields({ ...fields, genre: event.target.value })} maxLength={120} placeholder="例如：悬疑 / 奇幻" disabled={common.busy} /></label>
    <label>简介<textarea value={fields.synopsis} onChange={(event) => setFields({ ...fields, synopsis: event.target.value })} maxLength={5000} rows={5} disabled={common.busy} /></label>
    <label className={styles.checkLabel}><input type="checkbox" checked={fields.archived} onChange={(event) => setFields({ ...fields, archived: event.target.checked })} disabled={common.busy} />归档作品</label>
    <p className={styles.helpText}>归档作品可阅读、查看版本和导出。继续创作前请先解除归档。</p>
    <DetailsActions {...common} onDirtyChange={onDirtyChange} confirmClose={confirmClose} onKeepEditing={onKeepEditing} label="保存资料" disabled={!fields.title.trim()} disabledReason="请先填写作品名" />
  </form></Dialog>
}

export function ChapterDetailsDialog({ chapter, volumes, onSubmit, onDirtyChange, confirmClose, onKeepEditing, pendingRecovery, ...common }: DetailsCommon & { chapter: ChapterSnapshot; volumes: VolumeSummary[]; onSubmit: (fields: ChapterFields) => void }) {
  const [initialFields] = useState<ChapterFields>({ title: chapter.title, volumeId: chapter.volumeId, goal: chapter.goal, viewpoint: chapter.viewpoint, targetCharacters: chapter.targetCharacters, notes: chapter.notes, status: chapter.status === 'finalized' ? 'writing' : chapter.status })
  const [fields, setFields] = useState(initialFields)
  const dirty = fields.title !== initialFields.title || fields.volumeId !== initialFields.volumeId || fields.goal !== initialFields.goal || fields.viewpoint !== initialFields.viewpoint || fields.targetCharacters !== initialFields.targetCharacters || fields.notes !== initialFields.notes || fields.status !== initialFields.status
  useDetailsDirty(dirty, onDirtyChange)
  function submit(event: FormEvent) { event.preventDefault(); if (!common.busy) onSubmit({ ...fields, title: fields.title.trim() }) }
  return <Dialog title="本章资料" className={styles.lightDialog} {...common}><form className={styles.fieldStack} onSubmit={submit}>
    {pendingRecovery && <DetailsRecovery {...pendingRecovery} content={JSON.stringify({ bookId: chapter.bookId, chapterId: chapter.id, baseBookRevision: chapter.bookRevision, fields }, null, 2)} />}
    <label>章节名<input autoFocus value={fields.title} onChange={(event) => setFields({ ...fields, title: event.target.value })} maxLength={120} required disabled={common.busy} /></label>
    <div className={styles.twoColumns}><label>所属卷<select value={fields.volumeId ?? ''} onChange={(event) => setFields({ ...fields, volumeId: event.target.value || null })} disabled={common.busy}><option value="">未分卷</option>{volumes.map((volume) => <option value={volume.id} key={volume.id}>{volume.title}</option>)}</select></label>
      <label>工作状态<select value={fields.status} onChange={(event) => setFields({ ...fields, status: event.target.value as ChapterFields['status'] })} disabled={common.busy}><option value="planned">待写</option><option value="writing">草稿</option><option value="review">待审</option></select></label></div>
    {chapter.status === 'finalized' && <p className={styles.helpText}>保存资料会重开本章工作稿，原定稿保留。重新定稿请使用“作者定稿”。</p>}
    <label>本章目标<textarea value={fields.goal} onChange={(event) => setFields({ ...fields, goal: event.target.value })} rows={3} maxLength={10000} placeholder="这一章要推进什么？" disabled={common.busy} /></label>
    <div className={styles.twoColumns}><label>叙事视角<input value={fields.viewpoint} onChange={(event) => setFields({ ...fields, viewpoint: event.target.value })} maxLength={120} disabled={common.busy} /></label>
      <label>目标字数<input type="number" min={0} max={1000000} step={1} value={fields.targetCharacters ?? ''} onChange={(event) => setFields({ ...fields, targetCharacters: event.target.value === '' ? null : Number(event.target.value) })} disabled={common.busy} /></label></div>
    <label>备注<textarea value={fields.notes} onChange={(event) => setFields({ ...fields, notes: event.target.value })} rows={4} maxLength={5000} disabled={common.busy} /></label>
    <DetailsActions {...common} onDirtyChange={onDirtyChange} confirmClose={confirmClose} onKeepEditing={onKeepEditing} label={chapter.status === 'finalized' ? '保存并重开工作稿' : '保存资料'} disabled={!fields.title.trim()} disabledReason="请先填写章节名" />
  </form></Dialog>
}

export function ExportDialog({ title, finalizedCount, onSubmit, ...common }: Common & { title: string; finalizedCount: number; onSubmit: (fields: ExportFields) => void }) {
  const [fields, setFields] = useState<ExportFields>({ format: 'txt', scope: 'working', includeChapterTitles: true })
  return <Dialog title="导出作品" className={styles.lightDialog} {...common}><form className={styles.fieldStack} onSubmit={(event) => { event.preventDefault(); if (!common.busy) onSubmit(fields) }}>
    <p className={styles.helpText}>《{title}》会按当前卷章顺序导出。在下一步选择保存位置。</p>
    <label>正文范围<select value={fields.scope} onChange={(event) => setFields({ ...fields, scope: event.target.value as ExportFields['scope'] })} disabled={common.busy}><option value="working">全部章节的当前工作稿</option><option value="finalized">已定稿版本（{finalizedCount} 章）</option></select></label>
    <p className={styles.helpText}>{fields.scope === 'finalized' ? '使用每章最近一次作者定稿，跳过从未定稿的章节；定稿后的新修改不在此范围。' : '导出前先保存编辑器中的当前正文。'}</p>
    <label>文件格式<select value={fields.format} onChange={(event) => setFields({ ...fields, format: event.target.value as ExportFields['format'] })} disabled={common.busy}><option value="txt">纯文本 .txt</option><option value="markdown">Markdown .md</option></select></label>
    <label className={styles.checkLabel}><input type="checkbox" checked={fields.includeChapterTitles} onChange={(event) => setFields({ ...fields, includeChapterTitles: event.target.checked })} disabled={common.busy} />包含章节标题</label>
    <Actions {...common} label="选择位置并导出" disabled={fields.scope === 'finalized' && finalizedCount === 0} disabledReason="当前没有已定稿章节，请先定稿或选择当前工作稿" />
  </form></Dialog>
}

export function ConfirmDialog({ title, children, label, onSubmit, ...common }: Common & { title: string; children: string; label: string; onSubmit: () => void }) {
  return <Dialog title={title} className={styles.lightDialog} {...common}><p className={styles.helpText}>{children}</p><div className={styles.formActions}><button className={styles.button} type="button" onClick={common.onClose} disabled={common.busy} title={common.busy ? '当前操作正在处理，请稍候再取消' : undefined}>取消</button><button className={styles.primaryButton} type="button" onClick={onSubmit} disabled={common.busy} title={common.busy ? '当前操作正在处理，请勿重复提交' : undefined} aria-busy={common.busy}>{common.busy ? '处理中…' : label}</button></div></Dialog>
}

function useDetailsDirty(dirty: boolean, onDirtyChange: (dirty: boolean) => void) {
  // 首次展示及字段改回原值都以表单基线为准；关窗检查在界面更新时同步取得状态。
  useLayoutEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
}

function DetailsRecovery({ message, checking, onCheck, onRecover, content }: DetailsRecoveryProps & { content: string }) {
  const [retainedContent, setRetainedContent] = useState<string | null>(null)
  const retained = retainedContent === content
  return <section role="alert" className={styles.fieldStack}><p className={styles.helpText}>{message}</p>
    <label>待确认的资料修改<textarea readOnly rows={6} value={content} onFocus={(event) => event.target.select()} /></label>
    <label className={styles.checkLabel}><input type="checkbox" checked={retained} disabled={checking} onChange={(event) => setRetainedContent(event.target.checked ? content : null)} />我已复制留存以上资料，允许进入恢复</label>
    <div className={styles.formActions}><button type="button" className={styles.button} disabled={checking} title={checking ? '正在核对原保存回执，请稍候' : undefined} aria-busy={checking} onClick={onCheck}>{checking ? '正在核对…' : '查询原保存回执'}</button>
      <button type="button" className={styles.button} disabled={checking || !retained} title={checking ? '正在核对原保存回执，请稍候' : !retained ? '请先复制留存资料，并勾选留存确认' : undefined} onClick={onRecover}>进入草稿与恢复</button></div>
  </section>
}

function DetailsActions({ confirmClose, onKeepEditing, onDirtyChange, ...common }: DetailsCommon & { label: string; disabled?: boolean; disabledReason?: string }) {
  if (!confirmClose) return <Actions {...common} />
  return <section role="alert"><p className={styles.helpText}>资料有未保存修改。请选择保存后关闭、放弃修改，或取消关闭继续编辑。关闭窗口请在处理后再次操作。</p><div className={styles.formActions}>
    <button type="button" className={styles.button} disabled={common.busy} title={common.busy ? '正在保存资料，请稍候再取消关闭' : undefined} onClick={onKeepEditing}>取消关闭</button>
    <button type="button" className={styles.button} disabled={common.busy} title={common.busy ? '正在保存资料，请稍候再放弃修改' : undefined} onClick={() => { onDirtyChange(false); common.onClose() }}>放弃修改并关闭</button>
    <button type="submit" className={styles.primaryButton} disabled={common.busy || common.disabled} title={common.busy ? '正在保存资料，请勿重复提交' : common.disabled ? common.disabledReason : undefined} aria-busy={common.busy}>{common.busy ? '处理中…' : '保存并关闭'}</button>
  </div></section>
}

function Actions({ busy, onClose, label, disabled, disabledReason }: Common & { label: string; disabled?: boolean; disabledReason?: string }) {
  return <div className={styles.formActions}><button type="button" className={styles.button} onClick={onClose} disabled={busy} title={busy ? '当前操作正在处理，请稍候再取消' : undefined}>取消</button><button type="submit" className={styles.primaryButton} disabled={busy || disabled} title={busy ? '当前操作正在处理，请勿重复提交' : disabled ? disabledReason : undefined} aria-busy={busy}>{busy ? '处理中…' : label}</button></div>
}
