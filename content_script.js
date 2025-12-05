// content_script.js
const BROWSER = (typeof browser !== "undefined") ? browser : chrome;

/*
Schema d'une entrée :
{
  id: "<videoId>",
  url: "https://www.youtube.com/watch?v=...",
  title: "Titre de la vidéo",
  thumbnail: "https://i.ytimg.com/vi/<id>/hqdefault.jpg",
  clickedAt: "2025-12-05T18:00:00.000Z",
  leftAt: null
}
*/

const STORAGE_KEY = "yt_click_history";

// garde en mémoire le dernier id traité pour éviter doublons sur navigation SPA
let lastRecordedId = null;
let currentEntryId = null;

function getVideoIdFromUrl(url) {
  try {
    const u = new URL(url, location.href);
    return u.searchParams.get("v");
  } catch (e) {
    return null;
  }
}

function getTitle() {
  // document.title retourne "Titre - YouTube"
  const raw = document.title || "";
  return raw.replace(/\s*-\s*YouTube\s*$/i, "").trim();
}

function thumbnailForId(id) {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

async function saveEntry(entry) {
  const storage = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
  const arr = storage[STORAGE_KEY] || [];

  // éviter de dupliquer si le dernier est identique
  const last = arr.length ? arr[arr.length - 1] : null;
  if (last && last.id === entry.id && last.clickedAt === entry.clickedAt) {
    return;
  }

  arr.push(entry);
  await BROWSER.storage.local.set({ [STORAGE_KEY]: arr });
}

async function updateLastEntryLeftAt(id, leftAtIso) {
  const storage = await BROWSER.storage.local.get({ [STORAGE_KEY]: [] });
  const arr = storage[STORAGE_KEY] || [];
  // remonte depuis la fin pour trouver la dernière entrée avec cet id sans leftAt
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].id === id && (!arr[i].leftAt || arr[i].leftAt === null)) {
      arr[i].leftAt = leftAtIso;
      break;
    }
  }
  await BROWSER.storage.local.set({ [STORAGE_KEY]: arr });
}

function recordIfVideoPage(url) {
  const vid = getVideoIdFromUrl(url);
  if (!vid) return;

  // si on a déjà enregistré ce id récemment, on évite
  if (lastRecordedId === vid) {
    currentEntryId = vid;
    return;
  }

  const entry = {
    id: vid,
    url: url,
    title: getTitle(),
    thumbnail: thumbnailForId(vid),
    clickedAt: new Date().toISOString(),
    leftAt: null
  };

  saveEntry(entry).catch(console.error);
  lastRecordedId = vid;
  currentEntryId = vid;
}

// YouTube est une SPA : on intercepte pushState/replaceState et popstate
(function watchUrlChanges() {
  let lastHref = location.href;
  const check = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      // petit délai pour laisser YouTube mettre à jour le DOM
      setTimeout(() => recordIfVideoPage(location.href), 500);
    }
  };

  // override pushState/replaceState
  const _pushState = history.pushState;
  history.pushState = function () {
    _pushState.apply(this, arguments);
    check();
  };
  const _replaceState = history.replaceState;
  history.replaceState = function () {
    _replaceState.apply(this, arguments);
    check();
  };

  window.addEventListener("popstate", check);

  // fallback : poller toutes les 1.2s (robuste)
  setInterval(check, 1200);

  // initial check
  setTimeout(() => recordIfVideoPage(location.href), 800);
})();

// essayer d'enregistrer le leftAt quand l'onglet devient caché ou onbeforeunload
function handleVisibilityOrUnload() {
  if (!currentEntryId) return;
  const iso = new Date().toISOString();
  updateLastEntryLeftAt(currentEntryId, iso).catch(console.error);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    handleVisibilityOrUnload();
  }
});

window.addEventListener("beforeunload", () => {
  handleVisibilityOrUnload();
});

