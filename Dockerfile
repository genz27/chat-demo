FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# The browser uses same-origin /v1; nginx injects CHAT_API_KEY server-side.
ARG CHAT_API_ORIGIN=""
ENV CHAT_API_ORIGIN=$CHAT_API_ORIGIN
ENV CHAT_API_KEY="__CHAT_API_KEY__"
RUN pnpm build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
# Only replace the secret; leave nginx's own $uri variables intact.
ENV NGINX_ENVSUBST_VARS='${CHAT_API_KEY}'
EXPOSE 80
