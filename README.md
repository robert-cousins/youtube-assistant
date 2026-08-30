# youtube-assistant

A local YouTube record and assistant. It captures every video you open — including the ones you
never pressed play on — keeps them in a SQLite record that grows rather than being recomputed, and
adds three working surfaces on top: what you have watched, what the channels you follow have just
published, and whether the things you subscribe to still earn their place.

Everything runs on your machine. A Chrome extension captures and renders; a Python daemon
(standard library only, no dependencies) holds the record and does the work. The only things that
leave the machine are calls you ask for: the YouTube Data API, OpenRouter for summaries, and Gmail
for sending.

Two Chrome profiles and a phone converge on the same record.

---

## Features

### History — everything you have opened

One row per video, laid out as a table: thumbnail, actions, title, description, status.

- **Captures unplayed videos.** Open a video, change your mind, click away — it is still recorded,
  at 0%. Most trackers only record what you watched.
- **Survives in-app navigation.** YouTube is a single-page app; clicking video to video never
  reloads the page. Capture hooks `yt-navigate-start` so a new video id is never written with the
  previous video's player state.
- **Display window.** Show the last 2 weeks / month / 3 months / year / everything. A render
  filter, not a delete — the record keeps everything and widening it back is instant.
- **Thumbnail size** (small / medium / large) and **theme** (match YouTube / light / dark), both
  persisted across pages and profiles.
- **Descriptions and summaries** in their own column, with the original description on hover.
- **Liked videos** are folded in from your account, including things you liked on a phone. They
  render as `★ Liked` rather than "not played", which would be the opposite of true.
- **Clear** hides a video everywhere, permanently and across profiles. `yth hidden` lists what you
  removed and `--unhide` puts one back.

### Tracked — new uploads without waiting to watch

Channels you want to hear from. New uploads appear as notices, whether or not you have watched
anything from them.

- **Costs no API quota.** Discovery reads each channel's Atom feed, so it keeps working even when
  your OAuth token has expired.
- **Three ways to add:** a `Track` pill on any History row, a URL / `@handle` / `UC…` id field, or
  a filtered picker over your subscriptions.
- **No back-catalogue dump.** A feed carries the last 15 uploads; anything published *before* you
  started tracking is recorded but pre-cleared, so tracking 20 channels does not open the tab with
  300 unread notices.
- **Clear is independent of History.** Dismissing a notice never hides the video from History —
  you may well be dismissing it *because* you mean to watch it later.
- **Stays current.** A background poll every 30 minutes, plus a check of anything stale when you
  open the tab. **Refresh** forces a full check of every channel.

### Subscriptions — audit and prune

Every channel you subscribe to, ranked by how long since you last engaged and how long the channel
itself has been dormant.

- **Sorts that matter:** least recently viewed, least recently posted, longest subscribed, most
  liked. Never-viewed and long-dormant surface together at the top.
- **Honest labelling.** Watch data only exists from when you installed the extension; likes go back
  years. Each row says which it is — *Liked 3.2y ago*, *Watched 4d ago* — and a banner explains it.
  A column that silently means something other than its label is worse than no column.
- **Dormancy is free.** Last-upload dates come from Atom feeds, checked a few channels a minute in
  the background, rather than 1 quota unit per channel per pass.
- **Unsubscribing is queued, never immediate.** Select as many as you like; the daemon drains one
  a minute inside a daily quota budget. Nothing irreversible happens for at least a minute, the
  queue is visible, and everything still queued can be cancelled.
- **It tells you what you are about to lose.** Queueing a channel you track, or have liked videos
  from, says so.
- **Removed channels leave the list** but stay in the record under a `Removed` filter.

### Summaries and email

Two per-row buttons, both backed by the daemon so no API key ever lives in the browser.

- **Robert** — summarises the transcript (Gemini 2.5 Flash-Lite via OpenRouter, ~4 seconds,
  a fraction of a cent) and shows it in place of the description, with the real billed cost and
  elapsed time underneath.
- **George** — writes a long-form article and emails it from your own Gmail. One send per video;
  the button greys to *Sent* everywhere afterwards.

Both are guarded against the thing that makes AI summaries untrustworthy:

- **Per-channel caption repair.** Auto-captions mis-hear the same proper nouns every time for a
  given speaker, so the fix belongs to the channel. `yth terms --channel "X" --add Wrong=Right`
  applies a literal substitution before the model sees the transcript — a string swap cannot
  hallucinate, and the mapping is auditable.
- **Entity verification.** `yth verify <video_id>` checks every name, acronym and capitalised
  entity in a generated article against the transcript it came from. **Sending is blocked if
  verification fails.** If the transcript cannot be fetched the tool says it cannot check, rather
  than reporting nothing wrong.

### Cross-device

- **Two Chrome profiles** push to and pull from the same local daemon. Watch in one, see it in the
  other within a couple of minutes.
- **Phone:** like anything you watch on the YouTube app and it arrives with title, channel,
  duration and the date you liked it. No watch time, which is shown honestly rather than as 0%.
- **Self-healing schema.** When the payload gains a field, clients notice the version change and
  re-pull everything themselves.

### Quota accounting

Every API call is metered into a ledger keyed on the **Pacific** date, because that is when
YouTube resets — not your local midnight.

- A **daily budget** (default 5,000 of the 10,000 allocation) is enforced on the write path only,
  so a runaway unsubscribe worker can never starve reads.
- On exhaustion the worker stops, emails you, shows the reason in the UI, and resumes after the
  reset. Rows are re-queued rather than failed.
- `yth subs quota` shows the day's spend and how many unsubscribes remain.

### Self-correcting record

The DOM lies sometimes; the API does not. Where they disagree, the API wins.

- **Channel attribution repair.** The extension can attribute a video to the wrong channel
  entirely — during an in-app navigation the URL carries the new video id while the byline still
  shows the previous one. Capture now verifies the rendered video id before reading the byline and
  writes nothing rather than something wrong, the backfill overwrites channel identity from the
  API, and `yth repair-channels` audits the whole record (dry run by default).
- **Descriptions, durations and publication dates** are backfilled in the background, with
  unavailable videos marked so they are not re-queried forever.

---

## How it fits together

```
Chrome profile A ─┐                    ┌─ YouTube Data API   (likes, metadata, unsubscribe)
                  ├─ yth serve ─ SQLite ├─ Atom feeds        (new uploads, dormancy — no quota)
Chrome profile B ─┘   :8742            ├─ OpenRouter         (summaries)
                                        └─ Gmail API         (sending)
        phone ─── likes ────────────────┘
```

The extension pushes what it captures and pulls what the other profile and the background syncs
added. If the daemon is down everything still works locally; you lose cross-profile data until it
is back.

---

## Setup

```bash
git clone https://github.com/robert-cousins/youtube-assistant
cd youtube-assistant
```

**1. Load the extension.** `chrome://extensions` → Developer mode → **Load unpacked** → the
`extension/` folder. Repeat for each Chrome profile.

**2. Authorise.** Create a Desktop-app OAuth client in the Google Cloud Console with YouTube Data
API v3 enabled, export the id and secret as `GOOGLE_OAUTH_CLIENT_ID_YTH` /
`GOOGLE_OAUTH_CLIENT_SECRET_YTH`, then:

```bash
./yth auth --from-env             # read access (youtube.readonly)
./yth auth --gmail --from-env     # optional: emailing summaries (gmail.send)
./yth auth --write --from-env     # optional: unsubscribing (youtube)
```

Each is stored in its own file under `~/.config/yth/`, mode 0600. Nothing defaults to the write
credentials — only the unsubscribe worker names them.

> **Publish the OAuth consent screen.** While it is in *Testing*, Google expires refresh tokens
> after 7 days, which silently kills the likes sync and the backfills.

**3. Configure** `~/.config/yth/config.json`:

```json
{
  "email_to": "you@example.com",
  "article_model": "google/gemini-2.5-flash-lite"
}
```

Summaries need `OPENROUTER_API_KEY` in the environment.

**4. Start the daemon.**

```bash
./yth serve          # prints a token
```

Paste the token into the extension's Options page in each profile.

**5. Verify capture before trusting the record.** Open a long video, do not press play, click
straight to a short one. Check that row's title and duration belong to the *same* video. The
presence of a row is not enough — see `PLAN.md` §2.

---

## Command reference

| Command | What it does |
|---|---|
| `yth serve` | The daemon: HTTP bridge, background syncs, unsubscribe worker |
| `yth report [--since 5d] [--json]` | Render the record as markdown or JSON |
| `yth sync-likes` | Pull liked videos (also runs in the daemon) |
| `yth backfill` | Fetch missing descriptions, durations, dates, channel ids |
| `yth summarise <id>` | Summarise one transcript |
| `yth article <id>` | Generate the long-form article |
| `yth verify <id>` | Check an article's entities against its transcript |
| `yth email <id> [--to]` | Summarise if needed, then send |
| `yth terms --channel X --add Wrong=Right` | Per-channel caption repairs |
| `yth track add\|list\|remove\|refresh` | Tracked channels |
| `yth subs sync\|list\|queue\|cancel\|drain\|quota` | Subscription manager |
| `yth repair-channels [--apply]` | Audit and fix channel attribution |
| `yth hidden [--unhide <id>]` | List or restore removed videos |
| `yth import [FILE]` | Merge an extension export (manual fallback) |
| `yth export-extension -o FILE` | Write the record back out |
| `yth resync` | Force clients to re-pull every row |

---

## Things worth knowing

- **Reloading the extension orphans content scripts in tabs that were already open.** They stop
  recording silently until those tabs are refreshed.
- **Shorts are never captured** — only `/watch` pages.
- Times are `Australia/Perth` (UTC+8, no DST); the quota ledger uses US Pacific because that is
  what YouTube resets on.
- Import is a merge over a full snapshot, so skipping a week is harmless.
- **The extension's own import REPLACES its database rather than merging**, which is why
  `export-extension` writes the whole record and refuses to run if your newest export contains
  videos the record has not seen.
- The record (`history.db`) and anything generated from your account are gitignored. They are
  personal viewing data.

`PLAN.md` is the design log: every decision, every bug, what caused it, and what the fix actually
verified. It is the most useful thing here if you intend to change anything.

## Attribution

`yth` is original work with no upstream code — Python 3 standard library only. The extension in
`extension/` is a fork of
[GeorgeElliott/yt-watch-history](https://github.com/GeorgeElliott/yt-watch-history) (MIT), with its
history preserved so the vendor commit and every local change are visible as diffs. See
`ATTRIBUTION.md` for the full picture and the licence obligations.
