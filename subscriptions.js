/**
 * Subscriptions tab.
 *
 * Reads /subs live from the daemon, like Tracked and for the same reason: the
 * daemon holds the authoritative list and the engagement figures, and a stale
 * copy of "have I watched this channel lately" is worse than none.
 *
 * The Unsub pill never unsubscribes. It queues, and the daemon drains the queue
 * one channel a minute inside a daily quota budget. That is what makes it safe
 * to select a lot at once: nothing irreversible happens for at least a minute,
 * and everything still queued can be cancelled.
 */

const YTH_DEFAULT_URL = 'http://127.0.0.1:8742';

const container   = document.getElementById('subs-container');
const searchInput = document.getElementById('search-input');
const sortSelect  = document.getElementById('sort-select');
const filterSelect = document.getElementById('filter-select');
const loadMoreBtn = document.getElementById('load-more-btn');
const syncBtn     = document.getElementById('sync-btn');
const queueBar    = document.getElementById('queue-bar');
const statShown   = document.getElementById('stat-shown');
const statTotal   = document.getElementById('stat-total');
const statNever   = document.getElementById('stat-never');
const statDormant = document.getElementById('stat-dormant');
const statQuota   = document.getElementById('stat-quota');

let allSubs = [];
let filtered = [];
let budget = null;
let currentIndex = 0;
const PAGE_SIZE = 30;
const YEAR_MS = 365 * 86400000;

const showToast = (message) => {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
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

const ageFrom = (ms) => {
  if (!ms) return '';
  const days = Math.round((Date.now() - ms) / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${months}mo ago`;
  return `${(days / 365.25).toFixed(1)}y ago`;
};

const uploadMs = (s) => (s.lastUploadAt ? Date.parse(s.lastUploadAt) || 0 : 0);
const isDormant = (s) => {
  const ms = uploadMs(s);
  return ms > 0 && Date.now() - ms > YEAR_MS;
};


//  Actions 

const setQueued = (sub, queued) => ythCall('/subs-queue', {
  method: 'POST',
  body: JSON.stringify({ channelIds: [sub.channelId], cancel: !queued })
}).then((result) => {
  if (result.error) throw new Error(result.error);
  applyPayload(result, { keepPosition: true });
  const warn = (result.warnings || []).find((w) => w.channelId === sub.channelId);
  showToast(queued
    ? (warn
      ? `${sub.title} queued — note: ${warn.why}. Undo on the row, or Cancel all.`
      : `${sub.title} queued — cancel any time before it runs`)
    : `${sub.title} taken off the queue`);
}).catch((err) => showToast(`Failed: ${err.message}`));

const trackChannel = (sub, btn) => {
  const label = btn.textContent;
  btn.disabled = true;
  btn.classList.add('is-working');
  btn.textContent = '...';
  ythCall('/tracked-add', {
    method: 'POST',
    body: JSON.stringify({ channel: sub.channelId })
  }).then((result) => {
    btn.classList.remove('is-working');
    if (result.error) {
      btn.textContent = label;
      btn.disabled = false;
      return showToast(`Could not track: ${result.error}`);
    }
    btn.textContent = 'Tracked';
    btn.classList.add('is-sent');
    sub.tracked = true;
    showToast(`Now tracking ${sub.title}`);
  }).catch((err) => {
    btn.classList.remove('is-working');
    btn.textContent = label;
    btn.disabled = false;
    showToast(`Could not track: ${err.message}`);
  });
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
  }
  return btn;
};


//  Rendering 

const applyFilters = () => {
  const query = searchInput.value.toLowerCase().trim();
  const mode = filterSelect.value;
  const sort = sortSelect.value;

  filtered = allSubs.filter((s) => {
    if (mode === 'never' && s.lastViewedKind !== 'never') return false;
    if (mode === 'dormant' && !isDormant(s)) return false;
    if (mode === 'queued' && s.unsubState !== 'queued') return false;
    if (mode === 'tracked' && !s.tracked) return false;
    if (query) {
      return s.title.toLowerCase().includes(query) ||
        (s.description && s.description.toLowerCase().includes(query));
    }
    return true;
  });

  const cmp = {
    // Never-viewed sorts first, which is the point of the default view. They
    // all tie at 0, so break the tie on upload age: the best pruning
    // candidates -- never viewed AND long dormant -- surface together instead
    // of being scattered alphabetically through 282 rows.
    viewed: (a, b) => (a.lastViewed || 0) - (b.lastViewed || 0)
      || (uploadMs(a) || Infinity) - (uploadMs(b) || Infinity),
    // Unknown upload dates sort last, not first: "we have not checked yet" is
    // not evidence of dormancy and must not masquerade as it.
    upload: (a, b) => (uploadMs(a) || Infinity) - (uploadMs(b) || Infinity),
    subscribed: (a, b) => (Date.parse(a.subscribedAt) || 0) - (Date.parse(b.subscribedAt) || 0),
    likes: (a, b) => b.likes - a.likes,
    title: (a, b) => a.title.localeCompare(b.title)
  }[sort];
  filtered.sort(cmp);

  statShown.textContent = filtered.length.toLocaleString();
  currentIndex = 0;
  container.replaceChildren();
  renderBatch();
};

const renderBatch = () => {
  const batch = filtered.slice(currentIndex, currentIndex + PAGE_SIZE);

  if (currentIndex === 0 && batch.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '📻';
    const text = document.createElement('div');
    text.className = 'empty-text';
    text.textContent = allSubs.length ? 'Nothing matches' : 'No subscriptions synced yet';
    const sub = document.createElement('div');
    sub.className = 'empty-sub';
    sub.textContent = allSubs.length
      ? 'Try a different filter or search term'
      : 'Press "Sync from YouTube" to pull your subscription list';
    empty.append(icon, text, sub);
    container.replaceChildren(empty);
    loadMoreBtn.classList.add('hidden');
    return;
  }

  batch.forEach((sub) => {
    const url = `https://www.youtube.com/channel/${encodeURIComponent(sub.channelId)}`;
    const card = document.createElement('div');
    card.className = 'video-card';
    if (sub.unsubState === 'queued') card.style.opacity = '0.6';

    const thumbLink = document.createElement('a');
    thumbLink.href = url;
    thumbLink.target = '_blank';
    thumbLink.rel = 'noopener noreferrer';
    thumbLink.className = 'thumb-link';
    const img = document.createElement('img');
    img.src = sub.thumbnail || '';
    img.className = 'thumb-img';
    img.alt = '';
    thumbLink.appendChild(img);

    const tools = document.createElement('div');
    tools.className = 'card-tools';
    if (sub.unsubState === 'queued') {
      tools.appendChild(makePill('Undo', 'is-clear', () => setQueued(sub, false)));
    } else if (sub.unsubState === 'done') {
      const done = makePill('Removed', 'is-sent', null);
      done.title = 'Unsubscribed by yth';
      tools.appendChild(done);
    } else if (sub.unsubState === 'failed') {
      const failed = makePill('Retry', 'is-clear', () => setQueued(sub, true));
      failed.title = `Last attempt failed: ${sub.unsubError}`;
      tools.appendChild(failed);
    } else {
      const unsub = makePill('Unsub', 'is-clear', () => setQueued(sub, true));
      unsub.title = 'Queue an unsubscribe. Runs later, and can be cancelled until it does.';
      tools.appendChild(unsub);
    }
    if (sub.tracked) {
      const t = makePill('Tracked', 'is-track', null);
      t.classList.add('is-sent');
      t.title = 'Already on the Tracked tab';
      tools.appendChild(t);
    } else {
      const t = makePill('Track', 'is-track', null);
      t.disabled = false;
      t.title = 'Watch this channel for new uploads';
      t.onclick = () => trackChannel(sub, t);
      tools.appendChild(t);
    }

    const body = document.createElement('div');
    body.className = 'card-body';
    const titleLink = document.createElement('a');
    titleLink.href = url;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';
    titleLink.className = 'card-title';
    titleLink.textContent = sub.title;
    body.appendChild(titleLink);

    const viewed = document.createElement('div');
    viewed.className = 'card-meta';
    if (sub.lastViewedKind === 'never') {
      viewed.classList.add('sub-never');
      viewed.textContent = 'Never viewed';
      viewed.title = 'No liked video and no recorded watch from this channel';
    } else {
      viewed.textContent = `${sub.lastViewedKind === 'watched' ? 'Watched' : 'Liked'}`
        + ` ${ageFrom(sub.lastViewed)}`;
      viewed.title = new Date(sub.lastViewed).toLocaleString();
    }
    body.appendChild(viewed);

    const since = document.createElement('div');
    since.className = 'card-meta';
    since.textContent = sub.subscribedAt
      ? `Subscribed ${ageFrom(Date.parse(sub.subscribedAt))}` : '';
    body.appendChild(since);

    const descWrap = document.createElement('div');
    descWrap.className = 'card-desc-wrap';
    const descEl = document.createElement('div');
    descEl.className = 'card-description';
    if (sub.description) {
      descEl.textContent = sub.description;
      descEl.title = sub.description;
    } else {
      descEl.classList.add('is-empty');
      descEl.textContent = 'No channel description';
    }
    descWrap.appendChild(descEl);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const facts = document.createElement('div');
    facts.className = 'sub-facts';

    const upload = document.createElement('span');
    upload.className = 'card-meta';
    if (!sub.lastUploadAt) {
      upload.textContent = sub.activityError ? 'Feed unreachable' : 'Checking…';
      upload.title = sub.activityError
        || 'Upload activity is checked in the background, a few channels a minute';
    } else if (isDormant(sub)) {
      upload.classList.add('sub-dormant');
      upload.textContent = `Last post ${ageFrom(uploadMs(sub))}`;
      upload.title = new Date(sub.lastUploadAt).toLocaleString();
    } else {
      upload.textContent = `Posted ${ageFrom(uploadMs(sub))}`;
      upload.title = new Date(sub.lastUploadAt).toLocaleString();
    }
    facts.appendChild(upload);

    const engagement = document.createElement('span');
    engagement.className = 'card-meta';
    engagement.textContent = sub.likes
      ? `${sub.likes} liked` : (sub.videos ? `${sub.videos} in record` : '');
    facts.appendChild(engagement);

    if (sub.unsubState === 'queued') {
      const q = document.createElement('span');
      q.className = 'card-meta sub-queued';
      q.textContent = 'Queued';
      facts.appendChild(q);
    }

    actions.appendChild(facts);
    card.append(thumbLink, tools, body, descWrap, actions);
    container.appendChild(card);
  });

  currentIndex += PAGE_SIZE;
  loadMoreBtn.classList.toggle('hidden', currentIndex >= filtered.length);
};

const renderQueue = () => {
  const queued = allSubs.filter((s) => s.unsubState === 'queued').length;
  queueBar.classList.toggle('is-idle', !queued);
  document.getElementById('queue-count').textContent = queued;
  const rate = document.getElementById('queue-rate');
  if (!budget) {
    rate.textContent = '';
  } else if (budget.unsubsLeft <= 0) {
    rate.className = 'budget-warn';
    rate.textContent = `Daily budget reached (${budget.used}/${budget.budget} units)`
      + ' — the queue resumes after midnight US Pacific.';
  } else {
    rate.className = '';
    const today = Math.min(queued, budget.unsubsLeft);
    rate.textContent = `One a minute; ${budget.unsubsLeft} more allowed today`
      + (queued > budget.unsubsLeft
        ? ` — ${today} today, the rest tomorrow.` : '.');
  }
};

const renderStats = () => {
  statTotal.textContent = allSubs.filter((s) => s.present).length.toLocaleString();
  statNever.textContent = allSubs.filter((s) => s.lastViewedKind === 'never').length.toLocaleString();
  const dormant = allSubs.filter(isDormant).length;
  const unchecked = allSubs.filter((s) => !s.lastUploadAt && !s.activityError).length;
  statDormant.textContent = dormant.toLocaleString();
  statDormant.title = unchecked
    ? `${unchecked} channel(s) not yet checked for upload activity`
    : 'All channels checked';
  statQuota.textContent = budget
    ? `Quota: ${budget.used}/${budget.budget} units today` : '';
};

const applyPayload = (data, { keepPosition = false } = {}) => {
  if (data.subscriptions) allSubs = data.subscriptions;
  if (data.budget) budget = data.budget;
  renderStats();
  renderQueue();
  // A background reload must not throw you back to row 30 while you are
  // triaging row 200. Re-render as many pages as were already open.
  const pages = keepPosition ? Math.max(1, Math.ceil(currentIndex / PAGE_SIZE)) : 1;
  applyFilters();
  for (let i = 1; i < pages && currentIndex < filtered.length; i += 1) renderBatch();
};

const load = ({ keepPosition = false } = {}) => ythCall('/subs')
  .then((data) => applyPayload(data, { keepPosition }))
  .catch((err) => {
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
    sub.textContent = `${err.message}. Start \`yth serve\` and refresh.`;
    empty.append(icon, text, sub);
    container.appendChild(empty);
  });


//  Controls 

syncBtn.onclick = () => {
  const label = syncBtn.textContent;
  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing…';
  ythCall('/subs-sync', { method: 'POST', body: '{}' })
    .then((result) => {
      syncBtn.disabled = false;
      syncBtn.textContent = label;
      if (result.error) return showToast(`Sync failed: ${result.error}`);
      if (result.busy) return showToast('A sync is already running');
      applyPayload(result);
      showToast(`${result.synced} subscriptions synced`);
    })
    .catch((err) => {
      syncBtn.disabled = false;
      syncBtn.textContent = label;
      showToast(`Sync failed: ${err.message}`);
    });
};

document.getElementById('cancel-all-btn').onclick = () => {
  const queued = allSubs.filter((s) => s.unsubState === 'queued').length;
  if (!queued) return;
  if (!confirm(`Take all ${queued} queued channel(s) off the unsubscribe queue?`)) return;
  ythCall('/subs-cancel-all', { method: 'POST', body: '{}' })
    .then((result) => {
      applyPayload(result);
      showToast(`${result.changed} taken off the queue`);
    })
    .catch((err) => showToast(`Failed: ${err.message}`));
};

loadMoreBtn.onclick = renderBatch;

let searchTimeout;
searchInput.oninput = () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(applyFilters, 250);
};

sortSelect.onchange = applyFilters;
filterSelect.onchange = applyFilters;

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
  if (area === 'local' && (changes.youtubeTheme || changes.themeMode)) applyStoredTheme();
});

document.getElementById('theme-select').onchange = (e) => {
  chrome.storage.local.set({ themeMode: e.target.value });
  applyStoredTheme();
};

// Upload activity fills in a few channels a minute in the background, and the
// queue drains at the same rate, so a page left open refreshes itself.
load();
setInterval(() => load({ keepPosition: true }), 60000);
