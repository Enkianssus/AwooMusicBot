# NetEase queue acceptance — Awoo MusicBot 1.2.7

Date: 2026-11-11 (America/Los_Angeles).

## Scope and environment

- Feedback: `FB-20261102-A721B68F`.
- Core: isolated packaged `1.2.7`, separate user data and internal port `15555`; no live-room connection or automatic connector maintenance.
- Installed player: NetEase `3.1.43.205627` (the reporter used `3.1.42.205594`; this run does not claim that exact build was retested).
- Unchanged connector: `3.1.41.205529.2`, framework-dependent, private .NET `8.0.29`.
- Verified actual CEF current/next identities and player UI playback/progress. Audio output was muted; no audible-output claim is made.

## Automated validation

- `npm ci` completed in the isolated release checkout.
- `npm test`: 935 tests, 934 passed, 1 platform skip, 0 failed.
- `npm run lint`, `npx tsc --noEmit`, production dependency audit (0 vulnerabilities), and full `npm run build` passed.
- Connector contract checkout matches CI `main` at `1a561f7e840e48bc6ecf33601bebea78a3bac1f6`. The original development checkout was not modified.
- Sixteen dedicated regressions cover empty/nonempty queues, same-track heartbeat, unconfirmed/intermediate observations, action expiry, in-flight/new-action races, duplicate prevention, paused autoplay, natural advancement and QQ ownership.

## Live acceptance

1. Inserted `3404897305` (ゆーえふおー), then used the queue's immediate-play action. The player confirmed that target and the local queue became empty.
2. After confirmation, queued `22423450` (Autumn In New York) and `33166666` (Sun). Native next became `22423450`; there was no persistent waiting-for-immediate-play gate.
3. Sought the current song to near its end (02:54 / 02:58), without sending Next. It ended naturally and advanced to `22423450`; the core consumed that request and inserted `33166666` as native next.
4. Sought the second song near its end (06:42 / 06:51), again without sending Next. It ended naturally and advanced to `33166666`; the local queue became empty. The UI showed advancing playback progress.
5. Repeated with both `3404897305` and `2602729586` already queued before immediate-playing the first item. On confirmation the core noticed the player's next was different, physically inserted the waiting `2602729586`, and registered its guard. The next natural end reached `2602729586` and emptied the local queue.

Relevant log sequence: 22–26 confirmed the immediate target and registered the later request; 28–33 recorded both natural transitions and intermediate queue repair; 37–43 recorded the already-populated-head case and its natural transition. These are the isolated application's local log times.

No NetEase connector binary, production player configuration, account login or live-room settings were changed. This acceptance covers the reported queue-stall paths, not every NetEase version or all playback modes.
