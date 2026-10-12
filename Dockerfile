FROM node:22-alpine AS build

WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/scripts/editor-assets.mjs backend/scripts/site-assets.mjs ./scripts/
COPY backend/public ./public
COPY index.html noticia.html styles.css script.js noticia.js public-api.js /build/
COPY assets /build/assets
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /build/backend/package.json ./package.json
COPY --from=build --chown=node:node /build/backend/node_modules ./node_modules
COPY --from=build --chown=node:node /build/backend/dist ./dist
COPY --from=build --chown=node:node /build/backend/public ./public
RUN mkdir -p /app/uploads/news /app/uploads/banners /app/.private && chown -R node:node /app/uploads /app/.private
USER node
EXPOSE 3000
CMD ["npm", "start"]
