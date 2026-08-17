FROM node:22-alpine
WORKDIR /app

# Dependencies first so the layer is cached across source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Tests are not copied: they run in CI, not in the image.
CMD ["node", "src/index.js"]
