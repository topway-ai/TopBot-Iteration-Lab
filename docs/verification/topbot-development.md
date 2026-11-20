# TopBot Development From Chat

The explicit trigger is `/topbot-development` or `TopBot development`.
The chat can check readiness, prepare a change
in a separate worktree, run focused checks and open a draft pull request.
It cannot merge, publish, install or edit the running application through this
controller. Source or workflow edits stay local for independent review before
any same-repository push. CodeGraph provides context, not publish authority.

## Local Setup

Keep `topbot-development.cmd`, `topbot-development.mjs` and `config.json` in
`%USERPROFILE%/.topbot-development`, outside every editing worktree. Configure
`checkout` as a local clone whose fetch and push remote is the pinned TopBot
repository. Set `worktrees` to an existing separate directory on a roomy disk.
The launcher uses the installed CodeGraph Node runtime or a Node on PATH.
Install the two skill files in the app's private `skills/topbot-development`
directory to enable it before the next packaged version. Do not overwrite
existing skills or expose that data directory in a commit.

`doctor` is read-only. `start` requires at least 3 GiB of available RAM and
6 GiB of free staging disk and allows one active worktree. `finish` archives
the job without removing files. Keep local checks focused and serial; package
Windows on GitHub. The threshold is a preflight, not a hard OS resource limit.

`draft` depends on authorized Windows Git Credential Manager access for
`topway-ai`. The controller uses it only for the pinned repository, verifies
the GitHub account and exact draft SHA, and never writes or prints its token.
For eligible edits, it reconstructs the reviewed tree from the remote base
and inspected file objects, and pushes a one-commit snapshot. Original
development commits, messages and intermediate files are not sent.
Published job branches are immutable. For a revision, start a new job with
a new slug. A retry may report the same matching draft, not overwrite it.
It has no release operation. That is a restriction of this controller, not
a sandbox for a bot granted unrestricted shell or browser access. Enforce
repository permissions and protected paths separately; never give the routine
development bot unrestricted owner credentials or automatic approval.

## Automatic Iteration

In a provisioned Windows desktop, send one direct `/topbot-iterate REQUEST`
message. The authenticated local owner is the only caller. The installed
controller uses a workspace-limited coding runner and reads GitHub
credentials separately from the editor. One job runs at a time.

The controller uploads only a sanitized single-commit snapshot. A trusted
base-checkout workflow audits the changed paths and file objects without
executing candidate code. The automatic lane accepts ordinary UI code under
`src/components` and `src/lib`, release notes and an exact version bump.
Release policy, credentials, dependencies, CI and migrations cannot be edited
by an iteration.

The protected main branch must require GitHub Actions' `CI` and `TopBot
automatic review` checks, block deletion and force pushes, and have no
manual review requirement or bypass actors. After both checks pass on the
exact snapshot and base, the controller runs full CI and an artifact-only
Windows qualification on that exact candidate, then downloads and verifies
the qualification artifact. Only then does GitHub apply a non-forcing
atomic ref update. The local publisher rechecks CI and repository policy
before reserving a tag and before publishing the same qualified archive.
There is no second chat confirmation, human review or approval environment.

Provision the trusted local `automatic` configuration in
`%USERPROFILE%/.topbot-development/config.json` with `enabled` and an absolute
`nodeExecutable` path. The built-in editor calls the existing OpenRouter
connection and uses `deepseek/deepseek-v4-flash` unless `automatic.model`
pins another DeepSeek model. It sends only the request and selected public
source blobs. The model receives no tools, does not execute on this computer,
and returns exact text replacements for bounded, already tracked UI files.
For an isolated fixture or a small offline edit, `automatic.editor` can be
`local-qwen`. This uses the pre-existing llama.cpp service on loopback;
name the exact eligible UI path in the request. It does not use or need an
OpenRouter key.
If an external `workerExecutable` is configured instead, it must run in a
separate profile without access to the owner's data or credentials. The required workflows and
review script must already be installed on the trusted main branch. Rehearse
with disposable data before changing an existing production install or
repository policy. The controller never disables protection as a fallback.

Enable GitHub Immutable Releases for this repository before testing a
production dispatch. The publisher checks the setting and verifies the
published release is immutable. Automatic publication reads policy locally
through the authenticated GitHub controller; GitHub Actions only builds.
When using the optional manual dispatch, give its policy check its own
repository-scoped read-only credential via `TOPBOT_RELEASE_POLICY_TOKEN`
in the main-only `topbot-windows-release` environment. It
needs read access to Administration, Actions, Contents and Pull requests.
The policy credential is only used for GitHub GET requests, never for tags
or uploads. Do not use a broad developer or owner token for this secret.
Changing the pinned main ruleset requires a newly reviewed policy revision.
Limit release writers: drafts remain mutable until GitHub publishes them.

Before either release path can publish, configure an active repository **tag**
ruleset covering `refs/tags/v*` (no exclusions or bypass actors). Restrict
updates and deletions, not creation. The owner must be able to read the full
rule, including its bypass list. The iteration controller reads it before
dispatch and passes its ID and revision to the workflow. A missing rule is a
stop condition, not permission to publish an unprotected tag. For a
manual dispatch use the verified `ID@updated_at` as `reviewed_tag_ruleset`.
Creating repository rules is an explicit owner operation; the app does not do it.
If a publication stops after reserving its tag, inspect the tag and draft
before choosing a new version. Retries do not reclaim a pre-existing tag.
Tag protection does not sign release binaries or remove a repository
administrator's ability to change release policy.
The upstream multi-platform release, npm publishing, legacy mirror,
GHCR and broker deployment writers are disabled for this fork. Do not
grant other automations release write access.
These guards apply to workflow revisions containing them, not historical runs.
Before the first production dispatch, review existing Actions runs and other
write credentials; do not rerun old release workflows.

The desktop verifies the `topway-ai` GitHub identity with the existing Windows
Git Credential Manager and accepts commands only through the authenticated
local desktop while bots are idle. If the Windows desktop does not inherit Git
on PATH, set `gitExecutable` to the absolute Git executable in the existing
development `config.json`. Keep that configuration outside any worktree.
This is not protection against other
software with unrestricted access to that Windows user or desktop. Keep the
development bot's shell and computer permissions scoped; never enter tokens in
chat or grant broad access to the release account.

The existing [update and rollback flow](topbot-updates.md) takes over after a
new compatible release is available. Opening or merging a PR alone does not
create a release.

## Verification

```sh
node --test --test-concurrency=1 scripts/topbot-development.node-test.mjs
node --test scripts/topbot-iteration-editor.node-test.mjs scripts/topbot-qualification-artifact.node-test.mjs
```

The test uses real disposable Git worktrees and a synthetic GitHub API. It
proves original working files are untouched, private files and unsafe branches
are blocked, success creates an exact draft, repeated submission reuses it,
and no release request exists. It never uses a real GitHub credential.

After a GitHub Windows qualification finishes, use
`node scripts/verify-topbot-cloud-update.mjs RUN SHA BRANCH VERSION PREVIOUS_FIXTURE`
on Windows. The harness downloads and checks the exact GitHub Actions
artifact, updates a fresh copy of the supplied old program, then rolls back
the program while preserving data written after the upgrade. It never makes
a Release or changes the running installation.
