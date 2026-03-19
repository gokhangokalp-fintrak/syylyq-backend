# VITA SuperApp Backend — Production Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source and build
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma

# Copy static files (admin/merchant panels)
COPY admin-panel.html ./
COPY merchant-panel.html ./

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Run database migration and start
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
