'use strict';

const fs = require('node:fs');
const path = require('node:path');

let seed = 41027;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
function normal() {
  return Math.sqrt(-2 * Math.log(Math.max(0.000001, random()))) * Math.cos(2 * Math.PI * random());
}

const clusters = [
  { id: 'people', title: '人物与知情', color: '#76B9CE', center: [-150, 18, -25], spread: [64, 34, 34] },
  { id: 'events', title: '北堤事件', color: '#9DABDC', center: [-25, 44, 12], spread: [58, 35, 32] },
  { id: 'rules', title: '潮钟规则', color: '#8CCBB7', center: [70, -18, -15], spread: [49, 36, 28] },
  { id: 'clues', title: '伏笔与承诺', color: '#DEB881', center: [190, 14, 24], spread: [60, 35, 35] },
  { id: 'sources', title: '港务资料', color: '#AF9CCD', center: [105, 110, 42], spread: [46, 29, 28] },
  { id: 'plans', title: '未决与计划', color: '#D491A1', center: [-118, 122, 24], spread: [47, 29, 30] }
];
const excerpt = '“潮钟只会吐出声音，仓门外的脚步不会留下影像。”宋遥没有碰钟，只指向门槛上被雨冲淡的泥印。';
const anchors = [
  { id: 'lin', name: '林岑', type: '人物', cluster: 'people', position: [-154, -7, 0], status: '作者设定', detail: '档案修复员，持有旧索引。经历与知情按场景保存，不从人物简介推断。', source: '作者设定 · 人物 p01', eligibility: '仅纳入身份与当前可证知情', level: '身份' },
  { id: 'song', name: '宋遥', type: '人物', cluster: 'people', position: [-105, 58, 28], status: '作者设定', detail: '守潮人，寻找失踪队友。b42 只证实角色说过潮钟限制；相信、真实知情与作者秘密分别记录。', source: '作者设定 · 人物 p02', eligibility: '本场说法有引文；知情来源/时点待补，不入记忆包', level: '身份' },
  { id: 's1', name: '甲板回声', type: '场景', cluster: 'events', position: [-55, -6, 24], status: '已写场景', detail: '林岑听见重复钟声，查找不存在的靠港时间。', source: '第一章 · 场景 s01 · 正文样例', eligibility: '前文来源；发生与解释分开', level: '正文' },
  { id: 's2', name: '错号证词', type: '场景', cluster: 'events', position: [-54, 75, 9], status: '已写场景', detail: '证词编号反写为17，异常先记为待查，不作正式原因。', source: '第一章 · 场景 s02 · 正文样例', eligibility: '记住异常，不自动确定原因', level: '正文' },
  { id: 's3', name: '巡堤队封锁', type: '场景', cluster: 'events', position: [-3, 102, 24], status: '前场摘要', detail: '仓库被封锁；账本收走前，必须找到第17页。', source: '第二章 · 场景 s03 · 摘要样例', eligibility: '派生摘要待按来源版本核对', level: '摘要' },
  { id: 's4', name: '仓库对证', type: '场景', cluster: 'events', position: [8, 16, 42], status: '当前写作', detail: '核对钟声能够证明什么；不让钟声替人物作证。', source: '第二章 · 场景 s04 · 正文 r18 / b42', eligibility: '当前输入与保存版本需一致', level: '正文', excerpt },
  { id: 'rule', name: '潮钟的边界', type: '规则', cluster: 'rules', position: [83, -15, 22], status: '已确认 · 来源有效', detail: '只能重放声音，不能重放影像。否定条件必须完整保留，摘要不能只写“重放现场”。', source: '作者采用为规则（样例）· 正文 r18 / b42', eligibility: '本场适用 · 不隐藏 · 保留证据', level: '事实', excerpt },
  { id: 'place', name: '北堤潮钟仓库', type: '地点', cluster: 'rules', position: [80, 43, -13], status: '作者设定', detail: '封锁与对证的发生地；地点关系不代替正文证据。', source: '作者设定 · 地点 l01', eligibility: '本场地点，不自动扩写其他规则', level: '身份' },
  { id: 'clue', name: '反写编号 17', type: '伏笔', cluster: 'clues', position: [190, -8, 27], status: '已引入 · 回收待核', detail: '第一章出现反写编号；第三章计划回收。计划回收不等于正文已经回收。', source: '第一章 · 场景 s02 / 作者伏笔计划', eligibility: '纳入已写线索，未来回收不作已发生事实', level: '线索' },
  { id: 's5', name: '重放失败', type: '场景', cluster: 'clues', position: [144, 65, 1], status: '未来计划', detail: '声音不能证明影像身份，不能靠新增能力解围。', source: '第三章 · 场景 s05 · 作者计划', eligibility: '当前写作默认排除未来事件', level: '计划' },
  { id: 's6', name: '留下倒页', type: '场景', cluster: 'clues', position: [244, 41, 7], status: '未来计划', detail: '倒读账本，反写编号指向另一套索引。', source: '第三章 · 场景 s06 · 作者计划', eligibility: '回收仍待未来正文证据', level: '计划' },
  { id: 'ref', name: '港务日志第17页', type: '资料', cluster: 'sources', position: [112, 107, 42], status: '参考资料', detail: '作者手录资料，未确认为正式事实；没有精确正文绑定。', source: '作者材料 · ref01', eligibility: '参考用途单独选择，不自动作写作事实', level: '资料' },
  { id: 'todo', name: '第17页的交代', type: '待办', cluster: 'plans', position: [-118, 110, 15], status: '作者待处理', detail: '核对第二章是否揭示过早。待办不是故事中的事实。', source: '作者待办 · todo01', eligibility: '不进入正式事实上下文', level: '计划' },
  { id: 'idea', name: '第二次铃响', type: '想法', cluster: 'plans', position: [-163, 155, 40], status: '待确认', detail: '是否来自空船？尚未有支持这一解释的正文证据。', source: '作者想法 · idea01', eligibility: '未确认，不进入写作事实', level: '候选' }
];
const nodes = anchors.map(node => ({ ...node, anchor: true, fixture: false }));
const edgeKeys = new Set();
const edges = [];
function connect(a, b, kind, planned = false, fixture = false) {
  const key = [a, b].sort().join('|');
  if (a === b || edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push({ a, b, kind, planned, fixture });
}
[
  ['lin', 's1', '人物参与'], ['lin', 's4', '人物参与'], ['song', 's4', '人物参与'],
  ['s4', 'rule', '作者明确绑定'], ['s3', 'place', '场景地点'], ['s4', 'place', '场景地点'],
  ['s2', 'clue', '作者明确引入'], ['s6', 'clue', '计划回收', true], ['s5', 'rule', '计划遵守', true],
  ['s4', 'clue', '计划追问', true], ['ref', 'clue', '参考待核', true], ['todo', 's4', '作者待办'],
  ['idea', 's1', '待确认关联', true]
].forEach(edge => connect(...edge));

const prefixes = {
  people: ['身份线索', '人物经历', '知情记录', '人物关系'],
  events: ['事件片段', '场景证据', '时序记录', '事件关联'],
  rules: ['设定条目', '规则出处', '适用记录', '地点资料'],
  clues: ['线索片段', '伏笔计划', '承诺记录', '未决问题'],
  sources: ['资料摘录', '参考链接', '原文索引', '来源片段'],
  plans: ['待改记录', '构思片段', '候选条目', '作者意图']
};
for (let ci = 0; ci < clusters.length; ci++) {
  const cluster = clusters[ci];
  const local = anchors.filter(node => node.cluster === cluster.id);
  for (let i = 0; i < 116; i++) {
    const distance = Math.sqrt(random());
    const angle = i * 2.3999632297 + distance * 3.3;
    const spiral = 0.7 + random() * 0.4;
    const position = [
      cluster.center[0] + Math.cos(angle) * cluster.spread[0] * distance * spiral + normal() * 6,
      cluster.center[1] + Math.sin(angle) * cluster.spread[1] * distance + normal() * 4,
      cluster.center[2] + normal() * cluster.spread[2] * (0.35 + distance * 0.3)
    ];
    const id = `${cluster.id}-${String(i + 1).padStart(3, '0')}`;
    const names = prefixes[cluster.id];
    nodes.push({ id, name: `${names[i % names.length]} ${String(i + 1).padStart(3, '0')}`, type: '演示对象', cluster: cluster.id, position, anchor: false, fixture: true, status: '密度演示 · 非正式事实', level: '演示', detail: '此对象仅用于原创离线星系的密度与镜头演示，没有对应的已写小说证据，不会进入本场记忆。', source: '合成展示数据 · 非正文提取', eligibility: '只展示，不纳入写作或事实库' });
    connect(id, local[i % local.length].id, '演示关联', false, true);
    if (i > 0) connect(id, `${cluster.id}-${String(i).padStart(3, '0')}`, '演示关联', false, true);
    if (i > 7 && i % 3 === 0) connect(id, `${cluster.id}-${String(i - 6).padStart(3, '0')}`, '演示关联', false, true);
  }
}
const output = {
  title: '潮汐档案 · 夜航知识星系',
  scope: '仅用于产品/UI设计的原创样例，不是完整小说或真实提取结果',
  counts: { nodes: nodes.length, anchors: anchors.length, densityFixtures: nodes.length - anchors.length, edges: edges.length },
  clusters, nodes, edges
};
const destination = path.join(__dirname, 'sample-data.json');
fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`Created ${output.counts.nodes} sample objects (${output.counts.anchors} story anchors, ${output.counts.densityFixtures} explicit density fixtures) and ${output.counts.edges} sample edges.`);
