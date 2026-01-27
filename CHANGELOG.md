# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-01-27

### Added

- **Tailscale support** for secure remote mobile access
  - New `-t, --tailscale` option to prefer Tailscale IP for mobile server
  - Access mobile web UI from anywhere in your Tailnet (not just local Wi-Fi)
  - WireGuard encryption provides secure communication over any network
  - Automatic fallback to local IP if Tailscale is not connected

### Changed

- Extract `resolveServerIP()` function to reduce code duplication
- Unify `DEFAULT_SERVER_PORT` constant in `src/constants.ts`

## [1.1.11] - 2026-01-26

### Fixed

- Fix Ghostty focus from Web UI when Ghostty is in background
  - Add `activate` call before menu operations to bring Ghostty to foreground
  - Required when Web UI triggers focus while another app is active on Mac

## [1.1.10] - 2026-01-26

### Fixed

- Fix Ghostty focus not working when multiple windows are open
  - Click Window menu item twice (Ghostty quirk: first selects tab, second brings window to front)
  - Use `name` attribute instead of `title` for Window menu search
  - Add `AXRaise` to ensure window comes to front
  - Remove `activate` call that brought ccm window back to front
- Fix Web UI sendText/sendKeystroke targeting wrong session in Ghostty
  - Focus correct tab before sending text/keystroke
  - Prevents input going to currently active window instead of target session

### Changed

- Simplify Ghostty focus logic by removing complex tab cycling in favor of Window menu click

## [1.1.9] - 2026-01-25

### Fixed

- Improve Ghostty focus timing for multi-tab windows
  - Use menu-based tab navigation ("Show Next Tab") instead of keystroke-based approach
  - Works reliably regardless of user keybinding configuration
  - Iterate through all windows and tabs to find the target session

### Added

- Auto-detect Ghostty and prompt for `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` setting
  - Prevents Claude Code from overwriting terminal titles during execution
  - Required for reliable tab identification in Ghostty
  - Prompt appears on `ccm` launch or `ccm setup` for Ghostty users
  - User's choice is remembered to avoid repeated prompts

### Changed

- Separate confirmation prompts for hooks setup and Ghostty settings
- Remove unused internal exports for cleaner API

## [1.1.8] - 2026-01-24

### Security

- Bind server to specific IP instead of 0.0.0.0
  - Server now listens only on the IP displayed in QR code
  - Reduces attack surface from other network interfaces

## [1.1.7] - 2026-01-23

### Fixed

- Fix Ghostty focus not working when Ghostty is already the active application
  - Add 0.3s delay after title set for Window menu propagation

## [1.1.6] - 2026-01-23

### Added

- Full focus support for Ghostty terminal (title-based window targeting via Window menu)

### Changed

- Update README to reflect Ghostty full focus support

## [1.1.5] - 2026-01-22

### Changed

- Add npx execution method to README Quick Start section

## [1.1.4] - 2026-01-22

### Added

- Real-time modal content update in mobile web UI
  - Session messages now update automatically while modal is open
  - Waiting state (permission prompts) updates in real-time
  - Modal auto-closes when the session is deleted

## [1.1.3] - 2026-01-22

### Security

- Bundle marked v12.0.2 and DOMPurify v3.3.1 locally (remove external CDN dependency)
- Add server-side dangerous command blocking (rm -rf, sudo rm, mkfs, dd, chmod 777, curl|sh, wget|sh)
- Remove external QR code API call that leaked authentication tokens
- Add prominent public Wi-Fi security warning to README

### Changed

- Static library files (/lib/*.js) no longer require authentication token

## [1.1.2] - 2026-01-22

### Security

- Fix XSS vulnerabilities in mobile web UI
  - Add `escapeHtml()` for all user-provided content
  - Add `isValidSessionId()` validation
  - Replace inline onclick with event delegation pattern
- Enhance AppleScript sanitization (escape `$` and backtick characters)

### Fixed

- Add WebSocket client error handler to prevent process crashes
- Fix race condition in useServer hook when component unmounts during async operation
- Close net server on port availability check error

### Changed

- Add SIGTERM handler for graceful shutdown in containerized environments (Docker/K8s)
- Terminate all WebSocket clients explicitly before server shutdown

## [1.1.1] - 2026-01-22

### Changed

- Documentation improvements (README, CLAUDE.md)

## [1.1.0] - 2026-01-22

### Added

- **Mobile Web Interface** - Monitor and control sessions from your smartphone
  - Real-time session status via WebSocket
  - View latest Claude messages with markdown rendering
  - Focus terminal sessions remotely
  - Send text messages to terminal (multi-line supported)
  - Permission prompt responses (y/n/a) and Ctrl+C support
  - Bottom sheet modal with swipe-to-close gesture
- New command: `ccm serve` - Start mobile web server only
- QR code display in terminal UI (press `h` to toggle)
- Token-based authentication for mobile access
- Auto-select available port when default port (3456) is in use

### Changed

- Redesigned README with demo GIFs for both Terminal UI and Mobile Web
- Consolidated terminal fallback strategy for better code maintainability

### Security

- Mobile Web requires same Wi-Fi network (local network only)
- Unique token generated per session for authentication
- Warning messages about not sharing the access URL
- Dangerous command detection in mobile input

## [1.0.4] - 2026-01-18

### Fixed

- Use alternate screen buffer to prevent TUI stacking on re-render ([#5](https://github.com/onikan27/claude-code-monitor/pull/5)) by [@msdjzmst](https://github.com/msdjzmst)

## [1.0.3] - 2026-01-17

### Changed

- Update README: Add macOS-only badge and note, rename demo gif

## [1.0.2] - 2026-01-17

### Fixed

- Handle undefined cwd in session display (shows "(unknown)" instead of crashing)
- Ensure hook data is written before process exits

### Security

- Set file permission 0o600 for settings.json

## [1.0.1] - 2026-01-17

### Changed

- Improve performance with debounced file writes and session updates
- Add TTY cache size limit to prevent memory growth

## [1.0.0] - 2026-01-17

### Added

- Initial release
- Real-time monitoring of multiple Claude Code sessions
- Terminal UI (TUI) with keyboard navigation
- Focus feature to switch to session's terminal tab
  - Full support for iTerm2 and Terminal.app (TTY-based targeting)
  - Limited support for Ghostty (app activation only)
- Automatic hook setup via `ccm setup`
- Session status tracking (running, waiting for input, stopped)
- File-based session state management (no server required)
- Session auto-cleanup on timeout (30 minutes) or TTY termination
- Commands: `ccm`, `ccm watch`, `ccm setup`, `ccm list`, `ccm clear`
