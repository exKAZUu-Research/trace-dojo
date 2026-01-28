#!/usr/bin/env bash

set -e

export ALLOW_TO_SKIP_SEED=1
export RESTORE_BACKUP=0

IS_PRODUCTION=false
if [ "$WB_ENV" != "" ] && [ "$WB_ENV" != "development" ] && [ "$WB_ENV" != "test" ] && [ "$WB_VERSION" != "development" ]; then
  IS_PRODUCTION=true
fi

node node_modules/.bin/wb prisma cleanup-litestream &

if [ "$RESTORE_BACKUP" -eq 1 ] && [ "$IS_PRODUCTION" = true ]; then
  node node_modules/.bin/wb prisma deploy-force
else
  node node_modules/.bin/wb prisma deploy
fi

if [ "$IS_PRODUCTION" = true ]; then
  node node_modules/.bin/wb prisma seed &
else
  node node_modules/.bin/wb prisma seed
fi

if [ "$IS_PRODUCTION" = true ]; then
  litestream replicate -exec 'node node_modules/.bin/pm2-runtime start ecosystem.config.cjs'
else
  node node_modules/.bin/pm2-runtime start ecosystem.config.cjs
fi
