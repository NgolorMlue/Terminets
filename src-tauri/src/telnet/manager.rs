use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::session::TelnetSession;
use crate::config::ServerConfig;

pub struct TelnetSessionManager {
    sessions: Mutex<HashMap<String, Arc<TelnetSession>>>,
}

impl TelnetSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(
        &self,
        config: &ServerConfig,
        session_id: Option<&str>,
        app: AppHandle,
        cols: u32,
        rows: u32,
    ) -> Result<String> {
        let sid = session_id
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let session = Arc::new(TelnetSession::connect(config, &sid, app, cols, rows).await?);
        let mut sessions = self.sessions.lock().await;
        sessions.insert(sid.clone(), session);
        Ok(sid)
    }

    pub async fn write(&self, session_id: &str, data: &[u8]) -> Result<()> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?
        };
        session.write(data).await
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<()> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?
        };
        session.resize(cols, rows).await
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<()> {
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(session_id)
        };
        if let Some(session) = session {
            session.disconnect().await?;
        }
        Ok(())
    }
}
