# Universal Browser and Desktop Agent

## Runtime design

Miki does not ship a browser engine and does not use Playwright for browser control. The browser runtime is a loopback-only WebSocket bridge paired with a Miki WebExtension installed into each browser profile.

The extension bundle targets:

| Browser family | Adapter | Status |
| --- | --- | --- |
| Chrome / Chromium | Chromium Manifest V3 WebExtension | Source and packaging included |
| Microsoft Edge | Chromium Manifest V3 WebExtension | Same Chromium bundle |
| Brave | Chromium Manifest V3 WebExtension | Same Chromium bundle |
| Opera | Chromium Manifest V3 WebExtension | Same Chromium bundle |
| Vivaldi | Chromium Manifest V3 WebExtension | Same Chromium bundle |
| Firefox | Firefox WebExtensions manifest | Source and packaging included |
| Safari | Safari WebExtension manifest | Source included; Xcode conversion/signing is required on macOS |

The extension reports the browser identity after connecting. The agent can enumerate, navigate, activate and close tabs, inspect page content, fill and click DOM controls, send keys, scroll and capture the visible tab. A browser that cannot install the extension may only be accessible through its native desktop accessibility controls, with fewer capabilities.

## Desktop application adapters

| Operating system | Native interface | Capabilities and limits |
| --- | --- | --- |
| Windows | Microsoft UI Automation + Win32 | App/window discovery, semantic control inspection and invocation, text entry, keyboard/mouse actions, screenshots, process and system information |
| macOS | System Events Accessibility scripting + `open` | App/window discovery, semantic inspection and invocation, text entry, keyboard shortcuts, screenshots and app launch. Accessibility and Screen Recording permissions remain controlled by macOS; coordinate drag/click/scroll are not implemented |
| Linux X11 | AT-SPI + xdotool and system utilities | Accessible app/window discovery, semantic controls, keyboard/mouse actions, clipboard and screenshots when the required utilities are installed |
| Linux Wayland | AT-SPI | Semantic accessibility operations can work when the AT-SPI bus is available. X11 coordinate input and X11 screenshots are not available in a Wayland-only session in this backend |

The agent uses semantic controls first. Custom canvas-rendered interfaces, inaccessible controls, remote desktops and applications that expose no accessibility tree may need visual/coordinate interaction or may remain partially controllable. No adapter can guarantee complete control of every application.

## Confirmation and operating-system permissions

The owner configuration disables Miki's per-action confirmation prompts (`tools.auto_approve_all: true`, `sandbox_mode: true`, and both confirmation flags disabled). It also enables unrestricted file-tool paths (`autonomy.tool_policy.allow_all_paths: true`) and full computer/browser capabilities. `sandbox_mode` is an application feature switch, not an OS sandbox. This profile can affect files, processes and applications visible to the Miki process account, so run it inside a disposable VM/container. Hard platform capability requirements and OS-level authorization remain enforced.

This does **not** bypass operating-system security. The user must still install and pair browser extensions and grant whatever permissions the browser or OS requires. macOS Accessibility/Screen Recording permissions, Linux desktop-session/AT-SPI access and browser extension host permissions are enforced by their respective platforms. Miki cannot silently grant these privileges.

## Build and install

```bash
npm ci
npm run build:all
```

The core build copies the source extension into `packages/core/dist/plugins/browser/extension/{chrome,firefox,safari}`. Install the matching unpacked extension from the relevant folder and enter the local bridge URL and pairing token shown by Miki's browser bridge information. Safari additionally requires conversion/signing through Xcode.

No browser binary is downloaded by npm install, and no Playwright browser installer is used.

## Verification boundaries

Automated tests validate the WebExtension manifests, packaged files, bridge authentication/state reconciliation, and desktop utility logic. They do not prove that a particular locally installed browser or GUI application is controllable on the user's machine. Live qualification must be performed on each target OS with a logged-in desktop session and the corresponding platform permissions.

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](../AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
