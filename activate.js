(() => {
  let supportsDisplayTransition;
  function canTransitionDisplay() {
    if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
    if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
      return false;
    }
    const probe = document.createElement('div');
    probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
    document.body.appendChild(probe);
    getComputedStyle(probe).display;
    probe.style.display = 'none';
    supportsDisplayTransition = getComputedStyle(probe).display === 'block';
    probe.remove();
    return supportsDisplayTransition;
  }

  async function hideElement(el) {
    if (!el) return;
    if (canTransitionDisplay()) {
      el.hidden = true;
    } else {
      el.setAttribute('data-closing', '');
    }

    const animations = el.getAnimations ? el.getAnimations() : [];
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 400))
      ]);
    }

    if (el.hasAttribute('data-closing')) {
      el.removeAttribute('data-closing');
      el.hidden = true;
    }
  }

  function showElement(el) {
    if (!el) return;
    el.removeAttribute('data-closing');
    el.hidden = false;
  }

  const rootStyle = document.documentElement.style;
  const authCard = document.getElementById('auth-card');
  const switcher = document.getElementById('auth-tab-switcher');
  const tabLogin = document.getElementById('tab-btn-login');
  const tabRegister = document.getElementById('tab-btn-register');
  const paneLogin = document.getElementById('pane-login');
  const paneRegister = document.getElementById('pane-register');
  const feedbackEl = document.getElementById('auth-feedback');
  const subtitleEl = document.getElementById('auth-subtitle');
  const footerPromptText = document.getElementById('footer-prompt-text');
  const footerSwitchBtn = document.getElementById('btn-footer-switch');
  const rememberCheck = document.getElementById('remember-me');
  const motionToggleBtn = document.getElementById('btn-toggle-motion');
  const motionStatusLabel = document.getElementById('motion-status-label');

  const renewToggleBtn = document.getElementById('btn-toggle-renew');
  const renewDrawer = document.getElementById('login-renew-drawer');
  const renewKeyInput = document.getElementById('login-renew-key');

  let telegramUrl = 'https://t.me/DigitalLicenseKHBot';
  let currentMode = 'login';

  // Respect user reduced-motion preference and provide an interactive Pause/Play control
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let motionEnabled = !reducedMotionQuery.matches;

  function syncMotionButtonUI() {
    if (!motionToggleBtn || !motionStatusLabel) return;
    motionToggleBtn.setAttribute('aria-pressed', String(motionEnabled));
    motionStatusLabel.textContent = motionEnabled ? 'Sunset Live FX' : 'FX Paused';
    const dot = motionToggleBtn.querySelector('.sun-dot');
    if (dot) {
      dot.style.opacity = motionEnabled ? '1' : '0.35';
      dot.style.boxShadow = motionEnabled ? '0 0 9px #fbbf24' : 'none';
    }
    if (!motionEnabled) {
      rootStyle.setProperty('--rx', '0deg');
      rootStyle.setProperty('--ry', '0deg');
      rootStyle.setProperty('--bg-tx', '0px');
      rootStyle.setProperty('--bg-ty', '0px');
    }
  }

  motionToggleBtn?.addEventListener('click', () => {
    motionEnabled = !motionEnabled;
    syncMotionButtonUI();
  });

  reducedMotionQuery.addEventListener?.('change', (e) => {
    motionEnabled = !e.matches;
    syncMotionButtonUI();
  });
  syncMotionButtonUI();

  // 1. JavaScript Interactive 3D Parallax & Golden Cursor Spotlight (60fps Lerp)
  let targetRx = 0, targetRy = 0, currentRx = 0, currentRy = 0;
  let targetBgX = 0, targetBgY = 0, currentBgX = 0, currentBgY = 0;
  let pointerX = window.innerWidth * 0.65;
  let pointerY = window.innerHeight * 0.45;

  window.addEventListener('pointermove', (e) => {
    pointerX = e.clientX;
    pointerY = e.clientY;
    if (!motionEnabled) return;

    const normX = (e.clientX / window.innerWidth) - 0.5;
    const normY = (e.clientY / window.innerHeight) - 0.5;
    targetBgX = -normX * 16;
    targetBgY = -normY * 12;

    if (authCard) {
      const rect = authCard.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      rootStyle.setProperty('--mx', `${localX.toFixed(1)}px`);
      rootStyle.setProperty('--my', `${localY.toFixed(1)}px`);

      const cx = (localX / rect.width) - 0.5;
      const cy = (localY / rect.height) - 0.5;
      targetRx = Math.max(-4.5, Math.min(4.5, -cy * 6));
      targetRy = Math.max(-4.5, Math.min(4.5, cx * 6));
    }
  });

  window.addEventListener('pointerleave', () => {
    targetRx = 0;
    targetRy = 0;
    targetBgX = 0;
    targetBgY = 0;
  });

  // 2. JavaScript Canvas Golden Sunset Fireflies & Shimmering Sun-Motes
  const canvas = document.getElementById('sunset-particles');
  const ctx = canvas ? canvas.getContext('2d') : null;
  const particles = [];
  const PARTICLE_COUNT = 38;
  const PALETTE = [
    { r: 253, g: 224, b: 71 },  // Golden sun
    { r: 251, g: 146, b: 60 },  // Sunset orange
    { r: 244, g: 114, b: 182 }, // Warm coral pink
    { r: 254, g: 243, b: 199 }  // Soft cream starlight
  ];

  function resizeCanvas() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const c = PALETTE[i % PALETTE.length];
    particles.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: 1.2 + Math.random() * 2.6,
      vx: (Math.random() - 0.5) * 0.35,
      vy: -0.18 - Math.random() * 0.42,
      phase: Math.random() * Math.PI * 2,
      speed: 0.018 + Math.random() * 0.025,
      color: c
    });
  }

  function tickScene() {
    if (motionEnabled) {
      currentRx += (targetRx - currentRx) * 0.1;
      currentRy += (targetRy - currentRy) * 0.1;
      currentBgX += (targetBgX - currentBgX) * 0.08;
      currentBgY += (targetBgY - currentBgY) * 0.08;

      rootStyle.setProperty('--rx', `${currentRx.toFixed(2)}deg`);
      rootStyle.setProperty('--ry', `${currentRy.toFixed(2)}deg`);
      rootStyle.setProperty('--bg-tx', `${currentBgX.toFixed(1)}px`);
      rootStyle.setProperty('--bg-ty', `${currentBgY.toFixed(1)}px`);

      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const p of particles) {
          p.phase += p.speed;
          p.x += p.vx + Math.sin(p.phase) * 0.22;
          p.y += p.vy;

          // Gentle attraction/swirl near pointer
          const dx = pointerX - p.x;
          const dy = pointerY - p.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < 18000 && distSq > 40) {
            p.x -= (dx / Math.sqrt(distSq)) * 0.35;
            p.y -= (dy / Math.sqrt(distSq)) * 0.35;
          }

          if (p.y < -12) {
            p.y = canvas.height + 10;
            p.x = Math.random() * canvas.width;
          }
          if (p.x < -12) p.x = canvas.width + 10;
          if (p.x > canvas.width + 12) p.x = -10;

          const alpha = 0.25 + ((Math.sin(p.phase) + 1) * 0.32);
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3.8);
          grad.addColorStop(0, `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, ${alpha.toFixed(2)})`);
          grad.addColorStop(1, `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, 0)`);

          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 3.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(tickScene);
  }
  requestAnimationFrame(tickScene);

  // 3. Web Animations API Helpers (Button Ripple, Card Shake, Staggered Entrance)
  function spawnButtonRipple(btn, e) {
    if (!btn || !motionEnabled || !btn.animate) return;
    const rect = btn.getBoundingClientRect();
    const x = (e?.clientX || (rect.left + rect.width / 2)) - rect.left;
    const y = (e?.clientY || (rect.top + rect.height / 2)) - rect.top;
    const size = Math.max(rect.width, rect.height) * 1.9;

    const ripple = document.createElement('span');
    ripple.className = 'js-ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    btn.appendChild(ripple);

    const anim = ripple.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0)', opacity: 0.85 },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 }
      ],
      { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
    anim.onfinish = () => ripple.remove();
  }

  function shakeCardOnError() {
    if (!authCard || !motionEnabled || !authCard.animate) return;
    authCard.animate(
      [
        { translate: '0 0' },
        { translate: '-7px 0' },
        { translate: '6px 0' },
        { translate: '-4px 0' },
        { translate: '3px 0' },
        { translate: '0 0' }
      ],
      { duration: 340, easing: 'ease-out' }
    );
  }

  function runEntranceAnimation() {
    if (!authCard || !motionEnabled || !authCard.animate) return;
    authCard.animate(
      [
        { opacity: 0, translate: '0 18px', scale: '0.97' },
        { opacity: 1, translate: '0 0', scale: '1' }
      ],
      { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
  }

  document.querySelectorAll('.submit-btn').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => spawnButtonRipple(btn, e));
  });

  function showFeedback(message, type = 'error') {
    if (!feedbackEl) return;
    if (!message) {
      feedbackEl.hidden = true;
      feedbackEl.textContent = '';
      return;
    }
    feedbackEl.className = `feedback-banner ${type}`;
    feedbackEl.textContent = message;
    feedbackEl.hidden = false;
    if (type === 'error') {
      shakeCardOnError();
    }
  }

  function setRenewDrawerOpen(open) {
    if (!renewDrawer || !renewToggleBtn) return;
    renewToggleBtn.setAttribute('aria-expanded', String(Boolean(open)));
    if (open) {
      renewDrawer.hidden = false;
      requestAnimationFrame(() => {
        renewDrawer.classList.add('is-expanded');
      });
    } else {
      renewDrawer.classList.remove('is-expanded');
      if (renewKeyInput) renewKeyInput.value = '';
    }
  }

  if (renewDrawer) {
    renewDrawer.addEventListener('transitionend', (event) => {
      // Access event.animation directly when supported per modern-web-guidance (motion)
      const anim = 'animation' in TransitionEvent.prototype ? event.animation : null;
      const isBlockSize = event.propertyName === 'block-size' || anim?.transitionProperty === 'block-size';
      if (isBlockSize && !renewDrawer.classList.contains('is-expanded')) {
        renewDrawer.hidden = true;
      }
    });
  }

  if (renewToggleBtn) {
    renewToggleBtn.addEventListener('click', () => {
      const isOpen = renewToggleBtn.getAttribute('aria-expanded') === 'true';
      setRenewDrawerOpen(!isOpen);
      if (!isOpen && renewKeyInput) {
        setTimeout(() => renewKeyInput.focus(), 80);
      }
    });
  }

  async function switchAuthTab(mode) {
    currentMode = mode === 'register' ? 'register' : 'login';
    showFeedback('');
    if (currentMode === 'register') {
      switcher.setAttribute('data-active', 'register');
      tabLogin.setAttribute('aria-selected', 'false');
      tabRegister.setAttribute('aria-selected', 'true');
      if (subtitleEl) subtitleEl.textContent = 'Create your license account';
      if (footerPromptText) footerPromptText.textContent = 'Already have an account?';
      if (footerSwitchBtn) footerSwitchBtn.textContent = 'Sign In';
      await hideElement(paneLogin);
      showElement(paneRegister);
      document.getElementById('reg-email')?.focus();
    } else {
      switcher.setAttribute('data-active', 'login');
      tabLogin.setAttribute('aria-selected', 'true');
      tabRegister.setAttribute('aria-selected', 'false');
      if (subtitleEl) subtitleEl.textContent = 'Sign in to your account';
      if (footerPromptText) footerPromptText.textContent = "Don't have an account?";
      if (footerSwitchBtn) footerSwitchBtn.textContent = 'Sign Up';
      await hideElement(paneRegister);
      showElement(paneLogin);
      document.getElementById('login-email')?.focus();
    }
  }

  tabLogin?.addEventListener('click', () => switchAuthTab('login'));
  tabRegister?.addEventListener('click', () => switchAuthTab('register'));
  footerSwitchBtn?.addEventListener('click', () => {
    switchAuthTab(currentMode === 'login' ? 'register' : 'login');
  });

  // Show / Hide Password Toggle
  const EYE_OFF_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  const EYE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  document.querySelectorAll('[data-toggle-pass]').forEach((btn) => {
    btn.innerHTML = EYE_OFF_ICON;
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-toggle-pass');
      const input = document.getElementById(targetId);
      if (!input) return;
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      btn.innerHTML = isHidden ? EYE_ICON : EYE_OFF_ICON;
      btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    });
  });

  // Preserve signed Base64URL token (eyJ...) or auto-format legacy key on input
  function formatKeyString(raw) {
    const trimmed = String(raw || '').trim().replace(/\s+/g, '');
    if (!trimmed) return '';
    if (trimmed.startsWith('eyJ') || trimmed.includes('.')) {
      return trimmed;
    }

    const clean = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.startsWith('KEY')) {
      const body = clean.slice(3);
      const chunks = [];
      for (let i = 0; i < Math.min(body.length, 12); i += 4) {
        chunks.push(body.slice(i, i + 4));
      }
      return chunks.length > 0 ? `KEY-${chunks.join('-')}` : 'KEY-';
    }
    return trimmed;
  }

  ['reg-license-key', 'login-renew-key'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const formatted = formatKeyString(el.value);
      if (el.value !== formatted) {
        el.value = formatted;
      }
    });
  });

  // Paste Key buttons
  document.querySelectorAll('[data-paste-target]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-paste-target');
      const input = document.getElementById(targetId);
      if (!input) return;
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          input.value = formatKeyString(text.trim());
          input.focus();
        }
      } catch (e) {}
    });
  });

  // Window Minimize, Maximize/Restore & Close
  const MAX_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
  const RESTORE_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="8" width="13" height="13" rx="2"/><path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3"/></svg>';
  const maxBtn = document.getElementById('btn-win-max');
  async function toggleMaximize() {
    const res = await window.electronAPI?.maximizeWindow?.();
    if (!maxBtn || !res) return;
    maxBtn.innerHTML = res.maximized ? RESTORE_ICON : MAX_ICON;
    maxBtn.title = res.maximized ? 'Restore' : 'Maximize';
    maxBtn.setAttribute('aria-label', res.maximized ? 'Restore' : 'Maximize');
  }
  maxBtn?.addEventListener('click', toggleMaximize);
  document.querySelector('.titlebar')?.addEventListener('dblclick', toggleMaximize);

  document.getElementById('btn-win-min')?.addEventListener('click', () => {
    window.electronAPI?.minimizeWindow?.();
  });
  document.getElementById('btn-win-close')?.addEventListener('click', () => {
    window.electronAPI?.closeWindow?.();
  });

  // Login Form Submit
  document.getElementById('form-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('login-email');
    const passInput = document.getElementById('login-password');
    const submitBtn = document.getElementById('btn-submit-login');

    let email = (emailInput?.value || '').trim();
    if (email && !email.includes('@')) {
      email = `${email}@gmail.com`;
      if (emailInput) emailInput.value = email;
    }
    const password = passInput?.value || '';
    const newLicenseKey = (renewKeyInput?.value || '').trim();

    if (!email) {
      showFeedback('សូមបញ្ចូលអាសយដ្ឋាន Gmail របស់អ្នកជាមុនសិន។', 'error');
      emailInput?.focus();
      return;
    }
    if (!password) {
      showFeedback('សូមបញ្ចូលពាក្យសម្ងាត់ (Password) របស់អ្នក។', 'error');
      passInput?.focus();
      return;
    }

    const prevHTML = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Signing in...</span>';
    showFeedback('');

    try {
      if (rememberCheck && !rememberCheck.checked) {
        localStorage.removeItem('sastra_last_gmail');
      } else {
        localStorage.setItem('sastra_last_gmail', email);
      }
    } catch (err) {}

    try {
      const res = await window.electronAPI.loginAccount({ email, password, newLicenseKey });
      if (res && res.ok) {
        showFeedback('ចូលគណនីជោគជ័យ! កំពុងបើកផ្ទាំងកម្មវិធី SastraGetWay...', 'success');
      } else {
        if (res?.code === 'EXPIRED') {
          setRenewDrawerOpen(true);
          showFeedback(res.reason || 'គណនីបានផុតកំណត់ហើយ! សូមបញ្ចូល License Key ថ្មីដើម្បីបន្តសុពលភាព។', 'warn');
          setTimeout(() => renewKeyInput?.focus(), 100);
        } else if (res?.code === 'ACCOUNT_NOT_FOUND') {
          showFeedback(res.reason, 'warn');
        } else {
          showFeedback(res?.reason || 'មិនអាចចូលគណនីបានទេ សូមពិនិត្យម្តងទៀត។', 'error');
        }
      }
    } catch (err) {
      showFeedback(`កំហុសប្រព័ន្ធ៖ ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = prevHTML;
    }
  });

  // Register Form Submit
  document.getElementById('form-register')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('reg-email');
    const passInput = document.getElementById('reg-password');
    const keyInput = document.getElementById('reg-license-key');
    const submitBtn = document.getElementById('btn-submit-register');

    let email = (emailInput?.value || '').trim();
    if (email && !email.includes('@')) {
      email = `${email}@gmail.com`;
      if (emailInput) emailInput.value = email;
    }
    const password = passInput?.value || '';
    const licenseKey = (keyInput?.value || '').trim();

    if (!email) {
      showFeedback('សូមបញ្ចូលអាសយដ្ឋាន Gmail របស់អ្នក។', 'error');
      emailInput?.focus();
      return;
    }
    if (password.length < 4) {
      showFeedback('សូមបង្កើតពាក្យសម្ងាត់ (Password) យ៉ាងតិច ៤ តួអក្សរឡើងទៅ។', 'error');
      passInput?.focus();
      return;
    }
    if (!licenseKey) {
      showFeedback('សូមបញ្ចូល License Key ដែលទទួលបានពី Admin។', 'error');
      keyInput?.focus();
      return;
    }

    const prevHTML = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Creating account...</span>';
    showFeedback('');
    try { localStorage.setItem('sastra_last_gmail', email); } catch (err) {}

    try {
      const res = await window.electronAPI.registerAccount({ email, password, licenseKey });
      if (res && res.ok) {
        showFeedback('ចុះឈ្មោះ និងបើកសិទ្ធិប្រើប្រាស់ជោគជ័យ! កំពុងបើកកម្មវិធី...', 'success');
      } else {
        showFeedback(res?.reason || 'មិនអាចចុះឈ្មោះបានទេ សូមពិនិត្យម្តងទៀត។', 'error');
      }
    } catch (err) {
      showFeedback(`កំហុសប្រព័ន្ធ៖ ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = prevHTML;
    }
  });

  function applyInitialStatus(info) {
    if (!info) return;
    if (info.telegramUrl) {
      telegramUrl = info.telegramUrl;
    }
    const savedGmail = info.email || (() => {
      try { return localStorage.getItem('sastra_last_gmail') || ''; } catch (e) { return ''; }
    })();
    if (savedGmail) {
      const loginEmailEl = document.getElementById('login-email');
      if (loginEmailEl && !loginEmailEl.value) loginEmailEl.value = savedGmail;
    }
    if (info.code === 'KICKED_OTHER_PC' || info.code === 'REMOTE_LOGOUT' || info.code === 'ACCOUNT_DISABLED') {
      showFeedback(info.reason, 'error');
    } else if (info.code === 'EXPIRED' || info.expired) {
      setRenewDrawerOpen(true);
      showFeedback(info.reason || 'គណនីបានផុតកំណត់ថ្ងៃប្រើប្រាស់ហើយ! សូមបញ្ចូល License Key ថ្មី។', 'warn');
    } else if (info.code === 'CLOCK_ROLLBACK' || info.code === 'OFFLINE_EXCEEDED') {
      showFeedback(info.reason, 'warn');
    }
  }

  window.addEventListener('DOMContentLoaded', async () => {
    runEntranceAnimation();
    try {
      const status = await window.electronAPI?.getLicenseStatus?.();
      applyInitialStatus(status);
    } catch (e) {}

    window.electronAPI?.onLicenseStatus?.((status) => {
      applyInitialStatus(status);
    });
  });
})();
