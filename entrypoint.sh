#!/usr/bin/env bash

set -e

export ALLOW_TO_SKIP_SEED=1
export RESTORE_BACKUP=0

if [ "$RESTORE_BACKUP" -eq 1 ] && [ "$WB_ENV" != "" ] && [ "$WB_ENV" != "development" ] && [ "$WB_ENV" != "test" ] && [ "$WB_VERSION" != "development" ]; then
  node node_modules/.bin/wb prisma deploy-force
else
  node node_modules/.bin/wb prisma deploy
fi

if [ "$WB_ENV" != "" ] && [ "$WB_ENV" != "development" ] && [ "$WB_ENV" != "test" ] && [ "$WB_VERSION" != "development" ]; then
  node node_modules/.bin/wb prisma seed &
  node node_modules/.bin/wb prisma litestream &
else
  node node_modules/.bin/wb prisma seed
  node node_modules/.bin/wb prisma litestream
fi

if [ "$WB_ENV" != "" ] && [ "$WB_ENV" != "development" ] && [ "$WB_ENV" != "test" ] && [ "$WB_VERSION" != "development" ]; then
  litestream replicate -exec 'node node_modules/.bin/pm2-runtime start ecosystem.config.cjs'
else
  node node_modules/.bin/pm2-runtime start ecosystem.config.cjs
fi
