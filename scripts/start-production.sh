#!/usr/bin/env bash

set -euo pipefail

exec node node_modules/.bin/dotenv -c "$WB_ENV" -- node node_modules/.bin/next start "$@"
