# Building from Source

You can build Smart Job Seeker from source instead of using a pre-built binary. This gives you full control over what you're running.

## Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org/)
- **Rust 1.77+** — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Platform-specific dependencies** (see below)

### macOS

```bash
xcode-select --install
```

### Linux (Debian/Ubuntu)

```bash
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

### Windows

- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10/11)

## Build

```bash
git clone https://github.com/nicegui/smart-job-seeker.git
cd smart-job-seeker/desktop

# Install dependencies
npm install
cd src/ui && npm install && cd ../..

# Build everything (sidecar + UI + Tauri app)
npm run build
```

The installer will be in `src-tauri/target/release/bundle/`:

- **macOS**: `.dmg` in `bundle/dmg/`
- **Windows**: `.msi` in `bundle/msi/` and `.exe` in `bundle/nsis/`
- **Linux**: `.deb` in `bundle/deb/` and `.AppImage` in `bundle/appimage/`

## Development

```bash
# Run the sidecar directly (no Tauri, quickest iteration)
npm run dev

# Run the sidecar in IPC mode (stdin/stdout JSON)
npm run dev:sidecar

# Run the full Tauri app (requires Rust toolchain)
npm run tauri:dev
```

## Verifying the build

The JavaScript sidecar bundle is deterministic (produced by esbuild). You can verify it matches a release:

```bash
# Check out the release tag
git checkout v0.1.0

# Build just the JS bundle
npm run sidecar:bundle

# Compare hash
sha256sum dist/sidecar-bundle.cjs
```

The compiled Tauri binary is not bit-for-bit reproducible due to Rust compiler non-determinism, but the sidecar bundle hash confirms the application logic matches the source.
