FROM node:24.16.0-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf
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
    && yarn \
    # yarn install fails for some reason, so run it twice.
    && yarn \
    && yarn run build/core \
    && cat .next/BUILD_ID \
    && yarn wb optimizeForDockerBuild \
    && yarn wb prisma create-litestream-config \
    # Avoid overwriting existing db files
    && rm -Rf db/mount \
    && rm -Rf .yarn/cache \
    && bash ./bash/cleanup.sh

COPY scripts/docker-entrypoint.sh scripts/start-production.sh ./scripts/
RUN chmod +x scripts/*.sh
CMD ["./scripts/docker-entrypoint.sh"]
