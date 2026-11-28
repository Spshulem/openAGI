# Install OpenAGI

Pick the machine that will host your agent. It holds your conversations, memory,
tasks, and configuration. Keep it running when you want background work or remote
access. A browser or paired phone connects to that host.

## Downloads

**[GitHub downloads and latest release](https://github.com/Spshulem/openAGI/releases/latest)**

| Platform | Available install path | What you get |
| --- | --- | --- |
| macOS | [Download the latest release's `OpenAGI-<version>.dmg`](https://github.com/Spshulem/openAGI/releases/latest), drag OpenAGI to Applications, then open it | Native menu bar app, bundled runtime, updates, optional screen capture and computer control |
| Windows | [Download `OpenAGI-Windows-x64.zip` from the latest release](https://github.com/Spshulem/openAGI/releases/latest), extract it, then run `Start-OpenAGI.cmd` | Browser dashboard and CLI runtime with Node included; native macOS capture/control features are not included |
| Linux x64 | [Download `OpenAGI-Linux-x64.tar.gz` from the latest release](https://github.com/Spshulem/openAGI/releases/latest), use the shell installer below, or run Docker | Browser dashboard and an always-on agent on a desktop or server |
| Linux arm64 / Raspberry Pi | [Download `OpenAGI-Linux-arm64.tar.gz` from the latest release](https://github.com/Spshulem/openAGI/releases/latest), use the shell installer below, or run Docker | Browser dashboard and an always-on agent on a compatible 64-bit SBC |
| iPhone / Android | [Companion-app source and pairing guide](../mobile/README.md) | A paired mobile client; no public App Store, TestFlight, or Play Store link is advertised here |

The latest release attaches the Mac DMG, the Windows x64 ZIP, and the Linux
x64/arm64 archives, with `.sha256` checksums for the portable archives. The
[latest release page](https://github.com/Spshulem/openAGI/releases/latest) also offers that
release's exact **Source code** archive. The portable archives contain
Node.js and the installed runtime dependencies; they are the browser/CLI
runtime, not native Windows or Linux capture apps.

For a portable download, extract the **whole** archive into a folder you own.
Double-click `Start-OpenAGI.cmd` on Windows, or run `./start-openagi.sh` on Linux.
Open **http://127.0.0.1:43210/** after the server starts. Keep the terminal open;
Ctrl+C stops it. No administrator access, Git, Node install, or npm command is
needed for these bundles. After saving setup, relaunch if the page asks you to.
Check a downloaded file with `Get-FileHash <file> -Algorithm SHA256` in
PowerShell or `sha256sum <file>` on Linux against its accompanying checksum.

The links above open GitHub Releases, the all-platform download index, while
`https://openagi.sh/download` is a convenience redirect that currently points
to the Mac DMG.

## macOS

1. Open [the latest release](https://github.com/Spshulem/openAGI/releases/latest)
   and download its `.dmg`.
2. Drag OpenAGI to Applications and launch it. The current release workflow
   builds on Apple Silicon; Intel users can run the source runtime below.
3. Open the menu bar icon and follow **Choose → Connect → Start**. Choose
   **Connect & verify**, save your dashboard login, then **Meet your agent**.
4. Choose **Get started** to pick a guided chat. Screen capture, Accessibility,
   account connections, and remote devices are optional, separate steps.

If macOS rejects an installer, check the release and signature; do not disable
Gatekeeper or remove quarantine as a default installation step. See
[native-app build information](../mac/README.md) for source builds.

## Windows from source (PowerShell)

Install [Node.js 22 or newer](https://nodejs.org/en/download), reopen PowerShell,
and check `node --version`. Download and extract the ZIP above, open its
`openAGI-main` folder in PowerShell, then run:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run serve
```

Open **http://127.0.0.1:43210/**. Using `npm.cmd` avoids changing PowerShell's
script execution policy. Keep the terminal open. State lives under
`%USERPROFILE%\.openagi`, separately from the downloaded source folder.
If setup asks for a restart, stop the process with Ctrl+C, run
`npm.cmd run serve` again, then open **Get started**.

Windows runs the web/CLI agent. The Swift menu bar app and its native capture
and input adapters are macOS features. A Windows node does not gain those
capabilities merely by pairing with a Mac.

## Linux and Raspberry Pi

For a supported Debian/Ubuntu/Raspberry Pi OS installation, download and inspect
the installer before running it:

```sh
curl -fL https://openagi.sh/install.sh -o install-openagi.sh
less install-openagi.sh
sh install-openagi.sh
```

The same script is available from the source tree at
`https://raw.githubusercontent.com/Spshulem/openAGI/main/scripts/install.sh`.

The installer chooses an existing Docker installation or a native Node/systemd
path and prints the setup address. It may request sudo to install a system
service or missing prerequisites. Choose the portable archive or source route
if you want to run without system changes. The supported Docker targets are
Linux x64 and arm64; a Raspberry Pi needs a compatible 64-bit OS for arm64.

For a source installation on macOS or Linux, install Node.js 22+ first, then:

```sh
git clone https://github.com/Spshulem/openAGI.git
cd openAGI
npm ci --ignore-scripts
npm run serve
```

Or extract the source archive and run the final two commands in its folder.
Open **http://127.0.0.1:43210/**. To run at login/boot from a source install:

```sh
npm run install-launchd              # macOS
./scripts/install-systemd.sh user     # Linux user service
```

## Connect a model

The first-run wizard at `/setup` has three steps: **Choose**, **Connect**, and
**Start**. Only your selected provider's fields appear. It sends a short test
message and requires a model answer before handing off to chat.

- **Anthropic / OpenAI:** enter your API key. Existing keys stay private and are
  kept when a field is blank. The model can be changed in Model options.
- **ChatGPT plan:** sign in to an eligible account, then verify the connection.
- **Ollama / LM Studio:** start the server, enter its URL ending in `/v1`, and
  the exact installed model name. Ollama defaults to
  `http://localhost:11434/v1`; for example, run `ollama pull llama3.2` and enter
  `llama3.2`. No cloud key is required. `localhost` means the agent's host.
- **Apple Intelligence:** use the native Mac or iPhone app on macOS 26/iOS 26
  with compatible hardware and Apple Intelligence enabled and downloaded.
  The wizard reports the native model's availability. Browser-only runtimes
  do not provide Apple's native model bridge.

After verification, save your dashboard access token and choose **Meet your
agent**. Add integrations, devices, or screen access when you need them.
Reopen **Model & settings** from the sidebar to change models. Existing
integration and channel settings remain under **Advanced settings**.

## Guided setup with a coding agent

If you use Claude Code or Codex, it can walk you through the rest of setup.
The versioned skill lives in [`skills/openagi-setup`](../skills/openagi-setup/SKILL.md).
At the end of a run, `install.sh` offers to install it. You can also run it
any time from an OpenAGI checkout or portable folder:

```sh
sh scripts/setup-agent.sh                      # asks what to do
sh scripts/setup-agent.sh --agent claude       # or: --agent codex | manual
```

It asks before each change. The default answer is no.

- **Skill install:** copies the skill to `~/.claude/skills/openagi-setup`
  and/or `~/.codex/skills/openagi-setup` (`$CODEX_HOME` is respected). An
  identical copy is left alone. A different copy is kept unless you choose to
  replace it, or pass `--force`, and a timestamped backup is made either way.
- **Handoff file:** writes `~/.openagi-setup/HANDOFF.md` with the install
  mode, CLI path and dashboard address. It never contains keys or tokens.
- **Open the agent:** starts Claude Code or Codex in `~/.openagi-setup` in its
  normal permission mode. The first prompt names those files and nothing else.

The skill then checks prerequisites with `openagi doctor`. It has you sign in
with `claude auth login` or `codex login` in your own terminal. It selects
that sign-in with `openagi provider use claude-cli|codex-cli`, which sends one
real test prompt and saves the choice only if it gets an answer. It does not
replace a different working provider unless you add `--replace`. You save the
dashboard login in the browser. The skill finishes with
`openagi chat "Reply with exactly: openagi-setup-ok"`.

API keys, ChatGPT sign-in and local models stay in the browser at `/setup`. The
skill never asks for a key or token.

Without a terminal (CI, provisioning), nothing is installed and the manual
steps are printed. Installer controls: `OPENAGI_AGENT_SETUP=skip`,
`OPENAGI_AGENT=claude|codex|manual` and `OPENAGI_NONINTERACTIVE=1`. Run as your
normal user; as root it only prints the command to run.

A CLI sign-in only works for the OS user the daemon runs as. A system service
running as `openagi`, or a Docker container, cannot use your personal Claude
Code or Codex sign-in. Use the browser providers there.

## Docker

Use the version tag you selected from GitHub Releases, such as the tag shown on
the [latest release](https://github.com/Spshulem/openAGI/releases/latest). Replace `<version>` below
with that tag. The volume keeps state across replacements.
Binding the published port to loopback keeps setup on this computer.

```sh
OPENAGI_AUTH_TOKEN="$(openssl rand -hex 32)"
docker run -d --name openagi --restart unless-stopped \
  -p 127.0.0.1:43210:43210 -v openagi-data:/data \
  -e OPENAGI_AUTH_TOKEN="$OPENAGI_AUTH_TOKEN" \
  ghcr.io/spshulem/openagi:<version>
```

The image requires this token because it listens on all interfaces inside the
container. Open **http://127.0.0.1:43210/** and enter the generated token at
the login prompt. Keep it in your password manager; treat it as the dashboard
password. Configure your model in Settings after signing in.

Docker provides the agent runtime, not native desktop screen access. Configure
and pair a compatible computer node if you need interactive desktop tools.

## Connect a model, then learn in chat

Open `/setup`, choose your model provider, and save your dashboard login.
ChatGPT sign-in is offered in Settings; API-key providers use your own account
and billing. A connectivity error needs repair before you rely on chat. Without
a usable provider, deterministic mode lets you explore the UI but does not
provide normal model reasoning.

Choose **Connect & verify**, save your dashboard access token, then choose
**Meet your agent**. Under **Get started**, pick a goal and choose **Try it in chat**.
Read or edit the starter request and press Send.
See the [first-use guide](GETTING_STARTED.md) for the six flows.

## Common fixes

| Symptom | Check |
| --- | --- |
| Page will not load | Keep the launcher/serve process running; check its terminal. Visit `http://127.0.0.1:43210/health`. A process alone does not prove health. |
| Port already in use | An existing agent may own port 43210. Open that instance or stop it in its owning app/service before starting a second one. Do not delete its state. |
| Setup saved but server stopped | Foreground source and portable installs need the launcher restarted after setup changes. Relaunch and reopen Get started. |
| Agent cannot answer | Reopen Settings, check provider sign-in/key, model availability, balance, and limits. Saving a key is not a successful provider test. |
| Phone cannot connect | A phone cannot use your computer's `localhost`. Use a reachable private address or authenticated HTTPS, then follow the pairing guide. |
| Screen history but no computer input | Check the intended node, its advertised capabilities, current permissions, screen lock, and the separate Computer Use approval. |
| Mac is visible but desktop says main authorization is missing | On that Mac run `openagi reconnect`, then approve the short-lived request from an already paired owner phone. This keeps the node and phone pairing; it does not use a phone code or export the main owner token. |

## Updates and data

The Mac app checks its signed update feed; user preferences control automatic
installation. Source installs can use `npm run update`; keep local source
changes backed up and review the chosen update first. Replace a portable folder
with a newer extracted release while the old process is stopped. Keep your
separate state directory. Docker users replace the container with their chosen
version and retain the data volume.

State defaults to `~/.openagi` (`%USERPROFILE%\.openagi` on Windows).
`OPENAGI_DATA_DIR` selects another directory. Back it up privately; it contains
credentials and personal context. Uninstalling an app or deleting a portable
folder does not remove that state.
