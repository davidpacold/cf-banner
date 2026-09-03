#!/usr/bin/env python3
"""Read and write the MESSAGE / LEVEL / DISMISS_EPOCH lines in snippet.js.

The values are JS literals that may legitimately contain quotes, backslashes
and non-ASCII punctuation. Because they are written with json.dumps they are
also valid JSON, so json.loads decodes them exactly - no escape handling of
our own to get wrong. That holds for DISMISS_EPOCH too, which is a bare
integer in both languages.
"""

from __future__ import annotations

import json
import pathlib

SNIPPET = pathlib.Path(__file__).resolve().parent.parent / "snippet.js"
KEYS = ("MESSAGE", "LEVEL", "DISMISS_EPOCH")

# A snippet.js predating DISMISS_EPOCH still has to work for --status and for
# plain publishes; only --on needs the value, and it reports the missing line
# itself when it tries to write one. Keys absent from here stay required.
DEFAULTS = {"DISMISS_EPOCH": 0}

# json.dumps(ensure_ascii=False) leaves these three raw, but str.splitlines()
# - which every read path here uses - treats them as line terminators. A
# message containing one would write a MESSAGE line spanning two physical
# lines, after which _line_index can never find it again and every ./banner
# invocation fails. \u escapes are valid in both JSON and JavaScript. The C0
# controls that splitlines also breaks on (\v, \f, \x1c-\x1e) are already
# escaped by json.dumps.
LINE_TERMINATORS = {"\u2028": "\\u2028", "\u2029": "\\u2029", "\x85": "\\u0085"}


def _encode(value: str | int) -> str:
    encoded = json.dumps(value, ensure_ascii=False)
    for char, escape in LINE_TERMINATORS.items():
        encoded = encoded.replace(char, escape)
    return encoded


def _find(lines: list[str], key: str) -> int:
    prefix = f"const {key} = "
    for index, line in enumerate(lines):
        if line.startswith(prefix) and line.endswith(";"):
            return index
    return -1


def _line_index(lines: list[str], key: str) -> int:
    index = _find(lines, key)
    if index < 0:
        raise SystemExit(f"could not find the {key} line in {SNIPPET.name}")
    return index


def read() -> dict[str, str | int]:
    lines = SNIPPET.read_text(encoding="utf-8").splitlines()
    values = {}

    for key in KEYS:
        index = _find(lines, key)
        if index < 0:
            if key in DEFAULTS:
                values[key] = DEFAULTS[key]
                continue
            raise SystemExit(f"could not find the {key} line in {SNIPPET.name}")

        raw = lines[index][len(f"const {key} = ") : -1]
        try:
            values[key] = json.loads(raw)
        except ValueError:
            raise SystemExit(
                f"{key} in {SNIPPET.name} is not a plain literal: {raw}"
            ) from None

    if not isinstance(values["DISMISS_EPOCH"], int):
        raise SystemExit(
            f"DISMISS_EPOCH in {SNIPPET.name} must be a number, "
            f"got {values['DISMISS_EPOCH']!r}"
        )

    return values


def write(
    *,
    message: str | None = None,
    level: str | None = None,
    epoch: int | None = None,
) -> None:
    text = SNIPPET.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    trailing = newline if text.endswith(newline) else ""
    lines = text.splitlines()

    # Empty strings are skipped rather than written, so a caller passing only
    # --level cannot blank the message. epoch is tested against None instead,
    # because 0 is a legitimate value that `not value` would silently drop.
    updates = [
        (key, value)
        for key, value in (("MESSAGE", message), ("LEVEL", level))
        if value
    ]
    if epoch is not None:
        updates.append(("DISMISS_EPOCH", epoch))

    for key, value in updates:
        lines[_line_index(lines, key)] = f"const {key} = {_encode(value)};"

    SNIPPET.write_text(newline.join(lines) + trailing, encoding="utf-8")
