use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::proxy::VncProxy;

pub struct VncSessionManager {
    sessions: Mutex<HashMap<String, Arc<VncProxy>>>,
}

impl VncSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Start a new VNC proxy session
    /// Returns (session_id, ws_url)
    pub async fn connect(
        &self,
        host: &str,
        port: u16,
        app: AppHandle,
    ) -> Result<(String, String)> {
        let session_id = Uuid::new_v4().to_string();

        let proxy = Arc::new(
            VncProxy::start(session_id.clone(), host.to_string(), port, app).await?,
        );

        let ws_url = proxy.ws_url();

        let mut sessions = self.sessions.lock().await;
        sessions.insert(session_id.clone(), proxy);

        Ok((session_id, ws_url))
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<()> {
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(session_id)
        };
        if let Some(proxy) = session {
            proxy.stop().await?;
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn get_ws_url(&self, session_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).map(|p| p.ws_url())
    }
}
