# Use framework APIs directly: Windows PowerShell may inherit pwsh's PSModulePath.
function Get-TaskFileSha256 {
    param([string]$Path)
    $taskDigest = [Security.Cryptography.SHA256]::Create()
    $taskStream = $null
    try {
        $taskStream = [IO.File]::OpenRead($Path)
        return [BitConverter]::ToString($taskDigest.ComputeHash($taskStream)).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $taskStream) { $taskStream.Dispose() }
        $taskDigest.Dispose()
    }
}

function Expand-TaskRuntimeZip {
    param([string]$ArchivePath, [string]$DestinationPath)
    $null = [Reflection.Assembly]::Load('System.IO.Compression.FileSystem, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
    [IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $DestinationPath)
}
