pub mod store;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    #[serde(default = "default_server_icon")]
    pub icon: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub location: String,
    pub lat: f64,
    pub lng: f64,
    #[serde(default)]
    pub folder_id: Option<String>,
}

fn default_server_icon() -> String {
    "server".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    Key {
        key_path: String,
        passphrase: Option<String>,
    },
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderConfig {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigData {
    pub version: u32,
    #[serde(default)]
    pub folders: Vec<FolderConfig>,
    #[serde(default)]
    pub servers: Vec<ServerConfig>,
}

impl Default for ConfigData {
    fn default() -> Self {
        Self {
            version: 2,
            folders: Vec::new(),
            servers: Vec::new(),
        }
    }
}
