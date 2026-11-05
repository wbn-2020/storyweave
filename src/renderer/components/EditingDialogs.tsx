import { useId, useState, type FormEvent } from 'react'
import type { BookSummary, ChapterSnapshot, ExportBookInput, UpdateBookInput, UpdateChapterInput, VolumeSummary } from '../../contracts/api'
import { Dialog } from './Dialog'
import styles from '../App.module.css'

interface Common { busy: boolean; error?: string | null; onClose: () => void }
export type BookFields = Pick<UpdateBookInput, 'title' | 'genre' | 'synopsis' | 'archived'>
export type ChapterFields = Omit<UpdateChapterInput, 'bookId' | 'chapterId' | 'expectedBookRevision'>
export type ExportFields = Pick<ExportBookInput, 'format' | 'scope' | 'includeChapterTitles'>

export function NameDialog({ title, initialValue = '', submitLabel, onSubmit, ...common }: Common & { title: string; initialValue?: string; submitLabel: string; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState(initialValue)
  const id = useId()
  function submit(event: FormEvent) { event.preventDefault(); if (!common.busy && value.trim()) onSubmit(value.trim()) }
  return <Dialog title={title} {...common}><form onSubmit={submit}>
    <label htmlFor={id}>名称</label><input id={id} autoFocus autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} maxLength={120} required disabled={common.busy} />
    <Actions {...common} label={submitLabel} disabled={!value.trim()} />
  </form></Dialog>
}

export function BookDetailsDialog({ book, onSubmit, ...common }: Common & { book: BookSummary; onSubmit: (fields: BookFields) => void }) {
  const [fields, setFields] = useState<BookFields>({ title: book.title, genre: book.genre, synopsis: book.synopsis, archived: Boolean(book.archivedAt) })
  function submit(event: FormEvent) { event.preventDefault(); if (!common.busy) onSubmit({ ...fields, title: fields.title.trim() }) }
  return <Dialog title="作品资料" {...common}><form onSubmit={submit} className={styles.fieldStack}>
    <label>作品名<input autoFocus value={fields.title} onChange={(event) => setFields({ ...fields, title: event.target.value })} maxLength={120} required disabled={common.busy} /></label>
    <label>类型<input value={fields.genre} onChange={(event) => setFields({ ...fields, genre: event.target.value })} maxLength={120} placeholder="例如：悬疑 / 奇幻" disabled={common.busy} /></label>
    <label>简介<textarea value={fields.synopsis} onChange={(event) => setFields({ ...fields, synopsis: event.target.value })} maxLength={5000} rows={5} disabled={common.busy} /></label>
    <label className={styles.checkLabel}><input type="checkbox" checked={fields.archived} onChange={(event) => setFields({ ...fields, archived: event.target.checked })} disabled={common.busy} />归档作品</label>
    <p className={styles.helpText}>归档作品可阅读、查看版本和导出。继续创作前请先解除归档。</p>
    <Actions {...common} label="保存资料" disabled={!fields.title.trim()} />
  </form></Dialog>
}

export function ChapterDetailsDialog({ chapter, volumes, onSubmit, ...common }: Common & { chapter: ChapterSnapshot; volumes: VolumeSummary[]; onSubmit: (fields: ChapterFields) => void }) {
  const [fields, setFields] = useState<ChapterFields>({ title: chapter.title, volumeId: chapter.volumeId, goal: chapter.goal, viewpoint: chapter.viewpoint, targetCharacters: chapter.targetCharacters, notes: chapter.notes, status: chapter.status === 'finalized' ? 'writing' : chapter.status })
  function submit(event: FormEvent) { event.preventDefault(); if (!common.busy) onSubmit({ ...fields, title: fields.title.trim() }) }
  return <Dialog title="本章资料" {...common}><form className={styles.fieldStack} onSubmit={submit}>
    <label>章节名<input autoFocus value={fields.title} onChange={(event) => setFields({ ...fields, title: event.target.value })} maxLength={120} required disabled={common.busy} /></label>
    <div className={styles.twoColumns}><label>所属卷<select value={fields.volumeId ?? ''} onChange={(event) => setFields({ ...fields, volumeId: event.target.value || null })} disabled={common.busy}><option value="">未分卷</option>{volumes.map((volume) => <option value={volume.id} key={volume.id}>{volume.title}</option>)}</select></label>
      <label>工作状态<select value={fields.status} onChange={(event) => setFields({ ...fields, status: event.target.value as ChapterFields['status'] })} disabled={common.busy}><option value="planned">待写</option><option value="writing">草稿</option><option value="review">待审</option></select></label></div>
    {chapter.status === 'finalized' && <p className={styles.helpText}>保存资料会重开本章工作稿，原定稿保留。重新定稿请使用“作者定稿”。</p>}
    <label>本章目标<textarea value={fields.goal} onChange={(event) => setFields({ ...fields, goal: event.target.value })} rows={3} maxLength={2000} placeholder="这一章要推进什么？" disabled={common.busy} /></label>
    <div className={styles.twoColumns}><label>叙事视角<input value={fields.viewpoint} onChange={(event) => setFields({ ...fields, viewpoint: event.target.value })} maxLength={120} disabled={common.busy} /></label>
      <label>目标字数<input type="number" min={0} max={1000000} step={1} value={fields.targetCharacters ?? ''} onChange={(event) => setFields({ ...fields, targetCharacters: event.target.value === '' ? null : Number(event.target.value) })} disabled={common.busy} /></label></div>
    <label>备注<textarea value={fields.notes} onChange={(event) => setFields({ ...fields, notes: event.target.value })} rows={4} maxLength={5000} disabled={common.busy} /></label>
    <Actions {...common} label={chapter.status === 'finalized' ? '保存并重开工作稿' : '保存资料'} disabled={!fields.title.trim()} />
  </form></Dialog>
}

export function ExportDialog({ title, finalizedCount, onSubmit, ...common }: Common & { title: string; finalizedCount: number; onSubmit: (fields: ExportFields) => void }) {
  const [fields, setFields] = useState<ExportFields>({ format: 'txt', scope: 'working', includeChapterTitles: true })
  return <Dialog title="导出作品" {...common}><form className={styles.fieldStack} onSubmit={(event) => { event.preventDefault(); if (!common.busy) onSubmit(fields) }}>
    <p className={styles.helpText}>《{title}》会按当前卷章顺序导出。在下一步选择保存位置。</p>
    <label>正文范围<select value={fields.scope} onChange={(event) => setFields({ ...fields, scope: event.target.value as ExportFields['scope'] })} disabled={common.busy}><option value="working">全部章节的当前工作稿</option><option value="finalized">已定稿版本（{finalizedCount} 章）</option></select></label>
    <p className={styles.helpText}>{fields.scope === 'finalized' ? '使用每章最近一次作者定稿，跳过从未定稿的章节；定稿后的新修改不在此范围。' : '导出前先保存编辑器中的当前正文。'}</p>
    <label>文件格式<select value={fields.format} onChange={(event) => setFields({ ...fields, format: event.target.value as ExportFields['format'] })} disabled={common.busy}><option value="txt">纯文本 .txt</option><option value="markdown">Markdown .md</option></select></label>
    <label className={styles.checkLabel}><input type="checkbox" checked={fields.includeChapterTitles} onChange={(event) => setFields({ ...fields, includeChapterTitles: event.target.checked })} disabled={common.busy} />包含章节标题</label>
    <Actions {...common} label="选择位置并导出" disabled={fields.scope === 'finalized' && finalizedCount === 0} />
  </form></Dialog>
}

export function ConfirmDialog({ title, children, label, onSubmit, ...common }: Common & { title: string; children: string; label: string; onSubmit: () => void }) {
  return <Dialog title={title} {...common}><p className={styles.helpText}>{children}</p><div className={styles.formActions}><button className={styles.button} type="button" onClick={common.onClose} disabled={common.busy}>取消</button><button className={styles.primaryButton} type="button" onClick={onSubmit} disabled={common.busy}>{common.busy ? '处理中…' : label}</button></div></Dialog>
}

function Actions({ busy, onClose, label, disabled }: Common & { label: string; disabled?: boolean }) {
  return <div className={styles.formActions}><button type="button" className={styles.button} onClick={onClose} disabled={busy}>取消</button><button type="submit" className={styles.primaryButton} disabled={busy || disabled}>{busy ? '处理中…' : label}</button></div>
}
