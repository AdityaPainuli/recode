import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

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
];

type Screen = "idle" | "converting" | "done" | "error";

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function isVideoFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.includes(ext);
}

function App() {
  const [screen, setScreen] = useState<Screen>("idle");
  const [file, setFile] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [percent, setPercent] = useState(0);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);
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

  async function startConvert(preset: string) {
    if (!file || converting.current) return;
    converting.current = true;
    setActivePreset(preset);
    setPercent(0);
    setScreen("converting");
    try {
      await invoke<string>("start_convert", { input: file, preset });
    } catch (err) {
      converting.current = false;
      setError(String(err));
      setScreen("error");
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
    setActivePreset(null);
    setScreen("idle");
  }

  const presetLabel = PRESETS.find((p) => p.id === activePreset)?.title ?? "";

  if (ffmpegOk === false) {
    return (
      <main className="container">
        <div className="notice">
          <h1>One thing missing</h1>
          <p>
            Recode uses <strong>ffmpeg</strong> to convert videos on your Mac.
            Install it once with Homebrew:
          </p>
          <code>brew install ffmpeg</code>
          <p className="muted">Then reopen Recode. Nothing ever leaves your computer.</p>
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
                onClick={() => startConvert(p.id)}
              >
                <span className="preset-icon">{p.icon}</span>
                <span className="preset-title">{p.title}</span>
                <span className="preset-desc">{p.desc}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {screen === "converting" && (
        <div className="status">
          <p className="status-title">{presetLabel}</p>
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
                Show in Finder
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
          <button className="secondary" onClick={reset}>
            Start over
          </button>
        </div>
      )}
    </main>
  );
}

export default App;
