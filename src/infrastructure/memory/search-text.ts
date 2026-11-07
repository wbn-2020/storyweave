import { DomainError } from '../../contracts/api'
import { MEMORY_CHUNK_SIZE } from '../../contracts/memory'

const HAN = /\p{Script=Han}/u
const WORD = /[\p{L}\p{M}\p{N}_]/u
const MAX_QUERY_TOKENS = 80

function encodeWord(word: string): string {
  return `w${Array.from(word, (character) => character.codePointAt(0)!.toString(16)).join('x')}`
}

function* tokens(text: string, query: boolean): Generator<string> {
  let word = ''
  let previousHan = ''
  let singleHan = ''
  for (const character of text.normalize('NFKC').toLowerCase()) {
    if (HAN.test(character)) {
      if (word) { yield encodeWord(word); word = '' }
      const code = character.codePointAt(0)!.toString(16)
      if (!query) yield `h${code}`
      if (previousHan) yield `b${previousHan}x${code}`
      singleHan = previousHan ? '' : code
      previousHan = code
    } else {
      if (query && singleHan) yield `h${singleHan}`
      previousHan = ''
      singleHan = ''
      if (WORD.test(character)) word += character
      else if (word) { yield encodeWord(word); word = '' }
    }
  }
  if (query && singleHan) yield `h${singleHan}`
  if (word) yield encodeWord(word)
}

export function toSearchText(text: string): string {
  if (text.length > MEMORY_CHUNK_SIZE) throw new DomainError({ code: 'STORAGE_ERROR', message: '记忆检索片段超过分片上限。' })
  // Han 单字与相邻双字均编码为 ASCII，适配现有 unicode61 tokenizer。
  return Array.from(tokens(text, false)).join(' ')
}

export function toSearchQuery(query: string): string {
  const compiled = new Set<string>()
  // 查询只拼接编码后的 token；用户输入永远不会成为 FTS 运算符或列名。
  for (const token of tokens(query.slice(0, 200), true)) {
    compiled.add(token)
    if (compiled.size === MAX_QUERY_TOKENS) break
  }
  return Array.from(compiled).join(' AND ')
}
