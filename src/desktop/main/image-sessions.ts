import { nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { DomainError, failure, isRecord, type Result } from '../../contracts/api'
import { parseAiConnection, type AiConnectionPage } from '../../contracts/ai'
import { MAX_BOOK_MEDIA_BYTES, MAX_BOOK_MEDIA_ITEMS, MAX_BOOK_MEDIA_ITEM_BYTES, isBookMediaImage, isBookMediaSnapshot, validateBookMediaPayload, validateBoundedImagePayload } from '../../contracts/book-media'
import {
  parseImageGenerationBookInput, parseImageGenerationInput, parseImageGenerationReadInput, parseImageGenerationRun,
  MAX_GENERATED_IMAGE_BYTES, MAX_IMAGE_RESULT_BYTES, imageGenerationSizes, matchesImageGenerationSize, usesHuantuImageAspect,
  type ImageGenerationConnectionPage, type ImageGenerationInput, type ImageGenerationPage, type ImageGenerationRun,
} from '../../contracts/image-generation'
import { PendingAiResults, type PendingAiFile, type PendingAiPreflight } from './pending-ai-results'
import type { AiSessions } from './ai-sessions'
import type { ServiceClient } from './service-client'
import { writeNewText } from '../file-access'
import type { ProjectImageProvider } from './project-image-provider'

interface Entry { run: ImageGenerationRun; file?: PendingAiFile; pending: boolean; preflight?: PendingAiPreflight }
interface Active { entry: Entry; controller: AbortController; stop: 'cancelled' | 'timeout' | null }
const RESPONSE_BYTES = MAX_IMAGE_RESULT_BYTES
const TIMEOUT = 180_000
const PENDING_WARNING = '图片终态尚未确认落盘，结果仍在本次会话保留。请在图片面板重新核对，完成前保留窗口。'
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const fingerprint = (input: ImageGenerationInput, connection: ImageGenerationRun['connection']) => digest(JSON.stringify({ input, connection }))
const updatedTime = (run: ImageGenerationRun) => new Date(Math.max(Date.now(), Date.parse(run.updatedAt))).toISOString()
const terminal = (run: ImageGenerationRun, state: 'failed' | 'cancelled' | 'interrupted', error: string): ImageGenerationRun =>
  ({ ...run, state, version: 1, image: null, sha256: null, usage: null, error, updatedAt: updatedTime(run) })

/** 先检查 JPEG 尺寸再交给桌面解码，避免压缩文件声明超大画布导致无界分配。 */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) break
    while (bytes[offset] === 255) offset += 1
    const marker = bytes[offset++]
    if (marker === undefined || marker === 218 || marker === 217) break
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) break
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  throw new Error('图片响应缺少有效的 JPEG 尺寸。')
}

/** 图片任务单独留存在书库中；原图保存仍走不可变媒体事务，不自动采用生成结果。 */
export class ImageSessions {
  private readonly journal = new PendingAiResults('pending-image-results')
  private readonly entries = new Map<string, Entry>()
  private root: string | null = null
  private active: Active | null = null
  private working = false
  private warning: string | null = null
  private integrityFault = false

  constructor(private readonly projectProvider: Result<ProjectImageProvider | null> = { ok: true, data: null }) {}

  private async connections(bookId: string, service: ServiceClient, sessions: AiSessions): Promise<Result<ImageGenerationConnectionPage>> {
    const provider = this.projectProvider
    if (!provider.ok) return provider
    const result = await sessions.handle('ai.connection.list', { bookId }, service) as Result<AiConnectionPage>
    if (!result.ok) return result
    const local = provider.data?.connection
    if (local && result.data.connections.some(connection => connection.id === local.id)) return failure('REVISION_CONFLICT', '本书连接与项目生图连接编号冲突，请核对模型配置。')
    // 项目连接只加入图片接口，避免生图密钥被文字协作或向量请求复用。
    return { ok: true, data: { ...result.data,
      connections: local ? [local, ...result.data.connections] : result.data.connections,
      sessionKeyIds: local ? [local.id, ...result.data.sessionKeyIds] : result.data.sessionKeyIds,
      defaultConnectionId: local?.id ?? null,
    } }
  }

  hasActive(includePending = true): boolean { return this.active !== null || this.working || includePending && [...this.entries.values()].some((entry) => entry.pending) }
  abortAll(): void { if (this.active) { this.active.stop = 'cancelled'; this.active.controller.abort() } }
  savePendingResult(path: string): boolean {
    if (this.hasActive(false)) throw new DomainError({ code: 'WORKSPACE_BUSY', message: '请先等待图片请求结束。' })
    const pending = [...this.entries.values()].filter((entry) => entry.pending)
    if (!pending.length) return false
    for (const entry of pending) if (entry.run.state === 'running') entry.run = terminal(entry.run, 'interrupted', '原请求没有可确认终态，当前状态已另存副本，未再次向模型发送。')
    writeNewText(path, (write) => write(JSON.stringify({ format: 'storyweave.image-results', version: 1, workspaceRoot: this.root,
      runs: pending.map((entry) => entry.run), createdAt: new Date().toISOString() }) + '\n'))
    for (const entry of pending) entry.pending = false
    if (this.warning === PENDING_WARNING) this.warning = '图片结果已另存副本；原留存目录未补全，请保留副本并核对原任务。'
    return true
  }

  private persist(entry: Entry, next: ImageGenerationRun): void {
    const old = entry.file
    entry.run = parseImageGenerationRun(next)
    entry.pending = true
    const file = this.journal.save(this.root!, { command: 'book.image.result', contextHash: next.contextHash, input: entry.run }, entry.preflight)
    entry.file = file
    entry.pending = false
    if (this.warning === PENDING_WARNING) this.warning = null
    // 新版完整落盘后才标记旧版；标记失败仍能按任务版本选出唯一新结果。
    if (old) {
      try { this.journal.settle(old, 'committed') }
      catch { this.warning = '部分旧图片任务标记未完成，原记录继续保留；请保留 pending-image-results 目录。' }
    }
  }

  private restore(root: string): void {
    if (this.root === root) return
    if (this.active || [...this.entries.values()].some((entry) => entry.pending)) throw new DomainError({ code: 'WORKSPACE_BUSY', message: '另一书库的图片请求尚待结束或留存，请先回到原书库处理。' })
    this.entries.clear(); this.warning = null; this.integrityFault = false; this.root = root
    for (const item of this.journal.load(root)) {
      if ('warning' in item) { this.warning = item.warning; this.integrityFault = true; continue }
      const { payload } = item.file
      if (payload.command !== 'book.image.result') { this.warning = '图片留存目录含其他类型记录，请保留原目录并核对。'; this.integrityFault = true; continue }
      const run = payload.input
      if (fingerprint(run.input, run.connection) !== run.contextHash ||
        run.image && digest(Buffer.from(run.image.dataBase64, 'base64')) !== run.sha256) {
        this.warning = '图片任务上下文或原图摘要不符，原留存文件已保留，未恢复为可用结果。'; this.integrityFault = true; continue
      }
      const previous = this.entries.get(run.input.runId)
      if (previous && (previous.run.contextHash !== run.contextHash || previous.run.version === run.version && JSON.stringify(previous.run) !== JSON.stringify(run))) {
        this.warning = '同一图片任务存在矛盾记录，请保留原文件并核对。'; this.integrityFault = true; continue
      }
      if (!previous || run.version > previous.run.version) this.entries.set(run.input.runId, { run, file: item.file, pending: false })
    }
  }

  async handle(command: string, payload: unknown, service: ServiceClient, sessions: AiSessions): Promise<Result<unknown>> {
    const root = service.getWorkspaceRoot()
    if (!root) return failure('WORKSPACE_REQUIRED', '请先选择作品库。')
    if (this.working) return failure('WORKSPACE_BUSY', '图片资料正在核对，请稍后重试。')
    this.working = true
    try {
      this.restore(root)
      // 留存失败后仅续存内存中的原结果，不向提供方重发。
      for (const entry of this.entries.values()) {
        if (entry.run.state === 'running' && this.active?.entry !== entry) {
          this.persist(entry, terminal(entry.run, 'interrupted', '上次图片请求未取得可确认的终态。不会自动重发；请核对提供方记录后再明确创建新任务。'))
        } else if (entry.pending) this.persist(entry, entry.run)
      }
      if (command === 'book.image.connections') return await this.connections(parseImageGenerationBookInput(payload).bookId, service, sessions)
      if (command === 'book.image.list') {
        const { bookId } = parseImageGenerationBookInput(payload)
        await this.reconcile(bookId, service)
        const media = await service.request('book.media.get', { bookId })
        if (!media.ok) return media
        if (!isBookMediaSnapshot(media.data, bookId)) return failure('STORAGE_ERROR', '图片元信息不属于当前作品，请重新核对。')
        const assets = new Map(media.data.items.map((item) => [item.id, item.sha256]))
        // 恢复旧作品快照后，未来任务的保存记录仍留存，但不能当成当前作品的图片来源。
        const runs = [...this.entries.values()].map((entry) => entry.run).filter((run) => run.input.bookId === bookId && run.state !== 'discarded' &&
          (run.state !== 'saved' || assets.get(run.input.mediaId) === run.sha256))
        if (runs.length > 101 || runs.filter((run) => run.state !== 'saved').length > 1) return failure('STORAGE_ERROR', '图片任务数量或未处理任务身份异常，请保留原留存目录并核对。')
        const page: ImageGenerationPage = { bookId, warning: this.warning, runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((run) => ({
          runId: run.input.runId, mediaId: run.input.mediaId, kind: run.input.kind, personId: run.input.personId, title: run.input.title,
          model: run.connection.model, state: run.state, sha256: run.sha256, createdAt: run.createdAt,
        })) }
        return { ok: true, data: page }
      }
      if (command === 'book.image.start') return await this.start(parseImageGenerationInput(payload), service, sessions)
      const input = parseImageGenerationReadInput(payload), entry = this.entries.get(input.runId)
      if (!entry || entry.run.input.bookId !== input.bookId) return this.integrityFault ? failure('STORAGE_ERROR', this.warning ?? '图片留存目录尚待核对。')
        : failure('NOT_FOUND', '没有找到本书的这次图片任务。不会因此重新发送模型请求。')
      if (command === 'book.image.get') {
        if (this.integrityFault) return failure('STORAGE_ERROR', this.warning ?? '图片留存目录尚待核对。')
        await this.reconcile(input.bookId, service)
        return { ok: true, data: entry.run }
      }
      if (command === 'book.image.cancel') {
        if (this.active?.entry === entry) { this.active.stop = 'cancelled'; this.active.controller.abort() }
        return { ok: true, data: entry.run }
      }
      if (command === 'book.image.jpeg') {
        if (this.integrityFault) return failure('STORAGE_ERROR', this.warning ?? '图片留存目录尚待核对。')
        await this.reconcile(input.bookId, service)
        return this.createJpeg(entry)
      }
      if (command === 'book.image.discard') {
        if (this.active?.entry === entry || entry.run.state === 'running') return failure('WORKSPACE_BUSY', '请先取消图片请求并等待终态，再放弃这次结果。')
        await this.reconcile(input.bookId, service)
        if (entry.run.state === 'saved') return failure('FORBIDDEN', '这张生成图片已存入本书，不能将保存事实改为放弃。')
        if (entry.run.state !== 'discarded') this.persist(entry, { ...entry.run, state: 'discarded', version: entry.run.jpegSource ? 3 : 2, image: null, error: null, updatedAt: updatedTime(entry.run) })
        return { ok: true, data: entry.run }
      }
      return failure('INVALID_INPUT', '不支持此图片任务操作。')
    } catch (error) {
      return error instanceof DomainError ? { ok: false, error: error.detail } : failure('STORAGE_ERROR', '图片任务核对或留存未完成，请保留面板与 pending-image-results 目录。')
    } finally { this.working = false }
  }

  private async reconcile(bookId: string, service: ServiceClient): Promise<void> {
    const candidates = [...this.entries.values()].filter((entry) => entry.run.input.bookId === bookId && entry.run.state === 'succeeded')
    if (!candidates.length) return
    const media = await service.request('book.media.get', { bookId })
    if (!media.ok) throw new DomainError(media.error)
    if (!isBookMediaSnapshot(media.data, bookId)) throw new DomainError({ code: 'STORAGE_ERROR', message: '图片元信息不属于当前作品，请重新核对。' })
    // 恢复旧格式作品后尚无媒体表，侧车原图仍可核对或放弃，不能因此推定已经保存。
    if (media.data.requiresUpgrade) return
    for (const entry of candidates) {
      const run = entry.run
      const saved = await service.request('book.media.read', { bookId, id: run.input.mediaId })
      if (!saved.ok) {
        if (saved.error.code === 'NOT_FOUND') continue
        throw new DomainError(saved.error)
      }
      if (!isBookMediaImage(saved.data, bookId, run.input.mediaId) || saved.data.sha256 !== run.sha256 ||
        saved.data.mime !== run.image?.mime || saved.data.byteLength !== run.image?.byteLength ||
        digest(Buffer.from(saved.data.dataBase64, 'base64')) !== run.sha256) {
        throw new DomainError({ code: 'STORAGE_ERROR', message: '已存媒体与生成原图不一致，未解除生成结果的留存状态。' })
      }
      this.persist(entry, { ...run, state: 'saved', version: run.jpegSource ? 3 : 2, image: null, updatedAt: updatedTime(run) })
    }
  }

  private createJpeg(entry: Entry): Result<ImageGenerationRun> {
    const run = entry.run
    if (run.state !== 'succeeded' || !run.image || !run.sha256) return failure('FORBIDDEN', '请先取得待保存的生成原图，再制作入库副本。')
    // 原号再次核对只返回同一副本，丢失回执或连点均不重复转换，更不发送模型请求。
    if (run.jpegSource) return { ok: true, data: run }
    const source = run.image
    if (source.byteLength <= MAX_BOOK_MEDIA_ITEM_BYTES) return failure('INVALID_INPUT', '原图已符合 2 MiB 入库上限，可以直接编辑并保存。')
    const bytes = Buffer.from(source.dataBase64, 'base64')
    if (digest(bytes) !== run.sha256) return failure('STORAGE_ERROR', '原图摘要不符，已保留原任务，未制作副本。')
    let copy: Buffer
    try {
      const decoded = nativeImage.createFromBuffer(bytes)
      const dimensions = decoded.getSize()
      if (decoded.isEmpty() || dimensions.width !== source.width || dimensions.height !== source.height) return failure('INVALID_INPUT', '原图无法正确解码，未制作副本。')
      if (source.mime === 'image/png') {
        // JPEG 无透明通道；检查实际像素，不能把透明背景静默填成黑色。
        const bitmap = decoded.toBitmap()
        if (bitmap.length !== source.width * source.height * 4) return failure('INVALID_INPUT', '原图像素格式不受支持，未制作副本。')
        for (let offset = 3; offset < bitmap.length; offset += 4) {
          if (bitmap[offset] !== 255) return failure('INVALID_INPUT', '原图含透明像素，转为 JPEG 会改变背景；已保留原图，请另行准备保留透明的入库图片。')
        }
      }
      copy = decoded.toJPEG(93)
    } catch { return failure('INVALID_INPUT', '原图解码或 JPEG 编码失败，原任务仍保留。') }
    if (!copy.length || copy.length > MAX_BOOK_MEDIA_ITEM_BYTES) return failure('INVALID_INPUT', '同尺寸 JPEG（质量 93）仍超过 2 MiB；原图已保留，不会继续降低质量或缩小图片。')
    const dataBase64 = copy.toString('base64')
    validateBookMediaPayload('image/jpeg', dataBase64)
    const dimensions = jpegSize(copy)
    if (dimensions.width !== source.width || dimensions.height !== source.height) return failure('INVALID_INPUT', 'JPEG 副本尺寸变化，原图已保留，未采用副本。')
    this.persist(entry, { ...run, version: 2, image: { ...dimensions, mime: 'image/jpeg', dataBase64, byteLength: copy.length },
      sha256: digest(copy), jpegSource: { mime: source.mime, width: source.width, height: source.height,
        byteLength: source.byteLength, sha256: run.sha256, quality: 93 }, updatedAt: updatedTime(run) })
    return { ok: true, data: entry.run }
  }

  private async start(input: ImageGenerationInput, service: ServiceClient, sessions: AiSessions): Promise<Result<ImageGenerationRun>> {
    const old = this.entries.get(input.runId)
    if (old) return JSON.stringify(old.run.input) === JSON.stringify(input) ? { ok: true, data: old.run } : failure('REVISION_CONFLICT', '此图片任务编号已用于其他输入，不能覆盖或重新发送。')
    if (this.integrityFault) return failure('STORAGE_ERROR', this.warning ?? '图片留存目录尚待核对。')
    if (this.active) return failure('WORKSPACE_BUSY', '已有图片请求，请先结束并核对结果。')
    await this.reconcile(input.bookId, service)
    if ([...this.entries.values()].some((entry) => entry.run.input.bookId === input.bookId && !['saved', 'discarded'].includes(entry.run.state))) {
      return failure('WORKSPACE_BUSY', '本书仍有未处理的图片任务，请恢复原结果，保存或明确放弃后再创建。')
    }
    if ([...this.entries.values()].some((entry) => entry.run.input.mediaId === input.mediaId)) return failure('INVALID_INPUT', '图片身份已使用，请创建新的生成任务。')
    const media = await service.request('book.media.get', { bookId: input.bookId })
    if (!media.ok) return media
    if (!isBookMediaSnapshot(media.data, input.bookId) || media.data.bookRevision !== input.expectedBookRevision) return failure('REVISION_CONFLICT', '作品或图片版本已变化，请刷新后重新准备生成。')
    if (media.data.archived || media.data.requiresUpgrade) return failure('FORBIDDEN', '请先恢复作品编辑或备份升级，再生成图片。')
    if (media.data.items.length >= MAX_BOOK_MEDIA_ITEMS || media.data.totalBytes >= MAX_BOOK_MEDIA_BYTES || media.data.items.some((item) => item.id === input.mediaId)) return failure('INVALID_INPUT', '本书图片容量已满或图片身份已使用，未发送请求。')
    if (input.personId) {
      const person = await service.request('knowledge.get', { bookId: input.bookId, id: input.personId })
      if (!person.ok) return person
      if (person.data.bookId !== input.bookId || person.data.kind !== 'person' || person.data.id !== input.personId ||
        person.data.bookRevision !== input.expectedBookRevision) return failure('REVISION_CONFLICT', '关联人物身份、类型或作品版本已变化，请重新选择。')
    }
    const page = await this.connections(input.bookId, service, sessions)
    if (!page.ok) return page
    const found = page.data.connections.find((item) => item.id === input.connectionId)
    if (!found || found.version !== input.expectedConnectionVersion) return failure('REVISION_CONFLICT', '所选连接已变化，请重新读取连接后确认。')
    const connection = parseAiConnection(found)
    const local = this.projectProvider.ok ? this.projectProvider.data : null
    const key = local?.connection.id === connection.id ? local.apiKey : sessions.sessionKey(this.root!, input.bookId, connection)
    if (!imageGenerationSizes(connection).includes(input.size)) return failure('INVALID_INPUT', '所选提供方与模型不支持此请求画幅，请明确改选 3:4、1:1、3:2 或接口默认画幅；未发送请求。')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection.baseUrl).hostname) && !key) return failure('FORBIDDEN', '请先在模型设置保存此连接的本次会话密钥。')
    const preflight = this.journal.preflight(this.root!)
    const now = new Date().toISOString()
    const run: ImageGenerationRun = { input, connection, version: 0, state: 'running', contextHash: fingerprint(input, connection),
      image: null, sha256: null, usage: null, error: null, createdAt: now, updatedAt: now }
    const entry: Entry = { run, pending: false, preflight }
    this.entries.set(input.runId, entry)
    this.persist(entry, run)
    const active: Active = { entry, controller: new AbortController(), stop: null }
    this.active = active
    void this.generate(active, key)
    return { ok: true, data: run }
  }

  private async generate(active: Active, key?: string): Promise<void> {
    const run = active.entry.run, { input, connection } = run
    const timer = setTimeout(() => { active.stop = 'timeout'; active.controller.abort() }, TIMEOUT)
    let next: ImageGenerationRun
    try {
      const response = await fetch(`${connection.baseUrl}/images/generations`, {
        method: 'POST', redirect: 'error', signal: active.controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: connection.model, prompt: input.prompt, n: 1, ...(input.size === 'auto' ? {} : { size: input.size }),
          ...(usesHuantuImageAspect(connection) ? { response_format: 'b64_json' } : {}) }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`图片接口返回 HTTP ${response.status}，未读取远端错误正文；请检查图像模型和权限。`) }
      if (!response.body || !/^application\/(?:[\w.-]+[+])?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
        Number(response.headers.get('content-length')) > RESPONSE_BYTES) {
        await response.body?.cancel(); throw new Error('图片接口未返回 JSON，或响应超过 6 MiB。')
      }
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
      let text = '', size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > RESPONSE_BYTES) throw new Error('图片响应超过 6 MiB，已停止接收。')
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (active.controller.signal.aborted) throw new Error('aborted')
      let value: unknown
      try { value = JSON.parse(text) } catch { throw new Error('图片接口返回的 JSON 无效。') }
      // 有些兼容提供方用 HTTP 200 包装失败；不把它当成图片格式错误，也不透传可能含请求信息的远端文案。
      if (isRecord(value) && Object.hasOwn(value, 'error')) throw new Error('图片接口返回了提供方错误，未生成图片。请核对模型、额度及提供方请求记录；不会自动重发。')
      if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== 1 || !isRecord(value.data[0])) throw new Error('图片接口必须返回一张有效图片。')
      const item = value.data[0]
      let declaredMime = typeof item.mime_type === 'string' ? item.mime_type : null
      let bytes: Buffer
      if (typeof item.b64_json === 'string') {
        // 先做有界规范编码与签名检查，再分配 Buffer。
        const mime = item.b64_json.startsWith('/9j/') ? 'image/jpeg' : 'image/png'
        try { validateBoundedImagePayload(mime, item.b64_json, MAX_GENERATED_IMAGE_BYTES) } catch { throw new Error('原图不是有效 PNG / JPEG，或超过生成原图 4 MiB 上限。') }
        bytes = Buffer.from(item.b64_json, 'base64')
      } else {
        if (typeof item.url !== 'string' || item.url.length > 32768) throw new Error('图片接口没有返回原图或有效地址。')
        let url: URL
        try { url = new URL(item.url) } catch { throw new Error('图片接口返回的原图地址无效。') }
        // 只下载同源普通图片，不向返回地址附加会话密钥，也不跟随重定向。
        if (url.origin !== new URL(connection.baseUrl).origin || url.username || url.password || url.hash ||
          !['https:', 'http:'].includes(url.protocol)) throw new Error('原图地址不属于提供方同源地址，已停止下载。')
        const imageResponse = await fetch(url, { redirect: 'error', signal: active.controller.signal, headers: { Accept: 'image/png,image/jpeg' } })
        if (!imageResponse.ok) { await imageResponse.body?.cancel(); throw new Error(`原图下载返回 HTTP ${imageResponse.status}，未读取远端错误正文。`) }
        const mime = (imageResponse.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        if (!imageResponse.body || !['image/png', 'image/jpeg'].includes(mime) || Number(imageResponse.headers.get('content-length')) > MAX_GENERATED_IMAGE_BYTES) {
          await imageResponse.body?.cancel(); throw new Error('原图下载格式不是 PNG / JPEG，或超过生成原图 4 MiB 上限。')
        }
        const imageReader = imageResponse.body.getReader(), chunks: Uint8Array[] = []
        let total = 0
        try {
          while (true) {
            const chunk = await imageReader.read()
            if (chunk.done) break
            total += chunk.value.byteLength
            if (total > MAX_GENERATED_IMAGE_BYTES) throw new Error('原图下载超过生成原图 4 MiB 上限。')
            chunks.push(chunk.value)
          }
        } finally { await imageReader.cancel().catch(() => {}); imageReader.releaseLock() }
        bytes = Buffer.concat(chunks, total)
        if (typeof item.bytes === 'number' && item.bytes !== total || typeof item.mime_type === 'string' && item.mime_type !== mime) throw new Error('原图下载与提供方返回的长度或格式不符。')
        declaredMime = mime
      }
      const dataBase64 = bytes.toString('base64'), mime = bytes[0] === 255 ? 'image/jpeg' : 'image/png'
      if (declaredMime !== null && declaredMime !== mime) throw new Error('原图签名与提供方声明的格式不符。')
      let byteLength: number
      try { byteLength = validateBoundedImagePayload(mime, dataBase64, MAX_GENERATED_IMAGE_BYTES) }
      catch { throw new Error('原图不是有效 PNG / JPEG，或超过生成原图 4 MiB 上限。') }
      const dimensions = mime === 'image/png' ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : jpegSize(bytes)
      if (!dimensions.width || !dimensions.height || dimensions.width > 4096 || dimensions.height > 4096 ||
        !matchesImageGenerationSize(input, connection, dimensions.width, dimensions.height)) throw new Error('原图尺寸超出 4096 像素边长上限，或与指定画幅不一致。')
      const decoded = nativeImage.createFromBuffer(bytes)
      if (decoded.isEmpty() || decoded.getSize().width !== dimensions.width || decoded.getSize().height !== dimensions.height) throw new Error('生成原图无法正确解码。')
      let usage: ImageGenerationRun['usage'] = null
      if (isRecord(value.usage)) {
        const count = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : null
        usage = { inputTokens: count(value.usage.input_tokens), outputTokens: count(value.usage.output_tokens), totalTokens: count(value.usage.total_tokens) }
      }
      next = { ...run, state: 'succeeded', version: 1, image: { mime, ...dimensions, dataBase64, byteLength }, sha256: digest(bytes), usage, updatedAt: updatedTime(run) }
    } catch (error) {
      const state = active.stop === 'cancelled' ? 'cancelled' : 'failed'
      // 只展示本地固定错误；网络异常对象可能包含 URL 或请求信息，不能直接透传。
      const detail = active.stop === 'cancelled' ? '本地图片请求已取消；提供方仍可能已开始计费，请先核对再创建新任务。'
        : active.stop === 'timeout' ? '图片请求超过 180 秒，已停止等待。不会自动重发，请先核对提供方记录。'
        : error instanceof Error && /^(图片接口|图片响应|原图|生成原图)/.test(error.message) ? error.message : '图片网络请求未完成。不会自动重发，请核对接口与提供方记录。'
      next = terminal(run, state, detail)
    } finally { clearTimeout(timer) }
    try { this.persist(active.entry, next) }
    catch { this.warning = PENDING_WARNING }
    finally { if (this.active === active) this.active = null }
  }
}
