import { DomainError, isRecord, requiredId, requiredInteger, requiredText } from './api'
import { parseAiConnection, type AiConnection } from './ai'
import { parseMemorySearchInput, type MemoryEvidence, type MemorySearchInput, type MemorySearchPage } from './memory'

export const MEMORY_VECTOR_BATCH_SIZE = 8
export const MEMORY_VECTOR_MAX_DIMENSIONS = 4096
export const MEMORY_VECTOR_SCAN_LIMIT = 5000
export const MEMORY_VECTOR_CANDIDATES = 100
export type MemoryVectorKind = 'index' | 'search'
export type MemoryVectorState = 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface MemoryVectorProfileInput { bookId: string; connectionId: string; embeddingModel: string }
export interface MemoryVectorProfileServiceInput extends MemoryVectorProfileInput { connection: AiConnection }
export interface MemoryVectorPrepareInput extends MemoryVectorProfileInput {
  expectedPublicationVersion: number
  kind: MemoryVectorKind
  search?: MemorySearchInput
}
export interface MemoryVectorPrepareServiceInput extends MemoryVectorPrepareInput { connection: AiConnection }
export interface MemoryVectorReadInput { bookId: string; runId: string }
export interface MemoryVectorSearchResultInput { bookId: string; expectedPublicationVersion: number }
export interface MemoryVectorSearchResultOption {
  id: string
  query: string
  connectionName: string
  embeddingModel: string
  updatedAt: string
  hitCount: number
  truncated: boolean
}
export interface MemoryVectorSearchResultPage {
  bookId: string
  publicationVersion: number
  items: MemoryVectorSearchResultOption[]
  truncated: boolean
}
export interface MemoryVectorVersionInput extends MemoryVectorReadInput { expectedVersion: number }
export interface MemoryVectorStartInput extends MemoryVectorVersionInput { contextHash: string }
export interface MemoryVectorUsage { inputTokens: number | null; totalTokens: number | null }
export interface MemoryEmbeddingResponse { model: string; vectors: number[][]; usage: MemoryVectorUsage }
export interface MemoryVectorFinishInput extends MemoryVectorVersionInput {
  state: 'succeeded' | 'failed' | 'cancelled'
  response?: MemoryEmbeddingResponse
  error?: string
}
export interface MemoryVectorContext {
  bookId: string
  kind: MemoryVectorKind
  publicationVersion: number
  connection: AiConnection
  embeddingModel: string
  profileHash: string
  items: MemoryEvidence[]
  input: string[]
  search?: MemorySearchInput
  estimatedInputTokens: number
  contextHash: string
}
export interface MemoryVectorRunSummary {
  id: string
  bookId: string
  version: number
  state: MemoryVectorState
  kind: MemoryVectorKind
  publicationVersion: number
  connectionName: string
  embeddingModel: string
  inputCount: number
  error: string | null
  createdAt: string
  updatedAt: string
}
export interface MemoryVectorRun extends MemoryVectorRunSummary {
  context: MemoryVectorContext
  result: MemorySearchPage | null
  usage: MemoryVectorUsage | null
  active?: boolean
}
export interface MemoryVectorStatus {
  bookId: string
  requiresUpgrade: boolean
  publicationVersion: number
  profileHash: string
  eligibleChunks: number
  indexedChunks: number
  dimensions: number | null
  responseModel: string | null
  recentRuns: MemoryVectorRunSummary[]
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid('向量请求格式无效或包含不支持的字段。')
  return value
}
function id(value: unknown): string { return requiredId(value).toLowerCase() }
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid('向量预览指纹无效。')
  return value
}
function profile(data: Record<string, unknown>): MemoryVectorProfileInput {
  const embeddingModel = requiredText(data.embeddingModel, '向量模型', 200)
  if (/[\u0000-\u001f\u007f]/.test(embeddingModel)) invalid('向量模型名称不能包含控制字符。')
  return { bookId: id(data.bookId), connectionId: id(data.connectionId), embeddingModel }
}
export function parseMemoryVectorProfileInput(value: unknown): MemoryVectorProfileInput {
  return profile(record(value, ['bookId', 'connectionId', 'embeddingModel']))
}
export function parseMemoryVectorProfileServiceInput(value: unknown): MemoryVectorProfileServiceInput {
  const data = record(value, ['bookId', 'connectionId', 'embeddingModel', 'connection'])
  const parsed = profile(data)
  const connection = parseAiConnection(data.connection)
  if (connection.id !== parsed.connectionId) invalid('向量连接身份不符。')
  return { ...parsed, connection }
}
function prepare(data: Record<string, unknown>): MemoryVectorPrepareInput {
  const parsed = profile(data)
  if (data.kind !== 'index' && data.kind !== 'search') invalid('向量请求用途无效。')
  const expectedPublicationVersion = requiredInteger(data.expectedPublicationVersion, '索引发布版本')
  if (expectedPublicationVersion < 1) invalid('请先整理并发布本地索引。')
  if (data.kind === 'index') {
    if (data.search !== undefined) invalid('向量整理不能附带检索条件。')
    return { ...parsed, expectedPublicationVersion, kind: 'index' }
  }
  const search = parseMemorySearchInput(data.search)
  if (search.bookId !== parsed.bookId || !search.query) invalid('请填写当前作品的语义检索内容。')
  if (search.query.includes('\0')) invalid('向量检索文字不能包含空字符。')
  return { ...parsed, expectedPublicationVersion, kind: 'search', search }
}
export function parseMemoryVectorPrepareInput(value: unknown): MemoryVectorPrepareInput {
  return prepare(record(value, ['bookId', 'connectionId', 'embeddingModel', 'expectedPublicationVersion', 'kind', 'search']))
}
export function parseMemoryVectorPrepareServiceInput(value: unknown): MemoryVectorPrepareServiceInput {
  const data = record(value, ['bookId', 'connectionId', 'embeddingModel', 'expectedPublicationVersion', 'kind', 'search', 'connection'])
  const parsed = prepare(data)
  const connection = parseAiConnection(data.connection)
  if (connection.id !== parsed.connectionId) invalid('向量连接身份不符。')
  return { ...parsed, connection }
}
export function parseMemoryVectorReadInput(value: unknown): MemoryVectorReadInput {
  const data = record(value, ['bookId', 'runId'])
  return { bookId: id(data.bookId), runId: id(data.runId) }
}
export function parseMemoryVectorSearchResultInput(value: unknown): MemoryVectorSearchResultInput {
  const data = record(value, ['bookId', 'expectedPublicationVersion'])
  return { bookId: id(data.bookId), expectedPublicationVersion: requiredInteger(data.expectedPublicationVersion, '索引发布版本') }
}
function version(data: Record<string, unknown>): MemoryVectorVersionInput {
  return { bookId: id(data.bookId), runId: id(data.runId), expectedVersion: requiredInteger(data.expectedVersion, '向量请求版本') }
}
export function parseMemoryVectorVersionInput(value: unknown): MemoryVectorVersionInput {
  return version(record(value, ['bookId', 'runId', 'expectedVersion']))
}
export function parseMemoryVectorStartInput(value: unknown): MemoryVectorStartInput {
  const data = record(value, ['bookId', 'runId', 'expectedVersion', 'contextHash'])
  return { ...version(data), contextHash: hash(data.contextHash) }
}
export function parseMemoryVectorValues(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MEMORY_VECTOR_MAX_DIMENSIONS) {
    invalid('模型返回的向量维度或数值无效。')
  }
  const entries = Array.from(value)
  if (entries.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry)) || entries.every((entry) => entry === 0)) {
    invalid('模型返回的向量维度或数值无效。')
  }
  return entries as number[]
}
function tokenCount(value: unknown): number | null {
  return value === undefined || value === null ? null : requiredInteger(value, '向量请求用量')
}
function usage(value: unknown): MemoryVectorUsage {
  if (value === undefined || value === null) return { inputTokens: null, totalTokens: null }
  const data = record(value, ['inputTokens', 'totalTokens'])
  const parsed = { inputTokens: tokenCount(data.inputTokens), totalTokens: tokenCount(data.totalTokens) }
  if (parsed.inputTokens !== null && parsed.totalTokens !== null && parsed.totalTokens < parsed.inputTokens) invalid('向量请求用量无效。')
  return parsed
}
export function parseMemoryEmbeddingResponse(value: unknown, inputCount: number): MemoryEmbeddingResponse {
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > MEMORY_VECTOR_BATCH_SIZE || !isRecord(value) ||
    value.object !== 'list' || !Array.isArray(value.data) || value.data.length !== inputCount) invalid('向量响应数量或格式无效。')
  const vectors: number[][] = new Array(inputCount)
  for (const entry of value.data) {
    if (!isRecord(entry) || entry.object !== 'embedding' || !Number.isInteger(entry.index) ||
      (entry.index as number) < 0 || (entry.index as number) >= inputCount || vectors[entry.index as number] !== undefined) invalid('向量响应序号无效或重复。')
    vectors[entry.index as number] = parseMemoryVectorValues(entry.embedding)
  }
  if (Array.from(vectors).some((vector) => !vector) || vectors.some((vector) => vector.length !== vectors[0]!.length)) invalid('向量响应序号缺失或维度不一致。')
  const responseUsage = isRecord(value.usage) ? { inputTokens: value.usage.prompt_tokens, totalTokens: value.usage.total_tokens } : undefined
  return { model: requiredText(value.model, '返回向量模型', 200), vectors, usage: usage(responseUsage) }
}
export function parseMemoryVectorFinishInput(value: unknown): MemoryVectorFinishInput {
  const data = record(value, ['bookId', 'runId', 'expectedVersion', 'state', 'response', 'error'])
  const parsed = version(data)
  if (data.state !== 'succeeded' && data.state !== 'failed' && data.state !== 'cancelled') invalid('向量请求结束状态无效。')
  if (data.state === 'succeeded') {
    const response = record(data.response, ['model', 'vectors', 'usage'])
    if (!Array.isArray(response.vectors) || response.vectors.length < 1 || response.vectors.length > MEMORY_VECTOR_BATCH_SIZE || data.error !== undefined) invalid('向量结果格式无效。')
    const vectors = Array.from(response.vectors, parseMemoryVectorValues)
    if (vectors.some((vector) => !vector) || vectors.some((vector) => vector.length !== vectors[0]!.length)) invalid('向量结果序号缺失或维度不一致。')
    return { ...parsed, state: 'succeeded', response: { model: requiredText(response.model, '返回向量模型', 200), vectors, usage: usage(response.usage) } }
  }
  if (data.response !== undefined) invalid('未成功的请求不能保存向量结果。')
  return { ...parsed, state: data.state, ...(data.error === undefined ? {} : { error: requiredText(data.error, '向量请求错误', 500) }) }
}
