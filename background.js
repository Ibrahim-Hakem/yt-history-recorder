// background.js (handler simple pour sauvegarde JSON)
const BROWSER = (typeof browser !== "undefined") ? browser : chrome;

browser.runtime.onMessage.addListener(async (message, sender) => {
  try {
    if (!message || message.action !== "backup") return;
    const entries = message.entries || [];
    // build blob
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const filename = `yt-history-backup-${new Date().toISOString().slice(0,19)}.json`.replace(/[:]/g, "-");
    // trigger download (best-effort)
    if (browser.downloads && browser.downloads.download) {
      await browser.downloads.download({
        url,
        filename,
        conflictAction: "overwrite",
        saveAs: false
      });
      // revoke after a short delay
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      console.log("[YT-REC background] backup saved:", filename);
    } else {
      console.warn("[YT-REC background] downloads API not available");
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    console.error("[YT-REC background] backup error", e);
  }
});
