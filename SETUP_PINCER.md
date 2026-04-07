# nanoclaw + Pincer — Setup & Security Configuration

This document covers the complete setup for running nanoclaw with Pincer as its permission enforcement layer, including the network isolation, filtering proxy, and agent configuration changes made to enforce that all external actions go through Pincer.

---

## Architecture Overview

```
Slack / Discord
      │
nanoclaw host service  (dist/index.js, systemd)
      │  spawns per-message containers
      ▼
nanoclaw-agent containers  (Docker, nanoclaw-net)
      │
      ├─► http://host.docker.internal:8080  →  Pincer FastAPI  (permission enforcement)
      │
      └─► https via anthropic-proxy.py :10255  →  OneCLI :10255  →  Anthropic API only
```

**nanoclaw-net** is a Docker bridge with `Internal: true` — containers have NO default route to the internet. The only outbound paths are:
1. **Pincer** (plain HTTP, port 8080) — for all host actions
2. **anthropic-proxy.py** (HTTPS filter, port 10255) — for Claude API calls only

---

## Network Setup

### 1. Create the isolated Docker network

```bash
docker network create \
  --driver bridge \
  --subnet 172.19.0.0/16 \
  --opt com.docker.network.bridge.name=br-nanoclaw \
  --internal \
  nanoclaw-net
```

`--internal` removes the default route — containers cannot reach the internet directly.

Verify:
```bash
docker network inspect nanoclaw-net | grep -E '"Internal"|"Subnet"|"Gateway"'
# Should show: "Internal": true, Subnet: 172.19.0.0/16, Gateway: 172.19.0.1
```

**Important:** `host.docker.internal` must resolve to `172.19.0.1` (the nanoclaw-net gateway), NOT `172.17.0.1` (docker0 bridge, unreachable from this network). nanoclaw passes `--add-host=host.docker.internal:172.19.0.1` to every container. This is handled in `src/container-runtime.ts` → `hostGatewayArgs()`.

### 2. iptables — isolation rules

The iptables rules are persisted in `/etc/iptables/rules.v4` (via `iptables-persistent`). Key rules for nanoclaw isolation:

```
# Prevent containers from routing around the internal network restriction
-A DOCKER-INTERNAL ! -s 172.19.0.0/16 -o br-030b98e0ea89 -j DROP
-A DOCKER-INTERNAL ! -d 172.19.0.0/16 -i br-030b98e0ea89 -j DROP
```

> **Note:** `br-030b98e0ea89` is the bridge interface name for `nanoclaw-net`. This changes if you recreate the network. After recreating the network, run `docker network inspect nanoclaw-net` to get the new bridge name, update the iptables rules, and save with `sudo iptables-save > /etc/iptables/rules.v4`.

To restore iptables rules after a reboot:
```bash
sudo iptables-restore < /etc/iptables/rules.v4
```

Or install `iptables-persistent` to restore automatically:
```bash
sudo apt install iptables-persistent
sudo netfilter-persistent save
```

---

## Filtering Proxy (anthropic-proxy.py)

This Python proxy runs on `172.19.0.1:10255` and filters HTTPS CONNECT tunnels. It only allows connections to `*.anthropic.com` and `*.claude.ai`. Everything else gets a 403.

**File:** `scripts/anthropic-proxy.py`

It forwards allowed connections to OneCLI at `172.17.0.1:10255` (the credential injection proxy that injects `CLAUDE_CODE_OAUTH_TOKEN`).

### Systemd service

Create `/home/<user>/.config/systemd/user/anthropic-proxy.service`:

```ini
[Unit]
Description=Anthropic-only filtering proxy for nanoclaw containers
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /srv/workspace/nanoclaw/scripts/anthropic-proxy.py
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Enable and start:
```bash
systemctl --user daemon-reload
systemctl --user enable --now anthropic-proxy.service
systemctl --user status anthropic-proxy.service
```

Verify it's blocking non-Anthropic and allowing Anthropic:
```bash
journalctl --user -u anthropic-proxy.service -f
# Should show: ALLOW api.anthropic.com:443
# Should show: WARNING BLOCKED <anything-else>:443
```

---

## nanoclaw Host Service

**File:** `dist/index.js` (compiled from `src/`)

### Systemd service

Create `/home/<user>/.config/systemd/user/nanoclaw.service`:

```ini
[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /srv/workspace/nanoclaw/dist/index.js
WorkingDirectory=/srv/workspace/nanoclaw
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=/home/mayankr
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/mayankr/.local/bin
StandardOutput=append:/srv/workspace/nanoclaw/logs/nanoclaw.log
StandardError=append:/srv/workspace/nanoclaw/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
```

Enable and start:
```bash
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw.service
```

### Environment file

nanoclaw reads `.env` from its working directory. Copy from `.env.example` and fill in:

```bash
cp .env.example .env
```

`.env` variables:
```
TZ=UTC                        # Timezone for containers
ONECLI_URL=http://...         # OneCLI service URL (credential injection proxy)
DISCORD_BOT_TOKEN=...         # Discord bot token
SLACK_APP_TOKEN=xapp-...      # Slack socket mode app token
SLACK_BOT_TOKEN=xoxb-...      # Slack bot token
```

**The `.env` file must never be committed.** It is gitignored.

---

## Container Security Configuration

These changes are all in the source and committed. Documented here for understanding.

### 1. Pincer environment variables (src/container-runner.ts)

Every container gets:
```
PINCER_PROXY_URL=http://host.docker.internal:8080
NO_PROXY=host.docker.internal
no_proxy=host.docker.internal
```

`NO_PROXY` is critical: without it, `HTTP_PROXY` (injected by OneCLI) intercepts plain HTTP requests to port 8080 and sends them through the HTTPS filtering proxy, which returns 405.

### 2. Disabled web tools (container/agent-runner/src/index.ts)

```typescript
disallowedTools: ['WebSearch', 'WebFetch'],
```

`WebSearch` and `WebFetch` are explicitly removed from the model's context. Note: `allowedTools` alone is insufficient because `WebSearch` has `behavior: "passthrough"` in the SDK's permission check, which bypasses the allow-list.

### 3. Disabled agent-browser (container/disabled-agent-browser)

`container/disabled-agent-browser` is a stub script that exits 1. It is shadow-mounted over `/usr/local/bin/agent-browser` in every container:

```typescript
// In container-runner.ts
const disabledBrowser = path.join(process.cwd(), 'container', 'disabled-agent-browser');
if (fs.existsSync(disabledBrowser)) {
  mounts.push({
    hostPath: disabledBrowser,
    containerPath: '/usr/local/bin/agent-browser',
    readonly: true,
  });
}
```

`agent-browser` uses Chromium, which does not respect `HTTPS_PROXY`, so it cannot be controlled by the filtering proxy. The stub ensures it can never run.

### 4. Host gateway resolution (src/container-runtime.ts)

```typescript
export function hostGatewayArgs(): string[] {
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:172.19.0.1'];
  }
  return [];
}
```

Must use `172.19.0.1`, not the Docker `host-gateway` token. `host-gateway` resolves to `172.17.0.1` (docker0), which is unreachable from `nanoclaw-net` due to the DOCKER-INTERNAL iptables rules.

---

## Agent Instructions

### groups/global/CLAUDE.md

This file is the system prompt for the nanoclaw agent. It contains the full Pincer workflow: session lifecycle, `/act` format, permission graph explanation, requesting new nodes/edges, and the trust/audit endpoints.

This file **is** committed (global group CLAUDE.md is explicitly included in `.gitignore`).

### Skills

Skills live in `container/skills/` and are synced to `data/sessions/<group>/.claude/skills/` when the container runner starts. The relevant skills updated for Pincer:

- `container/skills/capabilities/SKILL.md` — `/capabilities` command; now queries the live Pincer graph instead of hardcoding capabilities
- `container/skills/status/SKILL.md` — `/status` command; removed agent-browser and WebSearch checks
- `container/skills/agent-browser/` — **deleted** (was listing a disabled tool as available)

---

## Verification Checklist

After setup, verify the full isolation:

```bash
# 1. Pincer is reachable from a container
docker run --rm --network nanoclaw-net \
  --add-host=host.docker.internal:172.19.0.1 \
  -e NO_PROXY=host.docker.internal \
  -e no_proxy=host.docker.internal \
  curlimages/curl:latest \
  curl -s http://host.docker.internal:8080/graph | python3 -c "import sys,json; print('Pincer OK, nodes:', len(json.load(sys.stdin)['nodes']))"

# 2. Non-Anthropic HTTPS is blocked (should get 000 = connection refused by proxy)
docker run --rm --network nanoclaw-net \
  --add-host=host.docker.internal:172.19.0.1 \
  -e HTTPS_PROXY=http://x:<token>@host.docker.internal:10255 \
  curlimages/curl:latest \
  curl -s --max-time 5 https://google.com/ -o /dev/null -w "%{http_code}"
# Expected: 000

# 3. Anthropic HTTPS is allowed (should get a real HTTP response)
docker run --rm --network nanoclaw-net \
  --add-host=host.docker.internal:172.19.0.1 \
  -e HTTPS_PROXY=http://x:<token>@host.docker.internal:10255 \
  -v /tmp/onecli-combined-ca.pem:/tmp/ca.pem:ro \
  -e SSL_CERT_FILE=/tmp/ca.pem \
  curlimages/curl:latest \
  curl -s --max-time 5 https://api.anthropic.com/ -o /dev/null -w "%{http_code}"
# Expected: 404 (server responded — path doesn't exist but connection works)

# 4. Direct internet bypass is impossible
docker run --rm --network nanoclaw-net \
  curlimages/curl:latest \
  curl -s --max-time 3 --noproxy "*" https://google.com/ -o /dev/null -w "%{http_code}"
# Expected: 000 (no default route)
```

---

## What to Check into Git

### ✅ Safe to commit (nanoclaw repo)

| Path | Notes |
|---|---|
| `src/` | All TypeScript source including the Pincer env var injection and NO_PROXY fix |
| `container/agent-runner/src/index.ts` | Has `disallowedTools` config |
| `container/skills/` | All skill SKILL.md files |
| `container/disabled-agent-browser` | Stub script |
| `scripts/anthropic-proxy.py` | Filtering proxy (no secrets) |
| `groups/global/CLAUDE.md` | Agent Pincer instructions |
| `.gitignore` | Updated to exclude data/, store/, logs/, .env |
| `SETUP_PINCER.md` | This file |

### ❌ Never commit

| Path | Why |
|---|---|
| `.env` | Bot tokens, OneCLI URL |
| `data/` | Per-session state, conversation history, IPC files |
| `store/` | Persistent agent storage |
| `logs/` | Runtime logs |
| `groups/*/` (except global/CLAUDE.md and main/CLAUDE.md) | May contain private conversations |
| `node_modules/` | Dependencies |
| `dist/` | Build output |

### External files (not in repo)

| File | How to recreate |
|---|---|
| `/home/<user>/.config/systemd/user/nanoclaw.service` | See Systemd section above |
| `/home/<user>/.config/systemd/user/anthropic-proxy.service` | See Filtering Proxy section above |
| `/home/<user>/.config/systemd/user/pincer.service` | See `Pincer/SETUP_PINCER.md` — Systemd Service section |
| `/etc/iptables/rules.v4` | Saved via `sudo iptables-save`; restore with `sudo iptables-restore < /etc/iptables/rules.v4` |
| `/tmp/onecli-combined-ca.pem` | Generated by OneCLI at startup; re-appears when OneCLI restarts |

---

## Troubleshooting

### "Pincer unavailable" from agent

Check:
1. Is `PINCER_PROXY_URL` set? → `docker inspect <container> | grep PINCER`
2. Is `NO_PROXY=host.docker.internal` set? → Without this, plain HTTP to port 8080 goes through the HTTPS proxy and gets 405.
3. Is `host.docker.internal` resolving correctly? → Must be `172.19.0.1`. Check with `docker exec <container> getent hosts host.docker.internal`.
4. Is Pincer running? → `curl http://localhost:8080/graph`

### agent-browser shows as available

The stub at `container/disabled-agent-browser` must exist and be executable. Check:
```bash
cat /srv/workspace/nanoclaw/container/disabled-agent-browser
```
If it doesn't exist, the shadow mount won't apply and the real `agent-browser` binary will be visible.

### WebSearch still available to agent

Ensure `disallowedTools: ['WebSearch', 'WebFetch']` is in `container/agent-runner/src/index.ts` AND the per-group agent-runner-src has been synced. The container-runner syncs this on startup, but existing long-running containers won't see the change until they're recycled.

### Non-Anthropic HTTPS not blocked (gets through)

Check `anthropic-proxy.service` is running on `172.19.0.1:10255`:
```bash
systemctl --user status anthropic-proxy.service
ss -tlnp | grep 10255
```
Also check that the `HTTPS_PROXY` env var is being injected by OneCLI (this is done automatically by OneCLI, not by nanoclaw).
