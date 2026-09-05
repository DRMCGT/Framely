// Video Background Studio - background service worker
// Opens (or focuses) the full studio tab on icon click.
// Never does video processing here — SW is event-driven and dies after ~30s.

const STUDIO_URL = 'src/page/studio.html';

chrome.action.onClicked.addListener(async () => {
  const targetUrl = chrome.runtime.getURL(STUDIO_URL);

  // Try to focus existing studio tab instead of duplicating
  const tabs = await chrome.tabs.query({ url: targetUrl });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url: targetUrl });
});
