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

"${wbCommand[@]}" prisma cleanup-litestream &

if [[ "$RESTORE_BACKUP" == "1" && "$isProduction" == true ]]; then
  "${wbCommand[@]}" prisma deploy-force
else
  "${wbCommand[@]}" prisma deploy
fi

if [[ "$isProduction" == true ]]; then
  "${wbCommand[@]}" prisma seed &
  exec litestream replicate -exec './scripts/start-production.sh'
else
  "${wbCommand[@]}" prisma seed
fi

exec ./scripts/start-production.sh "$@"
