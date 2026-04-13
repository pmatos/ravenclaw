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

On ring, a **visit session** starts per camera. Subsequent ring, motion, and smart-detect events extend the session. After 8 seconds of quiet (no new events), the session settles and processing begins with a three-tier strategy:

1. **Video frame extraction** (primary): Fetches an MP4 clip from the NVR covering 10s before the first ring through 5s after the last activity, extracts frames with `ffmpeg` at 2fps, and scores each through CompreFace with early-stop.
2. **Event thumbnails** (supplement): Fetches NVR thumbnails from all ring/smart-detect events captured during the session.
3. **Adaptive live snapshots** (fallback): Takes snapshots at increasing delays with early-stop on good face detection score.

The best candidate across all strategies is sent as a single WhatsApp notification per visit. Requires `ffmpeg` on the server.

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
- `DOORBELL_TARGET` — WhatsApp recipient: group JID (e.g., `120363...@g.us`) or phone in E.164 format. Falls back to `OWNER_PHONE` if not set.
- `HOOK_TOKEN` — OpenClaw gateway hook token (**required**)
- `NODE_TLS_REJECT_UNAUTHORIZED=0` — set by the systemd unit for UniFi self-signed certs

### Security

**Never commit secrets to this repo.** All credentials must come from environment variables. The `doorbell` CLI script and `index.mjs` both read secrets from env vars at runtime.

Git history was rewritten on 2026-04-12 to scrub previously committed secrets. Credentials that were exposed should be rotated:
- UniFi Protect password
- CompreFace API key
