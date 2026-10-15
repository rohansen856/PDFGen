FROM node:22-bookworm-slim

# System Chromium + fonts. Noto covers the ₹ sign and Indic scripts (Devanagari, Tamil, ...) that
# GST invoices often need; without them Chromium silently renders tofu boxes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-dejavu-core procps \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=1 CHROMIUM_PATH=/usr/bin/chromium NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
