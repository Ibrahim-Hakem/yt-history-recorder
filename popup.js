const BROWSER = (typeof browser !== "undefined") ? browser : chrome;
document.getElementById("open-history").addEventListener("click", () => {
  // envoie un message au background pour ouvrir history.html
  BROWSER.runtime.sendMessage({ type: "open-history" });
  window.close();
});

document.getElementById("clear-all").addEventListener("click", async () => {
  if (!confirm("Effacer tout l'historique YouTube enregistré ?")) return;
  await BROWSER.storage.local.set({ yt_click_history: [] });
  alert("Historique effacé.");
  window.close();
});

document.getElementById("export-json").addEventListener("click", async () => {
  const storage = await BROWSER.storage.local.get({ yt_click_history: [] });
  const arr = storage.yt_click_history || [];
  const blob = new Blob([JSON.stringify(arr, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `yt-history-${new Date().toISOString().slice(0,19)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  window.close();
});

