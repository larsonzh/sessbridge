<#
.SYNOPSIS
    Install the SessionBridge extension into VS Code.

.DESCRIPTION
    Copies extension/ into the VS Code extensions directory.  Run once before
    using the sessbridge client.

    Note: if the legacy whois 'vscode-chat-sender' extension is installed, both
    extensions would race on legacy files.  Either uninstall the old extension
    or keep only one installed (see -SkipLegacyCheck).
#>

param(
    [switch]$Force,

    [switch]$SkipLegacyCheck
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$srcDir = Join-Path $repoRoot 'extension'
$extDir = Join-Path $env:USERPROFILE '.vscode\extensions\larsonzh.sessbridge'

Write-Output "Source: $srcDir"
Write-Output "Target: $extDir"

if (-not $SkipLegacyCheck.IsPresent) {
    $legacyDir = Join-Path $env:USERPROFILE '.vscode\extensions\larsonzh.vscode-chat-sender'
    if (Test-Path -LiteralPath $legacyDir) {
        Write-Warning "Legacy extension found: $legacyDir"
        Write-Warning "Both extensions would race on legacy IPC files. Uninstall the legacy one first (installer\uninstall-legacy.ps1) or pass -SkipLegacyCheck."
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $srcDir 'package.json'))) {
    throw "package.json missing in $srcDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $srcDir 'extension.js'))) {
    throw "extension.js missing in $srcDir"
}

if (Test-Path -LiteralPath $extDir) {
    if (-not $Force.IsPresent) {
        Write-Output "Extension already installed at $extDir"
        Write-Output "Use -Force to overwrite, or run installer\uninstall.ps1 first."
        exit 0
    }
    Remove-Item -LiteralPath $extDir -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
}

New-Item -ItemType Directory -Path $extDir -Force | Out-Null

foreach ($item in Get-ChildItem -LiteralPath $srcDir -File) {
    Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $extDir $item.Name) -Force
}

Write-Output "SessionBridge extension installed to $extDir"
Write-Output "Please reload the VS Code window (Ctrl+Shift+P -> Developer: Reload Window) to activate."
Write-Output "Then use: .\client\sessbridge.py send --message 'hello'"
Write-Output "   or:   powershell -File client\ps\sessbridge.ps1 -Message 'hello'"
