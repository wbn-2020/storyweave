import { useState } from 'react'
import type { BookSnapshot } from '../../contracts/api'
import { MAX_WEAVE_MINUTE, MAX_WEAVE_VALUE, type WeaveOffer, type WeaveSnapshot, type WeaveState, type WeaveTask } from '../../contracts/weave-system'
import { StudioIcon } from './StudioIcon'
import styles from './StellarWeave.module.css'

interface Props {
  fields: WeaveState; book: BookSnapshot; disabled: boolean; error: string | null; notice: string | null; conflict: WeaveSnapshot | null
  onChange: (fields: WeaveState) => void; onSave: () => void; onCancel: () => void; onCompare: () => void; onUseLatest: () => void
}
export function WeaveSystemEditor({ fields, book, disabled, error, notice, conflict, onChange, onSave, onCancel, onCompare, onUseLatest }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  function update(patch: Partial<WeaveState>) { onChange({ ...fields, ...patch }) }
  function task(id: string, patch: Partial<WeaveTask>) { update({ tasks: fields.tasks.map((item) => item.id === id ? { ...item, ...patch } : item) }) }
  function offer(id: string, patch: Partial<WeaveOffer>) { update({ offers: fields.offers.map((item) => item.id === id ? { ...item, ...patch } : item) }) }
  function addTask(kind: WeaveTask['kind']) {
    const id = crypto.randomUUID()
    setExpanded((current) => ({ ...current, [id]: true }))
    update({ tasks: [...fields.tasks, { id, kind, active: true, title: '', chapterId: null, claimed: false,
      steps: [{ id: crypto.randomUUID(), title: '', done: false }], reward: { points: 0, experience: 0, items: [] } }] })
  }
  function toggle(id: string, open: boolean) { setExpanded((current) => current[id] === open ? current : { ...current, [id]: open }) }
  return <form className={styles.editor} onSubmit={(event) => { event.preventDefault(); if (!disabled && !conflict) onSave() }}
    onInvalidCapture={(event) => { if (event.target instanceof HTMLElement) { const details = event.target.closest('details'); if (details) details.open = true } }}>
    <fieldset disabled={disabled}>
      <legend>小说系统设定</legend>
      <div className={styles.fieldGrid}>
        <label>系统名称<input value={fields.name} maxLength={80} required onChange={(event) => update({ name: event.target.value })} /></label>
        <label>积分名称<input value={fields.currency} maxLength={30} required onChange={(event) => update({ currency: event.target.value })} /></label>
        <label>作者设定的积分余额<input type="number" min={0} max={MAX_WEAVE_VALUE} required value={fields.points} onChange={(event) => update({ points: event.target.valueAsNumber })} /></label>
        <label>作者设定的经验<input type="number" min={0} max={MAX_WEAVE_VALUE} required value={fields.experience} onChange={(event) => update({ experience: event.target.valueAsNumber })} /></label>
      </div>
      <p className={styles.note}>数值属于本书虚构系统。修改设定保留操作历史；剧情时间通过“刷新任务”推进。</p>
      <details className={styles.settingsSection}><summary>惩罚与冷却规则</summary><div className={styles.fieldGrid}>
        <label>连续未完成天数阈值<input type="number" min={0} max={365000} required value={fields.penalty.afterDays} onChange={(event) => update({ penalty: { ...fields.penalty, afterDays: event.target.valueAsNumber } })} /></label>
        <label>惩罚冷却分钟<input type="number" min={0} max={MAX_WEAVE_MINUTE} required value={fields.penalty.cooldownMinutes} onChange={(event) => update({ penalty: { ...fields.penalty, cooldownMinutes: event.target.valueAsNumber } })} /></label>
        <label>当前连续未完成天数<input type="number" min={0} max={365000} required value={fields.idleDays} onChange={(event) => update({ idleDays: event.target.valueAsNumber })} /></label>
        <label>当前惩罚冷却剩余分钟<input type="number" min={0} max={MAX_WEAVE_MINUTE - fields.storyMinute} required value={Math.max(0, fields.cooldownUntil - fields.storyMinute)} onChange={(event) => update({ cooldownUntil: fields.storyMinute + event.target.valueAsNumber })} /></label>
      </div><label>规则说明<textarea maxLength={2000} rows={2} value={fields.penalty.description} onChange={(event) => update({ penalty: { ...fields.penalty, description: event.target.value } })} /></label>
        <p className={styles.note}>阈值与冷却均填零表示停用。跨日刷新时，完成任一启用任务算当天完成；连续未完成达到阈值触发冷却，期间仅禁止领取每日奖励。所有倒计时均按剧情时间计算。</p>
      </details>
      <section className={styles.settingsSection}><h3>任务</h3>
        {fields.tasks.map((item, index) => <details key={item.id} className={styles.settingsSection} open={expanded[item.id] ?? false} onToggle={(event) => toggle(item.id, event.currentTarget.open)}><summary>{item.title || `未命名任务 ${index + 1}`} · {item.kind === 'main' ? '主线' : '每日'}{!item.active ? ' · 已停用' : ''}{item.claimed ? ' · 已领取' : ''}</summary>
          <div className={styles.fieldGrid}>
            <label>任务名称<input required value={item.title} maxLength={160} onChange={(event) => task(item.id, { title: event.target.value })} /></label>
            <label>关联章节<select value={item.chapterId ?? ''} onChange={(event) => task(item.id, { chapterId: event.target.value || null })}><option value="">未关联</option>{book.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label>
            <label>积分奖励<input type="number" min={0} max={MAX_WEAVE_VALUE} required value={item.reward.points} onChange={(event) => task(item.id, { reward: { ...item.reward, points: event.target.valueAsNumber } })} /></label>
            <label>经验奖励<input type="number" min={0} max={MAX_WEAVE_VALUE} required value={item.reward.experience} onChange={(event) => task(item.id, { reward: { ...item.reward, experience: event.target.valueAsNumber } })} /></label>
          </div><label className={styles.check}><input type="checkbox" checked={item.active} onChange={(event) => task(item.id, { active: event.target.checked })} />启用任务</label>
          <div className={styles.editorList}>{item.steps.map((step, stepIndex) => <div className={styles.editorRow} key={step.id}>
            <label>步骤 {stepIndex + 1}<input required value={step.title} maxLength={160} onChange={(event) => task(item.id, { steps: item.steps.map((entry) => entry.id === step.id ? { ...entry, title: event.target.value } : entry) })} /></label>
            <button className={styles.iconButton} type="button" title="移除此步骤" aria-label={`移除步骤 ${stepIndex + 1}`} disabled={item.claimed || item.steps.length <= 1} onClick={() => task(item.id, { steps: item.steps.filter((entry) => entry.id !== step.id) })}><StudioIcon name="close" /></button>
          </div>)}</div>
          <button className={styles.button} type="button" disabled={item.claimed || item.steps.length >= 16} onClick={() => task(item.id, { steps: [...item.steps, { id: crypto.randomUUID(), title: '', done: false }] })}><StudioIcon name="plus" />添加步骤</button>
          <div className={styles.editorList}>{item.reward.items.map((reward, rewardIndex) => <div className={styles.editorRow} key={rewardIndex}>
            <label>物品／词条名称<input maxLength={80} required value={reward.name} onChange={(event) => task(item.id, { reward: { ...item.reward, items: item.reward.items.map((entry, i) => i === rewardIndex ? { ...entry, name: event.target.value } : entry) } })} /></label>
            <label>数量<input type="number" min={1} max={MAX_WEAVE_VALUE} required value={reward.quantity} onChange={(event) => task(item.id, { reward: { ...item.reward, items: item.reward.items.map((entry, i) => i === rewardIndex ? { ...entry, quantity: event.target.valueAsNumber } : entry) } })} /></label>
            <button className={styles.iconButton} type="button" title="移除此奖励" aria-label={`移除物品奖励 ${rewardIndex + 1}`} onClick={() => task(item.id, { reward: { ...item.reward, items: item.reward.items.filter((_, i) => i !== rewardIndex) } })}><StudioIcon name="close" /></button>
          </div>)}</div><button className={styles.button} type="button" disabled={item.reward.items.length >= 8} onClick={() => task(item.id, { reward: { ...item.reward, items: [...item.reward.items, { name: '', quantity: 1 }] } })}><StudioIcon name="plus" />添加物品／词条奖励</button>
        </details>)}
        <div className={styles.actions}><button className={styles.button} type="button" disabled={fields.tasks.length >= 60} onClick={() => addTask('main')}><StudioIcon name="plus" />主线任务</button><button className={styles.button} type="button" disabled={fields.tasks.length >= 60} onClick={() => addTask('daily')}><StudioIcon name="plus" />每日任务</button></div>
      </section>
      <section className={styles.settingsSection}><h3>积分商店</h3>{fields.offers.map((item, index) => <details key={item.id} className={styles.settingsSection} open={expanded[item.id] ?? false} onToggle={(event) => toggle(item.id, event.currentTarget.open)}><summary>{item.name || `未命名商品 ${index + 1}`}{!item.active ? ' · 已停用' : ''}</summary>
        <div className={styles.fieldGrid}><label>商品名称<input value={item.name} maxLength={80} required onChange={(event) => offer(item.id, { name: event.target.value })} /></label>
          <label>价格<input type="number" min={0} max={MAX_WEAVE_VALUE} required value={item.price} onChange={(event) => offer(item.id, { price: event.target.valueAsNumber })} /></label>
          <label>每次兑换数量<input type="number" min={1} max={MAX_WEAVE_VALUE} required value={item.quantity} onChange={(event) => offer(item.id, { quantity: event.target.valueAsNumber })} /></label>
          <label>兑换冷却分钟<input type="number" min={0} max={MAX_WEAVE_MINUTE} required value={item.cooldownMinutes} onChange={(event) => offer(item.id, { cooldownMinutes: event.target.valueAsNumber })} /></label>
          <label>剩余库存<input type="number" min={0} max={MAX_WEAVE_VALUE} disabled={item.stock === null} required={item.stock !== null} value={item.stock ?? ''} onChange={(event) => offer(item.id, { stock: event.target.valueAsNumber })} /></label>
          <label className={styles.check}><input type="checkbox" checked={item.stock === null} onChange={(event) => offer(item.id, { stock: event.target.checked ? null : 0 })} />不限库存</label>
        </div><label>商品说明<textarea value={item.description} maxLength={2000} rows={2} onChange={(event) => offer(item.id, { description: event.target.value })} /></label>
        <label className={styles.check}><input type="checkbox" checked={item.active} onChange={(event) => offer(item.id, { active: event.target.checked })} />启用商品</label>
      </details>)}<button className={styles.button} type="button" disabled={fields.offers.length >= 40} onClick={() => {
        const id = crypto.randomUUID()
        setExpanded((current) => ({ ...current, [id]: true }))
        update({ offers: [...fields.offers, { id, active: true, name: '', description: '', price: 0, quantity: 1, stock: null, cooldownMinutes: 0, availableAt: 0, purchased: 0 }] })
      }}><StudioIcon name="plus" />添加商品</button></section>
    </fieldset>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {conflict && <section className={styles.warning}><p>最新作品版本 {conflict.bookRevision} · 系统版本 {conflict.revision}。请核对余额、任务状态和奖励；不会将当前输入覆盖到新版本。</p>
      <textarea rows={7} readOnly aria-label="最新系统设定" value={JSON.stringify(conflict.fields, null, 2)} />
      <button className={styles.button} type="button" disabled={disabled} onClick={onUseLatest}>放弃当前输入并载入最新版本</button></section>}
    <div className={styles.actions}><button className={styles.button} type="button" disabled={disabled} onClick={onCancel}>返回</button>
      <button className={styles.button} type="button" disabled={disabled} onClick={onCompare}>读取最新版本进行比较</button>
      <button className={styles.primaryButton} type="submit" disabled={disabled || Boolean(conflict)}>保存系统设定</button></div>
  </form>
}
