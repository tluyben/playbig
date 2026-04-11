# Dockerfile for playbig
# Playwright recommends using their official base image which ships Chromium +
# all system dependencies pre-installed.
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install Node deps first (layer-caches well)
COPY package*.json ./
RUN npm ci --omit=dev

# Playwright browsers are already present in the base image.
# If you use a plain node image instead, uncomment the next two lines:
# RUN npx playwright install chromium
# RUN npx playwright install-deps chromium

COPY . .

# Non-root user is already set up in the Playwright base image (pwuser)
USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT||3000) + '/health', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
