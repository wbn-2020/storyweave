import { useState } from 'react'
import type { BookSnapshot } from '../../contracts/api'
import { MAX_NOTE_CHAPTERS, parseNoteChapterIds } from '../../contracts/notes'
import styles from './StellarInspiration.module.css'
import ui from './stellar/Workspace.module.css'

const PAGE_SIZE = 30

export function NoteChapterPicker({ book, value, disabled, onChange }: {
  book: BookSnapshot; value: string[]; disabled: boolean; onChange: (ids: string[]) => void
}) {
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const query = search.trim().toLocaleLowerCase()
  const chapters = book.chapters.filter((chapter) => !query || chapter.title.toLocaleLowerCase().includes(query))
  const page = chapters.slice(offset, offset + PAGE_SIZE)
  const missing = value.filter((id) => !book.chapters.some((chapter) => chapter.id === id))

  return <div className={styles.chapterPicker}>
    <label>查找章节<input type="search" value={search} maxLength={120} disabled={disabled}
      onChange={(event) => { setSearch(event.target.value); setOffset(0) }} /></label>
    <p className={ui.muted}>已选 {value.length} / {MAX_NOTE_CHAPTERS} · 仅保存引用，不改写章节正文。</p>
    {!!value.length && <div className={styles.chapterSelections} aria-label="已选章节">
      {value.map((id) => <button className={ui.button} key={id} type="button" disabled={disabled}
        aria-label={`取消关联：${book.chapters.find((chapter) => chapter.id === id)?.title ?? '目录中不存在的章节'}`}
        onClick={() => onChange(value.filter((entry) => entry !== id))}>
        {book.chapters.find((chapter) => chapter.id === id)?.title ?? '章节已不在目录'} ×
      </button>)}
    </div>}
    {!!missing.length && <p className={ui.warning}>有已选章节不在当前目录中，请先取消该关联或重新读取目录。</p>}
    <ul className={styles.chapterOptions} aria-label="可关联章节">
      {page.map((chapter) => <li key={chapter.id}><label className={ui.check}>
        <input type="checkbox" checked={value.includes(chapter.id)}
          disabled={disabled || !value.includes(chapter.id) && value.length >= MAX_NOTE_CHAPTERS}
          onChange={(event) => onChange(parseNoteChapterIds(event.target.checked ? [...value, chapter.id] : value.filter((id) => id !== chapter.id)))} />
        <span>{chapter.title}</span>
      </label></li>)}
    </ul>
    {!chapters.length && <p className={ui.muted}>{book.chapters.length ? '没有匹配的章节。' : '这部作品还没有章节，请先新建章节。'}</p>}
    {chapters.length > PAGE_SIZE && <nav className={styles.chapterPaging} aria-label="关联章节分页">
      <button className={ui.button} type="button" disabled={disabled || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
      <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, chapters.length)} / {chapters.length}</span>
      <button className={ui.button} type="button" disabled={disabled || offset + PAGE_SIZE >= chapters.length} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</button>
    </nav>}
  </div>
}
