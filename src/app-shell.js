// Shared foundations for setup and the workspace. Keep feature styles local.
export const designTokens = `
:root {
  color-scheme: light;
  --bg:#ffffff; --panel:#f8f9fb; --panel-2:#f0f1f5; --text:#20232b;
  --muted:#646b79; --line:#e4e6ec; --accent:#187047; --accent-soft:#eaf5ee;
  --user:#eaf5ee; --assistant:#fff; --warn:#95621b; --err:#bd3544;
  --background:var(--bg); --foreground:var(--text); --card:var(--bg);
  --card-foreground:var(--text); --popover:var(--bg); --popover-foreground:var(--text);
  --primary:var(--accent); --primary-foreground:#fff; --secondary:var(--panel-2);
  --secondary-foreground:var(--text); --muted-bg:var(--panel); --muted-foreground:var(--muted);
  --accent-bg:var(--accent-soft); --accent-foreground:var(--accent);
  --border:var(--line); --input:var(--bg); --ring:#18704740;
  --destructive:var(--err); --destructive-foreground:#fff;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:24px; --space-6:32px;
  --radius-sm:6px; --radius:8px; --radius-lg:12px;
  --font-size-xs:12px; --font-size-sm:13px; --font-size-base:14px; --font-size-lg:16px;
  --shadow-sm:0 1px 2px #20232b08; --shadow:0 8px 32px #20232b12;
}
@media (prefers-color-scheme:dark) {
  :root { color-scheme:dark; --bg:#17181c; --panel:#1e1f24; --panel-2:#292b32;
    --text:#eff0f5; --muted:#a0a5b3; --line:#32343d; --accent:#91cfaa;
    --accent-soft:#21392c; --user:#21392c; --assistant:#17181c; --err:#ff9ca9;
    --warn:#e6bb73; --primary-foreground:#102b1c; --ring:#91cfaa50; }
}
* { box-sizing:border-box; }
button,input,textarea,select { font:inherit; }
button,a,input,textarea,select,summary { -webkit-tap-highlight-color:transparent; }
:focus-visible { outline:3px solid var(--ring); outline-offset:3px; }
[hidden] { display:none!important; }
`;

const icons = {
  chat:'<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z"/>',
  start:'<path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Z"/>',
  tasks:'<rect x="5" y="3" width="15" height="18" rx="3"/><path d="m8 11 2 2 5-5M9 17h7"/>',
  review:'<path d="M4 4h16v16H4zM4 14h4l2 3h4l2-3h4"/>',
  agents:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m7 10 3 2-3 2m6 0h4"/>',
  memory:'<path d="M12 4v16M12 6C6 0 0 10 5 12c-5 4 2 12 7 6M12 6c6-6 12 4 7 6 5 4-2 12-7 6"/>',
  connect:'<path d="m8 3 3 3-5 5-3-3m2 2 5-5M16 21l-3-3 5-5 3 3m-2-2-5 5m-6-3 8-8"/>',
  devices:'<rect x="2" y="4" width="14" height="11" rx="2"/><path d="M6 20h6m-3-5v5"/><rect x="17" y="10" width="5" height="11" rx="1"/>',
  screen:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4m-4-13 3 3-3 3m5 0h3"/>',
  settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.start}</svg>`;
const item = (id, label, image, extra = '') => `<button type="button" data-tab="${id}" ${extra}>${icon(image)}<span>${label}</span>${id === 'approvals' ? '<span id="approvalsNavCount" class="badge" hidden></span>' : ''}</button>`;

export const navigation = `
<aside class="app-navigation" id="appNavigation">
  <nav id="nav" aria-label="Main navigation">
    <div class="nav-group">${item('chat','Chat','chat')}${item('get-started','Get started','start')}</div>
    <div class="nav-group"><p class="nav-label">Workspace</p>
      ${item('coding-agents','Coding agents','agents')}${item('tasks','Tasks','tasks')}
      ${item('review','Review','review')}${item('approvals','Approvals','review','id="approvalsNav"')}
    </div>
    <div class="nav-group"><p class="nav-label">Your agent</p>
      ${item('memory','Memory','memory')}${item('skills','Skills','start')}${item('integrations','Integrations','connect')}
      ${item('nodes','Devices','devices')}${item('computer-use','Computer use','screen')}
    </div>
    <details class="nav-advanced"><summary>More tools</summary><div>
      ${item('suggestions','Suggestions','start')}${item('cron','Schedules','tasks')}
      ${item('activity','Computer history','screen')}${item('today','Today','review')}
      ${item('mcp','MCP servers','connect')}${item('channels','Channels','chat')}${item('agents','Specialists','agents')}
      <a href="/fleet">${icon('agents')}Fleet overview</a><a href="/g2/connect">${icon('devices')}Connect glasses</a>
      ${item('budget','Usage & budget','review')}${item('health','System health','start')}
      ${item('outcomes','Outcomes','tasks')}${item('scrutiny','Scrutiny','settings')}
    </div></details>
  </nav>
  <div class="nav-footer"><div id="providerSwitch" class="model-switch" hidden></div><button id="setupBtn" type="button">${icon('settings')}Model & settings</button>
  <a href="https://github.com/Spshulem/openAGI" target="_blank" rel="noopener noreferrer">Source & documentation <span>↗</span></a></div>
</aside>`;

export const shellStyles = `
${designTokens}
body { font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
a { color:var(--accent); }
.app { display:grid; grid-template-columns:224px minmax(0,1fr); grid-template-rows:1fr; }
.workspace { display:grid; grid-template-rows:64px minmax(0,1fr); min-width:0; min-height:0; }
.app-navigation { background:var(--panel); border-right:1px solid var(--line); display:flex; flex-direction:column; min-height:0; padding:24px 12px 14px; }
#nav { display:block; overflow-y:auto; margin:0; flex:1; min-height:0; }
#nav button,#nav a,.nav-footer button { display:flex; align-items:center; gap:10px; padding:9px 12px; width:100%; min-height:38px; border:0; border-radius:6px; background:transparent; color:var(--muted); font-size:13px; line-height:20px; font-weight:500; text-align:left; text-decoration:none; cursor:pointer; }
#nav button:hover,#nav a:hover,.nav-footer button:hover { background:var(--panel-2); color:var(--text); }
#nav button.active { color:var(--accent); background:var(--accent-soft); font-weight:600; }
#nav svg { flex-shrink:0; }
.nav-group { margin-bottom:20px; }
.nav-label { padding:0 12px; margin:0 0 6px; font-size:11px; font-weight:600; color:var(--muted); letter-spacing:.06em; text-transform:uppercase; }
.nav-advanced { margin:0 0 20px; }
.nav-advanced summary { padding:8px 12px; font-size:12px; color:var(--muted); cursor:pointer; }
.nav-footer { border-top:1px solid var(--line); padding-top:10px; }
.model-switch { padding:8px 12px; color:var(--muted); font-size:12px; }
.model-switch summary { cursor:pointer; }
.model-switch label { display:block; margin:10px 0 5px; }
.model-switch select { width:100%; padding:7px; border:1px solid var(--line); border-radius:6px; color:var(--text); background:var(--bg); }
.nav-footer a { display:flex; justify-content:space-between; color:var(--muted); text-decoration:none; padding:8px 12px; font-size:11px; }
.workspace-header { background:var(--bg); height:64px; padding:0 28px; gap:16px; }
.workspace-header h1 { font-size:14px; font-weight:600; letter-spacing:0; }
.workspace-header .status { margin-left:auto; flex-wrap:nowrap; justify-content:flex-end; overflow:hidden; }
.workspace-header .status-pill { border:0; border-radius:4px; background:var(--panel); font-size:11px; padding:4px 8px; max-width:250px; overflow:hidden; text-overflow:ellipsis; }
.workspace-header #menuToggle { display:none; }
.body { grid-template-columns:224px minmax(0,1fr); }
.sidebar { background:var(--bg); }
.sidebar header.sub { height:54px; padding:0 16px; background:var(--bg); }
.sidebar h2 { text-transform:none; letter-spacing:0; font-size:12px; font-weight:500; }
.sidebar .add { border:0; background:var(--panel); color:var(--text); border-radius:6px; padding:5px 8px; }
.sidebar ul { padding:8px; }
.sidebar li { padding:10px; }
.sidebar li.active { border:0; background:var(--panel); }
.sidebar li .title { font-weight:500; font-size:12px; }
.sidebar li .preview { font-size:11px; }
.main { overflow:auto; }
.main > h2,.main > p,.main > .pane { padding-left:28px; padding-right:28px; }
.thread { padding:32px max(24px,calc((100% - 800px)/2)); gap:24px; }
.msg { max-width:100%; border-radius:10px; padding:14px 18px; }
.msg.assistant { border:0; padding-left:0; background:transparent; }
.msg.user { max-width:85%; }
.composer { margin:0 max(24px,calc((100% - 800px)/2)) 24px; border:1px solid var(--line); border-radius:12px; background:var(--bg); padding:12px; box-shadow:var(--shadow-sm); }
.composer textarea { background:transparent; border:0; min-height:48px; box-shadow:none; }
.composer button { border-radius:7px; padding:8px 16px; background:var(--primary); color:var(--primary-foreground); }
.chat-welcome { max-width:680px; margin:auto; padding:48px 0; width:100%; }
.chat-welcome .eyebrow,.guide-page .eyebrow { color:var(--accent); font-size:12px; font-weight:600; margin-bottom:14px; }
.chat-welcome h2 { font-size:32px; font-weight:600; letter-spacing:-1px; line-height:1.2; margin:0 0 16px; }
.chat-welcome p { color:var(--muted); max-width:480px; }
.chat-starters { display:grid; grid-template-columns:1fr; gap:8px; margin-top:28px; }
.chat-starters button { text-align:left; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); padding:14px 16px; cursor:pointer; }
.chat-starters button:hover { border-color:var(--accent); background:var(--accent-soft); }
.model-needed { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:16px; background:var(--panel); font-size:13px; }
.guide-page { width:100%; max-width:1080px; margin:0 auto; padding:48px 48px 32px; }
.guide-page h2 { font-size:36px; font-weight:600; line-height:1.15; letter-spacing:-1.2px; margin:0 0 16px; max-width:600px; }
.guide-intro { color:var(--muted); font-size:15px; max-width:600px; margin-bottom:32px; }
.guide-featured { border:1px solid var(--line); border-radius:12px; padding:28px; display:flex; gap:32px; align-items:center; background:var(--panel); margin-bottom:36px; }
.guide-featured h3 { margin:4px 0 8px; font-size:20px; font-weight:600; letter-spacing:-.4px; }
.guide-featured p { color:var(--muted); max-width:560px; margin:0 0 20px; }
.guide-featured .guide-number { flex-shrink:0; width:76px; height:76px; border:1px solid var(--line); border-radius:20px; display:grid; place-items:center; font-size:30px; color:var(--accent); background:var(--bg); }
.guide-page h3.section-label { font-size:13px; font-weight:600; margin:0 0 16px; }
.guide-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.guide-card { border:1px solid var(--line); border-radius:10px; padding:22px; }
.guide-card h3 { font-size:15px; margin:0 0 8px; font-weight:600; }
.guide-card p { color:var(--muted); font-size:13px; margin:0 0 18px; }
.guide-card button { border:0; background:transparent; color:var(--accent); padding:0; font-weight:550; cursor:pointer; }
.guide-card details { margin-top:18px; font-size:12px; color:var(--muted); }
.guide-card summary { cursor:pointer; }
.guide-card ol { padding-left:18px; }
.guide-card li { margin:8px 0; }
.guide-check { display:flex; align-items:center; gap:7px; margin-top:16px; font-size:12px; color:var(--muted); }
.guide-check input { accent-color:var(--accent); }
.guide-footer { display:flex; gap:16px; justify-content:space-between; margin-top:28px; color:var(--muted); font-size:12px; }
.ui-btn { text-decoration:none; }
.ui-toast-ok { background:var(--panel); color:var(--text); border:1px solid var(--line); }
@media(max-width:1100px) { .body { grid-template-columns:190px minmax(0,1fr); } .guide-page { padding:32px; } .app { grid-template-columns:200px minmax(0,1fr); } }
@media(max-width:760px) {
  .app { grid-template-columns:minmax(0,1fr); } .app-navigation { display:none; position:fixed; inset:56px auto 0 0; width:240px; z-index:60; box-shadow:var(--shadow); }
  .app-navigation.open { display:flex; }
  .workspace { grid-template-rows:56px minmax(0,1fr); } .workspace-header { height:56px; padding:0 16px; gap:10px; }
  .workspace-header #menuToggle { display:block; border:1px solid var(--line); background:var(--bg); color:var(--text); border-radius:6px; padding:6px 10px; cursor:pointer; }
  .workspace-header .status-pill:nth-child(n+2) { display:none; }
  .body { grid-template-columns:1fr; } .sidebar { max-height:150px; border-right:0; border-bottom:1px solid var(--line); }
  .sidebar ul { display:flex; gap:4px; overflow:auto; } .sidebar li { min-width:180px; }
  .body:has(.sidebar:not([style*="display: none"])) { grid-template-rows:auto minmax(0,1fr); }
  .guide-page { padding:28px 20px; } .guide-page h2 { font-size:30px; } .guide-grid { grid-template-columns:1fr; }
  .guide-featured { padding:22px; gap:16px; } .guide-featured .guide-number { display:none; }
  .guide-footer { flex-direction:column; gap:8px; } .thread { padding:24px 20px; } .composer { margin:0 16px 16px; }
  .chat-welcome { padding:24px 0; } .chat-welcome h2 { font-size:28px; } .model-needed { align-items:flex-start; }
}
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition:none!important; animation:none!important; } }
`;
