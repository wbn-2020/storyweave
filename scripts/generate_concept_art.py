# -*- coding: utf-8 -*-
import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT_DIR = r"C:\AI\vibecoding\storyweave\design\concepts-v2"
os.makedirs(OUT_DIR, exist_ok=True)

FONT_REG_PATH = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD_PATH = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_MONO_PATH = r"C:\Windows\Fonts\consola.ttf"

def get_font(size, bold=False, mono=False):
    try:
        if mono and os.path.exists(FONT_MONO_PATH):
            return ImageFont.truetype(FONT_MONO_PATH, size)
        path = FONT_BOLD_PATH if bold else FONT_REG_PATH
        return ImageFont.truetype(path, size, index=0)
    except Exception:
        return ImageFont.load_default()

# Palette (Dark Cosmic Studio - crisp contrast, no alpha bug)
BG_BASE = (11, 14, 23)        # #0B0E17
BG_SIDEBAR = (16, 20, 32)     # #101420
BG_CARD = (21, 26, 42)        # #151A2A
BG_CARD_ALT = (28, 35, 56)    # #1C2338
BG_INPUT = (14, 18, 29)       # #0E121D
BORDER_SUBTLE = (45, 55, 85)  # #2D3755

TXT_MAIN = (241, 245, 249)    # #F1F5F9
TXT_SUB = (165, 180, 202)     # #A5B4CA
TXT_MUTED = (108, 124, 148)   # #6C7C94

ACCENT_INDIGO = (99, 102, 241)   # #6366F1
ACCENT_VIOLET = (168, 85, 247)   # #A855F7
ACCENT_CYAN = (34, 211, 238)     # #22D3EE
ACCENT_EMERALD = (52, 211, 153)  # #34D399
ACCENT_AMBER = (251, 191, 36)    # #FBBF24
ACCENT_ROSE = (251, 113, 133)    # #FB7185

def tint(color, bg=BG_CARD, ratio=0.18):
    return (
        int(bg[0] * (1 - ratio) + color[0] * ratio),
        int(bg[1] * (1 - ratio) + color[1] * ratio),
        int(bg[2] * (1 - ratio) + color[2] * ratio),
    )

def create_base_canvas(w=1920, h=1080):
    img = Image.new("RGBA", (w, h), BG_BASE + (255,))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse((150, -150, 950, 550), fill=(99, 102, 241, 30))
    gdraw.ellipse((1100, 400, 1950, 1150), fill=(168, 85, 247, 25))
    gdraw.ellipse((500, 650, 1200, 1200), fill=(34, 211, 238, 18))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=90))
    img = Image.alpha_composite(img, glow).convert("RGB")
    return img

def draw_card(draw, box, fill=BG_CARD, outline=BORDER_SUBTLE, radius=12, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

def draw_badge(draw, x, y, text, fg=ACCENT_INDIGO, bg=None, font_size=12, pad_x=10, pad_y=4, radius=7):
    if bg is None:
        bg = tint(fg, BG_CARD, 0.20)
    f = get_font(font_size, bold=True)
    bbox = draw.textbbox((0, 0), text, font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    w = tw + pad_x * 2
    h = th + pad_y * 2 + 4
    border_col = tint(fg, BG_CARD, 0.55)
    draw.rounded_rectangle((x, y, x + w, y + h), radius=radius, fill=bg, outline=border_col, width=1)
    draw.text((x + pad_x, y + pad_y - 1), text, font=f, fill=fg)
    return w, h

def wrap_text(draw, text, font, max_width):
    lines = []
    for paragraph in text.split("\n"):
        cur = ""
        for ch in paragraph:
            test = cur + ch
            bbox = draw.textbbox((0, 0), test, font=font)
            if bbox[2] - bbox[0] <= max_width:
                cur = test
            else:
                if cur:
                    lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
    return lines

def draw_wrapped(draw, x, y, text, font, fill, max_width, line_gap=6, max_lines=None):
    lines = wrap_text(draw, text, font, max_width)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1][:-1] + "…"
    cy = y
    for line in lines:
        draw.text((x, cy), line, font=font, fill=fill)
        bbox = draw.textbbox((0, 0), line, font=font)
        cy += (bbox[3] - bbox[1]) + line_gap
    return cy

def draw_app_shell(draw, active_nav=0, active_spine=0, book_title="《赛博修仙：我在废土修真机甲》", subtitle="仙侠 · 赛博朋克 · 黄金开篇孵化"):
    # Top Window Bar
    draw.rectangle((0, 0, 1920, 42), fill=(9, 12, 20))
    draw.line((0, 42, 1920, 42), fill=BORDER_SUBTLE, width=1)
    draw.ellipse((20, 14, 32, 26), fill=ACCENT_ROSE)
    draw.ellipse((42, 14, 54, 26), fill=ACCENT_AMBER)
    draw.ellipse((64, 14, 76, 26), fill=ACCENT_EMERALD)
    draw.text((96, 11), "织章 StoryWeave  ·  AI 原生小说创作工作台 v2.0", font=get_font(14, bold=True), fill=TXT_SUB)

    # Command palette pill
    draw.rounded_rectangle((700, 7, 1180, 35), radius=8, fill=BG_CARD, outline=BORDER_SUBTLE, width=1)
    draw.text((720, 11), "[Ctrl + K]  唤起全局 AI 指令 / 跳章 / 拆书 / 检索设定...", font=get_font(13), fill=TXT_MUTED)

    # Model Route status on right
    draw_badge(draw, 1430, 8, "● 智能路由已就绪: DeepSeek-R1(大纲) + Claude-3.7(正文)", fg=ACCENT_EMERALD, font_size=12, pad_x=12, pad_y=4)

    # Left Sidebar (w=220)
    draw.rectangle((0, 43, 220, 1080), fill=BG_SIDEBAR)
    draw.line((220, 43, 220, 1080), fill=BORDER_SUBTLE, width=1)

    # Current Book Card in Sidebar
    draw_card(draw, (14, 58, 206, 142), fill=BG_CARD_ALT, outline=ACCENT_INDIGO, radius=12)
    draw_badge(draw, 26, 66, "当前连载作品", fg=ACCENT_CYAN, font_size=11, pad_x=8, pad_y=2)
    draw.text((26, 94), book_title[:11] + "…", font=get_font(14, bold=True), fill=TXT_MAIN)
    draw.text((26, 116), "第 1 卷 · 已写 3.8 万字", font=get_font(12), fill=TXT_SUB)

    nav_items = [
        ("01 · 一句话开书房", "G1 脑洞与三层大纲"),
        ("02 · 沉浸三栏写作", "G5 节拍流与选中改写"),
        ("03 · 演进大纲沙盘", "G4 节奏曲线与智能修纲"),
        ("04 · 角色与关系网", "G3 试戏舱与双层关系"),
        ("05 · 记忆星图雷达", "G6 出场矩阵与伏笔链"),
        ("06 · 拆书仿写工坊", "文风DNA与节拍骨架"),
        ("07 · AI 模型路由池", "多模型分工与Token账单"),
    ]
    ny = 162
    for idx, (title, desc) in enumerate(nav_items):
        is_act = (idx == active_nav)
        if is_act:
            draw_card(draw, (14, ny, 206, ny + 54), fill=tint(ACCENT_INDIGO, BG_SIDEBAR, 0.28), outline=ACCENT_INDIGO, radius=10, width=2)
            draw.rectangle((14, ny + 12, 18, ny + 42), fill=ACCENT_INDIGO)
        else:
            draw_card(draw, (14, ny, 206, ny + 54), fill=BG_CARD, outline=BORDER_SUBTLE, radius=10, width=1)
        draw.text((28, ny + 8), title, font=get_font(14, bold=is_act), fill=TXT_MAIN if is_act else TXT_SUB)
        draw.text((28, ny + 30), desc, font=get_font(11), fill=ACCENT_CYAN if is_act else TXT_MUTED)
        ny += 64

    # Bottom writing goal in sidebar
    draw_card(draw, (14, 965, 206, 1062), fill=BG_CARD, outline=BORDER_SUBTLE, radius=12)
    draw.text((26, 977), "★ 今日码字目标", font=get_font(13, bold=True), fill=TXT_MAIN)
    draw.text((26, 1001), "3,680 / 4,000 字 (92%)", font=get_font(12, bold=True), fill=ACCENT_EMERALD)
    draw.rounded_rectangle((26, 1024, 194, 1034), radius=5, fill=BG_INPUT)
    draw.rounded_rectangle((26, 1024, 180, 1034), radius=5, fill=ACCENT_EMERALD)
    draw.text((26, 1040), "连续日更 14 天 · 速度 2,400字/h", font=get_font(11), fill=TXT_MUTED)

    # Top 5-Domain Spine Bar (x=221..1920, y=43..112)
    draw.rectangle((221, 43, 1920, 112), fill=BG_INPUT)
    draw.line((221, 112, 1920, 112), fill=BORDER_SUBTLE, width=1)

    draw.text((244, 54), book_title, font=get_font(18, bold=True), fill=TXT_MAIN)
    draw.text((244, 82), subtitle, font=get_font(12), fill=TXT_SUB)

    spines = [
        ("① 脑洞种子", "✓ 已锁定"),
        ("② 世界铁律", "✓ 3条法则"),
        ("③ 角色班底", "✓ 6人就绪"),
        ("④ 演进大纲", "● 1章待修纲"),
        ("⑤ 章节正文", "● 第2章创作中"),
    ]
    sx = 700
    for idx, (stitle, sstate) in enumerate(spines):
        is_cur = (idx == active_spine)
        col = ACCENT_INDIGO if is_cur else (ACCENT_EMERALD if "✓" in sstate else ACCENT_AMBER)
        bg = tint(col, BG_INPUT, 0.25 if is_cur else 0.12)
        draw.rounded_rectangle((sx, 53, sx + 195, 101), radius=10, fill=bg, outline=col if is_cur else BORDER_SUBTLE, width=2 if is_cur else 1)
        draw.text((sx + 14, 58), stitle, font=get_font(13, bold=True), fill=TXT_MAIN)
        draw.text((sx + 14, 78), sstate, font=get_font(11, bold=True), fill=col)
        if idx < len(spines) - 1:
            draw.line((sx + 195, 77, sx + 225, 77), fill=BORDER_SUBTLE, width=2)
        sx += 225


# ==============================================================================
# IMAGE 1: G1 一句话开书房 + 三层动态演进大纲 (Kickstart & Living Outline)
# ==============================================================================
def build_image_1():
    img = create_base_canvas()
    draw = ImageDraw.Draw(img)
    draw_app_shell(draw, active_nav=0, active_spine=3)

    # Prompt Input Hero Bar (y=128..218)
    draw_card(draw, (244, 128, 1896, 218), fill=BG_CARD_ALT, outline=ACCENT_INDIGO, radius=14, width=2)
    draw_badge(draw, 264, 140, "★ 一句话爽文脑洞输入", fg=ACCENT_CYAN, font_size=12)
    draw_badge(draw, 445, 140, "题材：赛博修仙 / 废土机甲 / 幕后迪化", fg=ACCENT_VIOLET, font_size=12)
    draw_badge(draw, 745, 140, "耗时 14.2s · 单库孵化事务已就绪 (book.sqlite)", fg=ACCENT_EMERALD, font_size=12)

    draw.text((264, 176), "“穿成废土边缘破烂维修铺的瞎眼老学徒，我随手用报废义体拼装的除草机，竟被联邦圣女当成上古仙道镇世机甲顶礼膜拜？”",
              font=get_font(16, bold=True), fill=TXT_MAIN)

    draw.rounded_rectangle((1555, 148, 1710, 198), radius=10, fill=BG_CARD, outline=BORDER_SUBTLE, width=1)
    draw.text((1578, 163), "↻ 全套换一拨", font=get_font(14, bold=True), fill=TXT_SUB)
    draw.rounded_rectangle((1724, 148, 1878, 198), radius=10, fill=ACCENT_INDIGO, outline=ACCENT_VIOLET, width=2)
    draw.text((1744, 163), "▶ 采纳并开写", font=get_font(14, bold=True), fill=TXT_MAIN)

    # Column 1: 书名矩阵 & 世界3铁律 (x=244..720, y=234..1056)
    draw_card(draw, (244, 234, 720, 680), fill=BG_CARD, outline=BORDER_SUBTLE)
    draw.text((264, 250), "① 爆款书名矩阵（5 角度备选）", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 580, 248, "↻ 仅换书名", fg=ACCENT_CYAN, font_size=12)

    titles = [
        ("爽点反差型", "《让你修农用义体，你搓出仙道歼星舰？》", True, "番茄/起点爆款相，反差感拉满"),
        ("悬念脑洞型", "《废土盲眼维修师：我的客人全是仙朝余孽》", False, "适合群像幕后流，世界观钩子强"),
        ("宿命史诗型", "《赛博劫灰录：从第零号锈铁铺开始成神》", False, "适合硬核慢热与设定党"),
        ("轻小说吐槽", "《关于我焊的破铜烂铁被全网尊为仙器这件事》", False, "轻松幽默、弹幕互动感极强"),
    ]
    ty = 290
    for tag, tname, chosen, reason in titles:
        c_outline = ACCENT_EMERALD if chosen else BORDER_SUBTLE
        c_bg = tint(ACCENT_EMERALD, BG_INPUT, 0.16) if chosen else BG_INPUT
        draw_card(draw, (264, ty, 700, ty + 84), fill=c_bg, outline=c_outline, radius=10, width=2 if chosen else 1)
        draw_badge(draw, 278, ty + 10, tag, fg=ACCENT_EMERALD if chosen else TXT_SUB, font_size=11, pad_x=8, pad_y=2)
        if chosen:
            draw_badge(draw, 595, ty + 10, "✓ 已选中", fg=ACCENT_EMERALD, font_size=11, pad_x=8, pad_y=2)
        draw.text((278, ty + 36), tname, font=get_font(14, bold=True), fill=TXT_MAIN)
        draw.text((278, ty + 59), f"推荐理由：{reason}", font=get_font(11), fill=TXT_SUB if chosen else TXT_MUTED)
        ty += 94

    # World 3 Iron Rules Card
    draw_card(draw, (244, 696, 720, 1056), fill=BG_CARD, outline=BORDER_SUBTLE)
    draw.text((264, 712), "② 世界底色 & 核心 3 铁律（硬约束）", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 575, 710, "强制注入生成", fg=ACCENT_VIOLET, font_size=12)

    rules = [
        ("法则 01 · 灵根即义体接口", "凡人唯有剥离原生神经、嵌合旧纪元『青铜仙骸』方可引气入体；算力过载将直接诱发电子心魔。"),
        ("法则 02 · 天劫即轨道律令炮", "修士突破金丹时将触发环地轨道『太微垣』主脑的算力清洗，雷劫本质为高能电浆轨道轰炸。"),
        ("法则 03 · 盲眼主角的万物焊装律", "主角沈烬双目失明却能听见机械与灵枢的『道韵杂音』，凡经其手焊接之物必附带一条逆天因果词条。"),
    ]
    ry = 752
    for rtitle, rdesc in rules:
        draw_card(draw, (264, ry, 700, ry + 90), fill=BG_INPUT, outline=BORDER_SUBTLE, radius=10)
        draw.text((278, ry + 10), rtitle, font=get_font(13, bold=True), fill=ACCENT_CYAN)
        draw_wrapped(draw, 278, ry + 34, rdesc, get_font(12), TXT_SUB, 405, line_gap=4, max_lines=2)
        ry += 98

    # Column 2: 三层动态演进大纲沙盘 (x=738..1410, y=234..1056)
    draw_card(draw, (738, 234, 1410, 1056), fill=BG_CARD, outline=ACCENT_INDIGO, width=2)
    draw.text((760, 250), "③ 初版三层演进大纲（总纲 ➔ 首卷主线 ➔ 黄金三章细纲）", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 1235, 248, "★ 随剧情滚动修纲", fg=ACCENT_AMBER, font_size=12)

    # Tier 1: Master 4-Act Outline
    draw_card(draw, (758, 288, 1390, 456), fill=BG_INPUT, outline=BORDER_SUBTLE, radius=12)
    draw.text((776, 300), "【第一层 · 全书四幕总纲】 锁死故事终局北极星，防中后期写崩水字数", font=get_font(13, bold=True), fill=ACCENT_VIOLET)
    acts = [
        ("起 · 废土盲匠", "第 1–30 章", "在锈铁镇守着维修铺，靠焊装农具暗中救下流亡圣女，被各方误认为隐世古仙。"),
        ("承 · 财阀围猎", "第 31–80 章", "联邦三大仙道财阀联手封锁第9区，主角昔日修好的玩具纷纷化为镇宗神兵护主。"),
        ("转 · 太微真相", "第 81–140 章", "揭晓旧纪元飞升骗局：所谓仙界只是轨道主脑收割灵根算力的培养皿，重燃凡人神火。"),
        ("合 · 焊天之战", "第 141–180 章", "以整座废土大陆为炉，替众生重焊无污染灵枢，一锤敲碎太微垣天道轨道。"),
    ]
    ax = 776
    for atitle, arange, adesc in acts:
        draw_card(draw, (ax, 330, ax + 144, 444), fill=BG_CARD_ALT, outline=BORDER_SUBTLE, radius=8)
        draw.text((ax + 10, 338), atitle, font=get_font(12, bold=True), fill=TXT_MAIN)
        draw.text((ax + 10, 356), arange, font=get_font(11, bold=True), fill=ACCENT_CYAN)
        draw_wrapped(draw, ax + 10, 376, adesc, get_font(11), TXT_SUB, 124, line_gap=3, max_lines=3)
        ax += 151

    # Tier 2: Volume 1 Arc & Tension Curve
    draw_card(draw, (758, 470, 1390, 646), fill=BG_INPUT, outline=BORDER_SUBTLE, radius=12)
    draw.text((776, 482), "【第二层 · 第一卷主线纲要 & 紧张度节奏曲线】 卷一：锈铁铺里的古仙传闻（共20章）", font=get_font(13, bold=True), fill=ACCENT_CYAN)
    draw.text((776, 506), "本卷目标：守住老街维修铺并治好眼疾   |   关底BOSS：天机集团巡察使『赵无极』(slot:@antagonist)", font=get_font(12), fill=TXT_SUB)

    chart_box = (776, 534, 1372, 632)
    draw.rounded_rectangle(chart_box, radius=8, fill=BG_BASE, outline=BORDER_SUBTLE)
    pts = [(796, 608), (850, 580), (904, 548), (958, 595), (1012, 572), (1066, 544), (1120, 588), (1174, 558), (1228, 540), (1282, 590), (1350, 545)]
    for i in range(len(pts) - 1):
        draw.line((pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]), fill=ACCENT_CYAN, width=3)
    for idx, (px, py) in enumerate(pts):
        col = ACCENT_ROSE if py < 555 else ACCENT_CYAN
        draw.ellipse((px - 5, py - 5, px + 5, py + 5), fill=col)
        draw.text((px - 10, py + 8), f"C{idx+1}", font=get_font(10), fill=TXT_MUTED)
    draw_badge(draw, 1170, 540, "★ 高潮卡点自动对齐", fg=ACCENT_ROSE, font_size=11, pad_x=8, pad_y=2)

    # Tier 3: Golden 3 Chapters Beats + Rolling Rebase
    draw.text((760, 660), "【第三层 · 黄金三章细纲（含3节拍+钩子）】  +  随剧情推进滚动续推", font=get_font(14, bold=True), fill=ACCENT_EMERALD)
    chapters = [
        ("第 1 章 · 半块发霉合成粮换修仙剑", "紧张度 78", [
            "节拍1：暴雪夜盲眼少年沈烬在铺内磨铁，重伤圣女苏清寒携断裂飞剑闯入。",
            "节拍2：沈烬把仙剑当成劣质合金犁头，用工业等离子焊枪随手补了一道焊缝。",
            "章末钩子：苏清寒握剑瞬间剑鸣九霄，满城义体修士灵枢同时报警！"
        ], False),
        ("第 2 章 · 你管这台除草机叫诛仙剑阵？", "紧张度 85", [
            "节拍1：天机集团执事率机械猎犬封街搜捕，踹开维修铺木门。",
            "节拍2：执事误触院角自动除草机，被附带『因果斩断』词条的刀片瞬间削去半截金丹义体。",
            "章末钩子：执事骇然逃窜汇报：锈铁街住着一位游戏人间的九劫剑仙！"
        ], False),
        ("第 3 章 · 全城大佬排队求我焊废铁", "紧张度 92 · 检测到剧情演进可修纲", [
            "节拍1：苏清寒留下一枚古玉抵债，黑市魁首连夜抬着报废机甲跪在铺外。",
            "节拍2：沈烬摸索古玉意外开启旧纪元天工图谱，首次看清满城修士头顶的气运线。",
            "章末钩子：轨道太微垣降下第一道巡检神念，直指维修铺后院！"
        ], True),
    ]
    cy = 692
    for ctitle, ctens, cbeats, highlight in chapters:
        draw_card(draw, (758, cy, 1390, cy + 110), fill=BG_INPUT, outline=ACCENT_AMBER if highlight else BORDER_SUBTLE, radius=10, width=2 if highlight else 1)
        draw.text((774, cy + 10), ctitle, font=get_font(13, bold=True), fill=TXT_MAIN)
        draw_badge(draw, 1110 if highlight else 1275, cy + 8, ctens, fg=ACCENT_AMBER if highlight else ACCENT_CYAN, font_size=11, pad_x=8, pad_y=2)
        by = cy + 36
        for b in cbeats:
            draw.text((774, by), "• " + b, font=get_font(11), fill=TXT_SUB)
            by += 22
        cy += 118

    # Column 3: 核心角色槽位卡 (x=1428..1896, y=234..1056)
    draw_card(draw, (1428, 234, 1896, 1056), fill=BG_CARD, outline=BORDER_SUBTLE)
    draw.text((1448, 250), "④ 核心人物锚点（槽位绑定）", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 1730, 248, "换人不崩大纲", fg=ACCENT_EMERALD, font_size=12)

    roles = [
        ("@protagonist · 主角", "沈烬 · 19岁 · 盲眼焊工", ACCENT_INDIGO,
         "执念：攒够三万信用点治好妹妹的结晶病\n弱点：极度护短、对修仙常识一无所知\n金手指：听声辨道韵、焊啥啥成仙器\n台词：“别挡着光——虽然我也看不见，但你踩脏我刚拖的地了。”"),
        ("@ally_1 · 核心羁绊", "苏清寒 · 太虚剑宗圣女", ACCENT_CYAN,
         "执念：查明师尊遭轨道天劫抹杀的真相\n弱点：严重脑补迪化症，把沈烬每句大白话当成无上道统\n台词：“前辈说这把剑缺了烟火气……原来我苦修百年，竟入魔道！”"),
        ("@antagonist · 首卷反派", "赵无极 · 天机集团巡察使", ACCENT_ROSE,
         "执念：夺取第9区所有野生古仙遗物晋升主城\n弱点：极度迷信算力战力榜，面对不可测因果律彻底破防\n台词：“区区下城区泥腿子，也配染指集团垄断的筑基芯片？”"),
    ]
    ry = 290
    for slot, rname, rcol, rbody in roles:
        draw_card(draw, (1448, ry, 1876, ry + 216), fill=BG_INPUT, outline=rcol, radius=12, width=1)
        draw_badge(draw, 1464, ry + 12, slot, fg=rcol, font_size=11, pad_x=8, pad_y=2)
        draw_badge(draw, 1765, ry + 12, "✓ 已采纳", fg=ACCENT_EMERALD, font_size=11, pad_x=8, pad_y=2)
        draw.text((1464, ry + 42), rname, font=get_font(15, bold=True), fill=TXT_MAIN)
        draw_wrapped(draw, 1464, ry + 72, rbody, get_font(12), TXT_SUB, 392, line_gap=6)
        ry += 230

    draw_card(draw, (1448, 984, 1876, 1042), fill=tint(ACCENT_INDIGO, BG_CARD, 0.22), outline=ACCENT_INDIGO, radius=10)
    draw.text((1464, 992), "★ 槽位联动保护：重掷 @antagonist 反派名字，左栏第1~3章细纲自动同步替换！", font=get_font(11, bold=True), fill=TXT_MAIN)
    draw.text((1464, 1016), "● 孵化态落盘：当前草稿已实时保存于本地 book.sqlite，断电重开零丢失。", font=get_font(11), fill=ACCENT_CYAN)

    out_path = os.path.join(OUT_DIR, "01-ai-kickstart-and-living-outline.png")
    img.save(out_path, quality=95)
    print("Saved:", out_path)


# ==============================================================================
# IMAGE 2: 沉浸三栏写作台 + 节拍扩写流水线 + 拆书仿写 & 三维读者模拟
# ==============================================================================
def build_image_2():
    img = create_base_canvas()
    draw = ImageDraw.Draw(img)
    draw_app_shell(draw, active_nav=1, active_spine=4)

    # Left Column: 目录 + 本章 3 节拍卡 + 拆书骨架挂载 (x=236..620, y=126..1060)
    draw_card(draw, (236, 126, 620, 1060), fill=BG_CARD, outline=BORDER_SUBTLE)
    draw.text((256, 144), "01 · 卷一目录 & 本章场景节拍", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 500, 142, "第 2 章写作中", fg=ACCENT_EMERALD, font_size=11)

    ch_list = [
        ("第 1 章  半块合成粮换修仙剑", "✓ 已定稿 · 3,420字", ACCENT_EMERALD, False),
        ("第 2 章  你管除草机叫诛仙剑阵？", "● 写作中 · 2,180/3,200字", ACCENT_INDIGO, True),
        ("第 3 章  全城大佬排队求焊铁", "○ 已排细纲 · 待开写", TXT_MUTED, False),
    ]
    cy = 182
    for ct, cs, ccol, act in ch_list:
        draw_card(draw, (254, cy, 602, cy + 54), fill=BG_CARD_ALT if act else BG_INPUT, outline=ACCENT_INDIGO if act else BORDER_SUBTLE, radius=9, width=2 if act else 1)
        draw.text((268, cy + 8), ct, font=get_font(13, bold=act), fill=TXT_MAIN if act else TXT_SUB)
        draw.text((268, cy + 30), cs, font=get_font(11, bold=True), fill=ccol)
        cy += 62

    draw.line((254, 378, 602, 378), fill=BORDER_SUBTLE, width=1)
    draw.text((256, 392), "02 · 本章 3 节拍推进器（可逐拍生成）", font=get_font(15, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 256, 422, "已套用拆书骨架：《雨夜巷战·三段反杀法》", fg=ACCENT_VIOLET, font_size=11)

    beats = [
        ("Beat 01 · 恶客临门（已完成）", "天机集团韩执事带机械猎犬踹碎木门，用灵压逼迫沈烬交出昨夜女修下落。", ACCENT_EMERALD, "✓ 对应正文 第1~4段"),
        ("Beat 02 · 焊枪除草（当前焦点）", "韩执事拔刀劈向柜台，退步时踩中院角改装除草机，因果律刀片瞬秒其筑基义体。", ACCENT_INDIGO, "● 正在精修 第5~8段"),
        ("Beat 03 · 迪化骇逃（待续写）", "苏清寒暗中窥见韩执事一招败北，彻底确信沈烬是九劫剑仙；章末抛出黑市拍卖钩子。", ACCENT_AMBER, "▶ 一键扩写本节拍"),
    ]
    by = 458
    for btitle, bdesc, bcol, bbtn in beats:
        draw_card(draw, (254, by, 602, by + 132), fill=BG_INPUT, outline=bcol, radius=10, width=2 if bcol == ACCENT_INDIGO else 1)
        draw.text((268, by + 10), btitle, font=get_font(13, bold=True), fill=bcol)
        draw_wrapped(draw, 268, by + 36, bdesc, get_font(12), TXT_SUB, 318, line_gap=4, max_lines=3)
        draw_badge(draw, 268, by + 98, bbtn, fg=bcol, font_size=11, pad_x=10, pad_y=3)
        by += 144

    # Context Transparency Card
    draw_card(draw, (254, 898, 602, 1044), fill=BG_INPUT, outline=ACCENT_CYAN, radius=10)
    draw.text((268, 910), "★ 本次发送 AI 上下文透明清单 (4,820 Tokens)", font=get_font(12, bold=True), fill=ACCENT_CYAN)
    ctx_items = [
        "[✓] 创作宪章：3条核心铁律 + 严禁现代网络烂梗",
        "[✓] 在场角色：沈烬(盲眼/冷淡)、韩执事(筑基初期/狂妄)",
        "[✓] 挂载文风DNA：《冷硬派废土白描·短句快刀》",
        "[✓] 前情锚点：第1章摘要 + 上一拍末尾 400 字",
    ]
    cy = 936
    for ci in ctx_items:
        draw.text((268, cy), ci, font=get_font(11), fill=TXT_SUB)
        cy += 24

    # Center Column: 沉浸式正文编辑器 + 选中浮动改写 + Diff 对比 (x=636..1370, y=126..1060)
    draw_card(draw, (636, 126, 1370, 1060), fill=(17, 21, 34), outline=BORDER_SUBTLE)
    draw.text((666, 144), "第二章  你管这台除草机叫诛仙剑阵？", font=get_font(20, bold=True), fill=TXT_MAIN)
    draw.text((666, 174), "实时保稿已同步 (Revision #18)  ·  字数：2,180 字  ·  视角：第三人称有限 (沈烬)", font=get_font(12), fill=TXT_MUTED)
    draw.line((656, 200, 1350, 200), fill=BORDER_SUBTLE, width=1)

    p1 = "　　风雪顺着破碎的门板灌进维修铺，煤油灯的火苗猛地矮了一截。韩执事靴底的合金马刺踩在满地铁屑上，发出刺耳的咯吱声。他居高临下地瞥了一眼柜台后摸索着扳手的瞎眼少年，左眼义体的红外扫描框在沈烬身上定格——灵力波动为零，纯正的废土凡人。"
    p2 = "　　“小瞎子，昨夜有柄断剑掉进你这条街。”韩执事五指按在腰间高频震荡刀柄上，筑基修士的威压毫无保留地倾泻而出，震得货架上的齿轮嗡嗡作响，“不想被拆成生物电池，就把人交出来。”"

    draw_wrapped(draw, 668, 220, p1, get_font(15), TXT_MAIN, 660, line_gap=10)
    draw_wrapped(draw, 668, 340, p2, get_font(15), TXT_MAIN, 660, line_gap=10)

    # Selected Block with AI Floating Toolbar & Inline Diff
    draw_card(draw, (658, 462, 1348, 825), fill=BG_CARD_ALT, outline=ACCENT_INDIGO, radius=12, width=2)

    # Floating AI Toolbar
    draw_card(draw, (674, 474, 1332, 520), fill=BG_INPUT, outline=ACCENT_VIOLET, radius=8, width=1)
    tools = [
        ("★ 朱雀去AI味", ACCENT_ROSE),
        ("◆ 仿写：冷硬白描DNA", ACCENT_VIOLET),
        ("▶ 动作分镜扩写", ACCENT_CYAN),
        ("● 潜台词强化", ACCENT_EMERALD),
    ]
    tx = 686
    for tlabel, tcol in tools:
        draw_badge(draw, tx, 483, tlabel, fg=tcol, font_size=12, pad_x=10, pad_y=4)
        tx += 160

    # Before (Original AI-ish paragraph)
    draw_card(draw, (674, 534, 1332, 628), fill=tint(ACCENT_ROSE, BG_INPUT, 0.16), outline=ACCENT_ROSE, radius=8)
    draw_badge(draw, 686, 542, "原段落 (检测到 3 处典型 AI 套话)", fg=ACCENT_ROSE, font_size=11, pad_x=8, pad_y=2)
    old_p = "　　[-沈烬嘴角勾起一抹冰冷的弧度，眼中闪过一丝不易察觉的精芒。空气中弥漫着令人窒息的肃杀之气，韩执事不禁倒吸一口凉气，只见那台除草机宛如远古凶兽般瞬间发动！-]"
    draw_wrapped(draw, 686, 570, old_p, get_font(13), (253, 186, 196), 628, line_gap=6)

    # After (Polished Imitation + De-AI paragraph)
    draw_card(draw, (674, 640, 1332, 766), fill=tint(ACCENT_EMERALD, BG_INPUT, 0.16), outline=ACCENT_EMERALD, radius=8, width=2)
    draw_badge(draw, 686, 648, "✓ 仿写 + 去AI味后新段落（已消除套话 · 动作质感 +34%）", fg=ACCENT_EMERALD, font_size=11, pad_x=8, pad_y=2)
    new_p = "　　[+沈烬没抬头，粗糙的拇指只是将扳手往死里拧了半圈。“退一步，别踩我刚焊好的弹簧。”韩执事狞笑着踏碎木槛，脚踝却猛地勾断一根绷紧的铜丝。角落里那台锈迹斑斑的除草机骤然咬合齿轮，三片涂着废机油的扇叶切开风雪，连带着韩执事半边钛合金肩胛骨，齐根削飞出去！+]"
    draw_wrapped(draw, 686, 676, new_p, get_font(14, bold=True), (209, 250, 229), 628, line_gap=6)

    draw_badge(draw, 1035, 778, "✓ 采纳替换本段 (Enter)", fg=TXT_MAIN, bg= tint(ACCENT_EMERALD, BG_CARD, 0.45), font_size=12, pad_x=14, pad_y=5)
    draw_badge(draw, 1225, 778, "✕ 保留原段 (Esc)", fg=TXT_SUB, bg=BG_INPUT, font_size=12, pad_x=12, pad_y=5)

    p4 = "　　断口平滑如镜，连一滴血都没来得及溅出，筑基灵枢的冷却液便在雪地里滋滋冒起白烟。韩执事僵在原地，直到半截肩膀哐当砸在铁砧上，凄厉的惨叫才撞碎了整条夜街的寂静。"
    draw_wrapped(draw, 668, 845, p4, get_font(15), TXT_MAIN, 660, line_gap=10)

    # Right Column: 三维虚拟读者试读间 + 定稿归档 (x=1386..1896, y=126..1060)
    draw_card(draw, (1386, 126, 1896, 1060), fill=BG_CARD, outline=BORDER_SUBTLE)
    draw.text((1406, 144), "03 · 三维虚拟读者试读间 & 审稿雷达", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 1735, 142, "无强制阻断门禁", fg=ACCENT_CYAN, font_size=11)

    readers = [
        ("★ 爽点小白读者", "爽感指数 94/100", ACCENT_AMBER,
         "“爽翻了！前面韩执事装逼蓄力拉得够满，除草机一刀秒筑基完全不墨迹！瞎子主角那句‘别踩我弹簧’逼格炸裂，快写下一章全城大佬来跪拜！”"),
        ("◆ 逻辑考据老书虫", "严密度 89/100 · 1条提醒", ACCENT_CYAN,
         "“除草机破防筑基义体符合第1章埋下的【万物焊装附带因果词条】设定。但注意：韩执事左眼有红外录像，他逃跑后天机集团为什么没立刻锁定沈烬样貌？建议补一句剑气余波震碎了他的义眼镜头。”"),
        ("♥ 情绪与人设 CP 党", "人设贴合 96/100", ACCENT_VIOLET,
         "“沈烬关心满地机油胜过关心强敌的冷淡劲儿太对味了！暗处偷看的苏清寒肯定又要疯狂脑补前辈高深莫测了，迪化反差感满分！”"),
    ]
    ry = 184
    for rrole, rscore, rcol, rcomment in readers:
        draw_card(draw, (1404, ry, 1878, ry + 148), fill=BG_INPUT, outline=rcol, radius=10, width=1)
        draw.text((1420, ry + 10), rrole, font=get_font(13, bold=True), fill=rcol)
        draw_badge(draw, 1680, ry + 8, rscore, fg=rcol, font_size=11, pad_x=8, pad_y=2)
        draw_wrapped(draw, 1420, ry + 38, rcomment, get_font(12), TXT_SUB, 442, line_gap=4, max_lines=4)
        if "建议补一句" in rcomment:
            draw_badge(draw, 1420, ry + 114, "▶ 一键定位第8段并补写『震碎义眼镜头』细节", fg=ACCENT_CYAN, font_size=11, pad_x=10, pad_y=3)
        ry += 158

    # One-Click Memory Archive Drawer
    draw_card(draw, (1404, 670, 1878, 1044), fill=BG_CARD_ALT, outline=ACCENT_EMERALD, radius=12, width=2)
    draw.text((1420, 686), "04 · 定稿记忆一键归档抽屉（防幻觉污染）", font=get_font(15, bold=True), fill=TXT_MAIN)
    draw.text((1420, 710), "绑定 Revision #18 · 重定稿时自动替换旧快照 (superseded)", font=get_font(11), fill=ACCENT_EMERALD)

    mem_items = [
        ("[✓] 客观事件 narrative_claim", "韩执事夜闯锈铁铺被改装除草机斩断右肩，狼狈逃离。", ACCENT_EMERALD),
        ("[✓] 角色状态更新 @antagonist", "韩执事：身体状态 -> 右肩义体损毁；心理 -> 惊惧。", ACCENT_CYAN),
        ("[✓] 角色认知 character_belief", "苏清寒 & 韩执事【误以为】沈烬是隐世九劫剑仙（非客观事实，防穿帮）。", ACCENT_VIOLET),
        ("[✓] 伏笔推进 foreshadow", "【太微垣巡检】线索推进（埋于第1章，计划第15章回收）。", ACCENT_AMBER),
    ]
    my = 738
    for mtag, mdesc, mcol in mem_items:
        draw_card(draw, (1420, my, 1862, my + 56), fill=BG_INPUT, outline=BORDER_SUBTLE, radius=8)
        draw.text((1432, my + 6), mtag, font=get_font(11, bold=True), fill=mcol)
        draw.text((1432, my + 28), mdesc[:34] + ("…" if len(mdesc) > 34 else ""), font=get_font(11), fill=TXT_SUB)
        my += 62

    draw.rounded_rectangle((1420, 992, 1862, 1032), radius=8, fill=ACCENT_EMERALD)
    draw.text((1515, 1002), "✓ 确认定稿并一键归档以上 4 条记忆", font=get_font(13, bold=True), fill=BG_BASE)

    out_path = os.path.join(OUT_DIR, "02-three-column-writing-and-imitation.png")
    img.save(out_path, quality=95)
    print("Saved:", out_path)


# ==============================================================================
# IMAGE 3: 立体角色工坊（六维雷达+试戏舱） + 双层动态人物关系画布
# ==============================================================================
def build_image_3():
    img = create_base_canvas()
    draw = ImageDraw.Draw(img)
    draw_app_shell(draw, active_nav=3, active_spine=2)

    # Left Half: 立体角色卡 + 六维雷达 + 角色试戏舱 (x=236..1040, y=126..1060)
    draw_card(draw, (236, 126, 1040, 1060), fill=BG_CARD, outline=BORDER_SUBTLE)
    draw.text((258, 144), "01 · 立体角色工坊（8维档案与对话试戏舱）", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 635, 142, "🎲 AI 避坑起名器", fg=ACCENT_CYAN, font_size=12)
    draw_badge(draw, 795, 142, "✦ AI 补全空字段(幂等)", fg=ACCENT_VIOLET, font_size=12)

    # Character Header Card
    draw_card(draw, (256, 184, 1020, 292), fill=BG_CARD_ALT, outline=ACCENT_INDIGO, radius=12, width=1)
    draw.ellipse((274, 200, 346, 272), fill=tint(ACCENT_INDIGO, BG_CARD, 0.35), outline=ACCENT_INDIGO, width=2)
    draw.text((293, 222), "沈烬", font=get_font(18, bold=True), fill=TXT_MAIN)

    draw.text((366, 196), "沈烬 (Shen Jin)  ·  @protagonist 核心主角", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 710, 194, "表面：盲眼底层焊工", fg=TXT_SUB, bg=BG_INPUT, font_size=11)
    draw_badge(draw, 862, 194, "底牌：旧纪元神匠宿主", fg=ACCENT_AMBER, font_size=11)
    draw.text((366, 226), "辨识度特征：灰麻布护目绷带、右手食指常年沾着蓝色灵枢焊锡、说话前习惯先敲两下扳手听回音。", font=get_font(12), fill=TXT_SUB)

    draw.text((366, 256), "⏱ 历史时点状态快照：", font=get_font(12, bold=True), fill=ACCENT_CYAN)
    snaps = ["第1章: 凡人/盲眼", "第5章: 解锁天工图谱(当前)", "第18章: 重铸青铜灵眸"]
    sx = 510
    for idx, st in enumerate(snaps):
        act = (idx == 1)
        draw_badge(draw, sx, 252, st, fg=ACCENT_CYAN if act else TXT_MUTED, bg=tint(ACCENT_CYAN, BG_INPUT, 0.25) if act else BG_INPUT, font_size=11, pad_x=8, pad_y=2)
        sx += 168

    # 6-Axis Radar Chart & 8-Dim Attributes
    draw_card(draw, (256, 306, 570, 620), fill=BG_INPUT, outline=BORDER_SUBTLE, radius=12)
    draw.text((274, 320), "六维人设与能力雷达", font=get_font(14, bold=True), fill=TXT_MAIN)
    cx, cy, r = 413, 475, 102
    axes = [("执行力 92", 0.92), ("执念度 96", 0.96), ("心性壁垒 95", 0.95), ("外貌辨识 88", 0.88), ("言辞张力 86", 0.86), ("锻造神通 98", 0.98)]
    for scale in [0.35, 0.7, 1.0]:
        ring = []
        for i in range(6):
            ang = -math.pi / 2 + i * 2 * math.pi / 6
            ring.append((cx + math.cos(ang) * r * scale, cy + math.sin(ang) * r * scale))
        draw.polygon(ring, outline=BORDER_SUBTLE)
    poly = []
    for i, (alabel, aval) in enumerate(axes):
        ang = -math.pi / 2 + i * 2 * math.pi / 6
        draw.line((cx, cy, cx + math.cos(ang) * r, cy + math.sin(ang) * r), fill=BORDER_SUBTLE, width=1)
        px = cx + math.cos(ang) * r * aval
        py = cy + math.sin(ang) * r * aval
        poly.append((px, py))
        lx = cx + math.cos(ang) * (r + 34) - 28
        ly = cy + math.sin(ang) * (r + 22) - 8
        draw.text((lx, ly), alabel, font=get_font(11, bold=True), fill=ACCENT_CYAN)
    draw.polygon(poly, fill=tint(ACCENT_INDIGO, BG_INPUT, 0.42), outline=ACCENT_INDIGO)
    for px, py in poly:
        draw.ellipse((px - 4, py - 4, px + 4, py + 4), fill=ACCENT_CYAN)

    draw_card(draw, (584, 306, 1020, 620), fill=BG_INPUT, outline=BORDER_SUBTLE, radius=12)
    fields = [
        ("核心动机 & 渴望", "攒够三万联邦信用点替妹妹沈小鱼换掉劣质人工肺；守住师父留下的老维修铺。"),
        ("性格盲区 & 致命弱点", "严重缺乏修仙界常识（把所有仙器当农具/家电修）；一旦妹妹受威胁会彻底放弃苟道。"),
        ("说话风格 & 口头禅", "短句、冷幽默、满口钳工黑话。口头禅：“这玩意儿焊死就行，讲究那么多干嘛？”"),
        ("当前认知边界 (防穿帮)", "【已知】苏清寒欠他50信用点；【未知】自己的除草机已登上联邦天道通缉榜第1名。"),
    ]
    fy = 320
    for ftitle, fval in fields:
        draw.text((602, fy), "◈ " + ftitle, font=get_font(12, bold=True), fill=ACCENT_VIOLET)
        draw_wrapped(draw, 602, fy + 22, fval, get_font(11), TXT_SUB, 400, line_gap=3, max_lines=2)
        fy += 74

    # Character Audition Theater (角色对话试戏舱)
    draw_card(draw, (256, 636, 1020, 1042), fill=BG_CARD_ALT, outline=ACCENT_VIOLET, radius=12, width=2)
    draw.text((276, 652), "02 · 角色对话试戏舱（小剧场 · 写正文前先找准人物腔调，好台词一键复制）", font=get_font(14, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 845, 650, "已锁定第5章认知边界", fg=ACCENT_EMERALD, font_size=11)

    draw_card(draw, (276, 692, 1000, 748), fill=BG_INPUT, outline=BORDER_SUBTLE, radius=10)
    draw.text((292, 700), "【作者设定试戏情境】 圣女苏清寒双手捧着十万极品灵石跪在铺门外，求你收她为记名剑侍。", font=get_font(12, bold=True), fill=ACCENT_AMBER)
    draw.text((292, 722), "测试目标：验证沈烬会不会突然说出仙侠腔套话（防 OOC）", font=get_font(11), fill=TXT_MUTED)

    draw_card(draw, (276, 760, 1000, 868), fill=tint(ACCENT_INDIGO, BG_INPUT, 0.22), outline=ACCENT_INDIGO, radius=10)
    draw.text((292, 768), "【沈烬 · 试戏回应】（贴合钳工黑话 + 盲眼听声细节）", font=get_font(12, bold=True), fill=ACCENT_CYAN)
    reply1 = "沈烬隔着门槛听见那堆石头硌得木板嘎吱响，眉头拧紧，拿铁钳敲了敲门框：“姑娘，我这儿是正规维修铺，不收矿石抵账。你要真闲得慌，把门口那筐生锈的螺母按螺纹顺一遍——管晚饭，没工钱。”"
    draw_wrapped(draw, 292, 794, reply1, get_font(12), TXT_MAIN, 690, line_gap=4)
    draw_badge(draw, 825, 834, "✓ 复制台词进当前章", fg=ACCENT_EMERALD, font_size=11, pad_x=8, pad_y=2)

    draw_card(draw, (276, 880, 1000, 978), fill=tint(ACCENT_VIOLET, BG_INPUT, 0.20), outline=ACCENT_VIOLET, radius=10)
    draw.text((292, 888), "【苏清寒 · 同场对手戏联动】（贴合脑补迪化人设）", font=get_font(12, bold=True), fill=ACCENT_VIOLET)
    reply2 = "苏清寒娇躯剧震，凝视着那筐杂乱螺母上残留的电弧余温，呼吸瞬间急促：“螺母分阴阳，螺纹演周天……前辈竟是要我借凡铁参悟太虚剑道总纲！清寒领旨！”"
    draw_wrapped(draw, 292, 914, reply2, get_font(12), TXT_MAIN, 690, line_gap=4)

    draw.rounded_rectangle((276, 990, 880, 1028), radius=8, fill=BG_INPUT, outline=BORDER_SUBTLE)
    draw.text((292, 1000), "继续输入试戏情境，例如：如果赵无极拿妹妹威胁他，他会怎么翻脸？...", font=get_font(12), fill=TXT_MUTED)
    draw.rounded_rectangle((892, 990, 1000, 1028), radius=8, fill=ACCENT_VIOLET)
    draw.text((918, 1000), "▶ 开演", font=get_font(13, bold=True), fill=TXT_MAIN)

    # Right Half: 动态人物关系画布（表面 vs 底牌双层关系 + 拖拽连线） (x=1056..1896, y=126..1060)
    draw_card(draw, (1056, 126, 1896, 1060), fill=BG_CARD, outline=BORDER_SUBTLE)
    draw.text((1078, 144), "03 · 动态人物关系画布（表面关系 vs 隐藏底牌）", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 1500, 142, "✦ 扫描正文自动推断关系", fg=ACCENT_CYAN, font_size=12)
    draw_badge(draw, 1710, 142, "拖拽边缘直接连线", fg=ACCENT_EMERALD, font_size=12)

    canvas_box = (1076, 184, 1876, 900)
    draw.rounded_rectangle(canvas_box, radius=12, fill=BG_BASE, outline=BORDER_SUBTLE)

    for gx in range(1100, 1860, 40):
        for gy in range(210, 890, 40):
            draw.point((gx, gy), fill=BORDER_SUBTLE)

    # Spread nodes nicely so edge labels never overlap nodes
    nodes = {
        "taiwei": (1476, 235, "太微垣主脑", "轨道天道AI (终极BOSS)", ACCENT_VIOLET),
        "su":     (1190, 390, "苏清寒 (女主)", "太虚剑宗圣女", ACCENT_CYAN),
        "zhao":   (1760, 390, "赵无极 (反派)", "天机集团巡察使", ACCENT_ROSE),
        "shen":   (1476, 565, "沈烬 (主角)", "盲眼焊工 / 天工宿主", ACCENT_INDIGO),
        "yu":     (1190, 790, "沈小鱼 (妹妹)", "人工肺感染者", ACCENT_EMERALD),
        "master": (1760, 790, "老瘸子 (师父)", "失踪的旧纪元大匠", ACCENT_AMBER),
    }

    edges = [
        ("shen", "su",     "表面：债主与欠债房客", "底牌：被脑补成九劫剑仙师祖", ACCENT_CYAN,    (1310, 485)),
        ("shen", "zhao",   "表面：素未谋面",       "死敌：第2章削断其麾下执事", ACCENT_ROSE,    (1640, 485)),
        ("shen", "yu",     "相依为命的兄妹",       "底牌：小鱼体内藏有初代火种", ACCENT_EMERALD, (1310, 690)),
        ("shen", "master", "表面：收养授艺之恩",   "底牌：借沈烬之手重焊天道",   ACCENT_AMBER,   (1640, 690)),
        ("su", "taiwei",   "表面：虔诚叩拜仙界",   "真相：太微垣正是弑师真凶",   ACCENT_VIOLET,  (1310, 295)),
        ("zhao", "taiwei", "从属：天道算力代理人", "底牌：随时可被抹杀的弃子",   ACCENT_ROSE,    (1640, 295)),
    ]

    for n1, n2, surf, hid, ecol, (mx, my) in edges:
        x1, y1, _, _, _ = nodes[n1]
        x2, y2, _, _, _ = nodes[n2]
        draw.line((x1, y1, mx, my), fill=ecol, width=2)
        draw.line((mx, my, x2, y2), fill=ecol, width=2)

    # Draw Node Cards first
    for k, (nx, ny, ntitle, nsub, ncol) in nodes.items():
        draw_card(draw, (nx - 95, ny - 36, nx + 95, ny + 36), fill=BG_CARD_ALT, outline=ncol, radius=12, width=2)
        draw.ellipse((nx - 82, ny - 8, nx - 66, ny + 8), fill=ncol)
        draw.text((nx - 56, ny - 22), ntitle, font=get_font(13, bold=True), fill=TXT_MAIN)
        draw.text((nx - 56, ny + 2), nsub, font=get_font(11), fill=TXT_SUB)

    # Draw Edge Labels on top with clean position
    for n1, n2, surf, hid, ecol, (mx, my) in edges:
        draw_card(draw, (mx - 102, my - 24, mx + 102, my + 24), fill=BG_INPUT, outline=ecol, radius=8)
        draw.text((mx - 92, my - 19), surf, font=get_font(11, bold=True), fill=TXT_MAIN)
        draw.text((mx - 92, my + 2), "★ " + hid, font=get_font(10), fill=ecol)

    # Bottom AI Relation Inference Proposal Bar
    draw_card(draw, (1076, 914, 1876, 1042), fill=BG_INPUT, outline=ACCENT_CYAN, radius=10)
    draw.text((1094, 924), "✦ AI 从第 2~3 章正文新推断出 2 条待确认关系：", font=get_font(13, bold=True), fill=ACCENT_CYAN)
    draw_badge(draw, 1094, 956, "+ [黑市魁首·鬼算子] ──(单向敬畏/试探)──> [沈烬]  (出处: 第3章第4段)   [✓ 采纳上画布]", fg=ACCENT_EMERALD, font_size=12, pad_x=10, pad_y=4)
    draw_badge(draw, 1094, 996, "+ [苏清寒] ──(敌对追查)──> [赵无极]  (出处: 第2章末尾)   [✓ 采纳上画布]", fg=ACCENT_CYAN, font_size=12, pad_x=10, pad_y=4)

    out_path = os.path.join(OUT_DIR, "03-character-studio-and-relationship-canvas.png")
    img.save(out_path, quality=95)
    print("Saved:", out_path)


# ==============================================================================
# IMAGE 4: 全书记忆星图 + 章节×实体出场热力矩阵 + 伏笔全周期雷达
# ==============================================================================
def build_image_4():
    img = create_base_canvas()
    draw = ImageDraw.Draw(img)
    draw_app_shell(draw, active_nav=4, active_spine=4)

    # Top Left: 全书星海关联脑图 (x=236..1080, y=126..610)
    draw_card(draw, (236, 126, 1080, 610), fill=BG_CARD, outline=BORDER_SUBTLE)
    draw.text((256, 142), "01 · 全书记忆星海脑图（点击节点反查全部正文引文与因果链）", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 835, 140, "当前聚焦：青铜古玉 (物品)", fg=ACCENT_VIOLET, font_size=11)

    star_box = (254, 180, 1062, 592)
    draw.rounded_rectangle(star_box, radius=10, fill=BG_BASE, outline=BORDER_SUBTLE)

    cx, cy = 650, 385
    s_nodes = [
        (410, 260, "沈烬 (主角)", ACCENT_INDIGO, "第3章摸索古玉开启图谱"),
        (890, 250, "苏清寒 (圣女)", ACCENT_CYAN, "第3章留古玉抵50信用点修剑费"),
        (390, 500, "老瘸子 (失踪师父)", ACCENT_AMBER, "十年前曾铸造古玉内芯"),
        (900, 505, "[伏笔] 太微垣坐标", ACCENT_ROSE, "古玉夹层藏有轨道主脑后门密钥"),
        (650, 215, "锈铁街维修铺 (地点)", ACCENT_EMERALD, "古玉当前存放位置"),
    ]
    for nx, ny, nlabel, ncol, elabel in s_nodes:
        draw.line((cx, cy, nx, ny), fill=ncol, width=2)
        mx, my = (cx + nx) // 2, (cy + ny) // 2
        draw.text((mx - 65, my - 10), elabel, font=get_font(11), fill=TXT_SUB)
        draw_card(draw, (nx - 92, ny - 24, nx + 92, ny + 24), fill=BG_CARD_ALT, outline=ncol, radius=18, width=2)
        draw.text((nx - 76, ny - 10), nlabel, font=get_font(12, bold=True), fill=TXT_MAIN)

    draw.ellipse((cx - 58, cy - 58, cx + 58, cy + 58), fill=tint(ACCENT_VIOLET, BG_BASE, 0.38), outline=ACCENT_VIOLET, width=3)
    draw.text((cx - 42, cy - 18), "◆ 青铜古玉", font=get_font(14, bold=True), fill=TXT_MAIN)
    draw.text((cx - 36, cy + 6), "共出场 8 次", font=get_font(11), fill=ACCENT_CYAN)

    # Bottom Left: 章节 × 实体出场热力矩阵 (x=236..1080, y=626..1060)
    draw_card(draw, (236, 626, 1080, 1060), fill=BG_CARD, outline=ACCENT_INDIGO, width=2)
    draw.text((256, 642), "02 · 章节 × 实体出场热力矩阵（3秒抓出掉线配角与遗忘道具）", font=get_font(16, bold=True), fill=TXT_MAIN)
    draw_badge(draw, 835, 640, "● 登场  ○ 提及  · 未出现", fg=ACCENT_CYAN, font_size=11)

    mx0, my0 = 430, 684
    for c in range(1, 17):
        draw.text((mx0 + (c - 1) * 28, my0), f"{c:02d}", font=get_font(11, mono=True), fill=TXT_MUTED)
    draw.text((888, my0), "长篇控盘诊断", font=get_font(12, bold=True), fill=TXT_MAIN)

    matrix_rows = [
        ("沈烬 (主角)",       [2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2], "✓ 全勤主视角", ACCENT_EMERALD),
        ("苏清寒 (女主)",     [2,2,2,1,2,2,0,2,2,1,2,2,2,2,2,2], "✓ 活跃核心羁绊", ACCENT_EMERALD),
        ("沈小鱼 (妹妹)",     [2,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0], "！已连续掉线 14 章", ACCENT_ROSE),
        ("赵无极 (首卷BOSS)", [0,1,2,2,0,1,2,2,0,0,2,2,1,2,2,2], "✓ 压迫感持续在线", ACCENT_CYAN),
        ("青铜古玉 (道具)",   [2,0,2,0,0,1,0,0,2,0,0,0,0,1,2,0], "✓ 线索周期正常", ACCENT_VIOLET),
        ("除草机 (仙器)",     [0,2,2,1,0,0,2,0,0,0,0,2,0,0,0,2], "✓ 阶段性爽点返场", ACCENT_AMBER),
    ]
    ry = 714
    for rname, cells, diag, dcol in matrix_rows:
        is_warn = ("掉线" in diag)
        row_bg = tint(ACCENT_ROSE, BG_INPUT, 0.22) if is_warn else BG_INPUT
        draw.rounded_rectangle((254, ry - 4, 1062, ry + 36), radius=6, fill=row_bg, outline=ACCENT_ROSE if is_warn else BORDER_SUBTLE, width=1)
        draw.text((266, ry + 5), rname, font=get_font(13, bold=True), fill=TXT_MAIN)
        for idx, val in enumerate(cells):
            cx_dot = mx0 + idx * 28 + 8
            cy_dot = ry + 15
            if val == 2:
                draw.ellipse((cx_dot - 7, cy_dot - 7, cx_dot + 7, cy_dot + 7), fill=ACCENT_INDIGO)
            elif val == 1:
                draw.ellipse((cx_dot - 6, cy_dot - 6, cx_dot + 6, cy_dot + 6), outline=ACCENT_CYAN, width=2)
            else:
                draw.ellipse((cx_dot - 2, cy_dot - 2, cx_dot + 2, cy_dot + 2), fill=(60, 72, 105))
        draw.text((888, ry + 5), diag, font=get_font(12, bold=True), fill=dcol)
        ry += 48

    draw_badge(draw, 256, 1014, "★ 矩阵诊断建议：【沈小鱼】作为主角赚钱的核心动机，已14章未露面，建议在第17章插入『病情复发或来信』节拍。", fg=ACCENT_AMBER, font_size=11, pad_x=10, pad_y=4)

    # Right Half: 伏笔全生命周期追踪雷达 + 记忆体检中心 (x=1096..1896, y=126..1060)
    draw_card(draw, (1096, 126, 1896, 1060), fill=BG_CARD, outline=BORDER_SUBTLE)
    draw.text((1118, 142), "03 · 伏笔全生命周期雷达（埋设 ➔ 推进提及 ➔ 计划回收 ➔ 实际回收证据）", font=get_font(16, bold=True), fill=TXT_MAIN)

    foreshadows = [
        ("！逾期未收", "【沈小鱼的人工肺编号 09】", ACCENT_ROSE,
         "埋设位置：第 1 章第 6 段（原文：“人工肺铭牌上刻着模糊的太微垣零号实验室徽记”）\n计划回收：第 12 章（已逾期 4 章！）\nAI 回收建议：可在第 17 章赵无极搜查医馆时引爆该线索，直接衔接第一卷高潮。"),
        ("● 推进中", "【老瘸子留下的生锈扳手】", ACCENT_AMBER,
         "埋设位置：第 1 章第 2 段  |  最近提及：第 9 章第 11 段（敲击机甲时发出龙吟）\n计划回收：第一卷末（预计第 20 章，无需该章已创建）\n当前状态：读者已知扳手不凡，但主角仍以为是普通高碳钢。"),
        ("● 推进中", "【太微垣第一道巡检神念】", ACCENT_CYAN,
         "埋设位置：第 3 章章末钩子  |  最近提及：第 14 章\n计划回收：第二卷开篇（预计第 25 章）\n当前状态：已被锈铁街古仙大阵暂时屏蔽。"),
        ("✓ 已完美回收", "【苏清寒断裂的本命飞剑】", ACCENT_EMERALD,
         "埋设位置：第 1 章第 9 段  ➔  实际回收证据：第 6 章 Revision #4 第 14 段\n回收效果：苏清寒拔剑斩碎天机集团三架浮空艇，正式确立沈烬『隐世剑仙』传闻。"),
    ]
    fy = 184
    for fstatus, ftitle, fcol, fbody in foreshadows:
        is_overdue = ("逾期" in fstatus)
        draw_card(draw, (1116, fy, 1876, fy + 150), fill=BG_INPUT, outline=fcol, radius=12, width=2 if is_overdue else 1)
        draw_badge(draw, 1132, fy + 12, fstatus, fg=fcol, font_size=11, pad_x=8, pad_y=2)
        draw.text((1235, fy + 12), ftitle, font=get_font(14, bold=True), fill=TXT_MAIN)
        if is_overdue:
            draw_badge(draw, 1685, fy + 10, "▶ 一键排入第17章细纲", fg=ACCENT_ROSE, font_size=11, pad_x=10, pad_y=3)
        draw_wrapped(draw, 1132, fy + 44, fbody, get_font(12), TXT_SUB, 725, line_gap=5, max_lines=4)
        fy += 164

    # Memory Health Check Box at Bottom Right
    draw_card(draw, (1116, 848, 1876, 1042), fill=BG_CARD_ALT, outline=ACCENT_CYAN, radius=12)
    draw.text((1134, 862), "04 · 全书记忆体检 & 知识库冲突裁决中心", font=get_font(15, bold=True), fill=TXT_MAIN)
    checks = [
        ("✓ 章节分层摘要覆盖：16 / 16 章（含 1 份卷级浓缩摘要，单次生成上下文严格控制在 6.5k Tokens 内）", ACCENT_EMERALD),
        ("✓ 重定稿版本清洁度：已自动清理 3 份旧版章节快照 (superseded)，零重复脏记忆", ACCENT_EMERALD),
        ("！待作者裁决冲突 (1项)：第4章写『锈铁街距主城三百里』，第15章写『八百里』  [点此一键统一为三百里]", ACCENT_AMBER),
    ]
    cy = 898
    for ctext, ccol in checks:
        draw.text((1134, cy), ctext, font=get_font(12, bold=("待作者" in ctext)), fill=ccol)
        cy += 38

    out_path = os.path.join(OUT_DIR, "04-memory-galaxy-matrix-and-foreshadow-radar.png")
    img.save(out_path, quality=95)
    print("Saved:", out_path)


if __name__ == "__main__":
    build_image_1()
    build_image_2()
    build_image_3()
    build_image_4()
