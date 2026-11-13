import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText } from './api'
import { KNOWLEDGE_KINDS, type KnowledgeKind } from './knowledge'
import { matchesNoteThumbnail, parseNoteThumbnailFields, parseNoteThumbnailMetadata, type NoteThumbnailFields, type NoteThumbnailMetadata } from './note-thumbnail'

export const NOTE_CATEGORIES = ['inspiration', 'material', 'method'] as const
export const NOTE_CATEGORY_LABELS = { inspiration: '灵感', material: '素材', method: '方法' } as const
export const MAX_NOTES = 10_000
export const MAX_NOTE_BODY = 20_000
export const NOTE_PAGE_SIZE = 40
export const NOTE_SCHEMA_VERSION = 12
export const NOTE_CHAPTER_SCHEMA_VERSION = 20
export const NOTE_MATERIAL_SCHEMA_VERSION = 22
export const MAX_NOTE_CHAPTERS = 20
export const MAX_NOTE_TAGS = 20
export type NoteCategory = typeof NOTE_CATEGORIES[number]
export interface NoteFields { category: NoteCategory; title: string; body: string }
export interface NoteMaterial { source: string; tags: string[] }
export interface NotePromotion { itemId: string; kind: KnowledgeKind; noteRevision: number; createdAt: string }
export interface NoteSummary {
  id: string; bookId: string; category: NoteCategory; title: string; excerpt: string
  revision: number; createdAt: string; updatedAt: string; promotion: NotePromotion | null
  chapterIds: string[] | null
  material: NoteMaterial | null
  thumbnail: NoteThumbnailMetadata | null
}
export interface NoteDetail extends NoteFields {
  id: string; bookId: string; revision: number; createdAt: string; updatedAt: string
  bookRevision: number; knowledgeRevision: number; archived: boolean
  promotion: NotePromotion | null; promotedFields: NoteFields | null
  chapterIds: string[] | null
  material: NoteMaterial | null
  thumbnail: NoteThumbnailMetadata | null
}
export interface NoteInput { bookId: string; id: string }
export interface ListNotesInput {
  bookId: string; search?: string; category?: NoteCategory; tag?: string; offset?: number; limit?: number; expectedBookRevision?: number
}
export interface NotePage {
  bookId: string; bookRevision: number; knowledgeRevision: number; archived: boolean
  items: NoteSummary[]; total: number; nextOffset: number | null
}
export interface CreateNoteInput extends NoteInput {
  expectedBookRevision: number; fields: NoteFields; chapterIds?: string[]; material?: NoteMaterial; thumbnail?: NoteThumbnailFields | null
}
export interface UpdateNoteInput extends CreateNoteInput { expectedNoteRevision: number }
export interface SetNoteChaptersInput extends NoteInput {
  expectedBookRevision: number; expectedNoteRevision: number; chapterIds: string[]
}
export interface PromoteNoteInput extends NoteInput {
  expectedBookRevision: number; expectedKnowledgeRevision: number; expectedNoteRevision: number; kind: KnowledgeKind
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('笔记请求包含无效或不支持的字段。')
  return value
}
function category(value: unknown): NoteCategory {
  if (value !== 'inspiration' && value !== 'material' && value !== 'method') invalid('请选择有效的笔记分类。')
  return value
}
function revision(value: unknown): number {
  const result = requiredInteger(value, '笔记版本')
  if (result < 1) invalid('笔记版本无效。')
  return result
}
function identity(data: Record<string, unknown>): NoteInput {
  return { bookId: requiredId(data.bookId).toLowerCase(), id: requiredId(data.id).toLowerCase() }
}
export function parseNoteFields(value: unknown): NoteFields {
  const data = record(value, ['category', 'title', 'body'])
  const title = requiredText(data.title, '笔记标题', 120)
  if (title.includes('\0') || typeof data.body !== 'string' || data.body.length > MAX_NOTE_BODY || data.body.includes('\0')) invalid('笔记正文最多 20,000 个字符，且不能包含空字符。')
  // 正文空白属于作者输入；列表和转换均使用这个已保存的原始版本。
  return { category: category(data.category), title, body: data.body }
}
export function parseNoteInput(value: unknown): NoteInput { return identity(record(value, ['bookId', 'id'])) }
export function parseNoteMaterial(value: unknown): NoteMaterial {
  const data = record(value, ['source', 'tags'])
  const source = optionalText(data.source, '素材出处', 2_000)
  if (source.includes('\0') || !Array.isArray(data.tags) || data.tags.length > MAX_NOTE_TAGS) invalid('素材出处不能包含空字符，标签最多 20 个。')
  const tags = [...new Set(data.tags.map((value) => {
    const tag = requiredText(value, '素材标签', 50)
    if (tag.includes('\0')) invalid('素材标签不能包含空字符。')
    return tag
  }))]
  return { source, tags }
}
export function sameNoteMaterial(left: NoteMaterial | null, right: NoteMaterial | null): boolean {
  return left === null || right === null ? left === right : left.source === right.source && left.tags.length === right.tags.length
    && left.tags.every((tag, index) => tag === right.tags[index])
}
export function parseNoteChapterIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_NOTE_CHAPTERS) invalid(`每条素材最多关联 ${MAX_NOTE_CHAPTERS} 个章节。`)
  const ids = value.map((entry) => requiredId(entry).toLowerCase())
  if (new Set(ids).size !== ids.length) invalid('关联章节不能重复。')
  return ids.sort()
}
export function sameNoteChapters(left: string[] | null, right: string[] | null): boolean {
  return left === null || right === null ? left === right : Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((id, index) => id === right[index])
}
export function parseListNotesInput(value: unknown): ListNotesInput {
  const data = record(value, ['bookId', 'search', 'category', 'tag', 'offset', 'limit', 'expectedBookRevision'])
  const offset = data.offset === undefined ? 0 : requiredInteger(data.offset, '笔记分页位置', MAX_NOTES)
  const limit = data.limit === undefined ? NOTE_PAGE_SIZE : requiredInteger(data.limit, '每页笔记数', 80)
  if (!limit || (offset > 0 && data.expectedBookRevision === undefined)) invalid('翻页需保留作品版本，每页数量必须在 1 到 80 之间。')
  const search = data.search === undefined ? '' : optionalText(data.search, '笔记搜索', 200)
  if (search.includes('\0')) invalid('搜索内容包含无效字符。')
  return { bookId: requiredId(data.bookId).toLowerCase(), search, offset, limit,
    ...(data.category === undefined ? {} : { category: category(data.category) }),
    ...(data.tag === undefined ? {} : { tag: parseNoteMaterial({ source: '', tags: [data.tag] }).tags[0]! }),
    ...(data.expectedBookRevision === undefined ? {} : { expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本') }) }
}
export function parseCreateNoteInput(value: unknown): CreateNoteInput {
  const data = record(value, ['bookId', 'id', 'expectedBookRevision', 'fields', 'chapterIds', 'material', 'thumbnail'])
  return { ...identity(data), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'), fields: parseNoteFields(data.fields),
    ...(data.chapterIds === undefined ? {} : { chapterIds: parseNoteChapterIds(data.chapterIds) }),
    ...(data.material === undefined ? {} : { material: parseNoteMaterial(data.material) }),
    ...(data.thumbnail === undefined ? {} : { thumbnail: data.thumbnail === null ? null : parseNoteThumbnailFields(data.thumbnail) }) }
}
export function parseUpdateNoteInput(value: unknown): UpdateNoteInput {
  const data = record(value, ['bookId', 'id', 'expectedBookRevision', 'expectedNoteRevision', 'fields', 'chapterIds', 'material', 'thumbnail'])
  return { ...identity(data), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedNoteRevision: revision(data.expectedNoteRevision), fields: parseNoteFields(data.fields),
    ...(data.chapterIds === undefined ? {} : { chapterIds: parseNoteChapterIds(data.chapterIds) }),
    ...(data.material === undefined ? {} : { material: parseNoteMaterial(data.material) }),
    ...(data.thumbnail === undefined ? {} : { thumbnail: data.thumbnail === null ? null : parseNoteThumbnailFields(data.thumbnail) }) }
}
export function parseSetNoteChaptersInput(value: unknown): SetNoteChaptersInput {
  const data = record(value, ['bookId', 'id', 'expectedBookRevision', 'expectedNoteRevision', 'chapterIds'])
  return { ...identity(data), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedNoteRevision: revision(data.expectedNoteRevision), chapterIds: parseNoteChapterIds(data.chapterIds) }
}
export function parsePromoteNoteInput(value: unknown): PromoteNoteInput {
  const data = record(value, ['bookId', 'id', 'expectedBookRevision', 'expectedKnowledgeRevision', 'expectedNoteRevision', 'kind'])
  if (typeof data.kind !== 'string' || !KNOWLEDGE_KINDS.includes(data.kind as KnowledgeKind)) invalid('请选择设定类型。')
  return { ...identity(data), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识版本'), expectedNoteRevision: revision(data.expectedNoteRevision), kind: data.kind as KnowledgeKind }
}

export function isNoteWriteReceiptFor(input: CreateNoteInput | UpdateNoteInput | PromoteNoteInput | SetNoteChaptersInput, value: NoteDetail): boolean {
  if (!value || value.bookId !== input.bookId || value.id !== input.id || !Number.isSafeInteger(value.bookRevision)
    || value.bookRevision < input.expectedBookRevision || !Number.isSafeInteger(value.knowledgeRevision) || value.knowledgeRevision < 0 || value.archived
    || !Number.isSafeInteger(value.revision) || value.revision < 1) return false
  try {
    if (value.chapterIds !== null && !sameNoteChapters(value.chapterIds, parseNoteChapterIds(value.chapterIds))) return false
    if (value.material !== null && !sameNoteMaterial(value.material, parseNoteMaterial(value.material))) return false
    if (value.thumbnail !== null) {
      const thumbnail = parseNoteThumbnailMetadata(value.thumbnail)
      if (thumbnail.noteId !== value.id || thumbnail.noteRevision > value.revision || thumbnail.createdAt < value.createdAt || thumbnail.createdAt > value.updatedAt) return false
    }
    if ('thumbnail' in input && input.thumbnail !== undefined && !matchesNoteThumbnail(value.thumbnail, input.thumbnail)) return false
  } catch { return false }
  if ('kind' in input) {
    const { promotion, promotedFields } = value
    return Boolean(promotion && promotedFields && promotion.kind === input.kind && promotion.itemId
      && value.revision === input.expectedNoteRevision && value.bookRevision === input.expectedBookRevision + 1
      && value.knowledgeRevision === input.expectedKnowledgeRevision + 1 && promotion.noteRevision === input.expectedNoteRevision
      && promotedFields.title === value.title && promotedFields.body === value.body && promotedFields.category === value.category)
  }
  if (input.chapterIds !== undefined && !sameNoteChapters(value.chapterIds, input.chapterIds)) return false
  if ('material' in input && input.material !== undefined && !sameNoteMaterial(value.material, input.material)) return false
  if (!('fields' in input)) {
    return (value.revision === input.expectedNoteRevision + 1 && value.bookRevision === input.expectedBookRevision + 1)
      || (value.revision === input.expectedNoteRevision && value.bookRevision === input.expectedBookRevision)
  }
  const expected = 'expectedNoteRevision' in input ? input.expectedNoteRevision : 0
  return value.category === input.fields.category && value.title === input.fields.title && value.body === input.fields.body
    && ((value.revision === expected + 1 && value.bookRevision === input.expectedBookRevision + 1)
      || (expected > 0 && value.revision === expected && value.bookRevision === input.expectedBookRevision))
}
