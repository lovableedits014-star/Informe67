FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts/editor-assets.mjs ./scripts/editor-assets.mjs
COPY public ./public
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p /app/uploads/news /app/uploads/banners /app/.private && chown -R node:node /app/uploads /app/.private

USER node
EXPOSE 3000

CMD ["npm", "start"]
