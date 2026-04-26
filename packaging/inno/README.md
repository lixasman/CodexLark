# CodexLark Inno Setup packaging

This folder contains the product installer definition for the Windows EXE packaging flow.

## Prerequisites

Before building, confirm the Inno Setup compiler is installed and available:

```powershell
Get-Command node
Get-Command npm
Get-Command iscc
```

Expected result: PowerShell can resolve usable command sources for `node`, `npm`, and `iscc`.

Note: these `Get-Command` checks are only a quick maintainer preflight. The actual helper uses the same resolver as the process runner and prefers executable `Application` entries when multiple command sources exist (for example `npm.cmd` over `npm.ps1`).

The packaging helper also expects:

- a completed `npm run build`
- the repository `dist/` output
- a usable local `node.exe`
- staging/output paths under `artifacts\packaging\`

## Build entrypoint

Run the packaging helper from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package\build-installer.ps1
```

Expected result:

- the helper stages `node.exe`, `dist/`, bridge scripts, support docs, and launchers
- the helper calls `iscc`
- the final EXE lands under `artifacts\packaging\output`

If you want the full maintainer release dry-run instead of packaging only, use:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package\run-product-installer-release-dry-run.ps1
```

Expected result:

- it runs `npm run build`
- it runs `node .\scripts\run-node-tests.cjs`
- it packages the installer
- it leaves logs and `release-dry-run-summary.json` under `artifacts\release-dry-run\...`

## Notes

- The helper builds a staging tree first so the `.iss` file only packages already prepared payloads.
- The helper resolves the bundled runtime from Node's real `process.execPath`; if your machine uses a shim manager and you want to pin a different runtime, pass `-BundledNodePath <full-path-to-node.exe>`.
- `StageRoot` and `OutputRoot` are intentionally constrained to `artifacts\packaging\...` so the helper cannot recursively delete arbitrary directories by mistake.
- The installer writes into `Program Files\CodexLark`.
- After install, the installer syncs the runtime manifest and launches `dist/setup-cli.js first-run` back in the original desktop user context.
