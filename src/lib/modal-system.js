/**
 * Modal System - Replaces native browser dialogs with themed modals
 * Supports: alert, confirm, input, and custom content modals
 */

const MODAL_STATE = {
    resolver: null,
    currentType: null,
    focusTrap: null,
    previousActiveElement: null,
};

// Icon SVGs for different modal types
const MODAL_ICONS = {
    info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
    warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
    danger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
    question: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
};

function createModalContainer() {
    if (document.getElementById('app-modal-system')) return;

    const container = document.createElement('div');
    container.id = 'app-modal-system';
    container.setAttribute('role', 'presentation');
    container.innerHTML = `
    <div class="app-modal-overlay" id="app-modal-overlay"></div>
    <div class="app-modal-panel" role="dialog" aria-modal="true" aria-labelledby="app-modal-title" id="app-modal-panel">
      <div class="app-modal-icon" id="app-modal-icon" aria-hidden="true"></div>
      <div class="app-modal-title" id="app-modal-title"></div>
      <div class="app-modal-message" id="app-modal-message"></div>
      <div class="app-modal-input-wrap" id="app-modal-input-wrap">
        <label class="app-modal-label" id="app-modal-label" for="app-modal-input"></label>
        <input class="app-modal-input" id="app-modal-input" spellcheck="false" autocomplete="off" type="text">
      </div>
      <div class="app-modal-actions" id="app-modal-actions">
        <button class="app-modal-btn ghost" id="app-modal-cancel"></button>
        <button class="app-modal-btn" id="app-modal-confirm"></button>
      </div>
    </div>
  `;
    document.body.appendChild(container);

    // Overlay click closes for non-alert modals
    document.getElementById('app-modal-overlay').addEventListener('click', () => {
        if (MODAL_STATE.currentType !== 'alert') {
            closeModal(false);
        }
    });

    // Cancel button
    document.getElementById('app-modal-cancel').addEventListener('click', () => closeModal(false));

    // Confirm button
    document.getElementById('app-modal-confirm').addEventListener('click', () => {
        const inputWrap = document.getElementById('app-modal-input-wrap');
        if (inputWrap.style.display !== 'none') {
            const value = document.getElementById('app-modal-input').value;
            closeModal(value);
        } else {
            closeModal(true);
        }
    });

    // Keyboard handling
    document.getElementById('app-modal-panel').addEventListener('keydown', handleModalKeydown);
    document.getElementById('app-modal-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            closeModal(document.getElementById('app-modal-input').value);
        }
    });
}

function handleModalKeydown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        if (MODAL_STATE.currentType !== 'alert') {
            closeModal(false);
        }
    } else if (e.key === 'Tab') {
        trapFocus(e);
    }
}

function trapFocus(e) {
    const panel = document.getElementById('app-modal-panel');
    const focusableElements = panel.querySelectorAll(
        'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
    } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
    }
}

function closeModal(result) {
    const container = document.getElementById('app-modal-system');
    if (!container) return;

    container.style.display = 'none';

    const resolver = MODAL_STATE.resolver;
    MODAL_STATE.resolver = null;
    MODAL_STATE.currentType = null;

    // Restore focus
    if (MODAL_STATE.previousActiveElement) {
        MODAL_STATE.previousActiveElement.focus();
        MODAL_STATE.previousActiveElement = null;
    }

    if (resolver) resolver(result);
}

function showModal(options) {
    createModalContainer();

    const container = document.getElementById('app-modal-system');
    const iconEl = document.getElementById('app-modal-icon');
    const titleEl = document.getElementById('app-modal-title');
    const messageEl = document.getElementById('app-modal-message');
    const inputWrap = document.getElementById('app-modal-input-wrap');
    const labelEl = document.getElementById('app-modal-label');
    const inputEl = document.getElementById('app-modal-input');
    const cancelBtn = document.getElementById('app-modal-cancel');
    const confirmBtn = document.getElementById('app-modal-confirm');

    if (MODAL_STATE.resolver) return Promise.resolve(null);

    // Store previous focus
    MODAL_STATE.previousActiveElement = document.activeElement;
    MODAL_STATE.currentType = options.type;

    // Set icon
    const iconSvg = MODAL_ICONS[options.variant || 'info'] || MODAL_ICONS.info;
    iconEl.innerHTML = iconSvg;
    iconEl.className = `app-modal-icon ${options.variant || 'info'}`;

    // Set content
    titleEl.textContent = options.title || '';
    messageEl.textContent = options.message || '';
    messageEl.style.display = options.message ? 'block' : 'none';

    // Handle input
    if (options.type === 'input') {
        inputWrap.style.display = 'block';
        labelEl.textContent = options.label || 'Value';
        inputEl.value = options.defaultValue || '';
        inputEl.placeholder = options.placeholder || '';
    } else {
        inputWrap.style.display = 'none';
    }

    // Set buttons
    cancelBtn.textContent = options.cancelText || 'Cancel';
    cancelBtn.style.display = options.type === 'alert' ? 'none' : 'inline-flex';
    confirmBtn.textContent = options.confirmText || 'OK';

    if (options.variant === 'danger') {
        confirmBtn.classList.add('danger');
    } else {
        confirmBtn.classList.remove('danger');
    }

    container.style.display = 'block';

    // Focus management
    setTimeout(() => {
        if (options.type === 'input') {
            inputEl.focus();
            inputEl.select();
        } else if (options.type === 'confirm') {
            confirmBtn.focus();
        } else {
            confirmBtn.focus();
        }
    }, 0);

    return new Promise((resolve) => {
        MODAL_STATE.resolver = resolve;
    });
}

// Public API
export function showAlert(options) {
    if (typeof options === 'string') {
        options = { message: options };
    }
    return showModal({
        type: 'alert',
        title: options.title || 'Alert',
        message: options.message,
        variant: options.variant || 'info',
        confirmText: options.confirmText || 'OK',
    });
}

export function showConfirm(options) {
    if (typeof options === 'string') {
        options = { message: options };
    }
    return showModal({
        type: 'confirm',
        title: options.title || 'Confirm',
        message: options.message,
        variant: options.variant || 'question',
        confirmText: options.confirmText || 'Yes',
        cancelText: options.cancelText || 'No',
    });
}

export function showInput(options) {
    return showModal({
        type: 'input',
        title: options.title || 'Input',
        message: options.message,
        label: options.label,
        defaultValue: options.defaultValue,
        placeholder: options.placeholder,
        confirmText: options.confirmText || 'Save',
        cancelText: options.cancelText || 'Cancel',
    });
}

export function showDangerConfirm(options) {
    if (typeof options === 'string') {
        options = { message: options };
    }
    return showModal({
        type: 'confirm',
        title: options.title || 'Confirm Deletion',
        message: options.message,
        variant: 'danger',
        confirmText: options.confirmText || 'Delete',
        cancelText: options.cancelText || 'Cancel',
    });
}

/**
 * Error message mapping - converts technical errors to user-friendly messages
 */
const ERROR_MESSAGES = {
    'Connection refused': 'Unable to connect to server. Please check that the server is running and accessible.',
    'Authentication failed': 'Authentication failed. Please verify your username and password.',
    'Host key verification failed': 'Host key verification failed. The server identity may have changed.',
    'Timeout': 'Connection timed out. The server did not respond in time.',
    'Network is unreachable': 'Network is unreachable. Please check your internet connection.',
    'No route to host': 'No route to host. The server address may be incorrect.',
    'Permission denied': 'Permission denied. You may not have access to this resource.',
    'File not found': 'The requested file or directory was not found.',
    'Disk full': 'Disk is full. Unable to complete the operation.',
    'Quota exceeded': 'Storage quota exceeded. Please free up some space.',
};

export function getUserFriendlyError(error) {
    if (!error) return 'An unknown error occurred.';

    const errorStr = String(error);

    // Check for known error patterns
    for (const [pattern, message] of Object.entries(ERROR_MESSAGES)) {
        if (errorStr.toLowerCase().includes(pattern.toLowerCase())) {
            return message;
        }
    }

    // Return cleaned up generic message
    return errorStr.replace(/^Error:\s*/i, '').replace(/\bat\s+.*$/m, '');
}

export function showError(message, error) {
    const userMessage = getUserFriendlyError(error || message);
    return showAlert({
        title: 'Error',
        message: userMessage,
        variant: 'danger',
        confirmText: 'OK',
    });
}
