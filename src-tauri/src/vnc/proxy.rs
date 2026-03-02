use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// Represents a VNC proxy session that bridges WebSocket to VNC TCP
pub struct VncProxy {
    pub session_id: String,
    pub ws_port: u16,
    shutdown: Arc<Mutex<bool>>,
    app: AppHandle,
}

impl VncProxy {
    /// Start a new VNC proxy session
    pub async fn start(
        session_id: String,
        vnc_host: String,
        vnc_port: u16,
        app: AppHandle,
    ) -> Result<Self> {
        // Bind to a random available port
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let ws_port = listener.local_addr()?.port();

        let shutdown = Arc::new(Mutex::new(false));
        let shutdown_clone = shutdown.clone();
        let session_id_clone = session_id.clone();
        let vnc_host_clone = vnc_host.clone();
        let app_clone = app.clone();

        // Spawn the proxy server
        tokio::spawn(async move {
            Self::run_proxy(
                listener,
                vnc_host_clone,
                vnc_port,
                session_id_clone,
                shutdown_clone,
                app_clone,
            )
            .await
        });

        Ok(Self {
            session_id,
            ws_port,
            shutdown,
            app,
        })
    }

    async fn run_proxy(
        listener: TcpListener,
        vnc_host: String,
        vnc_port: u16,
        session_id: String,
        shutdown: Arc<Mutex<bool>>,
        app: AppHandle,
    ) {
        loop {
            // Check shutdown flag
            if *shutdown.lock().await {
                break;
            }

            // Accept WebSocket connection with timeout
            let accept_result = tokio::select! {
                result = listener.accept() => result,
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(500)) => continue,
            };

            let (stream, _addr) = match accept_result {
                Ok(s) => s,
                Err(e) => {
                    log::error!("[vnc-proxy] Accept error: {}", e);
                    continue;
                }
            };

            // Upgrade to WebSocket
            let ws_stream = match accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => {
                    log::error!("[vnc-proxy] WebSocket upgrade error: {}", e);
                    continue;
                }
            };

            // Connect to VNC server
            let vnc_addr = format!("{}:{}", vnc_host, vnc_port);
            let vnc_stream = match TcpStream::connect(&vnc_addr).await {
                Ok(s) => s,
                Err(e) => {
                    log::error!("[vnc-proxy] VNC connect error: {}", e);
                    let _ = app.emit(&format!("vnc-error-{}", session_id), format!("Failed to connect to VNC server: {}", e));
                    continue;
                }
            };

            let _ = app.emit(&format!("vnc-connected-{}", session_id), ());

            // Run the proxy
            let session_id_clone = session_id.clone();
            let shutdown_clone = shutdown.clone();
            let app_clone = app.clone();

            tokio::spawn(async move {
                if let Err(e) = Self::proxy_connection(ws_stream, vnc_stream, shutdown_clone).await {
                    log::error!("[vnc-proxy] Proxy error: {}", e);
                }
                let _ = app_clone.emit(&format!("vnc-disconnected-{}", session_id_clone), ());
            });
        }
    }

    async fn proxy_connection(
        ws_stream: tokio_tungstenite::WebSocketStream<TcpStream>,
        vnc_stream: TcpStream,
        shutdown: Arc<Mutex<bool>>,
    ) -> Result<()> {
        let (mut ws_sink, mut ws_source) = ws_stream.split();
        let (mut vnc_reader, mut vnc_writer) = vnc_stream.into_split();

        // WebSocket -> VNC
        let shutdown1 = shutdown.clone();
        let ws_to_vnc = async move {
            while let Some(msg) = ws_source.next().await {
                if *shutdown1.lock().await {
                    break;
                }
                match msg {
                    Ok(Message::Binary(data)) => {
                        if vnc_writer.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Err(_) => break,
                    _ => {}
                }
            }
        };

        // VNC -> WebSocket
        let shutdown2 = shutdown.clone();
        let vnc_to_ws = async move {
            let mut buf = vec![0u8; 65536];
            loop {
                if *shutdown2.lock().await {
                    break;
                }
                match vnc_reader.read(&mut buf).await {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        if ws_sink
                            .send(Message::Binary(buf[..n].to_vec().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        };

        // Run both directions concurrently
        tokio::select! {
            _ = ws_to_vnc => {},
            _ = vnc_to_ws => {},
        }

        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        *self.shutdown.lock().await = true;
        let _ = self.app.emit(&format!("vnc-disconnected-{}", self.session_id), ());
        Ok(())
    }

    pub fn ws_url(&self) -> String {
        format!("ws://127.0.0.1:{}", self.ws_port)
    }
}
