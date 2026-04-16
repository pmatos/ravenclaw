import { ProtectApi } from "unifi-protect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, appendFile, readFile, readdir, rm } from "node:fs/promises";
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
  session: {
    settleMs: 8_000,
    preRingWindowMs: 10_000,
    postActivityMs: 5_000,
    maxSessionMs: 120_000,
    frameSampleIntervalMs: 500,
    earlyStopScore: 0.97,
    maxFrames: 40,
  },
};

// State — per-camera visit sessions instead of a global cooldown
/** @type {Map<string, object>} */
const activeSessions = new Map();

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

// --- Visit session lifecycle ---

function createSession(cameraId, ringTs) {
  return {
    cameraId,
    firstRingTs: ringTs,
    lastActivityTs: ringTs,
    events: [{ type: "ring", ts: ringTs }],
    settleTimer: null,
    settled: false,
    processing: false,
  };
}

function onRing(protect, camera, ringTs) {
  const existing = activeSessions.get(camera.id);
  if (existing && !existing.settled) {
    extendSession(camera.id, "ring", ringTs);
    return;
  }
  const session = createSession(camera.id, ringTs);
  activeSessions.set(camera.id, session);
  log(`Visit session started on ${camera.name}`);
  resetSettleTimer(protect, camera, session);
}

function extendSession(cameraId, eventType, ts, eventId) {
  const session = activeSessions.get(cameraId);
  if (!session || session.settled) return;
  session.events.push({ type: eventType, ts, eventId });
  session.lastActivityTs = Math.max(session.lastActivityTs, ts);
  log(`Session extended: ${eventType}${eventId ? ` (event ${eventId})` : ""}`);
  if (Date.now() - session.firstRingTs > CONFIG.session.maxSessionMs) {
    log("Session hit max duration, force-settling");
    clearTimeout(session.settleTimer);
    settleSession(session._protect, session._camera, session);
    return;
  }
  resetSettleTimer(session._protect, session._camera, session);
}

function resetSettleTimer(protect, camera, session) {
  // Stash protect/camera refs for extendSession to use
  session._protect = protect;
  session._camera = camera;
  if (session.settleTimer) clearTimeout(session.settleTimer);
  session.settleTimer = setTimeout(() => {
    settleSession(protect, camera, session);
  }, CONFIG.session.settleMs);
}

function settleSession(protect, camera, session) {
  if (session.settled) return;
  session.settled = true;
  session.processing = true;
  activeSessions.delete(camera.id);
  const duration = ((session.lastActivityTs - session.firstRingTs) / 1000).toFixed(1);
  log(`Session settled on ${camera.name}: ${session.events.length} events over ${duration}s`);
  processSession(protect, camera, session);
}

// --- Snapshot strategies ---

async function getBestFrameFromVideo(protect, camera, startTs, endTs) {
  const url = `https://${CONFIG.protect.address}/proxy/protect/api/video/export?` +
    `camera=${camera.id}&start=${startTs}&end=${endTs}`;
  const resp = await fetch(url, { headers: protect.headers });
  if (!resp.ok) throw new Error(`Video export HTTP ${resp.status}`);

  const videoPath = `${CONFIG.openclaw.snapDir}/visit_clip.mp4`;
  const videoBuffer = Buffer.from(await resp.arrayBuffer());
  await writeFile(videoPath, videoBuffer);
  const clipDuration = ((endTs - startTs) / 1000).toFixed(1);
  log(`Video clip: ${videoBuffer.length} bytes, ${clipDuration}s`);

  const frameDir = `${CONFIG.openclaw.snapDir}/frames`;
  if (!existsSync(frameDir)) mkdirSync(frameDir, { recursive: true });

  const fps = 1000 / CONFIG.session.frameSampleIntervalMs;
  await execFileAsync("ffmpeg", [
    "-y", "-i", videoPath,
    "-vf", `fps=${fps}`,
    "-frames:v", String(CONFIG.session.maxFrames),
    "-q:v", "2",
    `${frameDir}/frame_%04d.jpg`
  ], { timeout: 30_000 });

  const frameFiles = (await readdir(frameDir)).filter(f => f.endsWith(".jpg")).sort();
  if (frameFiles.length === 0) throw new Error("No frames extracted");
  log(`Extracted ${frameFiles.length} frames from video`);

  let best = null;
  let bestScore = -1;

  for (const file of frameFiles) {
    const frameData = await readFile(`${frameDir}/${file}`);
    const result = await recognizeFace(frameData);
    const faces = result.result || [];
    const topScore = faces.length > 0
      ? Math.max(...faces.map(f => f.box?.probability || 0))
      : 0;
    log(`${file}: ${faces.length} face(s), score ${topScore.toFixed(3)}`);

    if (topScore > bestScore) {
      bestScore = topScore;
      best = { source: `video-frame-${file}`, data: frameData, score: topScore, recognitionResult: result };
    }
    if (topScore >= CONFIG.session.earlyStopScore) {
      log(`Early stop on ${file}`);
      break;
    }
  }

  await rm(frameDir, { recursive: true, force: true });
  await rm(videoPath, { force: true });

  return best;
}

async function getBestFromEventThumbnails(protect, session) {
  const eventsWithIds = session.events.filter(e => e.eventId);
  if (eventsWithIds.length === 0) return null;

  let best = null;
  let bestScore = -1;

  for (const ev of eventsWithIds) {
    const thumb = await fetchEventThumbnail(protect, ev.eventId);
    if (!thumb || thumb.length < 1000) continue;

    const result = await recognizeFace(thumb);
    const faces = result.result || [];
    const topScore = faces.length > 0
      ? Math.max(...faces.map(f => f.box?.probability || 0))
      : 0;
    log(`Event thumbnail ${ev.eventId}: ${faces.length} face(s), score ${topScore.toFixed(3)}`);

    if (topScore > bestScore) {
      bestScore = topScore;
      best = { source: `event-thumb-${ev.eventId}`, data: thumb, score: topScore, recognitionResult: result };
    }
  }

  return best;
}

async function getAdaptiveSnapshot(protect, camera) {
  const delays = [0, 1000, 2500, 5000];
  let best = null;
  let bestScore = -1;

  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));

    try {
      const snap = await fetchSnapshot(protect, camera);
      const result = await recognizeFace(snap);
      const faces = result.result || [];
      const topScore = faces.length > 0
        ? Math.max(...faces.map(f => f.box?.probability || 0))
        : 0;
      log(`Adaptive snap ${delay}ms: ${faces.length} face(s), score ${topScore.toFixed(3)}`);

      if (topScore > bestScore) {
        bestScore = topScore;
        best = { source: `adaptive-snap-${delay}ms`, data: snap, score: topScore, recognitionResult: result };
      }
      if (topScore >= CONFIG.session.earlyStopScore) break;
    } catch (err) {
      log(`Adaptive snapshot at ${delay}ms failed: ${err.message}`);
    }
  }

  return best;
}

// --- Session processing ---

async function processSession(protect, camera, session) {
  const startTs = session.firstRingTs - CONFIG.session.preRingWindowMs;
  const endTs = session.lastActivityTs + CONFIG.session.postActivityMs;
  log(`Processing session on ${camera.name}: window ${new Date(startTs).toISOString()} to ${new Date(endTs).toISOString()}`);

  let best = null;

  // Strategy 1: Video export + frame extraction (includes pre-ring frames)
  try {
    best = await getBestFrameFromVideo(protect, camera, startTs, endTs);
    if (best) log(`Video strategy: best score ${best.score.toFixed(3)}`);
  } catch (err) {
    log(`Video extraction failed: ${err.message}`);
  }

  // Strategy 2: Event thumbnails from all session events
  if (!best || best.score < CONFIG.session.earlyStopScore) {
    try {
      const thumbBest = await getBestFromEventThumbnails(protect, session);
      if (thumbBest && (!best || thumbBest.score > best.score)) {
        best = thumbBest;
        log(`Event thumbnail strategy: best score ${best.score.toFixed(3)}`);
      }
    } catch (err) {
      log(`Event thumbnail strategy failed: ${err.message}`);
    }
  }

  // Strategy 3: Adaptive live snapshots (fallback)
  if (!best || best.score < 0.5) {
    try {
      const snapBest = await getAdaptiveSnapshot(protect, camera);
      if (snapBest && (!best || snapBest.score > best.score)) {
        best = snapBest;
        log(`Adaptive snapshot strategy: best score ${best.score.toFixed(3)}`);
      }
    } catch (err) {
      log(`Adaptive snapshot failed: ${err.message}`);
    }
  }

  // Last resort: single snapshot
  if (!best) {
    log("No candidates from any strategy, taking last-resort snapshot");
    try {
      const snap = await fetchSnapshot(protect, camera);
      best = { source: "last-resort", data: snap, score: 0, recognitionResult: await recognizeFace(snap) };
    } catch (err) {
      log(`Last-resort snapshot failed: ${err.message}`);
      return;
    }
  }

  log(`Best result: ${best.source} (score ${best.score.toFixed(3)})`);
  await notifyVisit(camera, session, best);
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

async function notifyVisit(camera, session, best) {
  try {
    const snapshot = best.data;
    const result = best.recognitionResult;
    const snapPath = `${CONFIG.openclaw.snapDir}/latest_ring.jpg`;
    await writeFile(snapPath, snapshot);
    log(`Snapshot saved (${snapshot.length} bytes, source: ${best.source})`);

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
        agentFollowUp = `An unknown person just rang the doorbell. A photo was already sent to WhatsApp with the caption "${caption}". Your reply will be delivered directly as a WhatsApp message — do NOT describe what you plan to send, just write the message itself. Ask Paulo if he knows who this person is. If Paulo later replies with a name, run: doorbell learn "<name>" ${unknownPath}`;
      }
    }

    log(`Sending image: ${caption}`);
    await sendImage(snapPath, caption);

    const ringCount = session.events.filter(e => e.type === "ring").length;
    const duration = ((session.lastActivityTs - session.firstRingTs) / 1000).toFixed(0);
    await logToMemory(`Doorbell visit (${ringCount} ring(s), ${duration}s, best: ${best.source}). ${caption}`);

    const timestamp = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin" });

    if (agentFollowUp) {
      // Unknown visitor: trigger agent directly — skip injectContext to avoid
      // the agent seeing the event in its session and sending a duplicate message later.
      log("Triggering agent for face learning...");
      await triggerAgentWithDelivery(agentFollowUp);
    } else {
      await injectContext(`DOORBELL EVENT at ${timestamp}: ${caption} A snapshot was sent to Paulo via WhatsApp.`);
    }
  } catch (err) {
    log(`Error in notifyVisit: ${err.message}`);
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

  // Listen for real-time events — rings start sessions, motion/smart-detect extend them
  protect.on("message", (packet) => {
    const { action, modelKey, id: deviceId } = packet.header ?? {};
    const payload = packet.payload;
    if (!payload || typeof payload !== "object") return;

    // Camera property updates (lastRing, lastMotion, isSmartDetected)
    if (action === "update" && modelKey === "camera") {
      const cam = doorbells.find(d => d.id === deviceId);
      if (!cam) return;

      if ("lastRing" in payload && payload.lastRing > (ringTimestamps[cam.id] || 0)) {
        ringTimestamps[cam.id] = payload.lastRing;
        log(`Ring event: ${cam.name} at ${new Date(payload.lastRing).toISOString()}`);
        onRing(protect, cam, payload.lastRing);
      }
      if ("lastMotion" in payload && activeSessions.has(cam.id)) {
        extendSession(cam.id, "motion", payload.lastMotion);
      }
      if (payload.isSmartDetected && activeSessions.has(cam.id)) {
        extendSession(cam.id, "smartDetect", Date.now());
      }
    }

    // Event objects carry eventIds useful for fetching thumbnails
    if (action === "add" && modelKey === "event") {
      const camId = payload.camera;
      if (!camId || !activeSessions.has(camId)) return;
      const evType = payload.type;
      if (evType === "smartDetectZone" || evType === "ring") {
        extendSession(camId, evType, payload.start || Date.now(), payload.id);
      }
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
