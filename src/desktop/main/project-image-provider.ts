import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { failure, isRecord, type Result } from '../../contracts/api'
import { parseAiConnection, type AiConnection } from '../../contracts/ai'

export interface ProjectImageProvider { connection: AiConnection; apiKey: string }

/** 开发项目的生图凭据只在主进程按固定文件读取，不进入构建、作品库或渲染进程。 */
export function readProjectImageProvider(root: string): Result<ProjectImageProvider | null> {
  try {
    const file = join(root, '.env.huantu.local'), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('invalid-config')
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(value) || Object.keys(value).length !== 3 ||
      value.endpoint !== 'https://huantu.xyz/api/v1/images/generations' ||
      typeof value.model !== 'string' || typeof value.apiKey !== 'string' ||
      !value.apiKey.trim() || value.apiKey.length > 8192 || /[\r\n\0]/.test(value.apiKey)) throw new Error('invalid-config')
    const connection = parseAiConnection({
      id: 'afe827df-b251-49d6-98b2-8715ca4b10bd', name: '幻图 · 项目生图',
      baseUrl: 'https://huantu.xyz/api/v1', model: value.model,
      contextWindow: 65536, maxOutputTokens: 4096, version: 1, updatedAt: stat.mtime.toISOString(),
    })
    return { ok: true, data: { connection, apiKey: value.apiKey } }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { ok: true, data: null }
    // 不把解析异常或原配置内容写入错误消息，避免密钥随日志或界面流出。
    return failure('STORAGE_ERROR', '项目生图配置 .env.huantu.local 无法读取或格式无效，请核对后重启应用。')
  }
}
