// 两个调用方分别限定实体与章节范围；同一登记规则供出场矩阵和设定库详情使用。
// 正向登记只认已采纳事件及正文来源；缺席来自独立整章核对，旧稿与当前分开。
export const APPEARANCE_ASSERTIONS_CTE = `events AS (SELECT s.id, s.fields_json, json_extract(s.fields_json, '$.freshness') AS freshness,
      json_extract(s.fields_json, '$.conflictState') AS conflict_state
    FROM story_records s WHERE s.book_id = @bookId AND s.kind = 'event'
      AND json_extract(s.fields_json, '$.authorDecision') = 'adopted'
      AND json_extract(s.fields_json, '$.nature') IN ('author_setting', 'narrative_claim', 'ai_derived')),
  assertions AS (
    SELECT DISTINCT r.entity_id, c.id AS chapter_id, e.id AS record_id, r.role AS role,
      CASE WHEN src.revision_id = c.current_revision_id AND e.freshness = 'current' AND e.conflict_state <> 'candidate' THEN 1 ELSE 0 END AS current
    FROM events e JOIN story_entity_refs r ON r.record_id = e.id AND r.book_id = @bookId
    JOIN entities p ON p.id = r.entity_id
    JOIN story_sources src ON src.record_id = e.id AND src.book_id = @bookId AND src.source_type = 'chapter_text'
    JOIN chapters c ON c.id = src.chapter_id JOIN chapters_page cp ON cp.id = c.id
    WHERE r.role IN ('participant', 'mentioned')
    UNION ALL
    SELECT a.value AS entity_id, c.id AS chapter_id, e.id AS record_id, 'absent' AS role,
      CASE WHEN json_extract(e.fields_json, '$.appearanceCheck.revisionId') = c.current_revision_id
        AND e.freshness = 'current' AND e.conflict_state <> 'candidate' THEN 1 ELSE 0 END AS current
    FROM events e JOIN json_each(e.fields_json, '$.appearanceCheck.absentEntityIds') a
    JOIN entities p ON p.id = a.value
    JOIN chapters c ON c.id = json_extract(e.fields_json, '$.appearanceCheck.chapterId')
    JOIN chapters_page cp ON cp.id = c.id
  )`
