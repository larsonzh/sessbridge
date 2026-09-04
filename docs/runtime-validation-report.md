# Runtime Validation Report

**Generated**: 2026-09-04
**Target**: `sessbridge` VS Code extension

## Summary

| Step | Status | Exit Code | Details |
|---|---|---:|---|
| Extension Host startup | PASS | 0 | VS Code 1.136.1 launched through `@vscode/test-electron@3.1.0` |
| Extension activation | PASS | 0 | `larsonzh.sessbridge` activated; `diag_<pid>.json` received |
| File IPC smoke | PASS | 0 | Atomic `cmd_<pid>.json` consumed; matching `status: "no_message"` receipt returned |
| LM provider call | UNVERIFIED | n/a | Intentionally excluded; requires Copilot authentication/provider availability |

## Environment

- OS: Windows
- Node.js: 24.17.0
- VS Code: 1.136.1
- Test runner: `@vscode/test-electron@3.1.0`
- Scope: isolated Extension Host and temporary SessionBridge channel directory

## Test Evidence

- Launcher: `tests/run-runtime-smoke.js`
- Extension Host suite: `tests/runtime-smoke/index.js`
- Command schema: v1, PID-scoped new channel
- Assertions: extension discovery, activation, diagnostic PID, command consumption, requestId binding, and `no_message` receipt

## Known Gaps

- CI executes the same smoke on Ubuntu with xvfb; the local evidence above is Windows-only.
- LM calls remain covered by the separate S0 real VS Code/provider verification because CI has no Copilot login or model credentials.

**Overall**: PASS for the Extension Host and file IPC runtime smoke scope.
