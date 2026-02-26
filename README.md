# Terminets

Terminets is a desktop application for managing and monitoring VPS/server infrastructure from a single interface.

## What this project is

Terminets (internally branded in the UI as **NODE/GRID**) is built with:
- **Tauri 2** for the desktop runtime and native backend
- **Vite + JavaScript** for the frontend
- **xterm.js** for embedded terminal sessions
- **Leaflet** for server/node map visualization

The app combines SSH-based server operations, live status insights, and file access tools into one control panel.

## Core capabilities

- Fleet-style server dashboard with online/total/ping status
- Interactive world map of nodes with latency visualization
- SSH session management and terminal tabs (PowerShell/CMD/Bash/Zsh/local)
- Metrics panels for selected nodes
- Built-in SFTP browser with file navigation and editing flow
- Recent session history and host information summaries

## Project structure

- Frontend UI: `src/` (main app logic in `src/app.js`)
- Desktop/backend: `src-tauri/` (Rust backend in `src-tauri/src/main.rs`)
- Build/dev scripts: `package.json`

## Run locally

```bash
npm install
npm run dev
```

## Build desktop app

```bash
npm run build
```
