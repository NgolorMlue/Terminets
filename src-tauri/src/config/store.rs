use anyhow::Result;
use std::path::PathBuf;
use tokio::sync::Mutex;

use super::{ConfigData, FolderConfig, ServerConfig};

pub struct ConfigStore {
    path: PathBuf,
    data: Mutex<ConfigData>,
}

impl ConfigStore {
    pub fn new() -> Self {
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("com.terminey.nodegrid");

        let path = config_dir.join("servers.json");

        let data = Self::load_from_disk(&path).unwrap_or_default();

        Self {
            path,
            data: Mutex::new(data),
        }
    }

    fn load_from_disk(path: &PathBuf) -> Result<ConfigData> {
        let contents = std::fs::read_to_string(path)?;
        let data: ConfigData = serde_json::from_str(&contents)?;
        Ok(data)
    }

    fn save_to_disk(path: &PathBuf, data: &ConfigData) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(data)?;
        std::fs::write(path, json)?;
        Ok(())
    }

    pub async fn get_servers(&self) -> Vec<ServerConfig> {
        let data = self.data.lock().await;
        data.servers.clone()
    }

    pub async fn get_folders(&self) -> Vec<FolderConfig> {
        let data = self.data.lock().await;
        data.folders.clone()
    }

    pub async fn save_server(&self, server: ServerConfig) -> Result<()> {
        let mut data = self.data.lock().await;

        // Update existing or insert new
        if let Some(existing) = data.servers.iter_mut().find(|s| s.id == server.id) {
            *existing = server;
        } else {
            data.servers.push(server);
        }

        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }

    pub async fn delete_server(&self, server_id: &str) -> Result<()> {
        let mut data = self.data.lock().await;
        data.servers.retain(|s| s.id != server_id);
        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }

    pub async fn reorder_servers(&self, ordered_ids: Vec<String>) -> Result<()> {
        let mut data = self.data.lock().await;

        if data.servers.len() <= 1 {
            return Ok(());
        }

        let mut remaining = std::mem::take(&mut data.servers);
        let mut reordered = Vec::with_capacity(remaining.len());

        for id in ordered_ids {
            if let Some(idx) = remaining.iter().position(|srv| srv.id == id) {
                reordered.push(remaining.remove(idx));
            }
        }

        reordered.extend(remaining.into_iter());
        data.servers = reordered;

        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }

    pub async fn get_server(&self, server_id: &str) -> Option<ServerConfig> {
        let data = self.data.lock().await;
        data.servers.iter().find(|s| s.id == server_id).cloned()
    }

    pub async fn save_folder(&self, folder: FolderConfig) -> Result<()> {
        let mut data = self.data.lock().await;
        if let Some(existing) = data.folders.iter_mut().find(|f| f.id == folder.id) {
            *existing = folder;
        } else {
            data.folders.push(folder);
        }
        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }

    pub async fn delete_folder(&self, folder_id: &str) -> Result<()> {
        let mut data = self.data.lock().await;
        data.folders.retain(|f| f.id != folder_id);
        for server in data.servers.iter_mut() {
            if server.folder_id.as_deref() == Some(folder_id) {
                server.folder_id = None;
            }
        }
        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }
}
