FROM python:3.11-slim

# Node.js 20 インストール
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存関係ファイルコピー
COPY requirements.txt .
COPY package.json .

# 依存関係インストール
RUN pip install --no-cache-dir -r requirements.txt
RUN npm install --production

# ソースコード全体をコピー
COPY . .

# 初期相場スクリーニング
RUN python server/market_monitor.py || true

ENV PORT=10000
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV PYTHON_CMD=python3

EXPOSE 10000

CMD ["node", "server.js"]
