<#
.SYNOPSIS
    Uninstall the SessionBridge extension from VS Code.
#>

$ErrorActionPreference = 'Stop'

$extDir = Join-Path $env:USERPROFILE '.vscode\extensions\larsonzh.sessbridge'

if (-not (Test-Path -LiteralPath $extDir)) {
    Write-Output "SessionBridge extension not found at $extDir"
    exit 0
}

Remove-Item -LiteralPath $extDir -Recurse -Force
Write-Output "SessionBridge extension removed from $extDir"
Write-Output "Reload the VS Code window to complete the removal."
