import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { countCharacters, documentToText, parseManuscript, type ManuscriptDocument } from '../../contracts/manuscript'
import { WORKBENCH_SCHEMA_VERSION, type WritingDay } from '../../contracts/workbench'

export function localWritingDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// 合并比较最多展开 65,536 个 UTF-16 单位；完整文字复用核对只做线性扫描。
const MAX_COMBINED_DIFF_LENGTH = 65_536

function blockTexts(document: ManuscriptDocument | null): Map<string, string> {
  // 与 countCharacters 一致忽略空白，段落边界、软换行和格式本身不产生字数。
  return new Map((document?.content ?? []).map((block) => [block.attrs.id, documentToText({ type: 'doc', content: [block] }).replace(/\s/gu, '')]))
}

function textCounts(previous: string, next: string): { added: number; removed: number } {
  if (previous === next) return { added: 0, removed: 0 }
  const a = Array.from(previous)
  const b = Array.from(next)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  // 这里只扣除共同前后缀；多处编辑之间未改的文字也可能计入中段，是版本差异近似而非击键数。
  return { added: b.length - head - tail, removed: a.length - head - tail }
}

function isSubsequence(previous: string, next: string): boolean {
  const characters = previous[Symbol.iterator]()
  let expected = characters.next()
  for (const character of next) {
    if (expected.done) return true
    if (character === expected.value) expected = characters.next()
  }
  return expected.done === true
}

function changedCounts(before: ManuscriptDocument | null, after: ManuscriptDocument): { added: number; removed: number } {
  const old = blockTexts(before)
  const current = blockTexts(after)
  const previousParts: string[] = []
  const nextParts: string[] = []
  // 同 ID 且文字未变的段落两侧均排除，整段移动仍计零；其余文字保留各自的正文顺序。
  for (const [id, previous] of old) {
    if (previous !== current.get(id)) previousParts.push(previous)
  }
  for (const [id, next] of current) {
    if (old.get(id) !== next) nextParts.push(next)
  }

  const previous = previousParts.join('')
  const next = nextParts.join('')
  if (previous === next) return { added: 0, removed: 0 }
  const previousCount = countCharacters(previous)
  const nextCount = countCharacters(next)
  // 忽略拆并后的块边界：旧文字仍按序完整保留时只计净新增，反向成立时只计净删除。
  // 这是保守的文字复用口径；跨段删写相同文字与搬运旧文字无法仅凭两个版本区分。
  if (nextCount > previousCount && isSubsequence(previous, next)) return { added: nextCount - previousCount, removed: 0 }
  if (previousCount > nextCount && isSubsequence(next, previous)) return { added: 0, removed: previousCount - nextCount }

  let added = 0
  let removed = 0
  for (const [id, previous] of old) {
    const counts = textCounts(previous, current.get(id) ?? '')
    added += counts.added
    removed += counts.removed
  }
  for (const [id, next] of current) if (!old.has(id)) added += countCharacters(next)
  if (previous.length + next.length > MAX_COMBINED_DIFF_LENGTH) return { added, removed }

  // 拆并伴随替换时取两种差异估算中较小的一组；两者净增相同，避免扩大原有按块估算。
  // 超过合并比较上限，或拆并、移动、多处改写混合出现时，仍可能多计未改文字。
  const combined = textCounts(previous, next)
  return { added: Math.min(added, combined.added), removed: Math.min(removed, combined.removed) }
}

export function recordWritingActivity(db: Database.Database, chapterId: string, revisionId: string, now: string, source?: WritingDay['source']): void {
  if (Number(db.pragma('user_version', { simple: true })) < WORKBENCH_SCHEMA_VERSION) return
  const row = db.prepare(`SELECT r.document_json, r.reason, p.document_json AS previous_json FROM chapter_revisions r
    LEFT JOIN chapter_revisions p ON p.id = r.parent_revision_id AND p.chapter_id = r.chapter_id
    WHERE r.id = ? AND r.chapter_id = ?`).get(revisionId, chapterId) as { document_json: string; previous_json: string | null; reason: string } | undefined
  if (!row) return
  const origin = source ?? (row.reason === 'imported' ? 'import' : row.reason === 'restored' ? 'restore' : 'manual')
  const counts = changedCounts(row.previous_json ? parseManuscript(JSON.parse(row.previous_json)) : null, parseManuscript(JSON.parse(row.document_json)))
  db.prepare(`INSERT INTO writing_activity (id, revision_id, chapter_id, date, source, added, removed, minutes, revised, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`).run(randomUUID(), revisionId, chapterId, localWritingDate(new Date(now)), origin, counts.added, counts.removed, now)
}
