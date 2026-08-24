const container        = document.getElementById('history-container');
const searchInput      = document.getElementById('search-input');
const sortSelect       = document.getElementById('sort-select');
const hideWatchedToggle = document.getElementById('hide-watched-toggle');
const loadMoreBtn      = document.getElementById('load-more-btn');
const statTotal        = document.getElementById('stat-total');

let allHistory     = [];
let filteredHistory = [];
let currentIndex   = 0;
let hideWatched    = false;
const PAGE_SIZE    = 24;

const showToast = (message) => {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
};

const formatTime = (seconds) => {
  const roundedSeconds = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(roundedSeconds / 60);
  const s = roundedSeconds % 60;
  return `${m}m ${s}s`;
};

// Removal has two callers now (the card menu and the Clear pill), and getting
// the order wrong matters: hide in the shared record first, because a purely
// local delete is undone by the next pull -- and for a liked video, by every
// future likes sync.
const removeVideo = (videoId) => {
  chrome.runtime.sendMessage({ type: 'yth-hide', videoId }, (result) => {
    void chrome.runtime.lastError;
    const syncFailed = result && result.error;
    db_deleteVideo(videoId).then(() => {
      showToast(syncFailed
        ? 'Removed here, but the sync daemon is unreachable - it may come back'
        : 'Video removed');
      loadHistory();
    }).catch(console.error);
  });
};

const applyFilters = () => {
  const query = searchInput.value.toLowerCase().trim();
  const sort = sortSelect.value;

  filteredHistory = allHistory.filter(v => {
    if (v.hidden) return false;                 // soft-deleted in the shared record
    if (hideWatched && v.watched) return false;
    if (query) {
      return v.title.toLowerCase().includes(query) ||
        (v.channel && v.channel.toLowerCase().includes(query));
    }
    return true;
  });

  if (sort === 'oldest') {
    filteredHistory.sort((a, b) => a.timestamp - b.timestamp);
  } else if (sort === 'title') {
    filteredHistory.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    filteredHistory.sort((a, b) => b.timestamp - a.timestamp);
  }

  currentIndex = 0;
  container.replaceChildren();
  renderBatch();
};

const renderBatch = () => {
  const batch = filteredHistory.slice(currentIndex, currentIndex + PAGE_SIZE);

  if (currentIndex === 0 && batch.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.gridColumn = '1 / -1';
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '\uD83D\uDCFA';
    const text = document.createElement('div');
    text.className = 'empty-text';
    text.textContent = searchInput.value ? 'No matching videos' : 'No history saved yet';
    const sub = document.createElement('div');
    sub.className = 'empty-sub';
    sub.textContent = searchInput.value ? 'Try a different search term' : 'Watch YouTube videos to start tracking';
    empty.appendChild(icon);
    empty.appendChild(text);
    empty.appendChild(sub);
    container.replaceChildren(empty);
    loadMoreBtn.classList.add('hidden');
    return;
  }

  batch.forEach(video => {
    const url = video.live || video.watched
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`
      : `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}&t=${video.time}s`;
    const thumbUrl = `https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/mqdefault.jpg`;
    const date = new Date(video.timestamp).toLocaleDateString();
    const liveTime = `${formatTime(video.time)} watched`;
    const timeBadge = video.live
      ? `\u{1F534} Livestream \u2022 ${liveTime}`
      : video.liveReplay
        ? `\u{1F504} Livestream \u2022 ${liveTime}`
        : video.watched
          ? '\u2713 Watched'
          : (video.liked && !video.time)
            // Liked elsewhere (phone, other profile): we have no watch time for
            // it, and showing 0:00 would read as "opened and abandoned".
            ? '\u2605 Liked'
            : video.liked
              ? `\u2605 ${formatTime(video.time)}`
              : formatTime(video.time);

    const card = document.createElement('div');
    card.className = 'video-card';

    const menuWrap = document.createElement('div');
    menuWrap.className = 'card-menu-wrap';
    const menuBtn = document.createElement('button');
    menuBtn.className = 'card-menu-btn';
    menuBtn.title = 'More actions';
    menuBtn.textContent = '\u22EE';
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
      cardMenu.classList.toggle('open');
    };
    const cardMenu = document.createElement('div');
    cardMenu.className = 'card-menu';

    const watchedItem = document.createElement('button');
    watchedItem.className = 'card-menu-item';
    watchedItem.textContent = video.watched ? '\u21A9 Reset progress' : '\u2713 Mark as watched';
    watchedItem.onclick = () => {
      // Read the latest record from IDB, toggle the watched flag, then save.
      chrome.storage.local.get({ watchedThreshold: 95 }, ({ watchedThreshold }) => {
        db_getVideoById(video.videoId).then((entry) => {
          if (!entry) return;
          const wasWatched = entry.watched;
          // Backwards compatibility: a record already marked watched before
          // this feature existed counts as one prior watch.
          if (typeof entry.watchCount !== 'number') {
            entry.watchCount = wasWatched ? 1 : 0;
          }
          entry.watched = !wasWatched;
          // Only credit a watch when the saved progress actually meets the
          // user's watch threshold — otherwise spamming "Reset progress"
          // and "Mark as watched" could inflate the count without watching.
          const progress = entry.duration > 0 ? entry.time / entry.duration : 0;
          const creditedWatch = entry.watched && !wasWatched && progress >= watchedThreshold / 100;
          if (creditedWatch) {
            entry.watchCount += 1;
          }
          if (!entry.watched) entry.time = 0;
          db_saveVideo(entry).then(() => {
            const eventPromise = creditedWatch
              ? db_recordWatchEvent({
                videoId: entry.videoId,
                watchedAt: Date.now()
              })
              : Promise.resolve();
            showToast(entry.watched ? 'Marked as watched' : 'Progress reset');
            return eventPromise.then(loadHistory);
          });
        }).catch(console.error);
      });
    };

    const copyItem = document.createElement('button');
    copyItem.className = 'card-menu-item';
    copyItem.textContent = '\uD83D\uDD17 Copy link';
    copyItem.onclick = () => {
      navigator.clipboard.writeText(`https://www.youtube.com/watch?v=${video.videoId}`);
      cardMenu.classList.remove('open');
      showToast('Link copied');
    };

    const removeItem = document.createElement('button');
    removeItem.className = 'card-menu-item danger';
    removeItem.textContent = '\uD83D\uDDD1 Remove from history';
    removeItem.onclick = () => removeVideo(video.videoId);

    cardMenu.appendChild(watchedItem);
    cardMenu.appendChild(copyItem);
    cardMenu.appendChild(removeItem);
    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(cardMenu);

    const thumbLink      = document.createElement('a');
    thumbLink.href        = url;
    thumbLink.target      = '_blank';
    thumbLink.rel         = 'noopener noreferrer';
    thumbLink.className   = 'thumb-link';
    const thumbImg        = document.createElement('img');
    thumbImg.src          = thumbUrl;
    thumbImg.className    = 'thumb-img';
    thumbImg.alt          = '';
    const timeBadgeEl = document.createElement('span');
    timeBadgeEl.className = video.watched ? 'time-badge watched-badge' : 'time-badge';
    timeBadgeEl.textContent = timeBadge;
    thumbLink.appendChild(thumbImg);
    thumbLink.appendChild(timeBadgeEl);

    // Tool stack, between thumbnail and title.
    const tools = document.createElement('div');
    tools.className = 'card-tools';

    const makePill = (label, className, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className ? `pill-btn ${className}` : 'pill-btn';
      btn.textContent = label;
      if (onClick) {
        btn.onclick = onClick;
      } else {
        btn.disabled = true;               // placeholder, no behaviour yet
        btn.title = `${label} - not wired up yet`;
      }
      return btn;
    };

    tools.appendChild(makePill('Clear', 'is-clear', () => removeVideo(video.videoId)));

    const robertBtn = makePill('Robert', 'is-robert', null);
    if (video.summaryState === 'no_transcript') {
      robertBtn.disabled = true;
      robertBtn.title = 'No transcript available for this video';
    } else {
      robertBtn.disabled = false;
      robertBtn.title = video.summary ? 'Re-summarise the transcript'
                                      : 'Summarise the transcript';
      robertBtn.onclick = () => {
        if (robertBtn.disabled) return;
        const label = robertBtn.textContent;
        robertBtn.disabled = true;
        robertBtn.classList.add('is-working');
        robertBtn.textContent = '...';
        descEl.classList.add('is-working');
        chrome.runtime.sendMessage(
          { type: 'yth-summarize', videoId: video.videoId },
          (result) => {
            void chrome.runtime.lastError;
            robertBtn.classList.remove('is-working');
            robertBtn.textContent = label;
            robertBtn.disabled = false;
            descEl.classList.remove('is-working');
            if (!result || result.state === 'error') {
              showToast(`Summary failed: ${(result && result.error) || 'no response'}`);
              return;
            }
            if (result.state === 'no_transcript') {
              showToast('No transcript available for this video');
            }
            // The pull inside the handler has already merged the new text into
            // IndexedDB; re-render so the column shows it.
            loadHistoryFromDb();
          });
      };
    }
    tools.appendChild(robertBtn);
    tools.appendChild(makePill('George', 'is-george', null));

    const body = document.createElement('div');
    body.className = 'card-body';
    const titleLink = document.createElement('a');
    titleLink.href = url;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';
    titleLink.className = 'card-title';
    titleLink.textContent = video.title;
    body.appendChild(titleLink);
    if (video.channel) {
      const channelLink = document.createElement('a');
      channelLink.href = video.channelUrl || '#';
      channelLink.target = '_blank';
      channelLink.rel = 'noopener noreferrer';
      channelLink.className = 'card-channel';
      channelLink.textContent = video.channel;
      body.appendChild(channelLink);
    }
    const metaDiv = document.createElement('div');
    metaDiv.className = 'card-meta';
    metaDiv.textContent = date;
    body.appendChild(metaDiv);

    // Description column. Populated from the shared record (the extension never
    // captures descriptions itself), so it is blank until the daemon has
    // backfilled that video.
    const descEl = document.createElement('div');
    descEl.className = 'card-description';
    if (video.summary) {
      // A summary supersedes the description in this column, but the original
      // description is kept in the record and shown on hover.
      descEl.classList.add('is-summary');
      descEl.textContent = video.summary;
      descEl.title = video.description || video.summary;
    } else if (video.summaryState === 'no_transcript') {
      descEl.classList.add('is-empty');
      descEl.textContent = video.description || 'No transcript available';
    } else if (video.description) {
      descEl.textContent = video.description;
      descEl.title = video.description;
    } else {
      descEl.classList.add('is-empty');
      descEl.textContent = 'No description';
    }

    // Right-hand slot. Everything here is right-aligned and vertically centred;
    // add further buttons or fields by appending to actions, no layout change
    // needed. Order: status fields first, controls last.
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    if (video.liked) {
      const likedFlag = document.createElement('span');
      likedFlag.className = 'liked-flag';
      likedFlag.textContent = '\u2605';
      likedFlag.title = 'Liked on YouTube';
      actions.appendChild(likedFlag);
    }

    const statusEl = document.createElement('span');
    statusEl.className = 'card-meta';
    statusEl.textContent = timeBadge;
    actions.appendChild(statusEl);

    actions.appendChild(menuWrap);

    card.appendChild(thumbLink);
    card.appendChild(tools);
    card.appendChild(body);
    card.appendChild(descEl);
    card.appendChild(actions);
    container.appendChild(card);
  });

  currentIndex += PAGE_SIZE;
  loadMoreBtn.classList.toggle('hidden', currentIndex >= filteredHistory.length);
};

//  Thumbnail size 
// The row layout reads --thumb-w from a class on the container, so switching
// size is a single class swap rather than a re-render.
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

const loadHistory = () => {
  // Ask the background worker to pull anything new from the local daemon first
  // (other Chrome profile, phone likes), then read IndexedDB. If the daemon is
  // down this resolves immediately and we simply render what is local.
  chrome.runtime.sendMessage({ type: 'yth-pull-now' }, () => {
    void chrome.runtime.lastError;                 // daemon absent is not an error
    loadHistoryFromDb();
  });
};

const loadHistoryFromDb = () => {
  // Fetch all records from IndexedDB for client-side filtering/sorting.
  // db_getAllVideos() returns them newest-first; applyFilters() may re-sort.
  db_getAllVideos().then((videos) => {
    allHistory = videos;
    statTotal.textContent = videos.length.toLocaleString();

    // On the very first load, apply the user's "hide watched" default.
    if (!loadHistory._initialized) {
      chrome.storage.local.get({ hideWatchedDefault: false }, (prefs) => {
        hideWatched = prefs.hideWatchedDefault;
        hideWatchedToggle.checked = hideWatched;
        loadHistory._initialized = true;
        applyFilters();
      });
    } else {
      applyFilters();
    }
  }).catch(console.error);
};

// Event listeners
loadMoreBtn.onclick = renderBatch;

let searchTimeout;
searchInput.oninput = () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(applyFilters, 300);
};

sortSelect.onchange = applyFilters;

hideWatchedToggle.onchange = () => {
  hideWatched = hideWatchedToggle.checked;
  applyFilters();
};

// Close menus on outside click
document.addEventListener('click', () => {
  document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
});

document.getElementById('clear-all').onclick = () => {
  if (confirm('Permanently delete your entire local history?\n\n'
      + 'Note: anything held by the sync daemon (other Chrome profile, liked '
      + 'videos) will return on the next pull. Stop `yth serve`, or clear the '
      + 'token in Options, if you want this to stick.')) {
    db_clearAllVideos().then(() => {
      // Keep the videoCount in sync so the popup stat updates promptly.
      chrome.storage.local.set({ videoCount: 0 });
      showToast('History cleared');
      loadHistory();
    }).catch(console.error);
  }
};

// Theme resolution: an explicit choice wins, otherwise follow YouTube's own
// theme (content.js mirrors it into youtubeTheme). 'auto' preserves the
// extension's original behaviour and stays the default.
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
      // No signal either way: let the OS preference apply via CSS.
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

document.addEventListener('DOMContentLoaded', () => {
  const select = document.getElementById('theme-select');
  if (!select) return;
  select.onchange = () => {
    chrome.storage.local.set({ themeMode: select.value });
    applyStoredTheme();
  };
  applyStoredTheme();
});

// db.js must be loaded before history.js (see history.html <script> tags).
loadHistory();