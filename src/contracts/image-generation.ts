import { DomainError, isRecord, requiredId, requiredInteger, type Result } from './api'
import { parseAiConnection, type AiConnection, type AiConnectionPage, type AiUsage } from './ai'
import { MAX_BOOK_MEDIA_ITEM_BYTES, validateBoundedImagePayload } from './book-media'

export const IMAGE_PROMPT_LIMIT = 8000
export const IMAGE_SIZES = ['auto', '1024x1536', '1024x1024', '1536x1024', '768x1024', '1200x800'] as const
export const MAX_GENERATED_IMAGE_BYTES = 4 * 1024 * 1024
/** 4 MiB 原图的 Base64 及有界输入可完整留存；不扩大文字结果或书内媒体预算。 */
export const MAX_IMAGE_RESULT_BYTES = 6 * 1024 * 1024
const HUANTU_IMAGE_SIZES = ['auto', '768x1024', '1024x1024', '1200x800'] as const
export type ImageGenerationState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'saved' | 'discarded'
export interface ImageGenerationInput {
  bookId: string; runId: string; mediaId: string; expectedBookRevision: number
  connectionId: string; expectedConnectionVersion: number
  kind: 'cover' | 'portrait'; personId: string | null
  title: string; prompt: string; size: typeof IMAGE_SIZES[number]
}
export interface ImageGenerationReadInput { bookId: string; runId: string }
export interface GeneratedImage { mime: 'image/png' | 'image/jpeg'; width: number; height: number; dataBase64: string; byteLength: number }
export interface ImageJpegSource extends Omit<GeneratedImage, 'dataBase64'> { sha256: string; quality: 93 }
export interface ImageGenerationRun {
  input: ImageGenerationInput; connection: AiConnection; version: number; state: ImageGenerationState
  /** 只保留本次作者明确填写的提示，不自动附加正文或人物档案。 */
  contextHash: string; sha256: string | null; image: GeneratedImage | null
  usage: AiUsage | null; error: string | null; createdAt: string; updatedAt: string
  /** 显式制作入库副本后记录原图身份；原图完整内容仍保留在此前的不可变任务文件。 */
  jpegSource?: ImageJpegSource
}
export interface ImageGenerationSummary {
  runId: string; mediaId: string; kind: 'cover' | 'portrait'; personId: string | null
  title: string; model: string; state: ImageGenerationState; sha256: string | null; createdAt: string
}
export interface ImageGenerationPage { bookId: string; runs: ImageGenerationSummary[]; warning: string | null }
export interface ImageGenerationConnectionPage extends AiConnectionPage { defaultConnectionId: string | null }
export interface ImageGenerationApi {
  listImageGenerationConnections(input: { bookId: string }): Promise<Result<ImageGenerationConnectionPage>>
  listImageGenerations(input: { bookId: string }): Promise<Result<ImageGenerationPage>>
  getImageGeneration(input: ImageGenerationReadInput): Promise<Result<ImageGenerationRun>>
  startImageGeneration(input: ImageGenerationInput): Promise<Result<ImageGenerationRun>>
  cancelImageGeneration(input: ImageGenerationReadInput): Promise<Result<ImageGenerationRun>>
  createImageGenerationJpeg(input: ImageGenerationReadInput): Promise<Result<ImageGenerationRun>>
  discardImageGeneration(input: ImageGenerationReadInput): Promise<Result<ImageGenerationRun>>
}

export function usesHuantuImageAspect(connection: Pick<AiConnection, 'baseUrl' | 'model'>): boolean {
  return connection.baseUrl === 'https://huantu.xyz/api/v1' && connection.model === 'gpt-image-2.6'
}
export function imageGenerationSizes(connection?: Pick<AiConnection, 'baseUrl' | 'model'>): readonly ImageGenerationInput['size'][] {
  return connection && usesHuantuImageAspect(connection) ? HUANTU_IMAGE_SIZES : IMAGE_SIZES
}
export function matchesImageGenerationSize(input: ImageGenerationInput, connection: AiConnection, width: number, height: number): boolean {
  if (input.size === 'auto') return true
  if (`${width}x${height}` === input.size) return true
  if (!usesHuantuImageAspect(connection)) return false
  const [requestedWidth, requestedHeight] = input.size.split('x').map(Number)
  // 此提供方把 size 用作画幅，允许返回像素取整的一像素误差，不裁切或缩放图片。
  return imageGenerationSizes(connection).includes(input.size) &&
    Math.abs(width * requestedHeight - height * requestedWidth) <= Math.max(requestedWidth, requestedHeight)
}

function invalid(): never { throw new DomainError({ code: 'INVALID_INPUT', message: '图片生成参数或留存记录无效，请保留原记录并重新核对。' }) }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid()
  return value
}
function id(value: unknown): string { return requiredId(value).toLowerCase() }
function text(value: unknown, maximum: number, required = true): string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid()
  return value
}
function time(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid()
  return value
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid()
  return value
}
export function parseImageGenerationInput(value: unknown): ImageGenerationInput {
  const v = object(value, ['bookId', 'runId', 'mediaId', 'expectedBookRevision', 'connectionId', 'expectedConnectionVersion', 'kind', 'personId', 'title', 'prompt', 'size'])
  if (!['cover', 'portrait'].includes(String(v.kind)) || !IMAGE_SIZES.includes(v.size as ImageGenerationInput['size'])) invalid()
  const personId = v.personId === null ? null : id(v.personId)
  if ((v.kind === 'portrait') !== (personId !== null)) invalid()
  return { bookId: id(v.bookId), runId: id(v.runId), mediaId: id(v.mediaId),
    expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本', Number.MAX_SAFE_INTEGER - 1),
    connectionId: id(v.connectionId), expectedConnectionVersion: requiredInteger(v.expectedConnectionVersion, '连接版本'),
    kind: v.kind as ImageGenerationInput['kind'], personId, title: text(v.title, 120), prompt: text(v.prompt, IMAGE_PROMPT_LIMIT),
    size: v.size as ImageGenerationInput['size'] }
}
export function parseImageGenerationReadInput(value: unknown): ImageGenerationReadInput {
  const v = object(value, ['bookId', 'runId'])
  return { bookId: id(v.bookId), runId: id(v.runId) }
}
export function parseImageGenerationBookInput(value: unknown): { bookId: string } {
  return { bookId: id(object(value, ['bookId']).bookId) }
}
export function parseImageGenerationRun(value: unknown): ImageGenerationRun {
  const v = object(value, ['input', 'connection', 'version', 'state', 'contextHash', 'sha256', 'image', 'usage', 'error', 'createdAt', 'updatedAt',
    ...(isRecord(value) && Object.hasOwn(value, 'jpegSource') ? ['jpegSource'] : [])])
  const input = parseImageGenerationInput(v.input), connection = parseAiConnection(v.connection)
  const version = requiredInteger(v.version, '图片任务版本', 3)
  if (connection.id !== input.connectionId || connection.version !== input.expectedConnectionVersion ||
    !['running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'saved', 'discarded'].includes(String(v.state))) invalid()
  const state = v.state as ImageGenerationState
  const sha256 = v.sha256 === null ? null : hash(v.sha256)
  let jpegSource: ImageJpegSource | undefined
  if (Object.hasOwn(v, 'jpegSource')) {
    const raw = object(v.jpegSource, ['mime', 'width', 'height', 'byteLength', 'sha256', 'quality'])
    const width = requiredInteger(raw.width, '原图宽度', 4096), height = requiredInteger(raw.height, '原图高度', 4096)
    const byteLength = requiredInteger(raw.byteLength, '原图大小', MAX_GENERATED_IMAGE_BYTES)
    if (!width || !height || byteLength <= MAX_BOOK_MEDIA_ITEM_BYTES || raw.quality !== 93 ||
      raw.mime !== 'image/png' && raw.mime !== 'image/jpeg' || !matchesImageGenerationSize(input, connection, width, height)) invalid()
    jpegSource = { mime: raw.mime, width, height, byteLength, sha256: hash(raw.sha256), quality: 93 }
    if (jpegSource.sha256 === sha256) invalid()
  }
  const expectedVersion = state === 'running' ? 0 : state === 'succeeded' ? (jpegSource ? 2 : 1)
    : ['saved', 'discarded'].includes(state) ? (jpegSource ? 3 : 2) : 1
  if (version !== expectedVersion || jpegSource && !['succeeded', 'saved', 'discarded'].includes(state)) invalid()
  let image: GeneratedImage | null = null
  if (v.image !== null) {
    const raw = object(v.image, ['mime', 'width', 'height', 'dataBase64', 'byteLength'])
    if (raw.mime !== 'image/png' && raw.mime !== 'image/jpeg') invalid()
    const byteLength = validateBoundedImagePayload(raw.mime, raw.dataBase64, jpegSource ? MAX_BOOK_MEDIA_ITEM_BYTES : MAX_GENERATED_IMAGE_BYTES)
    if (raw.byteLength !== byteLength) invalid()
    const width = requiredInteger(raw.width, '图片宽度', 4096), height = requiredInteger(raw.height, '图片高度', 4096)
    if (!width || !height || !matchesImageGenerationSize(input, connection, width, height) ||
      jpegSource && (raw.mime !== 'image/jpeg' || width !== jpegSource.width || height !== jpegSource.height)) invalid()
    image = { mime: raw.mime, width, height, dataBase64: raw.dataBase64 as string, byteLength }
  }
  if ((state === 'succeeded') !== (image !== null) || (['succeeded', 'saved'].includes(state) && !sha256) ||
    (!['succeeded', 'saved', 'discarded'].includes(state) && sha256 !== null)) invalid()
  let usage: AiUsage | null = null
  if (v.usage !== null) {
    const raw = object(v.usage, ['inputTokens', 'outputTokens', 'totalTokens'])
    const count = (value: unknown) => value === null ? null : requiredInteger(value, '图片用量')
    usage = { inputTokens: count(raw.inputTokens), outputTokens: count(raw.outputTokens), totalTokens: count(raw.totalTokens) }
  }
  const error = v.error === null ? null : text(v.error, 1000)
  if (['failed', 'cancelled', 'interrupted'].includes(state) !== (error !== null)) invalid()
  const createdAt = time(v.createdAt), updatedAt = time(v.updatedAt)
  if (updatedAt < createdAt) invalid()
  return { input, connection, version, state, contextHash: hash(v.contextHash), sha256, image, usage, error, createdAt, updatedAt,
    ...(jpegSource ? { jpegSource } : {}) }
}
export function isImageGenerationRun(value: unknown, bookId: string, runId: string): value is ImageGenerationRun {
  try { const run = parseImageGenerationRun(value); return run.input.bookId === bookId && run.input.runId === runId }
  catch { return false }
}
export function isImageGenerationPage(value: unknown, bookId: string): value is ImageGenerationPage {
  try {
    const v = object(value, ['bookId', 'runs', 'warning'])
    if (v.bookId !== bookId || !Array.isArray(v.runs) || v.runs.length > 101 || (v.warning !== null && typeof v.warning !== 'string')) return false
    const ids = new Set<string>(), media = new Set<string>()
    let pending = 0
    for (const raw of v.runs) {
      const item = object(raw, ['runId', 'mediaId', 'kind', 'personId', 'title', 'model', 'state', 'sha256', 'createdAt'])
      const runId = id(item.runId), mediaId = id(item.mediaId)
      if (runId !== item.runId || mediaId !== item.mediaId || ids.has(runId) || media.has(mediaId) || item.state === 'discarded' ||
        !['running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'saved'].includes(String(item.state)) ||
        !['cover', 'portrait'].includes(String(item.kind)) || (item.kind === 'portrait') !== (item.personId !== null)) return false
      if (item.personId !== null && id(item.personId) !== item.personId) return false
      if (item.sha256 !== null) hash(item.sha256)
      if (['succeeded', 'saved'].includes(String(item.state)) !== (item.sha256 !== null)) return false
      text(item.title, 120); text(item.model, 200); time(item.createdAt)
      if (item.state !== 'saved') pending += 1
      ids.add(runId); media.add(mediaId)
    }
    return pending <= 1
  } catch { return false }
}
