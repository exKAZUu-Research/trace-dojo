FROM node:24.11.1-slim@sha256:0afb7822fac7bf9d7c1bf3b6e6c496dee6b2b64d8dfa365501a3c68e8eba94b2
WORKDIR /app

EXPOSE 8080
ENV PORT=8080

ENV NODE_ENV=production
ENV HUSKY=0
ENV TZ=Asia/Tokyo
ENV WB_DOCKER=1

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
COPY .env* .yarnrc.yml ecosystem* next* tsconfig.json yarn.lock ./
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
    && yarn wb prisma create-litestream-config \
    # Avoid overwriting existing db files
    && rm -Rf db/mount \
    && rm -Rf .yarn/cache

COPY entrypoint.sh ./
CMD ./entrypoint.sh
