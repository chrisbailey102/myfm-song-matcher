FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
# schema.sql is read from src/db at runtime (also copy into dist after build)
RUN npm run build \
  && mkdir -p dist/db \
  && cp src/db/schema.sql dist/db/schema.sql \
  && npm prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV MYFM_UI_PORT=3847
EXPOSE 3847
CMD ["node", "dist/server.js"]
