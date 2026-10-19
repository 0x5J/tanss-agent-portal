# Build context is the repo root:
#   docker build -f updater/Dockerfile --build-arg UPDATER_VERSION=X.Y.Z .
FROM node:22-alpine

# Runs as root on purpose: the Docker socket is root-owned, and the updater
# needs it to replace the portal container.
WORKDIR /app

ARG UPDATER_VERSION=dev
ENV UPDATER_VERSION=$UPDATER_VERSION

# No npm dependencies. shared/update.ts is the only shared file the updater
# needs and imports nothing.
COPY shared/update.ts shared/
COPY updater/*.ts updater/
RUN rm updater/*.test.ts

CMD ["node", "updater/main.ts"]
