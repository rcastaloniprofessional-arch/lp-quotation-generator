# Puppeteer needs a real Chromium + its system libraries. The slim Node image
# plus the Debian "chromium" package is the most reliable combo on Railway.
FROM node:20-slim

# Chromium and the shared libraries headless Chrome needs to launch.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Use the system Chromium installed above instead of downloading Puppeteer's own copy.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# App source.
COPY . .

# Railway provides PORT at runtime; server.js reads process.env.PORT.
EXPOSE 3000
CMD ["node", "server.js"]
