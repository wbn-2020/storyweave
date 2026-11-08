import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DomainError, type AppError, type BookSnapshot, type BookSummary, type StudioApi } from '../../contracts/api'
import { MAX_NOTE_BODY, NOTE_SCHEMA_VERSION, type NoteFields } from '../../contracts/notes'
import {
  INSPIRATION_KINDS, parseCopyInspirationInput, parseInspirationFields, parseListInspirationInput, parseSaveInspirationInput,
  type CopyInspirationInput, type InspirationFields, type InspirationItem, type InspirationPage, type ListInspirationInput, type SaveInspirationInput,
} from '../../contracts/workbench'
import { displayTime, request } from '../request'
import { sameFields, useToolSession } from './workbench-ui'
import ui from './WorkbenchPanel.module.css'
import styles from './InspirationPanel.module.css'

export interface InspirationPanelProps {
  api: StudioApi
  books: BookSummary[]
  activeBook?: BookSnapshot | BookSummary | null
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onUnknown?: (error: AppError) => void
  onBookChanged: (bookId: string) => void | Promise<void>
  onRecover?: () => void
}

interface Draft { input: SaveInspirationInput; tags: string }
interface Listing { search: string; bookId: string; includeArchived: boolean; offset: number }
interface CopyDraft {
  source: InspirationItem
  noteId: string
  targetBookId: string
  target: BookSnapshot | null
  requiresUpgrade: boolean
}
const kindLabels: Record<InspirationFields['kind'], string> = {
  idea: '灵感', reference: '参考作品', observation: '场景观察', excerpt: '摘录', technique: '手法分析', method: '方法卡',
}
const nextKind: Record<InspirationFields['kind'], InspirationFields['kind']> = {
  idea: 'observation', reference: 'observation', observation: 'excerpt', excerpt: 'technique', technique: 'method', method: 'observation',
}
const firstListing: Listing = { search: '', bookId: '', includeArchived: false, offset: 0 }
function savedFields(item: InspirationItem): InspirationFields {
  return { kind: item.kind, title: item.title, body: item.body, source: item.source, tags: [...item.tags], parentId: item.parentId, bookId: item.bookId, archived: item.archived }
}
function asNote(source: InspirationItem): NoteFields {
  const attribution = [`灵感来源：${source.title}`, source.source && `出处：${source.source}`, source.tags.length && `标签：${source.tags.join('、')}`].filter(Boolean).join('\n')
  return { title: source.title, category: source.kind === 'method' || source.kind === 'technique' ? 'method' : source.kind === 'idea' ? 'inspiration' : 'material', body: `${source.body}\n\n${attribution}` }
}
function validItem(value: InspirationItem): boolean {
  try {
    return Boolean(value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) && value.revision > 0
      && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string' && sameFields(value, parseInspirationFields(value)))
  } catch { return false }
}
function validPage(value: InspirationPage, offset: number): boolean {
  return Boolean(value && Array.isArray(value.items) && value.items.length <= 50 && value.items.every(validItem)
    && new Set(value.items.map((item) => item.id)).size === value.items.length && Number.isSafeInteger(value.total) && value.total >= 0
    && (value.nextOffset === null || value.items.length > 0 && value.nextOffset === offset + value.items.length && value.nextOffset < value.total))
}

export function InspirationPanel({ api, books, activeBook, disabled, onDirtyChange, onUnknown, onBookChanged, onRecover }: InspirationPanelProps) {
  const currentBook = activeBook && ('book' in activeBook ? activeBook.book : activeBook)
  const tool = useToolSession({ api, disabled, onDirtyChange, onUnknown })
  const [page, setPage] = useState<InspirationPage | null>(null)
  const [listing, setListing] = useState<Listing>(firstListing)
  const [filters, setFilters] = useState(firstListing)
  const [kind, setKind] = useState<InspirationFields['kind'] | ''>('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [discard, setDiscard] = useState(false)
  const [recoveryPreserved, setRecoveryPreserved] = useState(false)
  const [copy, setCopy] = useState<CopyDraft | null>(null)
  const [parentNames, setParentNames] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<InspirationItem | null>(null)
  const freshRef = useRef(true)
  const editorRef = useRef<HTMLFormElement>(null)
  const visible = (page?.items ?? []).filter((item) => !kind || item.kind === kind)
  const copyFields = copy ? asNote(copy.source) : null
  const copyTooLarge = Boolean(copyFields && (copyFields.title.length > 120 || copyFields.body.length > MAX_NOTE_BODY))

  useEffect(() => { if (!disabled && freshRef.current) { freshRef.current = false; void load(firstListing) } }, [disabled])
  useEffect(() => () => { freshRef.current = true }, [])
  useEffect(() => { if (draft) { editorRef.current?.scrollIntoView({ block: 'nearest' }); editorRef.current?.focus({ preventScroll: true }) } }, [draft?.input.id])
  useEffect(() => { setRecoveryPreserved(false) }, [tool.pending])

  function canSwitch() {
    if (!tool.canLeave()) { tool.setError('请先保存、放弃当前更改或核对原请求，再切换内容。'); return false }
    return true
  }
  function changed(next: Draft) { setDraft(next); setDiscard(false); tool.setDirty(true); tool.setNotice(null) }
  function remember(items: InspirationItem[]) { setParentNames((previous) => ({ ...previous, ...Object.fromEntries(items.map((item) => [item.id, item.title])) })) }
  async function load(next: Listing, keepEditor = false) {
    if (!canSwitch()) return
    let input: ListInspirationInput
    try { input = parseListInspirationInput({ search: next.search, ...(next.bookId ? { bookId: next.bookId } : {}), includeArchived: next.includeArchived, offset: next.offset }) }
    catch (failure) { tool.setError(failure instanceof DomainError ? failure.detail.message : '筛选条件无效。'); return }
    await tool.read(() => api.listInspirations(input), (value) => {
      if (!validPage(value, next.offset)) throw new Error('Invalid inspiration page')
      setPage(value); setListing(next); setFilters(next); remember(value.items)
      if (!keepEditor) { setDraft(null); setCopy(null); setSelected(null); setDiscard(false) }
    })
  }
  function open(item: InspirationItem) {
    if (!canSwitch()) return
    setSelected(item); setCopy(null); setDiscard(false)
    setDraft({ input: { id: item.id, expectedRevision: item.revision, fields: savedFields(item) }, tags: item.tags.join('，') })
    tool.setError(null); tool.setNotice(null)
  }
  function create(parent?: InspirationItem, initialKind: InspirationFields['kind'] = 'idea') {
    if (!canSwitch()) return
    if (parent) remember([parent])
    const fields: InspirationFields = { kind: parent ? nextKind[parent.kind] : initialKind, title: '', body: '',
      source: parent?.source ?? '', tags: parent ? [...parent.tags] : [], parentId: parent?.id ?? null,
      bookId: parent?.bookId ?? null, archived: false }
    setSelected(null); setCopy(null); setDiscard(false)
    setDraft({ input: { id: crypto.randomUUID(), expectedRevision: 0, fields }, tags: fields.tags.join('，') })
    tool.setDirty(Boolean(parent))
    tool.setError(null); tool.setNotice(null)
  }
  function closeEditor() {
    if (tool.locked) return
    if (tool.dirty && !discard) { setDiscard(true); return }
    setDraft(null); setSelected(null); setCopy(null); setDiscard(false); tool.setDirty(false); tool.setError(null)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || tool.locked) return
    let input: SaveInspirationInput
    try { input = parseSaveInspirationInput({ ...draft.input, fields: { ...draft.input.fields, tags: draft.tags.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean) } }) }
    catch (failure) { tool.setError(failure instanceof DomainError ? failure.detail.message : '请检查灵感内容后重试。'); return }
    const success = await tool.write('inspiration.save', () => api.saveInspiration(input), (value) => validItem(value) && value.id === input.id
      && value.revision === input.expectedRevision + 1 && sameFields(value, input.fields), (value) => {
      setSelected(value); remember([value]); setDiscard(false)
      setDraft({ input: { id: value.id, expectedRevision: value.revision, fields: savedFields(value) }, tags: value.tags.join('，') })
    }, input.fields.archived ? '灵感已归档，原文和参考链均已保留。' : '灵感已保存。')
    if (success) await load({ ...listing, offset: 0 }, true)
  }
  function startCopy(source: InspirationItem) {
    if (!canSwitch()) return
    setDraft(null); setSelected(source); setDiscard(false)
    setCopy({ source, noteId: crypto.randomUUID(), targetBookId: currentBook && !currentBook.archivedAt ? currentBook.id : '', target: null, requiresUpgrade: false })
    tool.setError(null); tool.setNotice(null)
  }
  async function prepareCopy() {
    if (!copy || !copy.targetBookId || copyTooLarge || tool.locked) return
    const intended = copy
    await tool.read(async () => {
      const nextBook = await api.getBook({ bookId: intended.targetBookId })
      if (!nextBook.ok) return nextBook
      const status = await api.getKnowledgeStatus({ bookId: intended.targetBookId })
      if (!status.ok) return status
      if (nextBook.data.book.id !== intended.targetBookId || status.data.bookId !== intended.targetBookId || nextBook.data.book.revision !== status.data.bookRevision) {
        return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '作品在准备期间发生变化，请重新读取。' } }
      }
      return { ok: true as const, data: { book: nextBook.data, requiresUpgrade: status.data.schemaVersion < NOTE_SCHEMA_VERSION } }
    }, (value) => {
      if (value.book.book.archivedAt) { tool.setError('目标作品已归档，请先恢复作品，或选择其他作品。'); return }
      setCopy({ ...intended, target: value.book, requiresUpgrade: value.requiresUpgrade })
    })
  }
  function notifyBook(bookId: string) {
    void Promise.resolve().then(() => onBookChanged(bookId)).catch(() => tool.setError('笔记写入已确认；作品目录未同步，请在主窗口刷新作品。'))
  }
  async function upgradeTarget() {
    if (!copy?.target || !copy.requiresUpgrade || tool.locked) return
    const intended = copy
    const bookId = copy.target.book.id
    const expectedBookRevision = copy.target.book.revision
    const success = await tool.write('knowledge.upgrade', () => api.upgradeKnowledge({ bookId, expectedBookRevision }), (value) => value.bookId === bookId
      && value.bookRevision >= expectedBookRevision && value.schemaVersion >= NOTE_SCHEMA_VERSION && !value.requiresUpgrade, () => {
      setCopy({ ...intended, target: null, requiresUpgrade: false }); notifyBook(bookId)
    }, '作品备份和升级已完成，请重新读取复制目标。')
    if (success) tool.setNotice('作品备份和升级已完成，请点击“读取目标并预览”取得新版本。')
  }
  async function confirmCopy() {
    if (!copy?.target || copy.requiresUpgrade || copyTooLarge || tool.locked) return
    const fields = asNote(copy.source)
    let input: CopyInspirationInput
    try { input = parseCopyInspirationInput({ bookId: copy.target.book.id, expectedBookRevision: copy.target.book.revision,
      id: copy.source.id, expectedRevision: copy.source.revision, noteId: copy.noteId }) }
    catch (failure) { tool.setError(failure instanceof DomainError ? failure.detail.message : '复制目标无效。'); return }
    await tool.write('inspiration.copy', () => api.copyInspirationToNote(input), (value) => value.id === input.noteId && value.bookId === input.bookId
      && Number.isSafeInteger(value.revision) && value.revision >= 1 && value.bookRevision >= input.expectedBookRevision
      && sameFields(value, fields), () => { setCopy(null); notifyBook(input.bookId) }, '已复制到作品笔记，出处和标签已写入笔记；收件箱原件保留。')
  }

  return <section className={`${ui.panel} ${styles.panel}`} aria-label="灵感与拆书收件箱" aria-busy={tool.busy}>
    <div className={ui.heading}><div><h3>灵感与拆书</h3><p className={ui.muted}>随时收集，再把观察整理成自己的方法。</p></div><div className={ui.actions}><button className={ui.primaryButton} type="button" disabled={tool.locked} onClick={() => create()}>记一条灵感</button><button className={ui.button} type="button" disabled={tool.locked} onClick={() => create(undefined, 'reference')}>添加参考作品</button></div></div>
    <p className={ui.muted}>收件箱属于当前书库，独立于作品保存；单部作品恢复包不包含这里的原件。</p>
    {tool.error && <p className={ui.error} role="alert">{tool.error}</p>}
    {tool.notice && <p className={ui.notice} role="status">{tool.notice}</p>}
    {tool.pending && <div className={ui.warning}><p>保存结果尚未确认，表单与本次复制标识已保留。核对原请求前暂停写入。</p><div className={ui.actions}>{tool.pending.error.requestId && <button className={ui.button} type="button" disabled={tool.busy} onClick={() => void tool.checkReceipt().then((success) => { if (success) void load({ ...listing, offset: 0 }, true) })}>核对原请求</button>}</div><p>若服务连接已中断，请先保留当前输入，再从主窗口的草稿恢复入口重新连接并核对资料。不会自动重发本次复制。</p>{onRecover && <><label className={ui.check}><input type="checkbox" checked={recoveryPreserved} onChange={(event) => setRecoveryPreserved(event.target.checked)} />我已留存当前输入与复制标识，可以离开面板恢复</label><button className={ui.button} type="button" disabled={tool.busy || !recoveryPreserved} onClick={onRecover}>打开主窗口恢复</button></>}</div>}
    {(tool.pending || tool.error) && (draft || copy) && <details className={ui.details}><summary>查看并复制当前输入留存</summary><textarea readOnly rows={10} value={JSON.stringify(draft ?? copy, null, 2)} aria-label="尚未确认的灵感内容与复制标识" /></details>}
    <form className={ui.toolbar} onSubmit={(event) => { event.preventDefault(); void load({ ...filters, offset: 0 }) }}>
      <label>查找内容<input type="search" maxLength={200} value={filters.search} disabled={tool.locked} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="标题、内容或标签" /></label>
      <label>关联作品<select value={filters.bookId} disabled={tool.locked} onChange={(event) => setFilters({ ...filters, bookId: event.target.value })}><option value="">全部作品与未关联内容</option>{books.map((item) => <option key={item.id} value={item.id}>{item.title}{item.archivedAt ? '（已归档）' : ''}</option>)}</select></label>
      <label className={ui.check}><input type="checkbox" checked={filters.includeArchived} disabled={tool.locked} onChange={(event) => setFilters({ ...filters, includeArchived: event.target.checked })} />包含已归档</label><button className={ui.button} type="submit" disabled={tool.locked || tool.dirty}>筛选 / 刷新</button>
    </form>
    <div className={ui.toolbar}><label>本页类型<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="">所有类型</option>{INSPIRATION_KINDS.map((item) => <option key={item} value={item}>{kindLabels[item]}</option>)}</select></label><p className={ui.muted}>参考作品 → 场景观察 → 摘录 → 手法分析 → 方法卡</p></div>
    <div className={styles.layout}><div className={styles.listPane}>
      {!page ? <div className={ui.empty}><p>{tool.busy ? '正在读取收件箱…' : '尚未取得收件箱资料，请点击筛选 / 刷新。'}</p></div>
        : !visible.length ? <div className={ui.empty}><h4>{page.total ? '本页没有匹配类型' : '留住还没找到归属的想法'}</h4><p>{page.total ? '可切换本页类型，或翻页继续查找。' : '写下一个画面、一句对白，或添加一本参考作品。以后再关联作品、补充出处。'}</p><button className={ui.button} type="button" disabled={tool.locked} onClick={() => create()}>新建灵感</button></div>
          : <ul className={styles.items}>{visible.map((item) => <li key={item.id} className={selected?.id === item.id ? styles.selected : undefined}>
            <button className={styles.itemTitle} type="button" disabled={tool.locked} aria-pressed={selected?.id === item.id} onClick={() => open(item)}><span>{kindLabels[item.kind]}{item.archived ? ' · 已归档' : ''}</span><strong>{item.title}</strong></button>
            <p className={styles.preview}>{item.body || '尚未填写内容'}</p>{item.source && <p className={ui.muted}>出处：{item.source}</p>}{item.parentId && <p className={ui.muted}>上级：{parentNames[item.parentId] ?? `参考条目 ${item.parentId}`}</p>}
            {!!item.tags.length && <p className={styles.tags}>{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</p>}<p className={ui.muted}>{item.bookId ? books.find((entry) => entry.id === item.bookId)?.title ?? '关联作品暂不在书架' : '未关联作品'} · {displayTime(item.updatedAt)}</p>
            <div className={ui.actions}><button className={ui.button} type="button" disabled={tool.locked} onClick={() => create(item)}>继续写{kindLabels[nextKind[item.kind]]}</button><button className={ui.button} type="button" disabled={tool.locked || !books.some((entry) => !entry.archivedAt)} onClick={() => startCopy(item)}>复制到作品笔记</button></div>
          </li>)}</ul>}
      {page && <div className={styles.paging}><button className={ui.button} type="button" disabled={tool.locked || tool.dirty || listing.offset === 0} onClick={() => void load({ ...listing, offset: Math.max(0, listing.offset - 50) })}>上一页</button><span className={ui.muted}>{page.items.length ? `${listing.offset + 1}–${listing.offset + page.items.length} / ${page.total}` : `共 ${page.total} 条`} · 每页最多 50 条</span><button className={ui.button} type="button" disabled={tool.locked || tool.dirty || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) void load({ ...listing, offset: page.nextOffset }) }}>下一页</button></div>}
    </div><div className={styles.detailPane}>
      {draft && <form ref={editorRef} tabIndex={-1} className={styles.editor} onSubmit={(event) => void save(event)}>
        <div className={ui.heading}><h4>{draft.input.expectedRevision ? '编辑收集条目' : '新建收集条目'}</h4><span className={ui.muted}>{tool.dirty ? '有未保存更改' : '尚未修改'}</span></div>
        <fieldset disabled={tool.locked}><div className={ui.fields}><div className={ui.fieldGrid}>
          <label>类型<select value={draft.input.fields.kind} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, kind: event.target.value as InspirationFields['kind'] } } })}>{INSPIRATION_KINDS.map((item) => <option key={item} value={item}>{kindLabels[item]}</option>)}</select></label>
          <label>关联作品<select value={draft.input.fields.bookId ?? ''} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, bookId: event.target.value || null } } })}><option value="">暂不关联</option>{draft.input.fields.bookId && !books.some((item) => item.id === draft.input.fields.bookId) && <option value={draft.input.fields.bookId}>原关联作品暂不在书架</option>}{books.map((item) => <option key={item.id} value={item.id}>{item.title}{item.archivedAt ? '（已归档）' : ''}</option>)}</select></label></div>
          <label>标题<input required maxLength={160} value={draft.input.fields.title} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, title: event.target.value } } })} /></label>
          <label>{draft.input.fields.kind === 'excerpt' ? '摘录内容' : draft.input.fields.kind === 'method' ? '方法与适用条件' : draft.input.fields.kind === 'technique' ? '写法、作用与分析' : '内容'}<textarea rows={10} maxLength={40000} value={draft.input.fields.body} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, body: event.target.value } } })} /></label>
          <label>出处<textarea rows={2} maxLength={2000} placeholder="作品、作者、章节、页码或链接；记录足够的回查线索" value={draft.input.fields.source} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, source: event.target.value } } })} /></label>
          <label>标签<input maxLength={1100} placeholder="用逗号分隔，最多 20 个，每个最多 50 字符" value={draft.tags} onChange={(event) => changed({ ...draft, tags: event.target.value })} /></label>
          <InspirationParentPicker key={draft.input.id} api={api} id={draft.input.id} value={draft.input.fields.parentId} label={draft.input.fields.parentId ? parentNames[draft.input.fields.parentId] : undefined} disabled={tool.locked}
            onChange={(parent) => { if (parent) remember([parent]); changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, parentId: parent?.id ?? null } } }) }} />
          <label className={ui.check}><input type="checkbox" checked={draft.input.fields.archived} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, archived: event.target.checked } } })} />归档条目（原文、出处与参考链继续保留）</label>
          <p className={ui.muted}>关联作品只标记归属。点击“复制到作品笔记”才会在作品内新增笔记，后续可在笔记中明确转为设定。</p>
        </div></fieldset>
        <div className={ui.actions}><button className={ui.primaryButton} type="submit" disabled={tool.locked || Boolean(draft.input.expectedRevision && !tool.dirty)}>{tool.busy ? '正在保存…' : '保存条目'}</button><button className={ui.button} type="button" disabled={tool.locked} onClick={closeEditor}>{tool.dirty ? '放弃未保存更改' : '收起编辑'}</button></div>
        {discard && <div className={ui.warning} role="alert"><p>确定放弃这份表单的未保存更改？已保存原件会保留。</p><div className={ui.actions}><button className={ui.button} type="button" onClick={closeEditor}>确认放弃</button><button className={ui.button} type="button" onClick={() => setDiscard(false)}>继续编辑</button></div></div>}
        {selected && <div className={ui.actions}><button className={ui.button} type="button" disabled={tool.locked || tool.dirty} onClick={() => create(selected)}>以此继续写{kindLabels[nextKind[selected.kind]]}</button><button className={ui.button} type="button" disabled={tool.locked || tool.dirty || !books.some((item) => !item.archivedAt)} onClick={() => startCopy(selected)}>复制已保存版本到作品笔记</button></div>}
      </form>}
      {copy && copyFields && <section className={styles.copy} aria-label="复制到作品笔记"><div className={ui.heading}><h4>复制“{copy.source.title}”</h4><button className={ui.button} type="button" disabled={tool.locked} onClick={() => setCopy(null)}>取消复制</button></div><p className={ui.muted}>原件与参考链留在收件箱，作品笔记中保留出处和标签。</p>
        <label>目标作品<select value={copy.targetBookId} disabled={tool.locked} onChange={(event) => setCopy({ ...copy, targetBookId: event.target.value, target: null, requiresUpgrade: false })}><option value="">选择作品</option>{books.filter((item) => !item.archivedAt).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        {copyTooLarge && <p className={ui.warning}>这条灵感超过作品笔记的限制（标题 120 字符、含出处的正文 20,000 字符）。请保留原件，先将需要的部分整理为一条子记录，再复制。</p>}
        <div className={ui.actions}><button className={ui.button} type="button" disabled={tool.locked || !copy.targetBookId || copyTooLarge} onClick={() => void prepareCopy()}>读取目标并预览</button></div>
        {copy.target && <><details className={ui.details} open><summary>将复制到《{copy.target.book.title}》的笔记内容</summary><textarea readOnly rows={8} value={copyFields.body} aria-label="复制后的完整笔记内容" /></details>
          {copy.requiresUpgrade ? <div className={ui.warning}><p>这部作品需要先备份升级才能使用笔记。</p><button className={ui.button} type="button" disabled={tool.locked} onClick={() => void upgradeTarget()}>备份并升级目标作品</button></div>
            : <button className={ui.primaryButton} type="button" disabled={tool.locked || copyTooLarge} onClick={() => void confirmCopy()}>确认复制到作品笔记</button>}</>}
      </section>}
      {!draft && !copy && <div className={styles.guide}><h4>从看到，到看懂，再到会用</h4><p>选中条目可补充出处与标签；“继续写”会新建有上级来源的子记录。</p><p>参考作品记录整体印象，场景观察记录发生了什么，摘录留证据，手法分析解释作用，方法卡总结适用条件。</p></div>}
    </div></div>
  </section>
}

function InspirationParentPicker({ api, id, value, label, disabled, onChange }: {
  api: StudioApi; id: string; value: string | null; label?: string; disabled: boolean; onChange: (parent: InspirationItem | null) => void
}) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<InspirationPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const ticket = useRef(0)
  useEffect(() => { active.current = true; return () => { active.current = false; ticket.current += 1 } }, [])
  async function load(nextSearch: string, nextOffset: number) {
    if (disabled || loading) return
    const expected = ++ticket.current
    setLoading(true); setError(null)
    const result = await request(() => api.listInspirations({ search: nextSearch.trim(), offset: nextOffset, includeArchived: true }))
    if (!active.current || ticket.current !== expected) return
    setLoading(false)
    if (!result.ok) { setError(result.error.message); return }
    if (!validPage(result.data, nextOffset)) { setError('参考条目分页回执无效，请重新查询。'); return }
    setPage(result.data); setQuery(nextSearch); setOffset(nextOffset)
  }
  return <details className={ui.details}><summary>上级参考：{value ? label ?? value : '无（独立条目）'}</summary>
    {value && <button className={ui.button} type="button" disabled={disabled || loading} onClick={() => onChange(null)}>改为独立条目</button>}
    <div className={ui.toolbar}><label>查找上级参考<input type="search" value={search} maxLength={200} disabled={disabled || loading} onChange={(event) => setSearch(event.target.value)} /></label><button className={ui.button} type="button" disabled={disabled || loading} onClick={() => void load(search, 0)}>{loading ? '查找中…' : '查找条目'}</button></div>
    {error && <p className={ui.error} role="alert">{error}</p>}
    {page && <><ul className={ui.selection}>{page.items.filter((item) => item.id !== id).map((item) => <li key={item.id}><span>{item.title}<small>{kindLabels[item.kind]}{item.archived ? ' · 已归档' : ''}</small></span><button className={ui.button} type="button" disabled={disabled || loading || item.id === value} onClick={() => onChange(item)}>{item.id === value ? '已关联' : '设为上级'}</button></li>)}</ul>{!page.items.some((item) => item.id !== id) && <p className={ui.muted}>本页没有可选的上级参考。</p>}<div className={ui.actions}><button className={ui.button} type="button" disabled={disabled || loading || offset === 0} onClick={() => void load(query, Math.max(0, offset - 50))}>上一页</button><span className={ui.muted}>共 {page.total} 条</span><button className={ui.button} type="button" disabled={disabled || loading || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) void load(query, page.nextOffset) }}>下一页</button></div></>}
  </details>
}
