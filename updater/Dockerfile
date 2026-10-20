# Build context is the repo root:
#   docker build -f updater/Dockerfile --build-arg UPDATER_VERSION=X.Y.Z .
FROM node:22-alpine AS deps

# The only npm dependencies are the Sigstore packages that verify the image
# provenance; install scripts stay off.
WORKDIR /app/updater
COPY updater/package.json updater/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine

# Runs as root on purpose: the Docker socket is root-owned, and the updater
# needs it to replace the portal container.
WORKDIR /app

ARG UPDATER_VERSION=dev
ENV UPDATER_VERSION=$UPDATER_VERSION

# shared/update.ts is the only shared file the updater needs and imports
# nothing. updater/package.json marks the .ts files as ES modules.
COPY shared/update.ts shared/
COPY updater/package.json updater/
COPY --from=deps /app/updater/node_modules updater/node_modules
COPY updater/*.ts updater/
RUN rm updater/*.test.ts

CMD ["node", "updater/main.ts"]
