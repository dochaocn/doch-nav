/**
 * Service Worker：topSites、可选 history、扩展图标一键暂存。
 */

import { appendStashFromTab } from "./lib/storage-sync.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_TOP_SITES") {
    chrome.topSites.get((sites) => {
      sendResponse({ ok: true, sites: sites || [] });
    });
    return true;
  }
  if (msg?.type === "GET_HISTORY_FREQ") {
    if (!chrome.history || !chrome.history.search) {
      sendResponse({ ok: false, error: "no_history_permission" });
      return;
    }
    const days = Math.min(30, Math.max(1, msg.days || 14));
    const start = Date.now() - days * 864e5;
    chrome.history.search({ text: "", startTime: start, maxResults: 5000 }, (items) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      const hostCount = new Map();
      for (const it of items || []) {
        try {
          const u = new URL(it.url);
          const h = u.hostname || "local";
          hostCount.set(h, (hostCount.get(h) || 0) + (it.visitCount || 1));
        } catch {
          /* skip */
        }
      }
      const list = [...hostCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 24)
        .map(([host, count]) => ({ host, count }));
      sendResponse({ ok: true, list });
    });
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener(async (tab) => {
  const url = tab?.url || "";
  if (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools:") ||
    url.startsWith("chrome-extension://")
  ) {
    try {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
      setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1800);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    await appendStashFromTab({ url, title: tab.title || url });
    await chrome.action.setBadgeText({ text: "+" });
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1200);
  } catch (e) {
    console.error(e);
    try {
      await chrome.action.setBadgeText({ text: "!" });
      setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1800);
    } catch {
      /* ignore */
    }
  }
});
