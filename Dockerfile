FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6
WORKDIR /app

EXPOSE 8080
ENV PORT=8080

ENV NODE_ENV=production
ENV TZ=Asia/Tokyo
ENV WB_DOCKER=1

# mise provides the pinned node binary (mise.toml); its shims must resolve `node` for the
# entrypoint scripts and for Next.js, which must run under real Node.
ENV MISE_DATA_DIR=/usr/local/share/mise
ENV MISE_INSTALL_PATH=/usr/local/bin/mise
ENV MISE_TRUSTED_CONFIG_PATHS=/app
ENV PATH="/usr/local/share/mise/shims:${PATH}"
# Pin the mise installer version so the build stays reproducible instead of tracking mise's latest.
ENV MISE_VERSION=v2026.8.14

ARG ARCH
ENV ARCH=$ARCH

COPY dist/bash/ ./bash/

RUN apt-get -qq update \
    && bash ./bash/prepare-node-web.sh \
    && bash ./bash/install-litestream.sh \
    && curl https://mise.run | sh \
    && bash ./bash/cleanup.sh --keep-scripts

# JDK for grading fill-in-the-blank problems on this machine.
RUN apt-get -qq update \
    && apt-get -qq install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo "$VERSION_CODENAME") main" > /etc/apt/sources.list.d/adoptium.list \
    && apt-get -qq update \
    && apt-get -qq install -y --no-install-recommends temurin-21-jdk \
    && apt-get -qq purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*

ARG WB_VERSION
ENV WB_VERSION=$WB_VERSION
ENV NEXT_PUBLIC_WB_VERSION=$WB_VERSION

ARG WB_ENV
ENV WB_ENV=$WB_ENV
ENV NEXT_PUBLIC_WB_ENV=$WB_ENV

# .docker.env holds only the non-secret values of the selected fnox profile; secrets are injected at
# runtime from Fly.io secrets (scripts/syncFlySecrets.mjs).
# secrets are injected at runtime from Fly.io secrets (scripts/syncFlySecrets.mjs).
COPY .docker.env mise.toml bunfig.toml bun.lock next.config.ts tsconfig.json ./
COPY dist/package.json ./
COPY prisma/ ./prisma
COPY public/ ./public
COPY src/ ./src
COPY scripts/docker-entrypoint.sh scripts/start-production.sh ./scripts/

RUN bash ./bash/generate-package-manager-configs.sh

# Only node is installed, not every tool mise.toml pins: fnox.toml is never copied into the image and
# the age key never enters it, so the container can never use fnox.
# The lockfile is not frozen because dist/package.json omits dependencies the image does not need.
# apply-docker-env.sh exports the baked values so `next build` inlines NEXT_PUBLIC_*.
RUN mise trust --yes --all \
    && mise install node \
    && bun install \
    && bun run prisma generate \
    && bash ./bash/apply-docker-env.sh bun run build/core \
    && cat .next/BUILD_ID \
    # --env-refs keeps the R2 credentials out of the image; Litestream expands them from Fly.io secrets.
    && bash ./bash/apply-docker-env.sh bun wb prisma create-litestream-config --env-refs \
    && bun wb optimizeForDockerBuild \
    # Avoid overwriting existing db files
    && rm -Rf db/mount \
    && rm -Rf .next/cache \
    && bash ./bash/cleanup.sh --keep-scripts

RUN chmod +x scripts/*.sh
# Baked values apply only to keys the platform did not set, so Fly.io secrets win.
CMD ["bash", "./bash/apply-docker-env.sh", "./scripts/docker-entrypoint.sh"]
