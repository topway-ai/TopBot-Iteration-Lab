# TopBot Windows Updates

## Scope

The Windows fork uses its own ZIP transaction runner, not the upstream NSIS
auto-installer. `automaticUpdates` remains false for the legacy updater;
`managedWindowsUpdates` enables this separate path. Only published, immutable,
non-prerelease releases in `topway-ai/TopBot-Iteration-Lab` with `topbot-windows-update.json`
are eligible. A higher version is required. No GitHub credential is stored in
the desktop app. SHA-256 detects corruption; trust in unsigned releases still
depends on the GitHub repository and TLS, not an independent signing key.

## Flow

1. On AC power, check after startup and every six hours. Background checks
   wait while a bot, call, move or other desktop job is active.
2. Validate repository, version, data-format epoch, platform, size and URL.
   Stream the bounded ZIP download and verify its exact size and SHA-256.
3. Extract serially in a new transaction directory. Reject traversal,
   duplicate names, symlinks, Windows device names and oversized archives.
   Check the packaged identity before offering a restart.
4. At the existing quiet moment, or after Install, recheck resources/work.
   Pause new tasks with a temporary, nonpersistent server freeze. Start the
   independent helper, verify its PID/nonce receipt, then allow the handoff
   and quit normally. A failed helper launch leaves the app open and thaws it.
   A lost handoff's temporary freeze expires after 30 seconds.
5. Wait for this installation's processes to exit. Never force-stop the old
   program. Snapshot the active workspace, primary data folder and desktop
   profile while closed; caches listed in snapshot.json are excluded.
   Internal directory junctions are recorded in the snapshot manifest, not
   followed; their real targets are copied once. External, missing or
   unsupported links stop the update before the program is replaced.
6. Rename the old program into `previous`, then move the staged program into
   its place. No executable is patched while it runs.
7. Start the new executable with the same profile and a one-time health ticket.
   Require the expected PID/version/epoch, live desktop renderer and local
   server for 30 continuous seconds within a 180-second deadline.
   The candidate opens the desktop to validate the renderer even if the
   previous window was closed to the tray when the update started.
8. On failure, request the candidate's normal shutdown, stop only candidate
   installation processes if necessary, restore the previous program and
   restart it. Block the failed release from automatic retries.

Every switch is journaled before moving files. A per-user RunOnce recovery
entry, pointing outside the replaced installation, handles a machine restart
during a transaction. It removes only its own entry on completion. A file
lock prevents concurrent helpers. No execution-policy, firewall, antivirus,
permission-mode or model setting is changed.
The short bootstrap keeps the RunOnce command below Windows' 260-character
limit; a longer custom path is refused before the application exits.

The helper requires PowerShell 7. Use the standard Program Files install or
provision `%USERPROFILE%/.topbot-updates/runtime.json` with an absolute
`powershell` executable path. A missing runtime stops before shutdown.
The system's Windows PowerShell execution policy is left unchanged.
On this laptop a dedicated PowerShell 7 runtime lives under the update root,
so clearing the Codex runtime cache does not remove the update engine.

## Recovery And Data

In the local Windows main window, open **You > Updates and recovery** to
check, install a prepared update, roll back the latest managed update, or
open backups. The notification-area menu offers the same recovery controls.
**You > Quit TopBot completely** exits the app after confirmation.
Rollback requires confirmation and retains current chats, files and keys.
It does NOT restore the older data snapshot automatically. Snapshots include
private data and must remain local. Restore one manually only after assessing
newer data that would be lost.

`dataEpoch: 1` declares backward-compatible data. Bump it for an incompatible
migration: the current updater will refuse that release. Do not merely keep
the number unchanged to bypass this gate. A data migration needs a separate
reviewed migration/restore plan. Successful startup does not prove every
agent workflow; release CI and focused regressions remain mandatory.

The update root is `%USERPROFILE%/.topbot-updates`, outside AppData's possible
MSIX virtualization. Transactions contain the
plan, state, helper, snapshot and previous program. Keep the newest three
terminal transactions, plus the current last-good rollback target. Pending
or unrecognized records are not automatically deleted. Completed ZIPs are
removed on the next check/start. Insufficient space pauses updates rather
than deleting unrelated user files.

## Resource Budget

- Minimum 3 GB available RAM and a 3 GB disk reserve.
- ZIP at most 3 GB, expanded package at most 8 GB / 50,000 entries.
- Snapshot at most 12 GB / 100,000 files, bounded preparation/snapshot time.
- One helper, below-normal priority, serial copy/extraction, no GPU or model.
- These are sampled fail-fast checks, not a hard OS memory/CPU sandbox.

## Verification

Run one job at a time:

```powershell
node --test --test-concurrency=1 electron/topbot-update.node-test.mjs electron/updater-coordinator.node-test.mjs electron/update-when-quiet.node-test.mjs electron/startup-tray.node-test.mjs
pnpm exec vitest run server/move-freeze.test.ts server/move-freeze-thaw.test.ts electron/updater.test.mjs --maxWorkers=1
```

The Windows transaction tests compile a tiny offline fixture executable,
use temporary installs/data/profiles, and disable RunOnce registration.
They cover success, proactive rollback retaining newer data, crash, failed
health checks, a nonresponsive candidate requiring termination, interrupted rename, snapshot refusal, corrupted download,
archive traversal and invalid install paths. They never touch the live app.
The Node tests cover source/compatibility/resource gates, serialized checks,
busy-task refusal, helper failure and authenticated health receipts.

Also qualify the real packaged build using a disposable profile/workspace.
Do not infer a working desktop from just the tiny executable fixture.
The server harness alone does not prove native update controls or Windows
login recovery; those need packaged smoke tests and a controlled reboot.

### Local Qualification, 2026-11-17

- 81 existing Node idle-scheduler/startup/updater tests and 16 managed-update
  tests passed, including parent-process exit and internal skill junctions.
- 25 server-freeze/updater regression tests passed; server TypeScript build
  and scoped lint checks passed.
- The real 0.1.161-topbot.5 package passed an isolated .4-to-.5 transaction:
  1,017,064,666-byte archive, 25.647 seconds preparation, 39.606 seconds apply
  including the continuous 30-second health check. The fixture exited
  gracefully (zero fixture processes needed forced cleanup).
- The real per-user RunOnce entry was registered and removed successfully.
  A simulated interrupted switch and failure rollback were exercised; an
  actual Windows reboot during a transaction has NOT been tested.
- Packaged server probes passed: standalone startup, 14 proxy paths, MCP,
  CLI, encrypted backup, loopback trust gate, desktop entry and enterprise
  loading. Public GitHub release discovery worked, with no newer compatible
  release available. No GitHub workflow run or publication was performed.
- This laptop reused its unchanged installed renderer and native runtimes;
  desktop scripts, server and skills were rebuilt. A full Vite build stopped
  at a 2 GB heap cap, so it was not used to claim a new renderer build.
- A live-data attempt correctly stopped before replacing the old program
  when it encountered internal CodeGraph skill junctions. Support was added
  with a focused regression. The subsequent .6 build qualified with a rebuilt
  renderer and completed the .4-to-.6 upgrade and startup checks.

For the packaged main-window smoke test, run
`node scripts/stage-topbot-menu-test.mjs` after local packaging and qualification.
It stages the qualified archive in a disposable installation with a test-only
lower version and its own data/profile. Use **You > Updates and recovery >
Install prepared update** there and check the displayed versions after restart.
Verify the transaction committed and the sentinel exists both in the snapshot
and in the current data. For the qualified prior-version fixture, run
`scripts/test-qualified-rollback.ps1 -Mode Open` in PowerShell 7, choose
rollback in its window, then run the script with `-Mode Verify`. This checks
the restored program and data written after the upgrade. Operate on the
disposable windows only; a normal close can leave the app in the tray.

The initial transition from a build without this updater must happen while
the old app is normally closed. With a successful real-package report:

```powershell
node scripts/install-topbot-local.mjs .omb-scratch/topbot-update-package-result.json
```

This bootstrap uses the same transaction helper, snapshots and health gate.
It targets the per-user TopBot install, default workspace (plus OMB_DATA_DIR
when set) and existing desktop profile. Named/nondefault active workspaces
must be accounted for explicitly before bootstrapping. Subsequent updates
use the app's active-workspace discovery and normal shutdown automatically.
Rolling back to a pre-managed build also removes the managed updater until
a later reviewed bootstrap. Machine-specific reports remain untracked in
`.omb-scratch`; snapshots and keys must never be committed.

## Release

The `TopBot Windows Update` GitHub workflow only accepts main in
`topway-ai/TopBot-Iteration-Lab`. It tests, builds, smoke-tests and generates the manifest.
Its default is artifact-only. With Publish checked, a separate write-scoped
job creates a draft, uploads both ZIP and manifest, then publishes. Existing
tags/releases are never overwritten. This workflow does not grant the bot
permission to push or publish its own changes.

Local artifact generation after a Windows ZIP build:

```powershell
node scripts/topbot-update-manifest.mjs
```
