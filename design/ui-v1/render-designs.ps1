param([string]$OutputDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$C = @{
    bg='#F3EFE6'; paper='#FFFDF8'; panel='#F8F5EE'; ink='#292720'; muted='#706B61'
    faint='#A29A8C'; line='#DDD7CB'; terra='#9A4636'; soft='#F1E1D7'; blue='#446773'
    blueSoft='#E8EEF0'; green='#54634D'; greenSoft='#E9EDE3'; yellow='#F2EAD7'; dark='#2C302D'
}
$script:overflows = [System.Collections.Generic.List[string]]::new()
function Color($name) {
    if ($C.ContainsKey($name)) { return [Drawing.ColorTranslator]::FromHtml($C[$name]) }
    return [Drawing.ColorTranslator]::FromHtml($name)
}
function Box($x,$y,$w,$h,$fill,$stroke='',$radius=0) {
    $p=[Drawing.Drawing2D.GraphicsPath]::new()
    if ($radius -gt 0) {
        $d=$radius*2
        $p.AddArc($x,$y,$d,$d,180,90); $p.AddArc(($x+$w-$d),$y,$d,$d,270,90)
        $p.AddArc(($x+$w-$d),($y+$h-$d),$d,$d,0,90); $p.AddArc($x,($y+$h-$d),$d,$d,90,90)
        $p.CloseFigure()
    } else { $p.AddRectangle([Drawing.RectangleF]::new($x,$y,$w,$h)) }
    if ($fill) { $b=[Drawing.SolidBrush]::new((Color $fill)); $script:g.FillPath($b,$p); $b.Dispose() }
    if ($stroke) { $pen=[Drawing.Pen]::new((Color $stroke),1); $script:g.DrawPath($pen,$p); $pen.Dispose() }
    $p.Dispose()
}
function L($x1,$y1,$x2,$y2,$color='line',$width=1,$dash=$false) {
    $pen=[Drawing.Pen]::new((Color $color),$width)
    if ($dash) { $pen.DashPattern=@(4,4) }
    $script:g.DrawLine($pen,[single]$x1,[single]$y1,[single]$x2,[single]$y2); $pen.Dispose()
}
function Curve($x1,$y1,$x2,$y2,$color='blue',$width=1.3,$dash=$false) {
    $pen=[Drawing.Pen]::new((Color $color),$width)
    if($dash) { $pen.DashPattern=@(4,4) }
    $dx=[Math]::Max(45,[Math]::Abs($x2-$x1)*0.45)
    $script:g.DrawBezier($pen,[single]$x1,[single]$y1,[single]($x1+$dx),[single]$y1,[single]($x2-$dx),[single]$y2,[single]$x2,[single]$y2)
    $pen.Dispose()
}
function T($text,$x,$y,$w,$h,$size=16,$color='ink',$bold=$false,$serif=$false,$align='Near') {
    $text=([string]$text).Replace('\n',"`n")
    $family=if($serif){'SimSun'}else{'Microsoft YaHei'}
    $style=if($bold){[Drawing.FontStyle]::Bold}else{[Drawing.FontStyle]::Regular}
    $f=[Drawing.Font]::new($family,[single]$size,$style,[Drawing.GraphicsUnit]::Pixel)
    $b=[Drawing.SolidBrush]::new((Color $color))
    $fmt=[Drawing.StringFormat]::new(); $fmt.Alignment=[Drawing.StringAlignment]::$align
    $fmt.Trimming=[Drawing.StringTrimming]::None
    $rect=[Drawing.RectangleF]::new($x,$y,$w,$h)
    $measure=$script:g.MeasureString([string]$text,$f,[int]$w,$fmt)
    if($measure.Height -gt ($h+3)) { $script:overflows.Add(('{0}: {1} at {2},{3}, available {4}, needed {5:N1}' -f $script:current,([string]$text).Substring(0,[Math]::Min(20,([string]$text).Length)),$x,$y,$h,$measure.Height)) }
    $script:g.DrawString([string]$text,$f,$b,$rect,$fmt)
    $fmt.Dispose(); $f.Dispose(); $b.Dispose()
}
function Dot($x,$y,$color='green',$size=6) {
    $b=[Drawing.SolidBrush]::new((Color $color)); $script:g.FillEllipse($b,$x,$y,$size,$size); $b.Dispose()
}
function Button($label,$x,$y,$w,$primary=$false,$h=34) {
    if($primary){Box $x $y $w $h 'terra' '' 4; T $label $x ($y+7) $w ($h-10) 14 'paper' $true $false 'Center'}
    else {Box $x $y $w $h 'paper' 'line' 4; T $label $x ($y+7) $w ($h-10) 14 'ink' $false $false 'Center'}
}
function Label($text,$x,$y,$w=100,$color='muted') { T $text $x $y $w 22 12 $color }
function Canvas($name,$w=1600,$h=1000) {
    $script:current=$name
    $script:img=[Drawing.Bitmap]::new($w,$h)
    $script:g=[Drawing.Graphics]::FromImage($script:img)
    $script:g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $script:g.TextRenderingHint=[Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $script:g.Clear((Color 'bg'))
}
function Save($name) {
    $file=Join-Path $OutputDirectory $name
    $script:img.Save($file,[Drawing.Imaging.ImageFormat]::Png)
    $script:g.Dispose(); $script:img.Dispose()
    Write-Output ('Created ' + $name)
}
function Shell($mode,$subtitle) {
    Box 0 0 1600 64 'paper'; L 0 64 1600 64
    Box 21 19 27 27 'terra' '' 3
    L 28 25 41 39 'paper' 1.3; L 28 39 41 25 'paper' 1.3; L 28 31 41 31 'paper' 1
    T '织章' 62 17 72 34 23 'ink' $true $true
    Label 'STORYWEAVE' 139 27 121
    L 273 19 273 45
    T '潮汐档案' 295 20 125 30 18 'ink' $true
    Label '第一卷 / 退潮之前' 428 26 180
    Dot 1228 29 'green'
    T '已保存 r18' 1242 20 112 28 14 'green'
    Button '版本' 1382 16 68
    Button '导出' 1462 16 84
    Box 0 65 62 901 'panel'; L 62 65 62 966
    foreach($v in @(@('创',94),@('资',166),@('审',238))) {
        $active=$v[0] -eq '创'
        if($active){Box 12 ($v[1]-8) 38 44 'soft' '' 5}
        T $v[0] 12 $v[1] 38 29 18 $(if($active){'terra'}else{'muted'}) $active $false 'Center'
    }
    T '设' 13 908 36 25 15 'muted' $false $false 'Center'
    Box 62 65 1538 51 'panel'; L 62 116 1600 116
    T $mode 88 79 230 28 18 'ink' $true
    Label $subtitle 330 84 600
    Button '结构' 1107 73 64 ($mode -ne '书页旁注') 32
    Button '正文' 1179 73 64 ($mode -eq '书页旁注') 32
    Button '关系聚焦' 1267 73 96 $false 32
    Button '预览上下文' 1377 73 140 $false 32
    Box 0 966 1600 34 'panel'; L 0 966 1600 966
    Label 'UI 设计稿 · 原创样例 · 保存/版本/AI 均为状态示意，未连接真实服务' 22 974 1010
    Label '暖纸 / 墨色 / 赤陶' 1374 974 200
}
$scenes=@(
    @{id='01';name='甲板回声';chapter='第一章';summary='林岑听见重复钟声，查找不存在的靠港时间。';state='初稿'},
    @{id='02';name='错号证词';chapter='第一章';summary='证词编号反写为17，异常先记为待查，不作事实。';state='初稿'},
    @{id='03';name='巡堤队封锁';chapter='第二章';summary='北堤仓库被封锁；账本收走前，必须找到第17页。';state='待续'},
    @{id='04';name='仓库对证';chapter='第二章';summary='林岑质问宋遥；先重放钟声，证明两人相遇的时间。';state='当前'},
    @{id='05';name='重放失败';chapter='第三章';summary='声音无法证明影像身份；不能靠新增能力解围。';state='计划'},
    @{id='06';name='留下倒页';chapter='第三章';summary='倒读账本，反写编号指向另一套索引，伏笔回收。';state='计划'}
)
$p1='林岑把账本推到潮钟旁，纸边被盐水泡得发软。第十七页的位置留着一道新鲜的裁痕。'
$p2='“潮钟只会吐出声音，仓门外的脚步不会留下影像。”宋遥没有碰钟，只指向门槛上被雨冲淡的泥印。'
$p3='林岑收回了先前的判断。若钟声只能证明时间，那份证词就还缺一个可以被追问的人。'
function Scene($i,$x,$y,$w,$h=99,$small=$false) {
    $s=$scenes[$i]; $sel=$i -eq 3
    Box $x $y $w $h 'paper' $(if($sel){'terra'}else{'line'}) 5
    if($sel){Box $x ($y+9) 3 ($h-18) 'terra' '' 1}
    Label ($s.id+' / '+$s.chapter) ($x+14) ($y+10) ($w-80)
    Label $s.state ($x+$w-53) ($y+10) 42 $(if($sel){'terra'}else{'muted'})
    T $s.name ($x+14) ($y+32) ($w-28) 26 $(if($small){16}else{18}) 'ink' $true
    T $s.summary ($x+14) ($y+58) ($w-28) ($h-58) $(if($small){13}else{14}) 'muted'
}
function Asset($kind,$title,$detail,$x,$y,$w,$h,$tone='panel') {
    Box $x $y $w $h $tone 'line' 4
    Label $kind ($x+13) ($y+9) ($w-26) $(if($kind -eq '已确认规则'){'blue'}elseif($kind -eq '待确认想法'){'terra'}else{'muted'})
    T $title ($x+13) ($y+30) ($w-26) 28 16 'ink' $true
    if($detail){T $detail ($x+13) ($y+60) ($w-26) ($h-64) 13 'muted'}
}
function CompactAsset($kind,$title,$detail,$x,$y,$w,$h=65) {
    Box $x $y $w $h 'panel' 'line' 3
    Label $kind ($x+12) ($y+8) 80
    T $title ($x+94) ($y+8) ($w-104) 25 15 'ink' $true
    if($detail){T $detail ($x+12) ($y+36) ($w-24) ($h-39) 13 'muted'}
}
function Reader($x,$w) {
    Box $x 116 $w 850 'paper'; L $x 116 $x 966
    Label '正文联动 / 只读预览' ($x+30) 143 ($w-60)
    T '仓库对证' ($x+30) 183 ($w-60) 42 28 'ink' $true $true
    Label '第二章 · 场景 2' ($x+30) 233 ($w-60)
    L ($x+30) 272 ($x+$w-30) 272
    T $p1 ($x+32) 301 ($w-64) 100 18 'ink' $false $true
    Box ($x+22) 423 ($w-44) 143 'yellow' '' 2
    Box ($x+22) 423 3 143 'terra'
    T $p2 ($x+32) 438 ($w-64) 112 18 'ink' $false $true
    T $p3 ($x+32) 592 ($w-64) 100 18 'ink' $false $true
    Label '精确定位 · b42 · 正文 r18' ($x+30) 712 ($w-60) 'blue'
    L ($x+30) 750 ($x+$w-30) 750
    Label '已绑定的规则' ($x+30) 773 ($w-60) 'blue'
    T '只能重放声音，不能重放影像' ($x+30) 803 ($w-60) 48 17 'ink' $true
    Label '作者确认 · 2 处使用 · 非名称猜测' ($x+30) 854 ($w-60)
    Button '去写此场景  →' ($x+30) 900 ($w-60) $true 40
}

Canvas 'A'
Shell '章序经纬' '章序是骨架，人物、规则与伏笔成为侧轨证据'
Box 62 116 216 850 'panel'; L 278 116 278 966
Label '作品目录' 85 143 150
T '退潮之前' 85 178 168 33 22 'ink' $true $true
$treeY=@(261,319,430,488,599,657)
foreach($i in 0..5){
    if($i -eq 3){Box 74 ($treeY[$i]-7) 192 44 'soft' '' 4}
    Label $scenes[$i].id 88 $treeY[$i] 25
    T $scenes[$i].name 121 ($treeY[$i]-2) 135 33 15 $(if($i-eq 3){'terra'}else{'ink'}) ($i-eq 3)
}
Label '第一章 / 封存的潮钟' 84 225 184
Label '第二章 / 换页的账本' 84 394 184
Label '第三章 / 第二次铃响' 84 563 184
Button '＋ 新增章节' 85 744 169
Label '6 场景 · 3 章' 85 796 169
L 85 840 255 840
Label '上次写到' 85 863 150
T '仓库对证 · 段落 b42' 85 890 175 30 14 'ink'
Label '故事结构 / 三章范围' 310 141 300
Label '场景推进' 310 174 340 'terra'
Label '人物 / 世界 / 证据' 780 174 330 'blue'
L 684 211 684 879 'line' 2
$ys=@(227,336,477,586,727,836)
foreach($i in 0..5){Dot 681 ($ys[$i]+43) $(if($i-eq 3){'terra'}else{'faint'}) 7; L 655 ($ys[$i]+47) 682 ($ys[$i]+47) 'line'}
Curve 655 633 780 440 'blue' 1.5
Curve 655 618 780 252 'faint' 1
Curve 655 383 780 611 'terra' 1.2 $true
Curve 655 883 780 651 'terra' 1.2 $true
Box 689 523 86 24 'bg'; Label '明确使用' 695 526 76 'blue'
Box 689 419 86 24 'bg'; Label '人物参与' 695 422 76
Box 689 479 86 24 'bg'; Label '引入伏笔' 695 482 76 'terra'
Box 689 755 86 24 'bg'; Label '计划回收' 695 758 76 'terra'
foreach($i in 0..5){Scene $i 310 $ys[$i] 345 99}
Label '01 / 封存的潮钟' 310 206 330
Label '02 / 换页的账本' 310 456 330
Label '03 / 第二次铃响' 310 706 330
CompactAsset '人物' '林岑' '档案修复员 · 持有旧索引' 780 217 330 70
CompactAsset '人物' '宋遥' '守潮人 · 寻找失踪队友' 780 299 330 70
Asset '已确认规则' '潮钟的边界' '只能重放声音，不能重放影像。已绑定 2 处正文。' 780 385 330 110 'blueSoft'
CompactAsset '地点' '北堤潮钟仓库' '封锁发生地' 780 507 330 65
Asset '伏笔 / 已安排回收' '反写编号 17' '错号证词 → 留下倒页' 780 585 330 92
CompactAsset '作者待办' '第17页的交代' '核对第二章是否揭示过早' 780 690 330 65
CompactAsset '参考资料' '港务日志·第17页' '作者手录 · 非正式事实' 780 768 330 65
CompactAsset '待确认想法' '第二次铃响' '是否来自空船？不进入正式事实上下文' 780 846 330 78
Label '实线：明确关系 / 虚线：作者计划 · 拖动不改变章序' 310 938 800
Reader 1140 460
Save 'a-chapter-weave.png'

Canvas 'B'
Shell '线索群岛' '围绕故事问题组织材料，再把线索归入章序'
Label '退潮之前 / 线索板' 94 141 400
Label '自由位置不改变章节顺序' 813 141 270 'blue'
Label '01  错误的证词' 104 193 420 'terra'
L 104 221 529 221
Label '02  潮钟的限制' 602 193 470 'blue'
L 602 221 1080 221
L 975 392 975 452 'blue' 1.5
L 975 452 902 452 'blue' 1.5
Label '明确使用' 990 429 100 'blue'
Scene 0 104 241 221 123 $true
Scene 1 340 269 219 123 $true
CompactAsset '人物' '林岑' '档案修复员 · 持有旧索引' 104 381 221 70
Asset '待确认想法' '第二次铃响' '是否来自空船？暂不作为正式事实。' 250 470 309 98 'yellow'
Scene 2 602 241 226 123 $true
Scene 3 843 269 246 123 $true
Asset '已确认规则' '潮钟只能重放声音' '不能重放影像 · 已绑定正文2处' 602 408 300 100 'blueSoft'
CompactAsset '地点' '北堤潮钟仓库' '巡堤队封锁处' 775 524 314 68
Label '03  第17页的去向' 105 606 680 'terra'
L 105 636 1088 636
Scene 4 105 655 279 111 $true
Scene 5 405 655 280 111 $true
CompactAsset '人物' '宋遥' '守潮人 · 寻找失踪队友' 713 655 375 66
CompactAsset '伏笔' '反写编号17' '错号证词引入 → 留下倒页回收' 713 735 375 76
CompactAsset '作者待办' '第17页交代' '核对是否揭示过早' 105 789 279 76
CompactAsset '参考资料' '港务日志·第17页' '作者手录 · 非自动确认事实' 405 789 280 76
Box 94 899 995 43 'paper' 'line' 4
T '章序书签' 112 910 103 24 13 'muted'
T '第一章  →  第二章 · 仓库对证  →  第三章' 242 908 700 26 15 'terra' $true
Reader 1134 466
Save 'b-clue-islands.png'

Canvas 'C'
Shell '书页旁注' '把正文放在中央，结构与设定只在需要的位置出现'
Box 62 116 226 850 'panel'; L 288 116 288 966
Label '手稿 / 退潮之前' 85 142 185
T '从这里继续写' 85 179 190 32 20 'ink' $true $true
$cy=244
foreach($i in 0..5){
    if($i-eq 3){Box 75 ($cy-10) 199 101 'soft' '' 4}
    Label ($scenes[$i].chapter+' · '+$scenes[$i].id) 88 $cy 175
    T $scenes[$i].name 88 ($cy+25) 176 29 17 $(if($i-eq 3){'terra'}else{'ink'}) ($i-eq 3)
    T $scenes[$i].summary 88 ($cy+54) 176 36 12 'muted'
    $cy+=105
}
Button '＋ 下一章' 88 894 174
Box 321 145 808 785 'paper' 'line' 2
Label '第二章 / 换页的账本' 377 184 550
T '仓库对证' 377 236 690 55 38 'ink' $true $true
T '场景目标  找到证词可以被追问的人，而不是让钟声替人作证。' 377 307 687 50 15 'muted'
L 377 375 1072 375
T $p1 377 405 685 90 22 'ink' $false $true
Box 365 518 713 127 'yellow' '' 2
Box 365 518 3 127 'terra'
T $p2 377 536 685 95 22 'ink' $false $true
T $p3 377 679 685 90 22 'ink' $false $true
L 377 799 1072 799
Label 'b42 · 精确绑定 / 潮钟的边界' 377 825 490 'blue'
Label '此页是设计稿，不包含可保存的编辑器' 377 871 560
Button '查看结构  ↗' 904 859 168
Label '此场景的旁注' 1162 142 350
CompactAsset '人物' '林岑' '档案修复员 · 持有旧索引' 1162 180 404 66
CompactAsset '人物' '宋遥' '守潮人 · 寻找失踪队友' 1162 259 404 66
Asset '已确认规则 / 与高亮段绑定' '潮钟的边界' '只能重放声音，不能重放影像。2处使用；明确绑定，不是文字相似。' 1162 339 404 120 'blueSoft'
Curve 1077 577 1162 400 'blue' 1.5
CompactAsset '地点' '北堤潮钟仓库' '封锁发生地' 1162 473 404 65
CompactAsset '伏笔' '反写编号17' '错号证词 → 留下倒页' 1162 551 404 70
CompactAsset '作者待办' '第17页的交代' '第二章是否揭示过早？' 1162 635 404 65
CompactAsset '参考资料' '港务日志·第17页' '作者手录 · 非正式事实' 1162 713 404 65
CompactAsset '待确认想法' '第二次铃响' '是否来自空船？不进入正式事实上下文' 1162 791 404 77
Label 'AI 按需打开，不常驻聊天栏' 1162 904 400 'terra'
Save 'c-manuscript-margin.png'

Canvas 'D'
Shell '章节分镜' '横向看清推进、限制和回收，正文从下方展开'
$dx=@(107,603,1099)
$dt=@('01 / 封存的潮钟','02 / 换页的账本','03 / 第二次铃响')
$sub=@('发现异常，留下第一个疑问','寻找原件，建立证词的条件','计划失败，让旧线索发挥作用')
foreach($i in 0..2){
    T $dt[$i] $dx[$i] 144 440 34 22 'ink' $true $true
    Label $sub[$i] $dx[$i] 184 440
    L $dx[$i] 217 ($dx[$i]+435) 217
    Scene ($i*2) $dx[$i] 237 435 105
    L ($dx[$i]+216) 343 ($dx[$i]+216) 365 'line' 2
    Scene ($i*2+1) $dx[$i] 366 435 105
}
L 542 217 603 217 'faint' 1.2
L 1038 217 1099 217 'faint' 1.2
Label '章序' 550 225 49
Label '章序' 1046 225 49
CompactAsset '人物' '林岑' '持有旧索引，不掌握潮钟原理' 107 491 435 60
CompactAsset '伏笔' '反写编号17' '第一章引入 → 第三章回收' 107 561 435 60
CompactAsset '待确认想法' '第二次铃响' '是否来自空船？' 107 631 435 60
CompactAsset '已确认规则' '潮钟的边界' '只能重放声音，不能重放影像 · 2处使用' 603 491 435 76
CompactAsset '地点' '北堤潮钟仓库' '封锁发生地' 603 581 435 60
CompactAsset '人物' '宋遥' '守潮人 · 寻找失踪队友' 1099 491 435 60
CompactAsset '参考资料' '港务日志·第17页' '作者手录 · 非正式事实' 1099 561 435 60
CompactAsset '作者待办' '第17页的交代' '核对第二章是否揭示过早' 1099 631 435 60
Box 80 718 1480 224 'paper' 'line' 5
Label '展开正文 / 精确定位' 105 740 240 'blue'
T '仓库对证' 105 779 232 44 28 'ink' $true $true
Label '第二章 · 场景2 · b42 · r18' 105 834 240
Button '去写此场景 →' 105 884 204 $true
L 360 744 360 917
T $p1 386 743 701 54 17 'ink' $false $true
Box 377 804 722 61 'yellow' '' 2
T $p2 386 812 701 49 17 'ink' $false $true
T $p3 386 880 701 53 17 'ink' $false $true
L 1125 744 1125 917
Label '正文绑定的规则' 1152 742 370 'blue'
T '只能重放声音，不能重放影像' 1152 781 370 60 21 'ink' $true $true
T '已确认 · 2处正文使用\n坐标和章节顺序分开保存' 1152 855 370 58 14 'muted'
Save 'd-chapter-storyboard.png'

Canvas 'Mobile' 1720 1060
T '同一作品，四种窄屏落点' 46 32 1100 52 32 'ink' $true $true
T '390px 设计视口 · 不把桌面画布缩小塞进手机 · 所有内容均为静态样例' 46 97 1580 37 18 'muted'
$mx=@(46,464,882,1300)
$mn=@('A / 章序经纬','B / 线索群岛','C / 书页旁注','D / 章节分镜')
foreach($i in 0..3){
    $x=$mx[$i]
    Label $mn[$i] $x 162 360 'terra'
    Box $x 197 374 812 'paper' 'line' 12
    T '织章' ($x+21) 220 100 35 23 'ink' $true $true
    Label '潮汐档案' ($x+136) 230 200
    L ($x+18) 272 ($x+356) 272
    T $(if($i-eq 0){'场景列表'}elseif($i-eq 1){'线索主题'}elseif($i-eq 2){'仓库对证'}else{'章序与节奏'}) ($x+22) 295 330 40 23 'ink' $true
    if($i-eq 0){
        Label '第二章 / 换页的账本' ($x+22) 352 330
        Scene 2 ($x+19) 390 336 114 $true
        Scene 3 ($x+19) 524 336 114 $true
        Asset '已确认规则' '潮钟的边界' '声音可重放，影像不可重放。点开关系可看绑定正文。' ($x+19) 661 336 122 'blueSoft'
        Button '查看正文  →' ($x+21) 824 332 $true 44
    } elseif($i-eq 1){
        foreach($item in @(@('错误的证词','2场景 / 人物 / 未确认想法',371),@('潮钟的限制','2场景 / 已确认规则 / 地点',508),@('第17页的去向','2场景 / 伏笔 / 资料 / 待办',645))){
            Box ($x+20) $item[2] 334 111 'panel' 'line' 5
            T $item[0] ($x+36) ($item[2]+18) 303 32 21 'ink' $true
            T $item[1] ($x+36) ($item[2]+65) 301 30 14 'muted'
        }
        Button '关联已有场景' ($x+21) 824 332 $true 44
    } elseif($i-eq 2){
        Label '第二章 · 场景2 / b42' ($x+22) 352 330
        T $p1 ($x+24) 407 326 118 20 'ink' $false $true
        Box ($x+15) 553 344 162 'yellow' '' 2
        T $p2 ($x+24) 568 326 139 20 'ink' $false $true
        T $p3 ($x+24) 746 326 130 20 'ink' $false $true
        Label '1条规则旁注 · 精确绑定' ($x+22) 893 330 'blue'
    } else {
        $dy=367
        foreach($k in 0..2){
            Box ($x+22) $dy 330 126 $(if($k-eq 1){'soft'}else{'panel'}) 'line' 5
            T $dt[$k] ($x+37) ($dy+16) 302 31 18 'ink' $true
            T ($scenes[$k*2].name+'  →  '+$scenes[$k*2+1].name) ($x+37) ($dy+65) 302 44 16 'muted'
            $dy+=151
        }
        Button '展开当前场正文' ($x+21) 835 332 $true 44
    }
    L ($x+18) 933 ($x+356) 933
    Label '已保存 r18 · 状态示意' ($x+22) 947 327 'green'
    T '创作             资料             审阅' ($x+18) 978 340 26 15 'muted' $false $false 'Center'
}
Save 'mobile-directions.png'

Canvas 'States' 1600 1080
T '共通关键状态：先保护成果，再继续创作' 48 32 1490 60 33 'ink' $true $true
T '不因换一版布局而改变保存、授权与审阅规则。下列数字、版本和内容均为设计样例。' 48 107 1490 40 18 'muted'
Box 48 184 728 376 'paper' 'line' 8
Label '01 / 空作品' 76 212 620 'terra'
T '从一句话开始，也可以直接写。' 76 257 653 52 29 'ink' $true $true
T '标题与世界观都可以稍后再补。\n你写下的内容，不会因为没有配置 AI 而被挡住。' 76 329 647 85 18 'muted'
Button '直接写第一场' 76 464 211 $true 45
Button '导入正文' 303 464 176 $false 45
Label '示例作品只在显式选择后加载' 76 523 640
Box 808 184 744 376 'paper' 'line' 8
Label '02 / 保存结果未知' 836 212 660 'terra'
T '稿件还在，但保存结果需要核实。' 836 257 672 54 28 'ink' $true $true
Box 836 333 664 88 'yellow' '' 5
T '网络断开后没有收到回执，不能说已保存，也不能认定失败。先查询原操作，不另建一次写入。' 852 350 632 64 17 'ink'
Button '查询保存结果' 836 464 210 $true 45
Button '复制当前正文' 1062 464 207 $false 45
Label '本机草稿存在也不等于备份完成' 836 523 660
Box 48 592 728 412 'paper' 'line' 8
Label '03 / 实际输入预览' 76 620 620 'blue'
T '这一次，AI 会看到什么？' 76 666 646 48 28 'ink' $true $true
T '纳入  当前场景 r18、前一场、适用确认规则1条\n排除  隐藏设定、未来事实、待确认想法\n传输  作者选定的提供者与端点；预算需先授权' 76 733 650 119 18 'ink'
Button '确认范围后生成' 76 905 240 $true 45
Label '未授权零出站 · 此设计稿不发出请求' 76 969 650
Box 808 592 744 412 'paper' 'line' 8
Label '04 / 提议已过期' 836 620 660 'terra'
T '正文已变，这条提议暂不能应用。' 836 666 672 51 27 'ink' $true $true
T '提议基于 r17；当前正文是 r18。\n保留旧输入和差异，不把旧提议悄悄套到新稿。\n拒绝后重开也不会清空历史或洗掉旧基准。' 836 738 658 116 18 'ink'
Button '查看旧输入与差异' 836 905 251 $false 45
Button '重新生成' 1104 905 184 $true 45
Label '生成新任务仍需当前授权与预算' 836 969 650
Label '织章 · StoryWeave / PRD v0.1 配套状态设计 · 非功能实现或真实服务结果' 48 1040 1500
Save 'shared-states.png'

if($script:overflows.Count){
    Write-Output 'Text layout warnings:'
    $script:overflows | ForEach-Object { Write-Output $_ }
    exit 2
}
Write-Output 'No measured text overflows.'
