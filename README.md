<p align="center">
  <img src="banner.png" alt="Claw Sama" width="100%" />
</p>

<p align="center">
  <b>AI-powered VRM desktop pet that lives on your screen</b>
</p>

<p align="center">
  <a href="https://github.com/luckybugqqq/claw-sama/releases">
    <img src="https://img.shields.io/github/v/release/luckybugqqq/claw-sama?style=flat-square" alt="Release" />
  </a>
  <a href="https://www.npmjs.com/package/@luckybugqqq/claw-sama">
    <img src="https://img.shields.io/npm/v/@luckybugqqq/claw-sama?style=flat-square" alt="npm" />
  </a>
  <a href="https://github.com/luckybugqqq/claw-sama/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/luckybugqqq/claw-sama?style=flat-square" alt="License" />
  </a>
</p>

---

## What is Claw Sama?

Claw Sama is an AI desktop pet built as an [OpenClaw](https://github.com/anthropics/openclaw) plugin. She lives on your desktop as a 3D VRM avatar, talks to you with voice, reacts with emotions, and even watches your screen to keep you company.

## Features

### VRM Avatar
- 3D VRM model rendered with Three.js
- Facial expressions & emotion system (happy, sad, angry, surprised, think, curious...)
- Idle animations with random fidgets
- Mouse/camera gaze tracking
- Lip-sync synchronized with TTS audio

### AI Conversation
- Chat via text input or voice (hold F10)
- LLM-powered responses with personality (configurable via SOUL.md & IDENTITY.md)
- Emotion tool — AI controls avatar expressions in real-time
- One-click persona generation from avatar screenshot

### Screen Observation
- Captures your desktop every 60 seconds
- AI recognizes what you're doing and interacts accordingly
- Playing games? She cheers you on
- Writing code? She reminds you to rest
- Watching videos? She comments on the content
- Toggle on/off in settings

### Text-to-Speech
- Edge TTS (free, multiple Chinese/English/Japanese voices)
- Qwen TTS (Alibaba Cloud, expressive voices)
- Volume control & voice preview

### Desktop Integration
- Always-on-top transparent window
- Click-through when not interacting
- Drag to move, rotate camera, zoom
- Pin/unpin, hide/show
- macOS & Windows native support

## Install

### As OpenClaw Plugin (recommended)

```bash
openclaw plugins install @luckybugqqq/claw-sama
```

The npm package includes pre-built binaries for Windows (.exe) and macOS (.app). OpenClaw loads the plugin and launches the desktop pet automatically.


### Build from Source

```bash
git clone https://github.com/luckybugqqq/claw-sama.git
cd claw-sama/app
npm install
npx tauri build
```

> Requires Node.js 20+ and Rust toolchain.

## Settings

Open settings via the gear icon on the avatar window:

| Tab | Options |
|-----|---------|
| General | Hide UI, show subtitles, TTS toggle, volume, gaze tracking, UI alignment, screen observation |
| Voice | TTS provider (Edge/Qwen), voice selection with preview |
| Model | Built-in VRM models, import custom .vrm files |
| Persona | Edit IDENTITY.md & SOUL.md, one-click AI persona generation |

## Custom VRM Models

Built-in models are bundled with the app. You can import your own `.vrm` models via Settings > Model > Import. Custom models are stored in the workspace `models/` directory.

## Architecture

```
claw-sama/
├── index.ts              # OpenClaw plugin backend
├── app/
│   ├── src/              # React + Three.js frontend
│   │   ├── components/   # VRMScene, TextBubble, ChatInput, SettingsPanel
│   │   ├── emote.ts      # Emotion/expression controller
│   │   └── lip-sync.ts   # Audio-driven lip sync
│   ├── public/           # VRM models & animations
│   └── src-tauri/        # Tauri desktop shell
└── package.json
```

## Tech Stack

- **Frontend**: React, Three.js, [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)
- **Desktop**: [Tauri](https://tauri.app/)
- **Backend**: OpenClaw plugin SDK (Node.js)
- **AI**: LLM via OpenClaw runtime (supports multiple providers)
- **TTS**: Edge TTS / Qwen TTS

## Acknowledgments

- Inspired by [AIRI](https://github.com/moeru-ai/airi) — an AI companion project by moeru-ai

## License

MIT
