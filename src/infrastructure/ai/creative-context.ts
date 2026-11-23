import type Database from 'better-sqlite3'
import { DomainError } from '../../contracts/api'
import { WRITING_METHODS, parseCreativeResources, type CreativeResource, type CreativeResourceRef, type CreativeResources } from '../../contracts/creative-resources'
import { MAX_WORKBENCH_FIELDS_BYTES, parseInspirationFields, parseSceneFields } from '../../contracts/workbench'
import { isStudyCardKind, studyMaterialText } from '../../contracts/study-card'
import { parseStoryFields, plannedPayoffText } from '../../contracts/story'
import { NotesRepository } from '../notes/notes-repository'
import { parseRealmState } from '../../contracts/realm'
import { parseWeaveState } from '../../contracts/weave-system'
import type { StudioRepository } from '../storage/studio-repository'

function unavailable(message: string): never { throw new DomainError({ code: 'REVISION_CONFLICT', message }) }
export function readCreativeResources(studio: StudioRepository, db: Database.Database, bookId: string, chapterId: string,
  refs: CreativeResourceRef[], application: string, rawReferences = false): CreativeResources | undefined {
  if (!refs.length) return undefined
  const items = refs.map((ref): CreativeResource => {
    if (ref.source === 'builtin') {
      const method = WRITING_METHODS.find((item) => item.id === ref.id && item.revision === ref.revision)
      if (!method) return unavailable('写作方法版本已改变，请重新选择。')
      return { ...method }
    }
    if (ref.source === 'realm' || ref.source === 'weave') {
      if (ref.id !== bookId || Number(db.pragma('user_version', { simple: true })) < 28) return unavailable('请先在知识库备份升级至 v28，再将境界或织造设定选入写作上下文。')
      const table = ref.source === 'realm' ? 'realm_state' : 'weave_state'
      const row = db.prepare(`SELECT revision, CASE WHEN length(CAST(fields_json AS BLOB)) <= 262144 THEN fields_json END AS fields_json FROM ${table} WHERE singleton = 1`)
        .get() as { revision: number; fields_json: string | null } | undefined
      if (!row || row.revision !== ref.revision || !row.fields_json) return unavailable('境界或织造设定已经变化，请重新选择当前版本。')
      const fields = ref.source === 'realm' ? parseRealmState(JSON.parse(row.fields_json)) : parseWeaveState(JSON.parse(row.fields_json))
      const title = ref.source === 'realm' ? '境界阶梯与人物战力' : '织造系统设定'
      const text = `作者明确选入的当前配置快照，不附带故事时间。阶梯与规则作为作者设定；人物数值、库存和进度不能自动视为本章时点的状态。涉及历史章节时须根据正文与作者要求核对，未知项不得补全。\n${JSON.stringify(fields)}`
      return { ...ref, title, text, role: 'material' }
    }
    if (ref.source === 'note') {
      const note = new NotesRepository(studio).get({ bookId, id: ref.id })
      if (note.archived || note.revision !== ref.revision) return unavailable('所选笔记已改变或所属作品已归档，请重新选择。')
      return { ...ref, title: note.title, text: note.body, role: note.category === 'method' ? 'method' : 'material' }
    }
    if (ref.source === 'inspiration') {
      const collection = studio.getInspirationDatabase()
      const row = collection?.prepare(`SELECT revision, kind, title,
        CASE WHEN length(CAST(body AS BLOB)) <= 160000 THEN body END AS body,
        source, tags_json, parent_id, book_id, archived FROM inspirations WHERE id = ?`).get(ref.id) as
        { revision: number; kind: string; title: string; body: string; source: string; tags_json: string; parent_id: string | null; book_id: string | null; archived: number } | undefined
      if (!row || row.archived !== 0 || row.revision !== ref.revision) return unavailable('所选全局资料已改变或归档，请重新选择。')
      const fields = parseInspirationFields({ ...row, tags: JSON.parse(row.tags_json), parentId: row.parent_id, bookId: row.book_id, archived: false })
      // 引文验证只使用资料正文；出处仍由固定条目 ID 与版本追溯，不能混入待拆解原文。
      return { ...ref, title: fields.title, text: rawReferences ? fields.body : studyMaterialText(fields.kind, fields.body),
        role: fields.kind === 'method' || fields.kind === 'technique' || isStudyCardKind(fields.kind) ? 'method' : 'material' }
    }
    if (ref.source === 'foreshadow') {
      const row = db.prepare(`SELECT s.fields_json FROM story_records s JOIN story_record_revisions r
        ON r.record_id = s.id AND r.fields_json = s.fields_json WHERE s.id = ? AND s.book_id = ?
        AND s.kind = 'foreshadow' AND r.knowledge_revision = ?
        AND r.knowledge_revision = (SELECT MAX(latest.knowledge_revision) FROM story_record_revisions latest WHERE latest.record_id = s.id)
        AND length(CAST(s.fields_json AS BLOB)) <= 4194304`).get(ref.id, bookId, ref.revision) as { fields_json: string } | undefined
      if (!row) return unavailable('所选伏笔的固定修订已改变，请在雷达中刷新后重新选择。')
      const fields = parseStoryFields(JSON.parse(row.fields_json), bookId)
      if (fields.kind !== 'foreshadow' || fields.authorDecision !== 'adopted' || fields.freshness !== 'current' || fields.conflictState === 'candidate' ||
          fields.stage === 'resolved' || fields.stage === 'abandoned') return unavailable('伏笔尚未采纳、需要复核或已经结束，请先核对记录。')
      const history = fields.milestones.slice(-8)
      const text = [`作者选用的伏笔计划；计划不代表已经发生，也不代表人物知情。`, `记录 ${ref.id}；固定知识修订 ${ref.revision}`,
        `资料性质：${fields.nature}；冲突标注：${fields.conflictState}`, `说明：${fields.description}`, `当前阶段：${fields.stage}`, `计划回收：${plannedPayoffText(fields.plannedPayoff)}`,
        ...(fields.milestones.length > history.length ? ['较早的里程碑未附带；本次仅附带最后 8 项的节选。'] : []),
        ...history.map((item) => `${item.stage}：${item.note.slice(0, 1000)}${item.note.length > 1000 ? '（说明已节选）' : ''}${item.source?.sourceType === 'chapter_text'
          ? `\n固定出处 ${item.source.chapterId}／${item.source.revisionId}／${item.source.blockId}；引文：${item.source.quote}` : ''}`)].join('\n')
      return { ...ref, title: fields.title, text, role: 'plan' }
    }
    if (Number(db.pragma('user_version', { simple: true })) < 13) return unavailable('请先备份升级作品，再使用场景计划。')
    const row = db.prepare(`SELECT revision, CASE WHEN length(CAST(fields_json AS BLOB)) <= ? THEN fields_json END AS fields_json
      FROM scene_cards WHERE id = ?`).get(MAX_WORKBENCH_FIELDS_BYTES, ref.id) as { revision: number; fields_json: string } | undefined
    if (!row || row.revision !== ref.revision || typeof row.fields_json !== 'string') return unavailable('场景计划已改变，请重新选择。')
    const fields = parseSceneFields(JSON.parse(row.fields_json))
    if (fields.archived || (fields.chapterId && fields.chapterId !== chapterId)) return unavailable('所选场景不属于当前章，或已归档。')
    if (fields.anchor) {
      const chapter = studio.readChapter({ bookId, chapterId })
      if (fields.anchor.revisionId !== chapter.revisionId || fields.anchor.blockIds.some((id) => !chapter.document.content.some((block) => block.attrs.id === id))) {
        return unavailable('场景关联正文已经变化，请先复核场景定位。')
      }
    }
    // 场景引用固定实体版本及作者说明；不把计划或作者全知资料误写成人物知情。
    const names = [...fields.characterIds, ...(fields.locationId ? [fields.locationId] : [])].map((id) => {
      const entity = db.prepare('SELECT name FROM knowledge_items WHERE id = ? AND book_id = ?').get(id, bookId) as { name: string } | undefined
      if (!entity) return unavailable('场景关联的资料不存在，请先复核场景。')
      return `${id}：${entity.name}`
    })
    const text = [['目标', fields.goal], ['冲突', fields.conflict], ['结束变化', fields.outcome], ['视角', fields.viewpoint],
      ['故事时间', fields.storyTime], ['情节线', fields.plotline], ['人物与地点', names.join('；')], ['计划字数', fields.targetCharacters?.toString() ?? '']]
      .filter(([, value]) => value).map(([label, value]) => `${label}：${value}`).join('\n')
    return { ...ref, title: fields.title, role: 'plan', text: text || `场景：${fields.title}（尚未补充目标与冲突）` }
  })
  return parseCreativeResources({ version: 1, items, application })
}
