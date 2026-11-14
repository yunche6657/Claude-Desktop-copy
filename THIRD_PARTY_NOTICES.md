# Third-party components

This inventory records known origins and publication exclusions. It does not grant rights beyond each component's own license.

| Component | Origin | Distribution in this repository |
|---|---|---|
| Electron | https://github.com/electron/electron | npm development dependency; runtime binaries excluded |
| electron-builder | https://github.com/electron-userland/electron-builder | npm development dependency; generated installer excluded |
| Claude Code Best runtime | https://github.com/claude-code-best/claude-code | setup script only; generated agent-core excluded |
| Bun | https://github.com/oven-sh/bun | setup script only; binary excluded |
| Desktop frontend ion-dist | Locally pinned desktop frontend snapshot; related public extraction: https://github.com/rianprei/claude-desktop-analysis/tree/main/resources/ion-dist | Included as precompiled assets with per-file SHA-256 inventory; not relicensed under MIT. The related public extraction is not asserted to be the exact same build. |
| Desktop icons in desktop/assets | Reconstruction workspace assets; precise provenance not established | Included in source snapshot for review; reuse rights have not been established |
| i18n overlay | Reconstruction workspace localization data | Included for review; full provenance review pending |
| Public suffix data | See desktop/native-public-suffix.cjs and its source comments | Embedded data/source; review upstream terms before redistribution |

Original project code is licensed under MIT; see LICENSE. Third-party compiled frontend assets, data, icons and trademarks retain their own terms and are not relicensed under MIT. The complete desktop frontend's original source project is not available in this repository; its import utility handles prebuilt assets only.
