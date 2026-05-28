# Auqw Reproducible Build Environments

This directory stores reproducible build environments for supported Auqw targets.

Use real containerfiles where the platform supports that model:

- `linux-flatpak/Containerfile`
- `android-linux/Containerfile`
- `windows/Containerfile`

Use host setup recipes where the platform requires native OS tooling:

- `macos/Brewfile`
- `ios/Brewfile`

GitHub workflow files should orchestrate these environments. Platform dependencies live here.

