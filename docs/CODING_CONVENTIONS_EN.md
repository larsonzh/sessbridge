# SessionBridge Coding Conventions

> 简体中文：[CODING_CONVENTIONS.md](CODING_CONVENTIONS.md)

> Status: finalized 2026-09-04. Applies to the creation and maintenance of every
> committed file in this repository; legacy files that conflict with this
> specification are migrated per this specification (a one-time `--fix` suffices).

## 1. Encoding + line endings (hard rule)

For cross-platform use (Windows / Linux / macOS, PowerShell 5.1 / Python / Node / Go),
every file **committed to the repository** must satisfy:

| File type | Encoding | Line ending | Notes |
|----------|----------|-------------|-------|
| Markdown (`.md`) | UTF-8 **with BOM** | **LF** | incl. `copilot-instructions.md`, this document |
| PowerShell (`.ps1`) | UTF-8 **with BOM** | **LF** | PS 5.1 read/write compatibility, stable Chinese comments |
| JSON (`.json`) | UTF-8 **with BOM** | **LF** | pure data / golden samples / test fixtures |
| JSON (exception: `extension/package.json`) | UTF-8 **without BOM** | **LF** | strict JSON parsers / packaging tools (npm/vsce) reject BOM |
| Other (`.py`/`.js`/`.go`/`.txt`/`.gitignore`/`LICENSE`…) | UTF-8 **without BOM** | **LF** | code and plain text |

Rationale:

- **BOM**: Windows Notepad / PS 5.1 use BOM to detect UTF-8; BOM on Markdown/PS/JSON
  avoids mojibake in PowerShell 5.1 `Get-Content` and editor misdetection as ANSI.
- **JSON exception**: Node `JSON.parse`, npm, vsce, and VS Code extension manifest
  parsers are BOM-sensitive; `extension/package.json` must be BOM-free.
- **LF**: unified diffs, avoids cross-platform git line-ending warnings and
  shebang/script boundary issues.

### 1.1 Mechanical gate

```powershell
# Check (pre-commit/CI; exits 1 on violations)
python tools\enforce_encoding.py

# Auto-normalize (only encoding/BOM/EOL conversion, no semantic changes)
python tools\enforce_encoding.py --fix
```

Notes:

- Normalization **must not change JSON values, array order, or operation structure** —
  only encoding/line-ending conversion.
- After creating new Markdown/PS1/JSON files, run `--fix` first (or save directly with
  BOM+LF) before committing.
- The exception list must be kept in sync with `EXCEPTIONS_NO_BOM` in
  `tools/enforce_encoding.py`.

## 2. Repository layout (do not move at will)

```
extension/        VS Code extension (JS, no build step; package.json BOM-free)
client/
  sessbridge.py   Python CLI (send/wait/reply/discover, stdlib only)
  sessbridge.sh   POSIX sh client (Linux/macOS; no Python/Node dependency)
  ps/sessbridge.ps1   PowerShell compat layer (Windows; same contract as Python)
installer/        install/uninstall scripts
tests/            golden samples + contract tests (python tests\test_contract.py)
tools/            engineering tools (enforce_encoding.py etc.)
docs/             protocol/RFC/guide/troubleshooting/capability matrix
```

## 3. Contract discipline

- The channel protocol is governed solely by `docs/RFC-sessbridge-channel-protocol-v1.md`;
  client (Python/PS/sh) and extension behavior are locked by `tests/golden/*.json` +
  `tests/test_contract.py`.
- **Anti-drift for dual implementations**: Python, PowerShell, and sh clients must keep
  the same contract; when adding fields/behaviors, update RFC → golden samples →
  contract tests first; never change only one side.
- Exit-code contract: `0` success / `1` local transport failure / `2` extension-side
  failure / `3` validation failure.
- `requestId` receipt binding: before writing a command, first remove stale results for
  the same requestId (delete old results before writing the new command).
- Command files and receipt files are **both written atomically** (same-directory temp
  file + rename/replace); the extension keeps a requestId idempotent replay cache for
  success receipts (5 min / 50 entries); retries reuse the requestId without repeating
  side effects.
- PowerShell 5.1 compatibility: keep script comments pure ASCII (or confirmed UTF-8 BOM);
  no inline `$(if (...) { ... } else { ... })` subexpressions (historical pitfall).
- When writing JSON files for Node to parse, use BOM-free encoding (`WriteAllText` +
  `UTF8Encoding($false)` or Python `json.dump`).

## 3.1 Temporary files (tmp/)

- The repository root `tmp/` holds **temporary/one-off** files (test artifacts, debug
  snapshots, intermediate scripts, etc.); it is `.gitignore`d (keep `tmp/.gitkeep` so the
  directory exists after clone).
- **Clean up temporary files promptly** after use: delete at session/debug end; do not
  leave them in `tmp/` long-term.
- The encoding gate (`tools/enforce_encoding.py`) skips `tmp/`; cleanup duty remains with
  the user.

## 4. Chat tool adapter (extension-side seam)

- The extension currently adapts **Copilot Chat** by default (`SESSBRIDGE_CHAT_TOOL=copilot`);
  the only dependency surface is `TOOL_ADAPTERS` in `extension/extension.js`:
  - `panelCommands`: chat panel command IDs (open/focus/submit/queue/cancel/removePending/paste)
  - `hasLmApi()` / `selectModels()` / `sendLm()`: dialog model API wrappers
- When integrating **Continue or other chat tools** later:
  1. Add the corresponding adapter to `TOOL_ADAPTERS` (same `toolKey/panelCommands/LM API wrapper`);
  2. Clients and the channel protocol **stay unchanged** (protocol is tool-agnostic);
  3. Update the capability matrix and this document, keep `copilot` as the default.
- The extension must not sprinkle hardcoded `workbench.action.chat.*` (legacy leftover);
  new code always goes through `runPanelCommand()`/the adapter.

## 5. Git discipline

- Push to `origin` by default; **gitee is only a mirror** — without the user's explicit
  request in the same turn, **never** push to gitee.
- Without the user's explicit authorization in the same turn, **never** `git commit` /
  `git push`.
- Commit message style: `<type>: <summary>` (chore/feat/fix/docs/test/build).

## 6. Documentation

- Root `README.md`: quick start and positioning; `docs/SESSBRIDGE_README.md` (中文):
  full guide; `docs/SESSBRIDGE_TROUBLESHOOTING_CN.md` (中文): quick troubleshooting.
- English counterparts: `docs/SESSBRIDGE_README_EN.md`, `docs/SESSBRIDGE_TROUBLESHOOTING_EN.md`,
  plus `_EN` versions of the dev plan / S0 spike / capability matrix where applicable.
- The capability matrix (`docs/capability-matrix.md`) is filled after the S0 probe;
  `docs/DEV_PLAN.md` tracks milestones.
