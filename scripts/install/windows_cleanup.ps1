# Runs outside the installation after its interpreter exits. No admin rights needed.
param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$taskRequest = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
try {
    if (Get-Process -Id $taskRequest.parentPid -ErrorAction SilentlyContinue) {
        Wait-Process -Id $taskRequest.parentPid -Timeout 60 -ErrorAction Stop
    }
    $taskMarker = Join-Path $taskRequest.root 'installation.json'
    if (-not (Test-Path -LiteralPath $taskMarker)) { throw 'Installation marker disappeared; cleanup refused.' }
    $taskCurrent = Get-Content -LiteralPath $taskMarker -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($taskCurrent.id -ne $taskRequest.installationId -or -not $taskCurrent.uninstallPending) {
        throw 'Installation identity changed; cleanup refused.'
    }
    foreach ($taskPath in $taskRequest.paths) {
        for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
            try {
                if (Test-Path -LiteralPath $taskPath) { Remove-Item -LiteralPath $taskPath -Recurse -Force }
                break
            } catch {
                if ($taskAttempt -eq 29) { throw }
                Start-Sleep -Milliseconds 500
            }
        }
    }
    if (-not $taskRequest.purge) {
        $taskCurrent.uninstallPending = $false
        [IO.File]::WriteAllText($taskMarker, ($taskCurrent | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding($false)))
    }
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'result.json'), '{"ok":true}')
} catch {
    # Only status is persisted. Runtime failures must not disclose credential data.
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'result.json'), '{"ok":false,"error":"cleanup_incomplete"}')
    exit 1
}
