import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, opendirSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { DomainError, isRecord, requiredId } from '../../contracts/api'
import { parseAiFinishInput, type AiFinishInput } from '../../contracts/ai'
import { parseMemoryVectorFinishInput, type MemoryVectorFinishInput } from '../../contracts/memory-vector'
import { parseGenerationFinishInput, type GenerationFinishInput } from '../../contracts/generation'
import { checkedLocalDirectory, readSelectedFile, writeNewText } from '../file-access'

export type PendingAiPayload = { contextHash: string } & (
  { command: 'ai.finish'; input: AiFinishInput } | { command: 'memory.vector.finish'; input: MemoryVectorFinishInput } | { command: 'generation.finish'; input: GenerationFinishInput }
)
interface PendingAiVolume { id: string; hash: string | null; sequence: number; identity: string }
interface Capacity { files: number; bytes: number }
export interface PendingAiPreflight {
  root: string; volume: PendingAiVolume; readyId: string; readyHash: string; capacity: Capacity
}
export interface PendingAiFile { id: string; hash: string; root: string; volume: PendingAiVolume; payload: PendingAiPayload }
export type PendingAiEntry = { file: PendingAiFile } | { warning: string }
const MAX_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 10_000
const MAX_VOLUME_BYTES = 512 * 1024 * 1024
const METADATA_BYTES = 4096
const MIN_FREE_BYTES = MAX_BYTES + 1024 * 1024
const ROTATE_AT = 0.8
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SETTLED_NAME = new RegExp(`^(${UUID})(?:\\.${UUID})?\\.settled\\.json$`)
const READY_NAME = new RegExp(`^(${UUID})\\.ready\\.json$`)

function invalid(message: string): never { throw new DomainError({ code: 'STORAGE_ERROR', message }) }
function digest(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }
function timestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function json(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
function directoryIdentity(path: string): string {
  checkedLocalDirectory(path)
  const info = lstatSync(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) invalid('模型结果留存目录身份无效。')
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`
}
function nearCapacity(usage: Capacity, files: number, bytes: number): boolean {
  return usage.files + files >= MAX_ENTRIES * ROTATE_AT || usage.bytes + bytes >= MAX_VOLUME_BYTES * ROTATE_AT
}
function capacityText(usage: Capacity): string {
  return `${usage.files}/${MAX_ENTRIES} 项，${usage.bytes}/${MAX_VOLUME_BYTES} 字节（80% 自动分卷）`
}
function parsePayload(value: unknown): PendingAiPayload {
  if (!isRecord(value) || Object.keys(value).some((key) => !['command', 'contextHash', 'input'].includes(key)) ||
      typeof value.contextHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contextHash)) invalid('待存模型结果的身份无效，请保留原文件。')
  if (value.command === 'ai.finish') return { command: value.command, contextHash: value.contextHash, input: parseAiFinishInput(value.input) }
  if (value.command === 'memory.vector.finish') return { command: value.command, contextHash: value.contextHash, input: parseMemoryVectorFinishInput(value.input) }
  if (value.command === 'generation.finish') return { command: value.command, contextHash: value.contextHash, input: parseGenerationFinishInput(value.input) }
  return invalid('待存模型结果的命令不受支持。')
}

function read(path: string, maximum: number): Uint8Array {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) invalid('待存模型结果包含链接或异常文件，已停止读取。')
  return readSelectedFile(path, maximum, ['.json'])
}

/** 只写终态数据白名单；会话连接对象、请求头和密钥不能进入恢复日志。 */
export class PendingAiResults {
  constructor(private readonly directoryName: 'pending-model-results' | 'pending-generation-results' = 'pending-model-results') {}
  private directory(root: string, create: boolean): string | null {
    const parent = checkedLocalDirectory(root)
    const directory = join(parent, this.directoryName)
    if (!lstatSync(directory, { throwIfNoEntry: false })) {
      if (!create) return null
      mkdirSync(directory)
    }
    return checkedLocalDirectory(directory)
  }

  preflight(root: string): PendingAiPreflight {
    let capacity: Capacity | undefined
    try {
      const base = this.directory(root, true)!
      let volume: PendingAiVolume | undefined
      // 旧根目录只承接恢复与完成标记；损坏或未发布的分卷保留，由 load 单独提示。
      for (const entry of this.volumes(root, base)) {
        if ('volume' in entry && entry.volume.id !== 'legacy' && (!volume || entry.volume.sequence > volume.sequence ||
          entry.volume.sequence === volume.sequence && entry.volume.id > volume.id)) volume = entry.volume
      }
      const previousVolumeId = volume?.id ?? 'legacy'
      if (volume) capacity = this.capacity(this.locate(root, volume))
      let directory = volume ? this.locate(root, volume) : base
      let freeBytes = this.freeBytes(directory)
      if (!volume || nearCapacity(capacity!, 3, MAX_BYTES + 2 * METADATA_BYTES)) {
        volume = this.createVolume(root, base, (volume?.sequence ?? 0) + 1)
        directory = this.locate(root, volume)
        capacity = this.capacity(directory)
        freeBytes = this.freeBytes(directory)
      }
      const readyId = randomUUID()
      const content = JSON.stringify({ format: 'storyweave.pending-ai-ready', version: 1, id: readyId,
        workspaceRoot: root, volumeId: volume.id, volumeHash: volume.hash, createdAt: new Date().toISOString(),
        capacity: { ...capacity!, entryLimit: MAX_ENTRIES, byteLimit: MAX_VOLUME_BYTES, rotateAt: ROTATE_AT,
          availableBytes: freeBytes.toString(), requiredFreeBytes: MIN_FREE_BYTES, previousVolumeId } }) + '\n'
      if (Buffer.byteLength(content, 'utf8') > METADATA_BYTES) invalid('书库路径与预检记录超过 4 KiB，未开始留存预检写入。')
      // claim 和网络请求前，以独占写入及 fsync 验证可写性；记录不含输入正文、连接或密钥。
      // 这是当前余量检查，不能锁住其他进程随后可能占用的磁盘空间。
      writeNewText(join(directory, `${readyId}.ready.json`), (write) => write(content))
      this.freeBytes(directory)
      return { root, volume, readyId, readyHash: digest(content), capacity: capacity! }
    } catch (error) {
      const detail = error instanceof DomainError ? error.detail.message : '无法检查目录或磁盘可用空间。'
      invalid(`模型结果留存预检未通过。${capacity ? ` 当前卷 ${capacityText(capacity)}。` : ''} ${detail}`)
    }
  }

  save(root: string, payload: PendingAiPayload, checked?: PendingAiPreflight): PendingAiFile {
    const normalized = parsePayload(payload)
    let preflight = checked ?? this.preflight(root)
    if (preflight.root !== root) invalid('模型结果预检不属于当前书库，未提交数据库。')
    let directory = this.locate(root, preflight.volume)
    if (digest(read(join(directory, `${requiredId(preflight.readyId)}.ready.json`), METADATA_BYTES)) !== preflight.readyHash) {
      invalid('模型结果预检记录已变化，请保留结果并核对原分卷。')
    }
    // 多次失败留下的残件也计入容量；必要时新建分卷，原预检和部分结果均不覆盖。
    if (nearCapacity(this.capacity(directory), 2, MAX_BYTES + METADATA_BYTES)) {
      preflight = this.preflight(root)
      directory = this.locate(root, preflight.volume)
    }
    const volume = preflight.volume
    const id = randomUUID()
    const content = JSON.stringify({ format: 'storyweave.pending-ai-result', version: 2, id,
      volumeId: volume.id, volumeHash: volume.hash, readyId: preflight.readyId,
      workspaceRoot: root, createdAt: new Date().toISOString(), payload: normalized }) + '\n'
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) invalid('待存模型结果超过 4 MiB，结果仍在窗口会话保留，请另存后处理。')
    // 先完整落盘并同步，再允许发送 finish；中断后只补写本地终态，绝不再次请求模型。
    writeNewText(join(directory, `${id}.json`), (write) => write(content))
    return { id, hash: digest(content), root, volume, payload: normalized }
  }

  *load(root: string): Generator<PendingAiEntry> {
    const directory = this.directory(root, false)
    if (!directory) return
    for (const entry of this.volumes(root, directory)) {
      if ('warning' in entry) { yield entry; continue }
      try { yield* this.loadVolume(root, entry.volume) }
      catch { yield { warning: `无法扫描模型结果分卷 ${entry.volume.id}，原目录已保留；其他分卷仍继续核对。` } }
    }
  }

  private *loadVolume(root: string, volume: PendingAiVolume): Generator<PendingAiEntry> {
    const directory = this.locate(root, volume)
    const names = this.entries(directory)
    const present = new Set(names)
    const settlements = new Map<string, string[]>()
    for (const name of names) {
      const match = SETTLED_NAME.exec(name)
      if (!match) continue
      const id = match[1]!
      const group = settlements.get(id) ?? []
      group.push(name)
      settlements.set(id, group)
      if (!present.has(`${id}.json`)) yield { warning: `分卷 ${volume.id} 的完成标记 ${name} 缺少原结果，已保留待人工核对。` }
    }
    // 读取、补存与追加完成标记不设新写容量门槛；旧满卷也必须逐项恢复。
    for (const name of names) {
      if (SETTLED_NAME.test(name) || (volume.id === 'legacy' ? name === 'volumes' : name === 'volume.json')) continue
      try {
        const ready = READY_NAME.exec(name)
        if (ready && volume.id !== 'legacy') {
          const value = json(read(join(directory, name), METADATA_BYTES))
          if (!isRecord(value) || value.format !== 'storyweave.pending-ai-ready' || value.version !== 1 || value.id !== ready[1] ||
            value.workspaceRoot !== root || value.volumeId !== volume.id || value.volumeHash !== volume.hash || !timestamp(value.createdAt) ||
            !isRecord(value.capacity) || typeof value.capacity.files !== 'number' || typeof value.capacity.bytes !== 'number') invalid('预检记录不完整。')
          // 只有预检、没有终态可能是 claim 前取消；不能据此推定已发送，更不能重发模型。
          continue
        }
        const id = requiredId(name.slice(0, -5)).toLowerCase()
        if (name !== `${id}.json`) invalid('待存模型结果目录含未知项目。')
        const bytes = read(join(directory, name), MAX_BYTES)
        const hash = digest(bytes)
        if (this.hasSettlement(directory, volume, id, hash, settlements.get(id) ?? [])) continue
        const value = json(bytes)
        const fields = ['format', 'version', 'id', 'workspaceRoot', 'createdAt', 'payload',
          ...(volume.id === 'legacy' ? [] : ['volumeId', 'volumeHash', 'readyId'])]
        if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key)) ||
          value.format !== 'storyweave.pending-ai-result' || value.version !== (volume.id === 'legacy' ? 1 : 2) ||
          value.id !== id || value.workspaceRoot !== root || !timestamp(value.createdAt)) invalid('待存模型结果的来源或格式无效。')
        if (volume.id !== 'legacy' && (value.volumeId !== volume.id || value.volumeHash !== volume.hash ||
          requiredId(value.readyId).toLowerCase() !== value.readyId)) invalid('待存模型结果的原分卷身份不符。')
        yield { file: { id, hash, root, volume, payload: parsePayload(value.payload) } }
      } catch {
        yield { warning: `无法核对分卷 ${volume.id} 的留存项目 ${name}，原文件保留在 ${this.directoryName} 中。` }
      }
    }
  }

  settle(file: PendingAiFile, disposition: 'committed' | 'exported'): void {
    const directory = this.locate(file.root, file.volume)
    const id = requiredId(file.id).toLowerCase()
    if (digest(read(join(directory, `${id}.json`), MAX_BYTES)) !== file.hash) invalid('待存模型结果已变化，未解除恢复状态。')
    if (this.hasSettlement(directory, file.volume, id, file.hash, this.entries(directory))) return
    // 完成标记也可能在断电时只写了一部分，追加独立记录即可续办，不覆盖残件。
    // 使用原卷身份，不选择当前写入卷；满卷仍可追加这个小标记，不做发送前余量检查。
    const path = join(directory, `${id}.${randomUUID()}.settled.json`)
    writeNewText(path, (write) => write(JSON.stringify({ format: 'storyweave.settled-ai-result',
      version: file.volume.id === 'legacy' ? 1 : 2,
      ...(file.volume.id === 'legacy' ? {} : { volumeId: file.volume.id, volumeHash: file.volume.hash }),
      id, hash: file.hash, disposition, createdAt: new Date().toISOString() }) + '\n'))
  }

  private hasSettlement(directory: string, volume: PendingAiVolume, id: string, hash: string, names: readonly string[]): boolean {
    for (const name of names) {
      if (SETTLED_NAME.exec(name)?.[1] !== id) continue
      try {
        const receipt = json(read(join(directory, name), METADATA_BYTES))
        if (isRecord(receipt) && receipt.format === 'storyweave.settled-ai-result' &&
            (volume.id === 'legacy' ? receipt.version === 1 : receipt.version === 2 && receipt.volumeId === volume.id && receipt.volumeHash === volume.hash) &&
            receipt.id === id && receipt.hash === hash && ['committed', 'exported'].includes(String(receipt.disposition))) return true
      } catch { /* 不完整标记原样保留，由原结果与数据库重新核对后追加完成标记。 */ }
    }
    return false
  }

  private freeBytes(directory: string): bigint {
    const space = statfsSync(directory, { bigint: true })
    const available = space.bavail * space.bsize
    if (available < BigInt(MIN_FREE_BYTES)) invalid(`模型结果留存可用空间 ${available} 字节，至少需要 ${MIN_FREE_BYTES} 字节；旧结果与日志全部保留。`)
    return available
  }

  private capacity(directory: string): Capacity {
    let bytes = 0
    const names = this.entries(directory)
    for (const name of names) {
      const info = lstatSync(join(directory, name))
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) invalid('当前模型结果分卷含异常项目，请保留原目录并核对。')
      bytes += info.size
    }
    return { files: names.length, bytes }
  }

  private createVolume(root: string, base: string, sequence: number): PendingAiVolume {
    if (!Number.isSafeInteger(sequence) || sequence < 1) invalid('模型结果分卷序号已超出范围，请保留现有目录。')
    const parent = join(base, 'volumes')
    if (!lstatSync(parent, { throwIfNoEntry: false })) mkdirSync(parent)
    checkedLocalDirectory(parent)
    const id = randomUUID()
    const directory = join(parent, id)
    mkdirSync(directory)
    checkedLocalDirectory(directory)
    // 完整写入不可变卷身份后才发布；中断的空目录或 manifest 残件下次跳过并提示。
    writeNewText(join(directory, 'volume.json'), (write) => write(JSON.stringify({
      format: 'storyweave.pending-ai-volume', version: 1, id, sequence, workspaceRoot: root, createdAt: new Date().toISOString(),
    }) + '\n'))
    return this.readVolume(root, parent, id)
  }

  private readVolume(root: string, parent: string, id: string): PendingAiVolume {
    if (requiredId(id).toLowerCase() !== id) invalid('模型结果分卷标识无效。')
    checkedLocalDirectory(parent)
    const directory = join(parent, id)
    const identity = directoryIdentity(directory)
    const bytes = read(join(directory, 'volume.json'), METADATA_BYTES)
    const value = json(bytes)
    if (!isRecord(value) || Object.keys(value).some((key) => !['format', 'version', 'id', 'sequence', 'workspaceRoot', 'createdAt'].includes(key)) ||
      value.format !== 'storyweave.pending-ai-volume' || value.version !== 1 || value.id !== id || value.workspaceRoot !== root ||
      typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !timestamp(value.createdAt)) invalid('模型结果分卷身份尚未完整发布。')
    return { id, hash: digest(bytes), sequence: value.sequence, identity }
  }

  private *volumes(root: string, base: string): Generator<{ volume: PendingAiVolume } | { warning: string }> {
    yield { volume: { id: 'legacy', hash: null, sequence: 0, identity: directoryIdentity(base) } }
    const parent = join(base, 'volumes')
    if (!lstatSync(parent, { throwIfNoEntry: false })) return
    let names: string[]
    try { checkedLocalDirectory(parent); names = this.entries(parent) }
    catch { yield { warning: '无法读取模型结果分卷目录，已保留原目录；旧根目录结果仍可核对。' }; return }
    for (const id of names) {
      try { yield { volume: this.readVolume(root, parent, id) } }
      catch { yield { warning: `模型结果分卷 ${id} 未完整发布或身份无效，已保留原目录；其他分卷仍继续核对。` } }
    }
  }

  private locate(root: string, expected: PendingAiVolume): string {
    const base = this.directory(root, false)
    if (!base) invalid('模型结果原留存目录不存在，未新建替代目录。')
    const current = expected.id === 'legacy'
      ? { id: 'legacy', hash: null, sequence: 0, identity: directoryIdentity(base) }
      : this.readVolume(root, join(base, 'volumes'), expected.id)
    if (current.hash !== expected.hash || current.sequence !== expected.sequence || current.identity !== expected.identity) {
      invalid('模型结果原分卷已替换或身份已变化，未解除恢复状态。')
    }
    return expected.id === 'legacy' ? base : join(base, 'volumes', expected.id)
  }

  private entries(directory: string): string[] {
    const entries = opendirSync(directory)
    const result: string[] = []
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        result.push(entry.name)
      }
    } finally { entries.closeSync() }
    return result.sort()
  }
}
