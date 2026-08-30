# YouTube History Tracker — MVP Plan (v2)

**Goal:** a progressive, growing record of every YouTube video I open. Each manual run pulls
everything new since the last run and appends it. Default report renders the last 5 days.

**Include:** every video *opened*, even if never played. 0% watch time is a valid row — not filtered.
**Output:** markdown to stdout, or `--json`.

> Supersedes v1, which was built around a stateless 24h query. The inversion below matters:
> in v1 I flagged `videos.timestamp` as *contaminated* by mere page-opens. That contamination
> is now exactly the signal you want, so the two stores swap roles.

---

## 1. The data model inversion

| Store | Role in v1 | Role in v2 |
|---|---|---|
| `videos` (one mutable row per videoId) | Rejected — polluted by page-opens | **The spine.** One row per video *opened* |
| `watchSessions` (append-only, 60s flushes) | The spine | **Enrichment.** How long, and therefore what % |

So: `videos` answers *"did I open it"*, `watchSessions` answers *"did I actually watch it, and how much"*.
A video with a `videos` row and zero sessions is an open-but-never-played — which you now want, at 0%.

**Watch percentage** = `SUM(sessions.seconds) / videos.duration`. No sessions → 0%. Note it can
exceed 100% on a re-watch, so cap the displayed figure and keep the raw number in `--json`.

There's a second, distinct signal worth keeping: `videos.time` is the last playback *position*.
Position 90% with 2 minutes of watch time means you dragged the scrubber. Store both; render
watch time as primary.

---

## 2. Verified behaviour — what actually gets captured

I traced the capture paths in `content.js` rather than inferring them, because your
"include everything I opened" requirement lands exactly on an edge case.

**Two independent save paths:**

- `saveProgress()` — polling, every 10s (1s for videos under 20s). **Bails on `video.paused`.**
- `saveProgressImmediate()` — **no paused guard.** Fires on `beforeunload`, `visibilitychange`, `popstate`, and `ended`.

So an opened-but-never-played video is saved by the *exit* path, not the polling path:

| You do this | Captured? |
|---|---|
| Open video, press play | ✅ Polling saves within 10s |
| Open, don't play, switch tab | ✅ `visibilitychange` |
| Open, don't play, close tab / leave YouTube | ✅ `beforeunload` |
| Open, don't play, browser back | ✅ `popstate` |
| **Open, don't play, click straight to another video** | ❌ **Missed** |

### The gap, and the fix

The SPA navigation watcher (`content.js:1296`, a `MutationObserver` on `location.href`) calls
`flushActiveWatchTime(...)` — which writes a *watchSessions* row — but never calls
`saveProgressImmediate()`. In-app clicking from video A to video B therefore doesn't force a
`videos` save for A.

This causes two defects, both of which matter to you:

1. **Never-played videos vanish** when you click straight on to the next video. Directly against your requirement.
2. **Orphan sessions.** A video played for ~1–10s then clicked away from gets a `watchSessions`
   row (the flush) but possibly no `videos` row — so watch seconds with no title or duration.

**The fix is not simply calling `saveProgressImmediate()` in that observer.** YouTube navigates via
the History API, so `location.href` has *already changed* by the time a `MutationObserver` sees it.
Saving there reads the **new** video's `?v=` while the player, `document.title` and the reused
`<video>` element still hold the **old** video's state — writing a corrupted row rather than a
missing one. Strictly worse than the bug.

The right *event* is `yt-navigate-start`, which YouTube dispatches on `document` *before* the
navigation commits, while `location`, the title and the player all still describe the page being
left. It's a DOM `CustomEvent`, so a content script can listen to it across the isolated world:

```js
document.addEventListener('yt-navigate-start', () => {
  saveProgressImmediate();
});
```

Supplied as `0001-capture-unplayed-videos-on-spa-nav.patch`.

> **Unverified, and the race is narrowed rather than closed.** This is checked for syntax only
> (`node --check`). Two caveats:
>
> 1. `yt-navigate-start` is a YouTube-internal event, not a documented API, and could be renamed.
> 2. **The event fires at the right moment, but the read happens later.** The call chain is
>    `saveProgressImmediate` → `_doSaveProgress` → `chrome.storage.local.get(cb)` →
>    `_doSaveProgressInternal` reads `location.search` → `sendMessage('idb-get-video', cb)` →
>    reads `document.title`. So the video id is read one async hop after dispatch and the title
>    two. If YouTube commits the navigation first, you can get the new video's id against the old
>    player's `currentTime`, or the right id against the new title. Storage callbacks usually win
>    that race — "usually" is not verified.
>
> **Step 2's pass criterion is therefore not "a row appeared."** It is: no row whose title and
> duration belong to *different* videos. Open a long video, don't play it, click straight to a
> short one, and inspect that row specifically.
>
> If it fails, capture `videoId`, `title` and `currentTime` synchronously inside the
> `yt-navigate-start` handler and thread them through `_doSaveProgressInternal` — a larger change,
> which is why it isn't the default.

**This changes v1's recommendation.** v1 said install unmodified. Given your requirement, I now
recommend a **fork with this patch** — it's a genuine upstream bug worth a PR. Your report script
must still tolerate orphan sessions, since existing data predates the patch.

### Shorts — decided for you, at zero cost

**Shorts are already excluded by construction.** Two independent reasons:

- `isWatchPage()` is `location.pathname === '/watch'` — Shorts live at `/shorts/ID`.
- `videoId` is read as `new URLSearchParams(location.search).get('v')` — Shorts URLs have no `?v=`.

So Shorts never reach the database. Nothing to build, nothing to filter. Flagging it as a
**limitation** rather than a feature: your record will silently have no Shorts in it. Adding them
later means patching the path parser in `content.js` — a real change, not a config flag.

---

## 3. Architecture

```
YouTube
   │
   ▼
yt-watch-history (forked + yt-navigate-start patch)
   │  IndexedDB — full snapshot, never pruned
   ▼
Options → Export → ~/Downloads/yt-history-YYYY-MM-DD.json
   │
   ▼
yth import <file>   →  merge into history.db   (SQLite, the durable record)
   │
   ▼
yth report --since 5d   →  markdown | --json
```

**Why the export is a full snapshot and that's fine.** The extension has no pruning — no retention
cap, no max-entries setting. So every export is the complete history, and "since last update"
becomes a *merge* problem, not a fetch problem. That's strictly better: it self-heals. Skip a week,
and the next import backfills everything you missed.

### The merge rules

**Sessions — dedupe on `(videoId, watchedAt)`, not on the auto-increment `id`.**

The extension's session `id` is an IndexedDB auto-increment. If you ever clear or re-import the
extension's DB, ids reset to 1 and would collide with rows you've already stored — an
`INSERT OR IGNORE` on `id` would then silently discard real new data. `watchedAt` is a
millisecond timestamp; `(videoId, watchedAt)` is collision-free in practice and survives a reset.

**Videos — upsert, preserving history the extension throws away.** The `videos` store keeps only
*one* mutable row per video, so `timestamp` is overwritten on every re-watch. Your local store
should keep `first_seen` (min, never updated after insert) and `last_seen` (max), which gives you
a real timeline the extension itself can't reconstruct.

**Schema:**

```sql
videos(video_id PK, title, channel, channel_url, duration,
       last_position, watched, watch_count, live, live_replay,
       first_seen, last_seen)
sessions(video_id, watched_at, seconds, stream_type,
         PRIMARY KEY (video_id, watched_at))
imports(id PK, imported_at, source_file, new_videos, new_sessions)
```

The `imports` table is your "since last update" audit trail — it tells you what each run actually
added, which is what makes a manually-triggered progressive record trustworthy.

---

## 4. Build steps

**Step 1 — Fork and patch (30 min).** Fork `GeorgeElliott/yt-watch-history`, apply
`0001-capture-unplayed-videos-on-spa-nav.patch`, load unpacked from `src/`. Open a video without
playing it, click straight to another video, and confirm the first one now appears. **If it
doesn't, the `yt-navigate-start` hook isn't firing — see §2 before going further.**

**Step 2 — Verify before building (15 min).** Export, open the JSON. Confirm you can see: a played
video with sessions, and an opened-never-played video with a `videos` row and no sessions. This is
the checkpoint that de-risks everything after it.

**Step 3 — `yth import` (~80 lines).** Read export JSON, apply the merge rules, print what it added:
`+7 videos, +23 sessions`.

**Step 4 — `yth report` (~80 lines).**

```
yth report [--since 5d] [--json] [--unwatched-only] [--min-seconds N]
```

Default `--since 5d`. The DB keeps everything forever — the window is purely a render choice, so
`--since 30d` works the moment you have 30 days of data. Handle `live`/`liveReplay` (duration is
stored as 0) and orphan sessions (session rows with no matching video) so neither prints garbage.

Suggested output:

```markdown
# YouTube — last 5 days
_23 opened · 14 played · 4h 51m active viewing_

## Wed 19 Aug
- **[Building MCP servers from scratch](https://www.youtube.com/watch?v=XXXX)**
  Channel · 43m of 1h 02m · 69% · 14:22
- **[Some video I bailed on](https://www.youtube.com/watch?v=YYYY)**
  Channel · not played · 1h 15m long · 09:04
```

**Total: roughly half a day.**

---

## 5. Known limitations

- **No Shorts**, by construction (§2). Silent absence, not an error.
- **No backfill.** The record starts empty at install. Prior history would need a Takeout import.
- **One browser profile per install** — but multiple profiles merge cleanly at import time (§10).
  Phone, TV and other machines remain invisible; see §10 for why the iPhone has no good route.
- **Manual export.** The one remaining friction point — see below.
- **Sub-second bounces.** If you leave before the `<video>` element mounts, nothing is written.
- **Single-author upstream (2 stars, 4 months old).** Pin your fork to a reviewed commit.

---

## 6. Deferred

**Automate the export.** An `alarms` handler that auto-exports to a watched folder, so `yth import`
runs unattended. Scope this carefully: the existing `downloadBackup` uses `Blob` +
`createObjectURL` in `options.js` (page context), which does **not** move straight into an MV3
service worker — it likely needs a `data:` URL or an offscreen document. Adds the `downloads` permission.

**Later, only if the MVP earns it:** Shorts support (path-parser patch); topic grouping and
summaries; feeding the record into a knowledge/memory system; cross-device sync. *(Liked videos
were deferred here and have since been built — see §11.)*

---

## 7. Licensing

- `yt-watch-history` is **MIT**. Forking is fine; retain `LICENSE` and the copyright notice.
  Fork publicly rather than copy-pasting, so provenance is visible.
- **Send the fix upstream as a PR once you've confirmed it works** — it's a real bug (in-app
  navigation loses records), and it's the cleanest way to reuse this ethically.
- `sniklaus/youtube-watchmarker` is **GPL-3.0**. Read for ideas, don't copy — pasting its code
  would make your project GPL.
- `yth` is your own work, consuming an export format rather than source code. No obligation.

---

## 8. Decisions (settled)

| Question | Decision |
|---|---|
| Re-watch marker | `*` = **watched on more than one Perth day**. See caveat below |
| Grouping | Day-grouped, `Australia/Perth` (UTC+8, no DST) |
| `--json` | One object per video: rollup fields + nested `sessions` array |
| Channel | Included in every row |

**Why not `watchCount` for the `*` marker.** It's the obvious field, but `content.js:227` only
increments it on a not-watched → watched transition, and `watched` requires ≥95% progress. A video
you watched 40% of on two separate days has `watchCount = 0`. So the marker is instead **the count
of distinct Perth days with session rows**, which matches the intent and reuses the day-bucketing
code. `watch_count` is still stored and exposed in `--json` as "times finished".

**Which timestamp buckets a video into a day: `last_seen`.** For a 0%-watched video no sessions
exist, so `videos.timestamp` is the only timestamp available — `last_seen` therefore drives the
day header for every row, watched or not.

**First-import caveat, mostly mitigated.** The extension keeps one mutable timestamp per video, so
on a first import `first_seen` is really "when last saved" and older viewing would collapse onto
import day. Session rows are append-only and *do* remember the earlier watches, so import runs a
reconciliation pass that pulls `first_seen` back to the earliest session evidence. The residual gap
is videos with **no** sessions — opened but never played — where no earlier evidence exists; those
still date from their last save.

**Import is order-independent.** Two profiles (and archived exports opened out of sequence) arrive
in arbitrary order, so the video upsert cannot be last-writer-wins. `first_seen` takes the min,
`last_seen` / `last_position` / `watch_count` take the max, and descriptive fields (title, channel,
duration, `watched`, live flags) follow whichever side is genuinely fresher — compared against the
*raw* incoming timestamp, since after `last_seen` is max-merged a freshness test would always pass.
**Verified:** importing the demo snapshots newest-first yields a byte-identical database to
oldest-first.

**Session dedup key is `(video_id, watched_at, seconds)`** — not `(video_id, watched_at)` as v2
had it. `flushActiveWatchTime` can emit a 60s chunk row and a partial row in the *same
millisecond*, and a two-column key would silently discard real watch seconds via `INSERT OR
IGNORE`. Adding `seconds` disambiguates them (chunk rows are always multiples of 60, partials
aren't) and stays reset-safe, since every column is natural data rather than an auto-increment.

**The markdown report is window-scoped; `--json` also carries lifetime totals.** Every printed
figure — watch time, percentage, the `*` marker, the summary line — counts only sessions inside
the window. Without this, a video re-opened today after an hour of viewing last month would render
as "1h · 80%" under today's date while contributing nothing to the header, so the rows wouldn't sum
to the summary. `--json` exposes both: `window_watch_seconds` / `window_percent` /
`window_watched_days` alongside the lifetime `watch_seconds` / `percent` / `watched_days`, plus the
full nested `sessions` array. The `*` legend reads "watched on more than one day **in this
window**", which is then literally true.

**`--since 5d` means 5 calendar days in Perth** (today plus the four previous days), not a rolling
120 hours — so day headers are never half-populated.

## 9. Verification status

The tool is validated against a **synthetic fixture** built from my reading of `db.js` and
`options.js`. That is circular by construction: it proves the parser matches my understanding of
the format, not that my understanding is right. **Step 2 of §4 — install, export, inspect the real
JSON — remains the actual gate** before trusting any report output.

---

## 10. Multiple devices

### Two Chrome profiles — already solved, no changes needed

The extension's IndexedDB is per-profile, so the two profiles never see each other's data, and
Chrome's `storage.sync` is unusable for this (settings-sized quota, ~100KB). But the record doesn't
need the *browsers* to sync — `yth import` is a merge, so it does the joining:

```
Profile A ──export──┐
                    ├──► yth import (twice) ──► history.db
Profile B ──export──┘
```

Export from each profile, import both. Order doesn't matter, re-importing is a no-op, and the same
video watched in both profiles collapses to one row with the watch time summed.

**Verified:** a 40-minute video watched 20 minutes in profile A and 15 in profile B imports as one
row reading `35m of 40m · 88%`, alongside each profile's exclusive videos. Session dedup is on
`(video_id, watched_at, seconds)`, and two profiles produce genuinely distinct timestamps, so real
watch time is added rather than double-counted.

The only cost is exporting twice. If that becomes annoying, the deferred auto-export (§6) applied
to both profiles turns it into an unattended merge.

### iPhone — not solvable at this quality, and worth knowing why

There is **no route to iPhone watch data with watch-time fidelity** — but §11 adds a route to
iPhone *presence* via likes, which is usually what matters. The options for watch time itself:

- **Browser extension:** doesn't apply. YouTube on iPhone is the native app, and this is a
  Chrome desktop MV3 extension.
- **YouTube Data API:** cannot return watch history. Since 12 September 2016 the
  `contentDetails.relatedPlaylists.watchHistory` field returns the placeholder `HL`, and both
  `playlists.list` and `playlistItems.list` return empty for it. Not a quota or scope problem —
  the capability was withdrawn.
- **Google Takeout:** the one option that works. Watch history is recorded server-side against the
  Google account. *Inferred, not confirmed:* that server-side model means signed-in mobile-app
  viewing should appear in the export, but the documentation searched did not state mobile-app
  coverage explicitly. Verify with a one-off Takeout before building anything on it.

**Takeout's limits, which are the reason it isn't the primary collector.** It requires YouTube
History to be enabled on the account; it is a manual, batched export with a real lag rather than a
live feed; and critically it carries **timestamp, title, channel and URL but no duration and no
watch time**. Every iPhone row would therefore be "opened" with 0% — indistinguishable in shape
from a desktop video you never played.

**Recommendation: don't mix them by default.** If you add a Takeout importer later, tag those rows
with a `source` column (`extension` | `takeout`) so the report can show iPhone viewing as a
separate, explicitly lower-fidelity section instead of silently polluting your watch-time totals.
`yth`'s merge model handles the ingestion fine — the schema just needs that one extra column.

---

## 11. Liked videos (built)

Likes are the practical answer to the iPhone gap: like anything you watch on the phone and it
enters the record. No watch time, but presence, title, channel, duration and a real timestamp.

### Why the likes *playlist* and not `myRating=like`

`videos.list?myRating=like` returns liked videos but **no indication of when you liked them** — the
only timestamp is the video's own upload date, which is useless for a windowed report.

`playlistItems.list` on the account's likes playlist carries `snippet.publishedAt`, documented as
*"the date and time that the item was added to the playlist"* — i.e. when you liked it. That is the
timestamp the report needs, so the likes playlist is the source.

Both facts were checked against Google's docs rather than assumed: `relatedPlaylists.likes` is
**not** deprecated (unlike `favorites`, and unlike `watchHistory`, which has returned the empty
placeholder `HL` since September 2016).

### Flow

```
yth auth --client-secret client_secret.json     # once
yth sync-likes                                  # each run
```

1. `channels.list(mine=true)` → the likes playlist id.
2. `playlistItems.list` → video id, title, channel, **liked-at**. Paginated in full.
3. `videos.list(id=…)` in batches of 50 → ISO 8601 duration.

Quota cost is ~1 unit per call against a 10,000/day allowance — negligible.

**Durations are mapped by id, never zipped by position.** `videos.list` silently omits deleted,
private and region-blocked videos, which the likes playlist still returns as items; pairing by
index would attach one video's duration to another's title. Verified against a deliberately
reordered, incomplete API response.

### Three states, not two

A liked-only video has no sessions, so the naive path would print `not played` — the exact
opposite of the truth, since you liked it *because* you watched it. The renderer distinguishes:

| State | Renders as |
|---|---|
| Sessions, no like | `24m of 28m · 89%` |
| Sessions + like | `★` plus the same |
| **Like, no sessions** | **`★ liked · watch time unknown`** |
| Opened in browser, never played | `not played` |

`--unplayed-only` excludes liked-only rows for the same reason: they aren't unplayed, they're
unmeasured. `--json` carries `liked`, `liked_at`, and `source` (`extension` \| `youtube_api`).

### Setup and caveats

- Needs a Google Cloud project with **YouTube Data API v3** enabled and an OAuth client of type
  **Desktop app**. `yth auth` runs a loopback flow with PKCE — Google withdrew the copy-paste
  out-of-band flow, so a local redirect is the only option. **Verified that Windows Chrome can
  reach a callback server bound inside WSL on `127.0.0.1`.**
- The refresh token is written to `~/.config/yth/credentials.json` at mode `0600` — deliberately
  outside this directory, which is a candidate for `git init`.
- **Check the consent screen's publishing status.** An OAuth client left in *Testing* expires
  refresh tokens after ~7 days, which would make `sync-likes` a weekly re-auth chore rather than
  something you can automate. `youtube.readonly` is a sensitive scope, so moving to Production
  isn't free either. Worth knowing before building a cron job on it.
- **Liked Shorts do appear**, since they land in the likes playlist — partially filling the Shorts
  gap in §2, though only for Shorts you like.
- **Unliking leaves the local row in place.** Correct for a progressive record: you did watch it.
### Missing like dates: assumed, never dropped

`snippet.publishedAt` is normally present and real, but an item can arrive without it or with an
unparseable value. Dropping those would silently under-report — the opposite of the goal, which is
simply to get liked videos onto the list. So the item is kept, stamped with the sync time, and
flagged `approximate`; it renders as `★ liked (date approximate) · watch time unknown`, and the
sync prints how many were stamped that way.

The flag is not sticky in the wrong direction:

- A **real** date arriving on a later sync **supersedes** an assumed one, and clears the flag.
- An **assumed** date never overwrites a real one.
- Because a real date is usually *earlier* than the sync that guessed it, and `last_seen` is
  max-merged (so it cannot move backwards on its own), superseding also **resets** `first_seen` /
  `last_seen` for videos known only from the like. Without that the row keeps rendering under the
  day it happened to be synced. Videos that also have extension data are left alone — their
  timestamps come from real playback.

- Playlist ordering is not relied upon. `playlistItems.list` takes no `order` parameter, so the
  sync paginates fully rather than trusting reverse-chronological order; `--verbose` prints the
  first page's date span if you want to confirm the behaviour empirically.

---

## 12. Getting likes into the extension's History tab

Likes live in `history.db`; the extension's History tab reads its own IndexedDB. The only bridge
is the extension's import feature — and that bridge has a trap.

### The extension's import REPLACES, it does not merge

`options.js` calls `db_replaceDatabase(...)`, and `db.js` documents it plainly:

> `db_bulkImport` clears every application store in one atomic transaction

**So importing a likes-only file would erase the entire watch history.** The only safe payload is a
*superset* of what the extension already holds — which is exactly what this record is, provided the
latest export has been imported first.

### The flow

```
1. Extension options → Export          (browser → JSON)
2. yth import                          (JSON → record)
3. yth sync-likes                      (API  → record)
4. yth export-extension -o merged.json (record → JSON, now including likes)
5. Extension options → Import merged.json
```

Dedup is inherent: the record holds one row per `video_id`, so a video both watched and liked
emits once. Verified: 11 videos out, zero duplicate ids.

### The guard

Step 5 is destructive, so `export-extension` refuses to write in either unsafe case:

1. The newest export in your Downloads folders contains a video absent from the record — importing
   the result would delete it.
2. **There is no export to compare against at all.** This is the *more* dangerous case, not the
   safe one: with nothing to check, a record holding only synced likes would emit a likes-only
   file, and importing it would wipe the extension's entire watch history. An early version
   treated "cannot verify" as "nothing to verify" and would have done exactly that.

Both name the fix. `--force` overrides.

### Output is validated against the extension's own rules

`options.js` silently drops records failing its checks, so the exporter mirrors them: video ids
against `/^[a-zA-Z0-9_-]{11}$/`, titles truncated to 300 chars, `time` clamped to 0–86400, session
`seconds` clamped to 1–3600. Anything dropped is reported rather than lost quietly. Verified by
re-implementing the validator and confirming 11/11 videos and 167/167 sessions survive.

### `watchEvents` are now stored, so the round-trip is lossless

The record previously discarded `watchEvents` on import. That would have mattered here: with no
events in the file, the extension *regenerates* them from `watchCount`, collapsing every event onto
the video's timestamp. They are now stored in a `watch_events` table (deduped on
`video_id, watched_at`) and re-emitted unchanged.

### Caveats

- The extension has no concept of a like, so a liked-only video appears in the History tab as a
  normal entry at 0% progress. It's present and clickable, which was the goal, but the tab can't
  distinguish "liked on phone" from "opened and never played". `yth report` still can.
- After re-importing, the extension's next export contains the liked videos as ordinary records.
  That is handled: the report keys the "liked" state on the `likes` table rather than on
  `source`, so a liked video returning through the extension still renders
  `★ liked · watch time unknown` rather than reverting to `not played`.
- Step 5 replaces the live database. Keep the export from step 1 until you've confirmed the
  History tab looks right — it is your rollback.

---

## 13. Live sync (built) — the History tab as the primary UI

Requirement: watch or like on either Chrome profile or the phone, and find it in the History tab
within seconds of a refresh, with no manual import or export.

### Why files could not do it

The obvious design — auto-export, auto-import — fails on two counts:

1. **The extension's import is a destructive replace** (§12). Firing it on History-tab open would
   delete anything captured since the export was written. This trigger was requested and declined.
2. **Chrome profiles cannot see each other's IndexedDB.** Cross-profile sharing needs storage
   outside the browser regardless of file format.

### The simplification that shaped everything

**Likes are account-level, not profile-level.** Everything liked — Profile 4, Default, or phone —
lands on the same YouTube account. One sync captures all three sources, so likes never need to be
fetched inside the extension. That removes any need for `chrome.identity`, and with it the blocker
that Chrome Profile 4 is signed into an account with no YouTube channel. The refresh token also
stays outside the browser at mode 0600.

### Architecture

```
Chrome Default ─┐  push each capture (POST /ingest)
                ├──────────────►  yth serve  ◄── likes sync every 10m ── YouTube API
Chrome Profile 4┘  pull changes (GET /recent?since=cursor)      │
                                                            history.db
```

- **Push:** every `idb-save-video` / session / event is forwarded to the daemon as it happens.
  Incremental by construction — one small record, no files.
- **Pull:** a 2-minute alarm, plus an explicit pull when the History page loads, so a refresh is
  always current. Each profile keeps its own `row_updated` cursor, so it only receives changes.
- **Retention:** the daemon serves a 21-day window. `history.db` still keeps everything; the window
  only bounds what crosses the wire.

### Correctness

- **Merging, not replacing.** `db_saveVideo` uses `put()` — insert-or-replace — so writing a remote
  row directly would wipe local playback progress. `ythMergeVideo` keeps local watch state and lets
  the remote row fill gaps only: `time` and `watchCount` take the max, `watched` ORs, and
  `timestamp` only moves forward so a video watched last week is not shuffled up to when it was liked.
- **Degrades to local-only.** Push is fire-and-forget and pull swallows errors, so a stopped daemon
  costs you cross-profile freshness and nothing else. Capture and the History tab keep working.
- **`★ Liked` badge.** A liked-only video has no playback, and the tab would otherwise render
  `0:00`, reading as "opened and abandoned". It shows `★ Liked` instead — the same distinction
  `yth report` makes.

### Access control

Localhost is not access control: any page you visit can issue a cross-origin POST to 127.0.0.1.
The daemon requires an `X-YTH-Token` header, which forces a CORS preflight that is only answered
for `chrome-extension://` origins. The token is generated once into `~/.config/yth/daemon-token`
(mode 0600) and pasted into the extension's options page.

### Deleting a video from the display

Implemented as a **soft delete**, and now wired to the card menu's existing
"🗑 Remove from history" button.

**Syncing broke that button.** It previously called `db_deleteVideo` locally, which was correct for
a local-only extension. Once the daemon is running, a local delete is undone by the next pull two
minutes later — and for a liked video, by every future likes sync as well. The button now sends
`yth-hide` first, and only then deletes locally.

- `POST /hide` sets `hidden = 1`; the flag propagates to every profile on the next pull, and hidden
  rows are filtered out of the History tab.
- **If the daemon is unreachable** the local delete still happens, but the toast says so plainly —
  "Removed here, but the sync daemon is unreachable, it may come back" — rather than implying
  success.
- **The clear-all button** has the same exposure. Rather than silently surprising you, its confirm
  dialog now states that synced data returns on the next pull unless you stop `yth serve` or clear
  the token.

**Verified against the real record**, using a video that is both watched and liked:

| Check | Result |
|---|---|
| `/hide` sets the flag | ✅ |
| Flag delivered to the other profile via `/recent` | ✅ |
| **Survives a full likes re-sync** | ✅ still hidden |
| **Survives the video being watched again** | ✅ still hidden, progress still tracked |

Removal is therefore permanent, which is why `yth hidden` lists soft-deleted videos and
`yth hidden --unhide <video_id>` restores one — otherwise the only way back would be hand-written
SQL. An alternative design would un-hide on re-watch; that was rejected as more surprising than the
rule "removed stays removed until you say otherwise".

### Autostart

The daemon runs in WSL; Chrome runs on Windows. So the trigger has to live on the Windows side —
a WSL-only mechanism (systemd, `wsl.conf` `boot.command`) never fires if nothing has started WSL
after a reboot.

```
Windows logon
   └─ Scheduled Task "yth-daemon"
        └─ wscript.exe  C:\Users\rober\yth\start-yth-daemon.vbs   (hidden, no console)
             └─ wsl.exe -d Ubuntu -u robert --exec ~/bin/yth-daemon-start.sh
                  └─ yth serve --port 8742 --sync-minutes 10
```

- The VBS wrapper exists purely to avoid a console window flashing at every logon.
- `wsl.exe` **boots WSL if it is not running**, which is the whole point of driving this from Windows.
- `yth-daemon-start.sh` is idempotent — it exits immediately if the port is already listening — and
  `yth serve` itself now treats `EADDRINUSE` as "already running, nothing to do" rather than
  crashing. Starting twice is harmless.
- Logs to `~/.local/state/yth/daemon.log`, rotated at 1 MB. `PYTHONUNBUFFERED=1` is set in the
  launcher: without it Python block-buffers into the file and the log stays empty when you need it.

**Verified** by killing the daemon and triggering the task: it came back, `LastTaskResult: 0`,
health endpoint responding, log written.

Optional hardening (needs a `sudo` you must run yourself): a systemd unit would additionally
restart the daemon if it crashes mid-session, which the logon task does not.

### Operational note

The daemon is only needed for cross-profile and phone data. Local capture never depends on it —
if it is down, the History tab shows this profile's own data exactly as before, and catches up on
the next pull.

---

## 14. History tab layout (built)

The History tab is the primary UI, so it moved from a card grid to one video per row.

### Layout

```
[ thumbnail ] [ tools ] [ title / channel / date ] [ description ] [ ★ status ⋮ ]
      auto       auto            40ch                    1fr            auto
```

`.video-rows .video-card` is a five-column grid:
`var(--thumb-w) auto minmax(0, 40ch) minmax(0, 1fr) auto`. The title block is capped at `40ch` — measured
on the row's own font, so it tracks the type scale rather than a hardcoded pixel width. The
`minmax(0, ...)` on both flexible columns is load-bearing: without the `0` minimum, long text
stretches the row instead of wrapping. `.card-actions` is a deliberately open slot — appending a button or field to it lines up
on the right with no change to the grid definition. Order there is status fields first, controls
last.

`minmax(0, 1fr)` on the middle column is load-bearing: without the `0` minimum, a long title
stretches the row instead of ellipsizing.

### Thumbnail size

A **Thumbnails** control (small / medium / large) sits in the toolbar next to the sort selector.
It swaps a single class on the container, and all three sizes resolve through one custom property:

```css
.video-rows.thumb-small  { --thumb-w: 120px; }
.video-rows.thumb-medium { --thumb-w: 180px; }
.video-rows.thumb-large  { --thumb-w: 260px; }
```

Adding a size is one line. The choice persists in `chrome.storage.local` as `thumbSize`, default
medium. (The previous grid rendered thumbnails around 280px wide, which is what "large" reproduces.)

### Details that came out of actually rendering it

The layout was checked by rendering real records through headless Chrome rather than by reading
CSS, which caught three things:

- **Rows should not lift on hover.** The card style used `translateY(-3px)`; in a list that makes
  the whole page jitter. Rows highlight with a background instead.
- **A divider, not a card background, is what makes it read as a table.** With per-row card
  backgrounds the rows were invisible against the page in the light theme.
- **The status was rendered twice** — once as a thumbnail overlay, once in the right column. The
  overlay is hidden in row mode since status belongs in the column.

### Bug found while reviewing the render

Channel names were displaying doubled — "Feel Free Recap Feel Free Recap". Not a layout fault:
`getChannelName()` reads `ytd-channel-name`'s `textContent`, and YouTube puts the name in two text
nodes (visible plus tooltip). 13 stored rows were affected, all captured by the extension; API-sourced
rows were clean.

Fixed in `content.js` with `cleanChannelName()`, mirrored in `yth`'s ingest path, and the stored
rows repaired. The collapse is deliberately narrow — it requires the two copies to be separated by
a newline or a run of spaces, so a channel genuinely named "Duran Duran" is untouched. Unit-tested
against both.

### Description column

**Descriptions were not stored anywhere.** The extension never captures them and the export format
has no field for them, so this needed a backfill rather than a render change:

- `videos.description` added, populated from `videos.list?part=snippet` in batches of 50.
- `yth backfill` fills gaps on demand; the daemon also tops up 200 per cycle, so newly seen videos
  acquire descriptions without intervention.
- The full backfill of 1,275 videos took **16 seconds** and ~26 quota units: 1,169 with text, 106
  unavailable (deleted or private).
- Unavailable videos are stored as `""` rather than left `NULL`. That distinction is what stops
  them being re-queried on every pass forever.

Served text is flattened (`\s+` → space) and capped at 400 characters. Descriptions carry their own
blank lines, which would otherwise consume the three-line clamp and render as empty gaps — the
first render showed exactly that. Full text stays in the record.

The extension merges `description` from the daemon like any other field, with a non-empty remote
value winning over a blank local one, since the record is its only source.

**Narrow windows drop the description first** (below 1100px), then stack the actions (below 640px),
so the row never overflows horizontally.

### Why the description column was empty in the live tab

The preview rendered correctly while the real History tab showed "No description" on every row.
Four separate causes, none of them the CSS:

1. **`background.js` is a service worker.** Opening the History tab reloads `history.js` — which is
   why the *column* appeared — but the worker keeps running its old code until the extension is
   reloaded. The merge that copies `description` into IndexedDB simply was not running.
2. **The cursor had already passed those rows.** Clients page with `row_updated > cursor`. The
   description backfill bumped `row_updated` while the daemon was still serving payloads *without*
   descriptions, so the clients consumed those rows, advanced past them, and would never be sent
   them again. Adding a field is therefore not enough — the rows have to be re-stamped.
   `yth resync` does that.
3. **The 21-day serve window.** Rows older than that were never served at all, so they could never
   receive later enrichment. Since the cursor and the 500-row page cap are what actually bound a
   response, the window was only creating silent gaps — at 3650 days it still quietly dropped the
   oldest 2015 likes. It is now effectively unbounded; narrow it deliberately with `?days=N` if the
   extension should hold less.
4. **One page per alarm.** A 1,275-row backlog would have trickled out over 6 alarms (12 minutes).
   Pulls now continue while full pages come back.

Two bugs were caught while fixing those, both in the new code:

- **`resync` stamped every row with the same timestamp.** The cursor is the last row of a page, so
  it could never advance past page 1 — 500 of 1,275 rows would arrive and the rest never. Stamps
  are now staggered by `rowid`. The drain loop also refuses to continue unless the cursor actually
  moved, which would otherwise have been an infinite loop.
- **Reads queued behind the write lock.** The likes sync and description backfill hold it for tens
  of seconds; a `/recent` request during one timed out. Reads are now lock-free, relying on WAL for
  a consistent snapshot. Full delivery of 1,275 rows went from timing out to 0.1s.

### Tool column

Three pills stacked vertically between the thumbnail and the title, at the title's own font size
(14px):

| Pill | Behaviour |
|---|---|
| **Clear** | Removes the video from the display — the same path as the card menu's "Remove from history" |
| **Robert** | Placeholder, `disabled`, no behaviour yet |
| **George** | Placeholder, `disabled`, no behaviour yet |

**Clear shares one implementation with the menu item.** Removal is order-sensitive — the video has
to be hidden in the shared record *before* the local delete, or the next pull brings it back — so
having two copies of that sequence was a bug waiting to happen. Both now call `removeVideo(videoId)`.

**Styling.** Outline pills that fill on hover: neutral pills go to the accent colour, and Clear goes
red, since it destroys a row and should not look like its neighbours. Hover also lifts by 1px, with
`:active` returning it and `:focus-visible` giving a keyboard outline. Placeholders are genuinely
`disabled` with a tooltip rather than merely inert-looking, so they cannot be clicked to no effect.

**Fit.** At 14px with 2px padding and 3px gaps the stack is roughly 75px. That clears medium (101px)
and large (146px) thumbnails; at small (67px) the row grows by a few pixels to accommodate it, which
is the right trade — the buttons stay legible rather than shrinking below the title size that was
asked for.

### Theme

The preview renders were dark while the live tab was light, which turned out not to be a
discrepancy: `content.js` watches YouTube's own `dark` attribute and mirrors it into
`youtubeTheme`, and every extension page follows that. The live tab was light because YouTube is.

Sensible default, but there was no way to override it. A **Theme** control in the toolbar now sets
`themeMode`:

| Value | Behaviour |
|---|---|
| `auto` (default) | Follow YouTube, exactly as before |
| `light` / `dark` | Explicit override |

`auto` remains the default so nothing changes for anyone who does not touch it. With no signal at
all the `data-theme` attribute is removed rather than set to a guess, letting the stylesheet's
`prefers-color-scheme` rules apply.

**The popup, stats and options pages were updated too.** Each had its own copy of the
theme-application block reading only `youtubeTheme`, so an override set on the History page would
have left them mismatched.

Both themes were rendered and checked after the row rework — the row dividers, pills and
description column needed verifying in light, since the earlier previews had only been dark.

---

## 15. Transcript summaries — the "Robert" button (built)

Click **Robert** on a row: the transcript is fetched, summarised, and the result replaces the
description in that column.

### Flow

```
Robert click
  -> background.js  yth-summarize
       -> daemon POST /summarize
            -> fetch_transcript.py   (hermes youtube-content skill, own venv)
            -> OpenRouter  google/gemini-2.5-flash-lite
            -> store summary, bump row_updated
       -> ythPull()  -> IndexedDB (both profiles)
  -> re-render
```

**The daemon does the work, not the extension.** `OPENROUTER_API_KEY` stays in the daemon's
environment. Putting it in `chrome.storage` would expose it to anything running in the extension's
context, and it is the one credential here with real spending attached.

Measured on real videos: **~4 seconds** and **~$0.0004** per summary (3.1k tokens in, 178 out).
`gemini-2.5-flash-lite` holds ~1M tokens, so chunking is never needed in practice — the 600k-char
cap exists only to bound pathological input.

### Storage

`summary` is a **separate column** from `description`, so the YouTube text is never destroyed and a
re-summarise is not a one-way door. The column displays `summary || description`, with the original
description on hover. `summary_state` is `ok` / `no_transcript` / `error`; `NULL` means never
attempted, which is what distinguishes "not tried" from "tried, impossible".

Videos with no transcript get their Robert button disabled with a tooltip, so a permanently
impossible video is not retried on every click.

### The bug worth recording

The first version fed the *error message* to the model. The helper script reports failure as
`{"error": ...}` on **stdout** with exit code 1, and the original check only looked for a prefix of
`Error:` on a non-empty stdout — so for a deleted video the JSON error text looked like a valid
transcript, went to the model, and came back as a confident summary of the error, stored as
`state='ok'`. Cheerful garbage, indistinguishable from a real summary at a glance.

Now the exit code is checked first, the JSON body parsed for `error`, and a second check catches a
JSON error body arriving with a zero exit. Messages mentioning timeouts or connection trouble raise
a retryable `error` rather than a permanent `no_transcript`, so a network blip does not
permanently mark a video unsummarisable.

### Display

Summaries are visually distinct from descriptions — accent left border, primary text colour, four
lines instead of three — because one is the author's text and the other is model-generated.

Markdown is flattened for the column (`**bold**` unwrapped, list markers to `\u2022`), since the
cell sets `textContent` and would otherwise show literal asterisks. The raw markdown stays in the
record for any richer UI later.

### Prompt

Stored as `SUMMARY_PROMPT` in `yth`:

> Provide an executive summary of the transcript. Intro, speaker's main points with dot points
> briefly summarized. Target is less than 150 words.

### Setup note

The transcript helper needs `youtube-transcript-api`, installed in `~/.local/share/yth-venv` so
`yth` itself stays stdlib-only. `fetch_transcript` fails with the exact `uv` command to recreate it
if that venv goes missing.

### Cost and timing footer

Each summary carries a footer: `Summary cost $0.00055, took 4.2 sec`.

**The cost is the real billed figure, not an estimate.** OpenRouter returns `usage.cost` when the
request includes `"usage": {"include": true}`, so the number cannot drift away from actual spend
the way a hardcoded price table would. Token counts are stored alongside it and shown by the CLI.

The elapsed time covers the **whole click-to-result path**, transcript fetch included, since that
is what the wait actually consists of — not just the model call.

Stored as `summary_cost` / `summary_ms` / `summary_tokens_in` / `summary_tokens_out` rather than
appended to the summary text, so the summary itself stays clean for other uses. The daemon composes
the footer string when serving.

Two rendering details:

- **The footer is a sibling of the summary, not part of it.** Inside the `-webkit-line-clamp` box it
  would be clipped exactly when the summary is long enough to need clamping — i.e. almost always.
- **Costs run to fractions of a cent**, so two decimal places would render every summary as `$0.00`.
  The formatter uses five decimals below a cent and trims trailing zeros.

Summaries made before this existed have no cost data; the footer is omitted for them rather than
showing zeros. Re-clicking Robert refreshes both the summary and its footer.

---

## 16. Payload schema version

Three times now, adding a field to the sync payload (`description`, `summary`, `summaryMeta`) left
clients showing blanks until a manual extension reload plus `yth resync`. The cause is structural:
clients page with `row_updated > cursor`, so a row they have already consumed is never re-sent —
even though the payload now carries more than it did when they consumed it.

`/recent` now stamps every response with `PAYLOAD_SCHEMA`. The client stores the version it last
merged; on a mismatch it rewinds its cursor to 0 and re-pulls everything. **Bump `PAYLOAD_SCHEMA`
whenever a field is added to or changed in the payload** and the dance retires itself.

One trap worth recording: the first version called `ythPull()` from inside its own in-flight
promise. `ythPull` has a re-entrancy guard that returns the in-flight promise, so the recursive call
would have returned the promise it was already inside — awaiting itself, hanging forever. The
schema branch now returns a `schemaChanged` marker and the outer handler re-pulls, which is where
the drain loop already recurses, after the guard has cleared.

## 17. Bug: background description backfill never ran

The daemon's periodic backfill was placed *after* `c.close()`, so every cycle raised
"Cannot operate on a closed database" and was swallowed by the loop's `except Exception`. The likes
sync above it still worked, which is why the symptom was only a repeating log line and descriptions
that never filled in on their own — `yth backfill` had to be run by hand.

Moved before the close. The log line to look for is `[HH:MM] descriptions: +N`.

## 18. Capture stops in YouTube tabs that were open during an extension reload

Reloading an extension **orphans its content scripts in already-open tabs**. The old script stays
in the page but its `chrome.runtime` connection is dead ("Extension context invalidated"), so it
silently records nothing until the tab is refreshed.

This matters because the workflow here involves reloading the extension often. Symptom: watch
history simply stops, while everything already captured syncs normally.

Distinguishing it from a sync failure takes one query — compare video ids in the profile's
IndexedDB against the record. If nothing is missing from the record, the pipeline is healthy and
the extension never captured the video in the first place.

---

## 19. The "George" button — email the summary

George = **summarise if needed, then email**. It reuses an existing summary rather than paying for
one twice; only a video with no summary triggers a model call. End to end on a fresh video: ~5.7s.

```
George click
  -> background.js  yth-email
       -> daemon POST /email-summary
            -> summarise_video()   (skipped when a summary already exists)
            -> Gmail API  users.messages.send
       -> ythPull()
```

### Sending as your own account, not a transactional provider

The first implementation used Resend and hit a wall: its shared sender only delivers to the account
owner's own address, and the sending domain is not verified there, so
`you@example.com` was refused outright. Verifying a domain would have fixed it, but the
simpler answer is that this is personal mail from a personal account — Gmail sends it with no
recipient restriction at all.

Resend was removed entirely.

### Three separate credentials, deliberately

| Holder | Credential | Can do |
|---|---|---|
| `yth` — YouTube | `~/.config/yth/credentials.json` | Read likes on the **gmail** account (`youtube.readonly`) |
| `yth` — mail | `~/.config/yth/credentials-gmail.json` | **Send only** from the sending account (`gmail.send`) |
| Browser extension | *none* | No mail access of any kind |

The two Google tokens are separate files because they authenticate **different accounts**: YouTube
data lives on one Google account, while mail must originate from another. Neither can do
the other's job.

**`gmail.send` cannot read mail.** Verified directly against the API with that token:

```
list inbox messages    DENIED 403  Request had insufficient authentication scopes.
read profile           DENIED 403  Request had insufficient authentication scopes.
list drafts            DENIED 403  Request had insufficient authentication scopes.
```

This surfaced as a bug first: the sender originally called `users/me/profile` to discover its own
address, which a send-only scope forbids. The fix was to remove the lookup rather than widen the
scope — the address comes from config instead.

**The extension holds no mail credential whatsoever.** Its manifest requests `storage` and `alarms`,
with host access limited to youtube.com and 127.0.0.1; no extension script references Gmail. It
sends a video id to the daemon and nothing else.

### Configuration

`~/.config/yth/config.json`, written on first run:

```json
{
  "email_to": "you@example.com",
  "email_from_address": "sender@example.com",
  "email_from_name": "YouTube History",
  "email_subject_prefix": "\ud83d\udcfa "
}
```

Precedence is **config file → environment (`YTH_EMAIL_TO`, `YTH_EMAIL_FROM_NAME`) → defaults**, and
`yth email <id> --to addr` overrides for one run. The daemon endpoint also accepts a `to` field, so
per-row or per-channel recipients need no new plumbing.

`email_from_address` is optional — Gmail fills From from the authorised account when it is blank.
Set it only to attach a display name.

### Email content

Thumbnail, linked title, channel, the summary in an accent-bordered block, a watch link, and the
cost/time footer, with a plain-text alternative for clients that want it.

### Verified

Sent to `you@example.com` (message id confirmed) and confirmed in the Sent folder
through a separate read-capable integration — the address Resend had refused.

---

## 20. Hallucination investigation — "Janet Yellen" and a 2023 date

An emailed article named **Janet Yellen** nine times and dated itself **October 26, 2023**. Neither
came from the transcript. Two unrelated causes.

### Cause 1: the date was a data bug, not a hallucination

The model emitted a literal template placeholder:

```
**Published: [Date of publication, e.g., October 26, 2023]**
```

That is the model's own *example*, not an assertion — but rendered in email it reads as one.

`published_at` was added **after** all descriptions had been backfilled, and
`backfill_descriptions` selected rows `WHERE description IS NULL`. It therefore never revisited
them: **1 of 1298 rows had a date**, and every article was told "Published date: unknown".

Fixed by keying the backfill on either field being absent. Its progress counter had the same blind
spot and stopped the loop early, so that was fixed too. 1277/1298 now carry real dates; the other
21 are deleted or private.

### Cause 2: Yellen was a genuine fabrication, licensed by the prompt

Counts — transcript: `Yellen` 0, `Bessent` 0, `Treasury Secretary` 0. Article: `Yellen` 9.

The transcript *does* name the official: the auto-captioner rendered it **"Besson" 8 times**. The
model met an unfamiliar surname in a Treasury context and reached for a familiar office-holder.

The original prompt asked for a stylistic rewrite with nothing anchoring it to the transcript.
Accuracy rules were added that override style: no names, titles, figures or dates absent from the
source; keep roles unnamed rather than guessing; never emit placeholders; do not pad.

### What the model can and cannot repair

Worth stating precisely, because the intuitive fix makes this worse.

The same article correctly repaired **SIPs → CIPS** and **R&B → RMB**. Those are *repairs*: a
garbled token exists and context settles its identity. Yellen was an *insertion*: no token existed.
The rule now encodes exactly that distinction — repair what is present, never fill a void.

**But repair only works for entities the model knows.** Asked directly, both
`gemini-2.5-flash-lite` and `gemini-2.5-flash` answer that the current US Treasury Secretary is
Janet Yellen. Asked to correct a surname rendered "Besson" in a 2026 Treasury story, flash-lite
guesses *Bentsen* (Lloyd Bentsen, 1990s) and flash reasons its way confidently to *Yellen* — it
reproduces the original bug more persuasively than the weaker model.

Two conclusions follow:

- **"Verify entities from context" as a prompt instruction would make this worse.** It licenses
  exactly the substitution that caused the incident, for any entity postdating the model.
- **A stronger model does not help here and is arguably more dangerous.** flash costs ~4.8x more
  ($0.00412 vs $0.00086) and was no better; it dropped RMB entirely and was more confident about
  Yellen. `article_model` is configurable, but there is no evidence for upgrading.

### Current behaviour

Across flash-lite and flash, with and without title grounding, the article now writes "the Treasury
Secretary" and names nobody. Fabrication is gone; the name is lost. That is the right trade — a
missing name is a gap, a wrong name is a lie — but it is a real loss, not a clean win.

Passing the creator's title and description as authoritative *spelling* (never as substance) did
not recover it: the model stays conservative and uses the role.

### The remaining fix, not yet built

The reliable repair is **deterministic, not model judgement**: before the transcript reaches the
model, fuzzy-match its tokens against proper nouns in the creator's title and description and
substitute in code. "Besson" to "Bessent" is an edit distance of 2 against a name the creator
themselves published. No model knowledge involved, no cutoff exposure, and auditable.

---

## 21. Per-channel caption repair and the verification gate

Auto-captions mis-hear the same proper nouns every time for a given speaker, so the fix belongs to
the **channel**, not the video. Confirmed before building: "Besson" appears in 4 of 4 sampled Sean
Foo transcripts (17 occurrences) and "Bessent" in none of them — while 7 of his 36 video titles
spell it correctly, because the creator typed those himself. The ground truth was already in the
record.

### Glossary

`channel_terms(channel, wrong, right)`, applied as a literal whole-word substitution **before the
model sees the transcript**. A string swap cannot hallucinate, is auditable and is reversible —
which is the point, given the incident was caused by the model inferring.

```
yth terms --channel "Sean Foo" --add Besson=Bessent --add SIPs=CIPS --add "R&B=RMB"
yth terms                       # list all
```

Generation logs what it repaired: `glossary [Sean Foo]: Besson->Bessent x8, SIPs->CIPS x3, R&B->RMB x2`.

### The prompt had over-corrected

With the glossary applied the transcript said "Bessent" eight times and the article *still* named
nobody — the accuracy rules had been read as "never name people". A positive rule was needed: use
the names the transcript gives you; the prohibition covers only names that are absent. After that
the article correctly attributes to Bessent.

### Verification gate

`verify_article()` extracts entities from the article — acronyms, capitalised runs, non
sentence-initial capitalised words — and checks each against the repaired transcript plus the
creator's own title and description. Anything else was supplied by the model.

Tuning it mattered more than writing it. Four rounds of false positives, each a structural artifact
rather than a real finding: heading text, byline dates, list-item openers, and bold lead-in labels
followed by a colon. Headings and labels are the model's framing, not claims, so they are excluded;
colons and semicolons now count as clause boundaries. Noise fell from 26 flags to 9 on a bulleted
article and stayed at 3 on the Sean Foo one.

It earns its place: on an unrelated article it flagged `VSL` / `Video Sales Letters`, which appear
**zero** times in that transcript — an entire fabricated section, found automatically.

The gate blocks sending. `yth email <id> --force` overrides.

### Bug: the gate made false accusations when it could not run

`verify_article` re-fetched the transcript, and on failure fell back to an empty string — so the
haystack became title-plus-description and nearly every entity looked invented. During testing
YouTube rate-limited the repeated fetches and the gate duly accused a US-China article of inventing
"America", "Beijing" and "Canada".

Two fixes. Transcripts are now **cached** on the row at generation time, so verification reuses
them instead of hammering an unofficial endpoint. And an unavailable transcript raises
`CannotVerify` rather than returning an empty result: *"could not check"* and *"found nothing
wrong"* are different answers, and conflating them turns diligence into fabrication of a different
kind.

## 22. The "Tracked" tab (built)

A second surface between History and Stats. History answers *what did I watch*;
Tracked answers *what did the channels I care about just publish*. Videos appear
there without being watched — the point is the notice, not the record.

**Discovery is the per-channel Atom feed, not the Data API.**
`https://www.youtube.com/feeds/videos.xml?channel_id=UC…` returns the last 15
uploads with video id, title, description and publication time. Zero API quota,
no OAuth, and — this turned out to matter the same day — it kept working while
the account's refresh token was expired and every `api_get` call was returning
`invalid_grant`. Duration is the one field the feed lacks; the existing
description backfill supplies it when a token is available.

Handle→channel-id resolution scrapes the channel page for `externalId` rather
than calling `channels.list?forHandle`, for the same reason: adding a channel
must not depend on OAuth.

**Storage is shared; transport is not.** Discovered videos are rows in `videos`,
so `summarise_video`, `email_video_summary`, `apply_glossary` and
`verify_article` all work on them with no changes, and a tracked video you
later actually watch merges into the same row instead of forking. But Tracked is
served on its own `/tracked` endpoint with its own `TRACKED_SCHEMA`, because:

- History's `PAYLOAD_SCHEMA` must not move — a bump forces both profiles to
  re-pull all 1,300 rows, and the notice list is no reason for that.
- Tracked rows have no `sessions` entries. Folded into the History payload they
  would reach `stats.js` and be counted as watch time.

**Two things that would have leaked and had to be closed explicitly:**

1. A newly discovered video is inserted with `row_updated = 0`, not `now`.
   History's `/recent` selects on `row_updated > since`, so a non-zero stamp
   would have pushed every unwatched notice straight into the History tab —
   exactly the pollution the separate endpoint was meant to avoid. Watching it
   later makes `touch()` bump the stamp, and only then does it appear.
2. `Clear` on Tracked writes `tracked_items.cleared_at`, never `videos.hidden`.
   Sharing one flag would mean dismissing a notice permanently hides the video
   from History — worst possible outcome for a video you dismissed *because you
   meant to get to it later*. `emailed_at` is deliberately shared the other way:
   "sent" is a fact about the video, not about which tab you clicked in.

The `ON CONFLICT` clause only fills descriptive fields that are empty
(`COALESCE(NULLIF(videos.title, ''), excluded.title)`) and never touches
position, watch count or `last_seen`. Confirmed against Sean Foo's feed: of 15
entries, 5 already existed as watched rows and kept `watch_count` and
`last_position` intact; 10 were new and stayed out of History.

**Buttons.** Clear/Robert/George render on both tabs and call the same daemon
endpoints today, but through separate handlers in `tracked.js` — the workflows
can diverge without touching `history.js`. History gains a fourth pill, `Track`,
which adds that video's channel; it is a row action rather than a card-menu item
because it is a one-click reaction to something you just enjoyed.

**Seeding.** A feed always carries the last 15 uploads, so adding a channel
would dump its entire back catalogue in as unread — track 20 channels through
the subscriptions picker and the tab opens with 300 notices, which is the
opposite of "this channel published something new". Anything published before
`tracked_channels.added_at` is inserted with `cleared_at` already set: recorded,
visible under *Show cleared*, but not counted as new. Verified by adding
Veritasium — 15 items stored, 0 unread.

**Freshness.** A background thread polls every 30 minutes, separate from
`likes_loop` so an expired token cannot stop it. Opening the tab renders from
the daemon and *then* kicks a poll — but only for channels checked longer than
`TRACKED_STALE_MINUTES` (15) ago, because at 30 tracked channels an
unconditional poll on every visit is 30 serial HTTP fetches with the button
stuck on "Checking…". Pressing **Refresh** sends `force` and checks every
channel, which is what makes "I refreshed, so it is current" true. Both paths
take a non-blocking `tracked_lock`, so a click during a background poll returns
`busy` instead of duplicating N feed fetches.

**Paging.** `/tracked` caps a response and reports `more`; the client follows
`cursor` until it is false. A notice list that silently truncates at the cap
would be worse than a second round trip.

Three ways to add a channel: the `Track` pill on a History row, a URL/@handle
field, and a filtered picker over your subscriptions. Only the third needs
OAuth, and it says so plainly when the token has lapsed rather than failing
silently.

The `Track` pill needed one extra step. `channel_url` is empty for 1,228 of
1,316 rows — the extension never captured it and the description backfill never
asked the API for `snippet.channelId` — so the pill would have been disabled on
93% of History rows. Rather than a schema migration plus a full re-backfill
(which needs the working token we do not currently have), `/tracked-add` accepts
a `videoId` and scrapes the watch page for its `channelId`. Verified on
`LMpMmOWTtVk`, which had no `channel_url`: resolved to `@TheNextNewThingAI` and
pulled its 15 latest uploads.

## 23. Re-authorisation, and two leaks it exposed

The refresh token had lapsed — Google expires them after 7 days while the OAuth
consent screen is in *Testing* — so `sync-likes` and the description backfill
had been failing every cycle, and the new subscriptions picker returned
`invalid_grant`.

The first re-auth stored a *valid* token for the wrong Google account. It was
not obvious from the token itself; the tell was three empty results in a row:

```
channels?mine=true      -> 0 items
subscriptions?mine=true -> totalResults: 0
yth sync-likes          -> "No channel found for this account."
```

Subscriptions and the likes playlist belong to a *channel*, not an account, so
an account that has never created one authorises perfectly and returns nothing.
Worth remembering: "the API accepts the token" is not the same as "the token is
for the right identity". Re-running with the correct account gave
`UCilsFCl5J83rkYtkqnHtjbA / Robert Cousins` and 493 subscriptions.

**Durations were never backfilled.** `backfill_descriptions` keyed on
`description IS NULL OR published_at IS NULL`, so the 39 videos discovered from
channel feeds — which carry everything except duration — were never revisited.
`fetch_snippets` now asks for `snippet,contentDetails` in the same request (no
extra quota unit) and the pending query includes `duration = 0`. The duration
clause excludes `description = ''`, the marker this function already writes for
a video the API will not return: without it the 21 deleted/private liked videos
would be re-queried on every pass forever. 43 durations filled.

**The report had the same leak the History tab did.** `gather()` selects on
`last_seen`, and a tracked discovery carries `last_seen = publication time`, so
following a channel filled the report with "not played" rows for videos never
opened — 39 records where 22 were real. The History fix (`row_updated = 0`) did
not cover this, because the two surfaces select on different columns. `gather()`
now excludes tracked-source rows with no watch_count, no last_position and no
sessions; watching one restores it legitimately.

**And the duration backfill immediately reopened the History leak.** Its UPDATE
set `row_updated = now` unconditionally, so filling 39 tracked durations stamped
39 unwatched notices with a live History cursor — undoing the `row_updated = 0`
guard the insert path exists to provide. Confirmed by query, not by reasoning:
39 rows. The stamp is now conditional, and the 39 were re-zeroed.

Two more surfaces had the same hole and were fixed at the same time:

- `cmd_resync` re-stamps every row to force clients to re-pull. It would have
  converted every Tracked notice into History content permanently — and it is a
  maintenance command reached for after a future schema bump, so the damage
  would have been silent and much later.
- `cmd_export_extension` feeds `db_bulkImport`, which **clears the stores before
  writing**. Exporting tracked rows would replace the extension's History with a
  list containing videos that were never watched. The README still documents
  that round trip.

All four now share one predicate, `UNWATCHED_TRACKED`, defined once rather than
retyped per call site — four hand-written copies of the same four-clause
condition is how the next one gets missed. Verified individually: backfill
stamps 0, export emits 1,316 of 1,355 with 0 tracked, resync re-stamps 1,316,
report shows 22 records rather than 39.

The general lesson, and this is now the fifth surface: a new source writing into
`videos` leaks into every surface that reads `videos`, and each surface keys on
a different column — History on `row_updated`, the report on `last_seen`, export
on everything, resync on everything, Stats via the extension's own store. Adding
the source is the easy part; enumerating the readers is the work. Reasoning
about which ones are affected was not sufficient here — two of the five were
found only by being told to run the query.

## 24. History display window

The record now goes back to Feb 2015 and the tab was rendering all 1,371 rows.
"Clear anything older than two weeks" has two readings that lead to very
different work — a display filter, or `hidden = 1` on 1,200 rows synced to both
profiles — so it was worth asking rather than guessing. A display window was the
answer, and it is the better default anyway: `yth hidden --unhide` takes one id
at a time, so a bulk Clear would have been reversible only by hand-written SQL.

A **Show** control (2 weeks / 1 month / 3 months / 1 year / Everything, default
2 weeks) filters on `video.timestamp` in `applyFilters`, stored as
`historyWindowDays`. Nothing is written to the record and nothing syncs;
widening it back is instant. The stat bar gained *Showing: N* beside *Total
Archived*, so a narrow window never looks like data loss, and the empty state
distinguishes "nothing in this window" from "no history saved yet".

**The four-pill stack broke the Small thumbnail size.** Four pills at 14px stack
to ~100px against a 120px-wide thumbnail's 67px height, so the row height was
set by the pills and choosing Small saved no vertical space — the control did
nothing. `.video-rows.thumb-small .pill-btn` now shrinks to 11px with tighter
padding, which fits the stack inside the thumbnail again. Shrinking rather than
hiding a pill: every action stays reachable at every size. The rule keys off the
shared container class, so Tracked gets it too.

## 25. "4 channels failing to check" — a false alarm, and a real bug behind it

The Tracked tab reported all four channels failing. They were not: every feed
returned 200 from curl and from `fetch_channel_feed` back-to-back seconds later.
What the record held was one bad moment, `14:58:56`, in which YouTube's feed
endpoint answered a 500 for one channel and 404 for the other three — all four
of them valid, all four fine on the next request.

Two separate faults, and the visible one was the less important:

**No retry.** A single transient response marked a healthy channel broken.
`http_text` now retries three times with 1.5s and 3s backoff on any HTTPError,
URLError or timeout. Confirmed against a genuinely invalid channel id: raises
after ~6s having actually made three attempts, rather than failing instantly.

**`last_checked` moves whether or not the fetch worked**, so nothing in the
schema could answer "is this channel actually broken?". Added `last_ok` and
`fail_count`: success clears the count and stamps `last_ok`, failure increments.
A channel is only reported as failing at `fail_count >= 3` — one bad response
from this endpoint is routine and self-corrects, and the UI called it a failure
on the first. The chip tooltip now says how many checks failed in a row and when
the channel last worked, rather than showing a bare HTTP code.

The summary line changed from a count to names — `Not responding: X, Y` — since
"4 channels failing to check" told you a number and nothing actionable.

Worth noting the shape: the alarming symptom was cosmetic, and the actual defect
was that a poller wrote failure state it could never distinguish from a real
outage. Retry fixes today's noise; `last_ok` is what makes a genuine failure
legible when one eventually happens.

## 26. Subscriptions manager (built)

A fourth tab. It answers "which of these 491 should I keep?" and lets you queue
removals that the daemon executes slowly, in budget, over hours.

**Everything the UI needs costs 10 quota units.** `subscriptions.list?part=snippet`
returns title, description, avatar, the channel id **and the date you
subscribed** — 1 unit per 50 channels, so the whole list is 10. No second call.

**"Is the channel dormant" stays free.** Last-upload date comes from the Atom
feed, not the API: asking `playlistItems` for 491 channels would be 491 units a
pass. Checks are staleness-gated (weekly) and capped at 8 per background pass,
because firing 491 feed requests at once is exactly what drew the spurious 404s
in §25.

**"Last viewed" is labelled for what it measures.** Real watch data starts
19 Aug 2026; likes go back to 2015. So the value is the later of last-watch and
last-like, and `lastViewedKind` says which — the row reads *Liked 3.2y ago* or
*Watched 4d ago*, never a bare date implying we saw you watch something in 2015.
A banner above the list says so too. A column that silently means something
other than its label is how §20 happened.

Matching subscriptions to history was fuzzy (display name, breaks on rename), so
`videos.channel_id` was added and is backfilled from `snippet.channelId` — a
field the description backfill's call already returned. Exact where the backfill
has reached, normalised-name fallback where it has not.

### The write path

`subscriptions.delete` needs `https://www.googleapis.com/auth/youtube`, and
there is no subscriptions-only write scope — that one also permits playlist
edits, video metadata changes and channel settings. So:

- It lives in its own `credentials-youtube-write.json`, authorised by
  `yth auth --write`, and **nothing defaults to it**. `access_token()` takes an
  explicit path and the write path is named at exactly one call site. Read-only
  work cannot accidentally acquire write authority.
- Verified the refusal is safe: with no write credentials the drain records
  `stopped: auth`, leaves the row `queued`, and unsubscribes nothing.

**Queue, don't act.** The Unsub pill sets `unsub_state = 'queued'`. A worker
drains one per minute. That is what makes "select a lot and let it run" safe:
nothing irreversible happens for at least a minute, a visible queue bar shows
the count, and **Cancel all queued** stops the rest. `unsub_state` is an enum
(`queued → sent → done | failed | cancelled`), never a boolean — a row can sit
for days, and "queued" and "already gone" must never be confused.

The subscription id is re-verified against the API immediately before each
delete. It is not the channel id, and it changes if you unsubscribe and
resubscribe, so a stored id could spend 50 units deleting nothing — or something
else. If the channel is already gone the row is marked `done` without spending
anything.

### Quota

Metered inside `api_get`, the only place units are spent, into a `quota_usage`
table. Two things that are easy to get wrong and were checked rather than
assumed:

- **The day key is the Pacific date.** YouTube resets at midnight
  America/Los_Angeles *with DST*. Keying on Perth or UTC would roll the budget
  over mid-afternoon and report the wrong remaining spend for most of the day.
  `zoneinfo` where tzdata exists, the US rule as fallback.
- **The write path debits before the call.** A crash between issuing a delete
  and committing its cost would lose the 50 units and the next start would
  re-spend them.

Budget is 5,000 of the 10,000 default and is checked **only** on the write path,
so a runaway unsub worker cannot starve the likes sync or the backfills. On
exhaustion the worker stops, logs once per quota day (not once per minute), and
emails a notice; the UI shows the same numbers in the queue bar. Nothing is
lost — the queue resumes after the reset.

A side benefit: the Tracked tab's subscription picker now reads the synced
table instead of re-listing 491 channels from the API every time it is opened,
which was 10 units per open for a list the new tab already keeps current.
`fetch_subscriptions` was deleted rather than left as a third way to list the
same thing.

### Three things a review caught that testing had not

**Queueing had no guard at all.** `/subs-queue` checked only `present = 1` and
the state — so a channel you track, or have 40 liked videos from, queued
silently. Queueing is bulk by design, so a per-row confirmation is the wrong
answer; instead the endpoint now returns warnings and the toast names them
(*"Sean Foo queued — note: on the Tracked tab and 32 liked video(s)"*). The user
still decides, they just see it inside the minute before it runs.

**`sync_subscriptions` could strand a queued removal.** It set `present = 0` for
anything absent from the returned list, which on a short page would flip a
queued row — and `queue_unsub`'s `present = 1` guard would then silently refuse
to re-queue it. A pending removal that can never run and gives no reason why.
Rows in `queued`/`sent` are now exempt: the state machine owns them. Verified a
sync leaves a queued row at `present = 1`.

**The 60-second auto-reload fought the user.** `applyPayload` reset
`currentIndex = 0`, so anyone who had pressed Load More twice and was triaging
row 200 of 491 got thrown back to row 30 once a minute. Background reloads now
re-render as many pages as were already open.

## 27. "I queued two jobs but it's not working"

Correct, and for a reason the UI failed to say: **the write scope was never
authorised.** The auth flow started at the end of §26 timed out unapproved, so
`credentials-youtube-write.json` does not exist. The queue was behaving exactly
as designed — both rows sat at `queued`, the drain reported `stopped: auth`,
nothing was sent — but the tab showed only "one a minute, 99 more allowed
today", which reads as *waiting its turn*. `unsub_budget` now returns `blocked`
and `blockedDetail`, and the queue bar says what is actually stopping it.

Two real bugs surfaced while diagnosing it.

**The likes loop had been crashing every cycle.** `backfill_descriptions`
returns `0` on its early-return path, but every caller unpacks two values —
`_, filled = backfill_descriptions(...)`. So the moment the backfill finally had
nothing left to do, the daemon started raising `cannot unpack non-iterable int
object` on every pass. 374 occurrences in the log. It lay dormant for as long as
there was work to do, and only fired once the record was complete, which is the
worst possible timing for noticing it. Returns `0, 0` now.

**The likes sync was consuming most of the daily API quota.** The new ledger
showed 4,435 units spent in a day with the backfills finished and no
unsubscribes sent. Cause: `cmd_sync_likes` called `fetch_durations` on all 1,238
liked videos every run — 25 units — for values that had not changed since the
first sync, plus 25 units of playlist paging, every 10 minutes. About 7,200
units a day against a 10,000 allocation. It only asks for durations it does not
already hold now, and the daemon's interval went from 10 to 30 minutes: a
measured cycle costs **27 units**, so roughly 1,300 a day rather than 7,200.

That is the argument for metering generally. The waste was years-old in
character and completely invisible; nothing was failing, the numbers were simply
never counted. It became a real problem only when the unsubscribe budget started
competing for the same allocation — and then it showed up immediately.

## 28. Links opening in the YouTube app instead of a tab

Every outbound link was a plain `<a target="_blank">`, which is a *navigation* —
and a navigation to youtube.com can be captured by an installed app (a Chrome
PWA, or a Windows app registered for the site under "Apps for websites"),
landing the video outside the browser entirely.

`openlink.js` delegates from `document` and hands `https?:` links with
`target="_blank"` to `chrome.tabs.create` instead. That asks the browser for a
tab directly, so there is no navigation left for anything to intercept.
Delegated rather than wired per row, so it covers everything rendered later
without any page knowing about it; loaded by all five pages, so the nav bar's
own YouTube link behaves the same.

Modified clicks (ctrl, shift, meta, alt, middle) fall through untouched — they
already mean something specific and the browser should keep handling them.
Non-http hrefs are ignored so in-extension links are unaffected, and there is a
`window.open` fallback for Firefox builds where `chrome.tabs` is absent.

Verified by stubbing `chrome.tabs.create` and dispatching a real click at a
rendered row: `chrome.tabs.create` called with the watch URL, and `navigated`
false — the anchor's own navigation was suppressed rather than both firing.

I could not confirm what was capturing the links: neither Chrome profile has a
YouTube PWA installed (only the preinstalled Docs app), and there is no YouTube
entry in WindowsApps or the Start Menu. So this fixes the mechanism from the
extension's side without having identified the specific handler — if it
persists, it is a Chrome or Windows association setting, not the extension.


## 29. Removed subscriptions leave the list

`present = 0` rows were rendering as a greyed "Removed" pill, on the reasoning
that an irreversible change made on the user's behalf should stay auditable.
After 19 removals that reasoning was still right and the result was still
wrong: the audit trail was sitting in the middle of the list being triaged.

Same shape as History's display window and Tracked's *Show cleared* — hidden
from every view except its own. A **Removed** option in the filter brings them
back, and the stat bar carries a *Removed: 19* count so they are discoverable
rather than merely gone. The rows stay in the record; only the default view
changed.

Worth recording why the 19 were checked before being hidden: only 3 removals
had been observed in this session, so 19 `present = 0` rows looked like
`sync_subscriptions` over-marking — the exact failure §26 had already guarded
against once. It was not: all 19 carried `unsub_state = 'done'` and all 19
appear in the daemon log by name, drained one a minute from queues built in the
tab. The log existing in that form is what made the check take one command
instead of an investigation.
