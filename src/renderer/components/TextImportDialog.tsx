import { useEffect, useRef, useState } from 'react'
import type { ImportChapterPreview, StudioApi, TextEncoding, TextImportOptions, TextImportPreview, TextSplitMode } from '../../contracts/api'
import { request } from '../request'
import { Dialog } from './Dialog'
import styles from '../App.module.css'

interface Props { api: StudioApi; busy: boolean; error?: string | null; onClose: () => void; onCommit: (token: string, title: string) => void }

export function TextImportDialog({ api, busy, error, onClose, onCommit }: Props) {
  const [options, setOptions] = useState<TextImportOptions>({ encoding: 'utf-8', splitMode: 'headings' })
  const [preview, setPreview] = useState<TextImportPreview | null>(null)
  const [selected, setSelected] = useState<ImportChapterPreview | null>(null)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [chapterLoading, setChapterLoading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const mounted = useRef(true)
  const previewRequest = useRef(0)
  const operation = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewRequest.current += 1 } }, [])
  const optionsChanged = Boolean(preview && (preview.encoding !== options.encoding || preview.splitMode !== options.splitMode))
  const locked = busy || loading

  async function prepare(reparse: boolean) {
    if (operation.current) return
    operation.current = true
    previewRequest.current += 1
    setLoading(true); setReadError(null); setSelected(null); setChapterLoading(false)
    const result = reparse && preview
      ? await request(() => api.reparseTextImport({ token: preview.token, ...options }))
      : await request(() => api.selectTextImport(options))
    operation.current = false
    if (!mounted.current) return
    setLoading(false)
    if (!result.ok) { setReadError(result.error.message); return }
    if (!result.data) return
    setPreview(result.data); setPage(0)
    if (!reparse) setTitle(result.data.sourceName.replace(/\.[^.]+$/, '').slice(0, 120))
  }

  async function selectChapter(index: number) {
    if (!preview || optionsChanged) return
    const token = preview.token
    const ticket = ++previewRequest.current
    setChapterLoading(true); setSelected(null); setReadError(null)
    const result = await request(() => api.readImportChapter({ token, index }))
    if (!mounted.current || ticket !== previewRequest.current) return
    setChapterLoading(false)
    if (!result.ok) { setReadError(result.error.message); return }
    setSelected(result.data)
  }

  return <Dialog title="导入已有稿件" wide busy={locked} error={error ?? readError} onClose={onClose}>
    <p className={styles.helpText}>先检查编码与分章，再建立一部新作品。Markdown 按字面文本导入，当前不会还原排版格式。</p>
    <div className={styles.importOptions}><label>编码<select value={options.encoding} disabled={locked} onChange={(event) => setOptions({ ...options, encoding: event.target.value as TextEncoding })}><option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select></label>
      <label>分章方式<select value={options.splitMode} disabled={locked} onChange={(event) => setOptions({ ...options, splitMode: event.target.value as TextSplitMode })}><option value="headings">识别“第…章”等独立标题</option><option value="none">全部作为一章</option></select></label>
      <button type="button" className={styles.button} disabled={locked} onClick={() => void prepare(false)}>{loading ? '正在读取…' : preview ? '重新选文件' : '选择 TXT / MD 文件'}</button>
    </div>
    {optionsChanged && <div className={styles.inlineNotice}><span>选项已改变，先重新预览再确认导入。</span><button type="button" className={styles.button} disabled={locked} onClick={() => void prepare(true)}>重新解析</button></div>}
    {preview && <>
      <div className={styles.importSummary}><strong>{preview.sourceName}</strong><span>{preview.chapters.length.toLocaleString()} 章 · {preview.totalCharacters.toLocaleString()} 字 · {(preview.sourceBytes / 1024).toFixed(1)} KB</span></div>
      {preview.warnings.length > 0 && <ul className={styles.warningList}>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <div className={styles.previewLayout}><div className={styles.previewList}><ol>{preview.chapters.slice(page * 50, (page + 1) * 50).map((item) => <li key={item.index}><button type="button" className={selected?.index === item.index ? styles.selectedPreview : ''} disabled={locked || optionsChanged} onClick={() => void selectChapter(item.index)}><strong>{item.title}</strong><span>{item.characterCount.toLocaleString()} 字</span></button></li>)}</ol>
        {preview.chapters.length > 50 && <div className={styles.smallActions}><button type="button" onClick={() => setPage(page - 1)} disabled={page === 0 || locked}>上一页</button><span>{page + 1} / {Math.ceil(preview.chapters.length / 50)}</span><button type="button" onClick={() => setPage(page + 1)} disabled={(page + 1) * 50 >= preview.chapters.length || locked}>下一页</button></div>}
      </div><section className={styles.previewPane} aria-label="导入章节预览">{chapterLoading ? <p role="status">读取本章中…</p> : selected ? <><h3>{selected.title}</h3><pre>{selected.plainText || '（空白章节）'}</pre></> : <p>选择一章检查正文与分章位置；若出现乱码，请调整编码并重新解析。</p>}</section></div>
      <label>新作品名<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} disabled={locked} /></label>
    </>}
    <div className={styles.formActions}><button type="button" className={styles.button} onClick={onClose} disabled={locked}>取消</button><button type="button" className={styles.primaryButton} disabled={locked || !preview || !title.trim() || optionsChanged} onClick={() => { if (preview) onCommit(preview.token, title.trim()) }}>{busy ? '正在建立作品…' : '确认导入为新作品'}</button></div>
  </Dialog>
}
