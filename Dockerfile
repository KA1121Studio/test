FROM node:18-slim

# yt-dlp に必要な Python3 + pip をインストール
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    pip3 install yt-dlp && \
    apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
