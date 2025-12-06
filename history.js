// history.js (safe: no unsafe innerHTML, grouping by day, stable delete/clear/export)
const BROWSER = (typeof browser !== "undefined") ? browser : chrome;
const STORAGE_KEY = "yt_click_history";

function formatIso(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

function prettySeconds(sec) {
  if (sec === undefined || sec === null) return "-";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? `${h}h ` : "") + (m ? `${m}m ` : "") + `${s}s`;
}

function dateKeyFromIso(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getLabelForDateKey(key) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(key + "T00:00:00");
  const diffDays = Math.round((today - target) / (24 * 3600 * 1000));
  if (diffDays === 0) return "Aujourd'hui";
  if (diffDays === 1) return "Hier";
  if (diffDays > 1 && diffDays <= 6) {
    const weekdays = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
    return weekdays[target.getDay()];
  }
  return target.toLocaleDateString('fr-FR', { year: 'numeric', month: 'short', day: 'numeric' });
}

function createEl(tag, opts = {}) {
  const el = document.createElement(tag);
  if (opts.className) el.className = opts.className;
  if (opts.text) el.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v !== null && v !== undefined) el.setAttribute(k, String(v));
    }
  }
  return el;
}

async function loadAndRender() {
  const storage = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
  const arr = storage[STORAGE_KEY] || [];
  const container = document.getElementById("list");
  if (!container) return;

  // clear container
  while (container.firstChild) container.removeChild(container.firstChild);

  if (!arr.length) {
    const p = createEl("p", { className: "small", text: "Aucun enregistrement pour l'instant." });
    container.appendChild(p);
    return;
  }

  // sort desc by clickedAt
  arr.sort((a, b) => new Date(b.clickedAt) - new Date(a.clickedAt));

  // group by day key
  const groups = {};
  for (const e of arr) {
    const k = dateKeyFromIso(e.clickedAt);
    if (!groups[k]) groups[k] = [];
    groups[k].push(e);
  }

  const keys = Object.keys(groups).sort((a, b) => (a < b ? 1 : -1));

  for (const key of keys) {
    const header = createEl("h2", { className: "group-header", text: getLabelForDateKey(key) });
    container.appendChild(header);

    for (const entry of groups[key]) {
      const card = createEl("div", { className: "entry" });

      // thumbnail
      const img = createEl("img");
      img.alt = "miniature";
      img.loading = "lazy";
      try {
        const u = new URL(entry.thumbnail);
        img.src = u.href;
      } catch (e) {
        img.src = "";
      }
      img.style.width = "120px";
      img.style.height = "67px";
      img.style.objectFit = "cover";
      img.style.borderRadius = "6px";

      // meta
      const meta = createEl("div", { className: "meta" });

      const h3 = createEl("h3");
      const a = createEl("a");
      // build resume URL safely: set or update 't' param to seconds if available and leftAt exists
      let resumeHref = "#";
      try {
        const u = new URL(entry.url);
        if (entry.watchedSeconds > 0 && entry.leftAt) {
          // set t param in seconds
          u.searchParams.set('t', String(Math.round(entry.watchedSeconds)));
        }
        resumeHref = u.href;
      } catch (e) {
        // fallback: try to prefix with https if plausible
        try {
          resumeHref = "https://www.youtube.com/watch?v=" + encodeURIComponent(entry.id || "");
        } catch {}
      }
      a.href = resumeHref;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = entry.title || entry.url || "Vidéo YouTube";
      h3.appendChild(a);

      const timeDiv = createEl("div", { className: "time" });
      const opened = createEl("div");
      const openedStrong = createEl("strong", { text: formatIso(entry.clickedAt) });
      opened.textContent = "Ouvert : ";
      opened.appendChild(openedStrong);

      const left = createEl("div");
      const leftVal = entry.leftAt ? formatIso(entry.leftAt) : "-";
      const leftStrong = createEl("strong", { text: leftVal });
      left.textContent = "Quitter : ";
      left.appendChild(leftStrong);

      const pos = createEl("div");
      const posStrong = createEl("strong", { text: prettySeconds(entry.watchedSeconds) });
      pos.textContent = "Position atteinte : ";
      pos.appendChild(posStrong);
      if (entry.leftReason) {
        const spanReason = createEl("span", { text: ` (${entry.leftReason})` });
        pos.appendChild(spanReason);
      }

      timeDiv.appendChild(opened);
      timeDiv.appendChild(left);
      timeDiv.appendChild(pos);

      meta.appendChild(h3);
      meta.appendChild(timeDiv);

      // actions
      const actions = createEl("div", { className: "actions" });
      const deleteBtn = createEl("button", { text: "Supprimer" });
      deleteBtn.className = "delete";
      deleteBtn.dataset.session = entry.sessionId;
      deleteBtn.dataset.id = entry.id;
      actions.appendChild(deleteBtn);

      // assemble card
      card.appendChild(img);
      card.appendChild(meta);
      card.appendChild(actions);

      container.appendChild(card);
    }
  }

  // event delegation for delete buttons
  container.removeEventListener("click", containerClickHandler);
  container.addEventListener("click", containerClickHandler);
}

async function containerClickHandler(ev) {
  const target = ev.target;
  if (!target) return;
  const btn = target.closest && target.closest("button.delete");
  if (!btn) return;
  ev.preventDefault();
  const sessionId = btn.dataset.session;
  if (!sessionId) return;
  if (!confirm("Supprimer cette entrée ?")) return;
  const s = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
  let arr = s[STORAGE_KEY] || [];
  arr = arr.filter(e => e.sessionId !== sessionId);
  await BROWSER.storage.local.set({ [STORAGE_KEY]: arr });
  loadAndRender();
}

document.getElementById("clear-all").addEventListener("click", async () => {
  if (!confirm("Effacer tout l'historique enregistré ?")) return;
  await BROWSER.storage.local.set({ [STORAGE_KEY]: [] });
  loadAndRender();
});

document.getElementById("export-json").addEventListener("click", async () => {
  const s = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
  const arr = s[STORAGE_KEY] || [];
  const blob = new Blob([JSON.stringify(arr, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `yt-history-${new Date().toISOString().slice(0,19)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Ajoute ceci dans history.js (importer + merge)
async function importJsonFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      alert("Fichier JSON invalide : attendu un tableau d'entrées.");
      return;
    }

    // récupérer stockage actuel
    const s = await browser.storage.local.get({ yt_click_history: [] });
    const existing = s.yt_click_history || [];

    // index existant par sessionId (ou fallback par id+clickedAt)
    const idx = new Map();
    for (const e of existing) {
      if (e.sessionId) idx.set(e.sessionId, e);
      else idx.set(`${e.id}::${e.clickedAt}`, e);
    }

    let added = 0, updated = 0;
    for (const e of parsed) {
      if (!e) continue;
      let key = e.sessionId || `${e.id}::${e.clickedAt}`;
      if (idx.has(key)) {
        // fusionner intelligemment : garder valeurs existantes sauf si nouvelle a plus d'infos
        const cur = idx.get(key);
        const merged = Object.assign({}, cur, e);
        // remplacer dans existing
        const pos = existing.findIndex(x => (x.sessionId && x.sessionId === key) || (`${x.id}::${x.clickedAt}` === key));
        if (pos >= 0) existing[pos] = merged;
        updated++;
      } else {
        existing.push(e);
        idx.set(key, e);
        added++;
      }
    }

    await browser.storage.local.set({ yt_click_history: existing });
    alert(`Import terminé. ${added} ajoutées, ${updated} mises à jour.`);
    // re-render si page d'historique ouverte
    if (typeof loadAndRender === "function") loadAndRender();
  } catch (err) {
    console.error("Import error", err);
    alert("Erreur lors de l'import : voir console pour détails.");
  }
}

// liaison UI : si tu as un input file avec id="import-file"
const importInput = document.getElementById("import-file");
if (importInput) {
  importInput.addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) importJsonFile(f);
    importInput.value = "";
  });
}



loadAndRender();

