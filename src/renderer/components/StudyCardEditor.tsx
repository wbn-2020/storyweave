import { readStudyCard, type StudyCardKind } from '../../contracts/study-card'
import { readStudyTextCard, type StudyTextCardKind } from '../../contracts/study-text-card'
import ui from './stellar/Workspace.module.css'

export function StudyCardEditor({ kind, body, disabled = false, onChange }: {
  kind: StudyCardKind; body: string; disabled?: boolean; onChange: (body: string) => void
}) {
  let card: ReturnType<typeof readStudyCard>
  try { card = readStudyCard(kind, body, true) } catch {
    return <label>卡片内容需要修正<textarea rows={8} value={body} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><span className={ui.warning}>格式无法识别，原内容已保留。请先修正，再保存。</span></label>
  }
  const change = (patch: Partial<typeof card>) => onChange(JSON.stringify({ ...card, ...patch }))
  return <div className={ui.fields}>
    <label>分析<textarea value={card.analysis} maxLength={8000} rows={3} disabled={disabled} onChange={(event) => change({ analysis: event.target.value })} /></label>
    <label>适用场景<textarea value={card.application} maxLength={2000} rows={2} disabled={disabled} onChange={(event) => change({ application: event.target.value })} /></label>
    <label>复用限制<textarea value={card.limits} maxLength={2000} rows={2} disabled={disabled} onChange={(event) => change({ limits: event.target.value })} /></label>
    {'beats' in card ? <>
      {card.beats.map((beat, index) => <fieldset key={index} disabled={disabled} className={ui.panel}><legend>节拍 {index + 1}</legend>
        {([['title', '名称', 120], ['action', '抽象行动', 2000], ['outcome', '叙事变化', 2000]] as const).map(([key, label, maximum]) => <label key={key}>{label}<textarea rows={key === 'title' ? 1 : 2} value={beat[key]} maxLength={maximum} onChange={(event) => {
          if ('beats' in card) change({ beats: card.beats.map((item, at) => at === index ? { ...item, [key]: event.target.value } : item) })
        }} /></label>)}
        <button className={ui.button} type="button" disabled={disabled || card.beats.length <= 1} onClick={() => { if ('beats' in card) change({ beats: card.beats.filter((_, at) => at !== index) }) }}>移除此节拍</button>
      </fieldset>)}
      <button className={ui.button} type="button" disabled={disabled || card.beats.length >= 6} onClick={() => { if ('beats' in card) change({ beats: [...card.beats, { title: `节拍 ${card.beats.length + 1}`, action: '', outcome: '' }] }) }}>添加节拍</button>
    </> : ([['rhythm', '句式与节奏'], ['dialogue', '对白组织'], ['senses', '感官偏好'], ['diction', '措辞与动词']] as const).map(([key, label]) => <label key={key}>{label}<textarea value={card[key]} maxLength={4000} rows={3} disabled={disabled} onChange={(event) => change({ [key]: event.target.value })} /></label>)}
    <p className={ui.muted}>只复用结构与表达方法，人物、地点和情节由当前作品重新创作。</p>
  </div>
}

export function StudyTextCardEditor({ kind, body, disabled = false, onChange }: {
  kind: StudyTextCardKind; body: string; disabled?: boolean; onChange: (body: string) => void
}) {
  let parsed: ReturnType<typeof readStudyTextCard>
  try { parsed = readStudyTextCard(kind, body, true) } catch { parsed = null }
  if (!parsed) return <label>卡片内容需要修正<textarea rows={8} value={body} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><span className={ui.warning}>格式无法识别，原内容已保留。请先修正，再保存。</span></label>
  const card = parsed
  const change = (patch: Partial<typeof card>) => onChange(JSON.stringify({ ...card, ...patch }))
  return <div className={ui.fields}>
    {([['analysis', '分析', 8000], ['application', '适用场景', 2000], ['limits', '复用限制', 2000]] as const).map(([key, label, maximum]) =>
      <label key={key}>{label}<textarea value={card[key]} maxLength={maximum} rows={key === 'analysis' ? 3 : 2} disabled={disabled} onChange={(event) => change({ [key]: event.target.value })} /></label>)}
    {card.format === 'study-formula' ? <>
      {card.stages.map((stage, index) => <div className={ui.fieldGrid} key={index}>
        <label>阶段 {index + 1}<input value={stage} maxLength={40} disabled={disabled} onChange={(event) => change({ stages: card.stages.map((item, at) => at === index ? event.target.value : item) })} /></label>
        <button className={ui.button} type="button" disabled={disabled} onClick={() => change({ stages: card.stages.filter((_, at) => at !== index) })}>移除此阶段</button>
      </div>)}
      <button className={ui.button} type="button" disabled={disabled || card.stages.length >= 4} onClick={() => change({ stages: [...card.stages, ''] })}>添加阶段</button>
    </> : <details className={ui.details}><summary>固定词汇证据 · {card.words.length} 项</summary>
      {card.words.length ? <ul>{card.words.map((entry) => <li key={entry.word}><strong>{entry.word}</strong><blockquote>{entry.quote}</blockquote></li>)}</ul> : <p className={ui.muted}>本卡未提供可核对的词汇候选。</p>}
    </details>}
    <p className={ui.muted}>只复用分析与抽象阶段；词汇及引文保留用于来源核对，不附带到写作内容。</p>
  </div>
}
