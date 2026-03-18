/**
 * Text cleaning utilities for Claw Sama.
 */

export const VALID_EMOTIONS = [
  "happy", "sad", "angry", "surprised", "think", "awkward", "question", "curious", "neutral",
  "love", "flirty", "greeting", "relaxed",
] as const;

/**
 * Strip agent's inline thinking/reasoning from text output.
 * Gemini outputs thinking as plain text (not <think> tags), in various forms.
 */
export function stripThinking(text: string): string {
  const lines = text.split("\n");
  const TS_RE = /^\d{2}:\d{2}:\d{2}\s/;

  // Pass 1: timestamp-based split
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

  // Pass 2: strip leading noise lines
  const EMOTION_RE = /^(think|happy|sad|angry|surprised|awkward|question|curious|neutral)\s*$/i;
  const REASONING_RE = /^(I'll |I need to |I should |I want to |The user |Time is |Let me |My response|Responding )/i;
  const THINKING_HEADER_RE = /^(\*{0,2}Thinking( Process)?[:\*]|\*{0,2}思考)/i;

  let startIdx = 0;
  let inThinkingBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { startIdx = i + 1; continue; }
    if (EMOTION_RE.test(line)) { startIdx = i + 1; continue; }
    if (THINKING_HEADER_RE.test(line)) { inThinkingBlock = true; startIdx = i + 1; continue; }
    if (inThinkingBlock || REASONING_RE.test(line)) {
      startIdx = i + 1;
      continue;
    }
    if (inThinkingBlock && /^\d+[\.\)]\s/.test(line)) { startIdx = i + 1; continue; }
    break;
  }

  let result = lines.slice(startIdx).join("\n").trim();
  if (!result) result = text.trim();
  result = result.replace(/\[\[[\w_]+\]\]/g, "").trim();
  return result;
}

/**
 * Strip action/narration text wrapped in *..* or **..** (e.g. *adjusts posture*).
 */
export function stripActions(text: string): string {
  return text.replace(/\*{1,2}[^*]+\*{1,2}/g, "").replace(/\n{2,}/g, "\n").trim();
}

export function stripMarkdown(text: string): string {
  return text.replace(/[*_~`#>]/g, "").trim();
}

export function stripEmoji(text: string): string {
  return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").trim();
}

/**
 * Strip text for TTS playback:
 * - Remove parenthesized content: （...）and (...)
 * - Remove markdown symbols (but keep text between *...*)
 * - Remove emoji
 */
export function stripForTts(text: string): string {
  return text
    .replace(/（[^）]*）/g, "")     // Remove （...）
    .replace(/\([^)]*\)/g, "")      // Remove (...)
    .replace(/[_~`#>]/g, "")        // Remove markdown symbols except *
    .replace(/\*([^*]*)\*/g, "$1")  // Remove * but keep content between them
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .trim();
}

/**
 * Split text into sentences for incremental TTS.
 * Splits on Chinese/Japanese sentence-ending punctuation and common English punctuation.
 * Ellipsis patterns (... / …… / …) are protected and NOT treated as sentence boundaries.
 */
export function splitSentences(text: string): string[] {
  // Protect ellipsis patterns from being treated as sentence-ending periods
  const ellipsisMap: string[] = [];
  const safeText = text.replace(/\.{2,}|…+/g, (match) => {
    const idx = ellipsisMap.length;
    ellipsisMap.push(match);
    return `\x00E${idx}\x00`;
  });

  const parts = safeText.split(/(?<=[。！？；\n.!?;~])\s*/);
  return parts
    .map((s) => {
      // Restore ellipsis placeholders
      let restored = s;
      for (let i = 0; i < ellipsisMap.length; i++) {
        restored = restored.replace(`\x00E${i}\x00`, ellipsisMap[i]);
      }
      return restored.trim();
    })
    .filter((s) => s && !/^[。！？；.!?;~、，,\s]+$/.test(s));
}
