/* ============================================================
   织章 · StoryWeave — UI v5 interactions
   全部数据只存在于当前页面内存；刷新即还原。
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const SVG = 'http://www.w3.org/2000/svg';
  const esc = (value = '') => String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  const pad = (n) => String(n).padStart(2, '0');
  const timeNow = () => `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
  const plainText = (html = '') => {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    return holder.textContent || '';
  };
  const countChars = (html = '') => plainText(html).replace(/\s+/g, '').length;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const state = {
    view: 'desk',
    theme: 'light',
    activeChapter: 2,
    lastSaved: timeNow(),
    notes: [
      { text: '“雾不是天气，是有人不想让你看清。”', meta: '第 3 章 · 待用对白' },
      { text: '灯塔的光束扫过海面时，像有人在翻一页旧账。', meta: '意象 · 11.07' },
      { text: '查：七年前 11 月 3 日的潮汐表。', meta: '待查 · 11.06' },
      { text: '沈砚为什么从不提那晚？', meta: '人物动机 · 11.05' }
    ],
    archiveTab: 'people',
    archiveId: 'linyao',
    archiveQuery: '',
    reviewFilter: 'all',
    issueId: 'timeline',
    diffMode: 'side',
    pendingCandidates: 2,
    galaxySelected: 'linyao',
    galaxyTypes: new Set(['character', 'place', 'clue', 'event', 'object']),
    galaxyK: 1,
    galaxyX: 0,
    galaxyY: 0,
    galaxyQuery: '',
    galaxyDrag: null,
    galaxyPan: null,
    paletteItems: [],
    paletteIndex: 0,
    focusStart: 0,
    focusTimer: null,
    typewriter: false,
    justDragged: false,
    saveTimer: null,
    toastTimer: null,
    suggestionState: 'open'
  };

  /* ------------------------------------------------------------
     Data
     ------------------------------------------------------------ */
  const volumes = [
    { id: 1, roman: 'I', label: '第一卷', title: '雾中来信', note: '写作中' },
    { id: 2, roman: 'II', label: '第二卷', title: '潮汐之下', note: '大纲' }
  ];

  const chapters = [
    {
      id: 1, no: '01', volume: 1, title: '回到雾港', status: '已定稿', words: 1240, target: 2500,
      pov: '第三人称 · 林遥', time: '11 月 3 日 · 深夜', tension: 2,
      summary: '林遥回到旧宅，发现记忆里的灯塔不在原处。',
      goal: '让林遥回到旧宅，发现桌上那杯还温着的水。',
      beats: [
        { text: '夜车到站，雾漫过站台', done: true },
        { text: '旧宅门锁还能打开', done: true },
        { text: '窗外的灯塔不见了', done: false }
      ],
      people: [{ name: '林遥', kind: 'character' }],
      html: [
        '<p>夜车在凌晨四点十七分到站。林遥拖着一只旧箱子下车，站台上只有一盏灯，灯罩里积着死掉的飞蛾。</p>',
        '<p>雾从海面漫上来，漫过铁轨，漫过站牌上褪色的字。她站在原地，等一个不会来接她的人。</p>',
        '<p>旧宅在坡上。钥匙还是七年前那把，插进锁孔时，她听见里面有什么东西轻轻响了一下。门开了，屋里没有灰尘，桌上放着一杯还温着的水。</p>',
        '<p>她走到窗边。雾里，什么都没有。记忆里的灯塔本该在礁石尽头，此刻那里只有一片空白。</p>'
      ].join('')
    },
    {
      id: 2, no: '02', volume: 1, title: '没有署名的信', status: '草稿', words: 506, target: 2500,
      pov: '第三人称 · 林遥', time: '11 月 3 日 · 清晨', tension: 3,
      summary: '一封没有落款的名信，让灯塔从记忆里重新出现。',
      goal: '让林遥发现灯塔消失，并留下信来源的疑问。',
      beats: [
        { text: '抵达旧宅，发现灯还亮着', done: true },
        { text: '在码头看见灯塔消失', done: true },
        { text: '读无名信，留下来源疑问', done: false }
      ],
      people: [{ name: '林遥', kind: 'character' }, { name: '沈砚', kind: 'character' }, { name: '周叔', kind: 'character' }],
      html: [
        '<p>林遥回到雾港那天，雨已经下了整整一夜。车站外的梧桐叶落了一地，旧报亭的灯还亮着，玻璃上凝着一层薄雾。</p>',
        '<p>她从口袋里摸出那封信。信封边缘被反复摩挲，已经起了毛边。没有寄件人，没有落款，只有一个她七年没有再听过的名字。</p>',
        '<p>码头的方向传来一声汽笛。她抬头，看见远处灰白色的天际线正在缓缓变亮。记忆里的灯塔本该在更左边一些，但此刻那里只有一片空白。</p>',
        '<p>出租车沿着海岸线开。司机从后视镜里看了她一眼，说，雾季提前了。林遥没有接话。她盯着窗外，试图从每一栋旧楼里认出一点熟悉的东西。</p>',
        '<p>潮汐旅馆的招牌换了颜色，前台还是那个胖胖的女人。她递来钥匙，说，203，靠海那一间。又说，你母亲以前也喜欢那一间。</p>',
        '<p>林遥在楼梯口停了一会儿。她没有问母亲的事。七年前她离开时，把关于雾港的一切都留在了这里，包括那个名字。</p>',
        '<p>房间里有一股旧木头和盐的味道。她推开窗，雾涌进来，像一层没有重量的布。远处没有灯塔。连礁石都看不见。</p>',
        '<p>她把信放在桌上，盯着那行字看了很久。字迹很轻，像是怕惊动什么人。窗外，海面开始涨潮。</p>',
        '<p>她忽然想起，小时候母亲说过，雾起的时候，不要回答海上的灯。那时她以为这只是一句吓小孩的话。<span class="ai-mark" data-ai-mark>她第一次意识到，那句话也许不是用来吓小孩的。</span></p>'
      ].join('')
    },
    {
      id: 3, no: '03', volume: 1, title: '潮汐之后', status: '草稿', words: 1860, target: 2600,
      pov: '第三人称 · 林遥', time: '11 月 3 日 · 午后', tension: 4,
      summary: '周叔在面汤的热气里，说出船难名单上的一个漏洞。',
      goal: '引出周叔与七年前的船难，让“名单上有她，上船的不是她”落地。',
      beats: [
        { text: '在潮汐旅馆见到周叔', done: true },
        { text: '周叔说出名单的漏洞', done: true },
        { text: '林遥决定去灯塔', done: false }
      ],
      people: [{ name: '林遥', kind: 'character' }, { name: '周叔', kind: 'character' }],
      html: [
        '<p>周叔在潮汐旅馆的厨房里煮面。他老了很多，手背上全是白色的疤。看见林遥，他先笑了一下，又很快把笑收回去。</p>',
        '<p>“你妈那晚不在船上。”他说，声音很轻，像怕被墙听见。“名单上有她，但上船的人不是她。”</p>',
        '<p>林遥握着筷子的手停在半空。窗外有船进港，汽笛拖得很长。她想起小时候，周叔总说，潮水会把属于海的东西还回来。</p>',
        '<p>面汤上浮着一层油花。周叔低下头，再没有说一句话。</p>'
      ].join('')
    },
    {
      id: 4, no: '04', volume: 1, title: '消失的灯塔', status: '草稿', words: 2310, target: 2800,
      pov: '第三人称 · 林遥', time: '11 月 3 日 · 黄昏', tension: 5,
      summary: '退潮后灯塔出现二十分钟，日志的最后一页写着“不要回头”。',
      goal: '让林遥第一次进入灯塔，发现日志缺页，并让沈砚正面出现。',
      beats: [
        { text: '退潮，走上礁石', done: true },
        { text: '进入灯塔，发现日志', done: true },
        { text: '沈砚在门口出现', done: false }
      ],
      people: [{ name: '林遥', kind: 'character' }, { name: '沈砚', kind: 'character' }],
      html: [
        '<p>灯塔在退潮后出现。只有二十分钟。林遥踩着湿滑的礁石走过去，鞋里灌满了水。</p>',
        '<p>门没有锁。螺旋楼梯上落满盐粒，像一层没有化掉的雪。她数到第七十三级，看见一盏还亮着的灯。</p>',
        '<p>灯塔日志摊在桌上。前面的纸页被撕掉了，只剩最后一页，写着四个字：不要回头。</p>',
        '<p>身后传来脚步声。林遥没有回头。她听见沈砚说：“你还是来了。”</p>',
        '<p>沈砚站在门口，雨水顺着伞骨往下滴。他换了个姿势，用左手点烟，火光短暂地照亮他半张脸。</p>'
      ].join('')
    },
    {
      id: 5, no: '05', volume: 2, title: '旧名字', status: '大纲', words: 0, target: 2400,
      pov: '第三人称 · 林遥', time: '11 月 3 日 · 夜', tension: 4,
      summary: '沈砚第一次说出许青禾的名字，灯塔里的灯忽然暗了一下。',
      goal: '把母亲的名字从档案里带到人物之间。',
      beats: [
        { text: '沈砚收起伞', done: false },
        { text: '他说出许青禾的名字', done: false },
        { text: '灯塔的灯暗了一下', done: false }
      ],
      people: [{ name: '林遥', kind: 'character' }, { name: '沈砚', kind: 'character' }],
      html: ''
    },
    {
      id: 6, no: '06', volume: 2, title: '潮汐表', status: '大纲', words: 0, target: 2600,
      pov: '第三人称 · 林遥', time: '11 月 4 日 · 凌晨', tension: 5,
      summary: '被蓝墨水涂掉的潮位栏底下，藏着一句“没有退潮”。',
      goal: '让物证推翻官方记录，把怀疑指向所有人。',
      beats: [
        { text: '周叔抽屉里的旧潮汐表', done: false },
        { text: '蓝墨水底下的数字', done: false },
        { text: '“没有退潮”', done: false }
      ],
      people: [{ name: '林遥', kind: 'character' }, { name: '周叔', kind: 'character' }],
      html: ''
    },
    {
      id: 7, no: '07', volume: 2, title: '回信', status: '大纲', words: 0, target: 3000,
      pov: '第三人称 · 林遥', time: '11 月 4 日 · 清晨', tension: 3,
      summary: '雾散了一半。林遥把回信投进邮局，故事进入第二幕。',
      goal: '让林遥主动回应，而不是继续被过去推着走。',
      beats: [
        { text: '写完回信', done: false },
        { text: '雾散了一半', done: false },
        { text: '把信投进邮局', done: false }
      ],
      people: [{ name: '林遥', kind: 'character' }],
      html: ''
    }
  ];

  chapters.forEach((chapter) => {
    chapter._count = countChars(chapter.html);
  });

  const archiveData = {
    people: [
      {
        id: 'linyao', tab: 'people', type: '人物', en: 'LIN YAO', name: '林遥', initial: '遥', tint: '#92513e',
        role: '主角 · 32 岁 · 数据修复师', tags: ['POV', '主角', '不可靠叙述'],
        quote: '“我不是回来找答案的。我只是想知道，我记错的是哪一部分。”',
        status: '刚回到雾港，住在潮汐旅馆 203。左手仍戴着母亲留下的旧表。',
        statusLabel: '第 2 章', statusType: 'current',
        factsTitle: '人物内核',
        facts: [
          { label: '想要', text: '找回七年前那晚的完整记忆。' },
          { label: '害怕', text: '发现自己才是那个说谎的人。' },
          { label: '秘密', text: '她其实收到过第二封信，但没有告诉任何人。' }
        ],
        relations: [
          { name: '沈砚', rel: '旧友 / 互相隐瞒' },
          { name: '周叔', rel: '童年邻居 / 知情者' },
          { name: '许青禾', rel: '母亲 / 失踪' }
        ],
        sources: ['第 1 章 · 回到雾港', '第 2 章 · 没有署名的信', '第 4 章 · 消失的灯塔'],
        appearances: '第 1、2、4 章'
      },
      {
        id: 'shenyan', tab: 'people', type: '人物', en: 'SHEN YAN', name: '沈砚', initial: '砚', tint: '#455f5a',
        role: '旧友 · 34 岁 · 雾港报社编辑', tags: ['关键人物', '隐瞒者'],
        quote: '“有些事不是你忘了，是所有人都希望你忘掉。”',
        status: '在灯塔出现后第一次与林遥正面相遇。右手拿着那把旧伞。',
        statusLabel: '第 4 章', statusType: 'current',
        factsTitle: '人物内核',
        facts: [
          { label: '想要', text: '把七年前没写完的报道写完。' },
          { label: '害怕', text: '林遥发现他删掉的那一段。' },
          { label: '秘密', text: '船难那晚，他在灯塔上。' }
        ],
        relations: [
          { name: '林遥', rel: '旧友 / 互相试探' },
          { name: '许青禾', rel: '前同事 / 欠她一个真相' },
          { name: '周叔', rel: '互相守口如瓶' }
        ],
        sources: ['第 1 章 · 回到雾港', '第 4 章 · 消失的灯塔'],
        appearances: '第 1、4、5 章'
      },
      {
        id: 'zhou', tab: 'people', type: '人物', en: 'UNCLE ZHOU', name: '周叔', initial: '周', tint: '#8a7148',
        role: '旧灯塔看守人 · 61 岁 · 潮汐旅馆帮厨', tags: ['知情者', '记忆衰退'],
        quote: '“灯塔早拆了。你要找的那座，不在海这边。”',
        status: '在潮汐旅馆厨房煮面。记得灯塔，却坚持说它七年前就拆了。',
        statusLabel: '第 3 章', statusType: 'current',
        factsTitle: '人物内核',
        facts: [
          { label: '想要', text: '守住对许青禾的承诺。' },
          { label: '害怕', text: '忘记自己为什么守口如瓶。' },
          { label: '秘密', text: '灯塔日志的最后一页，是他撕的。' }
        ],
        relations: [
          { name: '林遥', rel: '看着她长大 / 不敢说实话' },
          { name: '许青禾', rel: '旧友 / 最后的托付' },
          { name: '沈砚', rel: '互相提防' }
        ],
        sources: ['第 3 章 · 潮汐之后', '第 6 章 · 潮汐表（计划）'],
        appearances: '第 3、6 章'
      },
      {
        id: 'xuqinghe', tab: 'people', type: '人物', en: 'XU QINGHE', name: '许青禾', initial: '禾', tint: '#6f5f7d',
        role: '林遥的母亲 · 失踪 · 曾是潮汐旅馆登记员', tags: ['失踪者', '核心谜团'],
        quote: '“雾起的时候，不要回答海上的灯。”',
        status: '七年前失踪。官方记录为船难遇难者，但名字不在登船名单上。',
        statusLabel: '七年前', statusType: 'missing',
        factsTitle: '留下的痕迹',
        facts: [
          { label: '最后出现', text: '潮汐旅馆前台，11 月 3 日 22:40。' },
          { label: '留下的规则', text: '雾起时，不要回答海上的灯。' },
          { label: '疑点', text: '她的名字在船难名单上，但登船记录里没有她。' }
        ],
        relations: [
          { name: '林遥', rel: '女儿 / 七年未见' },
          { name: '周叔', rel: '旧友 / 托付了某样东西' },
          { name: '沈砚', rel: '前同事 / 曾接受采访' }
        ],
        sources: ['第 2 章 · 没有署名的信', '第 3 章 · 潮汐之后'],
        appearances: '第 2、3 章（被提及）'
      }
    ],
    world: [
      {
        id: 'fogport', tab: 'world', type: '地点', en: 'FOG HARBOR', name: '雾港', initial: '雾', tint: '#41625b',
        role: '地点 · 北方沿海小镇', tags: ['主要舞台', '地点'],
        quote: '“每年十一月起雾，四十天后才散。”',
        status: '故事开始于雾季提前的第三天。镇上的路灯从傍晚亮到清晨。',
        statusLabel: '当前', statusType: 'current',
        factsTitle: '地理与规则',
        facts: [
          { label: '地理', text: '三面环山，一面朝海。唯一的码头在镇的东侧。' },
          { label: '气候', text: '雾季从 11 月 3 日开始，持续四十天。' },
          { label: '规则', text: '雾起时，镇上不点路灯；也不要回答海上的灯。' }
        ],
        relations: [
          { name: '旧灯塔', rel: '镇志里没有记录' },
          { name: '潮汐旅馆', rel: '镇上唯一还开着的旅馆' },
          { name: '青鸥号', rel: '七年前从这里出发' }
        ],
        sources: ['第 1 章 · 回到雾港', '第 2 章 · 没有署名的信'],
        appearances: '第 1—7 章'
      },
      {
        id: 'lighthouse', tab: 'world', type: '地点', en: 'THE OLD LIGHTHOUSE', name: '旧灯塔', initial: '塔', tint: '#37505a',
        role: '地点 · 不在任何地图上', tags: ['地点', '异常'],
        quote: '“退潮之后，它才在那里。”',
        status: '退潮后出现约二十分钟。门没有锁，内部仍有灯亮着。',
        statusLabel: '第 4 章', statusType: 'current',
        factsTitle: '地点规则',
        facts: [
          { label: '出现', text: '退潮后约二十分钟，只有礁石尽头的角度看得见。' },
          { label: '内部', text: '七十三级螺旋楼梯，顶层有一盏还亮着的灯。' },
          { label: '异常', text: '潮汐表显示那一夜没有退潮。' }
        ],
        relations: [
          { name: '林遥', rel: '记忆里一直存在' },
          { name: '周叔', rel: '七年前的看守人' },
          { name: '灯塔日志', rel: '最后一页被撕掉' }
        ],
        sources: ['第 1 章 · 回到雾港', '第 4 章 · 消失的灯塔'],
        appearances: '第 1、4、5 章'
      },
      {
        id: 'hotel', tab: 'world', type: '地点', en: 'TIDE HOTEL', name: '潮汐旅馆', initial: '汐', tint: '#5e5641',
        role: '地点 · 林遥的暂住地', tags: ['地点', '203'],
        quote: '“203，靠海那一间。你母亲以前也喜欢那一间。”',
        status: '前台还留着七年前的登记簿。周叔在后厨帮忙。',
        statusLabel: '第 2 章', statusType: 'current',
        factsTitle: '地点细节',
        facts: [
          { label: '房间', text: '203 朝海，窗框是旧木头，晚上能听见潮水。' },
          { label: '登记簿', text: '七年前的 11 月 3 日，有一页被撕掉。' },
          { label: '气味', text: '旧木头、盐和面汤。' }
        ],
        relations: [
          { name: '林遥', rel: '住进 203' },
          { name: '周叔', rel: '在后厨帮工' },
          { name: '无名信', rel: '纸张来自这里' }
        ],
        sources: ['第 2 章 · 没有署名的信', '第 3 章 · 潮汐之后'],
        appearances: '第 2、3 章'
      },
      {
        id: 'fogrule', tab: 'world', type: '规则', en: 'THE FOG RULE', name: '雾季规则', initial: '规', tint: '#6b5d47',
        role: '世界规则 · 镇上的共识', tags: ['规则', '禁忌'],
        quote: '“雾起的时候，不要回答海上的灯。”',
        status: '林遥母亲留下的唯一明确规则。违反者会在第二天忘记一件事。',
        statusLabel: '已确认', statusType: 'confirmed',
        factsTitle: '规则边界',
        facts: [
          { label: '规则', text: '雾起时不要应答海上的灯，也不要回头看。' },
          { label: '代价', text: '违反者会在第二天忘记一件重要的事。' },
          { label: '例外', text: '灯塔看守人不受规则约束。' }
        ],
        relations: [
          { name: '林遥', rel: '小时候被反复叮嘱' },
          { name: '周叔', rel: '知道例外的原因' },
          { name: '许青禾', rel: '规则的留下者' }
        ],
        sources: ['第 2 章 · 没有署名的信', '第 4 章 · 消失的灯塔'],
        appearances: '第 2、4、6 章'
      },
      {
        id: 'qingou', tab: 'world', type: '事件', en: 'THE QINGOU', name: '青鸥号', initial: '鸥', tint: '#514c63',
        role: '事件 · 七年前的渡轮', tags: ['事件', '七年前'],
        quote: '“官方记录零人遇难。可那年冬天，镇上有七户人家搬走了。”',
        status: '11 月 3 日夜失联。官方记录为机械故障后返航，无人员伤亡。',
        statusLabel: '七年前', statusType: 'missing',
        factsTitle: '事件记录',
        facts: [
          { label: '时间', text: '七年前 11 月 3 日 23:10 离港。' },
          { label: '记录', text: '官方称机械故障后返航，零人遇难。' },
          { label: '疑点', text: '许青禾在名单上，却不在登船记录里。' }
        ],
        relations: [
          { name: '许青禾', rel: '名单上的遇难者' },
          { name: '沈砚', rel: '当晚的目击者' },
          { name: '潮汐表', rel: '记录与官方不符' }
        ],
        sources: ['第 1 章 · 回到雾港', '第 3 章 · 潮汐之后'],
        appearances: '第 1、3、6 章'
      }
    ],
    clues: [
      {
        id: 'letter', tab: 'clues', type: '线索', en: 'THE UNSIGNED LETTER', name: '无名信', initial: '信', tint: '#8a5b43',
        role: '线索 · 第 2 章埋下', tags: ['线索', '待回收', '第 2 章'],
        quote: '“没有寄件人，没有落款，只有一个她七年没有再听过的名字。”',
        status: '仍在林遥手中。纸张来自七年前的潮汐旅馆。',
        statusLabel: '待回收', statusType: 'planned',
        factsTitle: '回收计划',
        facts: [
          { label: '埋下', text: '第 2 章，林遥在旧宅门口捡到。' },
          { label: '计划回收', text: '第 7 章，林遥写出回信。' },
          { label: '当前证据', text: '纸张水印与潮汐旅馆的旧登记簿一致。' }
        ],
        relations: [
          { name: '林遥', rel: '收到信的人' },
          { name: '许青禾', rel: '字迹高度相似' },
          { name: '潮汐旅馆', rel: '纸张来源' }
        ],
        sources: ['第 2 章 · 没有署名的信'],
        appearances: '第 2、7 章'
      },
      {
        id: 'log', tab: 'clues', type: '线索', en: 'THE LIGHTHOUSE LOG', name: '灯塔日志', initial: '志', tint: '#4f6254',
        role: '线索 · 第 4 章埋下', tags: ['线索', '待回收', '第 4 章'],
        quote: '“最后一页只有四个字：不要回头。”',
        status: '前面的纸页被撕掉。撕口很新，不像七年前的纸。',
        statusLabel: '待回收', statusType: 'planned',
        factsTitle: '回收计划',
        facts: [
          { label: '埋下', text: '第 4 章，林遥在灯塔顶层发现。' },
          { label: '计划回收', text: '第 6 章，缺页在周叔的抽屉里出现。' },
          { label: '当前证据', text: '最后一页的字迹与周叔的登记簿相似。' }
        ],
        relations: [
          { name: '旧灯塔', rel: '藏在顶层桌上' },
          { name: '周叔', rel: '可能是撕页的人' },
          { name: '林遥', rel: '第一个发现者' }
        ],
        sources: ['第 4 章 · 消失的灯塔'],
        appearances: '第 4、6 章'
      },
      {
        id: 'tide', tab: 'clues', type: '线索', en: 'THE TIDE TABLE', name: '潮汐表', initial: '潮', tint: '#49636a',
        role: '线索 · 第 6 章计划', tags: ['线索', '计划中', '第 6 章'],
        quote: '“那一夜的潮位栏，被人用蓝墨水涂掉了。”',
        status: '仍在周叔的抽屉里。涂痕下面还能看见“没有退潮”。',
        statusLabel: '计划中', statusType: 'planned',
        factsTitle: '回收计划',
        facts: [
          { label: '埋下', text: '第 6 章，林遥翻找周叔的抽屉。' },
          { label: '计划回收', text: '第 7 章，用来解释灯塔为何在那一夜出现。' },
          { label: '当前证据', text: '蓝墨水与周叔记账用的墨水相同。' }
        ],
        relations: [
          { name: '周叔', rel: '保存者' },
          { name: '旧灯塔', rel: '出现条件' },
          { name: '青鸥号', rel: '时间线冲突' }
        ],
        sources: ['第 6 章 · 潮汐表（计划）'],
        appearances: '第 6 章'
      },
      {
        id: 'recording', tab: 'clues', type: '线索', en: 'SHEN YAN’S TAPE', name: '沈砚的录音', initial: '录', tint: '#665269',
        role: '线索 · 第 4 章出现', tags: ['线索', '待回收'],
        quote: '“背景里有一声雾笛。可那天晚上，港口没有船。”',
        status: '旧录音带，标签上写着“11.03”。还没有人听过完整的一面。',
        statusLabel: '待回收', statusType: 'planned',
        factsTitle: '回收计划',
        facts: [
          { label: '埋下', text: '第 4 章，沈砚的伞袋里露出半盒磁带。' },
          { label: '计划回收', text: '第 5 章，林遥在报社旧设备上播放。' },
          { label: '当前证据', text: '背景声与灯塔雾笛的频率一致。' }
        ],
        relations: [
          { name: '沈砚', rel: '录音者' },
          { name: '旧灯塔', rel: '背景声来源' },
          { name: '青鸥号', rel: '可能与船难有关' }
        ],
        sources: ['第 4 章 · 消失的灯塔'],
        appearances: '第 4、5 章'
      },
      {
        id: 'ruleclue', tab: 'clues', type: '伏笔', en: 'DON’T LOOK BACK', name: '不要回头', initial: '回', tint: '#7b6644',
        role: '伏笔 · 第 2 章埋下', tags: ['伏笔', '窗口过长'],
        quote: '“雾起的时候，不要回答海上的灯。”',
        status: '第 2 章由林遥回忆母亲的话。计划在第 6 章回收。',
        statusLabel: '需关注', statusType: 'warning',
        factsTitle: '回收计划',
        facts: [
          { label: '埋下', text: '第 2 章，林遥想起母亲的叮嘱。' },
          { label: '计划回收', text: '第 6 章，周叔解释例外的代价。' },
          { label: '风险', text: '埋下与回收间隔 4 章，读者可能已经忘记。' }
        ],
        relations: [
          { name: '林遥', rel: '被叮嘱的人' },
          { name: '许青禾', rel: '留下规则的人' },
          { name: '周叔', rel: '知道例外的人' }
        ],
        sources: ['第 2 章 · 没有署名的信'],
        appearances: '第 2、6 章'
      },
      {
        id: 'photo', tab: 'clues', type: '物品', en: 'THE OLD PHOTO', name: '许青禾的旧照片', initial: '照', tint: '#6e6150',
        role: '物品 · 第 1 章出现', tags: ['物品', '已确认'],
        quote: '“照片背面写着：退潮之后，去灯塔。”',
        status: '夹在旧宅的相册里。背面日期是船难前一天。',
        statusLabel: '已确认', statusType: 'confirmed',
        factsTitle: '物品信息',
        facts: [
          { label: '发现', text: '第 1 章，林遥在旧宅相册里找到。' },
          { label: '内容', text: '许青禾站在灯塔前，身后没有海。' },
          { label: '背面', text: '“退潮之后，去灯塔。”' }
        ],
        relations: [
          { name: '林遥', rel: '发现者' },
          { name: '许青禾', rel: '照片中的人' },
          { name: '旧灯塔', rel: '照片中的地点' }
        ],
        sources: ['第 1 章 · 回到雾港'],
        appearances: '第 1 章'
      }
    ]
  };

  const galaxyNodes = [
    {
      id: 'linyao', name: '林遥', type: 'character', color: '#d08063', x: 548, y: 350,
      en: 'LIN YAO', role: '主角 · 32 岁 · 数据修复师',
      desc: '七年前离开雾港，如今带着一封无名信回来。她记得灯塔的位置，但所有人都说那里只有海。',
      current: '刚回到雾港，住在潮汐旅馆 203。她还没有打开母亲留下的那只铁盒。',
      stats: [['身份', '主角 / POV'], ['出场', '第 1、2、4 章']],
      sources: ['第 1 章 · 回到雾港', '第 2 章 · 没有署名的信']
    },
    {
      id: 'shenyan', name: '沈砚', type: 'character', color: '#7fa596', x: 776, y: 254,
      en: 'SHEN YAN', role: '旧友 · 34 岁 · 雾港报社编辑',
      desc: '七年前船难的目击者。他写过那篇报道，又在见报前删掉了最后一段。',
      current: '在灯塔出现后第一次与林遥正面相遇。右手拿着那把旧伞。',
      stats: [['身份', '关键人物 / 隐瞒者'], ['出场', '第 1、4、5 章']],
      sources: ['第 4 章 · 消失的灯塔']
    },
    {
      id: 'zhou', name: '周叔', type: 'character', color: '#c2a373', x: 815, y: 475,
      en: 'UNCLE ZHOU', role: '旧灯塔看守人 · 61 岁',
      desc: '记得灯塔，却坚持说它七年前就拆了。手背上有盐灼留下的白疤。',
      current: '在潮汐旅馆厨房煮面。面汤上浮着一层油花。',
      stats: [['身份', '知情者 / 看守人'], ['出场', '第 3、6 章']],
      sources: ['第 3 章 · 潮汐之后']
    },
    {
      id: 'xuqinghe', name: '许青禾', type: 'character', color: '#9a8db5', x: 392, y: 205,
      en: 'XU QINGHE', role: '林遥的母亲 · 七年前失踪',
      desc: '潮汐旅馆的前台登记员。她在船难名单上，却不在登船记录里。',
      current: '七年前失踪。留下的最后一句话是：不要回答海上的灯。',
      stats: [['身份', '失踪者 / 核心谜团'], ['出场', '第 2、3 章（被提及）']],
      sources: ['第 2 章 · 没有署名的信']
    },
    {
      id: 'fogport', name: '雾港', type: 'place', color: '#7fa596', x: 586, y: 540,
      en: 'FOG HARBOR', role: '地点 · 北方沿海小镇',
      desc: '三面环山，一面朝海。每年十一月起雾四十天，路灯在雾里像一排没睡醒的眼睛。',
      current: '雾季提前的第三天。码头的汽笛每天清晨响一次。',
      stats: [['类型', '主要舞台'], ['出场', '第 1—7 章']],
      sources: ['第 1 章 · 回到雾港']
    },
    {
      id: 'lighthouse', name: '旧灯塔', type: 'place', color: '#7f9db8', x: 304, y: 424,
      en: 'THE OLD LIGHTHOUSE', role: '地点 · 不在任何地图上',
      desc: '退潮后出现约二十分钟。门没有锁，螺旋楼梯有七十三级。',
      current: '塔顶的灯还亮着。日志的最后一页被撕掉。',
      stats: [['类型', '异常地点'], ['出场', '第 1、4、5 章']],
      sources: ['第 4 章 · 消失的灯塔']
    },
    {
      id: 'letter', name: '无名信', type: 'clue', color: '#d0b070', x: 486, y: 132,
      en: 'THE UNSIGNED LETTER', role: '线索 · 第 2 章埋下',
      desc: '没有寄件人，没有落款。信封边缘起了毛边，纸上只有一个她七年没有再听过的名字。',
      current: '仍在林遥手中。纸张来自七年前的潮汐旅馆。',
      stats: [['状态', '待回收'], ['计划回收', '第 7 章']],
      sources: ['第 2 章 · 没有署名的信']
    },
    {
      id: 'shipwreck', name: '七年前的船难', type: 'event', color: '#9a8db5', x: 706, y: 598,
      en: 'THE SHIPWRECK', role: '事件 · 青鸥号失联',
      desc: '官方记录零人遇难。可那年冬天，镇上有七户人家搬走了。',
      current: '许青禾的名字在名单上，却不在登船记录里。',
      stats: [['时间', '七年前 11.03'], ['状态', '记录矛盾']],
      sources: ['第 3 章 · 潮汐之后']
    },
    {
      id: 'tide', name: '潮汐表', type: 'object', color: '#7f9db8', x: 932, y: 557,
      en: 'THE TIDE TABLE', role: '物品 · 周叔保存',
      desc: '那一夜的潮位栏被人用蓝墨水涂掉。涂痕底下还能看见“没有退潮”。',
      current: '锁在周叔的抽屉里。',
      stats: [['状态', '计划中'], ['计划出现', '第 6 章']],
      sources: ['第 6 章 · 潮汐表（计划）']
    },
    {
      id: 'log', name: '灯塔日志', type: 'object', color: '#7f9db8', x: 250, y: 576,
      en: 'THE LIGHTHOUSE LOG', role: '物品 · 藏在灯塔顶层',
      desc: '前面的纸页被撕掉了，只剩最后一页，写着四个字：不要回头。',
      current: '撕口很新，不像七年前的纸。',
      stats: [['状态', '待回收'], ['发现', '第 4 章']],
      sources: ['第 4 章 · 消失的灯塔']
    },
    {
      id: 'recording', name: '沈砚的录音', type: 'clue', color: '#d0b070', x: 955, y: 348,
      en: 'SHEN YAN’S TAPE', role: '线索 · 第 4 章出现',
      desc: '旧录音带，标签上写着“11.03”。背景里有一声雾笛，可那天晚上港口没有船。',
      current: '还没有人听过完整的一面。',
      stats: [['状态', '待回收'], ['计划出现', '第 5 章']],
      sources: ['第 4 章 · 消失的灯塔']
    },
    {
      id: 'fogrule', name: '不要回头', type: 'event', color: '#d08063', x: 286, y: 246,
      en: 'DON’T LOOK BACK', role: '规则 · 雾季禁忌',
      desc: '雾起的时候，不要回答海上的灯，也不要回头。违反者会在第二天忘记一件事。',
      current: '林遥小时候被反复叮嘱。她一直以为这是吓小孩的话。',
      stats: [['类型', '世界规则'], ['回收窗口', '第 6 章']],
      sources: ['第 2 章 · 没有署名的信']
    }
  ];

  const galaxyEdges = [
    { from: 'linyao', to: 'fogport', label: '归返' },
    { from: 'linyao', to: 'letter', label: '收到' },
    { from: 'linyao', to: 'shenyan', label: '旧友' },
    { from: 'linyao', to: 'zhou', label: '告知' },
    { from: 'linyao', to: 'xuqinghe', label: '母女' },
    { from: 'linyao', to: 'fogrule', label: '禁忌' },
    { from: 'xuqinghe', to: 'letter', label: '笔迹' },
    { from: 'shenyan', to: 'shipwreck', label: '亲历' },
    { from: 'zhou', to: 'lighthouse', label: '看守' },
    { from: 'zhou', to: 'tide', label: '保存' },
    { from: 'shipwreck', to: 'lighthouse', label: '目击' },
    { from: 'shipwreck', to: 'tide', label: '异常' },
    { from: 'log', to: 'lighthouse', label: '藏于' },
    { from: 'recording', to: 'shenyan', label: '留下' },
    { from: 'letter', to: 'shipwreck', label: '寄于之前' }
  ];

  const issues = [
    {
      id: 'timeline', type: 'consistency', severity: 'high', status: 'open',
      title: '时间线冲突：她“七年没有再听过这个名字”',
      short: '第 1 章提到上周接到过许青禾的电话，第 2 章却说七年没听过这个名字。',
      chapterId: 2, chapterNo: '第 2 章', chapterTitle: '没有署名的信',
      quote: '只有一个她七年没有再听过的名字。',
      suggestion: '只有一个她七年没有当面听人提起的名字。',
      summary: '同一人物在相邻章节中的“最后一次接触”不一致。第 1 章的电话记录让第 2 章的绝对表述失效。',
      reason: '规则检出：人物时间线字段“最后一次接触”为 11 月 1 日，与正文“七年没有再听过”冲突。',
      evidenceQuote: '第 1 章 · 回到雾港：“上周那个电话，她没有接。”',
      evidenceSource: '第 1 章 · 回到雾港',
      impact: ['第 2 章 · 没有署名的信', '人物 · 林遥', '时间线 · 七年前'],
      version: '基于 v12 · 02:10；当前正文 v13 · 02:14',
      stale: true
    },
    {
      id: 'lefthand', type: 'consistency', severity: 'mid', status: 'open',
      title: '人物状态未同步：沈砚的左手',
      short: '沈砚左手在船难中受伤，第 4 章仍用左手点烟。',
      chapterId: 4, chapterNo: '第 4 章', chapterTitle: '消失的灯塔',
      quote: '他换了个姿势，用左手点烟。',
      suggestion: '他换了个姿势，用右手点烟。',
      summary: '人物档案记录沈砚左手受伤，阴雨天会发抖。本章的动作描写没有同步这个已确认事实。',
      reason: '规则检出：人物状态“左手受伤”在第 1 章确认，第 4 章动作与状态冲突。',
      evidenceQuote: '第 1 章 · 回到雾港：“他左手在船难中受伤，阴雨天会发抖。”',
      evidenceSource: '第 1 章 · 回到雾港',
      impact: ['第 4 章 · 消失的灯塔', '人物 · 沈砚', '记忆 · 人物状态'],
      version: '基于 v13 · 02:14',
      stale: false
    },
    {
      id: 'tone', type: 'suggestion', severity: 'low', status: 'open',
      title: '语气建议：最后一句可以更克制',
      short: '解释性独白把情绪说满了，留下一点空白会更有余味。',
      chapterId: 2, chapterNo: '第 2 章', chapterTitle: '没有署名的信',
      quote: '她第一次意识到，那句话也许不是用来吓小孩的。',
      suggestion: '那句话，也许不是说给小孩听的。',
      summary: '这里不需要替读者总结“意识到”。让句子停在规则本身，读者会自己完成那一步。',
      reason: '模型建议：叙述语气偏解释，删去“意识到”可保留悬念。不是事实判断。',
      evidenceQuote: '第 2 章 · 没有署名的信：“她第一次意识到……”',
      evidenceSource: '第 2 章 · 没有署名的信',
      impact: ['第 2 章 · 没有署名的信', '人物 · 林遥', '语气 · 第三人称限知'],
      version: '基于 v13 · 02:14',
      stale: false
    },
    {
      id: 'memory', type: 'memory', severity: 'mid', status: 'open',
      title: '记忆候选：许青禾在船难前寄出过一封信',
      short: '来自第 2 章的无名信线索，等待作者确认是否进入事实库。',
      chapterId: 2, chapterNo: '第 2 章', chapterTitle: '没有署名的信',
      quote: '许青禾在船难前寄出过一封信。',
      suggestion: '',
      summary: '无名信的纸张来自潮汐旅馆，字迹与许青禾高度相似。模型推测这封信可能由她在船难前寄出。',
      reason: '模型建议：来源与笔迹相似，但没有直接证据证明寄信人。需作者确认后才进入档案。',
      evidenceQuote: '第 2 章 · 没有署名的信：“没有寄件人，没有落款……”',
      evidenceSource: '第 2 章 · 没有署名的信',
      impact: ['人物 · 许青禾', '线索 · 无名信', '档案 · 待确认'],
      version: '基于 v13 · 02:14',
      stale: false
    }
  ];

  /* ------------------------------------------------------------
     Helpers
     ------------------------------------------------------------ */
  const pageNames = { desk: '书桌', write: '写作', outline: '大纲', galaxy: '星图', archive: '档案', review: '审阅' };
  const activeChapter = () => chapters.find((chapter) => chapter.id === state.activeChapter) || chapters[1];
  const statusClass = (status) => status === '已定稿' ? 'final' : status === '大纲' ? 'outline' : 'draft';

  function stripToExcerpt(html, max = 96) {
    const text = plainText(html).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function chapterFromSource(source) {
    const match = String(source || '').match(/第\s*(\d+)\s*章/);
    if (!match) return null;
    return chapters.find((chapter) => chapter.id === Number(match[1])) || null;
  }

  function findChapterByTitle(title) {
    return chapters.find((chapter) => chapter.title === title) || null;
  }

  function toast(message, actionLabel = '', action = null) {
    const box = $('#toast');
    const text = $('#toastText');
    const actionBtn = $('#toastAction');
    text.textContent = message;
    if (actionLabel && action) {
      actionBtn.hidden = false;
      actionBtn.textContent = actionLabel;
      actionBtn.onclick = () => {
        hideToast();
        action();
      };
    } else {
      actionBtn.hidden = true;
      actionBtn.onclick = null;
    }
    box.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(hideToast, 5200);
  }

  function hideToast() {
    const box = $('#toast');
    if (box) box.hidden = true;
    clearTimeout(state.toastTimer);
  }

  function updateClockLabels() {
    const time = state.lastSaved;
    const saveText = $('#saveText');
    const saveTime = $('#saveTime');
    const statusText = $('#statusSaveText');
    const statusTime = $('#statusSaveTime');
    const saveState = $('#saveState');
    const statusSave = $('.status-save');
    if (saveState) saveState.classList.remove('is-saving');
    if (statusSave) statusSave.classList.remove('is-saving');
    if (saveText) saveText.textContent = '已保存';
    if (saveTime) saveTime.textContent = time;
    if (statusText) statusText.textContent = '已保存';
    if (statusTime) statusTime.textContent = time;
    const deskClock = $('#deskClock');
    if (deskClock) deskClock.textContent = time;
    const continueMeta = $('#continueMeta');
    if (continueMeta) {
      const chapter = chapters[1];
      continueMeta.innerHTML = `${chapter.words.toLocaleString()} / ${chapter.target.toLocaleString()} 字 <span>·</span> 最后保存 ${time} <span>·</span> 第 2 稿`;
    }
  }

  function markSaving() {
    const saveState = $('#saveState');
    const statusSave = $('.status-save');
    if (saveState) {
      saveState.classList.add('is-saving');
      $('#saveText').textContent = '正在保存';
    }
    if (statusSave) {
      statusSave.classList.add('is-saving');
      $('#statusSaveText').textContent = '正在保存';
      $('#statusSaveTime').textContent = '';
    }
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 800);
  }

  function saveNow() {
    state.lastSaved = timeNow();
    const saveState = $('#saveState');
    const statusSave = $('.status-save');
    if (saveState) {
      saveState.classList.remove('is-saving');
      $('#saveText').textContent = '已保存';
      $('#saveTime').textContent = state.lastSaved;
    }
    if (statusSave) {
      statusSave.classList.remove('is-saving');
      $('#statusSaveText').textContent = '已保存';
      $('#statusSaveTime').textContent = state.lastSaved;
    }
    const deskClock = $('#deskClock');
    if (deskClock) deskClock.textContent = state.lastSaved;
    updateClockLabels();
  }

  function updateWordUI() {
    const chapter = activeChapter();
    const count = chapter.words.toLocaleString();
    const target = chapter.target.toLocaleString();
    const wordsEl = $('#paperWords');
    if (wordsEl) wordsEl.textContent = `${count} 字`;
    const meta = $('#editorMeta');
    if (meta) meta.innerHTML = `<span>第 ${chapter.id} 章</span><i></i><span>${chapter.status}</span><i></i><span>${count} / ${target} 字</span>`;
    const today = $('#statusToday');
    if (today) today.textContent = count;
    const focusWords = $('#focusWords');
    if (focusWords) focusWords.textContent = count;
    const todayWords = $('#todayWords');
    if (todayWords) todayWords.textContent = count;
    const continueMeta = $('#continueMeta');
    if (continueMeta) continueMeta.innerHTML = `${count} / ${target} 字 <span>·</span> 最后保存 ${state.lastSaved} <span>·</span> 第 2 稿`;
    const progress = $('#continueProgress');
    if (progress) {
      const percent = clamp(Math.round(chapter.words / chapter.target * 100), 0, 100);
      const fill = progress.querySelector('.progress-track i');
      const dot = progress.querySelector('.progress-track b');
      const label = progress.querySelector('.progress-label strong');
      const caption = progress.querySelector('p');
      if (fill) fill.style.width = `${percent}%`;
      if (dot) dot.style.left = `${percent}%`;
      if (label) label.textContent = `${percent}%`;
      if (caption) caption.textContent = `还差 ${Math.max(0, chapter.target - chapter.words).toLocaleString()} 字到本章目标。慢慢来。`;
    }
    const activeItem = $('.chapter-item.is-active');
    if (activeItem) {
      const em = activeItem.querySelector('em');
      if (em) em.textContent = `${count} 字`;
    }
    const row = $(`.chapter-row[data-chapter="${chapter.id}"]`);
    if (row) {
      const words = row.querySelector('.row-words');
      if (words) words.textContent = `${count} 字`;
    }
  }

  // 字数采用“示例基线 + 本次编辑增量”，避免切换章节或采纳建议时把演示字数重置为实际字符数。
  function setChapterWordsFromDom() {
    const chapter = activeChapter();
    const prose = $('#prose');
    if (!prose) return;
    const nextCount = countChars(prose.innerHTML);
    chapter.words = Math.max(0, chapter.words + (nextCount - chapter._count));
    chapter._count = nextCount;
    chapter.html = prose.innerHTML;
    updateWordUI();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------
     Navigation
     ------------------------------------------------------------ */
  function closePanes() {
    document.body.classList.remove('margin-open', 'chapters-open');
    const backdrop = $('#paneBackdrop');
    if (backdrop) backdrop.hidden = true;
  }

  function closeAnyOverlay() {
    if (!$('#palette').hidden) {
      closePalette();
      return true;
    }
    const drawer = $('.drawer-backdrop');
    if (drawer) {
      drawer.remove();
      unlockScroll();
      return true;
    }
    const modal = $$('.modal-backdrop').find((item) => !item.hidden);
    if (modal) {
      closeModal(modal);
      return true;
    }
    if (document.body.classList.contains('focus-mode')) {
      exitFocus();
      return true;
    }
    const toolbar = $('#selectionToolbar');
    if (toolbar && !toolbar.hidden) {
      toolbar.hidden = true;
      return true;
    }
    if (document.body.classList.contains('margin-open') || document.body.classList.contains('chapters-open')) {
      closePanes();
      return true;
    }
    return false;
  }

  function go(view) {
    if (!pageNames[view]) return;
    if (document.body.classList.contains('focus-mode')) exitFocus();
    state.view = view;
    $$('.view').forEach((section) => section.classList.toggle('is-active', section.dataset.view === view));
    $$('.rail-item, .mobile-nav button').forEach((button) => {
      const active = button.dataset.nav === view;
      button.classList.toggle('is-active', active);
      if (button.classList.contains('rail-item')) {
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    });
    const pageName = $('#topbarPage');
    if (pageName) pageName.textContent = pageNames[view];
    document.title = `织章 · StoryWeave — ${pageNames[view]}`;
    if ($('#bookPop')) $('#bookPop').hidden = true;
    $('#bookSwitch')?.setAttribute('aria-expanded', 'false');
    closePanes();
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (view === 'write') {
      const paperScroll = $('#paperScroll');
      if (paperScroll) paperScroll.scrollTop = 0;
    }
    if (view === 'galaxy') {
      // 星图在切换时重新计算边线，避免隐藏页面的尺寸为 0。
      requestAnimationFrame(() => updateGalaxyGeometry());
    }
    if (view === 'desk') renderDesk();
    else if (view === 'outline') renderOutline();
    else if (view === 'archive') renderArchive();
    else if (view === 'review') renderIssues();
  }

  /* ------------------------------------------------------------
     Desk
     ------------------------------------------------------------ */
  function greeting() {
    const hour = new Date().getHours();
    if (hour < 5) return '夜里好';
    if (hour < 11) return '早上好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }

  function renderDesk() {
    const now = new Date();
    const dateLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: 'long' })
      .format(now).toUpperCase();
    const dateNode = $('#deskDate');
    if (dateNode) dateNode.textContent = dateLabel;
    const heading = $('#deskHeading');
    if (heading) heading.innerHTML = `${greeting()}，<br><em>故事还在等你。</em>`;
    const chapter = chapters[1];
    const continueChapter = $('#continueChapter');
    if (continueChapter) continueChapter.textContent = chapter.title;
    const continueStatus = $('#continueStatus');
    if (continueStatus) {
      continueStatus.textContent = chapter.status;
      continueStatus.className = `status-pill ${statusClass(chapter.status)}`;
    }
    const excerpt = $('#continueExcerpt');
    if (excerpt) excerpt.textContent = `“${stripToExcerpt(chapter.html, 92)}”`;
    const meta = $('#continueMeta');
    if (meta) meta.innerHTML = `${chapter.words.toLocaleString()} / ${chapter.target.toLocaleString()} 字 <span>·</span> 最后保存 ${state.lastSaved} <span>·</span> 第 2 稿`;
    const progress = $('#continueProgress');
    const percent = clamp(Math.round(chapter.words / chapter.target * 100), 0, 100);
    if (progress) {
      const fill = progress.querySelector('.progress-track i');
      const dot = progress.querySelector('.progress-track b');
      const label = progress.querySelector('.progress-label strong');
      const caption = progress.querySelector('p');
      if (fill) fill.style.width = `${percent}%`;
      if (dot) dot.style.left = `${percent}%`;
      if (label) label.textContent = `${percent}%`;
      if (caption) caption.textContent = `还差 ${Math.max(0, chapter.target - chapter.words).toLocaleString()} 字到本章目标。慢慢来。`;
    }
    const todayWords = $('#todayWords');
    if (todayWords) todayWords.textContent = chapter.words.toLocaleString();
    renderDeskChapters();
    renderNotes();
  }

  function renderDeskChapters() {
    const holder = $('#deskChapters');
    if (!holder) return;
    const rows = chapters.filter((chapter) => chapter.volume === 1).map((chapter) => `
      <button class="chapter-row" data-chapter="${chapter.id}" type="button">
        <span class="row-no">${chapter.no}</span>
        <span class="row-title"><b>${esc(chapter.title)}</b><small>${esc(chapter.summary)}</small></span>
        <span class="row-words">${chapter.words.toLocaleString()} 字</span>
        <span class="row-state"><i class="status-dot ${chapter.status === '已定稿' ? 'done' : ''}"></i>${esc(chapter.status)}</span>
        <svg class="icon row-arrow"><use href="#i-arrow"/></svg>
      </button>
    `).join('');
    holder.innerHTML = rows + `
      <button class="chapter-more" type="button" data-nav="outline">
        <span>第二卷 · 潮汐之下</span><small>${chapters.filter((chapter) => chapter.volume === 2).length} 章大纲</small><svg class="icon"><use href="#i-arrow"/></svg>
      </button>
    `;
  }

  function renderNotes() {
    const holder = $('#deskNotes');
    if (!holder) return;
    holder.innerHTML = state.notes.map((note, index) => `
      <li class="${index === 0 ? 'is-new' : ''}"><span>${esc(note.text)}</span><small>${esc(note.meta)}</small></li>
    `).join('');
    const count = $('#noteCount');
    if (count) count.textContent = String(state.notes.length);
  }

  function addNote(text) {
    const clean = text.trim();
    if (!clean) return;
    state.notes.unshift({ text: clean, meta: '刚刚' });
    renderNotes();
    const input = $('#noteInput');
    if (input) input.value = '';
    toast('已收进桌边的便笺。');
  }

  /* ------------------------------------------------------------
     Writing
     ------------------------------------------------------------ */
  function renderChapterList(filter = '') {
    const holder = $('#chapterList');
    if (!holder) return;
    const query = filter.trim().toLowerCase();
    let html = '';
    let found = 0;
    volumes.forEach((volume) => {
      const list = chapters.filter((chapter) => chapter.volume === volume.id && (
        !query || chapter.title.toLowerCase().includes(query) || chapter.no.includes(query)
      ));
      if (!list.length) return;
      found += list.length;
      const total = chapters.filter((chapter) => chapter.volume === volume.id).reduce((sum, chapter) => sum + chapter.words, 0);
      html += `
        <div class="chapter-volume"><span>${volume.label} · ${esc(volume.title)}</span><small>${list.length} 章 · ${total.toLocaleString()} 字</small></div>
        ${list.map((chapter) => `
          <button class="chapter-item ${chapter.id === state.activeChapter ? 'is-active' : ''}" type="button" data-chapter="${chapter.id}">
            <span class="chapter-no">${chapter.no}</span>
            <span class="chapter-info">
              <b>${esc(chapter.title)}</b>
              <small><i class="status-dot ${chapter.status === '已定稿' ? 'done' : chapter.status === '大纲' ? '' : 'live'}"></i>${esc(chapter.status)} · <em>${chapter.words.toLocaleString()} 字</em></small>
            </span>
          </button>
        `).join('')}
      `;
    });
    holder.innerHTML = found ? html : '<p class="chapter-empty">没有找到章节。</p>';
  }

  function renderMargin(chapter) {
    const goal = $('#marginGoal');
    if (goal) goal.textContent = chapter.goal;
    const beats = $('#marginBeats');
    if (beats) {
      beats.innerHTML = chapter.beats.map((beat, index) => `
        <li class="${beat.done ? 'is-done' : ''}"><span class="beat-index">${beat.done ? '✓' : pad(index + 1)}</span><span>${esc(beat.text)}</span></li>
      `).join('');
    }
    const progress = $('#beatProgress');
    if (progress) {
      const done = chapter.beats.filter((beat) => beat.done).length;
      progress.textContent = `${done} / ${chapter.beats.length}`;
    }
    const people = $('#marginPeople');
    if (people) {
      people.innerHTML = chapter.people.length
        ? chapter.people.map((person) => `<span class="chip ${person.kind === 'character' ? 'is-character' : 'is-place'}">${esc(person.name)}</span>`).join('')
        : '<span class="chip">尚未设定</span>';
    }
    const pov = $('#marginPov');
    if (pov) pov.textContent = chapter.pov;
  }

  function renderSuggestionCard() {
    const card = $('#suggestionCard');
    if (!card) return;
    const tone = issues.find((issue) => issue.id === 'tone');
    if (!tone || tone.status !== 'open') {
      card.innerHTML = `
        <div class="suggestion-done"><svg class="icon"><use href="#i-check"/></svg><span>已处理这条语气建议。原稿仍保留在版本历史里。</span></div>
      `;
      card.classList.add('is-done');
    } else if (state.activeChapter !== 2) {
      card.innerHTML = `
        <div class="suggestion-done"><svg class="icon"><use href="#i-spark"/></svg><span>这一章还没有生成建议。写下一段后，再让织章整理上下文。</span></div>
      `;
      card.classList.add('is-done');
    } else {
      card.classList.remove('is-done');
      card.innerHTML = `
        <header><span class="suggestion-kind">语气 · 第 9 段</span><span class="suggestion-source">演示建议</span></header>
        <p class="suggestion-original">她第一次意识到，那句话也许不是用来吓小孩的。</p>
        <div class="suggestion-alt"><span>更克制</span><p>那句话，也许不是说给小孩听的。</p></div>
        <footer><button class="btn btn-primary small" data-accept-suggestion>替换</button><button class="btn btn-ghost small" data-ignore-suggestion>忽略</button></footer>
      `;
    }
    const badge = $('#suggestBadge');
    if (badge) {
      const openCount = issues.filter((issue) => issue.type === 'suggestion' && issue.status === 'open').length + 1;
      badge.textContent = String(openCount);
      badge.hidden = openCount === 0;
    }
  }

  function selectChapter(id, navigate = true) {
    const chapter = chapters.find((item) => item.id === Number(id));
    if (!chapter) return;
    state.activeChapter = chapter.id;
    state.suggestionState = 'open';
    const title = $('#paperTitle');
    if (title) title.textContent = chapter.title;
    const prose = $('#prose');
    if (prose) {
      prose.innerHTML = chapter.html;
      prose.dataset.placeholder = '第一句，从空白开始。';
      if (!chapter.html) prose.innerHTML = '';
    }
    const chapterNo = $('#paperChapterNo');
    if (chapterNo) chapterNo.textContent = `第 ${chapter.id} 章`;
    const folioNo = $('#paperFolioNo');
    if (folioNo) folioNo.textContent = chapter.no;
    const folioTitle = $('.folio');
    if (folioTitle) folioTitle.innerHTML = `雾港来信 <span>/</span> ${chapter.volume === 1 ? '第一卷 · 雾中来信' : '第二卷 · 潮汐之下'}`;
    const focusChapter = $('#focusChapter');
    if (focusChapter) focusChapter.textContent = `第 ${chapter.id} 章 · ${chapter.title}`;
    chapter._count = countChars(chapter.html);
    renderChapterList($('#chapterSearch')?.value || '');
    renderMargin(chapter);
    renderSuggestionCard();
    updateWordUI();
    updateClockLabels();
    if (navigate) {
      go('write');
      const paperScroll = $('#paperScroll');
      if (paperScroll) paperScroll.scrollTop = 0;
    }
  }

  function updateChapterTitle() {
    const chapter = activeChapter();
    const title = $('#paperTitle');
    if (!title) return;
    chapter.title = title.textContent.trim() || '未命名章节';
    const activeItem = $('.chapter-item.is-active');
    if (activeItem) {
      const b = activeItem.querySelector('b');
      if (b) b.textContent = chapter.title;
    }
    markSaving();
  }

  function addTextToProse(html) {
    const prose = $('#prose');
    if (!prose) return;
    prose.insertAdjacentHTML('beforeend', html);
    setChapterWordsFromDom();
    markSaving();
    prose.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ------------------------------------------------------------
     Outline
     ------------------------------------------------------------ */
  function renderVolumeBoard() {
    const holder = $('#volumeBoard');
    if (!holder) return;
    holder.innerHTML = volumes.map((volume) => {
      const list = chapters.filter((chapter) => chapter.volume === volume.id);
      const total = list.reduce((sum, chapter) => sum + chapter.words, 0);
      return `
        <section class="volume-col" data-volume-col="${volume.id}">
          <span class="volume-roman">${volume.roman}</span>
          <header class="volume-head">
            <div><span class="volume-kicker">${volume.label} · ${volume.note}</span><h3>${volume.title}</h3></div>
            <span class="volume-count">${list.length} 章 · ${total.toLocaleString()} 字</span>
          </header>
          <div class="chapter-cards" data-volume-cards="${volume.id}">
            ${list.map((chapter) => `
              <article class="chapter-card" draggable="true" data-outline-chapter="${chapter.id}" tabindex="0" role="button" aria-label="查看第 ${chapter.id} 章 ${esc(chapter.title)}">
                <div class="card-top"><span class="card-no">${chapter.no}</span><span class="status-pill ${statusClass(chapter.status)}">${esc(chapter.status)}</span></div>
                <h4>${esc(chapter.title)}</h4>
                <p>${esc(chapter.summary)}</p>
                <div class="card-foot"><span>${esc(chapter.pov.replace('第三人称 · ', 'POV · '))}</span><span class="tension"><span class="tension-bars">${[1,2,3].map((n) => `<i class="${n <= Math.ceil(chapter.tension / 5 * 3) ? 'on' : ''}"></i>`).join('')}</span>张力 ${chapter.tension}</span></div>
              </article>
            `).join('')}
          </div>
          <button class="add-card" type="button" data-add-chapter="${volume.id}"><svg class="icon"><use href="#i-plus"/></svg>新增章节</button>
        </section>
      `;
    }).join('');
  }

  const threads = [
    {
      id: 'truth', name: '灯塔真相', label: '主线', color: 'var(--accent)',
      note: '灯塔为何消失，又为何在退潮后出现。',
      nodes: [
        { ch: 1, text: '灯塔不在原处', state: 'done' },
        { ch: 2, text: '码头望见空白', state: 'done' },
        { ch: 4, text: '退潮后出现', state: 'done' },
        { ch: 6, text: '潮汐表异常', state: 'planned' }
      ]
    },
    {
      id: 'heart', name: '林遥 × 沈砚', label: '情感', color: 'var(--rose)',
      note: '两个人都知道一部分真相，但都不肯先开口。',
      nodes: [
        { ch: 1, text: '旧友未接电话', state: 'done' },
        { ch: 4, text: '灯塔门口相遇', state: 'done' },
        { ch: 5, text: '说出旧名字', state: 'planned' },
        { ch: 7, text: '回信之后', state: 'planned' }
      ]
    },
    {
      id: 'letterline', name: '无名信', label: '悬疑', color: 'var(--sage)',
      note: '谁寄的，为什么没有落款。',
      nodes: [
        { ch: 2, text: '信出现', state: 'done' },
        { ch: 3, text: '母亲的名字', state: 'done' },
        { ch: 7, text: '回信', state: 'planned' }
      ]
    },
    {
      id: 'rule', name: '不要回头', label: '伏笔', color: 'var(--gold)',
      note: '第 2 章埋下，第 6 章计划回收。',
      nodes: [
        { ch: 2, text: '母亲的叮嘱', state: 'done' },
        { ch: 4, text: '日志最后一页', state: 'done' },
        { ch: 6, text: '例外的代价', state: 'planned' }
      ]
    },
    {
      id: 'zhou', name: '周叔的记忆', label: '人物', color: 'var(--fog, #7f9db8)',
      note: '他记得灯塔，却坚持说它已经拆了。',
      nodes: [
        { ch: 3, text: '名单的漏洞', state: 'done' },
        { ch: 6, text: '抽屉里的潮汐表', state: 'planned' }
      ]
    }
  ];

  function renderThreads() {
    const holder = $('#threadBoard');
    if (!holder) return;
    holder.innerHTML = `
      <div class="thread-grid">
        <div class="thread-chapters"><span>线索 / 章节</span>${chapters.map((chapter) => `<b>${chapter.no}</b>`).join('')}</div>
        ${threads.map((thread) => `
          <div class="thread-row">
            <div class="thread-label" style="--thread-color:${thread.color}"><b>${thread.name}</b><small>${thread.label} · ${thread.note}</small></div>
            <div class="thread-track">
              ${thread.nodes.map((node) => `<button class="thread-node ${node.state === 'planned' ? 'is-planned' : 'is-done'}" type="button" style="grid-column:${node.ch};--thread-color:${thread.color}" data-thread="${thread.id}" data-thread-node="${node.ch}">${esc(node.text)}</button>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  const beats = [
    { no: '01', act: '起', title: '夜车抵达', desc: '林遥在雾里回到雾港，旧宅的灯还亮着。', chapter: 1, tension: 20 },
    { no: '02', act: '起', title: '灯塔消失', desc: '记忆里的灯塔不在原处，无名信出现。', chapter: 2, tension: 35 },
    { no: '03', act: '承', title: '名单的漏洞', desc: '周叔说：名单上有她，上船的人不是她。', chapter: 3, tension: 52 },
    { no: '04', act: '承', title: '退潮之后', desc: '灯塔出现二十分钟，日志只剩“不要回头”。', chapter: 4, tension: 78 },
    { no: '05', act: '转', title: '旧名字', desc: '沈砚说出许青禾的名字，灯暗了一下。', chapter: 5, tension: 60 },
    { no: '06', act: '转', title: '没有退潮', desc: '潮汐表被涂改，官方记录开始崩塌。', chapter: 6, tension: 88 },
    { no: '07', act: '合', title: '回信', desc: '林遥不再等答案，她把回信投进邮局。', chapter: 7, tension: 70 }
  ];

  function smoothPath(points) {
    if (!points.length) return '';
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  }

  function renderBeatChart() {
    const holder = $('#tensionChart');
    if (!holder) return;
    const width = 1000;
    const height = 176;
    const left = 28;
    const right = 28;
    const top = 22;
    const bottom = 42;
    const points = beats.map((beat, index) => ({
      ...beat,
      x: left + index * ((width - left - right) / (beats.length - 1)),
      y: top + (100 - beat.tension) / 100 * (height - top - bottom)
    }));
    const line = smoothPath(points);
    const area = `${line} L ${points[points.length - 1].x} ${height - bottom} L ${points[0].x} ${height - bottom} Z`;
    holder.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="七章情绪张力曲线">
        <defs>
          <linearGradient id="tensionFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="rgba(178,70,43,.20)"/>
            <stop offset="1" stop-color="rgba(178,70,43,0)"/>
          </linearGradient>
        </defs>
        ${[0, 1, 2, 3].map((n) => `<line class="grid-line" x1="${left}" y1="${top + n * (height - top - bottom) / 3}" x2="${width - right}" y2="${top + n * (height - top - bottom) / 3}"/>`).join('')}
        <path class="curve-area" d="${area}"/>
        <path class="curve" d="${line}"/>
        ${points.map((point) => `
          <g data-chart-chapter="${point.chapter}" tabindex="0" role="button" aria-label="第 ${point.chapter} 章 ${point.title}">
            <circle class="point" cx="${point.x}" cy="${point.y}" r="4.5"/>
            <text class="point-title" x="${point.x}" y="${point.y - 13}" text-anchor="middle">${point.title}</text>
            <text class="point-label" x="${point.x}" y="${height - 16}" text-anchor="middle">${point.no}</text>
          </g>
        `).join('')}
      </svg>
    `;
  }

  function renderBeatList() {
    const holder = $('#beatList');
    if (!holder) return;
    holder.innerHTML = beats.map((beat) => `
      <button class="beat-item" type="button" data-beat="${beat.chapter}">
        <span class="beat-no">${beat.no}</span>
        <span class="beat-copy"><span class="beat-act">${beat.act} · 第 ${beat.chapter} 章</span><h3>${beat.title}</h3><p>${beat.desc}</p></span>
        <span class="beat-chapter">张力 ${beat.tension}</span>
      </button>
    `).join('');
  }

  function renderOutline() {
    const count = $('#outlineCount');
    if (count) count.textContent = `${volumes.length} 卷 ${chapters.length} 章`;
    renderVolumeBoard();
    renderThreads();
    renderBeatChart();
    renderBeatList();
  }

  function openOutlineDrawer(chapter) {
    if (!chapter) return;
    const volume = volumes.find((item) => item.id === chapter.volume);
    openDrawer(`
      <header class="drawer-head">
        <div><p class="eyebrow">第 ${chapter.id} 章 · ${esc(chapter.status)}</p><h2>${esc(chapter.title)}</h2></div>
        <button class="icon-btn" type="button" data-close-drawer aria-label="关闭"><svg class="icon"><use href="#i-close"/></svg></button>
      </header>
      <div class="drawer-body">
        <p class="drawer-summary">${esc(chapter.summary)}</p>
        <div class="drawer-meta">
          <div><label>所属卷</label><p>${volume ? `${volume.label} · ${volume.title}` : '未分卷'}</p></div>
          <div><label>字数</label><p>${chapter.words.toLocaleString()} / ${chapter.target.toLocaleString()} 字</p></div>
          <div><label>视角</label><p>${esc(chapter.pov)}</p></div>
          <div><label>时间</label><p>${esc(chapter.time)}</p></div>
        </div>
        <div class="drawer-section"><h3>本章目标</h3><p>${esc(chapter.goal)}</p></div>
        <div class="drawer-section"><h3>场景节拍</h3>${chapter.beats.map((beat, index) => `<p>${beat.done ? '✓' : pad(index + 1)} · ${esc(beat.text)}</p>`).join('')}</div>
        <div class="drawer-section"><h3>在场人物</h3><p>${chapter.people.length ? chapter.people.map((person) => esc(person.name)).join(' · ') : '尚未设定'}</p></div>
      </div>
      <footer class="drawer-foot"><button class="btn btn-primary" type="button" data-chapter="${chapter.id}" data-close-drawer>打开正文</button><button class="btn btn-ghost" type="button" data-close-drawer>关闭</button></footer>
    `);
  }

  function openThreadDrawer(threadId) {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    openDrawer(`
      <header class="drawer-head">
        <div><p class="eyebrow">${thread.label} · 线索</p><h2>${thread.name}</h2></div>
        <button class="icon-btn" type="button" data-close-drawer aria-label="关闭"><svg class="icon"><use href="#i-close"/></svg></button>
      </header>
      <div class="drawer-body">
        <p class="drawer-summary">${esc(thread.note)}</p>
        <div class="drawer-section"><h3>章节节点</h3>${thread.nodes.map((node) => `<p>第 ${node.ch} 章 · ${esc(node.text)} <span class="muted">(${node.state === 'done' ? '已出现' : '计划中'})</span></p>`).join('')}</div>
        <div class="drawer-section"><h3>写作提示</h3><p>${thread.id === 'rule' ? '埋下与回收相隔 4 章。可以在第 4 章让林遥主动想起这句话，降低读者的遗忘。' : '节点之间最好有因果，而不只是时间顺序。'}</p></div>
      </div>
      <footer class="drawer-foot"><button class="btn btn-ghost" type="button" data-close-drawer>关闭</button></footer>
    `);
  }

  function openBeatDrawer(beatId) {
    const beat = beats.find((item) => item.chapter === Number(beatId));
    if (!beat) return;
    openDrawer(`
      <header class="drawer-head">
        <div><p class="eyebrow">${beat.act} · 第 ${beat.chapter} 章</p><h2>${beat.title}</h2></div>
        <button class="icon-btn" type="button" data-close-drawer aria-label="关闭"><svg class="icon"><use href="#i-close"/></svg></button>
      </header>
      <div class="drawer-body">
        <p class="drawer-summary">${esc(beat.desc)}</p>
        <div class="drawer-meta">
          <div><label>张力</label><p>${beat.tension} / 100</p></div>
          <div><label>节拍编号</label><p>${beat.no}</p></div>
        </div>
        <div class="drawer-section"><h3>写作提示</h3><p>这一拍负责把读者往前推。检查它是否改变了人物关系，或者让一个旧信息产生了新含义。</p></div>
      </div>
      <footer class="drawer-foot"><button class="btn btn-primary" type="button" data-chapter="${beat.chapter}" data-close-drawer>打开正文</button><button class="btn btn-ghost" type="button" data-close-drawer>关闭</button></footer>
    `);
  }

  function openDrawer(html) {
    const root = $('#drawerRoot');
    if (!root) return;
    root.innerHTML = `<div class="drawer-backdrop" data-drawer-backdrop><aside class="detail-drawer" role="dialog" aria-modal="true">${html}</aside></div>`;
    lockScroll();
  }

  function closeDrawer() {
    const root = $('#drawerRoot');
    if (root) root.innerHTML = '';
    unlockScroll();
  }

  /* ------------------------------------------------------------
     Archive
     ------------------------------------------------------------ */
  function archiveCollection() {
    return archiveData[state.archiveTab] || [];
  }

  function archiveAll() {
    return [...archiveData.people, ...archiveData.world, ...archiveData.clues];
  }

  function currentArchiveItem() {
    return archiveCollection().find((item) => item.id === state.archiveId) || archiveCollection()[0] || null;
  }

  function renderArchiveTabs() {
    const counts = { people: archiveData.people.length, world: archiveData.world.length, clues: archiveData.clues.length };
    const total = archiveAll().length;
    const totalNode = $('#archiveTotal');
    if (totalNode) totalNode.textContent = String(total);
    $$('#archiveTabs button').forEach((button) => {
      const key = button.dataset.tab;
      const count = button.querySelector('span');
      if (count) count.textContent = String(counts[key] || 0);
      button.classList.toggle('is-active', key === state.archiveTab);
      button.setAttribute('aria-selected', key === state.archiveTab ? 'true' : 'false');
    });
  }

  function renderArchive() {
    renderArchiveTabs();
    const holder = $('#archiveList');
    if (!holder) return;
    const query = state.archiveQuery.trim().toLowerCase();
    const list = archiveCollection().filter((item) => !query ||
      item.name.toLowerCase().includes(query) ||
      item.role.toLowerCase().includes(query) ||
      item.tags.some((tag) => tag.toLowerCase().includes(query))
    );
    if (!list.length) {
      holder.innerHTML = '<p class="chapter-empty">没有找到档案。</p>';
      $('#archiveDetail').innerHTML = '<div class="archive-empty">换一个名字，或者清空搜索。</div>';
      return;
    }
    if (!list.some((item) => item.id === state.archiveId)) state.archiveId = list[0].id;
    holder.innerHTML = list.map((item) => `
      <button class="archive-item ${item.id === state.archiveId ? 'is-active' : ''}" type="button" data-archive="${item.tab}" data-archive-id="${item.id}">
        <span class="archive-avatar" style="--tint:${item.tint}">${item.initial}</span>
        <span class="archive-item-copy"><b>${esc(item.name)}</b><small>${esc(item.role)}</small></span>
        <svg class="icon item-arrow"><use href="#i-chevron"/></svg>
      </button>
    `).join('');
    renderArchiveDetail();
    renderPendingCard();
  }

  function renderArchiveDetail() {
    const holder = $('#archiveDetail');
    const item = currentArchiveItem();
    if (!holder || !item) return;
    const related = item.relations.map((relation) => {
      const target = archiveAll().find((entry) => entry.name === relation.name);
      return { ...relation, target };
    });
    holder.innerHTML = `
      <header class="archive-detail-head">
        <span class="archive-portrait" style="--tint:${item.tint}">${item.initial}</span>
        <div class="archive-title-block">
          <p class="archive-en">${esc(item.en)}</p>
          <h2 class="archive-name">${esc(item.name)}</h2>
          <p class="archive-role">${esc(item.role)}</p>
        </div>
        <div class="archive-tags">${item.tags.map((tag) => `<span class="archive-tag">${esc(tag)}</span>`).join('')}</div>
      </header>
      <blockquote class="archive-quote">${esc(item.quote)}</blockquote>
      <section class="archive-section">
        <h3>此刻 <span>${esc(item.statusLabel)}</span></h3>
        <div class="status-line"><span class="status-pill ${item.statusType === 'planned' ? 'outline' : item.statusType === 'warning' ? 'review' : item.statusType === 'confirmed' ? 'final' : 'draft'}">${esc(item.statusLabel)}</span><p>${esc(item.status)}</p></div>
      </section>
      <section class="archive-section">
        <h3>${esc(item.factsTitle)} <span>作者已确认</span></h3>
        <div class="archive-facts">${item.facts.map((fact) => `<div class="fact"><label>${esc(fact.label)}</label><p>${esc(fact.text)}</p></div>`).join('')}</div>
      </section>
      <section class="archive-section">
        <h3>关系 <span>${related.length} 条</span></h3>
        <div class="relation-rows">
          ${related.map((relation) => `
            <button class="relation-row" type="button" ${relation.target ? `data-archive-rel="${relation.target.id}"` : ''}>
              <span class="relation-avatar" style="border-color:${relation.target ? relation.target.tint : 'var(--line-strong)'}">${relation.name.slice(0, 1)}</span>
              <span><b>${esc(relation.name)}</b><br><small>${esc(relation.rel)}</small></span>
              <svg class="icon" style="width:12px;height:12px;color:var(--faint)"><use href="#i-arrow-up"/></svg>
            </button>
          `).join('')}
        </div>
      </section>
      <section class="archive-section">
        <h3>出处与出场 <span>每条设定都能回到正文</span></h3>
        <div class="source-chips">
          ${item.sources.map((source) => `<button class="source-chip" type="button" data-locate-chapter="${chapterFromSource(source)?.id || ''}"><svg class="icon"><use href="#i-book"/></svg>${esc(source)}</button>`).join('')}
        </div>
        <p class="notes-hint" style="margin-top:10px">出场：${esc(item.appearances)}</p>
      </section>
      <div class="archive-actions">
        <button class="btn btn-primary" type="button" data-archive-edit>编辑档案</button>
        <button class="btn btn-ghost" type="button" data-locate-chapter="${chapterFromSource(item.sources[0])?.id || 1}">在正文中定位</button>
        <span class="meta">最后确认于 02:08 · 作者：林深</span>
      </div>
    `;
  }

  function renderPendingCard() {
    const card = $('#pendingCard');
    const count = $('#pendingCount');
    if (count) count.textContent = String(state.pendingCandidates);
    if (card) card.hidden = state.pendingCandidates <= 0;
    const deskPending = $('#deskPendingCount');
    if (deskPending) deskPending.textContent = state.pendingCandidates > 0 ? `${state.pendingCandidates} 条 AI 提取待确认` : '暂无 AI 提取待确认';
  }

  function chooseArchive(tab, id) {
    state.archiveTab = tab;
    state.archiveId = id;
    renderArchive();
  }

  function addCandidateToArchive() {
    if (archiveData.clues.some((clue) => clue.id === 'candidate-letter')) return;
    archiveData.clues.unshift({
      id: 'candidate-letter', tab: 'clues', type: '线索', en: 'THE LAST LETTER', name: '船难前的信', initial: '信', tint: '#8a5b43',
      role: '线索 · 由第 2 章提取 · 作者已确认', tags: ['已确认', '来源：第 2 章'],
      quote: '“许青禾在船难前寄出过一封信。”',
      status: '作者已确认。尚未确定寄出时间与收件人。',
      statusLabel: '已确认', statusType: 'confirmed',
      factsTitle: '已确认信息',
      facts: [
        { label: '来源', text: '第 2 章，无名信的纸张与笔迹。' },
        { label: '待补', text: '寄出时间、收件人、与无名信的关系。' },
        { label: '影响', text: '第 7 章回信时可用。' }
      ],
      relations: [
        { name: '许青禾', rel: '寄信人（待确认）' },
        { name: '无名信', rel: '可能是同一封' },
        { name: '林遥', rel: '收信人（未知）' }
      ],
      sources: ['第 2 章 · 没有署名的信'],
      appearances: '尚未在正文出现'
    });
    renderArchive();
  }

  /* ------------------------------------------------------------
     Review
     ------------------------------------------------------------ */
  function openIssues() {
    return issues.filter((issue) => issue.status === 'open');
  }

  function issueTypeLabel(issue) {
    if (issue.type === 'consistency') return '一致性';
    if (issue.type === 'suggestion') return '修改建议';
    return '记忆候选';
  }

  function issueCounts() {
    const open = issues.filter((issue) => issue.status === 'open');
    return {
      all: open.length,
      consistency: open.filter((issue) => issue.type === 'consistency').length,
      suggestion: open.filter((issue) => issue.type === 'suggestion').length,
      memory: open.filter((issue) => issue.type === 'memory').length
    };
  }

  function renderIssueStats() {
    const counts = issueCounts();
    const set = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
    set('#openIssueCount', counts.all);
    set('#ruleConflictCount', counts.consistency);
    set('#memoryCount', counts.memory);
    set('#tabAllCount', counts.all);
    set('#tabConsistencyCount', counts.consistency);
    set('#tabSuggestionCount', counts.suggestion);
    set('#tabMemoryCount', counts.memory);
    set('#railReviewBadge', counts.all);
    set('#mobileReviewBadge', counts.all);
    const deskReview = $('#deskReviewCount');
    if (deskReview) deskReview.textContent = `${counts.all} 处待审阅`;
    const deskConflict = $('#deskConflictNote');
    if (deskConflict) deskConflict.textContent = `其中 ${counts.consistency} 处规则冲突`;
    const railBadge = $('#railReviewBadge');
    if (railBadge) railBadge.hidden = counts.all === 0;
    const mobileBadge = $('#mobileReviewBadge');
    if (mobileBadge) mobileBadge.hidden = counts.all === 0;
  }

  function filteredIssues() {
    if (state.reviewFilter === 'all') return issues;
    return issues.filter((issue) => issue.type === state.reviewFilter);
  }

  function renderIssues() {
    renderIssueStats();
    const holder = $('#issueList');
    const detail = $('#issueDetail');
    const evidence = $('#evidencePane');
    const layout = $('.review-layout');
    if (!holder || !detail || !evidence) return;
    const list = filteredIssues().slice().sort((a, b) => {
      if (a.status === 'open' && b.status !== 'open') return -1;
      if (a.status !== 'open' && b.status === 'open') return 1;
      return issues.indexOf(a) - issues.indexOf(b);
    });
    const openTotal = openIssues().length;
    const emptyAll = openTotal === 0 && state.reviewFilter === 'all';

    if (!list.length || emptyAll) {
      layout?.classList.add('is-empty');
      holder.innerHTML = '';
      evidence.innerHTML = '';
      detail.innerHTML = `
        <div class="review-empty">
          <span class="seal-empty">审</span>
          <h2>${emptyAll ? '今天的稿子，审完了。' : '这个分类暂时没有待处理项。'}</h2>
          <p>${emptyAll ? '所有规则冲突、修改建议和记忆候选都已处理。去写下一段，或者回到正文看看修改后的句子。' : '换一个分类，或者回到正文继续写。'}</p>
          <button class="btn btn-primary" type="button" data-nav="write">回到正文</button>
        </div>
      `;
      return;
    }

    layout?.classList.remove('is-empty');
    if (!list.some((issue) => issue.id === state.issueId)) {
      state.issueId = (list.find((issue) => issue.status === 'open') || list[0]).id;
    }
    const selected = issues.find((issue) => issue.id === state.issueId) || list[0];
    holder.innerHTML = list.map((issue) => `
      <button class="issue-item ${issue.id === selected.id ? 'is-active' : ''} ${issue.status !== 'open' ? 'is-resolved' : ''}" type="button" data-issue="${issue.id}">
        <span class="issue-item-top"><i class="issue-sev ${issue.severity}"></i><span class="issue-type">${issueTypeLabel(issue)}</span>${issue.status !== 'open' ? `<span class="issue-status">${issue.status === 'resolved' ? '已采用' : issue.status === 'intentional' ? '有意安排' : '已忽略'}</span>` : ''}</span>
        <h3>${esc(issue.title)}</h3>
        <p>${esc(issue.short)}</p>
        <small>${esc(issue.chapterNo)} · ${esc(issue.chapterTitle)}</small>
      </button>
    `).join('');
    renderIssueDetail(selected);
    renderEvidence(selected);
  }

  function renderIssueDetail(issue) {
    const holder = $('#issueDetail');
    if (!holder || !issue) return;
    if (issue.status !== 'open') {
      const stateLabel = issue.status === 'resolved' ? '已采用' : issue.status === 'intentional' ? '有意安排' : '已忽略';
      holder.innerHTML = `
        <div class="issue-kicker"><span class="issue-sev ${issue.severity}"></span>${issueTypeLabel(issue)} · ${esc(issue.chapterNo)}</div>
        <h2>${esc(issue.title)}</h2>
        <p class="issue-summary">${esc(issue.summary)}</p>
        <div class="quote-box"><span>${issue.type === 'memory' ? '候选事实' : '原文位置'}</span><p>${esc(issue.quote)}</p></div>
        <div class="reason-box"><span>当前状态</span><p>这条已经被标记为“${stateLabel}”。${issue.type === 'memory' && issue.status === 'resolved' ? '事实已写入故事档案，引用仍保留。' : '正文没有被自动改写。'}</p></div>
        <div class="issue-actions">
          <button class="btn btn-ghost" type="button" data-issue-action="reopen">重新打开</button>
          <span class="spacer"></span>
          <button class="text-btn" type="button" data-locate-chapter="${issue.chapterId}">在正文中定位</button>
        </div>
      `;
      return;
    }
    if (issue.type === 'memory') {
      holder.innerHTML = `
        <div class="issue-kicker"><span class="issue-sev ${issue.severity}"></span>记忆候选 · ${esc(issue.chapterNo)}</div>
        <h2>${esc(issue.title)}</h2>
        <p class="issue-summary">${esc(issue.summary)}</p>
        <div class="quote-box"><span>候选事实</span><p>${esc(issue.quote)}</p></div>
        <div class="reason-box"><span>为什么会出现</span><p>${esc(issue.reason)}</p></div>
        <div class="issue-actions">
          <button class="btn btn-primary" type="button" data-issue-action="accept">纳入档案</button>
          <button class="btn btn-ghost" type="button" data-issue-action="ignore">暂不采用</button>
          <span class="spacer"></span>
          <button class="text-btn" type="button" data-issue-action="later">稍后处理</button>
        </div>
      `;
      return;
    }
    const isSuggestion = issue.type === 'suggestion';
    const diffSide = `
      <div class="diff">
        <div class="diff-col"><span>原文</span><p>${esc(issue.quote)}</p></div>
        <div class="diff-col is-new"><span>${isSuggestion ? '建议' : '修正'}</span><p>${esc(issue.suggestion)}</p></div>
      </div>
    `;
    const diffInline = `
      <div class="diff-inline"><del>${esc(issue.quote)}</del> <ins>${esc(issue.suggestion)}</ins></div>
    `;
    holder.innerHTML = `
      <div class="issue-kicker"><span class="issue-sev ${issue.severity}"></span>${issueTypeLabel(issue)} · ${esc(issue.chapterNo)}</div>
      <h2>${esc(issue.title)}</h2>
      <p class="issue-summary">${esc(issue.summary)}</p>
      <div class="quote-box"><span>原文位置</span><p>${esc(issue.quote)}</p></div>
      <div class="diff-toolbar"><span>对比</span><div class="diff-toggle"><button type="button" data-diff-mode="side" class="${state.diffMode === 'side' ? 'is-active' : ''}">并排</button><button type="button" data-diff-mode="inline" class="${state.diffMode === 'inline' ? 'is-active' : ''}">行内</button></div></div>
      <div class="diff-wrap ${state.diffMode === 'inline' ? 'is-inline' : ''}">${diffSide}${diffInline}</div>
      <div class="reason-box"><span>${isSuggestion ? '模型建议，不是事实判断' : '规则检出的依据'}</span><p>${esc(issue.reason)}</p></div>
      <div class="issue-actions">
        <button class="btn btn-primary" type="button" data-issue-action="accept">${isSuggestion ? '采用修改' : '采用修正'}</button>
        <button class="btn btn-ghost" type="button" data-issue-action="intentional">标记为有意安排</button>
        <button class="btn btn-ghost" type="button" data-issue-action="ignore">忽略</button>
        <span class="spacer"></span>
        <button class="text-btn" type="button" data-issue-action="later">稍后处理</button>
      </div>
    `;
  }

  function renderEvidence(issue) {
    const holder = $('#evidencePane');
    if (!holder || !issue) return;
    holder.innerHTML = `
      <section class="evidence-section">
        <div class="evidence-label"><svg class="icon"><use href="#i-book"/></svg>出处</div>
        <p class="evidence-quote">${esc(issue.evidenceQuote)}</p>
        <button class="evidence-source" type="button" data-locate-chapter="${issue.chapterId}">${esc(issue.evidenceSource)} →</button>
      </section>
      <section class="evidence-section">
        <div class="evidence-label"><svg class="icon"><use href="#i-branch"/></svg>影响范围</div>
        <div class="impact-chips">${issue.impact.map((item) => `<span class="impact-chip">${esc(item)}</span>`).join('')}</div>
      </section>
      <section class="evidence-section">
        <div class="evidence-label"><svg class="icon"><use href="#i-clock"/></svg>版本</div>
        <div class="version-card">
          <div><span>当前正文</span><b>v13 · 02:14</b></div>
          <div><span>本建议基于</span><b>${issue.stale ? 'v12 · 02:10' : 'v13 · 02:14'}</b></div>
          ${issue.stale ? '<p class="stale">正文已更新。采用前请重新核对这句话的上下文。</p>' : ''}
        </div>
      </section>
      <section class="evidence-section">
        <div class="evidence-label"><svg class="icon"><use href="#i-spark"/></svg>下一步</div>
        <div class="evidence-actions">
          <button class="btn btn-ghost" type="button" data-recheck>重新检查本章</button>
          <button class="btn btn-ghost" type="button" data-locate-chapter="${issue.chapterId}">在正文中定位</button>
        </div>
      </section>
    `;
  }

  // 审阅处理会同时影响正文、字数、档案候选和队列；撤销依赖进入函数时保存的旧 HTML 与旧字数。
  function resolveIssue(id, decision) {
    const issue = issues.find((item) => item.id === id);
    if (!issue || issue.status !== 'open') return;
    const chapter = chapters.find((item) => item.id === issue.chapterId);
    const oldHtml = chapter ? chapter.html : '';
    const oldWords = chapter ? chapter.words : 0;
    const oldStatus = issue.status;
    const oldPending = state.pendingCandidates;
    let replaced = false;

    if (decision === 'accept') {
      if (issue.type === 'memory') {
        addCandidateToArchive();
        state.pendingCandidates = Math.max(0, state.pendingCandidates - 1);
      } else if (chapter) {
        const marked = `<span class="ai-mark" data-ai-mark>${issue.quote}</span>`;
        if (chapter.html.includes(marked)) {
          chapter.html = chapter.html.replace(marked, issue.suggestion);
          replaced = true;
        } else if (chapter.html.includes(issue.quote)) {
          chapter.html = chapter.html.replace(issue.quote, issue.suggestion);
          replaced = true;
        }
        if (replaced) {
          const nextCount = countChars(chapter.html);
          chapter.words = Math.max(0, chapter.words + (nextCount - chapter._count));
          chapter._count = nextCount;
        }
      }
      issue.status = 'resolved';
    } else if (decision === 'intentional') {
      issue.status = 'intentional';
    } else {
      issue.status = 'ignored';
      if (issue.type === 'memory') {
        state.pendingCandidates = Math.max(0, state.pendingCandidates - 1);
      }
      if (issue.id === 'tone' && chapter) {
        const marked = new RegExp(`<span class="ai-mark"[^>]*>${escapeRegExp(issue.quote)}</span>`, 'g');
        chapter.html = chapter.html.replace(marked, '');
        const nextCount = countChars(chapter.html);
        chapter.words = Math.max(0, chapter.words + (nextCount - chapter._count));
        chapter._count = nextCount;
      }
    }

    if (chapter && state.activeChapter === chapter.id) {
      const prose = $('#prose');
      if (prose) prose.innerHTML = chapter.html;
      updateWordUI();
      renderSuggestionCard();
      markSaving();
    }
    state.issueId = null;
    renderArchive();
    renderPendingCard();
    renderIssues();
    const message = decision === 'accept'
      ? (issue.type === 'memory' ? '已纳入档案，来源保留在第 2 章。' : '已采用修改，原稿保留在版本历史里。')
      : decision === 'intentional' ? '已标记为有意安排，这条提醒不会再出现。' : '已忽略这条建议。';
    toast(message, '撤销', () => {
      issue.status = oldStatus;
      state.pendingCandidates = oldPending;
      state.issueId = issue.id;
      if (chapter) {
        chapter.html = oldHtml;
        chapter.words = oldWords;
        chapter._count = countChars(oldHtml);
        if (state.activeChapter === chapter.id) {
          const prose = $('#prose');
          if (prose) prose.innerHTML = chapter.html;
        }
      }
      if (decision === 'accept' && issue.type === 'memory') {
        archiveData.clues = archiveData.clues.filter((clue) => clue.id !== 'candidate-letter');
      }
      renderArchive();
      renderPendingCard();
      renderIssues();
      renderSuggestionCard();
      updateWordUI();
      toast('已撤销这次处理。');
    });
  }

  /* ------------------------------------------------------------
     Galaxy
     ------------------------------------------------------------ */
  const nodeTypes = {
    character: { label: '人物', color: '#d08063', radius: 21 },
    place: { label: '地点', color: '#7fa596', radius: 18 },
    clue: { label: '线索', color: '#d0b070', radius: 16 },
    event: { label: '事件', color: '#9a8db5', radius: 18 },
    object: { label: '物品', color: '#7f9db8', radius: 15 }
  };
  const galaxy = {
    nodeEls: new Map(),
    edgeEls: new Map()
  };

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG, tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    return el;
  }

  function seededRandom(seed) {
    let value = seed % 2147483647;
    if (value <= 0) value += 2147483646;
    return () => {
      value = value * 16807 % 2147483647;
      return (value - 1) / 2147483646;
    };
  }

  // 星图节点保存的是 SVG 用户坐标；屏幕坐标先经 CTM 逆矩阵换算，再叠加当前缩放与平移。
  function toSvgPoint(event) {
    const svg = $('#galaxySvg');
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
  }

  function edgeGeometry(edge) {
    const from = galaxyNodes.find((node) => node.id === edge.from);
    const to = galaxyNodes.find((node) => node.id === edge.to);
    if (!from || !to) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy) || 1;
    const bow = distance * 0.09;
    const cx = (from.x + to.x) / 2 - dy / distance * bow;
    const cy = (from.y + to.y) / 2 + dx / distance * bow;
    return {
      path: `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`,
      labelX: 0.25 * from.x + 0.5 * cx + 0.25 * to.x,
      labelY: 0.25 * from.y + 0.5 * cy + 0.25 * to.y
    };
  }

  function updateGalaxyTransform() {
    const viewport = $('#galaxyViewport');
    if (viewport) viewport.setAttribute('transform', `translate(${state.galaxyX} ${state.galaxyY}) scale(${state.galaxyK})`);
    const label = $('#galaxyZoomLabel');
    if (label) label.textContent = `${Math.round(state.galaxyK * 100)}%`;
  }

  function updateGalaxyGeometry() {
    galaxyNodes.forEach((node) => {
      const group = galaxy.nodeEls.get(node.id);
      if (group) group.setAttribute('transform', `translate(${node.x} ${node.y})`);
    });
    galaxyEdges.forEach((edge) => {
      const geometry = edgeGeometry(edge);
      const record = galaxy.edgeEls.get(`${edge.from}-${edge.to}`);
      if (!geometry || !record) return;
      record.path.setAttribute('d', geometry.path);
      record.label.setAttribute('x', geometry.labelX);
      record.label.setAttribute('y', geometry.labelY);
    });
  }

  function renderGalaxy() {
    const nodesGroup = $('#galaxyNodes');
    const edgesGroup = $('#galaxyEdges');
    const starsGroup = $('#galaxyStars');
    if (!nodesGroup || !edgesGroup || !starsGroup) return;
    nodesGroup.innerHTML = '';
    edgesGroup.innerHTML = '';
    starsGroup.innerHTML = '';
    galaxy.nodeEls.clear();
    galaxy.edgeEls.clear();

    const random = seededRandom(90317);
    for (let i = 0; i < 110; i += 1) {
      const star = svgEl('circle', {
        class: 'g-star',
        cx: (random() * 1200).toFixed(1),
        cy: (random() * 720).toFixed(1),
        r: (0.4 + random() * 1.1).toFixed(2),
        opacity: (0.12 + random() * 0.45).toFixed(2)
      });
      starsGroup.appendChild(star);
    }

    galaxyEdges.forEach((edge) => {
      const geometry = edgeGeometry(edge);
      if (!geometry) return;
      const path = svgEl('path', { class: 'g-edge', d: geometry.path, 'data-edge': `${edge.from}-${edge.to}` });
      const label = svgEl('text', { class: 'g-edge-label', x: geometry.labelX, y: geometry.labelY });
      label.textContent = edge.label;
      edgesGroup.appendChild(path);
      edgesGroup.appendChild(label);
      galaxy.edgeEls.set(`${edge.from}-${edge.to}`, { path, label });
    });

    galaxyNodes.forEach((node) => {
      const type = nodeTypes[node.type];
      const radius = type.radius;
      const group = svgEl('g', {
        class: `g-node type-${node.type}`,
        transform: `translate(${node.x} ${node.y})`,
        'data-node': node.id,
        tabindex: '0',
        role: 'button',
        'aria-label': `${node.name}，${type.label}`
      });
      group.style.setProperty('--node-color', type.color);
      const halo = svgEl('circle', { class: 'node-halo', r: radius + 7 });
      const ring = svgEl('circle', { class: 'node-ring', r: radius });
      const letter = svgEl('text', { class: 'node-letter', y: '1' });
      letter.textContent = node.name.slice(0, 1);
      const label = svgEl('text', { class: 'node-label', y: radius + 17 });
      label.textContent = node.name;
      group.append(halo, ring, letter, label);
      nodesGroup.appendChild(group);
      galaxy.nodeEls.set(node.id, group);

      group.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        selectGalaxyNode(node.id);
        const point = toSvgPoint(event);
        const worldX = (point.x - state.galaxyX) / state.galaxyK;
        const worldY = (point.y - state.galaxyY) / state.galaxyK;
        state.galaxyDrag = {
          id: node.id,
          dx: node.x - worldX,
          dy: node.y - worldY,
          startX: event.clientX,
          startY: event.clientY,
          moved: false
        };
        $('#galaxySvg').setPointerCapture(event.pointerId);
      });
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectGalaxyNode(node.id);
        }
      });
    });

    const stage = $('#galaxyStage');
    const svg = $('#galaxySvg');
    svg.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.g-node')) return;
      state.galaxyPan = {
        startX: event.clientX,
        startY: event.clientY,
        originX: state.galaxyX,
        originY: state.galaxyY,
        moved: false
      };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', (event) => {
      if (state.galaxyDrag) {
        const point = toSvgPoint(event);
        const node = galaxyNodes.find((item) => item.id === state.galaxyDrag.id);
        if (!node) return;
        node.x = (point.x - state.galaxyX) / state.galaxyK + state.galaxyDrag.dx;
        node.y = (point.y - state.galaxyY) / state.galaxyK + state.galaxyDrag.dy;
        if (Math.hypot(event.clientX - state.galaxyDrag.startX, event.clientY - state.galaxyDrag.startY) > 3) {
          state.galaxyDrag.moved = true;
        }
        updateGalaxyGeometry();
      } else if (state.galaxyPan) {
        const dx = event.clientX - state.galaxyPan.startX;
        const dy = event.clientY - state.galaxyPan.startY;
        if (Math.hypot(dx, dy) > 3) state.galaxyPan.moved = true;
        state.galaxyX = state.galaxyPan.originX + dx;
        state.galaxyY = state.galaxyPan.originY + dy;
        updateGalaxyTransform();
      }
    });
    const endPointer = () => {
      state.galaxyDrag = null;
      state.galaxyPan = null;
    };
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('pointerleave', (event) => {
      if (state.galaxyDrag || state.galaxyPan) endPointer();
    });
    svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = toSvgPoint(event);
      const oldK = state.galaxyK;
      const factor = Math.exp(-event.deltaY * 0.0012);
      const nextK = clamp(oldK * factor, 0.55, 2.4);
      state.galaxyX = point.x - (point.x - state.galaxyX) * (nextK / oldK);
      state.galaxyY = point.y - (point.y - state.galaxyY) * (nextK / oldK);
      state.galaxyK = nextK;
      updateGalaxyTransform();
    }, { passive: false });

    const filters = $('#galaxyFilters');
    if (filters) {
      filters.innerHTML = Object.entries(nodeTypes).map(([type, meta]) => `
        <button class="chip-filter is-on" type="button" data-galaxy-type="${type}" style="--chip-color:${meta.color}" aria-pressed="true">${meta.label}</button>
      `).join('');
    }
    const mobileList = $('#galaxyMobileList');
    if (mobileList) {
      mobileList.innerHTML = galaxyNodes.map((node) => {
        const count = galaxyEdges.filter((edge) => edge.from === node.id || edge.to === node.id).length;
        const type = nodeTypes[node.type];
        return `<button class="galaxy-mobile-item" type="button" data-galaxy-node="${node.id}" style="--node-color:${type.color}"><span><b>${esc(node.name)}</b><small>${type.label} · ${esc(node.role)}</small></span><em>${count} 关系</em></button>`;
      }).join('');
    }
    selectGalaxyNode(state.galaxySelected);
    if (window.innerWidth <= 820) {
      $('#galaxyStage')?.classList.remove('has-selection');
    }
    const hint = $('#galaxyHint');
    if (hint) hint.textContent = galaxyHintText();
  }

  function applyGalaxyFilters() {
    galaxyNodes.forEach((node) => {
      const group = galaxy.nodeEls.get(node.id);
      if (group) group.style.display = state.galaxyTypes.has(node.type) ? '' : 'none';
    });
    galaxyEdges.forEach((edge) => {
      const visible = state.galaxyTypes.has(galaxyNodes.find((node) => node.id === edge.from)?.type) &&
        state.galaxyTypes.has(galaxyNodes.find((node) => node.id === edge.to)?.type);
      const record = galaxy.edgeEls.get(`${edge.from}-${edge.to}`);
      if (record) {
        record.path.style.display = visible ? '' : 'none';
        record.label.style.display = visible ? '' : 'none';
      }
    });
    $$('#galaxyFilters .chip-filter').forEach((button) => {
      const on = state.galaxyTypes.has(button.dataset.galaxyType);
      button.classList.toggle('is-on', on);
      button.classList.toggle('is-off', !on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (state.galaxySelected) {
      const selected = galaxyNodes.find((node) => node.id === state.galaxySelected);
      if (selected && !state.galaxyTypes.has(selected.type)) {
        state.galaxySelected = null;
        $('#galaxyStage')?.classList.remove('has-selection');
        galaxy.nodeEls.forEach((el) => el.classList.remove('is-selected', 'is-related'));
        galaxy.edgeEls.forEach((record) => {
          record.path.classList.remove('is-related');
          record.label.classList.remove('is-related');
        });
        $('#galaxyDetail').innerHTML = '<div class="review-empty" style="min-height:220px"><span class="seal-empty">星</span><p>这个类型被隐藏了。重新打开筛选，或者点击左侧的其他节点。</p></div>';
      }
    }
  }

  function selectGalaxyNode(id) {
    const node = galaxyNodes.find((item) => item.id === id);
    if (!node) return;
    state.galaxySelected = id;
    const stage = $('#galaxyStage');
    stage.classList.add('has-selection');
    const related = new Set();
    galaxyEdges.forEach((edge) => {
      if (edge.from === id) related.add(edge.to);
      if (edge.to === id) related.add(edge.from);
    });
    galaxy.nodeEls.forEach((el, nodeId) => {
      el.classList.toggle('is-selected', nodeId === id);
      el.classList.toggle('is-related', related.has(nodeId));
    });
    galaxy.edgeEls.forEach((record, key) => {
      const relation = key.split('-');
      const isRelated = relation[0] === id || relation[1] === id;
      record.path.classList.toggle('is-related', isRelated);
      record.label.classList.toggle('is-related', isRelated);
    });
    renderGalaxyDetail(node, related);
  }

  function renderGalaxyDetail(node, related) {
    const holder = $('#galaxyDetail');
    if (!holder) return;
    const type = nodeTypes[node.type];
    const relations = galaxyEdges
      .filter((edge) => edge.from === node.id || edge.to === node.id)
      .map((edge) => {
        const otherId = edge.from === node.id ? edge.to : edge.from;
        const other = galaxyNodes.find((item) => item.id === otherId);
        return other ? { ...other, relation: edge.label } : null;
      })
      .filter(Boolean);
    holder.innerHTML = `
      <button class="icon-btn galaxy-detail-close" type="button" data-close-galaxy aria-label="关闭详情"><svg class="icon"><use href="#i-close"/></svg></button>
      <p class="eyebrow"><span class="eyebrow-line"></span>${type.label} · ${esc(node.state || '已确认')}</p>
      <h2>${esc(node.name)}</h2>
      <p class="detail-en">${esc(node.en)}</p>
      <p class="detail-role">${esc(node.role)}</p>
      <p class="detail-desc">${esc(node.desc)}</p>
      <div class="detail-block"><p class="detail-label">此刻</p><p>${esc(node.current)}</p></div>
      <div class="detail-block"><div class="detail-stats">${node.stats.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}</div></div>
      <div class="detail-block"><p class="detail-label">关系 · ${relations.length}</p><div class="relation-list">${relations.map((other) => `
        <button type="button" data-galaxy-node="${other.id}"><span class="relation-avatar" style="--node-color:${other.color}">${other.name.slice(0, 1)}</span><span><b>${esc(other.name)}</b><br><small>${esc(other.relation)}</small></span><svg class="icon" style="width:11px;height:11px"><use href="#i-arrow-up"/></svg></button>
      `).join('')}</div></div>
      <div class="detail-block"><p class="detail-label">出处</p><div class="detail-source-row">${node.sources.map((source) => `<button class="detail-source" type="button" data-locate-chapter="${chapterFromSource(source)?.id || ''}">${esc(source)}</button>`).join('')}</div></div>
      <button class="btn btn-ghost detail-cta" type="button" data-locate-chapter="${chapterFromSource(node.sources[0])?.id || 1}">在正文中定位</button>
    `;
    holder.scrollTop = 0;
  }

  function resetGalaxyView() {
    state.galaxyK = 1;
    state.galaxyX = 0;
    state.galaxyY = 0;
    updateGalaxyTransform();
  }

  function galaxyHintText() {
    return window.innerWidth <= 820 ? '点按节点查看 · 按钮缩放' : '拖动节点 · 滚轮缩放 · 点击查看';
  }

  /* ------------------------------------------------------------
     Palette / keyboard
     ------------------------------------------------------------ */
  function buildPaletteItems() {
    const items = [];
    Object.entries(pageNames).forEach(([key, label]) => {
      items.push({ group: '页面', label, sub: '切换到' + label, icon: `i-${key === 'desk' ? 'desk' : key === 'write' ? 'pen' : key === 'outline' ? 'outline' : key === 'galaxy' ? 'galaxy' : key === 'archive' ? 'archive' : 'review'}`, hint: '', run: () => go(key) });
    });
    chapters.forEach((chapter) => {
      items.push({ group: '章节', label: `第 ${chapter.id} 章 · ${chapter.title}`, sub: `${chapter.status} · ${chapter.words.toLocaleString()} 字`, icon: 'i-book', hint: chapter.pov, run: () => selectChapter(chapter.id) });
    });
    archiveData.people.forEach((person) => {
      items.push({ group: '人物', label: person.name, sub: person.role, icon: 'i-archive', hint: '人物档案', run: () => { go('archive'); chooseArchive('people', person.id); } });
    });
    items.push(
      { group: '动作', label: '专注模式', sub: '隐藏侧栏，只留下正文', icon: 'i-focus', hint: 'Ctrl Shift F', run: enterFocus },
      { group: '动作', label: '切换纸色', sub: '宣纸 / 夜墨', icon: 'i-moon', hint: state.theme === 'light' ? '夜墨' : '宣纸', run: () => setTheme(state.theme === 'light' ? 'dark' : 'light') },
      { group: '动作', label: '写作外观', sub: '字号、行距与动效', icon: 'i-settings', hint: '', run: openSettings },
      { group: '动作', label: '新建章节', sub: '加入目录末尾', icon: 'i-plus', hint: '', run: () => openChapterModal(1) },
      { group: '动作', label: '收一条便笺', sub: '回到书桌的余白', icon: 'i-note', hint: '', run: focusNotes },
      { group: '动作', label: '打开作品书架', sub: '切换作品', icon: 'i-book', hint: '', run: () => { go('desk'); setTimeout(() => $('#shelfSection')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60); } }
    );
    return items;
  }

  function openPalette() {
    const palette = $('#palette');
    if (!palette) return;
    const pop = $('#bookPop');
    if (pop) {
      pop.hidden = true;
      $('#bookSwitch')?.setAttribute('aria-expanded', 'false');
    }
    state.paletteItems = buildPaletteItems();
    state.paletteIndex = 0;
    palette.hidden = false;
    const input = $('#paletteInput');
    input.value = '';
    renderPalette('');
    input.focus();
    lockScroll();
  }

  function closePalette() {
    const palette = $('#palette');
    if (palette) palette.hidden = true;
    unlockScroll();
  }

  function renderPalette(query) {
    const holder = $('#paletteResults');
    if (!holder) return;
    const q = query.trim().toLowerCase();
    const filtered = state.paletteItems.filter((item) => !q ||
      item.label.toLowerCase().includes(q) ||
      item.sub.toLowerCase().includes(q) ||
      item.group.toLowerCase().includes(q)
    );
    state.paletteFiltered = filtered;
    if (state.paletteIndex >= filtered.length) state.paletteIndex = 0;
    if (!filtered.length) {
      holder.innerHTML = '<p class="palette-empty">没有找到。试试“第 2 章”或“林遥”。</p>';
      return;
    }
    let lastGroup = '';
    holder.innerHTML = filtered.map((item, index) => {
      const showGroup = item.group !== lastGroup;
      lastGroup = item.group;
      return `${showGroup ? `<p class="palette-group-label">${item.group}</p>` : ''}
        <button class="palette-item ${index === state.paletteIndex ? 'is-selected' : ''}" type="button" data-palette-index="${index}">
          <svg class="icon"><use href="#${item.icon}"/></svg>
          <span class="palette-item-copy"><b>${esc(item.label)}</b><small>${esc(item.sub)}</small></span>
          ${item.hint ? `<span class="hint">${esc(item.hint)}</span>` : ''}
        </button>`;
    }).join('');
  }

  function movePalette(delta) {
    const list = state.paletteFiltered || [];
    if (!list.length) return;
    state.paletteIndex = (state.paletteIndex + delta + list.length) % list.length;
    const input = $('#paletteInput');
    renderPalette(input ? input.value : '');
    const selected = $('.palette-item.is-selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  function runPalette(index) {
    const list = state.paletteFiltered || [];
    const item = list[index];
    if (!item) return;
    closePalette();
    item.run();
  }

  /* ------------------------------------------------------------
     Theme / settings / modals
     ------------------------------------------------------------ */
  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    $$('#themeOptions button').forEach((button) => button.classList.toggle('is-active', button.dataset.themeChoice === theme));
  }

  function lockScroll() { document.body.style.overflow = 'hidden'; }
  function unlockScroll() {
    const paletteOpen = $('#palette') && !$('#palette').hidden;
    const modalOpen = $$('.modal-backdrop').some((modal) => !modal.hidden);
    const drawerOpen = !!$('.drawer-backdrop');
    if (!paletteOpen && !modalOpen && !drawerOpen) document.body.style.overflow = '';
  }

  function openModal(selector) {
    const modal = typeof selector === 'string' ? $(selector) : selector;
    if (!modal) return;
    const pop = $('#bookPop');
    if (pop) {
      pop.hidden = true;
      $('#bookSwitch')?.setAttribute('aria-expanded', 'false');
    }
    modal.hidden = false;
    lockScroll();
    const focusable = modal.querySelector('input[type="text"], input:not([type]), textarea, select') || modal.querySelector('.modal[tabindex="-1"]');
    if (focusable) setTimeout(() => focusable.focus(), 40);
  }

  function closeModal(modal) {
    const target = typeof modal === 'string' ? $(modal) : modal;
    if (!target) return;
    target.hidden = true;
    unlockScroll();
  }

  function openSettings() {
    setTheme(state.theme);
    openModal('#settingsModal');
  }

  function applySettings() {
    const size = Number($('#fontSizeRange')?.value || 19);
    const leading = Number($('#lineHeightRange')?.value || 21) / 10;
    document.documentElement.style.setProperty('--prose-size', `${size}px`);
    document.documentElement.style.setProperty('--prose-leading', String(leading));
    const sizeOut = $('#fontSizeOut');
    if (sizeOut) sizeOut.textContent = `${size} px`;
    const leadOut = $('#lineHeightOut');
    if (leadOut) leadOut.textContent = leading.toFixed(1);
    document.body.classList.toggle('reduce-motion', !!$('#reduceMotion')?.checked);
  }

  function openChapterModal(volumeId = 1) {
    openModal('#chapterModal');
    const form = $('#chapterForm');
    if (form) {
      form.reset();
      form.elements.volume.value = String(volumeId);
      form.elements.title.focus();
    }
  }

  function submitChapter(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    if (!title) return;
    const volume = Number(data.get('volume') || 1);
    const goal = String(data.get('goal') || '').trim() || '待补充本章目标。';
    const id = Math.max(...chapters.map((chapter) => chapter.id)) + 1;
    chapters.push({
      id, no: pad(id), volume, title, status: '大纲', words: 0, target: 2200,
      pov: '第三人称 · 林遥', time: '待定', tension: 2,
      summary: goal,
      goal,
      beats: [
        { text: '本章第一个场景', done: false },
        { text: '本章的转折', done: false },
        { text: '留下的问题', done: false }
      ],
      people: [],
      html: ''
    });
    renderOutline();
    renderChapterList($('#chapterSearch')?.value || '');
    renderDesk();
    closeModal('#chapterModal');
    toast(`第 ${id} 章《${title}》已加入目录。`, '打开', () => selectChapter(id));
  }

  /* ------------------------------------------------------------
     Focus / typing / selection
     ------------------------------------------------------------ */
  // 专注模式只隐藏外围界面，不复制正文；退出后仍停留在当前章节与纸面滚动位置。
  function enterFocus() {
    if (state.view !== 'write') {
      go('write');
      setTimeout(enterFocus, 120);
      return;
    }
    document.body.classList.add('focus-mode');
    const chapter = activeChapter();
    const focusChapter = $('#focusChapter');
    if (focusChapter) focusChapter.textContent = `第 ${chapter.id} 章 · ${chapter.title}`;
    const focusWords = $('#focusWords');
    if (focusWords) focusWords.textContent = chapter.words.toLocaleString();
    state.focusStart = Date.now();
    clearInterval(state.focusTimer);
    state.focusTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.focusStart) / 1000);
      const timer = $('#focusTimer');
      if (timer) timer.textContent = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`;
    }, 1000);
  }

  function exitFocus() {
    document.body.classList.remove('focus-mode');
    clearInterval(state.focusTimer);
    state.focusTimer = null;
    const timer = $('#focusTimer');
    if (timer) timer.textContent = '00:00';
  }

  function toggleTypewriter() {
    state.typewriter = !state.typewriter;
    document.body.classList.toggle('typewriter', state.typewriter);
    const button = $('#typewriterBtn');
    if (button) button.textContent = state.typewriter ? '退出打字机' : '打字机';
    toast(state.typewriter ? '打字机模式：收窄纸面，让视线只落在句子上。' : '已回到普通纸面。');
  }

  function focusNotes() {
    go('desk');
    setTimeout(() => {
      const section = $('#notesSection');
      if (!section) return;
      section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      section.classList.add('is-targeted');
      setTimeout(() => section.classList.remove('is-targeted'), 1600);
      $('#noteInput')?.focus();
    }, 60);
  }

  function updateSelectionToolbar() {
    const toolbar = $('#selectionToolbar');
    const prose = $('#prose');
    if (!toolbar || !prose) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      toolbar.hidden = true;
      return;
    }
    const range = selection.getRangeAt(0);
    if (!prose.contains(range.commonAncestorContainer)) {
      toolbar.hidden = true;
      return;
    }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      toolbar.hidden = true;
      return;
    }
    toolbar.hidden = false;
    const width = toolbar.offsetWidth || 240;
    const left = clamp(rect.left + rect.width / 2 - width / 2, 8, window.innerWidth - width - 8);
    const top = Math.max(8, rect.top - 46);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }

  function executeSelectionCommand(command) {
    const prose = $('#prose');
    const selection = window.getSelection();
    if (!prose || !selection || selection.isCollapsed) return;
    if (command === 'ai') {
      if (window.innerWidth <= 1180) {
        document.body.classList.add('margin-open');
        const backdrop = $('#paneBackdrop');
        if (backdrop) backdrop.hidden = false;
      }
      $$('#marginPane [data-margin]').forEach((button) => button.classList.toggle('is-active', button.dataset.margin === 'suggest'));
      $$('.margin-panel').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.marginPanel === 'suggest'));
      $('#marginPane')?.classList.add('pulse');
      setTimeout(() => $('#marginPane')?.classList.remove('pulse'), 700);
      toast('已把选中的句子放进建议上下文。');
      $('#selectionToolbar').hidden = true;
      return;
    }
    if (command === 'mark') {
      const text = selection.toString();
      if (text) document.execCommand('insertHTML', false, `<mark>${esc(text)}</mark>`);
    } else {
      document.execCommand(command, false, null);
    }
    setChapterWordsFromDom();
    markSaving();
    updateSelectionToolbar();
  }

  /* ------------------------------------------------------------
     Init / events
     ------------------------------------------------------------ */
  function init() {
    setTheme('light');
    renderDesk();
    selectChapter(2, false);
    renderOutline();
    renderArchive();
    renderIssues();
    renderGalaxy();
    updateGalaxyTransform();
    updateClockLabels();
    applySettings();

    document.addEventListener('click', (event) => {
      const target = event.target;

      if (target.matches?.('[data-drawer-backdrop]')) {
        closeDrawer();
        return;
      }

      const chapterBtn = target.closest('[data-chapter]');
      if (chapterBtn) {
        event.preventDefault();
        selectChapter(chapterBtn.dataset.chapter);
        closeDrawer();
        return;
      }

      const nav = target.closest('[data-nav]');
      if (nav) {
        event.preventDefault();
        closeDrawer();
        go(nav.dataset.nav);
        return;
      }

      const locate = target.closest('[data-locate-chapter]');
      if (locate && locate.dataset.locateChapter) {
        event.preventDefault();
        selectChapter(locate.dataset.locateChapter);
        closeDrawer();
        return;
      }

      const closeDrawerBtn = target.closest('[data-close-drawer]');
      if (closeDrawerBtn) {
        closeDrawer();
        return;
      }

      const outlineCard = target.closest('[data-outline-chapter]');
      if (outlineCard) {
        if (state.justDragged) return;
        openOutlineDrawer(chapters.find((chapter) => chapter.id === Number(outlineCard.dataset.outlineChapter)));
        return;
      }

      const threadBtn = target.closest('[data-thread]');
      if (threadBtn) {
        openThreadDrawer(threadBtn.dataset.thread);
        return;
      }

      const beatBtn = target.closest('[data-beat], [data-chart-chapter]');
      if (beatBtn) {
        openBeatDrawer(beatBtn.dataset.beat || beatBtn.dataset.chartChapter);
        return;
      }

      const archiveBtn = target.closest('[data-archive-id]');
      if (archiveBtn) {
        chooseArchive(archiveBtn.dataset.archive, archiveBtn.dataset.archiveId);
        return;
      }

      const archiveRel = target.closest('[data-archive-rel]');
      if (archiveRel) {
        const item = archiveAll().find((entry) => entry.id === archiveRel.dataset.archiveRel);
        if (item) chooseArchive(item.tab, item.id);
        return;
      }

      const issueBtn = target.closest('[data-issue]');
      if (issueBtn) {
        state.issueId = issueBtn.dataset.issue;
        renderIssues();
        return;
      }

      const issueAction = target.closest('[data-issue-action]');
      if (issueAction) {
        const action = issueAction.dataset.issueAction;
        if (action === 'later') {
          toast('已保留这条，稍后还会出现在待审阅里。');
        } else if (action === 'reopen') {
          const issue = issues.find((item) => item.id === state.issueId);
          if (issue) {
            issue.status = 'open';
            renderIssues();
            toast('已重新打开这条审阅。');
          }
        } else {
          resolveIssue(state.issueId, action);
        }
        return;
      }

      const diffMode = target.closest('[data-diff-mode]');
      if (diffMode) {
        state.diffMode = diffMode.dataset.diffMode;
        renderIssueDetail(issues.find((issue) => issue.id === state.issueId));
        return;
      }

      const galaxyNode = target.closest('[data-galaxy-node]');
      if (galaxyNode) {
        selectGalaxyNode(galaxyNode.dataset.galaxyNode);
        return;
      }

      if (target.closest('[data-close-galaxy]')) {
        $('#galaxyStage')?.classList.remove('has-selection');
        return;
      }

      const galaxyFilter = target.closest('[data-galaxy-type]');
      if (galaxyFilter) {
        const type = galaxyFilter.dataset.galaxyType;
        if (state.galaxyTypes.has(type)) state.galaxyTypes.delete(type);
        else state.galaxyTypes.add(type);
        applyGalaxyFilters();
        return;
      }

      const otherBook = target.closest('[data-other-book]');
      if (otherBook) {
        toast(`《${otherBook.dataset.otherBook}》在完整产品里可以切换；本原型只展开了《雾港来信》。`);
        $('#bookPop').hidden = true;
        $('#bookSwitch')?.setAttribute('aria-expanded', 'false');
        return;
      }

      if (target.closest('[data-shelf-info]')) {
        toast('书架里已经有 3 部作品。作品归档与批量管理会在正式版中接入。');
        return;
      }

      if (target.closest('[data-shelf-jump]')) {
        $('#bookPop').hidden = true;
        $('#bookSwitch')?.setAttribute('aria-expanded', 'false');
        go('desk');
        setTimeout(() => $('#shelfSection')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
        return;
      }

      const addChapter = target.closest('[data-add-chapter]');
      if (addChapter) {
        openChapterModal(Number(addChapter.dataset.addChapter || 1));
        return;
      }

      const newChapter = target.closest('[data-new-chapter]');
      if (newChapter) {
        openChapterModal(1);
        return;
      }

      if (target.closest('#addChapterBtn')) {
        openChapterModal(1);
        return;
      }

      if (target.closest('[data-close-modal]')) {
        closeModal(target.closest('.modal-backdrop'));
        return;
      }

      const themeChoice = target.closest('[data-theme-choice]');
      if (themeChoice) {
        setTheme(themeChoice.dataset.themeChoice);
        return;
      }

      const acceptSuggestion = target.closest('[data-accept-suggestion]');
      if (acceptSuggestion) {
        resolveIssue('tone', 'accept');
        return;
      }

      const ignoreSuggestion = target.closest('[data-ignore-suggestion]');
      if (ignoreSuggestion) {
        resolveIssue('tone', 'ignore');
        return;
      }

      const adoptDraft = target.closest('[data-adopt-draft]');
      if (adoptDraft) {
        addTextToProse('<p>她把信翻到背面。那里有一道很浅的折痕，像是曾经夹过什么。林遥想起母亲整理旧信时，总习惯把日期朝里折。</p>');
        $('#generatedDraft').hidden = true;
        toast('已把这段放进正文，可以继续改。', '撤销', () => {
          const prose = $('#prose');
          const last = prose?.lastElementChild;
          if (last) last.remove();
          setChapterWordsFromDom();
          markSaving();
        });
        return;
      }

      const discardDraft = target.closest('[data-discard-draft]');
      if (discardDraft) {
        $('#generatedDraft').hidden = true;
        toast('已丢弃这段建议。');
        return;
      }

      if (target.closest('[data-recheck]')) {
        toast('已重新检查第 2 章：没有新增问题。');
        return;
      }

      if (target.closest('[data-archive-edit]')) {
        toast('档案编辑表单会在正式版中接入；原型保留展示与出处定位。');
        return;
      }

      if (target.closest('#confirmCandidate')) {
        if (state.pendingCandidates > 0) {
          state.pendingCandidates -= 1;
          addCandidateToArchive();
          const memoryIssue = issues.find((issue) => issue.id === 'memory');
          if (memoryIssue && memoryIssue.status === 'open') {
            memoryIssue.status = 'resolved';
            if (state.issueId === 'memory') state.issueId = null;
            renderIssues();
          }
          renderPendingCard();
          toast('已确认一条设定，来源保留在第 2 章。');
        }
        return;
      }

      if (target.closest('#ignoreCandidate')) {
        state.pendingCandidates = Math.max(0, state.pendingCandidates - 1);
        const memoryIssue = issues.find((issue) => issue.id === 'memory');
        if (memoryIssue && memoryIssue.status === 'open') {
          memoryIssue.status = 'ignored';
          if (state.issueId === 'memory') state.issueId = null;
          renderIssues();
        }
        renderPendingCard();
        toast('已忽略这条候选。');
        return;
      }

      if (target.closest('#extractBtn')) {
        if (state.pendingCandidates === 0) state.pendingCandidates = 2;
        renderPendingCard();
        toast('演示：已扫描第 2 章，发现 2 条可确认的候选。');
        return;
      }

      if (target.closest('#newArchiveBtn')) {
        toast('新建档案会在正式版中接入；原型已收录 15 条设定。');
        return;
      }

      if (target.closest('#newBookBtn')) {
        toast('新建作品会从“一句话故事”开始。原型保留这个入口。');
        return;
      }

      if (target.closest('#pacingBtn')) {
        go('review');
        toast('结构检查已合并到审阅队列。');
        return;
      }

      if (target.closest('#historyBtn')) {
        go('review');
        toast('版本历史与修改影响在审阅页右侧。');
        return;
      }

      if (target.closest('#snapshotBtn')) {
        saveNow();
        toast(`已保存快照 · ${state.lastSaved}`);
        return;
      }

      if (target.closest('#newVolumeBtn')) {
        toast('原型保留两卷结构。完整版可以继续新建卷。');
        return;
      }

      if (target.closest('#typewriterBtn')) {
        toggleTypewriter();
        return;
      }

      if (target.closest('#focusTop, #focusBtn, #focusBtn2')) {
        enterFocus();
        return;
      }

      if (target.closest('#exitFocus')) {
        exitFocus();
        return;
      }

      if (target.closest('#themeBtn')) {
        setTheme(state.theme === 'light' ? 'dark' : 'light');
        return;
      }

      if (target.closest('#settingsBtn')) {
        openSettings();
        return;
      }

      if (target.closest('#quickNoteBtn')) {
        focusNotes();
        return;
      }

      if (target.closest('#openChapters')) {
        document.body.classList.add('chapters-open');
        $('#paneBackdrop').hidden = false;
        return;
      }

      if (target.closest('#closeChapters')) {
        closePanes();
        return;
      }

      if (target.closest('#marginToggle')) {
        if (window.innerWidth <= 1180) {
          document.body.classList.remove('margin-collapsed');
          document.body.classList.toggle('margin-open');
          $('#paneBackdrop').hidden = !document.body.classList.contains('margin-open');
        } else {
          document.body.classList.toggle('margin-collapsed');
        }
        return;
      }

      if (target.closest('#closeMargin')) {
        if (window.innerWidth <= 1180) {
          document.body.classList.remove('margin-open');
          $('#paneBackdrop').hidden = true;
        } else {
          document.body.classList.add('margin-collapsed');
        }
        return;
      }

      if (target.closest('#paneBackdrop')) {
        closePanes();
        return;
      }

      if (target.closest('#bookSwitch')) {
        const pop = $('#bookPop');
        const isOpen = !pop.hidden;
        pop.hidden = isOpen;
        $('#bookSwitch').setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        return;
      }

      if (target.closest('#omniBtn, #mobileSearchBtn')) {
        openPalette();
        return;
      }

      if (target.closest('#zoomIn')) {
        state.galaxyK = clamp(state.galaxyK * 1.2, 0.55, 2.4);
        updateGalaxyTransform();
        return;
      }
      if (target.closest('#zoomOut')) {
        state.galaxyK = clamp(state.galaxyK / 1.2, 0.55, 2.4);
        updateGalaxyTransform();
        return;
      }
      if (target.closest('#zoomReset')) {
        resetGalaxyView();
        return;
      }

      if (target.closest('.modal-backdrop') && !target.closest('.modal')) {
        closeModal(target.closest('.modal-backdrop'));
        return;
      }

      if (!target.closest('.topbar-left')) {
        const pop = $('#bookPop');
        if (pop && !pop.hidden) {
          pop.hidden = true;
          $('#bookSwitch')?.setAttribute('aria-expanded', 'false');
        }
      }
    });

    // Tabs
    $$('[data-tabs]').forEach((tabs) => {
      tabs.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-tab]');
        if (!button) return;
        const group = tabs.dataset.tabs;
        const tab = button.dataset.tab;
        $$('button[data-tab]', tabs).forEach((item) => {
          item.classList.toggle('is-active', item === button);
          item.setAttribute('aria-selected', item === button ? 'true' : 'false');
        });
        if (group === 'outline') {
          $$('[data-tab-panel]', $('.view-outline')).forEach((panel) => panel.classList.toggle('is-active', panel.dataset.tabPanel === tab));
        } else if (group === 'archive') {
          state.archiveTab = tab;
          state.archiveId = (archiveData[tab] || [])[0]?.id || null;
          state.archiveQuery = '';
          const search = $('#archiveSearch');
          if (search) search.value = '';
          renderArchive();
        } else if (group === 'review') {
          state.reviewFilter = tab;
          const filtered = filteredIssues();
          state.issueId = (filtered.find((issue) => issue.status === 'open') || filtered[0])?.id || null;
          renderIssues();
        }
      });
    });

    // Margin tabs
    $$('#marginPane [data-margin]').forEach((button) => {
      button.addEventListener('click', () => {
        $$('#marginPane [data-margin]').forEach((item) => {
          item.classList.toggle('is-active', item === button);
          item.setAttribute('aria-selected', item === button ? 'true' : 'false');
        });
        $$('.margin-panel').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.marginPanel === button.dataset.margin));
      });
    });

    // Chapter search
    $('#chapterSearch')?.addEventListener('input', (event) => renderChapterList(event.target.value));

    // Editor
    const prose = $('#prose');
    if (prose) {
      prose.addEventListener('input', () => {
        setChapterWordsFromDom();
        markSaving();
        updateSelectionToolbar();
      });
      prose.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') {
          event.preventDefault();
          document.execCommand('insertHTML', false, '　　');
        }
      });
    }
    $('#paperTitle')?.addEventListener('input', updateChapterTitle);

    // Notes
    $('#noteForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      addNote($('#noteInput')?.value || '');
    });

    // Modals
    $('#fontSizeRange')?.addEventListener('input', applySettings);
    $('#lineHeightRange')?.addEventListener('input', applySettings);
    $('#reduceMotion')?.addEventListener('change', applySettings);
    $('#chapterForm')?.addEventListener('submit', submitChapter);

    // Palette
    $('#paletteInput')?.addEventListener('input', (event) => {
      state.paletteIndex = 0;
      renderPalette(event.target.value);
    });
    $('#paletteInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); movePalette(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); movePalette(-1); }
      else if (event.key === 'Enter') { event.preventDefault(); runPalette(state.paletteIndex); }
    });
    $('#palette')?.addEventListener('click', (event) => {
      if (event.target === $('#palette')) closePalette();
      const item = event.target.closest('[data-palette-index]');
      if (item) runPalette(Number(item.dataset.paletteIndex));
    });
    $('#toastClose')?.addEventListener('click', hideToast);

    // Generate demo
    $('#generateBtn')?.addEventListener('click', (event) => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      const label = button.querySelector('span');
      const original = label.textContent;
      label.textContent = '正在整理 4 条记忆…';
      setTimeout(() => {
        label.textContent = original;
        button.disabled = false;
        const draft = $('#generatedDraft');
        if (draft) {
          draft.hidden = false;
          draft.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 1100);
    });

    // Galaxy search
    $('#galaxySearch')?.addEventListener('input', (event) => {
      const query = event.target.value.trim().toLowerCase();
      state.galaxyQuery = query;
      let matches = 0;
      galaxyNodes.forEach((node) => {
        const el = galaxy.nodeEls.get(node.id);
        if (!el) return;
        const match = query && `${node.name}${node.role}${node.desc}`.toLowerCase().includes(query);
        el.classList.toggle('is-match', !!match);
        if (match) matches += 1;
      });
      const hint = $('#galaxyHint');
      if (hint) hint.textContent = query ? `${matches} 个匹配 · 回车定位` : galaxyHintText();
    });
    $('#galaxySearch')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const query = event.target.value.trim().toLowerCase();
      if (!query) return;
      const node = galaxyNodes.find((item) => `${item.name}${item.role}${item.desc}`.toLowerCase().includes(query));
      if (node) selectGalaxyNode(node.id);
    });

    // Archive search
    $('#archiveSearch')?.addEventListener('input', (event) => {
      state.archiveQuery = event.target.value;
      renderArchive();
    });

    // Outline drag
    const board = $('#volumeBoard');
    if (board) {
      let dragged = null;
      board.addEventListener('dragstart', (event) => {
        const card = event.target.closest('.chapter-card');
        if (!card) return;
        dragged = card;
        card.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.dataset.outlineChapter);
      });
      board.addEventListener('dragend', () => {
        $$('.chapter-card', board).forEach((card) => card.classList.remove('dragging', 'drag-over'));
        dragged = null;
        setTimeout(() => { state.justDragged = false; }, 60);
      });
      board.addEventListener('dragover', (event) => {
        const card = event.target.closest('.chapter-card');
        if (!card || !dragged || card === dragged) return;
        event.preventDefault();
        $$('.chapter-card', board).forEach((item) => item.classList.remove('drag-over'));
        card.classList.add('drag-over');
      });
      board.addEventListener('drop', (event) => {
        const card = event.target.closest('.chapter-card');
        if (!card || !dragged || card === dragged) return;
        event.preventDefault();
        const rect = card.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        card.parentElement.insertBefore(dragged, after ? card.nextSibling : card);
        card.classList.remove('drag-over');
        state.justDragged = true;
        toast('章节顺序已调整。原型里的改动只保留在当前页面。');
      });
    }

    // Global keyboard
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if ($('#palette').hidden) openPalette();
        else closePalette();
        return;
      }
      if (event.key === 'Escape') {
        if (closeAnyOverlay()) event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        enterFocus();
      }
    });

    // Selection toolbar
    document.addEventListener('selectionchange', updateSelectionToolbar);
    $('#selectionToolbar')?.addEventListener('mousedown', (event) => event.preventDefault());
    $('#selectionToolbar')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-cmd]');
      if (!button) return;
      executeSelectionCommand(button.dataset.cmd);
    });
    $('#paperScroll')?.addEventListener('scroll', () => { const toolbar = $('#selectionToolbar'); if (toolbar) toolbar.hidden = true; });

    // Re-render on resize for layout-dependent labels.
    window.addEventListener('resize', () => {
      if (window.innerWidth > 1180) {
        document.body.classList.remove('margin-open');
        const backdrop = $('#paneBackdrop');
        if (backdrop) backdrop.hidden = true;
      }
      if (window.innerWidth > 820) {
        document.body.classList.remove('chapters-open');
        const backdrop = $('#paneBackdrop');
        if (backdrop) backdrop.hidden = true;
      }
      if (window.innerWidth <= 820) {
        $('#galaxyStage')?.classList.remove('has-selection');
      } else if (state.galaxySelected) {
        $('#galaxyStage')?.classList.add('has-selection');
      }
      const galaxyHint = $('#galaxyHint');
      if (galaxyHint && !state.galaxyQuery) galaxyHint.textContent = galaxyHintText();
    });
  }

  init();
})();
