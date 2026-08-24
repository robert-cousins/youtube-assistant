/**
 * Background service worker. Handles:
 *   - Message routing (navigation, banner dismissals)
 *   - IndexedDB proxy for content scripts
 *   - Hourly count sync (writes videoCount to storage for popup)
 *   - Backup reminder alarm
 *   - Auto-migration of old local storage data on startup
 */

'use strict';

// Load db.js helpers. Chrome: via importScripts. Firefox: already loaded via manifest.
if (typeof importScripts === 'function') {
  importScripts('db.js');
}


//  yth sync bridge 
// Cross-profile and phone activity cannot reach this profile's IndexedDB on
// its own. A small local daemon (yth serve) holds the shared record: we push
// what we capture, and pull what the other profile and the likes sync added.
// Everything degrades to normal local-only behaviour if the daemon is down.

const YTH_DEFAULT_URL = 'http://127.0.0.1:8742';

const ythConfig = () => new Promise((resolve) => {
  chrome.storage.local.get({ ythUrl: YTH_DEFAULT_URL, ythToken: '', ythCursor: 0 }, resolve);
});

const ythFetch = (cfg, path, options = {}) => fetch(cfg.ythUrl + path, {
  ...options,
  headers: { 'Content-Type': 'application/json', 'X-YTH-Token': cfg.ythToken,
             ...(options.headers || {}) }
});

// Fire-and-forget: a dead daemon must never block or break local capture.
const ythPush = (videos = [], sessions = [], events = []) => {
  ythConfig().then((cfg) => {
    if (!cfg.ythToken) return;
    return ythFetch(cfg, '/ingest', {
      method: 'POST',
      body: JSON.stringify({ videos, sessions, events })
    });
  }).catch(() => { /* offline or daemon down — local capture already succeeded */ });
};

// Merge a record from the daemon into IndexedDB. db_saveVideo uses put(), i.e.
// insert-or-replace, so writing the remote record directly would wipe local
// playback progress. Local watch state always wins; the remote row only fills
// gaps and contributes the liked flag.
const ythMergeVideo = (remote) => new Promise((resolve) => {
  db_getVideoById(remote.videoId).then((existing) => {
    if (!existing) {
      resolve(db_saveVideo({
        videoId: remote.videoId,
        title: remote.title || '',
        channel: remote.channel || '',
        channelUrl: remote.channelUrl || '',
        time: remote.time || 0,
        duration: remote.duration || 0,
        watched: remote.watched === true,
        watchCount: remote.watchCount || 0,
        live: remote.live === true ? true : undefined,
        liveReplay: remote.liveReplay === true ? true : undefined,
        liked: remote.liked === true ? true : undefined,
        description: remote.description || '',
        hidden: remote.hidden === true ? true : undefined,
        timestamp: remote.timestamp || Date.now()
      }));
      return;
    }
    resolve(db_saveVideo({
      ...existing,
      title:      existing.title      || remote.title || '',
      channel:    existing.channel    || remote.channel || '',
      channelUrl: existing.channelUrl || remote.channelUrl || '',
      duration:   existing.duration   || remote.duration || 0,
      // Monotonic locally-owned facts: never regress them from a remote row.
      time:       Math.max(existing.time || 0, remote.time || 0),
      watchCount: Math.max(existing.watchCount || 0, remote.watchCount || 0),
      watched:    existing.watched === true || remote.watched === true,
      liked:      remote.liked === true ? true : existing.liked,
      // The record is the only source of descriptions, so a non-empty remote
      // value always wins over a blank local one.
      description: remote.description || existing.description || '',
      hidden:     remote.hidden === true ? true : undefined,
      // timestamp drives History-tab sort order. Only move it forward, so a
      // video watched here last week is not shuffled to when it was liked.
      timestamp:  Math.max(existing.timestamp || 0, remote.timestamp || 0)
    }));
  }).catch(() => resolve());
});

let ythPulling = null;

const ythPull = () => {
  if (ythPulling) return ythPulling;                 // collapse concurrent pulls
  ythPulling = ythConfig().then((cfg) => {
    if (!cfg.ythToken) return { skipped: true };
    return ythFetch(cfg, `/recent?since=${cfg.ythCursor || 0}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((data) => {
        const videos = data.videos || [];
        return videos.reduce(
          (chain, v) => chain.then(() => ythMergeVideo(v)), Promise.resolve()
        ).then(() => {
          if (data.cursor) chrome.storage.local.set({ ythCursor: data.cursor });
          if (videos.length) invalidateCountCache?.();
          // A full page means more is waiting. Keep going rather than
          // trickling one page per alarm, so a backlog (a resync, or a newly
          // added field) clears in seconds instead of hours.
          // Only continue if the cursor actually moved; a full page whose rows
          // all share one timestamp would otherwise loop forever.
          const advanced = data.cursor && data.cursor > (cfg.ythCursor || 0);
          return {
            merged: videos.length,
            cursor: data.cursor,
            more: videos.length >= 500 && advanced
          };
        });
      });
  }).catch((error) => ({ error: String(error) }))
    .then((result) => {
      ythPulling = null;
      if (result && result.more) return ythPull();
      return result;
    });
  return ythPulling;
};

chrome.alarms.get('yth-pull', (existing) => {
  if (!existing) chrome.alarms.create('yth-pull', { periodInMinutes: 2 });
});

// Message handlers

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from extension tabs, not from web pages
  if (!sender.tab) return;

  // Navigation
  if (message.type === 'redirect-history') {
    chrome.tabs.update(sender.tab.id, {
      url: chrome.runtime.getURL('history.html')
    });
    return;
  }

  if (message.type === 'open-history-tab') {
    chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
    return;
  }

  if (message.type === 'open-options-export') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('options.html') + '#export'
    });
    return;
  }

  if (message.type === 'dismiss-backup-reminder') {
    chrome.storage.local.set({
      showBackupReminder: false,
      lastBackupTimestamp: Date.now()
    });
    return;
  }

  // IDB proxy for content scripts
  // Each handler mirrors a db.js function. Handlers that need to return data
  // must call sendResponse({ ... }) inside a .then() and return true.

  if (message.type === 'idb-save-video') {
    db_saveVideo(message.video).catch(console.error);
    ythPush([message.video]);
    return;
  }

  if (message.type === 'idb-record-watch-event') {
    db_recordWatchEvent(message.watchEvent).catch(console.error);
    ythPush([], [], [message.watchEvent]);
    return;
  }

  if (message.type === 'yth-hide') {
    // Soft-delete in the shared record so the video stays gone: a local-only
    // delete would be undone by the next pull, since the row is still in the
    // daemon's database and still in the likes playlist.
    ythConfig().then((cfg) => {
      if (!cfg.ythToken) return { skipped: true };   // sync off: local delete is final
      return ythFetch(cfg, '/hide', {
        method: 'POST',
        body: JSON.stringify({ videoId: message.videoId })
      }).then((r) => (r.ok ? { hidden: true } : { error: 'HTTP ' + r.status }));
    }).then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  if (message.type === 'yth-pull-now') {
    // The History page asks for this on load so a refresh is always current.
    ythPull().then(sendResponse);
    return true;
  }

  if (message.type === 'idb-record-watch-session') {
    db_recordWatchSession(message.watchSession).catch(console.error);
    ythPush([], [message.watchSession]);
    return;
  }

  if (message.type === 'idb-get-video') {
    db_getVideoById(message.videoId)
      .then((video) => sendResponse({ video }))
      .catch(() => sendResponse({ video: null }));
    return true;
  }

  if (message.type === 'idb-get-recent-videos') {
    const limit = typeof message.limit === 'number' ? message.limit : 15;
    const offset = typeof message.offset === 'number' ? message.offset : 0;
    db_getVideos(limit, offset)
      .then((videos) => sendResponse({ videos }))
      .catch(() => sendResponse({ videos: [] }));
    return true;
  }

  if (message.type === 'idb-get-all-videos') {
    db_getAllVideos()
      .then((videos) => sendResponse({ videos }))
      .catch(() => sendResponse({ videos: [] }));
    return true;
  }

  if (message.type === 'idb-delete-video') {
    db_deleteVideo(message.videoId).catch(console.error);
    return;
  }
});

// Alarm scheduling

const scheduleBackupAlarm = () => {
  chrome.alarms.get('backup-reminder-check', (existing) => {
    if (!existing) {
      chrome.alarms.create('backup-reminder-check', { periodInMinutes: 1440 });
    }
  });
};

const scheduleCountAlarm = () => {
  chrome.alarms.get('video-count-sync', (existing) => {
    if (!existing) {
      chrome.alarms.create('video-count-sync', { periodInMinutes: 60 });
    }
  });
};

// Backup frequency thresholds (in milliseconds)
const BACKUP_FREQUENCY_MS = {
  daily:   86400000,
  weekly:  604800000,
  monthly: 2592000000
};

// Alarm dispatcher

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'yth-pull') ythPull();
  if (alarm.name === 'backup-reminder-check') {
    chrome.storage.local.get(
      { backupReminderFrequency: 'weekly', lastBackupTimestamp: 0 },
      (data) => {
        const { backupReminderFrequency, lastBackupTimestamp } = data;
        if (backupReminderFrequency === 'never') return;

        const threshold = BACKUP_FREQUENCY_MS[backupReminderFrequency];
        if (!threshold) return;

        if (Date.now() - lastBackupTimestamp >= threshold) {
          chrome.storage.local.set({ showBackupReminder: true });
        }
      }
    );
    return;
  }

  if (alarm.name === 'video-count-sync') {
    refreshVideoCount();
    return;
  }
});

// Video count refresh

const refreshVideoCount = () => {
  db_countVideos()
    .then((count) => chrome.storage.local.set({ videoCount: count }))
    .catch(console.error);
};

// Legacy migration (storage.local → IndexedDB)

const migrateIfNeeded = () => {
  db_countVideos()
    .then((count) => {
      // IDB already has records — nothing to migrate
      if (count > 0) return;

      // IDB is empty: check for legacy history in storage
      chrome.storage.local.get({ history: [] }, (data) => {
        const legacy = data.history;
        if (!Array.isArray(legacy) || legacy.length === 0) return;

        // Remap legacy format: id → videoId (the IDB keyPath)
        const migrated = legacy.map((v) => ({
          videoId:    v.id,
          title:      typeof v.title === 'string' ? v.title : '',
          channel:    typeof v.channel === 'string' ? v.channel : '',
          channelUrl: typeof v.channelUrl === 'string' ? v.channelUrl : '',
          time:       typeof v.time === 'number' ? v.time : 0,
          duration:   typeof v.duration === 'number' ? v.duration : 0,
          watched:    v.watched === true,
          // Backwards compatibility: legacy records never tracked watch
          // counts. Treat an already-watched video as one prior watch.
          watchCount: typeof v.watchCount === 'number' ? v.watchCount : (v.watched === true ? 1 : 0),
          live:       v.live === true ? true : undefined,
          timestamp:  typeof v.timestamp === 'number' ? v.timestamp : Date.now()
        }));

        db_bulkImport(migrated)
          .then((n) => {
            console.log(`[YTWH] Migrated ${n} video(s) to IndexedDB.`);
            chrome.storage.local.set({ videoCount: n });
          })
          .catch(console.error);
      });
    })
    .catch(console.error);
};

// Ghost mode (session-only, cleared on restart)

const resetGhostModeState = () => {
  chrome.storage.local.set({ ghostModeActive: false });
};

// Startup

chrome.runtime.onInstalled.addListener(() => {
  resetGhostModeState();
  scheduleBackupAlarm();
  scheduleCountAlarm();
  migrateIfNeeded();
  refreshVideoCount();
});

chrome.runtime.onStartup.addListener(() => {
  resetGhostModeState();
  scheduleBackupAlarm();
  scheduleCountAlarm();
  migrateIfNeeded();
  refreshVideoCount();
});
