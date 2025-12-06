// content_script.js (robuste, attend proprement la présence du <video>)
// Principes : waitForElement + safe listener attach + logs
// Modification : Suppression de l'accumulation des secondes regardées. Enregistrement simple de la position actuelle (currentTime) lors de pause, fin ou sortie.
// Nouvelle modification : Amélioration de getTitle pour utiliser l'élément DOM spécifique de YouTube afin d'éviter le titre par défaut "YouTube".
// Ajout : Mise à jour automatique de l'URL du navigateur avec &t= reflétant le temps courant lors de la lecture ou du seek, via history.replaceState pour éviter les rechargements.

const BROWSER = (typeof browser !== "undefined") ? browser : chrome;
const STORAGE_KEY = "yt_click_history";
const HIDDEN_TIMEOUT_MS = 20000;
const REUSE_WINDOW_MS = 5 * 60 * 1000;
let videoEl = null;
let currentSessionId = null;
let hiddenTimer = null;
let lastUpdatedTime = -1; // Pour éviter les mises à jour excessives
const TIME_UPDATE_INTERVAL_MS = 1000; // Mettre à jour l'URL toutes les secondes environ
function log(...args) { console.log("[YT-REC]", ...args); }
// ---------- util: attendre un element (selector) proprement ----------
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const obs = new MutationObserver((mutations) => {
      const found = document.querySelector(selector);
      if (found) {
        obs.disconnect();
        clearTimeout(timer);
        resolve(found);
      }
    });
    obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error("timeout waiting for element: " + selector));
    }, timeout);
  });
}
// ---------- storage helpers (simples) ----------
async function getAllEntries() {
  const s = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
  return s[STORAGE_KEY] || [];
}
async function setAllEntries(arr) {
  await BROWSER.storage.local.set({ [STORAGE_KEY]: arr });
}
function genSessionId() {
  try { return crypto && crypto.randomUUID ? crypto.randomUUID() : `s_${Date.now()}_${Math.floor(Math.random()*1e6)}`; } catch { return `s_${Date.now()}_${Math.floor(Math.random()*1e6)}`; }
}
async function findLastForId(id) {
  const arr = await getAllEntries();
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].id === id) return arr[i];
  }
  return null;
}
async function createEntry({ id, url, title }) {
  const sessionId = genSessionId();
  const clickedAt = new Date().toISOString();
  const e = {
    sessionId,
    id,
    url,
    title,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    clickedAt,
    leftAt: null,
    leftReason: null,
    watchedSeconds: 0
  };
  const arr = await getAllEntries();
  arr.push(e);
  await setAllEntries(arr);
  log("created entry", sessionId, id, title);
  return e;
}
async function patchEntry(sessionId, patch) {
  if (!sessionId) return false;
  const arr = await getAllEntries();
  let found = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].sessionId === sessionId) {
      arr[i] = Object.assign({}, arr[i], patch);
      found = true;
      break;
    }
  }
  if (found) {
    await setAllEntries(arr);
    log("patched", sessionId, patch);
    return true;
  } else {
    log("patch failed - session not found", sessionId, patch);
    return false;
  }
}
// ---------- helpers meta ----------
function getVideoIdFromUrl(url) {
  try { return new URL(url, location.href).searchParams.get("v"); } catch (e) { return null; }
}
async function getTitle() {
  try {
    const titleEl = await waitForElement('h1 yt-formatted-string', 5000); // Attendre l'élément spécifique du titre de la vidéo
    return titleEl ? titleEl.textContent.trim() : (document.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
  } catch (e) {
    log("Error getting title:", e);
    return (document.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim(); // Fallback
  }
}
function currentMetaForId(id) { return { id, url: location.href, title: getTitle() }; } // Note: getTitle est maintenant async, mais currentMetaForId est sync. Ajuster l'usage.
// ---------- Mise à jour de l'URL avec &t= ----------
function updateUrlWithTime(currentTime) {
  const roundedTime = Math.floor(currentTime);
  if (roundedTime === lastUpdatedTime) return; // Éviter les mises à jour inutiles
  lastUpdatedTime = roundedTime;
  const url = new URL(location.href);
  if (roundedTime > 0) {
    url.searchParams.set('t', `${roundedTime}s`); // YouTube accepte 't=10' ou 't=10s', mais 't=10' suffit
  } else {
    url.searchParams.delete('t');
  }
  history.replaceState(null, '', url.toString());
  log("Updated URL with t=", roundedTime);
}

// ---------- backup coordination ----------
// envoie un message au background pour déclencher un téléchargement de sauvegarde
async function requestBackup() {
  try {
    const entries = await getAllEntries();
    // message lourd possible ; on envoie quand même. background gère la création du blob/download.
    browser.runtime.sendMessage && browser.runtime.sendMessage({ action: "backup", entries });
    log("backup requested (sent to background)", (entries || []).length);
  } catch (e) {
    console.error("[YT-REC] requestBackup error", e);
  }
}

function requestBackupIfNeeded() {
  const now = Date.now();
  if (now - lastBackupAt < BACKUP_MIN_INTERVAL_MS) {
    // trop récent -> ignorer
    return;
  }
  lastBackupAt = now;
  requestBackup().catch(()=>{});
}



// ---------- main: safe attach to video element ----------
async function attachToVideoSafely() {
  try {
    videoEl = await waitForElement("video", 15000); // attend jusqu'à 15s
    if (!videoEl) {
      log("No video element found after wait");
      return;
    }
    log("video element acquired");
    // handler wrappers with null-safe operations
    async function onPlay() {
      try {
        const vid = getVideoIdFromUrl(location.href);
        if (!vid) { log("play but no vid"); return; }
        if (!currentSessionId) {
          const last = await findLastForId(vid);
          if (last && !last.leftAt) {
            currentSessionId = last.sessionId;
            log("Reusing open session", currentSessionId);
          } else if (last && last.leftAt) {
            const leftTs = new Date(last.leftAt).getTime();
            if (!isNaN(leftTs) && (Date.now() - leftTs) <= REUSE_WINDOW_MS) {
              await patchEntry(last.sessionId, { leftAt: null, leftReason: "reopened" });
              currentSessionId = last.sessionId;
              log("Reopened recent session", currentSessionId);
            } else {
              const meta = { id: vid, url: location.href, title: await getTitle() }; // Attendre le titre ici
              const created = await createEntry(meta);
              currentSessionId = created.sessionId;
            }
          } else {
            const meta = { id: vid, url: location.href, title: await getTitle() }; // Attendre le titre ici
            const created = await createEntry(meta);
            currentSessionId = created.sessionId;
          }
        }
        cancelHiddenTimer();
        log("onPlay -> session", currentSessionId);
      } catch (e) {
        console.error("[YT-REC] onPlay error", e);
      }
    }
    async function onPause() {
      try {
        if (currentSessionId && videoEl) {
          const position = Math.round(videoEl.currentTime || 0);
          await patchEntry(currentSessionId, { watchedSeconds: position });
          log("onPause -> position recorded", position);
          updateUrlWithTime(position); // Mettre à jour l'URL sur pause
          requestBackupIfNeeded();

        }
      } catch (e) { console.error("[YT-REC] onPause error", e); }
    }
    async function onEnded() {
      try {
        if (currentSessionId && videoEl) {
          const position = Math.round(videoEl.currentTime || 0);
          const iso = new Date().toISOString();
          await patchEntry(currentSessionId, { leftAt: iso, leftReason: "ended", watchedSeconds: position });
          log("onEnded -> closed session", currentSessionId, "position", position);
          currentSessionId = null;
          updateUrlWithTime(position); // Mettre à jour l'URL sur fin
          requestBackupIfNeeded();
        }
      } catch (e) { console.error("[YT-REC] onEnded error", e); }
    }
    function onTimeUpdate() {
      try {
        if (videoEl && !videoEl.paused) {
          updateUrlWithTime(videoEl.currentTime);
        }
      } catch (e) { console.error("[YT-REC] onTimeUpdate error", e); }
    }
    // detach first to be safe (we always check existence)
    try { videoEl.removeEventListener("play", onPlay); } catch {}
    try { videoEl.removeEventListener("pause", onPause); } catch {}
    try { videoEl.removeEventListener("ended", onEnded); } catch {}
    try { videoEl.removeEventListener("timeupdate", onTimeUpdate); } catch {}
    // attach listeners safely
    try { videoEl.addEventListener("play", onPlay); } catch (e) { console.error("[YT-REC] fail attach play", e); }
    try { videoEl.addEventListener("pause", onPause); } catch (e) { console.error("[YT-REC] fail attach pause", e); }
    try { videoEl.addEventListener("ended", onEnded); } catch (e) { console.error("[YT-REC] fail attach ended", e); }
    try { videoEl.addEventListener("timeupdate", onTimeUpdate); } catch (e) { console.error("[YT-REC] fail attach timeupdate", e); }
  } catch (err) {
    console.error("[YT-REC] attachToVideoSafely error", err);
  }
}
// ---------- visibility/unload ----------
function startHiddenTimer() {
  if (!currentSessionId) return;
  cancelHiddenTimer();
  hiddenTimer = setTimeout(async () => {
    try {
      if (videoEl) {
        const position = Math.round(videoEl.currentTime || 0);
        const iso = new Date().toISOString();
        await patchEntry(currentSessionId, { leftAt: iso, leftReason: "hidden_timeout", watchedSeconds: position });
        log("hidden_timeout -> closed", currentSessionId, "position", position);
        currentSessionId = null;
        updateUrlWithTime(position); // Mettre à jour l'URL sur timeout caché
        requestBackupIfNeeded();

      }
    } catch (e) { console.error("[YT-REC] hiddenTimer error", e); }
  }, HIDDEN_TIMEOUT_MS);
}
function cancelHiddenTimer() { if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; } }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") startHiddenTimer();
  else cancelHiddenTimer();
});
window.addEventListener("beforeunload", async () => {
  if (!currentSessionId) return;
  if (videoEl) {
    const position = Math.round(videoEl.currentTime || 0);
    const iso = new Date().toISOString();
    await patchEntry(currentSessionId, { leftAt: iso, leftReason: "unload", watchedSeconds: position });
    log("beforeunload closed", currentSessionId, "position", position);
    updateUrlWithTime(position); // Mettre à jour l'URL sur déchargement
    requestBackupIfNeeded();
  }
  currentSessionId = null;
});

// periodic backup (sauvegarde de sécurité toutes les X minutes)
setInterval(() => {
  requestBackupIfNeeded();
}, 5 * 60 * 1000); // toutes les 5 minutes

// initial attach (garde ta logique SPA existante)
setTimeout(() => {
  attachToVideoSafely().catch(()=>{});
}, 600);

// ---------- SPA watcher: detect navigation and attach to video ----------
(function watchUrl() {
  let last = location.href;
  const check = () => {
    if (location.href !== last) {
      last = location.href;
      setTimeout(() => {
        log("SPA navigation detected -> trying to attach to video");
        attachToVideoSafely();
      }, 300);
    }
  };
  const _p = history.pushState; history.pushState = function(){ _p.apply(this, arguments); check(); };
  const _r = history.replaceState; history.replaceState = function(){ _r.apply(this, arguments); check(); };
  window.addEventListener("popstate", check);
  setInterval(check, 1200);
  // initial attach attempt
  setTimeout(() => {
    log("initial attach attempt");
    attachToVideoSafely();
  }, 600);
})();
