# Сборка: docker build -t calorie-app .
# Запуск: docker run --env-file .env -p 3000:3000 calorie-app
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js bot.js apiRouter.js ./
COPY lib ./lib
COPY public ./public
COPY sql ./sql
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
