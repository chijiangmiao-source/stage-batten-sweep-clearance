# Playwright's official image already contains the matching Chromium build and
# its system libraries, so the same image serves both the web server and the
# one-shot verify job.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Browsers are preinstalled in this base image at /ms-playwright.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CI=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 4173

# Default target: production static server. The compose "verify" service overrides
# this command with the full Vitest + Playwright pipeline.
CMD ["npm", "run", "preview"]
