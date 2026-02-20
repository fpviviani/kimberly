FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# default command (overridden by docker-compose services)
CMD ["node","src/bin/cli.js"]
