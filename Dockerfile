FROM node:22-bookworm-slim

# Explicit host maintenance executes the pinned instance compiler in this VM.
RUN node -e "require('node:fs').writeFileSync('/tmp/node-root-ca.pem', require('node:tls').rootCertificates.join('\\n') + '\\n')" \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-root-ca.pem -o Acquire::Retries=3 update \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-root-ca.pem -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates \
    && rm /tmp/node-root-ca.pem \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends python3 python3-yaml python3-pil ffmpeg poppler-utils \
    && rm -rf /var/lib/apt/lists/*

ARG REVIEW_SOFTWARE_COMMIT=UNVERSIONED
ARG REVIEW_BASE_PATH=
ARG REVIEW_DEPLOYMENT_MODE=LOCAL
LABEL org.opencontainers.image.revision=$REVIEW_SOFTWARE_COMMIT
ENV REVIEW_SOFTWARE_COMMIT=$REVIEW_SOFTWARE_COMMIT
ENV REVIEW_BASE_PATH=$REVIEW_BASE_PATH
ENV REVIEW_DEPLOYMENT_MODE=$REVIEW_DEPLOYMENT_MODE

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY app/ ./app/
COPY host/ ./host/
COPY workers/ ./workers/
COPY scripts/ ./scripts/
COPY tsconfig.json next.config.ts vite.config.ts ./
COPY public/favicon.svg ./public/favicon.svg
RUN REVIEW_NODE_RUNTIME=1 npm run build && node scripts/write-runtime-build-contract.mjs

ENV NODE_ENV=production
ENV REVIEW_SQLITE_OWNER=CONTAINER
ENV PORT=3000

EXPOSE 3000

USER node

CMD ["node", "scripts/runtime-entrypoint.mjs"]
