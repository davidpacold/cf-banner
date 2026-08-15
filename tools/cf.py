#!/usr/bin/env python3
"""Cloudflare API calls for the banner Snippet and its rule.

Every API interaction lives here so that deploy.sh and ./banner share one
implementation instead of two drifting copies embedded in shell heredocs.

    python3 tools/cf.py deploy
    python3 tools/cf.py enable  / disable
    python3 tools/cf.py zone-id
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import secrets
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
ROOT = pathlib.Path(__file__).resolve().parent.parent
SNIPPET_FILE = ROOT / "snippet.js"

ZONE_NAME = os.environ.get("ZONE_NAME", "davidpacold.com")
HOST = os.environ.get("HOSTNAME_TARGET", "airiaazure.davidpacold.com")
SNIPPET_NAME = os.environ.get("SNIPPET_NAME", "cf_banner")

# The rules endpoint rejects unknown keys, so rules read back from the API are
# trimmed to these before being written again.
RULE_FIELDS = ("expression", "snippet_name", "description", "enabled")

# "could not find entrypoint ruleset" - what a zone with no snippet rules yet
# returns instead of an empty list.
NO_RULESET = 10003


class CloudflareError(RuntimeError):
    pass


def _call(token: str, method: str, path: str, *, body=None, content_type=None):
    """Returns the `result` field, raising on any API-level failure.

    Cloudflare answers with HTTP 200 and {"success": false} for permission and
    validation problems, so the status code alone is not a useful signal.
    """
    request = urllib.request.Request(f"{API}{path}", method=method, data=body)
    request.add_header("Authorization", f"Bearer {token}")
    if content_type:
        request.add_header("Content-Type", content_type)

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise CloudflareError(f"could not reach {API}: {exc.reason}") from exc

    try:
        payload = json.loads(raw)
    except ValueError:
        raise CloudflareError(f"non-JSON response from {path}: {raw[:300]}") from None

    if not payload.get("success"):
        errors = payload.get("errors") or []
        if any(e.get("code") == NO_RULESET for e in errors):
            raise LookupError(NO_RULESET)
        raise CloudflareError(f"{method} {path} failed: {json.dumps(errors)}")

    return payload.get("result")


def _multipart(parts):
    """Encodes (name, filename, content_type, data) tuples as form-data."""
    boundary = f"----cf-banner-{secrets.token_hex(16)}"
    chunks = []

    for name, filename, content_type, data in parts:
        disposition = f'form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        chunks.append(
            f"--{boundary}\r\n"
            f"Content-Disposition: {disposition}\r\n"
            f"Content-Type: {content_type}\r\n\r\n".encode()
            + data
            + b"\r\n"
        )

    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def zone_id(token: str, zone_name: str = ZONE_NAME) -> str:
    zones = _call(token, "GET", f"/zones?name={zone_name}") or []
    if not zones:
        raise CloudflareError(f"zone {zone_name} not found for this token")
    return zones[0]["id"]


def upload_snippet(token: str, zone: str, name: str = SNIPPET_NAME) -> None:
    body, content_type = _multipart(
        [
            (
                "metadata",
                None,
                "application/json",
                json.dumps({"main_module": SNIPPET_FILE.name}).encode(),
            ),
            (
                "files",
                SNIPPET_FILE.name,
                "application/javascript+module",
                SNIPPET_FILE.read_bytes(),
            ),
        ]
    )
    _call(
        token,
        "PUT",
        f"/zones/{zone}/snippets/{name}",
        body=body,
        content_type=content_type,
    )


def get_rules(token: str, zone: str) -> list[dict]:
    try:
        return _call(token, "GET", f"/zones/{zone}/snippets/snippet_rules") or []
    except LookupError:
        return []


def put_rules(token: str, zone: str, rules: list[dict]) -> None:
    trimmed = [{k: r[k] for k in RULE_FIELDS if k in r} for r in rules]
    _call(
        token,
        "PUT",
        f"/zones/{zone}/snippets/snippet_rules",
        body=json.dumps({"rules": trimmed}).encode(),
        content_type="application/json",
    )


def upsert_rule(token: str, zone: str, name: str = SNIPPET_NAME, host: str = HOST):
    """Replaces our own rule, leaving every other rule on the zone intact.

    snippet_rules is a whole-list PUT rather than a patch, so writing only our
    rule would silently delete anything else the zone depends on.
    """
    others = [r for r in get_rules(token, zone) if r.get("snippet_name") != name]
    others.append(
        {
            "expression": f"http.host eq {json.dumps(host)}",
            "snippet_name": name,
            "description": f"Inject banner on {host}",
            "enabled": True,
        }
    )
    put_rules(token, zone, others)


def set_rule_enabled(token: str, zone: str, enabled: bool, name: str = SNIPPET_NAME):
    rules = get_rules(token, zone)
    if not any(r.get("snippet_name") == name for r in rules):
        raise CloudflareError(f"no rule for snippet {name} yet - run ./deploy.sh first")

    for rule in rules:
        if rule.get("snippet_name") == name:
            rule["enabled"] = enabled

    put_rules(token, zone, rules)


def deploy(token: str, *, verbose: bool = True) -> None:
    def say(message):
        if verbose:
            print(message)

    say(f"==> Resolving zone {ZONE_NAME}")
    zone = os.environ.get("ZONE_ID") or zone_id(token)
    say(f"    {zone}")

    say(f"==> Uploading snippet {SNIPPET_NAME}")
    upload_snippet(token, zone)
    say("    uploaded")

    say(f"==> Binding rule for {HOST}")
    upsert_rule(token, zone)
    say("    done")


def require_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        sys.exit("Set CLOUDFLARE_API_TOKEN (needs Zone > Snippets > Edit)")
    return token


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("deploy")
    sub.add_parser("enable")
    sub.add_parser("disable")
    sub.add_parser("zone-id")

    args = parser.parse_args()
    token = require_token()

    try:
        if args.command == "deploy":
            deploy(token)
        elif args.command == "zone-id":
            print(zone_id(token))
        else:
            set_rule_enabled(token, zone_id(token), args.command == "enable")
    except CloudflareError as exc:
        sys.exit(f"error: {exc}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
