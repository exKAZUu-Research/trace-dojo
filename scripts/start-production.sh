#!/usr/bin/env bash

set -euo pipefail

exec node --stack-size=8192 node_modules/.bin/next start "$@"
