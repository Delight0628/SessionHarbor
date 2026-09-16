# SessionHarbor Cloud 自建云
FROM node:22-bookworm-slim
WORKDIR /app
# 预装 workspace 产物（构建上下文为仓库根）
COPY packages/cloud-server/package.json packages/cloud-server/
COPY packages/cloud-server/dist packages/cloud-server/dist
# core 运行时依赖（PLANS）
COPY packages/core/package.json packages/core/
COPY packages/core/dist packages/core/
ENV NODE_ENV=production \
    HARBOR_CLOUD_PORT=8787 \
    HARBOR_CLOUD_DATA=/data
VOLUME ["/data"]
EXPOSE 8787
WORKDIR /app/packages/cloud-server
# 简化：直接 node dist/server.js；生产可加 HEALTHCHECK
CMD ["node", "dist/server.js"]
