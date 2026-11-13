import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { DomainError, type FileWriteReceipt } from '../contracts/api'

function localPath(value: string): string {
  if (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':') || value.includes('\0')) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '请选择本机磁盘中的普通文件。' })
  }
  return resolve(value)
}

export function checkedLocalDirectory(value: string): string {
  const requested = localPath(value)
  const canonical = realpathSync.native(requested)
  localPath(canonical)
  if (requested.toLowerCase() !== resolve(canonical).toLowerCase() || !lstatSync(canonical).isDirectory()) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '不支持链接目录或网络位置，请选择本机普通目录。' })
  }
  return canonical
}

export function readSelectedText(filePath: string, maxBytes: number): Uint8Array {
  return readSelectedFile(filePath, maxBytes, ['.txt', '.md', '.markdown'])
}

export function readSelectedFile(filePath: string, maxBytes: number, extensions: readonly string[]): Uint8Array {
  const requested = localPath(filePath)
  const parent = checkedLocalDirectory(dirname(requested))
  const canonical = realpathSync.native(requested)
  if (resolve(canonical).toLowerCase() !== requested.toLowerCase()) throw new DomainError({ code: 'INVALID_INPUT', message: '不支持链接文件。' })
  if (!extensions.includes(extname(requested).toLowerCase())) throw new DomainError({ code: 'INVALID_INPUT', message: '所选文件的扩展名不受支持。' })
  const info = lstatSync(join(parent, basename(requested)))
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new DomainError({ code: 'INVALID_INPUT', message: `导入文件必须是普通文本，且不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB。` })
  const fd = openSync(requested, 'r')
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs) throw new DomainError({ code: 'INVALID_INPUT', message: '文件在读取前发生变化，请重新选择。' })
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (read === 0) throw new DomainError({ code: 'INVALID_INPUT', message: '文件读取不完整，请重新选择。' })
      offset += read
    }
    const after = fstatSync(fd)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new DomainError({ code: 'INVALID_INPUT', message: '文件在读取期间发生变化，请重新选择。' })
    return bytes
  } finally { closeSync(fd) }
}

export function writeNewText<T>(filePath: string, producer: (write: (chunk: string) => void) => T): { receipt: FileWriteReceipt; value: T } {
  return writeNewFile(filePath, (write) => producer((chunk) => write(Buffer.from(chunk, 'utf8'))))
}

export function writeNewBinary(filePath: string, bytes: Uint8Array): FileWriteReceipt {
  return writeNewFile(filePath, (write) => write(bytes)).receipt
}

function writeNewFile<T>(filePath: string, producer: (write: (chunk: Uint8Array) => void) => T): { receipt: FileWriteReceipt; value: T } {
  const requested = localPath(filePath)
  const name = basename(requested)
  if (!name || /[<>:"|?*]/.test(name) || /[ .]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '文件名无效，请使用普通文件名。' })
  }
  const parent = checkedLocalDirectory(dirname(requested))
  const target = join(parent, name)
  let fd: number | undefined
  let created = false
  let bytes = 0
  try {
    // wx 保证不会覆盖同名稿件。写入失败保留残留文件，供作者核对，不自动删除。
    fd = openSync(target, 'wx')
    created = true
    const value = producer((buffer) => {
      let offset = 0
      while (offset < buffer.length) {
        const written = writeSync(fd!, buffer, offset, buffer.length - offset)
        if (written === 0) throw new Error('Incomplete file write')
        bytes += written
        offset += written
      }
    })
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    return { receipt: { filePath: target, bytes }, value }
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 保留文件并报告写入未完成。 */ } }
    if (error instanceof DomainError) {
      if (!created) throw error
      throw new DomainError({ ...error.detail, message: `${error.detail.message} 已创建的空文件或部分内容保留在：${target}。请核对后另选新文件名。` })
    }
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      throw new DomainError({ code: 'INVALID_INPUT', message: '同名文件已存在，未覆盖任何内容。请选择新的文件名。' })
    }
    throw new DomainError({ code: 'STORAGE_ERROR', message: `文件写入未完成，请核对所选文件；可能已保留部分内容：${target}` })
  }
}
