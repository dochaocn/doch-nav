/**
 * Service Worker：topSites、可选 history、扩展图标一键暂存。
 */

import { appendStashFromTab } from "./lib/storage-sync.js";

/** @returns {string|null} 不可暂存时的原因代码；可暂存则 null */
function _stashBlockReason(url) {
  if (!url || typeof url !== "string") return "empty_tab_url";
  const u = url.trim();
  if (!u) return "empty_tab_url";
  if (u.startsWith("chrome://")) return "chrome_internal";
  if (u.startsWith("edge://")) return "edge_internal";
  if (u.startsWith("about:")) return "about_page";
  if (u.startsWith("devtools:")) return "devtools_page";
  if (u.startsWith("chrome-extension://")) return "extension_page";
  try {
    new URL(u);
    return null;
  } catch {
    return "invalid_url";
  }
}

async function _badgeError() {
  try {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1800);
  } catch {
    /* ignore */
  }
}

/**
 * onClicked 传入的 tab 有时不带 url（尤其未声明 activeTab 时）。在用户手势内用 tabs.get 补全，并兼顾 pendingUrl。
 */
async function _resolveTabForStash(tab) {
  let url = tab?.url || "";
  let title = tab?.title || "";
  const id = tab?.id;
  const missing = !url || !String(url).trim();
  if (missing && id != null) {
    try {
      const t = await chrome.tabs.get(id);
      url = (t?.url && String(t.url).trim()) || "";
      if (!url) url = (t?.pendingUrl && String(t.pendingUrl).trim()) || "";
      if (!title && t?.title) title = t.title;
    } catch (e) {
      console.warn("[个人导航站] tabs.get 失败", e);
    }
  }
  return { url: url || "", title: title || "" };
}

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
  const { url, title } = await _resolveTabForStash(tab);
  const block = _stashBlockReason(url);
  if (block) {
    console.warn("[个人导航站] 暂存跳过:", block, {
      urlPreview: url ? String(url).slice(0, 200) : "",
      tabId: tab?.id
    });
    await _badgeError();
    return;
  }
  try {
    await appendStashFromTab({ url, title: title || url });
    console.info("[个人导航站] 暂存成功", { urlPreview: String(url).slice(0, 200) });
    await chrome.action.setBadgeText({ text: "+" });
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1200);
  } catch (e) {
    console.error("[个人导航站] 暂存失败", e?.message || e, e);
    await _badgeError();
  }
});
