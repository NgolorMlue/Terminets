import { SESSION_FOLDER_ID, SESSION_FOLDER_NAME } from './runtime.js';

export const SERVER_ICON_OPTIONS = Object.freeze([
  { value: 'server', label: 'Server', glyph: '🖥' },
  { value: 'cloud', label: 'Cloud', glyph: '☁' },
  { value: 'database', label: 'Database', glyph: '🗄' },
  { value: 'shield', label: 'Shield', glyph: '🛡' },
  { value: 'terminal', label: 'Terminal', glyph: '⌨' },
  { value: 'network', label: 'Network', glyph: '🕸' },
]);

const SERVER_ICON_VALUE_SET = new Set(SERVER_ICON_OPTIONS.map((option) => option.value));

export const SERVER_ICON_OPTIONS_HTML = SERVER_ICON_OPTIONS
  .map((option) => `<option value="${option.value}">${option.glyph} ${option.label}</option>`)
  .join('');

export function normalizeConnectionProtocol(value) {
  const protocol = String(value || 'ssh').toLowerCase();
  return protocol === 'telnet' ? 'telnet' : 'ssh';
}

export function serverProtocol(server) {
  return normalizeConnectionProtocol(server?._raw?.protocol ?? server?.protocol);
}

export function normalizeFolderName(value) {
  const name = String(value || '').trim();
  return name.replace(/\s+/g, ' ').slice(0, 64);
}

export function isSessionFolderId(value) {
  return String(value || '').trim() === SESSION_FOLDER_ID;
}

export function withSystemFolders(folders) {
  const normalized = Array.isArray(folders)
    ? folders
      .map((folder) => ({
        id: String(folder?.id || '').trim(),
        name: normalizeFolderName(folder?.name || ''),
      }))
      .filter((folder) => folder.id && folder.name && !isSessionFolderId(folder.id))
    : [];

  return [{ id: SESSION_FOLDER_ID, name: SESSION_FOLDER_NAME, system: true }, ...normalized];
}

export function folderIconSvg(kind = 'folder') {
  if (kind === 'ungrouped') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"></circle><path d="M12 2.5v4"></path><path d="M12 17.5v4"></path><path d="M2.5 12h4"></path><path d="M17.5 12h4"></path></svg>';
  }
  if (kind === 'sessions') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2"></rect><path d="M7.5 9.5h9"></path><path d="M7.5 13h6"></path></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l1.6 2h9.4v8.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"></path><path d="M3.5 7.5V5.8a2 2 0 0 1 2-2h4.3l1.4 1.7h7.3a2 2 0 0 1 2 2v2"></path></svg>';
}

export function normalizeServerIcon(icon) {
  const value = String(icon || '').toLowerCase();
  if (SERVER_ICON_VALUE_SET.has(value)) return value;
  return 'server';
}

export function serverIconLabel(icon) {
  const key = normalizeServerIcon(icon);
  const found = SERVER_ICON_OPTIONS.find((option) => option.value === key);
  return found ? found.label : 'Server';
}

export function serverIconSvg(icon) {
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
