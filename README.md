# DockLite WSL

A lightweight Windows desktop dashboard for managing Docker that runs inside
WSL 2 — without needing Docker Desktop.

DockLite WSL drives the Docker CLI inside your chosen WSL distro, so there is
nothing extra to install or configure: if you already run Docker in WSL,
you are ready to go.

<!-- Tip: add a screenshot here, e.g. ![DockLite WSL](docs/screenshot.png) -->

## Features

- **WSL distro picker** — choose which installed WSL 2 distro to manage; your choice is remembered.
- **Dashboard** — at-a-glance counts plus live CPU and memory usage across running containers.
- **Containers** — searchable, filterable list (All / Running / Stopped) with one-click start, stop, restart, and delete. The list auto-refreshes, so status changes appear on their own.
- **Container detail view** — open any container in a full-page tabbed view:
  - **Overview** — status, image, command, ports, network, restart policy, timestamps.
  - **Stats** — live CPU and memory charts, network and block I/O, PID count.
  - **Logs** — real-time streaming logs with auto-scroll.
  - **Config** — environment variables, mounts, networks, labels, and the raw `docker inspect` JSON.
  - **Processes** — processes running inside the container.
  - **Exec** — run one-off commands inside the container.
- **Multiple open containers** — keep several containers open as sidebar tabs and switch between them; log streams keep running in the background.
- **Images** — browse images and deploy any of them as a container.
- **Deploy** — launch a new container with a custom name, port mapping, and environment variables.
- **Prune** — one-click cleanup of stopped containers, unused networks, dangling images, and build cache.

## Requirements

- Windows 10 (1903+) or Windows 11
- WSL 2 with a Linux distro installed
- Docker installed and working inside that WSL distro
- WebView2 runtime (pre-installed on Windows 11)

## Installation

Download the latest installer (`DockLite WSL_x.y.z_x64-setup.exe`) from the
[Releases](../../releases) page, run it, then launch DockLite WSL and select
your WSL distro to begin.

## Building from source

Prerequisites: Rust (MSVC toolchain), Visual Studio C++ Build Tools, and the
Tauri CLI.

```powershell
cargo install tauri-cli --version "^2.0" --locked
cargo tauri build
```

The installer is produced at
`src-tauri/target/release/bundle/nsis/`.

## How it works

DockLite WSL is a [Tauri 2](https://tauri.app) app — a Rust backend with a
plain HTML/CSS/JavaScript frontend. The backend runs `wsl -d <distro> docker ...`
commands, so it needs no Docker socket setup or daemon configuration. Container
logs are streamed live by long-running `docker logs -f` processes that push
each line to the UI.

## Notes

- Windows-only — the app depends on WSL.
- The **Exec** tab runs each command in a fresh shell, so the working directory
  and shell variables do not persist between runs.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
