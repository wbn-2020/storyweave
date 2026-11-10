import { readStudyCard, type StudyCardKind } from '../../contracts/study-card'
import ui from './WorkbenchPanel.module.css'

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
