#!/bin/sh
# SessionBridge shell client (Linux / macOS / other POSIX systems).
# Pure POSIX tooling — no Python / Node / jq required.
# Independent implementation of the channel protocol v1 with the same
# contract as client/sessbridge.py and client/ps/sessbridge.ps1.
#
# Exit codes: 0 = success, 1 = local transport failure, 2 = extension-side
# failure, 3 = validation / environment error.
#
# Usage:
#   sh client/sh/sessbridge.sh send --message "hello"
#   sh client/sh/sessbridge.sh send --message "status" --mode silent --model "DeepSeek V4 Flash Vision Exp"
#   sh client/sh/sessbridge.sh discover
#   sh client/sh/sessbridge.sh --help
#
# Env:
#   SESSBRIDGE_CHANNEL_DIR  override channel directory
#   VSCODE_PID              VS Code main-window PID (integrated terminal)
#   TMPDIR                  POSIX temp dir (default /tmp on Unix)

set -u

# ---- defaults --------------------------------------------------------------
MODE=visible
PRIORITY=normal
MODEL=""
REQUEST_ID=""
TARGET_PID=0
CHANNEL_DIR=""
TIMEOUT=30
POLL_MS=200
KEEP=0
JSON_OUTPUT=0
LEGACY=0
DISCOVER=0
AUTO_ESCALATE=0
LM_TIMEOUT_MS=0
CONVERSATION_ID=""
TURN_ID=""
MESSAGE=""
PRETTY=0

if [ -n "${SESSBRIDGE_CHANNEL_DIR:-}" ]; then
    CHANNEL_DIR="$SESSBRIDGE_CHANNEL_DIR"
else
    CHANNEL_DIR="${TMPDIR:-/tmp}/sessbridge"
fi

# ---- helpers ---------------------------------------------------------------
usage() {
    cat <<'EOF'
SessionBridge shell client — pure POSIX, no Python required.

Usage:
  sessbridge.sh send     --message <text> [options]
  sessbridge.sh discover [options]
  sessbridge.sh --help

Options:
  --message <text>           message to deliver (default empty)
  --mode visible|silent|auto delivery mode (default visible)
  --model <name-or-id>       preferred LM model (silent/auto)
  --request-id <id>          receipt binding id (auto: sess-<hex>)
  --target-pid <pid>         target VS Code main-window PID (0 = auto)
  --channel-dir <dir>        override channel directory
  --timeout <seconds>        wait for receipt (default 30)
  --poll-interval <ms>       poll interval ms (default 200)
  --keep                     keep receipt file after reading
  --json-output              print receipt as JSON
  --pretty                   readable multi-line receipt (like Format-List)
  --legacy                   whois legacy IPC mode
  --priority normal|high     request priority (default normal)
  --auto-escalate            retry with high on normal timeout
  --lm-response-timeout-ms <ms>  LM wait budget (0 = extension default)
  --conversation-id <id>     conversation context id
  --turn-id <n>              turn number (0 = new turn)
  --discover | -d            list available LM models

Environment:
  SESSBRIDGE_CHANNEL_DIR   channel directory (default $TMPDIR/sessbridge)
  VSCODE_PID               VS Code main-window PID
EOF
}

# json_escape <text>: print text JSON-encoded (single line).
json_escape() {
    printf '%s' "$1" | tr '\n' '\001' | awk '{
        gsub(/\\/, "\\\\");
        gsub(/"/, "\\\"");
        gsub(/\t/, "\\t");
        gsub(/\r/, "\\r");
        gsub(/\001/, "\\n");
        printf "%s", $0
    }'
}

# json_str <file> <key>: print the string value of a top-level key
# (assumes single-line JSON, as produced by the extension's writeResult).
json_str() {
    awk -v key="$2" '
    {
        idx = index($0, "\"" key "\"");
        if (idx == 0) { exit 0 }
        rest = substr($0, idx + length(key) + 2);
        sub(/^[ \t]*/, "", rest);
        if (substr(rest, 1, 1) != ":") { exit 0 }
        rest = substr(rest, 2);
        sub(/^[ \t]*/, "", rest);
        if (substr(rest, 1, 1) != "\"") { exit 0 }
        rest = substr(rest, 2);
        out = "";
        n = length(rest);
        i = 1;
        while (i <= n) {
            c = substr(rest, i, 1);
            if (c == "\\") {
                nc = substr(rest, i + 1, 1);
                if (nc == "n") { out = out "\n"; i += 2; continue }
                if (nc == "t") { out = out "\t"; i += 2; continue }
                if (nc == "r") { out = out "\r"; i += 2; continue }
                if (nc == "\"") { out = out "\""; i += 2; continue }
                if (nc == "\\") { out = out "\\"; i += 2; continue }
                if (nc == "u") { out = out "\\u" substr(rest, i + 2, 4); i += 6; continue }
                out = out nc; i += 2; continue
            }
            if (c == "\"") { break }
            out = out c;
            i++;
        }
        printf "%s", out;
    }' "$1"
}

# json_raw <file> <key>: print the raw (compact) JSON value of a top-level
# key.  Handles nested objects/arrays by brace/bracket pairing.
json_raw() {
    awk -v key="$2" '
    {
        idx = index($0, "\"" key "\"");
        if (idx == 0) { exit 0 }
        rest = substr($0, idx + length(key) + 2);
        sub(/^[ \t]*/, "", rest);
        if (substr(rest, 1, 1) != ":") { exit 0 }
        rest = substr(rest, 2);
        sub(/^[ \t]*/, "", rest);
        first = substr(rest, 1, 1);
        if (first == "\"" || first == "{" || first == "[") {
            closing = (first == "\"") ? "\"" : (first == "{") ? "}" : "]";
            if (first == "\"") {
                n = length(rest);
                i = 2;
                while (i <= n) {
                    c = substr(rest, i, 1);
                    if (c == "\\") { i += 2; continue }
                    if (c == "\"") { break }
                    i++;
                }
                printf "%s", substr(rest, 1, i);
                exit 0;
            }
            depth = 1;
            n = length(rest);
            i = 2;
            while (i <= n) {
                c = substr(rest, i, 1);
                if (c == "\\") { i += 2; continue }
                if (c == first) { depth++ }
                if (c == closing) { depth--; if (depth == 0) { break } }
                i++;
            }
            printf "%s", substr(rest, 1, i);
            exit 0;
        }
        # number / bool / null: read until comma or closing brace
        n = length(rest);
        i = 1;
        while (i <= n) {
            c = substr(rest, i, 1);
            if (c == "," || c == "}") { break }
            i++;
        }
        printf "%s", substr(rest, 1, i - 1);
    }' "$1"
}

# pretty_receipt <file>: Format-List style for new/legacy protocol receipts.
pretty_receipt() {
    file="$1"
    printf '%-16s: %s\n' schemaVersion "$(json_str "$file" schemaVersion)"
    printf '%-16s: %s\n' requestId "$(json_str "$file" requestId)"
    printf '%-16s: %s\n' request_id "$(json_str "$file" request_id)"
    printf '%-16s: %s\n' status "$(json_str "$file" status)"
    printf '%-16s: %s\n' success "$(json_str "$file" success)"
    printf '%-16s: %s\n' reason "$(json_str "$file" reason)"
    printf '%-16s: %s\n' mode "$(json_str "$file" mode)"
    printf '%-16s: %s\n' response "$(json_str "$file" response)"
    printf '%-16s: %s\n' ai_response "$(json_str "$file" ai_response)"
    printf '%-16s: %s\n' humanReply "$(json_str "$file" humanReply)"
    printf '%-16s: %s\n' conversationId "$(json_str "$file" conversationId)"
    printf '%-16s: %s\n' error "$(json_str "$file" error)"
    printf '%-16s: %s\n' polledMs "$(json_str "$file" polledMs)"
    printf '%-16s: %s\n' extensionVersion "$(json_str "$file" extensionVersion)"
    printf '%-16s: %s\n' finishedAt "$(json_str "$file" finishedAt)"
    printf '%-16s: %s\n' modeUsed "$(json_str "$file" modeUsed)"
    printf '%-16s: %s\n' model "$(json_raw "$file" model)"
    printf '%-16s: %s\n' models "$(json_raw "$file" models)"
}

# resolve_target_pid: --target-pid > VSCODE_PID > best-effort code process.
resolve_target_pid() {
    if [ "$TARGET_PID" -gt 0 ] 2>/dev/null; then
        return 0
    fi
    if [ -n "${VSCODE_PID:-}" ]; then
        case "$VSCODE_PID" in
            *[!0-9]*|"") ;;
            *) TARGET_PID="$VSCODE_PID"; return 0 ;;
        esac
    fi
    if command -v pgrep >/dev/null 2>&1; then
        found=$(pgrep -n -f 'Code|code' 2>/dev/null | head -n 1)
        case "$found" in
            *[!0-9]*|"") ;;
            *) TARGET_PID="$found"; return 0 ;;
        esac
    fi
    # MSYS/Git Bash fallback: `ps -W` lists the Windows PID (WINPID) as the
    # 4th column; on Linux/macOS `ps -W` is not supported and this yields
    # nothing (pgrep above already handled those platforms).
    if command -v ps >/dev/null 2>&1; then
        found=$(ps -W 2>/dev/null | grep -i '[c]ode' | head -n 1 | awk '{print $4}')
        case "$found" in
            *[!0-9]*|"") ;;
            *) TARGET_PID="$found"; return 0 ;;
        esac
    fi
    TARGET_PID=0
}

# make_request_id: sess-<epoch>-<hex>
make_request_id() {
    hex=$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
    [ -z "$hex" ] && hex=$$
    printf 'sess-%s-%s' "$(date +%s)" "$hex"
}

# build_envelope: print new-protocol command JSON.
build_envelope() {
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    {
        printf '{"schemaVersion":"1","requestId":"%s","mode":"%s","priority":"%s",' "$REQUEST_ID" "$MODE" "$PRIORITY"
        printf '"message":"%s",' "$(json_escape "$MESSAGE")"
        printf '"targetPid":%s,"timeoutMs":%s,' "$TARGET_PID" "$((TIMEOUT * 1000))"
        printf '"createdAt":"%s","legacy":false' "$ts"
        if [ -n "$MODEL" ]; then printf ',"model":"%s"' "$(json_escape "$MODEL")"; fi
        if [ "$LM_TIMEOUT_MS" -gt 0 ]; then printf ',"lmResponseTimeoutMs":%s' "$LM_TIMEOUT_MS"; fi
        if [ -n "$CONVERSATION_ID" ]; then printf ',"conversationId":"%s"' "$(json_escape "$CONVERSATION_ID")"; fi
        if [ -n "$TURN_ID" ]; then printf ',"turnId":%s' "$TURN_ID"; fi
        if [ "$DISCOVER" -eq 1 ]; then printf ',"discover":true'; fi
        printf '}'
    }
}

# build_legacy_payload: print legacy whois-shaped command JSON.
build_legacy_payload() {
    {
        printf '{"message":"%s","request_id":"%s","priority":"%s","mode":"%s","model":"%s","discover":%s' \
            "$(json_escape "$MESSAGE")" "$REQUEST_ID" "$PRIORITY" "$MODE" "$(json_escape "$MODEL")" \
            "$([ "$DISCOVER" -eq 1 ] && printf true || printf false)"
        if [ "$LM_TIMEOUT_MS" -gt 0 ]; then printf ',"lm_response_timeout_ms":%s' "$LM_TIMEOUT_MS"; fi
        printf '}'
    }
}

# paths (legacy always in system temp dir)
if [ "$LEGACY" -eq 1 ]; then
    if [ "$TARGET_PID" -gt 0 ] 2>/dev/null; then
        CMD_FILE="${TMPDIR:-/tmp}/vscode_chat_send_cmd_${TARGET_PID}.json"
        RES_FILE="${TMPDIR:-/tmp}/vscode_chat_send_res_${TARGET_PID}.json"
    else
        CMD_FILE="${TMPDIR:-/tmp}/vscode_chat_send_cmd.json"
        RES_FILE="${TMPDIR:-/tmp}/vscode_chat_send_result.json"
    fi
else
    mkdir -p "$CHANNEL_DIR" 2>/dev/null || true
    CMD_FILE="$CHANNEL_DIR/cmd_${TARGET_PID}.json"
    RES_FILE="$CHANNEL_DIR/res_${TARGET_PID}.json"
fi

# ---- parse args ------------------------------------------------------------
if [ "$#" -eq 0 ]; then
    usage
    exit 3
fi

while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help|-Help) usage; exit 0 ;;
        send) : ;;
        discover|-d|-DiscoverModels|--discover) DISCOVER=1 ;;
        -Message|-message|--message|-m) shift; MESSAGE="$1" ;;
        -Mode|-mode|--mode) shift; MODE="$1" ;;
        -Model|-model|--model) shift; MODEL="$1" ;;
        -RequestId|-request-id|--request-id) shift; REQUEST_ID="$1" ;;
        -TargetPid|-target-pid|--target-pid) shift; TARGET_PID="$1" ;;
        -ChannelDir|-channel-dir|--channel-dir) shift; CHANNEL_DIR="$1" ;;
        -TimeoutSec|-timeout|--timeout) shift; TIMEOUT="$1" ;;
        -PollIntervalMs|-poll-interval|--poll-interval) shift; POLL_MS="$1" ;;
        -KeepTempFiles|-keep|--keep) KEEP=1 ;;
        -JsonOutput|-json-output|--json-output) JSON_OUTPUT=1 ;;
        -Pretty|-pretty|--pretty) PRETTY=1 ;;
        -Legacy|-legacy|--legacy) LEGACY=1 ;;
        -Priority|-priority|--priority) shift; PRIORITY="$1" ;;
        -AutoEscalate|-auto-escalate|--auto-escalate) AUTO_ESCALATE=1 ;;
        -LmResponseTimeoutMs|-lm-response-timeout-ms|--lm-response-timeout-ms) shift; LM_TIMEOUT_MS="$1" ;;
        -ConversationId|-conversation-id|--conversation-id) shift; CONVERSATION_ID="$1" ;;
        -TurnId|-turn-id|--turn-id) shift; TURN_ID="$1" ;;
        *)
            echo "sessbridge.sh: unknown option: $1" >&2
            exit 3
            ;;
    esac
    shift
done

# ---- validation ------------------------------------------------------------
# Normalize case so PowerShell-style values (Silent/Visible/Auto/Normal/High)
# and POSIX-style lowercase values both work.
MODE=$(printf '%s' "$MODE" | tr '[:upper:]' '[:lower:]')
PRIORITY=$(printf '%s' "$PRIORITY" | tr '[:upper:]' '[:lower:]')
case "$MODE" in visible|silent|auto) ;; *) echo "sessbridge.sh: invalid --mode: $MODE" >&2; exit 3 ;; esac
case "$PRIORITY" in normal|high) ;; *) echo "sessbridge.sh: invalid --priority: $PRIORITY" >&2; exit 3 ;; esac
case "$TIMEOUT" in
    *[!0-9]*|"") echo "sessbridge.sh: invalid --timeout: $TIMEOUT" >&2; exit 3 ;;
esac
if [ "$TURN_ID" != "" ]; then
    case "$TURN_ID" in
        *[!0-9-]*) echo "sessbridge.sh: invalid --turn-id: $TURN_ID" >&2; exit 3 ;;
    esac
fi

resolve_target_pid

if [ -z "$REQUEST_ID" ]; then
    REQUEST_ID=$(make_request_id)
fi

# legacy and new channels need the PID resolved before path build; rebuild
# paths after resolution (legacy default was computed above with 0).
if [ "$LEGACY" -eq 1 ]; then
    if [ "$TARGET_PID" -gt 0 ] 2>/dev/null; then
        CMD_FILE="${TMPDIR:-/tmp}/vscode_chat_send_cmd_${TARGET_PID}.json"
        RES_FILE="${TMPDIR:-/tmp}/vscode_chat_send_res_${TARGET_PID}.json"
    fi
else
    CMD_FILE="$CHANNEL_DIR/cmd_${TARGET_PID}.json"
    RES_FILE="$CHANNEL_DIR/res_${TARGET_PID}.json"
fi

# ---- send attempt ----------------------------------------------------------
send_attempt() {
    if [ -f "$RES_FILE" ]; then rm -f "$RES_FILE" 2>/dev/null || :; fi

    if [ "$LEGACY" -eq 1 ]; then
        payload=$(build_legacy_payload)
    else
        payload=$(build_envelope)
    fi

    tmp_cmd="${CMD_FILE}.tmp-$$"
    if ! printf '%s' "$payload" > "$tmp_cmd" 2>/dev/null; then
        return 1
    fi
    if ! mv -f "$tmp_cmd" "$CMD_FILE" 2>/dev/null; then
        rm -f "$tmp_cmd" 2>/dev/null || :
        return 1
    fi

    started=$(date +%s)
    deadline=$((started + TIMEOUT))
    while :; do
        if [ -f "$RES_FILE" ]; then
            rid_new=$(json_str "$RES_FILE" requestId)
            rid_old=$(json_str "$RES_FILE" request_id)
            rid="$rid_new"; [ -z "$rid" ] && rid="$rid_old"
            if [ -n "$rid" ] && [ "$rid" = "$REQUEST_ID" ]; then
                RESULT_FILE="$RES_FILE"
                return 0
            fi
            if [ "$DISCOVER" -eq 1 ] && [ -z "$rid" ]; then
                st=$(json_str "$RES_FILE" reason)
                [ -z "$st" ] && st=$(json_str "$RES_FILE" status)
                case "$st" in discovery|discovery_failed) RESULT_FILE="$RES_FILE"; return 0 ;; esac
            fi
        fi
        now=$(date +%s)
        if [ "$now" -ge "$deadline" ]; then
            RESULT_FILE=""
            return 1
        fi
        poll_sleep=$(awk -v ms="$POLL_MS" 'BEGIN { printf "%.2f", ms / 1000 }')
        # POSIX sleep only guarantees integer seconds; GNU/BusyBox/macOS accept
        # fractions, so fall back to 1s on strict POSIX systems.
        sleep "$poll_sleep" 2>/dev/null || sleep 1
    done
}

# ---- main ------------------------------------------------------------------
RESULT_FILE=""
if send_attempt; then
    :
else
    if [ "$AUTO_ESCALATE" -eq 1 ] && [ "$PRIORITY" = "normal" ]; then
        PRIORITY=high
        send_attempt
    fi
fi

if [ -z "$RESULT_FILE" ]; then
    # local transport timeout
    if [ "$JSON_OUTPUT" -eq 1 ]; then
        printf '{"success":false,"reason":"poll_timeout","request_id":"%s"}' "$REQUEST_ID"
        printf '\n'
    fi
    exit 1
fi

if [ "$PRETTY" -eq 1 ]; then
    status=$(json_str "$RESULT_FILE" status)
    success=$(json_str "$RESULT_FILE" success)
    pretty_receipt "$RESULT_FILE"
    [ "$KEEP" -eq 1 ] || rm -f "$RESULT_FILE" 2>/dev/null || :
    if [ "$status" = "ok" ] || [ "$success" = "true" ] || [ "$status" = "discovery" ]; then
        exit 0
    fi
    if [ "$status" = "discovery_failed" ]; then
        exit 2
    fi
    [ -n "$status" ] && exit 2
    exit 0
fi

if [ "$DISCOVER" -eq 1 ]; then
    status=$(json_str "$RESULT_FILE" status)
    [ -z "$status" ] && status=$(json_str "$RESULT_FILE" reason)
    if [ "$status" = "discovery_failed" ]; then
        [ "$JSON_OUTPUT" -eq 0 ] && echo "discovery failed"
        exit 2
    fi
    if [ "$JSON_OUTPUT" -eq 1 ]; then
        cat "$RESULT_FILE"
        printf '\n'
    else
        echo "Available Models (JSON output: use --json-output for full list)"
        grep -oE '"name":"[^"]*","vendor":"[^"]*","id":"[^"]*"' "$RESULT_FILE" | \
            sed 's/"name":"\([^"]*\)","vendor":"\([^"]*\)","id":"\([^"]*\)"/  \1 (\2) \3/'
    fi
    [ "$KEEP" -eq 1 ] || rm -f "$RESULT_FILE" 2>/dev/null || :
    exit 0
fi

status=$(json_str "$RESULT_FILE" status)
success=$(json_str "$RESULT_FILE" success)

if [ "$JSON_OUTPUT" -eq 1 ]; then
    cat "$RESULT_FILE"
    printf '\n'
    [ "$KEEP" -eq 1 ] || rm -f "$RESULT_FILE" 2>/dev/null || :
    if [ "$status" = "ok" ] || [ "$success" = "true" ]; then
        exit 0
    fi
    exit 2
fi

if [ "$status" = "ok" ] || [ "$success" = "true" ]; then
    echo "OK"
    response=$(json_str "$RESULT_FILE" response)
    [ -z "$response" ] && response=$(json_str "$RESULT_FILE" ai_response)
    if [ -n "$response" ]; then
        printf '%s\n' "$response"
    fi
    mode_used=$(json_str "$RESULT_FILE" modeUsed)
    [ -n "$mode_used" ] && echo "(modeUsed: $mode_used)"
    [ "$KEEP" -eq 1 ] || rm -f "$RESULT_FILE" 2>/dev/null || :
    exit 0
fi

reason=$(json_str "$RESULT_FILE" reason)
[ -z "$reason" ] && reason="$status"
error=$(json_str "$RESULT_FILE" error)
[ -z "$error" ] && error="$reason"
echo "Failed: $error" >&2
[ "$KEEP" -eq 1 ] || rm -f "$RESULT_FILE" 2>/dev/null || :
exit 2
