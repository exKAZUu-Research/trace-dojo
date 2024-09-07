FROM node:22.8.0-slim@sha256:377674fd5bb6fc2a5a1ec4e0462c4bfd4cee1c51f705bbf4bda0ec2c9a73af72
WORKDIR /app

EXPOSE 8080

ENV NODE_ENV=production
ENV HUSKY=0
ENV TZ=Asia/Tokyo

ENV GOOGLE_APPLICATION_CREDENTIALS=/app/gcp-sa-key.json

ARG ARCH
ENV ARCH=$ARCH

RUN apt-get -qq update \
    && node -e 'fetch("https://raw.githubusercontent.com/WillBooster/docker-utils/main/bash/prepare-node-web.sh").then(r => r.text()).then(t => process.stdout.write(t))' | bash \
    && node -e 'fetch("https://raw.githubusercontent.com/WillBooster/docker-utils/main/bash/install-litestream.sh").then(r => r.text()).then(t => process.stdout.write(t))' | bash \
    && node -e 'fetch("https://raw.githubusercontent.com/WillBooster/docker-utils/main/bash/cleanup-apt.sh").then(r => r.text()).then(t => process.stdout.write(t))' | bash

COPY .yarn/ ./.yarn
COPY src/ ./src
COPY prisma/ ./prisma
COPY public/ ./public
COPY .env* .yarnrc.yml blitz* ecosystem* gcp-sa-key.* next* tsconfig.json yarn.lock ./
COPY dist/package.json ./

ARG WB_VERSION
ENV WB_VERSION=$WB_VERSION
ENV NEXT_PUBLIC_WB_VERSION=$WB_VERSION

ARG WB_ENV
ENV WB_ENV=$WB_ENV
ENV NEXT_PUBLIC_WB_ENV=$WB_ENV

RUN node -e 'fetch("https://raw.githubusercontent.com/WillBooster/docker-utils/main/bash/configure-yarn.sh").then(r => r.text()).then(t => process.stdout.write(t))' | bash \
    && yarn \
    # yarn install fails for some reason, so run it twice.
    && yarn \
    && yarn run build/core \
    && cat .next/BUILD_ID \
    && yarn wb optimizeForDockerBuild \
    # Avoid overwriting existing db files
    && rm -Rf db/mount \
    && rm -Rf .yarn/cache

ENV ALLOW_TO_SKIP_SEED=1
ENV RESTORE_BACKUP=0

CMD if [ "$RESTORE_BACKUP" -eq 1 ] && [ -s gcp-sa-key.json ] && [ "$WB_ENV" != "" ] && [ "$WB_ENV" != "development" ] && [ "$WB_ENV" != "test" ]; then \
        node node_modules/.bin/wb prisma deploy-force gcs://wb-online-judge/trace-dojo-${WB_ENV}/prod.sqlite3; \
    else \
        node node_modules/.bin/wb prisma deploy; \
    fi \
    && node node_modules/.bin/wb prisma seed \
    && node node_modules/.bin/wb prisma litestream \
    && if [ -s gcp-sa-key.json ] && [ "$WB_ENV" != "" ] && [ "$WB_ENV" != "development" ] && [ "$WB_ENV" != "test" ]; then \
           bash -c "litestream replicate -exec 'node node_modules/.bin/pm2-runtime start ecosystem.config.cjs' prisma/mount/prod.sqlite3 gcs://wb-online-judge/trace-dojo-${WB_ENV}/prod.sqlite3"; \
       else \
           bash -c "node node_modules/.bin/pm2-runtime start ecosystem.config.cjs"; \
       fi
