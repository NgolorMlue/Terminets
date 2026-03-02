// Local shell (PTY) session management
// Extracted from main.rs for better organization

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

pub(crate) struct LocalShellSession {
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send>>,
}

pub(crate) struct LocalShellManager {
    sessions: Arc<Mutex<HashMap<String, Arc<LocalShellSession>>>>,
}

#[derive(Clone)]
pub(crate) struct LocalShellLaunchSpec {
    program: OsString,
    args: Vec<OsString>,
    set_cwd: bool,
    env: Vec<(OsString, OsString)>,
}

fn shell_spec(
    program: impl Into<OsString>,
    args: impl IntoIterator<Item = impl Into<OsString>>,
    set_cwd: bool,
    env: Vec<(OsString, OsString)>,
) -> LocalShellLaunchSpec {
    LocalShellLaunchSpec {
        program: program.into(),
        args: args.into_iter().map(Into::into).collect(),
        set_cwd,
        env,
    }
}

fn build_shell_runtime_env(runtime_root: &Path, cwd: &Path) -> Vec<(OsString, OsString)> {
    let mut envs = Vec::new();
    let mut path_entries = Vec::new();

    let candidate_dirs = [
        runtime_root.join("bin"),
        runtime_root.join("usr").join("bin"),
        runtime_root.join("usr").join("local").join("bin"),
    ];
    for dir in candidate_dirs {
        if dir.is_dir() {
            path_entries.push(dir);
        }
    }

    if let Some(existing) = std::env::var_os("PATH") {
        path_entries.extend(std::env::split_paths(&existing));
    }

    if !path_entries.is_empty() {
        if let Ok(path_value) = std::env::join_paths(path_entries) {
            envs.push((OsString::from("PATH"), path_value));
        }
    }

    let home = std::env::var_os("HOME")
        .or_else(|| dirs::home_dir().map(|d| d.into_os_string()))
        .unwrap_or_else(|| cwd.as_os_str().to_owned());
    envs.push((OsString::from("HOME"), home));
    envs.push((OsString::from("TERM"), OsString::from("xterm-256color")));
    envs.push((OsString::from("CHERE_INVOKING"), OsString::from("1")));

    envs
}

fn bundled_shell_runtime_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("shell-runtime"));
        candidates.push(resource_dir);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("shell-runtime"));
            candidates.push(exe_dir.join("resources").join("shell-runtime"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("shell-runtime"));
        candidates.push(cwd.join("resources").join("shell-runtime"));
        candidates.push(
            cwd.join("src-tauri")
                .join("resources")
                .join("shell-runtime"),
        );
    }

    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    for candidate in candidates {
        if !candidate.is_dir() {
            continue;
        }
        let key = candidate.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            roots.push(candidate);
        }
    }
    roots
}

fn bundled_shell_launch_specs(
    app: &tauri::AppHandle,
    shell: &str,
    cwd: &Path,
) -> Vec<LocalShellLaunchSpec> {
    let (exec_candidates, args): (&[&str], &[&str]) = match shell {
        "bash" => (&["bin/bash.exe", "usr/bin/bash.exe", "bash.exe"], &["-l"]),
        "zsh" => (&["bin/zsh.exe", "usr/bin/zsh.exe", "zsh.exe"], &["-l"]),
        _ => return Vec::new(),
    };

    let mut specs = Vec::new();
    for root in bundled_shell_runtime_roots(app) {
        let env = build_shell_runtime_env(&root, cwd);
        for rel in exec_candidates {
            let path = root.join(rel);
            if path.is_file() {
                specs.push(shell_spec(
                    path.into_os_string(),
                    args.iter().copied(),
                    true,
                    env.clone(),
                ));
            }
        }
    }
    specs
}

#[cfg(target_os = "windows")]
pub(crate) fn known_windows_shell_paths(shell: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        candidates.push(
            PathBuf::from(&user_profile)
                .join("Documents")
                .join("MobaXterm")
                .join("slash")
                .join("bin")
                .join(format!("{shell}.exe")),
        );
    }

    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(
            PathBuf::from(&program_files)
                .join("Git")
                .join("bin")
                .join(format!("{shell}.exe")),
        );
        candidates.push(
            PathBuf::from(&program_files)
                .join("Git")
                .join("usr")
                .join("bin")
                .join(format!("{shell}.exe")),
        );
    }

    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(&program_files_x86)
                .join("Git")
                .join("bin")
                .join(format!("{shell}.exe")),
        );
        candidates.push(
            PathBuf::from(&program_files_x86)
                .join("Git")
                .join("usr")
                .join("bin")
                .join(format!("{shell}.exe")),
        );
    }

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(&local_app_data)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join(format!("{shell}.exe")),
        );
        candidates.push(
            PathBuf::from(&local_app_data)
                .join("Programs")
                .join("Git")
                .join("usr")
                .join("bin")
                .join(format!("{shell}.exe")),
        );
    }

    if shell == "bash" || shell == "zsh" {
        candidates.push(
            PathBuf::from("C:\\msys64")
                .join("usr")
                .join("bin")
                .join(format!("{shell}.exe")),
        );
        candidates.push(
            PathBuf::from("C:\\cygwin64")
                .join("bin")
                .join(format!("{shell}.exe")),
        );
    }

    let mut seen = HashSet::new();
    let mut existing = Vec::new();
    for path in candidates {
        if !path.is_file() {
            continue;
        }
        let key = path.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            existing.push(path);
        }
    }
    existing
}

#[cfg(target_os = "windows")]
fn local_shell_launch_specs(
    app: &tauri::AppHandle,
    shell: &str,
    cwd: &Path,
) -> Vec<LocalShellLaunchSpec> {
    let mut specs = bundled_shell_launch_specs(app, shell, cwd);
    let zsh_via_bash_cmd = "if command -v zsh >/dev/null 2>&1; then exec zsh -l; else echo '[nodegrid] zsh not found, falling back to bash'; exec bash -l; fi";
    let wsl_fallback_via_bash_cmd =
        "echo '[nodegrid] wsl not found, falling back to bash'; exec bash -l";
    match shell {
        "cmd" => {
            specs.push(shell_spec(
                "cmd.exe",
                std::iter::empty::<&str>(),
                true,
                Vec::new(),
            ));
        }
        "bash" => {
            for path in known_windows_shell_paths("bash") {
                specs.push(shell_spec(path.into_os_string(), ["-l"], true, Vec::new()));
            }
            specs.push(shell_spec("bash.exe", ["-l"], true, Vec::new()));
        }
        "zsh" => {
            for spec in bundled_shell_launch_specs(app, "bash", cwd) {
                specs.push(shell_spec(
                    spec.program.clone(),
                    ["-lc", zsh_via_bash_cmd],
                    spec.set_cwd,
                    spec.env.clone(),
                ));
            }
            for path in known_windows_shell_paths("zsh") {
                specs.push(shell_spec(path.into_os_string(), ["-l"], true, Vec::new()));
            }
            for path in known_windows_shell_paths("bash") {
                specs.push(shell_spec(
                    path.into_os_string(),
                    ["-lc", zsh_via_bash_cmd],
                    true,
                    Vec::new(),
                ));
            }
            specs.push(shell_spec("zsh.exe", ["-l"], true, Vec::new()));
            specs.push(shell_spec(
                "bash.exe",
                ["-lc", zsh_via_bash_cmd],
                true,
                Vec::new(),
            ));
        }
        "wsl" => {
            specs.push(shell_spec(
                "wsl.exe",
                ["--cd", "~"],
                false,
                Vec::new(),
            ));
            for spec in bundled_shell_launch_specs(app, "bash", cwd) {
                specs.push(shell_spec(
                    spec.program.clone(),
                    ["-lc", wsl_fallback_via_bash_cmd],
                    spec.set_cwd,
                    spec.env.clone(),
                ));
            }
            for path in known_windows_shell_paths("bash") {
                specs.push(shell_spec(
                    path.into_os_string(),
                    ["-lc", wsl_fallback_via_bash_cmd],
                    true,
                    Vec::new(),
                ));
            }
            specs.push(shell_spec(
                "bash.exe",
                ["-lc", wsl_fallback_via_bash_cmd],
                true,
                Vec::new(),
            ));
        }
        _ => {
            specs.push(shell_spec(
                "powershell.exe",
                std::iter::empty::<&str>(),
                true,
                Vec::new(),
            ));
            specs.push(shell_spec(
                "pwsh.exe",
                std::iter::empty::<&str>(),
                true,
                Vec::new(),
            ));
        }
    }
    specs
}

#[cfg(not(target_os = "windows"))]
fn local_shell_launch_specs(
    app: &tauri::AppHandle,
    shell: &str,
    cwd: &Path,
) -> Vec<LocalShellLaunchSpec> {
    let mut specs = bundled_shell_launch_specs(app, shell, cwd);
    match shell {
        "cmd" => specs.push(shell_spec("sh", ["-l"], true, Vec::new())),
        "zsh" => specs.push(shell_spec("zsh", ["-l"], true, Vec::new())),
        "wsl" => specs.push(shell_spec("bash", ["-l"], true, Vec::new())),
        "powershell" => {
            specs.push(shell_spec(
                "pwsh",
                std::iter::empty::<&str>(),
                true,
                Vec::new(),
            ));
            specs.push(shell_spec(
                "powershell",
                std::iter::empty::<&str>(),
                true,
                Vec::new(),
            ));
        }
        _ => specs.push(shell_spec("bash", ["-l"], true, Vec::new())),
    }
    specs
}

impl LocalShellManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn connect(
        &self,
        app: tauri::AppHandle,
        shell_type: Option<String>,
        cols: u32,
        rows: u32,
        cwd: PathBuf,
    ) -> Result<String, String> {
        let shell = shell_type
            .unwrap_or_else(|| "powershell".to_string())
            .to_lowercase();

        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: rows.max(1).min(u16::MAX as u32) as u16,
                cols: cols.max(1).min(u16::MAX as u32) as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to allocate local PTY: {e}"))?;

        let mut last_err = String::new();
        let mut child_opt: Option<Box<dyn portable_pty::Child + Send>> = None;

        for spec in local_shell_launch_specs(&app, &shell, &cwd) {
            let mut cmd = CommandBuilder::new(&spec.program);
            for arg in &spec.args {
                cmd.arg(arg);
            }
            if spec.set_cwd {
                cmd.cwd(&cwd);
            }
            for (key, value) in &spec.env {
                cmd.env(key, value);
            }
            match pty_pair.slave.spawn_command(cmd) {
                Ok(child) => {
                    child_opt = Some(child);
                    break;
                }
                Err(err) => {
                    last_err = format!("{}: {}", spec.program.to_string_lossy(), err);
                }
            }
        }

        let child = child_opt.ok_or_else(|| {
            if last_err.is_empty() {
                format!("Failed to start local shell '{}'", shell)
            } else if shell == "bash" || shell == "zsh" || shell == "wsl" {
                format!(
                    "Failed to start local shell '{}': {}. Embedded runtime not found. \
Place shell files under resources/shell-runtime (for example bin/{}.exe or usr/bin/{}.exe).",
                    shell, last_err, "bash", "bash"
                )
            } else {
                format!("Failed to start local shell '{}': {}", shell, last_err)
            }
        })?;

        let mut reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone local PTY reader: {e}"))?;
        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to acquire local PTY writer: {e}"))?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(LocalShellSession {
            master: Mutex::new(pty_pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        });

        self.sessions
            .lock()
            .map_err(|_| "Local session registry is unavailable".to_string())?
            .insert(session_id.clone(), Arc::clone(&session));

        let sessions = Arc::clone(&self.sessions);
        let read_id = session_id.clone();
        let read_app = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0_u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let encoded = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let data_event = format!("local-data-{}", read_id);
                        let _ = read_app.emit(&data_event, encoded);
                    }
                    Err(_) => break,
                }
            }
            if let Ok(mut map) = sessions.lock() {
                map.remove(&read_id);
            }
            let eof_event = format!("local-eof-{}", read_id);
            let closed_event = format!("local-closed-{}", read_id);
            let _ = read_app.emit(&eof_event, "");
            let _ = read_app.emit(&closed_event, "");
        });

        Ok(session_id)
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let session = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Local session registry is unavailable".to_string())?;
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| format!("Local session not found: {}", session_id))?
        };

        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "Local session writer is unavailable".to_string())?;
        writer
            .write_all(data)
            .map_err(|e| format!("Local shell write failed: {e}"))?;
        writer
            .flush()
            .map_err(|e| format!("Local shell flush failed: {e}"))?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let session = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Local session registry is unavailable".to_string())?;
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| format!("Local session not found: {}", session_id))?
        };

        let size = PtySize {
            rows: rows.max(1).min(u16::MAX as u32) as u16,
            cols: cols.max(1).min(u16::MAX as u32) as u16,
            pixel_width: 0,
            pixel_height: 0,
        };
        let master = session
            .master
            .lock()
            .map_err(|_| "Local session PTY is unavailable".to_string())?;
        master
            .resize(size)
            .map_err(|e| format!("Local shell resize failed: {e}"))?;
        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "Local session registry is unavailable".to_string())?
            .remove(session_id);
        if let Some(session) = session {
            let mut child = session
                .child
                .lock()
                .map_err(|_| "Local session child is unavailable".to_string())?;
            child
                .kill()
                .map_err(|e| format!("Failed to stop local shell: {e}"))?;
            Ok(())
        } else {
            Err(format!("Local session not found: {}", session_id))
        }
    }
}
