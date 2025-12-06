// content_script.js (version intégrale et robuste)
// - Stockage résilient (getAll/setAll/create/patch) avec try/catch
// - Backup best-effort via runtime.sendMessage({action:"backup", entries})
// - Variables manquantes ajoutées (lastBackupAt, BACKUP_MIN_INTERVAL_MS)
// - getTitle + getCurrentMeta corrigés (async)
// - attachToVideoSafely: attachement propre + listeners robustes
// - visibility / beforeunload handlers appellent patchEntry et requestBackupIfNeeded
// - defensive programming : pas d'exception non captée

/* globals browser, chrome */
const BROWSER = (typeof browser !== "undefined") ? browser : chrome;
const STORAGE_KEY = "yt_click_history";

const HIDDEN_TIMEOUT_MS = 20000;
const REUSE_WINDOW_MS = 5 * 60 * 1000;
const BACKUP_MIN_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes minimum entre backups
let lastBackupAt = 0;

let videoEl = null;
let currentSessionId = null;
let hiddenTimer = null;

function log(...args) { console.log("[YT-REC]", ...args); }


/* ---------- getStableMeta(videoId) : récupère titre + chaîne + date de publication ---------- */
/* Utilise JSON-LD, DOM selectors, meta tags, puis oEmbed en fallback (best-effort) */
async function getStableMeta(videoId) {
  const result = {
    videoId: videoId || null,
    title: "",
    channelName: "",
    uploadDate: "", // format ISO si présent
    uniqueLabel: ""
  };

  // helper safe JSON parse
  function tryParseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  // 1) tenter JSON-LD (le plus fiable sur la page)
  try {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of scripts) {
      const data = tryParseJson(s.textContent);
      if (!data) continue;
      // data can be object or array
      const candidates = Array.isArray(data) ? data : [data];
      for (const c of candidates) {
        if (!c) continue;
        // Look for VideoObject
        if (c['@type'] === 'VideoObject' || (c['@type'] && c['@type'].toLowerCase().includes('video'))) {
          if (!result.title && c.name) result.title = String(c.name).trim();
          if (!result.channelName && c.author) {
            if (typeof c.author === 'string') result.channelName = c.author.trim();
            else if (c.author.name) result.channelName = String(c.author.name).trim();
          }
          if (!result.uploadDate && c.uploadDate) result.uploadDate = String(c.uploadDate).trim();
        }
      }
      if (result.title || result.channelName) break;
    }
  } catch (e) { /* silent */ }

  // 2) DOM selectors (YouTube specific)
  try {
    if (!result.title) {
      const tit = document.querySelector('h1 yt-formatted-string') || document.querySelector('#container h1 yt-formatted-string');
      if (tit && tit.textContent) result.title = tit.textContent.trim();
    }
    if (!result.channelName) {
      // multiple selectors because YouTube DOM can change
      const ch = document.querySelector('ytd-channel-name a') ||
                 document.querySelector('#meta-contents ytd-channel-name a') ||
                 document.querySelector('ytd-video-owner-renderer a#text') ||
                 document.querySelector('ytd-video-owner-renderer yt-formatted-string.ytd-video-owner-renderer');
      if (ch && ch.textContent) result.channelName = ch.textContent.trim();
    }
    // upload date visible sometimes in #info-strings or meta
    if (!result.uploadDate) {
      // try to parse a visible date in the UI
      const dateEl = document.querySelector('#info-strings yt-formatted-string') || document.querySelector('#date yt-formatted-string');
      if (dateEl && dateEl.textContent) {
        // not ISO — keep human text as fallback
        result.uploadDate = dateEl.textContent.trim();
      }
    }
  } catch (e) { /* silent */ }

  // 3) meta tags fallback
  try {
    if (!result.title) {
      const m = document.querySelector('meta[property="og:title"], meta[name="title"], meta[name="twitter:title"]');
      if (m && (m.content || m.getAttribute('content'))) result.title = (m.content || m.getAttribute('content')).trim();
    }
    if (!result.channelName) {
      const ma = document.querySelector('meta[name="author"]');
      if (ma && ma.content) result.channelName = ma.content.trim();
    }
  } catch (e) { /* silent */ }

  // 4) Optional fallback: oEmbed (best-effort). Fetch may be blocked by CORS; protect with try/catch.
  if ((!result.title || !result.channelName) && videoId) {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
      const resp = await fetch(oembedUrl, { method: 'GET' });
      if (resp && resp.ok) {
        const j = await resp.json();
        if (!result.title && j.title) result.title = String(j.title).trim();
        if (!result.channelName && (j.author_name || j.author)) result.channelName = String(j.author_name || j.author).trim();
      }
    } catch (e) {
      // oEmbed may be blocked by CORS — ignore silently
    }
  }

  // 5) final fallback to document.title
  try {
    if (!result.title) result.title = (document.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
  } catch (e) { /* ignore */ }

  // Normalize uploadDate: try to extract ISO from known sources (ld+json already gave ISO) else keep string
  // Construct a uniqueLabel for display/search
  const datePart = result.uploadDate ? (` ${result.uploadDate.slice(0,10)}`) : "";
  const channelPart = result.channelName ? (` — ${result.channelName}`) : "";
  result.uniqueLabel = `${result.title || "(sans titre)"}${channelPart}${datePart}`;

  return result;
}


/* ---------- util : waitForElement ---------- */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    try {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
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
    } catch (e) {
      reject(e);
    }
  });
}

/* ---------- storage helpers (robustes) ---------- */
async function getAllEntries() {
  try {
    const s = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
    return s[STORAGE_KEY] || [];
  } catch (e) {
    console.error("[YT-REC] getAllEntries error", e);
    return [];
  }
}
async function setAllEntries(arr) {
  try {
    await BROWSER.storage.local.set({ [STORAGE_KEY]: arr || [] });
    return true;
  } catch (e) {
    console.error("[YT-REC] setAllEntries error", e);
    return false;
  }
}

function genSessionId() {
  try { return crypto && crypto.randomUUID ? crypto.randomUUID() : `s_${Date.now()}_${Math.floor(Math.random()*1e6)}`; }
  catch { return `s_${Date.now()}_${Math.floor(Math.random()*1e6)}`; }
}

async function findLastForId(id) {
  try {
    const arr = await getAllEntries();
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].id === id) return arr[i];
    }
  } catch (e) {
    console.error("[YT-REC] findLastForId error", e);
  }
  return null;
}

async function createEntry({ id, url, title }) {
  // id = videoId
  try {
    // call stable meta to enrich stored entry
    const stable = await getStableMeta(id);
    const sessionId = genSessionId();
    const clickedAt = new Date().toISOString();
    const e = {
      sessionId,
      id,
      url,
      title: stable.title || title || "",
      channelName: stable.channelName || "",
      uploadDate: stable.uploadDate || "",
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      clickedAt,
      leftAt: null,
      leftReason: null,
      watchedSeconds: 0
    };
    const arr = await getAllEntries();
    arr.push(e);
    await setAllEntries(arr);
    log("created entry (enriched)", sessionId, id, e.title, e.channelName, e.uploadDate);
    requestBackupIfNeeded();
    return e;
  } catch (err) {
    console.error("[YT-REC] createEntry error", err);
    throw err;
  }
}

async function patchEntry(sessionId, patch) {
  if (!sessionId) return false;
  try {
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
      requestBackupIfNeeded();
      return true;
    } else {
      log("patchEntry: session not found", sessionId);
      return false;
    }
  } catch (e) {
    console.error("[YT-REC] patchEntry error", e);
    return false;
  }
}

/* ---------- backup coordination ---------- */
async function requestBackup() {
  try {
    // obtain entries and send to background
    const entries = await getAllEntries();
    if (!browser || !browser.runtime) {
      // try chrome runtime fallback
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ action: "backup", entries });
        log("backup requested (chrome)");
        return;
      }
      log("backup: runtime API not available");
      return;
    }
    // sendMessage returns a Promise in modern browsers; not critical if no listener
    browser.runtime.sendMessage({ action: "backup", entries }).catch(err => {
      // swallow errors; backup is best-effort
      console.warn("[YT-REC] backup message error", err);
    });
    log("backup requested (sent to background)", (entries || []).length);
  } catch (e) {
    console.error("[YT-REC] requestBackup error", e);
  }
}
function requestBackupIfNeeded() {
  try {
    const now = Date.now();
    if (now - lastBackupAt < BACKUP_MIN_INTERVAL_MS) return;
    lastBackupAt = now;
    requestBackup();
  } catch (e) {
    console.error("[YT-REC] requestBackupIfNeeded error", e);
  }
}

/* ---------- meta helpers ---------- */
function getVideoIdFromUrl(url) {
  try { return new URL(url, location.href).searchParams.get("v"); } catch (e) { return null; }
}

/* getTitle: robust, returns string; uses yt DOM when possible */
async function getTitle() {
  try {
    // YouTube places title in 'h1 yt-formatted-string' or metaog:title; try both
    try {
      const el = await waitForElement('h1 yt-formatted-string', 3000).catch(()=>null);
      if (el && el.textContent) return el.textContent.trim();
    } catch (e) { /* ignore */ }
    // fallback to meta tag
    const meta = document.querySelector('meta[property="og:title"]');
    if (meta && meta.content) return meta.content.trim();
    // last resort
    return (document.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
  } catch (e) {
    console.error("[YT-REC] getTitle error", e);
    return (document.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
  }
}

/* async helper to get current metadata object */
async function getCurrentMeta(id) {
  const title = await getTitle().catch(()=> "");
  return { id, url: location.href, title: title || "" };
}

/* ---------- core: attach to video and listeners ---------- */
async function attachToVideoSafely() {
  try {
    // wait for the <video>
    videoEl = await waitForElement("video", 15000).catch((e) => {
      log("waitForElement(video) failed:", e && e.message);
      return null;
    });
    if (!videoEl) { log("attachToVideoSafely: no video element"); return; }
    log("video element acquired");

    // --- NOUVEAU : s'assurer que la session en mémoire correspond à la vidéo actuelle ---
    try {
      const vidNow = getVideoIdFromUrl(location.href);
      if (vidNow) {
        await ensureSessionMatchesCurrentVid(vidNow);
      } else {
        // pas d'id vidéo dans l'URL : on réinitialise la session au cas où
        currentSessionId = null;
      }
    } catch (e) {
      console.error("[YT-REC] error while ensuring session matches current vid", e);
      currentSessionId = null;
    }

    const vid = getVideoIdFromUrl(location.href);
    if (vid) {
      await ensureSessionMatchesCurrentVid(vid);
    } else {
      currentSessionId = null;
    }
    // inner handlers
    async function onPlay() {
      try {
        const vid = getVideoIdFromUrl(location.href);
        if (!vid) { log("onPlay: no vid"); return; }

        // --- NOUVEAU : s'assurer immédiatement que la session en mémoire correspond à cette vidéo.
        // Si currentSessionId appartient à une autre vidéo, elle sera fermée proprement.
        try {
          await ensureSessionMatchesCurrentVid(vid);
        } catch (e) {
          console.error("[YT-REC] ensureSessionMatchesCurrentVid failed inside onPlay", e);
          currentSessionId = null; // sécurité
        }
        // Pour debug : afficher l'état après vérif
        log("onPlay: after ensure, currentSessionId =", currentSessionId);

        // === suite normale (réutiliser ou créer) ===

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
              const meta = await getCurrentMeta(vid);
              const created = await createEntry(meta);
              currentSessionId = created.sessionId;
            }
          } else {
            const meta = await getCurrentMeta(vid);
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
          requestBackupIfNeeded();
        }
      } catch (e) { console.error("[YT-REC] onEnded error", e); }
    }

    function onTimeUpdate() {
      try {
        // Only update URL fragment, do not persist to storage each tick
        if (videoEl && !videoEl.paused) {
          // fast, non-blocking update of URL param t (no storage write)
          const rounded = Math.floor(videoEl.currentTime || 0);
          // avoid thrashing history by only replacing every second or when changed
          if (typeof window.__yt_last_t === "undefined" || window.__yt_last_t !== rounded) {
            window.__yt_last_t = rounded;
            try {
              const u = new URL(location.href);
              if (rounded > 0) u.searchParams.set('t', `${rounded}`);
              else u.searchParams.delete('t');
              history.replaceState(null, '', u.toString());
            } catch (e) { /* ignore URL errors */ }
          }
        }
      } catch (e) { console.error("[YT-REC] onTimeUpdate error", e); }
    }

    // detach old handlers safely by recreating wrapper references
    try { videoEl.removeEventListener("play", videoEl._ytrec_onPlay); } catch {}
    try { videoEl.removeEventListener("pause", videoEl._ytrec_onPause); } catch {}
    try { videoEl.removeEventListener("ended", videoEl._ytrec_onEnded); } catch {}
    try { videoEl.removeEventListener("timeupdate", videoEl._ytrec_onTimeUpdate); } catch {}

    // attach and keep references to detach later
    videoEl._ytrec_onPlay = onPlay;
    videoEl._ytrec_onPause = onPause;
    videoEl._ytrec_onEnded = onEnded;
    videoEl._ytrec_onTimeUpdate = onTimeUpdate;

    videoEl.addEventListener("play", onPlay);
    videoEl.addEventListener("pause", onPause);
    videoEl.addEventListener("ended", onEnded);
    // timeupdate is frequent but cheap here (no storage writes)
    videoEl.addEventListener("timeupdate", onTimeUpdate);

    log("attachToVideoSafely: listeners attached");
  } catch (e) {
    console.error("[YT-REC] attachToVideoSafely fatal error", e);
  }
}

/* ---------- visibility / hidden timeout / unload ---------- */
function cancelHiddenTimer() {
  if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
}
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
        requestBackupIfNeeded();
      }
    } catch (e) { console.error("[YT-REC] hiddenTimer error", e); }
  }, HIDDEN_TIMEOUT_MS);
}

document.addEventListener("visibilitychange", () => {
  try {
    if (document.visibilityState === "hidden") startHiddenTimer();
    else cancelHiddenTimer();
  } catch (e) { console.error("[YT-REC] visibilitychange handler error", e); }
});

window.addEventListener("beforeunload", async () => {
  try {
    if (!currentSessionId) return;
    if (videoEl) {
      const position = Math.round(videoEl.currentTime || 0);
      const iso = new Date().toISOString();
      await patchEntry(currentSessionId, { leftAt: iso, leftReason: "unload", watchedSeconds: position });
      log("beforeunload closed", currentSessionId, "position", position);
      requestBackupIfNeeded();
    }
    currentSessionId = null;
  } catch (e) { console.error("[YT-REC] beforeunload handler error", e); }
});

/* ---------- SPA navigation watcher (safe) ---------- */
(function watchUrl() {
  try {
    let last = location.href;
    const check = () => {
      try {
        if (location.href !== last) {
          last = location.href;
          setTimeout(() => {
            log("SPA navigation detected -> trying to attach to video");
            attachToVideoSafely().catch(()=>{});
          }, 250);
        }
      } catch (e) { console.error("[YT-REC] url check error", e); }
    };
    const _p = history.pushState;
    history.pushState = function () { _p.apply(this, arguments); check(); };
    const _r = history.replaceState;
    history.replaceState = function () { _r.apply(this, arguments); check(); };
    window.addEventListener("popstate", check);
    setInterval(check, 1200);
    setTimeout(() => {
      log("initial attach attempt");
      attachToVideoSafely().catch(()=>{});
    }, 600);
  } catch (e) {
    console.error("[YT-REC] watchUrl init error", e);
  }
})();

// Retourne l'entrée en storage correspondant à sessionId (ou null)
async function getEntryBySessionId(sessionId) {
  if (!sessionId) return null;
  try {
    const arr = await getAllEntries();
    return arr.find(e => e.sessionId === sessionId) || null;
  } catch (e) {
    console.error("[YT-REC] getEntryBySessionId error", e);
    return null;
  }
}

// S'assure que la session courante correspond à la vidéo id donnée.
// Si non : ferme proprement l'ancienne session (leftAt/navigated) et clear currentSessionId.
async function ensureSessionMatchesCurrentVid(vid) {
  try {
    if (!currentSessionId) return;
    const entry = await getEntryBySessionId(currentSessionId);
    if (!entry) {
      // l'entrée a été supprimée depuis ; on arrête le tracking
      currentSessionId = null;
      return;
    }
    if (entry.id !== vid) {
      // l'ancienne session ne correspond pas à la nouvelle vidéo -> fermer proprement
      if (!entry.leftAt) {
        const iso = new Date().toISOString();
        await patchEntry(currentSessionId, { leftAt: iso, leftReason: "navigated" });
        log("ensureSessionMatchesCurrentVid: closed previous session due to navigation", currentSessionId, "-> navigated");
      }
      currentSessionId = null;
    }
    // si entry.id === vid, on laisse currentSessionId tel quel (reuse possible)
  } catch (e) {
    console.error("[YT-REC] ensureSessionMatchesCurrentVid error", e);
    // par sécurité, on réinitialise currentSessionId pour ne pas polluer la nouvelle session
    currentSessionId = null;
  }
}
