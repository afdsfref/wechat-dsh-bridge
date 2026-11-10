# Restart the WeChat-to-DSH bridge when its daemon is not alive.
#
# The bridge writes its pid to $storageDir\bridge.pid. A stale or absent pid
# means the daemon died (or never started); this script starts it again hidden.
# Run it from Task Scheduler every few minutes, or by hand after a reboot.

$ErrorActionPreference = 'SilentlyContinue'

$bridge = 'C:\Users\Administrator\Documents\Codex\wechat-dsh-bridge'
$storage = 'C:\Users\Administrator\.wechat-dsh-bridge'
$pidFile = Join-Path $storage 'bridge.pid'

$alive = $false
if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw | Out-String).Trim()
    if ($raw -match '^\d+$') {
        $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
        # A stale pid may be reused by an unrelated process; confirm it is our node.
        if ($proc -and $proc.ProcessName -eq 'node') { $alive = $true }
    }
}

if (-not $alive) {
    Start-Process -FilePath (Join-Path $bridge 'start-wechat-dsh.cmd') -WindowStyle Hidden
    $log = Join-Path $storage 'watchdog.log'
    Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' bridge restarted by watchdog') -Encoding utf8
}
