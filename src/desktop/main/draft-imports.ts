import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { DomainError, isRecord, requiredId, requiredInteger, requiredText, type DraftImportData, type DraftImportPreview, type DraftPreviewInput } from '../../contracts/api'
import { MAX_DRAFT_FILE_BYTES, parseDraftFile } from '../../contracts/draft'
import { countCharacters } from '../../contracts/manuscript'
import { readSelectedFile } from '../file-access'

interface DraftImportSession {
  scope: string
  preview: DraftImportPreview
  bytes: Uint8Array
  hash: string
  expiresAt: number
  attempted: boolean
}

export function parseDraftTarget(value: unknown): DraftPreviewInput {
  if (!isRecord(value)) throw unavailable('草稿恢复目标无效。')
  return { scope: requiredId(value.scope), bookId: requiredId(value.bookId).toLowerCase(), expectedBookRevision: requiredInteger(value.expectedBookRevision, '目标作品版本') }
}

export class DraftImports {
  private session: DraftImportSession | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.session = null
  }

  select(filePath: string, target: DraftPreviewInput): DraftImportPreview {
    return this.prepare(readSelectedFile(filePath, MAX_DRAFT_FILE_BYTES, ['.json']), basename(filePath), target)
  }

  prepare(bytes: Uint8Array, sourceName: string, target: DraftPreviewInput): DraftImportPreview {
    const draft = parseDraftFile(bytes)
    const preview: DraftImportPreview = {
      ...draft, token: randomUUID(), sourceName, targetBookId: target.bookId, expectedBookRevision: target.expectedBookRevision,
      characterCount: countCharacters(draft.plainText),
    }
    this.clear()
    this.session = { scope: target.scope, preview, bytes, hash: hash(bytes), expiresAt: Date.now() + 30 * 60_000, attempted: false }
    this.timer = setTimeout(() => this.clear(), 30 * 60_000)
    this.timer.unref()
    return preview
  }

  consume(value: unknown, scope: string): DraftImportData {
    if (!isRecord(value)) throw unavailable('草稿确认参数无效。')
    const token = requiredId(value.token)
    const title = requiredText(value.title, '新章节名称', 120)
    const session = this.session
    if (!session || session.expiresAt < Date.now() || session.scope !== scope || requiredId(value.scope) !== scope || session.preview.token !== token) {
      throw unavailable('草稿预览已失效，请重新选择并核对目标作品。')
    }
    if (session.attempted) throw unavailable('这份预览已提交过恢复。请先核对回执或目标作品目录，避免重复建立章节。')
    if (hash(session.bytes) !== session.hash) throw unavailable('预览来源发生变化，请重新选择草稿。')
    // 确认后只使用本次预览缓存的原字节；不能重读已变化的路径，也不能重放未知写入。
    session.attempted = true
    return { bookId: session.preview.targetBookId, expectedBookRevision: session.preview.expectedBookRevision, title, sourceName: session.preview.sourceName, sourceBytes: session.bytes }
  }
}

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function unavailable(message: string): DomainError { return new DomainError({ code: 'INVALID_INPUT', message }) }
