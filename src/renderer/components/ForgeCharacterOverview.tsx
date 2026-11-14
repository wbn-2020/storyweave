import { useEffect, useState } from 'react'
import type { StudioApi } from '../../contracts/api'
import { CHARACTER_PROFILE_FIELDS, type CharacterProfileField } from '../../contracts/character-profile'
import type { ForgeEntity, ForgeKind, ForgeProposal, ForgeRunDetail, ForgeSnapshot } from '../../contracts/forge'
import { displayTime, request } from '../request'
import { CharacterProfileView } from './CharacterProfileEditor'
import { StudioIcon } from './StudioIcon'
import { SavedPortrait, useSavedPortraits } from './SavedPortrait'
import styles from './StellarForgeCharacter.module.css'

interface Props {
  api: StudioApi
  snapshot: ForgeSnapshot
  selectedId: string
  disabled: boolean
  detail: ForgeRunDetail | null
  proposal: ForgeProposal | null
  excluded: string
  onPrepare: (kind: ForgeKind) => void
  onKnowledge: () => void
  onMedia: () => void
  onCopy: (text: string) => void
}

const fieldLabels: Record<CharacterProfileField, string> = {
  motivation: '动机', desire: '眼下渴望', weakness: '致命弱点', appearance: '外貌习惯',
  speechStyle: '说话风格', background: '身世', growthStages: '成长弧光', skillLimits: '能力与代价',
}

export function ForgeCharacterOverview({ api, snapshot, selectedId, disabled, detail, proposal, excluded, onPrepare, onKnowledge, onMedia, onCopy }: Props) {
  // 显式刷新即使未推进作品版本，也要重新读取失败的立绘资料。
  const portraits = useSavedPortraits(api, snapshot.bookId, snapshot.bookRevision, snapshot)
  const [auditionResult, setAuditionResult] = useState<{ api: StudioApi; snapshot: ForgeSnapshot; person: ForgeEntity; values: (ForgeRunDetail | null)[]; error: string | null } | null>(null)
  const person = snapshot.person?.entity.id === selectedId ? snapshot.person.entity : null
  const portrait = portraits.items.find((item) => item.personId === person?.id)
  const profile = person?.fields.characterProfile
  const names = proposal?.kind === 'names' ? proposal.names : []
  const avoidedNames = [...new Set([...snapshot.entities.filter((item) => item.kind === 'person').map((item) => item.name),
    ...excluded.split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean)])]
  const pending = person && (person.fields.freshness !== 'current' || person.fields.conflictState === 'candidate' || person.fields.authorDecision === 'review_later')
  const auditionTasks = snapshot.auditionRuns
  const currentAuditions = auditionResult?.api === api && auditionResult.snapshot === snapshot && auditionResult.person === person ? auditionResult : null
  const auditionError = currentAuditions?.error ?? null

  // 任务轮询不重读历史台词；完成后父页更新快照，显式刷新也可重试失败片段。
  useEffect(() => {
    let active = true
    setAuditionResult(null)
    if (!person || !auditionTasks.length) return
    void (async () => {
      // 结果绑定本次人物快照；失败保留卡片位置，不把后一份片段冒充前一份。
      const values: (ForgeRunDetail | null)[] = []
      let error: string | null = null
      for (const task of auditionTasks) {
        const result = await request(() => api.getForgeRun({ bookId: snapshot.bookId, runId: task.id }))
        if (!active) return
        if (!result.ok) { error = result.error.message; values.push(null); continue }
        const value = result.data
        if (value.bookId !== snapshot.bookId || value.run.id !== task.id || value.run.bookId !== snapshot.bookId
          || value.request.bookId !== snapshot.bookId || value.request.kind !== 'audition' || value.request.personId !== person.id
          || value.run.context.purpose !== 'forge' || !['succeeded', 'adopted'].includes(value.run.state)) {
          error = '试戏片段与固定任务不一致。'; values.push(null); continue
        }
        if (!value.run.outputText.trim()) { error = '已完成试戏没有可显示的内容。'; values.push(null); continue }
        values.push(value)
      }
      if (active) setAuditionResult({ api, snapshot, person, values, error })
    })()
    return () => { active = false }
  }, [api, snapshot, person])

  return <section className={styles.overview} aria-label="角色工坊档案总览">
    <div className={styles.columns}>
      <aside className={styles.identity}>
        <button type="button" className={styles.portrait} disabled={disabled} onClick={onMedia} aria-label={person ? `查看${person.fields.name}的立绘` : '查看人物立绘'}>
          <SavedPortrait api={api} bookId={snapshot.bookId} personId={person?.id ?? ''} metadata={portrait} name={person?.fields.name ?? ''} className={styles.portraitContent} fallback={<><StudioIcon name="user" size={64} /><span>{!person ? '尚未选择人物' : portraits.loading ? '立绘资料读取中…' : portraits.error ? '立绘资料暂不可用' : portrait ? '已保存立绘尚未显示' : '尚未设置立绘'}</span></>} />
        </button>
        <h3>{person?.fields.name ?? '选择角色'}{pending && <i title="人物资料待复核" aria-label="人物资料待复核" />}</h3>
        <p className={styles.subtitle}>{person?.fields.summary || '尚未填写人物身份'}</p>
        {portraits.error && <p className={styles.error} role="alert">{portraits.error}</p>}
        <CharacterProfileView profile={profile} details={false} compact />
      </aside>
      <article className={styles.fields}>
        <header><h3><StudioIcon name="spark" size={24} />八维人设</h3><button type="button" className={styles.iconButton} disabled={disabled} title="编辑人物设定" aria-label="编辑人物设定" onClick={onKnowledge}><StudioIcon name="pen" size={20} /></button></header>
        <dl>{CHARACTER_PROFILE_FIELDS.map((key) => <div key={key}><dt>{fieldLabels[key]}</dt><dd>{profile?.[key] ? <>{person?.fields.nature === 'ai_inference' && <span className={styles.inference}>AI 推断</span>}{profile[key]}</> : <span className={styles.unknown}>{person ? '尚未填写' : '尚未选择人物'}</span>}</dd></div>)}</dl>
        <button type="button" className={styles.fill} disabled={disabled || !person} onClick={() => onPrepare('fill')}><StudioIcon name="spark" size={20} />只补空白字段</button>
      </article>
      <aside className={styles.nameWorkshop}>
        <h3><StudioIcon name="spark" size={24} />避坑起名器</h3>
        <div className={styles.nameCandidates}>{names.length ? names.slice(0, 3).map((item) => <article key={item.name}><div><strong>{item.name}</strong><button type="button" className={styles.iconButton} disabled={disabled} title="复制名字" aria-label={`复制名字${item.name}`} onClick={() => onCopy(item.name)}><StudioIcon name="copy" size={20} /></button></div><p>{item.meaning}</p></article>)
          : <div className={styles.nameEmpty}><StudioIcon name="spark" size={32} /><p>尚无已读取的起名候选</p></div>}</div>
        {names.length > 0 && <p className={styles.scope}>AI 起名候选 · 当前显示 {Math.min(3, names.length)}/{names.length} 个{detail?.run.context.bookRevision !== snapshot.bookRevision ? ' · 来源版本已变化' : ''}</p>}
        <button type="button" className={styles.namesAction} disabled={disabled} onClick={() => onPrepare('names')}><StudioIcon name="refresh" size={20} />准备起名</button>
        <section className={styles.avoidance}><h4><StudioIcon name="minus" size={20} />本书已有、避用名单</h4><div>{avoidedNames.slice(0, 12).map((name) => <span key={name}>{name}</span>)}</div>{!avoidedNames.length && <p className={styles.unknown}>尚未登记人物或避用名称</p>}{avoidedNames.length > 12 && <p className={styles.scope}>共 {avoidedNames.length} 项，当前显示前 12 项。</p>}</section>
        <button type="button" className={styles.auditionAction} disabled={disabled || !person} onClick={() => onPrepare('audition')}><StudioIcon name="spark" size={24} /><span>进入试戏舱</span><StudioIcon name="chevron" size={20} /></button>
      </aside>
    </div>
    <div className={styles.dialogues} aria-label="人物试戏片段" aria-busy={Boolean(person && auditionTasks.length && !currentAuditions)}>{[0, 1].map((index) => {
      const audition = currentAuditions?.values[index]
      const placeholder = !person ? '选择人物后读取已有试戏。' : index >= auditionTasks.length ? '当前资料中尚无此段已完成试戏。'
        : !currentAuditions ? '试戏片段读取中…' : '此段试戏未能读取，请刷新资料重试。'
      return <article key={index} data-tone={index}><h3><StudioIcon name="spark" size={24} />台词 · 片段{index === 0 ? '一' : '二'}</h3>{audition ? <><blockquote>{audition.run.outputText}</blockquote><small>AI 试戏 · {displayTime(audition.run.createdAt)} · 尚非正文</small><button type="button" className={styles.iconButton} disabled={disabled} title="复制试戏片段" aria-label={`复制试戏片段${index + 1}`} onClick={() => onCopy(audition.run.outputText)}><StudioIcon name="copy" size={20} /></button></>
        : <p className={styles.unknown}>{placeholder}</p>}</article>
    })}</div>
    {auditionError && <p className={styles.error} role="alert">{auditionError}</p>}
  </section>
}
