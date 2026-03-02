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

export async function askInputModal({
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
