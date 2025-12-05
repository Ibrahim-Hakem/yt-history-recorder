const BROWSER = (typeof browser !== "undefined") ? browser : chrome;
const STORAGE_KEY = "yt_click_history";

function formatIso(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString();
}

function durationBetween(startIso, endIso) {
  if (!startIso || !endIso) return "-";
  const s = new Date(startIso);
  const e = new Date(endIso);
  const sec = Math.max(0, Math.round((e - s) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s2 = sec % 60;
  return (h ? `${h}h ` : "") + (m ? `${m}m ` : "") + `${s2}s`;
}

async function loadAndRender() {
  const storage = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
  const arr = storage[STORAGE_KEY] || [];
  const container = document.getElementById("list");
  container.innerHTML = "";

  if (!arr.length) {
    container.innerHTML = "<p class='small'>Aucun enregistrement pour l'instant.</p>";
    return;
  }

  // trier par date décroissante
  arr.sort((a, b) => new Date(b.clickedAt) - new Date(a.clickedAt));

  arr.forEach((entry, idx) => {
    const el = document.createElement("div");
    el.className = "entry";

    el.innerHTML = `
      <img src="${entry.thumbnail}" alt="miniature" loading="lazy" />
      <div class="meta">
        <h3><a href="${entry.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.title || entry.url)}</a></h3>
        <div class="time">
          <div>Ouvert : <strong>${formatIso(entry.clickedAt)}</strong></div>
          <div>Quitter : <strong>${entry.leftAt ? formatIso(entry.leftAt) : "-"}</strong> &nbsp; Durée : <strong>${durationBetween(entry.clickedAt, entry.leftAt)}</strong></div>
        </div>
      </div>
      <div class="actions">
        <button data-idx="${idx}" class="delete">Supprimer</button>
      </div>
    `;

    container.appendChild(el);
  });

  // bind delete buttons
  Array.from(document.querySelectorAll("button.delete")).forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      const idx = parseInt(btn.getAttribute("data-idx"), 10);
      if (!confirm("Supprimer cette entrée ?")) return;
      const storage = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
      const arr = storage[STORAGE_KEY] || [];
      // comme on a trié, idx correspond à index dans arr trié; pour simplicité, on recalculera à partir de sorted
      arr.sort((a,b) => new Date(b.clickedAt) - new Date(a.clickedAt));
      arr.splice(idx, 1);
      await BROWSER.storage.local.set({ [STORAGE_KEY]: arr });
      loadAndRender();
    });
  });
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

document.getElementById("clear-all").addEventListener("click", async () => {
  if (!confirm("Effacer tout l'historique enregistré ?")) return;
  await BROWSER.storage.local.set({ [STORAGE_KEY]: [] });
  loadAndRender();
});

document.getElementById("export-json").addEventListener("click", async () => {
  const storage = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
  const arr = storage[STORAGE_KEY] || [];
  const blob = new Blob([JSON.stringify(arr, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `yt-history-${new Date().toISOString().slice(0,19)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Init
loadAndRender();

