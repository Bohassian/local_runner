FROM node:22-alpine

WORKDIR /app

RUN corepack enable

COPY package.json ./
RUN yarn install

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

EXPOSE 3939
CMD ["node", "dist/index.js"]
