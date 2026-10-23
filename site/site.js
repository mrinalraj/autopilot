// All interactions are local demonstrations; no tracker or launcher is contacted.
document.documentElement.classList.add('enhanced');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function tabs(list, onSelect = () => {}) {
  const buttons = [...list.querySelectorAll('[role="tab"]')];
  const panels = buttons.map((button) => document.getElementById(button.getAttribute('aria-controls')));
  let animation;
  function select(button, focus = false) {
    animation?.cancel();
    const next = buttons.indexOf(button);
    buttons.forEach((tab, index) => {
      const active = index === next;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[index].hidden = !active;
    });
    if (focus) button.focus({ preventScroll: true });
    onSelect(button, panels[next]);
  }
  buttons.forEach((button, index) => {
    button.addEventListener('click', (event) => {
      select(button);
      if (!reducedMotion.matches && event.detail > 0) {
        animation = panels[index].animate([{ opacity: 0.4, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.23,1,.32,1)' });
      }
    });
    button.addEventListener('keydown', (event) => {
      let target;
      if (event.key === 'ArrowRight') target = (index + 1) % buttons.length;
      if (event.key === 'ArrowLeft') target = (index - 1 + buttons.length) % buttons.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = buttons.length - 1;
      if (target !== undefined) { event.preventDefault(); select(buttons[target], true); }
    });
  });
  select(buttons.find((button) => button.getAttribute('aria-selected') === 'true') || buttons[0]);
  return select;
}

tabs(document.querySelector('.preview-tabs'));
const previewDialog = document.getElementById('preview-dialog');
const expandedPreview = document.getElementById('expanded-preview');
document.querySelectorAll('[data-expand]').forEach((link) => {
  link.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (typeof previewDialog.showModal !== 'function') return;
    event.preventDefault();
    const figure = link.closest('figure');
    expandedPreview.src = link.href;
    expandedPreview.alt = figure.querySelector('img').alt;
    document.getElementById('preview-dialog-title').textContent = figure.querySelector('figcaption > span').textContent;
    previewDialog.showModal();
  });
});
document.querySelector('.preview-close').addEventListener('click', () => previewDialog.close());
previewDialog.addEventListener('click', (event) => {
  if (event.target === previewDialog) previewDialog.close();
});
tabs(document.querySelector('.install-tabs'));

document.querySelectorAll('[data-copy]').forEach((button) => {
  let resetTimer;
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    const label = button.querySelector('span');
    const status = document.getElementById('copy-status');
    clearTimeout(resetTimer);
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      label.textContent = 'Copied';
      status.textContent = 'Installation commands copied to clipboard.';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      label.textContent = 'Selected';
      status.textContent = 'Clipboard access is unavailable. The commands are selected; copy them with your device’s copy command.';
    }
    resetTimer = setTimeout(() => { label.textContent = 'Copy'; }, 2400);
  });
});

// A tab switch must not leave the film playing out of sight.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) document.getElementById('launch-film').pause();
});
