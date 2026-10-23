FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:views
ENV HOST=0.0.0.0 PORT=8787 HEARTH_DATA=/app/data/hearth.json
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["npx", "tsx", "src/index.ts"]
