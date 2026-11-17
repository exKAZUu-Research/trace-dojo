#!/usr/bin/env bash

set -euo pipefail

# The interpreters run each call of a learner's program on this process's stack, where V8's default (about 1 MB) can
# run out before their 512-call limit. 4 MB must stay below the main thread's stack size (`ulimit -s`, 8 MB by default
# on Linux), or V8 crashes instead of throwing a RangeError.
exec node --stack-size=4000 node_modules/.bin/next start "$@"
