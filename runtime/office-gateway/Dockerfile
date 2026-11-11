FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
WORKDIR /app
COPY runtime/office-gateway/protocol.mjs runtime/office-gateway/gateway.mjs ./
USER 10001:10001
EXPOSE 9981 9982
ENTRYPOINT ["node", "--max-old-space-size=96", "/app/gateway.mjs"]
