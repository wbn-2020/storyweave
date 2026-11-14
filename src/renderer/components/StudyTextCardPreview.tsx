import type { CreativeResource } from '../../contracts/creative-resources'
import { readStudyTextCard, validateStudyTextSource } from '../../contracts/study-text-card'
import ui from './stellar/Workspace.module.css'
import styles from './StellarStudy.module.css'

export function StudyTextCardPreview({ kind, body, reference }: {
  kind: string; body: string; reference?: CreativeResource
}) {
  try {
    const card = readStudyTextCard(kind, body, true)
    if (!card) return <p tabIndex={0}>{body}</p>
    if (reference) validateStudyTextSource(card, reference.text)
    return <div className={styles.textPreview} data-format={card.format}>
      {card.format === 'study-formula'
        ? card.stages.length ? <ol className={styles.formulaStages} aria-label="抽象技法阶段">{card.stages.map((stage, index) =>
          <li key={index}><span>{stage || '待填写'}</span>{index < card.stages.length - 1 && <b aria-hidden="true">+</b>}</li>)}</ol>
          : <p className={ui.muted}>本卡未提供技法阶段。</p>
        : !reference ? <p className={ui.muted}>固定来源缺失，词汇无法核对。</p>
          : card.words.length ? <>
            <ul className={styles.vocabularyTags} aria-label="同一固定参考中的模型词汇候选">{card.words.map((entry) =>
              <li key={entry.word} title={`固定引文：${entry.quote}`} aria-label={`${entry.word}，固定引文：${entry.quote}`}>{entry.word}</li>)}</ul>
            <p className={styles.previewNotice}>模型词汇候选</p>
          </> : <p className={ui.muted}>本卡未提供可核对的词汇候选。</p>}
      <p tabIndex={0}>{card.analysis || '尚未提供分析'}</p>
    </div>
  } catch { return <p className={ui.warning}>卡片格式或词汇来源需要核对，完整内容保留在审阅详情。</p> }
}
