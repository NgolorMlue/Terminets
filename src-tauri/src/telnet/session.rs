use anyhow::Result;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;

use crate::config::ServerConfig;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

enum SessionCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Disconnect,
}

#[derive(Default)]
struct TelnetParserState {
    in_iac: bool,
    pending_command: Option<u8>,
    in_subnegotiation: bool,
    subnegotiation_iac_seen: bool,
}

pub struct TelnetSession {
    command_tx: mpsc::UnboundedSender<SessionCommand>,
    _io_task: tokio::task::JoinHandle<()>,
}

fn fold_session_command(
    cmd: SessionCommand,
    write_buf: &mut Vec<u8>,
    pending_resize: &mut Option<(u32, u32)>,
    should_disconnect: &mut bool,
) {
    match cmd {
        SessionCommand::Write(bytes) => write_buf.extend_from_slice(&bytes),
        SessionCommand::Resize { cols, rows } => {
            *pending_resize = Some((cols, rows));
        }
        SessionCommand::Disconnect => {
            *should_disconnect = true;
        }
    }
}

fn escape_iac(data: &[u8]) -> Vec<u8> {
    if !data.contains(&IAC) {
        return data.to_vec();
    }
    let mut escaped = Vec::with_capacity(data.len() + 8);
    for byte in data {
        escaped.push(*byte);
        if *byte == IAC {
            escaped.push(IAC);
        }
    }
    escaped
}

fn parse_telnet_chunk(
    state: &mut TelnetParserState,
    chunk: &[u8],
    plain_out: &mut Vec<u8>,
    response_out: &mut Vec<u8>,
) {
    for byte in chunk {
        if state.in_subnegotiation {
            if state.subnegotiation_iac_seen {
                if *byte == SE {
                    state.in_subnegotiation = false;
                    state.subnegotiation_iac_seen = false;
                } else if *byte == IAC {
                    state.subnegotiation_iac_seen = true;
                } else {
                    state.subnegotiation_iac_seen = false;
                }
            } else if *byte == IAC {
                state.subnegotiation_iac_seen = true;
            }
            continue;
        }

        if let Some(cmd) = state.pending_command.take() {
            match cmd {
                DO => {
                    response_out.extend_from_slice(&[IAC, WONT, *byte]);
                }
                WILL => {
                    response_out.extend_from_slice(&[IAC, DONT, *byte]);
                }
                DONT | WONT => {}
                _ => {}
            }
            continue;
        }

        if state.in_iac {
            state.in_iac = false;
            match *byte {
                IAC => plain_out.push(IAC),
                DO | DONT | WILL | WONT => state.pending_command = Some(*byte),
                SB => {
                    state.in_subnegotiation = true;
                    state.subnegotiation_iac_seen = false;
                }
                _ => {}
            }
            continue;
        }

        if *byte == IAC {
            state.in_iac = true;
            continue;
        }

        plain_out.push(*byte);
    }
}

impl TelnetSession {
    pub async fn connect(
        config: &ServerConfig,
        session_id: &str,
        app: AppHandle,
        _initial_cols: u32,
        _initial_rows: u32,
    ) -> Result<Self> {
        let addr = format!("{}:{}", config.host, config.port);
        let stream = TcpStream::connect(&addr)
            .await
            .map_err(|e| anyhow::anyhow!("Telnet connect failed: {}", e))?;
        let _ = stream.set_nodelay(true);

        let (mut reader, mut writer) = stream.into_split();
        let (command_tx, mut command_rx) = mpsc::unbounded_channel::<SessionCommand>();
        let session_id_owned = session_id.to_string();

        let io_task = tokio::spawn(async move {
            let mut parser_state = TelnetParserState::default();
            let mut read_buffer = [0_u8; 8192];

            loop {
                tokio::select! {
                    biased;
                    maybe_cmd = command_rx.recv() => {
                        match maybe_cmd {
                            Some(first_cmd) => {
                                let mut write_buf: Vec<u8> = Vec::new();
                                let mut pending_resize: Option<(u32, u32)> = None;
                                let mut should_disconnect = false;

                                fold_session_command(
                                    first_cmd,
                                    &mut write_buf,
                                    &mut pending_resize,
                                    &mut should_disconnect,
                                );

                                while !should_disconnect {
                                    match command_rx.try_recv() {
                                        Ok(cmd) => {
                                            fold_session_command(
                                                cmd,
                                                &mut write_buf,
                                                &mut pending_resize,
                                                &mut should_disconnect,
                                            );
                                            if write_buf.len() >= 8192 {
                                                break;
                                            }
                                        }
                                        Err(TryRecvError::Empty) => break,
                                        Err(TryRecvError::Disconnected) => {
                                            should_disconnect = true;
                                            break;
                                        }
                                    }
                                }

                                if !write_buf.is_empty() {
                                    let payload = escape_iac(&write_buf);
                                    if writer.write_all(&payload).await.is_err() {
                                        let event_name = format!("telnet-closed-{}", session_id_owned);
                                        let _ = app.emit(&event_name, ());
                                        break;
                                    }
                                }

                                let _ = pending_resize;

                                if should_disconnect {
                                    let _ = writer.shutdown().await;
                                    let event_name = format!("telnet-closed-{}", session_id_owned);
                                    let _ = app.emit(&event_name, ());
                                    break;
                                }
                            }
                            None => {
                                let _ = writer.shutdown().await;
                                let event_name = format!("telnet-closed-{}", session_id_owned);
                                let _ = app.emit(&event_name, ());
                                break;
                            }
                        }
                    }
                    read_result = reader.read(&mut read_buffer) => {
                        match read_result {
                            Ok(0) => {
                                let event_name = format!("telnet-eof-{}", session_id_owned);
                                let _ = app.emit(&event_name, ());
                                break;
                            }
                            Ok(size) => {
                                let mut plain_data = Vec::with_capacity(size);
                                let mut responses = Vec::new();
                                parse_telnet_chunk(
                                    &mut parser_state,
                                    &read_buffer[..size],
                                    &mut plain_data,
                                    &mut responses,
                                );

                                if !responses.is_empty() && writer.write_all(&responses).await.is_err() {
                                    let event_name = format!("telnet-closed-{}", session_id_owned);
                                    let _ = app.emit(&event_name, ());
                                    break;
                                }

                                if !plain_data.is_empty() {
                                    let text = String::from_utf8_lossy(&plain_data).into_owned();
                                    let event_name = format!("telnet-data-{}", session_id_owned);
                                    let _ = app.emit(&event_name, text);
                                }
                            }
                            Err(_) => {
                                let event_name = format!("telnet-closed-{}", session_id_owned);
                                let _ = app.emit(&event_name, ());
                                break;
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            command_tx,
            _io_task: io_task,
        })
    }

    pub async fn write(&self, data: &[u8]) -> Result<()> {
        self.command_tx
            .send(SessionCommand::Write(data.to_vec()))
            .map_err(|e| anyhow::anyhow!("Failed to queue Telnet write: {}", e))
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.command_tx
            .send(SessionCommand::Resize { cols, rows })
            .map_err(|e| anyhow::anyhow!("Failed to queue Telnet resize: {}", e))
    }

    pub async fn disconnect(&self) -> Result<()> {
        self.command_tx
            .send(SessionCommand::Disconnect)
            .map_err(|e| anyhow::anyhow!("Failed to queue Telnet disconnect: {}", e))
    }
}
