# S0: VS Code Chat API two-way capability verification (Capability Spike)

> 简体中文：[S0-CAPABILITY-SPIKE.md](S0-CAPABILITY-SPIKE.md)

> Goal: verify the availability of the `visible` two-way capability (human-reply
> capture) in the current VS Code / Copilot version, freeze mode semantics, and
> produce the capability matrix. **Cannot be skipped** (RFC §5).
> Degradation route: if the host API is limited, keep the one-way
> "delivery + poll receipt" semantics (already implemented in M1), and supplement
> `humanReply` through a controlled receipt file; **must not** degrade to GUI automation.

## 1. Prerequisites

- sessbridge extension installed: `powershell -File installer\install.ps1 -Force`
- GitHub Copilot / corresponding LM channel installed and signed in (DeepSeek, etc.)
- Reload the VS Code window so the extension activates

## 2. Run the probe

1. Open a normal VS Code window (extension activates on `onStartupFinished`).
2. Open the integrated terminal (Ctrl+`), confirm `$env:VSCODE_PID` exists.
3. On activation the extension automatically writes two probes
   (channel directory defaults to `%TEMP%\sessbridge`):
   - `diag_<pid>.json`: `extension_activated` probe (chat/lm namespaces, version, API keys)
   - `diag_<pid>-lm.json`: `lm_probe` probe (model count, copilot models)
4. Inspect the probe:
   ```powershell
   $d = "$env:TEMP\sessbridge"
   Get-Content "$d\diag_$(Get-Process Code | Where-Object MainWindowTitle | Select-Object -First 1 -ExpandProperty Id).json"
   ```

## 2.1 Real VS Code runtime smoke (CI)

This smoke uses `@vscode/test-electron@3.1.0` to launch an isolated VS Code
Extension Host — no Copilot sign-in or specific LM provider required. The test
activates `larsonzh.sessbridge`, reads the real `diag_<pid>.json`, then sends an
empty message through the real PID-scoped file channel and verifies the
`status: "no_message"` receipt.

Local Windows (requires Node.js 22, desktop VS Code download network):

```powershell
npm install --no-save --no-package-lock @vscode/test-electron@3.1.0
node tests\run-runtime-smoke.js
```

Local Linux (requires Node.js 22, xvfb, network):

```sh
npm install --no-save --no-package-lock @vscode/test-electron@3.1.0
xvfb-run -a node tests/run-runtime-smoke.js
```

The CI job uses VS Code `1.136.1`; the `.vscode-test/` download cache directory is
ignored. PASS on the local Windows machine on 2026-09-04: Extension Host exit code
`0`, extension version `0.1.0`, real receipt `status: "no_message"`, PID routing
verified.

## 3. Verification results (real VS Code)

| # | Item | Method | Conclusion field |
|---|---|---|---|
| 1 | `vscode.chat` namespace exists | `diag_28012.json` | ✅ `hasChatNamespace=true`, 35 chat keys |
| 2 | `requestHandler` / `createChatParticipant` available | `diag_28012.json` | ✅ participant=true; ❌ requestHandler=false |
| 3 | `vscode.lm.selectChatModels` available | `diag_28012-lm.json` | ✅ 34 models, no probe error |
| 4 | Copilot silent end-to-end | `Auto` probe | ✅ exit 0, `status=ok`, `modeUsed=silent`, non-empty response |
| 5 | DeepSeek silent end-to-end | requestId `s0-deepseek-4`, PID `28012` | ✅ exit 0, `status=ok`, response `S0-OK` |
| 6 | Human-reply capture feasibility | API probe | ⚠️ full capture not feasible; M2 uses a controlled participant |
| 7 | Multi-instance routing | PID-scoped channel + extension `process.ppid` check | ✅ protocol/code path verified; two-window test left for later regression |
| 8 | Legacy protocol compatibility regression | 21 contract tests incl. legacy parity | ✅ tests pass, whois protocol unchanged |

## 4. Conclusions

Results #1–#8 above are synced to `docs/capability-matrix.md`. The M2 session-turn
implementation is decided by the results:
- requestHandler/participant available → capture `humanReply` inside the extension;
  `wait`/`reply` use session turns.
- Not available → keep M1 semantics; `humanReply` supplied by a human/external via a
  controlled receipt file (documented degradation).
