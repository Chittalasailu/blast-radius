# Deployed image for the hosted demo.
#
# The frontend is built at image-build time and served by the same Fastify
# process that exposes the API, so the deployment is a single container with
# no separate static host and no CORS surface.

FROM node:22-slim AS build

WORKDIR /app

# Install with dev dependencies present: vite and the react plugin are needed
# to build the frontend.
COPY package.json package-lock.json ./
RUN npm ci

COPY web ./web
COPY server ./server
RUN npm run build:web


FROM node:22-slim AS runtime

ENV NODE_ENV=production
# The platform router cannot reach a loopback-bound process.
ENV HOST=0.0.0.0
ENV PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY --from=build /app/web/dist ./web/dist

# Connection details come from the platform's environment variables. No .env
# file is baked into the image.
EXPOSE 8080

USER node

CMD ["node", "server/index.mjs"]
