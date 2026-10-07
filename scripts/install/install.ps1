# No administrator rights or preinstalled Python/Node required.
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$taskUtf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $taskUtf8
$OutputEncoding = $taskUtf8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskRoot = if ($env:OPENCLAW_HOME) { $env:OPENCLAW_HOME } else { Join-Path $env:LOCALAPPDATA 'OpenClaw Farm Console' }
for ($taskIndex = 0; $taskIndex -lt $args.Count; $taskIndex++) {
    if ($args[$taskIndex] -eq '--home' -and $taskIndex + 1 -lt $args.Count) { $taskRoot = $args[$taskIndex + 1] }
    elseif ($args[$taskIndex] -like '--home=*') { $taskRoot = $args[$taskIndex].Substring(7) }
}
$taskRoot = [IO.Path]::GetFullPath($taskRoot)
$taskArchRaw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($taskArchRaw -eq 'ARM64') {
    $taskAsset = 'uv-aarch64-pc-windows-msvc.zip'
    $taskPythonRequest = 'cpython-3.12.10-windows-x86_64-none'
    $taskSha = 'dbb3a5bd06d20c9ab8bb9a79c7c4fb5832ca1c7ba5f231a020bc92e5a3c6dcf4'
} elseif ($taskArchRaw -eq 'AMD64') {
    $taskAsset = 'uv-x86_64-pc-windows-msvc.zip'
    $taskPythonRequest = '3.12.10'
    $taskSha = '5049375aa2a5162f132b2c1cb992e25d42d47d934cab8c174dbe6f60973dcc12'
} else { throw 'Windows x64 or ARM64 is required.' }
$taskTools = Join-Path $taskRoot 'runtime/tools'
$taskCache = Join-Path $taskRoot 'cache'
New-Item -ItemType Directory -Force -Path $taskTools, $taskCache | Out-Null
$taskWork = Join-Path $taskCache ('bootstrap-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskWork | Out-Null
try {
    $taskUv = Join-Path $taskTools 'uv.exe'
    $taskNeedsUv = -not (Test-Path $taskUv)
    if (-not $taskNeedsUv) { $taskNeedsUv = ((& $taskUv --version) -notmatch '^uv 0\.8\.22(?: |$)') }
    if ($taskNeedsUv) {
        $taskArchive = Join-Path $taskCache $taskAsset
        $taskUrl = 'https://github.com/astral-sh/uv/releases/download/0.8.22/' + $taskAsset
        for ($taskAttempt = 0; $taskAttempt -lt 3; $taskAttempt++) {
            try { Invoke-WebRequest -UseBasicParsing -Uri $taskUrl -OutFile $taskArchive -TimeoutSec 1200; break }
            catch { if ($taskAttempt -eq 2) { throw }; Start-Sleep -Seconds 2 }
        }
        if ((Get-FileHash $taskArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskSha) { throw 'Runtime checksum mismatch. Download was not executed.' }
        Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskWork
        $taskBinary = @(Get-ChildItem -LiteralPath $taskWork -Recurse -Filter uv.exe)
        if ($taskBinary.Count -ne 1) { throw 'Invalid runtime archive.' }
        Copy-Item -LiteralPath $taskBinary[0].FullName -Destination $taskUv -Force
    }
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $taskRoot 'runtime/python-base'
    $env:UV_PYTHON_BIN_DIR = $taskTools
    $env:UV_CACHE_DIR = Join-Path $taskCache 'uv'
    if (-not $env:UV_HTTP_TIMEOUT) { $env:UV_HTTP_TIMEOUT = '1200' }
    $taskSavedPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 otherwise treats this expected missing-runtime
        # stderr as a terminating NativeCommandError before we check exit code.
        $ErrorActionPreference = 'Continue'
        & $taskUv python find $taskPythonRequest --managed-python --no-python-downloads --no-config 2>$null | Out-Null
        $taskFindExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $taskSavedPreference }
    if ($taskFindExit -ne 0) {
        & $taskUv python install $taskPythonRequest --no-config
        if ($LASTEXITCODE -ne 0) { throw 'Private Python installation failed. Windows ARM64 requires Windows 11 x64 emulation.' }
    }
    $taskPython = (& $taskUv python find $taskPythonRequest --managed-python --no-config | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $taskPython)) { throw 'Private Python was not found.' }
    & $taskPython (Join-Path $taskSource 'control.py') install @args
    if ($LASTEXITCODE -ne 0) { throw 'Console installation failed.' }
} finally { Remove-Item -LiteralPath $taskWork -Recurse -Force -ErrorAction SilentlyContinue }
