FROM node:20-slim

# Install latest chrome dev environment and dependencies for puppeteer
RUN apt-get update \
    && apt-get install -y wget gnupg ca-certificates procps libxss1 libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
