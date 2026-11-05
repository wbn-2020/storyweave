param([string]$OutputDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$data=Get-Content -LiteralPath (Join-Path $OutputDirectory 'sample-data.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$script:Palette=@{bg='#090F18';panel='#111B29';raised='#172436';ink='#E7EAF0';muted='#A0AEC0';faint='#718198';line='#273548';gold='#DBBA87';green='#8FC6B3';sky='#070D17';paper='#F4F0E7';paperInk='#342F29';paperMuted='#7B746A';quote='#EAE3D2'}
$script:overflows=[Collections.Generic.List[string]]::new()
$nodes=@{};foreach($n in $data.nodes){$nodes[$n.id]=$n}
$colors=@{};foreach($c in $data.clusters){$colors[$c.id]=$c.color}
function Color($name,$alpha=255){$v=if($script:Palette.ContainsKey($name)){$script:Palette[$name]}else{$name};$c=[Drawing.ColorTranslator]::FromHtml($v);return [Drawing.Color]::FromArgb($alpha,$c.R,$c.G,$c.B)}
function Box($x,$y,$w,$h,$fill,$stroke='',$radius=0){
    $p=[Drawing.Drawing2D.GraphicsPath]::new()
    if($radius){$d=$radius*2;$p.AddArc($x,$y,$d,$d,180,90);$p.AddArc(($x+$w-$d),$y,$d,$d,270,90);$p.AddArc(($x+$w-$d),($y+$h-$d),$d,$d,0,90);$p.AddArc($x,($y+$h-$d),$d,$d,90,90);$p.CloseFigure()}else{$p.AddRectangle([Drawing.RectangleF]::new($x,$y,$w,$h))}
    if($fill){$b=[Drawing.SolidBrush]::new((Color $fill));$script:g.FillPath($b,$p);$b.Dispose()}
    if($stroke){$p1=[Drawing.Pen]::new((Color $stroke),1);$script:g.DrawPath($p1,$p);$p1.Dispose()};$p.Dispose()
}
function L($x1,$y1,$x2,$y2,$color='line',$width=1,$alpha=255,$dash=$false){$p=[Drawing.Pen]::new((Color $color $alpha),$width);if($dash){$p.DashPattern=@(4,5)};$script:g.DrawLine($p,[single]$x1,[single]$y1,[single]$x2,[single]$y2);$p.Dispose()}
function T($text,$x,$y,$w,$h,$size=16,$color='ink',$bold=$false,$serif=$false,$align='Near'){
    $text=([string]$text).Replace('\n',"`n");$family=if($serif){'SimSun'}else{'Microsoft YaHei'};$style=if($bold){[Drawing.FontStyle]::Bold}else{[Drawing.FontStyle]::Regular}
    $font=[Drawing.Font]::new($family,[single]$size,$style,[Drawing.GraphicsUnit]::Pixel);$brush=[Drawing.SolidBrush]::new((Color $color));$fmt=[Drawing.StringFormat]::new();$fmt.Alignment=[Drawing.StringAlignment]::$align;$fmt.Trimming=[Drawing.StringTrimming]::None
    $measure=$script:g.MeasureString($text,$font,[int]$w,$fmt);if($measure.Height -gt ($h+3)){$script:overflows.Add(('{0}: {1} at {2},{3}, height {4}, needed {5:N1}' -f $script:current,$text.Substring(0,[Math]::Min(23,$text.Length)),$x,$y,$h,$measure.Height))}
    $script:g.DrawString($text,$font,$brush,[Drawing.RectangleF]::new($x,$y,$w,$h),$fmt);$fmt.Dispose();$brush.Dispose();$font.Dispose()
}
function Dot($x,$y,$size,$color,$alpha=255){$b=[Drawing.SolidBrush]::new((Color $color $alpha));$script:g.FillEllipse($b,[single]($x-$size/2),[single]($y-$size/2),[single]$size,[single]$size);$b.Dispose()}
function Glow($x,$y,$radius,$color,$core=2){foreach($step in 4,3,2,1){Dot $x $y ($radius*$step/2) $color (3+4*(5-$step))};Dot $x $y $core $color 235;if($core-gt 3){Dot $x $y ($core/3) '#F1F2E9'}}
function Nebula($x,$y,$rx,$ry,$color){$p=[Drawing.Drawing2D.GraphicsPath]::new();$p.AddEllipse([single]($x-$rx),[single]($y-$ry),[single]($rx*2),[single]($ry*2));$b=[Drawing.Drawing2D.PathGradientBrush]::new($p);$b.CenterColor=Color $color 23;$b.SurroundColors=@((Color $color 0));$script:g.FillPath($b,$p);$b.Dispose();$p.Dispose()}
function Button($label,$x,$y,$w,$primary=$false,$h=35){Box $x $y $w $h $(if($primary){'#BDAC8C'}else{'panel'}) $(if($primary){''}else{'line'}) 4;T $label $x ($y+8) $w ($h-10) 14 $(if($primary){'bg'}else{'ink'}) $primary $false 'Center'}
function Label($text,$x,$y,$w,$color='faint'){T $text $x $y $w 26 13 $color}
function Canvas($name,$w=1600,$h=1000){$script:current=$name;$script:img=[Drawing.Bitmap]::new($w,$h);$script:g=[Drawing.Graphics]::FromImage($script:img);$script:g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias;$script:g.TextRenderingHint=[Drawing.Text.TextRenderingHint]::AntiAliasGridFit;$script:g.Clear((Color 'bg'))}
function Save($name){$script:img.Save((Join-Path $OutputDirectory $name),[Drawing.Imaging.ImageFormat]::Png);$script:g.Dispose();$script:img.Dispose();Write-Output ('Created '+$name)}
function Shell($active,$eyebrow,$title){
    Box 0 0 1600 66 'panel';L 0 66 1600 66
    $p=[Drawing.Pen]::new((Color 'gold'),1.1);$points=[Drawing.PointF[]]@([Drawing.PointF]::new(31,20),[Drawing.PointF]::new(45,34),[Drawing.PointF]::new(31,48),[Drawing.PointF]::new(17,34));$script:g.DrawPolygon($p,$points);$p.Dispose()
    T '织章' 62 17 90 35 26 'ink' $true $true;Label 'STORYWEAVE' 164 27 145
    L 335 18 335 48;T '潮汐档案' 359 21 132 31 18 'ink' $true;Label '第一卷 / 退潮之前' 518 28 290
    Dot 1237 34 5 'green';Label 'r18 / 保存状态示例' 1251 26 189 'muted';Box 1456 22 118 27 '#262C32' '#594B39' 3;T '离线设计稿' 1456 26 118 21 12 'gold' $false $false 'Center'
    Box 0 67 66 896 'panel';L 66 67 66 963
    foreach($item in @(@('创作','章',93),@('知识','星',178),@('审阅','阅',263))){if($item[0]-eq $active){Box 8 ($item[2]-5) 50 65 '#223247' '' 5};T $item[1] 10 $item[2] 46 33 23 $(if($item[0]-eq $active){'#A8C9D5'}else{'faint'}) $false $true 'Center';T $item[0] 8 ($item[2]+34) 50 24 12 $(if($item[0]-eq $active){'#A8C9D5'}else{'faint'}) $false $false 'Center'}
    Label $eyebrow 95 87 900;T $title 95 116 1140 40 27 'ink' $true $true;L 66 166 1600 166
    Box 0 963 1600 37 'panel';L 0 963 1600 963;Label 'UI v0.2 / 原创离线展示 · 无模型、数据库或可靠保存 · 密度样例不作写作记忆' 22 974 1190;Label '织章 / 夜航知识星系' 1368 974 200
}
function Project($position,$x,$y,$w,$h,$local=$false){
    $a=[double]$position[0];$b=[double]$position[1];$c=[double]$position[2];$turn=if($local){-0.12}else{-0.10};$tilt=if($local){-0.32}else{-0.46}
    if($local){$a=($a-8)*0.9;$b=($b-25)*1.45;$c*=0.8}
    $rx=$a*[Math]::Cos($turn)+$c*[Math]::Sin($turn);$rz=-$a*[Math]::Sin($turn)+$c*[Math]::Cos($turn);$ry=$b*[Math]::Cos($tilt)-$rz*[Math]::Sin($tilt);$depth=$b*[Math]::Sin($tilt)+$rz*[Math]::Cos($tilt);$perspective=690/(690-$depth)
    $scale=if($local){[Math]::Min($w/440,$h/250)}else{[Math]::Min($w/650,$h/340)}
    return @{x=$x+$w*0.50+$rx*$scale*$perspective;y=$y+$h*0.62-$ry*$scale*$perspective;z=$depth;p=$perspective}
}
function Galaxy($x,$y,$w,$h,$local=$false){
    Box $x $y $w $h 'sky';$script:g.SetClip([Drawing.RectangleF]::new($x,$y,$w,$h));$ps=@{};$visible=@{}
    foreach($c in $data.clusters){$p=Project $c.center $x $y $w $h $local;Nebula $p.x $p.y ($w*0.2) ($h*0.23) $c.color}
    foreach($n in $data.nodes){$show=if($local){($n.id-in @('lin','song','s4','rule','place','clue')) -or ($n.fixture-and $n.cluster-in @('events','rules','people')-and ([int]$n.id.Substring($n.id.Length-3)%3-eq 0))}else{$true};if($show){$ps[$n.id]=Project $n.position $x $y $w $h $local;$visible[$n.id]=$n}}
    foreach($e in $data.edges){if(!$ps.ContainsKey($e.a)-or !$ps.ContainsKey($e.b)){continue};$p=$ps[$e.a];$q=$ps[$e.b];$selected=$e.a-eq 'rule'-or $e.b-eq 'rule';$alpha=if($e.fixture){if($selected){74}else{26}}else{if($selected){158}else{70}};$color=if($e.planned){'gold'}else{$colors[$nodes[$e.a].cluster]};L $p.x $p.y $q.x $q.y $color $(if($selected){1.1}else{0.65}) $alpha $e.planned}
    foreach($n in ($visible.Values | Sort-Object {$ps[$_.id].z})){$p=$ps[$n.id];$core=if($n.anchor){5.5*$p.p}else{1.65*$p.p};$radius=if($n.anchor){16*$p.p}else{5.6*$p.p};$color=if($n.id-eq 'rule'){'#F2D7A7'}else{$colors[$n.cluster]};Glow $p.x $p.y $radius $color $core}
    $script:g.ResetClip()
    $labelIds=if($local){@('rule','s4','lin')}else{@('rule','s4','lin','song','clue','ref')}
    foreach($id in $labelIds){$p=$ps[$id];$text=$nodes[$id].name;$lw=[Math]::Min(183,28+$text.Length*15);$lx=[Math]::Max($x+7,[Math]::Min($x+$w-$lw-7,$p.x+13));$ly=$p.y+$(if($id-eq 'rule'){18}else{-29});$ly=[Math]::Max($y+8,[Math]::Min($y+$h-43,$ly));Box $lx $ly $lw 32 '#102033' $(if($id-eq 'rule'){'#A78A5D'}else{'#33485D'}) 3;T $text ($lx+7) ($ly+6) ($lw-14) 24 $(if($local){12}else{14}) $(if($id-eq 'rule'){'gold'}else{'ink'}) ($id-eq 'rule')}
}
$p1='林岑把账本推到潮钟旁，纸边被盐水泡得发软。第十七页的位置留着一道新鲜的裁痕。'
$p2='“潮钟只会吐出声音，仓门外的脚步不会留下影像。”宋遥没有碰钟，只指向门槛上被雨冲淡的泥印。'
$p3='林岑收回了先前的判断。若钟声只能证明时间，那份证词就还缺一个可以被追问的人。'

Canvas 'Galaxy'
Shell '知识' 'STORY ATLAS / 全书知识探索' '在星系里，看见故事的联系。'
Button '3D 星系' 1220 105 106 $true;Button '对象列表' 1337 105 99;Button '回到正文 →' 1447 105 126
Box 66 167 197 796 '#0E1722';L 263 167 263 963;Label '知识群落' 88 195 147 'muted'
$gy=252;foreach($c in $data.clusters){Dot 94 ($gy+10) 6 $c.color;T $c.title 112 $gy 135 29 15 'muted';$gy+=55}
L 88 639 241 639;T '全书可见 ≠ 本场可用' 88 664 162 51 14 'gold';T '未来计划与未确认项可以探索，但不进入写作事实。' 88 730 162 96 14 'muted';T '710 展示对象\n14 故事样例\n＋696 密度演示' 88 858 163 82 13 'faint'
Box 263 167 1006 796 'sky';Label '710 展示对象 · 1,615 展示关系' 286 189 567 'muted';Box 972 182 270 38 'panel' 'line' 4;T '人物、规则、场景…       定位' 985 192 244 28 13 'faint'
Galaxy 278 229 974 654
Label '夜航 / 作者全书视角' 300 243 341
Label '人物与知情' 390 386 159 '#7E9CAB';Label '北堤事件' 648 340 159 '#8395B5';Label '伏笔与承诺' 996 564 196 '#AE9570'
Label '拖动旋转 · 滚轮缩放 · 点击选中' 298 899 509;Button '＋' 1091 891 37;Button '−' 1136 891 37;Button '全景' 1182 891 63
L 284 939 1249 939;Label '实线：明确关系 / 虚线：计划或待核 / 密度演示不作记忆' 291 947 928
Box 1269 167 331 796 'panel';L 1269 167 1269 963
Label '规则 / 已确认 · 来源有效' 1298 197 277 'green';T '潮钟的边界' 1298 244 278 46 28 'ink' $true $true
T '只能重放声音，不能重放影像。\n否定条件完整保留，不把“重放现场”当作规则。' 1298 307 271 114 18 'ink'
Label '出处' 1298 447 44;T '作者采用为规则（样例）\n出处正文 r18 / b42' 1344 447 226 67 13 'muted'
Label '写作' 1298 530 44;T '本场适用 · 不隐藏\n仍需当前范围与来源核对' 1344 530 226 65 13 'muted'
L 1298 616 1570 616;Label '关系 / 证据' 1298 637 251 'muted';T '来源绑定 → 仓库对证\n计划遵守 → 重放失败' 1298 677 274 85 14 'muted'
Button '查看原文' 1298 785 126;Button '去本场' 1438 785 130
T '来源改动后需复核。\n星系距离不是因果或确证。' 1298 860 273 74 14 'gold'
Save '01-galaxy.png'

Canvas 'Writing'
Shell '创作' 'MANUSCRIPT / 正文与本场记忆' '继续写，不必重新讲完整本书。'
Button '全书星系 ↗' 1284 105 134;Button '预览实际输入' 1432 105 141
Box 66 167 221 796 '#0E1722';L 287 167 287 963;Label '退潮之前 / 手稿' 87 195 180 'muted'
$names=@('甲板回声','错号证词','巡堤队封锁','仓库对证','重放失败','留下倒页');$sy=256
foreach($i in 0..5){if($i-eq 3){Box 78 ($sy-10) 194 74 '#23364A' '' 4};Label ('0'+($i+1)+' / '+$(if($i-lt 2){'第一章'}elseif($i-lt 4){'第二章'}else{'第三章 · 计划'})) 93 $sy 172;T $names[$i] 93 ($sy+25) 170 33 17 $(if($i-eq 3){'ink'}else{'muted'}) ($i-eq 3);$sy+=94}
T '同一场景，不维护第二份正文。\n其他场景仅展示对象，不假装已有可写稿。' 88 862 180 74 13 'faint'
Box 287 167 877 796 '#14202C';Box 329 192 793 728 'paper' '' 3
Label '第二章 / 换页的账本 · 场景 s04' 371 235 676 'paperMuted';T '仓库对证' 371 293 660 61 38 'paperInk' $true $true
T '场景目标：找到证词可以被追问的人，而不是让钟声替人作证。' 371 368 697 57 16 'paperMuted';L 371 441 1078 441 '#DDD7CD'
T $p1 371 470 697 90 22 'paperInk' $false $true
Box 359 581 722 118 'quote';Box 359 581 3 118 '#9D7853';T $p2 371 600 697 87 22 'paperInk' $false $true
T $p3 371 736 697 96 22 'paperInk' $false $true
L 371 855 1078 855 '#DDD7CD';T 'b42 / 精确来源示例 · r18 / 当前正文示例\n只读设计稿，不是可保存的编辑器。' 371 873 697 54 13 'paperMuted'
Box 1164 167 436 796 '#101A27';L 1164 167 1164 963;Label '本场知识脉络 / 关联不等于全部纳入' 1190 194 381 'muted'
Galaxy 1186 235 388 217 $true
Label '适用记忆 / 状态示例' 1190 478 253 'ink';Label '版本示例 r18' 1440 478 147 'green'
$cards=@(@('潮钟的边界','只能重放声音，不能重放影像。','作者采用样例 · 原文 b42',527),@('反写编号 17','已引入异常；第三章只是计划回收。','已写线索状态 ≠ 未来事件',638),@('待补 / 暂不纳入：宋遥','只证实说过限制；真实知情尚待核对。','知情来源与时点待补，不入记忆包',749))
foreach($c in $cards){$gap=$c[3]-eq 749;Box 1186 $c[3] 388 99 $(if($gap){'#22282F'}else{'#162536'}) $(if($gap){'#594B39'}else{'line'}) 4;T $c[0] 1200 ($c[3]+12) 358 27 16 $(if($gap){'gold'}else{'ink'}) $true;T $c[1] 1200 ($c[3]+40) 358 38 14 'muted';Label $c[2] 1200 ($c[3]+76) 359 $(if($gap){'gold'}else{'green'})}
T '排除：未来/未确认、知情待补、未核验摘要。\n固定状态样例，不是检索或模型调用结果。' 1190 871 383 58 13 'faint'
Save '02-writing-memory.png'

Canvas 'Review'
Shell '审阅' 'MEMORY REVIEW / 独立确认前状态样例' '记忆要有出处，也要经得起改稿。'
Button '查看星系 ↗' 1420 105 153
Box 66 167 271 796 '#101A27';L 337 167 337 963;Label '候选与待复核 / 原创样例' 87 195 230 'muted'
$items=@(@('规则候选 · b42 / r18','潮钟只能重放声音，不能重放影像。','来源完整 · 待作者确认',247),@('旧摘要 · r17','潮钟可以重放现场。','来源已变 / 否定条件丢失',395),@('未确认解释','第二次铃响来自空船。','无正式事实证据',543),@('伏笔状态 · 第三章计划','反写编号 17 已回收。','只有计划，不能当已发生',691))
foreach($i in 0..3){$c=$items[$i];Box 82 $c[3] 239 132 $(if($i-eq 0){'#1A3040'}else{'raised'}) $(if($i-eq 0){'#819CA8'}else{'line'}) 4;Label $c[0] 96 ($c[3]+13) 211;T $c[1] 96 ($c[3]+43) 211 58 16 'ink' ($i-eq 0);Label $c[2] 96 ($c[3]+102) 213 'gold'}
T '本页是确认前的独立状态样例；演示决定不改全书页的事实样例。' 88 863 234 82 13 'faint'
Box 337 167 889 796 '#0D1723';Label '规则候选 / 尚未入正式记忆' 379 203 801 'green';T '把限制完整留下来。' 379 254 810 48 31 'ink' $true $true
Box 379 326 803 99 '#182C3B' '' 3;Box 379 326 3 99 '#6D9B9B';T '潮钟只能重放声音，不能重放影像。' 404 354 751 59 24 'ink'
Label '正文 r18 · 来源 b42       全书规则 / 作者需确认       尚未采用' 379 447 808 'muted'
Box 379 499 803 216 'paper' '' 3;Label '原文证据 / 第二章 · 仓库对证' 405 522 747 'paperMuted';T $p2 405 569 747 118 25 'paperInk' $false $true
T '这句话首先是角色说法。作者确认它为世界规则后，才形成正式事实；摘要不得丢掉“不能重放影像”的限制。' 379 749 803 99 18 'muted'
Button '确认采用' 379 867 149 $true 42;Button '编辑后确认' 542 867 163 $false 42;Button '拒绝' 719 867 109 $false 42;Button '稍后处理' 842 867 139 $false 42
Box 1226 167 374 796 '#111D2B';L 1226 167 1226 963;T '记忆如何保持可信' 1254 206 318 36 19 'ink' $true
$hitems=@(@('源正文已保存','保存成功与记忆更新是两种状态。r18 只是样例版本。',275),@('派生摘要可能过时','原文、范围或知情变化后，旧摘要隔离，不继续当证据。',424),@('确认只改变采用状态','不自动改全书，不抹去原拒绝，不自动升格角色说法。',573))
foreach($c in $hitems){T $c[0] 1254 $c[2] 316 33 18 'ink' $true;T $c[1] 1254 ($c[2]+43) 316 74 16 'muted';L 1254 ($c[2]+124) 1570 ($c[2]+124)}
T '索引与布局可以重建；作者决定、事实历史与原文不能靠检索重建。\n\n演示不持久保存，也不运行提取。' 1254 762 316 167 16 'gold'
Save '03-memory-review.png'

Canvas 'Mobile' 1660 1150
T '夜航星系，窄屏回到清楚的任务' 43 28 1573 57 35 'ink' $true $true
T '390px 目标布局示意 / 不是实机截图 · 旋转星系有列表替代，正文与审阅依然可达。' 43 101 1562 38 18 'muted'
$mx=@(47,590,1133);$heads=@('全书星系 / 探索','正文 / 本场记忆','审阅 / 证据确认')
foreach($i in 0..2){$x=$mx[$i];Label $heads[$i] $x 171 476 'gold';Box $x 212 480 848 'panel' 'line' 10;T '织章' ($x+22) 234 113 36 25 'ink' $true $true;Label '潮汐档案 / 离线示例' ($x+164) 247 289;L ($x+18) 293 ($x+462) 293
    if($i-eq 0){T '知识星系' ($x+22) 315 435 42 26 'ink' $true $true;Label '14 故事对象＋696 密度演示' ($x+22) 367 437;Galaxy ($x+18) 411 444 305;Button '对象列表' ($x+21) 738 438 $false 44;T '潮钟的边界' ($x+22) 810 433 44 25 'ink' $true $true;T '只能重放声音，不能重放影像。\n出处 b42 / r18 · 本场适用示例' ($x+22) 868 435 73 17 'muted';Button '查看原文 →' ($x+21) 971 438 $true 44}
    elseif($i-eq 1){Box ($x+18) 313 444 591 'paper' '' 3;Label '第二章 / 场景 s04' ($x+42) 340 396 'paperMuted';T '仓库对证' ($x+42) 394 394 48 30 'paperInk' $true $true;T $p1 ($x+42) 474 391 97 21 'paperInk' $false $true;Box ($x+29) 589 420 150 'quote';T $p2 ($x+42) 607 391 122 21 'paperInk' $false $true;T $p3 ($x+42) 770 391 111 21 'paperInk' $false $true;Button '展开本场记忆 / 输入范围' ($x+21) 939 438 $true 45}
    else{Label '规则候选 / 尚未采用' ($x+22) 321 436 'green';T '把限制完整留下来。' ($x+22) 366 435 54 26 'ink' $true $true;Box ($x+20) 450 440 85 '#182C3B';T '只能重放声音，不能重放影像。' ($x+34) 474 412 55 21 'ink';Box ($x+20) 557 440 207 'paper';Label '原文 / b42 · r18' ($x+38) 577 403 'paperMuted';T $p2 ($x+38) 621 403 126 20 'paperInk' $false $true;T '角色说法 ≠ 世界事实。\n确认前不入正式记忆，改稿后重新核对证据。' ($x+22) 796 435 87 17 'muted';Button '确认采用' ($x+22) 925 210 $true 45;Button '拒绝' ($x+247) 925 211 $false 45;Label '决定只是本次演示选择' ($x+22) 1005 436}
}
Label '织章 / UI v0.2 · 原创静态窄屏板，不是移动端、检索、保存或性能验收。' 47 1102 1578
Save '04-mobile-directions.png'
if($script:overflows.Count){Write-Output 'Text layout warnings:';$script:overflows | ForEach-Object {Write-Output $_};exit 2}
Write-Output 'No measured text overflows.'
