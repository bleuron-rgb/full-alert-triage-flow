# The image staging and production both run: the same Node process, the same
# entry point, and the same Sentry instrumentation as `npm start` locally.
FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080

# instrument.js reads the release from git when it can; there is no repository in
# the image, so the deploying commit is baked in instead.
ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=$SENTRY_RELEASE

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 8080
CMD ["node", "--import", "./src/instrument.js", "src/server.js"]
