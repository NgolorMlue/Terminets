import {
  RECENT_SESSION_LIMIT,
  RECENT_SESSION_STORAGE_KEY,
  SESSION_SHORTCUT_LIMIT,
  SESSION_SHORTCUT_STORAGE_KEY,
} from './runtime.js';

export function loadSessionShortcuts(normalizeSessionShortcutEntry) {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_SHORTCUT_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeSessionShortcutEntry)
      .filter(Boolean)
      .slice(0, SESSION_SHORTCUT_LIMIT);
  } catch {
    return [];
  }
}

export function saveSessionShortcuts(shortcuts) {
  try {
    localStorage.setItem(
      SESSION_SHORTCUT_STORAGE_KEY,
      JSON.stringify(shortcuts.slice(0, SESSION_SHORTCUT_LIMIT))
    );
  } catch {
    // Ignore localStorage write failures.
  }
}

export function normalizeSessionShortcutType(value) {
  const type = String(value || '').toLowerCase();
  const allowed = new Set([
    'local_shell',
    'wsl_shell',
    'rsh',
    'mosh',
    'rdp',
    'vnc',
    'ftp',
    'serial',
  ]);
  return allowed.has(type) ? type : null;
}

export function normalizeSessionShortcutEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const type = normalizeSessionShortcutType(entry.type);
  if (!type) return null;
  const id = String(entry.id || '').trim() || crypto.randomUUID();
  const folderId = String(entry.folderId || '').trim();
  return {
    id,
    type,
    name: String(entry.name || '').trim(),
    folderId,
    payload: entry.payload && typeof entry.payload === 'object' ? entry.payload : {},
    createdAt: Number(entry.createdAt) || Date.now(),
  };
}

export function sessionShortcutDisplayName(shortcut, localShellLabel) {
  if (!shortcut) return 'Session';
  if (shortcut.name) return shortcut.name;
  const payload = shortcut.payload || {};

  if (shortcut.type === 'local_shell') return `Local ${localShellLabel(payload.shellType || 'powershell')}`;
  if (shortcut.type === 'wsl_shell') return 'Local WSL';
  if (shortcut.type === 'serial') return `Serial ${payload.serialPort || ''}`.trim();

  const host = String(payload.host || '').trim();
  const port = Number(payload.port);
  if (host && Number.isFinite(port) && port > 0) return `${shortcut.type.toUpperCase()} ${host}:${port}`;
  if (host) return `${shortcut.type.toUpperCase()} ${host}`;
  return shortcut.type.toUpperCase();
}

export function sessionShortcutMeta(shortcut) {
  const payload = shortcut?.payload || {};
  if (shortcut?.type === 'local_shell') return 'LOCAL';
  if (shortcut?.type === 'wsl_shell') return 'WSL';
  if (shortcut?.type === 'serial') return `${payload.serialPort || 'SERIAL'} @ ${payload.baud || 115200}`;
  const host = String(payload.host || '').trim();
  const port = Number(payload.port);
  if (host && Number.isFinite(port) && port > 0) return `${host}:${port}`;
  return shortcut?.type ? shortcut.type.toUpperCase() : 'SESSION';
}

export function addSessionShortcut(shortcuts, entry) {
  const normalized = normalizeSessionShortcutEntry({
    ...entry,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  });
  if (!normalized) return shortcuts;
  return [normalized, ...shortcuts].slice(0, SESSION_SHORTCUT_LIMIT);
}

export function removeSessionShortcut(shortcuts, shortcutId) {
  const id = String(shortcutId || '').trim();
  if (!id) return shortcuts;
  return shortcuts.filter((item) => item.id !== id);
}

export function loadRecentSessions(normalizeRecentSessionEntry) {
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

export function saveRecentSessions(recentSessions) {
  try {
    localStorage.setItem(
      RECENT_SESSION_STORAGE_KEY,
      JSON.stringify(recentSessions.slice(0, RECENT_SESSION_LIMIT))
    );
  } catch {
    // Ignore localStorage write failures.
  }
}

export function formatRecentSessionTimestamp(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '\u2014';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '\u2014';
  }
}

export function normalizeRecentSessionEntry(entry, normalizeLocalShellType) {
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

export function recentSessionLabel(entry, localShellLabel) {
  if (entry?.mode === 'ssh') {
    const target = entry.serverName || entry.host || 'Unknown server';
    return `SSH · ${target}`;
  }
  return localShellLabel(entry?.shell || 'powershell');
}

export function recentSessionMeta(entry) {
  if (entry?.mode === 'ssh') {
    const host = String(entry.host || '').trim();
    const port = Number(entry.port);
    const endpoint = host ? `${host}:${Number.isFinite(port) ? port : 22}` : '\u2014';
    const user = String(entry.username || '').trim();
    return user ? `${endpoint} · ${user}` : endpoint;
  }
  return entry?.workspace ? String(entry.workspace) : '\u2014';
}

export function syncRecentSessionViewport() {
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

export function renderRecentSessionHistory({
  recentSessions,
  escapeHtml,
  localShellLabel,
  restoreRecentSession,
}) {
  const listEl = document.getElementById('dash-recent-session-list');
  if (!listEl) return;

  if (!recentSessions.length) {
    listEl.innerHTML = '<div class="dash-recent-empty">No recent sessions.</div>';
    syncRecentSessionViewport();
    return;
  }

  listEl.innerHTML = recentSessions.map((entry) => {
    const sessionLabel = recentSessionLabel(entry, localShellLabel);
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

export function trackRecentSession(recentSessions, sessionEntry, normalizeRecentEntry) {
  const normalized = normalizeRecentEntry(sessionEntry);
  if (!normalized || !normalized.id) return recentSessions;
  return [
    normalized,
    ...recentSessions.filter((entry) => entry.id !== normalized.id),
  ].slice(0, RECENT_SESSION_LIMIT);
}

export function removeMostRecentSession(recentSessions) {
  if (!recentSessions.length) return { removed: null, recentSessions };
  const [removed, ...rest] = recentSessions;
  return { removed, recentSessions: rest };
}

export function findLocalTabIdByHistoryId(termTabs, historyId) {
  if (!historyId) return null;
  const match = Object.entries(termTabs).find(([, tab]) => tab.mode === 'local' && tab.historyId === historyId);
  return match ? match[0] : null;
}

export function findSshTabIdByHistoryId(termTabs, historyId) {
  if (!historyId) return null;
  const match = Object.entries(termTabs).find(([, tab]) => tab.mode === 'ssh' && tab.historyId === historyId);
  return match ? match[0] : null;
}
