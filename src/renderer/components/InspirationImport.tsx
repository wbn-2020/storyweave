import { useEffect, useRef, useState } from 'react'
import type { AppError, StudioApi } from '../../contracts/api'
import { parseImportInspirationsInput, type ImportInspirationsInput } from '../../contracts/workbench'
import { sameFields, useToolSession } from './workbench-ui'
import styles from './stellar/Workspace.module.css'

interface Props { api: StudioApi; disabled: boolean; onDirtyChange: (dirty: boolean) => void; onSaved: () => void; onUnknown?: (error: AppError) => void; onRecover?: () => void }
export function InspirationImport({ api, disabled, onDirtyChange, onSaved, onUnknown, onRecover }: Props) {
  const tool = useToolSession({ api, disabled, onDirtyChange, onUnknown })
  const [draft, setDraft] = useState<ImportInspirationsInput | null>(null)
  const [reading, setReading] = useState(false)
  const [preserved, setPreserved] = useState<string | null>(null)
  const mounted = useRef(true)
  // 留存确认绑定本次内容与请求，后续导入不能沿用旧确认。
  const recoverySnapshot = tool.pending ? JSON.stringify({ requestId: tool.pending.error.requestId ?? null, input: draft }, null, 2) : ''
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  // 文件读取只响应作者显式选择；正文按有界片段保存，原文字符与顺序完整保留。
  async function load(file: File | undefined) {
    if (!file || tool.locked || tool.dirty || reading) return
    setReading(true); setPreserved(null); tool.setDirty(true); tool.setError(null)
    try {
      if (file.size > 1024 * 1024 || !/\.(txt|md|markdown)$/i.test(file.name)) throw new Error('请选择不超过 1 MiB 的 UTF-8 TXT 或 Markdown 文本；更长作品请先按章节分成文件。')
      const body = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (!body.trim() || body.includes('\0')) throw new Error('文本为空或包含无效字符。')
      const rootId = crypto.randomUUID(), parts: string[] = []
      for (let offset = 0; offset < body.length;) {
        let end = Math.min(offset + 30_000, body.length)
        if (end < body.length) {
          const line = body.lastIndexOf('\n', end - 1)
          if (line > offset + 15_000) end = line + 1
          if (/[\uD800-\uDBFF]/.test(body[end - 1]!) && /[\uDC00-\uDFFF]/.test(body[end]!)) end--
        }
        parts.push(body.slice(offset, end)); offset = end
      }
      const title = file.name.replace(/\.(txt|md|markdown)$/i, '').slice(0, 120)
      const fields = { kind: 'reference' as const, source: `作者导入：${file.name}`, tags: ['拆书参考'], bookId: null, archived: false }
      const items = [{ id: rootId, expectedRevision: 0, fields: { ...fields, parentId: null, title, body: `原始参考文本分为 ${parts.length} 段，按“原文 1”起的顺序阅读。正文保存在以下分段中。` } },
        ...parts.map((text, index) => ({ id: crypto.randomUUID(), expectedRevision: 0, fields: { ...fields, parentId: rootId, title: `${title} · 原文 ${index + 1}`, body: text } }))]
      if (mounted.current) setDraft(parseImportInspirationsInput({ items }))
    } catch (cause) { if (mounted.current) { tool.setError(cause instanceof Error ? cause.message : '无法读取文本。'); tool.setDirty(false) } }
    finally { if (mounted.current) setReading(false) }
  }
  async function save() {
    if (!draft || tool.locked || reading) return
    const input = draft
    setPreserved(null)
    await tool.write('inspiration.import', () => api.importInspirations(input), (receipt) => Boolean(receipt && Array.isArray(receipt.items)
      && receipt.items.length === input.items.length && input.items.every((entry, index) => {
        const item = receipt.items[index]
        return Boolean(item && item.id === entry.id && item.revision === 1 && item.thumbnail === null && sameFields(item, entry.fields))
      })), () => {
      setDraft(null); setPreserved(null); onSaved()
    }, '参考文本与分段已保存，可在 AI 拆书中选择需要分析的分段。')
  }
  return <details className={styles.panel}><summary>导入拆书参考文本</summary>
    <p className={styles.muted}>选择文本，检查分段后存入全局收件箱。每次 AI 拆书由你选择分析片段，参考作品与自己的小说分开保存。</p>
    <input aria-label="选择参考文本" type="file" accept=".txt,.md,.markdown" disabled={tool.locked || reading || tool.dirty} onChange={(event) => { void load(event.target.files?.[0]); event.target.value = '' }} />
    {reading && <p role="status">正在读取文本…</p>}
    {tool.error && <p className={styles.error} role="alert">{tool.error}</p>}{tool.notice && <p className={styles.notice} role="status">{tool.notice}</p>}
    {draft && <><p>{draft.items[0]?.fields.title} · {draft.items.length - 1} 个原文分段</p><div className={styles.actions}><button type="button" className={styles.primaryButton} disabled={tool.locked} onClick={() => void save()}>确认保存参考文本</button><button type="button" className={styles.button} disabled={tool.locked} onClick={() => { setDraft(null); setPreserved(null); tool.setDirty(false) }}>放弃此次导入</button></div>
      {draft.items.slice(1).map((item) => <details key={item.id}><summary>{item.fields.title} · {item.fields.body.length} 字符</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{item.fields.body}</pre></details>)}</>}
    {tool.pending && <><p className={styles.warning}>导入结果未确认，分段和标识仍保留。请先核对原请求。</p><button className={styles.button} type="button" disabled={tool.busy || !tool.pending.error.requestId} onClick={() => void tool.checkReceipt()}>核对原请求</button>
      {onRecover && <><label>导入留存<textarea readOnly rows={5} value={recoverySnapshot} /></label><label className={styles.check}><input type="checkbox" checked={preserved === recoverySnapshot} disabled={tool.busy} onChange={(event) => setPreserved(event.target.checked ? recoverySnapshot : null)} />已留存分段与导入标识，恢复后先核对收件箱</label><button className={styles.button} type="button" disabled={preserved !== recoverySnapshot || tool.busy} onClick={onRecover}>进入恢复</button></>}
    </>}
  </details>
}
