import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, opendirSync } from 'node:fs'
import { join } from 'node:path'
import { DomainError, isRecord, requiredId, requiredInteger, type DraftCheckpointReceipt, type RecoveryDraftList, type RecoveryDraftSummary, type SaveChapterOutput, type WorkspaceSnapshot } from '../../contracts/api'
import { MAX_DRAFT_FILE_BYTES, parseDraftFile, type ChapterDraftFile } from '../../contracts/draft'
import { countCharacters, documentToText } from '../../contracts/manuscript'
import { checkedLocalDirectory, readSelectedFile, writeNewText } from '../file-access'
import { parseDraftCopy } from './draft-copy'
import type { RecoveryDraftGeneration, RecoveryDraftInventory } from '../../contracts/book-recovery'

const MAX_FILES = 10_000
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const CHECKPOINT_NAME = /^[0-9a-f-]{36}\.json$/i

interface CheckpointRecord {
  id: string
  root: string
  bookId: string
  chapterId: string
  documentHash: string
  fileHash: string
  directory: string
}

interface Generation extends RecoveryDraftGeneration { directory: string; sequence: number }

export class DraftRecovery {
  private root: string | null = null
  private scope: string | null = null
  private warning: string | null = null
  private readonly recent = new Map<string, CheckpointRecord>()
  private readonly sequences = new Map<string, { sequence: number; hash: string; receipt: DraftCheckpointReceipt }>()

  bind(root: string | null): boolean {
    if (root === this.root) return false
    this.root = root
    this.scope = root ? randomUUID() : null
    this.warning = null
    this.sequences.clear()
    return true
  }

  attach(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    return this.scope && snapshot.rootPath === this.root ? { ...snapshot, recoveryScope: this.scope } : snapshot
  }

  requireScope(value: unknown): string {
    if (!this.root || !this.scope) throw new DomainError({ code: 'WORKSPACE_REQUIRED', message: '请先选择本地作品库。' })
    if (requiredId(value) !== this.scope) throw new DomainError({ code: 'WORKSPACE_BUSY', message: '作品库已变化，旧草稿请求未写入，请重新载入当前书库。' })
    return this.scope
  }

  checkpoint(value: unknown): DraftCheckpointReceipt {
    if (!isRecord(value)) throw invalid('草稿检查点内容无效。')
    this.requireScope(value.scope)
    const draft = parseDraftCopy(value)
    const editorSessionId = requiredId(value.editorSessionId).toLowerCase()
    const editSequence = requiredInteger(value.editSequence, '草稿编辑序号')
    const documentHash = hash(JSON.stringify(draft.document))
    const identity = `${editorSessionId}:${draft.bookId}:${draft.chapterId}`
    const previous = this.sequences.get(identity)
    if (previous && previous.sequence === editSequence && previous.hash === documentHash) return previous.receipt
    if (previous && previous.sequence >= editSequence) throw invalid('检查点编辑序号已过期，现有副本已保留。')
    const root = this.root!
    const directory = this.generations(root, true).at(-1)!.directory
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const file: ChapterDraftFile = {
      format: 'storyweave.chapter-draft', version: 1, description: '自动草稿检查点，需预览确认后恢复为新章节。',
      ...draft, createdAt, plainText: documentToText(draft.document), checkpoint: { id, editorSessionId, editSequence },
    }
    const serialized = JSON.stringify(file) + '\n'
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_DRAFT_FILE_BYTES) throw invalid('本次草稿检查点超过 16 MiB，请另存当前草稿并拆分章节。')
    const usage = this.checkCapacity(directory, bytes)
    writeNewText(join(directory, `${id}.json`), (write) => write(serialized))
    const receipt: DraftCheckpointReceipt = { checkpointId: id, createdAt,
      ...(usage.files + 1 >= MAX_FILES * 0.8 || usage.bytes + bytes >= MAX_TOTAL_BYTES * 0.8
        ? { warning: '当前检查点代容量已达 80%，请查看恢复容量并建立新一代承接保护；旧副本全部保留。' } : {}) }
    this.recent.set(id, { id, root, directory, bookId: draft.bookId, chapterId: draft.chapterId, documentHash, fileHash: hash(serialized) })
    while (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!)
    this.sequences.set(identity, { sequence: editSequence, hash: documentHash, receipt })
    while (this.sequences.size > 256) this.sequences.delete(this.sequences.keys().next().value!)
    return receipt
  }

  list(value: unknown): RecoveryDraftList & RecoveryDraftInventory {
    if (!isRecord(value)) throw invalid('草稿列表请求无效。')
    this.requireScope(value.scope)
    const generations = this.generations(this.root!, false)
    const active = generations.at(-1)!
    const selected = this.generation(generations, value.generationId ?? active.id)
    const usage = this.capacity(active.directory)
    const result: RecoveryDraftList & RecoveryDraftInventory = { items: [], skipped: 0, warnings: this.warning ? [this.warning] : [],
      capacity: { generationId: active.id, ...usage, maxFiles: MAX_FILES, maxBytes: MAX_TOTAL_BYTES },
      selectedGenerationId: selected.id, generations: generations.map(({ id, createdAt }) => ({ id, createdAt, active: id === active.id })) }
    if (usage.files >= MAX_FILES || usage.bytes >= MAX_TOTAL_BYTES) result.warnings.push('当前检查点代已满，请建立新一代继续自动保护。旧代全部保留，可切换查看和恢复。')
    else if (usage.files >= MAX_FILES * 0.8 || usage.bytes >= MAX_TOTAL_BYTES * 0.8) result.warnings.push('当前检查点代已使用超过 80% 容量，可以建立新一代，旧检查点继续保留。')
    const directory = selected.directory
    if (!lstatSync(directory, { throwIfNoEntry: false })) return result
    const latest = new Map<string, { sequence: number; saved: boolean; summary: RecoveryDraftSummary }>()
    const entries = opendirSync(directory)
    let inspected = 0
    let bytesRead = 0
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (entry.name === 'generations' || entry.name === 'generation.json') continue
        inspected += 1
        if (inspected > MAX_FILES) { result.warnings.push('恢复目录项目较多，本次只检查前 10,000 项。已有文件均保留。'); break }
        if (entry.name.endsWith('.saved.json')) continue
        if (!CHECKPOINT_NAME.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) { result.skipped += 1; continue }
        try {
          const checkpointId = requiredId(entry.name.slice(0, -5)).toLowerCase()
          const bytes = readSelectedFile(join(directory, entry.name), MAX_DRAFT_FILE_BYTES, ['.json'])
          bytesRead += bytes.byteLength
          if (bytesRead > MAX_TOTAL_BYTES) { result.warnings.push('本次检查已达到 512 MiB 读取上限，其余文件保持原样。'); break }
          const draft = parseDraftFile(bytes)
          if (draft.checkpoint?.id !== checkpointId) throw invalid('检查点文件身份不符。')
          const key = `${draft.checkpoint.editorSessionId}:${draft.bookId}:${draft.chapterId}`
          const previous = latest.get(key)
          if (previous && previous.sequence > draft.checkpoint.editSequence) continue
          const summary = { checkpointId, bookId: draft.bookId, chapterId: draft.chapterId, title: draft.title, baseRevisionId: draft.baseRevisionId, createdAt: draft.createdAt, characterCount: countCharacters(draft.plainText) }
          latest.set(key, { sequence: draft.checkpoint.editSequence, saved: this.isSaved(directory, checkpointId, hash(bytes)), summary })
        } catch { result.skipped += 1 }
      }
    } finally { entries.closeSync() }
    // 列表只呈现同一次编辑会话的最后有效检查点；全部历史文件仍原样保留在恢复目录。
    result.items = [...latest.values()].filter((item) => !item.saved).map((item) => item.summary)
    result.items.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.checkpointId.localeCompare(right.checkpointId))
    return result
  }

  rotate(value: unknown): RecoveryDraftList & RecoveryDraftInventory {
    if (!isRecord(value)) throw invalid('检查点分代请求无效。')
    this.requireScope(value.scope)
    const generations = this.generations(this.root!, true)
    const active = generations.at(-1)!
    if (value.expectedGenerationId !== active.id) throw invalid('当前检查点代已变化，请刷新容量后再操作。')
    if (generations.length >= 1000) throw invalid('检查点分代已达 1,000 代，请保留现有资料并选择新的作品库。')
    const parent = join(this.directory(this.root!, true)!, 'generations')
    if (!lstatSync(parent, { throwIfNoEntry: false })) mkdirSync(parent)
    checkedLocalDirectory(parent)
    const id = randomUUID()
    const directory = join(parent, id)
    mkdirSync(directory)
    checkedLocalDirectory(directory)
    // 以不可变的代记录发布新写入位置；旧目录不搬移、不覆盖，重启后按序号继续承接。
    writeNewText(join(directory, 'generation.json'), (write) => write(JSON.stringify({
      format: 'storyweave.draft-generation', version: 1, id, sequence: active.sequence + 1, createdAt: new Date().toISOString(),
    }) + '\n'))
    this.sequences.clear()
    this.warning = null
    return this.list({ scope: value.scope, generationId: id })
  }

  read(scope: unknown, id: unknown, generationId?: unknown): Uint8Array {
    this.requireScope(scope)
    const checkpointId = requiredId(id).toLowerCase()
    const generations = this.generations(this.root!, false)
    const directory = this.generation(generations, generationId ?? generations.at(-1)!.id).directory
    const bytes = readSelectedFile(join(directory, `${checkpointId}.json`), MAX_DRAFT_FILE_BYTES, ['.json'])
    if (parseDraftFile(bytes).checkpoint?.id !== checkpointId) throw invalid('检查点身份不符，请保留文件并核对来源。')
    return bytes
  }

  saved(root: string | null, output: SaveChapterOutput): void {
    if (!root) return
    const chapter = output.chapter
    const documentHash = hash(JSON.stringify(chapter.document))
    for (const [id, record] of this.recent) {
      if (record.root !== root || record.bookId !== chapter.bookId || record.chapterId !== chapter.id || record.documentHash !== documentHash) continue
      try {
        const directory = checkedLocalDirectory(record.directory)
        const marker = JSON.stringify({ format: 'storyweave.saved-checkpoint', version: 1, checkpointId: id, fileHash: record.fileHash, savedRevisionId: chapter.revisionId }) + '\n'
        this.checkCapacity(directory, Buffer.byteLength(marker, 'utf8'))
        writeNewText(join(directory, `${id}.saved.json`), (write) => write(marker))
        this.recent.delete(id)
      } catch {
        // 正文已经提交，辅助标记失败只能保留候选，不能反过来把保存结果改成失败。
        this.warning = '部分检查点未能登记已保存状态，列表可能含已经保存的稿件，请与正文版本核对后恢复。'
      }
    }
  }

  private directory(root: string, create: boolean): string | null {
    checkedLocalDirectory(root)
    const path = join(root, 'recovery')
    const info = lstatSync(path, { throwIfNoEntry: false })
    if (!info && !create) return null
    if (!info) mkdirSync(path)
    return checkedLocalDirectory(path)
  }

  private checkCapacity(directory: string, addingBytes: number): { files: number; bytes: number } {
    const usage = this.capacity(directory)
    if (usage.files >= MAX_FILES || usage.bytes + addingBytes > MAX_TOTAL_BYTES) {
      throw invalid('当前检查点代达到容量保护上限，自动检查点暂停。请在草稿恢复中建立新一代；全部旧副本继续保留。')
    }
    return usage
  }

  private capacity(directory: string): { files: number; bytes: number } {
    if (!lstatSync(directory, { throwIfNoEntry: false })) return { files: 0, bytes: 0 }
    checkedLocalDirectory(directory)
    const entries = opendirSync(directory)
    let count = 0
    let bytes = 0
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (entry.name === 'generations' || entry.name === 'generation.json') continue
        count += 1
        if (count > MAX_FILES) break
        const info = lstatSync(join(directory, entry.name))
        if (info.isFile() && !info.isSymbolicLink()) bytes += info.size
      }
    } finally { entries.closeSync() }
    return { files: count, bytes }
  }

  private generation(generations: Generation[], id: unknown): Generation {
    if (typeof id !== 'string' || (id !== 'legacy' && requiredId(id).toLowerCase() !== id)) throw invalid('检查点代标识无效。')
    const found = generations.find((item) => item.id === id)
    if (!found) throw invalid('检查点代不存在，请刷新列表。')
    return found
  }

  private generations(root: string, create: boolean): Generation[] {
    const directory = this.directory(root, create) ?? join(root, 'recovery')
    const result: Generation[] = [{ id: 'legacy', createdAt: null, sequence: 0, directory, active: false }]
    const parent = join(directory, 'generations')
    if (!lstatSync(parent, { throwIfNoEntry: false })) return result
    checkedLocalDirectory(parent)
    const entries = opendirSync(parent)
    let inspected = 0
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++inspected > 1000) throw invalid('检查点分代目录超过保护上限，请保留目录并人工核对。')
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalid('检查点分代目录包含异常项目，已停止写入。')
        const id = requiredId(entry.name).toLowerCase()
        if (entry.name !== id) throw invalid('检查点代标识无效。')
        const path = checkedLocalDirectory(join(parent, id))
        const manifest = join(path, 'generation.json')
        if (!lstatSync(manifest, { throwIfNoEntry: false })) { this.warning = '发现未完成发布的检查点代，其目录已保留；当前仍使用最近完成的代。'; continue }
        let value: unknown
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readSelectedFile(manifest, 4096, ['.json']))) }
        catch { this.warning = '发现未完整写入的检查点代记录，目录已保留；当前仍使用最近完成的代。'; continue }
        if (!isRecord(value) || value.format !== 'storyweave.draft-generation' || value.version !== 1 || value.id !== id ||
          typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) throw invalid('检查点代记录无效，已停止写入。')
        const sequence = requiredInteger(value.sequence, '检查点代序号')
        if (sequence === 0 || result.some((item) => item.sequence === sequence)) throw invalid('检查点代序号冲突，已停止写入。')
        result.push({ id, createdAt: value.createdAt, sequence, directory: path, active: false })
      }
    } finally { entries.closeSync() }
    return result.sort((a, b) => a.sequence - b.sequence)
  }

  private isSaved(directory: string, checkpointId: string, fileHash: string): boolean {
    const path = join(directory, `${checkpointId}.saved.json`)
    if (!lstatSync(path, { throwIfNoEntry: false })) return false
    try {
      const marker: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readSelectedFile(path, 4096, ['.json'])))
      return isRecord(marker) && marker.format === 'storyweave.saved-checkpoint' && marker.version === 1
        && marker.checkpointId === checkpointId && marker.fileHash === fileHash && typeof marker.savedRevisionId === 'string' && Boolean(requiredId(marker.savedRevisionId))
    } catch { return false }
  }
}

function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function invalid(message: string): DomainError { return new DomainError({ code: 'INVALID_INPUT', message }) }
