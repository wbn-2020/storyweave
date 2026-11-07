import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText } from './api'
import { KNOWLEDGE_KINDS, type KnowledgeKind } from './knowledge'

export const NOTE_CATEGORIES = ['inspiration', 'material', 'method'] as const
export const NOTE_CATEGORY_LABELS = { inspiration: '灵感', material: '素材', method: '方法' } as const
export const MAX_NOTES = 10_000
export const MAX_NOTE_BODY = 20_000
export const NOTE_PAGE_SIZE = 40
export const NOTE_SCHEMA_VERSION = 12
export type NoteCategory = typeof NOTE_CATEGORIES[number]
export interface NoteFields { category: NoteCategory; title: string; body: string }
export interface NotePromotion { itemId: string; kind: KnowledgeKind; noteRevision: number; createdAt: string }
export interface NoteSummary {
  id: string; bookId: string; category: NoteCategory; title: string; excerpt: string
  revision: number; createdAt: string; updatedAt: string; promotion: NotePromotion | null
}
export interface NoteDetail extends NoteFields {
  id: string; bookId: string; revision: number; createdAt: string; updatedAt: string
  bookRevision: number; knowledgeRevision: number; archived: boolean
  promotion: NotePromotion | null; promotedFields: NoteFields | null
}
export interface NoteInput { bookId: string; id: string }
export interface ListNotesInput {
  bookId: string; search?: string; category?: NoteCategory; offset?: number; limit?: number; expectedBookRevision?: number
}
export interface NotePage {
  bookId: string; bookRevision: number; knowledgeRevision: number; archived: boolean
  items: NoteSummary[]; total: number; nextOffset: number | null
}
export interface CreateNoteInput extends NoteInput { expectedBookRevision: number; fields: NoteFields }
export interface UpdateNoteInput extends CreateNoteInput { expectedNoteRevision: number }
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
export function parseListNotesInput(value: unknown): ListNotesInput {
  const data = record(value, ['bookId', 'search', 'category', 'offset', 'limit', 'expectedBookRevision'])
  const offset = data.offset === undefined ? 0 : requiredInteger(data.offset, '笔记分页位置', MAX_NOTES)
  const limit = data.limit === undefined ? NOTE_PAGE_SIZE : requiredInteger(data.limit, '每页笔记数', 80)
  if (!limit || (offset > 0 && data.expectedBookRevision === undefined)) invalid('翻页需保留作品版本，每页数量必须在 1 到 80 之间。')
  const search = data.search === undefined ? '' : optionalText(data.search, '笔记搜索', 200)
  if (search.includes('\0')) invalid('搜索内容包含无效字符。')
  return { bookId: requiredId(data.bookId).toLowerCase(), search, offset, limit,
    ...(data.category === undefined ? {} : { category: category(data.category) }),
    ...(data.expectedBookRevision === undefined ? {} : { expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本') }) }
}
export function parseCreateNoteInput(value: unknown): CreateNoteInput {
  const data = record(value, ['bookId', 'id', 'expectedBookRevision', 'fields'])
  return { ...identity(data), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'), fields: parseNoteFields(data.fields) }
}
export function parseUpdateNoteInput(value: unknown): UpdateNoteInput {
  const data = record(value, ['bookId', 'id', 'expectedBookRevision', 'expectedNoteRevision', 'fields'])
  return { ...identity(data), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedNoteRevision: revision(data.expectedNoteRevision), fields: parseNoteFields(data.fields) }
}
export function parsePromoteNoteInput(value: unknown): PromoteNoteInput {
  const data = record(value, ['bookId', 'id', 'expectedBookRevision', 'expectedKnowledgeRevision', 'expectedNoteRevision', 'kind'])
  if (typeof data.kind !== 'string' || !KNOWLEDGE_KINDS.includes(data.kind as KnowledgeKind)) invalid('请选择设定类型。')
  return { ...identity(data), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    expectedKnowledgeRevision: requiredInteger(data.expectedKnowledgeRevision, '知识版本'), expectedNoteRevision: revision(data.expectedNoteRevision), kind: data.kind as KnowledgeKind }
}

export function isNoteWriteReceiptFor(input: CreateNoteInput | UpdateNoteInput | PromoteNoteInput, value: NoteDetail): boolean {
  if (!value || value.bookId !== input.bookId || value.id !== input.id || !Number.isSafeInteger(value.bookRevision)
    || value.bookRevision < input.expectedBookRevision || !Number.isSafeInteger(value.knowledgeRevision) || value.knowledgeRevision < 0 || value.archived
    || !Number.isSafeInteger(value.revision) || value.revision < 1) return false
  if ('kind' in input) {
    const { promotion, promotedFields } = value
    return Boolean(promotion && promotedFields && promotion.kind === input.kind && promotion.itemId
      && value.revision === input.expectedNoteRevision && value.bookRevision === input.expectedBookRevision + 1
      && value.knowledgeRevision === input.expectedKnowledgeRevision + 1 && promotion.noteRevision === input.expectedNoteRevision
      && promotedFields.title === value.title && promotedFields.body === value.body && promotedFields.category === value.category)
  }
  const expected = 'expectedNoteRevision' in input ? input.expectedNoteRevision : 0
  return value.category === input.fields.category && value.title === input.fields.title && value.body === input.fields.body
    && ((value.revision === expected + 1 && value.bookRevision === input.expectedBookRevision + 1)
      || (expected > 0 && value.revision === expected && value.bookRevision === input.expectedBookRevision))
}
