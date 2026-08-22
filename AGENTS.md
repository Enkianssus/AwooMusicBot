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
- Keep `publicKeyId` equal to `bilincm-connectors-2026-01` unless performing an
  explicitly planned key rotation with old-client compatibility.
- Every connector release must retain both Awoo and legacy archive names, in
  both self-contained and framework-dependent forms. Do not remove legacy
  catalog fields or `BiliNCM.Connector.*.exe` aliases while supported old cores
  still consume them.
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
  connector. The Release workflow must also pass both Awoo and legacy smoke
  tests before assets are accepted.
- Worker changes: run `node --check` and `wrangler deploy --dry-run` before a
  production deploy.
- After release, verify GitHub assets, signatures/hashes, catalog contents,
  HTTP Range downloads, and compatibility with both a current core and an old
  core that selects the legacy package.
