import { ProtectApi } from "unifi-protect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, appendFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";

const execFileAsync = promisify(execFile);

// Configuration — secrets come from environment variables
const CONFIG = {
  protect: {
    address: process.env.PROTECT_ADDRESS || "192.168.178.165",
    username: process.env.PROTECT_USERNAME || "ravenclaw",
    password: process.env.PROTECT_PASSWORD,
  },
  compreface: {
    url: process.env.COMPREFACE_URL || "http://localhost:8000",
    apiKey: process.env.COMPREFACE_API_KEY,
  },
  openclaw: {
    target: null,
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789",
    hookToken: null,
    memoryDir: null,
  },
  ringCooldownMs: 30_000,
};

// State
let lastRingTime = 0;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function fetchSnapshot(protect, camera) {
  const snapshot = await protect.getSnapshot(camera, { width: 1920, height: 1440 });
  if (!snapshot) throw new Error("Snapshot returned null");
  return snapshot;
}

async function fetchEventThumbnail(protect, eventId) {
  try {
    const resp = await fetch(
      `https://${CONFIG.protect.address}/proxy/protect/api/events/${eventId}/thumbnail?w=1920`,
      { headers: protect.headers }
    );
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

async function findRingEvent(protect, cameraId, ringTimestamp) {
  // Find the ring event created around the ring timestamp
  try {
    const start = ringTimestamp - 5000;
    const end = ringTimestamp + 5000;
    const resp = await fetch(
      `https://${CONFIG.protect.address}/proxy/protect/api/events?start=${start}&end=${end}&cameras=${cameraId}&types=ring&limit=1`,
      { headers: protect.headers }
    );
    if (!resp.ok) return null;
    const events = await resp.json();
    return events.length > 0 ? events[0] : null;
  } catch {
    return null;
  }
}

async function getBestSnapshot(protect, camera, ringTimestamp) {
  // Strategy: take multiple shots and pick the best face
  const candidates = [];

  // 1. Try event thumbnail (captured by NVR at ring time)
  const ringEvent = await findRingEvent(protect, camera.id, ringTimestamp);
  if (ringEvent) {
    const thumb = await fetchEventThumbnail(protect, ringEvent.id);
    if (thumb && thumb.length > 1000) {
      candidates.push({ source: "event-thumbnail", data: thumb });
    }
  }

  // 2. Take live snapshots spread over ~12s to catch the person approaching
  for (const delay of [1000, 2500, 4000, 5500, 7000, 8500, 10000, 11500]) {
    const elapsed = Date.now() - ringTimestamp;
    const wait = delay - elapsed;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    try {
      const snap = await fetchSnapshot(protect, camera);
      candidates.push({ source: `snapshot-${delay}ms`, data: snap });
    } catch (err) {
      log(`Snapshot at ${delay}ms failed: ${err.message}`);
    }
  }

  if (candidates.length === 0) throw new Error("No snapshots captured");

  // Run all through CompreFace, pick the one with best face probability
  let best = null;
  let bestScore = -1;

  for (const c of candidates) {
    const result = await recognizeFace(c.data);
    const faces = result.result || [];
    const topScore = faces.length > 0
      ? Math.max(...faces.map(f => f.box?.probability || 0))
      : 0;
    log(`${c.source}: ${c.data.length} bytes, ${faces.length} face(s), best score ${topScore.toFixed(3)}`);

    if (topScore > bestScore) {
      bestScore = topScore;
      best = { ...c, recognitionResult: result };
    }
  }

  // If no faces found in any, just use the largest image
  if (bestScore <= 0) {
    best = candidates.reduce((a, b) => a.data.length > b.data.length ? a : b);
    best.recognitionResult = await recognizeFace(best.data);
  }

  log(`Best snapshot: ${best.source} (score ${bestScore.toFixed(3)})`);
  return best;
}

async function recognizeFace(imageBuffer) {
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: "image/jpeg" }), "snapshot.jpg");

  const resp = await fetch(
    `${CONFIG.compreface.url}/api/v1/recognition/recognize`,
    {
      method: "POST",
      headers: { "x-api-key": CONFIG.compreface.apiKey },
      body: formData,
    }
  );

  const data = await resp.json();
  return data;
}

async function addFace(name, imageBuffer) {
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: "image/jpeg" }), "face.jpg");

  const resp = await fetch(
    `${CONFIG.compreface.url}/api/v1/recognition/faces?subject=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "x-api-key": CONFIG.compreface.apiKey },
      body: formData,
    }
  );

  return resp.json();
}

async function sendImage(imagePath, caption) {
  const target = CONFIG.openclaw.target;
  if (!target) return;

  const args = [
    "message", "send",
    "--channel", "whatsapp",
    "--target", target,
    "--media", imagePath,
    "--message", caption,
  ];

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { stdout } = await execFileAsync("openclaw", args, { timeout: 60_000 });
      if (stdout) log(`Image sent: ${stdout.trim()}`);
      return;
    } catch (err) {
      log(`Image send error (attempt ${attempt}/${maxRetries}): ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 5_000));
      }
    }
  }
}

async function injectContext(text) {
  // POST /hooks/wake injects a system event into the main session
  try {
    const resp = await fetch(`${CONFIG.openclaw.gatewayUrl}/hooks/wake`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CONFIG.openclaw.hookToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, mode: "now" }),
    });
    const data = await resp.json();
    log(`Context injected via /hooks/wake: ${JSON.stringify(data)}`);
  } catch (err) {
    log(`Context inject error: ${err.message}`);
  }
}

async function triggerAgentWithDelivery(message) {
  // POST /hooks/agent runs a full agent turn and delivers to WhatsApp
  try {
    const resp = await fetch(`${CONFIG.openclaw.gatewayUrl}/hooks/agent`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CONFIG.openclaw.hookToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        name: "Doorbell",
        deliver: true,
        channel: "whatsapp",
        to: CONFIG.openclaw.target,
      }),
    });
    const data = await resp.json();
    log(`Agent triggered via /hooks/agent: ${JSON.stringify(data)}`);
  } catch (err) {
    log(`Agent trigger error: ${err.message}`);
  }
}

async function logToMemory(entry) {
  if (!CONFIG.openclaw.memoryDir) return;
  const today = new Date().toISOString().split("T")[0];
  const file = `${CONFIG.openclaw.memoryDir}/${today}.md`;
  const line = `- ${new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin" })} — ${entry}\n`;
  try {
    await appendFile(file, line);
    log(`Memory logged: ${entry}`);
  } catch (err) {
    log(`Memory log error: ${err.message}`);
  }
}

async function handleDoorbellRing(protect, camera) {
  const now = Date.now();

  // Cooldown to avoid duplicate notifications
  if (now - lastRingTime < CONFIG.ringCooldownMs) {
    log("Ring ignored (cooldown)");
    return;
  }
  lastRingTime = now;

  log(`Doorbell ring detected on ${camera.name}!`);

  try {
    // Get best snapshot from multiple candidates
    const ringTimestamp = Date.now();
    const best = await getBestSnapshot(protect, camera, ringTimestamp);
    const snapshot = best.data;
    const result = best.recognitionResult;
    const snapPath = `${CONFIG.openclaw.snapDir}/latest_ring.jpg`;
    await writeFile(snapPath, snapshot);
    log(`Snapshot saved (${snapshot.length} bytes, source: ${best.source})`);

    // Determine who it is and notify
    let caption;
    let agentFollowUp;

    if (result.code === 28 || !result.result || result.result.length === 0) {
      caption = "Someone rang the doorbell but I couldn't see their face.";
      agentFollowUp = null;
    } else {
      const faces = result.result;
      const recognized = faces
        .filter(f => f.subjects && f.subjects.length > 0 && f.subjects[0].similarity > 0.9)
        .map(f => f.subjects[0].subject);

      if (recognized.length > 0) {
        const names = recognized.join(" and ");
        caption = `${names} is at the door.`;
        agentFollowUp = null;
      } else {
        const unknownPath = `${CONFIG.openclaw.snapDir}/unknown_visitor.jpg`;
        await writeFile(unknownPath, snapshot);
        caption = "Someone I don't recognize is at the door.";
        agentFollowUp = `I just sent Paulo a doorbell photo of someone I don't recognize. The photo is at ${unknownPath}. Ask Paulo who it is. When he replies with a name, run: doorbell learn "<name>" ${unknownPath}`;
      }
    }

    // 1. Send the snapshot image directly via WhatsApp (reliable)
    log(`Sending image: ${caption}`);
    await sendImage(snapPath, caption);

    // 2. Log to memory for durable history
    await logToMemory(`Doorbell rang. ${caption}`);

    // 3. Inject context into agent session so Ravenclaw remembers
    const timestamp = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin" });
    await injectContext(`DOORBELL EVENT at ${timestamp}: ${caption} A snapshot was sent to Paulo via WhatsApp.`);

    // 4. For unknown faces, trigger agent to ask who it is
    if (agentFollowUp) {
      log("Triggering agent for face learning...");
      await triggerAgentWithDelivery(agentFollowUp);
    }
  } catch (err) {
    log(`Error handling ring: ${err.message}`);
    console.error(err);
  }
}

async function main() {
  const required = ["PROTECT_PASSWORD", "COMPREFACE_API_KEY"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    log(`FATAL: Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  CONFIG.openclaw.target = process.env.DOORBELL_TARGET || process.env.OWNER_PHONE || null;
  CONFIG.openclaw.hookToken = process.env.HOOK_TOKEN || "";
  if (!CONFIG.openclaw.target) {
    log("WARNING: DOORBELL_TARGET not set. Set it to a WhatsApp phone or group JID.");
  }

  // Set up memory and snapshot directories inside the workspace
  const home = process.env.HOME || "/home/openclaw";
  const memDir = `${home}/.openclaw/workspace/memory`;
  const snapDir = `${home}/.openclaw/workspace/doorbell`;
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
  if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true });
  CONFIG.openclaw.memoryDir = memDir;
  CONFIG.openclaw.snapDir = snapDir;

  // Disable TLS verification for UniFi self-signed cert
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  log("Connecting to UniFi Protect...");
  const protect = new ProtectApi();

  const loginOk = await protect.login(
    CONFIG.protect.address,
    CONFIG.protect.username,
    CONFIG.protect.password
  );

  if (!loginOk) {
    log("Failed to login to UniFi Protect");
    process.exit(1);
  }

  log("Logged in successfully");

  // Get bootstrap data
  const bootstrapOk = await protect.getBootstrap();
  if (!bootstrapOk || !protect.bootstrap) {
    log("Failed to get bootstrap data");
    process.exit(1);
  }

  // Find doorbell cameras
  const doorbells = protect.bootstrap.cameras.filter(c => c.featureFlags?.isDoorbell);
  log(`Found ${doorbells.length} doorbell(s): ${doorbells.map(d => d.name).join(", ")}`);

  if (doorbells.length === 0) {
    log("No doorbells found. Exiting.");
    process.exit(1);
  }

  // Track lastRing timestamps
  const ringTimestamps = {};
  for (const cam of doorbells) {
    ringTimestamps[cam.id] = cam.lastRing || 0;
    log(`${cam.name}: initial lastRing = ${cam.lastRing}`);
  }

  // Listen for real-time events
  protect.on("message", (packet) => {
    if (packet.header?.action !== "update" || packet.header?.modelKey !== "camera") return;

    const payload = packet.payload;
    if (!payload || typeof payload !== "object" || !("lastRing" in payload)) return;

    const camId = packet.header.id;
    const newRing = payload.lastRing;

    if (doorbells.some(d => d.id === camId) && newRing > (ringTimestamps[camId] || 0)) {
      ringTimestamps[camId] = newRing;
      const camera = doorbells.find(d => d.id === camId);
      log(`Ring event: ${camera.name} at ${new Date(newRing).toISOString()}`);
      handleDoorbellRing(protect, camera);
    }
  });

  log("Listening for doorbell events...");

  // Keep alive — reconnect on disconnect
  protect.on("close", () => {
    log("WebSocket closed. Reconnecting in 10s...");
    setTimeout(() => main(), 10_000);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
