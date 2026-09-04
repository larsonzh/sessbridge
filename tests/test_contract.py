"""SessionBridge channel protocol contract tests (stdlib only).

Verifies the client contract against golden samples and a mock extension:
  - exit codes 0/1/2/3 (RFC §4.3)
  - new protocol envelope / receipt shapes (RFC §4.1/4.2)
  - legacy protocol compatibility (whois IPC Chat Sender dialect)
  - requestId binding, discovery, timeout, validation

Run:  python tests/test_contract.py
"""

import importlib.util
import io
import json
import os
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Load the client module by path (keeps the test self-contained, no sys.path
# pollution and no interpreter-site import of an installed `sessbridge`).
_spec = importlib.util.spec_from_file_location(
    'sessbridge_client', os.path.join(ROOT, 'client', 'sessbridge.py'))
sessbridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sessbridge)

import tempfile as _tempfile  # noqa: E402

GOLDEN = os.path.join(ROOT, 'tests', 'golden')
FAKE_PID = 424242
ISO = '2026-09-04T00:00:05Z'


def load_golden(name):
    # Golden fixtures may carry a UTF-8 BOM (editor-written); read robustly.
    with open(os.path.join(GOLDEN, name), encoding='utf-8-sig') as f:
        return json.load(f)


class MockReceiver(threading.Thread):
    """Acts like the SessionBridge extension: pick up cmd, write res."""

    def __init__(self, cmd_file, res_file, res_factory, snapshots=None):
        super().__init__(daemon=True)
        self.cmd_file = cmd_file
        self.res_file = res_file
        self.res_factory = res_factory
        self.snapshots = snapshots if snapshots is not None else []
        self.seen = threading.Event()

    def run(self):
        deadline = time.time() + 5
        while time.time() < deadline:
            if os.path.isfile(self.cmd_file):
                try:
                    with open(self.cmd_file, encoding='utf-8') as f:
                        data = json.load(f)
                except (OSError, ValueError):
                    time.sleep(0.02)
                    continue
                try:
                    os.unlink(self.cmd_file)
                except OSError:
                    pass
                self.snapshots.append(data)
                res = self.res_factory(data)
                with open(self.res_file, 'w', encoding='utf-8') as f:
                    json.dump(res, f, ensure_ascii=False)
                self.seen.set()
                return
            time.sleep(0.02)


def ok_visible(data):
    return {
        'schemaVersion': '1', 'requestId': data.get('requestId', data.get('request_id', '')),
        'status': 'ok', 'mode': data.get('mode', 'visible'), 'response': '',
        'humanReply': '', 'error': '', 'polledMs': 0,
        'extensionVersion': '0.1.0', 'finishedAt': ISO, 'modeUsed': 'visible',
    }


def ok_silent(data):
    return {
        'schemaVersion': '1', 'requestId': data.get('requestId', data.get('request_id', '')),
        'status': 'ok', 'mode': 'silent', 'response': 'nominal', 'humanReply': '',
        'error': '', 'polledMs': 100, 'extensionVersion': '0.1.0',
        'finishedAt': ISO, 'modeUsed': 'silent',
        'model': {'name': 'DeepSeek V4 Flash', 'vendor': 'deepseek', 'id': 'deepseek-v4-flash'},
    }


def lm_unavailable(data):
    return {
        'schemaVersion': '1', 'requestId': data.get('requestId', data.get('request_id', '')),
        'status': 'lm_api_unavailable', 'mode': 'silent', 'response': '', 'humanReply': '',
        'error': 'lm_api_unavailable', 'polledMs': 0,
        'extensionVersion': '0.1.0', 'finishedAt': ISO,
    }


def discovery(data):
    return {
        'schemaVersion': '1', 'requestId': data.get('requestId', data.get('request_id', '')),
        'status': 'discovery', 'mode': 'visible', 'response': '', 'humanReply': '',
        'error': '', 'polledMs': 0, 'extensionVersion': '0.1.0', 'finishedAt': ISO,
        'models': [{'name': 'DeepSeek V4 Flash', 'vendor': 'deepseek', 'id': 'deepseek-v4-flash',
                    'family': 'deepseek', 'version': 'v4', 'maxInputTokens': 128000}],
    }


def legacy_ok(data):
    return {
        'success': True, 'reason': 'sent_via_clipboard_fallback',
        'request_id': data.get('request_id', data.get('requestId', '')),
        'priority': data.get('priority', 'normal'),
    }


class ContractTestCase(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='sessbridge-test-')
        self.channel = os.path.join(self.tmp, 'channel')
        self._old_vscode_pid = os.environ.get('VSCODE_PID')
        self._old_channel = os.environ.get('SESSBRIDGE_CHANNEL_DIR')
        os.environ['VSCODE_PID'] = str(FAKE_PID)
        os.environ['SESSBRIDGE_CHANNEL_DIR'] = self.channel

    def tearDown(self):
        if self._old_vscode_pid is None:
            os.environ.pop('VSCODE_PID', None)
        else:
            os.environ['VSCODE_PID'] = self._old_vscode_pid
        if self._old_channel is None:
            os.environ.pop('SESSBRIDGE_CHANNEL_DIR', None)
        else:
            os.environ['SESSBRIDGE_CHANNEL_DIR'] = self._old_channel

    def run_client(self, argv, timeout=10):
        result = {}
        def target():
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = sessbridge.main(argv)
            result['code'] = code
            result['stdout'] = buf.getvalue()
        t = threading.Thread(target=target, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            raise AssertionError('client did not finish in time: %r' % (argv,))
        return result['code'], result['stdout']

    # ---- new protocol --------------------------------------------------
    def test_send_visible_success_exit0(self):
        cmd_file = os.path.join(self.channel, 'cmd_%d.json' % FAKE_PID)
        res_file = os.path.join(self.channel, 'res_%d.json' % FAKE_PID)
        snap = []
        mock = MockReceiver(cmd_file, res_file, ok_visible, snap)
        mock.start()
        code, out = self.run_client(['send', '--message', 'hello from contract'])
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(res_file))
        self.assertEqual(len(snap), 1)
        env = snap[0]
        self.assertEqual(env['schemaVersion'], '1')
        self.assertTrue(env['requestId'].startswith('sess-'))
        self.assertEqual(env['mode'], 'visible')
        self.assertEqual(env['priority'], 'normal')
        self.assertEqual(env['message'], 'hello from contract')
        self.assertEqual(env['targetPid'], FAKE_PID)
        self.assertEqual(env['timeoutMs'], 30000)
        self.assertIs(env['legacy'], False)
        self.assertFalse(env.get('request_id'))

    def test_envelope_keys_match_golden(self):
        cmd_file = os.path.join(self.channel, 'cmd_%d.json' % FAKE_PID)
        res_file = os.path.join(self.channel, 'res_%d.json' % FAKE_PID)
        snap = []
        mock = MockReceiver(cmd_file, res_file, ok_visible, snap)
        mock.start()
        code, _ = self.run_client(['send', '--message', 'hello from contract'])
        self.assertEqual(code, 0)
        golden = load_golden('cmd_visible.new.json')
        self.assertEqual(sorted(snap[0].keys()), sorted(golden.keys()))

    def test_send_silent_captures_response(self):
        cmd_file = os.path.join(self.channel, 'cmd_%d.json' % FAKE_PID)
        res_file = os.path.join(self.channel, 'res_%d.json' % FAKE_PID)
        mock = MockReceiver(cmd_file, res_file, ok_silent)
        mock.start()
        code, out = self.run_client(['send', '--message', 'status', '--mode', 'silent',
                                     '--json-output'])
        self.assertEqual(code, 0)
        receipt = json.loads(out)
        self.assertEqual(receipt['status'], 'ok')
        self.assertEqual(receipt['modeUsed'], 'silent')
        self.assertEqual(receipt['response'], 'nominal')

    def test_send_lm_api_unavailable_exit2(self):
        cmd_file = os.path.join(self.channel, 'cmd_%d.json' % FAKE_PID)
        res_file = os.path.join(self.channel, 'res_%d.json' % FAKE_PID)
        mock = MockReceiver(cmd_file, res_file, lm_unavailable)
        mock.start()
        code, out = self.run_client(['send', '--message', 'x', '--mode', 'silent', '--json-output'])
        self.assertEqual(code, 2)
        receipt = json.loads(out)
        self.assertEqual(receipt['status'], 'lm_api_unavailable')

    def test_send_timeout_exit1(self):
        code, out = self.run_client(['send', '--message', 'x', '--timeout', '1',
                                     '--poll-interval', '100'])
        self.assertEqual(code, 1)

    def test_empty_message_exit3(self):
        code, _ = self.run_client(['send', '--message', ''])
        self.assertEqual(code, 3)

    def test_discover_exit0(self):
        cmd_file = os.path.join(self.channel, 'cmd_%d.json' % FAKE_PID)
        res_file = os.path.join(self.channel, 'res_%d.json' % FAKE_PID)
        snap = []
        mock = MockReceiver(cmd_file, res_file, discovery, snap)
        mock.start()
        code, out = self.run_client(['discover', '--json-output'])
        self.assertEqual(code, 0)
        self.assertTrue(snap[0].get('discover') is True)
        receipt = json.loads(out)
        self.assertEqual(receipt['status'], 'discovery')
        self.assertEqual(len(receipt['models']), 1)

    def test_wait_without_id_exit3(self):
        code, _ = self.run_client(['wait'])
        self.assertEqual(code, 3)

    # ---- legacy protocol -----------------------------------------------
    def test_legacy_files_and_payload(self):
        # Patch temp dir so legacy files land in the test sandbox.
        orig = _tempfile.gettempdir
        _tempfile.gettempdir = lambda: self.tmp
        try:
            cmd_file = os.path.join(self.tmp, 'vscode_chat_send_cmd_%d.json' % FAKE_PID)
            res_file = os.path.join(self.tmp, 'vscode_chat_send_res_%d.json' % FAKE_PID)
            snap = []
            mock = MockReceiver(cmd_file, res_file, legacy_ok, snap)
            mock.start()
            code, out = self.run_client(['send', '--message', 'legacy hello', '--legacy',
                                         '--json-output'])
            self.assertEqual(code, 0)
            self.assertEqual(len(snap), 1)
            payload = snap[0]
            self.assertNotIn('requestId', payload)
            self.assertTrue(payload['request_id'].startswith('sess-'))
            self.assertEqual(payload['mode'], 'visible')
            self.assertEqual(payload['discover'], False)
            self.assertNotIn('schemaVersion', payload)
            self.assertFalse(os.path.exists(cmd_file))  # mock consumed
            # legacy receipt shape: success/reason/request_id
            receipt = json.loads(out)
            self.assertTrue(receipt['success'])
            self.assertEqual(receipt['reason'], 'sent_via_clipboard_fallback')
        finally:
            _tempfile.gettempdir = orig

    def test_legacy_golden_parity(self):
        orig = _tempfile.gettempdir
        _tempfile.gettempdir = lambda: self.tmp
        try:
            cmd_file = os.path.join(self.tmp, 'vscode_chat_send_cmd_%d.json' % FAKE_PID)
            res_file = os.path.join(self.tmp, 'vscode_chat_send_res_%d.json' % FAKE_PID)
            snap = []
            mock = MockReceiver(cmd_file, res_file, legacy_ok, snap)
            mock.start()
            code, _ = self.run_client(['send', '--message', 'hello from golden', '--legacy'])
            self.assertEqual(code, 0)
            golden = load_golden('cmd_legacy.json')
            self.assertEqual(sorted(snap[0].keys()), sorted(golden.keys()))
        finally:
            _tempfile.gettempdir = orig

    def test_reply_requires_conversation(self):
        code, _ = self.run_client(['reply', '--message', 'ok'])
        self.assertEqual(code, 3)

    def test_reply_ok(self):
        cmd_file = os.path.join(self.channel, 'cmd_%d.json' % FAKE_PID)
        res_file = os.path.join(self.channel, 'res_%d.json' % FAKE_PID)
        snap = []
        mock = MockReceiver(cmd_file, res_file, ok_visible, snap)
        mock.start()
        code, _ = self.run_client(['reply', '--message', 'ok', '--conversation-id', 'conv-x'])
        self.assertEqual(code, 0)
        self.assertEqual(snap[0]['conversationId'], 'conv-x')


if __name__ == '__main__':
    unittest.main(verbosity=2)
