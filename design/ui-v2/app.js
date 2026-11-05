(() => {
  'use strict';

  const root = document.getElementById('sw-night-v2');
  if (!root) return;
  const data = JSON.parse(root.querySelector('[data-galaxy-data]').textContent);
  const byId = new Map(data.nodes.map(node => [node.id, node]));
  const colors = new Map(data.clusters.map(cluster => [cluster.id, cluster.color]));
  const anchors = data.nodes.filter(node => node.anchor);
  const state = { page: 'galaxy', selected: 'rule', cluster: 'all', view: 'space', glow: 0.8, labels: true, turn: -0.1, tilt: -0.46, zoom: 1, panX: 0, panY: 0, sourceOpen: false, inputOpen: false, review: 'boundary' };
  const decisions = new Map();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderPending = false;
  let focusAnimation = null;

  function rgb(hex) {
    return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
  }
  function persist() {
    if (!window.zcode?.setWidgetState) return;
    window.zcode.setWidgetState({
      modelContent: { kind: 'storyweave-galaxy-v2', page: state.page, selected: state.selected, cluster: state.cluster, view: state.view },
      privateContent: { turn: state.turn, tilt: state.tilt, zoom: state.zoom, glow: state.glow, labels: state.labels }
    }).catch(() => {});
  }
  function restore(snapshot) {
    if (snapshot?.modelContent?.kind !== 'storyweave-galaxy-v2') return;
    const saved = snapshot.modelContent;
    if (['galaxy', 'writing', 'review'].includes(saved.page)) state.page = saved.page;
    if (byId.has(saved.selected)) state.selected = saved.selected;
    if (saved.cluster === 'all' || data.clusters.some(cluster => cluster.id === saved.cluster)) state.cluster = saved.cluster;
    if (['space', 'list'].includes(saved.view)) state.view = saved.view;
    const privateState = snapshot.privateContent;
    for (const [name, min, max] of [['turn', -Math.PI * 4, Math.PI * 4], ['tilt', -1.2, 1.2], ['zoom', 0.5, 2.5], ['glow', 0, 1]]) {
      if (Number.isFinite(privateState?.[name])) state[name] = Math.max(min, Math.min(max, privateState[name]));
    }
    if (typeof privateState?.labels === 'boolean') state.labels = privateState.labels;
    renderPage(false);
    renderDetail();
    scheduleDraw();
  }
  function project(node, width, height, local) {
    let [x, y, z] = node.position;
    const turn = local ? -0.12 : state.turn;
    const tilt = local ? -0.32 : state.tilt;
    if (local) { x = (x - 8) * 0.9; y = (y - 25) * 1.45; z = z * 0.8; }
    const rx = x * Math.cos(turn) + z * Math.sin(turn);
    const rz = -x * Math.sin(turn) + z * Math.cos(turn);
    const ry = y * Math.cos(tilt) - rz * Math.sin(tilt);
    const depth = y * Math.sin(tilt) + rz * Math.cos(tilt);
    const perspective = 690 / (690 - depth);
    const scale = Math.min(width / (local ? 440 : 650), height / (local ? 250 : 340)) * (local ? 1 : state.zoom);
    return { x: width * 0.5 + rx * scale * perspective + (local ? 0 : state.panX), y: height * 0.62 - ry * scale * perspective + (local ? 0 : state.panY), z: depth, perspective, radius: (node.anchor ? 3.2 : 1.08) * perspective };
  }
  function visibleNode(node, local) {
    if (local) return ['lin', 'song', 's4', 'rule', 'place', 'clue'].includes(node.id) || (node.fixture && ['events', 'rules', 'people'].includes(node.cluster) && Number(node.id.slice(-3)) % 3 === 0);
    return state.cluster === 'all' || node.cluster === state.cluster;
  }
  function createRenderer(canvas) {
    let gl = null;
    try { gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false }); } catch {}
    if (!gl) return { mode: 'Canvas 三维投影', context: canvas.getContext('2d') };
    function shader(type, source) {
      const value = gl.createShader(type);
      gl.shaderSource(value, source);
      gl.compileShader(value);
      if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
      return value;
    }
    const vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 p; attribute vec4 c; attribute float s; varying vec4 color; void main(){gl_Position=vec4(p,0.0,1.0);gl_PointSize=s;color=c;}');
    const fragment = shader(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec4 color; uniform float points; void main(){float a=1.0;if(points>0.5){float d=length(gl_PointCoord-vec2(0.5))*2.0;float core=exp(-d*d*34.0);float halo=exp(-d*d*5.2)*0.34;a=(core+halo)*(1.0-smoothstep(0.82,1.0,d));}gl_FragColor=vec4(color.rgb,color.a*a);}');
    const program = gl.createProgram();
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    gl.useProgram(program);
    const locations = { p: gl.getAttribLocation(program, 'p'), c: gl.getAttribLocation(program, 'c'), s: gl.getAttribLocation(program, 's'), points: gl.getUniformLocation(program, 'points') };
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(locations.p); gl.vertexAttribPointer(locations.p, 2, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(locations.c); gl.vertexAttribPointer(locations.c, 4, gl.FLOAT, false, 28, 8);
    gl.enableVertexAttribArray(locations.s); gl.vertexAttribPointer(locations.s, 1, gl.FLOAT, false, 28, 24);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    return { mode: 'WebGL 三维投影', gl, program, buffer, locations, draw(vertices, kind) {
      if (!vertices.length) return;
      gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      gl.uniform1f(locations.points, kind === gl.POINTS ? 1 : 0);
      gl.drawArrays(kind, 0, vertices.length / 7);
    } };
  }
  const views = [
    { container: root.querySelector('[data-galaxy]'), local: false },
    { container: root.querySelector('[data-local-galaxy]'), local: true }
  ].map(view => {
    view.canvas = view.container.querySelector('canvas');
    view.labels = view.container.querySelector('[data-labels]');
    view.renderer = createRenderer(view.canvas);
    view.projected = new Map();
    const label = view.container.querySelector('[data-renderer]');
    if (label) label.textContent = `${view.renderer.mode} · 原创展示`;
    return view;
  });
  function neighborSet() {
    const neighbors = new Set([state.selected]);
    data.edges.forEach(edge => {
      if (edge.a === state.selected) neighbors.add(edge.b);
      if (edge.b === state.selected) neighbors.add(edge.a);
    });
    return neighbors;
  }
  function paint(view) {
    const width = view.container.clientWidth;
    const height = view.container.clientHeight;
    if (!width || !height || view.container.closest('[hidden]')) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rw = Math.round(width * dpr), rh = Math.round(height * dpr);
    if (view.canvas.width !== rw || view.canvas.height !== rh) { view.canvas.width = rw; view.canvas.height = rh; }
    view.projected.clear();
    const visible = data.nodes.filter(node => visibleNode(node, view.local));
    const visibleIds = new Set(visible.map(node => node.id));
    visible.forEach(node => view.projected.set(node.id, project(node, width, height, view.local)));
    const neighbors = neighborSet();
    const lines = [], points = [];
    const gl = view.renderer.gl;
    const context = view.renderer.context;
    if (gl) { gl.viewport(0, 0, rw, rh); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    if (context) { context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height); }
    const vertex = (p, color, alpha, size) => [p.x / width * 2 - 1, 1 - p.y / height * 2, ...rgb(color), alpha, size * dpr];
    for (const edge of data.edges) {
      if (!visibleIds.has(edge.a) || !visibleIds.has(edge.b)) continue;
      const a = view.projected.get(edge.a), b = view.projected.get(edge.b);
      const related = edge.a === state.selected || edge.b === state.selected;
      const color = edge.planned ? '#bc9a70' : colors.get(byId.get(edge.a).cluster);
      const alpha = edge.fixture ? (related ? 0.34 : 0.11) : (related ? 0.68 : 0.27);
      if (gl) {
        if (edge.planned) {
          const steps = Math.max(2, Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) / 7));
          for (let i = 0; i < steps; i += 2) {
            const t1 = i / steps, t2 = Math.min((i + 1) / steps, 1);
            const start = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
            const end = { x: a.x + (b.x - a.x) * t2, y: a.y + (b.y - a.y) * t2 };
            lines.push(...vertex(start, color, alpha, 1), ...vertex(end, color, alpha, 1));
          }
        } else lines.push(...vertex(a, color, alpha, 1), ...vertex(b, color, alpha, 1));
      } else {
        context.strokeStyle = color; context.globalAlpha = alpha; context.lineWidth = related ? 1 : 0.6;
        context.setLineDash(edge.planned ? [4, 4] : []); context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
    }
    if (gl) view.renderer.draw(lines, gl.LINES);
    const sorted = visible.slice().sort((a, b) => view.projected.get(a.id).z - view.projected.get(b.id).z);
    for (const node of sorted) {
      const p = view.projected.get(node.id);
      const selected = node.id === state.selected;
      const color = selected ? '#f2d7a7' : colors.get(node.cluster);
      const size = p.radius * (node.anchor ? 6 + state.glow * 6 : 4 + state.glow * 5);
      const alpha = node.anchor ? 1 : (neighbors.has(node.id) ? 0.9 : 0.47 + state.glow * 0.23);
      if (gl) points.push(...vertex(p, color, alpha, Math.max(5, size)));
      else {
        context.globalAlpha = alpha; context.setLineDash([]);
        const radius = p.radius * (node.anchor ? 5 : 3.1) * (0.65 + state.glow * 0.75);
        const gradient = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
        gradient.addColorStop(0, node.anchor ? '#eef8fa' : color); gradient.addColorStop(0.18, color); gradient.addColorStop(1, `${color}00`);
        context.fillStyle = gradient; context.fillRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
      }
    }
    if (gl) view.renderer.draw(points, gl.POINTS);
    if (context) context.globalAlpha = 1;
    renderLabels(view, visible, width, height);
  }
  function renderLabels(view, visible, width, height) {
    view.labels.replaceChildren();
    if (!state.labels) return;
    const candidates = visible.filter(node => node.anchor).sort((a, b) => (b.id === state.selected) - (a.id === state.selected));
    const occupied = [];
    const cap = view.local ? 3 : width < 430 ? 4 : 7;
    let count = 0;
    for (const node of candidates) {
      if (count >= cap) break;
      const p = view.projected.get(node.id);
      if (p.x < 5 || p.x > width - 5 || p.y < 5 || p.y > height - 42) continue;
      const labelWidth = Math.min(148, 24 + node.name.length * 11);
      let left = Math.min(width - labelWidth - 6, Math.max(6, p.x + 9));
      let top = p.y - 14;
      if (node.id === state.selected) top += 18;
      top = Math.max(10, Math.min(height - 50, top));
      let collision = occupied.some(box => left < box.right + 6 && left + labelWidth > box.left - 6 && top < box.bottom + 5 && top + 32 > box.top - 5);
      if (collision) {
        top += 36;
        collision = occupied.some(box => left < box.right + 6 && left + labelWidth > box.left - 6 && top < box.bottom + 5 && top + 32 > box.top - 5);
      }
      if (collision || top > height - 50) continue;
      const label = document.createElement('button'); label.type = 'button'; label.className = `sw-star-label${node.id === state.selected ? ' is-selected' : ''}`;
      label.textContent = node.name; label.style.left = `${left}px`; label.style.top = `${top}px`;
      label.addEventListener('click', () => select(node.id, false));
      view.labels.append(label); occupied.push({ left, right: left + labelWidth, top, bottom: top + 32 }); count++;
    }
    if (!view.local && width > 550 && state.cluster === 'all') {
      for (const cluster of data.clusters) {
        const projected = project({ position: cluster.center }, width, height, false);
        const label = document.createElement('span'); label.className = 'sw-cluster-name'; label.textContent = cluster.title;
        label.style.left = `${Math.max(8, Math.min(width - 105, projected.x - 40))}px`; label.style.top = `${Math.max(18, Math.min(height - 60, projected.y - 67))}px`;
        view.labels.append(label);
      }
    }
  }
  function scheduleDraw() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; views.forEach(paint); });
  }
  function focusNode(node) {
    if (state.page !== 'galaxy') return;
    const view = views[0];
    const width = view.container.clientWidth, height = view.container.clientHeight;
    const targetZoom = Math.max(1.25, state.zoom);
    const from = { zoom: state.zoom, panX: state.panX, panY: state.panY };
    state.zoom = targetZoom; state.panX = 0; state.panY = 0;
    const target = project(node, width, height, false);
    const to = { zoom: targetZoom, panX: width * 0.5 - target.x, panY: height * 0.48 - target.y };
    Object.assign(state, from);
    if (focusAnimation) cancelAnimationFrame(focusAnimation);
    if (reducedMotion) { Object.assign(state, to); scheduleDraw(); persist(); return; }
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / 390); const eased = 1 - Math.pow(1 - t, 3);
      for (const key of ['zoom', 'panX', 'panY']) state[key] = from[key] + (to[key] - from[key]) * eased;
      scheduleDraw();
      if (t < 1) focusAnimation = requestAnimationFrame(step); else { focusAnimation = null; persist(); }
    }
    focusAnimation = requestAnimationFrame(step);
  }
  function select(id, focus) {
    if (!byId.has(id)) return;
    state.selected = id;
    renderDetail(); scheduleDraw();
    if (focus) focusNode(byId.get(id)); else persist();
  }
  function renderDetail() {
    const node = byId.get(state.selected);
    root.querySelector('[data-detail-kind]').textContent = `${node.type} / ${node.status}`;
    root.querySelector('[data-detail-title]').textContent = node.name;
    root.querySelector('[data-detail-text]').textContent = node.detail;
    root.querySelector('[data-detail-source]').textContent = node.source;
    root.querySelector('[data-detail-level]').textContent = node.level;
    root.querySelector('[data-detail-use]').textContent = node.eligibility;
    root.querySelector('[data-source-panel]').textContent = node.excerpt || '作者记录或展示对象：本示例没有此对象的精确正文引用，不用相似句子伪造来源。';
    const list = root.querySelector('[data-detail-relations]'); list.replaceChildren();
    const semantic = data.edges.filter(edge => !edge.fixture && (edge.a === node.id || edge.b === node.id));
    if (!semantic.length) {
      const item = document.createElement('li'); item.textContent = node.fixture ? '仅密度演示关联，不是已提取记忆。' : '本样例暂无已绑定的关系。'; list.append(item);
    }
    semantic.forEach(edge => { const item = document.createElement('li'); item.textContent = `${edge.kind} → ${byId.get(edge.a === node.id ? edge.b : edge.a).name}${edge.planned ? ' / 计划或待核' : ''}`; list.append(item); });
  }
  function renderPage(save = true) {
    root.querySelectorAll('[data-screen]').forEach(screen => { screen.hidden = screen.dataset.screen !== state.page; });
    root.querySelectorAll('[data-page]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.page === state.page)));
    root.querySelectorAll('[data-cluster]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cluster === state.cluster)));
    root.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
    root.querySelector('[data-galaxy]').hidden = state.view === 'list'; root.querySelector('[data-list]').hidden = state.view !== 'list';
    const visible = data.nodes.filter(node => visibleNode(node, false));
    const visibleIds = new Set(visible.map(node => node.id));
    const edgeCount = data.edges.filter(edge => visibleIds.has(edge.a) && visibleIds.has(edge.b)).length;
    root.querySelector('[data-count]').textContent = state.view === 'list' ? `${anchors.filter(node => state.cluster === 'all' || node.cluster === state.cluster).length} 故事对象 / 密度演示不列入事实` : `${visible.length.toLocaleString()} 展示对象 · ${edgeCount.toLocaleString()} 展示关系`;
    const objectList = root.querySelector('[data-list]'); objectList.replaceChildren();
    anchors.filter(node => state.cluster === 'all' || node.cluster === state.cluster).forEach(node => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'sw-object-row';
      const title = document.createElement('span'); title.textContent = node.name;
      const subtitle = document.createElement('small'); subtitle.textContent = `${node.type} / ${node.status}`;
      button.append(title, subtitle); button.addEventListener('click', () => select(node.id, false)); objectList.append(button);
    });
    if (save) persist(); scheduleDraw();
  }
  const reviewItems = {
    boundary: { kind: '规则候选 / 尚未入正式记忆', title: '把限制完整留下来。', proposal: '潮钟只能重放声音，不能重放影像。', version: '正文 r18 · 来源 b42', scope: '全书规则 · 作者需确认', status: '待作者确认', sourceTitle: '原文证据 / 第二章 · 仓库对证', quote: data.nodes.find(node => node.id === 'rule').excerpt, explanation: '这句话首先是角色说法。作者确认它为世界规则后，才形成正式事实；摘要不得丢掉“不能重放影像”的限制。', canConfirm: true },
    stale: { kind: '派生摘要 / 来源已变', title: '旧摘要不能继续当当前证据。', proposal: '潮钟可以重放现场。', version: '旧输入 r17 · 当前 r18', scope: '否定条件丢失 · 当前停用', status: '需要重建或重绑', sourceTitle: '当前原文 / r18 与旧摘要不同', quote: '潮钟只会吐出声音，仓门外的脚步不会留下影像。', explanation: '旧摘要丢失“不能重放影像”的限制，不能直接确认。真实系统需根据当前依赖重新生成候选，再审阅；本演示不会运行提取。', canConfirm: false },
    belief: { kind: '未确认解释 / 无世界事实依据', title: '记住说法，不把猜想当真相。', proposal: '第二次铃响来自空船。', version: '作者想法 · 无引用证据', scope: '来源待补 · 禁止自动确证', status: '不能直接采用', sourceTitle: '当前证据边界', quote: '本故事样例没有证明铃声来自空船的段落。没有引用不等于系统应补出一个原因。', explanation: '可以保存为作者想法或角色相信的说法；若要采用为正式设定，需要作者明确决定、适用范围与可靠出处。此演示不伪造证据。', canConfirm: false },
    future: { kind: '伏笔状态 / 只有未来计划', title: '计划回收，不等于已经回收。', proposal: '反写编号 17 已回收。', version: '第三章计划 · 尚无正文回收', scope: '本场写作排除未来事件', status: '回收仍待核验', sourceTitle: '作者计划 / 非已写情节', quote: '“错号证词”引入反写编号；“留下倒页”计划揭示另一套索引。这只是一项未来安排。', explanation: '可以把它保存为计划回收，不能确认“已回收”。本场只纳入已写线索，后文解释与角色知情另行控制。', canConfirm: false }
  };
  function renderReview() {
    const item = reviewItems[state.review];
    root.querySelectorAll('[data-review]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.review === state.review)));
    for (const [selector, key] of [['kind', 'kind'], ['title', 'title'], ['version', 'version'], ['scope', 'scope'], ['state', 'status'], ['source-title', 'sourceTitle'], ['quote', 'quote'], ['explanation', 'explanation']]) root.querySelector(`[data-review-${selector}]`).textContent = item[key];
    root.querySelector('[data-proposal]').textContent = item.proposal;
    root.querySelector('[data-decision="confirm"]').disabled = !item.canConfirm;
    root.querySelector('[data-decision="edit"]').disabled = !item.canConfirm;
    const feedback = root.querySelector('[data-review-feedback]');
    feedback.hidden = !decisions.has(state.review); feedback.textContent = decisions.get(state.review) || '';
  }
  root.querySelectorAll('[data-page],[data-go]').forEach(button => button.addEventListener('click', () => { state.page = button.dataset.page || button.dataset.go; renderPage(); }));
  root.querySelectorAll('[data-cluster]').forEach(button => button.addEventListener('click', () => {
    state.cluster = button.dataset.cluster;
    state.panX = 0; state.panY = 0; state.zoom = state.cluster === 'all' ? 1 : 1.5;
    if (state.cluster !== 'all') {
      const cluster = data.clusters.find(item => item.id === state.cluster);
      const view = views[0];
      const point = project({ position: cluster.center }, view.container.clientWidth, view.container.clientHeight, false);
      state.panX = view.container.clientWidth * 0.5 - point.x;
      state.panY = view.container.clientHeight * 0.5 - point.y;
    }
    renderPage();
  }));
  root.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { state.view = button.dataset.view; renderPage(); }));
  root.querySelector('[data-search]').addEventListener('submit', event => {
    event.preventDefault();
    const query = root.querySelector('#sw-galaxy-query').value.trim();
    const matches = anchors.filter(node => node.name.includes(query) && query.length);
    const status = root.querySelector('[data-search-status]');
    if (matches.length !== 1) { status.textContent = matches.length ? '匹配多个对象，请输入更完整的名称；不会自动合并同名人物。' : '未找到故事对象。本演示只定位14个故事样例。'; return; }
    state.cluster = 'all'; state.view = 'space'; renderPage(false); select(matches[0].id, true); status.textContent = `已定位 ${matches[0].name} / 仅展示，不加入写作输入。`;
  });
  const keyboardList = root.querySelector('[data-keyboard-list]');
  anchors.forEach(node => { const button = document.createElement('button'); button.type = 'button'; button.textContent = `${node.name} / ${node.type}`; button.addEventListener('click', () => select(node.id, true)); keyboardList.append(button); });
  root.querySelector('[data-source-toggle]').addEventListener('click', event => { state.sourceOpen = !state.sourceOpen; root.querySelector('[data-source-panel]').hidden = !state.sourceOpen; event.currentTarget.setAttribute('aria-expanded', String(state.sourceOpen)); });
  root.querySelectorAll('[data-input-toggle]').forEach(button => button.addEventListener('click', () => { state.inputOpen = !state.inputOpen; root.querySelector('[data-input-panel]').hidden = !state.inputOpen; root.querySelectorAll('[data-input-toggle]').forEach(control => control.setAttribute('aria-expanded', String(state.inputOpen))); }));
  root.querySelectorAll('[data-select-scene]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.selectScene === 's4') return;
    state.page = 'galaxy'; state.cluster = 'all'; state.view = 'space'; renderPage(false); select(button.dataset.selectScene, true);
    root.querySelector('[data-search-status]').textContent = '只切换到所选故事对象；演示正文仍仅有“仓库对证”，不假装存在其他可写正文。';
  }));
  root.querySelectorAll('[data-camera]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.camera === 'reset') { Object.assign(state, { turn: -0.1, tilt: -0.46, zoom: 1, panX: 0, panY: 0 }); }
    else state.zoom = Math.max(0.5, Math.min(2.5, state.zoom * (button.dataset.camera === 'in' ? 1.2 : 1 / 1.2)));
    scheduleDraw(); persist();
  }));
  for (const view of views) {
    let drag = null;
    view.canvas.addEventListener('pointerdown', event => { drag = { x: event.clientX, y: event.clientY, moved: false }; view.canvas.setPointerCapture(event.pointerId); });
    view.canvas.addEventListener('pointermove', event => {
      if (!drag || view.local) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      state.turn += dx * 0.008; state.tilt = Math.max(-1.2, Math.min(1.2, state.tilt + dy * 0.006)); drag.x = event.clientX; drag.y = event.clientY; scheduleDraw();
    });
    view.canvas.addEventListener('pointerup', event => {
      if (!drag) return;
      if (!drag.moved) {
        const rect = view.canvas.getBoundingClientRect(); const x = event.clientX - rect.left, y = event.clientY - rect.top;
        let best = null, distance = 26;
        for (const [id, p] of view.projected) { const d = Math.hypot(p.x - x, p.y - y); if (d < distance) { best = id; distance = d; } }
        if (best) select(best, false);
      }
      drag = null; persist();
    });
    view.canvas.addEventListener('pointercancel', () => { drag = null; });
    view.canvas.addEventListener('wheel', event => { if (view.local) return; event.preventDefault(); state.zoom = Math.max(0.5, Math.min(2.5, state.zoom * Math.exp(-event.deltaY * 0.001))); scheduleDraw(); persist(); }, { passive: false });
    new ResizeObserver(scheduleDraw).observe(view.container);
  }
  root.querySelectorAll('[data-review]').forEach(button => button.addEventListener('click', () => { state.review = button.dataset.review; renderReview(); }));
  root.querySelectorAll('[data-decision]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.decision;
    const item = reviewItems[state.review];
    const proposal = root.querySelector('[data-proposal]');
    const feedback = root.querySelector('[data-review-feedback]');
    if (action === 'edit' && item.canConfirm) {
      const field = document.createElement('textarea'); field.setAttribute('aria-label', '编辑候选命题'); field.value = item.proposal; proposal.replaceChildren(field); field.focus();
      feedback.hidden = false; feedback.textContent = '编辑的是候选示例，不是正文；点击确认仅记录本次演示选择。'; return;
    }
    if (action === 'confirm' && !item.canConfirm) return;
    const edited = proposal.querySelector('textarea');
    if (action === 'confirm' && edited && !edited.value.trim()) { feedback.hidden = false; feedback.textContent = '候选为空，不能确认。'; return; }
    const messages = { confirm: '演示：已选择采用此候选。没有写入正式记忆、正文或数据库；刷新后不作为持久决定。', reject: '演示：已选择拒绝。真实产品需保留拒绝历史，本演示没有持久回执。', later: '演示：留待稍后处理；不改变当前事实或正文。' };
    const message = `${messages[action]}${edited && action === 'confirm' ? ' 采用的是作者编辑文本，不再标作原提取命题。' : ''}`;
    decisions.set(state.review, message); feedback.hidden = false; feedback.textContent = message;
  }));
  renderDetail(); renderReview(); renderPage(false); restore(window.zcode?.widgetState);
  window.addEventListener('zcode:set_globals', event => restore(event.detail?.globals?.widgetState));
  if (globalThis.Tweak) {
    const tweak = new globalThis.Tweak({ container: root.querySelector('.sw-app'), onChange: () => { scheduleDraw(); persist(); } });
    tweak.addSlider(state, 'glow', { label: '星点辉光', min: 0, max: 1, step: 0.1 });
    tweak.addToggle(state, 'labels', { label: '近景故事标签' });
  }
  root.dataset.ready = 'true';
  root.querySelector('[data-runtime-status]').textContent = `${views[0].renderer.mode} · 可旋转/缩放，非真实记忆引擎`;
})();
