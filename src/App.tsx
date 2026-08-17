import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

const REPO_URL = "https://github.com/AdityaPainuli/recode";

const VIDEO_EXTENSIONS = [
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv",
  "ts", "mts", "m2ts", "3gp", "mpg", "mpeg", "ogv", "vob",
];

const PRESETS = [
  {
    id: "play-anywhere",
    icon: "🎬",
    title: "Play anywhere",
    desc: "MP4 that works on any device, TV, or app",
  },
  {
    id: "smaller-file",
    icon: "📦",
    title: "Smaller file",
    desc: "Shrink the size, keep the quality",
  },
  {
    id: "web-video",
    icon: "🌐",
    title: "Web video",
    desc: "WebM for websites and browsers",
  },
  {
    id: "audio-only",
    icon: "🎧",
    title: "Audio only",
    desc: "Keep the sound, drop the video",
  },
  {
    id: "edit-in-resolve",
    icon: "🎞️",
    title: "Edit in DaVinci",
    desc: "DNxHR for Resolve (free/Linux can't read H.264). Big files",
  },
];

const VIDEO_CODECS = [
  { id: "h264", label: "H.264 / AVC" },
  { id: "hevc", label: "H.265 / HEVC" },
  { id: "vp9", label: "VP9" },
  { id: "av1", label: "AV1" },
  { id: "dnxhr", label: "DNxHR HQ (editing)" },
  { id: "prores", label: "ProRes HQ (editing)" },
  { id: "copy", label: "Copy (no re-encode)" },
];

const AUDIO_CODECS = [
  { id: "aac", label: "AAC" },
  { id: "opus", label: "Opus" },
  { id: "mp3", label: "MP3" },
  { id: "flac", label: "FLAC" },
  { id: "pcm", label: "PCM (editing)" },
  { id: "copy", label: "Copy (no re-encode)" },
  { id: "none", label: "No audio" },
];

const CONTAINERS = [
  { id: "mp4", label: "MP4" },
  { id: "mkv", label: "MKV" },
  { id: "webm", label: "WebM" },
  { id: "mov", label: "MOV" },
];

// WebM only accepts a subset of codecs; other containers take everything we offer.
const WEBM_VIDEO = ["vp9", "av1", "copy"];
const WEBM_AUDIO = ["opus", "none", "copy"];

type Screen = "idle" | "converting" | "done" | "error";

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function isVideoFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.includes(ext);
}

function platformName(): "macos" | "windows" | "linux" {
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return "macos";
  if (ua.includes("Windows")) return "windows";
  return "linux";
}

const FFMPEG_INSTALL: Record<string, string> = {
  macos: "brew install ffmpeg",
  windows: "winget install ffmpeg",
  linux: "sudo apt install ffmpeg",
};

function bugReportUrl(detail?: string): string {
  const title = encodeURIComponent("[bug] ");
  const body = encodeURIComponent(
    `**Platform:** ${navigator.userAgent}\n\n**What happened:**\n\n` +
      (detail ? "**Error output:**\n```\n" + detail + "\n```\n" : "")
  );
  return `${REPO_URL}/issues/new?title=${title}&body=${body}`;
}

function App() {
  const [screen, setScreen] = useState<Screen>("idle");
  const [file, setFile] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [percent, setPercent] = useState(0);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);
  const [jobLabel, setJobLabel] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [vcodec, setVcodec] = useState("h264");
  const [acodec, setAcodec] = useState("aac");
  const [container, setContainer] = useState("mp4");
  const converting = useRef(false);

  useEffect(() => {
    invoke<boolean>("check_ffmpeg").then(setFfmpegOk);

    const unlisteners = [
      listen<{ percent: number }>("convert-progress", (e) => {
        setPercent(e.payload.percent);
      }),
      listen<{ output: string }>("convert-done", (e) => {
        converting.current = false;
        setOutput(e.payload.output);
        setScreen("done");
      }),
      listen<{ message: string }>("convert-error", (e) => {
        converting.current = false;
        setError(e.payload.message);
        setScreen("error");
      }),
      listen("convert-cancelled", () => {
        converting.current = false;
        setScreen("idle");
      }),
      getCurrentWebview().onDragDropEvent((e) => {
        if (converting.current) return;
        if (e.payload.type === "over") {
          setDragOver(true);
        } else if (e.payload.type === "drop") {
          setDragOver(false);
          const video = e.payload.paths.find(isVideoFile);
          if (video) {
            setFile(video);
            setScreen("idle");
          }
        } else {
          setDragOver(false);
        }
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, []);

  async function pickFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof selected === "string") setFile(selected);
  }

  async function startJob(label: string, invocation: Promise<string>) {
    converting.current = true;
    setJobLabel(label);
    setPercent(0);
    setScreen("converting");
    try {
      await invocation;
    } catch (err) {
      converting.current = false;
      setError(String(err));
      setScreen("error");
    }
  }

  function startPreset(preset: string) {
    if (!file || converting.current) return;
    const label = PRESETS.find((p) => p.id === preset)?.title ?? preset;
    startJob(label, invoke<string>("start_convert", { input: file, preset }));
  }

  function startCustom() {
    if (!file || converting.current) return;
    const v = VIDEO_CODECS.find((c) => c.id === vcodec)?.label ?? vcodec;
    startJob(
      `${v} → ${container.toUpperCase()}`,
      invoke<string>("start_convert_custom", {
        input: file,
        vcodec,
        acodec,
        container,
      })
    );
  }

  function pickContainer(next: string) {
    setContainer(next);
    if (next === "webm") {
      if (!WEBM_VIDEO.includes(vcodec)) setVcodec("vp9");
      if (!WEBM_AUDIO.includes(acodec)) setAcodec("opus");
    }
  }

  function cancel() {
    invoke("cancel_convert");
  }

  function reset() {
    setFile(null);
    setOutput(null);
    setError(null);
    setPercent(0);
    setJobLabel("");
    setScreen("idle");
  }

  const videoOptions =
    container === "webm"
      ? VIDEO_CODECS.filter((c) => WEBM_VIDEO.includes(c.id))
      : VIDEO_CODECS;
  const audioOptions =
    container === "webm"
      ? AUDIO_CODECS.filter((c) => WEBM_AUDIO.includes(c.id))
      : AUDIO_CODECS;

  if (ffmpegOk === false) {
    return (
      <main className="container">
        <div className="notice">
          <h1>One thing missing</h1>
          <p>
            Recode uses <strong>ffmpeg</strong> to convert videos on your
            computer. Install it once:
          </p>
          <code>{FFMPEG_INSTALL[platformName()]}</code>
          <p className="muted">
            Then reopen Recode. Nothing ever leaves your computer.
          </p>
          <button onClick={() => invoke<boolean>("check_ffmpeg").then(setFfmpegOk)}>
            Check again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <header>
        <h1>Recode</h1>
        <p className="tagline">Convert videos. Locally. No uploads, ever.</p>
      </header>

      {screen === "idle" && !file && (
        <div
          className={`dropzone ${dragOver ? "drag-over" : ""}`}
          onClick={pickFile}
        >
          <span className="drop-icon">⬇</span>
          <p>Drop a video here</p>
          <p className="muted">or click to choose a file</p>
        </div>
      )}

      {screen === "idle" && file && (
        <>
          <div className="file-chip">
            <span className="file-name">{fileName(file)}</span>
            <button className="link" onClick={reset}>
              change
            </button>
          </div>
          <p className="prompt">What do you want?</p>
          <div className="presets">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className="preset"
                onClick={() => startPreset(p.id)}
              >
                <span className="preset-icon">{p.icon}</span>
                <span className="preset-title">{p.title}</span>
                <span className="preset-desc">{p.desc}</span>
              </button>
            ))}
          </div>

          <button className="link advanced-toggle" onClick={() => setAdvanced(!advanced)}>
            {advanced ? "▾" : "▸"} Advanced: pick exact codecs
          </button>

          {advanced && (
            <div className="advanced">
              <label>
                <span>Video codec</span>
                <select value={vcodec} onChange={(e) => setVcodec(e.target.value)}>
                  {videoOptions.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Audio codec</span>
                <select value={acodec} onChange={(e) => setAcodec(e.target.value)}>
                  {audioOptions.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Container</span>
                <select value={container} onChange={(e) => pickContainer(e.target.value)}>
                  {CONTAINERS.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </label>
              <button onClick={startCustom}>Convert</button>
            </div>
          )}
        </>
      )}

      {screen === "converting" && (
        <div className="status">
          <p className="status-title">{jobLabel}</p>
          <p className="muted">{file ? fileName(file) : ""}</p>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="percent">{percent.toFixed(0)}%</p>
          <button className="secondary" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}

      {screen === "done" && (
        <div className="status">
          <span className="big-icon">✅</span>
          <p className="status-title">Done</p>
          <p className="muted">{output ? fileName(output) : ""}</p>
          <div className="actions">
            {output && (
              <button onClick={() => revealItemInDir(output)}>
                {platformName() === "macos" ? "Show in Finder" : "Show in folder"}
              </button>
            )}
            <button className="secondary" onClick={reset}>
              Convert another
            </button>
          </div>
        </div>
      )}

      {screen === "error" && (
        <div className="status">
          <span className="big-icon">⚠️</span>
          <p className="status-title">That didn't work</p>
          <pre className="error-detail">{error}</pre>
          <div className="actions">
            <button onClick={() => openUrl(bugReportUrl(error ?? undefined))}>
              Report this bug
            </button>
            <button className="secondary" onClick={reset}>
              Start over
            </button>
          </div>
        </div>
      )}

      <footer>
        <button className="link" onClick={() => openUrl(bugReportUrl())}>
          Found a bug? Report it
        </button>
      </footer>
    </main>
  );
}

export default App;
