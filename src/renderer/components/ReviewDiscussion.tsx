import type { ReviewIssue } from '../../contracts/workbench'
import { displayTime } from '../request'
import { StudioIcon } from './StudioIcon'
import styles from './ReviewDiscussion.module.css'

interface Props {
  issue: ReviewIssue
  disabled?: boolean
  replyDisabled?: boolean
  replyReason?: string
  onReply?: () => void
  onResolve?: () => void
  onReopen?: () => void
}

export function ReviewDiscussion({ issue, disabled, replyDisabled, replyReason, onReply, onResolve, onReopen }: Props) {
  return <section className={styles.discussion} aria-label={`批注讨论：${issue.title}`} data-state={issue.status}>
    <header className={styles.identity}>
      <span className={styles.avatar} aria-hidden="true"><StudioIcon name={issue.aiRunId ? 'spark' : 'user'} size={20} /></span>
      <strong>{issue.aiRunId ? '审稿建议' : '本机作者'}</strong>
      <time dateTime={issue.updatedAt}>更新于 {displayTime(issue.updatedAt)}</time>
    </header>
    <p className={styles.body}>{issue.reason || issue.suggestion || '尚未填写批注内容。'}</p>
    {Boolean(issue.replies?.length) && <ol className={styles.replies} aria-label="已保存回复" tabIndex={0}>
      {issue.replies!.map((reply) => <li key={reply.id}>
        <header className={styles.identity}><StudioIcon name="user" size={16} /><strong>本机作者</strong><time dateTime={reply.createdAt}>{displayTime(reply.createdAt)}</time></header>
        <p className={styles.body}>{reply.body}</p>
      </li>)}
    </ol>}
    {(onReply || onResolve || onReopen) && <div className={styles.actions}>
      {onReply && <button type="button" className={styles.action} disabled={disabled || replyDisabled} title={replyReason} onClick={onReply}><StudioIcon name="comment" size={20} />回复</button>}
      {onResolve && <button type="button" className={styles.action} disabled={disabled || issue.stale} title={issue.stale ? '来源已变化，请重新定位并复核后再解决。' : '标记已解决，保留批注和回复。'} onClick={onResolve}><StudioIcon name="check" size={20} />解决</button>}
      {onReopen && <button type="button" className={styles.action} disabled={disabled} onClick={onReopen}><StudioIcon name="refresh" size={20} />重新打开</button>}
      {issue.status === 'resolved' && <span className={styles.resolved}><StudioIcon name="check" size={16} />已解决</span>}
    </div>}
  </section>
}
