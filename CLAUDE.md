# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Ravenclaw is a collection of services for a home automation agent (OpenClaw) running on a Hetzner vCPU server. Sensitive infrastructure details (IPs, credentials, service config) are in `CLAUDE.local.md` (gitignored).

## doorbell-cli

A Node.js (ESM) service that monitors a UniFi Protect doorbell via WebSocket, captures snapshots on ring events, runs face recognition through CompreFace, and sends WhatsApp notifications via OpenClaw.

### Architecture

- **`index.mjs`** — Main service. Connects to UniFi Protect WebSocket, listens for `lastRing` changes on doorbell cameras, then orchestrates: snapshot capture → CompreFace recognition → WhatsApp notification + agent context injection.
- **`doorbell`** — Bash CLI tool for the OpenClaw agent to manage CompreFace (recognize, learn faces, list subjects, take snapshots). Installed to `/usr/local/bin/doorbell` on the server.

### Key integrations

- **UniFi Protect** (`unifi-protect` npm): WebSocket events + snapshot/event-thumbnail API. Self-signed certs require `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **CompreFace**: REST API for face recognition (`/api/v1/recognition/recognize`) and training (`/api/v1/recognition/faces?subject=<name>`). Runs as Docker containers on the same server.
- **OpenClaw Gateway**: `openclaw message send --media` for WhatsApp images. `POST /hooks/wake` to inject context into agent session. `POST /hooks/agent` with `deliver: true` for agent-driven conversations (e.g., asking who an unknown visitor is). Daily memory logs written to `~/.openclaw/workspace/memory/`.

### Snapshot strategy

On ring, the service takes multiple snapshot candidates (NVR event thumbnail + two timed live shots), runs all through CompreFace, and picks the one with the highest face detection confidence.

### Commands

```bash
cd doorbell-cli && npm install   # install dependencies
node index.mjs                   # run locally (needs OWNER_PHONE env var)
```

### Deployment

The service runs on the Hetzner server as a systemd user service (`doorbell-watcher.service`) under the `openclaw` user. The repo is cloned at `~/ravenclaw` on the server. Deploy by pushing to the remote and pulling on the server:

```bash
git push origin main
ssh openclaw@<server> 'cd ~/ravenclaw && git pull && systemctl --user restart doorbell-watcher'
```

### Environment variables

All secrets are passed via environment variables set in the systemd unit (`~/.config/systemd/user/doorbell-watcher.service`):

- `PROTECT_PASSWORD` — UniFi Protect password (**required**)
- `COMPREFACE_API_KEY` — CompreFace recognition API key (**required**)
- `OWNER_PHONE` — WhatsApp recipient in E.164 format (e.g., `+49...`)
- `HOOK_TOKEN` — OpenClaw gateway hook token (optional, has default)
- `NODE_TLS_REJECT_UNAUTHORIZED=0` — set by the systemd unit for UniFi self-signed certs
