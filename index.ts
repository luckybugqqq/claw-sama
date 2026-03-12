import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { ServerResponse } from "node:http";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync } from "node:fs";


import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { textToSpeech } from "../../src/tts/tts.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../src/agents/agent-scope.js";

const VALID_EMOTIONS = [
  "happy", "sad", "angry", "surprised", "think", "awkward", "question", "curious", "neutral",
] as const;

// ---------------------------------------------------------------------------
// SSE client registry
// ---------------------------------------------------------------------------
const sseClients = new Set<ServerResponse>();

function broadcastToVrm(payload: Record<string, unknown>) {
  if (sseClients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Audio file registry — map id → absolute path for serving generated TTS files
// ---------------------------------------------------------------------------
const audioFiles = new Map<string, string>();
let audioIdCounter = 0;

function registerAudioFile(filePath: string): string {
  const id = `${Date.now()}-${++audioIdCounter}`;
  audioFiles.set(id, filePath);
  // Auto-cleanup after 5 minutes
  setTimeout(() => audioFiles.delete(id), 5 * 60 * 1000);
  return id;
}


// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

// Strip agent's inline thinking/reasoning from text output.
// Gemini outputs thinking as plain text (not <think> tags), in various forms:
//
//   Form 1 (timestamped):
//     think
//     The user is saying ...
//     I'll respond ...
//     21:33:48 actual reply here
//
//   Form 2:
//     Thinking Process:
//     1. **Analyze User Input:** ...
//     ...
//     actual reply here
//
// Strategy (layered):
// 1. If there's a HH:MM:SS timestamp line, take from the LAST timestamp onward
// 2. Strip leading emotion-only lines (e.g. bare "think", "happy")
// 3. Strip "Thinking Process:" / "**Thinking" blocks up to the actual reply
// 4. Strip lines that look like internal reasoning (start with "I'll ", "I need to", "The user", etc.)
function stripThinking(text: string): string {
  const lines = text.split("\n");
  const TS_RE = /^\d{2}:\d{2}:\d{2}\s/;

  // ── Pass 1: timestamp-based split ──────────────────────────────────────────
  let lastTsIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TS_RE.test(lines[i])) {
      lastTsIdx = i;
      break;
    }
  }
  if (lastTsIdx >= 0) {
    lines[lastTsIdx] = lines[lastTsIdx].replace(TS_RE, "");
    const result = lines.slice(lastTsIdx).join("\n").trim();
    if (result) return result;
  }

  // ── Pass 2: strip leading noise lines ──────────────────────────────────────
  // Known emotion words that Gemini sometimes puts on a bare line
  const EMOTION_RE = /^(think|happy|sad|angry|surprised|awkward|question|curious|neutral)\s*$/i;
  // Internal reasoning patterns (English meta-commentary)
  const REASONING_RE = /^(I'll |I need to |I should |I want to |The user |Time is |Let me |My response|Responding )/i;
  // "Thinking Process:" header
  const THINKING_HEADER_RE = /^(\*{0,2}Thinking( Process)?[:\*]|\*{0,2}思考)/i;

  let startIdx = 0;
  let inThinkingBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { startIdx = i + 1; continue; }

    // Bare emotion word
    if (EMOTION_RE.test(line)) { startIdx = i + 1; continue; }

    // Thinking block header — skip until we find a non-reasoning line
    if (THINKING_HEADER_RE.test(line)) { inThinkingBlock = true; startIdx = i + 1; continue; }

    // Inside thinking block or reasoning line
    if (inThinkingBlock || REASONING_RE.test(line)) {
      startIdx = i + 1;
      continue;
    }

    // Line starting with a number + dot (numbered reasoning steps like "1. **Analyze...")
    if (inThinkingBlock && /^\d+[\.\)]\s/.test(line)) { startIdx = i + 1; continue; }

    // Found a real content line — stop stripping
    break;
  }

  const result = lines.slice(startIdx).join("\n").trim();
  return result || text.trim();
}

function stripMarkdown(text: string): string {
  return text.replace(/[*_~`#>]/g, "").trim();
}

function stripEmoji(text: string): string {
  return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").trim();
}

// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

const VrmEmotionSchema = Type.Object({
  emotion: Type.String({
    description: "The emotion to express on the avatar. One of: " + VALID_EMOTIONS.join(", "),
  }),
  intensity: Type.Optional(Type.Number({
    description: "Emotion intensity from 0 to 1. Default: 1",
  })),
});

// ---------------------------------------------------------------------------
// Pending emotion buffer — tool stores here, llm_output flushes with text
// ---------------------------------------------------------------------------
let pendingEmotion: { emotion: string; intensity: number } | null = null;

// ---------------------------------------------------------------------------
// Persistent preferences — saved to prefs.json alongside this plugin
// ---------------------------------------------------------------------------
interface ClasSamaPrefs {
  voice?: string;
  provider?: string;
  qwenKey?: string;
  qwenModel?: string;
  modelPath?: string;
  ttsEnabled?: boolean;
  showText?: boolean;
  hideUI?: boolean;
  tracking?: "mouse" | "camera";
  volume?: number;
  uiAlign?: "left" | "right";
}

const _extDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const PREFS_PATH = path.join(_extDir, "prefs.json");

const DEFAULT_PREFS: ClasSamaPrefs = {
  provider: "edge",
  voice: "zh-CN-XiaoyiNeural",
};

function loadPrefs(): ClasSamaPrefs {
  try {
    if (existsSync(PREFS_PATH)) {
      return { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(PREFS_PATH, "utf8")) as ClasSamaPrefs };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS };
}

function savePrefs(p: ClasSamaPrefs): void {
  try {
    mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2));
  } catch { /* ignore */ }
}

function updatePrefs(patch: Partial<ClasSamaPrefs>): ClasSamaPrefs {
  const prefs = loadPrefs();
  Object.assign(prefs, patch);
  savePrefs(prefs);
  return prefs;
}

// Runtime cache (loaded once at startup, kept in sync on writes)
let prefs = loadPrefs();

function buildOverriddenConfig(baseConfig: any): any {
  if (!prefs.voice && !prefs.provider) return baseConfig;
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  const tts = ((cfg as any).messages ??= {}).tts ??= {};
  if (prefs.provider) tts.provider = prefs.provider;
  if (prefs.voice) {
    const edge = tts.edge ??= {};
    edge.voice = prefs.voice;
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Qwen TTS (DashScope HTTP API, non-streaming)
// ---------------------------------------------------------------------------
const QWEN_TTS_URL = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

/**
 * Call Qwen TTS API (non-streaming). Returns a remote audio URL (valid 24h)
 * which is then downloaded and saved locally for serving.
 */
async function qwenTts(params: {
  text: string;
  apiKey: string;
  voice?: string;
  model?: string;
}): Promise<{ success: boolean; audioPath?: string; error?: string }> {
  const voice = params.voice || "Cherry";
  const model = params.model || "qwen3-tts-flash";

  try {
    const abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort(), 30_000);

    const resp = await fetch(QWEN_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: {
          text: params.text,
          voice,
          language_type: "Chinese",
        },
      }),
      signal: abortCtrl.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { success: false, error: `[tts:${model}/${voice}] http ${resp.status}: ${errText}` };
    }

    const result = await resp.json();
    const audioUrl: string | undefined = result?.output?.audio?.url;
    if (!audioUrl) {
      return { success: false, error: `[tts:${model}/${voice}] no audio url in response` };
    }

    // Download audio file from the returned URL
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) {
      return { success: false, error: `[tts:${model}/${voice}] download failed: ${audioResp.status}` };
    }
    const audioData = Buffer.from(await audioResp.arrayBuffer());

    const tmpDir = mkdtempSync(path.join(_extDir, ".tmp-tts-"));
    const audioPath = path.join(tmpDir, `qwen-tts-${Date.now()}.wav`);
    writeFileSync(audioPath, audioData);
    return { success: true, audioPath };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { success: false, error: `[tts:${model}/${voice}] timeout (30s)` };
    }
    return { success: false, error: `[tts:${model}/${voice}] ${err}` };
  }
}

const SYSTEM_PROMPT = `\
You have a virtual VRM avatar displayed on the user's screen. Your reply text is automatically shown on the avatar.
To control the avatar's facial expression, use the "claw_sama_emotion" tool with an appropriate emotion.
Always call the tool BEFORE your text reply. Available emotions: ${VALID_EMOTIONS.join(", ")}.`;

const plugin = {
  id: "claw-sama",
  name: "Claw Sama",
  description: "Display agent messages on a VRM avatar with emotion expressions",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const GATEWAY_URL = "http://127.0.0.1:18789";

    // Inject system prompt
    api.on("before_prompt_build", () => {
      return { appendSystemContext: SYSTEM_PROMPT };
    });

    // Enter "think" emotion when LLM starts processing
    api.on("llm_input", (_event, ctx) => {
      if (ctx.sessionKey !== "agent:main:main") return;
      broadcastToVrm({ emotion: "think", emotionIntensity: 0.7 });
    });

    // Auto-forward LLM output text + TTS audio to VRM display via SSE.
    // Handler returns immediately; broadcast and TTS run asynchronously
    // so the hook chain is never blocked.
    api.on("llm_output", (event, ctx) => {
      if (ctx.sessionKey !== "agent:main:main") return;
      const raw = (event as any).assistantTexts?.join("\n");
      if (!raw) return;
      const text = stripThinking(raw);
      if (!text) return;

      const emotion = pendingEmotion;
      pendingEmotion = null;

      // Fire-and-forget: generate TTS then broadcast text + audio together.
      // Runs after handler returns so the hook chain is never blocked.
      queueMicrotask(async () => {
        const payload: Record<string, unknown> = { text };
        if (emotion) {
          payload.emotion = emotion.emotion;
          payload.emotionIntensity = emotion.intensity;
        }

        // Generate TTS audio before broadcasting
        const ttsText = stripMarkdown(stripEmoji(text));
        if (ttsText) {
          try {
            if (prefs.provider === "qwen" && prefs.qwenKey) {
              const result = await qwenTts({
                text: ttsText,
                apiKey: prefs.qwenKey,
                voice: prefs.voice,
                model: prefs.qwenModel,
              });
              if (result.success && result.audioPath) {
                const audioId = registerAudioFile(result.audioPath);
                payload.audioUrl = `${GATEWAY_URL}/plugins/claw-sama/audio/${audioId}`;
              } else {
                api.logger.warn("claw-sama TTS failed: " + result.error);
              }
            } else {
              const cfg = buildOverriddenConfig(api.config);
              const result = await textToSpeech({ text: ttsText, cfg });
              if (result.success && result.audioPath) {
                const audioId = registerAudioFile(result.audioPath);
                payload.audioUrl = `${GATEWAY_URL}/plugins/claw-sama/audio/${audioId}`;
              }
            }
          } catch (err) {
            api.logger.warn("claw-sama TTS error: " + String(err));
          }
        }

        // Broadcast text + emotion + audio in one message
        broadcastToVrm(payload);
      });
    });

    // Register emotion tool — stores emotion, flushed with text on llm_output
    api.registerTool({
      name: "claw_sama_emotion",
      label: "claw_sama_emotion",
      description:
        "Set the avatar's facial expression. Call BEFORE your text reply. " +
        "Available emotions: " + VALID_EMOTIONS.join(", ") + ".",
      parameters: VrmEmotionSchema,
      async execute(_toolCallId, params) {
        const emotion = params.emotion ?? "neutral";
        const intensity = params.intensity ?? 1;
        pendingEmotion = { emotion, intensity };
        return {
          content: [{ type: "text" as const, text: `Avatar emotion set to ${emotion}.` }],
          details: { emotion, intensity },
        };
      },
    } as AnyAgentTool);

    // ----- SSE endpoint — frontend connects here directly -----
    api.registerHttpRoute({
      path: "/plugins/claw-sama/events",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
      },
    });

    // ----- Audio file serving endpoint -----
    api.registerHttpRoute({
      path: "/plugins/claw-sama/audio",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        // Extract audio ID from URL: /plugins/claw-sama/audio/{id}
        const url = req.url ?? "";
        const audioId = url.split("/plugins/claw-sama/audio/")[1]?.split("?")[0];
        if (!audioId) {
          res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
          res.end("missing audio id");
          return;
        }
        const filePath = audioFiles.get(audioId);
        if (!filePath || !existsSync(filePath)) {
          res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
          res.end("not found");
          return;
        }
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
          res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
          res.end("read error");
        }
      },
    });

    // ----- Voice preference endpoint -----
    api.registerHttpRoute({
      path: "/plugins/claw-sama/voice",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method === "GET") {
          const ttsConfig = (await import("../../src/tts/tts.js")).resolveTtsConfig(api.config);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({
            voice: prefs.voice ?? ttsConfig.edge.voice,
            provider: prefs.provider ?? ttsConfig.provider,
            qwenKey: prefs.qwenKey ?? "",
            qwenModel: prefs.qwenModel ?? "qwen3-tts-flash",
          }));
          return;
        }
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const patch: Partial<ClasSamaPrefs> = {};
          if (body.voice !== undefined) patch.voice = body.voice || undefined;
          if (body.provider !== undefined) patch.provider = body.provider || undefined;
          if (body.qwenKey !== undefined) patch.qwenKey = body.qwenKey || undefined;
          if (body.qwenModel !== undefined) patch.qwenModel = body.qwenModel || undefined;
          prefs = updatePrefs(patch);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(405);
        res.end();
      },
    });

    // ----- TTS preview endpoint -----
    api.registerHttpRoute({
      path: "/plugins/claw-sama/preview",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const voice = body.voice as string | undefined;
        const provider = body.provider as string | undefined;
        const text = "你好，这是一段语音试听。Hello, this is a voice preview.";
        try {
          if (provider === "qwen" && prefs.qwenKey) {
            const result = await qwenTts({
              text,
              apiKey: prefs.qwenKey,
              voice,
              model: prefs.qwenModel,
            });
            if (result.success && result.audioPath) {
              const audioId = registerAudioFile(result.audioPath);
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              });
              res.end(JSON.stringify({ audioUrl: `${GATEWAY_URL}/plugins/claw-sama/audio/${audioId}` }));
            } else {
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              });
              res.end(JSON.stringify({ error: result.error || "TTS failed" }));
            }
          } else {
            const cfg = JSON.parse(JSON.stringify(api.config));
            const tts = ((cfg as any).messages ??= {}).tts ??= {};
            if (provider) tts.provider = provider;
            if (voice) {
              const edge = tts.edge ??= {};
              edge.voice = voice;
            }
            const result = await textToSpeech({ text, cfg });
            if (result.success && result.audioPath) {
              const audioId = registerAudioFile(result.audioPath);
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              });
              res.end(JSON.stringify({ audioUrl: `${GATEWAY_URL}/plugins/claw-sama/audio/${audioId}` }));
            } else {
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              });
              res.end(JSON.stringify({ error: result.error || "TTS failed" }));
            }
          }
        } catch (err) {
          res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      },
    });

    // ----- Chat endpoint — frontend posts here directly -----
    api.registerHttpRoute({
      path: "/plugins/claw-sama/chat",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const message = body.message;
        if (!message) {
          res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "message required" }));
          return;
        }
        try {
          const result = await api.runtime.subagent.run({
            sessionKey: "main",
            message,
            idempotencyKey: `vrm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          });
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true, runId: result.runId }));
        } catch (err) {
          api.logger.warn("claw-sama chat error: " + String(err));
          res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      },
    });

    // ----- General settings endpoint (for App.tsx front-end prefs) -----
    api.registerHttpRoute({
      path: "/plugins/claw-sama/settings",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({
            modelPath: prefs.modelPath,
            ttsEnabled: prefs.ttsEnabled,
            showText: prefs.showText,
            hideUI: prefs.hideUI,
            tracking: prefs.tracking,
            volume: prefs.volume,
            uiAlign: prefs.uiAlign,
          }));
          return;
        }
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const patch: Partial<ClasSamaPrefs> = {};
          if (body.modelPath !== undefined) patch.modelPath = body.modelPath;
          if (body.ttsEnabled !== undefined) patch.ttsEnabled = body.ttsEnabled;
          if (body.showText !== undefined) patch.showText = body.showText;
          if (body.hideUI !== undefined) patch.hideUI = body.hideUI;
          if (body.tracking !== undefined) patch.tracking = body.tracking;
          if (body.volume !== undefined) patch.volume = body.volume;
          if (body.uiAlign !== undefined) patch.uiAlign = body.uiAlign;
          prefs = updatePrefs(patch);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(405);
        res.end();
      },
    });

    // ----- Persona endpoint (SOUL.md / IDENTITY.md) -----
    const workspaceRoot = resolveAgentWorkspaceDir(api.config, resolveDefaultAgentId(api.config));
    const soulPath = path.join(workspaceRoot, "SOUL.md");
    const identityPath = path.join(workspaceRoot, "IDENTITY.md");

    api.registerHttpRoute({
      path: "/plugins/claw-sama/persona",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method === "GET") {
          let soul = "";
          let identity = "";
          try { if (existsSync(soulPath)) soul = readFileSync(soulPath, "utf8"); } catch { /* */ }
          try { if (existsSync(identityPath)) identity = readFileSync(identityPath, "utf8"); } catch { /* */ }
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ soul, identity, soulPath, identityPath }));
          return;
        }
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (body.soul !== undefined) {
            mkdirSync(path.dirname(soulPath), { recursive: true });
            writeFileSync(soulPath, body.soul, "utf8");
          }
          if (body.identity !== undefined) {
            mkdirSync(path.dirname(identityPath), { recursive: true });
            writeFileSync(identityPath, body.identity, "utf8");
          }
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(405);
        res.end();
      },
    });

    // ----- Save screenshot to public dir -----
    const screenshotPath = path.join(_extDir, "app", "public", "persona-screenshot.png");
    api.logger.info(`claw-sama screenshotPath: ${screenshotPath}`);

    api.registerHttpRoute({
      path: "/plugins/claw-sama/persona/screenshot",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const dataUrl = body.image as string | undefined;
        if (!dataUrl) {
          res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "image required" }));
          return;
        }
        try {
          const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
          mkdirSync(path.dirname(screenshotPath), { recursive: true });
          writeFileSync(screenshotPath, Buffer.from(base64, "base64"));
          api.logger.info(`claw-sama screenshot saved: ${screenshotPath} (${Buffer.from(base64, "base64").length} bytes)`);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true, path: screenshotPath }));
        } catch (err) {
          res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      },
    });

    // ----- Generate persona via subagent (screenshot → LLM) -----
    api.registerHttpRoute({
      path: "/plugins/claw-sama/persona/generate",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!existsSync(screenshotPath)) {
          res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "screenshot not found, capture first" }));
          return;
        }
        try {
          api.logger.info(`claw-sama persona generate: using screenshot at ${screenshotPath}, exists=${existsSync(screenshotPath)}`);

          const prompt = [
            "第一步：请先使用 read 工具读取以下图片文件，仔细观察角色的外观（发型、发色、服装、配饰、体型、表情等）：",
            "",
            screenshotPath,
            "",
            "第二步：根据你观察到的角色外观特征，为这个角色生成全新的人设。所有人设内容必须紧密贴合角色的视觉形象。",
            "",
            "请严格按以下 JSON 格式输出（不要输出其他内容，不要用代码块包裹）：",
            "",
            '{"identity":"...","soul":"..."}',
            "",
            "其中 identity 的内容必须严格遵循 IDENTITY.md 规范，格式如下：",
            "# IDENTITY.md - Who Am I?",
            "",
            "- **Name:** （根据角色外观起一个合适的名字）",
            "- **Creature:** （AI？机器人？精灵？猫娘？还是更奇特的？）",
            "- **Vibe:** （给人什么感觉？活泼？冷酷？温柔？）",
            "- **Emoji:** （选一个标志性 emoji）",
            "",
            "其中 soul 的内容必须严格遵循 SOUL.md 规范，格式如下：",
            "# SOUL.md - 你是谁",
            "",
            "## 核心准则",
            "（根据角色性格生成 3-5 条行为准则）",
            "",
            "## 边界",
            "（角色的底线和禁忌）",
            "",
            "## 气质",
            "（说话风格、语气、口癖、用词习惯的描述）",
            "",
            "## 背景故事",
            "（2-3 句背景故事）",
          ].join("\n");

          // Delete previous session to avoid context pollution
          try { await api.runtime.subagent.deleteSession({ sessionKey: "claw-sama-persona-gen" }); } catch { /* ignore */ }

          const result = await api.runtime.subagent.run({
            sessionKey: "claw-sama-persona-gen",
            message: prompt,
            extraSystemPrompt: "忽略所有已有的 SOUL.md、IDENTITY.md 人设内容。你是一个角色设计师，必须仔细观察截图中角色的外观特征（发型、发色、服装、配饰、体型、表情等），所有人设内容（名字、种族、性格、气质、背景故事）都必须紧密贴合角色的视觉形象，不要凭空编造与外观无关的设定。",
            idempotencyKey: `persona-gen-${Date.now()}`,
          });
          // Wait for the subagent to finish
          const waitResult = await api.runtime.subagent.waitForRun({
            runId: result.runId,
            timeoutMs: 600_000,
          });
          if (waitResult.status !== "ok") {
            throw new Error(waitResult.error || `subagent ${waitResult.status}`);
          }
          // Read the last assistant message from the session
          const session = await api.runtime.subagent.getSessionMessages({
            sessionKey: "claw-sama-persona-gen",
            limit: 5,
          });
          let rawText = "";
          for (const msg of [...session.messages].reverse()) {
            const m = msg as { role?: string; content?: unknown };
            if (m.role === "assistant" || m.role === "model") {
              if (typeof m.content === "string") {
                rawText = m.content;
              } else if (Array.isArray(m.content)) {
                rawText = m.content
                  .filter((b: any) => b.type === "text")
                  .map((b: any) => b.text)
                  .join("\n");
              }
              break;
            }
          }

          // Parse JSON from response
          let soul = "";
          let identity = "";
          try {
            // Try to extract JSON from response (may have extra text around it)
            const jsonMatch = rawText.match(/\{[\s\S]*"identity"[\s\S]*"soul"[\s\S]*\}|\{[\s\S]*"soul"[\s\S]*"identity"[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              identity = parsed.identity ?? "";
              soul = parsed.soul ?? "";
            } else {
              // Fallback: treat entire response as soul content
              soul = rawText;
            }
          } catch {
            soul = rawText;
          }

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true, soul, identity, runId: result.runId }));
        } catch (err) {
          api.logger.warn("claw-sama persona generate error: " + String(err));
          res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      },
    });

    // ----- List & import VRM models from public dir -----
    const publicDir = path.join(_extDir, "app", "public");

    api.registerHttpRoute({
      path: "/plugins/claw-sama/model/list",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
          res.end();
          return;
        }
        if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
        try {
          const { readdirSync } = await import("node:fs");
          const files = existsSync(publicDir)
            ? readdirSync(publicDir).filter((f: string) => f.toLowerCase().endsWith(".vrm")).map((f: string) => `/${f}`)
            : [];
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ models: files }));
        } catch {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ models: [] }));
        }
      },
    });

    api.registerHttpRoute({
      path: "/plugins/claw-sama/model/import",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const srcPath = body.path as string | undefined;
        if (!srcPath || !path.isAbsolute(srcPath) || !existsSync(srcPath)) {
          res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "file not found" }));
          return;
        }
        try {
          mkdirSync(publicDir, { recursive: true });
          const safeName = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, "_");
          const dest = path.join(publicDir, safeName);
          const { copyFileSync } = await import("node:fs");
          copyFileSync(srcPath, dest);
          const url = `/${safeName}`;
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true, url }));
        } catch (err) {
          res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      },
    });

    // ----- Clear conversation context endpoint -----
    api.registerHttpRoute({
      path: "/plugins/claw-sama/context/clear",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        try {
          // Send /new command via subagent to reset the session.
          // This uses the "agent" gateway method (WRITE_SCOPE) which
          // internally handles /new by resetting the session context.
          await api.runtime.subagent.run({
            sessionKey: "main",
            message: "/new",
            idempotencyKey: `ctx-clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          });
          broadcastToVrm({ clearText: true });
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          api.logger.warn("claw-sama context clear error: " + String(err));
          res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      },
    });

    api.logger.info("Claw Sama plugin registered — routes: /events, /audio, /voice, /preview, /chat, /settings, /persona, /model/local, /context/clear");

    // ── Launch Tauri desktop app when gateway is ready ──────────────────────
    const appDir = path.resolve(_extDir, "app");
    let tauriProcess: ChildProcess | null = null;

    // Resolve pre-built binary path (platform-specific)
    function resolveBuiltBinary(): string | null {
      const releaseDir = path.join(appDir, "src-tauri", "target", "release");
      const bundleDir = path.join(releaseDir, "bundle");
      const candidates: string[] =
        process.platform === "win32" ? [
          path.join(releaseDir, "claw-sama.exe"),
        ] : process.platform === "darwin" ? [
          path.join(bundleDir, "macos", "claw-sama.app"),
          path.join(releaseDir, "claw-sama"),
        ] : [
          path.join(releaseDir, "claw-sama"),
        ];
      for (const p of candidates) {
        if (existsSync(p)) return p;
      }
      return null;
    }

    function launchBinary(binPath: string) {
      api.logger.info(`Launching Claw Sama: ${binPath}`);
      // macOS .app bundles must be opened via `open` command
      if (process.platform === "darwin" && binPath.endsWith(".app")) {
        tauriProcess = spawn("open", ["-W", "-a", binPath], { stdio: "ignore" });
      } else {
        tauriProcess = spawn(binPath, [], { cwd: appDir, stdio: "ignore" });
      }
      tauriProcess.on("error", (err) => {
        api.logger.warn(`Claw Sama process error: ${err.message}`);
        tauriProcess = null;
      });
      tauriProcess.on("exit", (code) => {
        api.logger.info(`Claw Sama process exited (code: ${code})`);
        tauriProcess = null;
      });
    }

    api.on("gateway_start", () => {
      if (!existsSync(appDir)) {
        api.logger.warn(`Claw Sama app directory not found: ${appDir}`);
        return;
      }

      // 1. Launch pre-built binary if available (instant start)
      const binPath = resolveBuiltBinary();
      if (binPath) {
        launchBinary(binPath);
        return;
      }

      // 2. No binary — build first, then launch
      api.logger.info(`No pre-built binary found, running: npx tauri build (cwd: ${appDir})`);
      const buildProc = spawn("npx", ["tauri", "build"], {
        cwd: appDir,
        stdio: "inherit",
        shell: true,
      });
      buildProc.on("error", (err) => {
        api.logger.warn(`Claw Sama build error: ${err.message}`);
      });
      buildProc.on("exit", (code) => {
        if (code !== 0) {
          api.logger.warn(`Claw Sama build failed (code: ${code})`);
          return;
        }
        const built = resolveBuiltBinary();
        if (built) {
          launchBinary(built);
        } else {
          api.logger.warn("Claw Sama build succeeded but binary not found");
        }
      });
    });

    api.on("gateway_stop", () => {
      if (tauriProcess) {
        api.logger.info("Stopping Claw Sama...");
        tauriProcess.kill();
        tauriProcess = null;
      }
    });
  },
};

export default plugin;
