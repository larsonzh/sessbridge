<#
.SYNOPSIS
    Build the SessionBridge .vsix package using Microsoft's vsce (via npx).

.DESCRIPTION
    Runs vsce against extension/package.json and writes
    dist\sessbridge-<version>.vsix.  vsce is fetched on demand with npx
    (requires Node.js 16+ and network access on first run).
#>

param(
    [switch]$NoFetch
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$extDir = Join-Path $repoRoot 'extension'
$distDir = Join-Path $repoRoot 'dist'
$pkgPath = Join-Path $extDir 'package.json'

if (-not (Test-Path -LiteralPath $pkgPath)) {
    throw "package.json missing in $extDir"
}

$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding utf8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$out = Join-Path $distDir ("sessbridge-{0}.vsix" -f $pkg.version)

if (-not $NoFetch.IsPresent) {
    # Prime the npx cache so the actual package step is deterministic.
    npx --yes @vscode/vsce --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npx @vscode/vsce unavailable — install Node.js or pass -NoFetch with a pre-installed vsce." }
}

Push-Location $extDir
try {
    npx --yes @vscode/vsce package --skip-license --out $out
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Output "Built: $out"
Write-Output "Next: tools\make_checksums.ps1 -Dir dist"
