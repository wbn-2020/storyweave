import { DomainError, isRecord, requiredId, requiredInteger, type Result } from './api'

export const MEDIA_SCHEMA_VERSION = 14
export const MAX_BOOK_MEDIA_ITEMS = 100
export const MAX_BOOK_MEDIA_ITEM_BYTES = 2 * 1024 * 1024
export const MAX_BOOK_MEDIA_BYTES = 64 * 1024 * 1024
export const MAX_BOOK_MEDIA_BASE64_LENGTH = Math.ceil(MAX_BOOK_MEDIA_ITEM_BYTES / 3) * 4
export const MAX_BOOK_MEDIA_SNAPSHOT_BYTES = 1024 * 1024
export const BOOK_MEDIA_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type BookMediaMime = typeof BOOK_MEDIA_MIMES[number]
export type BookMediaKind = 'cover' | 'portrait'

export interface BookMediaFields {
  kind: BookMediaKind
  personId: string | null
  title: string
  /** 图片备注，同时用作无法显示图片时的替代文本。 */
  alt: string
  mime: BookMediaMime
  dataBase64: string
}
export interface GetBookMediaInput { bookId: string }
export interface ReadBookMediaInput extends GetBookMediaInput { id: string }
export interface SaveBookMediaInput extends ReadBookMediaInput { expectedBookRevision: number; fields: BookMediaFields }
export interface BookMediaMetadata extends Omit<BookMediaFields, 'dataBase64'> {
  id: string
  bookRevision: number
  byteLength: number
  sha256: string
  createdAt: string
}
export interface BookMediaImage extends BookMediaMetadata { bookId: string; dataBase64: string }
export interface BookMediaSnapshot {
  bookId: string
  bookRevision: number
  archived: boolean
  schemaVersion: number
  requiresUpgrade: boolean
  /** 包含全部旧资产，按创建时作品版本倒序；封面和每位人物的第一张为当前图。 */
  items: BookMediaMetadata[]
  activeCoverId: string | null
  totalBytes: number
  totalBase64Bytes: number
  savedMedia: BookMediaMetadata | null
}
export interface BookMediaApi {
  getBookMedia(input: GetBookMediaInput): Promise<Result<BookMediaSnapshot>>
  readBookMedia(input: ReadBookMediaInput): Promise<Result<BookMediaImage>>
  saveBookMedia(input: SaveBookMediaInput): Promise<Result<BookMediaSnapshot>>
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return invalid('图片参数无效；只接受图片内容与规定的元信息。')
  return value
}
function text(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return invalid(`${label}${required ? '不能为空，且' : ''}不能超过 ${maximum} 个字符或包含控制字符。`)
  return value
}
function identity(value: unknown): string { return requiredId(value).toLowerCase() }
function parseLabels(value: Record<string, unknown>): Omit<BookMediaFields, 'dataBase64'> {
  if (value.kind !== 'cover' && value.kind !== 'portrait') return invalid('图片用途只能是封面或人物立绘。')
  if (!BOOK_MEDIA_MIMES.includes(value.mime as BookMediaMime)) return invalid('只接受 PNG、JPEG 或 WebP 图片。')
  const personId = value.personId === null ? null : identity(value.personId)
  if ((value.kind === 'cover' && personId !== null) || (value.kind === 'portrait' && personId === null)) return invalid('封面不关联人物；立绘必须关联本书已有的人物。')
  return { kind: value.kind, personId, title: text(value.title, '图片名称', 120, true), alt: text(value.alt, '备注 / 替代文本', 2000), mime: value.mime as BookMediaMime }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** 在解码前核对规范 Base64、填充位和预算；拒绝 data URL、路径、空白及宽松解码。 */
export function validateBookMediaPayload(mime: BookMediaMime, value: unknown): number {
  if (typeof value !== 'string' || !value.length || value.length > MAX_BOOK_MEDIA_BASE64_LENGTH || value.length % 4 !== 0) return invalid('图片 Base64 长度无效，单张原图不得超过 2 MiB。')
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const body = value.slice(0, value.length - padding)
  // 避免对数 MiB 文本使用嵌套重复正则，防止校验自身耗尽正则栈。
  if (/[^A-Za-z0-9+/]/.test(body) || (padding === 2 && (ALPHABET.indexOf(body.at(-1)!) & 15) !== 0)
    || (padding === 1 && (ALPHABET.indexOf(body.at(-1)!) & 3) !== 0)) return invalid('图片必须使用规范 Base64 编码，不能包含 URL、空白或非零填充位。')
  const size = value.length / 4 * 3 - padding
  if (size < 4 || size > MAX_BOOK_MEDIA_ITEM_BYTES) return invalid('单张原图不得超过 2 MiB。')
  // 签名检查只取所需字节，契约层可同时用于 renderer 和仓储，无需 Node Buffer。
  const byte = (index: number): number => {
    const offset = Math.floor(index / 3) * 4, shift = index % 3
    const a = ALPHABET.indexOf(value[offset + shift]), b = ALPHABET.indexOf(value[offset + shift + 1])
    return shift === 0 ? (a << 2) | (b >> 4) : shift === 1 ? ((a & 15) << 4) | (b >> 2) : ((a & 3) << 6) | b
  }
  const matches = (offset: number, bytes: readonly number[]) => bytes.every((item, index) => byte(offset + index) === item)
  let valid = false
  if (mime === 'image/png') valid = size >= 45 && matches(0, [137, 80, 78, 71, 13, 10, 26, 10])
    && matches(8, [0, 0, 0, 13, 73, 72, 68, 82]) && matches(size - 12, [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
  if (mime === 'image/jpeg') valid = matches(0, [255, 216, 255]) && matches(size - 2, [255, 217])
  if (mime === 'image/webp') {
    const riffSize = byte(4) + byte(5) * 256 + byte(6) * 65536 + byte(7) * 16777216
    valid = size >= 20 && matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80, 86, 80, 56])
      && [32, 76, 88].includes(byte(15)) && riffSize + 8 === size && size % 2 === 0
  }
  if (!valid) return invalid('图片 MIME 与文件签名、边界或长度不匹配。请重新选择 PNG、JPEG 或 WebP 原图。')
  return size
}

export function parseBookMediaFields(value: unknown): BookMediaFields {
  const data = record(value, ['kind', 'personId', 'title', 'alt', 'mime', 'dataBase64'])
  const labels = parseLabels(data)
  validateBookMediaPayload(labels.mime, data.dataBase64)
  return { ...labels, dataBase64: data.dataBase64 as string }
}
export function parseGetBookMediaInput(value: unknown): GetBookMediaInput {
  const data = record(value, ['bookId'])
  return { bookId: identity(data.bookId) }
}
export function parseReadBookMediaInput(value: unknown): ReadBookMediaInput {
  const data = record(value, ['bookId', 'id'])
  return { bookId: identity(data.bookId), id: identity(data.id) }
}
export function parseSaveBookMediaInput(value: unknown): SaveBookMediaInput {
  const data = record(value, ['bookId', 'expectedBookRevision', 'id', 'fields'])
  return { bookId: identity(data.bookId), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本', Number.MAX_SAFE_INTEGER - 1), id: identity(data.id), fields: parseBookMediaFields(data.fields) }
}

const META_KEYS = ['id', 'bookRevision', 'kind', 'personId', 'title', 'alt', 'mime', 'byteLength', 'sha256', 'createdAt']
export function parseBookMediaMetadata(value: unknown): BookMediaMetadata {
  const data = record(value, META_KEYS), labels = parseLabels(data)
  const id = identity(data.id), bookRevision = requiredInteger(data.bookRevision, '图片创建版本')
  const byteLength = requiredInteger(data.byteLength, '图片大小', MAX_BOOK_MEDIA_ITEM_BYTES)
  if (id !== data.id || labels.personId !== data.personId || bookRevision < 1 || byteLength < 4
    || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)
    || typeof data.createdAt !== 'string' || data.createdAt.length !== 24 || !Number.isFinite(Date.parse(data.createdAt))
    || new Date(data.createdAt).toISOString() !== data.createdAt) return invalid('图片元信息无效。')
  return { ...labels, id, bookRevision, byteLength, sha256: data.sha256, createdAt: data.createdAt }
}
export function isBookMediaSnapshot(value: unknown, bookId: string): value is BookMediaSnapshot {
  try {
    const data = record(value, ['bookId', 'bookRevision', 'archived', 'schemaVersion', 'requiresUpgrade', 'items', 'activeCoverId', 'totalBytes', 'totalBase64Bytes', 'savedMedia'])
    if (data.bookId !== bookId || identity(data.bookId) !== bookId || typeof data.archived !== 'boolean' || typeof data.requiresUpgrade !== 'boolean') return false
    const revision = requiredInteger(data.bookRevision, '作品版本'), schema = requiredInteger(data.schemaVersion, '作品格式')
    if (schema < 1 || data.requiresUpgrade !== (schema < MEDIA_SCHEMA_VERSION) || !Array.isArray(data.items) || data.items.length > MAX_BOOK_MEDIA_ITEMS) return false
    let bytes = 0, encoded = 0, previous = Number.POSITIVE_INFINITY
    const ids = new Set<string>()
    const items = data.items.map(parseBookMediaMetadata)
    for (const item of items) {
      if (ids.has(item.id) || item.bookRevision > revision || item.bookRevision >= previous) return false
      ids.add(item.id); previous = item.bookRevision; bytes += item.byteLength; encoded += Math.ceil(item.byteLength / 3) * 4
    }
    if (bytes > MAX_BOOK_MEDIA_BYTES || data.totalBytes !== bytes || data.totalBase64Bytes !== encoded || data.activeCoverId !== (items.find((item) => item.kind === 'cover')?.id ?? null)) return false
    if (data.requiresUpgrade && (items.length !== 0 || data.savedMedia !== null)) return false
    if (data.savedMedia !== null) {
      const saved = parseBookMediaMetadata(data.savedMedia), match = items.find((item) => item.id === saved.id)
      if (!match || JSON.stringify(match) !== JSON.stringify(saved)) return false
    }
    return new TextEncoder().encode(JSON.stringify(data)).byteLength <= MAX_BOOK_MEDIA_SNAPSHOT_BYTES
  } catch { return false }
}
export function isBookMediaImage(value: unknown, bookId: string, id: string): value is BookMediaImage {
  try {
    const data = record(value, [...META_KEYS, 'bookId', 'dataBase64'])
    const { bookId: owner, dataBase64, ...rest } = data
    const meta = parseBookMediaMetadata(rest)
    return owner === bookId && identity(owner) === owner && meta.id === id && validateBookMediaPayload(meta.mime, dataBase64) === meta.byteLength
  } catch { return false }
}
