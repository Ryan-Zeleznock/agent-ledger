FROM node:24-alpine3.24 AS builder
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm ci --omit=dev

FROM gcr.io/distroless/nodejs24-debian12:nonroot
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
USER 65532
EXPOSE 8787
CMD ["dist/server/main.js"]
