# 重启 QQ + NapCat（网页设置页「重启 QQ」按钮调用）
# 重启后 NapCat 会重新生成登录二维码（NapCat.Shell\cache\qrcode.png）
$ErrorActionPreference = 'SilentlyContinue'
Write-Output "== restart QQ+NapCat =="
# 1) 关闭 QQ 相关进程与 NapCat
Get-Process -Name 'QQ','QQExternal','QQMusic','QQNotify','QQMiniBrowser','NapCatWinBootMain' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
# 2) 重新启动 NapCat（launcher.bat 自带管理员检测；非管理员会弹 UAC）
$bat = 'C:\my-wiki\NapCat.Shell\launcher.bat'
if (Test-Path $bat) {
  Start-Process -FilePath $bat -WorkingDirectory 'C:\my-wiki\NapCat.Shell'
  Write-Output "launcher started"
} else {
  Write-Output "launcher.bat not found: $bat"
}
