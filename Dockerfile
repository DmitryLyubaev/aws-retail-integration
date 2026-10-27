FROM node:24.22.1-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae AS node
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .

FROM node AS build
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM postgres:17-bookworm@sha256:ec4dfc6571f04fe0731ce948c1500d676af49a7224392dcc6995cc1ee33a94bb AS runtime
COPY --from=node /usr/local/ /usr/local/
WORKDIR /app
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY package.json ./
ENTRYPOINT ["node", "dist/src/main.js"]

FROM runtime AS tooling
COPY --from=node /app/node_modules/ node_modules/
COPY . .
ENTRYPOINT []
CMD ["npm", "test"]
