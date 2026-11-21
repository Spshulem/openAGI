(() => {
  'use strict';
  // These switches only change illustrative examples and installation text.
  function tabs(selector, activate) {
    const buttons = [...document.querySelectorAll(selector)];
    function select(button, focus = false) {
      buttons.forEach(item => {
        const selected = item === button;
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
      });
      activate(button);
      if (focus) button.focus();
    }
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => select(button));
      button.addEventListener('keydown', event => {
        let target;
        if (event.key === 'ArrowRight') target = (index + 1) % buttons.length;
        if (event.key === 'ArrowLeft') target = (index - 1 + buttons.length) % buttons.length;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = buttons.length - 1;
        if (target === undefined) return;
        event.preventDefault();
        select(buttons[target], true);
      });
    });
  }

  tabs('[data-product-tab]', button => {
    document.querySelectorAll('[data-product-panel]').forEach(panel => {
      panel.hidden = panel.id !== button.getAttribute('aria-controls');
    });
  });

  const installs = {
    curl: {
      command: 'curl -fsSL https://openagi.sh/install.sh | sh',
      note: 'For macOS, Debian-family Linux, or a host with Docker. The installer guides you to setup.'
    },
    docker: {
      command: 'OPENAGI_AUTH_TOKEN="$(openssl rand -hex 32)"\ndocker run -d --name openagi --restart unless-stopped -p 127.0.0.1:43210:43210 -v openagi-data:/data -e OPENAGI_AUTH_TOKEN="$OPENAGI_AUTH_TOKEN" ghcr.io/spshulem/openagi:v0.0.83',
      note: 'Requires Docker and OpenSSL. Save the generated token; enter it at http://127.0.0.1:43210/ when the dashboard asks.'
    },
    source: {
      command: 'git clone https://github.com/Spshulem/openAGI\ncd openAGI\nnpm ci --ignore-scripts\nnpm run serve',
      note: 'Requires Git and Node.js 22+. Then open http://127.0.0.1:43210/setup on this computer.'
    }
  };
  tabs('[data-install-tab]', button => {
    const install = installs[button.dataset.installTab];
    if (!install) return;
    document.getElementById('install-command').textContent = install.command;
    document.getElementById('install-context').textContent = install.note;
    document.getElementById('install-panel').setAttribute('aria-labelledby', button.id);
    document.querySelectorAll('[data-clipboard="install-command"]').forEach(copy => {
      copy.textContent = 'Copy command';
    });
  });

  document.querySelectorAll('[data-clipboard]').forEach(button => {
    const original = button.textContent;
    let timer;
    button.addEventListener('click', async () => {
      const code = document.getElementById(button.dataset.clipboard);
      if (!code) return;
      clearTimeout(timer);
      try {
        await navigator.clipboard.writeText(code.textContent.trim());
        button.textContent = 'Copied';
      } catch {
        // Keep the command usable when a browser denies clipboard access.
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        let copied = false;
        try { copied = document.execCommand('copy'); } catch {}
        button.textContent = copied ? 'Copied' : 'Selected — copy';
        if (copied) selection.removeAllRanges();
      }
      timer = setTimeout(() => { button.textContent = original; }, 2400);
    });
  });
})();
