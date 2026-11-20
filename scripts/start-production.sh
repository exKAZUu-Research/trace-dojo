#!/usr/bin/env bash

set -euo pipefail

exec node --stack-size=4096 node_modules/.bin/next start "$@"
