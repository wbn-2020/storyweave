import type Database from 'better-sqlite3'

export function* storedRunIds(db: Database.Database, table: 'living_runs' | 'forge_runs'): Generator<string> {
  const query = db.prepare(`SELECT run_id FROM ${table} WHERE run_id > ? ORDER BY run_id LIMIT 128`)
  let after = ''
  while (true) {
    // 先结束编号查询，再读取含格式校验的历史；活动迭代器期间不能调用 better-sqlite3 的 pragma。
    const rows = query.all(after) as { run_id: string }[]
    for (const row of rows) yield row.run_id
    if (rows.length < 128) return
    after = rows.at(-1)!.run_id
  }
}
