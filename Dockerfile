FROM node:24.18.0-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
WORKDIR /app

EXPOSE 8080
ENV PORT=8080

ENV NODE_ENV=production
ENV HUSKY=0
ENV TZ=Asia/Tokyo
ENV WB_DOCKER=1

ARG ARCH
ENV ARCH=$ARCH

COPY dist/bash/ ./bash/

RUN apt-get -qq update \
    && bash ./bash/prepare-node-web.sh \
    && bash ./bash/install-litestream.sh \
    && bash ./bash/cleanup.sh --keep-scripts

COPY .yarn/ ./.yarn
COPY src/ ./src
COPY prisma/ ./prisma
COPY public/ ./public
COPY .env* .yarnrc.yml next* tsconfig.json yarn.lock ./
COPY dist/package.json ./

ARG WB_VERSION
ENV WB_VERSION=$WB_VERSION
ENV NEXT_PUBLIC_WB_VERSION=$WB_VERSION

ARG WB_ENV
ENV WB_ENV=$WB_ENV
ENV NEXT_PUBLIC_WB_ENV=$WB_ENV

RUN bash ./bash/configure-yarn.sh \
    && NODE_ENV=development yarn \
    # yarn install fails for some reason, so run it twice.
    && NODE_ENV=development yarn \
    && yarn prisma generate \
    && yarn run build/core \
    && cat .next/BUILD_ID \
    && yarn wb prisma create-litestream-config \
    && yarn wb optimizeForDockerBuild \
    # Avoid overwriting existing db files
    && rm -Rf db/mount \
    && rm -Rf .yarn/cache \
    && bash ./bash/cleanup.sh

COPY scripts/docker-entrypoint.sh scripts/start-production.sh ./scripts/
RUN chmod +x scripts/*.sh
CMD ["./scripts/docker-entrypoint.sh"]
