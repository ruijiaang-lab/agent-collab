# Quick start

Three ways to run `agent-collab`. Pick whichever fits.

---

## 1. Bare Node (recommended for development)

Requires Node ≥ 20. Zero dependencies — `npm install` is not needed.

```bash
git clone https://github.com/ruijiaang-lab/agent-collab.git
cd agent-collab
npm start
# 极简模式：http://127.0.0.1:5057/simple
# 高级模式：http://127.0.0.1:5057/chair
```

Run the smoke test:

```bash
npm test
```

---

## 2. Docker (recommended for trying it out)

No Node install required. Persists meeting state into `./data` on the host.

```bash
git clone https://github.com/ruijiaang-lab/agent-collab.git
cd agent-collab
docker build -t agent-collab .
docker run --rm -p 5057:5057 -v "$(pwd)/data:/app/data" agent-collab
# 极简模式：http://127.0.0.1:5057/simple
# 高级模式：http://127.0.0.1:5057/chair
```

Run on a different host port:

```bash
docker run --rm -p 8080:5057 -v "$(pwd)/data:/app/data" agent-collab
# Now on http://127.0.0.1:8080
```

Run detached + auto-restart:

```bash
docker run -d --name agent-collab \
  -p 5057:5057 \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  agent-collab
```

Stop and remove:

```bash
docker stop agent-collab && docker rm agent-collab
```

---

## 3. Docker Compose (recommended for "set and forget")

```yaml
# docker-compose.yml
services:
  agent-collab:
    build: .
    image: agent-collab
    container_name: agent-collab
    ports:
      - "5057:5057"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
docker compose up -d
# 极简模式：http://127.0.0.1:5057/simple
# 高级模式：http://127.0.0.1:5057/chair
docker compose logs -f          # tail logs
docker compose down             # stop
```

---

## Configuration

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `5057` | HTTP 端口 |
| `AGENT_COLLAB_DATA_DIR` | `./data` | state.json 存储目录 |

### Agent 配置（.env）

Agent runner 的认证信息在 `.env` 文件里（已 gitignore，不会提交到公开仓库）。

```bash
cp .env.example .env
# 编辑 .env，填入你的 API 端点和 key
```

完整配置项见 `.env.example`。两种认证方式：

1. **CLI 已登录**：不填 .env，直接用本地已登录的 `claude` / `hermes` CLI
2. **第三方 API 端点**：填 `.env` 里的 BASE_URL 和 API_KEY

> **注意**：`AGENT_COLLAB_CLAUDE_MODEL` 建议留空。第三方代理通常有自己支持的模型列表，填错名字会报 `400 Param Incorrect`。

---

## Persistence

Meeting state lives in `data/state.json`. It is intentionally `.gitignore`d
(it changes constantly during use and contains your workspace-specific
content) but is mounted as a Docker volume in option 2 / 3 above so meetings
survive container restarts.

To start from a clean slate:

```bash
rm -f data/state.json    # next run regenerates the default
```

---

## Health check

The HTTP server exposes `/api/state` as a JSON read of the full state. The
Docker image's HEALTHCHECK pings it every 30s.

```bash
curl -s http://127.0.0.1:5057/api/state | head -c 200
```
