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


def _line_index(lines: list[str], key: str) -> int:
    prefix = f"const {key} = "
    for index, line in enumerate(lines):
        if line.startswith(prefix) and line.endswith(";"):
            return index
    raise SystemExit(f"could not find the {key} line in {SNIPPET.name}")


def read() -> dict[str, str | int]:
    lines = SNIPPET.read_text(encoding="utf-8").splitlines()
    values = {}

    for key in KEYS:
        raw = lines[_line_index(lines, key)][len(f"const {key} = ") : -1]
        try:
            values[key] = json.loads(raw)
        except ValueError:
            raise SystemExit(
                f"{key} in {SNIPPET.name} is not a plain literal: {raw}"
            ) from None

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
        encoded = json.dumps(value, ensure_ascii=False)
        lines[_line_index(lines, key)] = f"const {key} = {encoded};"

    SNIPPET.write_text(newline.join(lines) + trailing, encoding="utf-8")
