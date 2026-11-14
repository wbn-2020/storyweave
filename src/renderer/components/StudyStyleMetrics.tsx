import { useMemo } from 'react'
import type { CreativeResource } from '../../contracts/creative-resources'
import type { StyleCard } from '../../contracts/study-card'
import { measureStudyStyle } from '../study-style-metrics'
import styles from './StudyStyleMetrics.module.css'

export function StudyStyleMetrics({ source, facts }: {
  source: CreativeResource | undefined
  facts: Pick<StyleCard, 'rhythm' | 'dialogue' | 'senses' | 'diction'>
}) {
  const measurement = useMemo(() => source ? measureStudyStyle(source.text) : null, [source?.text])
  const maximum = Math.max(1, ...(measurement?.bins.map((bin) => bin.count) ?? []))
  const quoteShare = measurement && measurement.textCharacters > 0 && measurement.quotedCharacters !== null
    ? measurement.quotedCharacters / measurement.textCharacters : null
  const distributionLabel = measurement?.sentences
    ? `句长分布，共 ${measurement.sentences} 句。${measurement.bins.map((bin) => `${bin.label} 字：${bin.count} 句`).join('；')}`
    : '当前固定参考没有可统计的句子。'
  const quoteUnavailable = !measurement ? '固定参考统计暂不可用'
    : measurement.quotedCharacters === null ? '引号未配对，比例未知' : '没有可统计的字符'
  const quoteLabel = quoteShare === null ? quoteUnavailable
    : `成对引号内 ${measurement!.quotedCharacters} 字符，占 ${measurement!.textCharacters} 个非空白、非引号字符的 ${(quoteShare * 100).toFixed(1)}%。此比例不等同人物对白比例。`

  return <div className={styles.metrics}>
    <div className={styles.grid}>
      <div className={styles.distribution}><figure>
        {measurement?.sentences ? <svg className={styles.histogram} viewBox="0 0 240 132" role="img" aria-label={distributionLabel}>
          <line className={styles.gridline} x1="42" y1="17" x2="235" y2="17" />
          <line className={styles.axis} x1="42" y1="100" x2="235" y2="100" />
          <text className={styles.tick} x="37" y="20" textAnchor="end">{maximum}</text>
          <text className={styles.tick} x="37" y="103" textAnchor="end">0</text>
          {measurement.bins.map((bin, index) => {
            const height = bin.count / maximum * 72, x = 48 + index * 37
            return <g key={bin.label}>
              <rect className={styles.bar} x={x} y={100 - height} width="27" height={height}><title>{bin.label} 字：{bin.count} 句</title></rect>
              <text className={styles.value} x={x + 13.5} y={94 - height} textAnchor="middle">{bin.count}</text>
              <text className={styles.tick} x={x + 13.5} y="118" textAnchor="middle">{bin.label}</text>
            </g>
          })}
        </svg> : <p className={styles.unavailable}>{measurement ? '没有可统计的句子' : '固定参考统计暂不可用'}</p>}
        <figcaption>句长分布<small>每句字符数 · {measurement?.sentences ?? '—'} 句</small></figcaption>
        </figure>
        <dl className={styles.facts}><dt>句式节奏</dt><dd tabIndex={0}>{facts.rhythm || '尚未提供'}</dd></dl>
      </div>
      <div className={styles.dialogue}><figure>
        <svg className={styles.ring} viewBox="0 0 120 120" role="img" aria-label={quoteLabel}>
          <circle className={quoteShare === null ? styles.unknownRing : styles.ringBase} cx="60" cy="60" r="44" pathLength="100" />
          {quoteShare !== null && <circle className={styles.ringValue} cx="60" cy="60" r="44" pathLength="100"
            strokeDasharray={`${quoteShare * 100} ${100 - quoteShare * 100}`} transform="rotate(-90 60 60)" />}
          <text className={styles.ringText} x="60" y="65" textAnchor="middle" aria-hidden="true">{quoteShare === null ? '—' : `${(quoteShare * 100).toFixed(1)}%`}</text>
        </svg>
        <figcaption>对白占比<small>按成对引号覆盖统计</small></figcaption>
        </figure>
        {quoteShare === null ? <p className={styles.note}>{quoteUnavailable}</p>
          : <p className={styles.legend}><span><i />引号内</span><span><i />引号外</span></p>}
        <dl className={styles.facts}><dt>对白组织</dt><dd tabIndex={0}>{facts.dialogue || '尚未提供'}</dd></dl>
      </div>
      <dl className={`${styles.facts} ${styles.qualitative}`}>
        <div><dt>感官偏好</dt><dd tabIndex={0}>{facts.senses || '尚未提供'}</dd></div>
        <div><dt>措辞与动词</dt><dd tabIndex={0}>{facts.diction || '尚未提供'}</dd></div>
      </dl>
    </div>
    <details className={styles.method}>
      <summary>统计口径 · {source ? `${source.title} · v${source.revision}` : '固定来源缺失'}</summary>
      <p>仅统计此卡对应的固定参考片段全文，不代表整部作品或作者风格。句长使用中文原生分句，按非空白 Unicode 字符计数，包含标点与引号；纯标点片段不计句数。</p>
      <p>占比分母排除空白及配对用引号，保留其他标点。识别中文双引号、直角引号及未转义的英文双引号；嵌套内容只计一次。引号不完整时不显示比例，引文也可能不是人物对白。感官与措辞保留模型分析文字。</p>
    </details>
  </div>
}
