/**
 * Persistent preferences for Claw Sama.
 */
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ClawSamaPrefs {
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
  screenObserve?: boolean;
  screenObserveInterval?: number;
  language?: "zh" | "en";
  currentDance?: string;
  customDancePreset?: {
    label: string;
    type: string;
    url: string;
    bgm?: string;
  };
  hideMood?: boolean;
}

const _srcDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.resolve(_srcDir, "..");

// Workspace roots
const profile = process.env.OPENCLAW_PROFILE?.trim();
const homeDir = process.env.HOME || process.env.USERPROFILE || "";
export const openclawWorkspaceRoot = (profile && profile.toLowerCase() !== "default")
  ? path.join(homeDir, ".openclaw", `workspace-${profile}`)
  : path.join(homeDir, ".openclaw", "workspace");
export const workspaceRoot = path.join(openclawWorkspaceRoot, "claw-sama");

const PREFS_PATH = path.join(workspaceRoot, "claw-sama.json");

// Legacy path for migration
const LEGACY_PREFS_PATH = path.join(workspaceRoot, "clawsama.json");

const DEFAULT_PREFS: ClawSamaPrefs = {
  provider: "edge",
  voice: "zh-CN-XiaoyiNeural",
};

export function loadPrefs(): ClawSamaPrefs {
  try {
    if (existsSync(PREFS_PATH)) {
      return { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(PREFS_PATH, "utf8")) as ClawSamaPrefs };
    }
    // Migrate from legacy clawsama.json
    if (existsSync(LEGACY_PREFS_PATH)) {
      const prefs = { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(LEGACY_PREFS_PATH, "utf8")) as ClawSamaPrefs };
      savePrefs(prefs);
      return prefs;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(p: ClawSamaPrefs): void {
  try {
    mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2));
  } catch { /* ignore */ }
}

export function updatePrefs(patch: Partial<ClawSamaPrefs>): ClawSamaPrefs {
  const prefs = loadPrefs();
  Object.assign(prefs, patch);
  savePrefs(prefs);
  return prefs;
}

// ── Screen Observation Knowledge Base ──

const SCREEN_KB = `\
## 杀戮尖塔 / Slay the Spire
- 卡牌roguelike游戏
- 界面特征：卡牌手牌、地图路径选择、敌人血条、能量点数
- 关键词：Strike, Defend, Ascension, Neow, 精英怪, 篝火

## 仁王3 / Nioh 3
- 动作RPG，暗黑风格日本战国背景
- 界面特征：血条、精力条、妖力条、装备栏、暗黑写实画风
- 关键词：武技、守护灵、落命、常暗、妖怪`;

export function loadScreenKb(): string {
  return SCREEN_KB;
}

// Runtime cache
let _prefs = loadPrefs();

export function getPrefs(): ClawSamaPrefs {
  return _prefs;
}

export function setPrefs(p: ClawSamaPrefs) {
  _prefs = p;
}
