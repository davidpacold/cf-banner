#!/usr/bin/env bash
#
# Deploy snippet.js to Cloudflare and bind it to the hostname.
#
#   export CLOUDFLARE_API_TOKEN=...   # needs Zone > Snippets > Edit
#   ./deploy.sh
#
# Implementation lives in tools/cf.py. Override ZONE_NAME, HOSTNAME_TARGET or
# SNIPPET_NAME in the environment to point this at something else.

set -euo pipefail

exec python3 "$(dirname "$0")/tools/cf.py" deploy
