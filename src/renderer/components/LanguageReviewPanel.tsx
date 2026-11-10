import { useState } from 'react'
import type { ChapterSnapshot } from '../../contracts/api'
import styles from './WorkbenchPanel.module.css'

export interface LanguageFinding { id: string; blockId: string; quote: string; category: string; reason: string }
const PHRASES = ['嘴角勾起一抹弧度', '嘴角微微勾起', '眼中闪过一丝精芒', '眼中精芒', '倒吸一口凉气', '如遭雷击', '心中涌起无尽', '不禁倒吸', '一抹玩味的笑容']
function scan(chapter: ChapterSnapshot): { items: LanguageFinding[]; total: number; blocks: number } {
  const items: LanguageFinding[] = []
  let total = 0, blocks = 0
  for (const block of chapter.document.content) {
    if (block.type === 'horizontalRule') continue
    const text = (block.content ?? []).map((node) => node.type === 'text' ? node.text : '\n').join('')
    if (!text.trim()) continue
    blocks++
    for (const phrase of PHRASES) {
      let offset = 0
      while ((offset = text.indexOf(phrase, offset)) >= 0) {
        total++
        if (items.length < 120) items.push({ id: `${block.attrs.id}:${offset}`, blockId: block.attrs.id, quote: phrase, category: '词表命中',
          reason: `本段包含“${phrase}”。它可能是刻意用语，需结合语境判断是否改为更具体的动作或感官细节。` })
        offset += phrase.length
      }
    }
    const sentences = text.split(/[。！？!?]/).map((sentence) => sentence.trim()).filter(Boolean)
    let prefix = '', streak = 0, reported = false
    for (const sentence of sentences) {
      const subject = /^(他们|她们|众人|他|她|它|我|你)/.exec(sentence)?.[1] ?? ''
      streak = subject && subject === prefix ? streak + 1 : subject ? 1 : 0
      prefix = subject
      if (streak === 3 && !reported) {
        total++; reported = true
        if (items.length < 120) items.push({ id: `${block.attrs.id}:repeated`, blockId: block.attrs.id, quote: text.length <= 2000 ? text : sentence.slice(0, 2000), category: '连续相同句首',
          reason: `本段至少三个连续句子以“${subject}”起笔。可检查节奏是否单一；这只是句式提示，不判断来源、质量或作者身份。` })
      }
    }
  }
  return { items, total, blocks }
}

export function LanguageReviewPanel({ chapter, disabled, onRegister, onReview }: {
  chapter: ChapterSnapshot | null; disabled: boolean; onRegister: (finding: LanguageFinding) => void; onReview?: (instruction: string) => void
}) {
  const [result, setResult] = useState<{ revisionId: string; chapterId: string; data: ReturnType<typeof scan> } | null>(null)
  const current = Boolean(chapter && result?.chapterId === chapter.id && result.revisionId === chapter.revisionId)
  return <section className={styles.detectorSection} aria-label="语言与句式提示">
    <div className={styles.heading}><div><h4>语言与句式提示</h4><p className={styles.muted}>读取当前已保存稿件，扫描固定套话词表及连续相同句首。命中只供作者判断。</p></div>
      <button className={styles.primaryButton} type="button" disabled={disabled || !chapter} onClick={() => { if (chapter) setResult({ revisionId: chapter.revisionId, chapterId: chapter.id, data: scan(chapter) }) }}>扫描当前章</button></div>
    {!chapter && <p className={styles.empty}>先打开并保存一章，再扫描实际正文。</p>}
    {chapter && !result && <p className={styles.empty}>《{chapter.title}》尚未扫描，点击上方按钮开始。</p>}
    {result && !current && <p className={styles.warning}>章节或正文版本已变化，请重新扫描。旧结果不会登记到新稿。</p>}
    {current && result && <><p className={styles.muted}>已扫描 {result.data.blocks} 个非空段落，命中 {result.data.total} 处；当前列出 {result.data.items.length} 处。无命中也不代表语言没有问题。</p>
      {result.data.items.map((item) => <article className={styles.panel} key={item.id}><h4>{item.category}</h4><blockquote><mark>{item.quote}</mark></blockquote><p>{item.reason}</p><p className={styles.identity}>段落 {item.blockId}</p>
        <button type="button" className={styles.button} disabled={disabled} onClick={() => onRegister(item)}>登记为待判断问题</button></article>)}
      {onReview && <button className={styles.primaryButton} type="button" disabled={disabled || !result.data.total} onClick={() => onReview('仅审阅本章的语言与对白。结合套话与重复句首检查具体语境，选择确有必要的段落提出建议，保留逐字引文与可能的反证，给出可替换完整目标段落的改写稿。不要评分，不要声称识别出AI来源。')}>准备逐段润色提案</button>}
    </>}
  </section>
}

const READERS = [
  { name: '爽点与节奏', lens: 'pace', focus: '关注人物行动、压抑与释放、信息密度、章末悬念；说明具体何处影响继续阅读。' },
  { name: '设定与因果', lens: 'logic', focus: '核对本次实际提供的行动前提、资源代价和因果。没有前文资料时明确未知，不推断全书矛盾。' },
  { name: '情绪与人物互动', lens: 'emotion', focus: '关注互动中的目标、情绪转变、潜台词及人物选择，给出具体段落与可能的另一种理解。' },
] as const

export function ReaderReviewPanel({ chapter, disabled, onReview }: { chapter: ChapterSnapshot | null; disabled: boolean; onReview?: (instruction: string) => void }) {
  return <section className={styles.readersSection} aria-label="虚拟读者试读"><h4>选择一个试读角度</h4><p className={styles.muted}>模型只阅读发送预览中选入的内容。意见是模拟建议，不能代表真实读者或留存数据。</p>
    {!chapter && <p className={styles.empty}>先打开并保存需要试读的章节。</p>}
    {READERS.map((reader) => <article key={reader.lens} className={styles.panel}><h4>{reader.name}</h4><p>{reader.focus}</p><button type="button" className={styles.primaryButton} disabled={disabled || !chapter || !onReview} onClick={() => onReview?.(`以${reader.name}虚拟读者角度试读本章，所有建议使用lens=${reader.lens}。${reader.focus}只提出有逐字段落证据的问题，允许没有问题；给出反证、修改方向和必要时的段落替换稿，不输出评分或真实读者结论。`)}>准备这个角度的试读</button></article>)}
  </section>
}
