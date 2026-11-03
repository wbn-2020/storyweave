(() => {
  'use strict';
  const views = ['overview', 'outline', 'canvas', 'editor', 'world', 'review', 'export'];
  const key = 'storyweave.prototype.design-1';
  const $ = id => document.getElementById(id);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const originalSource = '账本来自城南旧书铺。寄信人没有署名，许照尚未解释自己与账本的关系。';
  const sampleSource = '账本原藏于城北钟楼档案室。许照把它送到旧书铺，故意留下一枚旧藏印，但还没有说出原因。';
  const initialChapters = {
    ch01: { index: '01', name: '旧账本', summary: '林舟收到匿名来信，在城南旧书铺找到一本被抹去名字的账本。', action: '修复空白页，辨认留下的藏印。', turn: '许照知道这本账，却拒绝解释。', body: '信是在雾最浓的时候送来的。\n\n林舟打开门，台阶上只有一个湿透的信封，封口压着一根细细的红线。纸上没有署名，只写着城南旧书铺的地址。\n\n铺子的老板把账本推到他面前，说：“你不是第一个找它的人。”\n\n最后一页的名字被刮掉了。林舟用指腹碰了碰纸的凹处，在边缘看见一枚旧藏印。\n\n门外，许照收起伞。他看见账本时停了一下，却只问：“信是谁送的？”' },
    ch02: { index: '02', name: '怀疑动机', summary: '许照的沉默，让林舟开始怀疑账本被送到这里的目的。', action: '比较匿名信与账本的藏印，追问许照。', turn: '线索指向城北钟楼，林舟决定亲自查明。', body: '许照站在窗边，背对着他。雨声很轻，雾却把两人的距离拉得很远。\n\n“你见过这个印。”林舟说。\n\n许照没有回答。他把袖口折起来，露出一道很旧的伤痕。林舟看见那道伤痕，忽然不确定自己应该继续问什么。\n\n“账本上的人都去了哪里？”\n\n“你应该先问，为什么他们的名字还在。”\n\n窗外的钟楼没有钟声。林舟合上账本，第一次觉得这本薄薄的册子，比一座城更重。' },
    ch03: { index: '03', name: '钟楼对峙', summary: '林舟与许照在钟楼相对，旧藏印与隐瞒的来源终于交汇。', action: '进入档案室，核对藏印和失踪者的名单。', turn: '许照承认送出账本，却留下一个更危险的问题。', body: '城北的台阶一共四十九级，林舟数了两遍。\n\n档案室的门开着，风把旧纸翻成一片片低声的耳语。许照没有站在门口，而是坐在停摆的钟下面。\n\n林舟把账本摊开，问：“你为什么让我找到它？”\n\n许照抬起头。“因为再没有人记得他们了。”\n\n钟楼外，雾开始向相反的方向流动。' }
  };
  const nodes = {
    ledger: { title: '旧账本', kind: '情节节点 · CH01', chapter: 'ch01', description: '匿名来信把林舟带到旧书铺。账本是谜题的入口，不是全部答案。', intent: '让林舟得到一条可以验证的线索，并留下来源问题。', refs: ['lin', 'f03'] },
    motive: { title: '怀疑动机', kind: '情节节点 · CH02', chapter: 'ch02', description: '许照的沉默是行动，不是空白。林舟需要判断这份沉默在保护谁。', intent: '把外部线索转成两人的信任冲突，让主角决定前往钟楼。', refs: ['lin', 'xu', 'f03'] },
    tower: { title: '钟楼对峙', kind: '情节节点 · CH03', chapter: 'ch03', description: '故事里的线索与人物选择在同一场景交汇。来源揭晓不应取代人物的代价。', intent: '回应账本来源，同时把悬念转到许照送出账本的原因。', refs: ['xu', 'bell', 'f03'] },
    lin: { title: '林舟', kind: '人物节点', chapter: 'ch01', description: '账本修复师。他相信记录，但越来越难分辨记录与事实。', intent: '让主角通过一次次选择建立自己的判断，而不是只接收答案。', refs: ['lin', 'f03'] },
    xu: { title: '许照', kind: '人物节点', chapter: 'ch02', description: '雾城巡夜人。他知道更多，但每一次隐瞒都有一个需要解释的理由。', intent: '用具体行为表达隐瞒，把理由留给后续对峙。', refs: ['xu', 'bell'] },
    f03: { title: 'F03 · 账本来源', kind: '伏笔节点', chapter: 'ch01', description: originalSource, intent: '在第一章埋下来源问题，第三章回应出处与送出它的人。', refs: ['f03', 'xu', 'bell'] },
    bell: { title: '城北钟楼', kind: '世界设定', chapter: 'ch03', description: '雾城唯一能辨认雾潮方向的地方，地下有一间旧档案室。', intent: '把钟楼作为有规则、有历史的场景，而不是方便揭晓答案的舞台。', refs: ['bell', 'f03'] }
  };
  const settings = {
    lin: { category: 'characters', initial: '舟', title: '林舟', kind: '人物 · 记录者', description: '账本修复师，相信每一个被擦去的名字都留下了痕迹。', attributes: [['核心动机', '找出失踪者的名字为什么被抹去。'], ['人物边界', '不掌握超自然能力；依据纸张、藏印和目击记录判断。'], ['来源', '作者设定 · 人物卡 / 第一章'], ['关联章节', '第一章、第二章、第三章']] },
    xu: { category: 'characters', initial: '照', title: '许照', kind: '人物 · 隐瞒者', description: '雾城巡夜人。沉默不是没有答案，而是不愿承担说出答案的后果。', attributes: [['核心动机', '保护不能再被城里人记起的人。'], ['人物边界', '知道钟楼档案室的历史，但并非无所不知。'], ['来源', '作者设定 · 人物卡 / 第二章'], ['关联章节', '第二章、第三章']] },
    bell: { category: 'world', initial: '钟', title: '城北钟楼', kind: '世界 · 空间规则', description: '城里唯一能辨认雾潮方向的地方。停摆的钟和地下档案室，共用一段历史。', attributes: [['空间规则', '城南旧书铺到城北钟楼需要穿过河岸。'], ['使用边界', '钟楼不提供人物尚未获得的答案。'], ['来源', '作者设定 · 世界卡 / 第三章']] },
    fog: { category: 'world', initial: '雾', title: '雾潮', kind: '世界 · 自然规则', description: '雾只会遮蔽方向与声音，不会凭空制造真实记录。', attributes: [['已确认规则', '雾潮有可观测方向，记录可能被人为更改。'], ['来源', '作者设定 · 世界卡'], ['关联章节', '全卷背景']] },
    f03: { category: 'foreshadow', initial: '线', title: 'F03 · 账本来源', kind: '伏笔 · 来源与回收', description: originalSource, attributes: [['埋设位置', '第一章 · 旧账本'], ['回收位置', '第三章 · 钟楼对峙'], ['确认状态', '作者维护的设定；修改需经过影响审阅']] }
  };
  const defaultIntent = '写一个关于记录与信任的故事：林舟追查账本中的空白名字，必须在证据和许照的沉默之间作出选择。';
  let state = { view: 'canvas', chapter: 'ch02', node: 'motive', worldTab: 'characters', setting: 'lin', preview: 'md', intent: defaultIntent, source: originalSource, chapters: structuredClone(initialChapters), drafts: [], versions: [], change: { from: originalSource, to: sampleSource, origin: '示例建议' }, reviewed: false, confirmed: false, previousSource: null, accepted: {}, focus: false };
  let storageAvailable = true;
  let undo = null;
  let cursor = null;
  let editingIntent = false;
  let statusTimer;
  const snapshot = label => ({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label, source: state.source, intent: state.intent, chapters: structuredClone(state.chapters), date: new Date().toISOString() });
  try {
    const loaded = JSON.parse(localStorage.getItem(key) || 'null');
    if (loaded?.version === 'design-1') {
      const s = loaded.state;
      if (s && typeof s === 'object') {
        for (const id of Object.keys(initialChapters)) {
          for (const field of ['body', 'summary', 'action', 'turn']) if (typeof s.chapters?.[id]?.[field] === 'string') state.chapters[id][field] = s.chapters[id][field].slice(0, field === 'body' ? 100000 : 1000);
        }
        for (const field of ['source', 'intent']) if (typeof s[field] === 'string') state[field] = s[field].slice(0, 1000);
        if (views.includes(s.view)) state.view = s.view;
        if (Object.hasOwn(initialChapters, s.chapter)) state.chapter = s.chapter;
        if (Object.hasOwn(nodes, s.node)) state.node = s.node;
        if (Object.hasOwn(settings, s.setting)) state.setting = s.setting;
        if (['characters', 'world', 'foreshadow'].includes(s.worldTab)) state.worldTab = s.worldTab;
        if (['md', 'json'].includes(s.preview)) state.preview = s.preview;
        state.confirmed = Boolean(s.confirmed);
        state.reviewed = Boolean(s.reviewed);
        if (typeof s.previousSource === 'string') state.previousSource = s.previousSource.slice(0, 1000);
        if (s.change && typeof s.change.from === 'string' && typeof s.change.to === 'string') state.change = { from: s.change.from.slice(0, 1000), to: s.change.to.slice(0, 1000), origin: s.change.origin === '作者修改' ? '作者修改' : '示例建议' };
        if (Array.isArray(s.drafts)) state.drafts = s.drafts.filter(d => typeof d.title === 'string' && typeof d.intent === 'string').slice(-15).map(d => ({ title: d.title.slice(0, 40), intent: d.intent.slice(0, 600), genre: typeof d.genre === 'string' ? d.genre.slice(0, 20) : '未分类' }));
        if (Array.isArray(s.versions)) state.versions = s.versions.filter(v => typeof v.label === 'string' && typeof v.source === 'string' && v.chapters && Object.keys(initialChapters).every(id => typeof v.chapters[id]?.body === 'string')).slice(-6);
      }
    }
  } catch { storageAvailable = false; }
  if (!state.versions.length) state.versions.push(snapshot('v0.1 · 初始故事骨架'));
  const savedHash = location.hash.slice(1);
  if (views.includes(savedHash)) state.view = savedHash;

  function save() {
    try { localStorage.setItem(key, JSON.stringify({ version: 'design-1', state })); storageAvailable = true; }
    catch { storageAvailable = false; }
    $('storage-label').textContent = storageAvailable ? '本地创作空间' : '当前会话模式';
    $('storage-description').textContent = storageAvailable ? '此浏览器内保存 · 可导出备份' : '保存不可用，请及时导出';
    $('editor-save-state').textContent = storageAvailable ? '已保存到此浏览器' : '未持久保存 · 请导出';
  }
  function announce(text) {
    $('live-status').textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('live-status').textContent = ''; }, 4500);
  }
  function addVersion(label) {
    state.versions.push(snapshot(label));
    state.versions = state.versions.slice(-6);
    save();
  }
  function navigate(view) {
    if (!views.includes(view)) return;
    state.view = view;
    render();
    save();
    history.replaceState(null, '', '#' + view);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function chooseChapter(id, view) {
    if (!Object.hasOwn(state.chapters, id)) return;
    state.chapter = id;
    cursor = null;
    if (view) navigate(view); else { render(); save(); }
  }
  function openSetting(id) {
    if (!Object.hasOwn(settings, id)) return;
    state.setting = id;
    state.worldTab = settings[id].category;
    navigate('world');
  }
  function writeSelected() {
    chooseChapter(nodes[state.node].chapter, 'editor');
    $('chapter-body').focus();
  }
  function prepareChange(to = sampleSource, origin = '示例建议') {
    if (!to.trim() || to.trim() === state.source) { announce('请先准备一个与当前不同的来源设定。'); return; }
    state.change = { from: state.source, to: to.trim(), origin };
    state.reviewed = false;
    $('ack-impact').checked = false;
    navigate('review');
  }
  function chapterButtons(container, classes = '') {
    container.replaceChildren();
    Object.entries(state.chapters).forEach(([id, ch]) => {
      const button = make('button', classes + (id === state.chapter ? ' is-current' : ''));
      button.type = 'button'; button.dataset.chapter = id;
      button.append(make('span', '', ch.index));
      const label = make('span'); label.append(make('strong', '', ch.name));
      if (container.id === 'outline-chapters') label.append(make('small', '', ch.turn));
      button.append(label); container.append(button);
    });
  }
  function renderGraph() {
    const selected = nodes[state.node];
    document.querySelectorAll('[data-node]').forEach(button => { button.classList.toggle('is-selected', button.dataset.node === state.node); button.setAttribute('aria-pressed', String(button.dataset.node === state.node)); });
    $('inspector-kind').textContent = selected.kind;
    $('inspector-title').textContent = selected.title;
    $('inspector-description').textContent = state.node === 'f03' ? state.source : selected.description;
    $('inspector-intent').textContent = state.node === 'motive' ? state.chapters.ch02.summary : selected.intent;
    $('inspector-references').replaceChildren();
    selected.refs.forEach(id => {
      const button = make('button', '', settings[id].title);
      button.type = 'button'; button.dataset.openWorld = id;
      $('inspector-references').append(button);
    });
    $('inspector-chapter-label').textContent = `打开第${state.chapters[selected.chapter].index}章`;
    $('f03-node-body').textContent = state.source;
    $('f03-node-status').textContent = state.confirmed ? '来源已确认' : '待回收';
    $('ledger-node-body').textContent = state.chapters.ch01.summary;
    $('motive-node-body').textContent = state.chapters.ch02.summary;
    $('tower-node-body').textContent = state.chapters.ch03.summary;
    $('canvas-graph').classList.toggle('is-focused', state.focus);
    document.querySelector('[data-action="focus-plots"]').setAttribute('aria-pressed', String(state.focus));
    $('focus-label').textContent = state.focus ? '显示全部关联' : '聚焦情节';
    $('canvas-version').textContent = state.versions.at(-1).label;
    $('canvas-review-label').textContent = state.confirmed ? '回看审阅与版本' : '查看建议与影响';
    const graph = $('canvas-graph');
    if (graph.getBoundingClientRect().width === 0) return;
    const bounds = graph.getBoundingClientRect();
    const lines = $('map-connections'); lines.replaceChildren();
    $('map-lines').setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
    const links = [['ledger', 'motive', 'plot'], ['motive', 'tower', 'plot'], ['lin', 'ledger', 'character'], ['xu', 'motive', 'character'], ['f03', 'ledger', 'thread'], ['f03', 'tower', 'thread'], ['bell', 'tower', 'thread']];
    links.forEach(([from, to, kind]) => {
      if (state.focus && kind !== 'plot') return;
      const a = graph.querySelector(`[data-node="${from}"]`).getBoundingClientRect();
      const b = graph.querySelector(`[data-node="${to}"]`).getBoundingClientRect();
      let x1 = a.left - bounds.left + a.width / 2, y1 = a.top - bounds.top + a.height / 2;
      let x2 = b.left - bounds.left + b.width / 2, y2 = b.top - bounds.top + b.height / 2;
      let d;
      if (Math.abs(y2 - y1) < 80 && Math.abs(x2 - x1) > 80) {
        const sign = Math.sign(x2 - x1); x1 += sign * a.width / 2; x2 -= sign * b.width / 2;
        const mid = (x1 + x2) / 2; d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
      } else {
        const sign = Math.sign(y2 - y1) || 1; y1 += sign * a.height / 2; y2 -= sign * b.height / 2;
        const mid = (y1 + y2) / 2; d = `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
      }
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', kind === 'plot' ? '#ad725c' : kind === 'thread' ? '#8b9fa7' : '#a7b298'); path.setAttribute('stroke-width', kind === 'plot' ? '1.8' : '1.2');
      if (kind === 'thread') path.setAttribute('stroke-dasharray', '4 4');
      if (kind !== 'character') path.setAttribute('marker-end', `url(#arrow-${kind === 'plot' ? 'plot' : 'thread'})`);
      lines.append(path);
    });
  }
  function renderOutline() {
    chapterButtons($('outline-chapters'));
    const ch = state.chapters[state.chapter];
    $('outline-chapter-index').textContent = 'CHAPTER ' + ch.index;
    $('outline-chapter-title').textContent = `第${ch.index}章 · ${ch.name}`;
    for (const field of ['summary', 'action', 'turn']) $('outline-' + field).value = ch[field];
  }
  const sentenceSuggestions = [
    { id: 'detail', title: '让动作承担情绪', text: '林舟把手指停在那枚藏印上，没有再把问题问第二遍。' },
    { id: 'hook', title: '留一个可继续的疑问', text: '他忽然意识到，许照不是不愿说出答案，而是在等他先作出选择。' }
  ];
  function renderSuggestions() {
    const container = $('editor-suggestions'); container.replaceChildren();
    sentenceSuggestions.forEach(suggestion => {
      const item = make('article', 'suggestion-card');
      item.append(make('span', 'suggestion-meta', '示例建议 · ' + suggestion.title), make('p', '', suggestion.text));
      const actions = make('div', 'suggestion-actions');
      for (const [action, label] of [['insert-suggestion', '插入光标处'], ['reject-suggestion', '拒绝本条']]) {
        const button = make('button', '', label); button.type = 'button'; button.dataset.action = action; button.dataset.suggestion = suggestion.id;
        if (state.accepted[state.chapter + ':' + suggestion.id]) { button.disabled = true; button.textContent = state.accepted[state.chapter + ':' + suggestion.id] === 'accepted' ? '已插入' : '已拒绝'; }
        actions.append(button);
      }
      item.append(actions); container.append(item);
    });
    const validUndo = undo && undo.chapter === state.chapter && state.chapters[state.chapter].body === undo.after;
    $('undo-suggestion').disabled = !validUndo;
    $('undo-note').textContent = validUndo ? '可撤销刚插入的示例；继续编辑后会保护你的新改动。' : undo ? '正文已变化，为保护你的编辑，请手动移除不需要的句子。' : '未接受建议时，不会改动正文。';
  }
  function renderEditor() {
    chapterButtons($('editor-chapters'));
    const ch = state.chapters[state.chapter];
    $('editor-chapter-index').textContent = 'CHAPTER ' + ch.index;
    $('editor-chapter-title').textContent = `第${ch.index}章 · ${ch.name}`;
    $('chapter-body').value = ch.body;
    $('chapter-word-count').textContent = ch.body.replace(/\s/g, '').length.toLocaleString('zh-CN') + ' 字';
    renderSuggestions();
  }
  function renderWorld() {
    settings.f03.description = state.source;
    document.querySelectorAll('[data-world-tab]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.worldTab === state.worldTab)); button.tabIndex = button.dataset.worldTab === state.worldTab ? 0 : -1; });
    const tabId = { characters: 'tab-characters', world: 'tab-world', foreshadow: 'tab-foreshadow' }[state.worldTab];
    $('world-cards').setAttribute('aria-labelledby', tabId); $('world-cards').replaceChildren();
    Object.entries(settings).filter(([, setting]) => setting.category === state.worldTab).forEach(([id, setting]) => {
      const button = make('button', 'world-card' + (state.setting === id ? ' is-selected' : '')); button.type = 'button'; button.dataset.setting = id;
      button.append(make('span', 'card-initial', setting.initial), make('h3', '', setting.title), make('small', '', setting.kind), make('p', '', setting.description), make('span', 'card-source', '作者设定 · 有关联出处'));
      $('world-cards').append(button);
    });
    const setting = settings[state.setting];
    $('setting-kind').textContent = setting.kind; $('setting-title').textContent = setting.title; $('setting-description').textContent = setting.description;
    $('setting-attributes').replaceChildren();
    setting.attributes.forEach(([label, text]) => { const item = make('div', 'setting-attribute'); item.append(make('span', '', label), make('p', '', text)); $('setting-attributes').append(item); });
    $('source-edit').hidden = state.setting !== 'f03';
    $('source-draft').value = state.source;
    $('setting-actions').replaceChildren();
    const button = make('button', 'button quiet full-width', state.setting === 'f03' ? '查看当前来源版本' : '查看关联章节');
    button.type = 'button'; button.dataset.action = state.setting === 'f03' ? 'show-latest-version' : 'open-setting-chapter'; $('setting-actions').append(button);
  }
  function renderReview() {
    $('pending-review').hidden = state.reviewed;
    $('completed-review').hidden = !state.reviewed;
    $('review-nav-dot').hidden = state.reviewed;
    $('review-origin').textContent = state.change.origin;
    $('review-reason').textContent = '这份来源提议把旧书铺、许照与钟楼联系起来。下方是预置影响示例；它不表示系统已自动校验所有正文。';
    $('review-before').textContent = state.change.from;
    $('review-after').textContent = state.change.to;
    $('confirm-change').disabled = !$('ack-impact').checked || state.reviewed;
    $('completed-title').textContent = state.confirmed ? '设定已更新，正文由你决定' : '这次建议没有被采用';
    $('completed-description').textContent = state.confirmed ? '画布与来源设定同步为新版本。三章正文保持原样，等待你逐章审阅。' : '原有来源设定和正文保持不变，你可以继续创作或再准备一个修改。';
    $('confirmed-source').textContent = state.source;
    $('completed-actions').replaceChildren();
    const actions = state.confirmed ? [['undo-source', '撤销本次设定确认'], ['canvas', '回到故事画布']] : [['review-example', '再次查看示例'], ['canvas', '回到故事画布']];
    actions.forEach(([action, label]) => { const button = make('button', 'button quiet', label); button.type = 'button'; if (action === 'canvas') button.dataset.view = action; else button.dataset.action = action; $('completed-actions').append(button); });
    $('version-list').replaceChildren();
    [...state.versions].reverse().forEach(v => { const button = make('button', 'version-item'); button.type = 'button'; button.dataset.version = v.id; button.append(make('strong', '', v.label), make('small', '', '只读快照 · 正文和设定')); $('version-list').append(button); });
  }
  function assets() {
    return { schemaVersion: 'storyweave-design-1', product: 'StoryWeave', title: '雾城来信', sample: true, intent: state.intent, chapters: state.chapters, canon: { ledgerSource: state.source }, storyNodes: Object.entries(nodes).map(([id, node]) => ({ id, chapter: node.chapter, title: node.title, references: node.refs })), relationships: [{ from: 'ledger', to: 'motive', type: 'motivates' }, { from: 'motive', to: 'tower', type: 'leads_to' }, { from: 'f03', to: 'ledger', type: 'planted_in' }, { from: 'f03', to: 'tower', type: 'resolved_in' }], versions: state.versions };
  }
  function manuscript() {
    return '# 雾城来信\n\n> 织章交互原型 · 原创样例与当前本地编辑\n\n## 第一卷 · 雾起\n\n' + Object.values(state.chapters).map(ch => `### 第${ch.index}章 · ${ch.name}\n\n${ch.body}`).join('\n\n');
  }
  function renderExport() {
    $('export-summary').textContent = `3 个章节 · ${Object.values(state.chapters).reduce((n, ch) => n + ch.body.replace(/\s/g, '').length, 0).toLocaleString('zh-CN')} 字 · ${state.versions.length} 个本地快照`;
    document.querySelectorAll('[data-preview]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.preview === state.preview)); button.tabIndex = button.dataset.preview === state.preview ? 0 : -1; });
    $('export-preview').setAttribute('aria-labelledby', 'preview-' + state.preview);
    const text = state.preview === 'md' ? manuscript() : JSON.stringify(assets(), null, 2);
    $('export-preview').textContent = text.length > 15000 ? text.slice(0, 15000) + '\n…预览截断，下载包含完整本地内容。' : text;
    $('export-current-version').textContent = state.versions.at(-1).label.split(' · ')[0];
  }
  function renderOverview() {
    $('overview-intent').textContent = state.intent;
    $('overview-word-count').textContent = Object.values(state.chapters).reduce((n, ch) => n + ch.body.replace(/\s/g, '').length, 0).toLocaleString('zh-CN') + ' 字 · 当前原型正文';
    $('project-drafts').replaceChildren();
    if (!state.drafts.length) $('project-drafts').append(make('div', 'empty-seeds', '还没有新的作品意图。可以先留下一颗故事种子，再决定是否展开。'));
    state.drafts.forEach(draft => { const card = make('article', 'draft-card'); card.append(make('small', '', draft.genre), make('strong', '', draft.title), make('p', '', draft.intent)); $('project-drafts').append(card); });
  }
  function render() {
    document.querySelectorAll('[data-view-panel]').forEach(panel => { panel.hidden = panel.dataset.viewPanel !== state.view; });
    document.querySelectorAll('.side-nav [data-view]').forEach(button => { button.classList.toggle('is-active', button.dataset.view === state.view); if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    $('main').dataset.currentView = state.view;
    document.title = '织章 StoryWeave · ' + document.querySelector(`[data-view-panel="${state.view}"] h1`).textContent;
    document.querySelectorAll('.path-chapters [data-chapter]').forEach(button => { button.classList.toggle('is-current', button.dataset.chapter === state.chapter); });
    renderOverview(); renderOutline(); renderGraph(); renderEditor(); renderWorld(); renderReview(); renderExport();
    requestAnimationFrame(renderGraph);
  }
  function download(content, type, filename) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = make('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('已生成本地文件：' + filename);
  }
  function showVersion(id) {
    const v = state.versions.find(item => item.id === id); if (!v) return;
    $('version-dialog-title').textContent = v.label;
    $('version-dialog-description').textContent = '只读本地快照。查看不会覆盖当前正文或设定。';
    $('version-dialog-source').textContent = v.source;
    $('version-dialog-body').textContent = Object.entries(initialChapters).map(([chapter, ch]) => `第${ch.index}章 · ${ch.name}\n\n${v.chapters[chapter].body}`).join('\n\n');
    $('version-dialog').showModal();
  }
  function showProjectDialog(edit) {
    editingIntent = edit;
    $('project-form').reset();
    $('project-dialog-title').textContent = edit ? '调整当前作品意图' : '创建作品意图';
    $('project-name').value = edit ? '雾城来信' : ''; $('project-name').readOnly = edit;
    $('project-intent').value = edit ? state.intent : '';
    $('project-dialog-note').textContent = edit ? '只调整这本样例作品的创作意图，不会覆盖大纲或正文。' : '创建一张本地作品意图卡。现有样例画布和正文不会被替换。';
    $('project-dialog').showModal();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button, a');
    if (!button || button.disabled) return;
    if (button.dataset.brandHome !== undefined) { event.preventDefault(); navigate('canvas'); return; }
    if (button.dataset.view) { navigate(button.dataset.view); return; }
    if (button.dataset.chapter) { chooseChapter(button.dataset.chapter); return; }
    if (button.dataset.openChapter) { chooseChapter(button.dataset.openChapter, 'editor'); return; }
    if (button.dataset.openWorld) { openSetting(button.dataset.openWorld); return; }
    if (button.dataset.node) {
      state.node = button.dataset.node;
      state.chapter = nodes[state.node].chapter;
      renderGraph();
      document.querySelectorAll('.path-chapters [data-chapter]').forEach(item => { item.classList.toggle('is-current', item.dataset.chapter === state.chapter); });
      save();
      return;
    }
    if (button.dataset.worldTab) { state.worldTab = button.dataset.worldTab; state.setting = Object.keys(settings).find(id => settings[id].category === state.worldTab); renderWorld(); save(); return; }
    if (button.dataset.setting) { state.setting = button.dataset.setting; renderWorld(); save(); return; }
    if (button.dataset.preview) { state.preview = button.dataset.preview; renderExport(); save(); return; }
    if (button.dataset.version) { showVersion(button.dataset.version); return; }
    if (button.hasAttribute('data-close-dialog')) { button.closest('dialog').close(); return; }
    const action = button.dataset.action;
    if (action === 'write-selected') writeSelected();
    if (action === 'focus-plots') { state.focus = !state.focus; renderGraph(); save(); }
    if (action === 'help') $('help-dialog').showModal();
    if (action === 'create-project') showProjectDialog(false);
    if (action === 'edit-intent') showProjectDialog(true);
    if (action === 'generate-example') { Object.keys(state.accepted).filter(id => id.startsWith(state.chapter + ':')).forEach(id => { delete state.accepted[id]; }); renderSuggestions(); announce('已显示预置原创建议，没有调用模型。'); }
    if (action === 'insert-suggestion') {
      const suggestion = sentenceSuggestions.find(s => s.id === button.dataset.suggestion); if (!suggestion) return;
      const body = state.chapters[state.chapter].body;
      const position = cursor?.chapter === state.chapter ? Math.min(cursor.position, body.length) : body.length;
      const insertion = '\n\n' + suggestion.text;
      if (body.length + insertion.length > 100000) { announce('已到原型正文上限，请先导出或整理内容。'); return; }
      const after = body.slice(0, position) + insertion + body.slice(position);
      undo = { chapter: state.chapter, before: body, after, suggestion: suggestion.id };
      state.chapters[state.chapter].body = after;
      state.accepted[state.chapter + ':' + suggestion.id] = 'accepted';
      cursor = { chapter: state.chapter, position: position + insertion.length };
      renderEditor(); save(); announce('只在光标处插入示例，没有替换选中的原文。');
    }
    if (action === 'reject-suggestion') { state.accepted[state.chapter + ':' + button.dataset.suggestion] = 'rejected'; renderSuggestions(); save(); }
    if (action === 'undo-suggestion' && undo && undo.chapter === state.chapter && state.chapters[state.chapter].body === undo.after) {
      state.chapters[state.chapter].body = undo.before; delete state.accepted[state.chapter + ':' + undo.suggestion]; undo = null; renderEditor(); save(); announce('示例插入已撤销。');
    }
    if (action === 'save-version') { addVersion('v0.' + (state.versions.length + 1) + ' · 手动正文快照'); render(); announce('已保留当前三章正文与设定快照。'); }
    if (action === 'review-example') { if (state.confirmed) navigate('review'); else prepareChange(); }
    if (action === 'fill-source-example') $('source-draft').value = sampleSource;
    if (action === 'review-source') prepareChange($('source-draft').value, '作者修改');
    if (action === 'dismiss-change') { state.reviewed = true; renderReview(); save(); announce('没有改动当前设定或正文。'); }
    if (action === 'confirm-change' && $('ack-impact').checked && !state.reviewed) {
      if (state.source !== state.change.from) { announce('当前来源已变化，请重新准备和审阅修改。'); return; }
      state.previousSource = state.source; state.source = state.change.to; state.confirmed = true; state.reviewed = true;
      addVersion('v0.' + (state.versions.length + 1) + ' · 确认来源设定'); render(); announce('来源设定与画布已更新。正文保持原样。');
    }
    if (action === 'undo-source' && state.previousSource !== null) {
      state.source = state.previousSource; state.previousSource = null; state.confirmed = false; state.reviewed = false;
      state.change = { from: state.source, to: sampleSource, origin: '示例建议' }; $('ack-impact').checked = false;
      addVersion('v0.' + (state.versions.length + 1) + ' · 撤销来源确认'); render(); announce('只恢复来源设定，没有回滚正文编辑。');
    }
    if (action === 'open-setting-chapter') chooseChapter(state.setting === 'lin' ? 'ch01' : state.setting === 'xu' ? 'ch02' : 'ch03', 'editor');
    if (action === 'show-latest-version') showVersion(state.versions.at(-1).id);
    if (action === 'download-md') download(manuscript(), 'text/markdown; charset=utf-8', '雾城来信-原型正文.md');
    if (action === 'download-json') download(JSON.stringify(assets(), null, 2), 'application/json', 'storyweave-design-assets.json');
  });
  $('chapter-body').addEventListener('input', event => {
    state.chapters[state.chapter].body = event.target.value;
    cursor = { chapter: state.chapter, position: event.target.selectionEnd };
    $('chapter-word-count').textContent = event.target.value.replace(/\s/g, '').length.toLocaleString('zh-CN') + ' 字';
    renderSuggestions(); save();
  });
  for (const event of ['keyup', 'click', 'select']) $('chapter-body').addEventListener(event, () => { cursor = { chapter: state.chapter, position: $('chapter-body').selectionEnd }; });
  $('outline-form').addEventListener('submit', event => {
    event.preventDefault();
    for (const field of ['summary', 'action', 'turn']) state.chapters[state.chapter][field] = $('outline-' + field).value.trim();
    save(); renderGraph(); announce('章节意图已保存，正文没有被覆盖。');
  });
  $('project-form').addEventListener('submit', event => {
    event.preventDefault();
    const intent = $('project-intent').value.trim(); const title = $('project-name').value.trim();
    if (!title || !intent) return;
    if (editingIntent) state.intent = intent; else state.drafts.push({ title, intent, genre: $('project-genre').value });
    state.drafts = state.drafts.slice(-15); save(); renderOverview(); $('project-dialog').close(); announce(editingIntent ? '当前作品意图已更新。' : '已保存本地故事种子卡；原作品未被替换。');
  });
  $('ack-impact').addEventListener('change', renderReview);
  window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (views.includes(view)) { state.view = view; render(); save(); } });
  if (window.ResizeObserver) new ResizeObserver(renderGraph).observe($('canvas-graph'));
  window.__prototype = { product: 'StoryWeave', version: 'design-1', views };
  render(); save();
})();
