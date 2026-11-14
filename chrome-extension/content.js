(function () {
  function detectGmailOnPage() {
    try {
      const els = document.querySelectorAll("[aria-label*='@']");
      for (const el of els) {
        const lbl = el.getAttribute("aria-label") || "";
        const em = lbl.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        if (em && em[1]) return em[1].toLowerCase();
      }
      const html = document.documentElement.innerHTML || "";
      const m = html.match(/([a-zA-Z0-9._%+-]+@gmail\.com)/i);
      if (m && m[1]) return m[1].toLowerCase();
    } catch (e) {}
    return "";
  }

  function createSastraButton() {
    if (document.getElementById("sastra-gemini-connect-btn")) return;
    const btn = document.createElement("button");
    btn.id = "sastra-gemini-connect-btn";
    btn.innerHTML = "🌐 ភ្ជាប់ Gmail នេះទៅ SastraGetWay (1-Click)";
    btn.style.cssText = [
      "position:fixed",
      "bottom:22px",
      "right:22px",
      "z-index:999999",
      "padding:10px 18px",
      "border-radius:14px",
      "border:1px solid rgba(245,158,11,0.65)",
      "background:linear-gradient(135deg, rgba(15,23,42,0.95), rgba(88,28,135,0.92))",
      "color:#fde68a",
      "font-family:system-ui,-apple-system,sans-serif",
      "font-size:13px",
      "font-weight:700",
      "cursor:pointer",
      "box-shadow:0 8px 28px rgba(245,158,11,0.32)",
      "transition:all 0.2s ease"
    ].join(";");

    btn.onclick = () => triggerSastraSync(btn);
    document.body.appendChild(btn);

  }

  function triggerSastraSync(btn) {
    const email = detectGmailOnPage();
    const currentUrl = new URL(window.location.href);
    const pathAccount = currentUrl.pathname.match(/^\/u\/(\d{1,2})\/app(?:\/|$)/);
    const selectedAuthuser = pathAccount?.[1] || currentUrl.searchParams.get("authuser") || "";
    if (btn) {
      btn.innerHTML = "⏳ កំពុងភ្ជាប់ទៅ SastraGetWay...";
      btn.style.borderColor = "#38bdf8";
      btn.style.color = "#bae6fd";
    }
    chrome.runtime.sendMessage({ type: "SASTRA_SYNC_GEMINI_WEB", email, authuser: selectedAuthuser }, (res) => {
      showSyncResult(btn, res, email);
    });
  }

  function showSyncResult(btn, res, email = "") {
    if (!btn) return;
    if (res && res.ok) {
      btn.textContent = `បានភ្ជាប់ ${res.email || email || "Gmail"} ទៅ SastraGetWay រួចរាល់!`;
      btn.style.background = "linear-gradient(135deg, #065f46, #047857)";
      btn.style.borderColor = "#34d399";
      btn.style.color = "#ecfdf5";
    } else {
      btn.textContent = res?.error || "សូមបើកកម្មវិធី SastraGetWay ជាមុនសិន";
      btn.style.borderColor = "#fb7185";
      btn.style.color = "#fecdd3";
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SASTRA_SYNC_RESULT") {
      showSyncResult(document.getElementById("sastra-gemini-connect-btn"), msg.result);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createSastraButton);
  } else {
    createSastraButton();
  }
})();
