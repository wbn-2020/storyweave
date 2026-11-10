import { useId } from 'react'
import {
  CHARACTER_PROFILE_FIELDS, CHARACTER_PROFILE_LABELS, MAX_CHARACTER_PROFILE_FIELD_LENGTH,
  CHARACTER_ABILITIES, CHARACTER_ABILITY_LABELS,
  type CharacterProfile, type CharacterProfileField,
} from '../../contracts/character-profile'
import styles from './KnowledgePanel.module.css'

const hints: Record<CharacterProfileField, string> = {
  motivation: '什么原因推动人物行动？（如：找回失踪的妹妹 / 守护安全区）',
  desire: '眼下想得到什么，长远又渴望什么？',
  weakness: '哪些恐惧、盲点或性格缺陷会让人物付出代价？',
  appearance: '辨识度特征、穿搭、姿态或标志性习惯动作（如：紧张时推黑框眼镜）。',
  speechStyle: '常用词、口头禅、语气句式（如：“这波操作，稳如老狗！”）。',
  background: '哪些身世经历与过往关系塑造了现在的人物？',
  growthStages: '可分行记录初期、中期、后期的境界/心境转折与变化。',
  skillLimits: '核心能力、金手指、背包道具，以及使用能力的冷却条件与代价。',
}

export function CharacterProfileEditor({ profile, disabled, abilitiesDisabled = disabled, onChange }: {
  profile?: CharacterProfile
  disabled: boolean
  abilitiesDisabled?: boolean
  onChange: (profile: CharacterProfile) => void
}) {
  const id = useId()
  return <details className={styles.characterProfile} open>
    <summary>角色深度档案 & 属性面板 · 选填</summary>
    <p id={`${id}-help`} className={styles.profileHelp}>记录人物动机、背景、外貌、口头禅与能力代价。六维能力由作者设定，范围 0–100，留空表示未知；旧作品须先升级至 v17。</p>
    <div className={styles.profileFields}>
      {CHARACTER_PROFILE_FIELDS.map((key) => <label key={key}>
        {CHARACTER_PROFILE_LABELS[key]}
        <textarea value={profile?.[key] ?? ''} rows={3} maxLength={MAX_CHARACTER_PROFILE_FIELD_LENGTH}
          disabled={disabled} aria-describedby={`${id}-help ${id}-${key}-hint`}
          placeholder={hints[key]}
          onChange={(event) => onChange({ ...profile, [key]: event.target.value })} />
        <span id={`${id}-${key}-hint`} className={styles.profileHint}>{hints[key]}</span>
      </label>)}
      {CHARACTER_ABILITIES.map((key) => <label key={key}>{CHARACTER_ABILITY_LABELS[key]}
        <input type="number" min={0} max={100} step={1} value={profile?.abilities?.[key] ?? ''} disabled={abilitiesDisabled}
          placeholder="未知" aria-describedby={`${id}-help`} onChange={(event) => {
            const abilities = { ...profile?.abilities }
            if (event.target.value === '') delete abilities[key]
            else if (Number.isInteger(event.target.valueAsNumber) && event.target.valueAsNumber >= 0 && event.target.valueAsNumber <= 100) abilities[key] = event.target.valueAsNumber
            else return
            onChange({ ...profile, abilities })
          }} />
      </label>)}
    </div>
  </details>
}

export function CharacterProfileView({ profile }: { profile?: CharacterProfile }) {
  const keys = CHARACTER_PROFILE_FIELDS.filter((key) => profile?.[key]?.trim())
  const cx = 110, cy = 105, radius = 68
  const points = CHARACTER_ABILITIES.map((axis, idx) => {
    const angle = -Math.PI / 2 + (idx * 2 * Math.PI) / CHARACTER_ABILITIES.length
    const value = profile?.abilities?.[axis]
    const score = (value ?? 0) / 100
    return {
      label: CHARACTER_ABILITY_LABELS[axis], value,
      x: cx + Math.cos(angle) * radius * score,
      y: cy + Math.sin(angle) * radius * score,
      lx: cx + Math.cos(angle) * (radius + 22),
      ly: cy + Math.sin(angle) * (radius + 18),
    }
  })
  const polygonPoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  return <div className={styles.characterDashboard}>
    <div className={styles.radarCard}>
      <div className={styles.radarHeader}>
        <strong>角色六维能力</strong>
        <span>作者设定 · 0–100</span>
      </div>
      <div className={styles.radarBody}>
        <svg className={styles.radarSvg} viewBox="0 0 220 210" aria-label="角色六维属性雷达图">
          {[0.35, 0.68, 1].map((scale) => {
            const ring = CHARACTER_ABILITIES.map((_, idx) => {
              const angle = -Math.PI / 2 + (idx * 2 * Math.PI) / CHARACTER_ABILITIES.length
              return `${(cx + Math.cos(angle) * radius * scale).toFixed(1)},${(cy + Math.sin(angle) * radius * scale).toFixed(1)}`
            }).join(' ')
            return <polygon key={scale} points={ring} className={styles.radarGrid} />
          })}
          {points.every((point) => point.value !== undefined) && <polygon points={polygonPoints} className={styles.radarArea} />}
          {points.map((p, idx) => (
            <g key={idx}>
              {p.value !== undefined && <circle cx={p.x} cy={p.y} r="3.5" className={styles.radarDot} />}
              <text x={p.lx} y={p.ly} textAnchor="middle" dominantBaseline="middle" className={styles.radarLabel}>
                {p.label} {p.value ?? '未知'}
              </text>
            </g>
          ))}
        </svg>
        <div className={styles.radarStatsList}>
          {points.map((p) => (
            <div key={p.label} className={styles.radarStatRow}>
              <span>{p.label}</span>
              <div className={styles.radarBarTrack}><i style={{ width: `${p.value ?? 0}%` }} /></div>
              <strong>{p.value ?? '未知'}</strong>
            </div>
          ))}
        </div>
      </div>
    </div>

    {keys.length === 0 ? (
      <p className={styles.profileHelp}>尚未填写详细角色档案，可点击右上角「编辑条目」补充动机、外貌、口头禅与技能限制。</p>
    ) : (
      <dl className={styles.profileValues}>
        {keys.map((key) => (
          <div key={key} className={styles.profileCardItem}>
            <dt>{CHARACTER_PROFILE_LABELS[key]}</dt>
            <dd>{profile?.[key]}</dd>
          </div>
        ))}
      </dl>
    )}
  </div>
}
