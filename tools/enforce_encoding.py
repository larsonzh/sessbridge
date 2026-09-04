#!/usr/bin/env python3
"""Enforce repository encoding + line-ending rules for sessbridge.

Rules (see docs/CODING_CONVENTIONS.md):
  .md / .ps1 / .json   -> UTF-8 with BOM + LF
      exception: .json consumed by strict JSON parsers (package manifests)
      -> UTF-8 without BOM + LF
  all other files      -> UTF-8 without BOM + LF

Usage:
  python tools/enforce_encoding.py            # check (exit 1 if violations)
  python tools/enforce_encoding.py --fix      # normalize files in place
"""

import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# JSON files that MUST stay UTF-8 without BOM (strict parsers / tooling).
EXCEPTIONS_NO_BOM = {
    'extension/package.json',
}

BOM_EXTS = {'.md', '.ps1', '.json'}
SKIP_DIRS = {'.git', '__pycache__', 'node_modules', '.venv', 'venv', 'out', 'dist', 'tmp', '.vscode-test'}


def iter_files(root):
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in fn:
            yield os.path.join(dp, f)


def want_bom(p, root):
    rel = os.path.relpath(p, root).replace('\\', '/')
    if rel in EXCEPTIONS_NO_BOM:
        return False
    return os.path.splitext(p)[1].lower() in BOM_EXTS


def scan(root):
    """Return list of (relpath, current_state, want_state, detail)."""
    problems = []
    for p in iter_files(root):
        try:
            with open(p, 'rb') as fh:
                raw = fh.read()
        except OSError:
            continue
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            problems.append((os.path.relpath(p, root), 'not-utf-8', 'utf-8'))
            continue
        has_bom = raw.startswith(b'\xef\xbb\xbf')
        want = want_bom(p, root)
        text_lf = text.replace('\r\n', '\n').replace('\r', '\n')
        new_raw = (b'\xef\xbb\xbf' if want else b'') + text_lf.encode('utf-8')
        cur_state = 'bom' if has_bom else 'nobom'
        want_state = 'bom' if want else 'nobom'
        if raw != new_raw:
            detail = []
            if has_bom != want:
                detail.append('BOM %s->%s' % (cur_state, want_state))
            if text != text_lf:
                detail.append('EOL CRLF/CR->LF')
            problems.append((os.path.relpath(p, root), ', '.join(detail), want_state))
    return problems


def main():
    parser = argparse.ArgumentParser(description='Enforce sessbridge encoding/EOL rules.')
    parser.add_argument('--fix', action='store_true', help='Normalize files in place.')
    args = parser.parse_args()

    problems = scan(ROOT)
    if args.fix:
        for rel, detail, _ in problems:
            p = os.path.join(ROOT, rel)
            with open(p, 'rb') as fh:
                raw = fh.read()
            text = raw.decode('utf-8-sig').replace('\r\n', '\n').replace('\r', '\n')
            want = want_bom(p, ROOT)
            with open(p, 'wb') as fh:
                fh.write((b'\xef\xbb\xbf' if want else b'') + text.encode('utf-8'))
            print('fixed  %s (%s)' % (rel, detail))
        print('normalized %d file(s)' % len(problems))
        return 0

    if not problems:
        print('OK: all files match encoding/EOL rules')
        return 0
    for rel, detail, _ in problems:
        print('VIOLATION %s -> %s' % (rel, detail))
    print('%d file(s) violate encoding/EOL rules (run --fix)' % len(problems))
    return 1


if __name__ == '__main__':
    sys.exit(main())
