<#
.SYNOPSIS
    Uninstall the legacy whois 'vscode-chat-sender' extension.

.DESCRIPTION
    Removes the old extension so SessionBridge (which also speaks the legacy
    dialect) can serve whois flows without racing on legacy IPC files.
    The whois source copy remains untouched.
#>

$ErrorActionPreference = 'Stop'

$extDir = Join-Path $env:USERPROFILE '.vscode\extensions\larsonzh.vscode-chat-sender'

if (-not (Test-Path -LiteralPath $extDir)) {
    Write-Output "Legacy extension not found at $extDir"
    exit 0
}

Remove-Item -LiteralPath $extDir -Recurse -Force
Write-Output "Legacy extension removed from $extDir"
Write-Output "Reload the VS Code window to complete the removal."
