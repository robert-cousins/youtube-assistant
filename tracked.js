/**
 * Tracked tab.
 *
 * Deliberately does NOT go through IndexedDB or the History sync bridge. A
 * notice list is only useful if it is current, and the daemon already holds the
 * authoritative copy, so this page reads /tracked directly on every load. That
 * also keeps the two surfaces independent: History's payload schema, cursor and
 * merge rules can change without touching this file, and the button handlers
 * here can diverge from History's whenever the workflow needs them to.
 */

const YTH_DEFAULT_URL = 'http://127.0.0.1:8742';

const container    = document.getElementById('tracked-container');
const searchInput  = document.getElementById('search-input');
const sortSelect   = document.getElementById('sort-select');
const clearedToggle = document.getElementById('show-cleared-toggle');
const loadMoreBtn  = document.getElementById('load-more-btn');
const statNew      = document.getElementById('stat-new');
const statChannels = document.getElementById('stat-channels');
const statChecked  = document.getElementById('stat-checked');
const refreshBtn   = document.getElementById('refresh-btn');

let allItems     = [];
let allChannels  = [];
let filtered     = [];
let currentIndex = 0;
let showCleared  = false;
const PAGE_SIZE  = 24;

const showToast = (message) => {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2600);
};

const ythConfig = () => new Promise((resolve) => {
  chrome.storage.local.get({ ythUrl: YTH_DEFAULT_URL, ythToken: '' }, resolve);
});

const ythCall = (path, options = {}) => ythConfig().then((cfg) => {
  if (!cfg.ythToken) {
    return Promise.reject(new Error('No daemon token set - see the Options tab'));
  }
  return fetch(cfg.ythUrl + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-YTH-Token': cfg.ythToken,
      ...(options.headers || {})
    }
  }).then((r) => {
    if (!r.ok) throw new Error(`daemon returned ${r.status}`);
    return r.json();
  });
});

const formatDuration = (seconds) => {
  const total = Math.max(0, Math.round(seconds || 0));
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};

// Relative age is the thing you actually scan for in a notice list; the exact
// timestamp goes on the tooltip.
const formatAge = (iso) => {
  const ms = Date.parse(iso || '');
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
};

const formatChecked = (ms) => (ms
  ? `Checked ${formatAge(new Date(ms).toISOString())}`
  : 'Never checked');


//  Rendering 

const applyFilters = () => {
  const query = searchInput.value.toLowerCase().trim();
  const sort = sortSelect.value;

  filtered = allItems.filter((v) => {
    if (v.cleared && !showCleared) return false;
    if (query) {
      return v.title.toLowerCase().includes(query) ||
        (v.channel && v.channel.toLowerCase().includes(query));
    }
    return true;
  });

  const byPublished = (a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
  if (sort === 'oldest') {
    filtered.sort((a, b) => -byPublished(a, b));
  } else if (sort === 'channel') {
    filtered.sort((a, b) => (a.channel || '').localeCompare(b.channel || '') || byPublished(a, b));
  } else {
    filtered.sort(byPublished);
  }

  currentIndex = 0;
  container.replaceChildren();
  renderBatch();
};

const renderEmpty = () => {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.style.gridColumn = '1 / -1';
  const icon = document.createElement('div');
  icon.className = 'empty-icon';
  icon.textContent = '📡';
  const text = document.createElement('div');
  text.className = 'empty-text';
  const sub = document.createElement('div');
  sub.className = 'empty-sub';
  if (searchInput.value) {
    text.textContent = 'No matching videos';
    sub.textContent = 'Try a different search term';
  } else if (!allChannels.length) {
    text.textContent = 'No channels tracked yet';
    sub.textContent = 'Use "Manage channels" above to add one';
  } else {
    text.textContent = 'Nothing new';
    sub.textContent = 'Everything from your tracked channels has been cleared';
  }
  empty.append(icon, text, sub);
  container.replaceChildren(empty);
  loadMoreBtn.classList.add('hidden');
};

// Per-surface state, on purpose. Clear here writes tracked_items.cleared_at,
// never videos.hidden -- dismissing a notice must not hide the video from
// History, because watching it afterwards is the whole point.
const clearItem = (item, undo) => {
  ythCall('/tracked-clear', {
    method: 'POST',
    body: JSON.stringify({ videoId: item.videoId, undo: !!undo })
  }).then(() => {
    item.cleared = !undo;
    showToast(undo ? 'Restored' : 'Cleared');
    applyFilters();
  }).catch((err) => showToast(`Clear failed: ${err.message}`));
};

const makePill = (label, className, onClick) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className ? `pill-btn ${className}` : 'pill-btn';
  btn.textContent = label;
  if (onClick) {
    btn.onclick = onClick;
  } else {
    btn.disabled = true;
    btn.title = `${label} - not wired up yet`;
  }
  return btn;
};

// Robert and George call the same daemon endpoints History does, but through
// their own handlers here. Same behaviour today, independently changeable.
const wireRobert = (item, descEl) => {
  const btn = makePill('Robert', 'is-robert', null);
  if (item.summaryState === 'no_transcript') {
    btn.disabled = true;
    btn.title = 'No transcript available for this video';
    return btn;
  }
  btn.disabled = false;
  btn.title = item.summary ? 'Re-summarise the transcript' : 'Summarise the transcript';
  btn.onclick = () => {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-working');
    btn.textContent = '...';
    descEl.classList.add('is-working');
    ythCall('/summarize', {
      method: 'POST',
      body: JSON.stringify({ videoId: item.videoId })
    }).then((result) => {
      if (result.state === 'no_transcript') {
        showToast('No transcript available for this video');
      } else if (result.state !== 'ok') {
        showToast(`Summary failed: ${result.error || 'unknown error'}`);
      }
      return load({ quiet: true });
    }).catch((err) => {
      showToast(`Summary failed: ${err.message}`);
      btn.classList.remove('is-working');
      btn.textContent = label;
      btn.disabled = false;
      descEl.classList.remove('is-working');
    });
  };
  return btn;
};

const wireGeorge = (item) => {
  const btn = makePill('George', 'is-george', null);
  if (item.emailedAt) {
    // Shared with History on purpose: "sent" is a fact about the video, not
    // about the surface the button was clicked on.
    btn.disabled = true;
    btn.textContent = 'Sent';
    btn.classList.add('is-sent');
    btn.title = `Emailed to ${item.emailedTo || 'recipient'} on `
      + new Date(item.emailedAt).toLocaleString();
    return btn;
  }
  if (item.summaryState === 'no_transcript') {
    btn.disabled = true;
    btn.title = 'No transcript available for this video';
    return btn;
  }
  btn.disabled = false;
  btn.title = item.summary ? 'Email the existing summary' : 'Summarise, then email the summary';
  btn.onclick = () => {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-working');
    btn.textContent = '...';
    ythCall('/email-summary', {
      method: 'POST',
      body: JSON.stringify({ videoId: item.videoId })
    }).then((result) => {
      btn.classList.remove('is-working');
      if (result.state === 'sent' || result.state === 'already_sent') {
        btn.textContent = 'Sent';
        btn.classList.add('is-sent');
        btn.disabled = true;
        showToast(result.state === 'sent'
          ? `Emailed to ${String(result.detail).split(' ')[0]}`
          : `Already emailed to ${result.detail}`);
        return load({ quiet: true });
      }
      btn.textContent = label;
      btn.disabled = false;
      showToast(`Email failed: ${result.error || 'unknown error'}`);
    }).catch((err) => {
      btn.classList.remove('is-working');
      btn.textContent = label;
      btn.disabled = false;
      showToast(`Email failed: ${err.message}`);
    });
  };
  return btn;
};

const renderBatch = () => {
  const batch = filtered.slice(currentIndex, currentIndex + PAGE_SIZE);
  if (currentIndex === 0 && batch.length === 0) return renderEmpty();

  batch.forEach((item) => {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
    const card = document.createElement('div');
    card.className = 'video-card';
    if (item.cleared) card.style.opacity = '0.5';

    const thumbLink = document.createElement('a');
    thumbLink.href = url;
    thumbLink.target = '_blank';
    thumbLink.rel = 'noopener noreferrer';
    thumbLink.className = 'thumb-link';
    const thumbImg = document.createElement('img');
    thumbImg.src = `https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg`;
    thumbImg.className = 'thumb-img';
    thumbImg.alt = '';
    thumbLink.appendChild(thumbImg);

    const body = document.createElement('div');
    body.className = 'card-body';
    const titleLink = document.createElement('a');
    titleLink.href = url;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';
    titleLink.className = 'card-title';
    titleLink.textContent = item.title;
    body.appendChild(titleLink);
    if (item.channel) {
      const channelLink = document.createElement('a');
      channelLink.href = item.channelUrl || '#';
      channelLink.target = '_blank';
      channelLink.rel = 'noopener noreferrer';
      channelLink.className = 'card-channel';
      channelLink.textContent = item.channel;
      body.appendChild(channelLink);
    }
    const metaDiv = document.createElement('div');
    metaDiv.className = 'card-meta';
    metaDiv.textContent = formatAge(item.publishedAt);
    if (item.publishedAt) metaDiv.title = new Date(item.publishedAt).toLocaleString();
    body.appendChild(metaDiv);

    const descWrap = document.createElement('div');
    descWrap.className = 'card-desc-wrap';
    const descEl = document.createElement('div');
    descEl.className = 'card-description';
    if (item.summary) {
      descEl.classList.add('is-summary');
      descEl.textContent = item.summary;
      descEl.title = item.description || item.summary;
    } else if (item.summaryState === 'no_transcript') {
      descEl.classList.add('is-empty');
      descEl.textContent = item.description || 'No transcript available';
    } else if (item.description) {
      descEl.textContent = item.description;
      descEl.title = item.description;
    } else {
      descEl.classList.add('is-empty');
      descEl.textContent = 'No description';
    }
    descWrap.appendChild(descEl);
    if (item.summary && item.summaryMeta) {
      const metaEl = document.createElement('div');
      metaEl.className = 'summary-meta';
      metaEl.textContent = item.summaryMeta;
      descWrap.appendChild(metaEl);
    }

    const tools = document.createElement('div');
    tools.className = 'card-tools';
    tools.appendChild(item.cleared
      ? makePill('Restore', 'is-clear', () => clearItem(item, true))
      : makePill('Clear', 'is-clear', () => clearItem(item, false)));
    tools.appendChild(wireRobert(item, descEl));
    tools.appendChild(wireGeorge(item));

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    if (item.watchCount) {
      const seen = document.createElement('span');
      seen.className = 'card-meta';
      seen.textContent = '✓ Watched';
      seen.title = 'Already in your History';
      actions.appendChild(seen);
    }
    const durEl = document.createElement('span');
    durEl.className = 'card-meta';
    durEl.textContent = formatDuration(item.duration);
    actions.appendChild(durEl);

    card.append(thumbLink, tools, body, descWrap, actions);
    container.appendChild(card);
  });

  currentIndex += PAGE_SIZE;
  loadMoreBtn.classList.toggle('hidden', currentIndex >= filtered.length);
};


//  Channel manager 

const renderChannels = () => {
  const chips = document.getElementById('channel-chips');
  chips.replaceChildren();
  if (!allChannels.length) {
    const hint = document.createElement('span');
    hint.className = 'card-meta';
    hint.textContent = 'No channels tracked yet.';
    chips.appendChild(hint);
  }
  allChannels.forEach((ch) => {
    const chip = document.createElement('span');
    chip.className = ch.lastError ? 'channel-chip has-error' : 'channel-chip';
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = ch.title;
    name.title = ch.lastError
      ? `Last check failed: ${ch.lastError}`
      : `${ch.handle || ch.channelId} - ${formatChecked(ch.lastChecked).toLowerCase()}`;
    const count = document.createElement('span');
    count.className = 'chip-count';
    count.textContent = ch.pending ? String(ch.pending) : '';
    const remove = document.createElement('button');
    remove.className = 'chip-remove';
    remove.textContent = '×';
    remove.title = 'Stop tracking this channel';
    remove.onclick = () => {
      ythCall('/tracked-remove', {
        method: 'POST',
        body: JSON.stringify({ channelId: ch.channelId })
      }).then(() => {
        showToast(`Stopped tracking ${ch.title}`);
        load();
      }).catch((err) => showToast(`Failed: ${err.message}`));
    };
    chip.append(name, count, remove);
    chips.appendChild(chip);
  });

  const summary = document.getElementById('channel-summary');
  const failing = allChannels.filter((c) => c.lastError).length;
  summary.textContent = failing ? `${failing} channel(s) failing to check` : '';
};

const addChannel = (spec) => {
  if (!spec) return;
  const btn = document.getElementById('channel-add-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '...';
  ythCall('/tracked-add', { method: 'POST', body: JSON.stringify({ channel: spec }) })
    .then((result) => {
      btn.disabled = false;
      btn.textContent = label;
      if (result.error) return showToast(`Could not track: ${result.error}`);
      document.getElementById('channel-input').value = '';
      showToast(result.added.existing
        ? `Already tracking ${result.added.title}`
        : `Now tracking ${result.added.title || result.added.channelId}`);
      load();
    })
    .catch((err) => {
      btn.disabled = false;
      btn.textContent = label;
      showToast(`Could not track: ${err.message}`);
    });
};

let subsCache = null;

const renderSubs = (filter) => {
  const list = document.getElementById('subs-list');
  list.replaceChildren();
  const tracked = new Set(allChannels.map((c) => c.channelId));
  const q = (filter || '').toLowerCase().trim();
  const rows = (subsCache || []).filter((s) => !q || s.title.toLowerCase().includes(q));
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'card-meta';
    none.textContent = 'No matching subscriptions';
    list.appendChild(none);
    return;
  }
  rows.slice(0, 300).forEach((s) => {
    const row = document.createElement('div');
    row.className = 'subs-row';
    const name = document.createElement('span');
    name.className = 'subs-name';
    name.textContent = s.title;
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    if (tracked.has(s.channelId)) {
      btn.textContent = 'Tracked';
      btn.disabled = true;
    } else {
      btn.textContent = 'Track';
      btn.onclick = () => {
        btn.disabled = true;
        btn.textContent = '...';
        ythCall('/tracked-add', {
          method: 'POST',
          body: JSON.stringify({ channel: s.channelId })
        }).then((result) => {
          if (result.error) {
            btn.disabled = false;
            btn.textContent = 'Track';
            return showToast(`Could not track: ${result.error}`);
          }
          btn.textContent = 'Tracked';
          showToast(`Now tracking ${s.title}`);
          load({ keepSubs: true });
        }).catch((err) => {
          btn.disabled = false;
          btn.textContent = 'Track';
          showToast(`Could not track: ${err.message}`);
        });
      };
    }
    row.append(name, btn);
    list.appendChild(row);
  });
  if (rows.length > 300) {
    const more = document.createElement('div');
    more.className = 'card-meta';
    more.textContent = `…and ${rows.length - 300} more. Type to filter.`;
    list.appendChild(more);
  }
};

const openSubs = () => {
  const panel = document.getElementById('subs-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  if (subsCache) return renderSubs(document.getElementById('subs-filter').value);
  const list = document.getElementById('subs-list');
  list.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'card-meta';
  loading.textContent = 'Loading subscriptions…';
  list.appendChild(loading);
  ythCall('/subscriptions').then((result) => {
    if (result.error) {
      // The only part of Tracked that needs OAuth. Say so plainly rather than
      // failing silently: feed polling and the other two add paths still work.
      loading.textContent = `Subscriptions unavailable: ${result.error}`
        + ' — run `yth auth --from-env` to reauthorise. You can still add'
        + ' channels by URL.';
      return;
    }
    subsCache = result.subscriptions || [];
    renderSubs('');
  }).catch((err) => {
    loading.textContent = `Subscriptions unavailable: ${err.message}`;
  });
};


//  Loading 

// `keepSubs` is accepted so callers inside the subscriptions panel read as
// intentional; the cache is never invalidated here, only by a page reload.
// Pages on the cursor the payload returns. The server caps a response, and a
// silent truncation in a notice list is worse than a second round trip.
const loadPage = (since, acc) => ythCall(`/tracked?since=${since}`).then((data) => {
  const items = acc.concat(data.videos || []);
  if (data.more && data.cursor > since) return loadPage(data.cursor, items);
  return { videos: items, channels: data.channels || [] };
});

const load = ({ quiet = false } = {}) => {
  return loadPage(0, []).then((data) => {
    allItems = data.videos || [];
    allChannels = data.channels || [];
    statNew.textContent = allItems.filter((v) => !v.cleared).length.toLocaleString();
    statChannels.textContent = allChannels.length.toLocaleString();
    const newest = allChannels.reduce((m, c) => Math.max(m, c.lastChecked || 0), 0);
    statChecked.textContent = formatChecked(newest);
    renderChannels();
    applyFilters();
  }).catch((err) => {
    if (!quiet) {
      container.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const icon = document.createElement('div');
      icon.className = 'empty-icon';
      icon.textContent = '⚠';
      const text = document.createElement('div');
      text.className = 'empty-text';
      text.textContent = 'Cannot reach the sync daemon';
      const sub = document.createElement('div');
      sub.className = 'empty-sub';
      sub.textContent = `${err.message}. Tracked reads live from the daemon, so`
        + ' there is nothing cached to show. Start `yth serve` and refresh.';
      empty.append(icon, text, sub);
      container.appendChild(empty);
    }
  });
};

// Refresh polls every tracked feed server-side, which takes a second or two per
// channel, so it never blocks the render: the list is drawn from what we have,
// the button reports progress, and the list reloads when the poll returns.
const doRefresh = ({ force = true } = {}) => {
  const label = 'Refresh';
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Checking…';
  return ythCall('/tracked-refresh', {
    method: 'POST',
    body: JSON.stringify({ force })
  })
    .then((result) => {
      refreshBtn.disabled = false;
      refreshBtn.textContent = label;
      // Opening the tab checks only stale channels and says nothing unless it
      // actually found something; pressing Refresh always reports back.
      if (force || result.new) {
        showToast(result.busy
          ? 'A check is already running - the list will update shortly'
          : result.new
            ? `${result.new} new video(s) from ${result.checked} channel(s)`
            : `Up to date (${result.checked} channel(s) checked)`);
      }
      return result.new || force ? load({ quiet: true }) : null;
    })
    .catch((err) => {
      refreshBtn.disabled = false;
      refreshBtn.textContent = label;
      if (force) showToast(`Refresh failed: ${err.message}`);
    });
};


//  Controls 

const THUMB_SIZES = ['small', 'medium', 'large'];

const applyThumbSize = (size) => {
  const chosen = THUMB_SIZES.includes(size) ? size : 'medium';
  THUMB_SIZES.forEach((s) => container.classList.toggle(`thumb-${s}`, s === chosen));
  const select = document.getElementById('thumb-size-select');
  if (select && select.value !== chosen) select.value = chosen;
};

chrome.storage.local.get({ thumbSize: 'medium' }, ({ thumbSize }) => {
  applyThumbSize(thumbSize);
  const select = document.getElementById('thumb-size-select');
  if (select) {
    select.onchange = () => {
      applyThumbSize(select.value);
      chrome.storage.local.set({ thumbSize: select.value });
    };
  }
});

const resolveTheme = ({ themeMode, youtubeTheme }) => {
  if (themeMode === 'light' || themeMode === 'dark') return themeMode;
  return youtubeTheme || '';
};

const applyStoredTheme = () => {
  chrome.storage.local.get({ youtubeTheme: '', themeMode: 'auto' }, (data) => {
    const theme = resolveTheme(data);
    if (theme) {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
    const select = document.getElementById('theme-select');
    if (select) select.value = data.themeMode || 'auto';
  });
};
applyStoredTheme();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.youtubeTheme || changes.themeMode)) {
    applyStoredTheme();
  }
});

loadMoreBtn.onclick = renderBatch;

let searchTimeout;
searchInput.oninput = () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(applyFilters, 300);
};

sortSelect.onchange = applyFilters;

clearedToggle.onchange = () => {
  showCleared = clearedToggle.checked;
  applyFilters();
};

refreshBtn.onclick = () => doRefresh({ force: true });

document.getElementById('channel-toggle').onclick = () => {
  document.getElementById('channel-bar').classList.toggle('collapsed');
};

document.getElementById('channel-add-btn').onclick = () =>
  addChannel(document.getElementById('channel-input').value.trim());

document.getElementById('channel-input').onkeydown = (e) => {
  if (e.key === 'Enter') addChannel(e.target.value.trim());
};

document.getElementById('subs-btn').onclick = openSubs;

let subsFilterTimeout;
document.getElementById('subs-filter').oninput = (e) => {
  clearTimeout(subsFilterTimeout);
  subsFilterTimeout = setTimeout(() => renderSubs(e.target.value), 200);
};

document.getElementById('theme-select').onchange = (e) => {
  chrome.storage.local.set({ themeMode: e.target.value });
  applyStoredTheme();
};

// A visit is itself a request for current data, so poll on open rather than
// showing whatever the last background cycle happened to leave behind -- but
// only for channels nothing has checked lately. Pressing Refresh checks all.
load().then(() => doRefresh({ force: false }));
