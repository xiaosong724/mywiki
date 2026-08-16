# 生成「Wiki 指令卡」PNG（web/assets/help-card.png）—— /帮助 时 QQ 发送
# 依赖 Windows GDI+（System.Drawing）；生成一次提交到 git，手机端无需生成
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'web\assets\help-card.png'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

$w = 780; $h = 560
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.Clear([System.Drawing.Color]::FromArgb(18, 21, 28))

$white  = [System.Drawing.Brushes]::White
$gray   = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(139, 147, 165))
$accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(79, 140, 255))

$titleFont = New-Object System.Drawing.Font('Microsoft YaHei', 22, [System.Drawing.FontStyle]::Bold)
$secFont   = New-Object System.Drawing.Font('Microsoft YaHei', 16, [System.Drawing.FontStyle]::Bold)
$bodyFont  = New-Object System.Drawing.Font('Microsoft YaHei', 14)
$mutedFont = New-Object System.Drawing.Font('Microsoft YaHei', 12)

$y = 26
$g.DrawString('Wiki 指令卡', $titleFont, $accent, 28, $y); $y += 46

# 图库
$g.DrawString('图库（前缀 /图库）', $secFont, $white, 28, $y); $y += 32
$gal = @(
  '/图库 妖丹掉落截图 [图片]       上传（带图）',
  '/图库 妖丹                      查询（最新 5 张）',
  '/图库 妖丹 2                    查询第 2 页',
  '/图库 改 #a1b2c3d4 五阶妖兽截图   修改介绍',
  '/图库 删 #a1b2c3d4              删除'
)
foreach ($ln in $gal) { $g.DrawString($ln, $bodyFont, $white, 40, $y); $y += 28 }
$y += 12

# 修仙模组（全量知识库）
$g.DrawString('修仙模组（前缀 /wiki）', $secFont, $white, 28, $y); $y += 32
$wiki = @(
  '/wiki 增 标题 内容             新增记录（自动生成 #id）',
  '/wiki 改 新标题 新内容 #id      修改记录',
  '/wiki 删 #id                   删除记录',
  '/wiki 灵根是什么                查询（AI 回答）'
)
foreach ($ln in $wiki) { $g.DrawString($ln, $bodyFont, $white, 40, $y); $y += 28 }
$y += 16
$g.DrawString('前缀以本群配置为准；上传 / 记录前请先发 /我是 名字 绑定身份', $mutedFont, $gray, 28, $y)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("已生成: " + $out)
