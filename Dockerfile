FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY config ./config
RUN mkdir -p /app/data
ENV PORT=3007 NODE_ENV=production DB_PATH=/app/data/booking.db
EXPOSE 3007
CMD ["node", "server/index.js"]
