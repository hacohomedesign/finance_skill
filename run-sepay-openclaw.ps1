$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Output "=== SePay Finance Sync ==="
Write-Output "Thu muc: $root"
Write-Output ""
Write-Output "Bat dau chay sync lien tuc (5 phut/lan)..."
Write-Output "Nhan Ctrl+C de dung."
Write-Output ""

node sync.js --watch
