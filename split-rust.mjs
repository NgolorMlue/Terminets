/**
 * Split main.rs into modules: local_shell.rs and lookup.rs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve('src-tauri', 'src');
const MAIN_RS = resolve(ROOT, 'main.rs');
const LOCAL_SHELL_RS = resolve(ROOT, 'local_shell.rs');
const LOOKUP_RS = resolve(ROOT, 'lookup.rs');

const content = readFileSync(MAIN_RS, 'utf8');
const lines = content.split('\n');
console.log(`Read ${lines.length} lines from main.rs`);

function extract(start, end) {
    return lines.slice(start - 1, end).join('\n');
}

// ============================================================
// 1. local_shell.rs — Lines 120-668
// ============================================================

const localShellContent = `// Local shell (PTY) session management
// Extracted from main.rs for better organization

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

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

${extract(152, 477)}

impl LocalShellManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

${extract(486, 667)}
}
`;

writeFileSync(LOCAL_SHELL_RS, localShellContent);
console.log('✓ Created local_shell.rs');

// ============================================================
// 2. lookup.rs — Lines 1366-2250
// ============================================================

const lookupContent = `// IP geolocation, WHOIS, and reverse DNS lookup logic
// Extracted from main.rs for better organization

use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use tokio::net::lookup_host;

${extract(1366, 1474)}

pub async fn resolve_host_ip(host: &str) -> Result<IpAddr, String> {
${extract(1477, 1494)}

${extract(1496, 2250)}
`;

writeFileSync(LOOKUP_RS, lookupContent);
console.log('✓ Created lookup.rs');

// ============================================================
// 3. Rewrite main.rs
// ============================================================

const newMainRs = `// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod local_shell;
mod lookup;
mod ssh;
mod telnet;
mod vnc;

use config::store::ConfigStore;
use config::{AuthMethod, ConnectionProtocol, FolderConfig, ServerConfig};
use local_shell::LocalShellManager;
use lookup::resolve_host_ip;
use serde::{Deserialize, Serialize};
use ssh::host_key::clear_known_host as clear_known_host_impl;
use ssh::manager::SshSessionManager;
use ssh::probe::{collect_metrics, ServerMetricsSnapshot};
use ssh::sftp::{
    create_dir as sftp_create_dir_impl, delete_entry as sftp_delete_entry_impl,
    download_file as sftp_download_file_impl, list_dir as sftp_list_dir_impl,
    read_file as sftp_read_file_impl, rename_entry as sftp_rename_entry_impl,
    upload_file as sftp_upload_file_impl, write_file as sftp_write_file_impl, SftpListResponse,
    SftpReadFileResponse, SftpWriteFileResponse,
};
use telnet::manager::TelnetSessionManager;
use vnc::manager::VncSessionManager;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use sysinfo::System;
use tauri::{Emitter, Manager, State};
use tokio::net::TcpStream;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Config Commands ──

${extract(45, 119)}

// ── SSH / Telnet / VNC / Local Shell Commands ──

${extract(670, 1365)}

// ── IP Lookup Commands (delegating to lookup module) ──

#[tauri::command]
async fn lookup_ip_location(host: String) -> Result<lookup::LookupLocationResponse, String> {
    lookup::lookup_ip_location(host).await
}

#[tauri::command]
async fn geocode_location(query: String) -> Result<lookup::GeocodeLocationResponse, String> {
    lookup::geocode_location(query).await
}

// ── Main ──

${extract(2251, 2312)}
`;

writeFileSync(MAIN_RS, newMainRs);
console.log('✓ Rewrote main.rs');
console.log('\\nDone! Run "cargo check" in src-tauri to verify.');
