FROM node:22-bookworm-slim AS build

ENV ASTRO_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
RUN pnpm exec playwright install --with-deps --only-shell chromium

COPY . .
ARG PUBLIC_SITE_URL=http://localhost:4321
ARG PUBLIC_API_BASE_PATH=/api/v1
ENV PUBLIC_SITE_URL=${PUBLIC_SITE_URL}
ENV PUBLIC_API_BASE_PATH=${PUBLIC_API_BASE_PATH}
RUN pnpm build

FROM golang:1.25-alpine AS server-build

WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/turblog-server ./cmd/turblog-server

FROM nginx:1.29-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=server-build /out/turblog-server /usr/local/bin/turblog-server

RUN mkdir -p /var/lib/turblog && chown nginx:nginx /var/lib/turblog

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
