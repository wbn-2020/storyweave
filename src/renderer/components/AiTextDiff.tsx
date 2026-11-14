import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AI_OUTPUT_LIMIT } from '../../contracts/ai'
import { applyAiTextHunks, compareAiText, type AiTextComparison, type AiTextHunk } from '../../contracts/ai-text-diff'
import styles from './StellarTextDiff.module.css'

export interface AiTextDiffProps {
  originalText: string
  suggestedText: string
  disabled: boolean
  /** 返回完整选区的合并文本；调用方继续负责 AI 采用的版本校验及保存。 */
  onAcceptText: (text: string) => void | Promise<void>
}

interface Review {
  basis: AiTextComparison | null
  selected: number[]
  page: number
  error: string | null
  accepted: boolean
}
const PAGE_SIZE = 12
function emptyReview(basis: AiTextComparison | null): Review { return { basis, selected: [], page: 0, error: null, accepted: false } }
function kind(hunk: AiTextHunk): string { return !hunk.originalText ? '新增' : !hunk.suggestedText ? '删除' : '替换' }
function TextSide({ title, text, empty }: { title: string; text: string; empty: string }) {
  return <div><h4>{title}</h4>{text ? <>
    {!text.trim() && <p className={styles.hint}>此处仅有空白或换行（{text.length} 字符）。</p>}
    <pre className={styles.text}>{text}</pre>
  </> : <p className={styles.hint}>{empty}</p>}</div>
}

export function AiTextDiff({ originalText, suggestedText, disabled, onAcceptText }: AiTextDiffProps) {
  const headingId = useId()
  const comparison = useMemo(() => {
    try { return { value: compareAiText(originalText, suggestedText), error: null } }
    catch (caught) { return { value: null, error: caught instanceof Error ? caught.message : '暂时无法比较这两份文本，请保留原稿并缩小范围。' } }
  }, [originalText, suggestedText])
  const diff = comparison.value
  const [review, setReview] = useState<Review>(() => emptyReview(diff))
  const [submitting, setSubmitting] = useState(false)
  const mounted = useRef(true)
  const submitLock = useRef(false)
  const currentBasis = useRef(diff)
  currentBasis.current = diff
  // 首次收到新基线的渲染就失效旧选择；不能等待 effect 才阻止沿用旧 hunk 下标。
  const active = review.basis === diff ? review : emptyReview(diff)
  const merged = useMemo(() => {
    try { return { text: diff ? applyAiTextHunks(diff, active.selected) : originalText, error: null } }
    catch (caught) { return { text: originalText, error: caught instanceof Error ? caught.message : '合并未完成，原文仍保留。' } }
  }, [diff, active.selected, originalText])
  const blocked = disabled || submitting
  const limitError = !merged.text.trim() ? '合并结果为空，不能作为 AI 采用内容。请保留至少一段正文。'
    : merged.text.length > AI_OUTPUT_LIMIT ? `合并结果超过 ${AI_OUTPUT_LIMIT.toLocaleString()} 字符，请调整选择或缩小改写范围。`
      : merged.text.includes('\0') ? '合并结果包含空字符，不能采用。' : null
  const canAccept = Boolean(diff && active.selected.length && !merged.error && !limitError && merged.text !== originalText && !blocked)

  useEffect(() => { setReview(emptyReview(diff)) }, [diff])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  function update(patch: Partial<Review>) { setReview({ ...active, ...patch, basis: diff }) }
  function toggle(id: number) {
    if (blocked) return
    update({ selected: active.selected.includes(id) ? active.selected.filter((value) => value !== id) : [...active.selected, id], error: null, accepted: false })
  }
  async function accept() {
    if (!canAccept || submitLock.current || !diff) return
    submitLock.current = true; setSubmitting(true); update({ error: null, accepted: false })
    const basis = diff
    try {
      await onAcceptText(merged.text)
      if (mounted.current && currentBasis.current === basis) setReview((value) => value.basis === basis ? { ...value, accepted: true } : value)
    } catch (caught) {
      if (mounted.current && currentBasis.current === basis) setReview((value) => value.basis === basis
        ? { ...value, error: caught instanceof Error ? caught.message : '未能采用所选差异；选择和原文仍保留。' } : value)
    } finally {
      submitLock.current = false
      if (mounted.current) setSubmitting(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil((diff?.hunks.length ?? 0) / PAGE_SIZE))
  const page = Math.min(active.page, pageCount - 1)
  const visible = diff?.hunks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? []
  return <section className={styles.panel} aria-labelledby={headingId} aria-busy={submitting}>
    <header className={styles.heading}><h3 id={headingId}>逐段选择改写</h3><span>{diff ? `${diff.hunks.length} 处差异` : ''}</span></header>
    <p className={styles.hint}>勾选要采用的差异，未勾选处保留原文。连续增删或拆并段落会合为一组，请先检查完整合并预览。</p>
    {comparison.error && <p className={styles.notice} role="alert">{comparison.error}</p>}
    {diff && !diff.hunks.length && <p className={styles.hint}>建议与原文相同，无需采用。</p>}
    {diff && diff.hunks.length > 0 && <>
      {diff.hunks.some((hunk) => hunk.coarse) && <p className={styles.notice}>部分区间过长或重复过多，已按整块展示；勾选该区间会采用其中全部变化。</p>}
      <div className={styles.actions}>
        <button type="button" disabled={blocked || active.selected.length === diff.hunks.length} onClick={() => update({ selected: diff.hunks.map((hunk) => hunk.id), error: null, accepted: false })}>全选差异</button>
        <button type="button" disabled={blocked || !active.selected.length} onClick={() => update({ selected: [], error: null, accepted: false })}>清空选择</button>
        <span role="status">已选 {active.selected.length} / {diff.hunks.length} 处</span>
      </div>
      {visible.map((hunk) => <article className={styles.hunk} key={hunk.id} data-kind={!hunk.originalText ? 'added' : !hunk.suggestedText ? 'removed' : 'changed'}>
        <label className={styles.choice}><input type="checkbox" checked={active.selected.includes(hunk.id)} disabled={blocked} onChange={() => toggle(hunk.id)} />
          <span>差异 {hunk.id + 1} · {kind(hunk)}{hunk.coarse ? ' · 整块选择' : ''}</span>
        </label>
        <div className={styles.columns}>
          <TextSide title="原文 · 未选择时保留" text={hunk.originalText} empty="此位置没有原文段落。" />
          <TextSide title="建议 · 选择后采用" text={hunk.suggestedText} empty="采用此项会删除左侧原文。" />
        </div>
      </article>)}
      {pageCount > 1 && <nav className={styles.actions} aria-label="文本差异分页">
        <button type="button" disabled={blocked || page === 0} onClick={() => update({ page: page - 1 })}>上一页</button><span>{page + 1} / {pageCount}</span>
        <button type="button" disabled={blocked || page + 1 >= pageCount} onClick={() => update({ page: page + 1 })}>下一页</button>
      </nav>}
      <details className={styles.preview}><summary>完整合并预览 · {merged.text.length.toLocaleString()} 字符</summary>
        <pre className={styles.text}>{merged.text || '（合并结果为空）'}</pre>
      </details>
      {(active.error || merged.error || (active.selected.length > 0 && limitError)) && <p className={styles.notice} role="alert">{active.error || merged.error || limitError}</p>}
      {active.accepted && <p className={styles.hint} role="status">完整合并文本已交回 AI 审阅流程。</p>}
      <div className={styles.actions}><button className={styles.primary} type="button" aria-busy={submitting} disabled={!canAccept} onClick={() => void accept()}>{submitting ? '正在采用…' : '采用所选差异'}</button>
        <span>将返回完整选区文本，包含所有保留段落。</span>
      </div>
    </>}
  </section>
}
