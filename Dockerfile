FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 4000
USER node
CMD ["node","dist/index.js"]