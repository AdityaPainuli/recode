# Recode

Convert videos without touching a terminal. Local and private, nothing ever leaves your machine.

Drop a video, pick what you want, done. No codec jargon, no upload, no file size limits.

## Presets

| Preset | What it does | Output |
|---|---|---|
| Play anywhere | H.264/AAC, works on any device or app | `.mp4` |
| Smaller file | HEVC (hardware-accelerated on macOS) | `.mp4` |
| Web video | VP9/Opus for browsers | `.webm` |
| Audio only | Strips video, keeps sound | `.m4a` |

Output lands next to the original as `name (recoded).ext`. Originals are never touched.

## Stack

- [Tauri 2](https://tauri.app) (Rust backend, system webview)
- React + TypeScript + Vite frontend
- ffmpeg for the actual conversion (system install for now, bundled sidecar planned)

## Development

Requires Rust, Node, and ffmpeg (`brew install ffmpeg`).

```sh
npm install
npm run tauri dev
```

Build a distributable app:

```sh
npm run tauri build
```

## Roadmap

- [ ] Bundle static ffmpeg as a Tauri sidecar (no Homebrew dependency)
- [ ] Batch conversion (drop multiple files)
- [ ] Custom output folder
- [ ] Windows/Linux builds
