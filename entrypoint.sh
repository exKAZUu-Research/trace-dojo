#!/usr/bin/env bash

set -e

generate_litestream_config() {
  local gcs_url="$1"

  local retention_check_interval="1h"
  if [ "$WB_ENV" = "staging" ]; then
    retention_check_interval="5m"
  fi

  cat > /etc/litestream.yml << EOF
dbs:
  - path: prisma/mount/prod.sqlite3
    replicas:
      - url: ${gcs_url}
        retention: 8h
        retention-check-interval: ${retention_check_interval}
        sync-interval: 60s
EOF
}

export ALLOW_TO_SKIP_SEED=1
export RESTORE_BACKUP=0

if [ "$RESTORE_BACKUP" -eq 1 ] && [ -s gcp-sa-key.json ] && [ "$WB_ENV" != "" ] && [ "$WB_ENV" != "development" ] && [ "$WB_ENV" != "test" ] && [ "$WB_VERSION" != "development" ]; then
  node node_modules/.bin/wb prisma deploy-force gs://wb-education-services/trace-dojo-${WB_ENV}/prod.sqlite3
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

if [ -s gcp-sa-key.json ] && [ "$WB_ENV" != "" ] && [ "$WB_ENV" != "development" ] && [ "$WB_ENV" != "test" ] && [ "$WB_VERSION" != "development" ]; then
  generate_litestream_config "gs://wb-education-services/trace-dojo-${WB_ENV}/prod.sqlite3"
  litestream replicate -exec 'node node_modules/.bin/pm2-runtime start ecosystem.config.cjs'
else
  node node_modules/.bin/pm2-runtime start ecosystem.config.cjs
fi
