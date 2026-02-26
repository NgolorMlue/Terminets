// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod ssh;

use config::store::ConfigStore;
use config::{AuthMethod, FolderConfig, ServerConfig};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use ssh::manager::SshSessionManager;
use ssh::probe::{collect_metrics, ServerMetricsSnapshot};
use ssh::sftp::{
    create_dir as sftp_create_dir_impl, delete_entry as sftp_delete_entry_impl,
    download_file as sftp_download_file_impl, list_dir as sftp_list_dir_impl,
    read_file as sftp_read_file_impl, rename_entry as sftp_rename_entry_impl,
    upload_file as sftp_upload_file_impl, write_file as sftp_write_file_impl, SftpListResponse,
    SftpReadFileResponse, SftpWriteFileResponse,
};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::IpAddr;
use std::net::SocketAddr;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::Instant;
use sysinfo::System;
use tauri::{Emitter, Manager, State};
use tokio::net::{lookup_host, TcpStream};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Config Commands ──

#[tauri::command]
async fn get_servers(config: State<'_, ConfigStore>) -> Result<Vec<ServerConfig>, String> {
    Ok(config.get_servers().await)
}

#[tauri::command]
async fn get_folders(config: State<'_, ConfigStore>) -> Result<Vec<FolderConfig>, String> {
    Ok(config.get_folders().await)
}

#[tauri::command]
async fn save_server(server: ServerConfig, config: State<'_, ConfigStore>) -> Result<(), String> {
    config.save_server(server).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_folder(folder: FolderConfig, config: State<'_, ConfigStore>) -> Result<(), String> {
    config.save_folder(folder).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_server(server_id: String, config: State<'_, ConfigStore>) -> Result<(), String> {
    config
        .delete_server(&server_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_folder(folder_id: String, config: State<'_, ConfigStore>) -> Result<(), String> {
    config
        .delete_folder(&folder_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn reorder_servers(server_ids: Vec<String>, config: State<'_, ConfigStore>) -> Result<(), String> {
    config
        .reorder_servers(server_ids)
        .await
        .map_err(|e| e.to_string())
}

// ── SSH Commands ──

fn apply_auth_overrides(
    server: &mut ServerConfig,
    username_override: Option<String>,
    password_override: Option<String>,
) {
    if let Some(name) = username_override {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            server.username = trimmed.to_string();
        }
    }

    if let Some(password) = password_override {
        if let AuthMethod::Password {
            password: configured,
        } = &mut server.auth_method
        {
            *configured = password;
        }
    }
}

struct LocalShellSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
}

struct LocalShellManager {
    sessions: Arc<Mutex<HashMap<String, Arc<LocalShellSession>>>>,
}

#[derive(Clone)]
struct LocalShellLaunchSpec {
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
fn known_windows_shell_paths(shell: &str) -> Vec<PathBuf> {
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
    fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn connect(
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
            } else if shell == "bash" || shell == "zsh" {
                format!(
                    "Failed to start local shell '{}': {}. Embedded runtime not found. \
Place shell files under resources/shell-runtime (for example bin/{}.exe or usr/bin/{}.exe).",
                    shell, last_err, shell, shell
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

    fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
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

    fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
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

    fn disconnect(&self, session_id: &str) -> Result<(), String> {
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

#[tauri::command]
async fn ssh_connect(
    server_id: String,
    cols: Option<u32>,
    rows: Option<u32>,
    username_override: Option<String>,
    password_override: Option<String>,
    ssh_mgr: State<'_, SshSessionManager>,
    config: State<'_, ConfigStore>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    apply_auth_overrides(&mut server, username_override, password_override);

    let c = cols.unwrap_or(80);
    let r = rows.unwrap_or(24);

    ssh_mgr
        .connect(&server, app, c, r)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_write(
    session_id: String,
    data: Vec<u8>,
    ssh_mgr: State<'_, SshSessionManager>,
) -> Result<(), String> {
    ssh_mgr
        .write(&session_id, &data)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_write_text(
    session_id: String,
    data: String,
    ssh_mgr: State<'_, SshSessionManager>,
) -> Result<(), String> {
    ssh_mgr
        .write(&session_id, data.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    ssh_mgr: State<'_, SshSessionManager>,
) -> Result<(), String> {
    ssh_mgr
        .resize(&session_id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_disconnect(
    session_id: String,
    ssh_mgr: State<'_, SshSessionManager>,
) -> Result<(), String> {
    ssh_mgr
        .disconnect(&session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_shell_connect(
    shell_type: Option<String>,
    cols: Option<u32>,
    rows: Option<u32>,
    local_shell_mgr: State<'_, LocalShellManager>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let c = cols.unwrap_or(80);
    let r = rows.unwrap_or(24);
    let workspace = app_terminal_workspace_dir();
    std::fs::create_dir_all(&workspace).map_err(|e| {
        format!(
            "Failed to create terminal workspace '{}': {e}",
            workspace.display()
        )
    })?;
    local_shell_mgr.connect(app, shell_type, c, r, workspace)
}

#[tauri::command]
async fn local_shell_write(
    session_id: String,
    data: Vec<u8>,
    local_shell_mgr: State<'_, LocalShellManager>,
) -> Result<(), String> {
    local_shell_mgr.write(&session_id, &data)
}

#[tauri::command]
async fn local_shell_write_text(
    session_id: String,
    data: String,
    local_shell_mgr: State<'_, LocalShellManager>,
) -> Result<(), String> {
    local_shell_mgr.write(&session_id, data.as_bytes())
}

#[tauri::command]
async fn local_shell_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    local_shell_mgr: State<'_, LocalShellManager>,
) -> Result<(), String> {
    local_shell_mgr.resize(&session_id, cols, rows)
}

#[tauri::command]
async fn local_shell_disconnect(
    session_id: String,
    local_shell_mgr: State<'_, LocalShellManager>,
) -> Result<(), String> {
    local_shell_mgr.disconnect(&session_id)
}

#[tauri::command]
async fn start_local_terminal(terminal_type: Option<String>) -> Result<(), String> {
    let workspace = app_terminal_workspace_dir();
    std::fs::create_dir_all(&workspace).map_err(|e| {
        format!(
            "Failed to create terminal workspace '{}': {e}",
            workspace.display()
        )
    })?;

    let kind = terminal_type
        .unwrap_or_else(|| "powershell".to_string())
        .to_lowercase();

    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<(std::process::Command, bool)> = Vec::new();
        let zsh_via_bash_cmd = "if command -v zsh >/dev/null 2>&1; then exec zsh -l; else echo '[nodegrid] zsh not found, falling back to bash'; exec bash -l; fi";
        if kind == "cmd" {
            candidates.push((std::process::Command::new("cmd.exe"), true));
        } else if kind == "bash" {
            for path in known_windows_shell_paths("bash") {
                let mut bash = std::process::Command::new(path);
                bash.arg("-l");
                candidates.push((bash, true));
            }
            let mut bash = std::process::Command::new("bash.exe");
            bash.arg("-l");
            candidates.push((bash, true));
        } else if kind == "zsh" {
            for path in known_windows_shell_paths("zsh") {
                let mut zsh = std::process::Command::new(path);
                zsh.arg("-l");
                candidates.push((zsh, true));
            }
            for path in known_windows_shell_paths("bash") {
                let mut bash = std::process::Command::new(path);
                bash.args(["-lc", zsh_via_bash_cmd]);
                candidates.push((bash, true));
            }
            let mut zsh = std::process::Command::new("zsh.exe");
            zsh.arg("-l");
            candidates.push((zsh, true));
            let mut bash = std::process::Command::new("bash.exe");
            bash.args(["-lc", zsh_via_bash_cmd]);
            candidates.push((bash, true));
        } else {
            candidates.push((std::process::Command::new("powershell.exe"), true));
            candidates.push((std::process::Command::new("pwsh.exe"), true));
        }

        let mut last_err = String::new();
        for (mut cmd, set_cwd) in candidates {
            cmd.creation_flags(CREATE_NO_WINDOW);
            if set_cwd {
                cmd.current_dir(&workspace);
            }
            match cmd.spawn() {
                Ok(_) => return Ok(()),
                Err(err) => {
                    last_err = err.to_string();
                }
            }
        }
        return Err(format!("Failed to start local terminal: {}", last_err));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .spawn()
            .map_err(|e| format!("Failed to start local terminal: {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let candidates = [
            ("x-terminal-emulator", Vec::<&str>::new()),
            ("gnome-terminal", Vec::<&str>::new()),
            ("konsole", Vec::<&str>::new()),
            ("xterm", Vec::<&str>::new()),
        ];
        for (bin, args) in candidates {
            if std::process::Command::new(bin).args(args).spawn().is_ok() {
                return Ok(());
            }
        }
        return Err(
            "No terminal binary found (tried x-terminal-emulator, gnome-terminal, konsole, xterm)"
                .to_string(),
        );
    }

    #[allow(unreachable_code)]
    Err("Local terminal launch is not supported on this platform".to_string())
}

#[derive(Debug, Serialize)]
struct HostDeviceInfo {
    hostname: String,
    os_name: String,
    os_version: String,
    arch: String,
    cpu_cores: u32,
    total_memory_mb: u64,
    terminal_workspace: String,
}

fn app_terminal_workspace_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.terminey.nodegrid")
        .join("terminal-workspace")
}

fn is_supported_external_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|ch| ch.is_control()) {
        return false;
    }
    let lowered = trimmed.to_ascii_lowercase();
    lowered.starts_with("http://") || lowered.starts_with("https://")
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    if !is_supported_external_url(&trimmed) {
        return Err("Only http/https URLs are allowed".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", trimmed.as_str()]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Opening external URLs is not supported on this platform".to_string())
}

#[tauri::command]
async fn get_host_device_info() -> Result<HostDeviceInfo, String> {
    let mut system = System::new_all();
    system.refresh_all();

    let hostname = System::host_name().unwrap_or_else(|| "Unknown".to_string());
    let os_name = System::name().unwrap_or_else(|| std::env::consts::OS.to_string());
    let os_version = System::os_version().unwrap_or_default();
    let arch = std::env::consts::ARCH.to_string();
    let cpu_cores = u32::try_from(system.cpus().len()).unwrap_or(0);

    let raw_memory = system.total_memory();
    let total_memory_mb = if raw_memory > 1_073_741_824 {
        raw_memory / (1024 * 1024)
    } else {
        raw_memory / 1024
    };

    let terminal_workspace = app_terminal_workspace_dir().to_string_lossy().to_string();

    Ok(HostDeviceInfo {
        hostname,
        os_name,
        os_version,
        arch,
        cpu_cores,
        total_memory_mb,
        terminal_workspace,
    })
}

#[tauri::command]
async fn ssh_probe_metrics(
    server_id: String,
    config: State<'_, ConfigStore>,
) -> Result<ServerMetricsSnapshot, String> {
    let server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    collect_metrics(&server).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_list_dir(
    server_id: String,
    path: Option<String>,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<SftpListResponse, String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_list_dir_impl(&server, path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_upload_file(
    server_id: String,
    local_path: String,
    remote_path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_upload_file_impl(&server, local_path, remote_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_download_file(
    server_id: String,
    remote_path: String,
    local_path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_download_file_impl(&server, remote_path, local_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_rename_entry(
    server_id: String,
    old_path: String,
    new_path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_rename_entry_impl(&server, old_path, new_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_delete_entry(
    server_id: String,
    path: String,
    is_dir: bool,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_delete_entry_impl(&server, path, is_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_create_dir(
    server_id: String,
    path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_create_dir_impl(&server, path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_read_file(
    server_id: String,
    path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<SftpReadFileResponse, String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_read_file_impl(&server, path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_write_file(
    server_id: String,
    path: String,
    content: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<SftpWriteFileResponse, String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_write_file_impl(&server, path, content)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
struct ServerStatusResponse {
    status: String,
    latency_ms: Option<u32>,
    reason: Option<String>,
    ip: Option<String>,
}

#[tauri::command]
async fn check_server_status(
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<ServerStatusResponse, String> {
    let ip = match resolve_host_ip(&host).await {
        Ok(ip) => ip,
        Err(err) => {
            return Ok(ServerStatusResponse {
                status: "unknown".to_string(),
                latency_ms: None,
                reason: Some(err),
                ip: None,
            });
        }
    };

    let timeout_ms = timeout_ms.unwrap_or(2500).clamp(250, 15_000);
    let addr = SocketAddr::new(ip, port);
    let start = Instant::now();

    match tokio::time::timeout(Duration::from_millis(timeout_ms), TcpStream::connect(addr)).await {
        Ok(Ok(_stream)) => {
            let elapsed = start.elapsed().as_millis();
            Ok(ServerStatusResponse {
                status: "online".to_string(),
                latency_ms: Some(u32::try_from(elapsed).unwrap_or(u32::MAX)),
                reason: None,
                ip: Some(ip.to_string()),
            })
        }
        Ok(Err(err)) => Ok(ServerStatusResponse {
            status: "offline".to_string(),
            latency_ms: None,
            reason: Some(err.to_string()),
            ip: Some(ip.to_string()),
        }),
        Err(_) => Ok(ServerStatusResponse {
            status: "offline".to_string(),
            latency_ms: None,
            reason: Some(format!("Connection timed out after {}ms", timeout_ms)),
            ip: Some(ip.to_string()),
        }),
    }
}

#[derive(Debug, Deserialize)]
struct IpApiResponse {
    city: Option<String>,
    region: Option<String>,
    country_name: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    org: Option<String>,
    asn: Option<String>,
    error: Option<bool>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpWhoConnection {
    isp: Option<String>,
    org: Option<String>,
    asn: Option<i64>,
    domain: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpWhoResponse {
    success: bool,
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    connection: Option<IpWhoConnection>,
    message: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeSearchResponse {
    objects: Option<RipeObjects>,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeObjects {
    object: Vec<RipeObject>,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeObject {
    #[serde(rename = "type")]
    object_type: String,
    attributes: RipeAttributes,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeAttributes {
    attribute: Vec<RipeAttribute>,
}

#[derive(Debug, Deserialize, Clone)]
struct RipeAttribute {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct GoogleDnsResponse {
    #[serde(rename = "Answer")]
    answer: Option<Vec<GoogleDnsRecord>>,
    #[serde(rename = "Authority")]
    authority: Option<Vec<GoogleDnsRecord>>,
}

#[derive(Debug, Deserialize)]
struct GoogleDnsRecord {
    data: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct RegistryWhoisEnrichment {
    provider: Option<String>,
    org: Option<String>,
    asn: Option<String>,
    domain: Option<String>,
    source: Option<String>,
}

#[derive(Debug, Serialize)]
struct LookupLocationResponse {
    ip: String,
    location: String,
    lat: f64,
    lng: f64,
    provider: Option<String>,
    org: Option<String>,
    asn: Option<String>,
    domain: Option<String>,
    source: String,
}

#[derive(Debug, Serialize)]
struct GeocodeLocationResponse {
    location: String,
    lat: f64,
    lng: f64,
}

#[derive(Debug, Deserialize)]
struct NominatimItem {
    display_name: Option<String>,
    lat: Option<String>,
    lon: Option<String>,
}

async fn resolve_host_ip(host: &str) -> Result<IpAddr, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("Host is required".into());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }

    let mut addrs = lookup_host((host, 0))
        .await
        .map_err(|e| format!("Failed to resolve host '{host}': {e}"))?;

    addrs
        .next()
        .map(|addr| addr.ip())
        .ok_or_else(|| format!("No IP found for host '{host}'"))
}

fn build_location_label(
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    for part in [city, region, country] {
        if let Some(value) = part {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    parts.join(", ")
}

fn clean_text(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_asn_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let upper = trimmed.to_ascii_uppercase();
    if !upper.starts_with("AS") {
        return None;
    }
    let mut digits = String::new();
    for ch in upper.chars().skip(2) {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        None
    } else {
        Some(format!("AS{digits}"))
    }
}

fn normalize_asn(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(parsed) = parse_asn_token(trimmed) {
        return Some(parsed);
    }
    if trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return Some(format!("AS{}", trimmed));
    }
    None
}

fn split_ipapi_org(org: Option<String>, asn: Option<String>) -> (Option<String>, Option<String>) {
    let mut org_clean = clean_text(org);
    let mut asn_clean = clean_text(asn).and_then(|value| parse_asn_token(&value).or(Some(value)));

    if let Some(text) = org_clean.clone() {
        let upper = text.to_ascii_uppercase();
        if upper.starts_with("AS") {
            let token = text.split_whitespace().next().unwrap_or("").trim();
            if asn_clean.is_none() {
                asn_clean = parse_asn_token(token);
            }
            let rest = text[token.len()..].trim();
            if rest.is_empty() {
                org_clean = None;
            } else {
                org_clean = Some(rest.to_string());
            }
        }
    }

    (org_clean, asn_clean)
}

fn select_best_location(
    ip: IpAddr,
    primary: Option<&LookupLocationResponse>,
    secondary: Option<&LookupLocationResponse>,
) -> String {
    let ip_text = ip.to_string();
    let score = |value: &str| -> usize {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed == ip_text {
            return 0;
        }
        trimmed
            .split(',')
            .filter(|part| !part.trim().is_empty())
            .count()
            * 4
            + trimmed.len()
    };

    let first = primary.map(|r| r.location.clone()).unwrap_or_default();
    let second = secondary.map(|r| r.location.clone()).unwrap_or_default();
    if score(&first) >= score(&second) {
        if first.trim().is_empty() {
            ip_text
        } else {
            first
        }
    } else if second.trim().is_empty() {
        ip_text
    } else {
        second
    }
}

fn domain_hint_from_host(host: &str) -> Option<String> {
    let trimmed = host.trim().trim_matches('.').to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.parse::<IpAddr>().is_ok() {
        return None;
    }
    if !trimmed.contains('.') {
        return None;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    {
        return None;
    }
    Some(trimmed)
}

fn ripe_attr_first(object: &RipeObject, name: &str) -> Option<String> {
    object
        .attributes
        .attribute
        .iter()
        .find(|attr| attr.name.eq_ignore_ascii_case(name))
        .and_then(|attr| clean_text(Some(attr.value.clone())))
}

fn ripe_attr_all(object: &RipeObject, name: &str) -> Vec<String> {
    object
        .attributes
        .attribute
        .iter()
        .filter(|attr| attr.name.eq_ignore_ascii_case(name))
        .filter_map(|attr| clean_text(Some(attr.value.clone())))
        .collect()
}

fn parse_route_prefix_len(route: &str) -> u8 {
    route
        .split('/')
        .nth(1)
        .and_then(|value| value.trim().parse::<u8>().ok())
        .unwrap_or(0)
}

fn extract_domain_from_text(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('.').to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }

    let mut candidate = trimmed.clone();
    if let Some((_, rhs)) = trimmed.rsplit_once('@') {
        candidate = rhs.to_string();
    }

    if !candidate.contains('.') {
        return None;
    }
    if !candidate
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    {
        return None;
    }
    if !candidate.chars().any(|ch| ch.is_ascii_alphabetic()) {
        return None;
    }
    if candidate.ends_with("in-addr.arpa") {
        return None;
    }
    Some(candidate)
}

fn compose_sources(parts: &[&str]) -> String {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for part in parts {
        if part.trim().is_empty() {
            continue;
        }
        if seen.insert((*part).to_string()) {
            out.push((*part).to_string());
        }
    }
    if out.is_empty() {
        "unknown".to_string()
    } else {
        out.join(" + ")
    }
}

fn ptr_name_for_ip(ip: IpAddr) -> Option<String> {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            Some(format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0]))
        }
        IpAddr::V6(_) => None,
    }
}

async fn lookup_ptr_domain(client: &reqwest::Client, ip: IpAddr) -> Option<String> {
    let ptr_name = ptr_name_for_ip(ip)?;
    let response = client
        .get("https://dns.google/resolve")
        .query(&[("name", ptr_name.as_str()), ("type", "PTR")])
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: GoogleDnsResponse = response.json().await.ok()?;

    if let Some(answer) = payload.answer {
        for record in answer {
            if let Some(data) = record.data {
                if let Some(domain) = extract_domain_from_text(&data) {
                    return Some(domain);
                }
            }
        }
    }

    if let Some(authority) = payload.authority {
        for record in authority {
            let Some(data) = record.data else {
                continue;
            };
            for token in data.split_whitespace() {
                if let Some(domain) = extract_domain_from_text(token) {
                    return Some(domain);
                }
            }
        }
    }

    None
}

async fn lookup_ripe_search(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<RipeObject>, String> {
    let response = client
        .get("https://rest.db.ripe.net/search.json")
        .query(&[("query-string", query), ("flags", "no-filtering")])
        .send()
        .await
        .map_err(|e| format!("ripe.db request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("ripe.db HTTP {}", response.status()));
    }
    let payload: RipeSearchResponse = response
        .json()
        .await
        .map_err(|e| format!("ripe.db invalid response: {e}"))?;
    Ok(payload
        .objects
        .map(|objects| objects.object)
        .unwrap_or_default())
}

async fn lookup_ripe_org_details(
    client: &reqwest::Client,
    org_handle: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let objects = lookup_ripe_search(client, org_handle).await?;
    let org_object = objects.iter().find(|obj| {
        obj.object_type.eq_ignore_ascii_case("organisation")
            && ripe_attr_first(obj, "organisation")
                .map(|value| value.eq_ignore_ascii_case(org_handle))
                .unwrap_or(false)
    });

    let Some(org) = org_object else {
        return Ok((None, None));
    };

    let org_name = ripe_attr_first(org, "org-name");
    let email_domain = ripe_attr_all(org, "e-mail")
        .into_iter()
        .find_map(|email| extract_domain_from_text(&email));
    Ok((org_name, email_domain))
}

async fn lookup_via_ripe_registry(
    client: &reqwest::Client,
    ip: IpAddr,
) -> Result<RegistryWhoisEnrichment, String> {
    let objects = lookup_ripe_search(client, &ip.to_string()).await?;
    if objects.is_empty() {
        return Err("ripe.db returned no objects".to_string());
    }

    let inetnum = objects
        .iter()
        .find(|obj| obj.object_type.eq_ignore_ascii_case("inetnum"));
    let route = objects
        .iter()
        .filter(|obj| obj.object_type.eq_ignore_ascii_case("route"))
        .max_by_key(|obj| {
            ripe_attr_first(obj, "route")
                .map(|r| parse_route_prefix_len(&r))
                .unwrap_or(0)
        });

    let mut asn = route
        .and_then(|obj| ripe_attr_first(obj, "origin"))
        .and_then(|value| normalize_asn(&value));

    let mut org = None::<String>;
    let mut org_domain = None::<String>;
    if let Some(inet) = inetnum {
        if let Some(org_handle) = ripe_attr_first(inet, "org") {
            if let Ok((org_name, domain)) = lookup_ripe_org_details(client, &org_handle).await {
                org = org_name;
                org_domain = domain;
            }
        }
        if org.is_none() {
            org = ripe_attr_all(inet, "descr").into_iter().next();
        }

        if asn.is_none() {
            let maybe_from_mnt = ripe_attr_all(inet, "mnt-by")
                .into_iter()
                .find_map(|value| normalize_asn(&value));
            asn = maybe_from_mnt;
        }
    }

    let mut provider = None::<String>;
    let mut provider_domain = None::<String>;
    if let Some(asn_value) = asn.clone() {
        if let Ok(as_objects) = lookup_ripe_search(client, &asn_value).await {
            let aut_num = as_objects
                .iter()
                .find(|obj| {
                    obj.object_type.eq_ignore_ascii_case("aut-num")
                        && ripe_attr_first(obj, "aut-num")
                            .map(|v| v.eq_ignore_ascii_case(&asn_value))
                            .unwrap_or(false)
                })
                .or_else(|| {
                    as_objects
                        .iter()
                        .find(|obj| obj.object_type.eq_ignore_ascii_case("aut-num"))
                });

            if let Some(aut) = aut_num {
                if let Some(org_handle) = ripe_attr_first(aut, "org") {
                    if let Ok((org_name, domain)) =
                        lookup_ripe_org_details(client, &org_handle).await
                    {
                        provider = org_name;
                        provider_domain = domain;
                    }
                }
                if provider.is_none() {
                    provider = ripe_attr_first(aut, "as-name")
                        .or_else(|| ripe_attr_all(aut, "descr").into_iter().next());
                }
            }
        }
    }

    let domain = org_domain.or(provider_domain);
    let source = if provider.is_some() || org.is_some() || asn.is_some() || domain.is_some() {
        Some("ripe.db".to_string())
    } else {
        None
    };

    if source.is_none() {
        Err("ripe.db returned no usable ownership fields".to_string())
    } else {
        Ok(RegistryWhoisEnrichment {
            provider,
            org,
            asn,
            domain,
            source,
        })
    }
}

fn build_lookup_response(
    ip: IpAddr,
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
    provider: Option<String>,
    org: Option<String>,
    asn: Option<String>,
    domain: Option<String>,
    source_name: &str,
) -> Result<LookupLocationResponse, String> {
    let lat = lat.ok_or_else(|| format!("{source_name} returned no latitude"))?;
    let lng = lng.ok_or_else(|| format!("{source_name} returned no longitude"))?;
    let mut location = build_location_label(city, region, country);
    if location.is_empty() {
        location = ip.to_string();
    }
    Ok(LookupLocationResponse {
        ip: ip.to_string(),
        location,
        lat,
        lng,
        provider,
        org,
        asn,
        domain,
        source: source_name.to_string(),
    })
}

async fn lookup_via_ipapi(
    client: &reqwest::Client,
    ip: IpAddr,
) -> Result<LookupLocationResponse, String> {
    let url = format!("https://ipapi.co/{ip}/json/");
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("ipapi.co request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ipapi.co HTTP {}", resp.status()));
    }

    let payload: IpApiResponse = resp
        .json()
        .await
        .map_err(|e| format!("ipapi.co invalid response: {e}"))?;

    if payload.error.unwrap_or(false) {
        return Err(payload
            .reason
            .unwrap_or_else(|| "ipapi.co returned an error".to_string()));
    }

    let (org_value, asn_value) = split_ipapi_org(payload.org, payload.asn);
    let provider_value = org_value.clone();

    build_lookup_response(
        ip,
        payload.city,
        payload.region,
        payload.country_name,
        payload.latitude,
        payload.longitude,
        provider_value,
        org_value,
        asn_value,
        None,
        "ipapi.co",
    )
}

async fn lookup_via_ipwho(
    client: &reqwest::Client,
    ip: IpAddr,
) -> Result<LookupLocationResponse, String> {
    let url = format!("https://ipwho.is/{ip}");
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("ipwho.is request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ipwho.is HTTP {}", resp.status()));
    }

    let payload: IpWhoResponse = resp
        .json()
        .await
        .map_err(|e| format!("ipwho.is invalid response: {e}"))?;

    if !payload.success {
        return Err(payload
            .message
            .unwrap_or_else(|| "ipwho.is returned an error".to_string()));
    }

    let connection = payload.connection;
    let provider = connection
        .as_ref()
        .and_then(|c| c.isp.clone().or(c.org.clone()));
    let org = connection.as_ref().and_then(|c| c.org.clone());
    let asn = connection
        .as_ref()
        .and_then(|c| c.asn)
        .map(|value| format!("AS{}", value));
    let domain = connection.as_ref().and_then(|c| c.domain.clone());

    build_lookup_response(
        ip,
        payload.city,
        payload.region,
        payload.country,
        payload.latitude,
        payload.longitude,
        provider,
        org,
        asn,
        domain,
        "ipwho.is",
    )
}

#[tauri::command]
async fn lookup_ip_location(host: String) -> Result<LookupLocationResponse, String> {
    let ip = resolve_host_ip(&host).await?;
    let domain_hint = domain_hint_from_host(&host);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let (ipwho_result, ipapi_result, registry_result, ptr_domain) = tokio::join!(
        lookup_via_ipwho(&client, ip),
        lookup_via_ipapi(&client, ip),
        lookup_via_ripe_registry(&client, ip),
        lookup_ptr_domain(&client, ip)
    );
    let registry = registry_result.ok();

    match (ipwho_result, ipapi_result) {
        (Ok(ipwho), Ok(ipapi)) => {
            let location = select_best_location(ip, Some(&ipwho), Some(&ipapi));
            let provider = registry
                .as_ref()
                .and_then(|value| clean_text(value.provider.clone()))
                .or_else(|| clean_text(ipapi.provider.clone()))
                .or_else(|| clean_text(ipwho.provider.clone()))
                .or_else(|| clean_text(ipapi.org.clone()))
                .or_else(|| clean_text(ipwho.org.clone()));
            let org = registry
                .as_ref()
                .and_then(|value| clean_text(value.org.clone()))
                .or_else(|| clean_text(ipapi.org.clone()))
                .or_else(|| clean_text(ipwho.org.clone()))
                .or_else(|| clean_text(provider.clone()));
            let asn = registry
                .as_ref()
                .and_then(|value| clean_text(value.asn.clone()))
                .or_else(|| clean_text(ipapi.asn.clone()))
                .or_else(|| clean_text(ipwho.asn.clone()));
            let domain = domain_hint
                .clone()
                .or(ptr_domain.clone())
                .or_else(|| {
                    registry
                        .as_ref()
                        .and_then(|value| clean_text(value.domain.clone()))
                })
                .or_else(|| clean_text(ipapi.domain.clone()))
                .or_else(|| clean_text(ipwho.domain.clone()))
                .or_else(|| clean_text(ipapi.domain.clone()));
            let source = compose_sources(&[
                registry
                    .as_ref()
                    .and_then(|value| value.source.as_deref())
                    .unwrap_or(""),
                "ipwho.is",
                "ipapi.co",
                if ptr_domain.is_some() {
                    "dns.google"
                } else {
                    ""
                },
            ]);

            Ok(LookupLocationResponse {
                ip: ip.to_string(),
                location,
                lat: ipwho.lat,
                lng: ipwho.lng,
                provider,
                org,
                asn,
                domain,
                source,
            })
        }
        (Ok(mut ipwho), Err(_)) => {
            ipwho.provider = registry
                .as_ref()
                .and_then(|value| clean_text(value.provider.clone()))
                .or_else(|| clean_text(ipwho.provider.clone()))
                .or_else(|| clean_text(ipwho.org.clone()));
            ipwho.org = registry
                .as_ref()
                .and_then(|value| clean_text(value.org.clone()))
                .or_else(|| clean_text(ipwho.org.clone()))
                .or_else(|| clean_text(ipwho.provider.clone()));
            ipwho.asn = registry
                .as_ref()
                .and_then(|value| clean_text(value.asn.clone()))
                .or_else(|| clean_text(ipwho.asn.clone()));
            ipwho.domain = domain_hint
                .clone()
                .or(ptr_domain.clone())
                .or_else(|| {
                    registry
                        .as_ref()
                        .and_then(|value| clean_text(value.domain.clone()))
                })
                .or_else(|| clean_text(ipwho.domain.clone()));
            ipwho.source = compose_sources(&[
                registry
                    .as_ref()
                    .and_then(|value| value.source.as_deref())
                    .unwrap_or(""),
                "ipwho.is",
                if ptr_domain.is_some() {
                    "dns.google"
                } else {
                    ""
                },
            ]);
            Ok(ipwho)
        }
        (Err(_), Ok(mut ipapi)) => {
            ipapi.provider = registry
                .as_ref()
                .and_then(|value| clean_text(value.provider.clone()))
                .or_else(|| clean_text(ipapi.provider.clone()))
                .or_else(|| clean_text(ipapi.org.clone()));
            ipapi.org = registry
                .as_ref()
                .and_then(|value| clean_text(value.org.clone()))
                .or_else(|| clean_text(ipapi.org.clone()))
                .or_else(|| clean_text(ipapi.provider.clone()));
            ipapi.asn = registry
                .as_ref()
                .and_then(|value| clean_text(value.asn.clone()))
                .or_else(|| clean_text(ipapi.asn.clone()));
            ipapi.domain = domain_hint
                .clone()
                .or(ptr_domain.clone())
                .or_else(|| {
                    registry
                        .as_ref()
                        .and_then(|value| clean_text(value.domain.clone()))
                })
                .or_else(|| clean_text(ipapi.domain.clone()));
            ipapi.source = compose_sources(&[
                registry
                    .as_ref()
                    .and_then(|value| value.source.as_deref())
                    .unwrap_or(""),
                "ipapi.co",
                if ptr_domain.is_some() {
                    "dns.google"
                } else {
                    ""
                },
            ]);
            Ok(ipapi)
        }
        (Err(ipwho_error), Err(ipapi_error)) => Err(format!(
            "All geo lookup providers failed (ipwho.is: {ipwho_error}; ipapi.co: {ipapi_error})"
        )),
    }
}

#[tauri::command]
async fn geocode_location(query: String) -> Result<GeocodeLocationResponse, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Location query is required".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let resp = client
        .get("https://nominatim.openstreetmap.org/search")
        .header("User-Agent", "NodeGrid/2.0 (desktop app geocoder)")
        .query(&[
            ("q", query),
            ("format", "jsonv2"),
            ("limit", "1"),
            ("addressdetails", "1"),
        ])
        .send()
        .await
        .map_err(|e| format!("Nominatim request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Nominatim HTTP {}", resp.status()));
    }

    let rows: Vec<NominatimItem> = resp
        .json()
        .await
        .map_err(|e| format!("Nominatim invalid response: {e}"))?;

    let first = rows
        .first()
        .ok_or_else(|| format!("No location match found for '{query}'"))?;

    let lat = first
        .lat
        .as_deref()
        .ok_or_else(|| "Geocoder returned no latitude".to_string())?
        .parse::<f64>()
        .map_err(|e| format!("Invalid latitude from geocoder: {e}"))?;

    let lng = first
        .lon
        .as_deref()
        .ok_or_else(|| "Geocoder returned no longitude".to_string())?
        .parse::<f64>()
        .map_err(|e| format!("Invalid longitude from geocoder: {e}"))?;

    let location = first
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(query)
        .to_string();

    Ok(GeocodeLocationResponse { location, lat, lng })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ConfigStore::new())
        .manage(SshSessionManager::new())
        .manage(LocalShellManager::new())
        .invoke_handler(tauri::generate_handler![
            get_servers,
            get_folders,
            save_server,
            save_folder,
            delete_server,
            delete_folder,
            reorder_servers,
            ssh_connect,
            ssh_write,
            ssh_write_text,
            ssh_resize,
            ssh_disconnect,
            local_shell_connect,
            local_shell_write,
            local_shell_write_text,
            local_shell_resize,
            local_shell_disconnect,
            get_host_device_info,
            open_external_url,
            start_local_terminal,
            ssh_probe_metrics,
            sftp_list_dir,
            sftp_upload_file,
            sftp_download_file,
            sftp_rename_entry,
            sftp_delete_entry,
            sftp_create_dir,
            sftp_read_file,
            sftp_write_file,
            check_server_status,
            lookup_ip_location,
            geocode_location,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
