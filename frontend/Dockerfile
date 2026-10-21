# --- build stage ---
# Node 24:與 CI 一致(Capacitor CLI 要求 >= 22)
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE=""
ARG VITE_MOCK=auto
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_MOCK=$VITE_MOCK
RUN npm run build

# --- serve stage ---
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
