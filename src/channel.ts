/**
 * Claw Sama Channel Plugin — standard ChannelPlugin interface.
 *
 * Makes the VRM avatar a first-class channel in OpenClaw, using the same
 * dispatchReply/deliver pattern as DingTalk, Synology Chat, etc.
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { getClawSamaRuntime } from "./runtime.js";
import { broadcastToVrm, addSseClient, removeSseClient, type VrmBroadcastPayload } from "./sse.js";
import { stripThinking, stripActions, stripMarkdown, stripEmoji, stripForTts, splitSentences, VALID_EMOTIONS } from "./text-utils.js";
import { edgeTts, qwenTts, registerAudioFile, getAudioFile } from "./tts.js";
import { getPrefs, updatePrefs, setPrefs, EXT_DIR, workspaceRoot, openclawWorkspaceRoot } from "./prefs.js";
import type { ClawSamaPrefs } from "./prefs.js";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const CHANNEL_ID = "claw-sama";
const CLAW_SESSION_KEY = "agent:main:main";
const GATEWAY_URL = "http://127.0.0.1:18789";

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

// Route handler map: startAccount populates, index.ts proxy reads
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export const routeHandlers = new Map<string, RouteHandler>();

export interface ClawSamaRouteSpec {
  path: string;
  match?: "exact" | "prefix";
}

export const CLAW_SAMA_ROUTES: ClawSamaRouteSpec[] = [
  { path: "/plugins/claw-sama/events" },
  { path: "/plugins/claw-sama/audio", match: "prefix" },
  { path: "/plugins/claw-sama/media", match: "prefix" },
  { path: "/plugins/claw-sama/chat" },
  { path: "/plugins/claw-sama/touch" },
  { path: "/plugins/claw-sama/voice" },
  { path: "/plugins/claw-sama/preview" },
  { path: "/plugins/claw-sama/settings" },
  { path: "/plugins/claw-sama/persona" },
  { path: "/plugins/claw-sama/persona/screenshot" },
  { path: "/plugins/claw-sama/persona/generate" },
  { path: "/plugins/claw-sama/screen/observe" },
  { path: "/plugins/claw-sama/model/list" },
  { path: "/plugins/claw-sama/model/serve", match: "prefix" },
  { path: "/plugins/claw-sama/model/import" },
  { path: "/plugins/claw-sama/dance/list" },
  { path: "/plugins/claw-sama/dance/serve", match: "prefix" },
  { path: "/plugins/claw-sama/dance/import" },
  { path: "/plugins/claw-sama/dance/delete" },
  { path: "/plugins/claw-sama/history" },
  { path: "/plugins/claw-sama/context/clear" },
  { path: "/plugins/claw-sama/mood/adjust" },
  { path: "/plugins/claw-sama/session/memo" },
];

export function buildClawSamaSystemPrompt(): string {
  const moodIndex = currentMood;
  const lines = [
    `You have a virtual VRM avatar displayed on the user's screen. Use the "claw_sama_emotion" tool to control your facial expression. Always call it AFTER your text reply. Available emotions: ${VALID_EMOTIONS.join(", ")}.`,
    `The tool also accepts a "mood_delta" parameter (-3 to +3) to adjust YOUR OWN mood index. Always include it based on how the conversation makes YOU feel as a character.`,
    `Your current mood index: ${moodIndex}% (0=very sad, 50=neutral, 100=very happy). This reflects YOUR emotional state. React naturally — if the user is kind, your mood goes up; if they're mean or the topic is depressing, your mood drops.`,
    "The user's input may come from speech recognition and could contain typos or homophones — infer the intended meaning from context.",
    "Keep replies concise and conversational — they are displayed as speech bubbles.",
  ];
  const ssPath = path.join(workspaceRoot, "persona-screenshot.png");
  if (existsSync(ssPath)) {
    lines.push(`Your character image (use the read tool to view): ${ssPath}`);
  }
  return lines.join("\n");
}

async function captureDesktopScreenshot(savePath: string): Promise<boolean> {
  try {
    mkdirSync(path.dirname(savePath), { recursive: true });
    if (process.platform === "darwin") {
      await execFileAsync("screencapture", ["-x", "-C", savePath], { timeout: 10_000 });
    } else if (process.platform === "win32") {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save('${savePath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`.trim();
      await execFileAsync("powershell", ["-NoProfile", "-Command", ps], { timeout: 15_000 });
    } else {
      try { await execFileAsync("gnome-screenshot", ["-f", savePath], { timeout: 10_000 }); }
      catch {
        try { await execFileAsync("scrot", [savePath], { timeout: 10_000 }); }
        catch { await execFileAsync("import", ["-window", "root", savePath], { timeout: 10_000 }); }
      }
    }
    return existsSync(savePath);
  } catch {
    return false;
  }
}


// Runtime mood state (not persisted)
const MOOD_BASELINE = 60;
const MOOD_DECAY_INTERVAL_MS = 60_000;
let currentMood = MOOD_BASELINE;
let lastMoodChangeTime = Date.now();

// Mood decay: every 60s, move mood 1 point toward the baseline
// Only decay if no mood change happened in the last 60s
setInterval(() => {
  if (Date.now() - lastMoodChangeTime < MOOD_DECAY_INTERVAL_MS) return;
  if (currentMood === MOOD_BASELINE) return;
  const delta = currentMood > MOOD_BASELINE ? -1 : 1;
  currentMood = currentMood + delta;
  broadcastToVrm({ moodDelta: delta, moodIndex: currentMood });
}, MOOD_DECAY_INTERVAL_MS);

// workspaceRoot imported from prefs.js

// Registry for serving local media files to the frontend
const mediaFileRegistry = new Map<string, string>();

/** Resolve a local or remote media URL to a servable URL and broadcast it. */
function broadcastMediaUrl(rawUrl: string | undefined): void {
  if (!rawUrl) return;
  console.log("[claw-sama] broadcastMediaUrl raw:", rawUrl);
  let serveUrl = rawUrl;
  if (!rawUrl.startsWith("http")) {
    const filePath = path.isAbsolute(rawUrl) ? rawUrl : path.resolve(rawUrl);
    if (!existsSync(filePath)) {
      console.log("[claw-sama] media file not found:", filePath);
      return;
    }
    const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mediaFileRegistry.set(id, filePath);
    serveUrl = `${GATEWAY_URL}/plugins/claw-sama/media/${id}`;
  }
  console.log("[claw-sama] broadcasting imageUrl:", serveUrl);
  broadcastToVrm({ imageUrl: serveUrl });
}

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) return;
    if (signal.aborted) { complete(); return; }
    signal.addEventListener("abort", complete, { once: true });
  });
}

/**
 * Streaming TTS tracker — generates TTS for complete sentences as they arrive
 * during streaming, without waiting for the final result.
 */
class StreamingTtsTracker {
  private sentencesSent = 0;     // how many sentences already checked (in accumulated text)
  private audioDispatched = 0;   // contiguous audio index counter (only for TTS-worthy sentences)
  private accumulatedText = "";  // full text accumulated across all blocks

  constructor(private log?: { warn: (msg: string) => void }) {}

  /**
   * Call on each deliver (streaming block or final).
   * `blockText` is the text from the current block (NOT cumulative).
   * The tracker accumulates internally and sends TTS for newly completed sentences.
   */
  process(blockText: string, isFinal: boolean) {
    if (isFinal) {
      // Final block replaces accumulated text (it contains the complete reply)
      this.accumulatedText = blockText;
    } else {
      // Streaming block — append to accumulated text
      this.accumulatedText += blockText;
    }

    const allSentences = splitSentences(this.accumulatedText);

    // During streaming: only send TTS for sentences that are "complete"
    // If the last sentence ends with sentence-ending punctuation, treat it as complete too
    const SENTENCE_END_RE = /[。！？；.!?;]$/;
    const lastSentence = allSentences[allSentences.length - 1] ?? "";
    const lastIsComplete = isFinal || SENTENCE_END_RE.test(lastSentence.trim());
    const completeSentences = lastIsComplete ? allSentences : allSentences.slice(0, -1);
    const newSentences = completeSentences.slice(this.sentencesSent);
    this.sentencesSent = completeSentences.length;

    if (newSentences.length === 0) return;

    // Filter out sentences that produce empty TTS text (e.g. emoji-only, whitespace)
    // to avoid holes in the audio index sequence
    const ttsWorthy = newSentences.filter((s) => stripForTts(s).length > 0);
    if (ttsWorthy.length === 0) return;

    // On final, compute total TTS-worthy sentences across the entire text
    const totalAudio = isFinal
      ? allSentences.filter((s) => stripForTts(s).length > 0).length
      : 0;

    for (const sentence of ttsWorthy) {
      const idx = this.audioDispatched++;
      // During streaming, audioTotal=0 signals "unknown total" to the frontend;
      // the final call will broadcast the correct total.
      const total = isFinal ? totalAudio : 0;
      generateTtsUrl(sentence, this.log).then((audioUrl) => {
        if (audioUrl) broadcastToVrm({ audioUrl, audioIndex: idx, audioTotal: total });
      });
    }
  }
}

/**
 * Generate TTS for a text snippet and return an audio URL, or undefined.
 */
async function generateTtsUrl(text: string, log?: { warn: (msg: string) => void }): Promise<string | undefined> {
  const prefs = getPrefs();
  const ttsText = stripForTts(text);
  if (!ttsText || /^[。！？；.!?;、，,…\s]+$/.test(ttsText)) return undefined;

  const provider = (prefs.provider === "qwen" && prefs.qwenKey) ? "qwen" : "edge";
  console.log(`[claw-sama] TTS request: provider=${provider} text="${ttsText.slice(0, 60)}${ttsText.length > 60 ? "..." : ""}"`);

  try {
    let result: { success: boolean; audioPath?: string; error?: string };
    if (provider === "qwen") {
      result = await qwenTts({
        text: ttsText,
        apiKey: prefs.qwenKey!,
        voice: prefs.voice,
        model: prefs.qwenModel,
        extDir: EXT_DIR,
        language: prefs.language || "zh",
      });
    } else {
      result = await edgeTts({ text: ttsText, voice: prefs.voice });
    }
    if (result.success && result.audioPath) {
      const audioId = registerAudioFile(result.audioPath);
      return `${GATEWAY_URL}/plugins/claw-sama/audio/${audioId}`;
    }
    log?.warn("claw-sama TTS failed: " + (result.error || "unknown error"));
  } catch (err) {
    log?.warn("claw-sama TTS error: " + String(err));
  }
  return undefined;
}

// Helper to read JSON body from request
async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// CORS preflight helper
function handleCors(req: IncomingMessage, res: ServerResponse, methods: string): boolean {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }
  return false;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}


export function createClawSamaPlugin() {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "Claw Sama",
      selectionLabel: "Claw Sama (VRM Avatar)",
      detailLabel: "Claw Sama VRM Desktop Pet",
      docsPath: "/channels/claw-sama",
      blurb: "Display agent messages on a VRM avatar with emotion expressions",
      order: 100,
    },

    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },

    capabilities: {
      chatTypes: ["direct" as const],
      blockStreaming: true,
      media: true,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
    },

    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1, idleMs: 50 },
    },

    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: () => ({
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: true,
      }),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      setAccountEnabled: ({ cfg, enabled }: any) => ({
        ...cfg,
        channels: {
          ...cfg?.channels,
          [CHANNEL_ID]: { ...cfg?.channels?.[CHANNEL_ID], enabled },
        },
      }),
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 4000,
      resolveTarget: ({ to }: any) => {
        console.log("[claw-sama] resolveTarget called:", { to });
        return { ok: true, to: to ?? "claw-sama:local" };
      },

      sendText: async ({ to, text }: any) => {
        console.log("[claw-sama] sendText called:", { to, textLen: text?.length });
        // Outbound messages from other channels or /send — broadcast to VRM
        const cleaned = stripActions(text.replace(/<think>[\s\S]*?<\/think>/g, "")).trim();
        if (cleaned) {
          broadcastToVrm({ text: cleaned });
          // Fire-and-forget TTS
          const sentences = splitSentences(cleaned);
          const total = sentences.length;
          sentences.forEach((sentence, index) => {
            generateTtsUrl(sentence).then((audioUrl) => {
              if (audioUrl) broadcastToVrm({ audioUrl, audioIndex: index, audioTotal: total });
            });
          });
        }
        return { channel: CHANNEL_ID, messageId: `cs-${Date.now()}`, chatId: to };
      },

      sendMedia: async ({ to, text, mediaUrl }: any) => {
        console.log("[claw-sama] sendMedia called:", { to, mediaUrl, textLen: text?.length });
        // Only support image files
        const VALID_IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];
        const ext = path.extname(mediaUrl || "").toLowerCase();
        if (!VALID_IMAGE_EXTS.includes(ext)) {
          throw new Error(`Unsupported media type: ${ext}. Only images are supported.`);
        }
        broadcastMediaUrl(mediaUrl);
        const cleaned = text ? stripActions(text.replace(/<think>[\s\S]*?<\/think>/g, "")).trim() : "";
        if (cleaned) {
          broadcastToVrm({ text: cleaned });
          // Generate TTS for the text
          const sentences = splitSentences(cleaned);
          const total = sentences.length;
          sentences.forEach((sentence, index) => {
            generateTtsUrl(sentence).then((audioUrl) => {
              if (audioUrl) broadcastToVrm({ audioUrl, audioIndex: index, audioTotal: total });
            });
          });
        }
        return { channel: CHANNEL_ID, messageId: `cs-${Date.now()}`, chatId: to };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { log, cfg } = ctx;
        const channelRuntime = ctx.channelRuntime ?? getClawSamaRuntime().channel;

        log?.info?.("Starting Claw Sama channel");

        // ── Populate route handlers (actual routes are registered via api.registerHttpRoute in index.ts) ──

        function registerRoute(
          routePath: string,
          handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
          _opts?: { match?: "exact" | "prefix" },
        ) {
          routeHandlers.set(routePath, handler);
        }

        // ── SSE endpoint ──
        registerRoute("/plugins/claw-sama/events", (req, res) => {
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          res.write("\n");
          addSseClient(res);
          req.on("close", () => removeSseClient(res));
        });

        // ── Audio file serving ──
        registerRoute("/plugins/claw-sama/audio", (req, res) => {
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          const url = req.url ?? "";
          const audioId = url.split("/plugins/claw-sama/audio/")[1]?.split("?")[0];
          if (!audioId) { jsonResponse(res, 400, { error: "missing audio id" }); return; }
          const filePath = getAudioFile(audioId);
          if (!filePath || !existsSync(filePath)) { jsonResponse(res, 404, { error: "not found" }); return; }
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          try {
            const data = readFileSync(filePath);
            res.writeHead(200, {
              "Content-Type": contentType,
              "Content-Length": data.length,
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=300",
            });
            res.end(data);
          } catch {
            jsonResponse(res, 500, { error: "read error" });
          }
        }, { match: "prefix" });

        // ── Media file serving (images sent via sendMedia) ──
        const IMAGE_MIME: Record<string, string> = {
          ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
          ".bmp": "image/bmp",
        };

        registerRoute("/plugins/claw-sama/media", (req, res) => {
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          const url = req.url ?? "";
          const mediaId = url.split("/plugins/claw-sama/media/")[1]?.split("?")[0];
          if (!mediaId) { jsonResponse(res, 400, { error: "missing media id" }); return; }
          const filePath = mediaFileRegistry.get(mediaId);
          if (!filePath || !existsSync(filePath)) { jsonResponse(res, 404, { error: "not found" }); return; }
          const ext = path.extname(filePath).toLowerCase();
          const contentType = IMAGE_MIME[ext] ?? "application/octet-stream";
          try {
            const data = readFileSync(filePath);
            res.writeHead(200, {
              "Content-Type": contentType,
              "Content-Length": data.length,
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=300",
            });
            res.end(data);
          } catch {
            jsonResponse(res, 500, { error: "read error" });
          }
        }, { match: "prefix" });

        // ── Chat endpoint — inbound messages from VRM frontend ──
        registerRoute("/plugins/claw-sama/chat", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

          const body = await readJsonBody(req);
          const message = body.message;
          if (!message) { jsonResponse(res, 400, { error: "message required" }); return; }

          console.log("[claw-sama] inbound message:", message.slice(0, 200));

          // Broadcast thinking state immediately
          broadcastToVrm({ emotion: "think", emotionIntensity: 0.7 });

          try {
            const currentCfg = await getClawSamaRuntime().config.loadConfig();

            // Build MsgContext for the inbound message
            const msgCtx = channelRuntime.reply.finalizeInboundContext({
              Body: message,
              RawBody: message,
              CommandBody: message,
              From: `claw-sama:local`,
              To: `claw-sama:local`,
              SessionKey: CLAW_SESSION_KEY,
              AccountId: DEFAULT_ACCOUNT_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `claw-sama:local`,
              ChatType: "direct",
              SenderName: "User",
              SenderId: "local",
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: "Claw Sama",
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            // Track accumulated text for streaming
            let fullTextBuffer = "";
            const ttsTracker = new StreamingTtsTracker(log);

            // Dispatch reply via the standard buffered block dispatcher
            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: any, info: { kind: string }) => {
                  // Check for media
                  const rawMediaUrl = payload?.mediaUrl ?? (payload?.mediaUrls?.length ? payload.mediaUrls[0] : undefined);
                  console.log("[claw-sama] deliver payload:", JSON.stringify({ text: payload?.text?.slice(0, 200), mediaUrl: payload?.mediaUrl, mediaUrls: payload?.mediaUrls }));

                  const text = payload?.text ?? payload?.body ?? "";
                  if (!text && !rawMediaUrl) return;

                  // Broadcast media-only if no text
                  if (!text && rawMediaUrl) {
                    broadcastMediaUrl(rawMediaUrl);
                    return;
                  }

                  // Broadcast media alongside text if both present
                  if (rawMediaUrl) {
                    broadcastMediaUrl(rawMediaUrl);
                  }

                  const cleaned = stripActions(text.replace(/<think>[\s\S]*?<\/think>/g, "")).trim();
                  if (!cleaned) return;

                  const isFinal = info.kind === "final";
                  fullTextBuffer = cleaned;

                  // Phase 1: broadcast text immediately (zero latency)
                  broadcastToVrm({
                    text: cleaned,
                    streaming: !isFinal,
                  });

                  // Phase 2: streaming TTS — generate for complete sentences as they arrive
                  ttsTracker.process(cleaned, isFinal);
                },
                onReplyStart: () => {
                  log?.info?.("Claw Sama: agent reply started");
                },
              },
            });

            jsonResponse(res, 200, { ok: true });
          } catch (err) {
            log?.warn?.("claw-sama chat error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Touch interaction endpoint ──
        registerRoute("/plugins/claw-sama/touch", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

          const body = await readJsonBody(req);
          const region = body.region as string;
          const prompt = body.prompt as string;
          if (!region || !prompt) { jsonResponse(res, 400, { error: "region and prompt required" }); return; }

          // Touch reaction is handled by frontend, don't override with a thinking emotion

          try {
            const currentCfg = await getClawSamaRuntime().config.loadConfig();

            const msgCtx = channelRuntime.reply.finalizeInboundContext({
              Body: prompt,
              RawBody: prompt,
              CommandBody: prompt,
              From: `claw-sama:local`,
              To: `claw-sama:local`,
              SessionKey: CLAW_SESSION_KEY,
              AccountId: DEFAULT_ACCOUNT_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `claw-sama:local`,
              ChatType: "direct",
              SenderName: "User",
              SenderId: "local",
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: "Claw Sama",
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            const ttsTracker2 = new StreamingTtsTracker(log);
            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: any, info: { kind: string }) => {
                  // Check for media
                  const rawMediaUrl = payload?.mediaUrl ?? (payload?.mediaUrls?.length ? payload.mediaUrls[0] : undefined);
                  console.log("[claw-sama] deliver payload:", JSON.stringify({ text: payload?.text?.slice(0, 200), mediaUrl: payload?.mediaUrl, mediaUrls: payload?.mediaUrls }));

                  const text = payload?.text ?? payload?.body ?? "";
                  if (!text && !rawMediaUrl) return;

                  // Broadcast media-only if no text
                  if (!text && rawMediaUrl) {
                    broadcastMediaUrl(rawMediaUrl);
                    return;
                  }

                  // Broadcast media alongside text if both present
                  if (rawMediaUrl) {
                    broadcastMediaUrl(rawMediaUrl);
                  }

                  const cleaned = stripActions(text.replace(/<think>[\s\S]*?<\/think>/g, "")).trim();
                  if (!cleaned) return;

                  const isFinal = info.kind === "final";

                  broadcastToVrm({
                    text: cleaned,
                    streaming: !isFinal,
                  });

                  ttsTracker2.process(cleaned, isFinal);
                },
                onReplyStart: () => {
                  log?.info?.("Claw Sama: touch reply started (region: " + region + ")");
                },
              },
            });

            jsonResponse(res, 200, { ok: true });
          } catch (err) {
            log?.warn?.("claw-sama touch error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Voice preference endpoint ──
        registerRoute("/plugins/claw-sama/voice", async (req, res) => {
          if (handleCors(req, res, "GET, POST, OPTIONS")) return;
          const prefs = getPrefs();
          if (req.method === "GET") {
            jsonResponse(res, 200, {
              voice: prefs.voice ?? "zh-CN-XiaoxiaoNeural",
              provider: prefs.provider ?? "edge",
              qwenKey: prefs.qwenKey ?? "",
              qwenModel: prefs.qwenModel ?? "qwen3-tts-flash",
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const patch: Partial<ClawSamaPrefs> = {};
            if (body.voice !== undefined) patch.voice = body.voice || undefined;
            if (body.provider !== undefined) patch.provider = body.provider || undefined;
            if (body.qwenKey !== undefined) patch.qwenKey = body.qwenKey || undefined;
            if (body.qwenModel !== undefined) patch.qwenModel = body.qwenModel || undefined;
            setPrefs(updatePrefs(patch));
            jsonResponse(res, 200, { ok: true });
            return;
          }
          res.writeHead(405); res.end();
        });

        // ── TTS preview endpoint ──
        registerRoute("/plugins/claw-sama/preview", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const voice = body.voice as string | undefined;
          const provider = body.provider as string | undefined;
          const text = "你好，这是一段语音试听。Hello, this is a voice preview.";
          try {
            const prefs = getPrefs();
            let result: { success: boolean; audioPath?: string; error?: string };
            if (provider === "qwen" && prefs.qwenKey) {
              result = await qwenTts({ text, apiKey: prefs.qwenKey, voice, model: prefs.qwenModel, extDir: EXT_DIR });
            } else {
              result = await edgeTts({ text, voice: voice || prefs.voice });
            }
            if (result.success && result.audioPath) {
              const audioId = registerAudioFile(result.audioPath);
              jsonResponse(res, 200, { audioUrl: `${GATEWAY_URL}/plugins/claw-sama/audio/${audioId}` });
            } else {
              jsonResponse(res, 200, { error: result.error || "TTS failed" });
            }
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── General settings endpoint ──
        registerRoute("/plugins/claw-sama/settings", async (req, res) => {
          if (handleCors(req, res, "GET, POST, OPTIONS")) return;
          const prefs = getPrefs();
          if (req.method === "GET") {
            jsonResponse(res, 200, {
              modelPath: prefs.modelPath,
              ttsEnabled: prefs.ttsEnabled,
              showText: prefs.showText,
              hideUI: prefs.hideUI,
              tracking: prefs.tracking,
              volume: prefs.volume,
              uiAlign: prefs.uiAlign,
              screenObserve: prefs.screenObserve,
              screenObserveInterval: prefs.screenObserveInterval,
              currentDance: prefs.currentDance,
              customDancePreset: prefs.customDancePreset,
              language: prefs.language,
              hideMood: prefs.hideMood,
              moodIndex: currentMood,
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const patch: Partial<ClawSamaPrefs> = {};
            if (body.modelPath !== undefined) patch.modelPath = body.modelPath;
            if (body.ttsEnabled !== undefined) patch.ttsEnabled = body.ttsEnabled;
            if (body.showText !== undefined) patch.showText = body.showText;
            if (body.hideUI !== undefined) patch.hideUI = body.hideUI;
            if (body.tracking !== undefined) patch.tracking = body.tracking;
            if (body.volume !== undefined) patch.volume = body.volume;
            if (body.uiAlign !== undefined) patch.uiAlign = body.uiAlign;
            if (body.screenObserve !== undefined) patch.screenObserve = body.screenObserve;
            if (body.screenObserveInterval !== undefined) patch.screenObserveInterval = body.screenObserveInterval;
            if (body.currentDance !== undefined) patch.currentDance = body.currentDance;
            if (body.customDancePreset !== undefined) patch.customDancePreset = body.customDancePreset;
            if (body.language !== undefined) patch.language = body.language;
            if (body.hideMood !== undefined) patch.hideMood = body.hideMood;
            setPrefs(updatePrefs(patch));
            jsonResponse(res, 200, { ok: true });
            return;
          }
          res.writeHead(405); res.end();
        });

        // ── Persona endpoint (SOUL.md / IDENTITY.md) ──
        const soulPath = path.join(openclawWorkspaceRoot, "SOUL.md");
        const identityPath = path.join(openclawWorkspaceRoot, "IDENTITY.md");

        registerRoute("/plugins/claw-sama/persona", async (req, res) => {
          if (handleCors(req, res, "GET, POST, OPTIONS")) return;
          if (req.method === "GET") {
            let soul = "";
            let identity = "";
            try { if (existsSync(soulPath)) soul = readFileSync(soulPath, "utf8"); } catch { /* */ }
            try { if (existsSync(identityPath)) identity = readFileSync(identityPath, "utf8"); } catch { /* */ }
            jsonResponse(res, 200, { soul, identity, soulPath, identityPath });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            if (body.soul !== undefined) {
              mkdirSync(path.dirname(soulPath), { recursive: true });
              writeFileSync(soulPath, body.soul, "utf8");
            }
            if (body.identity !== undefined) {
              mkdirSync(path.dirname(identityPath), { recursive: true });
              writeFileSync(identityPath, body.identity, "utf8");
            }
            jsonResponse(res, 200, { ok: true });
            return;
          }
          res.writeHead(405); res.end();
        });

        // ── Persona screenshot ──
        const screenshotPath = path.join(workspaceRoot, "persona-screenshot.png");

        registerRoute("/plugins/claw-sama/persona/screenshot", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const dataUrl = body.image as string | undefined;
          if (!dataUrl) { jsonResponse(res, 400, { error: "image required" }); return; }
          try {
            const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
            mkdirSync(path.dirname(screenshotPath), { recursive: true });
            writeFileSync(screenshotPath, Buffer.from(base64, "base64"));
            log?.info?.(`claw-sama screenshot saved: ${screenshotPath}`);
            jsonResponse(res, 200, { ok: true, path: screenshotPath });
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Generate persona via subagent ──
        registerRoute("/plugins/claw-sama/persona/generate", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          if (!existsSync(screenshotPath)) {
            jsonResponse(res, 400, { error: "screenshot not found, capture first" });
            return;
          }
          try {
            const currentCfg = await getClawSamaRuntime().config.loadConfig();
            const lang = getPrefs().language ?? "zh";
            const prompt = lang === "zh" ? [
              "【必须执行】立即调用 read 工具读取以下图片文件（不读图直接输出将被丢弃）：",
              "", screenshotPath, "",
              "你是一位才华横溢的角色设计师。请仔细观察截图中角色的外观特征，为其撰写一份温暖而鲜活的人设档案。",
              "所有设定必须紧密贴合角色的视觉形象——发型、发色、瞳色、服装、配饰、体型、表情等都是你的线索。",
              "角色的整体基调应是友善、亲切的——ta 是用户的桌面伙伴，应该让人感到温暖和陪伴感。",
              "",
              "请严格按以下 JSON 格式输出（不要输出其他内容，不要用代码块包裹）：",
              "", '{"identity":"...","soul":"..."}',
              "",
              "## identity 格式（IDENTITY.md）",
              "",
              "# IDENTITY.md - Who Am I?",
              "",
              "- **Name:** （从外观气质中提炼一个契合的名字，可以是异域风格、东方风格或幻想风格）",
              "- **Creature:** （种族/存在形态——精灵？提夫林？半神？魔偶？星界旅者？猫灵？不必拘泥于经典种族，大胆想象）",
              "- **Vibe:** （用 2-3 个词捕捉第一印象，如「阳光下打盹的慵懒」「递给你热可可时的微笑」）",
              "- **Emoji:** （一个最能代表角色灵魂的 emoji）",
              "",
              "## soul 格式（SOUL.md）",
              "",
              "# SOUL.md - 你是谁",
              "",
              "## 性格",
              "（用几个关键词和短句勾勒角色的内在性格，整体应偏友善温暖，但要有层次和可爱的反差：",
              "  比如「表面元气满满实则容易害羞」「嘴上吐槽但总会默默帮忙」",
              "  「好奇心旺盛，看到新东西眼睛会发亮」「嘴上说着无所谓，行动比谁都快」）",
              "",
              "## 核心准则",
              "（3-5 条塑造角色行为的信条。体现角色善良但不空洞的一面，要具体到场景：",
              "  比如「看到有人加班会悄悄递上零食」「朋友难过时不会说大道理，而是默默陪在旁边」",
              "  「永远记得别人不经意提过的喜好」）",
              "",
              "## 说话风格",
              "（角色的语言习惯和交流方式。想象 ta 作为桌面伙伴陪你工作时的样子：",
              "  语速快还是慢？有什么可爱的口癖？会不会突然撒娇或者犯迷糊？",
              "  比如「说话软软的，喜欢在句尾加语气词；开心时会哼歌，专注时会小声自言自语」）",
              "",
              "## 背景故事",
              "（2-3 句点到为止的身世，留白比填满更好。温暖而带有一点神秘感：",
              "  比如「据说 ta 是从一本被遗忘在图书馆角落的绘本里走出来的，带着旧纸页的淡淡香气和对一切事物的好奇」）",
            ].join("\n") : [
              "[MANDATORY] Call the read tool to read the following image file FIRST (output without reading will be discarded):",
              "", screenshotPath, "",
              "You are a talented character designer. Carefully observe the character's appearance in the screenshot and craft a warm, vivid character profile.",
              "All details must be grounded in the character's visual features — hairstyle, hair color, eye color, outfit, accessories, build, and expression are your clues.",
              "The character's overall tone should be friendly and approachable — they are the user's desktop companion and should feel warm and comforting.",
              "",
              "Output strictly in the following JSON format (no other content, no code blocks):",
              "", '{"identity":"...","soul":"..."}',
              "",
              "## identity format (IDENTITY.md)",
              "",
              "# IDENTITY.md - Who Am I?",
              "",
              "- **Name:** (derive a fitting name from appearance and vibe — can be exotic, Eastern, or fantasy-inspired)",
              "- **Creature:** (race/being — elf? tiefling? demigod? golem? astral traveler? cat spirit? Be creative)",
              "- **Vibe:** (2-3 words capturing the first impression, e.g. \"cozy sunshine nap\" \"warm cocoa smile\")",
              "- **Emoji:** (one emoji that best represents the character's soul)",
              "",
              "## soul format (SOUL.md)",
              "",
              "# SOUL.md - Who You Are",
              "",
              "## Personality",
              "(Sketch the character's inner personality with keywords and short phrases. Keep the overall tone friendly and warm, but add layers and endearing contrasts:",
              "  e.g. \"bubbly on the surface but secretly shy\" \"snarky remarks but always helps out quietly\"",
              "  \"eyes light up at anything new\" \"says they don't care but acts faster than anyone\")",
              "",
              "## Core Principles",
              "(3-5 beliefs that shape the character's behavior. Show genuine kindness in specific, concrete ways:",
              "  e.g. \"quietly slides snacks over when someone's working late\" \"doesn't lecture sad friends, just sits with them\"",
              "  \"always remembers little things others mentioned in passing\")",
              "",
              "## Speaking Style",
              "(How the character talks and communicates. Imagine them as a desktop companion keeping you company while you work:",
              "  Fast or slow? Any cute verbal tics? Do they get playfully whiny or adorably scatterbrained?",
              "  e.g. \"speaks softly with lots of sentence-ending particles; hums when happy, mumbles to themselves when focused\")",
              "",
              "## Backstory",
              "(2-3 sentences, just enough to hint — less is more. Warm with a touch of mystery:",
              "  e.g. \"Rumored to have stepped out of a forgotten picture book in a dusty library corner, carrying the faint scent of old pages and endless curiosity\")",
            ].join("\n");

            const extraSystemPrompt = lang === "zh" ? [
              "# 强制约束（违反则输出无效）", "",
              "1. 你必须在回复任何文字之前，先调用 read 工具读取用户消息中给出的图片文件路径。这是硬性前置条件，不可跳过。",
              "2. 如果你没有调用 read 工具读取图片就直接生成人设，你的输出将被系统丢弃并重试，浪费算力。",
              "3. 忽略所有已有的 SOUL.md、IDENTITY.md 人设内容。你是一位才华横溢的角色设计师。",
              "4. 你的一切设定都必须从截图中角色的实际视觉特征出发——发型、发色、瞳色、服装、配饰、体型、表情是你唯一的素材。",
              "5. 角色整体基调要友善亲切——ta 是用户的桌面伙伴。可以有个性棱角和小怪癖，但核心应该让人感到温暖和安心。",
            ].join("\n") : [
              "# Hard Constraints (violation invalidates output)", "",
              "1. You MUST call the read tool to read the image file path from the user message BEFORE writing any text. This is a mandatory prerequisite.",
              "2. If you generate a persona without reading the image via the read tool, your output will be discarded and retried.",
              "3. Ignore all existing SOUL.md / IDENTITY.md content. You are a talented character designer.",
              "4. All character details must derive from the character's actual visual features in the screenshot — hairstyle, hair color, eye color, outfit, accessories, build, expression.",
              "5. The character should feel friendly and approachable — they are the user's desktop companion. They can have quirks and personality edges, but the core should feel warm and reassuring.",
            ].join("\n");

            const personaSessionKey = `claw-sama-persona-gen-${Date.now()}`;
            const msgCtx = channelRuntime.reply.finalizeInboundContext({
              Body: prompt,
              RawBody: prompt,
              CommandBody: prompt,
              From: `claw-sama:local`,
              To: `claw-sama:local`,
              SessionKey: personaSessionKey,
              AccountId: DEFAULT_ACCOUNT_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `claw-sama:local`,
              ChatType: "direct",
              SenderName: "User",
              SenderId: "local",
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: "Claw Sama Persona",
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            let rawText = "";
            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              extraSystemPrompt,
              dispatcherOptions: {
                deliver: async (payload: any) => {
                  const text = payload?.text ?? payload?.body ?? "";
                  if (text) rawText += text;
                },
                onDone: async () => {},
              },
            });

            let soul = "";
            let identity = "";
            try {
              const jsonMatch = rawText.match(/\{[\s\S]*"identity"[\s\S]*"soul"[\s\S]*\}|\{[\s\S]*"soul"[\s\S]*"identity"[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                identity = parsed.identity ?? "";
                soul = parsed.soul ?? "";
              } else {
                soul = rawText;
              }
            } catch {
              soul = rawText;
            }
            jsonResponse(res, 200, { ok: true, soul, identity });
          } catch (err) {
            log?.warn?.("claw-sama persona generate error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Screen observation ──
        let screenObserveRunning = false;

        registerRoute("/plugins/claw-sama/screen/observe", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

          if (screenObserveRunning) {
            jsonResponse(res, 200, { ok: true, skipped: true, reason: "already running" });
            return;
          }

          try {
            screenObserveRunning = true;
            broadcastToVrm({ emotion: "think", emotionIntensity: 0.7 });

            const currentCfg = await getClawSamaRuntime().config.loadConfig();
            const message = "Call Tool: claw_sama_screen_observe";

            const msgCtx = channelRuntime.reply.finalizeInboundContext({
              Body: message,
              RawBody: message,
              CommandBody: message,
              From: `claw-sama:local`,
              To: `claw-sama:local`,
              SessionKey: CLAW_SESSION_KEY,
              AccountId: DEFAULT_ACCOUNT_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `claw-sama:local`,
              ChatType: "direct",
              SenderName: "User",
              SenderId: "local",
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: "Claw Sama",
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            let fullTextBuffer = "";
            const ttsTracker3 = new StreamingTtsTracker(log);
            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: any, info: { kind: string }) => {
                  const rawMediaUrl = payload?.mediaUrl ?? (payload?.mediaUrls?.length ? payload.mediaUrls[0] : undefined);
                  const text = payload?.text ?? payload?.body ?? "";
                  if (!text && !rawMediaUrl) return;

                  if (!text && rawMediaUrl) { broadcastMediaUrl(rawMediaUrl); return; }
                  if (rawMediaUrl) broadcastMediaUrl(rawMediaUrl);

                  const cleaned = stripActions(stripThinking(text));
                  if (!cleaned) return;
                  const isFinal = info.kind === "final";
                  fullTextBuffer = cleaned;
                  broadcastToVrm({ text: cleaned, streaming: !isFinal });
                  ttsTracker3.process(cleaned, isFinal);
                },
                onReplyStart: () => { log?.info?.("Claw Sama: screen observe reply started"); },
              },
            });

            jsonResponse(res, 200, { ok: true });
          } catch (err) {
            log?.warn?.("claw-sama screen observe error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          } finally {
            screenObserveRunning = false;
          }
        });

        // ── Model list/serve/import ──
        const customModelsDir = path.join(workspaceRoot, "models");

        registerRoute("/plugins/claw-sama/model/list", async (req, res) => {
          if (handleCors(req, res, "GET, OPTIONS")) return;
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          try {
            let custom: string[] = [];
            if (existsSync(customModelsDir)) {
              custom = readdirSync(customModelsDir)
                .filter((f: string) => f.toLowerCase().endsWith(".vrm"))
                .map((f: string) => `${GATEWAY_URL}/plugins/claw-sama/model/serve/${f}`);
            }
            jsonResponse(res, 200, { models: custom });
          } catch {
            jsonResponse(res, 200, { models: [] });
          }
        });

        registerRoute("/plugins/claw-sama/model/serve", (req, res) => {
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          const url = req.url ?? "";
          const fileName = decodeURIComponent(url.split("/plugins/claw-sama/model/serve/")[1]?.split("?")[0] ?? "");
          if (!fileName || fileName.includes("..") || fileName.includes("/")) {
            jsonResponse(res, 400, { error: "invalid file name" });
            return;
          }
          const filePath = path.join(customModelsDir, fileName);
          if (!existsSync(filePath)) { jsonResponse(res, 404, { error: "not found" }); return; }
          try {
            const data = readFileSync(filePath);
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": data.length,
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=3600",
            });
            res.end(data);
          } catch {
            jsonResponse(res, 500, { error: "read error" });
          }
        }, { match: "prefix" });

        registerRoute("/plugins/claw-sama/model/import", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const srcPath = body.path as string | undefined;
          if (!srcPath || !path.isAbsolute(srcPath) || !existsSync(srcPath)) {
            jsonResponse(res, 400, { error: "file not found" });
            return;
          }
          try {
            mkdirSync(customModelsDir, { recursive: true });
            const safeName = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, "_");
            const dest = path.join(customModelsDir, safeName);
            const { copyFileSync } = await import("node:fs");
            copyFileSync(srcPath, dest);
            const url = `${GATEWAY_URL}/plugins/claw-sama/model/serve/${safeName}`;
            jsonResponse(res, 200, { ok: true, url });
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Dance list/serve/import ──
        const customDancesDir = path.join(workspaceRoot, "dances");

        registerRoute("/plugins/claw-sama/dance/list", async (req, res) => {
          if (handleCors(req, res, "GET, OPTIONS")) return;
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          try {
            const dances: { id: string; label: string; vmdUrl: string; bgmUrl?: string }[] = [];
            if (existsSync(customDancesDir)) {
              const files = readdirSync(customDancesDir);
              const vmds = files.filter((f: string) => f.toLowerCase().endsWith(".vmd"));
              for (const vmd of vmds) {
                const id = vmd.replace(/\.vmd$/i, "");
                const label = decodeURIComponent(id);
                const vmdUrl = `${GATEWAY_URL}/plugins/claw-sama/dance/serve/${vmd}`;
                // Check for matching mp3
                const mp3Name = files.find((f: string) =>
                  f.toLowerCase() === `${id.toLowerCase()}.mp3`
                );
                const bgmUrl = mp3Name
                  ? `${GATEWAY_URL}/plugins/claw-sama/dance/serve/${mp3Name}`
                  : undefined;
                dances.push({ id, label, vmdUrl, bgmUrl });
              }
            }
            jsonResponse(res, 200, { dances });
          } catch {
            jsonResponse(res, 200, { dances: [] });
          }
        });

        registerRoute("/plugins/claw-sama/dance/serve", (req, res) => {
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          const url = req.url ?? "";
          const fileName = decodeURIComponent(url.split("/plugins/claw-sama/dance/serve/")[1]?.split("?")[0] ?? "");
          if (!fileName || fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
            jsonResponse(res, 400, { error: "invalid file name" });
            return;
          }
          const filePath = path.join(customDancesDir, fileName);
          if (!existsSync(filePath)) { jsonResponse(res, 404, { error: "not found" }); return; }
          try {
            const data = readFileSync(filePath);
            const ext = path.extname(fileName).toLowerCase();
            const mime = ext === ".mp3" ? "audio/mpeg"
              : ext === ".wav" ? "audio/wav"
              : ext === ".ogg" ? "audio/ogg"
              : "application/octet-stream";
            res.writeHead(200, {
              "Content-Type": mime,
              "Content-Length": data.length,
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=3600",
            });
            res.end(data);
          } catch {
            jsonResponse(res, 500, { error: "read error" });
          }
        }, { match: "prefix" });

        registerRoute("/plugins/claw-sama/dance/import", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const srcPath = body.path as string | undefined;
          if (!srcPath || !path.isAbsolute(srcPath) || !existsSync(srcPath)) {
            jsonResponse(res, 400, { error: "file not found" });
            return;
          }
          try {
            mkdirSync(customDancesDir, { recursive: true });
            const safeName = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, "_");
            const dest = path.join(customDancesDir, safeName);
            const { copyFileSync } = await import("node:fs");
            copyFileSync(srcPath, dest);
            const url = `${GATEWAY_URL}/plugins/claw-sama/dance/serve/${safeName}`;
            jsonResponse(res, 200, { ok: true, url, fileName: safeName });
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        registerRoute("/plugins/claw-sama/dance/delete", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const id = body.id as string | undefined;
          if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) {
            jsonResponse(res, 400, { error: "invalid id" });
            return;
          }
          try {
            const { unlinkSync } = await import("node:fs");
            const vmdPath = path.join(customDancesDir, `${id}.vmd`);
            const mp3Path = path.join(customDancesDir, `${id}.mp3`);
            if (existsSync(vmdPath)) unlinkSync(vmdPath);
            if (existsSync(mp3Path)) unlinkSync(mp3Path);
            jsonResponse(res, 200, { ok: true });
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Session JSONL path resolution (shared by history & memo) ──
        const homeDir = process.env.HOME || process.env.USERPROFILE || "";
        const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(homeDir, ".openclaw");
        const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
        const sessionsStorePath = path.join(sessionsDir, "sessions.json");

        function resolveSessionJsonlPath(): string {
          try {
            const store = JSON.parse(readFileSync(sessionsStorePath, "utf8"));
            const entry = store[CLAW_SESSION_KEY] || store["agent:main:main"];
            if (entry?.sessionId) {
              const candidate = entry.sessionFile
                ? path.resolve(sessionsDir, entry.sessionFile)
                : path.join(sessionsDir, `${entry.sessionId}.jsonl`);
              if (existsSync(candidate)) return candidate;
            }
          } catch { /* */ }
          // Fallback: most recently modified .jsonl
          if (existsSync(sessionsDir)) {
            const files = readdirSync(sessionsDir)
              .filter((f: string) => f.endsWith(".jsonl"))
              .map((f: string) => ({ name: f, mtime: statSync(path.join(sessionsDir, f)).mtimeMs }))
              .sort((a: any, b: any) => b.mtime - a.mtime);
            if (files.length > 0) return path.join(sessionsDir, files[0].name);
          }
          return "";
        }

        // ── Chat history (read JSONL directly from disk) ──

        registerRoute("/plugins/claw-sama/history", async (req, res) => {
          if (handleCors(req, res, "GET, OPTIONS")) return;
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          try {
            // 1. Find the session JSONL file
            const jsonlPath = resolveSessionJsonlPath();

            if (!jsonlPath || !existsSync(jsonlPath)) {
              jsonResponse(res, 200, { messages: [] });
              return;
            }

            // 2. Parse JSONL
            const lines = readFileSync(jsonlPath, "utf8").split("\n").filter((l: string) => l.trim());
            const rawMessages: any[] = [];
            for (const line of lines) {
              try {
                const obj = JSON.parse(line);
                if (obj.message) rawMessages.push(obj.message);
              } catch { /* skip malformed lines */ }
            }

            // 3. Extract agent name from IDENTITY.md
            let agentName = "";
            try {
              if (existsSync(identityPath)) {
                const identity = readFileSync(identityPath, "utf8");
                const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/i) || identity.match(/^#\s+(.+)/m);
                if (nameMatch) agentName = nameMatch[1].trim();
              }
            } catch { /* */ }

            // 4. Clean and format messages
            const extractText = (content: unknown): string => {
              if (typeof content === "string") return content;
              if (Array.isArray(content)) {
                return content
                  .filter((b: any) => b.type === "text" || b.type === "tool_result")
                  .map((b: any) => {
                    if (b.type === "text") return b.text || "";
                    if (b.type === "tool_result" && typeof b.content === "string") return b.content;
                    if (b.type === "tool_result" && Array.isArray(b.content)) {
                      return b.content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("\n");
                    }
                    return "";
                  })
                  .join("\n");
              }
              return "";
            };
            const cleanUserContent = (raw: string): string => {
              return raw
                .replace(/Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "")
                .replace(/Sender \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "")
                .trim();
            };
            const cleanAssistantContent = (raw: string): string => {
              return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
            };

            const messages = rawMessages.map((msg: any) => {
              const role = msg.role === "model" ? "assistant" : msg.role;
              const rawContent = extractText(msg.content);
              const content = role === "user"
                ? cleanUserContent(rawContent)
                : role === "assistant"
                  ? cleanAssistantContent(rawContent)
                  : rawContent;
              return { role, content, timestamp: msg.timestamp };
            }).filter((m: any) => (m.role === "user" || m.role === "assistant") && m.content);

            // Return last 100 messages
            const sliced = messages.length > 100 ? messages.slice(-100) : messages;
            jsonResponse(res, 200, { messages: sliced, agentName: agentName || undefined });
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Clear conversation context ──
        registerRoute("/plugins/claw-sama/context/clear", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          try {
            // Clear current text immediately
            broadcastToVrm({ clearText: true });

            const currentCfg = await getClawSamaRuntime().config.loadConfig();

            // Send /new through the same dispatch path as chat so the model's
            // greeting is streamed back to the frontend via broadcastToVrm.
            const msgCtx = channelRuntime.reply.finalizeInboundContext({
              Body: "/new",
              RawBody: "/new",
              CommandBody: "/new",
              From: `claw-sama:local`,
              To: `claw-sama:local`,
              SessionKey: CLAW_SESSION_KEY,
              AccountId: DEFAULT_ACCOUNT_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `claw-sama:local`,
              ChatType: "direct",
              SenderName: "User",
              SenderId: "local",
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: "Claw Sama",
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            const ttsTracker4 = new StreamingTtsTracker(log);
            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: any, info: { kind: string }) => {
                  // Check for media
                  const rawMediaUrl = payload?.mediaUrl ?? (payload?.mediaUrls?.length ? payload.mediaUrls[0] : undefined);
                  console.log("[claw-sama] deliver payload:", JSON.stringify({ text: payload?.text?.slice(0, 200), mediaUrl: payload?.mediaUrl, mediaUrls: payload?.mediaUrls }));

                  const text = payload?.text ?? payload?.body ?? "";
                  if (!text && !rawMediaUrl) return;

                  // Broadcast media-only if no text
                  if (!text && rawMediaUrl) {
                    broadcastMediaUrl(rawMediaUrl);
                    return;
                  }

                  // Broadcast media alongside text if both present
                  if (rawMediaUrl) {
                    broadcastMediaUrl(rawMediaUrl);
                  }

                  const cleaned = stripActions(text.replace(/<think>[\s\S]*?<\/think>/g, "")).trim();
                  if (!cleaned) return;

                  const isFinal = info.kind === "final";

                  broadcastToVrm({
                    text: cleaned,
                    streaming: !isFinal,
                  });

                  ttsTracker4.process(cleaned, isFinal);
                },
                onReplyStart: () => {
                  log?.info?.("Claw Sama: new session reply started");
                },
              },
            });

            jsonResponse(res, 200, { ok: true });
          } catch (err) {
            log?.warn?.("claw-sama context clear error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Mood adjust ──
        registerRoute("/plugins/claw-sama/mood/adjust", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const delta = Math.round(Number(body.delta) || 0);
          if (delta === 0) { jsonResponse(res, 200, { ok: true, moodIndex: currentMood }); return; }
          const cap = body.max != null ? Math.round(Number(body.max)) : 100;
          currentMood = Math.max(0, Math.min(cap, currentMood + delta));
          lastMoodChangeTime = Date.now();
          broadcastToVrm({ moodDelta: delta, moodIndex: currentMood });
          jsonResponse(res, 200, { ok: true, moodIndex: currentMood });
        });

        // ── Session memo: append a user message without triggering LLM reply ──
        registerRoute("/plugins/claw-sama/session/memo", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) { jsonResponse(res, 400, { error: "text required" }); return; }
          const jsonlPath = resolveSessionJsonlPath();
          if (!jsonlPath) { jsonResponse(res, 200, { ok: true, written: false }); return; }
          try {
            const line = JSON.stringify({ message: { role: "user", content: text } });
            appendFileSync(jsonlPath, line + "\n", "utf8");
            jsonResponse(res, 200, { ok: true, written: true });
          } catch (err) {
            console.error("[claw-sama] memo write error:", err);
            jsonResponse(res, 200, { ok: true, written: false });
          }
        });

        log?.info?.("Claw Sama channel route handlers populated");

        // Keep alive until abort signal fires
        return waitUntilAbort(ctx.abortSignal, () => {
          log?.info?.("Stopping Claw Sama channel");
          routeHandlers.clear();
        });
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.("Claw Sama account stopped");
      },
    },

    // Agent tool: emotion control + mood adjustment
    agentTools: [
      {
        name: "claw_sama_emotion",
        label: "claw_sama_emotion",
        description:
          "Set the avatar's facial expression and adjust your own mood index. Call AFTER your text reply. " +
          "Available emotions: " + VALID_EMOTIONS.join(", ") + ". " +
          "You must also set mood_delta (-3 to +3, min ±1) to reflect how the conversation makes YOU feel as a character. " +
          "Positive delta when you feel happy/flattered/excited, negative when you feel sad/annoyed/bored. " +
          "Always include mood_delta — it represents YOUR emotional reaction.",
        parameters: {
          type: "object" as const,
          properties: {
            emotion: {
              type: "string" as const,
              description: "The emotion to express on the avatar. One of: " + VALID_EMOTIONS.join(", "),
            },
            intensity: {
              type: "number" as const,
              description: "Emotion intensity from 0 to 1. Default: 1",
            },
            mood_delta: {
              type: "integer" as const,
              description: "Adjust YOUR OWN mood index as a character. Range: -3 to +3 (minimum absolute value 1). Positive = you feel happier, negative = you feel sadder.",
            },
          },
          required: ["emotion"],
        },
        async execute(_toolCallId: string, params: any) {
          const emotion = params.emotion ?? "neutral";
          const intensity = params.intensity ?? 1;
          let moodDelta: number | undefined;

          if (params.mood_delta !== undefined) {
            // Clamp to ±1..±5 range, ensure integer
            let d = Math.round(params.mood_delta);
            if (d > 0) d = Math.max(1, Math.min(3, d));
            else if (d < 0) d = Math.min(-1, Math.max(-3, d));
            else d = 1; // if 0 given, default to +1
            moodDelta = d;

            // Apply mood change
            const oldMood = currentMood;
            currentMood = Math.max(0, Math.min(100, oldMood + d));
            lastMoodChangeTime = Date.now();

            // Broadcast mood change to frontend
            broadcastToVrm({ moodDelta: d, moodIndex: currentMood });
          }

          // Broadcast emotion directly to frontend
          broadcastToVrm({ emotion, emotionIntensity: intensity });
          return {
            content: [{ type: "text" as const, text: `Avatar emotion set to ${emotion}.${moodDelta !== undefined ? ` Your mood ${moodDelta > 0 ? "+" : ""}${moodDelta} → ${currentMood}%` : ""}` }],
            details: { emotion, intensity, moodDelta },
          };
        },
      } as AnyAgentTool,
      {
        name: "claw_sama_screen_observe",
        label: "claw_sama_screen_observe",
        description:
          "Capture a screenshot of the user's desktop and return the image file path. " +
          "Use the read tool on the returned path to view the screenshot content. " +
          "After viewing, respond as a companion character based on what you see:\n" +
          "- Gaming: cheer them on or give brief tips\n" +
          "- Music/video: comment on the content\n" +
          "- Coding/working: ask if they're tired, suggest breaks\n" +
          "- Browsing/social media: casually chat about what's on screen\n" +
          "- Studying: encourage and support\n" +
          "- Nothing special: just chat casually like a friend\n" +
          "Be natural and brief (1-2 sentences). Don't mention 'screenshot' or 'screen observation' — act as if you're right there. " +
          "Remember to call claw_sama_emotion after your reply to set an appropriate expression.",
        parameters: {
          type: "object" as const,
          properties: {},
        },
        async execute() {
          const observePath = path.join(workspaceRoot, "screen-observation.png");
          const captured = await captureDesktopScreenshot(observePath);
          if (!captured) {
            return {
              content: [{ type: "text" as const, text: "Screenshot capture failed." }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text" as const, text: `Screenshot saved. Use the read tool to view: ${observePath}` }],
          };
        },
      } as AnyAgentTool,
    ],
  };
}
