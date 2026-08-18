// Downloads static ffmpeg + ffprobe for the build target into
// src-tauri/binaries/ as Tauri externalBin sidecars. Runs before
// dev/build; skips if the binaries are already present.
import { execSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "src-tauri", "binaries");
const tmpDir = join(binDir, ".tmp");

function hostTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  return "x86_64-unknown-linux-gnu";
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const exe = triple.includes("windows") ? ".exe" : "";
const ffmpegOut = join(binDir, `recode-ffmpeg-${triple}${exe}`);
const ffprobeOut = join(binDir, `recode-ffprobe-${triple}${exe}`);

if (existsSync(ffmpegOut) && existsSync(ffprobeOut)) {
  console.log(`ffmpeg sidecars already present for ${triple}`);
  process.exit(0);
}

async function download(url, dest) {
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function extract(archive, dir) {
  // bsdtar (macOS, Windows 10+, Linux via libarchive) handles zip and tar.xz alike.
  execSync(`tar -xf "${archive}" -C "${dir}"`, { stdio: "inherit" });
}

function findBinary(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      const found = findBinary(p, name);
      if (found) return found;
    } else if (entry === name) {
      return p;
    }
  }
  return null;
}

async function macosUrls(arch) {
  // Version-stamped paths; scrape the homepage for the current ones.
  const html = await (await fetch("https://ffmpeg.martin-riedl.de/")).text();
  const pattern = new RegExp(`/download/macos/${arch}/[^/"]+/ffmpeg\\.zip`);
  const m = html.match(pattern);
  if (!m) throw new Error(`no macos/${arch} build found on ffmpeg.martin-riedl.de`);
  const base = `https://ffmpeg.martin-riedl.de${m[0].replace(/ffmpeg\.zip$/, "")}`;
  return [`${base}ffmpeg.zip`, `${base}ffprobe.zip`];
}

const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download";

async function archives() {
  switch (triple) {
    case "aarch64-apple-darwin":
      return await macosUrls("arm64");
    case "x86_64-apple-darwin":
      return await macosUrls("amd64");
    case "x86_64-unknown-linux-gnu":
      return [`${BTBN}/ffmpeg-master-latest-linux64-gpl.tar.xz`];
    case "x86_64-pc-windows-msvc":
      return [`${BTBN}/ffmpeg-master-latest-win64-gpl.zip`];
    default:
      throw new Error(`no ffmpeg source configured for target: ${triple}`);
  }
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const urls = await archives();
for (let i = 0; i < urls.length; i++) {
  const archive = join(tmpDir, `dl-${i}${urls[i].endsWith(".zip") ? ".zip" : ".tar.xz"}`);
  await download(urls[i], archive);
  extract(archive, tmpDir);
  rmSync(archive);
}

const ffmpegSrc = findBinary(tmpDir, `ffmpeg${exe}`);
const ffprobeSrc = findBinary(tmpDir, `ffprobe${exe}`);
if (!ffmpegSrc || !ffprobeSrc) {
  throw new Error(`extracted archives are missing ffmpeg/ffprobe for ${triple}`);
}

copyFileSync(ffmpegSrc, ffmpegOut);
copyFileSync(ffprobeSrc, ffprobeOut);
if (!exe) {
  chmodSync(ffmpegOut, 0o755);
  chmodSync(ffprobeOut, 0o755);
}
rmSync(tmpDir, { recursive: true, force: true });
console.log(`ffmpeg sidecars ready: ${ffmpegOut}, ${ffprobeOut}`);
