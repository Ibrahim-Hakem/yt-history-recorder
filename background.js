// background.js (robuste) - gère backup + open-history
const BROWSER = (typeof browser !== "undefined") ? browser : chrome;

async function handleBackup(message) {
  try {
    const entries = message.entries || [];
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const filename = `yt-history-backup-${new Date().toISOString().slice(0,19)}.json`.replace(/[:]/g, "-");

    if (BROWSER.downloads && BROWSER.downloads.download) {
      await BROWSER.downloads.download({
        url,
        filename,
        conflictAction: "overwrite",
        saveAs: false
      });
      // revoke later
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      console.log("[YT-REC background] backup saved:", filename);
    } else {
      console.warn("[YT-REC background] downloads API not available");
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    console.error("[YT-REC background] backup error", e);
  }
}

async function openHistoryPage() {
  try {
    const url = BROWSER.runtime.getURL("history.html");
    // try to find an existing tab with this URL
    if (BROWSER.tabs && BROWSER.tabs.query) {
      try {
        const tabs = await BROWSER.tabs.query({ url: url });
        if (tabs && tabs.length) {
          // focus the first matching tab
          const t = tabs[0];
          await BROWSER.tabs.update(t.id, { active: true });
          if (typeof BROWSER.windows !== "undefined") {
            await BROWSER.windows.update(t.windowId, { focused: true });
          }
          console.log("[YT-REC background] focused existing history tab");
          return;
        }
      } catch (qerr) {
        // some browsers may not allow query({url}) for extension html; fallback to creating
        console.warn("[YT-REC background] tabs.query failed:", qerr);
      }
    }
    // create a new tab
    if (BROWSER.tabs && BROWSER.tabs.create) {
      await BROWSER.tabs.create({ url });
      console.log("[YT-REC background] opened history.html in new tab");
    } else {
      // fallback: open a window
      if (BROWSER.windows && BROWSER.windows.create) {
        await BROWSER.windows.create({ url });
        console.log("[YT-REC background] opened history.html in new window");
      } else {
        console.error("[YT-REC background] cannot open history page: tabs/windows API not available");
      }
    }
  } catch (e) {
    console.error("[YT-REC background] openHistoryPage error", e);
  }
}

BROWSER.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (!message) return;

    // Backup message (old behaviour)
    if (message.action === "backup") {
      handleBackup(message).catch(err => console.error("[YT-REC background] handleBackup error", err));
      return; // no response required
    }

    // Open history request (support both { type: "open-history" } and { action: "open-history" })
    if (message.type === "open-history" || message.action === "open-history") {
      openHistoryPage().catch(err => console.error("[YT-REC background] openHistoryPage error", err));
      return;
    }

    // future messages can be handled here
  } catch (e) {
    console.error("[YT-REC background] onMessage handler error", e);
  }
});
