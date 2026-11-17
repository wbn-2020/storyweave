import { useMemo } from 'react'
import type { CreativeResource } from '../../contracts/creative-resources'
import type { StyleCard } from '../../contracts/study-card'
import { measureStudyStyle, measureStudyStyleAnnotations } from '../study-style-metrics'
import { STUDY_SENSE_LABELS } from '../../contracts/study-card'
import styles from './StudyStyleMetrics.module.css'

export function StudyStyleMetrics({ source, facts, compact = false }: {
  source: CreativeResource | undefined
  facts: StyleCard
  compact?: boolean
}) {
  const measurement = useMemo(() => source ? measureStudyStyle(source.text) : null, [source?.text])
  const annotations = useMemo(() => source ? measureStudyStyleAnnotations(source.text, facts) : null, [source?.text, facts])
  const curve = useMemo(() => {
    if (!measurement?.sentences) return null
    const counts = new Map(measurement.lengthCounts.map((entry) => [entry.length, entry.count]))
    const maximumLength = measurement.lengthCounts.at(-1)!.length
    const maximumCount = Math.max(...counts.values())
    const positions = new Set([0, maximumLength])
    // 给每个实际句长补相邻的零频次位置，避免跨过未出现的句长画出虚构分布，也不创建五万个空点。
    for (const length of counts.keys()) {
      positions.add(length)
      if (length > 0) positions.add(length - 1)
      if (length < maximumLength) positions.add(length + 1)
    }
    const points = [...positions].sort((a, b) => a - b).map((length) =>
      `${42 + length / maximumLength * 193},${60 - (counts.get(length) ?? 0) / maximumCount * 48}`).join(' ')
    return { maximumLength, maximumCount, points,
      label: `按句长逐字统计频次，横轴为每句字符数，纵轴为句数。${measurement.lengthCounts.map((entry) => `${entry.length} 字：${entry.count} 句`).join('；')}。其余句长为零句。` }
  }, [measurement])
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
  const annotationUnavailable = !source ? '固定来源缺失，标注未知' : facts.version === 1 ? '旧卡未提供结构化标注' : !annotations ? '标注来源无法核对' : '未提供标注'
  const sensoryLabel = annotations?.total
    ? `感官标注分布，共 ${annotations.total} 条。${annotations.senses.map((entry) => `${entry.label} ${entry.count} 条`).join('；')}。归类为模型判断，不代表全文真实感官比例。`
    : annotationUnavailable

  return <div className={styles.metrics} data-compact={compact}>
    <div className={styles.grid}>
      <div className={styles.distribution}><figure>
        {curve && <svg className={styles.curve} viewBox="0 0 240 84" role="img" aria-label={curve.label}>
          <line className={styles.gridline} x1="42" y1="12" x2="235" y2="12" />
          <line className={styles.axis} x1="42" y1="60" x2="235" y2="60" />
          <polygon className={styles.curveArea} points={`42,60 ${curve.points} 235,60`} />
          <polyline className={styles.curveLine} points={curve.points} />
          <text className={styles.tick} x="37" y="15" textAnchor="end">{curve.maximumCount}</text>
          <text className={styles.tick} x="37" y="63" textAnchor="end">0</text>
          <text className={styles.tick} x="42" y="78" textAnchor="middle">0</text>
          <text className={styles.tick} x="235" y="78" textAnchor="end">{curve.maximumLength} 字</text>
        </svg>}
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
        <div><dt>感官偏好</dt><dd className={styles.visualFacts}>
          {annotations?.total ? <>
            <svg className={styles.sensoryBar} viewBox="0 0 240 20" role="img" aria-label={sensoryLabel}>
              {annotations.senses.map((entry, index) => {
                const start = annotations.senses.slice(0, index).reduce((sum, item) => sum + item.count, 0)
                return <rect className={styles.sense} data-sense={entry.sense} key={entry.sense}
                  x={start / annotations.total * 240} y="2" width={entry.count / annotations.total * 240 - 2} height="16" rx="3">
                  <title>{entry.label}：{entry.count} 条标注</title>
                </rect>
              })}
            </svg>
            <ul className={styles.senseLegend} aria-label="感官标注数量">{annotations.senses.map((entry) =>
              <li key={entry.sense}><i className={styles.sense} data-sense={entry.sense} aria-hidden="true" />{entry.label} {entry.count}</li>)}</ul>
            <p className={styles.annotationNote} data-summary>模型标注 · {annotations.total} 条</p>
          </> : <p className={styles.annotationNote}>{annotationUnavailable}</p>}
          <p className={styles.analysisText} tabIndex={0}>{facts.senses || '尚未提供感官分析'}</p>
        </dd></div>
        <div><dt>高频动词</dt><dd className={styles.visualFacts}>
          {annotations?.verbs.length ? <>
            <ul className={styles.verbTags} aria-label="模型动词候选，按固定原文字面次数排序">{annotations.verbs.map((entry) =>
              <li key={entry.word} title={`${entry.word}：固定原文字面出现 ${entry.count} 次，词性为模型判断`}
                aria-label={`${entry.word}，固定原文字面出现 ${entry.count} 次，模型动词候选`}>{entry.word}</li>)}</ul>
            <p className={styles.annotationNote} data-summary>模型动词候选</p>
          </> : <p className={styles.annotationNote}>{annotationUnavailable === '未提供标注' ? '未提供动词候选' : annotationUnavailable}</p>}
          <p className={styles.analysisText} tabIndex={0}>{facts.diction || '尚未提供措辞分析'}</p>
        </dd></div>
      </dl>
    </div>
    <details className={styles.method}>
      <summary>统计口径 · {source ? `${source.title} · v${source.revision}` : '固定来源缺失'}</summary>
      <p>仅统计此卡对应的固定参考片段全文，不代表整部作品或作者风格。句长使用中文原生分句，按非空白 Unicode 字符计数，包含标点与引号；纯标点片段不计句数。</p>
      <p>上方曲线按每个实际句长统计句数，未出现的句长记零；下方柱图按五档汇总，两图使用同一份原文。折线连接实际计数，不是概率密度或多个来源的对比。</p>
      <p>占比分母排除空白及配对用引号，保留其他标点。识别中文双引号、直角引号及未转义的英文双引号；嵌套内容只计一次。引号不完整时不显示比例，引文也可能不是人物对白。</p>
      <p>感官条仅按模型提供且逐字核对的标注计数；同一短语可跨感官分类，各算一条，不代表全文真实感官比例。动词由模型提出，只在本卡固定参考全文统计不重叠的字面次数；子词、同形词也可能命中，不代表完整分词或每次均为动词。未标注不代表不存在。</p>
      {annotations && facts.version === 2 && <ul className={styles.evidence}>
        {facts.annotations.senses.map((entry) => <li key={`${entry.sense}:${entry.quote}`}><strong>{STUDY_SENSE_LABELS[entry.sense]}</strong><q>{entry.quote}</q></li>)}
        {facts.annotations.verbs.map((entry) => <li key={entry.word}><strong>动词候选：{entry.word}</strong><q>{entry.quote}</q></li>)}
      </ul>}
    </details>
  </div>
}
