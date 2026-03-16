<p align="center">
  <img src="img/banner.png" alt="Claw Sama" width="100%" />
</p>

<p align="center">
  <b>A VRM AI desktop pet powered by OpenClaw plugin</b><br/>
  <b>基于 OpenClaw 插件的 AI 桌面宠物</b>
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

<p align="center">
  <img src="img/display1.gif" width="80%" /><br/>
  <img src="img/display2.png" width="80%" /><br/>
  <img src="img/display3.png" width="80%" /><br/>
  <img src="img/display4.png" width="80%" />
</p>

---

## What is Claw Sama? / 这是什么？

Claw Sama is an AI desktop pet built as an [OpenClaw](https://github.com/anthropics/openclaw) plugin. She lives on your desktop as a 3D VRM avatar, talks to you with voice, reacts with emotions, and even watches your screen to keep you company.

Claw Sama 是一个基于 [OpenClaw](https://github.com/anthropics/openclaw) 插件实现的 AI 桌面宠物。她以 3D VRM 虚拟形象常驻在你的桌面上，能用语音跟你聊天、实时表达情绪，甚至能观察你的屏幕来主动陪伴你。

## Features / 特性

### 🎭 Live VRM Avatar / 活灵活现的虚拟形象
- 3D VRM model with real-time facial expressions — happy, sad, angry, surprised, think, curious...
- Lip-sync perfectly matched to voice output
- Idle animations & random fidgets — she's alive even when you're not talking
- Eyes follow your mouse cursor or camera
- 5 built-in VRM models + import your own custom models
- 3D VRM 模型，实时面部表情切换
- 口型与语音完美同步
- 待机动画和随机小动作——不说话的时候她也是活的
- 视线跟踪鼠标或摄像头
- 5 款内置 VRM 模型 + 支持导入自定义模型

### 🧠 AI Conversation & Voice / AI 对话与语音
- Chat via text or voice (hold F10 to speak), she replies with voice — not just text
- Voice call mode with redesigned UI — smooth, immersive voice conversations
- LLM-powered personality — she has her own character, not just a chatbot
- Configurable persona via SOUL.md & IDENTITY.md — define her personality, speech style, backstory
- One-click persona generation — take a screenshot of the VRM model, AI creates a matching character profile
- Edge TTS (free, Chinese/English/Japanese) or Qwen TTS (20+ expressive voices)
- 文字或语音聊天（按住 F10 说话），她会用语音回复——不只是文字
- 语音通话模式，全新 UI 设计——流畅沉浸的语音对话体验
- LLM 驱动的独立人格——不只是聊天机器人，她有自己的性格
- 通过 SOUL.md 和 IDENTITY.md 自定义人设——定义性格、说话风格、背景故事
- 一键生成人设——截取模型截图，AI 自动生成匹配的角色设定
- Edge TTS（免费，中/英/日语音）或通义千问 TTS（20+ 种表现力丰富的语音）

### 👀 Companion Interaction / 陪伴式交互
- She watches your screen and understands what you're doing — then talks to you about it
- **Playing Slay the Spire?** She helps you plan your deck and warns you about elite fights
- **Debugging a React component?** She notices you've been stuck for a while and suggests taking a break
- **Watching a movie on Bilibili?** She comments on the plot twist she just saw
- **Reading documentation?** She quietly cheers you on: "You got this!"
- 通过屏幕观察感知你正在做的事，像真正的伙伴一样自然地融入你的日常
- **在打杀戮尖塔？** 她会帮你分析卡组搭配，提醒你小心精英怪
- **调试 React 组件？** 她发现你卡了好一会儿，建议你起来活动活动
- **在 B 站看电影？** 她会吐槽刚才的剧情反转
- **在看技术文档？** 她默默给你打气："加油，你可以的！"

### 💃 Dance System / 舞蹈系统
- VMD dance playback with BGM — pick a preset and watch her dance
- Expanded FBX action pool — richer idle animations and emotional reactions
- Full-body IK (Inverse Kinematics) — natural motion retargeting from VMD/FBX to VRM
- VMD 舞蹈播放配合 BGM——选择预设即可观赏舞蹈
- 扩展的 FBX 动作库——更丰富的待机动画和情绪反应
- 全身 IK（逆运动学）——从 VMD/FBX 到 VRM 的自然动作重定向

### 🖥️ Desktop Integration / 桌面集成
- Always-on-top transparent window — she floats above everything
- Click-through — doesn't block your work, only responds when you interact
- Drag to move, rotate camera, zoom in/out
- Pin/unpin, hide/show, collapse menu
- macOS & Windows native support via Tauri
- 置顶透明窗口——始终浮在最上层
- 点击穿透——不影响工作，只在你交互时才响应
- 拖拽移动、旋转视角、缩放
- 置顶/取消置顶、显示/隐藏、折叠菜单
- 通过 Tauri 原生支持 macOS 和 Windows

## Install / 安装

### As OpenClaw Plugin (recommended) / 作为 OpenClaw 插件安装（推荐）

```bash
openclaw plugins install @luckybugqqq/claw-sama
```

The npm package includes pre-built binaries for Windows (.exe) and macOS (.app). OpenClaw loads the plugin and launches the desktop pet automatically.

npm 包内含 Windows (.exe) 和 macOS (.app) 预编译文件。OpenClaw 加载插件后自动启动桌面宠物。

### Build from Source / 从源码构建

```bash
git clone https://github.com/luckybugqqq/claw-sama.git
cd claw-sama/app
npm install
npx tauri build
```

> Requires Node.js 20+ and Rust toolchain. / 需要 Node.js 20+ 和 Rust 工具链。

## Settings / 设置

Open settings via the gear icon on the avatar window: / 点击角色窗口上的齿轮图标打开设置：

| Tab / 标签 | Options / 选项 |
|---|---|
| General / 常规 | Hide UI, subtitles, TTS, volume, gaze tracking, UI position, screen observation / 隐藏UI、字幕、语音、音量、视线跟踪、UI位置、屏幕观察 |
| Voice / 语音 | TTS provider (Edge/Qwen), voice selection with preview / TTS 服务商、语音选择与试听 |
| Model / 形象 | Built-in VRM models, import custom .vrm / 内置VRM模型、导入自定义模型 |
| Persona / 人设 | Edit IDENTITY.md & SOUL.md, one-click AI generation / 编辑人设文件、一键AI生成 |
| Dance / 舞蹈 | Dance presets with BGM, VMD playback / 舞蹈预设与BGM、VMD播放 |

## Architecture / 架构

```
claw-sama/
├── index.ts              # OpenClaw plugin backend / 插件后端
├── app/
│   ├── src/              # React + Three.js frontend / 前端
│   │   ├── components/   # VRMScene, TextBubble, ChatInput, SettingsPanel
│   │   ├── emote.ts      # Emotion controller / 表情控制器
│   │   ├── lip-sync.ts   # Audio-driven lip sync / 口型同步
│   │   ├── motion-controller.ts  # Dance & action orchestration / 舞蹈与动作编排
│   │   ├── vmd-loader.ts # VMD dance file parser / VMD 舞蹈文件解析
│   │   └── vrm-ik-handler.ts    # Full-body IK retargeting / 全身IK重定向
│   ├── public/           # VRM models, animations & BGM / 模型、动画和BGM
│   └── src-tauri/        # Tauri desktop shell / 桌面外壳
└── package.json
```

## Tech Stack / 技术栈

- **Frontend / 前端**: React, Three.js, [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)
- **Desktop / 桌面**: [Tauri](https://tauri.app/)
- **Backend / 后端**: OpenClaw plugin SDK (Node.js)
- **AI**: LLM via OpenClaw runtime (supports multiple providers / 支持多种模型)
- **TTS / 语音合成**: Edge TTS / Qwen TTS

## Acknowledgments / 致谢

- Inspired by [AIRI](https://github.com/moeru-ai/airi) — an AI companion project by moeru-ai
- Inspired by [Lobe Vidol](https://github.com/lobehub/lobe-vidol) — virtual idol interaction by LobeHub

## License / 许可

MIT
