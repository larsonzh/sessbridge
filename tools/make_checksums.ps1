<#
.SYNOPSIS
    Generate a SHA256 checksum manifest (SHA256SUMS) for release artifacts.

.DESCRIPTION
    Hashes every file in -Dir (default: .\dist) and writes SHA256SUMS
    next to them (format: "<sha256>  <filename>", sorted by name).
    Excludes an existing SHA256SUMS itself.
#>

param(
    [string]$Dir = ''
)

$ErrorActionPreference = 'Stop'

$targetDir = if ($Dir) {
    [System.IO.Path]::GetFullPath($Dir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist'))
}

if (-not (Test-Path -LiteralPath $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    Write-Output "Created $targetDir (no artifacts yet)"
}

$lines = @()
foreach ($file in Get-ChildItem -LiteralPath $targetDir -File | Where-Object { $_.Name -ne 'SHA256SUMS' } | Sort-Object Name) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $lines += "{0}  {1}" -f $hash, $file.Name
}
$sumsPath = Join-Path $targetDir 'SHA256SUMS'
[System.IO.File]::WriteAllLines([string]$sumsPath, [string[]]$lines, [System.Text.UTF8Encoding]::new($true))

$lines | ForEach-Object { Write-Output $_ }
Write-Output "Wrote $sumsPath"
