FROM node:24.10.0-bookworm-slim@sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9
WORKDIR /app
# Only the consumer facade and notebook. No world, solutions, or expectations.
COPY worker.mjs /app/worker.mjs
USER node
ENTRYPOINT ["node", "--max-old-space-size=384", "/app/worker.mjs"]
