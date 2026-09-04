#!/usr/bin/env python3
"""SessionBridge client — two-way session bridge CLI for VS Code Copilot Chat.

Pure file-based IPC (no UI automation).  Speaks the channel protocol v1
(RFC-sessbridge-channel-protocol-v1.md) and a legacy compatibility dialect
inherited from whois' IPC Chat Sender.

Commands:
    sessbridge send      --message "..."        deliver a message, wait for receipt
    sessbridge wait      --request-id/--conversation-id   wait for an existing receipt
    sessbridge reply     --message "..." --conversation-id ...   continue a conversation
    sessbridge discover                          list available LM models

Exit codes (contract, same as whois):
    0   success (receipt with status ok / discovery)
    1   local transport failure (poll_timeout / write_cmd_failed)
    2   extension-side failure (status lm_api_unavailable / extension_error ...)
    3   validation error

Stdlib only.  Cross-platform (Windows / Linux / macOS).
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone


SCHEMA_VERSION = '1'


# ---------------------------------------------------------------------------
# Paths / identity
# ---------------------------------------------------------------------------

def channel_dir() -> str:
    """Channel directory: SESSBRIDGE_CHANNEL_DIR override or default temp dir."""
    env = os.environ.get('SESSBRIDGE_CHANNEL_DIR', '').strip()
    if env:
        return env
    return os.path.join(tempfile.gettempdir(), 'sessbridge')


def resolve_target_pid(preferred_pid: int) -> int:
    """Auto-detect the target VS Code main-window PID.

    Order: preferred (verified Code process) -> $VSCODE_PID -> first Code.exe
    with a window title (Windows) / best-effort `ps` on POSIX.
    Returns 0 if undetectable (caller falls back to legacy shared files).
    """
    if preferred_pid > 0:
        if _is_code_process(preferred_pid):
            return preferred_pid
        preferred_pid = 0

    vscode_pid = os.environ.get('VSCODE_PID', '').strip()
    if vscode_pid:
        try:
            pid = int(vscode_pid)
            if pid > 0:
                return pid
        except ValueError:
            pass

    return _detect_code_process()


def _is_code_process(pid: int) -> bool:
    if sys.platform.startswith('win'):
        try:
            result = subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 f'Get-Process -Id {pid} -ErrorAction SilentlyContinue | '
                 f'Where-Object {{ $_.Name -eq "Code" }} | Select-Object -ExpandProperty Id'],
                capture_output=True, text=True, timeout=5)
            return result.returncode == 0 and result.stdout.strip() != ''
        except Exception:
            return False
    try:
        r = subprocess.run(['ps', '-p', str(pid), '-o', 'comm='], capture_output=True, text=True, timeout=5)
        return r.returncode == 0 and 'code' in r.stdout.lower()
    except Exception:
        return False


def _detect_code_process() -> int:
    if sys.platform.startswith('win'):
        try:
            result = subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 'Get-Process -Name Code -ErrorAction SilentlyContinue | '
                 'Where-Object { -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } | '
                 'Sort-Object StartTime -Descending | '
                 'Select-Object -First 1 -ExpandProperty Id'],
                capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                raw = result.stdout.strip()
                if raw:
                    return int(raw)
        except Exception:
            pass
        return 0
    # POSIX best effort: newest code process.
    try:
        r = subprocess.run(['pgrep', '-n', 'code'], capture_output=True, text=True, timeout=5)
        return int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 0
    except Exception:
        return 0


def get_file_paths(pid: int, legacy: bool):
    """Return (cmd_file, res_file, is_legacy_channel).

    - legacy=True          -> whois old names (PID-scoped or shared)
    - legacy=False, pid>0  -> new channel dir names
    - legacy=False, pid==0 -> legacy shared names (compat fallback, RFC §3.2)
    """
    if legacy:
        if pid > 0:
            return (os.path.join(tempfile.gettempdir(), f'vscode_chat_send_cmd_{pid}.json'),
                    os.path.join(tempfile.gettempdir(), f'vscode_chat_send_res_{pid}.json'),
                    True)
        return (os.path.join(tempfile.gettempdir(), 'vscode_chat_send_cmd.json'),
                os.path.join(tempfile.gettempdir(), 'vscode_chat_send_result.json'),
                True)
    if pid > 0:
        d = channel_dir()
        os.makedirs(d, exist_ok=True)
        return (os.path.join(d, f'cmd_{pid}.json'),
                os.path.join(d, f'res_{pid}.json'),
                False)
    # No PID and not legacy: fall back to legacy shared (compat).
    return (os.path.join(tempfile.gettempdir(), 'vscode_chat_send_cmd.json'),
            os.path.join(tempfile.gettempdir(), 'vscode_chat_send_result.json'),
            True)


# ---------------------------------------------------------------------------
# Envelope building
# ---------------------------------------------------------------------------

def build_new_envelope(args, request_id: str, message: str, target_pid: int,
                       discover: bool = False) -> dict:
    env = {
        'schemaVersion': SCHEMA_VERSION,
        'requestId': request_id,
        'mode': args.mode,
        'priority': args.priority,
        'message': message,
        'targetPid': target_pid,
        'timeoutMs': args.timeout * 1000,
        'createdAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'legacy': False,
    }
    if discover:
        env['discover'] = True
    if args.lm_response_timeout_ms > 0:
        env['lmResponseTimeoutMs'] = args.lm_response_timeout_ms
    if args.conversation_id:
        env['conversationId'] = args.conversation_id
    if args.turn_id is not None:
        env['turnId'] = args.turn_id
    if args.model:
        env['model'] = args.model
    return env


def build_legacy_payload(args, request_id: str, message: str, discover: bool) -> dict:
    payload = {
        'message': message,
        'request_id': request_id,
        'priority': args.priority,
        'mode': args.mode,
        'model': args.model,
        'discover': discover,
    }
    if args.model_options is not None:
        payload['model_options'] = args.model_options
    if args.lm_response_timeout_ms > 0:
        payload['lm_response_timeout_ms'] = args.lm_response_timeout_ms
    return payload


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

def send_and_poll(cmd_file, res_file, payload, args, discover: bool):
    """Write cmd, poll for receipt.  Returns outcome dict or None on timeout."""
    # RFC §4.1: remove stale result BEFORE writing the command (prevents
    # accidentally deleting a fresh receipt → false poll_timeout).
    if os.path.isfile(res_file):
        try:
            os.unlink(res_file)
        except OSError:
            pass

    try:
        # Atomic command write (F8): write a sibling temp file, then rename
        # into place.  The extension polls for the file; a partially-written
        # command (non-atomic direct write) would be parsed as malformed and
        # quarantined, or — worse — re-read every poll tick.
        tmp_cmd = '%s.tmp-%d-%s' % (cmd_file, os.getpid(), uuid.uuid4().hex[:8])
        with open(tmp_cmd, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp_cmd, cmd_file)
    except OSError as exc:
        return {'success': False, 'reason': f'write_cmd_failed:{exc}',
                'request_id': payload.get('request_id', payload.get('requestId', ''))}

    poll_interval = max(0.05, args.poll_interval / 1000.0)
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        if os.path.isfile(res_file):
            try:
                with open(res_file, 'r', encoding='utf-8') as f:
                    outcome = json.load(f)
                if _receipt_matches(outcome, payload, discover, args):
                    if not args.keep:
                        try:
                            os.unlink(res_file)
                        except OSError:
                            pass
                    return outcome
            except (OSError, ValueError):
                pass
        time.sleep(poll_interval)

    # Timeout — clean up command file.
    if os.path.isfile(cmd_file):
        try:
            os.unlink(cmd_file)
        except OSError:
            pass
    return None


def _receipt_matches(outcome, payload, discover: bool, args) -> bool:
    """New schema: requestId back; legacy: request_id back (or discovery legacy)."""
    if isinstance(outcome, dict):
        rid_new = str(outcome.get('requestId') or '')
        rid_old = str(outcome.get('request_id') or '')
        rid = rid_new or rid_old
        expected = payload.get('requestId') or payload.get('request_id') or ''
        if rid:
            return rid == expected
        # Legacy discovery may omit request_id.
        reason = str(outcome.get('reason') or '')
        status = str(outcome.get('status') or '')
        if discover and not rid and reason in ('discovery', 'discovery_failed'):
            return True
        if discover and not rid and status in ('discovery', 'discovery_failed'):
            return True
    return False


def normalize_outcome(outcome: dict) -> dict:
    """Fold new-schema receipt into the legacy-shaped outcome contract
    while preserving new-schema fields (status/modeUsed/model/...)."""
    if outcome.get('schemaVersion') is not None:
        status = str(outcome.get('status') or '')
        folded = {
            'success': status in ('ok', 'discovery'),
            'reason': status,
            'request_id': outcome.get('requestId') or '',
            'status': status,
            'response': outcome.get('response') or '',
            'humanReply': outcome.get('humanReply') or '',
            'mode': outcome.get('mode') or '',
            'conversationId': outcome.get('conversationId') or '',
            'turnId': outcome.get('turnId'),
            'error': outcome.get('error') or '',
            'models': outcome.get('models'),
            'model': outcome.get('model'),
            'aiResponseTruncated': outcome.get('aiResponseTruncated'),
            'extensionVersion': outcome.get('extensionVersion') or '',
            'finishedAt': outcome.get('finishedAt') or '',
            'polledMs': outcome.get('polledMs') or 0,
        }
        for key, value in outcome.items():
            if key not in folded:
                folded[key] = value
        return folded
    return outcome


def finalize_and_exit(outcome, args, discover: bool, target_pid: int) -> int:
    if outcome is None:
        outcome = {'success': False, 'reason': 'poll_timeout',
                   'request_id': args.request_id}
    outcome = normalize_outcome(outcome)
    if args.request_id and not outcome.get('request_id'):
        outcome['request_id'] = args.request_id

    if args.json_output:
        if not isinstance(outcome, dict):
            outcome = dict(outcome)
        outcome['target_pid'] = target_pid
        print(json.dumps(outcome, ensure_ascii=False))
    else:
        _print_human(outcome, discover)

    if outcome.get('success'):
        return 0
    reason = str(outcome.get('reason') or '')
    is_local = (reason == 'poll_timeout') or reason.startswith('write_cmd_failed')
    return 1 if is_local else 2


def _print_human(outcome: dict, discover: bool) -> None:
    if discover and outcome.get('success') and isinstance(outcome.get('models'), list):
        models = outcome['models']
        print(f"Available Models (total {len(models)}):")
        for m in models:
            print(f"  {str(m.get('name') or ''):40} {str(m.get('id') or '')[:30]} "
                  f"{str(m.get('vendor') or '')[:20]} {str(m.get('family') or '')[:20]}")
        return
    if outcome.get('success'):
        print("OK")
        if outcome.get('response'):
            print(outcome['response'])
        return
    print(f"Failed: {outcome.get('reason') or 'unknown'}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def print_discovery_models(models):
    ordered = sorted(models, key=lambda m: (str(m.get('vendor') or ''), str(m.get('name') or '')))
    print()
    print('Available Models (grouped by vendor):')
    print('-' * 140)
    header = f"{'Model Name':40} {'ID':30} {'Family':22} {'Version':22} {'MaxInputTokens':14}"
    for vendor in sorted({str(m.get('vendor') or 'unknown') for m in ordered}):
        print()
        print(f'[{vendor}]')
        print(header)
        print('-' * len(header))
        for m in ordered:
            if str(m.get('vendor') or 'unknown') != vendor:
                continue
            max_tokens = m.get('maxInputTokens')
            max_tokens_text = f'{max_tokens:,}' if isinstance(max_tokens, int) else ('-' if max_tokens is None else str(max_tokens))
            print(f"{str(m.get('name') or '')[:40]:40} {str(m.get('id') or '')[:30]:30} "
                  f"{str(m.get('family') or '')[:22]:22} {str(m.get('version') or '')[:22]:22} "
                  f"{max_tokens_text:>14}")
    print('-' * 140)
    print(f'[{len(ordered)} model(s) total]')


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='sessbridge',
        description='SessionBridge client — two-way session bridge to VS Code Copilot Chat.')

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--request-id', default='', help='Receipt binding id (auto: sess-<uuid>)')
    common.add_argument('--target-pid', type=int, default=0, help='Target VS Code main-window PID (0 = auto)')
    common.add_argument('--channel-dir', default='', help='Override channel directory (default: SESSBRIDGE_CHANNEL_DIR or %TEMP%\\sessbridge)')
    common.add_argument('--timeout', type=int, default=30, help='Seconds to wait for receipt (default 30)')
    common.add_argument('--poll-interval', type=int, default=200, help='Poll interval ms (default 200)')
    common.add_argument('--json-output', action='store_true', help='Print receipt as JSON')
    common.add_argument('--keep', action='store_true', help='Keep receipt file after reading')
    common.add_argument('--legacy', action='store_true', help='Legacy IPC mode (whois file names/payload)')
    common.add_argument('--mode', default='visible', choices=['visible', 'silent', 'auto'],
                        help='Delivery mode (default visible)')
    common.add_argument('--priority', default='normal', choices=['normal', 'high'],
                        help='Send priority (default normal)')
    common.add_argument('--auto-escalate', action='store_true',
                        help='normal timeout -> retry with high')
    common.add_argument('--model', default='', help='Preferred LM model name/id (silent/auto)')
    common.add_argument('--model-options', type=json.loads, default=None,
                        help='JSON object of LM model options, e.g. \'{"thinking_mode":"deep"}\'')
    common.add_argument('--lm-response-timeout-ms', type=int, default=0,
                        help='Per-request LM response timeout (1000-3600000)')
    common.add_argument('--conversation-id', default='', help='Existing conversation context id')
    common.add_argument('--turn-id', type=int, default=None, help='Turn number (0 = new turn)')

    sub = parser.add_subparsers(dest='command', required=True)

    p_send = sub.add_parser('send', parents=[common])
    p_send.add_argument('--message', default='', help='Message text to deliver')

    p_wait = sub.add_parser('wait', parents=[common])
    p_wait.add_argument('--message', help=argparse.SUPPRESS)
    p_wait.add_argument('--res-file', default='', help='Explicit receipt file path (advanced)')

    p_reply = sub.add_parser('reply', parents=[common])
    p_reply.add_argument('--message', default='', help='Reply message text')

    p_discover = sub.add_parser('discover', parents=[common])
    p_discover.add_argument('--message', help=argparse.SUPPRESS)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    cmd = args.command
    discover = cmd == 'discover'
    legacy = args.legacy or os.environ.get('SESSBRIDGE_LEGACY', '').strip().lower() in ('1', 'true', 'yes')

    # --channel-dir parity with PowerShell's -ChannelDir: applies for the
    # whole process (channel_dir()/get_file_paths read the env var).
    if args.channel_dir:
        os.environ['SESSBRIDGE_CHANNEL_DIR'] = args.channel_dir

    if cmd == 'send':
        message = args.message.strip()
        if not message:
            print(json.dumps({'success': False, 'reason': 'empty_message'}) if args.json_output
                  else 'Failed: empty_message', file=sys.stderr)
            return 3
    elif cmd == 'reply':
        message = args.message.strip()
        if not message:
            print('Failed: empty_message', file=sys.stderr)
            return 3
        if not args.conversation_id:
            print('Failed: reply requires --conversation-id', file=sys.stderr)
            return 3
    elif cmd == 'wait':
        message = ''
        if not args.request_id and not args.conversation_id:
            print('Failed: wait requires --request-id or --conversation-id', file=sys.stderr)
            return 3
    else:  # discover
        message = ''

    request_id_input = (args.request_id or '').strip()
    effective_request_id = request_id_input or f'sess-{uuid.uuid4().hex}'

    target_pid = resolve_target_pid(args.target_pid)
    cmd_file, res_file, is_legacy_channel = get_file_paths(target_pid, legacy)

    if cmd == 'wait':
        return _wait_impl(args, cmd_file, res_file, is_legacy_channel, target_pid, effective_request_id)

    if legacy or is_legacy_channel:
        payload = build_legacy_payload(args, effective_request_id, message, discover)
    else:
        payload = build_new_envelope(args, effective_request_id, message, target_pid, discover)

    # First attempt with configured priority.
    outcome = send_and_poll(cmd_file, res_file, payload, args, discover)

    # Auto-escalate: normal timeout -> retry with high.
    escalated = False
    if outcome is None and args.auto_escalate and args.priority == 'normal':
        args.priority = 'high'
        if legacy or is_legacy_channel:
            payload = build_legacy_payload(args, effective_request_id, message, discover)
        else:
            payload = build_new_envelope(args, effective_request_id, message, target_pid, discover)
        outcome = send_and_poll(cmd_file, res_file, payload, args, discover)
        escalated = outcome is not None

    if outcome is not None and escalated:
        outcome = dict(outcome)
        outcome['escalated'] = True
        outcome['escalated_reason'] = 'normal_timeout_retry_with_high'

    code = finalize_and_exit(outcome, args, discover, target_pid)
    if discover and not args.json_output and outcome and outcome.get('success') and isinstance(outcome.get('models'), list):
        print_discovery_models(outcome['models'])
    return code


def _wait_impl(args, cmd_file, res_file, is_legacy_channel, target_pid, request_id) -> int:
    """Wait for an existing receipt (already issued by another process/sender).

    Polls the channel directory for result files whose requestId /
    conversationId match.  Defaults to the resolved (cmd,res) pair's res file.
    """
    poll_interval = max(0.05, args.poll_interval / 1000.0)
    deadline = time.time() + args.timeout
    candidates = set()
    if args.res_file:
        candidates.add(args.res_file)
    else:
        candidates.add(res_file)
        d = channel_dir()
        if os.path.isdir(d):
            for name in os.listdir(d):
                if name.startswith('res_') and name.endswith('.json'):
                    candidates.add(os.path.join(d, name))

    while time.time() < deadline:
        for f in list(candidates):
            if not os.path.isfile(f):
                continue
            try:
                with open(f, 'r', encoding='utf-8') as fh:
                    outcome = json.load(fh)
            except (OSError, ValueError):
                continue
            rid = str(outcome.get('requestId') or outcome.get('request_id') or '')
            cid = str(outcome.get('conversationId') or '')
            if (args.request_id and rid != args.request_id):
                continue
            if (args.conversation_id and cid != args.conversation_id):
                continue
            if not args.keep:
                try:
                    os.unlink(f)
                except OSError:
                    pass
            return finalize_and_exit(outcome, args, False, target_pid)
        time.sleep(poll_interval)

    outcome = {'success': False, 'reason': 'poll_timeout', 'request_id': request_id}
    return finalize_and_exit(outcome, args, False, target_pid)


if __name__ == '__main__':
    sys.exit(main())
