import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { StudioApi } from '../../contracts/api'
import type { AiConnectionPage } from '../../contracts/ai'
import type { KnowledgeItemPage } from '../../contracts/knowledge'
import { MAX_BOOK_MEDIA_ITEM_BYTES } from '../../contracts/book-media'
import {
  IMAGE_PROMPT_LIMIT, IMAGE_SIZES, imageGenerationSizes, usesHuantuImageAspect, isImageGenerationRun, parseImageGenerationInput,
  type ImageGenerationInput, type ImageGenerationRun,
} from '../../contracts/image-generation'
import { request } from '../request'
import { StudioIcon } from './StudioIcon'
import styles from './StellarMedia.module.css'

interface Props {
  api: StudioApi; bookId: string; bookRevision: number; disabled: boolean; readOnly: boolean
  initialKind: 'cover' | 'portrait'; initialRunId?: string
  onStateChange: (state: { dirty: boolean; locked: boolean; running: boolean }) => void
  onUse: (run: ImageGenerationRun) => Promise<void>; onClose: () => void
}
type GenerationOperation = 'load' | 'people' | 'start' | 'check' | 'cancel' | 'discard' | 'jpeg' | 'use'
const stateLabels: Record<ImageGenerationRun['state'], string> = {
  running: '正在生成', succeeded: '生成完成，待保存', failed: '生成失败', cancelled: '已取消',
  interrupted: '请求已中断，待核对', saved: '已存入本书', discarded: '已放弃',
}

/** 生成控制与媒体保存分开；未知回包只查询原任务，不自动重发付费请求。 */
export function ImageGenerationEditor({ api, bookId, bookRevision, disabled, readOnly, initialKind, initialRunId, onStateChange, onUse, onClose }: Props) {
  const [connections, setConnections] = useState<AiConnectionPage | null>(null), [connectionId, setConnectionId] = useState('')
  const [kind, setKind] = useState(initialKind), [personId, setPersonId] = useState('')
  const [people, setPeople] = useState<KnowledgeItemPage | null>(null), [query, setQuery] = useState(''), [peopleQuery, setPeopleQuery] = useState(''), [peopleOffset, setPeopleOffset] = useState(0)
  const [title, setTitle] = useState(''), [prompt, setPrompt] = useState(''), [size, setSize] = useState<ImageGenerationInput['size']>('auto')
  const [consent, setConsent] = useState(false), [dirty, setDirty] = useState(false)
  const [run, setRun] = useState<ImageGenerationRun | null>(null), [submitted, setSubmitted] = useState<ImageGenerationInput | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirmDiscard, setConfirmDiscard] = useState(false)
  const [operationName, setOperationName] = useState<GenerationOperation | null>(null)
  const [loaded, setLoaded] = useState(false), [pollPaused, setPollPaused] = useState(false)
  const mounted = useRef(false), busyRef = useRef(false), runRef = useRef(run), submittedRef = useRef(submitted)
  const editor = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onStateChange, onUse, onClose })
  callbacks.current = { onStateChange, onUse, onClose }
  runRef.current = run; submittedRef.current = submitted
  const running = run?.state === 'running'
  const unresolved = Boolean((submitted || initialRunId) && !run)
  const locked = busy || running || Boolean(submitted && !run)
  const connection = connections?.connections.find((item) => item.id === connectionId)
  const keyMissing = connection && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection.baseUrl).hostname) && !connections?.sessionKeyIds.includes(connection.id)
  const availableSizes = imageGenerationSizes(connection)
  const unsupportedSize = !availableSizes.includes(size)
  const oversized = Boolean(run?.image && run.image.byteLength > MAX_BOOK_MEDIA_ITEM_BYTES)

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; callbacks.current.onStateChange({ dirty: false, locked: false, running: false }) }
  }, [])
  useEffect(() => { callbacks.current.onStateChange({ dirty, locked, running }) }, [dirty, locked, running])
  useEffect(() => {
    if (loaded) {
      editor.current?.scrollIntoView({ block: 'nearest' })
      const target = editor.current?.querySelector<HTMLElement>('select:not(:disabled),button:not(:disabled)')
      ;(target ?? editor.current)?.focus({ preventScroll: true })
    }
  }, [loaded])
  useEffect(() => {
    if (!running || pollPaused || disabled) return
    const timer = window.setTimeout(() => void check(), 1200)
    return () => window.clearTimeout(timer)
  }, [run, busy, running, pollPaused, disabled])

  async function operation(next: GenerationOperation, action: () => Promise<void>) {
    if (!mounted.current || busyRef.current || disabled) return
    busyRef.current = true; setBusy(true); setOperationName(next); setError(null)
    try { await action() }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '图片操作未完成，请核对原任务。') }
    finally { busyRef.current = false; if (mounted.current) { setBusy(false); setOperationName(null) } }
  }
  const processing = (next: GenerationOperation) => busy && operationName === next
  function receive(value: unknown, runId: string) {
    if (!isImageGenerationRun(value, bookId, runId)) throw new Error('图片回执身份或格式不符，请保留原任务编号并重新核对。')
    const previous = runRef.current
    if (previous && (previous.input.runId !== runId || previous.contextHash !== value.contextHash || value.version < previous.version)) throw new Error('图片任务回执早于当前版本或上下文不符。')
    if (submittedRef.current && JSON.stringify(value.input) !== JSON.stringify(submittedRef.current)) throw new Error('图片任务回执与本次固定输入不符。')
    if (!mounted.current) return
    runRef.current = value; setRun(value); setDirty(false); setConfirmDiscard(false); setLoaded(true); setPollPaused(false)
  }
  async function load() {
    await operation('load', async () => {
      if (initialRunId) {
        const result = await request(() => api.getImageGeneration({ bookId, runId: initialRunId }))
        if (!result.ok) throw new Error(result.error.message)
        receive(result.data, initialRunId)
      } else {
        const result = await request(() => api.listAiConnections({ bookId }))
        if (!result.ok) throw new Error(result.error.message)
        if (result.data.bookId !== bookId || !Array.isArray(result.data.connections) || !Array.isArray(result.data.sessionKeyIds)) throw new Error('连接列表不属于当前作品，请重新读取。')
        if (mounted.current) { setConnections(result.data); setLoaded(true) }
      }
    })
  }
  function changed(change: () => void) { change(); setDirty(true); setConsent(false); setConfirmDiscard(false) }
  async function searchPeople(search: string, offset = 0) {
    await operation('people', async () => {
      const result = await request(() => api.listKnowledgeItems({ bookId, kind: 'person', search, offset, limit: 40 }))
      if (!result.ok) throw new Error(result.error.message)
      const page = result.data
      if (page.bookId !== bookId || page.bookRevision !== bookRevision || !Array.isArray(page.items) || page.items.length > 40 ||
        page.items.some((person) => person.bookId !== bookId || person.kind !== 'person')) throw new Error('人物资料或作品版本已变化，请返回并刷新图片资料。')
      if (mounted.current) { setPeople(page); setPeopleQuery(search); setPeopleOffset(offset) }
    })
  }
  async function start(event: FormEvent) {
    event.preventDefault()
    if (readOnly || !connection || run || submitted || !consent || keyMissing || unsupportedSize || connections?.requiresUpgrade) return
    await operation('start', async () => {
      const input = parseImageGenerationInput({ bookId, expectedBookRevision: bookRevision, runId: crypto.randomUUID(), mediaId: crypto.randomUUID(),
        connectionId: connection.id, expectedConnectionVersion: connection.version, kind, personId: kind === 'portrait' ? personId : null, title, prompt, size })
      // 在调用前固定身份；IPC 失联后以此编号读取，不能以新编号无声重试。
      submittedRef.current = input; setSubmitted(input)
      const result = await request(() => api.startImageGeneration(input))
      if (!result.ok) {
        if (!['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'STORAGE_ERROR'].includes(result.error.code)) { submittedRef.current = null; setSubmitted(null) }
        throw new Error(result.error.message)
      }
      receive(result.data, input.runId)
    })
  }
  async function check() {
    const runId = runRef.current?.input.runId ?? submittedRef.current?.runId ?? initialRunId
    if (!runId) return
    await operation('check', async () => {
      try {
        const result = await request(() => api.getImageGeneration({ bookId, runId }))
        if (!result.ok) {
          if (result.error.code === 'NOT_FOUND' && !runRef.current && !initialRunId) {
            submittedRef.current = null; setSubmitted(null)
            throw new Error('原任务未建立，当前表单仍保留。本次没有发送新请求。')
          }
          throw new Error(result.error.message)
        }
        receive(result.data, runId)
      } catch (error) {
        // 无效回执也暂停自动核对；只有取得有效的原任务回执才恢复轮询。
        if (mounted.current) setPollPaused(true)
        throw error
      }
    })
  }
  async function cancel() {
    if (!run || run.state !== 'running') return
    await operation('cancel', async () => {
      const result = await request(() => api.cancelImageGeneration({ bookId, runId: run.input.runId }))
      if (!result.ok) throw new Error(result.error.message)
      receive(result.data, run.input.runId)
    })
  }
  async function discard() {
    if (!run || running || busy) return
    if (!confirmDiscard) { setConfirmDiscard(true); return }
    await operation('discard', async () => {
      const result = await request(() => api.discardImageGeneration({ bookId, runId: run.input.runId }))
      if (!result.ok) throw new Error(result.error.message)
      receive(result.data, run.input.runId)
    })
  }
  async function createJpeg() {
    if (!run || run.state !== 'succeeded' || !oversized) return
    await operation('jpeg', async () => {
      const result = await request(() => api.createImageGenerationJpeg({ bookId, runId: run.input.runId }))
      if (!result.ok) throw new Error(result.error.message)
      receive(result.data, run.input.runId)
    })
  }
  function close() {
    if (locked) return
    if (dirty && !confirmDiscard) { setConfirmDiscard(true); return }
    callbacks.current.onClose()
  }

  return <div ref={editor} tabIndex={-1} className={styles.generator} aria-busy={busy || running}>
    <h4>{run ? stateLabels[run.state] : '生成图片'}</h4>
    {readOnly && <p className={styles.warning}>当前作品暂不可写，可核对、取消或明确放弃原任务；恢复编辑并刷新资料后才能保存到本书。</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {unresolved && <div className={styles.warning}><p>原请求结果尚待核对；当前输入与任务编号保留，不会自动重发。</p><code>{submitted?.runId ?? initialRunId}</code>
      <button type="button" className={styles.button} disabled={busy || disabled} aria-busy={processing('check')} onClick={() => void check()}>{processing('check') ? '正在核对原任务…' : '核对原任务'}</button></div>}
    {!loaded && !unresolved && <button type="button" className={styles.button} disabled={busy || disabled} aria-busy={processing('load')} onClick={() => void load()}>{processing('load') ? '正在读取生成资料…' : '重新读取生成资料'}</button>}
    {run ? <>
      <p className={styles.muted}>{run.connection.name} · {run.connection.model} · {run.input.size === 'auto' ? '接口默认画幅' : run.input.size}</p>
      {running && <><div className={styles.generationSkeleton} data-kind={run.input.kind} role="status"><StudioIcon name="spark" size={32} /><span>正在生成{run.input.kind === 'cover' ? '封面' : '立绘'}…</span></div>
        <button type="button" className={styles.button} disabled={busy || disabled} aria-busy={processing('cancel')} onClick={() => void cancel()}>{processing('cancel') ? '正在取消生成…' : '取消生成'}</button></>}
      {running && pollPaused && <div className={styles.warning}><p>自动核对已暂停，原任务仍保留；可手动核对当前状态。</p>
        <button type="button" className={styles.button} disabled={busy || disabled} aria-busy={processing('check')} onClick={() => void check()}>{processing('check') ? '正在核对原任务…' : '核对原任务'}</button></div>}
      {run.error && <p className={styles.warning} role="status">{run.error}</p>}
      {run.image && <><img className={styles.generatedPreview} src={`data:${run.image.mime};base64,${run.image.dataBase64}`} alt={run.input.title} />
        <p className={styles.muted}>{run.image.width} × {run.image.height} · {(run.image.byteLength / 1024 / 1024).toFixed(2)} MiB · 尚未保存为书内图片</p>
        {oversized && <div className={styles.warning}><p>原图超过书内单张 2 MiB 上限，已完整留存在图片任务中。可明确制作同尺寸 JPEG 入库副本（质量 93，有损压缩）；不缩放、不裁切，原图继续保留。含透明像素的图片不会转换。</p>
          <button type="button" className={styles.button} disabled={busy || disabled} aria-busy={processing('jpeg')} onClick={() => void createJpeg()}>{processing('jpeg') ? '正在制作 JPEG 副本…' : '制作同尺寸 JPEG 入库副本'}</button></div>}
        {run.jpegSource && <p className={styles.notice} role="status">当前预览为同尺寸 JPEG 入库副本（质量 {run.jpegSource.quality}）；{(run.jpegSource.byteLength / 1024 / 1024).toFixed(2)} MiB 原图保留在原任务文件，尚未采用为书内图片。</p>}
        <button type="button" className={styles.primaryButton} disabled={busy || disabled || readOnly || oversized} aria-busy={processing('use')} title={oversized ? '请先制作符合 2 MiB 上限的入库副本' : undefined} onClick={() => void operation('use', () => callbacks.current.onUse(run))}><StudioIcon name="pen" />{processing('use') ? '正在读取生成原图…' : '编辑并保存到本书'}</button></>}
      {run.usage && <p className={styles.muted}>提供方返回用量：输入 {run.usage.inputTokens ?? '未知'}，输出 {run.usage.outputTokens ?? '未知'}，合计 {run.usage.totalTokens ?? '未知'} token</p>}
      <details><summary>本次生成输入</summary><p className={styles.notes}>{run.input.prompt}</p><p className={styles.identity}>任务：{run.input.runId}<br />作品基线：v{run.input.expectedBookRevision}</p></details>
      {!running && <div className={styles.actions}>
        <button type="button" className={styles.button} disabled={busy || disabled} aria-busy={processing('check')} onClick={() => void check()}>{processing('check') ? '正在核对原任务…' : '重新核对原任务'}</button>
        {!['saved', 'discarded'].includes(run.state) && <button type="button" className={styles.button} disabled={busy || disabled} aria-busy={processing('discard')} onClick={() => void discard()}>{processing('discard') ? '正在放弃结果…' : confirmDiscard ? '确认放弃这次结果' : '放弃这次结果'}</button>}
      </div>}
      {confirmDiscard && <p className={styles.warning}>放弃后不再恢复为待保存图片，原留存记录仍保留。</p>}
    </> : loaded && <form className={styles.generatorForm} onSubmit={(event) => void start(event)}>
      <fieldset disabled={disabled || readOnly || busy || unresolved} className={styles.fields}>
        <label>图片用途<select value={kind} onChange={(event) => changed(() => setKind(event.target.value as 'cover' | 'portrait'))}><option value="cover">作品封面</option><option value="portrait">人物立绘</option></select></label>
        <label>图像模型连接<select required value={connectionId} onChange={(event) => changed(() => setConnectionId(event.target.value))}><option value="">请选择支持图像生成的连接</option>
          {connections?.connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
        {connections?.connections.length === 0 && <p className={styles.warning}>本书没有模型连接，请先返回模型设置，配置支持 Images 接口的图像模型。</p>}
        {connections?.requiresUpgrade && <p className={styles.warning}>本书模型配置需要先备份升级，请返回处理后重新进入。</p>}
        {keyMissing && <p className={styles.warning}>所选连接没有本次会话密钥，请先在模型设置保存。</p>}
        {kind === 'portrait' && <div className={styles.people}>
          <div className={styles.search}><label>查找已有的人物<input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} /></label>
            <button type="button" className={styles.button} disabled={busy || disabled} aria-busy={processing('people')} onClick={() => void searchPeople(query.trim())}>{processing('people') ? '正在查找人物…' : '查找人物'}</button></div>
          <label>关联人物<select required value={personId} onChange={(event) => changed(() => setPersonId(event.target.value))}><option value="">请选择人物</option>
            {personId && !people?.items.some((item) => item.id === personId) && <option value={personId}>{personId}</option>}
            {people?.items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label>
          {people && <div className={styles.actions}><button type="button" className={styles.button} disabled={peopleOffset === 0} onClick={() => void searchPeople(peopleQuery, Math.max(0, peopleOffset - 40))}>上一页人物</button>
            <button type="button" className={styles.button} disabled={people.nextOffset === null} onClick={() => void searchPeople(peopleQuery, people.nextOffset!)}>下一页人物</button></div>}
        </div>}
        <label>图片名称<input required maxLength={120} value={title} onChange={(event) => changed(() => setTitle(event.target.value))} /></label>
        <label>画幅<select value={size} onChange={(event) => changed(() => setSize(event.target.value as ImageGenerationInput['size']))}>
          {IMAGE_SIZES.filter((value) => availableSizes.includes(value) || value === size).map((value) => <option key={value} value={value} disabled={!availableSizes.includes(value)}>{value === 'auto' ? '接口默认画幅' : `${['1024x1536', '768x1024'].includes(value) ? '竖幅' : ['1536x1024', '1200x800'].includes(value) ? '横幅' : '方形'} · ${value}`}</option>)}</select></label>
        {connection && usesHuantuImageAspect(connection) && <p className={styles.muted}>此连接按 3:4、1:1、3:2 画幅生成，实际返回像素以预览为准。</p>}
        {unsupportedSize && <p className={styles.warning}>当前画幅不适用于所选模型，请明确改选后再发送。</p>}
        <label>生成提示<textarea required rows={8} maxLength={IMAGE_PROMPT_LIMIT} value={prompt} onChange={(event) => changed(() => setPrompt(event.target.value))} /></label>
        <p className={styles.muted}>{prompt.length} / {IMAGE_PROMPT_LIMIT} 字符 · 仅发送以上提示，接收一张不超过 4 MiB、边长不超过 4096 像素的 PNG / JPEG；书内单张仍限 2 MiB，超限后可另行确认制作 JPEG 副本。</p>
        <label className={styles.check}><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />确认发送至所选提供方，可能产生图像生成费用</label>
      </fieldset>
      <button type="submit" className={styles.goldButton} aria-busy={processing('start')} disabled={disabled || readOnly || busy || unresolved || !connection || !consent || !!keyMissing || unsupportedSize || connections?.requiresUpgrade || !title.trim() || !prompt.trim() || kind === 'portrait' && !personId}><StudioIcon name="spark" />{processing('start') ? '正在发送图片请求…' : '开始生成'}</button>
    </form>}
    <button type="button" className={styles.button} disabled={disabled || locked} onClick={close}>{dirty && confirmDiscard ? '确认放弃表单并返回' : '返回图片详情'}</button>
  </div>
}
