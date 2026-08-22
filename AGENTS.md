# Awoo MusicBot project instructions

## Release instructions are mandatory

- For any version bump, upload, tag, GitHub Release, repository rename, or
  Cloudflare deployment, read `docs/RELEASING.md` completely before acting.
- Do not push, create or delete tags/Releases, rename repositories, or deploy
  Cloudflare without the user's explicit authorization for that remote action.
- A release is not complete when a tag is pushed. Wait for GitHub Actions,
  verify every required asset, verify the catalog bot commit, and test the
  public proxy endpoints before reporting success.

## Repository boundaries

- The root repository is `Enkianssus/AwooMusicBot`; its default branch is
  `master`.
- `BiliNCM-Connectors/` is a separate nested Git repository. Its canonical
  GitHub name after the approved migration is `Enkianssus/awoo-connectors` and
  its default branch is `main`. The local directory name may remain
  `BiliNCM-Connectors`.
- Never mix the two repositories in one commit. Inspect status, branch, remote,
  and diff in each repository independently.
- Preserve unrelated user work. In particular, do not stage or modify
  `AwooMusicBot-Skins/`, overlay repositories, build artifacts, backups, or
  experiments unless the user explicitly puts them in scope.
- Stage only named files. Never use `git add -A`, `git add .`, force-push, or
  rewrite published history.

## Accounts and project identity

- GitHub publication must use the `Enkianssus` account.
- Cloudflare publication must use the Enkianssus account and
  `ENKIANSSUS_CLOUDFLARE_API_TOKEN`. Never use any non-Enkianssus account,
  token, project, identifier, or branding in an Enkianssus project.
- Never print access tokens or signing keys. Never expose
  `CONNECTOR_SIGNING_PRIVATE_KEY`.

## Stable compatibility contracts

- Keep these public endpoints stable:
  - `https://app.enkianss.us/connectors/v1/catalog.json`
  - `https://app.enkianss.us/connectors/v1/profiles/qqmusic/catalog.json`
  - `https://app.enkianss.us/connectors/v1/download/...`
- Awoo MusicBot 1.1.10 and newer consume the separate
  `https://app.enkianss.us/connectors/v2/catalog.json` endpoint.  It uses
  `schemaVersion: 2`, the same `publicKeyId`, and contains only signed
  `package` objects with `deployment: framework-dependent`; their download
  URLs are under
  `/connectors/v2/download/`; the current client must not silently fall back
  to the frozen v1 catalog.
- Keep `publicKeyId` equal to `bilincm-connectors-2026-01` unless performing an
  explicitly planned key rotation with old-client compatibility.
- Historical v1 connector Releases retain their existing Awoo/legacy archive
  names, self-contained/framework-dependent forms, catalog fields, and
  `BiliNCM.Connector.*.exe` aliases while old cores may consume them. Do not
  rewrite or delete those immutable v1 assets.
- Every future v2 connector Release contains exactly three assets: one Awoo
  framework-dependent ZIP and its `.sig` and `.sha256`; it does not publish
  legacy or SelfContained archives.
- Awoo MusicBot 1.1.10 and newer must install only the framework-dependent
  connector package and its private shared .NET Runtime. Do not reintroduce a
  SelfContained download fallback into the current client. Existing installed
  SelfContained connectors must remain launchable and recoverable.
- Before tagging Awoo MusicBot 1.1.10, push the v2 workflow/catalog/proxy code,
  seed `catalog-v2.json` from existing signed Awoo framework-dependent assets,
  and deploy and verify `/connectors/v2/...`. Do not create a new connector
  revision or Tag solely for this migration. Future connector code updates use
  the three-asset v2 Release workflow.
- SelfContained assets remain only in historical v1 Releases and the frozen v1
  Catalog for Awoo MusicBot 1.1.0-1.1.9 compatibility. Future v2 workflow runs
  must not add new SelfContained or legacy assets.
- Do not overwrite an already published version or replace signed Release
  assets. Publish a higher connector revision instead.
- Raise `minimumCoreVersion` only for a real core protocol/behavior dependency,
  never merely because a framework-dependent package exists.

## Version rules

- Awoo MusicBot uses `MAJOR.MINOR.PATCH`; the current architecture releases on
  the `1.1.x` channel with tags such as `v1.1.10`. The `1.0.x` channel remains
  separate and must not be silently promoted to `1.1.x`.
- NetEase uses five parts:
  `PLAYER_MAJOR.PLAYER_MINOR.PLAYER_PATCH.PLAYER_BUILD.CONNECTOR_REVISION`, for
  example `3.1.37.205354.9` and tag `netease-v3.1.37.205354.9`.
- KuGou uses four parts:
  `PLAYER_MAJOR.PLAYER_MINOR.PLAYER_FEATURE.CONNECTOR_REVISION`, for example
  `20.0.81.5` and tag `kugou-v20.0.81.5`. Its noisy final player build stays in
  `testedPlayerVersion`, not the connector version.
- QQ Music uses three parts:
  `PLAYER_MAJOR.PLAYER_MINOR.CONNECTOR_REVISION`, for example `22.52.1` and tag
  `qqmusic-v22.52.1`.
- Folia uses three parts and follows its Stage API baseline, for example
  `1.1.3` and tag `folia-v1.1.3`.
- Increment only the last component for a connector-only fix on the same player
  branch. A changed player/API branch is a manual update boundary and starts a
  new connector revision sequence.
- QQ compatibility profiles use their own SemVer and tag
  `qqmusic-profiles-vMAJOR.MINOR.PATCH`; they are not QQ connector binaries.

## Required validation

- Awoo MusicBot: `npm test`, `npm run lint`, `npx tsc --noEmit`, and a full
  `npm run build` before tagging. Keep `package.json`, `package-lock.json`, and
  the versioned `build:dev` output directory synchronized.
- Connectors: build the full solution and run all tests relevant to the changed
  connector. Future v2 Release workflows must pass the Awoo framework-dependent
  small-package smoke test; they do not publish or smoke-test legacy packages.
- Worker changes: run `node --check` and `wrangler deploy --dry-run` before a
  production deploy.
- After release, verify the three v2 assets, signatures/hashes, `catalog-v2.json`,
  HTTP Range downloads, and installation by the current core. Historical v1
  assets and endpoints remain immutable; a future v2 release does not require
  reinstalling an old core.
