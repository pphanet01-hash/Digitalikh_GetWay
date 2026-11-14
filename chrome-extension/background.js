async function syncGoogleCookiesToSastra(emailHint = "", authuser = "") {
  try {
    const byUrl = await chrome.cookies.getAll({ url: "https://gemini.google.com/" });
    const byDomain = await chrome.cookies.getAll({ domain: "google.com" });
    const mergedMap = new Map();
    for (const c of [...byDomain, ...byUrl]) {
      if (c && c.name && c.value) {
        mergedMap.set(`${c.domain}_${c.name}_${c.path}`, {
          name: c.name,
          value: c.value,
          domain: c.domain || ".google.com",
          path: c.path || "/",
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          hostOnly: Boolean(c.hostOnly),
          sameSite: c.sameSite || "unspecified",
          expirationDate: c.expirationDate
        });
      }
    }
    const cookies = Array.from(mergedMap.values());
    const hasPsid = cookies.some((c) => c.name === "__Secure-1PSID" || c.name === "SID");
    if (!hasPsid) {
      return { ok: false, error: "សូម Login គណនី Gmail នៅក្នុង gemini.google.com ជាមុនសិន!" };
    }

    const res = await fetch("http://127.0.0.1:20129/gemini-web/import-cookies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: emailHint || "",
        authuser: /^\d{1,2}$/.test(String(authuser)) ? String(authuser) : "",
        cookies
      })
    });
    const data = await res.json();
    return data;
  } catch (err) {
    return { ok: false, error: err.message || "មិនអាចភ្ជាប់ទៅ SastraGetWay (127.0.0.1:20129) បានទេ" };
  }
}

function geminiAccountFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== "gemini.google.com") return "";
    const pathAccount = url.pathname.match(/^\/u\/(\d{1,2})\/app(?:\/|$)/);
    if (pathAccount) return pathAccount[1];
    const queryAccount = url.searchParams.get("authuser") || "";
    return /^\d{1,2}$/.test(queryAccount) ? queryAccount : "";
  } catch { return ""; }
}

function isGeminiAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname === "gemini.google.com" && /^\/(?:u\/\d{1,2}\/)?app(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

// Keep the one-time Chrome chooser intent across Google's redirects and service-worker sleeps.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void (async () => {
    const url = changeInfo.url || tab?.url || "";
    const key = `sastraGeminiConnect_${tabId}`;
    if (changeInfo.url && /sastra_connect(?:=|%3[dD])1/.test(changeInfo.url)) {
      await chrome.storage.session.set({ [key]: Date.now() });
    }
    if (changeInfo.status !== "complete" || !isGeminiAppUrl(url)) return;
    const pending = (await chrome.storage.session.get(key))[key];
    if (!pending || Date.now() - pending > 10 * 60_000) return;
    await chrome.storage.session.remove(key);
    const authuser = geminiAccountFromUrl(url);
    const result = await syncGoogleCookiesToSastra("", authuser);
    await chrome.tabs.sendMessage(tabId, { type: "SASTRA_SYNC_RESULT", result }).catch(() => {});
  })().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "SASTRA_SYNC_GEMINI_WEB") {
    syncGoogleCookiesToSastra(msg.email || "", msg.authuser || "").then((result) => {
      sendResponse(result);
    });
    return true;
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.url || !tab.url.includes("gemini.google.com")) {
    chrome.tabs.create({ url: "https://gemini.google.com/app?sastra_connect=1" });
    return;
  }
  const authuser = geminiAccountFromUrl(tab.url);
  await syncGoogleCookiesToSastra("", authuser);
});
