#!/usr/bin/env bash

set -euo pipefail

export ALLOW_TO_SKIP_SEED=1
if [[ -z "${RESTORE_BACKUP+x}" ]]; then
  export RESTORE_BACKUP=0
fi

wbCommand=(node node_modules/.bin/wb)

isProduction=false
if [[ -n "${WB_ENV:-}" && "${WB_ENV:-}" != "development" && "${WB_ENV:-}" != "test" && "${WB_VERSION:-}" != "development" ]]; then
  isProduction=true
fi

"${wbCommand[@]}" db cleanup-litestream

if [[ "$RESTORE_BACKUP" == "1" && "$isProduction" == true ]]; then
  "${wbCommand[@]}" db deploy-force
else
  "${wbCommand[@]}" db deploy
fi

if [[ "$isProduction" == true ]]; then
  "${wbCommand[@]}" db seed &
  exec run-litestream.sh './scripts/start-production.sh'
else
  "${wbCommand[@]}" db seed
fi

exec ./scripts/start-production.sh "$@"
