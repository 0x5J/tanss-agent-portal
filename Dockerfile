# syntax=docker/dockerfile:1
# Das Bundle ist plattformunabhängig: einmal nativ bauen statt je Zielplattform emuliert.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY shared ./shared
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# The server runs the TypeScript sources through tsx, so they ship as they are.
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
# Sitzung, Einstellungen und Berichte. Compose hängt hier ./data ein; ohne
# Volume muss der Ordner trotzdem existieren und dem Laufzeitnutzer gehören.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3848
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3848)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
