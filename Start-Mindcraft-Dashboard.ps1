$Root = "C:\Users\kiero\mindcraft-furrywall-test"
$Dashboard = Join-Path $Root "dashboard"
$Server = Join-Path $Dashboard "server.cjs"
$Url = "http://127.0.0.1:8090"

$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*mindcraft-furrywall-test*dashboard*server.cjs*" }

if (-not $existing) {
    Start-Process -FilePath "node.exe" -ArgumentList $Server -WorkingDirectory $Dashboard -WindowStyle Hidden
    Start-Sleep -Seconds 1
}

Start-Process $Url
Write-Host "Andy dashboard: $Url" -ForegroundColor Green
