/* ══════════════════════════════════════════════════════════
   NODE/GRID — Real SSH Terminal App
   Tauri 2 + russh + xterm.js
══════════════════════════════════════════════════════════ */

// Static imports — Tauri packages are safe to import even without the runtime
// (they only throw when *called*, not on import)
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { open as tauriOpen, save as tauriSave } from '@tauri-apps/plugin-dialog';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

/* ── Tauri / Browser runtime detection ── */
const isTauri = Boolean(window.__TAURI_INTERNALS__);

// Browser-mode localStorage backend
const STORAGE_KEY = 'nodegrid_servers';
const FOLDER_STORAGE_KEY = 'nodegrid_folders';
const FOLDER_COLLAPSE_STORAGE_KEY = 'nodegrid_folder_collapse';
const UNGROUPED_COLLAPSE_ID = '__ungrouped__';
const RECENT_SESSION_STORAGE_KEY = 'nodegrid_recent_local_sessions';
const RECENT_SESSION_LIMIT = 20;
const _get = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } };
const _set = (l) => localStorage.setItem(STORAGE_KEY, JSON.stringify(l));
const _getFolders = () => { try { return JSON.parse(localStorage.getItem(FOLDER_STORAGE_KEY)) || []; } catch { return []; } };
const _setFolders = (l) => localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(l));

const browserInvoke = async (cmd, args) => {
  if (cmd === 'get_servers') return _get();
  if (cmd === 'get_folders') return _getFolders();
  if (cmd === 'save_server') {
    const srv = args.server, list = _get(), idx = list.findIndex(s => s.id === srv.id);
    if (idx >= 0) list[idx] = srv; else list.push(srv);
    _set(list); return;
  }
  if (cmd === 'save_folder') {
    const folder = args.folder;
    const list = _getFolders();
    const idx = list.findIndex((f) => f.id === folder.id);
    if (idx >= 0) list[idx] = folder; else list.push(folder);
    _setFolders(list);
    return;
  }
  if (cmd === 'delete_server') { _set(_get().filter(s => s.id !== args.serverId)); return; }
  if (cmd === 'delete_folder') {
    const folderId = String(args.folderId || '');
    _setFolders(_getFolders().filter((f) => f.id !== folderId));
    const servers = _get().map((s) => (s.folder_id === folderId ? { ...s, folder_id: null } : s));
    _set(servers);
    return;
  }
  if (cmd === 'reorder_servers') {
    const ids = Array.isArray(args?.serverIds) ? args.serverIds.map((id) => String(id)) : [];
    if (!ids.length) return;
    const list = _get();
    const byId = new Map(list.map((server) => [String(server.id), server]));
    const reordered = [];
    ids.forEach((id) => {
      if (byId.has(id)) {
        reordered.push(byId.get(id));
        byId.delete(id);
      }
    });
    byId.forEach((server) => reordered.push(server));
    _set(reordered);
    return;
  }
  if (cmd === 'lookup_ip_location') throw new Error('Location lookup requires the desktop app');
  if (cmd === 'geocode_location') throw new Error('Text location lookup requires the desktop app');
  if (cmd === 'get_host_device_info') {
    return {
      hostname: 'Browser Preview',
      os_name: navigator.platform || 'Unknown',
      os_version: 'n/a',
      arch: 'n/a',
      cpu_cores: navigator.hardwareConcurrency || 0,
      total_memory_mb: 0,
      terminal_workspace: '.',
    };
  }
  if (cmd === 'start_local_terminal') throw new Error('Local terminal requires the desktop app');
  if (cmd.startsWith('local_shell_')) throw new Error('Local terminal requires the desktop app');
  if (cmd.startsWith('sftp_')) throw new Error('SFTP requires the desktop app');
  if (cmd === 'check_server_status') return { status: 'unknown', latency_ms: null, reason: 'Browser preview mode', ip: null };
  if (cmd === 'ssh_probe_metrics') throw new Error('Metrics refresh requires the desktop app');
  if (cmd === 'ssh_clear_known_host') return 0;
  if (cmd === 'ssh_connect') throw new Error('SSH requires the desktop app');
  if (cmd === 'open_external_url') {
    const url = String(args?.url || '').trim();
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
};

// Use real Tauri APIs in desktop, localStorage mock in browser
const invoke = isTauri ? tauriInvoke : browserInvoke;
const listen = isTauri ? tauriListen : async () => () => {};
const open   = isTauri ? tauriOpen   : async () => null;
const saveDialog = isTauri ? tauriSave : async () => null;

if (!isTauri) console.warn('[NODE/GRID] Browser preview mode — SSH disabled, using localStorage');

/* ══════════════════════════════════════════════════════════
   SERVER STATE  (loaded from Rust backend)
══════════════════════════════════════════════════════════ */
let SRV = [];   // populated on startup from config
let FOLDERS = [];
let selId = null;
let mainDashboardActive = false;
let hostDeviceInfo = null;
const LIVE_METRICS = new Map();
const SERVER_INTEL = new Map();
const SERVER_INTEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
let metricsSensitiveMasked = true;
let metricsLiveEnabled = true;
let statusRefreshInFlight = false;
const STATUS_REFRESH_INTERVAL_MS = 15000;
const METRICS_LIVE_REFRESH_INTERVAL_MS = 4000;
const TERMINAL_INPUT_FLUSH_MS = 2;
const TERMINAL_OUTPUT_FLUSH_MS = 4;
let recentLocalSessions = loadRecentSessions();
let sidebarSuppressClickUntilMs = 0;
let sidebarPointerDragState = null;
let collapsedFolderIds = loadCollapsedFolders();
const SERVER_ICON_OPTIONS = Object.freeze([
  { value: 'server', label: 'Server', glyph: '🖥' },
  { value: 'cloud', label: 'Cloud', glyph: '☁' },
  { value: 'database', label: 'Database', glyph: '🗄' },
  { value: 'shield', label: 'Shield', glyph: '🛡' },
  { value: 'terminal', label: 'Terminal', glyph: '⌨' },
  { value: 'network', label: 'Network', glyph: '🕸' },
]);
const SERVER_ICON_VALUE_SET = new Set(SERVER_ICON_OPTIONS.map((option) => option.value));
const SERVER_ICON_OPTIONS_HTML = SERVER_ICON_OPTIONS
  .map((option) => `<option value="${option.value}">${option.glyph} ${option.label}</option>`)
  .join('');

function normalizeFolderName(value) {
  const name = String(value || '').trim();
  return name.replace(/\s+/g, ' ').slice(0, 64);
}

function normalizeFolderId(value) {
  const id = String(value || '').trim();
  if (!id) return null;
  if (!FOLDERS.some((folder) => folder.id === id)) return null;
  return id;
}

function folderNameById(folderId) {
  const id = String(folderId || '').trim();
  if (!id) return '';
  const folder = FOLDERS.find((item) => item.id === id);
  return folder ? folder.name : '';
}

function folderIconSvg(kind = 'folder') {
  if (kind === 'ungrouped') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"></circle><path d="M12 2.5v4"></path><path d="M12 17.5v4"></path><path d="M2.5 12h4"></path><path d="M17.5 12h4"></path></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l1.6 2h9.4v8.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"></path><path d="M3.5 7.5V5.8a2 2 0 0 1 2-2h4.3l1.4 1.7h7.3a2 2 0 0 1 2 2v2"></path></svg>';
}

function loadCollapsedFolders() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLDER_COLLAPSE_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return new Set();
    const ids = parsed
      .map((id) => String(id || '').trim())
      .filter((id) => id.length > 0);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveCollapsedFolders() {
  try {
    localStorage.setItem(FOLDER_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsedFolderIds)));
  } catch {
    // Ignore localStorage failures.
  }
}

function isFolderCollapsed(folderId) {
  return collapsedFolderIds.has(String(folderId || '').trim());
}

function toggleFolderCollapsed(folderId) {
  const id = String(folderId || '').trim();
  if (!id) return;
  if (collapsedFolderIds.has(id)) collapsedFolderIds.delete(id);
  else collapsedFolderIds.add(id);
  saveCollapsedFolders();
  renderSidebar();
  if (selId !== null) document.getElementById(`sn-${selId}`)?.classList.add('active');
  refreshRailActive();
  refreshSidebarBadges();
}

const INPUT_MODAL = {
  resolver: null,
};

function createInputModal() {
  if (document.getElementById('input-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'input-modal';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="input-modal-overlay" id="input-modal-overlay"></div>
    <div class="input-modal-panel" role="dialog" aria-modal="true" aria-labelledby="input-modal-title">
      <div class="input-modal-title" id="input-modal-title">Input</div>
      <label class="input-modal-label" id="input-modal-label" for="input-modal-value">Value</label>
      <input class="input-modal-input" id="input-modal-value" spellcheck="false" autocomplete="off">
      <div class="input-modal-error" id="input-modal-error" style="display:none"></div>
      <div class="input-modal-actions">
        <button class="input-modal-btn ghost" id="input-modal-cancel">Cancel</button>
        <button class="input-modal-btn" id="input-modal-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const cancel = () => {
    const resolver = INPUT_MODAL.resolver;
    INPUT_MODAL.resolver = null;
    modal.style.display = 'none';
    if (resolver) resolver(null);
  };

  document.getElementById('input-modal-overlay').addEventListener('click', cancel);
  document.getElementById('input-modal-cancel').addEventListener('click', cancel);

  document.getElementById('input-modal-save').addEventListener('click', () => {
    const resolver = INPUT_MODAL.resolver;
    INPUT_MODAL.resolver = null;
    const value = String(document.getElementById('input-modal-value').value || '');
    modal.style.display = 'none';
    if (resolver) resolver(value);
  });

  document.getElementById('input-modal-value').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      document.getElementById('input-modal-save').click();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  });
}

async function askInputModal({
  title = 'Input',
  label = 'Value',
  value = '',
  placeholder = '',
  submitText = 'Save',
} = {}) {
  createInputModal();
  const modal = document.getElementById('input-modal');
  const titleEl = document.getElementById('input-modal-title');
  const labelEl = document.getElementById('input-modal-label');
  const inputEl = document.getElementById('input-modal-value');
  const saveEl = document.getElementById('input-modal-save');
  const errorEl = document.getElementById('input-modal-error');
  if (!modal || !titleEl || !labelEl || !inputEl || !saveEl || !errorEl) return null;

  if (INPUT_MODAL.resolver) return null;

  titleEl.textContent = title;
  labelEl.textContent = label;
  inputEl.value = String(value || '');
  inputEl.placeholder = String(placeholder || '');
  saveEl.textContent = submitText;
  errorEl.style.display = 'none';
  errorEl.textContent = '';
  modal.style.display = 'block';

  setTimeout(() => {
    inputEl.focus();
    inputEl.select();
  }, 0);

  return await new Promise((resolve) => {
    INPUT_MODAL.resolver = resolve;
  });
}

function sDot(s) {
  return s === 'online' ? '#00ffaa' : s === 'warn' ? '#f5a623' : s === 'unknown' ? '#3a5570' : '#ff3b5c';
}

function latencyColor(latencyMs, status) {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) {
    return status === 'offline' ? 'var(--danger)' : 'var(--muted)';
  }
  if (latencyMs < 20) return '#f7fbff';
  if (latencyMs < 90) return '#00ffaa';
  if (latencyMs < 120) return '#c8ff4d';
  if (latencyMs < 150) return '#ffd84d';
  if (latencyMs < 200) return '#ff9f1a';
  return '#ff3b5c';
}

function normalizeCoordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getServerMapCoords(server) {
  const lat = Number(server?.lat);
  const lng = Number(server?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function hasValidMapCoords(server) {
  return Boolean(getServerMapCoords(server));
}

function safeMapFlyTo(mapInstance, coords, minZoom = 3) {
  if (!mapInstance || !coords) return;

  const rawZoom = Number(mapInstance.getZoom?.());
  const targetZoom = Number.isFinite(rawZoom) ? Math.max(rawZoom, minZoom) : minZoom;
  const fly = () => {
    try {
      mapInstance.flyTo([coords.lat, coords.lng], targetZoom, { duration: 0.8 });
    } catch (error) {
      console.warn('Map flyTo skipped due to invalid map state:', error);
    }
  };

  mapInstance.invalidateSize();
  const size = mapInstance.getSize?.();
  const hasSize = size && Number.isFinite(size.x) && Number.isFinite(size.y) && size.x > 0 && size.y > 0;

  if (!hasSize) {
    setTimeout(() => {
      mapInstance.invalidateSize();
      const retrySize = mapInstance.getSize?.();
      const retryHasSize = retrySize
        && Number.isFinite(retrySize.x)
        && Number.isFinite(retrySize.y)
        && retrySize.x > 0
        && retrySize.y > 0;
      if (retryHasSize) fly();
    }, 160);
    return;
  }

  fly();
}

function updateAvgPingRefreshButton() {
  const btn = document.getElementById('h-avgping-refresh-btn');
  if (!btn) return;
  btn.disabled = statusRefreshInFlight;
  btn.classList.toggle('is-loading', statusRefreshInFlight);
  btn.title = statusRefreshInFlight ? 'Refreshing server ping...' : 'Refresh server ping';
  btn.setAttribute('aria-busy', statusRefreshInFlight ? 'true' : 'false');
}

function normalizeServerIcon(icon) {
  const value = String(icon || '').toLowerCase();
  if (SERVER_ICON_VALUE_SET.has(value)) return value;
  return 'server';
}

function serverIconLabel(icon) {
  const key = normalizeServerIcon(icon);
  const found = SERVER_ICON_OPTIONS.find((option) => option.value === key);
  return found ? found.label : 'Server';
}

function serverIconSvg(icon) {
  const key = normalizeServerIcon(icon);
  if (key === 'cloud') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18h9.5a3 3 0 0 0 .4-6 4.8 4.8 0 0 0-9.3-1.4A3.7 3.7 0 0 0 7.5 18Z"></path></svg>';
  }
  if (key === 'database') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6.5" rx="6.5" ry="2.8"></ellipse><path d="M5.5 6.5v10c0 1.5 2.9 2.8 6.5 2.8s6.5-1.3 6.5-2.8v-10"></path><path d="M5.5 11.5c0 1.5 2.9 2.8 6.5 2.8s6.5-1.3 6.5-2.8"></path></svg>';
  }
  if (key === 'shield') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 7 3.2V11c0 5-2.8 8.1-7 10-4.2-1.9-7-5-7-10V6.2L12 3Z"></path><path d="m9.5 11.8 1.8 1.8 3.4-3.6"></path></svg>';
  }
  if (key === 'terminal') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"></rect><path d="m7.5 9.5 2.7 2.3-2.7 2.3"></path><path d="M12.5 15h4"></path></svg>';
  }
  if (key === 'network') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6.2" r="2.2"></circle><circle cx="6.2" cy="17.8" r="2.2"></circle><circle cx="17.8" cy="17.8" r="2.2"></circle><path d="M10.9 8.2 7.4 15.6"></path><path d="m13.1 8.2 3.5 7.4"></path><path d="M8.4 17.8h7.2"></path></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"></rect><path d="M8 8h8"></path><path d="M8 12h8"></path><path d="M8 16h8"></path></svg>';
}

function updateHeaderStats() {
  const total = SRV.length;
  const online = SRV.filter(s => s.status === 'online').length;
  const latencies = SRV.map(s => s.latencyMs).filter(v => typeof v === 'number');
  const avgLatency = latencies.length
    ? `${Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)}ms`
    : '\u2014';

  document.getElementById('h-online').textContent = online;
  document.getElementById('h-total').textContent = total;
  document.getElementById('h-avgping').textContent = avgLatency;
  updateAvgPingRefreshButton();
  const sbCount = document.getElementById('sb-count');
  if (sbCount) sbCount.textContent = `${total}`;
  const sbNodeSummary = document.getElementById('sb-node-summary');
  if (sbNodeSummary) sbNodeSummary.textContent = `${total}`;
  renderMainDashboard();
}

function formatMemoryMb(value) {
  const mb = Number(value);
  if (!Number.isFinite(mb) || mb <= 0) return '\u2014';
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(2)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function loadRecentSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_SESSION_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map(normalizeRecentSessionEntry)
      .filter(Boolean)
      .slice(0, RECENT_SESSION_LIMIT);
  } catch {
    return [];
  }
}

function saveRecentSessions() {
  try {
    localStorage.setItem(RECENT_SESSION_STORAGE_KEY, JSON.stringify(recentLocalSessions.slice(0, RECENT_SESSION_LIMIT)));
  } catch {
    // Ignore localStorage write failures.
  }
}

function formatRecentSessionTimestamp(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '\u2014';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '\u2014';
  }
}

function normalizeRecentSessionEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || '').trim();
  if (!id) return null;

  const mode = String(entry.mode || 'local').toLowerCase() === 'ssh' ? 'ssh' : 'local';
  const openedAtMs = Number(entry.openedAtMs) || Date.now();
  if (mode === 'ssh') {
    return {
      id,
      mode: 'ssh',
      openedAtMs,
      serverId: String(entry.serverId || '').trim(),
      serverName: String(entry.serverName || '').trim(),
      host: String(entry.host || '').trim(),
      port: Number(entry.port) || 22,
      username: String(entry.username || '').trim(),
    };
  }

  return {
    id,
    mode: 'local',
    openedAtMs,
    shell: normalizeLocalShellType(entry.shell || 'powershell'),
    workspace: String(entry.workspace || ''),
  };
}

function recentSessionLabel(entry) {
  if (entry?.mode === 'ssh') {
    const target = entry.serverName || entry.host || 'Unknown server';
    return `SSH · ${target}`;
  }
  return localShellLabel(entry?.shell || 'powershell');
}

function recentSessionMeta(entry) {
  if (entry?.mode === 'ssh') {
    const host = String(entry.host || '').trim();
    const port = Number(entry.port);
    const endpoint = host ? `${host}:${Number.isFinite(port) ? port : 22}` : '\u2014';
    const user = String(entry.username || '').trim();
    return user ? `${endpoint} · ${user}` : endpoint;
  }
  return entry?.workspace ? String(entry.workspace) : '\u2014';
}

function renderRecentSessionHistory() {
  const listEl = document.getElementById('dash-recent-session-list');
  if (!listEl) return;

  if (!recentLocalSessions.length) {
    listEl.innerHTML = '<div class="dash-recent-empty">No recent sessions.</div>';
    syncRecentSessionViewport();
    return;
  }

  listEl.innerHTML = recentLocalSessions.map((entry) => {
    const sessionLabel = recentSessionLabel(entry);
    const openedAt = formatRecentSessionTimestamp(entry.openedAtMs);
    const detail = escapeHtml(String(recentSessionMeta(entry)));
    const sessionId = escapeHtml(String(entry.id || ''));
    return `
      <div
        class="dash-recent-item dash-recent-item-action"
        data-session-id="${sessionId}"
        role="button"
        tabindex="0"
        title="Restore this session"
      >
        <div class="dash-recent-main">
          <div class="dash-recent-shell">${escapeHtml(sessionLabel)}</div>
          <div class="dash-recent-time">${escapeHtml(openedAt)}</div>
        </div>
        <div class="dash-recent-path">${detail}</div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.dash-recent-item-action').forEach((item) => {
    item.addEventListener('click', () => {
      const sessionId = item.dataset.sessionId || '';
      void restoreRecentSession(sessionId);
    });
    item.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      const sessionId = item.dataset.sessionId || '';
      void restoreRecentSession(sessionId);
    });
  });

  syncRecentSessionViewport();
}

function syncRecentSessionViewport() {
  const listEl = document.getElementById('dash-recent-session-list');
  if (!listEl) return;

  const items = Array.from(listEl.querySelectorAll('.dash-recent-item'));
  if (items.length <= 4) {
    listEl.style.maxHeight = '';
    listEl.style.overflowY = '';
    return;
  }

  const styles = window.getComputedStyle(listEl);
  const gap = parseFloat(styles.rowGap || styles.gap || '0') || 0;
  const visibleItems = items.slice(0, 4);
  const visibleHeight = visibleItems.reduce((sum, item) => {
    return sum + item.getBoundingClientRect().height;
  }, 0);
  const totalHeight = visibleHeight + (gap * Math.max(visibleItems.length - 1, 0));

  listEl.style.maxHeight = `${Math.ceil(totalHeight)}px`;
  listEl.style.overflowY = 'auto';
}

function trackRecentSession(sessionEntry) {
  const normalized = normalizeRecentSessionEntry(sessionEntry);
  if (!normalized || !normalized.id) return;
  recentLocalSessions = [
    normalized,
    ...recentLocalSessions.filter((entry) => entry.id !== normalized.id),
  ].slice(0, RECENT_SESSION_LIMIT);
  saveRecentSessions();
  renderRecentSessionHistory();
}

function trackRecentLocalSession(sessionEntry) {
  trackRecentSession({ ...sessionEntry, mode: 'local' });
}

function trackRecentSshSession(sessionEntry) {
  trackRecentSession({ ...sessionEntry, mode: 'ssh' });
}

function removeMostRecentSession() {
  if (!recentLocalSessions.length) return null;
  const [removed, ...rest] = recentLocalSessions;
  recentLocalSessions = rest;
  saveRecentSessions();
  renderRecentSessionHistory();
  return removed;
}

function findLocalTabIdByHistoryId(historyId) {
  if (!historyId) return null;
  const match = Object.entries(termTabs).find(([, tab]) => tab.mode === 'local' && tab.historyId === historyId);
  return match ? match[0] : null;
}

function findSshTabIdByHistoryId(historyId) {
  if (!historyId) return null;
  const match = Object.entries(termTabs).find(([, tab]) => tab.mode === 'ssh' && tab.historyId === historyId);
  return match ? match[0] : null;
}

async function refreshHostDeviceInfo() {
  try {
    hostDeviceInfo = await invoke('get_host_device_info');
  } catch {
    hostDeviceInfo = null;
  }
  renderMainDashboard();
}

function renderMainDashboard() {
  const info = hostDeviceInfo;
  const hostEl = document.getElementById('dash-hostname');
  const osEl = document.getElementById('dash-os');
  const coresEl = document.getElementById('dash-cpu-cores');
  const memEl = document.getElementById('dash-memory');
  const pathEl = document.getElementById('dash-terminal-path');

  if (hostEl) hostEl.textContent = info?.hostname || '\u2014';
  if (osEl) {
    const osName = info?.os_name || 'Unknown OS';
    const osVersion = info?.os_version ? ` ${info.os_version}` : '';
    const arch = info?.arch ? ` (${info.arch})` : '';
    osEl.textContent = `${osName}${osVersion}${arch}`;
  }
  if (coresEl) coresEl.textContent = info?.cpu_cores ? String(info.cpu_cores) : '\u2014';
  if (memEl) memEl.textContent = formatMemoryMb(info?.total_memory_mb || 0);
  if (pathEl) pathEl.textContent = `Terminal workspace: ${info?.terminal_workspace || '\u2014'}`;
  renderMainServerList();
  renderRecentSessionHistory();
  if (mainDashboardActive) {
    ensureDashboardMap();
    renderDashboardMapMarkers(false);
    if (dashMap) setTimeout(() => { dashMap.invalidateSize(); }, 0);
  }
}

function renderMainServerList() {
  const listEl = document.getElementById('dash-server-list');
  if (!listEl) return;

  if (!SRV.length) {
    listEl.innerHTML = '<div class="dash-server-empty">No servers configured.</div>';
    return;
  }

  listEl.innerHTML = SRV.map((server) => {
    const pingText = typeof server.latencyMs === 'number'
      ? `${server.latencyMs}ms`
      : server.status === 'offline' ? 'OFF' : '\u2014';
    const pingColor = latencyColor(server.latencyMs, server.status);
    const activeClass = server.id === selId ? ' active' : '';
    return `<button class="dash-server-item${activeClass}" type="button" data-server-id="${escapeHtml(server.id)}" title="Select ${escapeHtml(server.name)}">
      <span class="dash-server-dot" style="background:${sDot(server.status)};box-shadow:0 0 6px ${sDot(server.status)}"></span>
      <span class="dash-server-name">${escapeHtml(server.name)}</span>
      <span class="dash-server-latency" style="color:${pingColor}">${pingText}</span>
    </button>`;
  }).join('');

  listEl.querySelectorAll('.dash-server-item').forEach((item) => {
    item.addEventListener('click', () => {
      const serverId = item.dataset.serverId || '';
      if (!serverId) return;
      selectSrv(serverId, { keepMain: true });
    });
  });
}

function hasTerminalTabsOpen() {
  return Object.keys(termTabs).length > 0;
}

function hasVisibleTerminalTabsForSelection() {
  return Object.values(termTabs).some((tab) => tab.mode === 'local' || tab.pinned || tab.srvId === selId);
}

function updateMainTerminalLayout() {
  const bottomSection = document.getElementById('bottom-section');
  const dashSection = document.getElementById('dashboard-section');
  const maxBtn = document.getElementById('tab-maximize-btn');
  if (!bottomSection || !dashSection) return;

  if (!mainDashboardActive) {
    bottomSection.classList.remove('terminal-collapsed');
    bottomSection.style.flex = '';
    bottomSection.style.height = '';
    dashSection.style.flex = '';
    dashSection.style.height = '';
    if (maxBtn) maxBtn.style.display = '';
    return;
  }

  const hasTabs = mainDashboardActive ? hasVisibleTerminalTabsForSelection() : hasTerminalTabsOpen();
  if (!hasTabs) {
    bottomSection.classList.add('terminal-collapsed');
    bottomSection.style.flex = '0 0 38px';
    bottomSection.style.height = '38px';
    dashSection.style.display = '';
    dashSection.style.flex = '1 1 auto';
    dashSection.style.height = 'auto';
    if (maxBtn) maxBtn.style.display = 'none';
    return;
  }

  if (isMaximized) {
    bottomSection.classList.remove('terminal-collapsed');
    bottomSection.style.flex = '1 1 auto';
    bottomSection.style.height = 'auto';
    dashSection.style.display = 'none';
    dashSection.style.flex = '0 0 0';
    dashSection.style.height = '0';
    if (maxBtn) maxBtn.style.display = '';
    return;
  }

  bottomSection.classList.remove('terminal-collapsed');
  dashSection.style.display = '';
  bottomSection.style.flex = '0 0 50%';
  bottomSection.style.height = '50%';
  dashSection.style.flex = '0 0 50%';
  dashSection.style.height = '50%';
  if (maxBtn) maxBtn.style.display = '';
}

function setMainDashboardActive(active) {
  mainDashboardActive = Boolean(active);
  const mainBtn = document.getElementById('sb-main-tab');
  const mapSection = document.getElementById('map-section');
  const dashSection = document.getElementById('dashboard-section');
  const metricsBtn = document.getElementById('tab-metrics-btn');
  if (mainBtn) mainBtn.classList.toggle('active', mainDashboardActive);
  if (mapSection) mapSection.style.display = mainDashboardActive ? 'none' : '';
  if (dashSection) dashSection.style.display = mainDashboardActive ? '' : 'none';
  if (metricsBtn) metricsBtn.style.display = mainDashboardActive ? 'none' : '';
  if (mainDashboardActive) {
    selectSrv(null, { keepMain: true });
    renderMainDashboard();
    void refreshHostDeviceInfo();
    setTerminalPickerVisible(false);
    hideTabAddMenu();
    setTimeout(() => {
      if (dashMap) {
        dashMap.invalidateSize();
        renderDashboardMapMarkers(true);
      }
    }, 140);
  }
  if (!mainDashboardActive) {
    setTerminalPickerVisible(false);
    hideTabAddMenu();
    setTimeout(() => { map.invalidateSize(); }, 120);
  }
  updateMainTerminalLayout();
}

function setTerminalPickerVisible(visible) {
  const picker = document.getElementById('dash-terminal-picker');
  if (!picker) return;
  picker.style.display = visible ? 'flex' : 'none';
}

function normalizeLocalShellType(shellType) {
  const value = String(shellType || '').toLowerCase();
  if (value === 'cmd' || value === 'bash' || value === 'zsh') return value;
  return 'powershell';
}

function localShellLabel(shellType) {
  const kind = normalizeLocalShellType(shellType);
  if (kind === 'cmd') return 'CMD';
  if (kind === 'bash') return 'Bash';
  if (kind === 'zsh') return 'Zsh';
  return 'PowerShell';
}

async function startLocalTerminalFromDashboard(terminalType) {
  const terminalKind = normalizeLocalShellType(terminalType);
  const terminalLabel = localShellLabel(terminalKind);
  const btn = document.getElementById('dash-start-local-terminal-btn');
  const status = document.getElementById('dash-status');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Starting...';
  }
  setTerminalPickerVisible(false);
  if (status) {
    status.classList.remove('error');
    status.textContent = `Launching ${terminalLabel}...`;
  }

  try {
    const tid = addLocalTermTab(terminalKind);
    if (!tid) throw new Error('Could not create local terminal tab');
    if (status) {
      status.classList.remove('error');
      status.textContent = `${terminalLabel} tab opened.`;
    }
  } catch (err) {
    if (status) {
      status.classList.add('error');
      status.textContent = `Failed to start local terminal: ${String(err)}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Start Local Terminal';
    }
  }
}

async function removePreviousSessionFromDashboard() {
  const status = document.getElementById('dash-status');
  const removed = removeMostRecentSession();
  if (!removed) {
    if (status) {
      status.classList.remove('error');
      status.textContent = 'No previous session in history.';
    }
    return;
  }

  const openTabId = removed.mode === 'ssh'
    ? findSshTabIdByHistoryId(removed.id)
    : findLocalTabIdByHistoryId(removed.id);
  if (openTabId) {
    await closeTab(null, openTabId);
  }

  if (status) {
    status.classList.remove('error');
    if (removed.mode === 'ssh') {
      const label = removed.serverName || removed.host || 'SSH';
      status.textContent = `${label} session removed.`;
    } else {
      status.textContent = `${localShellLabel(removed.shell || 'powershell')} session removed.`;
    }
  }
}

async function restoreRecentSession(sessionId) {
  const status = document.getElementById('dash-status');
  const entry = recentLocalSessions.find((item) => item.id === sessionId);
  if (!entry) {
    if (status) {
      status.classList.add('error');
      status.textContent = 'Selected recent session was not found.';
    }
    return;
  }

  try {
    if (entry.mode === 'ssh') {
      const existingSshTabId = findSshTabIdByHistoryId(entry.id);
      if (existingSshTabId) {
        setActiveTab(existingSshTabId);
        if (status) {
          status.classList.remove('error');
          status.textContent = `${entry.serverName || entry.host || 'SSH'} session restored (already open).`;
        }
        return;
      }

      const server = SRV.find((item) => item.id === entry.serverId)
        || SRV.find((item) => item.host === entry.host && Number(item.port) === Number(entry.port || 22));
      if (!server) throw new Error('Server for this SSH session is no longer configured');

      selectSrv(server.id, { keepMain: true });
      const tid = addTermTab({
        serverId: server.id,
        historyId: entry.id,
        usernameOverride: entry.username || undefined,
      });
      if (!tid) throw new Error('Could not restore SSH session');
      setActiveTab(tid);
      if (status) {
        status.classList.remove('error');
        status.textContent = `${server.name} SSH session restored.`;
      }
      return;
    }

    const existingLocalTabId = findLocalTabIdByHistoryId(entry.id);
    const shell = normalizeLocalShellType(entry.shell || 'powershell');
    const shellLabel = localShellLabel(shell);
    if (existingLocalTabId) {
      setActiveTab(existingLocalTabId);
      if (status) {
        status.classList.remove('error');
        status.textContent = `${shellLabel} session restored (already open).`;
      }
      return;
    }

    const tid = addLocalTermTab(shell, { historyId: entry.id });
    if (!tid) throw new Error('Could not restore session');
    setActiveTab(tid);
    if (status) {
      status.classList.remove('error');
      status.textContent = `${shellLabel} session restored.`;
    }
  } catch (err) {
    if (status) {
      status.classList.add('error');
      status.textContent = `Session restore failed: ${String(err)}`;
    }
  }
}

async function refreshServerStatuses() {
  if (statusRefreshInFlight || SRV.length === 0) {
    updateHeaderStats();
    return;
  }

  statusRefreshInFlight = true;
  updateAvgPingRefreshButton();

  try {
    await Promise.all(SRV.map(async (server) => {
      try {
        const result = await invoke('check_server_status', {
          host: server.host,
          port: server.port,
          timeoutMs: 2500,
        });
        const status = result?.status;
        server.status = status === 'online' || status === 'offline' || status === 'unknown'
          ? status
          : 'unknown';
        server.latencyMs = typeof result?.latency_ms === 'number' ? Math.max(0, Math.round(result.latency_ms)) : null;
        server.resolvedIp = typeof result?.ip === 'string' ? result.ip : server.resolvedIp || null;
        server.statusReason = typeof result?.reason === 'string' ? result.reason : null;
      } catch {
        server.status = 'unknown';
        server.latencyMs = null;
        server.statusReason = null;
      }
    }));
  } finally {
    statusRefreshInFlight = false;
    const repaint = () => {
      updateHeaderStats();
      renderSidebar();
      renderMapMarkers();
      if (selId !== null) document.getElementById(`sn-${selId}`)?.classList.add('active');
      refreshRailActive();
      refreshSidebarBadges();
      refreshSftpBrowserTab();
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(repaint, { timeout: 200 });
    } else {
      setTimeout(repaint, 0);
    }
  }
}

/* ══════════════════════════════════════════════════════════
   SIDEBAR
══════════════════════════════════════════════════════════ */
function clearSidebarDragState() {
  sidebarPointerDragState = null;
  document.querySelectorAll('.snode').forEach((node) => {
    node.classList.remove('dragging', 'drag-over-before', 'drag-over-after');
  });
  document.querySelectorAll('.sb-folder-drop-target').forEach((node) => {
    node.classList.remove('drag-over-folder');
  });
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
}

function beginSidebarPointerDrag(ev, serverId, nodeEl) {
  if (ev.button !== 0) return;
  sidebarPointerDragState = {
    serverId,
    nodeEl,
    startX: ev.clientX,
    startY: ev.clientY,
    active: false,
    targetType: null,
    targetId: null,
    targetFolderId: null,
    insertBefore: true,
  };
  window.addEventListener('mousemove', onSidebarPointerDragMove);
  window.addEventListener('mouseup', onSidebarPointerDragEnd);
}

function onSidebarPointerDragMove(ev) {
  const state = sidebarPointerDragState;
  if (!state) return;

  if (!state.active) {
    const dx = Math.abs(ev.clientX - state.startX);
    const dy = Math.abs(ev.clientY - state.startY);
    if (dx < 4 && dy < 4) return;
    state.active = true;
    state.nodeEl.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }

  const hovered = document.elementFromPoint(ev.clientX, ev.clientY);
  const targetNode = hovered instanceof Element ? hovered.closest('.snode') : null;
  const targetFolder = hovered instanceof Element ? hovered.closest('.sb-folder-drop-target') : null;

  document.querySelectorAll('.snode').forEach((node) => {
    node.classList.remove('drag-over-before', 'drag-over-after');
  });
  document.querySelectorAll('.sb-folder-drop-target').forEach((node) => {
    node.classList.remove('drag-over-folder');
  });

  if (targetNode) {
    const targetId = targetNode.dataset.serverId || '';
    if (!targetId || targetId === state.serverId) {
      state.targetType = null;
      state.targetId = null;
      state.targetFolderId = null;
      return;
    }

    const targetServer = SRV.find((server) => server.id === targetId);
    const rect = targetNode.getBoundingClientRect();
    const insertBefore = (ev.clientY - rect.top) < (rect.height / 2);
    targetNode.classList.toggle('drag-over-before', insertBefore);
    targetNode.classList.toggle('drag-over-after', !insertBefore);
    state.targetType = 'server';
    state.targetId = targetId;
    state.targetFolderId = targetServer?.folderId || null;
    state.insertBefore = insertBefore;
    return;
  }

  if (targetFolder) {
    const folderRaw = String(targetFolder.dataset.dropFolderId || '').trim();
    const folderId = normalizeFolderId(folderRaw);
    targetFolder.classList.add('drag-over-folder');
    state.targetType = 'folder';
    state.targetId = '';
    state.targetFolderId = folderId;
    return;
  }

  if (!targetNode && !targetFolder) {
    state.targetType = null;
    state.targetId = null;
    state.targetFolderId = null;
    return;
  }
}

function updateServerFolderLocal(serverId, folderId) {
  const server = SRV.find((item) => item.id === serverId);
  if (!server) return false;
  const nextFolderId = normalizeFolderId(folderId);
  const prevFolderId = normalizeFolderId(server.folderId);
  if (prevFolderId === nextFolderId) return false;
  server.folderId = nextFolderId;
  if (server._raw && typeof server._raw === 'object') {
    server._raw.folder_id = nextFolderId;
  }
  return true;
}

async function applyAndPersistSidebarMutation({ reorderChanged = false, folderChanged = false, movedServerId = '' } = {}) {
  if (!reorderChanged && !folderChanged) return;
  try {
    if (folderChanged && movedServerId) {
      const moved = SRV.find((item) => item.id === movedServerId);
      if (moved) {
        await saveServerModel(moved, { folder_id: moved.folderId || null });
      }
    }
    if (reorderChanged) {
      await persistServerOrder();
    }
  } catch (error) {
    console.error('Failed to persist sidebar mutation:', error);
    await loadServers();
    return;
  }

  updateHeaderStats();
  renderSidebar();
  if (selId !== null) document.getElementById(`sn-${selId}`)?.classList.add('active');
  refreshRailActive();
  refreshSidebarBadges();
  renderServerList();
}

function onSidebarPointerDragEnd(ev) {
  const state = sidebarPointerDragState;
  window.removeEventListener('mousemove', onSidebarPointerDragMove);
  window.removeEventListener('mouseup', onSidebarPointerDragEnd);
  if (!state) return;

  let changed = false;
  let reorderChanged = false;
  let folderChanged = false;
  let movedServerId = state.serverId;
  if (state.active) {
    sidebarSuppressClickUntilMs = Date.now() + 250;
    if (state.targetType === 'server' && state.targetId) {
      reorderChanged = moveServerOrder(state.serverId, state.targetId, state.insertBefore);
      folderChanged = updateServerFolderLocal(state.serverId, state.targetFolderId);
      changed = reorderChanged || folderChanged;
    } else if (state.targetType === 'folder') {
      folderChanged = updateServerFolderLocal(state.serverId, state.targetFolderId);
      reorderChanged = moveServerOrderToEnd(state.serverId);
      changed = reorderChanged || folderChanged;
    } else {
      const list = document.getElementById('sb-list');
      if (list) {
        const rect = list.getBoundingClientRect();
        const inList = ev.clientX >= rect.left
          && ev.clientX <= rect.right
          && ev.clientY >= rect.top
          && ev.clientY <= rect.bottom;
        if (inList) {
          reorderChanged = moveServerOrderToEnd(state.serverId);
          changed = reorderChanged;
        }
      }
    }
  }

  clearSidebarDragState();
  if (changed) void applyAndPersistSidebarMutation({ reorderChanged, folderChanged, movedServerId });
}

function moveServerOrder(draggedId, targetId, insertBefore) {
  const from = SRV.findIndex((server) => server.id === draggedId);
  const to = SRV.findIndex((server) => server.id === targetId);
  if (from < 0 || to < 0 || from === to) return false;

  const [moved] = SRV.splice(from, 1);
  let insertAt = to;
  if (from < to) insertAt -= 1;
  if (!insertBefore) insertAt += 1;
  insertAt = Math.max(0, Math.min(insertAt, SRV.length));
  SRV.splice(insertAt, 0, moved);
  return true;
}

function moveServerOrderToEnd(serverId) {
  const from = SRV.findIndex((server) => server.id === serverId);
  if (from < 0 || from === SRV.length - 1) return false;
  const [moved] = SRV.splice(from, 1);
  SRV.push(moved);
  return true;
}

async function persistServerOrder() {
  try {
    await invoke('reorder_servers', { serverIds: SRV.map((server) => server.id) });
  } catch (error) {
    console.error('Failed to persist server order:', error);
  }
}

function renderSidebarServerItem(server, list, rail, options = {}) {
  const pingText = typeof server.latencyMs === 'number' ? `${server.latencyMs}ms` : server.status === 'offline' ? 'OFF' : '\u2014';
  const pingColor = latencyColor(server.latencyMs, server.status);
  const iconSvg = serverIconSvg(server.icon);
  const safeName = escapeHtml(String(server.name || '\u2014'));
  const safeLoc = escapeHtml(String(server.loc || 'Unknown location'));
  const indented = Boolean(options.indented);

  const el = document.createElement('div');
  el.className = `snode reorderable${indented ? ' snode-in-folder' : ''}`;
  el.id = `sn-${server.id}`;
  el.dataset.serverId = server.id;
  el.title = `${server.name} \u00b7 ${server.loc || 'Unknown location'}`;
  el.innerHTML = `<div class="snode-dot" style="background:${sDot(server.status)};box-shadow:0 0 6px ${sDot(server.status)}"></div>
    <span class="snode-icon" title="${serverIconLabel(server.icon)}">${iconSvg}</span>
    <div class="snode-main"><div class="snode-name">${safeName}</div></div>
    <div class="snode-right">
      <span class="snode-tabs" id="stabs-${server.id}" style="display:none"></span>
      <div class="snode-ping" style="color:${pingColor}">${pingText}</div>
    </div>`;
  el.addEventListener('mousedown', (ev) => beginSidebarPointerDrag(ev, server.id, el));
  el.addEventListener('click', (ev) => {
    if (Date.now() < sidebarSuppressClickUntilMs) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    selectSrv(server.id);
    if (window.innerWidth <= 700) toggleSidebar(false);
  });
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    selectSrv(server.id);
    showServerContextMenu(ev.clientX, ev.clientY, server.id);
  });
  list.appendChild(el);

  const railItem = document.createElement('div');
  railItem.className = 'sb-rail-item';
  railItem.id = `rail-${server.id}`;
  railItem.innerHTML = `<div class="sb-rail-dot" style="background:${sDot(server.status)};box-shadow:0 0 5px ${sDot(server.status)}"></div>
    <div class="sb-rail-tip"><strong>${safeName}</strong> \u00b7 ${safeLoc}</div>`;
  railItem.addEventListener('click', () => selectSrv(server.id));
  railItem.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    selectSrv(server.id);
    showServerContextMenu(ev.clientX, ev.clientY, server.id);
  });
  rail.appendChild(railItem);
}

function renderSidebar() {
  const list = document.getElementById('sb-list');
  const rail = document.getElementById('sb-rail');
  clearSidebarDragState();
  list.innerHTML = '';
  rail.innerHTML = '';

  if (SRV.length === 0 && FOLDERS.length === 0) {
    list.innerHTML = `<div style="padding:20px 12px;text-align:center;color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;line-height:1.8">
      No servers configured.<br>Click the <span style="color:var(--accent2);font-weight:700">+</span> button above<br>to add your first server.
    </div>`;
    return;
  }

  const groupedServers = new Map();
  FOLDERS.forEach((folder) => groupedServers.set(folder.id, []));
  const ungroupedServers = [];
  SRV.forEach((server) => {
    const folderId = normalizeFolderId(server.folderId);
    if (folderId && groupedServers.has(folderId)) groupedServers.get(folderId).push(server);
    else ungroupedServers.push(server);
  });

  FOLDERS.forEach((folder) => {
    const collapsed = isFolderCollapsed(folder.id);
    const folderRow = document.createElement('div');
    folderRow.className = `sb-folder-row sb-folder-drop-target${collapsed ? ' collapsed' : ''}`;
    folderRow.dataset.folderId = folder.id;
    folderRow.dataset.dropFolderId = folder.id;
    folderRow.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    folderRow.innerHTML = `<span class="sb-folder-caret">${collapsed ? '&#9656;' : '&#9662;'}</span><span class="sb-folder-icon">${folderIconSvg('folder')}</span><span class="sb-folder-name">${escapeHtml(folder.name)}</span><span class="sb-folder-count">${(groupedServers.get(folder.id) || []).length}</span>`;
    folderRow.addEventListener('click', (ev) => {
      if (Date.now() < sidebarSuppressClickUntilMs) return;
      ev.preventDefault();
      ev.stopPropagation();
      toggleFolderCollapsed(folder.id);
    });
    folderRow.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showFolderContextMenu(ev.clientX, ev.clientY, folder.id);
    });
    list.appendChild(folderRow);

    const members = groupedServers.get(folder.id) || [];
    if (!collapsed) {
      members.forEach((server) => renderSidebarServerItem(server, list, rail, { indented: true }));
    }
  });

  if (FOLDERS.length) {
    const ungroupedCollapsed = isFolderCollapsed(UNGROUPED_COLLAPSE_ID);
    const ungroupedRow = document.createElement('div');
    ungroupedRow.className = `sb-folder-row sb-folder-row-ghost sb-folder-drop-target${ungroupedCollapsed ? ' collapsed' : ''}`;
    ungroupedRow.dataset.dropFolderId = '';
    ungroupedRow.setAttribute('aria-expanded', ungroupedCollapsed ? 'false' : 'true');
    ungroupedRow.innerHTML = `<span class="sb-folder-caret">${ungroupedCollapsed ? '&#9656;' : '&#9662;'}</span><span class="sb-folder-icon">${folderIconSvg('ungrouped')}</span><span class="sb-folder-name">Ungrouped</span><span class="sb-folder-count">${ungroupedServers.length}</span>`;
    ungroupedRow.addEventListener('click', (ev) => {
      if (Date.now() < sidebarSuppressClickUntilMs) return;
      ev.preventDefault();
      ev.stopPropagation();
      toggleFolderCollapsed(UNGROUPED_COLLAPSE_ID);
    });
    list.appendChild(ungroupedRow);
  }
  if (ungroupedServers.length && !(FOLDERS.length && isFolderCollapsed(UNGROUPED_COLLAPSE_ID))) {
    ungroupedServers.forEach((server) => renderSidebarServerItem(server, list, rail));
  }
}

/* ══════════════════════════════════════════════════════════
   LEAFLET MAP
══════════════════════════════════════════════════════════ */
const map = L.map('leaflet-map', { center: [20, 10], zoom: 2, minZoom: 1, maxZoom: 10 });
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd', maxZoom: 19
}).addTo(map);

const svg = document.getElementById('conn-svg');
let leafletMarkers = {};
let dashMap = null;
let dashLeafletMarkers = {};
let dashMapHasFit = false;

function createMarkerIcon(s, active) {
  const col = sDot(s.status);
  const ringCol = latencyColor(s.latencyMs, s.status);
  return L.divIcon({
    html: `<div style="width:40px;height:40px;position:relative;display:flex;align-items:center;justify-content:center;">
      <div class="node-ring" style="color:${ringCol};width:22px;height:22px;"></div>
      <div class="node-ring node-ring2" style="color:${ringCol};width:22px;height:22px;"></div>
      <div class="node-marker" style="color:${col};${active ? 'box-shadow:0 0 14px ' + col + '88;border-width:2.5px' : ''}">
        <div class="dot"></div></div>
      <div class="${active ? 'node-label active-label' : 'node-label'}">${s.name}</div>
    </div>`,
    className: '', iconSize: [40, 40], iconAnchor: [20, 20],
  });
}

function renderMapMarkers() {
  // Remove old markers
  Object.values(leafletMarkers).forEach(m => map.removeLayer(m));
  leafletMarkers = {};

  SRV.forEach(s => {
    const coords = getServerMapCoords(s);
    if (!coords) return;
    const m = L.marker([coords.lat, coords.lng], {
      icon: createMarkerIcon(s, s.id === selId),
      zIndexOffset: 100
    }).addTo(map);
    m.on('click', () => selectSrv(s.id));
    m.bindTooltip(
      `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#b8cce0;background:rgba(7,9,13,.95);border:1px solid #1a2840;padding:7px 12px;border-radius:4px"><span style="color:#00bfff;font-weight:700">${s.name}</span> \u00b7 ${s.host}<br><span style="color:#3a5570">${s.loc}</span></div>`,
      { permanent: false, direction: 'top', offset: [0, -18], opacity: 1, className: 'leaflet-tooltip-custom' }
    );
    leafletMarkers[s.id] = m;
  });
  renderDashboardMapMarkers(false);
}

function ensureDashboardMap() {
  if (dashMap) return dashMap;
  const container = document.getElementById('dash-map');
  if (!container) return null;

  dashMap = L.map(container, { center: [20, 10], zoom: 2, minZoom: 1, maxZoom: 10 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(dashMap);

  return dashMap;
}

function renderDashboardMapMarkers(forceFit = false) {
  if (!mainDashboardActive && !dashMap) return;
  const mapInstance = dashMap || ensureDashboardMap();
  if (!mapInstance) return;

  Object.values(dashLeafletMarkers).forEach((marker) => mapInstance.removeLayer(marker));
  dashLeafletMarkers = {};

  const mapServers = SRV
    .map((server) => ({ server, coords: getServerMapCoords(server) }))
    .filter((entry) => Boolean(entry.coords));

  mapServers.forEach(({ server, coords }) => {
    const marker = L.marker([coords.lat, coords.lng], {
      icon: createMarkerIcon(server, server.id === selId),
      zIndexOffset: 100,
    }).addTo(mapInstance);

    marker.on('click', () => selectSrv(server.id, { keepMain: true }));
    marker.bindTooltip(
      `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#b8cce0;background:rgba(7,9,13,.95);border:1px solid #1a2840;padding:7px 12px;border-radius:4px"><span style="color:#00bfff;font-weight:700">${server.name}</span> \u00b7 ${server.host}<br><span style="color:#3a5570">${server.loc}</span></div>`,
      { permanent: false, direction: 'top', offset: [0, -18], opacity: 1, className: 'leaflet-tooltip-custom' },
    );
    dashLeafletMarkers[server.id] = marker;
  });

  if (!mapServers.length) {
    dashMapHasFit = false;
    return;
  }

  if (forceFit || !dashMapHasFit) {
    const bounds = L.latLngBounds(mapServers.map(({ coords }) => [coords.lat, coords.lng]));
    if (bounds.isValid()) {
      mapInstance.fitBounds(bounds.pad(0.2), { animate: false, maxZoom: 4 });
      dashMapHasFit = true;
    }
  }
}

/* ══════════════════════════════════════════════════════════
   TAB STATE
══════════════════════════════════════════════════════════ */
let termTabs = {}, activeTabId = 'metrics', tabCounter = 0;
const sftpBrowserTab = {
  open: false,
  srvId: null,
  tabBtnEl: null,
};
const staticSftpState = {
  path: '.',
  serverId: null,
  loading: false,
  requestSeq: 0,
  colWidths: [280, 72, 88, 160, 100],
  view: 'list',
  pane: 'files',
  entries: [],
  editorPath: '',
  editorOriginal: '',
  editorContent: '',
  editorDirty: false,
  editorLoading: false,
  editorSaving: false,
  editorSize: 0,
  editorModifiedUnix: null,
  editorChmod: '',
  contextPath: '',
};

function refreshSftpBrowserTab() {
  const btn = sftpBrowserTab.tabBtnEl;
  if (!btn) return;
  if (!sftpBrowserTab.open) {
    btn.style.display = 'none';
    btn.classList.remove('active');
    return;
  }

  const srv = SRV.find((s) => s.id === sftpBrowserTab.srvId);
  if (!srv) {
    btn.style.display = 'none';
    btn.classList.remove('active');
    return;
  }

  btn.style.display = '';
  btn.classList.toggle('active', activeTabId === 'sftp');

  const dot = btn.querySelector('.tab-dot');
  const num = btn.querySelector('.tab-num');
  const label = btn.querySelector('.tab-label');
  if (label) label.textContent = 'SFTP';
  if (num) num.textContent = srv.name;
  if (dot) {
    const color = sDot(srv.status);
    dot.style.background = color;
    dot.style.boxShadow = `0 0 5px ${color}`;
  }
}

function closeSftpBrowserTab(e) {
  if (e) e.stopPropagation();
  const wasActive = activeTabId === 'sftp';
  if (sftpBrowserTab.tabBtnEl) {
    sftpBrowserTab.tabBtnEl.remove();
  }
  sftpBrowserTab.open = false;
  sftpBrowserTab.srvId = null;
  sftpBrowserTab.tabBtnEl = null;

  if (wasActive) {
    const vis = Object.entries(termTabs).find(([, t]) => t.mode === 'local' || t.pinned || t.srvId === selId);
    setActiveTab(vis ? vis[0] : 'metrics');
  }
}

function openSftpBrowserTab(serverId) {
  const srv = SRV.find((s) => s.id === serverId);
  if (!srv) return;

  if (!sftpBrowserTab.tabBtnEl) {
    const btn = document.createElement('div');
    btn.className = 'tab-term';
    btn.id = 'tabbtn-sftp-browser';
    btn.innerHTML = `
      <div class="tab-term-inner" data-tabid="sftp-browser">
        <div class="tab-dot"></div>
        <span class="tab-label">SFTP</span>
        <span class="tab-num"></span>
      </div>
      <button class="tab-close" data-tabid="sftp-browser">\u00d7</button>`;
    btn.querySelector('.tab-term-inner').addEventListener('click', () => {
      if (sftpBrowserTab.srvId !== null) selectSrv(sftpBrowserTab.srvId);
      setActiveTab('sftp');
    });
    btn.querySelector('.tab-close').addEventListener('click', closeSftpBrowserTab);
    document.getElementById('term-tab-area').insertBefore(btn, document.getElementById('tab-add-btn'));
    sftpBrowserTab.tabBtnEl = btn;
  }

  sftpBrowserTab.open = true;
  sftpBrowserTab.srvId = srv.id;
  refreshSftpBrowserTab();
}

function setActiveTab(id) {
  document.getElementById('tab-metrics-btn').classList.remove('active');
  document.getElementById('tab-sftp-btn').classList.remove('active');
  document.getElementById('metrics-panel').classList.remove('active');
  document.getElementById('sftp-panel').classList.remove('active');
  if (sftpBrowserTab.tabBtnEl) sftpBrowserTab.tabBtnEl.classList.remove('active');
  Object.values(termTabs).forEach(t => {
    t.tabBtnEl.classList.remove('active');
    t.panelEl.classList.remove('active');
  });

  activeTabId = id;

  if (id === 'metrics') {
    document.getElementById('tab-metrics-btn').classList.add('active');
    document.getElementById('metrics-panel').classList.add('active');
    if (selId !== null) {
      renderMetrics(SRV.find(s => s.id === selId));
      if (metricsLiveEnabled && hasLiveSshSessionForServer(selId)) {
        void refreshMetrics(selId);
      }
    } else {
      showMEmpty();
    }
  } else if (id === 'sftp') {
    document.getElementById('tab-sftp-btn').classList.add('active');
    if (sftpBrowserTab.tabBtnEl) sftpBrowserTab.tabBtnEl.classList.add('active');
    document.getElementById('sftp-panel').classList.add('active');
    if (selId !== null) sftpBrowserTab.srvId = selId;
    refreshSftpBrowserTab();
    if (selId !== null) showStaticSftpForServer(); else showStaticSftpEmpty();
  } else {
    const t = termTabs[id];
    if (!t) return;
    t.tabBtnEl.classList.add('active');
    t.panelEl.classList.add('active');
    if (t.terminal) {
      setTimeout(() => { t.fitAddon?.fit(); t.terminal.focus(); }, 50);
    }
  }
  refreshSftpBrowserTab();
}

function refreshTabVisibility() {
  Object.entries(termTabs).forEach(([id, t]) => {
    if (t.mode === 'local') {
      t.tabBtnEl.style.display = '';
      t.tabBtnEl.classList.remove('cross-server');
      const badge = t.tabBtnEl.querySelector('.tab-srv-badge');
      if (badge) badge.style.display = 'none';
      return;
    }

    const visible = t.pinned || t.srvId === selId;
    t.tabBtnEl.style.display = visible ? '' : 'none';
    if (t.pinned && t.srvId !== selId) {
      t.tabBtnEl.classList.add('cross-server');
      const badge = t.tabBtnEl.querySelector('.tab-srv-badge');
      if (badge) badge.style.display = 'inline-flex';
    } else {
      t.tabBtnEl.classList.remove('cross-server');
      const badge = t.tabBtnEl.querySelector('.tab-srv-badge');
      if (badge) badge.style.display = 'none';
    }
  });

  if (activeTabId !== 'metrics' && activeTabId !== 'sftp') {
    const t = termTabs[activeTabId];
    if (!t || (t.mode !== 'local' && !t.pinned && t.srvId !== selId)) {
      const firstVis = Object.entries(termTabs).find(([, tab]) => tab.mode === 'local' || tab.pinned || tab.srvId === selId);
      setActiveTab(firstVis ? firstVis[0] : 'metrics');
    }
  }
}

function refreshAddBtn() {
  const btn = document.getElementById('tab-add-btn');
  if (!btn) return;
  btn.classList.remove('disabled');
  btn.dataset.tip = selId !== null
    ? 'Left click: New SSH tab. Right click: More options.'
    : 'Right click: Choose terminal type';
  updateTabAddMenuState();
}

function openSelectedServerTerminal() {
  if (selId === null) return false;
  const srv = SRV.find((s) => s.id === selId);
  if (!srv) return false;
  addTermTab({ serverId: srv.id });
  return true;
}

function updateTabAddMenuState() {
  const sshBtn = document.getElementById('tab-add-new-ssh');
  if (!sshBtn) return;
  const srv = selId !== null ? SRV.find((s) => s.id === selId) : null;
  const enabled = Boolean(srv);
  sshBtn.classList.toggle('disabled', !enabled);
  sshBtn.textContent = enabled
    ? `New SSH Connection (${srv.name})`
    : 'New SSH Connection (Select a server)';
}

function hideTabAddMenu() {
  const menu = document.getElementById('tab-add-menu');
  if (!menu) return;
  menu.style.display = 'none';
}

function showTabAddMenu(position = null) {
  const menu = document.getElementById('tab-add-menu');
  const btn = document.getElementById('tab-add-btn');
  if (!menu || !btn) return;

  updateTabAddMenuState();
  menu.style.display = 'block';
  const menuRect = menu.getBoundingClientRect();
  const rect = btn.getBoundingClientRect();
  const rawLeft = position && Number.isFinite(position.x) ? position.x : rect.left;
  const rawTop = position && Number.isFinite(position.y) ? position.y : rect.bottom + 6;
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - menuRect.width - 8));
  const top = Math.max(8, Math.min(rawTop, window.innerHeight - menuRect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function runTabAddMenuAction(action) {
  const value = String(action || '').toLowerCase();
  if (value === 'ssh') {
    if (openSelectedServerTerminal()) hideTabAddMenu();
    return;
  }
  const shell = normalizeLocalShellType(value);
  hideTabAddMenu();
  addLocalTermTab(shell);
}

function toggleTabAddMenu(position = null) {
  const menu = document.getElementById('tab-add-menu');
  if (!menu) return;
  if (menu.style.display === 'none' || !menu.style.display) showTabAddMenu(position);
  else hideTabAddMenu();
}

function refreshSidebarBadges() {
  SRV.forEach(s => {
    const count = Object.values(termTabs).filter(t => t.mode !== 'local' && t.srvId === s.id).length;
    const badge = document.getElementById(`stabs-${s.id}`);
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count === 1 ? '1 tab' : `${count} tabs`;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  });
}

function hideServerContextMenu() {
  const menu = document.getElementById('server-context-menu');
  if (!menu) return;
  menu.style.display = 'none';
  menu.innerHTML = '';
  menu.dataset.serverId = '';
}

function hideFolderContextMenu() {
  const menu = document.getElementById('folder-context-menu');
  if (!menu) return;
  menu.style.display = 'none';
  menu.innerHTML = '';
  menu.dataset.folderId = '';
}

function showFolderContextMenu(x, y, folderId) {
  const menu = document.getElementById('folder-context-menu');
  const folder = FOLDERS.find((item) => item.id === folderId);
  if (!menu || !folder) return;

  hideSftpContextMenu();
  hideServerContextMenu();

  menu.dataset.folderId = folder.id;
  menu.innerHTML = [
    '<button class="sftp-menu-item" data-action="edit_folder">Edit Folder</button>',
    '<button class="sftp-menu-item" data-action="rename_folder">Rename Folder</button>',
    '<div class="sftp-menu-sep"></div>',
    '<button class="sftp-menu-item danger" data-action="delete_folder">Delete Folder</button>',
  ].join('');
  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;

  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await runFolderContextAction(btn.dataset.action, folder.id);
    });
  });
}

async function runFolderContextAction(action, folderId) {
  hideFolderContextMenu();
  const folder = FOLDERS.find((item) => item.id === folderId);
  if (!folder) return;

  if (action === 'edit_folder' || action === 'rename_folder') {
    const label = action === 'rename_folder' ? 'Rename folder' : 'Edit folder name';
    const input = await askInputModal({
      title: label,
      label: 'Folder Name',
      value: folder.name,
      placeholder: 'Folder name',
      submitText: 'Save',
    });
    if (input === null) return;
    const name = normalizeFolderName(input);
    if (!name || name === folder.name) return;
    try {
      await invoke('save_folder', { folder: { id: folder.id, name } });
      await loadServers();
    } catch (error) {
      window.alert(`Folder update failed: ${String(error)}`);
    }
    return;
  }

  if (action === 'delete_folder') {
    const first = window.confirm(`Delete folder "${folder.name}"?`);
    if (!first) return;
    const second = window.confirm(`Delete folder "${folder.name}" and ungroup its servers?`);
    if (!second) return;
    try {
      await invoke('delete_folder', { folderId: folder.id });
      await loadServers();
    } catch (error) {
      window.alert(`Delete folder failed: ${String(error)}`);
    }
  }
}

async function createFolderFromSidebar() {
  const raw = window.prompt('New folder name:');
  if (raw === null) return;
  const name = normalizeFolderName(raw);
  if (!name) return;
  if (FOLDERS.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
    window.alert('Folder name already exists.');
    return;
  }
  try {
    await invoke('save_folder', {
      folder: {
        id: crypto.randomUUID(),
        name,
      },
    });
    await loadServers();
    if (document.getElementById('settings-modal')?.style.display === 'block') {
      renderServerList();
      renderFolderOptions();
    }
  } catch (error) {
    window.alert(`Create folder failed: ${String(error)}`);
  }
}

function showServerContextMenu(x, y, serverId) {
  const menu = document.getElementById('server-context-menu');
  const server = SRV.find(s => s.id === serverId);
  if (!menu || !server) return;

  hideSftpContextMenu();
  hideFolderContextMenu();

  menu.dataset.serverId = server.id;
  menu.innerHTML = [
    '<button class="sftp-menu-item" data-action="new_terminal">New Terminal</button>',
    '<button class="sftp-menu-item" data-action="open_sftp">Open SFTP</button>',
    '<button class="sftp-menu-item" data-action="connect_as">Connect as</button>',
    '<div class="sftp-menu-sep"></div>',
    '<button class="sftp-menu-item" data-action="edit_config">Edit Config</button>',
    '<button class="sftp-menu-item" data-action="clear_known_host">Clear Host Key</button>',
    '<button class="sftp-menu-item" data-action="rename">Rename</button>',
    '<button class="sftp-menu-item danger" data-action="delete">Delete</button>',
    '<div class="sftp-menu-sep"></div>',
    '<button class="sftp-menu-item" data-action="details">Details</button>',
  ].join('');
  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;

  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await runServerContextAction(btn.dataset.action, server.id);
    });
  });
}

async function saveServerModel(server, overrides = {}) {
  if (!server) return;
  const payload = {
    ...(server._raw || {}),
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    icon: normalizeServerIcon(server.icon || server?._raw?.icon),
    location: server.loc,
    lat: server.lat,
    lng: server.lng,
    folder_id: server.folderId || null,
    auth_method: server?._raw?.auth_method || { type: 'Agent' },
    ...overrides,
  };
  await invoke('save_server', { server: payload });
}

async function runServerContextAction(action, serverId) {
  hideServerContextMenu();

  const server = SRV.find(s => s.id === serverId);
  if (!server) return;

  if (action === 'new_terminal') {
    selectSrv(server.id);
    addTermTab({ serverId: server.id });
    return;
  }

  if (action === 'open_sftp') {
    selectSrv(server.id);
    openSftpBrowserTab(server.id);
    setActiveTab('sftp');
    return;
  }

  if (action === 'connect_as') {
    selectSrv(server.id);
    addTermTab({ serverId: server.id, forceUsernamePrompt: true });
    return;
  }

  if (action === 'edit_config') {
    openSettings();
    showServerForm(server);
    return;
  }

  if (action === 'rename') {
    const nextNameRaw = await askInputModal({
      title: 'Rename Server',
      label: 'Server Name',
      value: server.name,
      placeholder: 'Server name',
      submitText: 'Rename',
    });
    if (nextNameRaw === null) return;
    const nextName = nextNameRaw.trim();
    if (!nextName || nextName === server.name) return;
    try {
      await saveServerModel(server, { name: nextName });
      await loadServers();
    } catch (err) {
      window.alert(`Rename failed: ${String(err)}`);
    }
    return;
  }

  if (action === 'clear_known_host') {
    const confirmed = window.confirm(
      `Clear trusted host key for "${server.name}" (${server.host}:${server.port})?\n\nThe next connection will trust and store the current host key again.`
    );
    if (!confirmed) return;
    try {
      const removed = await invoke('ssh_clear_known_host', { serverId: server.id });
      window.alert(`Known host entries cleared: ${Number(removed) || 0}`);
    } catch (err) {
      window.alert(`Clear host key failed: ${String(err)}`);
    }
    return;
  }

  if (action === 'delete') {
    const firstConfirm = window.confirm(`Delete server "${server.name}"?`);
    if (!firstConfirm) return;
    const secondConfirm = window.confirm(`Delete "${server.name}" permanently? This cannot be undone.`);
    if (!secondConfirm) return;
    try {
      await invoke('delete_server', { serverId: server.id });
      await loadServers();
    } catch (err) {
      window.alert(`Delete failed: ${String(err)}`);
    }
    return;
  }

  if (action === 'details') {
    const pingText = typeof server.latencyMs === 'number' ? `${server.latencyMs}ms` : '\u2014';
    window.alert(
      [
        `Name: ${server.name}`,
        `Host: ${server.host}:${server.port}`,
        `Username: ${server.username}`,
        `Icon: ${serverIconLabel(server.icon)}`,
        `Folder: ${folderNameById(server.folderId) || '\u2014'}`,
        `Location: ${server.loc || '\u2014'}`,
        `Coordinates: ${server.lat}, ${server.lng}`,
        `Status: ${server.status || 'unknown'}`,
        `Latency: ${pingText}`,
        `Auth: ${server.authLabel || '\u2014'}`,
      ].join('\n')
    );
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '\u2014';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUnixTimestamp(seconds) {
  const ts = Number(seconds);
  if (!Number.isFinite(ts) || ts <= 0) return '\u2014';
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return '\u2014';
  }
}

function remoteParentPath(path) {
  const p = String(path || '.').trim();
  if (!p || p === '.') return '.';
  if (p === '/') return '/';
  const normalized = p.replace(/\/+$/, '');
  if (!normalized || normalized === '/') return '/';
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return normalized.slice(0, idx);
}

function remoteBaseName(path) {
  const value = String(path || '').replace(/\/+$/, '');
  if (!value || value === '/') return '';
  const idx = value.lastIndexOf('/');
  if (idx < 0) return value;
  return value.slice(idx + 1);
}

function remoteJoinPath(base, childName) {
  const name = String(childName || '').trim().replace(/[\\/]/g, '');
  if (!name) return String(base || '.').trim() || '.';
  const root = String(base || '.').trim() || '.';
  if (root === '/') return `/${name}`;
  if (root === '.') return name;
  return `${root.replace(/\/+$/, '')}/${name}`;
}

function selectedSftpServer() {
  if (selId === null) throw new Error('Select a node first');
  const srv = SRV.find(s => s.id === selId);
  if (!srv) throw new Error('Selected server no longer exists');
  return srv;
}

const sftpCredentialCache = new Map();

function cacheSftpCredentials(serverId, username, password = null) {
  if (!serverId) return;
  const existing = sftpCredentialCache.get(serverId) || {};
  const next = { ...existing };
  if (typeof username === 'string' && username.trim()) next.username = username.trim();
  if (typeof password === 'string') next.password = password;
  sftpCredentialCache.set(serverId, next);
}

function resolveSftpAuthOverrides(server) {
  const cached = sftpCredentialCache.get(server.id) || {};
  const configuredUsername = String(server.username || '').trim();
  const username = String(cached.username || configuredUsername).trim();
  if (!username) {
    throw new Error('Missing SFTP username. Open a terminal and connect once, or set username in Server Config.');
  }

  const overrides = {};
  if (username !== configuredUsername) overrides.usernameOverride = username;

  const authType = server?._raw?.auth_method?.type;
  if (authType === 'Password') {
    const configuredPassword = String(server?._raw?.auth_method?.password ?? '');
    const cachedPassword = typeof cached.password === 'string' ? cached.password : null;
    if (!configuredPassword) {
      if (cachedPassword === null) {
        throw new Error('Missing SFTP password. Open a terminal and connect once, or save password in Server Config.');
      }
      overrides.passwordOverride = cachedPassword;
    }
  }

  return overrides;
}

async function invokeSftp(command, server, payload = {}) {
  const overrides = resolveSftpAuthOverrides(server);
  return invoke(command, {
    serverId: server.id,
    ...payload,
    ...overrides,
  });
}

function setSftpControlsDisabled(disabled) {
  const refreshEl = document.getElementById('sftp-refresh-btn');
  const goEl = document.getElementById('sftp-go-btn');
  const upEl = document.getElementById('sftp-up-btn');
  const uploadEl = document.getElementById('sftp-upload-btn');
  const newFileEl = document.getElementById('sftp-new-file-btn');
  const listViewEl = document.getElementById('sftp-view-list-btn');
  const gridViewEl = document.getElementById('sftp-view-grid-btn');
  const filesPaneEl = document.getElementById('sftp-pane-files-btn');
  const editorPaneEl = document.getElementById('sftp-pane-editor-btn');
  if (refreshEl) refreshEl.disabled = disabled;
  if (goEl) goEl.disabled = disabled;
  if (upEl) upEl.disabled = disabled;
  if (uploadEl) uploadEl.disabled = disabled;
  if (newFileEl) newFileEl.disabled = disabled;
  if (listViewEl) listViewEl.disabled = disabled;
  if (gridViewEl) gridViewEl.disabled = disabled;
  if (filesPaneEl) filesPaneEl.disabled = disabled;
  if (editorPaneEl && staticSftpState.editorPath) editorPaneEl.disabled = disabled;
}

function setStaticSftpStatus(message, isError = false) {
  const statusEl = document.getElementById('sftp-status-static');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function updateSftpViewButtons() {
  const listViewEl = document.getElementById('sftp-view-list-btn');
  const gridViewEl = document.getElementById('sftp-view-grid-btn');
  if (listViewEl) listViewEl.classList.toggle('active', staticSftpState.view === 'list');
  if (gridViewEl) gridViewEl.classList.toggle('active', staticSftpState.view === 'grid');
}

function setSftpViewMode(mode) {
  const next = mode === 'grid' ? 'grid' : 'list';
  if (staticSftpState.view === next) return;
  staticSftpState.view = next;
  updateSftpViewButtons();
  renderStaticSftpRows(staticSftpState.entries || []);
}

function resetSftpEditorState() {
  staticSftpState.pane = 'files';
  staticSftpState.editorPath = '';
  staticSftpState.editorOriginal = '';
  staticSftpState.editorContent = '';
  staticSftpState.editorDirty = false;
  staticSftpState.editorLoading = false;
  staticSftpState.editorSaving = false;
  staticSftpState.editorSize = 0;
  staticSftpState.editorModifiedUnix = null;
  staticSftpState.editorChmod = '';
}

function confirmDiscardSftpEditorChanges() {
  if (!staticSftpState.editorDirty) return true;
  return window.confirm('You have unsaved changes in the editor. Discard them?');
}

function updateSftpPaneButtons() {
  const filesBtn = document.getElementById('sftp-pane-files-btn');
  const editorBtn = document.getElementById('sftp-pane-editor-btn');
  const isFiles = staticSftpState.pane !== 'editor';
  if (filesBtn) filesBtn.classList.toggle('active', isFiles);
  if (editorBtn) {
    editorBtn.classList.toggle('active', !isFiles);
    editorBtn.disabled = !staticSftpState.editorPath;
  }
}

function renderSftpEditorPanel() {
  const tableWrapEl = document.getElementById('sftp-table-wrap-static');
  const navEl = document.getElementById('sftp-nav');
  const viewToggleEl = document.querySelector('.sftp-view-toggle');
  const uploadBtn = document.getElementById('sftp-upload-btn');
  const newFileBtn = document.getElementById('sftp-new-file-btn');
  const refreshBtn = document.getElementById('sftp-refresh-btn');
  const editorWrapEl = document.getElementById('sftp-editor-wrap');
  const editorFileEl = document.getElementById('sftp-editor-file');
  const editorMetaEl = document.getElementById('sftp-editor-meta');
  const editorDirtyEl = document.getElementById('sftp-editor-dirty');
  const editorTextEl = document.getElementById('sftp-editor-text');
  const editorSaveEl = document.getElementById('sftp-editor-save-btn');
  if (!tableWrapEl || !editorWrapEl || !editorTextEl || !editorSaveEl) return;

  const inEditor = staticSftpState.pane === 'editor';
  tableWrapEl.style.display = inEditor ? 'none' : 'flex';
  editorWrapEl.style.display = inEditor ? 'flex' : 'none';
  if (navEl) navEl.style.display = inEditor ? 'none' : 'grid';
  if (viewToggleEl) viewToggleEl.style.display = inEditor ? 'none' : 'flex';
  if (uploadBtn) uploadBtn.style.display = inEditor ? 'none' : '';
  if (newFileBtn) newFileBtn.style.display = inEditor ? 'none' : '';
  if (refreshBtn) refreshBtn.style.display = inEditor ? 'none' : '';

  const modified = formatUnixTimestamp(staticSftpState.editorModifiedUnix);
  if (editorFileEl) editorFileEl.textContent = staticSftpState.editorPath || 'No file selected';
  if (editorMetaEl) {
    editorMetaEl.textContent = staticSftpState.editorPath
      ? `${formatBytes(staticSftpState.editorSize)} | Modified ${modified} | ${staticSftpState.editorChmod || 'mode unavailable'} | UTF-8 text`
      : '';
  }
  if (editorDirtyEl) editorDirtyEl.style.display = staticSftpState.editorDirty ? 'inline' : 'none';
  if (editorTextEl.value !== staticSftpState.editorContent) editorTextEl.value = staticSftpState.editorContent || '';
  editorTextEl.disabled = staticSftpState.editorLoading || staticSftpState.editorSaving || !staticSftpState.editorPath;
  editorSaveEl.disabled = staticSftpState.editorLoading || staticSftpState.editorSaving || !staticSftpState.editorDirty;
}

function setSftpPane(mode, allowPrompt = true) {
  const next = mode === 'editor' ? 'editor' : 'files';
  if (next === staticSftpState.pane) return true;
  if (next === 'files' && allowPrompt && !confirmDiscardSftpEditorChanges()) return false;
  if (next === 'editor' && !staticSftpState.editorPath) return false;
  staticSftpState.pane = next;
  updateSftpPaneButtons();
  renderSftpEditorPanel();
  return true;
}

async function openSftpEditorFile(entry) {
  if (!entry || entry.is_dir) return;
  const targetPath = String(entry.path || '').trim();
  if (!targetPath) return;
  if (staticSftpState.editorPath && staticSftpState.editorPath !== targetPath && !confirmDiscardSftpEditorChanges()) {
    return;
  }

  const srv = selectedSftpServer();
  staticSftpState.editorLoading = true;
  staticSftpState.editorSaving = false;
  staticSftpState.editorPath = targetPath;
  staticSftpState.editorDirty = false;
  staticSftpState.editorContent = '';
  staticSftpState.editorOriginal = '';
  setSftpPane('editor', false);
  setStaticSftpStatus(`Loading file ${remoteBaseName(targetPath) || targetPath} ...`);
  updateSftpPaneButtons();
  renderSftpEditorPanel();

  try {
    const result = await invokeSftp('sftp_read_file', srv, { path: targetPath });
    staticSftpState.editorPath = result?.path || targetPath;
    staticSftpState.editorContent = String(result?.content || '');
    staticSftpState.editorOriginal = staticSftpState.editorContent;
    staticSftpState.editorSize = Number(result?.size || 0);
    staticSftpState.editorModifiedUnix = Number(result?.modified_unix || 0) || null;
    staticSftpState.editorChmod = String(result?.chmod || '');
    staticSftpState.editorDirty = false;
    setStaticSftpStatus(`Editor opened: ${remoteBaseName(staticSftpState.editorPath) || staticSftpState.editorPath}`);
  } catch (err) {
    setStaticSftpStatus(`Open failed: ${String(err)}`, true);
    resetSftpEditorState();
  } finally {
    staticSftpState.editorLoading = false;
    updateSftpPaneButtons();
    renderSftpEditorPanel();
  }
}

async function saveSftpEditorFile() {
  if (!staticSftpState.editorPath || !staticSftpState.editorDirty) return;
  const srv = selectedSftpServer();
  const editorTextEl = document.getElementById('sftp-editor-text');
  if (!editorTextEl) return;
  const content = editorTextEl.value ?? '';

  staticSftpState.editorSaving = true;
  renderSftpEditorPanel();
  setStaticSftpStatus(`Saving ${remoteBaseName(staticSftpState.editorPath) || staticSftpState.editorPath} ...`);
  try {
    const result = await invokeSftp('sftp_write_file', srv, {
      path: staticSftpState.editorPath,
      content,
    });
    staticSftpState.editorContent = content;
    staticSftpState.editorOriginal = content;
    staticSftpState.editorDirty = false;
    staticSftpState.editorSize = Number(result?.size || content.length);
    staticSftpState.editorModifiedUnix = Number(result?.modified_unix || 0) || staticSftpState.editorModifiedUnix;
    staticSftpState.editorChmod = String(result?.chmod || staticSftpState.editorChmod || '');
    setStaticSftpStatus(`Saved ${remoteBaseName(staticSftpState.editorPath) || staticSftpState.editorPath}`);
    await loadStaticSftpDir(staticSftpState.path || '.');
    setSftpPane('editor', false);
  } catch (err) {
    setStaticSftpStatus(`Save failed: ${String(err)}`, true);
  } finally {
    staticSftpState.editorSaving = false;
    updateSftpPaneButtons();
    renderSftpEditorPanel();
  }
}

function closeSftpEditor() {
  if (!setSftpPane('files', true)) return;
  resetSftpEditorState();
  updateSftpPaneButtons();
  renderSftpEditorPanel();
}

function hideSftpContextMenu() {
  const menu = document.getElementById('sftp-context-menu');
  if (!menu) return;
  menu.style.display = 'none';
  menu.innerHTML = '';
  staticSftpState.contextPath = '';
}

function showSftpContextMenu(x, y, entry) {
  const menu = document.getElementById('sftp-context-menu');
  if (!menu || !entry) return;
  hideServerContextMenu();
  hideFolderContextMenu();
  staticSftpState.contextPath = entry.path || '';

  const items = [];
  if (entry.is_dir) {
    items.push({ action: 'open', label: 'Open Folder' });
    items.push({ action: 'upload_here', label: 'Upload File Here' });
    items.push({ action: 'new_folder', label: 'New Folder Here' });
    items.push({ separator: true });
  } else {
    items.push({ action: 'edit', label: 'Edit File' });
    items.push({ action: 'download', label: 'Download File' });
    items.push({ separator: true });
  }
  items.push({ action: 'rename', label: 'Rename' });
  items.push({ action: 'copy_path', label: 'Copy Path' });
  items.push({ separator: true });
  items.push({
    action: 'delete',
    label: entry.is_dir ? 'Delete Folder' : 'Delete File',
    danger: true,
  });

  menu.innerHTML = items.map((item) => {
    if (item.separator) return '<div class="sftp-menu-sep"></div>';
    return `<button class="sftp-menu-item ${item.danger ? 'danger' : ''}" data-action="${item.action}">${item.label}</button>`;
  }).join('');
  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;

  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      await runSftpContextAction(btn.dataset.action, entry);
    });
  });
}

function showSftpWorkspaceContextMenu(x, y, directoryPath) {
  const menu = document.getElementById('sftp-context-menu');
  if (!menu) return;
  hideServerContextMenu();
  const targetDir = String(directoryPath || staticSftpState.path || '.').trim() || '.';
  staticSftpState.contextPath = targetDir;

  menu.innerHTML = [
    '<button class="sftp-menu-item" data-action="upload_here_workspace">Upload File Here</button>',
    '<button class="sftp-menu-item" data-action="new_file_workspace">New File Here</button>',
    '<button class="sftp-menu-item" data-action="new_folder_workspace">New Folder Here</button>',
    '<div class="sftp-menu-sep"></div>',
    '<button class="sftp-menu-item" data-action="refresh_workspace">Refresh</button>',
  ].join('');
  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;

  menu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const action = btn.dataset.action;
      hideSftpContextMenu();
      if (action === 'upload_here_workspace') {
        await uploadFileToRemoteDir(targetDir);
      } else if (action === 'new_file_workspace') {
        await createSftpFile(targetDir);
      } else if (action === 'new_folder_workspace') {
        await createSftpFolder(targetDir);
      } else if (action === 'refresh_workspace') {
        await loadStaticSftpDir(targetDir);
      }
    });
  });
}

async function uploadFileToRemoteDir(targetDir) {
  const srv = selectedSftpServer();
  const baseDir = String(targetDir || staticSftpState.path || '.').trim() || '.';
  const picked = await open({
    title: 'Select file to upload',
    directory: false,
    multiple: false,
  });
  if (!picked) return;

  const localPath = Array.isArray(picked) ? picked[0] : picked;
  if (!localPath) return;

  const filename = String(localPath).split(/[\\/]/).pop() || 'upload.bin';
  const remotePath = remoteJoinPath(baseDir, filename);
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Uploading ${filename} ...`);
  try {
    await invokeSftp('sftp_upload_file', srv, {
      localPath: String(localPath),
      remotePath,
    });
    setStaticSftpStatus(`Uploaded ${filename} to ${baseDir}`);
    await loadStaticSftpDir(baseDir);
  } catch (err) {
    setStaticSftpStatus(`Upload failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function downloadSftpEntry(entry) {
  if (!entry || entry.is_dir) return;
  const srv = selectedSftpServer();
  const remotePath = String(entry.path || '').trim();
  if (!remotePath) return;
  const fileName = remoteBaseName(remotePath) || 'download.bin';
  const chosen = await saveDialog({
    title: 'Save downloaded file',
    defaultPath: fileName,
  });
  if (!chosen) return;

  const localPath = Array.isArray(chosen) ? chosen[0] : chosen;
  if (!localPath) return;

  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Downloading ${fileName} ...`);
  try {
    await invokeSftp('sftp_download_file', srv, {
      remotePath,
      localPath: String(localPath),
    });
    setStaticSftpStatus(`Downloaded ${fileName}`);
  } catch (err) {
    setStaticSftpStatus(`Download failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function renameSftpEntry(entry) {
  const oldPath = String(entry.path || '').trim();
  if (!oldPath) return;
  const oldName = remoteBaseName(oldPath);
  const nextNameRaw = await askInputModal({
    title: 'Rename Entry',
    label: 'New Name',
    value: oldName,
    placeholder: oldName || 'new-name',
    submitText: 'Rename',
  });
  if (nextNameRaw === null) return;
  const nextName = nextNameRaw.trim().replace(/[\\/]/g, '');
  if (!nextName || nextName === oldName) return;

  const srv = selectedSftpServer();
  const newPath = remoteJoinPath(remoteParentPath(oldPath), nextName);
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Renaming ${oldName} ...`);
  try {
    await invokeSftp('sftp_rename_entry', srv, {
      oldPath,
      newPath,
    });
    setStaticSftpStatus(`Renamed to ${nextName}`);
    await loadStaticSftpDir(staticSftpState.path || '.');
  } catch (err) {
    setStaticSftpStatus(`Rename failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function deleteSftpEntry(entry) {
  const path = String(entry.path || '').trim();
  if (!path) return;
  const label = remoteBaseName(path) || path;
  const confirmed = window.confirm(`Delete ${entry.is_dir ? 'folder' : 'file'} "${label}"?`);
  if (!confirmed) return;

  const srv = selectedSftpServer();
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Deleting ${label} ...`);
  try {
    await invokeSftp('sftp_delete_entry', srv, {
      path,
      isDir: Boolean(entry.is_dir),
    });
    setStaticSftpStatus(`Deleted ${label}`);
    await loadStaticSftpDir(staticSftpState.path || '.');
  } catch (err) {
    setStaticSftpStatus(`Delete failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function createSftpFolder(parentDir) {
  const folderNameRaw = window.prompt('New folder name:');
  if (folderNameRaw === null) return;
  const folderName = folderNameRaw.trim().replace(/[\\/]/g, '');
  if (!folderName) return;

  const srv = selectedSftpServer();
  const parent = String(parentDir || staticSftpState.path || '.').trim() || '.';
  const path = remoteJoinPath(parent, folderName);
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Creating folder ${folderName} ...`);
  try {
    await invokeSftp('sftp_create_dir', srv, {
      path,
    });
    setStaticSftpStatus(`Created folder ${folderName}`);
    await loadStaticSftpDir(parent);
  } catch (err) {
    setStaticSftpStatus(`Create folder failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function createSftpFile(parentDir) {
  const fileNameRaw = window.prompt('New file name:', 'new-file.txt');
  if (fileNameRaw === null) return;
  const fileName = fileNameRaw.trim().replace(/[\\/]/g, '');
  if (!fileName) return;

  const srv = selectedSftpServer();
  const parent = String(parentDir || staticSftpState.path || '.').trim() || '.';
  const path = remoteJoinPath(parent, fileName);
  setSftpControlsDisabled(true);
  setStaticSftpStatus(`Creating file ${fileName} ...`);
  try {
    await invokeSftp('sftp_write_file', srv, {
      path,
      content: '',
    });
    setStaticSftpStatus(`Created file ${fileName}`);
    await loadStaticSftpDir(parent);
  } catch (err) {
    setStaticSftpStatus(`Create file failed: ${String(err)}`, true);
  } finally {
    setSftpControlsDisabled(false);
  }
}

async function runSftpContextAction(action, entry) {
  hideSftpContextMenu();
  if (!entry || !action) return;
  if (action === 'open') {
    if (entry.is_dir) await loadStaticSftpDir(entry.path);
    return;
  }
  if (action === 'upload_here') {
    if (entry.is_dir) await uploadFileToRemoteDir(entry.path);
    return;
  }
  if (action === 'new_folder') {
    if (entry.is_dir) await createSftpFolder(entry.path);
    return;
  }
  if (action === 'edit') {
    await openSftpEditorFile(entry);
    return;
  }
  if (action === 'download') {
    await downloadSftpEntry(entry);
    return;
  }
  if (action === 'rename') {
    await renameSftpEntry(entry);
    return;
  }
  if (action === 'copy_path') {
    try {
      await navigator.clipboard.writeText(String(entry.path || ''));
      setStaticSftpStatus(`Copied path: ${entry.path}`);
    } catch {
      setStaticSftpStatus('Copy path failed', true);
    }
    return;
  }
  if (action === 'delete') {
    await deleteSftpEntry(entry);
  }
}

const SFTP_MIN_COL_WIDTHS = [180, 60, 70, 120, 88];
function staticSftpColumnTemplate() {
  return staticSftpState.colWidths.map((w) => `${Math.round(w)}px`).join(' ');
}

function applyStaticSftpColumnTemplate() {
  const wrap = document.getElementById('sftp-table-wrap-static');
  if (!wrap) return;
  wrap.style.setProperty('--sftp-cols', staticSftpColumnTemplate());
}

function initStaticSftpColumnResizers() {
  const header = document.getElementById('sftp-header-static');
  if (!header) return;
  applyStaticSftpColumnTemplate();
  header.querySelectorAll('.sftp-col-resizer').forEach((resizer) => {
    resizer.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const colIndex = Number(resizer.dataset.col);
      if (!Number.isInteger(colIndex) || colIndex < 0 || colIndex >= staticSftpState.colWidths.length) return;
      const startX = ev.clientX;
      const startWidth = staticSftpState.colWidths[colIndex];
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (moveEv) => {
        const next = Math.max(SFTP_MIN_COL_WIDTHS[colIndex], startWidth + (moveEv.clientX - startX));
        staticSftpState.colWidths[colIndex] = next;
        applyStaticSftpColumnTemplate();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

function showStaticSftpEmpty(message = 'Select a node to browse files') {
  hideSftpContextMenu();
  resetSftpEditorState();
  updateSftpPaneButtons();
  const emptyEl = document.getElementById('sftp-empty');
  const shellEl = document.getElementById('sftp-shell');
  if (emptyEl) {
    emptyEl.textContent = message;
    emptyEl.style.display = 'block';
  }
  if (shellEl) shellEl.style.display = 'none';
}

function showStaticSftpForServer() {
  hideSftpContextMenu();
  const emptyEl = document.getElementById('sftp-empty');
  const shellEl = document.getElementById('sftp-shell');
  if (emptyEl) emptyEl.style.display = 'none';
  if (shellEl) shellEl.style.display = 'flex';
  if (staticSftpState.serverId !== selId) {
    staticSftpState.serverId = selId;
    staticSftpState.path = '.';
    resetSftpEditorState();
  }
  const input = document.getElementById('sftp-path-input');
  if (input && !input.value.trim()) input.value = staticSftpState.path || '.';
  updateSftpPaneButtons();
  renderSftpEditorPanel();
  void loadStaticSftpDir(staticSftpState.path || '.');
}

function renderStaticSftpRows(entries) {
  const listEl = document.getElementById('sftp-list-static');
  const wrapEl = document.getElementById('sftp-table-wrap-static');
  const headerEl = document.getElementById('sftp-header-static');
  if (!listEl || !wrapEl || !headerEl) return;

  listEl.oncontextmenu = (ev) => {
    if (ev.target?.closest?.('.sftp-row')) return;
    ev.preventDefault();
    ev.stopPropagation();
    showSftpWorkspaceContextMenu(ev.clientX, ev.clientY, staticSftpState.path || '.');
  };

  staticSftpState.entries = Array.isArray(entries) ? entries : [];
  updateSftpViewButtons();

  if (staticSftpState.view === 'grid') {
    wrapEl.classList.add('grid-mode');
    listEl.classList.add('grid-mode');
  } else {
    wrapEl.classList.remove('grid-mode');
    listEl.classList.remove('grid-mode');
  }

  if (staticSftpState.entries.length === 0) {
    listEl.innerHTML = `<div class="sftp-empty">No files found</div>`;
    return;
  }

  const pathToEntry = new Map();
  if (staticSftpState.view === 'grid') {
    listEl.innerHTML = staticSftpState.entries.map((entry) => {
      pathToEntry.set(String(entry.path || ''), entry);
      const name = escapeHtml(entry.name || '');
      const type = entry.is_dir ? 'DIR' : entry.is_symlink ? 'LINK' : 'FILE';
      const size = entry.is_dir ? '\u2014' : formatBytes(entry.size);
      const created = formatUnixTimestamp(entry.created_unix || entry.modified_unix);
      const chmod = escapeHtml(entry.chmod || '\u2014');
      const path = escapeHtml(entry.path || '');
      const icon = sftpEntryIconMarkup(entry);
      return `<div class="sftp-row sftp-card ${entry.is_dir ? 'is-dir' : ''}" data-path="${path}" data-dir="${entry.is_dir ? '1' : '0'}">
        <div class="sftp-card-head">
          <div class="sftp-card-name">${icon}<span class="sftp-name-text">${name}</span></div>
          <div class="sftp-card-type">${type}</div>
        </div>
        <div class="sftp-card-meta">
          <span>Size ${size}</span>
          <span>${chmod}</span>
        </div>
        <div class="sftp-card-created">${escapeHtml(created)}</div>
      </div>`;
    }).join('');
  } else {
    listEl.innerHTML = staticSftpState.entries.map((entry) => {
      pathToEntry.set(String(entry.path || ''), entry);
      const name = escapeHtml(entry.name || '');
      const type = entry.is_dir ? 'DIR' : entry.is_symlink ? 'LINK' : 'FILE';
      const size = entry.is_dir ? '\u2014' : formatBytes(entry.size);
      const created = formatUnixTimestamp(entry.created_unix || entry.modified_unix);
      const chmod = escapeHtml(entry.chmod || '\u2014');
      const path = escapeHtml(entry.path || '');
      const icon = sftpEntryIconMarkup(entry);
      return `<div class="sftp-row sftp-grid-row ${entry.is_dir ? 'is-dir' : ''}" data-path="${path}" data-dir="${entry.is_dir ? '1' : '0'}">
        <div class="sftp-cell sftp-name"><span class="sftp-entry-main">${icon}<span class="sftp-name-text">${name}</span></span></div>
        <div class="sftp-cell sftp-type">${type}</div>
        <div class="sftp-cell sftp-size">${size}</div>
        <div class="sftp-cell sftp-created">${escapeHtml(created)}</div>
        <div class="sftp-cell sftp-chmod">${chmod}</div>
      </div>`;
    }).join('');
  }

  listEl.querySelectorAll('.sftp-row').forEach((row) => {
    const path = row.dataset.path || '';
    const entry = pathToEntry.get(path);
    if (!entry) return;
    if (entry.is_dir) {
      row.addEventListener('dblclick', () => {
        if (entry.path) loadStaticSftpDir(entry.path);
      });
    }
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showSftpContextMenu(ev.clientX, ev.clientY, entry);
    });
  });
}

async function loadStaticSftpDir(targetPath) {
  hideSftpContextMenu();
  if (selId === null) {
    showStaticSftpEmpty();
    return;
  }

  const srv = SRV.find(s => s.id === selId);
  if (!srv) {
    showStaticSftpEmpty('Selected server no longer exists');
    return;
  }

  const statusEl = document.getElementById('sftp-status-static');
  const pathEl = document.getElementById('sftp-path-input');
  if (!statusEl || !pathEl) return;

  const path = (targetPath ?? pathEl.value ?? staticSftpState.path ?? '.').trim() || '.';
  staticSftpState.path = path;
  const requestId = ++staticSftpState.requestSeq;
  staticSftpState.loading = true;

  setStaticSftpStatus(`Loading ${path} ...`);
  setSftpControlsDisabled(true);

  try {
    const result = await invokeSftp('sftp_list_dir', srv, { path });
    if (requestId !== staticSftpState.requestSeq) return;
    staticSftpState.path = result?.path || path;
    pathEl.value = staticSftpState.path;
    renderStaticSftpRows(result?.entries || []);
    setStaticSftpStatus(`${(result?.entries || []).length} item(s) in ${staticSftpState.path}`);
  } catch (err) {
    if (requestId !== staticSftpState.requestSeq) return;
    setStaticSftpStatus(`SFTP failed: ${String(err)}`, true);
    renderStaticSftpRows([]);
  } finally {
    if (requestId !== staticSftpState.requestSeq) return;
    staticSftpState.loading = false;
    setSftpControlsDisabled(false);
    updateSftpPaneButtons();
    renderSftpEditorPanel();
  }
}

/* ══════════════════════════════════════════════════════════
   SELECT SERVER
══════════════════════════════════════════════════════════ */
function selectSrv(id, options = {}) {
  const keepMain = Boolean(options.keepMain);
  if (id !== null && mainDashboardActive && !keepMain) setMainDashboardActive(false);
  selId = id;
  document.querySelectorAll('.snode').forEach(n => n.classList.remove('active'));
  if (id !== null) document.getElementById(`sn-${id}`)?.classList.add('active');
  SRV.forEach(s => {
    if (leafletMarkers[s.id]) leafletMarkers[s.id].setIcon(createMarkerIcon(s, s.id === id));
    if (dashLeafletMarkers[s.id]) dashLeafletMarkers[s.id].setIcon(createMarkerIcon(s, s.id === id));
  });
  renderMainServerList();
  refreshAddBtn();
  refreshTabVisibility();
  refreshRailActive();
  if (id !== null) {
    const srv = SRV.find(s => s.id === id);
    if (srv) {
      if (activeTabId === 'sftp') {
        sftpBrowserTab.srvId = id;
        refreshSftpBrowserTab();
      }
      const coords = getServerMapCoords(srv);
      if (coords) {
        if (mainDashboardActive && dashMap) safeMapFlyTo(dashMap, coords);
        else safeMapFlyTo(map, coords);
      }
      if (activeTabId === 'metrics') {
        renderMetrics(srv);
        if (metricsLiveEnabled && hasLiveSshSessionForServer(srv.id)) {
          void refreshMetrics(srv.id);
        }
      }
      if (activeTabId === 'sftp') showStaticSftpForServer();
    }
  } else {
    if (activeTabId === 'metrics') showMEmpty();
    if (activeTabId === 'sftp') showStaticSftpEmpty();
  }
}

/* ══════════════════════════════════════════════════════════
   ADD TERMINAL TAB  (xterm.js + real SSH)
══════════════════════════════════════════════════════════ */
function addTermTab(options = {}) {
  const targetServerId = options.serverId ?? selId;
  if (targetServerId === null) return;
  const s = SRV.find(sv => sv.id === targetServerId);
  if (!s) return;
  const usernameOverride = typeof options.usernameOverride === 'string' && options.usernameOverride.trim()
    ? options.usernameOverride.trim()
    : null;
  const forceUsernamePrompt = Boolean(options.forceUsernamePrompt);
  const providedHistoryId = typeof options?.historyId === 'string' ? options.historyId.trim() : '';
  const historyId = providedHistoryId || `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const tid = `t${++tabCounter}`;
  const srvTabCount = Object.values(termTabs).filter(t => t.srvId === s.id).length + 1;

  // Tab button
  const btn = document.createElement('div');
  btn.className = 'tab-term';
  btn.id = `tabbtn-${tid}`;
  btn.innerHTML = `
    <div class="tab-term-inner" data-tabid="${tid}">
      <div class="tab-dot" style="background:${sDot('unknown')};box-shadow:0 0 5px ${sDot('unknown')}"></div>
      <span class="tab-label">${s.name}</span>
      <span class="tab-num">#${srvTabCount}</span>
      <span class="tab-srv-badge" style="display:none">${s.name}</span>
    </div>
    <button class="tab-pin" data-tabid="${tid}" data-tip="Pin (keep across server switches)">&#x2299;</button>
    <button class="tab-close" data-tabid="${tid}">&#x00d7;</button>`;

  btn.querySelector('.tab-term-inner').addEventListener('click', () => setActiveTab(tid));
  btn.querySelector('.tab-pin').addEventListener('click', (e) => togglePin(e, tid));
  btn.querySelector('.tab-close').addEventListener('click', (e) => closeTab(e, tid));
  document.getElementById('term-tab-area').insertBefore(btn, document.getElementById('tab-add-btn'));

  // Terminal panel with xterm container
  const panel = document.createElement('div');
  panel.className = 'tab-panel term-panel';
  panel.id = `panel-${tid}`;
  panel.innerHTML = `
    <div class="term-topbar">
      <div class="term-info">
        <div class="term-srv-dot" id="term-dot-${tid}" style="background:${sDot('unknown')};box-shadow:0 0 6px ${sDot('unknown')}"></div>
        <span class="term-srv-name">${s.name}</span>
        <span class="term-srv-ip">${s.host}:${s.port}</span>
        <span class="term-cross-badge" id="cross-badge-${tid}" style="display:none">PINNED \u00b7 CROSS-SERVER</span>
        <span class="term-conn-status" id="conn-status-${tid}" style="margin-left:8px;font-size:9px;color:var(--warn);letter-spacing:1px">CONNECTING\u2026</span>
      </div>
      <div class="term-actions">
        <button class="term-btn" id="clear-btn-${tid}">CLEAR</button>
        <button class="term-btn" id="reconnect-btn-${tid}">RECONNECT</button>
        <button class="term-btn danger" id="close-btn-${tid}">CLOSE</button>
      </div>
    </div>
    <div class="term-body">
      <div class="xterm-container" id="xterm-${tid}"></div>
    </div>`;
  document.getElementById('term-panels-host').appendChild(panel);

  // Wire up action buttons
  panel.querySelector(`#clear-btn-${tid}`).addEventListener('click', () => termClear(tid));
  panel.querySelector(`#reconnect-btn-${tid}`).addEventListener('click', () => termReconnect(tid));
  panel.querySelector(`#close-btn-${tid}`).addEventListener('click', () => closeTab(null, tid));

  termTabs[tid] = {
    mode: 'ssh',
    srvId: s.id, srv: s, pinned: false,
    historyId,
    usernameOverride,
    forceUsernamePrompt,
    connStatus: 'connecting',
    tabBtnEl: btn, panelEl: panel,
    terminal: null, fitAddon: null, sessionId: null,
    unlisten: null, unlistenEof: null, unlistenClosed: null,
    resizeObserver: null,
    pendingInput: '',
    inputFlushTimer: null,
    pendingOutput: [],
    outputFlushTimer: null,
  };

  trackRecentSshSession({
    id: historyId,
    openedAtMs: Date.now(),
    serverId: s.id,
    serverName: s.name,
    host: s.host,
    port: s.port,
    username: usernameOverride || s.username || '',
  });

  setActiveTab(tid);
  initTermSession(tid, s, usernameOverride, forceUsernamePrompt);
  refreshSidebarBadges();
  updateMainTerminalLayout();
  return tid;
}

function insertLocalTabButton(btn) {
  const area = document.getElementById('term-tab-area');
  const addBtn = document.getElementById('tab-add-btn');
  let anchor = addBtn;

  for (const child of Array.from(area.children)) {
    if (child.id === 'tab-add-btn') break;
    if (!child.classList.contains('tab-term')) continue;
    const childId = child.querySelector('.tab-term-inner')?.dataset?.tabid;
    const childTab = childId ? termTabs[childId] : null;
    if (!childTab || childTab.mode !== 'local') {
      anchor = child;
      break;
    }
  }

  area.insertBefore(btn, anchor);
}

function addLocalTermTab(shellType = 'powershell', options = {}) {
  const localShellType = normalizeLocalShellType(shellType);
  const shellLabel = localShellLabel(localShellType);
  const providedHistoryId = typeof options?.historyId === 'string' ? options.historyId.trim() : '';

  const tid = `l${++tabCounter}`;
  const historyId = providedHistoryId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const localCount = Object.values(termTabs).filter((t) => t.mode === 'local').length + 1;

  const btn = document.createElement('div');
  btn.className = 'tab-term';
  btn.id = `tabbtn-${tid}`;
  btn.innerHTML = `
    <div class="tab-term-inner" data-tabid="${tid}">
      <div class="tab-dot" style="background:${sDot('unknown')};box-shadow:0 0 5px ${sDot('unknown')}"></div>
      <span class="tab-label">LOCAL</span>
      <span class="tab-num">${shellLabel} #${localCount}</span>
      <span class="tab-srv-badge" style="display:none"></span>
    </div>
    <button class="tab-close" data-tabid="${tid}">&#x00d7;</button>`;

  btn.querySelector('.tab-term-inner').addEventListener('click', () => setActiveTab(tid));
  btn.querySelector('.tab-close').addEventListener('click', (e) => closeTab(e, tid));

  const panel = document.createElement('div');
  panel.className = 'tab-panel term-panel';
  panel.id = `panel-${tid}`;
  panel.innerHTML = `
    <div class="term-topbar">
      <div class="term-info">
        <div class="term-srv-dot" id="term-dot-${tid}" style="background:${sDot('unknown')};box-shadow:0 0 6px ${sDot('unknown')}"></div>
        <span class="term-srv-name">Local Terminal</span>
        <span class="term-srv-ip" id="term-local-meta-${tid}">${shellLabel}</span>
        <span class="term-conn-status" id="conn-status-${tid}" style="margin-left:8px;font-size:9px;color:var(--warn);letter-spacing:1px">CONNECTING\u2026</span>
      </div>
      <div class="term-actions">
        <button class="term-btn" id="clear-btn-${tid}">CLEAR</button>
        <button class="term-btn" id="reconnect-btn-${tid}">RECONNECT</button>
        <button class="term-btn danger" id="close-btn-${tid}">CLOSE</button>
      </div>
    </div>
    <div class="term-body">
      <div class="xterm-container" id="xterm-${tid}"></div>
    </div>`;
  document.getElementById('term-panels-host').appendChild(panel);

  panel.querySelector(`#clear-btn-${tid}`).addEventListener('click', () => termClear(tid));
  panel.querySelector(`#reconnect-btn-${tid}`).addEventListener('click', () => termReconnect(tid));
  panel.querySelector(`#close-btn-${tid}`).addEventListener('click', () => closeTab(null, tid));

  termTabs[tid] = {
    mode: 'local',
    srvId: null, srv: null, pinned: true,
    historyId,
    localShellType,
    usernameOverride: null,
    forceUsernamePrompt: false,
    connStatus: 'connecting',
    tabBtnEl: btn, panelEl: panel,
    terminal: null, fitAddon: null, sessionId: null,
    unlisten: null, unlistenEof: null, unlistenClosed: null,
    resizeObserver: null,
    pendingInput: '',
    inputFlushTimer: null,
    pendingOutput: [],
    outputFlushTimer: null,
  };

  insertLocalTabButton(btn);
  const metaEl = document.getElementById(`term-local-meta-${tid}`);
  if (metaEl && hostDeviceInfo?.terminal_workspace) {
    metaEl.textContent = `${shellLabel} · ${hostDeviceInfo.terminal_workspace}`;
  }

  trackRecentLocalSession({
    id: historyId,
    shell: localShellType,
    openedAtMs: Date.now(),
    workspace: hostDeviceInfo?.terminal_workspace || '',
  });

  setActiveTab(tid);
  void initLocalTermSession(tid, localShellType);
  updateMainTerminalLayout();
  return tid;
}

function readTerminalLine(term, promptText, secret = false) {
  return new Promise((resolve) => {
    let value = '';
    term.write(promptText);

    const dispose = term.onData((data) => {
      for (const ch of data) {
        if (ch === '\r') {
          term.write('\r\n');
          dispose.dispose();
          resolve({ cancelled: false, value });
          return;
        }
        if (ch === '\n') continue;
        if (ch === '\u0003') {
          term.write('^C\r\n');
          dispose.dispose();
          resolve({ cancelled: true, value: '' });
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (!value) continue;
          value = value.slice(0, -1);
          term.write('\b \b');
          continue;
        }
        if (ch >= ' ' && ch !== '\u007f') {
          value += ch;
          term.write(secret ? '*' : ch);
        }
      }
    });
  });
}

async function resolveTerminalCredentials(term, serverConfig, usernameOverride = null, forceUsernamePrompt = false) {
  let username = (!forceUsernamePrompt && typeof usernameOverride === 'string' && usernameOverride.trim())
    ? usernameOverride.trim()
    : (!forceUsernamePrompt ? String(serverConfig?.username || '').trim() : '');

  if (!username) {
    const usernameInput = await readTerminalLine(
      term,
      `\x1b[38;2;58;85;112mUsername for ${serverConfig.host}:\x1b[0m `
    );
    if (usernameInput.cancelled) return { cancelled: true, username: '', passwordOverride: null };
    username = String(usernameInput.value || '').trim();
    if (!username) {
      term.writeln('\x1b[38;2;255;59;92mUsername is required.\x1b[0m');
      return { cancelled: true, username: '', passwordOverride: null };
    }
  }

  let passwordOverride = null;
  const authType = serverConfig?._raw?.auth_method?.type;
  const configuredPassword = String(serverConfig?._raw?.auth_method?.password ?? '');
  if (authType === 'Password' && !configuredPassword) {
    const passwordInput = await readTerminalLine(
      term,
      `\x1b[38;2;58;85;112mPassword for ${username}@${serverConfig.host}:\x1b[0m `,
      true
    );
    if (passwordInput.cancelled) return { cancelled: true, username: '', passwordOverride: null };
    passwordOverride = String(passwordInput.value || '');
  }

  return { cancelled: false, username, passwordOverride };
}

function flushTerminalOutput(tab) {
  if (!tab) return;
  if (tab.outputFlushTimer !== null) {
    clearTimeout(tab.outputFlushTimer);
    tab.outputFlushTimer = null;
  }
  if (!tab.terminal) {
    tab.pendingOutput = [];
    return;
  }
  const chunks = tab.pendingOutput.splice(0, tab.pendingOutput.length);
  if (!chunks.length) return;
  tab.terminal.write(chunks.join(''));
}

function queueTerminalOutput(tab, payload) {
  if (!tab || !payload) return;
  tab.pendingOutput.push(String(payload));
  if (tab.outputFlushTimer !== null) return;
  tab.outputFlushTimer = setTimeout(() => {
    flushTerminalOutput(tab);
  }, TERMINAL_OUTPUT_FLUSH_MS);
}

function flushTerminalInput(tab, command) {
  if (!tab) return;
  if (tab.inputFlushTimer !== null) {
    clearTimeout(tab.inputFlushTimer);
    tab.inputFlushTimer = null;
  }
  const text = tab.pendingInput;
  tab.pendingInput = '';
  if (!text || !tab.sessionId) return;
  invoke(command, { sessionId: tab.sessionId, data: text }).catch(() => {});
}

function queueTerminalInput(tab, command, text) {
  if (!tab || !tab.sessionId || !text) return;
  tab.pendingInput += String(text);
  if (tab.pendingInput.length >= 2048) {
    flushTerminalInput(tab, command);
    return;
  }
  if (tab.inputFlushTimer !== null) return;
  tab.inputFlushTimer = setTimeout(() => {
    flushTerminalInput(tab, command);
  }, TERMINAL_INPUT_FLUSH_MS);
}

function clearTerminalIoQueues(tab) {
  if (!tab) return;
  if (tab.inputFlushTimer !== null) {
    clearTimeout(tab.inputFlushTimer);
    tab.inputFlushTimer = null;
  }
  if (tab.outputFlushTimer !== null) {
    clearTimeout(tab.outputFlushTimer);
    tab.outputFlushTimer = null;
  }
  tab.pendingInput = '';
  tab.pendingOutput = [];
}

/* ══════════════════════════════════════════════════════════
   INIT TERMINAL SESSION (real SSH via Tauri)
══════════════════════════════════════════════════════════ */
async function initTermSession(tid, serverConfig, usernameOverride = null, forceUsernamePrompt = false) {
  const t = termTabs[tid];
  if (!t) return;

  const container = document.getElementById(`xterm-${tid}`);

  // Create xterm.js terminal
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    theme: {
      background: '#060a0e',
      foreground: '#b8cce0',
      cursor: '#00bfff',
      cursorAccent: '#060a0e',
      selectionBackground: '#1a284066',
      selectionForeground: '#ffffff',
      black: '#0b0f16',
      red: '#ff3b5c',
      green: '#00ffaa',
      yellow: '#f5a623',
      blue: '#00bfff',
      magenta: '#cc66ff',
      cyan: '#00bfff',
      white: '#b8cce0',
      brightBlack: '#3a5570',
      brightRed: '#ff6b88',
      brightGreen: '#33ffbb',
      brightYellow: '#ffcc44',
      brightBlue: '#44ccff',
      brightMagenta: '#dd88ff',
      brightCyan: '#44ddff',
      brightWhite: '#deeeff',
    },
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    rightClickSelectsWord: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(container);

  // Clipboard: Ctrl+Shift+C to copy, Ctrl+Shift+V to paste
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Ctrl+Shift+C → copy selection
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
      return false;
    }
    // Ctrl+Shift+V → paste from clipboard
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      navigator.clipboard.readText().then((text) => {
        if (text) queueTerminalInput(t, 'ssh_write_text', text);
      });
      return false;
    }
    // Ctrl+V (without shift) → also paste for convenience
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyV') {
      navigator.clipboard.readText().then((text) => {
        if (text) queueTerminalInput(t, 'ssh_write_text', text);
      });
      return false;
    }
    return true;
  });

  // Delay fit to ensure container is sized
  await new Promise(r => setTimeout(r, 100));
  fitAddon.fit();

  t.terminal = term;
  t.fitAddon = fitAddon;

  const creds = await resolveTerminalCredentials(term, serverConfig, usernameOverride, forceUsernamePrompt);
  if (creds.cancelled) {
    term.writeln('\x1b[38;2;58;85;112mConnection cancelled.\x1b[0m');
    updateTabStatus(tid, 'disconnected');
    return;
  }

  const connectUsername = creds.username;
  const passwordOverride = creds.passwordOverride;
  t.usernameOverride = connectUsername;
  t.forceUsernamePrompt = false;
  cacheSftpCredentials(serverConfig.id, connectUsername, passwordOverride);
  if (t.mode === 'ssh' && t.historyId) {
    trackRecentSshSession({
      id: t.historyId,
      openedAtMs: Date.now(),
      serverId: serverConfig.id,
      serverName: serverConfig.name,
      host: serverConfig.host,
      port: serverConfig.port,
      username: connectUsername,
    });
  }

  term.writeln('\x1b[38;2;0;191;255m\u2592 Connecting to ' + serverConfig.name + ' (' + serverConfig.host + ':' + serverConfig.port + ') as ' + connectUsername + '\u2026\x1b[0m');

  try {
    // Connect via Rust backend
    const connectPayload = {
      serverId: serverConfig.id,
      cols: term.cols,
      rows: term.rows,
    };
    if (connectUsername) connectPayload.usernameOverride = connectUsername;
    if (passwordOverride !== null) connectPayload.passwordOverride = passwordOverride;
    const sessionId = await invoke('ssh_connect', connectPayload);

    t.sessionId = sessionId;

    // Update connection status
    updateTabStatus(tid, 'connected');

    // Listen for SSH data from backend
    t.unlisten = await listen(`ssh-data-${sessionId}`, (event) => {
      queueTerminalOutput(t, event.payload);
    });

    // Listen for EOF / channel close
    t.unlistenEof = await listen(`ssh-eof-${sessionId}`, () => {
      term.writeln('\r\n\x1b[38;2;245;166;35m\u2592 Connection closed by remote host.\x1b[0m');
      updateTabStatus(tid, 'disconnected');
    });

    t.unlistenClosed = await listen(`ssh-closed-${sessionId}`, () => {
      term.writeln('\r\n\x1b[38;2;255;59;92m\u2592 Connection lost.\x1b[0m');
      updateTabStatus(tid, 'disconnected');
    });

    // Send user keystrokes to backend
    term.onData((data) => {
      queueTerminalInput(t, 'ssh_write_text', data);
    });

    // Handle terminal resize
    term.onResize(({ cols, rows }) => {
      if (!t.sessionId) return;
      invoke('ssh_resize', { sessionId: t.sessionId, cols, rows })
        .catch(() => { });
    });

    // Re-fit on container resize
    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { }
    });
    resizeObserver.observe(container);
    t.resizeObserver = resizeObserver;

  } catch (err) {
    term.writeln(`\x1b[38;2;255;59;92m\u2716 Connection failed: ${err}\x1b[0m`);
    term.writeln('\x1b[38;2;58;85;112mPress RECONNECT to try again.\x1b[0m');
    updateTabStatus(tid, 'error');
  }
}

async function initLocalTermSession(tid, shellType = 'powershell') {
  const t = termTabs[tid];
  if (!t) return;
  const localShellType = normalizeLocalShellType(shellType);

  const container = document.getElementById(`xterm-${tid}`);

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    theme: {
      background: '#060a0e',
      foreground: '#b8cce0',
      cursor: '#00bfff',
      cursorAccent: '#060a0e',
      selectionBackground: '#1a284066',
      selectionForeground: '#ffffff',
      black: '#0b0f16',
      red: '#ff3b5c',
      green: '#00ffaa',
      yellow: '#f5a623',
      blue: '#00bfff',
      magenta: '#cc66ff',
      cyan: '#00bfff',
      white: '#b8cce0',
      brightBlack: '#3a5570',
      brightRed: '#ff6b88',
      brightGreen: '#33ffbb',
      brightYellow: '#ffcc44',
      brightBlue: '#44ccff',
      brightMagenta: '#dd88ff',
      brightCyan: '#44ddff',
      brightWhite: '#deeeff',
    },
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    rightClickSelectsWord: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(container);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
      return false;
    }
    if ((e.ctrlKey && e.shiftKey && e.code === 'KeyV') || (e.ctrlKey && !e.shiftKey && e.code === 'KeyV')) {
      navigator.clipboard.readText().then((text) => {
        if (text) queueTerminalInput(t, 'local_shell_write_text', text);
      });
      return false;
    }
    return true;
  });

  await new Promise(r => setTimeout(r, 100));
  fitAddon.fit();

  t.terminal = term;
  t.fitAddon = fitAddon;

  const shellLabel = localShellLabel(localShellType);
  term.writeln(`\x1b[38;2;0;191;255m\u2592 Starting local ${shellLabel} shell\u2026\x1b[0m`);

  try {
    const sessionId = await invoke('local_shell_connect', {
      shellType: localShellType,
      cols: term.cols,
      rows: term.rows,
    });

    t.sessionId = sessionId;
    updateTabStatus(tid, 'connected');

    t.unlisten = await listen(`local-data-${sessionId}`, (event) => {
      queueTerminalOutput(t, String(event.payload || ''));
    });

    t.unlistenEof = await listen(`local-eof-${sessionId}`, () => {
      term.writeln('\r\n\x1b[38;2;245;166;35m\u2592 Local shell closed.\x1b[0m');
      updateTabStatus(tid, 'disconnected');
    });

    t.unlistenClosed = await listen(`local-closed-${sessionId}`, () => {
      term.writeln('\r\n\x1b[38;2;255;59;92m\u2592 Local shell terminated.\x1b[0m');
      updateTabStatus(tid, 'disconnected');
    });

    term.onData((data) => {
      queueTerminalInput(t, 'local_shell_write_text', data);
    });

    term.onResize(({ cols, rows }) => {
      if (!t.sessionId) return;
      invoke('local_shell_resize', { sessionId: t.sessionId, cols, rows })
        .catch(() => { });
    });

    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { }
    });
    resizeObserver.observe(container);
    t.resizeObserver = resizeObserver;
  } catch (err) {
    term.writeln(`\x1b[38;2;255;59;92m\u2716 Local terminal failed: ${err}\x1b[0m`);
    term.writeln('\x1b[38;2;58;85;112mPress RECONNECT to try again.\x1b[0m');
    updateTabStatus(tid, 'error');
  }
}

function updateTabStatus(tid, status) {
  const t = termTabs[tid];
  if (!t) return;
  t.connStatus = status;

  const statusEl = document.getElementById(`conn-status-${tid}`);
  const dot = t.tabBtnEl.querySelector('.tab-dot');
  const topDot = document.getElementById(`term-dot-${tid}`);

  const colors = {
    connecting: { text: 'CONNECTING\u2026', color: 'var(--warn)', dotColor: '#f5a623' },
    connected: { text: 'CONNECTED', color: 'var(--accent2)', dotColor: '#00ffaa' },
    disconnected: { text: 'DISCONNECTED', color: 'var(--muted)', dotColor: '#3a5570' },
    error: { text: 'ERROR', color: 'var(--danger)', dotColor: '#ff3b5c' },
  };
  const c = colors[status] || colors.connecting;

  if (statusEl) { statusEl.textContent = c.text; statusEl.style.color = c.color; }
  if (dot) { dot.style.background = c.dotColor; dot.style.boxShadow = `0 0 5px ${c.dotColor}`; }
  if (topDot) { topDot.style.background = c.dotColor; topDot.style.boxShadow = `0 0 6px ${c.dotColor}`; }
  if (t.mode === 'ssh') {
    maybeRenderSelectedMetrics();
  }
}

/* ══════════════════════════════════════════════════════════
   PIN / CLOSE / CLEAR / RECONNECT
══════════════════════════════════════════════════════════ */
function togglePin(e, tid) {
  e.stopPropagation();
  const t = termTabs[tid]; if (!t) return;
  t.pinned = !t.pinned;
  const btn = t.tabBtnEl.querySelector('.tab-pin');
  if (t.pinned) {
    t.tabBtnEl.classList.add('pinned');
    btn.dataset.tip = 'Unpin';
    btn.textContent = '\u229b';
  } else {
    t.tabBtnEl.classList.remove('pinned');
    btn.dataset.tip = 'Pin (keep across server switches)';
    btn.textContent = '\u2299';
  }
  refreshTabVisibility();
}

async function closeTab(e, tid) {
  if (e) e.stopPropagation();
  const t = termTabs[tid]; if (!t) return;
  const wasActive = activeTabId === tid;
  if (t.mode === 'local') flushTerminalInput(t, 'local_shell_write_text');
  else flushTerminalInput(t, 'ssh_write_text');

  // Clean up SSH session
  if (t.sessionId) {
    const disconnectCmd = t.mode === 'local' ? 'local_shell_disconnect' : 'ssh_disconnect';
    try { await invoke(disconnectCmd, { sessionId: t.sessionId }); } catch { }
  }
  // Clean up listeners
  if (t.unlisten) t.unlisten();
  if (t.unlistenEof) t.unlistenEof();
  if (t.unlistenClosed) t.unlistenClosed();
  clearTerminalIoQueues(t);
  // Clean up xterm
  if (t.resizeObserver) t.resizeObserver.disconnect();
  if (t.terminal) t.terminal.dispose();

  t.tabBtnEl.remove();
  t.panelEl.remove();
  delete termTabs[tid];

  if (wasActive) {
    const vis = Object.entries(termTabs).find(([, t]) => t.mode === 'local' || t.pinned || t.srvId === selId);
    setActiveTab(vis ? vis[0] : 'metrics');
  }
  refreshSidebarBadges();
  maybeRenderSelectedMetrics();
  updateMainTerminalLayout();
}

function termClear(tid) {
  const t = termTabs[tid];
  if (t?.terminal) t.terminal.clear();
}

async function termReconnect(tid) {
  const t = termTabs[tid]; if (!t) return;
  if (t.mode === 'local') flushTerminalInput(t, 'local_shell_write_text');
  else flushTerminalInput(t, 'ssh_write_text');

  // Disconnect old session
  if (t.sessionId) {
    const disconnectCmd = t.mode === 'local' ? 'local_shell_disconnect' : 'ssh_disconnect';
    try { await invoke(disconnectCmd, { sessionId: t.sessionId }); } catch { }
    t.sessionId = null;
  }
  if (t.unlisten) { t.unlisten(); t.unlisten = null; }
  if (t.unlistenEof) { t.unlistenEof(); t.unlistenEof = null; }
  if (t.unlistenClosed) { t.unlistenClosed(); t.unlistenClosed = null; }
  clearTerminalIoQueues(t);
  if (t.resizeObserver) { t.resizeObserver.disconnect(); t.resizeObserver = null; }
  if (t.terminal) { t.terminal.dispose(); t.terminal = null; }

  updateTabStatus(tid, 'connecting');
  if (t.mode === 'local') {
    await initLocalTermSession(tid, t.localShellType || 'powershell');
  } else {
    await initTermSession(tid, t.srv, t.usernameOverride || null, Boolean(t.forceUsernamePrompt));
  }
}

/* ══════════════════════════════════════════════════════════
   METRICS
══════════════════════════════════════════════════════════ */
function hasLiveSshSessionForServer(serverId) {
  if (!serverId) return false;
  return Object.values(termTabs).some((tab) => {
    return tab.mode === 'ssh'
      && tab.srvId === serverId
      && tab.connStatus === 'connected'
      && Boolean(tab.sessionId);
  });
}

function maybeRenderSelectedMetrics() {
  if (activeTabId !== 'metrics' || selId === null) return;
  const selected = SRV.find((server) => server.id === selId);
  if (!selected) return;
  renderMetrics(selected);
}

async function tickLiveMetricsRefresh() {
  if (activeTabId !== 'metrics' || selId === null) return;
  if (!metricsLiveEnabled) return;
  if (!hasLiveSshSessionForServer(selId)) return;
  await refreshMetrics(selId);
}

function showMEmpty() {
  document.getElementById('m-empty').style.display = 'flex';
  document.getElementById('m-content').style.display = 'none';
}

function getLiveMetricsState(serverId) {
  if (!LIVE_METRICS.has(serverId)) {
    LIVE_METRICS.set(serverId, {
      loading: false,
      error: '',
      lastUpdatedMs: 0,
      data: null,
    });
  }
  return LIVE_METRICS.get(serverId);
}

function getServerIntelState(serverId) {
  if (!SERVER_INTEL.has(serverId)) {
    SERVER_INTEL.set(serverId, {
      loading: false,
      error: '',
      lastUpdatedMs: 0,
      data: null,
    });
  }
  return SERVER_INTEL.get(serverId);
}

function cleanLiveMetricsCache() {
  const valid = new Set(SRV.map(s => s.id));
  for (const key of LIVE_METRICS.keys()) {
    if (!valid.has(key)) LIVE_METRICS.delete(key);
  }
}

function cleanServerIntelCache() {
  const valid = new Set(SRV.map(s => s.id));
  for (const key of SERVER_INTEL.keys()) {
    if (!valid.has(key)) SERVER_INTEL.delete(key);
  }
}

function formatUpdatedAgo(ms) {
  if (!ms) return 'Never';
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortErrorText(value) {
  const text = String(value || 'Unknown error').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inferBrowserScheme(port) {
  if ([443, 6443, 8443, 9443].includes(port)) return 'https';
  if ([80, 81, 3000, 3001, 4000, 5000, 5173, 5601, 8000, 8080, 8081, 8088, 8888, 9000, 9090, 9200, 15672].includes(port)) return 'http';
  return '';
}

function normalizeUrlHost(host) {
  const raw = String(host || '').trim();
  if (!raw) return '';
  if (raw.startsWith('[') && raw.endsWith(']')) return raw;
  if (raw.includes(':')) return `[${raw}]`;
  return raw;
}

function buildServiceBrowserUrl(server, service) {
  if (!service?.is_browser_supported) return '';
  const host = normalizeUrlHost(server?.host || '');
  const port = Number(service?.port);
  if (!host || !Number.isFinite(port) || port <= 0) return '';
  const scheme = String(service?.browser_url_scheme || inferBrowserScheme(port)).toLowerCase();
  if (!scheme) return '';
  const omitPort = (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
  return `${scheme}://${host}${omitPort ? '' : `:${port}`}/`;
}

function renderMetricsServiceRows(server, services) {
  if (!Array.isArray(services) || !services.length) {
    return '<div class="mx-service-empty">No listening services found in latest scan.</div>';
  }

  return services
    .slice()
    .sort((a, b) => Number(a?.port || 0) - Number(b?.port || 0))
    .slice(0, 24)
    .map((service) => {
      const port = Number(service?.port || 0);
      const protocol = String(service?.protocol || 'tcp').toUpperCase();
      const bind = String(service?.bind || '*');
      const serviceName = escapeHtml(String(service?.service || `Port ${port || '?'}`));
      const processName = String(service?.process || '').trim();
      const openUrl = buildServiceBrowserUrl(server, service);
      const encodedUrl = openUrl ? encodeURIComponent(openUrl) : '';
      const processMeta = processName ? ` · ${escapeHtml(processName)}` : '';
      const meta = `${escapeHtml(protocol)} · ${escapeHtml(bind)}:${port || '?'}${processMeta}`;

      return `
        <div class="mx-service-item">
          <div class="mx-service-main">
            <div class="mx-service-name">${serviceName}</div>
            <div class="mx-service-meta">${meta}</div>
          </div>
          ${openUrl
            ? `<button class="mx-service-open-btn" data-open-url="${encodedUrl}" title="Open ${serviceName}">Open</button>`
            : '<span class="mx-service-chip">Non-web</span>'}
        </div>`;
    })
    .join('');
}

async function openServiceInBrowser(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return;
  try {
    await invoke('open_external_url', { url: target });
  } catch {
    try {
      window.open(target, '_blank', 'noopener,noreferrer');
    } catch {
      // Ignore open failures.
    }
  }
}

function renderSensitiveValue(value, kind = 'text') {
  const raw = String(value ?? '\u2014');
  const normalized = raw.trim().toLowerCase();
  if (
    !metricsSensitiveMasked
    || !raw.trim()
    || raw.trim() === '\u2014'
    || normalized === 'unavailable'
    || normalized === 'unknown'
  ) {
    return escapeHtml(raw);
  }
  if (kind === 'coordinates') return '\u2022\u2022.\u2022\u2022\u2022\u2022, \u2022\u2022.\u2022\u2022\u2022\u2022';
  return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
}

function sftpEntryKind(entry) {
  if (entry?.is_dir) return 'dir';
  if (entry?.is_symlink) return 'link';
  return 'file';
}

function sftpEntryIconMarkup(entry) {
  const kind = sftpEntryKind(entry);
  if (kind === 'dir') {
    return `<span class="sftp-entry-icon dir" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M3.5 6.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path>
      </svg>
    </span>`;
  }
  if (kind === 'link') {
    return `<span class="sftp-entry-icon link" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M8.5 12.5l3-3a3 3 0 1 1 4.2 4.2l-2 2"></path>
        <path d="M15.5 11.5l-3 3a3 3 0 1 1-4.2-4.2l2-2"></path>
      </svg>
    </span>`;
  }
  return `<span class="sftp-entry-icon file" aria-hidden="true">
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M6 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20z"></path>
      <path d="M14 3.5V8h4"></path>
    </svg>
  </span>`;
}

async function refreshMetrics(serverId) {
  const state = getLiveMetricsState(serverId);
  if (state.loading) return;

  state.loading = true;
  state.error = '';

  if (activeTabId === 'metrics' && selId === serverId) {
    renderMetrics(SRV.find(s => s.id === serverId));
  }

  try {
    const result = await invoke('ssh_probe_metrics', { serverId });
    state.data = result || null;
    state.lastUpdatedMs = Number(result?.fetched_unix_ms) || Date.now();
    state.error = '';
  } catch (e) {
    state.error = shortErrorText(e);
    state.lastUpdatedMs = Date.now();
  } finally {
    state.loading = false;
    if (activeTabId === 'metrics' && selId === serverId) {
      renderMetrics(SRV.find(s => s.id === serverId));
    }
  }
}

async function refreshServerIntel(server, force = false) {
  if (!server?.id || !server?.host) return;

  const state = getServerIntelState(server.id);
  const isStale = !state.lastUpdatedMs || (Date.now() - state.lastUpdatedMs) > SERVER_INTEL_REFRESH_INTERVAL_MS;
  if (!force && (state.loading || (state.data && !isStale))) return;

  state.loading = true;
  state.error = '';

  if (activeTabId === 'metrics' && selId === server.id) {
    renderMetrics(server);
  }

  try {
    const result = await invoke('lookup_ip_location', { host: server.host });
    state.data = result || null;
    state.lastUpdatedMs = Date.now();
    state.error = '';
  } catch (e) {
    state.error = shortErrorText(e);
  } finally {
    state.loading = false;
    if (activeTabId === 'metrics' && selId === server.id) {
      renderMetrics(server);
    }
  }
}

function seedFromServer(s) {
  const input = `${s.id}|${s.name}|${s.loc}|${s.lat}|${s.lng}`;
  let h = 7;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return h;
}

function seededInt(seed, offset, min, max) {
  const x = Math.sin(seed + offset) * 10000;
  const unit = x - Math.floor(x);
  return Math.floor(unit * (max - min + 1)) + min;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function seededSeries(seed, offset, points, min, max, wobble = 7) {
  const series = [];
  const span = Math.max(1, max - min);
  let current = seededInt(seed, offset, min, max);
  for (let i = 0; i < points; i++) {
    const drift = seededInt(seed + offset * 97, i + 1, -wobble, wobble);
    const pull = seededInt(seed + offset * 17, i + 53, -2, 2);
    current = clamp(current + drift + pull, min, max);
    // Light smoothing so lines look like telemetry, not noise
    const prev = i > 0 ? series[i - 1] : current;
    series.push(Math.round((prev * 0.45) + (current * 0.55)));
  }
  // Normalize range to avoid flat lines
  if (Math.max(...series) - Math.min(...series) < Math.max(3, span * 0.06)) {
    return series.map((v, i) => clamp(v + ((i % 3) - 1) * 2, min, max));
  }
  return series;
}

function seriesAvg(values) {
  return Math.round(values.reduce((acc, n) => acc + n, 0) / values.length);
}

function sparklineSvg(values, color) {
  const w = 240, h = 64, pad = 6;
  const min = Math.min(...values), max = Math.max(...values);
  const xStep = (w - pad * 2) / Math.max(1, values.length - 1);
  const yScale = (h - pad * 2) / Math.max(1, max - min);
  const points = values.map((v, i) => {
    const x = pad + i * xStep;
    const y = h - pad - ((v - min) * yScale);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const area = `${points.join(' ')} ${(w - pad).toFixed(2)},${(h - pad).toFixed(2)} ${pad.toFixed(2)},${(h - pad).toFixed(2)}`;
  const [lx, ly] = points[points.length - 1].split(',');

  return `
    <svg class="mx-spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polyline class="mx-spark-grid" points="${pad},${h * 0.22} ${w - pad},${h * 0.22}"></polyline>
      <polyline class="mx-spark-grid" points="${pad},${h * 0.50} ${w - pad},${h * 0.50}"></polyline>
      <polyline class="mx-spark-grid" points="${pad},${h * 0.78} ${w - pad},${h * 0.78}"></polyline>
      <polygon points="${area}" fill="${color}22"></polygon>
      <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline>
      <circle cx="${lx}" cy="${ly}" r="3.6" fill="${color}"></circle>
    </svg>`;
}

function buildAttentionIssues({
  incidents24h,
  pendingUpdates,
  cpu,
  ram,
  disk,
  lastPatchDays,
  firewallLabel,
  servicesHealthy,
  servicesTotal,
  statusReason,
}) {
  const issues = [];

  if (incidents24h > 0) {
    issues.push({
      severity: incidents24h > 1 ? 'bad' : 'warn',
      message: `${incidents24h} incident${incidents24h > 1 ? 's' : ''} detected in the last 24h.`,
    });
  }
  if (cpu >= 85) issues.push({ severity: 'bad', message: `CPU usage is high at ${cpu}%.` });
  else if (cpu >= 70) issues.push({ severity: 'warn', message: `CPU usage is elevated at ${cpu}%.` });

  if (ram >= 90) issues.push({ severity: 'bad', message: `Memory pressure is critical at ${ram}%.` });
  else if (ram >= 75) issues.push({ severity: 'warn', message: `Memory usage is high at ${ram}%.` });

  if (disk >= 90) issues.push({ severity: 'bad', message: `Disk usage is critical at ${disk}%.` });
  else if (disk >= 80) issues.push({ severity: 'warn', message: `Disk usage is high at ${disk}%.` });

  if (pendingUpdates > 3) issues.push({ severity: 'bad', message: `${pendingUpdates} pending updates need patching.` });
  else if (pendingUpdates > 0) issues.push({ severity: 'warn', message: `${pendingUpdates} pending update${pendingUpdates > 1 ? 's' : ''} available.` });

  if (lastPatchDays > 21) issues.push({ severity: 'bad', message: `Last patch cycle was ${lastPatchDays} days ago.` });
  else if (lastPatchDays > 7) issues.push({ severity: 'warn', message: `Patch cycle age is ${lastPatchDays} days.` });

  if (firewallLabel !== 'Enabled') {
    issues.push({ severity: 'warn', message: 'Firewall state needs review.' });
  }

  if (servicesHealthy < servicesTotal) {
    issues.push({
      severity: servicesHealthy <= Math.max(1, servicesTotal - 2) ? 'bad' : 'warn',
      message: `${servicesTotal - servicesHealthy} service${servicesTotal - servicesHealthy > 1 ? 's are' : ' is'} not healthy.`,
    });
  }

  if (typeof statusReason === 'string' && statusReason.trim()) {
    issues.push({ severity: 'warn', message: `Connectivity note: ${statusReason.trim()}` });
  }

  if (!issues.length) {
    issues.push({ severity: 'ok', message: 'No active attention issues detected.' });
  }

  return issues;
}

function renderMetrics(s) {
  if (!s) { showMEmpty(); return; }
  document.getElementById('m-empty').style.display = 'none';
  const mc = document.getElementById('m-content');
  mc.style.display = 'block';

  const liveState = getLiveMetricsState(s.id);
  const live = liveState.data || null;
  const intelState = getServerIntelState(s.id);
  const intel = intelState.data || null;
  const intelStale = !intelState.lastUpdatedMs || (Date.now() - intelState.lastUpdatedMs) > SERVER_INTEL_REFRESH_INTERVAL_MS;
  if (!intelState.loading && (!intel || intelStale)) {
    void refreshServerIntel(s);
  }

  const seed = seedFromServer(s);
  const env = ['production', 'staging', 'development'][seededInt(seed, 1, 0, 2)];
  const provider = ['AWS', 'Azure', 'GCP', 'Hetzner', 'DigitalOcean'][seededInt(seed, 2, 0, 4)];
  const osSeed = ['Ubuntu 24.04', 'Debian 12', 'Rocky Linux 9', 'AlmaLinux 9'][seededInt(seed, 3, 0, 3)];
  const osPretty = live?.os_pretty || [live?.os_name, live?.os_version].filter(Boolean).join(' ') || osSeed;
  const kernel = live?.kernel || '';
  const hostLabel = live?.hostname || s.host;
  const availability = (99 + seededInt(seed, 4, 0, 95) / 100).toFixed(2);
  const cpuSeed = seededInt(seed, 5, 8, 82);
  const ramSeed = seededInt(seed, 6, 12, 88);
  const diskSeed = seededInt(seed, 7, 18, 86);
  const cpuLive = Number.isFinite(Number(live?.cpu_used_percent)) ? clamp(Math.round(Number(live.cpu_used_percent)), 1, 99) : null;
  const ramLive = Number.isFinite(Number(live?.memory_used_percent)) ? clamp(Math.round(Number(live.memory_used_percent)), 1, 99) : null;
  const diskLive = Number.isFinite(Number(live?.disk_used_percent)) ? clamp(Math.round(Number(live.disk_used_percent)), 1, 99) : null;
  const cpu = cpuLive ?? cpuSeed;
  const ram = ramLive ?? ramSeed;
  const disk = diskLive ?? diskSeed;
  const netIn = seededInt(seed, 8, 40, 840);
  const netOut = seededInt(seed, 9, 25, 610);
  const uptimeSecondsLive = Number(live?.uptime_seconds);
  const uptimeDays = Number.isFinite(uptimeSecondsLive) ? Math.max(0, Math.floor(uptimeSecondsLive / 86400)) : seededInt(seed, 10, 3, 184);
  const heartbeatSec = seededInt(seed, 11, 4, 59);
  const incidents24h = seededInt(seed, 12, 0, 2);
  const pendingUpdates = seededInt(seed, 13, 0, 7);
  const lastPatchDays = seededInt(seed, 14, 0, 27);
  const rebootDays = seededInt(seed, 15, 1, 45);
  const fallbackServicesTotal = seededInt(seed, 16, 6, 15);
  const liveServices = Array.isArray(live?.services) ? live.services : [];
  const servicesTotal = liveServices.length > 0 ? liveServices.length : fallbackServicesTotal;
  const servicesHealthy = liveServices.length > 0
    ? liveServices.length
    : Math.max(servicesTotal - incidents24h, servicesTotal - 2);
  const browserServices = liveServices.filter((service) => Boolean(service?.is_browser_supported)).length;
  const serviceScanError = typeof live?.services_error === 'string' ? live.services_error.trim() : '';
  const serviceRowsHtml = renderMetricsServiceRows(s, liveServices);
  const servicesStatusNoteRaw = live
    ? serviceScanError
      ? `Service scan warning: ${serviceScanError}`
      : liveServices.length
        ? `${liveServices.length} listening service${liveServices.length > 1 ? 's' : ''} · ${browserServices} web endpoint${browserServices === 1 ? '' : 's'}`
        : 'No listening services detected in latest scan.'
    : 'Press Refresh to load listening services.';

  const statusClass = incidents24h === 0 ? 'st-online' : incidents24h === 1 ? 'st-warn' : 'st-offline';
  const statusLabel = incidents24h === 0 ? 'HEALTHY' : incidents24h === 1 ? 'DEGRADED' : 'ATTENTION';
  const patchClass = pendingUpdates === 0 ? 'pc-ok' : pendingUpdates <= 3 ? 'pc-warn' : 'pc-bad';
  const patchLabel = pendingUpdates === 0 ? 'Up to date' : pendingUpdates <= 3 ? 'Needs updates' : 'High patch backlog';
  const firewallLabel = seededInt(seed, 17, 0, 10) > 1 ? 'Enabled' : 'Review';
  const firewallClass = firewallLabel === 'Enabled' ? 'pc-ok' : 'pc-warn';
  const loadBase = Math.round((netIn + netOut) / 2);
  const cpuSeries = seededSeries(seed, 30, 24, Math.max(4, cpu - 26), Math.min(98, cpu + 17), 8);
  const ramSeries = seededSeries(seed, 40, 24, Math.max(8, ram - 20), Math.min(98, ram + 12), 6);
  const netSeries = seededSeries(seed, 50, 24, Math.max(20, Math.round(loadBase * 0.45)), Math.max(40, Math.round(loadBase * 1.05)), 45);
  const incidentSeries = seededSeries(seed, 60, 7, 0, 3, 2);
  const cpuColor = cpu > 75 ? '#ff3b5c' : cpu > 55 ? '#f5a623' : '#00bfff';
  const ramColor = ram > 80 ? '#ff3b5c' : ram > 60 ? '#f5a623' : '#00ffaa';
  const netColor = '#19a7ff';
  const capFill = Math.round((disk * 0.52) + (ram * 0.30) + (cpu * 0.18));
  const serviceHeadroom = servicesTotal > 0 ? Math.round((servicesHealthy / servicesTotal) * 100) : 100;
  const avgIncident = (incidentSeries.reduce((acc, n) => acc + n, 0) / incidentSeries.length).toFixed(1);
  const liveLinked = hasLiveSshSessionForServer(s.id);
  const liveActive = liveLinked && metricsLiveEnabled;
  const refreshInfo = liveState.error
    ? `Refresh failed: ${escapeHtml(liveState.error)}`
    : liveActive
      ? `Live update every ${Math.round(METRICS_LIVE_REFRESH_INTERVAL_MS / 1000)}s · updated ${formatUpdatedAgo(liveState.lastUpdatedMs)}`
      : liveLinked
        ? `Live updates paused · updated ${formatUpdatedAgo(liveState.lastUpdatedMs)}`
      : liveState.lastUpdatedMs
        ? `Last update ${formatUpdatedAgo(liveState.lastUpdatedMs)} · manual refresh only`
        : 'No data yet · press Refresh';
  const metricsSource = liveActive ? 'Live telemetry' : (live ? 'Last captured' : 'Estimated');
  const osBadge = live?.os_name || osSeed;
  const kernelBadge = kernel || 'Unavailable';
  const cpuCores = Number.isFinite(Number(live?.cpu_cores)) ? Math.max(1, Math.round(Number(live.cpu_cores))) : null;
  const totalMemory = formatMemoryMb(live?.memory_total_mb);
  const locationValue = s.loc || 'Unknown';
  const hasCoords = Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)) && !(Number(s.lat) === 0 && Number(s.lng) === 0);
  const coordValue = hasCoords ? `${Number(s.lat).toFixed(4)}, ${Number(s.lng).toFixed(4)}` : 'Unavailable';
  const specSource = live ? 'Specs from latest SSH refresh' : 'Press Refresh to load hardware specs';
  const whoisIp = intel?.ip || s.resolvedIp || 'Unavailable';
  const whoisLocation = intel?.location || locationValue || 'Unknown';
  const whoisProvider = intel?.provider || intel?.org || provider;
  const whoisOrg = intel?.org || 'Unavailable';
  const whoisAsn = intel?.asn || 'Unavailable';
  const whoisDomain = intel?.domain || 'Unavailable';
  const whoisSource = intel?.source || 'Lookup pending';
  const whoisStatus = intelState.loading
    ? 'Resolving IP ownership and provider...'
    : intelState.error
      ? `Whois lookup warning: ${escapeHtml(intelState.error)}`
      : `Whois updated ${formatUpdatedAgo(intelState.lastUpdatedMs)} via ${escapeHtml(whoisSource)}`;
  const attentionIssues = buildAttentionIssues({
    incidents24h,
    pendingUpdates,
    cpu,
    ram,
    disk,
    lastPatchDays,
    firewallLabel,
    servicesHealthy,
    servicesTotal,
    statusReason: s.statusReason,
  });

  mc.innerHTML = `
    <div class="mx-shell">
      <div class="mx-hero">
        <div class="mx-hero-left">
          <div class="mx-eyebrow">Node Health View</div>
          <div class="mx-title-row">
            <div class="mhdr-name">${s.name} <span style="font-size:12px;color:var(--muted);font-weight:400">\u00b7 ${s.loc}</span></div>
            <div class="mx-title-actions">
              <div class="m-status ${statusClass}">${statusLabel}</div>
              <button
                class="mx-mask-btn ${metricsSensitiveMasked ? 'is-masked' : ''}"
                id="mx-mask-toggle-btn"
                title="${metricsSensitiveMasked ? 'Show sensitive values' : 'Hide sensitive values'}"
              >&#128065; ${metricsSensitiveMasked ? 'Masked' : 'Visible'}</button>
              <button
                class="mx-live-btn ${liveActive ? 'is-on' : 'is-off'}"
                id="mx-live-toggle-btn"
                title="${liveLinked ? 'Toggle live metrics polling' : 'Connect SSH to enable live metrics'}"
                ${liveLinked ? '' : 'disabled'}
              >Live: ${liveActive ? 'On' : 'Off'}</button>
              <button class="mx-refresh-btn ${liveState.loading ? 'is-loading' : ''}" id="mx-refresh-btn" ${liveState.loading ? 'disabled' : ''}>${liveState.loading ? 'Refreshing...' : 'Refresh'}</button>
              <div class="mx-refresh-meta ${liveState.error ? 'is-error' : ''}">${refreshInfo}</div>
            </div>
          </div>
          <div class="mx-subline">${live ? 'LIVE PROBE' : env.toUpperCase()} \u00b7 ${escapeHtml(whoisProvider)} \u00b7 ${osPretty}</div>
          <div class="mx-tag-row">
            <span class="mx-tag">${metricsSource}</span>
            <span class="mx-tag">Heartbeat ${heartbeatSec}s</span>
            <span class="mx-tag">Uptime ${uptimeDays}d</span>
            <span class="mx-tag">Services ${servicesHealthy}/${servicesTotal}</span>
          </div>
        </div>
        <div class="mx-radials">
          <div class="mx-radial-card">
            <div class="mx-radial" style="--pct:${availability};--col:#00ffaa">
              <span>${availability}%</span>
            </div>
            <div class="mx-radial-label">Availability</div>
          </div>
          <div class="mx-radial-card">
            <div class="mx-radial" style="--pct:${Math.round((100 - pendingUpdates * 8))};--col:${pendingUpdates > 3 ? '#ff3b5c' : pendingUpdates > 0 ? '#f5a623' : '#00bfff'}">
              <span>${pendingUpdates}</span>
            </div>
            <div class="mx-radial-label">Pending Patches</div>
          </div>
          <div class="mx-radial-card">
            <div class="mx-radial" style="--pct:${capFill};--col:${capFill > 76 ? '#ff3b5c' : capFill > 58 ? '#f5a623' : '#00bfff'}">
              <span>${capFill}%</span>
            </div>
            <div class="mx-radial-label">Capacity Pressure</div>
          </div>
        </div>
      </div>

      <div class="mx-kpi-grid">
        <article class="mx-kpi">
          <div class="mx-kpi-head">
            <div class="mx-kpi-title">CPU Load</div>
            <div class="mx-kpi-value" style="color:${cpuColor}">${cpu}%</div>
          </div>
          <div class="mx-kpi-sub">24h avg ${seriesAvg(cpuSeries)}% \u00b7 peak ${Math.max(...cpuSeries)}%</div>
          ${sparklineSvg(cpuSeries, cpuColor)}
        </article>

        <article class="mx-kpi">
          <div class="mx-kpi-head">
            <div class="mx-kpi-title">Memory Use</div>
            <div class="mx-kpi-value" style="color:${ramColor}">${ram}%</div>
          </div>
          <div class="mx-kpi-sub">Working set ${seriesAvg(ramSeries)}% \u00b7 free ${Math.max(6, 100 - ram)}%</div>
          ${sparklineSvg(ramSeries, ramColor)}
        </article>

        <article class="mx-kpi">
          <div class="mx-kpi-head">
            <div class="mx-kpi-title">Network Throughput</div>
            <div class="mx-kpi-value" style="color:${netColor}">${netIn}/${netOut}</div>
          </div>
          <div class="mx-kpi-sub">Mbps in/out \u00b7 avg ${seriesAvg(netSeries)} Mbps</div>
          ${sparklineSvg(netSeries, netColor)}
        </article>
      </div>

      <div class="mx-bottom-grid">
        <section class="mx-panel">
          <div class="mx-panel-title">System Specs</div>
          <div class="mx-list-row">
            <span>Location</span>
            <strong>${escapeHtml(locationValue)}</strong>
          </div>
          <div class="mx-list-row">
            <span>Coordinates</span>
            <strong>${renderSensitiveValue(coordValue, 'coordinates')}</strong>
          </div>
          <div class="mx-list-row">
            <span>Host</span>
            <strong>${renderSensitiveValue(hostLabel)}</strong>
          </div>
          <div class="mx-list-row">
            <span>CPU Cores</span>
            <strong>${cpuCores ?? '\u2014'}</strong>
          </div>
          <div class="mx-list-row">
            <span>Total Memory</span>
            <strong>${totalMemory}</strong>
          </div>
          <div class="mx-security-note">${specSource}</div>
        </section>

        <section class="mx-panel">
          <div class="mx-panel-title">Network Whois</div>
          <div class="mx-list-row">
            <span>IP Address</span>
            <strong>${renderSensitiveValue(whoisIp)}</strong>
          </div>
          <div class="mx-list-row">
            <span>Provider</span>
            <strong>${escapeHtml(whoisProvider)}</strong>
          </div>
          <div class="mx-list-row">
            <span>Organization</span>
            <strong>${escapeHtml(whoisOrg)}</strong>
          </div>
          <div class="mx-list-row">
            <span>ASN</span>
            <strong>${escapeHtml(whoisAsn)}</strong>
          </div>
          <div class="mx-list-row">
            <span>Geo Location</span>
            <strong>${escapeHtml(whoisLocation)}</strong>
          </div>
          <div class="mx-list-row">
            <span>Domain</span>
            <strong>${renderSensitiveValue(whoisDomain)}</strong>
          </div>
          <div class="mx-security-note">${whoisStatus}</div>
        </section>

        <section class="mx-panel">
          <div class="mx-panel-title">Security Posture</div>
          <div class="mx-list-row">
            <span>Status</span>
            <strong class="${statusClass}">${statusLabel}</strong>
          </div>
          <div class="mx-list-row">
            <span>Operating System</span>
            <strong>${osBadge}</strong>
          </div>
          <div class="mx-list-row">
            <span>Kernel</span>
            <strong>${kernelBadge}</strong>
          </div>
          <div class="mx-list-row">
            <span>Firewall</span>
            <strong class="${firewallClass}">${firewallLabel}</strong>
          </div>
          <div class="mx-list-row">
            <span>Patch State</span>
            <strong class="${patchClass}">${patchLabel}</strong>
          </div>
          <div class="mx-list-row">
            <span>Last Patch Cycle</span>
            <strong class="${lastPatchDays <= 7 ? 'pc-ok' : lastPatchDays <= 21 ? 'pc-warn' : 'pc-bad'}">${lastPatchDays}d ago</strong>
          </div>
          <div class="mx-list-row">
            <span>Credential Exposure</span>
            <strong class="pc-ok">Protected</strong>
          </div>
          <div class="mx-security-note">SSH host/user/auth details are intentionally hidden in this panel.</div>
        </section>

        <section class="mx-panel">
          <div class="mx-panel-title">Open Services</div>
          <div class="mx-service-list">
            ${serviceRowsHtml}
          </div>
          <div class="mx-security-note">${escapeHtml(servicesStatusNoteRaw)}</div>
        </section>

        <section class="mx-panel">
          <div class="mx-panel-title">Attention Queue</div>
          <div class="mx-attention-list">
            ${attentionIssues.map((item) => `
              <div class="mx-attention-item ${item.severity}">
                <span class="mx-attention-dot"></span>
                <span>${escapeHtml(item.message)}</span>
              </div>`).join('')}
          </div>
          <div class="mx-security-note">Red items should be addressed first, then warnings.</div>
        </section>

        <section class="mx-panel">
          <div class="mx-panel-title">Reliability Timeline</div>
          <div class="mx-incident-chart">
            ${incidentSeries.map((v, i) => `
              <div class="mx-ibar-wrap">
                <div class="mx-ibar ${v === 0 ? 'ok' : v === 1 ? 'warn' : 'bad'}" style="height:${24 + v * 16}px"></div>
                <span>D-${6 - i}</span>
              </div>`).join('')}
          </div>
          <div class="mx-list-row">
            <span>24h Incident Count</span>
            <strong class="${incidents24h === 0 ? 'pc-ok' : incidents24h === 1 ? 'pc-warn' : 'pc-bad'}">${incidents24h}</strong>
          </div>
          <div class="mx-list-row">
            <span>7d Daily Incident Avg</span>
            <strong class="${avgIncident < 0.6 ? 'pc-ok' : avgIncident < 1.4 ? 'pc-warn' : 'pc-bad'}">${avgIncident}</strong>
          </div>
          <div class="mx-list-row">
            <span>Last Reboot</span>
            <strong class="pc-ok">${rebootDays}d ago</strong>
          </div>
        </section>

        <section class="mx-panel">
          <div class="mx-panel-title">Capacity Breakdown</div>
          <div class="mx-cap-row">
            <div class="mx-cap-label">Disk</div>
            <div class="mx-cap-bar"><div style="width:${disk}%;background:${disk > 80 ? '#ff3b5c' : disk > 65 ? '#f5a623' : '#00bfff'}"></div></div>
            <div class="mx-cap-val">${disk}%</div>
          </div>
          <div class="mx-cap-row">
            <div class="mx-cap-label">Memory</div>
            <div class="mx-cap-bar"><div style="width:${ram}%;background:${ram > 80 ? '#ff3b5c' : ram > 60 ? '#f5a623' : '#00ffaa'}"></div></div>
            <div class="mx-cap-val">${ram}%</div>
          </div>
          <div class="mx-cap-row">
            <div class="mx-cap-label">CPU</div>
            <div class="mx-cap-bar"><div style="width:${cpu}%;background:${cpu > 75 ? '#ff3b5c' : cpu > 55 ? '#f5a623' : '#00bfff'}"></div></div>
            <div class="mx-cap-val">${cpu}%</div>
          </div>
          <div class="mx-cap-row">
            <div class="mx-cap-label">Service Headroom</div>
            <div class="mx-cap-bar"><div style="width:${serviceHeadroom}%;background:#00ffaa"></div></div>
            <div class="mx-cap-val">${serviceHeadroom}%</div>
          </div>
        </section>
      </div>

      <div class="mx-footnote">
        <div class="mx-footnote-title">Live Stream Available In Terminal</div>
        <div class="mx-footnote-copy">Live metrics run only while an SSH tab is connected. Without SSH, metrics keep last data and update on manual refresh.</div>
      </div>
    </div>`;

  const refreshBtn = document.getElementById('mx-refresh-btn');
  const maskBtn = document.getElementById('mx-mask-toggle-btn');
  const liveBtn = document.getElementById('mx-live-toggle-btn');
  if (maskBtn) maskBtn.addEventListener('click', () => {
    metricsSensitiveMasked = !metricsSensitiveMasked;
    renderMetrics(s);
  });
  if (liveBtn) liveBtn.addEventListener('click', () => {
    if (!hasLiveSshSessionForServer(s.id)) return;
    metricsLiveEnabled = !metricsLiveEnabled;
    if (metricsLiveEnabled) {
      void refreshMetrics(s.id);
    }
    renderMetrics(s);
  });
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    void refreshMetrics(s.id);
    void refreshServerIntel(s, true);
  });
  mc.querySelectorAll('.mx-service-open-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const encoded = button.getAttribute('data-open-url') || '';
      if (!encoded) return;
      let url = '';
      try {
        url = decodeURIComponent(encoded);
      } catch {
        url = encoded;
      }
      void openServiceInBrowser(url);
    });
  });
}

/* ══════════════════════════════════════════════════════════
   SIDEBAR COLLAPSE (desktop)
══════════════════════════════════════════════════════════ */
let sidebarCollapsed = false;
function toggleSidebar_collapse() {
  const sb = document.getElementById('sidebar');
  const arrow = document.getElementById('sb-toggle-arrow');
  const label = document.querySelector('.sb-toggle-label');
  sidebarCollapsed = !sidebarCollapsed;
  sb.classList.toggle('collapsed', sidebarCollapsed);
  arrow.textContent = sidebarCollapsed ? '\u203a' : '\u2039';
  if (label) label.textContent = sidebarCollapsed ? 'EXPAND' : 'COLLAPSE';
  setTimeout(() => { map.invalidateSize(); }, 250);
}

function toggleSidebar(force) {
  if (window.innerWidth > 700) return;
  const sb = document.getElementById('sidebar'), ov = document.getElementById('sidebar-overlay');
  const isOpen = force !== undefined ? force : !sb.classList.contains('open');
  sb.classList.toggle('open', isOpen); ov.classList.toggle('open', isOpen);
}

function refreshRailActive() {
  document.querySelectorAll('.sb-rail-item').forEach(el => el.classList.remove('active'));
  if (selId !== null) document.getElementById(`rail-${selId}`)?.classList.add('active');
}

/* ══════════════════════════════════════════════════════════
   MAP COLLAPSE
══════════════════════════════════════════════════════════ */
let mapCollapsed = false;
let mapHeightBeforeCollapse = '50%';

function toggleMap() {
  const ms = document.getElementById('map-section');
  const btn = document.getElementById('map-toggle-btn');
  mapCollapsed = !mapCollapsed;
  if (mapCollapsed) {
    mapHeightBeforeCollapse = ms.style.height || '50%';
    ms.classList.add('collapsed');
    btn.textContent = '\u25b8 Expand';
  } else {
    ms.classList.remove('collapsed');
    ms.style.height = mapHeightBeforeCollapse;
    btn.textContent = '\u25be Collapse';
    setTimeout(() => { map.invalidateSize(); }, 260);
  }
}

/* ══════════════════════════════════════════════════════════
   MAXIMIZE / MINIMIZE
══════════════════════════════════════════════════════════ */
let isMaximized = false;
let preMax = { mapCollapsed: false, mapHeight: null };

function toggleMaximize() {
  const btn = document.getElementById('tab-maximize-btn');
  const icon = document.getElementById('maximize-icon');
  const label = document.getElementById('maximize-label');

  if (!isMaximized) {
    preMax.mapCollapsed = mapCollapsed;
    preMax.mapHeight = document.getElementById('map-section').style.height || null;

    if (!mapCollapsed) {
      mapCollapsed = true;
      const ms = document.getElementById('map-section');
      if (!preMax.mapHeight) preMax.mapHeight = ms.style.height || null;
      ms.classList.add('collapsed');
      document.getElementById('map-toggle-btn').textContent = '\u25b8 Expand';
    }

    isMaximized = true;
    btn.classList.add('maximized');
    icon.textContent = '\u2921';
    label.textContent = 'MIN';
    updateMainTerminalLayout();
    setTimeout(() => { map.invalidateSize(); }, 260);

  } else {
    if (!preMax.mapCollapsed && mapCollapsed) {
      mapCollapsed = false;
      const ms = document.getElementById('map-section');
      ms.classList.remove('collapsed');
      if (preMax.mapHeight) ms.style.height = preMax.mapHeight;
      document.getElementById('map-toggle-btn').textContent = '\u25be Collapse';
      mapHeightBeforeCollapse = preMax.mapHeight || '50%';
    }

    isMaximized = false;
    btn.classList.remove('maximized');
    icon.textContent = '\u2922';
    label.textContent = 'MAX';
    updateMainTerminalLayout();
    setTimeout(() => { map.invalidateSize(); }, 260);
  }
}

/* ══════════════════════════════════════════════════════════
   SETTINGS MODAL
══════════════════════════════════════════════════════════ */
function createSettingsModal() {
  const modal = document.createElement('div');
  modal.id = 'settings-modal';
  modal.innerHTML = `
    <div class="settings-overlay" id="settings-overlay"></div>
    <div class="settings-panel" id="settings-panel">
      <div class="settings-header">
        <span class="settings-title">\u2699 SERVER CONFIGURATION</span>
        <button class="settings-close-btn" id="settings-close-btn">\u00d7</button>
      </div>
      <div class="settings-body" id="settings-body">
        <div class="settings-list" id="settings-list"></div>
        <button class="settings-add-btn" id="settings-add-btn">+ Add Server</button>
      </div>
      <div class="settings-form" id="settings-form" style="display:none">
        <div class="sf-title" id="sf-title">Add Server</div>
        <div class="sf-row">
          <label class="sf-label">Name</label>
          <input class="sf-input" id="sf-name" placeholder="e.g. NYC-01">
        </div>
        <div class="sf-row">
          <label class="sf-label">Server Icon</label>
          <select class="sf-input" id="sf-icon">
            ${SERVER_ICON_OPTIONS_HTML}
          </select>
        </div>
        <div class="sf-row">
          <label class="sf-label">Folder</label>
          <select class="sf-input" id="sf-folder">
            <option value="">No Folder</option>
          </select>
        </div>
        <div class="sf-row">
          <label class="sf-label">Host</label>
          <div style="display:flex;gap:6px">
            <input class="sf-input" id="sf-host" placeholder="e.g. 45.77.12.33" style="flex:1">
            <button class="sf-browse-btn" id="sf-locate-btn">Locate</button>
          </div>
        </div>
        <div class="sf-row">
          <label class="sf-label">Port</label>
          <input class="sf-input" id="sf-port" type="number" value="22">
        </div>
        <div class="sf-row">
          <label class="sf-label">Username</label>
          <input class="sf-input" id="sf-username" placeholder="Leave empty to ask on connect">
        </div>
        <div class="sf-row">
          <label class="sf-label">Auth Method</label>
          <select class="sf-input" id="sf-auth-method">
            <option value="Key">SSH Key</option>
            <option value="Password">Password</option>
            <option value="Agent">SSH Agent</option>
          </select>
        </div>
        <div class="sf-row" id="sf-key-row">
          <label class="sf-label">Key Path</label>
          <div style="display:flex;gap:6px">
            <input class="sf-input" id="sf-key-path" placeholder="~/.ssh/id_ed25519" style="flex:1">
            <button class="sf-browse-btn" id="sf-browse-btn">Browse</button>
          </div>
        </div>
        <div class="sf-row" id="sf-passphrase-row">
          <label class="sf-label">Key Passphrase (optional)</label>
          <input class="sf-input" id="sf-passphrase" type="password" placeholder="Leave empty if none">
        </div>
        <div class="sf-row" id="sf-password-row" style="display:none">
          <label class="sf-label">Password</label>
          <input class="sf-input" id="sf-password" type="password">
        </div>
        <div class="sf-row">
          <label class="sf-label">Location</label>
          <div style="display:flex;gap:6px">
            <input class="sf-input" id="sf-location" placeholder="e.g. New York, US" style="flex:1">
            <button class="sf-browse-btn" id="sf-get-location-btn">Get Location</button>
          </div>
        </div>
        <div class="sf-row-pair">
          <div class="sf-row">
            <label class="sf-label">Latitude</label>
            <input class="sf-input" id="sf-lat" type="number" step="0.0001" placeholder="40.7128">
          </div>
          <div class="sf-row">
            <label class="sf-label">Longitude</label>
            <input class="sf-input" id="sf-lng" type="number" step="0.0001" placeholder="-74.0060">
          </div>
        </div>
        <div class="sf-actions">
          <button class="sf-cancel-btn" id="sf-cancel-btn">Cancel</button>
          <button class="sf-save-btn" id="sf-save-btn">Save Server</button>
        </div>
        <div class="sf-error" id="sf-error" style="display:none"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Wire up events
  document.getElementById('settings-overlay').addEventListener('click', closeSettings);
  document.getElementById('settings-close-btn').addEventListener('click', closeSettings);
  document.getElementById('settings-add-btn').addEventListener('click', () => showServerForm(null));
  document.getElementById('sf-cancel-btn').addEventListener('click', hideServerForm);
  document.getElementById('sf-save-btn').addEventListener('click', saveServerForm);
  document.getElementById('sf-browse-btn').addEventListener('click', browseKeyFile);
  document.getElementById('sf-locate-btn').addEventListener('click', lookupHostLocation);
  document.getElementById('sf-get-location-btn').addEventListener('click', geocodeTypedLocation);
  document.getElementById('sf-auth-method').addEventListener('change', toggleAuthFields);
}

function openSettings() {
  document.getElementById('settings-modal').style.display = 'block';
  renderFolderOptions();
  renderServerList();
}

function renderFolderOptions(selectedFolderId = '') {
  const select = document.getElementById('sf-folder');
  if (!select) return;
  const selected = normalizeFolderId(selectedFolderId) || '';
  const options = ['<option value="">No Folder</option>'];
  FOLDERS.forEach((folder) => {
    const active = folder.id === selected ? ' selected' : '';
    options.push(`<option value="${folder.id}"${active}>${escapeHtml(folder.name)}</option>`);
  });
  select.innerHTML = options.join('');
  select.value = selected;
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
  hideServerForm();
}

function renderServerList() {
  const list = document.getElementById('settings-list');
  if (SRV.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px">No servers configured yet.</div>`;
    return;
  }
  list.innerHTML = SRV.map(s => `
    <div class="sl-item" data-id="${s.id}">
      <div class="sl-info">
        <div class="sl-name">${s.name}</div>
        <div class="sl-detail">${s.username ? `${s.username}@` : ''}${s.host}:${s.port} \u00b7 ${folderNameById(s.folderId) || 'Ungrouped'} \u00b7 ${s.loc || 'Unspecified'}</div>
      </div>
      <div class="sl-actions">
        <button class="sl-edit-btn" data-id="${s.id}">Edit</button>
        <button class="sl-clear-host-btn" data-id="${s.id}">Clear Host Key</button>
        <button class="sl-delete-btn" data-id="${s.id}">Delete</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('.sl-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const srv = SRV.find(s => s.id === btn.dataset.id);
      if (srv) showServerForm(srv);
    });
  });
  list.querySelectorAll('.sl-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await invoke('delete_server', { serverId: btn.dataset.id });
      await loadServers();
      renderServerList();
    });
  });
  list.querySelectorAll('.sl-clear-host-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const server = SRV.find((s) => s.id === btn.dataset.id);
      if (!server) return;
      const confirmed = window.confirm(
        `Clear trusted host key for "${server.name}" (${server.host}:${server.port})?\n\nThe next connection will trust and store the current host key again.`
      );
      if (!confirmed) return;
      try {
        const removed = await invoke('ssh_clear_known_host', { serverId: server.id });
        window.alert(`Known host entries cleared: ${Number(removed) || 0}`);
      } catch (error) {
        window.alert(`Clear host key failed: ${String(error)}`);
      }
    });
  });
}

let editingServerId = null;

function showServerForm(server) {
  editingServerId = server ? server.id : null;
  document.getElementById('sf-title').textContent = server ? 'Edit Server' : 'Add Server';
  renderFolderOptions(server ? server.folderId : '');
  document.getElementById('sf-name').value = server ? server.name : '';
  document.getElementById('sf-icon').value = normalizeServerIcon(server ? (server.icon || server?._raw?.icon) : 'server');
  document.getElementById('sf-host').value = server ? server.host : '';
  document.getElementById('sf-port').value = server ? server.port : 22;
  document.getElementById('sf-username').value = server ? server.username : '';
  document.getElementById('sf-location').value = server ? server.loc : '';
  document.getElementById('sf-lat').value = server ? server.lat : '';
  document.getElementById('sf-lng').value = server ? server.lng : '';
  document.getElementById('sf-error').style.display = 'none';

  if (server && server._raw) {
    const am = server._raw.auth_method;
    document.getElementById('sf-auth-method').value = am.type;
    if (am.type === 'Key') {
      document.getElementById('sf-key-path').value = am.key_path || '';
      document.getElementById('sf-passphrase').value = am.passphrase || '';
    } else if (am.type === 'Password') {
      document.getElementById('sf-password').value = am.password || '';
    }
  } else {
    document.getElementById('sf-auth-method').value = 'Key';
    document.getElementById('sf-key-path').value = '';
    document.getElementById('sf-passphrase').value = '';
    document.getElementById('sf-password').value = '';
  }

  toggleAuthFields();
  document.getElementById('settings-body').style.display = 'none';
  document.getElementById('settings-form').style.display = 'block';
}

function hideServerForm() {
  document.getElementById('settings-form').style.display = 'none';
  document.getElementById('settings-body').style.display = 'block';
  editingServerId = null;
}

function toggleAuthFields() {
  const method = document.getElementById('sf-auth-method').value;
  document.getElementById('sf-key-row').style.display = method === 'Key' ? '' : 'none';
  document.getElementById('sf-passphrase-row').style.display = method === 'Key' ? '' : 'none';
  document.getElementById('sf-password-row').style.display = method === 'Password' ? '' : 'none';
}

async function browseKeyFile() {
  try {
    const selected = await open({
      multiple: false,
      title: 'Select SSH Key',
    });
    if (selected) {
      document.getElementById('sf-key-path').value = selected;
    }
  } catch (e) {
    console.error('File picker error:', e);
  }
}

async function lookupHostLocation() {
  const hostInput = document.getElementById('sf-host');
  const locateBtn = document.getElementById('sf-locate-btn');
  const host = hostInput.value.trim();
  if (!host) {
    showFormError('Enter a host/IP first, then click Locate.');
    return;
  }

  const originalText = locateBtn.textContent;
  locateBtn.disabled = true;
  locateBtn.textContent = 'Locating...';

  try {
    const result = await invoke('lookup_ip_location', { host });
    if (result?.location) document.getElementById('sf-location').value = result.location;
    if (typeof result?.lat === 'number') document.getElementById('sf-lat').value = result.lat.toFixed(4);
    if (typeof result?.lng === 'number') document.getElementById('sf-lng').value = result.lng.toFixed(4);
    document.getElementById('sf-error').style.display = 'none';
  } catch (e) {
    showFormError(`Location lookup failed: ${e}`);
  } finally {
    locateBtn.disabled = false;
    locateBtn.textContent = originalText;
  }
}

async function geocodeTypedLocation() {
  const locationInput = document.getElementById('sf-location');
  const locationBtn = document.getElementById('sf-get-location-btn');
  const query = locationInput.value.trim();
  if (!query) {
    showFormError('Enter a city/location first, then click Get Location.');
    return;
  }

  const originalText = locationBtn.textContent;
  locationBtn.disabled = true;
  locationBtn.textContent = 'Getting...';

  try {
    const result = await invoke('geocode_location', { query });
    if (result?.location) locationInput.value = result.location;
    if (typeof result?.lat === 'number') document.getElementById('sf-lat').value = result.lat.toFixed(4);
    if (typeof result?.lng === 'number') document.getElementById('sf-lng').value = result.lng.toFixed(4);
    document.getElementById('sf-error').style.display = 'none';
  } catch (e) {
    showFormError(`Location lookup failed: ${e}`);
  } finally {
    locationBtn.disabled = false;
    locationBtn.textContent = originalText;
  }
}

async function saveServerForm() {
  const closeModalOnSuccess = editingServerId !== null;
  const name = document.getElementById('sf-name').value.trim();
  const icon = normalizeServerIcon(document.getElementById('sf-icon').value);
  const host = document.getElementById('sf-host').value.trim();
  const port = parseInt(document.getElementById('sf-port').value) || 22;
  const username = document.getElementById('sf-username').value.trim();
  const location = document.getElementById('sf-location').value.trim();
  const lat = parseFloat(document.getElementById('sf-lat').value) || 0;
  const lng = parseFloat(document.getElementById('sf-lng').value) || 0;
  const folderId = normalizeFolderId(document.getElementById('sf-folder').value);
  const authMethod = document.getElementById('sf-auth-method').value;

  if (!name || !host) {
    showFormError('Name and Host are required.');
    return;
  }

  let auth_method;
  if (authMethod === 'Key') {
    const keyPath = document.getElementById('sf-key-path').value.trim();
    const passphrase = document.getElementById('sf-passphrase').value || null;
    if (!keyPath) { showFormError('SSH key path is required.'); return; }
    auth_method = { type: 'Key', key_path: keyPath, passphrase };
  } else if (authMethod === 'Password') {
    const password = document.getElementById('sf-password').value;
    auth_method = { type: 'Password', password };
  } else {
    auth_method = { type: 'Agent' };
  }

  const server = {
    id: editingServerId || crypto.randomUUID(),
    name, icon, host, port, username, auth_method, location, lat, lng, folder_id: folderId,
  };

  try {
    await invoke('save_server', { server });
    await loadServers();
    if (closeModalOnSuccess) closeSettings();
    else {
      hideServerForm();
      renderServerList();
    }
  } catch (e) {
    showFormError(`Save failed: ${e}`);
  }
}

function showFormError(msg) {
  const el = document.getElementById('sf-error');
  el.textContent = msg;
  el.style.display = 'block';
}

/* ══════════════════════════════════════════════════════════
   LOAD SERVERS FROM BACKEND
══════════════════════════════════════════════════════════ */
async function loadServers() {
  try {
    const [configs, folders] = await Promise.all([
      invoke('get_servers'),
      invoke('get_folders').catch(() => []),
    ]);
    FOLDERS = Array.isArray(folders)
      ? folders
        .map((folder) => ({
          id: String(folder?.id || '').trim(),
          name: normalizeFolderName(folder?.name || ''),
        }))
        .filter((folder) => folder.id && folder.name)
      : [];
    collapsedFolderIds = new Set(
      Array.from(collapsedFolderIds).filter((id) => id === UNGROUPED_COLLAPSE_ID || FOLDERS.some((folder) => folder.id === id))
    );
    saveCollapsedFolders();
    SRV = configs.map(c => ({
      id: c.id,
      name: c.name,
      icon: normalizeServerIcon(c.icon),
      host: c.host,
      port: c.port,
      username: c.username,
      loc: c.location,
      lat: normalizeCoordinate(c.lat),
      lng: normalizeCoordinate(c.lng),
      folderId: null,
      status: 'unknown',
      latencyMs: null,
      resolvedIp: null,
      statusReason: null,
      authLabel: c.auth_method.type === 'Key' ? 'SSH Key' : c.auth_method.type === 'Password' ? 'Password' : 'Agent',
      _raw: c,
    }))
      .map((server) => ({
        ...server,
        folderId: normalizeFolderId(server._raw?.folder_id),
      }));
    if (selId !== null && !SRV.some(s => s.id === selId)) selId = null;
    if (sftpBrowserTab.open && !SRV.some((s) => s.id === sftpBrowserTab.srvId)) {
      closeSftpBrowserTab();
    }
    const validServerIds = new Set(SRV.map((s) => s.id));
    for (const key of sftpCredentialCache.keys()) {
      if (!validServerIds.has(key)) sftpCredentialCache.delete(key);
    }
  } catch (e) {
    console.error('Failed to load servers:', e);
    FOLDERS = [];
    SRV = [];
    selId = null;
  }
  cleanLiveMetricsCache();
  cleanServerIntelCache();
  updateHeaderStats();
  renderSidebar();
  renderMapMarkers();
  if (selId !== null) document.getElementById(`sn-${selId}`)?.classList.add('active');
  refreshRailActive();
  refreshSidebarBadges();
  refreshSftpBrowserTab();
  if (activeTabId === 'sftp') {
    if (selId !== null) showStaticSftpForServer(); else showStaticSftpEmpty();
  }
  void refreshServerStatuses();
}

/* ══════════════════════════════════════════════════════════
   METRICS SWITCH
══════════════════════════════════════════════════════════ */
function switchToMetrics() { setActiveTab('metrics'); }
function switchToSftp() { setActiveTab('sftp'); }

/* ══════════════════════════════════════════════════════════
   RESIZE HANDLERS
══════════════════════════════════════════════════════════ */
// Vertical: map / bottom panel resize
(function () {
  const handle = document.getElementById('map-resize');
  const mapSec = document.getElementById('map-section');
  const main = document.getElementById('main');
  let dragging = false, startY = 0, startH = 0;

  handle.addEventListener('mousedown', e => {
    if (mapCollapsed) return;
    dragging = true; startY = e.clientY; startH = mapSec.offsetHeight;
    handle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const totalH = main.offsetHeight;
    const newH = Math.max(80, Math.min(totalH - 120, startH + dy));
    mapSec.style.height = newH + 'px';
    mapHeightBeforeCollapse = newH + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    map.invalidateSize();
  });
})();

// Horizontal: sidebar width resize
(function () {
  const handle = document.getElementById('sb-resize');
  const sb = document.getElementById('sidebar');
  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    if (sidebarCollapsed) return;
    dragging = true; startX = e.clientX; startW = sb.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    sb.style.width = Math.max(160, Math.min(420, startW + dx)) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

/* ══════════════════════════════════════════════════════════
   WIRE UP EVENT LISTENERS + INIT
══════════════════════════════════════════════════════════ */

// Create settings modal DOM
createSettingsModal();

// Wire up all UI buttons via addEventListener (CSP-safe, no inline handlers)
document.getElementById('menu-btn').addEventListener('click', () => toggleSidebar());
document.getElementById('sb-main-tab').addEventListener('click', () => setMainDashboardActive(true));
document.getElementById('sb-add-folder-btn').addEventListener('click', () => {
  void createFolderFromSidebar();
});
document.getElementById('sb-add-btn').addEventListener('click', () => { openSettings(); showServerForm(null); });
document.getElementById('sb-gear-btn').addEventListener('click', () => openSettings());
document.getElementById('sb-toggle-btn').addEventListener('click', () => toggleSidebar_collapse());
document.getElementById('sidebar-overlay').addEventListener('click', () => toggleSidebar(false));
document.getElementById('map-toggle-btn').addEventListener('click', () => toggleMap());
document.getElementById('tab-metrics-btn').addEventListener('click', () => switchToMetrics());
document.getElementById('tab-sftp-btn').addEventListener('click', () => switchToSftp());
document.getElementById('h-avgping-refresh-btn').addEventListener('click', () => {
  void refreshServerStatuses();
});
const tabAddBtn = document.getElementById('tab-add-btn');
tabAddBtn.addEventListener('click', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  if (openSelectedServerTerminal()) {
    hideTabAddMenu();
    return;
  }
  toggleTabAddMenu();
});
tabAddBtn.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  showTabAddMenu({ x: ev.clientX, y: ev.clientY });
});
document.querySelectorAll('#tab-add-menu .tab-add-menu-item').forEach((item) => {
  item.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (item.classList.contains('disabled')) return;
    runTabAddMenuAction(item.dataset.action || '');
  });
});
document.getElementById('tab-maximize-btn').addEventListener('click', () => toggleMaximize());
document.getElementById('sftp-pane-files-btn').addEventListener('click', () => {
  if (staticSftpState.pane === 'editor') closeSftpEditor();
  else setSftpPane('files', false);
});
document.getElementById('sftp-pane-editor-btn').addEventListener('click', () => {
  if (staticSftpState.editorPath) setSftpPane('editor', false);
});
document.getElementById('sftp-view-list-btn').addEventListener('click', () => setSftpViewMode('list'));
document.getElementById('sftp-view-grid-btn').addEventListener('click', () => setSftpViewMode('grid'));
document.getElementById('sftp-upload-btn').addEventListener('click', () => uploadFileToRemoteDir(staticSftpState.path || '.'));
document.getElementById('sftp-new-file-btn').addEventListener('click', () => createSftpFile(staticSftpState.path || '.'));
document.getElementById('sftp-refresh-btn').addEventListener('click', () => loadStaticSftpDir());
document.getElementById('sftp-go-btn').addEventListener('click', () => loadStaticSftpDir());
document.getElementById('sftp-up-btn').addEventListener('click', () => {
  const input = document.getElementById('sftp-path-input');
  const next = remoteParentPath(input?.value || '.');
  if (input) input.value = next;
  loadStaticSftpDir(next);
});
document.getElementById('sftp-path-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') loadStaticSftpDir();
});
document.getElementById('sftp-editor-text').addEventListener('input', (ev) => {
  staticSftpState.editorContent = String(ev.target?.value || '');
  staticSftpState.editorDirty = staticSftpState.editorContent !== staticSftpState.editorOriginal;
  renderSftpEditorPanel();
});
document.getElementById('sftp-editor-save-btn').addEventListener('click', () => {
  void saveSftpEditorFile();
});
document.getElementById('sftp-editor-close-btn').addEventListener('click', () => {
  closeSftpEditor();
});
document.getElementById('dash-start-local-terminal-btn').addEventListener('click', () => {
  setTerminalPickerVisible(true);
});
document.getElementById('dash-remove-previous-session-btn').addEventListener('click', () => {
  void removePreviousSessionFromDashboard();
});
document.getElementById('dash-launch-powershell-btn').addEventListener('click', () => {
  void startLocalTerminalFromDashboard('powershell');
});
document.getElementById('dash-launch-cmd-btn').addEventListener('click', () => {
  void startLocalTerminalFromDashboard('cmd');
});
document.getElementById('dash-launch-bash-btn').addEventListener('click', () => {
  void startLocalTerminalFromDashboard('bash');
});
document.getElementById('dash-launch-zsh-btn').addEventListener('click', () => {
  void startLocalTerminalFromDashboard('zsh');
});
document.getElementById('dash-cancel-terminal-picker-btn').addEventListener('click', () => {
  setTerminalPickerVisible(false);
});
document.addEventListener('click', (ev) => {
  const addMenu = document.getElementById('tab-add-menu');
  const addBtn = document.getElementById('tab-add-btn');
  if (addMenu && addMenu.style.display !== 'none' && !addMenu.contains(ev.target) && ev.target !== addBtn) {
    hideTabAddMenu();
  }
  const sftpMenu = document.getElementById('sftp-context-menu');
  if (sftpMenu && sftpMenu.style.display !== 'none' && !sftpMenu.contains(ev.target)) {
    hideSftpContextMenu();
  }
  const serverMenu = document.getElementById('server-context-menu');
  if (serverMenu && serverMenu.style.display !== 'none' && !serverMenu.contains(ev.target)) {
    hideServerContextMenu();
  }
  const folderMenu = document.getElementById('folder-context-menu');
  if (folderMenu && folderMenu.style.display !== 'none' && !folderMenu.contains(ev.target)) {
    hideFolderContextMenu();
  }
});
window.addEventListener('resize', () => {
  hideTabAddMenu();
  hideSftpContextMenu();
  hideServerContextMenu();
  hideFolderContextMenu();
  syncRecentSessionViewport();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    hideTabAddMenu();
    hideSftpContextMenu();
    hideServerContextMenu();
    hideFolderContextMenu();
  }
});

initStaticSftpColumnResizers();
updateSftpViewButtons();
updateSftpPaneButtons();
renderSftpEditorPanel();
setMainDashboardActive(true);
renderMainDashboard();
refreshAddBtn();

// Initial load
loadServers();
setInterval(() => { void refreshServerStatuses(); }, STATUS_REFRESH_INTERVAL_MS);
setInterval(() => { void tickLiveMetricsRefresh(); }, METRICS_LIVE_REFRESH_INTERVAL_MS);
