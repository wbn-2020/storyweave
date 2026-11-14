import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { BookSnapshot, ChapterSnapshot, RevisionSnapshot, StudioApi } from '../../contracts/api'
import { DomainError } from '../../contracts/api'
import { CHARACTER_PROFILE_SCHEMA_VERSION } from '../../contracts/character-profile'
import {
  AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_KINDS, KNOWLEDGE_NATURES,
  KNOWLEDGE_ADJUDICATION_SCHEMA_VERSION,
  parseKnowledgeFields, parseKnowledgeSource,
  type CreateKnowledgeItemInput, type KnowledgeItemDetail, type KnowledgeItemFields, type KnowledgeItemPage,
  type KnowledgeKind, type KnowledgeNature, type KnowledgeSource, type KnowledgeSourceInput, type KnowledgeStatus, type UpdateKnowledgeItemInput,
} from '../../contracts/knowledge'
import type { ManuscriptBlock } from '../../contracts/manuscript'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import { CharacterProfileEditor, CharacterProfileView } from './CharacterProfileEditor'
import shared from '../StellarShared.module.css'
import styles from './StellarKnowledge.module.css'
import { StudioIcon } from './StudioIcon'
import { SavedPortrait, useSavedPortraits } from './SavedPortrait'
import { KnowledgeAdjudicationPanel } from './KnowledgeAdjudicationPanel'

interface Props {
  initialKind?: KnowledgeKind
  initialId?: string
  api: StudioApi
  book: BookSnapshot
  busy: boolean
  error?: string | null
  pendingMessage?: string | null
  checkingReceipt: boolean
  onCheckReceipt: () => void
  onRecover: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  onForge?: (personId: string, kind: 'fill' | 'extract' | 'audition') => void
  onUpgrade: (accept: (status: KnowledgeStatus) => void) => Promise<void>
  onCreate: (input: CreateKnowledgeItemInput, accept: (saved: KnowledgeItemDetail) => void) => Promise<void>
  onUpdate: (input: UpdateKnowledgeItemInput, accept: (saved: KnowledgeItemDetail) => void) => Promise<void>
}

const kindLabels: Record<KnowledgeKind, string> = { person: '人物角色', place: '地图地点', organization: '势力组织', object: '道具法宝', rule: '世界规则', theme: '核心主题', other: '其他设定' }
const natureLabels: Record<KnowledgeNature, string> = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '人物认知', ai_derived: 'AI 整理', ai_inference: 'AI 推断', external_reference: '外部参考' }
const decisionLabels = { unreviewed: '未处理', adopted: '已采纳', rejected: '已否决', review_later: '要求复核' }
const freshnessLabels = { current: '当前', affected: '受影响', updating: '更新中', failed: '更新失败' }
const conflictLabels = { unchecked: '未检查冲突', clear: '未发现已知冲突', candidate: '存在候选冲突', explained: '作者已解释' }
const sourceLabels = { author_input: '作者输入', chapter_text: '正文摘录', external: '外部资料' }
const validityLabels = { valid: '出处可查', partial: '出处部分缺失', missing: '出处缺失' }
const initialFields: KnowledgeItemFields = { kind: 'person', name: '', aliases: [], summary: '', nature: 'author_setting', authorDecision: 'adopted', freshness: 'current', conflictState: 'clear' }
const PAGE_SIZE = 50
const categoryIcons = { person: 'user', place: 'compass', organization: 'workflow', object: 'archive', rule: 'read', theme: 'spark', other: 'grid' } as const
function cardState(item: KnowledgeItemFields) {
  if (item.authorDecision === 'rejected') return { tone: 'danger', label: '已否决' }
  if (['unreviewed', 'review_later'].includes(item.authorDecision) || item.freshness !== 'current' || ['candidate', 'unchecked'].includes(item.conflictState)) return { tone: 'warning', label: '待复核' }
  if (item.nature === 'ai_inference') return { tone: 'inference', label: 'AI 推断' }
  return { tone: 'success', label: '已确认' }
}

// StarWriter V2.4.8 同款：内置 9 种世界观模型预设（开箱即用，告别从零空想）
const WORLD_MODELS: readonly {
  id: string
  genre: string
  badge: string
  kind: KnowledgeKind
  title: string
  summary: string
}[] = [
  {
    id: 'xianxia',
    genre: '修仙世界',
    badge: '东方仙侠',
    kind: 'rule',
    title: '九境修真与灵脉法则',
    summary: '【世界类型】东方仙侠大千世界，九州灵脉分三千大洲。\n【力量体系】炼气 → 筑基 → 金丹 → 元婴 → 化神 → 炼虚 → 合体 → 大乘 → 渡劫。\n【经济货币】下品/中品/上品/极品灵石，辅以丹药符箓易物。\n【核心禁忌】修为每晋升一境需历心魔劫；强行夺舍将沾染因果业火，受天道雷罚。',
  },
  {
    id: 'scifi-doomsday',
    genre: '科幻末日',
    badge: '游戏异能',
    kind: 'rule',
    title: '灾变维度与晶核觉醒体系',
    summary: '【世界类型】灾变后末世，现实废墟与异度深渊裂隙双重交叠。\n【力量体系】一阶觉醒者 → 二阶强化者 → 三阶进化者 → 四阶主宰，依靠吸收怪物晶核晋升。\n【社会结构】人类幸存者安全区、猎人公会、深渊教会（反派）、流浪拾荒者。\n【核心法则】不可直视深渊裂隙超过 3 秒；过度透支精神力会导致异能失控畸变。',
  },
  {
    id: 'urban-martial',
    genre: '都市高武',
    badge: '气血武道',
    kind: 'rule',
    title: '全球武道与气血宗师体系',
    summary: '【世界类型】地窟裂缝降临后的现代高武都市，武道高考决定命运阶层。\n【力量体系】一品至九品武者（气血值卡点）→ 宗师（精神力外放）→ 大宗师（金身不坏）→ 绝巅。\n【社会结构】武道教育部、镇魔军、财阀武馆、地窟异族王庭。\n【核心限制】气血亏空会折损寿元，高阶功法需匹配特定精神意志。',
  },
  {
    id: 'weird-cthulhu',
    genre: '诡异世界',
    badge: '规则怪谈',
    kind: 'rule',
    title: '旧日污染与民俗诡异代偿法则',
    summary: '【世界类型】表里双层世界，民俗禁忌与不可名状的旧日污染并存。\n【力量体系】驾驭诡异拼图/民俗器物，分为：巡夜人 → 掌灯使 → 镇渊官。\n【核心代价】每一次动用诡异能力都会加深自身复苏度，唯有以另一件诡异形成死机平衡方可续命。',
  },
  {
    id: 'wasteland',
    genre: '丧尸废土',
    badge: '机械义体',
    kind: 'organization',
    title: '废土避难所与机械义体秩序',
    summary: '【世界类型】灰雾纪元后的辐射废土，旧时代科技遗迹与变异兽群并存。\n【势力分布】浮空城财团、地下齿轮教会、废土游骑兵、荒原掠夺者。\n【经济体系】净水配额、高能电池与旧世界芯片为硬通货。',
  },
  {
    id: 'modern-romance',
    genre: '现代言情',
    badge: '都市职场',
    kind: 'organization',
    title: '名流商圈与行业生态设定',
    summary: '【世界背景】一线都市投行与顶级建筑设计事务所交锋圈。\n【社会关系】家族联姻契约、行业竞标暗战、新锐独立工作室突围。\n【核心冲突】职业理想与世俗筹码的博弈，双向救赎与阶层破壁。',
  },
  {
    id: 'ancient-romance',
    genre: '古典言情',
    badge: '宅斗宫闱',
    kind: 'rule',
    title: '世家门阀礼法与内宅规制',
    summary: '【世界类型】架空仿宋明盛世，勋贵门阀与科举新贵并立。\n【社会规制】嫡庶尊卑、宗族祠堂律法、内宅掌家对牌、皇商盐引特权。\n【核心禁忌】女子私蓄外产、勋贵私联边军皆属抄家大罪。',
  },
  {
    id: 'ancient-war',
    genre: '古代战争',
    badge: '乱世争霸',
    kind: 'organization',
    title: '九州藩镇兵制与粮道地理',
    summary: '【世界类型】王朝末年群雄割据，北境铁骑叩关，江南世家拥兵自重。\n【军事体系】重甲步卒（玄甲营）、轻骑游弩、床弩攻城械、水师楼船。\n【核心法则】兵马未动粮草先行，冬春换季漕运结冰决定南北战局走向。',
  },
  {
    id: 'alt-history',
    genre: '历史架空',
    badge: '朝堂权谋',
    kind: 'rule',
    title: '六部台谏制度与皇权相权制衡',
    summary: '【朝堂架构】内阁票拟、司礼监批红、都察院风闻奏事、锦衣卫北镇抚司。\n【经济赋税】一条鞭法改制、海贸开海禁令、晋商与徽商钱庄汇票。\n【核心冲突】新政变法派与江南清流既得利益集团的生死博弈。',
  },
]

// StarWriter V2.2 同款：去 AI 味角色起名器（避开萧/叶/林/苏/顾等撞烂姓氏）
const NAMER_POOLS: Record<string, { direction: string; items: { name: string; role: string; vibe: string; catchphrase: string }[] }[]> = {
  xianxia: [
    {
      direction: '方向一：清冷孤高 · 金石草木意象（避开萧/叶/林/苏）',
      items: [
        { name: '裴惊蛰', role: '主角 / 剑修', vibe: '外冷内烈，春雷破冰之剑', catchphrase: '“惊蛰既至，百虫当醒，你这把钝剑也该出鞘了。”' },
        { name: '温折雪', role: '女主 / 医修', vibe: '温润如玉却下手极狠，折梅映雪', catchphrase: '“救人一命收三两银，杀你，免费。”' },
        { name: '岑不渡', role: '重要配角', vibe: '苦海孤舟，守关半生的散修刀客', catchphrase: '“渡人渡己太累，老夫只渡亡魂。”' },
        { name: '谢长庚', role: '师兄 / 幕后', vibe: '启明星落，表面病弱实则算无遗策', catchphrase: '“咳……师弟莫慌，这一局我三年前便落子了。”' },
        { name: '商玄烛', role: '宿敌 / 反派', vibe: '幽冥秉烛，偏执疯批的魔道魁首', catchphrase: '“天道若瞎，我便点一盏人皮烛替它看看。”' },
      ],
    },
    {
      direction: '方向二：杀伐果断 · 边塞铁血与古意单字',
      items: [
        { name: '封无咎', role: '主角 / 武夫', vibe: '百无禁忌，以凡躯硬撼神明', catchphrase: '“天降之咎，封某一人担之！”' },
        { name: '燕回舟', role: '游侠 / 刺客', vibe: '轻舟过万山，来去无踪的风流客', catchphrase: '“借你项上人头换壶好酒，不亏。”' },
        { name: '钟离昧', role: '宿将 / 枭雄', vibe: '老谋深算，镇守北境三十载', catchphrase: '“城在人在，何须向朝廷借一兵一卒？”' },
        { name: '虞知微', role: '谋士 / 司天监', vibe: '见微知著，执掌星象卜算的少女', catchphrase: '“卦象说你今日合该破财，把命留下吧。”' },
        { name: '闻人烬', role: '反派 / 邪修', vibe: '万物成烬，自尸山血海爬出的复仇者', catchphrase: '“灰烬里长出的花，才最艳。”' },
      ],
    },
  ],
  scifi: [
    {
      direction: '方向一：冷感赛博 · 工业与暗夜纪元',
      items: [
        { name: '祁昼', role: '主角 / 觉醒者', vibe: '永夜寻昼，理智到近乎冷酷的序列持有者', catchphrase: '“概率低于三成，但在我的计算里，这就叫必胜。”' },
        { name: '江逾白', role: '搭档 / 狙击手', vibe: '干净利落，在废墟里依然擦亮枪管的完美主义者', catchphrase: '“别乱动，你的影子暴露在感染区了。”' },
        { name: '盛鸦', role: '情报商 / 亦正亦邪', vibe: '黑市机械改造人，收集旧时代遗物', catchphrase: '“诚惠两枚高阶晶核，附赠一条活命路线。”' },
        { name: '唐挽星', role: '天才研究员', vibe: '笑眯眯的武器狂人，视危险实验为艺术', catchphrase: '“别怕，这管药剂最多让你多长两条机械臂。”' },
        { name: '严寂', role: '审判官 / 反派', vibe: '绝对秩序信徒，抹杀一切异常的铁腕领袖', catchphrase: '“秩序不需要感情，正如深渊不需要怜悯。”' },
      ],
    },
  ],
  urban: [
    {
      direction: '方向一：市井烟火 & 现代高辨识度',
      items: [
        { name: '陈野', role: '主角 / 破局者', vibe: '野草般疯长，草根逆袭的狠人', catchphrase: '“规矩是赢家定的，今天起换我坐庄。”' },
        { name: '周妄', role: '反派 / 世家子', vibe: '肆意妄为，表面温和实则极度危险', catchphrase: '“我这人最讲道理，可惜你不配听。”' },
        { name: '梁岁寒', role: '女主 / 法医刑警', vibe: '岁寒知松柏，冷静敏锐的解剖专家', catchphrase: '“死人不会撒谎，但活人每一句都在编。”' },
        { name: '孟听澜', role: '幕后推手', vibe: '静水深流，茶馆里操盘百亿资本的掌舵人', catchphrase: '“喝茶要慢，收网要快。”' },
        { name: '许肆', role: '热血死党', vibe: '张扬洒脱，为兄弟两肋插刀的散打冠军', catchphrase: '“废什么话，干就完了！”' },
      ],
    },
  ],
}

function blockText(block: ManuscriptBlock): string {
  return block.type === 'horizontalRule' ? '' : (block.content ?? []).map((node) => node.type === 'hardBreak' ? '\n' : node.text).join('')
}

export function KnowledgePanel({ api, book, busy, initialKind, initialId, error, pendingMessage, checkingReceipt, onCheckReceipt, onRecover, onClose, onDirtyChange, onUpgrade, onCreate, onUpdate, onForge }: Props) {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusRefresh, setStatusRefresh] = useState(0)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const [activeView, setActiveView] = useState<'entries' | 'worldModels' | 'namer' | 'adjudication'>('entries')
  const [adjudicationDraft, setAdjudicationDraft] = useState<string | null>(null)
  const [namerGenre, setNamerGenre] = useState<'xianxia' | 'scifi' | 'urban'>('xianxia')
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<{ search: string; kind: KnowledgeKind | ''; nature: KnowledgeNature | ''; reviewOnly: boolean }>({ search: '', kind: initialKind ?? '', nature: '', reviewOnly: false })
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState<KnowledgeItemPage | null>(null)
  const portraits = useSavedPortraits(api, book.book.id, page?.bookRevision ?? book.book.revision)
  const [listLoading, setListLoading] = useState(true)
  const [detail, setDetail] = useState<KnowledgeItemDetail | null>(null)
  const [reading, setReading] = useState(false)
  const [writing, setWriting] = useState(false)
  const [mode, setMode] = useState<'view' | 'create' | 'edit'>('view')
  const [fields, setFields] = useState<KnowledgeItemFields>(initialFields)
  const [aliases, setAliases] = useState('')
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [expectedRevision, setExpectedRevision] = useState(0)
  const [sourceType, setSourceType] = useState<KnowledgeSourceInput['sourceType'] | ''>('')
  const [quote, setQuote] = useState('')
  const [sourceChapter, setSourceChapter] = useState<ChapterSnapshot | null>(null)
  const [blockId, setBlockId] = useState('')
  const [evidence, setEvidence] = useState<{ source: KnowledgeSource; revision: RevisionSnapshot } | null>(null)
  const mounted = useRef(false)
  const readTicket = useRef(0)
  const listTicket = useRef(0)
  const statusTicket = useRef(0)
  const dirtyRef = useRef(false)
  const writeLock = useRef(false)
  const readLock = useRef(false)
  const callback = useRef(onDirtyChange)
  callback.current = onDirtyChange
  const unavailable = busy || writing || reading || Boolean(pendingMessage)
  const archived = Boolean(book.book.archivedAt)
  const knowledgeReady = status !== null && !status.requiresUpgrade
  const characterProfileReady = status !== null && status.schemaVersion >= CHARACTER_PROFILE_SCHEMA_VERSION
  const abilitiesReady = status !== null && status.schemaVersion >= 17
  const adjudicationReady = status !== null && status.schemaVersion >= KNOWLEDGE_ADJUDICATION_SCHEMA_VERSION
  const initialSelection = useRef(initialId)
  useEffect(() => {
    if (!knowledgeReady || unavailable || !initialSelection.current) return
    const id = initialSelection.current
    initialSelection.current = undefined
    void selectItem(id)
  }, [knowledgeReady, unavailable])
  const hasProfileDraft = Object.values(fields.characterProfile ?? {}).some((value) => typeof value === 'string' ? Boolean(value.trim()) : Boolean(value && Object.keys(value).length))

  function setDirtyState(value: boolean) { dirtyRef.current = value; setDirty(value); callback.current(value) }
  function markChanged() { setDirtyState(true); setMessage(null) }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; readTicket.current += 1; listTicket.current += 1; statusTicket.current += 1; callback.current(false) }
  }, [])

  useEffect(() => { setRecoveryConfirmed(false) }, [pendingMessage])

  useEffect(() => {
    const ticket = ++statusTicket.current
    setStatusLoading(true); setStatus(null)
    void request(() => api.getKnowledgeStatus({ bookId: book.book.id })).then((result) => {
      if (!mounted.current || ticket !== statusTicket.current) return
      setStatusLoading(false)
      if (result.ok && result.data.bookId === book.book.id) setStatus(result.data)
      else setMessage(result.ok ? '知识库状态与当前作品不符，请重新打开后再试。' : result.error.message)
    })
    return () => { statusTicket.current += 1 }
  }, [api, book.book.id, statusRefresh])

  useEffect(() => {
    if (!knowledgeReady) { setPage(null); setListLoading(false); return }
    const ticket = ++listTicket.current
    setListLoading(true); setPage(null)
    void request(() => api.listKnowledgeItems({ bookId: book.book.id, search: filters.search, ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.nature ? { nature: filters.nature } : {}), reviewOnly: filters.reviewOnly, includeOverview: true, limit: PAGE_SIZE, offset })).then((result) => {
      if (!mounted.current || ticket !== listTicket.current) return
      setListLoading(false)
      if (result.ok && result.data.bookId === book.book.id && result.data.overview &&
          KNOWLEDGE_KINDS.every((kind) => Number.isSafeInteger(result.data.overview?.counts[kind]) && result.data.overview!.counts[kind] >= 0) &&
          Object.values(result.data.overview.counts).reduce((sum, count) => sum + count, 0) === result.data.overview.total &&
          Number.isSafeInteger(result.data.overview.reviewTotal) && result.data.overview.reviewTotal >= 0 && result.data.overview.reviewTotal <= result.data.overview.total) setPage(result.data)
      else if (result.ok) setMessage('知识列表与当前作品不符，请重新打开后再试。')
      else setMessage(result.error.message)
    })
    return () => { listTicket.current += 1 }
  }, [api, book.book.id, filters, offset, refresh, knowledgeReady])

  async function upgrade() {
    if (!upgradeConfirmed || !status || (!status.requiresUpgrade && abilitiesReady && adjudicationReady) || mode !== 'view' ||
        dirtyRef.current || archived || busy || pendingMessage || writeLock.current || readLock.current) return
    writeLock.current = true; setWriting(true); setMessage(null)
    try {
      await onUpgrade((saved) => {
        if (!mounted.current) return
        if (saved.bookId !== book.book.id || saved.requiresUpgrade || saved.schemaVersion < KNOWLEDGE_ADJUDICATION_SCHEMA_VERSION) { setMessage('启用回执尚未确认知识裁决可用，请保留窗口并核对结果。'); return }
        setStatus(saved); setDetail(null); resetSource(); setUpgradeConfirmed(false); setRefresh((value) => value + 1)
      })
    } catch { if (mounted.current) setMessage('启用结果尚未确认，请保留窗口并核对回执。') }
    finally { writeLock.current = false; if (mounted.current) setWriting(false) }
  }

  function mayLeave(): boolean {
    if (busy || pendingMessage || writeLock.current || readLock.current) return false
    if (dirtyRef.current) { setMessage('此条目有未保存修改。请先保存，或点击“放弃本次修改”后再切换。'); return false }
    return true
  }

  function resetSource() { setSourceType(''); setQuote(''); setSourceChapter(null); setBlockId(''); setEvidence(null) }

  async function selectItem(id: string) {
    if (!mayLeave()) return
    setActiveView('entries')
    const ticket = ++readTicket.current
    readLock.current = true; setReading(true); setMessage(null); setDetail(null); setMode('view'); resetSource()
    const result = await request(() => api.getKnowledgeItem({ bookId: book.book.id, id }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.id === id) setDetail(result.data)
    else if (result.ok) setMessage('读取条目的身份不符，请刷新后再试。')
    else setMessage(result.error.message)
  }

  function beginEdit(create: boolean, preset?: Partial<KnowledgeItemFields>) {
    if (!mayLeave() || archived || (create ? !page : !detail)) return
    setActiveView('entries')
    setMode(create ? 'create' : 'edit')
    const values = create ? { ...initialFields, ...preset } : detail!
    if (create) setDetail(null)
    setFields({
      kind: values.kind,
      name: values.name,
      aliases: [...values.aliases],
      summary: values.summary,
      nature: values.nature,
      authorDecision: values.authorDecision,
      freshness: values.freshness,
      conflictState: values.conflictState,
      ...(values.characterProfile === undefined ? {} : { characterProfile: { ...values.characterProfile } }),
    })
    setAliases(values.aliases.join('\n'))
    setExpectedRevision(create ? page!.knowledgeRevision : detail!.knowledgeRevision)
    resetSource()
    if (preset) markChanged()
    else setMessage(null)
  }

  function discard() {
    if (busy || pendingMessage || writeLock.current || readLock.current) return
    setDirtyState(false); setMode('view'); resetSource(); setMessage(null)
  }

  async function chooseChapter(chapterId: string) {
    if (unavailable) return
    markChanged(); setSourceChapter(null); setBlockId(''); setQuote('')
    if (!chapterId) return
    const ticket = ++readTicket.current
    readLock.current = true; setReading(true)
    const result = await request(() => api.readChapter({ bookId: book.book.id, chapterId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.id === chapterId) setSourceChapter(result.data)
    else if (result.ok) setMessage('读取的正文来源身份不符，请重新选择章节。')
    else setMessage(result.error.message)
  }

  function chooseBlock(id: string) {
    setBlockId(id); markChanged()
    const block = sourceChapter?.document.content.find((item) => item.attrs.id === id)
    setQuote(block ? blockText(block).slice(0, 2000) : '')
  }

  async function showSource(source: KnowledgeSource) {
    if (source.sourceType !== 'chapter_text' || unavailable) return
    const ticket = ++readTicket.current
    readLock.current = true; setReading(true); setEvidence(null); setMessage(null)
    const result = await request(() => api.readRevision({ bookId: book.book.id, chapterId: source.chapterId, revisionId: source.revisionId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.chapterId === source.chapterId && result.data.id === source.revisionId) setEvidence({ source, revision: result.data })
    else if (result.ok) setMessage('读取的正文版本身份不符，未展示其他正文。')
    else setMessage('无法读取此条来源的原版本：' + result.error.message)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || pendingMessage || writeLock.current || readLock.current || archived || mode === 'view') return
    let input: CreateKnowledgeItemInput
    try {
      const parsed = parseKnowledgeFields({ ...fields, aliases: aliases.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) })
      let source: KnowledgeSourceInput | undefined
      if (sourceType === 'chapter_text') {
        if (!sourceChapter || !blockId) { setMessage('请选择正文来源的章节和段落。'); return }
        source = parseKnowledgeSource({ sourceType, bookId: book.book.id, chapterId: sourceChapter.id, revisionId: sourceChapter.revisionId, blockId, quote }, book.book.id)
        const selected = sourceChapter.document.content.find((block) => block.attrs.id === blockId)
        if (!selected || !blockText(selected).includes(quote)) { setMessage('引文必须是所选段落中连续的原文，请保留原文的字词与空白。'); return }
      } else if (sourceType) source = parseKnowledgeSource({ sourceType, bookId: book.book.id, quote }, book.book.id)
      input = { bookId: book.book.id, expectedKnowledgeRevision: expectedRevision, fields: parsed, ...(source ? { source } : {}) }
    } catch (caught) { setMessage(caught instanceof DomainError ? caught.detail.message : '条目内容无效，请检查后再保存。'); return }
    writeLock.current = true; setWriting(true); setMessage(null)
    const expectedItemId = mode === 'edit' ? detail?.id : null
    const accept = (saved: KnowledgeItemDetail) => {
      if (!mounted.current) return
      if (saved.bookId !== book.book.id || (expectedItemId && saved.id !== expectedItemId)) { setMessage('保存回执的条目身份不符，当前修改仍保留。'); return }
      setDirtyState(false); setDetail(saved); setMode('view'); resetSource(); setRefresh((value) => value + 1)
    }
    try {
      if (mode === 'edit' && detail) await onUpdate({ ...input, id: detail.id }, accept)
      else await onCreate(input, accept)
    } catch { if (mounted.current) setMessage('保存尚未确认，请保留当前修改并核对回执。') }
    finally { writeLock.current = false; if (mounted.current) setWriting(false) }
  }

  function filterKind(value: string) { if (mayLeave()) { setFilters({ ...filters, kind: value as KnowledgeKind | '' }); setOffset(0); setActiveView('entries') } }
  function filterNature(value: string) { if (mayLeave()) { setFilters({ ...filters, nature: value as KnowledgeNature | '' }); setOffset(0) } }
  const sourceBlock = sourceChapter?.document.content.find((block) => block.attrs.id === blockId)
  const draftJson = pendingMessage && activeView === 'adjudication' ? adjudicationDraft : pendingMessage && mode !== 'view' ? JSON.stringify({
    format: 'storyweave-knowledge-draft', version: 1, bookId: book.book.id,
    operation: mode === 'edit' ? 'knowledge.update' : 'knowledge.create',
    ...(mode === 'edit' && detail ? { itemId: detail.id } : {}), expectedKnowledgeRevision: expectedRevision,
    fields: { ...fields, aliases: aliases.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }, aliasesText: aliases,
    source: sourceType ? { sourceType, bookId: book.book.id, quote,
      ...(sourceType === 'chapter_text' ? { chapterId: sourceChapter?.id ?? null, revisionId: sourceChapter?.revisionId ?? null, blockId: blockId || null } : {}) } : null,
  }, null, 2) : null
  const panelError = [message, error].filter((value, index, values) => value && value !== pendingMessage && values.indexOf(value) === index).join(' ') || null

  return <Dialog title={activeView === 'adjudication' ? '知识候选与裁决' : '故事设定库'} className={styles.libraryPage} wide busy={unavailable} error={panelError} onClose={() => { if (mayLeave()) onClose() }}><div className={styles.panel} data-mode={mode}>
    <div className={styles.intro}>
      <div>
        <p>{book.book.title}</p>
      </div>
      <div className={styles.topSwitchBar} role="tablist" aria-label="设定子模块切换">
        <button type="button" role="tab" aria-selected={activeView === 'entries' && filters.kind === ''} className={activeView === 'entries' && filters.kind === '' ? styles.topTabActive : styles.topTab} onClick={() => filterKind('')}><StudioIcon name="books" size={20} />全部设定</button>
        <button type="button" role="tab" aria-selected={activeView === 'entries' && filters.kind === 'person'} className={activeView === 'entries' && filters.kind === 'person' ? styles.topTabActive : styles.topTab} onClick={() => filterKind('person')}><StudioIcon name="user" size={20} />本书人物</button>
        <button type="button" role="tab" aria-selected={activeView === 'worldModels'} className={activeView === 'worldModels' ? styles.topTabActive : styles.topTab} onClick={() => { if (mayLeave()) setActiveView('worldModels') }}><StudioIcon name="galaxy" size={20} />世界模板</button>
        <button type="button" role="tab" aria-selected={activeView === 'namer'} className={activeView === 'namer' ? styles.topTabActive : styles.topTab} onClick={() => { if (mayLeave()) setActiveView('namer') }}><StudioIcon name="spark" size={20} />名字参考</button>
      </div>
    </div>

    {pendingMessage && <section className={styles.pending} aria-label="核对知识库操作结果">
      <h3>操作结果尚未确认</h3>
      <p role="status">{pendingMessage}</p>
      <button className={shared.button} type="button" disabled={checkingReceipt} onClick={onCheckReceipt}>{checkingReceipt ? '正在核对…' : '核对回执'}</button>
      {draftJson && <><label>条目与裁决草稿副本（只读，可全选复制）<textarea className={styles.draftCopy} readOnly value={draftJson} rows={9} spellCheck={false} onFocus={(event) => event.currentTarget.select()} /></label><p>请将以上内容复制到安全位置。此副本保留当前条目或裁决及固定来源；恢复页不会自动导入或重新提交它。</p></>}
      <label className={`${shared.checkLabel} ${styles.upgradeCheck}`}><input type="checkbox" checked={recoveryConfirmed} disabled={checkingReceipt} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />{draftJson ? '我已复制保留条目草稿，了解原操作可能已写入。' : '我了解知识库启用操作可能已成功，需要在恢复后核对结果。'}</label>
      <button className={shared.button} type="button" disabled={!recoveryConfirmed || checkingReceipt} onClick={() => { if (pendingMessage && recoveryConfirmed && !checkingReceipt) onRecover() }}>进入草稿与恢复</button>
    </section>}

    {archived && <p className={shared.helpText}>作品已归档，可查看知识资料；解除归档后才能编辑。</p>}
    {statusLoading && <p className={styles.status} role="status">正在检查本书知识库…</p>}
    {!statusLoading && !status && <button className={shared.button} type="button" disabled={unavailable} onClick={() => { setMessage(null); setStatusRefresh((value) => value + 1) }}>重新检查知识库</button>}
    {status?.requiresUpgrade && <section className={styles.upgrade} aria-label="启用本书知识库">
      <h3>为这本书启用角色卡与设定库</h3>
      <p>当前作品使用旧版数据结构。启用时会先保存本书数据库的独立备份，再升级至 v26，以存储角色档案、世界观规则、来源、修改与独立裁决记录。升级后须使用支持 v26 的程序。</p>
      <label className={`${shared.checkLabel} ${styles.upgradeCheck}`}><input type="checkbox" checked={upgradeConfirmed} disabled={unavailable || archived} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />我了解升级会修改本书数据库，并同意先备份后启用。</label>
      <button className={shared.primaryButton} type="button" disabled={unavailable || archived || !upgradeConfirmed} onClick={() => void upgrade()}>{writing || busy ? '正在备份并启用…' : '备份并启用知识库'}</button>
    </section>}
    {status?.backupPath && <p className={styles.backupPath}>升级前备份：{status.backupPath}</p>}
    {knowledgeReady && !abilitiesReady && <details className={styles.upgrade}>
      <summary>可选：启用角色档案与六维能力数值</summary>
      <p>升级至当前 v26 后可保存八维文字档案、作者明确设定的六维能力、工坊采用回执及独立知识裁决。先保留独立备份，升级后须使用支持 v26 的程序。</p>
      <label className={`${shared.checkLabel} ${styles.upgradeCheck}`}><input type="checkbox" checked={upgradeConfirmed} disabled={unavailable || archived || mode !== 'view'} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />我同意先备份本书数据库，再启用人物档案。</label>
      <button className={shared.button} type="button" disabled={unavailable || archived || mode !== 'view' || !upgradeConfirmed} onClick={() => void upgrade()}>{writing || busy ? '正在备份并启用…' : '备份并启用人物档案'}</button>
    </details>}
    {knowledgeReady && abilitiesReady && !adjudicationReady && <details className={styles.upgrade}>
      <summary>可选：启用独立 A/B 知识裁决</summary>
      <p>先备份本书数据库，再升级至 v26，以保存两侧固定来源、保留 A/B 或有意安排及前后修订。原条目和来源完整保留；升级后的作品须使用支持 v26 的程序。</p>
      <label className={`${shared.checkLabel} ${styles.upgradeCheck}`}><input type="checkbox" checked={upgradeConfirmed} disabled={unavailable || archived || mode !== 'view'} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />我同意先备份本书数据库，再启用知识裁决。</label>
      <button className={shared.button} type="button" disabled={unavailable || archived || mode !== 'view' || !upgradeConfirmed} onClick={() => void upgrade()}>{writing || busy ? '正在备份并启用…' : '备份并启用知识裁决'}</button>
    </details>}

    {knowledgeReady && activeView === 'adjudication' && detail && adjudicationReady && <>
      <KnowledgeAdjudicationPanel key={`${detail.id}:${detail.revisions[0]?.id ?? ''}`} book={book} detail={detail} disabled={unavailable}
        onUpdate={onUpdate} onDirtyChange={setDirtyState} onDraftChange={setAdjudicationDraft} onShowSource={(source) => void showSource(source)}
        onBack={() => { if (mayLeave()) { resetSource(); setActiveView('entries') } }}
        onSaved={(saved) => { setDetail(saved); resetSource(); setRefresh((value) => value + 1); setMessage(null) }} />
      {evidence && <Evidence source={evidence.source} revision={evidence.revision} onClose={() => setEvidence(null)} />}
    </>}

    {/* 子视图 A：StarWriter 9种世界观流派模型预设 */}
    {knowledgeReady && activeView === 'worldModels' && (
      <section className={styles.worldModelsSection} aria-label="9种世界模型预设">
        <div className={styles.subHeader}>
          <div>
            <h3>世界设定模板</h3>
            <p>9 份内置模板；选用后可编辑，保存前不会加入本书设定。</p>
          </div>
          <button type="button" className={shared.button} onClick={() => setActiveView('entries')}>返回设定列表</button>
        </div>
        <div className={styles.worldModelGrid}>
          {WORLD_MODELS.map((model) => (
            <article key={model.id} className={styles.worldModelCard}>
              <div className={styles.worldModelCardHead}>
                <span className={styles.worldGenrePill}>{model.genre}</span>
                <small>{model.badge}</small>
              </div>
              <h4>{model.title}</h4>
              <pre className={styles.worldModelPreview}>{model.summary}</pre>
              <button
                type="button"
                className={shared.primaryButton}
                disabled={unavailable || archived || !page}
                onClick={() => beginEdit(true, {
                  kind: model.kind,
                  name: `${model.genre} · ${model.title}`,
                  summary: model.summary,
                  nature: 'author_setting',
                  authorDecision: 'adopted',
                })}
              >
                + 套用此世界模型并编辑
              </button>
            </article>
          ))}
        </div>
      </section>
    )}

    {/* 子视图 B：StarWriter 去 AI 味角色起名器 */}
    {knowledgeReady && activeView === 'namer' && (
      <section className={styles.namerSection} aria-label="去AI味角色起名器">
        <div className={styles.subHeader}>
          <div>
            <h3>人物名字参考</h3>
            <p>按题材收录的内置候选。选用后可修改姓名与档案。</p>
          </div>
          <div className={styles.namerGenreButtons}>
            <button type="button" className={namerGenre === 'xianxia' ? shared.primaryButton : shared.button} onClick={() => setNamerGenre('xianxia')}>东方玄幻 / 修仙武侠</button>
            <button type="button" className={namerGenre === 'scifi' ? shared.primaryButton : shared.button} onClick={() => setNamerGenre('scifi')}>科幻末日 / 诡异异能</button>
            <button type="button" className={namerGenre === 'urban' ? shared.primaryButton : shared.button} onClick={() => setNamerGenre('urban')}>现代都市 / 悬疑权谋</button>
          </div>
        </div>

        <div className={styles.namerGroups}>
          {(NAMER_POOLS[namerGenre] ?? []).map((group) => (
            <div key={group.direction} className={styles.namerGroupCard}>
              <h4>{group.direction}</h4>
              <div className={styles.namerCandidateGrid}>
                {group.items.map((cand) => (
                  <div key={cand.name} className={styles.namerCandidateCard}>
                    <div className={styles.namerCandTop}>
                      <span className={styles.avatarCircle} data-tone={cand.name.charCodeAt(0) % 4}>{cand.name.slice(0, 1)}</span>
                      <div>
                        <strong>{cand.name}</strong>
                        <span className={styles.roleTag}>{cand.role}</span>
                      </div>
                    </div>
                    <p className={styles.namerVibe}>{cand.vibe}</p>
                    <blockquote className={styles.namerQuote}>{cand.catchphrase}</blockquote>
                    <button
                      type="button"
                      className={shared.button}
                      disabled={unavailable || archived || !page}
                      onClick={() => beginEdit(true, {
                        kind: 'person',
                        name: cand.name,
                        summary: `【角色定位】${cand.role}\n【人物气质】${cand.vibe}\n【代表口头禅】${cand.catchphrase}`,
                        characterProfile: {
                          motivation: cand.vibe,
                          speechStyle: cand.catchphrase,
                        },
                      })}
                    >
                      + 以「{cand.name}」新建角色卡
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    )}

    {/* 主视图 C：角色与设定列表 + 详情/编辑 */}
    {knowledgeReady && activeView === 'entries' && <>
      <div className={styles.libraryTools}>
        <form className={styles.search} onSubmit={(event) => { event.preventDefault(); if (mayLeave()) { setFilters({ ...filters, search: search.trim() }); setOffset(0) } }}>
          <StudioIcon name="search" size={20} /><input type="search" aria-label="搜索角色名、别名或设定说明" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} disabled={unavailable || dirty} placeholder="搜索设定…" />
          <button className={styles.toolIcon} type="submit" disabled={unavailable || dirty} aria-label="查找设定" title="查找"><StudioIcon name="arrow" size={20} /></button>
        </form>
        <button type="button" className={styles.reviewFilter} aria-pressed={filters.reviewOnly} disabled={unavailable || dirty} title="未处理、要求复核、新鲜度变化或冲突未检查／候选冲突" onClick={() => { if (mayLeave()) { setFilters({ ...filters, reviewOnly: !filters.reviewOnly }); setOffset(0) } }}>仅待复核<span>{page?.overview?.reviewTotal ?? '—'}</span></button>
        <button className={styles.toolIcon} type="button" disabled={unavailable || dirty || listLoading} onClick={() => { setMessage(null); setRefresh((value) => value + 1) }} aria-label="刷新设定库" title="刷新"><StudioIcon name="refresh" size={20} /></button>
        <button className={shared.primaryButton} type="button" disabled={unavailable || dirty || archived || !page} onClick={() => beginEdit(true, { kind: filters.kind || 'person' })}><StudioIcon name="plus" size={20} />新建条目</button>
      </div>
      {portraits.error && <p className={styles.status} role="status">{portraits.error}</p>}
      <div className={styles.layout}>
      <aside className={styles.filterPane} aria-label="设定筛选">
        <nav className={styles.categories} aria-label="设定分类">
          <button type="button" aria-pressed={!filters.kind} disabled={unavailable || dirty} onClick={() => filterKind('')}><StudioIcon name="books" size={24} /><span>全部设定</span><strong>{page?.overview?.total ?? '—'}</strong></button>
          {KNOWLEDGE_KINDS.map((kind) => <button type="button" key={kind} aria-pressed={filters.kind === kind} disabled={unavailable || dirty} onClick={() => filterKind(kind)}><StudioIcon name={categoryIcons[kind]} size={24} /><span>{kindLabels[kind]}</span><strong>{page?.overview?.counts[kind] ?? '—'}</strong></button>)}
        </nav>
        <div className={styles.filters}>
          <label>性质<select value={filters.nature} onChange={(event) => filterNature(event.target.value)} disabled={unavailable || dirty}><option value="">全部性质</option>{KNOWLEDGE_NATURES.map((nature) => <option key={nature} value={nature}>{natureLabels[nature]}</option>)}</select></label>
        </div>
      </aside><section className={styles.listPane} aria-label="知识条目列表">
        {listLoading && <p className={styles.status} role="status">正在读取本书角色与设定…</p>}
        {page && <p className={styles.status}>共 {page.total.toLocaleString()} 张设定卡 · 每页 {PAGE_SIZE} 条</p>}
        <ul className={styles.items}>
          {page?.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`${styles.itemRowBtn} ${detail?.id === item.id ? styles.selected : ''}`}
                disabled={unavailable || dirty}
                aria-pressed={detail?.id === item.id}
                onClick={() => void selectItem(item.id)}
              >
                <SavedPortrait api={api} bookId={book.book.id} personId={item.id} metadata={item.kind === 'person' ? portraits.items.find((value) => value.personId === item.id) : undefined} name={item.name} className={styles.cardPortrait} fallback={<><StudioIcon name={categoryIcons[item.kind]} size={48} /><span>{kindLabels[item.kind]}</span></>} />
                {(page.overview?.sourceChapterCounts[item.id] ?? 0) > 0 && <span className={styles.sourceCount}>出处 {page.overview!.sourceChapterCounts[item.id]} 章</span>}
                <div className={styles.itemRowMeta}>
                  <div className={styles.itemRowTitleLine}>
                    <strong>{item.name}</strong>
                    <span className={styles.roleTag} data-kind={item.kind}>{kindLabels[item.kind]}</span>
                  </div>
                  <span className={styles.itemSummary}>{item.summary || '尚未填写说明'}</span>
                  <span className={styles.cardState} data-tone={cardState(item).tone}><StudioIcon name={cardState(item).tone === 'success' ? 'check' : cardState(item).tone === 'inference' ? 'spark' : 'clock'} size={16} />{cardState(item).label}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
        {page?.items.length === 0 && (
          <div className={styles.emptyListHint}>
            <p>当前筛选下还没有卡片。</p>
            <div className={styles.listActions}>
              <button type="button" className={shared.primaryButton} disabled={unavailable || dirty || archived} onClick={() => beginEdit(true, { kind: filters.kind || 'person' })}>新建条目</button>
              <button type="button" className={shared.button} onClick={() => setActiveView('namer')}>查看名字参考</button>
              <button type="button" className={shared.button} onClick={() => setActiveView('worldModels')}>查看世界模板</button>
            </div>
          </div>
        )}
        <div className={styles.paging}><button type="button" className={shared.button} disabled={unavailable || dirty || listLoading || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button><span>{page ? `${page.total ? Math.floor(offset / PAGE_SIZE) + 1 : 0} / ${Math.ceil(page.total / PAGE_SIZE)}` : '—'}</span><button type="button" className={shared.button} disabled={unavailable || dirty || listLoading || page?.nextOffset == null} onClick={() => { if (page?.nextOffset != null) setOffset(page.nextOffset) }}>下一页</button></div>
      </section>

      <section className={styles.detailPane} aria-label="知识条目详情" aria-busy={reading}>
        {mode === 'view' ? detail ? <>
          <SavedPortrait api={api} bookId={book.book.id} personId={detail.id} metadata={detail.kind === 'person' ? portraits.items.find((value) => value.personId === detail.id) : undefined} name={detail.name} className={styles.detailPortrait} fallback={<StudioIcon name={categoryIcons[detail.kind]} size={64} />} />
          <div className={styles.detailHeading}>
            <div className={styles.detailHeroLeft}>
              <div>
                <div className={styles.detailTagRow}>
                  <span className={styles.roleTag} data-kind={detail.kind}>{kindLabels[detail.kind]}</span>
                  <span className={styles.natureBadge}>{natureLabels[detail.nature]}</span>
                </div>
                <h3>{detail.name}</h3>
                <span className={styles.cardState} data-tone={cardState(detail).tone}>{cardState(detail).label}</span>
                {detail.aliases.length > 0 && <p className={shared.helpText}>别名 / 称号：{detail.aliases.join('、')}</p>}
              </div>
            </div>
            <div className={styles.listActions}><button className={shared.primaryButton} type="button" disabled={unavailable || archived} onClick={() => beginEdit(false)}>编辑卡片</button>
              <button className={shared.button} type="button" disabled={unavailable || !adjudicationReady} onClick={() => { if (mayLeave()) { resetSource(); setActiveView('adjudication') } }}><StudioIcon name="warning" size={18} />{adjudicationReady ? '冲突裁决' : '需先启用知识裁决'}</button>
              <button className={shared.textButton} type="button" disabled={unavailable} onClick={() => void selectItem(detail.id)}>重新读取当前条目</button>
              {detail.kind === 'person' && onForge && <details className={styles.forgeActions}><summary>AI 工坊</summary><div><button className={shared.button} type="button" disabled={unavailable || archived} onClick={() => { if (mayLeave()) onForge(detail.id, 'fill') }}>AI 补全空白</button><button className={shared.button} type="button" disabled={unavailable || archived} onClick={() => { if (mayLeave()) onForge(detail.id, 'extract') }}>从正文提炼</button><button className={shared.button} type="button" disabled={unavailable || archived} onClick={() => { if (mayLeave()) onForge(detail.id, 'audition') }}>角色试戏</button></div></details>}
            </div>
          </div>

          <details className={styles.judgment}><summary>作者判断与状态</summary><div className={styles.labels}>
            <span>采纳状态：{decisionLabels[detail.authorDecision]}</span>
            <span>新鲜度：{freshnessLabels[detail.freshness]}</span>
            <span>一致性：{conflictLabels[detail.conflictState]}</span>
          </div>{detail.adjudications?.[0] && <p>最近独立裁决：{{ keep_a: '保留 A', keep_b: '保留 B', intentional: '标为有意安排' }[detail.adjudications[0].resolution]} · {detail.adjudications[0].revisionId === detail.revisions[0]?.id ? '对应当前修订' : '之后已有条目修订，请查看固定历史'}</p>}</details>
          {detail.nature === 'future_plan' && <p className={styles.natureNote}>这是尚未写成的未来计划，不作为当前已发生事实。</p>}
          {detail.nature === 'ai_inference' && <p className={styles.natureNote}>这是推断记录，需要依据与作者判断，不能自动视为已成立。</p>}

          <div className={styles.summaryCard}>
            <h4>身份与设定</h4>
            <p className={styles.body}>{detail.summary || '尚未填写说明。'}</p>
          </div>
          {detail.kind === 'person' && <dl className={styles.keyFacts}><div><dt>动机</dt><dd>{detail.characterProfile?.motivation || '未填写'}</dd></div><div><dt>致命弱点</dt><dd>{detail.characterProfile?.weakness || '未填写'}</dd></div><div><dt>身世</dt><dd>{detail.characterProfile?.background || '未填写'}</dd></div></dl>}

          {detail.kind === 'person' && (
            <details className={styles.characterProfile} key={`profile-${detail.id}`}><summary>完整八维档案与六维能力</summary>
              <CharacterProfileView profile={detail.characterProfile} />
            </details>
          )}

          <div className={styles.sectionHeading}><h4>正文出处与依据</h4><span>{detail.sources.length} 条</span></div>
          {detail.sources.length === 0 && <p className={shared.helpText}>暂无已登记来源。</p>}
          <ul className={styles.sources}>{detail.sources.map((source) => <li key={source.id}><div><strong>{sourceLabels[source.sourceType]}</strong><span>{source.sourceType === 'chapter_text' ? validityLabels[source.validity] : '手工来源记录'}{source.sourceType === 'chapter_text' && source.referenceState === 'historical' ? ' · 引用历史稿' : ''}</span></div><blockquote>{source.quote}</blockquote>{source.sourceType === 'chapter_text' && <button className={shared.button} type="button" onClick={() => void showSource(source)} disabled={unavailable}>查看此版本原文</button>}</li>)}</ul>
          {evidence && <Evidence source={evidence.source} revision={evidence.revision} onClose={() => setEvidence(null)} />}
          <div className={styles.sectionHeading}><h4>修改记录</h4><span>共 {detail.revisions.length} 次保存</span></div>
          <ol className={styles.history}>{detail.revisions.map((revision) => <li key={revision.id}><time dateTime={revision.createdAt}>{displayTime(revision.createdAt)}</time><span>{revision.reason === 'created' ? '建立卡片' : '更新卡片'} · {revision.fields.name} · {decisionLabels[revision.fields.authorDecision]}</span></li>)}</ol>
        </> : (
          <div className={styles.empty}>
            <StudioIcon name="read" size={32} /><h3>{reading ? '正在读取卡片…' : '尚未选择设定'}</h3>
            <p>选择条目查看档案、来源与作者判断。</p>
            <div className={styles.emptyActionRow}>
              <button type="button" className={shared.primaryButton} disabled={unavailable || archived || !page} onClick={() => beginEdit(true, { kind: 'person' })}>+ 新建人物角色卡</button>
              <button type="button" className={shared.button} onClick={() => setActiveView('namer')}>名字参考</button>
              <button type="button" className={shared.button} onClick={() => setActiveView('worldModels')}>世界模板</button>
            </div>
          </div>
        ) : <form className={styles.editorForm} onSubmit={(event) => void save(event)}>
          <div className={styles.detailHeading}><h3>{mode === 'create' ? '新建角色 / 设定卡片' : '编辑角色 / 设定卡片'}</h3><span>{dirty ? '有未保存修改' : '尚未修改'}</span></div>
          <label>名称<input autoFocus value={fields.name} maxLength={120} required disabled={unavailable} placeholder="例如：林辰 / 裴惊蛰 / 九境修真体系" onChange={(event) => { setFields({ ...fields, name: event.target.value }); markChanged() }} /></label>
          <div className={styles.twoColumns}><label>卡片类型<select value={fields.kind} disabled={unavailable || hasProfileDraft} onChange={(event) => { setFields({ ...fields, kind: event.target.value as KnowledgeKind }); markChanged() }}>{KNOWLEDGE_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label><label>知识性质<select value={fields.nature} disabled={unavailable} onChange={(event) => { setFields({ ...fields, nature: event.target.value as KnowledgeNature }); markChanged() }}>{KNOWLEDGE_NATURES.map((nature) => <option key={nature} value={nature}>{natureLabels[nature]}</option>)}</select></label></div>
          {hasProfileDraft && <p className={shared.helpText}>此条目已填写人物档案。若要更改类型，请先清空档案中的内容；已保存的历史档案仍会保留。</p>}
          <label>称号 / 普通别名（每行一个）<textarea value={aliases} rows={2} maxLength={6049} disabled={unavailable} placeholder="如：林小哥、游戏宅、第七序列宿主" onChange={(event) => { setAliases(event.target.value); markChanged() }} /></label>
          <label>核心设定 / 人物小传<textarea value={fields.summary} rows={6} maxLength={20000} disabled={unavailable} onChange={(event) => { setFields({ ...fields, summary: event.target.value }); markChanged() }} placeholder="写下角色身份、核心性格、世界规则或势力架构…" /></label>
          {fields.kind === 'person' && (characterProfileReady
            ? <CharacterProfileEditor profile={fields.characterProfile} disabled={unavailable} abilitiesDisabled={unavailable || !abilitiesReady} onChange={(characterProfile) => { setFields({ ...fields, characterProfile }); markChanged() }} />
            : <p className={shared.helpText}>人物档案为选填功能，可先保存普通条目；返回详情后，在上方“可选：启用人物档案”中备份升级即可补充。</p>)}
          <div className={styles.twoColumns}><label>作者决定<select value={fields.authorDecision} disabled={unavailable} onChange={(event) => { setFields({ ...fields, authorDecision: event.target.value as KnowledgeItemFields['authorDecision'] }); markChanged() }}>{AUTHOR_DECISIONS.map((value) => <option key={value} value={value}>{decisionLabels[value]}</option>)}</select></label><label>冲突状态<select value={fields.conflictState} disabled={unavailable} onChange={(event) => { setFields({ ...fields, conflictState: event.target.value as KnowledgeItemFields['conflictState'] }); markChanged() }}>{CONFLICT_STATES.map((value) => <option key={value} value={value}>{conflictLabels[value]}</option>)}</select></label></div>
          <label>新鲜度标注<select value={fields.freshness} disabled={unavailable} onChange={(event) => { setFields({ ...fields, freshness: event.target.value as KnowledgeItemFields['freshness'] }); markChanged() }}>{KNOWLEDGE_FRESHNESS.map((value) => <option key={value} value={value}>{freshnessLabels[value]}</option>)}</select></label>
          <div className={styles.sectionHeading}><h4>{mode === 'edit' ? '追加来源' : '关联来源（可选）'}</h4></div>
          <label>来源类型<select value={sourceType} disabled={unavailable} onChange={(event) => { resetSource(); setSourceType(event.target.value as typeof sourceType); markChanged() }}><option value="">暂不添加来源</option><option value="author_input">作者输入</option><option value="chapter_text">本书正文摘录</option><option value="external">外部资料说明</option></select></label>
          {sourceType === 'chapter_text' && <><label>来源章节<select value={sourceChapter?.id ?? ''} disabled={unavailable} onChange={(event) => void chooseChapter(event.target.value)}><option value="">选择章节</option>{book.chapters.map((item) => <option key={item.id} value={item.id}>第 {item.position + 1} 章 · {item.title}</option>)}</select></label>{sourceChapter && <label>来源段落<select value={blockId} disabled={unavailable} onChange={(event) => chooseBlock(event.target.value)}><option value="">选择段落</option>{sourceChapter.document.content.map((block, index) => { const text = blockText(block); return text.trim() ? <option key={block.attrs.id} value={block.attrs.id}>段落 {index + 1} · {text.slice(0, 65)}</option> : null })}</select></label>}{sourceBlock && <blockquote className={styles.blockPreview}>{blockText(sourceBlock)}</blockquote>}</>}
          {sourceType && <label>{sourceType === 'chapter_text' ? '连续原文引文（最多 2,000 字符）' : '来源说明'}<textarea value={quote} maxLength={2000} rows={3} disabled={unavailable || (sourceType === 'chapter_text' && !blockId)} onChange={(event) => { setQuote(event.target.value); markChanged() }} required /></label>}
          <div className={shared.formActions}><button className={shared.button} type="button" disabled={unavailable} onClick={discard}>{dirty ? '放弃本次修改' : '返回详情'}</button><button className={shared.primaryButton} type="submit" disabled={unavailable || archived || !fields.name.trim() || (mode === 'edit' && !dirty)}>{writing || busy ? '正在保存…' : '保存卡片'}</button></div>
        </form>}
      </section>
    </div></>}
  </div></Dialog>
}

function Evidence({ source, revision, onClose }: { source: KnowledgeSource; revision: RevisionSnapshot; onClose: () => void }) {
  if (source.sourceType !== 'chapter_text') return null
  const index = revision.document.content.findIndex((block) => block.attrs.id === source.blockId)
  const blocks = index < 0 ? [] : revision.document.content.slice(Math.max(0, index - 1), index + 2)
  return <section className={styles.evidence} aria-label="来源版本原文"><div className={styles.sectionHeading}><h4>来源版本上下文</h4><button type="button" className={shared.button} onClick={onClose}>收起原文</button></div>{index < 0 ? <p className={shared.helpText}>该版本中未找到所引用段落，未跳转到其他正文。</p> : blocks.map((block) => <p className={block.attrs.id === source.blockId ? styles.evidenceQuote : styles.evidenceContext} key={block.attrs.id}>{block.type === 'horizontalRule' ? '分场线' : blockText(block)}</p>)}</section>
}
