# Attribution and provenance

Short answer: **`yth` is yours outright. The browser extension is not — it's George Elliott's,
with a 12-line patch from us.** The two live in different places on disk and carry different
obligations.

## What is original work

Everything in this directory:

| File | Lines | Origin |
|---|---|---|
| `yth` | ~600 | Written from scratch. No upstream code |
| `PLAN.md`, `README.md`, `ATTRIBUTION.md` | ~250 | Original |
| `0001-capture-unplayed-videos-on-spa-nav.patch` | 12 added | Original code, 6 lines of upstream context |
| `0002-live-sync-via-local-daemon.patch` | ~197 added | Original: daemon bridge, merge-aware upsert, ★ badge, options UI |
| History row layout, thumbnail sizes, channel-name fix | ~220 added | Original; committed directly to the fork repo rather than as a patch file |

`yth` consumes a JSON *format*. It contains no copied source, links to no upstream library, and
depends only on the Python standard library. Reading a file format creates no derivative work —
the same way a CSV parser isn't derived from Excel. **You can license this however you like.**

## What is not original work

`extension/` is a **copy of someone else's project** — 3,770 lines of JavaScript from:

> **[GeorgeElliott/yt-watch-history](https://github.com/GeorgeElliott/yt-watch-history)**
> Copyright (c) 2026 George Elliott — MIT License

We copied `src/` verbatim and applied two patches — a 12-line bugfix and a ~200-line sync feature
across five files. Its `LICENSE` file is retained in the copy, which
is the MIT obligation. **Don't describe the extension as your own work.** The honest framing is:

> "A personal YouTube history report built on top of GeorgeElliott/yt-watch-history (MIT), with a
> patch to capture videos opened but never played."

If you publish, the clean path is to **fork on GitHub** rather than ship a copied folder, so the
provenance is visible in the repo graph, and to **open a PR** with the patch — it fixes a real
upstream bug (in-app navigation loses records).

## Repos consulted, and what came from each

| Repo | License | What we took |
|---|---|---|
| [GeorgeElliott/yt-watch-history](https://github.com/GeorgeElliott/yt-watch-history) | MIT | **The collector itself.** Copied and patched. The IndexedDB schema (`videos` / `watchSessions` / `watchEvents`) and export format are what `yth` reads |
| [lynicis/dont-let-youtube-track-you](https://github.com/lynicis/dont-let-youtube-track-you) | MIT | **Nothing.** Evaluated and rejected — solves cross-device sync we didn't need, and its store listing carries `supabase.co` and Lemon Squeezy permissions |
| [sniklaus/youtube-watchmarker](https://github.com/sniklaus/youtube-watchmarker) | **GPL-3.0** | **Nothing — deliberately.** Read for context only. Copying any of it would force the whole project to GPL |
| [mevfiew/youtube-view-history](https://github.com/mevfiew/youtube-view-history) | MIT | **Nothing.** Records videos *seen* in feeds, not videos watched |

The last three were assessed and not used. They're listed because they informed the design
decision, not because any code came from them.

## The fork is version-controlled — patches are historical

`extension/` is the **authoritative copy**. It was developed as its own git repository and its
history is preserved here via `git subtree`, so the vendor commit — upstream 1.2.2 verbatim — is
still the first commit that touches those files and every local change is visible as a diff
against it. The `patches/000N-*.patch` files are a historical record of intent, not a maintained
build input.

Why the change: upstream moved between clones, and `0002` no longer applies cleanly to today's
`GeorgeElliott/yt-watch-history`. The drift is small — a handful of context lines, no features
missing from the fork — but hand-maintained patch files against a moving upstream give a false
sense of reproducibility. Version-controlling the fork is honest about what it is: a vendored copy
with local changes.

To see exactly what diverges from upstream, clone upstream and diff `src/` against the fork.

## Licence obligations, concretely

- **MIT (`yt-watch-history`)**: keep `LICENSE` and the copyright notice with any copy you
  distribute. `extension/LICENSE` carries George Elliott's notice; the repository-root `LICENSE`
  covers the original work. No obligation at all for private personal use.
- **GPL-3.0 (`youtube-watchmarker`)**: no obligation, because we took nothing. Keep it that way —
  pasting even a function from it would relicense your project.
- **`yth`**: no third-party obligations.
