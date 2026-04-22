import {
  getPinnedState,
  setPinnedState,
  getStashState,
  setStashState,
  getFreqHiddenUrls,
  addFreqHiddenUrl,
  getUsageScores,
  bumpUsage,
  normalizeUrlForUsage,
  getSettings,
  setSettings,
  isStashLocalOnly,
  isPinnedLocalOnly,
  DEFAULT_PIN_FOLDER,
  DEFAULT_STASH_FOLDER
} from "./lib/storage-sync.js";

const DND = "application/x-personal-nav";

function dndTypePresent(e) {
  return [...e.dataTransfer.types].some(
    (t) => t === DND || t.toLowerCase() === DND.toLowerCase()
  );
}

const state = {
  pinned: { folders: [], items: [] },
  stash: { folders: [], items: [] },
  /** @type {Set<string>} 经常访问中已隐藏的规范化 URL */
  freqHidden: new Set(),
  usage: {},
  topSites: [],
  historyHosts: [],
  filter: "",
  theme: "light"
};

function $(id) {
  return document.getElementById(id);
}

/**
 * 为 <img> 设置 favicon，按顺序尝试多个来源。
 * 说明：单独使用 Google s2 时，部分域名无收录、或网络无法访问 Google 会导致不显示；
 * 因此增加 DuckDuckGo 与站点 /favicon.ico 作为回退。
 */
function faviconPlaceholderDataUrl(hostname) {
  const raw = hostname.replace(/^www\./i, "")[0] || "?";
  const ch = /^[a-z0-9]$/i.test(raw) ? raw.toUpperCase() : "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect fill="#e2e8f0" width="64" height="64" rx="12"/><text x="32" y="40" text-anchor="middle" font-family="system-ui,sans-serif" font-size="26" font-weight="600" fill="#64748b">${ch}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

function setFaviconOnImg(img, pageUrl) {
  let urls;
  try {
    const u = new URL(pageUrl);
    const host = u.hostname;
    if (!host) {
      img.removeAttribute("src");
      return;
    }
    urls = [
      `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`,
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
      `${u.origin}/favicon.ico`
    ];
  } catch {
    img.removeAttribute("src");
    return;
  }

  let i = 0;
  const tryNext = () => {
    if (i >= urls.length) {
      img.onerror = null;
      img.onload = null;
      try {
        img.src = faviconPlaceholderDataUrl(new URL(pageUrl).hostname);
      } catch {
        img.removeAttribute("src");
      }
      return;
    }
    img.src = urls[i++];
  };

  img.onerror = () => tryNext();
  img.onload = () => {
    img.onerror = null;
  };
  tryNext();
}

function hostLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function greet() {
  const h = new Date().getHours();
  if (h < 6) return "夜深了，注意休息";
  if (h < 12) return "上午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function showToast(msg, ms = 2800) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

async function applyThemeFromSettings() {
  const s = await getSettings();
  state.theme = s.theme;
  document.documentElement.setAttribute("data-theme", s.theme);
  $("theme-icon").textContent = s.theme === "dark" ? "☾" : "☀";
}

async function updateSyncBanner() {
  const banner = $("sync-banner");
  const ps = [];
  if (await isPinnedLocalOnly()) {
    ps.push("常用链接因配额仅保存在本机，无法随 Google 账号同步。");
  }
  if (await isStashLocalOnly()) {
    ps.push("暂存列表因配额仅保存在本机，无法同步。");
  }
  if (ps.length) {
    banner.hidden = false;
    banner.textContent = ps.join(" ");
  } else {
    banner.hidden = true;
  }
}

function matchesFilter(text) {
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return String(text).toLowerCase().includes(q);
}

function sortFolders(list) {
  return [...(list || [])].sort(
    (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)
  );
}

function nextSortOrder(folders) {
  if (!folders.length) return 0;
  return Math.max(...folders.map((f) => f.sortOrder || 0), 0) + 1;
}

// —— 常用 —— //

function pinnedItemVisible(p) {
  return (
    matchesFilter(p.title || "") ||
    matchesFilter(p.url || "") ||
    matchesFilter(hostLabel(p.url))
  );
}

function stashItemVisible(s) {
  return (
    matchesFilter(s.label || "") ||
    matchesFilter(s.pageTitle || "") ||
    matchesFilter(s.url || "") ||
    matchesFilter(s.note || "")
  );
}

function freqEntryVisible(e) {
  return (
    matchesFilter(e.title) ||
    matchesFilter(e.url) ||
    matchesFilter(hostLabel(e.url))
  );
}

function buildFreqEntries() {
  const usage = state.usage;
  const entries = [];
  for (const s of state.topSites) {
    const url = s.url;
    const key = normalizeUrlForUsage(url);
    const sc = usage[key]?.c || 0;
    entries.push({
      url,
      title: s.title || hostLabel(url),
      score: sc,
      nu: key
    });
  }
  if (state.historyHosts.length) {
    for (const h of state.historyHosts) {
      const url = `https://${h.host}/`;
      if (entries.some((e) => hostLabel(e.url) === h.host)) continue;
      const key = normalizeUrlForUsage(url);
      const sc = usage[key]?.c || 0;
      entries.push({
        url,
        title: h.host,
        score: sc + h.count * 0.01,
        visits: h.count,
        nu: key
      });
    }
  }
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.title || "").localeCompare(b.title || "");
  });
  return entries.filter((e) => !state.freqHidden.has(e.nu));
}

function renderPinned() {
  const root = $("pinned-root");
  const empty = $("pinned-empty");
  const folders = sortFolders(state.pinned.folders);
  const items = state.pinned.items.filter(pinnedItemVisible);
  empty.hidden = items.length > 0;
  root.innerHTML = "";
  if (!items.length && !state.filter.trim()) {
    folders.forEach((f) => {
      const inF = state.pinned.items.filter((p) => p.folderId === f.id);
      if (inF.length) empty.hidden = true;
    });
  }

  for (const f of folders) {
    const inFolder = state.pinned.items
      .filter((p) => p.folderId === f.id && pinnedItemVisible(p))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    const details = document.createElement("details");
    details.className = "folder-block";
    details.open = true;

    const sum = document.createElement("summary");
    const title = document.createElement("span");
    title.style.flex = "1";
    title.textContent = f.name || "文件夹";
    sum.appendChild(title);
    if (f.id !== DEFAULT_PIN_FOLDER) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn--ghost btn--sm";
      del.textContent = "删除";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void deletePinnedFolder(f.id);
      });
      sum.appendChild(del);
    }
    details.appendChild(sum);

    const drop = document.createElement("div");
    drop.className = "folder-drop";
    mountFolderDropHandlers(drop, f.id);

    const grid = document.createElement("div");
    grid.className = "tile-grid";
    for (const item of inFolder) {
      grid.appendChild(renderPinnedTile(item, f.id));
    }
    drop.appendChild(grid);
    details.appendChild(drop);
    root.appendChild(details);
  }
}

function renderPinnedTile(item, folderId) {
  const a = document.createElement("a");
  a.className = "tile";
  a.href = item.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.draggable = true;

  a.addEventListener("click", async (e) => {
    if (e.target.closest(".tile__actions")) {
      e.preventDefault();
      return;
    }
    await bumpUsage(item.url);
  });

  a.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData(
      DND,
      JSON.stringify({
        z: "p",
        id: item.id,
        folderId
      })
    );
    e.dataTransfer.effectAllowed = "move";
  });

  a.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  a.addEventListener("drop", (e) => {
    e.preventDefault();
    handlePinnedDropOnItem(e, item.id, folderId);
  });

  const img = document.createElement("img");
  img.className = "tile__fav";
  img.alt = "";
  setFaviconOnImg(img, item.url);
  img.width = 40;
  img.height = 40;

  const label = document.createElement("div");
  label.className = "tile__label";
  label.textContent = item.title || hostLabel(item.url);

  const actions = document.createElement("div");
  actions.className = "tile__actions";
  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "mini-btn";
  renameBtn.textContent = "改";
  renameBtn.title = "修改显示名称";
  renameBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void renamePinnedItem(item.id);
  });
  const del = document.createElement("button");
  del.type = "button";
  del.className = "mini-btn";
  del.textContent = "删";
  del.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void removePinned(item.id);
  });
  actions.appendChild(renameBtn);
  actions.appendChild(del);

  a.appendChild(img);
  a.appendChild(label);
  a.appendChild(actions);
  return a;
}

function mountFolderDropHandlers(el, folderId) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("folder-drop--over");
    e.dataTransfer.dropEffect = "move";
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("folder-drop--over");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("folder-drop--over");
    handlePinnedDropOnFolder(e, folderId);
  });
}

function parseDnD(e) {
  try {
    return JSON.parse(e.dataTransfer.getData(DND));
  } catch {
    return null;
  }
}

function handlePinnedDropOnFolder(e, targetFolderId) {
  const d = parseDnD(e);
  if (!d) return;
  if (d.z === "p" && d.id) {
    void movePinnedItem(d.id, targetFolderId, null);
    return;
  }
  if (d.z === "stash" && d.id) {
    void addStashItemToPinned(d.id, targetFolderId, null);
    return;
  }
  if (d.z === "freq" && d.url) {
    void addPinnedAt(d.url, d.title, targetFolderId, null, {
      hideFreqNu: d.nu
    });
    return;
  }
}

function handlePinnedDropOnItem(e, targetItemId, targetFolderId) {
  const d = parseDnD(e);
  if (!d) return;
  if (d.z === "p" && d.id && d.id !== targetItemId) {
    void movePinnedItem(d.id, targetFolderId, targetItemId);
    return;
  }
  if (d.z === "stash" && d.id) {
    void addStashItemToPinned(d.id, targetFolderId, targetItemId);
    return;
  }
  if (d.z === "freq" && d.url) {
    void addPinnedAt(d.url, d.title, targetFolderId, targetItemId, {
      hideFreqNu: d.nu
    });
    return;
  }
}

/**
 * 从暂存拖入常用：移除暂存条目并插入对应文件夹（顺序参考目标磁贴）。
 */
async function addStashItemToPinned(stashId, targetFolderId, beforeItemId) {
  const stashItem = state.stash.items.find((x) => x.id === stashId);
  if (!stashItem) return;
  if (state.pinned.items.some((p) => p.url === stashItem.url)) {
    showToast("已有相同网址在常用中");
    return;
  }
  const now = Date.now();
  const title =
    stashItem.label || stashItem.pageTitle || hostLabel(stashItem.url);
  const newPinned = {
    id: crypto.randomUUID(),
    url: stashItem.url,
    title,
    folderId: targetFolderId,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now
  };

  const withoutStash = state.stash.items.filter((x) => x.id !== stashId);
  try {
    await setStashState({
      folders: state.stash.folders,
      items: withoutStash
    });
  } catch (err) {
    showToast(err.message || String(err));
    return;
  }

  const allPinned = state.pinned.items.map((x) => ({ ...x }));
  let bucket = allPinned
    .filter((x) => x.folderId === targetFolderId)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  if (beforeItemId) {
    const ix = bucket.findIndex((x) => x.id === beforeItemId);
    if (ix >= 0) bucket.splice(ix, 0, newPinned);
    else bucket = [...bucket, newPinned];
  } else {
    bucket = [...bucket, newPinned];
  }
  bucket.forEach((it, i) => {
    it.sortOrder = i;
  });

  const otherFolders = allPinned.filter((x) => x.folderId !== targetFolderId);
  const merged = rebalanceSortOrder([...otherFolders, ...bucket]);

  try {
    await setPinnedState({
      folders: state.pinned.folders,
      items: merged
    });
    state.pinned = await getPinnedState();
    state.stash = await getStashState();
    renderPinned();
    renderStash();
    await updateSyncBanner();
    showToast("已加入常用链接");
  } catch (e) {
    showToast(e.message || String(e));
  }
}

async function movePinnedItem(itemId, targetFolderId, beforeItemId) {
  const all = state.pinned.items.map((x) => ({ ...x }));
  const cur = all.find((x) => x.id === itemId);
  if (!cur) return;
  const without = all.filter((x) => x.id !== itemId);
  cur.folderId = targetFolderId;
  cur.updatedAt = Date.now();

  let bucket = without
    .filter((x) => x.folderId === targetFolderId)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  if (beforeItemId) {
    const ix = bucket.findIndex((x) => x.id === beforeItemId);
    if (ix >= 0) bucket.splice(ix, 0, cur);
    else bucket = [...bucket, cur];
  } else {
    bucket = [...bucket, cur];
  }
  bucket.forEach((it, i) => {
    it.sortOrder = i;
  });

  const otherFolders = without.filter((x) => x.folderId !== targetFolderId);
  const merged = rebalanceSortOrder([...otherFolders, ...bucket]);

  try {
    await setPinnedState({
      folders: state.pinned.folders,
      items: merged
    });
    state.pinned = await getPinnedState();
    renderPinned();
  } catch (err) {
    showToast(err.message || String(err));
  }
}

function rebalanceSortOrder(items) {
  const byF = new Map();
  for (const it of items) {
    const fid = it.folderId;
    if (!byF.has(fid)) byF.set(fid, []);
    byF.get(fid).push(it);
  }
  const out = [];
  for (const [, arr] of byF) {
    arr.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    arr.forEach((it, idx) => {
      it.sortOrder = idx;
    });
    out.push(...arr);
  }
  return out;
}

async function renamePinnedItem(id) {
  const it = state.pinned.items.find((x) => x.id === id);
  if (!it) return;
  const cur = it.title || hostLabel(it.url);
  const nv = window.prompt("显示名称（留空则用域名）", cur);
  if (nv === null) return;
  const nextTitle = nv.trim() || hostLabel(it.url);
  if (nextTitle === cur) return;
  const next = state.pinned.items.map((p) =>
    p.id === id
      ? { ...p, title: nextTitle, updatedAt: Date.now() }
      : p
  );
  try {
    await setPinnedState({ folders: state.pinned.folders, items: next });
    state.pinned = await getPinnedState();
    renderPinned();
    await updateSyncBanner();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

async function removePinned(id) {
  const next = state.pinned.items.filter((p) => p.id !== id);
  try {
    await setPinnedState({ folders: state.pinned.folders, items: next });
    state.pinned = await getPinnedState();
    renderPinned();
    await updateSyncBanner();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

// —— 暂存 —— //

async function renameStashItem(id) {
  const it = state.stash.items.find((x) => x.id === id);
  if (!it) return;
  const cur = it.label || it.pageTitle || hostLabel(it.url);
  const nv = window.prompt("显示名称（留空则用页面标题）", cur);
  if (nv === null) return;
  const nextLabel = nv.trim() || it.pageTitle || hostLabel(it.url);
  const prev = String(it.label ?? it.pageTitle ?? "").trim();
  if (nextLabel === prev) return;
  const items = state.stash.items.map((i) =>
    i.id === id ? { ...i, label: nextLabel, updatedAt: Date.now() } : i
  );
  try {
    await setStashState({ folders: state.stash.folders, items });
    state.stash = await getStashState();
    renderStash();
  } catch (err) {
    showToast(err.message || String(err));
  }
}

function renderStash() {
  const root = $("stash-root");
  const empty = $("stash-empty");
  const folders = sortFolders(state.stash.folders);
  const vis = state.stash.items.filter(stashItemVisible);
  empty.hidden = vis.length > 0;

  root.innerHTML = "";
  for (const f of folders) {
    const items = state.stash.items
      .filter((s) => s.folderId === f.id && stashItemVisible(s))
      .sort((a, b) => (b.stashedAt || 0) - (a.stashedAt || 0));

    const details = document.createElement("details");
    details.className = "folder-block";
    details.open = true;

    const sum = document.createElement("summary");
    const title = document.createElement("span");
    title.style.flex = "1";
    title.textContent = f.name || "文件夹";
    sum.appendChild(title);
    if (f.id !== DEFAULT_STASH_FOLDER) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn--ghost btn--sm";
      del.textContent = "删除";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void deleteStashFolder(f.id);
      });
      sum.appendChild(del);
    }
    details.appendChild(sum);

    const drop = document.createElement("div");
    drop.className = "folder-drop";
    mountStashFolderDrop(drop, f.id);

    const grid = document.createElement("div");
    grid.className = "tile-grid";
    for (const s of items) {
      grid.appendChild(renderStashTile(s, f.id));
    }
    drop.appendChild(grid);
    details.appendChild(drop);
    root.appendChild(details);
  }
}

function renderStashTile(s, folderId) {
  const a = document.createElement("a");
  a.className = "tile";
  a.href = s.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.draggable = true;
  const headline = s.label || s.pageTitle || hostLabel(s.url);
  const tipParts = [];
  if (s.pageTitle && s.pageTitle !== headline) tipParts.push("页面标题：" + s.pageTitle);
  tipParts.push(s.url);
  a.title = tipParts.join("\n");

  a.addEventListener("click", async (e) => {
    if (e.target.closest(".tile__actions")) {
      e.preventDefault();
      return;
    }
    await bumpUsage(s.url);
  });

  a.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData(
      DND,
      JSON.stringify({ z: "stash", id: s.id, folderId })
    );
    e.dataTransfer.effectAllowed = "move";
  });
  a.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  a.addEventListener("drop", (e) => {
    e.preventDefault();
    void handleStashDropOnRow(e, s.id, folderId);
  });

  const img = document.createElement("img");
  img.className = "tile__fav";
  img.alt = "";
  setFaviconOnImg(img, s.url);
  img.width = 40;
  img.height = 40;

  const label = document.createElement("div");
  label.className = "tile__label";
  label.textContent = s.label || s.pageTitle || hostLabel(s.url);

  const actions = document.createElement("div");
  actions.className = "tile__actions";
  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "mini-btn";
  renameBtn.textContent = "改";
  renameBtn.title = "修改显示名称";
  renameBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void renameStashItem(s.id);
  });
  const del = document.createElement("button");
  del.type = "button";
  del.className = "mini-btn";
  del.textContent = "删";
  del.title = "删除";
  del.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void removeStash(s.id);
  });
  actions.appendChild(renameBtn);
  actions.appendChild(del);

  a.appendChild(img);
  a.appendChild(label);
  a.appendChild(actions);
  return a;
}

function mountStashFolderDrop(el, folderId) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("folder-drop--over");
    e.dataTransfer.dropEffect = "move";
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("folder-drop--over");
  });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("folder-drop--over");
    const d = parseDnD(e);
    if (!d) return;
    if (d.z === "stash" && d.id) {
      await moveStashToFolder(d.id, folderId, null);
      return;
    }
    if (d.z === "p" && d.id) {
      await addPinnedItemToStash(d.id, folderId, null);
      return;
    }
    if (d.z === "freq" && d.url) {
      await addFreqEntryToStash(d.nu, d.url, d.title, folderId, null);
    }
  });
}

async function handleStashDropOnRow(e, targetId, folderId) {
  const d = parseDnD(e);
  if (!d) return;
  if (d.z === "stash" && d.id && d.id !== targetId) {
    await moveStashToFolder(d.id, folderId, targetId);
    return;
  }
  if (d.z === "p" && d.id) {
    await addPinnedItemToStash(d.id, folderId, targetId);
    return;
  }
  if (d.z === "freq" && d.url) {
    await addFreqEntryToStash(d.nu, d.url, d.title, folderId, targetId);
  }
}

async function moveStashToFolder(itemId, targetFolderId, beforeId) {
  const all = state.stash.items.map((x) => ({ ...x }));
  const cur = all.find((x) => x.id === itemId);
  if (!cur) return;
  const without = all.filter((x) => x.id !== itemId);
  cur.folderId = targetFolderId;
  cur.updatedAt = Date.now();

  let bucket = without
    .filter((x) => x.folderId === targetFolderId)
    .sort((a, b) => (b.stashedAt || 0) - (a.stashedAt || 0));

  if (beforeId) {
    const ix = bucket.findIndex((x) => x.id === beforeId);
    if (ix >= 0) bucket.splice(ix, 0, cur);
    else bucket = [cur, ...bucket];
  } else {
    bucket = [cur, ...bucket];
  }

  const rest = without.filter((x) => x.folderId !== targetFolderId);
  const merged = [...rest, ...bucket];
  try {
    await setStashState({ folders: state.stash.folders, items: merged });
    state.stash = await getStashState();
    renderStash();
  } catch (err) {
    showToast(err.message || String(err));
  }
}

async function removeStash(id) {
  const next = state.stash.items.filter((s) => s.id !== id);
  try {
    await setStashState({ folders: state.stash.folders, items: next });
    state.stash = await getStashState();
    renderStash();
    await updateSyncBanner();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

/**
 * 常用条目移入暂存（指定文件夹与插入位置；beforeStashId 为 null 表示插到该文件夹顶部）。
 */
async function addPinnedItemToStash(pinnedId, targetFolderId, beforeStashId) {
  const pin = state.pinned.items.find((x) => x.id === pinnedId);
  if (!pin) return;
  if (state.stash.items.some((s) => s.url === pin.url)) {
    showToast("已有相同网址在暂存中");
    return;
  }
  const now = Date.now();
  const pt = pin.title || hostLabel(pin.url);
  const newStash = {
    id: crypto.randomUUID(),
    url: pin.url,
    pageTitle: pt,
    label: pt,
    folderId: targetFolderId,
    note: "",
    stashedAt: now,
    updatedAt: now
  };

  const nextPinned = state.pinned.items.filter((x) => x.id !== pinnedId);
  const allStash = state.stash.items.map((x) => ({ ...x }));
  const bucket = allStash
    .filter((x) => x.folderId === targetFolderId)
    .sort((a, b) => (b.stashedAt || 0) - (a.stashedAt || 0));
  let newBucket;
  if (beforeStashId) {
    const ix = bucket.findIndex((x) => x.id === beforeStashId);
    if (ix >= 0) {
      newBucket = [...bucket.slice(0, ix), newStash, ...bucket.slice(ix)];
    } else {
      newBucket = [newStash, ...bucket];
    }
  } else {
    newBucket = [newStash, ...bucket];
  }
  const rest = allStash.filter((x) => x.folderId !== targetFolderId);
  const mergedStash = [...rest, ...newBucket];

  try {
    await setStashState({ folders: state.stash.folders, items: mergedStash });
    await setPinnedState({ folders: state.pinned.folders, items: nextPinned });
    state.stash = await getStashState();
    state.pinned = await getPinnedState();
    renderStash();
    renderPinned();
    renderFreq();
    await updateSyncBanner();
    showToast("已移入暂存");
  } catch (err) {
    showToast(err.message || String(err));
  }
}

/**
 * 「经常访问」卡片拖入暂存：写入暂存并隐藏该建议项（与点「删」一致）。
 */
async function addFreqEntryToStash(nu, url, title, targetFolderId, beforeStashId) {
  if (state.stash.items.some((s) => s.url === url)) {
    showToast("已有相同网址在暂存中");
    return;
  }
  const now = Date.now();
  const pt = title || hostLabel(url);
  const newStash = {
    id: crypto.randomUUID(),
    url,
    pageTitle: pt,
    label: pt,
    folderId: targetFolderId,
    note: "",
    stashedAt: now,
    updatedAt: now
  };
  const allStash = state.stash.items.map((x) => ({ ...x }));
  const bucket = allStash
    .filter((x) => x.folderId === targetFolderId)
    .sort((a, b) => (b.stashedAt || 0) - (a.stashedAt || 0));
  let newBucket;
  if (beforeStashId) {
    const ix = bucket.findIndex((x) => x.id === beforeStashId);
    if (ix >= 0) {
      newBucket = [...bucket.slice(0, ix), newStash, ...bucket.slice(ix)];
    } else {
      newBucket = [newStash, ...bucket];
    }
  } else {
    newBucket = [newStash, ...bucket];
  }
  const rest = allStash.filter((x) => x.folderId !== targetFolderId);
  const mergedStash = [...rest, ...newBucket];

  try {
    await setStashState({ folders: state.stash.folders, items: mergedStash });
    await addFreqHiddenUrl(nu);
    state.stash = await getStashState();
    state.freqHidden = await getFreqHiddenUrls();
    renderStash();
    renderFreq();
    await updateSyncBanner();
    showToast("已加入暂存");
  } catch (err) {
    showToast(err.message || String(err));
  }
}

function mountFreqPanelDrop(el) {
  el.addEventListener(
    "dragover",
    (e) => {
      if (!dndTypePresent(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("folder-drop--over");
    },
    true
  );
  el.addEventListener(
    "dragleave",
    (e) => {
      if (e.relatedTarget && el.contains(e.relatedTarget)) return;
      el.classList.remove("folder-drop--over");
    },
    true
  );
  el.addEventListener(
    "drop",
    (e) => {
      if (!dndTypePresent(e)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("folder-drop--over");
      const d = parseDnD(e);
      if (!d) return;
      if (d.z === "freq") return;
      if (d.z === "p" && d.id) {
        void (async () => {
          try {
            await setPinnedState({
              folders: state.pinned.folders,
              items: state.pinned.items.filter((p) => p.id !== d.id)
            });
            state.pinned = await getPinnedState();
            renderPinned();
            renderFreq();
            await updateSyncBanner();
            showToast("已从常用中移除（站点仍可按数据出现在「经常访问」）");
          } catch (err) {
            showToast(err.message || String(err));
          }
        })();
        return;
      }
      if (d.z === "stash" && d.id) {
        void (async () => {
          try {
            await setStashState({
              folders: state.stash.folders,
              items: state.stash.items.filter((s) => s.id !== d.id)
            });
            state.stash = await getStashState();
            renderStash();
            renderFreq();
            await updateSyncBanner();
            showToast("已从暂存中移除");
          } catch (err) {
            showToast(err.message || String(err));
          }
        })();
      }
    },
    true
  );
}

// —— 经常访问 —— //

function renderFreq() {
  const root = $("freq-root");
  const empty = $("freq-empty");
  const hint = $("freq-source-hint");
  const hasHistory = state.historyHosts.length > 0;
  hint.textContent = hasHistory
    ? "本机 topSites + 浏览历史 + 同步点击"
    : "本机 topSites + 同步点击";

  const allEntries = buildFreqEntries().filter(freqEntryVisible);
  empty.hidden = allEntries.length > 0;

  root.innerHTML = "";
  const dropShell = document.createElement("div");
  dropShell.className = "folder-drop freq-panel-drop";
  mountFreqPanelDrop(dropShell);

  const grid = document.createElement("div");
  grid.className = "card-grid";
  for (const ent of allEntries) {
    grid.appendChild(renderFreqCard(ent));
  }
  dropShell.appendChild(grid);
  root.appendChild(dropShell);

  if (!allEntries.length) {
    empty.hidden = false;
  }
}

function renderFreqCard(e) {
  const wrap = document.createElement("div");
  wrap.className = "card card--freq";
  wrap.draggable = true;
  wrap.addEventListener("dragstart", (ev) => {
    ev.dataTransfer.setData(
      DND,
      JSON.stringify({
        z: "freq",
        nu: e.nu,
        url: e.url,
        title: e.title
      })
    );
    ev.dataTransfer.effectAllowed = "copyMove";
  });

  const tileActions = document.createElement("div");
  tileActions.className = "tile__actions";
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "mini-btn";
  delBtn.textContent = "删";
  delBtn.title = "从列表中隐藏（可同步）";
  delBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void hideFreqEntry(e.nu);
  });
  tileActions.appendChild(delBtn);

  const link = document.createElement("a");
  link.className = "card__link";
  link.href = e.url;
  link.draggable = false;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.addEventListener("click", async () => {
    await bumpUsage(e.url);
  });

  const img = document.createElement("img");
  img.className = "card__fav";
  img.alt = "";
  setFaviconOnImg(img, e.url);

  const body = document.createElement("div");
  body.className = "card__body";
  const t = document.createElement("p");
  t.className = "card__title";
  t.textContent = e.title;
  const m = document.createElement("p");
  m.className = "card__meta";
  const parts = [hostLabel(e.url)];
  if (e.visits) parts.push(`约 ${Math.round(e.visits)} 次`);
  m.textContent = parts.join(" · ");
  body.appendChild(t);
  body.appendChild(m);

  link.appendChild(img);
  link.appendChild(body);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn--ghost card__add";
  addBtn.textContent = "加入常用";
  addBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void addPinnedFromFreq(e.url, e.title);
  });

  wrap.appendChild(tileActions);
  wrap.appendChild(link);
  wrap.appendChild(addBtn);
  return wrap;
}

async function hideFreqEntry(normalizedUrl) {
  try {
    await addFreqHiddenUrl(normalizedUrl);
    state.freqHidden = await getFreqHiddenUrls();
    renderFreq();
  } catch (err) {
    showToast(err.message || String(err));
  }
}

async function addPinnedAt(
  url,
  title,
  targetFolderId,
  beforeItemId,
  { hideFreqNu = null } = {}
) {
  if (state.pinned.items.some((p) => p.url === url)) {
    showToast("已在常用链接中");
    return;
  }
  const now = Date.now();
  const item = {
    id: crypto.randomUUID(),
    url,
    title: title || hostLabel(url),
    folderId: targetFolderId,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now
  };

  const allPinned = state.pinned.items.map((x) => ({ ...x }));
  let bucket = allPinned
    .filter((x) => x.folderId === targetFolderId)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  if (beforeItemId) {
    const ix = bucket.findIndex((x) => x.id === beforeItemId);
    if (ix >= 0) bucket.splice(ix, 0, item);
    else bucket = [...bucket, item];
  } else {
    bucket = [...bucket, item];
  }
  bucket.forEach((it, i) => {
    it.sortOrder = i;
  });

  const otherFolders = allPinned.filter((x) => x.folderId !== targetFolderId);
  const merged = rebalanceSortOrder([...otherFolders, ...bucket]);

  try {
    await setPinnedState({
      folders: state.pinned.folders,
      items: merged
    });
    state.pinned = await getPinnedState();
    if (hideFreqNu) {
      await addFreqHiddenUrl(hideFreqNu);
      state.freqHidden = await getFreqHiddenUrls();
    }
    renderPinned();
    renderFreq();
    showToast("已加入常用");
    await updateSyncBanner();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

async function addPinnedFromFreq(url, title) {
  await addPinnedAt(url, title, DEFAULT_PIN_FOLDER, null, {});
}

async function newFolder(which) {
  const name = window.prompt('文件夹名称（最多 30 字）', '');
  if (name == null) return;
  const n = name.trim().slice(0, 30);
  if (!n) return;
  const id = crypto.randomUUID();
  if (which === 'pinned') {
    const folders = [
      ...state.pinned.folders,
      { id, name: n, sortOrder: nextSortOrder(state.pinned.folders) }
    ];
    try {
      await setPinnedState({ folders, items: state.pinned.items });
      state.pinned = await getPinnedState();
      renderPinned();
    } catch (e) {
      showToast(e.message || String(e));
    }
  } else if (which === "stash") {
    const folders = [
      ...state.stash.folders,
      {
        id,
        name: n,
        sortOrder: nextSortOrder(state.stash.folders),
        createdAt: Date.now()
      }
    ];
    try {
      await setStashState({ folders, items: state.stash.items });
      state.stash = await getStashState();
      renderStash();
    } catch (e) {
      showToast(e.message || String(e));
    }
  }
}

async function deletePinnedFolder(folderId) {
  if (folderId === DEFAULT_PIN_FOLDER) {
    showToast('默认文件夹不可删除');
    return;
  }
  if (!confirm('删除文件夹？其中条目将移入「默认」文件夹。')) return;
  const items = state.pinned.items.map((it) => ({ ...it }));
  for (const it of items) {
    if (it.folderId === folderId) {
      it.folderId = DEFAULT_PIN_FOLDER;
      it.updatedAt = Date.now();
    }
  }
  const folders = state.pinned.folders.filter((f) => f.id !== folderId);
  try {
    await setPinnedState({ folders, items: rebalanceSortOrder(items) });
    state.pinned = await getPinnedState();
    renderPinned();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

async function deleteStashFolder(folderId) {
  if (folderId === DEFAULT_STASH_FOLDER) {
    showToast('默认文件夹不可删除');
    return;
  }
  if (!confirm('删除文件夹？其中条目将移入「默认」文件夹。')) return;
  const items = state.stash.items.map((it) => ({ ...it }));
  for (const it of items) {
    if (it.folderId === folderId) {
      it.folderId = DEFAULT_STASH_FOLDER;
      it.updatedAt = Date.now();
    }
  }
  const folders = state.stash.folders.filter((f) => f.id !== folderId);
  try {
    await setStashState({ folders, items });
    state.stash = await getStashState();
    renderStash();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

async function loadTopSites() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_TOP_SITES' });
    if (res?.ok) state.topSites = res.sites || [];
    else state.topSites = [];
  } catch {
    state.topSites = [];
  }
}

async function loadHistoryOptional() {
  state.historyHosts = [];
  const has = await chrome.permissions.contains({ permissions: ['history'] });
  if (!has) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_HISTORY_FREQ',
      days: 14
    });
    if (res?.ok && Array.isArray(res.list)) state.historyHosts = res.list;
  } catch {
    /* ignore */
  }
}

async function loadAll() {
  state.pinned = await getPinnedState();
  state.stash = await getStashState();
  state.freqHidden = await getFreqHiddenUrls();
  state.usage = await getUsageScores();
  await loadTopSites();
  await loadHistoryOptional();
}

function bindEvents() {
  $("filter-input").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderPinned();
    renderFreq();
    renderStash();
  });

  $("btn-theme").addEventListener("click", async () => {
    const next = state.theme === "dark" ? "light" : "dark";
    await setSettings({ theme: next });
    await applyThemeFromSettings();
  });

  $("btn-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  $("btn-new-folder-pinned").addEventListener("click", () =>
    void newFolder("pinned")
  );
  $("btn-new-folder-stash").addEventListener("click", () =>
    void newFolder("stash")
  );

  $("form-pinned-manual").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    let url = String(fd.get("url") || "").trim();
    const title = String(fd.get("title") || "").trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    await addPinnedFromFreq(url, title);
    e.target.reset();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" && area !== "local") return;
    const keys = Object.keys(changes);
    if (keys.some((k) => k.startsWith("pn_"))) {
      loadAll().then(() => {
        renderPinned();
        renderFreq();
        renderStash();
        updateSyncBanner();
      });
    }
  });
}

async function init() {
  $("greet").textContent = greet();
  await applyThemeFromSettings();
  await loadAll();
  await updateSyncBanner();
  renderPinned();
  renderFreq();
  renderStash();
  bindEvents();
}

init().catch((e) => {
  console.error(e);
  showToast("加载失败：" + (e.message || e));
});
