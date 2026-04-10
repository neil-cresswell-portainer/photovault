# ── PhotoVault Dockerfile ──────────────────────────────────────────────────────
# Single-stage build. TLS cert is generated at first startup and stored in the
# data volume, so it persists across container restarts and image rebuilds.
# You only ever need to install the cert on your iPhone once.
#
# Build:
#   docker build -t photovault .
#
# Run:
#   docker run -d \
#     --name photovault \
#     --restart unless-stopped \
#     -p 3737:3737 \
#     -e VAULT_PASSWORD=yourpassword \
#     -v /path/to/your/photos:/photos:ro \
#     -v photovault_data:/app/data \
#     photovault
#
# The single named volume photovault_data persists:
#   - TLS certificate (data/certs/)    — generated once, reused forever
#   - Scan index     (data/cache.json) — survives container recreation
#   - Thumbnails     (data/thumbs/)    — no regeneration needed after rebuild
#
# First-time iPhone setup (do once, after first container start):
#   1. Open https://<your-server-ip>:3737/cert/install in Safari
#   2. Follow the 5-step guide to install and trust the certificate
#   3. No more warnings — ever

FROM node:20-slim

# openssl: used by server.js to generate the self-signed cert on first run
# ffmpeg:  used for video thumbnail extraction
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application source
COPY server.js .
COPY public/ ./public/

# Create data dir structure. The whole /app/data tree is owned by the volume
# at runtime, but we pre-create it so the app starts cleanly even without a volume.
RUN mkdir -p data/thumbs data/certs

# Mount point for photos (bind mount from host at runtime)
RUN mkdir -p /photos

EXPOSE 3737

ENV PHOTOS_DIR=/photos
ENV DATA_DIR=/app/data
ENV PORT=3737
ENV NODE_ENV=production
# VAULT_PASSWORD must be provided at runtime

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "\
const https=require('https');\
const o={hostname:'localhost',port:process.env.PORT||3737,path:'/cert',method:'HEAD',rejectUnauthorized:false};\
https.request(o,r=>{process.exit(r.statusCode<500?0:1)}).on('error',()=>{\
  require('http').request({hostname:'localhost',port:process.env.PORT||3737,path:'/cert',method:'HEAD'},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1)).end();\
}).end()"

CMD ["node", "server.js"]
