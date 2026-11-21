(() => {
  'use strict';
  const stateButtons = [...document.querySelectorAll('[data-state]')];
  const demo = document.querySelector('.demo-device');
  const title = document.querySelector('#signal-title');
  const description = document.querySelector('#signal-description');
  const states = {
    listening: { title: 'A thought, caught.', text: 'Hold the button and speak. Let go when you’re done.', hue: '0deg' },
    working: { title: 'A little time to think.', text: 'Your agent has the thought. The light shows it is working.', hue: '75deg' },
    attention: { title: 'A moment for you.', text: 'A quiet signal when an answer or decision needs your attention.', hue: '195deg' },
    done: { title: 'Back to your day.', text: 'The thought has a place. The task is complete.', hue: '285deg' }
  };
  let completionTimer;
  let held = false;
  let heldKey = null;
  let heldPointer = null;
  function showState(name) {
    const state = states[name];
    if (!state || !demo || !title || !description) return;
    clearTimeout(completionTimer);
    demo.style.setProperty('--hue', state.hue);
    title.textContent = state.title;
    description.textContent = state.text;
    stateButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.state === name)));
  }
  function begin() {
    if (held) return;
    held = true;
    demo.classList.add('is-held');
    showState('listening');
    title.textContent = 'Listening to you.';
    description.textContent = 'This is a visual preview. Release to see what happens next.';
  }
  function release() {
    if (!held) return;
    held = false;
    demo.classList.remove('is-held');
    showState('working');
    completionTimer = setTimeout(() => showState('done'), 1500);
  }
  function cancel() {
    if (!held) return;
    held = false;
    heldKey = null;
    heldPointer = null;
    demo.classList.remove('is-held');
    showState('listening');
  }
  stateButtons.forEach(button => button.addEventListener('click', () => {
    cancel();
    showState(button.dataset.state);
  }));
  if (demo) {
    demo.addEventListener('pointerdown', event => {
      if (event.button !== 0 || held) return;
      heldPointer = event.pointerId;
      demo.setPointerCapture(event.pointerId);
      begin();
    });
    demo.addEventListener('pointerup', event => {
      if (heldPointer !== event.pointerId) return;
      heldPointer = null;
      release();
    });
    demo.addEventListener('pointercancel', cancel);
    demo.addEventListener('lostpointercapture', () => { if (heldPointer !== null) cancel(); });
    demo.addEventListener('keydown', event => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!event.repeat) {
          heldKey = event.key;
          begin();
        }
      }
    });
    demo.addEventListener('keyup', event => {
      if (heldKey !== event.key) return;
      event.preventDefault();
      heldKey = null;
      release();
    });
    demo.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  }
  const filters = [...document.querySelectorAll('[data-filter]')];
  const devices = [...document.querySelectorAll('[data-device-kind]')];
  const count = document.querySelector('#device-count');
  filters.forEach(button => button.addEventListener('click', () => {
    const filter = button.dataset.filter;
    filters.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    let visible = 0;
    devices.forEach(device => {
      device.hidden = filter !== 'all' && device.dataset.deviceKind !== filter;
      if (!device.hidden) visible++;
    });
    if (count) count.textContent = `${visible} ${visible === 1 ? 'device' : 'devices'} shown`;
  }));
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy commands'; }, 2000);
    } catch {
      button.textContent = 'Select and copy the commands above';
    }
  }));
})();

(() => {
  'use strict';
  document.documentElement.classList.add('has-js');
  const header = document.querySelector('.unified-header');
  const menu = header?.querySelector('.menu-toggle');
  function setMenu(open) {
    header?.classList.toggle('is-menu-open', open);
    menu?.setAttribute('aria-expanded', String(open));
  }
  menu?.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
  header?.querySelectorAll('nav a').forEach(link => link.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') {
      setMenu(false);
      menu.focus();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (header && !header.contains(event.target)) setMenu(false);
  });

  const examples = {
    routine: {
      kicker: 'A useful routine', title: 'A little less<br>starting over.',
      context: 'You review the calendar, check a few updates, and write the same morning note.',
      suggestion: '“I can prepare a morning brief from the sources you choose. Would you like to make it a routine?”',
      receipt: 'Suggested routine · Yours to review'
    },
    supervisor: {
      kicker: 'Your coding agents', title: 'The right question.<br>With its context.',
      context: 'Several coding sessions are moving. One needs a decision before it can continue.',
      suggestion: '“This thread needs your choice. Here is the question, the PR, and the verification evidence behind it.”',
      receipt: 'Supervisor · A decision for you'
    },
    memory: {
      kicker: 'A thought, kept', title: 'A little context.<br>For next time.',
      context: 'A conversation leaves you with a decision you want your agent to remember.',
      suggestion: '“Keep the prototype simple: a button, a microphone, and a clear signal. Use that direction when we revisit the hardware.”',
      receipt: 'Illustrative memory · Continuity across sessions'
    }
  };
  const exampleButtons = [...document.querySelectorAll('[data-example]')];
  exampleButtons.forEach(button => button.addEventListener('click', () => {
    const example = examples[button.dataset.example];
    if (!example) return;
    for (const field of ['kicker', 'context', 'suggestion', 'receipt']) {
      const node = document.getElementById(`example-${field}`);
      if (node) node.textContent = example[field];
    }
    const title = document.getElementById('example-title');
    if (title) title.innerHTML = example.title;
    exampleButtons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));

  const filters = [...document.querySelectorAll('[data-connection-filter]')];
  const cards = [...document.querySelectorAll('[data-connection-kind]')];
  const count = document.getElementById('connection-count');
  filters.forEach(button => button.addEventListener('click', () => {
    const category = button.dataset.connectionFilter;
    let visible = 0;
    cards.forEach(card => {
      card.hidden = category !== 'all' && card.dataset.connectionKind !== category;
      if (!card.hidden) visible++;
    });
    filters.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    if (count) count.textContent = `${visible} ${visible === 1 ? 'connection' : 'connections'} shown`;
  }));
})();
