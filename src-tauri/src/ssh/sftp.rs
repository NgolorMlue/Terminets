use std::cmp::Ordering;
use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use anyhow::Result;
use russh::client;
use russh::Disconnect;
use russh_keys::key;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::config::{AuthMethod, ServerConfig};

struct ClientHandler;

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }
}

#[derive(Debug, Serialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub created_unix: Option<u64>,
    pub modified_unix: Option<u64>,
    pub chmod: String,
}

#[derive(Debug, Serialize)]
pub struct SftpListResponse {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Serialize)]
pub struct SftpReadFileResponse {
    pub path: String,
    pub size: u64,
    pub modified_unix: Option<u64>,
    pub chmod: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct SftpWriteFileResponse {
    pub path: String,
    pub size: u64,
    pub modified_unix: Option<u64>,
    pub chmod: String,
}

const MAX_EDITABLE_FILE_BYTES: usize = 10 * 1024 * 1024;

fn join_remote(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

fn normalize_path(value: Option<String>) -> String {
    match value {
        Some(path) => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                ".".to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => ".".to_string(),
    }
}

fn metadata_modified_unix(metadata: &russh_sftp::client::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_secs())
}

async fn connect_authenticated(config: &ServerConfig) -> Result<client::Handle<ClientHandler>> {
    let ssh_config = client::Config {
        ..Default::default()
    };

    let addr = format!("{}:{}", config.host, config.port);
    let mut session = client::connect(Arc::new(ssh_config), &addr[..], ClientHandler)
        .await
        .map_err(|e| anyhow::anyhow!("SSH connect failed: {}", e))?;

    match &config.auth_method {
        AuthMethod::Password { password } => {
            let auth_result = session
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| anyhow::anyhow!("Password auth failed: {}", e))?;
            if !auth_result {
                anyhow::bail!("Password authentication rejected by server");
            }
        }
        AuthMethod::Key {
            key_path,
            passphrase,
        } => {
            let key_pair = russh_keys::load_secret_key(key_path, passphrase.as_deref())
                .map_err(|e| anyhow::anyhow!("Failed to load SSH key: {}", e))?;
            let auth_result = session
                .authenticate_publickey(&config.username, Arc::new(key_pair))
                .await
                .map_err(|e| anyhow::anyhow!("Key auth failed: {}", e))?;
            if !auth_result {
                anyhow::bail!("Public key authentication rejected by server");
            }
        }
        AuthMethod::Agent => {
            auth_agent(&mut session, &config.username).await?;
        }
    }

    Ok(session)
}

struct SftpConnection {
    session: client::Handle<ClientHandler>,
    sftp: SftpSession,
}

async fn connect_sftp(config: &ServerConfig) -> Result<SftpConnection> {
    let session = connect_authenticated(config).await?;
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to open SFTP channel: {}", e))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| anyhow::anyhow!("Failed to start SFTP subsystem: {}", e))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP session: {}", e))?;

    Ok(SftpConnection { session, sftp })
}

async fn close_sftp(session: &client::Handle<ClientHandler>, sftp: &SftpSession, reason: &str) {
    let _ = sftp.close().await;
    let _ = session
        .disconnect(Disconnect::ByApplication, reason, "en-US")
        .await;
}

#[cfg(unix)]
async fn auth_agent(session: &mut client::Handle<ClientHandler>, username: &str) -> Result<()> {
    let mut agent = russh_keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to connect to SSH agent: {}", e))?;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to list agent keys: {}", e))?;

    if identities.is_empty() {
        anyhow::bail!("SSH agent has no keys loaded");
    }

    let mut current_agent = agent;
    for id in &identities {
        let (returned_agent, result) = session
            .authenticate_future(username, id.clone(), current_agent)
            .await;
        current_agent = returned_agent;
        if let Ok(true) = result {
            return Ok(());
        }
    }

    anyhow::bail!("SSH agent authentication failed - no accepted keys")
}

#[cfg(windows)]
async fn auth_agent(session: &mut client::Handle<ClientHandler>, username: &str) -> Result<()> {
    let mut agent = russh_keys::agent::client::AgentClient::connect_pageant().await;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to list Pageant keys: {}", e))?;

    if identities.is_empty() {
        anyhow::bail!("Pageant has no keys loaded");
    }

    let mut current_agent = agent;
    for id in &identities {
        let (returned_agent, result) = session
            .authenticate_future(username, id.clone(), current_agent)
            .await;
        current_agent = returned_agent;
        if let Ok(true) = result {
            return Ok(());
        }
    }

    anyhow::bail!("Pageant authentication failed - no accepted keys")
}

pub async fn list_dir(config: &ServerConfig, path: Option<String>) -> Result<SftpListResponse> {
    let SftpConnection { session, sftp } = connect_sftp(config).await?;

    let requested = normalize_path(path);
    let canonical = sftp
        .canonicalize(requested.clone())
        .await
        .unwrap_or(requested);

    let mut entries = Vec::<SftpEntry>::new();
    let read_dir = sftp
        .read_dir(canonical.clone())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to list directory '{}': {}", canonical, e))?;

    for entry in read_dir {
        let name = entry.file_name();
        let file_type = entry.file_type();
        let metadata = entry.metadata();
        let modified_unix = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|dur| dur.as_secs());

        entries.push(SftpEntry {
            path: join_remote(&canonical, &name),
            name,
            is_dir: file_type.is_dir(),
            is_symlink: file_type.is_symlink(),
            size: metadata.len(),
            created_unix: metadata
                .accessed()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|dur| dur.as_secs()),
            modified_unix,
            chmod: metadata.permissions().to_string(),
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    close_sftp(&session, &sftp, "sftp list complete").await;

    Ok(SftpListResponse {
        path: canonical,
        entries,
    })
}

pub async fn upload_file(
    config: &ServerConfig,
    local_path: String,
    remote_path: String,
) -> Result<()> {
    let local = local_path.trim();
    if local.is_empty() {
        anyhow::bail!("Local file path is required");
    }

    let remote = remote_path.trim();
    if remote.is_empty() {
        anyhow::bail!("Remote file path is required");
    }

    let local_name = Path::new(local)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(local);
    let data = tokio::fs::read(local)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read local file '{}': {}", local_name, e))?;

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let mut remote_file = sftp
        .create(remote.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to create remote file '{}': {}", remote, e))?;
    remote_file
        .write_all(&data)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to upload file '{}': {}", remote, e))?;
    let _ = remote_file.shutdown().await;

    close_sftp(&session, &sftp, "sftp upload complete").await;
    Ok(())
}

pub async fn download_file(
    config: &ServerConfig,
    remote_path: String,
    local_path: String,
) -> Result<()> {
    let remote = remote_path.trim();
    if remote.is_empty() {
        anyhow::bail!("Remote file path is required");
    }

    let local = local_path.trim();
    if local.is_empty() {
        anyhow::bail!("Local file path is required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let bytes = sftp
        .read(remote.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read remote file '{}': {}", remote, e))?;

    tokio::fs::write(local, &bytes)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to write local file '{}': {}", local, e))?;

    close_sftp(&session, &sftp, "sftp download complete").await;
    Ok(())
}

pub async fn read_file(config: &ServerConfig, path: String) -> Result<SftpReadFileResponse> {
    let requested = path.trim();
    if requested.is_empty() {
        anyhow::bail!("File path is required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let canonical = sftp
        .canonicalize(requested.to_string())
        .await
        .unwrap_or_else(|_| requested.to_string());

    let bytes = sftp
        .read(canonical.clone())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read file '{}': {}", canonical, e))?;

    if bytes.len() > MAX_EDITABLE_FILE_BYTES {
        close_sftp(&session, &sftp, "sftp read file complete").await;
        anyhow::bail!(
            "File is too large to edit ({} bytes). Max supported size is {} bytes.",
            bytes.len(),
            MAX_EDITABLE_FILE_BYTES
        );
    }

    let content = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("File appears to be binary or non-UTF-8"))?;
    let metadata = sftp
        .metadata(canonical.clone())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to stat file '{}': {}", canonical, e))?;

    close_sftp(&session, &sftp, "sftp read file complete").await;
    Ok(SftpReadFileResponse {
        path: canonical,
        size: metadata.len(),
        modified_unix: metadata_modified_unix(&metadata),
        chmod: metadata.permissions().to_string(),
        content,
    })
}

pub async fn write_file(
    config: &ServerConfig,
    path: String,
    content: String,
) -> Result<SftpWriteFileResponse> {
    let target = path.trim();
    if target.is_empty() {
        anyhow::bail!("File path is required");
    }

    let bytes = content.into_bytes();
    if bytes.len() > MAX_EDITABLE_FILE_BYTES {
        anyhow::bail!(
            "Content is too large ({} bytes). Max supported size is {} bytes.",
            bytes.len(),
            MAX_EDITABLE_FILE_BYTES
        );
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let mut remote_file = sftp
        .create(target.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to open file '{}': {}", target, e))?;
    remote_file
        .write_all(&bytes)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to write file '{}': {}", target, e))?;
    let _ = remote_file.shutdown().await;

    let metadata = sftp
        .metadata(target.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to stat file '{}': {}", target, e))?;

    close_sftp(&session, &sftp, "sftp write file complete").await;
    Ok(SftpWriteFileResponse {
        path: target.to_string(),
        size: metadata.len(),
        modified_unix: metadata_modified_unix(&metadata),
        chmod: metadata.permissions().to_string(),
    })
}

pub async fn rename_entry(config: &ServerConfig, old_path: String, new_path: String) -> Result<()> {
    let old_path = old_path.trim();
    let new_path = new_path.trim();
    if old_path.is_empty() || new_path.is_empty() {
        anyhow::bail!("Both old and new paths are required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    sftp.rename(old_path.to_string(), new_path.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to rename '{}': {}", old_path, e))?;
    close_sftp(&session, &sftp, "sftp rename complete").await;
    Ok(())
}

pub async fn delete_entry(config: &ServerConfig, path: String, is_dir: bool) -> Result<()> {
    let path = path.trim();
    if path.is_empty() {
        anyhow::bail!("Path is required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    if is_dir {
        sftp.remove_dir(path.to_string())
            .await
            .map_err(|e| anyhow::anyhow!("Failed to delete folder '{}': {}", path, e))?;
    } else {
        sftp.remove_file(path.to_string())
            .await
            .map_err(|e| anyhow::anyhow!("Failed to delete file '{}': {}", path, e))?;
    }
    close_sftp(&session, &sftp, "sftp delete complete").await;
    Ok(())
}

pub async fn create_dir(config: &ServerConfig, path: String) -> Result<()> {
    let path = path.trim();
    if path.is_empty() {
        anyhow::bail!("Folder path is required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    sftp.create_dir(path.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to create folder '{}': {}", path, e))?;
    close_sftp(&session, &sftp, "sftp mkdir complete").await;
    Ok(())
}
