# DIGITALIKH GETWAY — Neural AI Gateway & Account Pool (v2.0.6)

Desktop AI Router & Account Pool Manager supporting **Google Antigravity OAuth**, **Gemini API Keys**, and **Gemini Web Chat (`gemini.google.com/app`)**.

## Requirements
- **Node.js** 22+ (uses built-in `node:sqlite`)
- **Windows 10 / 11** (x64)

## Quick Start (Development)
```bash
npm install
npm start
```

## Build Windows Installer (`.exe`)
```bash
npm run build
```
Output installer will be generated inside `dist/DIGITALIKH GETWAY Setup <version>.exe`.

## Project Structure
- `main.js` — Electron main process, system tray, IPC handlers, Gemini Web Bridge (`127.0.0.1:20129`)
- `preload.js` — Context-isolated IPC bridge for the renderer
- `dashboard.html` — 3D Orbital Constellation UI, Live Telemetry, Settings & Pool Management
- `activate.html` / `activate.js` — License activation screen
- `engine/app/custom-server.js` — Local API Gateway (`127.0.0.1:20128/v1`), OpenAI/Gemini/Anthropic routing, and multimodal audio handling
- `license/license-manager.js` & `license/cloud-config.json` — Hardware-bound license verification & Firebase config
- `admin-keygen/` — Admin key generator (`npm run keygen`) and dashboard (`npm run admin`)
- `chrome-extension/` — Cookie-Editor helper extension for importing Gemini Web sessions

## Local API Endpoint
- **Base URL:** `http://127.0.0.1:20128/v1`
- **Default API Key:** `ls-digitalikh`
- **Recommended Model:** `Gemini 3.8 Flash Low` (`ag/gemini-3.8-flash-low`)
- **Modes:** `hybrid`, `antigravity`, `gemini`, `gemini-web`

## GitHub Repository
- **URL:** `https://github.com/pphanet01-hash/Digitalikh_GetWay`
