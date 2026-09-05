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
    .\sessbridge.ps1 -Message "Hello from IPC"

.EXAMPLE
    .\sessbridge.ps1 -Message "status" -Priority normal -Mode Silent -Model "DeepSeek V4 Flash"

.EXAMPLE
    .\sessbridge.ps1 -Message "test" -JsonOutput -KeepTempFiles
#>

param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Send')]
    [AllowEmptyString()]
    [string]$Message,

    [AllowEmptyString()]
    [string]$RequestId = '',

    [switch]$JsonOutput,

    [switch]$KeepTempFiles,

    # Upper bound matches the historical Windows max PID (real PIDs can
    # exceed 99999 on long-uptime systems); Python client accepts any
    # positive int here, so this must not be tighter than that (parity).
    [ValidateRange(0, 4194304)]
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

    # -1 = not specified (parity with Python's argparse default=None); any
    # value >= 0, including 0, is sent explicitly (see docs/RFC turnId=0 example).
    [ValidateRange(-1, 999999)]
    [int]$TurnId = -1
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

# Folds a new-protocol (schemaVersion/status) receipt into the legacy shape
# (success/reason/request_id) so the rest of the script has one uniform
# contract to check, regardless of which channel answered.  Without this,
# `$outcome.success` on a real new-protocol receipt throws
# PropertyNotFoundException under Set-StrictMode (the field does not exist
# on that shape) instead of reporting success/failure correctly.
function ConvertTo-NormalizedOutcome {
    param($Outcome)

    if ($null -eq $Outcome -or $Outcome -is [hashtable]) {
        # Hashtable outcomes are only produced locally (poll_timeout /
        # write_cmd_failed) and are already legacy-shaped by construction.
        return $Outcome
    }

    $hasSchemaVersion = ($null -ne $Outcome.PSObject.Properties['schemaVersion']) -and
        (-not [string]::IsNullOrWhiteSpace([string]$Outcome.schemaVersion))
    if (-not $hasSchemaVersion) {
        return $Outcome  # already legacy-shaped (whois dialect)
    }

    $status = ''
    if ($null -ne $Outcome.PSObject.Properties['status']) { $status = [string]$Outcome.status }
    $success = ($status -eq 'ok' -or $status -eq 'discovery')
    $requestId = ''
    if ($null -ne $Outcome.PSObject.Properties['requestId']) { $requestId = [string]$Outcome.requestId }

    $normalized = $Outcome.PSObject.Copy()
    Add-Member -InputObject $normalized -NotePropertyName 'success' -NotePropertyValue $success -Force
    Add-Member -InputObject $normalized -NotePropertyName 'reason' -NotePropertyValue $status -Force
    Add-Member -InputObject $normalized -NotePropertyName 'request_id' -NotePropertyValue $requestId -Force
    if (($null -ne $Outcome.PSObject.Properties['response']) -and (-not [string]::IsNullOrEmpty([string]$Outcome.response))) {
        Add-Member -InputObject $normalized -NotePropertyName 'ai_response' -NotePropertyValue $Outcome.response -Force
    }
    return $normalized
}

$resolvedPid = Resolve-TargetPid -PreferredPid $TargetPid

# ---- channel dir / file paths ---------------------------------------------
$legacyChannel = ($Legacy.IsPresent -or $resolvedPid -eq 0)
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
    if ($resolvedPid -gt 0) {
        $cmdFile = Join-Path $env:TEMP ("vscode_chat_send_cmd_{0}.json" -f $resolvedPid)
        $resFile = Join-Path $env:TEMP ("vscode_chat_send_res_{0}.json" -f $resolvedPid)
    } else {
        $cmdFile = Join-Path $env:TEMP 'vscode_chat_send_cmd.json'
        $resFile = Join-Path $env:TEMP 'vscode_chat_send_result.json'
    }
} else {
    if (-not (Test-Path -LiteralPath $ChannelDir)) {
        New-Item -ItemType Directory -Path $ChannelDir -Force | Out-Null
    }
    $cmdFile = Join-Path $ChannelDir ("cmd_{0}.json" -f $resolvedPid)
    $resFile = Join-Path $ChannelDir ("res_{0}.json" -f $resolvedPid)
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
    if ($TurnId -ge 0) { $payload.turnId = $TurnId }
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
        # Atomic command write (F8): temp file in the same directory, then
        # File.Move(overwrite) into place — the extension polls for the file
        # and must never see a half-written JSON payload.
        $tmpCmd = [string]$CmdFile + ('.tmp-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
        [System.IO.File]::WriteAllText($tmpCmd, [string]$jsonText, [System.Text.UTF8Encoding]::new($false))
        try {
            [System.IO.File]::Move($tmpCmd, [string]$CmdFile, $true)
        } catch {
            # Fallback when the overwrite move is unavailable on this runtime.
            [System.IO.File]::Copy($tmpCmd, [string]$CmdFile, $true)
            Remove-Item -LiteralPath $tmpCmd -Force -ErrorAction SilentlyContinue
        }
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
            -TargetPid $resolvedPid -TimeoutSecValue $TimeoutSec -Discover $true
    }
} else {
    $payload = if ($legacyChannel) {
        New-LegacyPayload -MessageText $messageText -RequestId $effectiveRequestId -Priority $Priority -Discover $false
    } else {
        New-EnvelopePayload -MessageText $messageText -RequestId $effectiveRequestId -Priority $Priority `
            -TargetPid $resolvedPid -TimeoutSecValue $TimeoutSec -Discover $false
    }
}

$outcome = Invoke-SendAttempt -AttemptPriority $Priority -CmdFile $cmdFile -ResFile $resFile -Payload $payload

$escalated = $false
if ($null -eq $outcome -and $AutoEscalate.IsPresent -and $Priority -eq 'normal') {
    $payload2 = if ($legacyChannel) {
        New-LegacyPayload -MessageText $messageText -RequestId $effectiveRequestId -Priority 'high' -Discover $discoverMode
    } else {
        New-EnvelopePayload -MessageText $messageText -RequestId $effectiveRequestId -Priority 'high' `
            -TargetPid $resolvedPid -TimeoutSecValue $TimeoutSec -Discover $discoverMode
    }
    $outcome = Invoke-SendAttempt -AttemptPriority 'high' -CmdFile $cmdFile -ResFile $resFile -Payload $payload2
    if ($null -ne $outcome) { $escalated = $true }
}

if ($null -eq $outcome) {
    $outcome = @{
        success      = $false
        reason       = 'poll_timeout'
        request_id   = $effectiveRequestId
        target_pid   = $resolvedPid
        cmd_file     = $cmdFile
        res_file     = $resFile
    }
} elseif ($escalated) {
    $outcome = $outcome.PSObject.Copy()
    Add-Member -InputObject $outcome -NotePropertyName 'escalated' -NotePropertyValue $true -Force
    Add-Member -InputObject $outcome -NotePropertyName 'escalated_reason' -NotePropertyValue 'normal_timeout_retry_with_high' -Force
}

$outcome = ConvertTo-NormalizedOutcome -Outcome $outcome

if ($JsonOutput) {
    $outcome | ConvertTo-Json -Compress -Depth 4 | Write-Output
} elseif ($discoverMode -and $outcome.success) {
    $models = @($outcome.models)
    Write-Output ("Available Models (total {0}):" -f $models.Count)
    foreach ($m in $models) {
        $family = ''
        if ($null -ne $m.PSObject.Properties['family']) { $family = [string]$m.family }
        Write-Output ("  {0,-40} {1,-30} {2,-20} {3,-20}" -f $m.name, $m.id, $m.vendor, $family)
    }
} elseif ($outcome.success) {
    Write-Output 'OK'
    $aiResponse = ''
    if ($null -ne $outcome.PSObject.Properties['ai_response']) { $aiResponse = [string]$outcome.ai_response }
    if (-not [string]::IsNullOrEmpty($aiResponse)) { Write-Output $aiResponse }
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
