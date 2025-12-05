// background.js
const BROWSER = (typeof browser !== "undefined") ? browser : chrome;

BROWSER.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "open-history") {
    BROWSER.tabs.create({ url: BROWSER.runtime.getURL("history.html") });
  }
});

