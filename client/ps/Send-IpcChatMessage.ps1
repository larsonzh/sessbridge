# SessionBridge PowerShell client (compat layer, Windows).
# Two-way session bridge to VS Code Copilot Chat via file-based IPC.
# No UI automation (pywinauto / AHK) involved.
#
# Speaks the channel protocol v1 (see docs/RFC-sessbridge-channel-protocol-v1.md)
# and a legacy compatibility dialect inherited from whois IPC Chat Sender.
#
# Exit codes (contract, same as whois):
#   0   success
#   1   local transport failure (poll_timeout / write_cmd_failed)
#   2   extension-side failure
#   3   validation error

<#
.SYNOPSIS
    Send a message to VS Code Chat via IPC (SessionBridge).

.DESCRIPTION
    Writes a command file that the sessbridge extension picks up, then waits
    for the result.  No pywinauto or AHK involved.

    Multi-instance routing:
      Auto-detects the target VS Code instance PID from $env:VSCODE_PID
      (integrated terminal) or the first Code.exe process (external terminal).
      Pass -TargetPid explicitly to target a specific instance.

    New protocol (default):
      channel dir = %TEMP%\sessbridge (override SESSBRIDGE_CHANNEL_DIR or
      pass -ChannelDir); files cmd_<pid>.json / res_<pid>.json.

    Legacy protocol (-Legacy):
      whois old names in %TEMP%: vscode_chat_send_cmd_<pid>.json /
      vscode_chat_send_res_<pid>.json (or shared names when no PID).

.EXAMPLE
    .\Send-IpcChatMessage.ps1 -Message "Hello from IPC"

.EXAMPLE
    .\Send-IpcChatMessage.ps1 -Message "status" -Priority normal -Mode Silent -Model "DeepSeek V4 Flash"

.EXAMPLE
    .\Send-IpcChatMessage.ps1 -Message "test" -JsonOutput -KeepTempFiles
#>

param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Send')]
    [AllowEmptyString()]
    [string]$Message,

    [AllowEmptyString()]
    [string]$RequestId = '',

    [switch]$JsonOutput,

    [switch]$KeepTempFiles,

    [ValidateRange(0, 99999)]
    [int]$TargetPid = 0,

    [ValidateSet('normal', 'high')]
    [string]$Priority = 'normal',

    [switch]$AutoEscalate,

    [ValidateRange(1, 5400)]
    [int]$TimeoutSec = 30,

    [ValidateRange(50, 2000)]
    [int]$PollIntervalMs = 200,

    [ValidateSet('Silent', 'Visible', 'Auto')]
    [string]$Mode = 'Visible',

    [AllowEmptyString()]
    [string]$Model = '',

    [object]$ModelOptions = $null,

    [ValidateRange(1000, 3600000)]
    [int]$LmResponseTimeoutMs = 0,

    [Parameter(ParameterSetName = 'Discover')]
    [switch]$DiscoverModels,

    [string]$ChannelDir = '',

    [switch]$Legacy,

    [AllowEmptyString()]
    [string]$ConversationId = '',

    [ValidateRange(0, 999999)]
    [int]$TurnId = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---- PID resolution -------------------------------------------------------
if ($TargetPid -gt 0) {
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if ($null -eq $proc -or $proc.Name -ne 'Code') {
            $TargetPid = 0
        }
    } catch {
        $TargetPid = 0
    }
}

function Resolve-TargetPid {
    param([int]$PreferredPid)
    if ($PreferredPid -gt 0) { return $PreferredPid }
    $vscodePid = [string]$env:VSCODE_PID
    if (-not [string]::IsNullOrWhiteSpace($vscodePid)) {
        $parsed = 0
        if ([int]::TryParse($vscodePid, [ref]$parsed)) {
            if ($parsed -gt 0) { return $parsed }
        }
    }
    try {
        $codeProc = Get-Process -Name 'Code' -ErrorAction SilentlyContinue |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } |
            Sort-Object StartTime -Descending |
            Select-Object -First 1
        if ($null -ne $codeProc) { return [int]$codeProc.Id }
    } catch {
        $null = $null
    }
    return 0
}

function Get-RequestId {
    return ('sess-' + [Guid]::NewGuid().ToString('N'))
}

$targetPid = Resolve-TargetPid -PreferredPid $TargetPid

# ---- channel dir / file paths ---------------------------------------------
$legacyChannel = ($Legacy.IsPresent -or $targetPid -eq 0)
if (-not $legacyChannel) {
    if ([string]::IsNullOrWhiteSpace($ChannelDir)) {
        $ChannelDir = [string]$env:SESSBRIDGE_CHANNEL_DIR
    }
    if ([string]::IsNullOrWhiteSpace($ChannelDir)) {
        $ChannelDir = Join-Path $env:TEMP 'sessbridge'
    }
}

$cmdFile = ''
$resFile = ''
if ($legacyChannel) {
    if ($targetPid -gt 0) {
        $cmdFile = Join-Path $env:TEMP ("vscode_chat_send_cmd_{0}.json" -f $targetPid)
        $resFile = Join-Path $env:TEMP ("vscode_chat_send_res_{0}.json" -f $targetPid)
    } else {
        $cmdFile = Join-Path $env:TEMP 'vscode_chat_send_cmd.json'
        $resFile = Join-Path $env:TEMP 'vscode_chat_send_result.json'
    }
} else {
    if (-not (Test-Path -LiteralPath $ChannelDir)) {
        New-Item -ItemType Directory -Path $ChannelDir -Force | Out-Null
    }
    $cmdFile = Join-Path $ChannelDir ("cmd_{0}.json" -f $targetPid)
    $resFile = Join-Path $ChannelDir ("res_{0}.json" -f $targetPid)
}

# ---- validate message -----------------------------------------------------
$discoverMode = $PSCmdlet.ParameterSetName -eq 'Discover'
if ($PSCmdlet.ParameterSetName -eq 'Send') {
    $messageText = [string]$Message
    if ([string]::IsNullOrWhiteSpace($messageText)) {
        if ($JsonOutput) {
            @{ success = $false; reason = 'empty_message' } | ConvertTo-Json -Compress | Write-Output
        }
        exit 3
    }
} else {
    $messageText = ''
}

# ---- request id -----------------------------------------------------------
$requestIdWasAutoGenerated = [string]::IsNullOrWhiteSpace([string]$RequestId)
$effectiveRequestId = if ($requestIdWasAutoGenerated) { Get-RequestId } else { [string]$RequestId }

# ---- payload builders -----------------------------------------------------
function New-LegacyPayload {
    param([string]$MessageText, [string]$RequestId, [string]$Priority, [bool]$Discover)
    $payload = @{
        message    = $MessageText
        request_id = $RequestId
        priority   = $Priority
        mode       = $Mode.ToLowerInvariant()
        model      = [string]$Model
        discover   = $Discover
    }
    if ($null -ne $ModelOptions -and $ModelOptions -is [hashtable] -and $ModelOptions.Count -gt 0) {
        $payload.model_options = $ModelOptions
    }
    if ($LmResponseTimeoutMs -gt 0) {
        $payload.lm_response_timeout_ms = $LmResponseTimeoutMs
    }
    return $payload
}

function New-EnvelopePayload {
    param([string]$MessageText, [string]$RequestId, [string]$Priority, [int]$TargetPid,
          [int]$TimeoutSecValue, [bool]$Discover)
    $payload = [ordered]@{
        schemaVersion = '1'
        requestId     = $RequestId
        mode          = $Mode.ToLowerInvariant()
        priority      = $Priority
        message       = $MessageText
        targetPid     = $TargetPid
        timeoutMs     = ($TimeoutSecValue * 1000)
        createdAt     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        legacy        = $false
    }
    if ($LmResponseTimeoutMs -gt 0) { $payload.lmResponseTimeoutMs = $LmResponseTimeoutMs }
    if (-not [string]::IsNullOrWhiteSpace([string]$ConversationId)) { $payload.conversationId = $ConversationId }
    if ($TurnId -gt 0) { $payload.turnId = $TurnId }
    if (-not [string]::IsNullOrWhiteSpace([string]$Model)) { $payload.model = $Model }
    if ($Discover) { $payload.discover = $true }
    return $payload
}

# ---- send attempt ---------------------------------------------------------
function Invoke-SendAttempt {
    param(
        [string]$AttemptPriority,
        [string]$CmdFile,
        [string]$ResFile,
        [hashtable]$Payload
    )

    if (Test-Path -LiteralPath $ResFile) {
        try { Remove-Item -LiteralPath $ResFile -Force } catch { $null = $null }
    }

    try {
        $jsonText = $Payload | ConvertTo-Json -Compress -Depth 4
        [System.IO.File]::WriteAllText([string]$CmdFile, [string]$jsonText,
            [System.Text.UTF8Encoding]::new($false))
    } catch {
        return @{ success = $false; reason = "write_cmd_failed:$($_.Exception.Message)"; request_id = $effectiveRequestId }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -le $deadline) {
        if (Test-Path -LiteralPath $ResFile) {
            try {
                $raw = Get-Content -LiteralPath $ResFile -Raw -Encoding utf8
                $outcome = $raw | ConvertFrom-Json -ErrorAction Stop

                $ridNew = ''
                $ridOld = ''
                if ($null -ne $outcome.PSObject.Properties['requestId']) { $ridNew = [string]$outcome.requestId }
                if ($null -ne $outcome.PSObject.Properties['request_id']) { $ridOld = [string]$outcome.request_id }
                $rid = if (-not [string]::IsNullOrWhiteSpace($ridNew)) { $ridNew } else { $ridOld }
                $reqIdMatches = ($rid -eq $effectiveRequestId)

                if (-not $reqIdMatches) {
                    $reasonText = ''
                    $statusText = ''
                    if ($null -ne $outcome.PSObject.Properties['reason']) { $reasonText = [string]$outcome.reason }
                    if ($null -ne $outcome.PSObject.Properties['status']) { $statusText = [string]$outcome.status }
                    $isLegacyDiscover = (
                        $discoverMode -and [string]::IsNullOrWhiteSpace($rid) -and
                        ($reasonText -eq 'discovery' -or $reasonText -eq 'discovery_failed' -or
                         $statusText -eq 'discovery' -or $statusText -eq 'discovery_failed')
                    )
                    if (-not $isLegacyDiscover) {
                        Start-Sleep -Milliseconds 100
                        continue
                    }
                }

                if (-not $KeepTempFiles.IsPresent) {
                    Remove-Item -LiteralPath $ResFile -Force -ErrorAction SilentlyContinue
                }
                return $outcome
            } catch {
                Start-Sleep -Milliseconds 100
                continue
            }
        }
        Start-Sleep -Milliseconds $PollIntervalMs
    }

    if (Test-Path -LiteralPath $CmdFile) {
        try { Remove-Item -LiteralPath $CmdFile -Force } catch { $null = $null }
    }
    return $null
}

# ---- main flow ------------------------------------------------------------
if ($discoverMode) {
    $payload = if ($legacyChannel) {
        New-LegacyPayload -MessageText '' -RequestId $effectiveRequestId -Priority $Priority -Discover $true
    } else {
        New-EnvelopePayload -MessageText '' -RequestId $effectiveRequestId -Priority $Priority `
            -TargetPid $targetPid -TimeoutSecValue $TimeoutSec -Discover $true
    }
} else {
    $payload = if ($legacyChannel) {
        New-LegacyPayload -MessageText $messageText -RequestId $effectiveRequestId -Priority $Priority -Discover $false
    } else {
        New-EnvelopePayload -MessageText $messageText -RequestId $effectiveRequestId -Priority $Priority `
            -TargetPid $targetPid -TimeoutSecValue $TimeoutSec -Discover $false
    }
}

$outcome = Invoke-SendAttempt -AttemptPriority $Priority -CmdFile $cmdFile -ResFile $resFile -Payload $payload

$escalated = $false
if ($null -eq $outcome -and $AutoEscalate.IsPresent -and $Priority -eq 'normal') {
    $payload2 = if ($legacyChannel) {
        New-LegacyPayload -MessageText $messageText -RequestId $effectiveRequestId -Priority 'high' -Discover $discoverMode
    } else {
        New-EnvelopePayload -MessageText $messageText -RequestId $effectiveRequestId -Priority 'high' `
            -TargetPid $targetPid -TimeoutSecValue $TimeoutSec -Discover $discoverMode
    }
    $outcome = Invoke-SendAttempt -AttemptPriority 'high' -CmdFile $cmdFile -ResFile $resFile -Payload $payload2
    if ($null -ne $outcome) { $escalated = $true }
}

if ($null -eq $outcome) {
    $outcome = @{
        success      = $false
        reason       = 'poll_timeout'
        request_id   = $effectiveRequestId
        target_pid   = $targetPid
        cmd_file     = $cmdFile
        res_file     = $resFile
    }
} elseif ($escalated) {
    $outcome = $outcome.PSObject.Copy()
    Add-Member -InputObject $outcome -NotePropertyName 'escalated' -NotePropertyValue $true -Force
    Add-Member -InputObject $outcome -NotePropertyName 'escalated_reason' -NotePropertyValue 'normal_timeout_retry_with_high' -Force
}

if ($JsonOutput) {
    $outcome | ConvertTo-Json -Compress -Depth 4 | Write-Output
} elseif ($discoverMode -and $outcome.success) {
    $models = @($outcome.models)
    Write-Output ("Available Models (total {0}):" -f $models.Count)
    foreach ($m in $models) {
        Write-Output ("  {0,-40} {1,-30} {2,-20} {3,-20}" -f $m.name, $m.id, $m.vendor, $m.family)
    }
} elseif ($outcome.success) {
    Write-Output 'OK'
    if ($outcome.ai_response) { Write-Output $outcome.ai_response }
} else {
    Write-Error "Command failed: $($outcome.reason)"
}

if ($outcome.success) { exit 0 }

$failureReason = ''
if ($outcome -is [hashtable] -and $outcome.ContainsKey('reason')) {
    $failureReason = [string]$outcome['reason']
} elseif ($null -ne $outcome.PSObject.Properties['reason']) {
    $failureReason = [string]$outcome.reason
}
$isLocalFailure = ($failureReason -eq 'poll_timeout' -or $failureReason.StartsWith('write_cmd_failed'))
if ($isLocalFailure) { exit 1 }
exit 2
