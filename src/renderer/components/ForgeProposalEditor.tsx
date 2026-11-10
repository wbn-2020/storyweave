import type { ForgeProposal } from '../../contracts/forge'
import { KNOWLEDGE_KINDS } from '../../contracts/knowledge'
import { CharacterProfileEditor } from './CharacterProfileEditor'
import { TimeEditor } from './StoryFieldsEditor'
import styles from './ForgePanel.module.css'

const kindLabels = { person: '人物', place: '地点', organization: '势力', object: '物品', rule: '规则与力量体系', theme: '主题', other: '其他' }
const natureLabels = { narrative_claim: '正文陈述', character_belief: '人物信念', ai_inference: '模型推断' }

export function ForgeProposalEditor({ proposal, selected, disabled, onChange, onSelect }: {
  proposal: Exclude<ForgeProposal, { kind: 'names' }>; selected: string[]; disabled: boolean
  onChange: (value: ForgeProposal) => void; onSelect: (key: string, checked: boolean) => void
}) {
  if (proposal.kind === 'relations') return <div className={styles.proposals}>{proposal.relations.map((item) => <article key={item.key} className={styles.card}>
    <label className={styles.check}><input type="checkbox" checked={selected.includes(item.key)} disabled={disabled} onChange={(event) => onSelect(item.key, event.target.checked)} />采用这条关系</label>
    <p className={styles.meta}>{item.fromEntityId} → {item.toEntityId}</p>
    <label>关系类型<input maxLength={120} value={item.relationType} disabled={disabled} onChange={(event) => onChange({ ...proposal, relations: proposal.relations.map((value) => value.key === item.key ? { ...value, relationType: event.target.value } : value) })} /></label>
    <div className={styles.columns}>
      <label>方向<select value={item.direction} disabled={disabled} onChange={(event) => onChange({ ...proposal, relations: proposal.relations.map((value) => value.key === item.key ? { ...value, direction: event.target.value as 'directed' | 'mutual' } : value) })}><option value="directed">单向</option><option value="mutual">双向</option></select></label>
      <label>关系层次<select value={item.layer} disabled={disabled} onChange={(event) => onChange({ ...proposal, relations: proposal.relations.map((value) => value.key === item.key ? { ...value, layer: event.target.value as 'surface' | 'hidden' } : value) })}><option value="surface">表面关系</option><option value="hidden">隐藏关系</option></select></label>
      <label>知识性质<select value={item.nature} disabled={disabled} onChange={(event) => onChange({ ...proposal, relations: proposal.relations.map((value) => value.key === item.key ? { ...value, nature: event.target.value as typeof item.nature } : value) })}>{Object.entries(natureLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    </div>
    <label>关系说明<textarea rows={4} value={item.description} maxLength={4000} disabled={disabled} onChange={(event) => onChange({ ...proposal, relations: proposal.relations.map((value) => value.key === item.key ? { ...value, description: event.target.value } : value) })} /></label>
    <TimeEditor label="关系生效时间" value={item.validFrom} disabled={disabled} onChange={(time) => onChange({ ...proposal, relations: proposal.relations.map((value) => value.key === item.key ? { ...value, validFrom: time } : value) })} />
    <TimeEditor label="关系结束时间（不含截止时点）" value={item.validUntil} disabled={disabled} onChange={(time) => onChange({ ...proposal, relations: proposal.relations.map((value) => value.key === item.key ? { ...value, validUntil: time } : value) })} />
    <details><summary>固定正文引文 · {item.citations.length}</summary>{item.citations.map((citation, index) => <blockquote key={index}>{citation.quote}<small>{citation.blockId}</small></blockquote>)}</details>
  </article>)}</div>
  return <div className={styles.proposals}>{proposal.cards.map((card) => <article key={card.key} className={styles.card}>
    <label className={styles.check}><input type="checkbox" checked={selected.includes(card.key)} disabled={disabled} onChange={(event) => onSelect(card.key, event.target.checked)} />采用这张卡片</label>
    {proposal.kind === 'world' && <label>卡片类型<select value={card.kind} disabled={disabled} onChange={(event) => onChange({ ...proposal, cards: proposal.cards.map((value) => value.key === card.key ? { ...value, kind: event.target.value as typeof card.kind } : value) })}>{KNOWLEDGE_KINDS.filter((kind) => kind !== 'person').map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label>}
    <label>名称<input value={card.name} maxLength={120} disabled={disabled || proposal.kind === 'fill' || proposal.kind === 'extract'} onChange={(event) => onChange({ ...proposal, cards: proposal.cards.map((value) => value.key === card.key ? { ...value, name: event.target.value } : value) })} /></label>
    <label>说明<textarea rows={4} value={card.summary} maxLength={8000} disabled={disabled} onChange={(event) => onChange({ ...proposal, cards: proposal.cards.map((value) => value.key === card.key ? { ...value, summary: event.target.value } : value) })} /></label>
    {card.kind === 'person' && <CharacterProfileEditor profile={card.profile} disabled={disabled} onChange={(profile) => onChange({ ...proposal, cards: proposal.cards.map((value) => value.key === card.key ? { ...value, profile } : value) })} />}
    {card.citations.length > 0 && <details><summary>固定正文引文 · {card.citations.length}</summary>{card.citations.map((citation, index) => <blockquote key={index}>{citation.quote}<small>{citation.blockId}</small></blockquote>)}</details>}
  </article>)}</div>
}
