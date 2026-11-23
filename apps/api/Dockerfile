FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm install --no-save tsx
COPY src ./src
COPY scripts ./scripts
USER node
EXPOSE 3333
CMD ["npx", "tsx", "src/server.ts"]
