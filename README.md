# youtube-assistant

A personal YouTube record and assistant. It captures every video you open — including ones you
never pressed play on — keeps them in a local SQLite record that grows rather than being
recomputed, and adds three things on top:

- **History** — everything you have opened, one row per video, with AI summaries on demand.
- **Tracked** — channels you follow for new uploads without waiting to watch them. Discovery
  runs off each channel's Atom feed, so it costs no API quota.
- **Subscriptions** — an audit of what you subscribe to, ranked by how long since you last
  watched or liked anything of theirs and by how long the channel has been dormant, with
  unsubscribes queued and drained slowly inside a daily quota budget.

Everything runs locally: a Chrome extension for capture and UI, a Python daemon (stdlib only)
holding the shared record, and a local HTTP bridge between them. Nothing leaves the machine
except calls to the YouTube Data API, OpenRouter for summaries, and Gmail for sending.

Two Chrome profiles and an iPhone all converge on the same record.

See `ATTRIBUTION.md` for what is original versus borrowed, and `PLAN.md` for the full design log —
including the bugs, what caused them, and what the fixes actually verified.

## Layout

| Path | What |
|---|---|
| `yth` | The CLI and daemon. Python 3, standard library only, no dependencies. |
| `extension/` | The Chrome extension. A fork of GeorgeElliott/yt-watch-history (MIT) — see `ATTRIBUTION.md`. |
| `patches/` | The original patches against upstream, kept for provenance. |
| `PLAN.md` | Design decisions and the engineering log. |

## Setup

```bash
git clone https://github.com/robert-cousins/youtube-assistant
cd youtube-assistant
```

**1. Load the extension.** `chrome://extensions` → Developer mode → **Load unpacked** →
the `extension/` folder. Repeat for each Chrome profile.

**2. Authorise the YouTube API.** Create a Desktop-app OAuth client in the Google Cloud Console,
export the id and secret as `GOOGLE_OAUTH_CLIENT_ID_YTH` / `GOOGLE_OAUTH_CLIENT_SECRET_YTH`, then:

```bash
./yth auth --from-env             # read access (youtube.readonly)
./yth auth --gmail --from-env     # optional: sending summaries (gmail.send)
./yth auth --write --from-env     # optional: unsubscribing (youtube)
```

Publish the OAuth consent screen, or Google expires the refresh token every 7 days.

**3. Configure.** `~/.config/yth/config.json`:

```json
{
  "email_to": "you@example.com",
  "article_model": "google/gemini-2.5-flash-lite"
}
```

Summaries need `OPENROUTER_API_KEY` in the environment.

**4. Start the daemon.**

```bash
./yth serve                       # prints a token
```

Paste the token into the extension's Options page in each profile. The extension pushes what it
captures and pulls what the other profile and the likes sync added.

**5. Verify capture before trusting the record.** Open a long video, do not press play, click
straight to a short one. Check that row's title and duration belong to the *same* video. See
`PLAN.md` §2 — the presence of a row is not enough.

## Use

```
# Export from the extension's options page, then:
./yth import                 # newest export in ~/Downloads or C:\Users\*\Downloads
./yth import path/to.json

./yth report                 # last 5 Perth days, markdown
./yth report --since 2w
./yth report --json
./yth report --unplayed-only
./yth report --min-seconds 30
```

### Liked videos (optional — this is the iPhone route)

```
yth auth --client-secret client_secret.json   # once; Desktop-app OAuth client
yth sync-likes                                # each run
```

Needs a Google Cloud project with YouTube Data API v3 enabled. The refresh token is stored at
`~/.config/yth/credentials.json` (mode 0600), outside this directory. Liked-only videos render as
`★ liked · watch time unknown` — never "not played", which would be the opposite of true. Likes
carry their real date (when you liked it); if that field is ever missing the item is still kept,
stamped with the sync time and shown as `(date approximate)` until a real date turns up.

### Live sync (recommended — no manual steps)

```
yth serve          # prints a token; already autostarts at Windows logon
```

Autostart is registered as the Windows scheduled task **yth-daemon**, which launches it inside WSL
with no console window. Logs: `~/.local/state/yth/daemon.log`.
To disable: `schtasks /Delete /TN yth-daemon`.

Paste the token into the extension's options page ("Sync daemon" → Test) **in each Chrome
profile**. From then on, watching or liking anywhere — either profile, or your phone — shows up in
the History tab on refresh. Likes are pulled every 10 minutes; captures push instantly.

If the daemon is not running, everything still works locally; you just lose cross-profile and phone
data until it is back.

### Manual round-trip (only if you are not running the daemon)

```
yth import                              # 1. latest extension export
yth sync-likes                          # 2. pull likes
yth export-extension -o merged.json     # 3. write a superset back out
                                        # 4. import it via the options page
```

**The extension's import REPLACES its database — it does not merge.** That is why step 3 emits the
whole record rather than just the likes, and why it refuses to run if your newest export contains
videos the record hasn't seen. Keep that export until you've confirmed the History tab looks right.

Python 3 stdlib only. The record lives in `history.db` beside the script; the report window is
purely a render flag, so `--since 30d` works as soon as you have 30 days of data.

## Notes

- Times are `Australia/Perth` (UTC+8, no DST).
- **Tracked tab.** Channels you want to hear about without waiting to watch them. `yth track add
  @handle` (or a URL, or a `UC…` id), `yth track list`, `yth track remove`, `yth track refresh`.
  Discovery reads the channel's Atom feed, so it costs no API quota and works even when the OAuth
  token has expired. New uploads appear on the Tracked tab with the same Clear/Robert/George
  buttons; `Clear` there dismisses the notice only and never hides the video from History.
  `yth track subs` lists your subscriptions (this one does need a valid token).
- **Subscriptions tab.** Audit what you subscribe to and prune it. `yth subs sync` pulls the
  list (10 quota units for all 491), `yth subs list` ranks by least-recently-viewed,
  `yth subs quota` shows the day's spend. Unsubscribing is queued, not immediate: the daemon
  sends one a minute inside a 5,000-unit daily budget, and anything still queued can be
  cancelled. Requires a separate authorisation — `yth auth --write --from-env` — because
  `subscriptions.delete` needs a scope that also permits playlist and video edits; it is
  stored apart from the read-only token and used only by the unsubscribe worker.
- `yth terms --channel "X" --add Wrong=Right` fixes recurring caption errors for a channel; applied
  to the transcript before the model sees it. `yth verify <video_id>` checks an article's entities
  against its source. Sending is blocked if verification fails — `--force` overrides.
- **George** on a row summarises (if needed) and emails the summary from your own Gmail. Recipient
  is `email_to` in `~/.config/yth/config.json`; `yth email <video_id> [--to addr]` does the same
  from the CLI. Authorise sending once with `yth auth --gmail --from-env` (scope: `gmail.send`
  only — it can send mail and cannot read any).
- **Robert** on a row summarises its transcript (~4s, ~$0.0004) and shows the summary in place of
  the description. `yth summarise <video_id>` does the same from the CLI. Needs `yth serve` running
  and `OPENROUTER_API_KEY` in the environment.
- History tab toolbar: **Theme** (Match YouTube / Light / Dark) and **Thumbnails** (small / medium
  / large). Both persist, and the theme choice applies to the popup and stats pages too.
- `*` on a row means watched on more than one day within the report window.
- "Remove from history" on a card hides it everywhere, permanently. `yth hidden` lists what you
  removed; `yth hidden --unhide <video_id>` puts one back.
- The markdown report is window-scoped; `--json` carries lifetime totals too.
- **Shorts are never captured** — the extension only tracks `/watch` pages.
- Import is a merge over a full snapshot, so skipping a week is harmless; the next import backfills.
- After adding a field to the `/recent` payload, bump `PAYLOAD_SCHEMA` in `yth`. Clients notice the
  change and re-pull everything themselves; no manual `yth resync` needed.
- **After reloading the extension, refresh any open YouTube tabs.** A reload orphans content
  scripts in tabs that were already open, and they silently stop recording until refreshed.
- **Two Chrome profiles:** export from each and import both — they merge into one record (`PLAN.md` §10).
- **iPhone:** like anything you watch on the phone and `yth sync-likes` pulls it in — title,
  channel, duration and when you liked it, but no watch time. See `PLAN.md` §11.
- `first_seen` is pulled back to the earliest session evidence, so re-watches show a true span.
- **Token expiry.** Google expires refresh tokens after 7 days while the OAuth consent screen is
  in *Testing*, which silently kills `sync-likes`, the backfill and the subscriptions picker.
  `yth auth --from-env` fixes it — approve as the account that owns the YouTube channel, not
  just any Google account: one without a channel authorises fine and then returns nothing.
  Publishing the consent screen in the Cloud Console stops the 7-day clock.
