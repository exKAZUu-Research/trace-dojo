FROM node:22.20.0-slim@sha256:d943bf20249f8b92eff6f605362df2ee9cf2d6ce2ea771a8886e126ec8714f08
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

COPY entrypoint.sh ./
CMD ./entrypoint.sh
