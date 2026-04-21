import { clearAllUserData } from "./lib/storage-sync.js";

const historyStatus = document.getElementById("history-status");
const clearMsg = document.getElementById("clear-msg");

async function refreshHistoryStatus() {
  const has = await chrome.permissions.contains({
    permissions: ["history"]
  });
  historyStatus.textContent = has
    ? "当前已授予「历史记录」权限。"
    : "当前未授予；新标签页的「经常访问」仅使用 topSites 与扩展内点击统计。";
}

document.getElementById("btn-history-on").addEventListener("click", async () => {
  historyStatus.textContent = "";
  const ok = await chrome.permissions.request({ permissions: ["history"] });
  historyStatus.textContent = ok ? "已授予，请刷新新标签页以加载历史聚合。" : "未授予。";
});

document.getElementById("btn-history-off").addEventListener("click", async () => {
  historyStatus.textContent = "";
  const ok = await chrome.permissions.remove({ permissions: ["history"] });
  historyStatus.textContent = ok ? "已移除权限。" : "移除失败或本未授权。";
});

document.getElementById("btn-clear").addEventListener("click", async () => {
  if (
    !confirm(
      "确定清除个人导航站在本机的全部数据？（包括 sync 与降级到 local 的列表）"
    )
  ) {
    return;
  }
  clearMsg.textContent = "";
  try {
    await clearAllUserData();
    clearMsg.textContent = "已清除。";
  } catch (e) {
    clearMsg.textContent = e.message || String(e);
  }
});

refreshHistoryStatus();
