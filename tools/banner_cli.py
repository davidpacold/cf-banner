#!/usr/bin/env python3
"""Implementation of ./banner - change the site notice and put it live.

    ./banner "Scheduled maintenance tonight, 10pm-11pm ET"
    ./banner --level critical "Sign-in is degraded. We are on it."
    ./banner --off / --on / --status
"""

from __future__ import annotations

import argparse
import html
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

import cf
import config

KEYCHAIN_SERVICE = "cf-banner-cloudflare-token"
BANNER_TEXT = re.compile(r'cf-banner__text">([^<]*)<')
USER_AGENT = "cf-banner/1.0 (deploy verification)"

DIM, GREEN, RED, RESET = "\033[2m", "\033[32m", "\033[31m", "\033[0m"

NO_TOKEN = f"""No Cloudflare API token found.

Store it once in your Keychain (recommended):

  security add-generic-password -s {KEYCHAIN_SERVICE} -a "$USER" -w

...then paste a token with Zone > Snippets > Edit at the prompt.
Or set CLOUDFLARE_API_TOKEN for a single run."""


def resolve_token() -> str:
    """Environment first so one-off runs and CI work, then the Keychain so
    day-to-day use needs no setup. Never written to disk in plaintext."""
    if token := os.environ.get("CLOUDFLARE_API_TOKEN"):
        return token

    try:
        found = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True,
            text=True,
            check=True,
        )
        return found.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        sys.exit(NO_TOKEN)


class SiteUnreachable(RuntimeError):
    """The site could not be checked - distinct from "no banner is showing"."""


def fetch_page() -> str:
    """Cloudflare answers the default Python-urllib User-Agent with 403, so
    this identifies itself explicitly. Sec-Fetch-Dest marks it a navigation,
    which is what the Snippet injects into."""
    request = urllib.request.Request(
        f"https://{cf.HOST}/",
        headers={"Sec-Fetch-Dest": "document", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise SiteUnreachable(f"https://{cf.HOST}/ returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise SiteUnreachable(f"could not reach https://{cf.HOST}/: {exc}") from exc


def live_message() -> str:
    """What the edge is actually serving - the only trustworthy check.

    The banner escapes its text for HTML and encodes non-ASCII as numeric
    references, so this unescapes before returning. Comparing the raw forms
    would report a false mismatch for any message with a quote, an ampersand
    or an em dash. Returns "" only when the page genuinely has no banner;
    a failed fetch raises instead, so a broken check never reads as absence.
    """
    match = BANNER_TEXT.search(fetch_page())
    return html.unescape(match.group(1)) if match else ""


def wait_for_live(expected: str, *, attempts: int = 12, delay: int = 5):
    """Returns (matched, detail). Fetch failures are retried, since the edge
    can be briefly unavailable mid-deploy, but the last one is reported rather
    than being mistaken for a missing banner."""
    detail = ""
    for attempt in range(attempts):
        try:
            detail = live_message()
            if detail == expected:
                return True, detail
        except SiteUnreachable as exc:
            detail = str(exc)
        if attempt < attempts - 1:
            time.sleep(delay)
    return False, detail


def show_status() -> None:
    current = config.read()
    print(f"in snippet.js : {current['MESSAGE']}  [{current['LEVEL']}]")
    try:
        print(f"live on site  : {live_message() or '(no banner showing)'}")
    except SiteUnreachable as exc:
        print(f"live on site  : {RED}could not check{RESET} - {exc}")


def toggle(token: str, enabled: bool) -> None:
    cf.set_rule_enabled(token, cf.zone_id(token), enabled)

    # Confirm rather than announce. Rule changes take a few seconds to reach
    # every PoP, so reporting success straight after the API call can leave
    # the next --status showing the previous state and looking broken.
    expected = config.read()["MESSAGE"] if enabled else ""
    matched, detail = wait_for_live(expected)

    if not matched:
        sys.exit(
            f"{RED}error:{RESET} rule updated, but https://{cf.HOST}/ "
            f"is still serving: {detail!r}"
        )

    print(f"{GREEN}Banner {'shown' if enabled else 'hidden'}.{RESET}")
    print(f"{DIM}The snippet stays deployed; only the rule toggles.{RESET}")


def publish(token: str, message: str | None, level: str | None) -> None:
    config.write(message=message, level=level)
    current = config.read()

    print(f"{DIM}Deploying: {current['MESSAGE']}  [{current['LEVEL']}]{RESET}")
    cf.deploy(token, verbose=False)

    matched, detail = wait_for_live(current["MESSAGE"])
    if matched:
        print(f"{GREEN}Live:{RESET} {current['MESSAGE']}  [{current['LEVEL']}]")
    else:
        sys.exit(
            f"{RED}error:{RESET} uploaded to Cloudflare, but https://{cf.HOST}/ "
            f"is not serving it. Last check saw: {detail!r}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="./banner",
        description="Change the site notice and put it live.",
    )
    parser.add_argument("message", nargs="?", help="the notice text, quoted")
    parser.add_argument("--level", choices=["important", "critical"])

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--on", action="store_true", help="show the banner")
    mode.add_argument("--off", action="store_true", help="hide it, keep the message")
    mode.add_argument("--status", action="store_true", help="file vs. what is live")

    args = parser.parse_args()
    token = resolve_token()

    try:
        if args.status:
            show_status()
        elif args.on or args.off:
            toggle(token, args.on)
        elif args.message or args.level:
            publish(token, args.message, args.level)
        else:
            parser.print_help()
            return 1
    except cf.CloudflareError as exc:
        sys.exit(f"{RED}error:{RESET} {exc}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
