# ---- deps: install full dependency tree (needed to run the Nest build) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

# ---- build: compile TypeScript -> dist ----
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn build

# ---- prod-deps: install only production dependencies (smaller, no @nestjs/cli etc.) ----
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000 --production && yarn cache clean

# ---- runtime: minimal final image ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
EXPOSE 3005
CMD ["node", "dist/main.js"]
