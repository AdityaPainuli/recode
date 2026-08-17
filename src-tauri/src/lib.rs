use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

struct ConvertJob {
    child: Child,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct ConvertState(Mutex<Option<ConvertJob>>);

#[derive(Clone, Serialize)]
struct ProgressPayload {
    percent: f32,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    output: String,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    message: String,
}

/// Command that never flashes a console window on Windows.
fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// GUI apps don't inherit the shell PATH on macOS (and often on Linux),
/// so check the common install locations explicitly before PATH lookup.
fn find_ffmpeg() -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &[
            "C:\\ffmpeg\\bin\\ffmpeg.exe",
            "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
        ]
    } else {
        &[
            "/opt/homebrew/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
            "/usr/bin/ffmpeg",
            "/snap/bin/ffmpeg",
            "/var/lib/flatpak/exports/bin/ffmpeg",
        ]
    };
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let ok = quiet_command(name)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        Some(PathBuf::from(name))
    } else {
        None
    }
}

fn ffprobe_path(ffmpeg: &Path) -> PathBuf {
    let name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    if ffmpeg.parent().map(|p| p.as_os_str().is_empty()).unwrap_or(true) {
        PathBuf::from(name)
    } else {
        ffmpeg.with_file_name(name)
    }
}

fn probe_duration_secs(ffmpeg: &Path, input: &str) -> Option<f64> {
    let out = quiet_command(ffprobe_path(ffmpeg))
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            input,
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().ok()
}

fn s(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

fn video_args(vcodec: &str, container: &str) -> Result<Vec<String>, String> {
    let hvc1_tag = matches!(container, "mp4" | "mov");
    let mut args = match vcodec {
        "copy" => s(&["-c:v", "copy"]),
        "h264" => {
            if cfg!(target_os = "macos") {
                s(&["-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p"])
            } else {
                s(&[
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-pix_fmt", "yuv420p",
                ])
            }
        }
        "hevc" => {
            if cfg!(target_os = "macos") {
                s(&["-c:v", "hevc_videotoolbox", "-q:v", "55", "-pix_fmt", "yuv420p"])
            } else {
                s(&[
                    "-c:v", "libx265", "-preset", "fast", "-crf", "26",
                    "-pix_fmt", "yuv420p",
                ])
            }
        }
        "vp9" => s(&[
            "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0",
            "-deadline", "good", "-cpu-used", "4", "-row-mt", "1",
            "-tile-columns", "2", "-pix_fmt", "yuv420p",
        ]),
        "av1" => s(&["-c:v", "libsvtav1", "-crf", "32", "-preset", "8", "-pix_fmt", "yuv420p"]),
        other => return Err(format!("unknown video codec: {other}")),
    };
    if vcodec == "hevc" && hvc1_tag {
        args.extend(s(&["-tag:v", "hvc1"]));
    }
    Ok(args)
}

fn audio_args(acodec: &str) -> Result<Vec<String>, String> {
    Ok(match acodec {
        "copy" => s(&["-c:a", "copy"]),
        "aac" => s(&["-c:a", "aac", "-b:a", "192k"]),
        "opus" => s(&["-c:a", "libopus", "-b:a", "128k"]),
        "mp3" => s(&["-c:a", "libmp3lame", "-q:a", "2"]),
        "flac" => s(&["-c:a", "flac"]),
        "none" => s(&["-an"]),
        other => return Err(format!("unknown audio codec: {other}")),
    })
}

/// Maps a preset id to (ffmpeg output args, output extension).
fn preset_args(preset: &str) -> Result<(Vec<String>, String), String> {
    let (v, a, container) = match preset {
        "play-anywhere" => ("h264", "aac", "mp4"),
        "smaller-file" => ("hevc", "aac", "mp4"),
        "web-video" => ("vp9", "opus", "webm"),
        "audio-only" => {
            let mut args = s(&["-vn"]);
            args.extend(audio_args("aac")?);
            return Ok((args, "m4a".to_string()));
        }
        other => return Err(format!("unknown preset: {other}")),
    };
    build_args(v, a, container)
}

fn build_args(vcodec: &str, acodec: &str, container: &str) -> Result<(Vec<String>, String), String> {
    if !matches!(container, "mp4" | "mkv" | "webm" | "mov") {
        return Err(format!("unknown container: {container}"));
    }
    let mut args = video_args(vcodec, container)?;
    args.extend(audio_args(acodec)?);
    if matches!(container, "mp4" | "mov") {
        args.extend(s(&["-movflags", "+faststart"]));
    }
    Ok((args, container.to_string()))
}

fn output_path_for(input: &Path, ext: &str) -> PathBuf {
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    let dir = input.parent().unwrap_or(Path::new("."));
    let mut candidate = dir.join(format!("{stem} (recoded).{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} (recoded {n}).{ext}"));
        n += 1;
    }
    candidate
}

fn run_convert(
    app: AppHandle,
    state: State<'_, ConvertState>,
    input: String,
    args: Vec<String>,
    ext: String,
) -> Result<String, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let input_path = PathBuf::from(&input);
    if !input_path.is_file() {
        return Err("input file does not exist".into());
    }
    let output = output_path_for(&input_path, &ext);
    let duration = probe_duration_secs(&ffmpeg, &input);

    let mut cmd = quiet_command(&ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i", &input])
        .args(&args)
        .args(["-progress", "pipe:1", "-nostats"])
        .arg(&output)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("failed to start ffmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("failed to capture ffmpeg output")?;
    let stderr = child.stderr.take();
    let cancelled = Arc::new(AtomicBool::new(false));

    {
        let mut guard = state.0.lock().unwrap();
        if guard.is_some() {
            let _ = child.kill();
            return Err("a conversion is already running".into());
        }
        *guard = Some(ConvertJob {
            child,
            cancelled: cancelled.clone(),
        });
    }

    let out_str = output.to_string_lossy().to_string();
    let out_ret = out_str.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        // Collect stderr in parallel so we can report a useful error message.
        let stderr_handle = stderr.map(|e| {
            std::thread::spawn(move || {
                BufReader::new(e)
                    .lines()
                    .filter_map(|l| l.ok())
                    .collect::<Vec<_>>()
            })
        });

        for line in BufReader::new(stdout).lines().filter_map(|l| l.ok()) {
            if let Some(us) = line.strip_prefix("out_time_us=") {
                if let (Ok(us), Some(total)) = (us.parse::<f64>(), duration) {
                    if total > 0.0 {
                        let pct = ((us / 1_000_000.0) / total * 100.0).clamp(0.0, 99.9);
                        let _ = app2.emit("convert-progress", ProgressPayload {
                            percent: pct as f32,
                        });
                    }
                }
            }
        }

        let status = {
            let state = app2.state::<ConvertState>();
            let mut guard = state.0.lock().unwrap();
            guard.take().map(|mut job| job.child.wait())
        };

        if cancelled.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&out_str);
            let _ = app2.emit("convert-cancelled", ());
            return;
        }

        match status {
            Some(Ok(s)) if s.success() => {
                let _ = app2.emit("convert-done", DonePayload { output: out_str });
            }
            _ => {
                let tail = stderr_handle
                    .and_then(|h| h.join().ok())
                    .map(|lines| {
                        lines.iter().rev().take(4).rev().cloned().collect::<Vec<_>>().join("\n")
                    })
                    .unwrap_or_default();
                let _ = std::fs::remove_file(&out_str);
                let _ = app2.emit("convert-error", ErrorPayload {
                    message: if tail.is_empty() {
                        "conversion failed".into()
                    } else {
                        tail
                    },
                });
            }
        }
    });

    Ok(out_ret)
}

#[tauri::command]
fn check_ffmpeg() -> bool {
    find_ffmpeg().is_some()
}

#[tauri::command]
fn start_convert(
    app: AppHandle,
    state: State<'_, ConvertState>,
    input: String,
    preset: String,
) -> Result<String, String> {
    let (args, ext) = preset_args(&preset)?;
    run_convert(app, state, input, args, ext)
}

#[tauri::command]
fn start_convert_custom(
    app: AppHandle,
    state: State<'_, ConvertState>,
    input: String,
    vcodec: String,
    acodec: String,
    container: String,
) -> Result<String, String> {
    let (args, ext) = build_args(&vcodec, &acodec, &container)?;
    run_convert(app, state, input, args, ext)
}

#[tauri::command]
fn cancel_convert(state: State<'_, ConvertState>) {
    let mut guard = state.0.lock().unwrap();
    if let Some(job) = guard.as_mut() {
        job.cancelled.store(true, Ordering::SeqCst);
        let _ = job.child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ConvertState::default())
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            start_convert,
            start_convert_custom,
            cancel_convert
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
