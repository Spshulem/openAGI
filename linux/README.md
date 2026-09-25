# OpenAGI Linux companion

This directory contains an independent Linux desktop companion for OpenAGI. It targets Fedora KDE Plasma on Wayland and keeps the existing OpenAGI HTTP, observation, approval, lease, and Computer Use contracts.

The companion provides:

- active application and window metadata from an observation-only KWin script;
- screen capture through XDG Desktop Portal ScreenCast and PipeWire;
- local OCR with Tesseract;
- activity and OCR observations through `POST /observations`;
- Quick Ask through the existing `POST /message` SSE endpoint;
- a Plasma system tray and `Ctrl+Alt+Space` Quick Ask shortcut;
- Computer Use through a private Unix socket and a one-shot helper compatible with the existing Node executor;
- separate XDG RemoteDesktop consent for pointer and keyboard control.

The Linux companion does not implement iMessage. That integration remains specific to the Apple ecosystem.

## Consent and privacy

Screen capture and remote control are disabled at startup. Opening the dashboard or starting the service does not create a portal session. The user must select **Enable screen context** or **Enable computer control** from the tray before the corresponding KDE portal request is made.

ScreenCast and RemoteDesktop use separate portal sessions and separate restore tokens. Enabling capture never silently enables control. OpenAGI's existing approval, bounded lease, fresh-frame, sequence, expiration, and cancellation checks still govern agent actions after portal control has been enabled.

Observation and Quick Ask frames remain in memory, are passed to Tesseract on stdin, and are discarded; only OCR text and minimal window metadata are sent through those HTTP routes. The durable outbox contains only observation JSON with application, window, timestamp, confidence, and OCR text. It is bounded to the newest 256 batches, 8 MiB, and 24 hours; older entries are deleted locally. Use **Delete queued screen context** in the tray to erase it immediately.

Computer Use screenshot responses are returned to the OpenAGI core over the private helper/RPC path so an approved visual-control action can inspect the frame. This is a separate flow: its PNG bytes are never stored in the observation outbox, but they can enter the core's tool/model context and are subject to that configured provider's retention boundary. Typed text is sent to the helper over stdin and is not placed in process arguments.

Capture is rejected before requesting a frame and checked again before OCR when focus is unknown, stale, sensitive, or changes during capture. Password managers, wallets, messaging applications, private/incognito windows, password/passkey pages, authenticators, recovery phrases, API-key pages, card-number pages, and online-banking windows are excluded by default.

Additional exclusions can be configured as comma-separated literal values:

```ini
OPENAGI_LINUX_EXCLUDED_APPS=org.example.Vault,org.example.PrivateChat
OPENAGI_LINUX_EXCLUDED_TITLE_TERMS=Payroll,Client Secret
```

Application values are matched case-insensitively against the desktop application identifier. Title terms are escaped before they are added to the privacy patterns.

## Runtime requirements

The supported path expects:

- Python 3.11 or newer;
- PySide6, `dbus-next`, Pillow, PyGObject, and GStreamer Python bindings;
- GStreamer with PipeWire, app sink, video conversion, and PNG encoding support;
- Tesseract with the configured OCR languages (`spa+eng` by default);
- `xdg-desktop-portal` and `xdg-desktop-portal-kde`;
- KDE Plasma/KWin 6 on Wayland;
- a user systemd manager.

The installer does not install or elevate privileges for system packages. Its preflight fails if required commands or Python modules are absent.

## Install for the current user

Computer Use accepts control requests only from the trusted `openagi.service` cgroup. Before activating the companion, place the OpenAGI checkout on a durable HOME/NVMe checkout (not a removable or compatibility filesystem) and install the existing rootless core service from that copy:

```bash
./scripts/install-systemd.sh user
```

The companion installer refuses activation when that user unit is absent. `--dry-run` reports the prerequisite and `--stage-only` remains available for package verification without starting either service.

Inspect the paths without changing the system:

```bash
./linux/install-user.sh --dry-run
```

Stage the package and files without changing the running KWin or systemd state:

```bash
./linux/install-user.sh --stage-only
```

Install, enable the KWin script, and start the user service:

```bash
./linux/install-user.sh
```

The Python environment is installed below `~/.local/share/openagi-linux-companion`, while mutable state is kept on the home filesystem below `~/.local/state/openagi/linux-companion`. Entry points are linked into `~/.local/bin`.

The installer adds a user-service drop-in that sets:

```ini
OPENAGI_COMPUTER_BACKEND=native
OPENAGI_COMPUTER_HELPER=%h/.local/bin/openagi-linux-helper
OPENAGI_COMPUTER_USE=1
```

It restarts the required `openagi.service` after installing the helper drop-in only when that service is already active. It does not enable capture or control.

To remove installed code, the KWin script, and units:

```bash
./linux/install-user.sh uninstall
```

The state directory is intentionally retained so uninstalling does not silently destroy queued observations or portal restore tokens.

## Configuration

The companion service optionally reads `~/.config/openagi/linux-companion.env`. Restrict the file to the current user if it contains an OpenAGI token:

```bash
chmod 600 ~/.config/openagi/linux-companion.env
```

Supported variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAGI_LINUX_BASE_URL` | `http://127.0.0.1:43210` | OpenAGI endpoint; non-loopback plain HTTP is rejected |
| `OPENAGI_AUTH_TOKEN` | empty | Bearer token for the local OpenAGI server |
| `OPENAGI_LINUX_OCR_INTERVAL` | `15` | OCR cadence in seconds, from 1 to 3600 |
| `OPENAGI_LINUX_OCR_LANGUAGE` | `spa+eng` | Tesseract language list |
| `OPENAGI_LINUX_TESSERACT` | discovered from `PATH` | Absolute or executable Tesseract path |
| `OPENAGI_LINUX_EXCLUDED_APPS` | empty additions | Extra application identifiers |
| `OPENAGI_LINUX_EXCLUDED_TITLE_TERMS` | empty additions | Extra literal title terms |

## Operation and diagnostics

Check dependencies and portal-advertised capabilities without opening a permission selector:

```bash
openagi-linux-companion --doctor
```

Inspect the service:

```bash
systemctl --user status openagi-linux-companion.service
journalctl --user -u openagi-linux-companion.service
```

Tray actions are available for Quick Ask, capture, control, pausing observations, deleting queued screen context, and quitting. Portal denial or revocation leaves the relevant capability disabled; the companion does not fall back to X11 or claim that an unverified action succeeded.

The shortcut is registered by KWin as `OpenAGI Quick Ask`. If `Ctrl+Alt+Space` conflicts with an existing shortcut, assign another key in **System Settings → Keyboard → Shortcuts → KWin**; the tray action remains available as a fallback.

## Development verification

Run the Linux suite without opening portal sessions:

```bash
QT_QPA_PLATFORM=offscreen python3 -m unittest discover -s linux/tests -p 'test_*.py' -v
```

Run the existing Node suite with:

```bash
npm test
```

The live portal property test reads advertised source, cursor, and device types only. A real ScreenCast or RemoteDesktop end-to-end test requires an explicit user interaction with KDE's portal dialog and is therefore not part of unattended test execution.
