/**
 * chrome.storage.sync 封装：分片、配额检测、失败时可降级到 local（仅本机）。
 * v2：常用 / 暂存为 { folders, items }；经常访问的「删除」为隐藏列表 pn_freq_hidden_v1。
 */

const SYNC_KEYS = {
  pinnedV1: "pn_pinned_v1",
  pinnedV2: "pn_pinned_v2",
  stashMeta: "pn_stash_meta_v1",
  stashPrefix: "pn_stash_chunk_",
  freqHidden: "pn_freq_hidden_v1",
  usage: "pn_usage_v1",
  settings: "pn_settings_v1"
};

const LOCAL_KEYS = {
  pinnedOverflow: "pn_pinned_overflow_local",
  pinnedOverflowFlag: "pn_pinned_sync_unavailable",
  stashOverflow: "pn_stash_overflow_local",
  stashOverflowFlag: "pn_stash_sync_unavailable"
};

const CHUNK_SIZE = 6000;

const DEFAULT_PIN_FOLDER = "pn-folder-pin-default";
const DEFAULT_STASH_FOLDER = "pn-folder-stash-default";

function _hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function _migratePinnedV1Array(arr) {
  const folders = [
    { id: DEFAULT_PIN_FOLDER, name: "默认", sortOrder: 0, createdAt: Date.now() }
  ];
  const items = (arr || []).map((it, i) => ({
    id: it.id || `pin-${Date.now()}-${i}`,
    url: it.url,
    title: it.title || _hostFromUrl(it.url),
    folderId: DEFAULT_PIN_FOLDER,
    sortOrder: it.sortOrder ?? i,
    createdAt: it.createdAt || Date.now(),
    updatedAt: it.updatedAt || Date.now()
  }));
  return { version: 2, folders, items };
}

function _migrateStashV1Array(arr) {
  const folders = [
    {
      id: DEFAULT_STASH_FOLDER,
      name: "默认",
      sortOrder: 0,
      createdAt: Date.now()
    }
  ];
  const items = (arr || []).map((s) => {
    const pt = s.title || _hostFromUrl(s.url);
    return {
      id: s.id || `stash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      url: s.url,
      pageTitle: pt,
      label: pt,
      folderId: DEFAULT_STASH_FOLDER,
      note: s.note || "",
      stashedAt: s.stashedAt || Date.now(),
      updatedAt: s.updatedAt || s.stashedAt || Date.now()
    };
  });
  return { version: 2, folders, items };
}

function _emptyPinnedState() {
  return _migratePinnedV1Array([]);
}

function _emptyStashState() {
  return _migrateStashV1Array([]);
}

async function _removeStashChunkKeys() {
  const all = await chrome.storage.sync.get(null);
  const removals = [];
  for (const k of Object.keys(all)) {
    if (k.startsWith(SYNC_KEYS.stashPrefix)) removals.push(k);
  }
  if (removals.length) await chrome.storage.sync.remove(removals);
}

async function _writeStashBundleToSync(bundle) {
  const raw = JSON.stringify(bundle);
  const chunks = [];
  for (let i = 0; i < raw.length; i += CHUNK_SIZE)
    chunks.push(raw.slice(i, i + CHUNK_SIZE));
  if (!chunks.length) chunks.push("");
  const meta = {
    version: 2,
    chunkCount: chunks.length,
    updatedAt: Date.now()
  };
  const payload = { [SYNC_KEYS.stashMeta]: meta };
  for (let i = 0; i < chunks.length; i++)
    payload[`${SYNC_KEYS.stashPrefix}${i}`] = chunks[i];
  await chrome.storage.sync.set(payload);
}

function _parseStashRaw(raw) {
  try {
    const data = JSON.parse(raw || "{}");
    if (Array.isArray(data)) return _migrateStashV1Array(data);
    if (data && Array.isArray(data.folders) && Array.isArray(data.items))
      return { version: 2, folders: data.folders, items: data.items };
    return _emptyStashState();
  } catch {
    return _emptyStashState();
  }
}

export async function getPinnedState() {
  const fl = await chrome.storage.local.get(LOCAL_KEYS.pinnedOverflowFlag);
  let raw = null;
  if (fl[LOCAL_KEYS.pinnedOverflowFlag]) {
    const o = await chrome.storage.local.get(LOCAL_KEYS.pinnedOverflow);
    raw = o[LOCAL_KEYS.pinnedOverflow];
    if (Array.isArray(raw)) raw = _migratePinnedV1Array(raw);
  } else {
    const r = await chrome.storage.sync.get([SYNC_KEYS.pinnedV2, SYNC_KEYS.pinnedV1]);
    if (r[SYNC_KEYS.pinnedV2] && r[SYNC_KEYS.pinnedV2].folders)
      raw = r[SYNC_KEYS.pinnedV2];
    else if (Array.isArray(r[SYNC_KEYS.pinnedV1]))
      raw = _migratePinnedV1Array(r[SYNC_KEYS.pinnedV1]);
    else {
      const o = await chrome.storage.local.get(LOCAL_KEYS.pinnedOverflow);
      if (o[LOCAL_KEYS.pinnedOverflow]?.folders) raw = o[LOCAL_KEYS.pinnedOverflow];
      else if (Array.isArray(o[LOCAL_KEYS.pinnedOverflow]))
        raw = _migratePinnedV1Array(o[LOCAL_KEYS.pinnedOverflow]);
    }
  }
  if (Array.isArray(raw)) raw = _migratePinnedV1Array(raw);
  if (!raw || !raw.folders) return _emptyPinnedState();
  return {
    version: 2,
    folders: raw.folders,
    items: Array.isArray(raw.items) ? raw.items : []
  };
}

export async function setPinnedState(state) {
  const payload = {
    version: 2,
    folders: state.folders || [],
    items: state.items || []
  };
  try {
    await chrome.storage.sync.set({ [SYNC_KEYS.pinnedV2]: payload });
    await chrome.storage.sync.remove(SYNC_KEYS.pinnedV1).catch(() => {});
    await chrome.storage.local.remove([
      LOCAL_KEYS.pinnedOverflow,
      LOCAL_KEYS.pinnedOverflowFlag
    ]);
  } catch (e) {
    if (_isQuotaError(e)) {
      await chrome.storage.sync
        .remove([SYNC_KEYS.pinnedV2, SYNC_KEYS.pinnedV1])
        .catch(() => {});
      await chrome.storage.local.set({
        [LOCAL_KEYS.pinnedOverflow]: payload,
        [LOCAL_KEYS.pinnedOverflowFlag]: true
      });
      throw new Error(
        "SYNC_QUOTA:常用链接已写入本机仅（不同步），请减少条目或缩短标题。"
      );
    }
    throw e;
  }
}

export async function getStashState() {
  const flag = await chrome.storage.local.get(LOCAL_KEYS.stashOverflowFlag);
  if (flag[LOCAL_KEYS.stashOverflowFlag]) {
    const lo = await chrome.storage.local.get(LOCAL_KEYS.stashOverflow);
    const data = lo[LOCAL_KEYS.stashOverflow];
    if (data?.folders && data.items) return _parseStashRaw(JSON.stringify(data));
    if (Array.isArray(data)) return _migrateStashV1Array(data);
    return _emptyStashState();
  }
  const meta = (await chrome.storage.sync.get(SYNC_KEYS.stashMeta))[
    SYNC_KEYS.stashMeta
  ];
  if (!meta || !meta.chunkCount) {
    const local = await chrome.storage.local.get(LOCAL_KEYS.stashOverflow);
    const data = local[LOCAL_KEYS.stashOverflow];
    if (data?.folders && data.items) return _parseStashRaw(JSON.stringify(data));
    if (Array.isArray(data)) return _migrateStashV1Array(data);
    return _emptyStashState();
  }
  const keys = [];
  for (let i = 0; i < meta.chunkCount; i++)
    keys.push(`${SYNC_KEYS.stashPrefix}${i}`);
  const parts = await chrome.storage.sync.get(keys);
  let raw = "";
  for (let i = 0; i < meta.chunkCount; i++) {
    const piece = parts[`${SYNC_KEYS.stashPrefix}${i}`];
    if (typeof piece === "string") raw += piece;
  }
  return _parseStashRaw(raw);
}

async function _clearStashFromSync() {
  const all = await chrome.storage.sync.get(null);
  const rm = Object.keys(all).filter(
    (k) => k === SYNC_KEYS.stashMeta || k.startsWith(SYNC_KEYS.stashPrefix)
  );
  if (rm.length) await chrome.storage.sync.remove(rm);
}

export async function setStashState(state) {
  const bundle = {
    version: 2,
    folders: state.folders || [],
    items: state.items || []
  };
  try {
    await _removeStashChunkKeys();
    await _writeStashBundleToSync(bundle);
    await chrome.storage.local.remove([
      LOCAL_KEYS.stashOverflow,
      LOCAL_KEYS.stashOverflowFlag
    ]);
  } catch (e) {
    if (_isQuotaError(e)) {
      await _clearStashFromSync().catch(() => {});
      await chrome.storage.local.set({
        [LOCAL_KEYS.stashOverflow]: bundle,
        [LOCAL_KEYS.stashOverflowFlag]: true
      });
      throw new Error(
        "SYNC_QUOTA:暂存列表已部分写入本机仅（不同步），请删除旧条目。"
      );
    }
    throw e;
  }
}

/**
 * 供 background 调用：将一条暂存加入「默认」文件夹（首个 sortOrder 最小或 id 为 DEFAULT_STASH_FOLDER）。
 */
export async function appendStashFromTab({ url, title }) {
  const state = await getStashState();
  let def = state.folders.find((f) => f.id === DEFAULT_STASH_FOLDER);
  if (!def && state.folders.length)
    def = [...state.folders].sort(
      (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)
    )[0];
  if (!def) {
    def = {
      id: DEFAULT_STASH_FOLDER,
      name: "默认",
      sortOrder: 0,
      createdAt: Date.now()
    };
    state.folders = [def];
  }
  const folderId = def.id;
  const pt = title || _hostFromUrl(url);
  const now = Date.now();
  const item = {
    id: crypto.randomUUID(),
    url,
    pageTitle: pt,
    label: pt,
    folderId,
    note: "",
    stashedAt: now,
    updatedAt: now
  };
  state.items = [item, ...(state.items || [])];
  await setStashState(state);
  return item;
}

export async function getUsageScores() {
  const r = await chrome.storage.sync.get(SYNC_KEYS.usage);
  const u = r[SYNC_KEYS.usage];
  if (u && typeof u === "object") return u;
  return {};
}

async function setUsageScores(scores) {
  try {
    await chrome.storage.sync.set({ [SYNC_KEYS.usage]: scores });
  } catch (e) {
    if (_isQuotaError(e)) {
      const pruned = _pruneUsage(scores, 80);
      await chrome.storage.sync.set({ [SYNC_KEYS.usage]: pruned });
    } else throw e;
  }
}

function _pruneUsage(scores, maxKeys) {
  const entries = Object.entries(scores).sort(
    (a, b) => (b[1].c || 0) - (a[1].c || 0)
  );
  const out = {};
  for (let i = 0; i < Math.min(maxKeys, entries.length); i++) {
    const [k, v] = entries[i];
    out[k] = { c: v.c, updatedAt: v.updatedAt };
  }
  return out;
}

export async function bumpUsage(url) {
  if (!url) return;
  const key = _normalizeUrl(url);
  const scores = await getUsageScores();
  const cur = scores[key] || { c: 0, updatedAt: Date.now() };
  scores[key] = { c: (cur.c || 0) + 1, updatedAt: Date.now() };
  await setUsageScores(scores);
}

export function normalizeUrlForUsage(url) {
  return _normalizeUrl(url);
}

function _normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

function _isQuotaError(e) {
  const msg = String(e && e.message);
  return msg.includes("QUOTA") || msg.includes("quota");
}

export async function getSettings() {
  const r = await chrome.storage.sync.get(SYNC_KEYS.settings);
  const s = r[SYNC_KEYS.settings];
  return {
    theme: s?.theme === "dark" ? "dark" : "light"
  };
}

export async function setSettings(partial) {
  const cur = await getSettings();
  await chrome.storage.sync.set({
    [SYNC_KEYS.settings]: { ...cur, ...partial }
  });
}

/** 经常访问中用户点击「删除」隐藏的规范化 URL 列表（最多 200 条以控制配额）。 */
export async function getFreqHiddenUrls() {
  const r = await chrome.storage.sync.get(SYNC_KEYS.freqHidden);
  const arr = r[SYNC_KEYS.freqHidden];
  if (Array.isArray(arr)) return new Set(arr.map((x) => String(x)));
  return new Set();
}

export async function addFreqHiddenUrl(normalizedUrl) {
  if (!normalizedUrl) return;
  const s = await getFreqHiddenUrls();
  s.add(normalizedUrl);
  const list = [...s].slice(0, 200);
  await chrome.storage.sync.set({ [SYNC_KEYS.freqHidden]: list });
}

export async function clearAllUserData() {
  const allSync = await chrome.storage.sync.get(null);
  const toRemove = Object.keys(allSync).filter((k) => k.startsWith("pn_"));
  if (toRemove.length) await chrome.storage.sync.remove(toRemove);
  await chrome.storage.local.remove([
    LOCAL_KEYS.pinnedOverflow,
    LOCAL_KEYS.pinnedOverflowFlag,
    LOCAL_KEYS.stashOverflow,
    LOCAL_KEYS.stashOverflowFlag,
    "pn_top_sites_cache_local"
  ]);
}

export async function isStashLocalOnly() {
  const f = await chrome.storage.local.get(LOCAL_KEYS.stashOverflowFlag);
  return !!f[LOCAL_KEYS.stashOverflowFlag];
}

export async function isPinnedLocalOnly() {
  const f = await chrome.storage.local.get(LOCAL_KEYS.pinnedOverflowFlag);
  return !!f[LOCAL_KEYS.pinnedOverflowFlag];
}

export { DEFAULT_STASH_FOLDER, DEFAULT_PIN_FOLDER };
