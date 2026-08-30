/**
 * Open outbound links as browser tabs.
 *
 * A plain <a target="_blank"> is a navigation, and a navigation to youtube.com
 * can be captured by an installed app -- a Chrome PWA, or a Windows app
 * registered for the site -- which lands the video outside the browser.
 * chrome.tabs.create asks the browser for a tab directly, so there is no
 * navigation for anything to intercept.
 *
 * Loaded before each page's own script and delegated from the document, so it
 * covers rows rendered later without any page needing to know about it.
 */

'use strict';

document.addEventListener('click', (event) => {
  // Modified clicks already mean something specific (new window, download,
  // save target). Leave them to the browser.
  if (event.button !== 0 || event.ctrlKey || event.metaKey
      || event.shiftKey || event.altKey || event.defaultPrevented) {
    return;
  }
  const link = event.target.closest && event.target.closest('a[target="_blank"]');
  if (!link) return;
  const href = link.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href)) return;   // in-extension links stay as they are

  event.preventDefault();
  if (chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url: href, active: true });
  } else {
    // Firefox builds, or a context without the tabs API: the original
    // behaviour is still better than doing nothing.
    window.open(href, '_blank', 'noopener');
  }
});
