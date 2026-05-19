# Quick start

Three ways to run `agent-collab`. Pick whichever fits.

---

## 1. Bare Node (recommended for development)

Requires Node ≥ 20. Zero dependencies — `npm install` is not needed.

```bash
git clone https://github.com/ruijiaang-lab/agent-collab.git
cd agent-collab
npm start
# Open http://127.0.0.1:5057
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
# Open http://127.0.0.1:5057
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
# Open http://127.0.0.1:5057
docker compose logs -f          # tail logs
docker compose down             # stop
```

---

## Configuration

All knobs are environment variables. Defaults work for local single-user mode.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5057` | HTTP port the WebUI + REST API listen on |

Agent-runner config (for the upcoming v0.3 real-agent module) lives in `.env`
— see `.env.example` when v0.3 ships. The public repo never contains real API
keys; you bring your own.

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
