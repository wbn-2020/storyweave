import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react'
import { StudioIcon } from './StudioIcon'
import styles from '../App.module.css'

export type DialogDisplayMode = 'modal' | 'canvas' | 'drawer'

export const DialogDisplayContext = createContext<DialogDisplayMode>('modal')

interface EditorialMeta {
  eyebrow: string
  line1: string
  line2: string
  lede: string
}

function matchEditorialMeta(title: string): EditorialMeta {
  if (title.includes('故事孵化')) {
    return { eyebrow: 'STORY SEED · 故事孵化', line1: '先接住，', line2: '一个想法。', lede: '从一句脑洞到第一章。AI 提出故事的可能，你决定哪些留下。' }
  }
  if (title.includes('规划') || title.includes('审稿')) {
    return { eyebrow: 'STRUCTURE · 大纲与审稿', line1: '故事不是一条线，', line2: '而是一张网。', lede: '在章节之间看见因果，在线索之间看见回声。先搭骨架，再让文字长出血肉。' }
  }
  if (title.includes('知识') || title.includes('设定')) {
    return { eyebrow: 'STORY BIBLE · 人物与世界设定', line1: '先有可信的人，', line2: '才有可信的故事。', lede: '人物动机、世界规则、地点与物品。每条设定都有出处，随故事自然生长。' }
  }
  if (title.includes('星海') || title.includes('关系')) {
    return { eyebrow: 'STORY GALAXY · 关系星图与画布', line1: '每个名字，', line2: '都有自己的引力。', lede: '人物、地点、线索和事件不是孤岛。拖动节点或切换画布，看看谁被谁牵动。' }
  }
  if (title.includes('时间线')) {
    return { eyebrow: 'CHRONOLOGY · 双轨故事时间线', line1: '让每件事，', line2: '发生在它的时刻。', lede: '分开梳理读者看到的章节叙述顺序与故事发生的真实先后，伏笔与回收一目了然。' }
  }
  if (title.includes('脉络') || title.includes('记录')) {
    return { eyebrow: 'THREADS & EVENTS · 事件与伏笔', line1: '埋下的线索，', line2: '都会有回声。', lede: '记录关键事件、关系变迁、伏笔回收窗口与人物在每个时点的知情状态。' }
  }
  if (title.includes('灵感') && title.includes('拆书')) {
    return { eyebrow: 'SKILL & STUDY · 拆书导入与技能库', line1: '把读过的好书，', line2: '留成会用的方法。', lede: '导入参考文本提炼场景观察、手法分析与方法卡，让经验随时参与下一章创作。' }
  }
  if (title.includes('笔记') || title.includes('素材')) {
    return { eyebrow: 'MARGIN NOTES · 余白与随手记', line1: '灵感，', line2: '暂时不必成为事实。', lede: '给一闪而过的念头、待用台词与分场碎片留一页纸，成熟后再升格为正式设定。' }
  }
  if (title.includes('日历')) {
    return { eyebrow: 'RITUAL & RHYTHM · 创作日历', line1: '让每一次落笔，', line2: '都有迹可循。', lede: '规划每日码字目标、截稿节点与灵感日常，在稳定的节奏里完成长篇。' }
  }
  if (title.includes('封面') || title.includes('立绘')) {
    return { eyebrow: 'GALLERY · 封面与人物立绘', line1: '每一个故事，', line2: '都有自己的面孔。', lede: '为作品设置专属书封，为重要角色绑定视觉立绘与神态特征。' }
  }
  if (title.includes('阅读')) {
    return { eyebrow: 'READER EDITION · 沉浸通读', line1: '退后一步，', line2: '像读者一样重逢。', lede: '切换工作稿或作者定稿，在纯净书页中审视全书节奏与行文呼吸。' }
  }
  return { eyebrow: 'STORYWEAVE · 记忆与审阅', line1: '把决定权，', line2: '留给作者。', lede: title }
}

interface Props {
  title: string
  children: ReactNode
  onClose: () => void
  busy?: boolean
  wide?: boolean
  error?: string | null
  className?: string
  inline?: boolean
}

export function Dialog({ title, children, onClose, busy = false, wide = false, error, className = '', inline = false }: Props) {
  const contextMode = useContext(DialogDisplayContext)
  const mode: DialogDisplayMode = inline ? 'canvas' : contextMode
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()

  useEffect(() => {
    if (mode !== 'modal') return
    const previousFocus = document.activeElement
    dialog.current?.showModal()
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus() }
  }, [mode])

  if (mode === 'drawer') {
    return <section className={`${styles.drawerDialogSurface} ${className}`} aria-labelledby={heading}>
      <header className={styles.drawerDialogHeader}>
        <div className={styles.canvasDialogTitleGroup}>
          <span className={styles.canvasDialogBadge}><span className={styles.eyebrowLine} />COPILOT · 边栏副驾驶</span>
          <h2 id={heading}>{title}</h2>
        </div>
        <button type="button" className={styles.canvasCloseButton} onClick={onClose} disabled={busy} aria-label="收起副驾驶面板">
          <span>收起</span>
        </button>
      </header>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      <div className={styles.drawerDialogBody}>{children}</div>
    </section>
  }

  if (mode === 'canvas') {
    const editorial = matchEditorialMeta(title)
    return <section className={`${styles.canvasDialogSurface} ${className}`} aria-labelledby={heading}>
      <header className={styles.canvasDialogHeader}>
        <div className={styles.canvasDialogTitleGroup}>
          <p className={styles.canvasDialogBadge}><span className={styles.eyebrowLine} />{editorial.eyebrow}</p>
          <h2 id={heading} className={styles.editorialDisplay}>
            {editorial.line1}<br /><em>{editorial.line2}</em>
          </h2>
          <p className={styles.editorialLede}>{editorial.lede}</p>
        </div>
        <div className={styles.canvasHeaderActions}>
          <button type="button" className={styles.canvasCloseButton} onClick={onClose} disabled={busy} aria-label="返回书桌或写作">
            <StudioIcon name="arrow" size={14} style={{ transform: 'rotate(180deg)' }} />
            <span>返回书桌</span>
          </button>
        </div>
      </header>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      <div className={styles.canvasDialogBody}>{children}</div>
    </section>
  }

  return <dialog ref={dialog} className={`${styles.inlineForm} ${wide ? styles.wideDialog : ''} ${styles.lightDialog} ${className}`} aria-labelledby={heading}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <div className={styles.formHeading}><h2 id={heading}>{title}</h2><button type="button" onClick={onClose} disabled={busy} aria-label="关闭">×</button></div>
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {children}
  </dialog>
}
