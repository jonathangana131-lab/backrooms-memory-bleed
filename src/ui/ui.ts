/** DOM UI: title screen, settings, pause menu, HUD. */
import type { SettingsData } from '../save/db';

export interface UICallbacks {
  onNewExpedition(seedText: string): void;
  onContinue(): void;
  onResume(): void;
  onSaveQuit(): void;
  onSettingsChanged(s: SettingsData): void;
}

export class UI {
  root: HTMLElement;
  titleScreen!: HTMLElement;
  pauseMenu!: HTMLElement;
  hud!: HTMLElement;
  debugOverlay!: HTMLElement;
  toastArea!: HTMLElement;
  private seedInput!: HTMLInputElement;
  private continueBtn!: HTMLButtonElement;
  private sensSlider!: HTMLInputElement;
  private volSlider!: HTMLInputElement;
  private qualSelect!: HTMLSelectElement;
  private fovSlider!: HTMLInputElement;
  private subsCheck!: HTMLInputElement;
  private subtitlesOn = true;
  private staminaFill!: HTMLElement;
  private batteryWrap!: HTMLElement;
  private batteryFill!: HTMLElement;
  private promptEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private objectiveEl!: HTMLElement;
  private endingEl!: HTMLElement;
  private erosionEl!: HTMLElement;
  private logEl!: HTMLElement;
  private noteEl!: HTMLElement;
  private beaconFlash!: HTMLElement;
  logOpen = false;
  private subtitleTimer = 0;
  debugVisible = false;
  private fpsAccum = 0; private fpsFrames = 0; private fpsShown = 0;
  private torchIcon!: HTMLElement;
  private loadingEl!: HTMLElement;
  private loadingDotsTimer: ReturnType<typeof setInterval> | null = null;
  private loadingSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSeed = '';
  private toastQueue: {
    el: HTMLElement;
    expiresAt: number;
    fadeTimer: ReturnType<typeof setTimeout>;
    removeTimer?: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(private cbs: UICallbacks) {
    this.root = document.getElementById('ui')!;
    this.root.innerHTML = '';
    this.injectPolishStyles();
    this.buildTitle();
    this.buildPause();
    this.buildHud();
  }

  /**
   * All polish styling lives here (CSS-in-JS) so no external CSS file is
   * needed; appended to <head> it cleanly overrides src/style.css rules.
   */
  private injectPolishStyles(): void {
    const css = `
      /* --- ending screen: staggered fade, pulsing separator, seed stamp --- */
      @keyframes bmbEndingFade {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: none; }
      }
      .ending-overlay .ending-inner > p {
        opacity: 0;
        animation: bmbEndingFade 2.2s ease forwards;
        animation-delay: calc(var(--i, 0) * 0.5s);
      }
      .ending-overlay .ending-inner .btn {
        animation-name: bmbEndingFade;
        animation-duration: 2s;
        animation-timing-function: ease;
        animation-fill-mode: forwards;
        animation-delay: calc(var(--i, 0) * 0.5s + 0.4s);
      }
      @keyframes bmbSepPulse {
        0%, 100% { opacity: 0.2; transform: scaleX(0.62); }
        50% { opacity: 0.85; transform: scaleX(1); }
      }
      .ending-sep {
        width: 140px; height: 1px; margin: 14px auto 6px;
        background: linear-gradient(90deg, transparent, #6e6438, transparent);
        transform-origin: center;
        animation: bmbSepPulse 3.2s ease-in-out infinite;
      }
      .ending-seed {
        font-family: 'Courier New', Courier, monospace;
        font-size: 11px; letter-spacing: 4px;
        color: #8f8354; opacity: 0.75; user-select: text;
        animation: bmbEndingFade 2s ease forwards;
        animation-delay: calc(var(--i, 0) * 0.5s + 0.6s);
        opacity: 0;
      }
      /* --- toasts: slide-in from right, tiered decay --- */
      .toast-area .toast { will-change: opacity, transform; }
      /* --- loading indicator --- */
      @keyframes bmbLoadBreath {
        0%, 100% { opacity: 0.45; }
        50% { opacity: 1; }
      }
      .reconstructing {
        position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
        z-index: 60; display: none; pointer-events: none;
        font-family: 'Courier New', Courier, monospace;
        font-size: 15px; letter-spacing: 6px; color: #cdbf72;
        text-shadow: 0 0 12px rgba(205,191,114,0.35);
        animation: bmbLoadBreath 1.4s ease-in-out infinite;
      }
      /* --- battery / torch HUD --- */
      .battery-wrap { position: absolute; }
      .battery-wrap .torch-icon {
        position: absolute; left: -27px; top: -7px;
        width: 18px; height: 18px; pointer-events: none;
        color: #7ab0d8; opacity: 0.25; filter: grayscale(0.7);
        transition: opacity 0.3s ease, filter 0.3s ease, color 0.3s ease;
      }
      .battery-wrap .torch-icon svg { width: 100%; height: 100%; display: block; }
      .battery-wrap .torch-icon.lit {
        opacity: 1; filter: none; color: #aad6f2;
        filter: drop-shadow(0 0 5px rgba(122,176,216,0.75));
      }
      @keyframes bmbBattCritical {
        0%, 100% { background: #d84848; box-shadow: 0 0 3px rgba(216,72,72,0.4); }
        50% { background: #ff7d68; box-shadow: 0 0 11px rgba(255,96,72,0.95); }
      }
      .battery-wrap.critical { border-color: rgba(216,72,72,0.75) !important; }
      .battery-wrap.critical .battery-fill {
        animation: bmbBattCritical 0.9s ease-in-out infinite;
      }
    `;
    const style = document.createElement('style');
    style.id = 'bmb-ui-polish';
    style.textContent = css;
    document.head.appendChild(style);
  }

  private el(tag: string, cls?: string, parent?: HTMLElement): HTMLElement {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    (parent || this.root).appendChild(e);
    return e;
  }

  private buildTitle(): void {
    const s = this.el('div', 'screen title-screen');
    this.titleScreen = s;
    this.el('div', 'title-eyebrow', s).textContent = 'ANOMALOUS SPACE RESEARCH DIVISION // FIELD UNIT';
    const h1 = this.el('h1', 'game-title', s);
    h1.innerHTML = 'BACKROOMS<br><span>MEMORY BLEED</span>';
    this.el('p', 'title-sub', s).textContent =
      'The space remembers people who were never here. It is reconstructing them wrong.';
    const menu = this.el('div', 'menu-col', s);

    const newBtn = this.el('button', 'btn primary', menu) as HTMLButtonElement;
    newBtn.textContent = 'NEW EXPEDITION';
    newBtn.onclick = () => {
      this.pendingSeed = this.seedInput.value.trim();
      this.showReconstructing();
      this.cbs.onNewExpedition(this.pendingSeed);
    };

    this.continueBtn = this.el('button', 'btn', menu) as HTMLButtonElement;
    this.continueBtn.textContent = 'CONTINUE';
    this.continueBtn.onclick = () => this.cbs.onContinue();

    const setBtn = this.el('button', 'btn', menu) as HTMLButtonElement;
    setBtn.textContent = 'SETTINGS';
    setBtn.onclick = () => this.togglePanel();

    this.seedInput = this.el('input', 'seed-input', menu) as HTMLInputElement;
    this.seedInput.placeholder = 'seed (blank = random)';
    this.seedInput.spellcheck = false;

    const panel = this.el('div', 'settings-panel', s);
    panel.id = 'settings-panel';
    panel.style.display = 'none';
    const row1 = this.el('label', 'set-row', panel);
    row1.textContent = 'MOUSE SENSITIVITY';
    this.sensSlider = this.el('input', '', row1) as HTMLInputElement;
    this.sensSlider.type = 'range'; this.sensSlider.min = '0.4'; this.sensSlider.max = '3'; this.sensSlider.step = '0.05'; this.sensSlider.value = '1';
    this.sensSlider.oninput = () => this.pushSettings();
    const row2 = this.el('label', 'set-row', panel);
    row2.textContent = 'MASTER VOLUME';
    this.volSlider = this.el('input', '', row2) as HTMLInputElement;
    this.volSlider.type = 'range'; this.volSlider.min = '0'; this.volSlider.max = '1'; this.volSlider.step = '0.02'; this.volSlider.value = '0.8';
    this.volSlider.oninput = () => this.pushSettings();
    const row3 = this.el('label', 'set-row', panel);
    row3.textContent = 'RENDER QUALITY';
    this.qualSelect = this.el('select', '', row3) as HTMLSelectElement;
    for (const [v, t] of [['1', 'FULL'], ['0.75', 'HIGH'], ['0.6', 'MEDIUM'], ['0.45', 'LOW']] as const) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      this.qualSelect.appendChild(o);
    }
    this.qualSelect.onchange = () => this.pushSettings();
    const row4 = this.el('label', 'set-row', panel);
    row4.textContent = 'FIELD OF VIEW';
    this.fovSlider = this.el('input', '', row4) as HTMLInputElement;
    this.fovSlider.type = 'range'; this.fovSlider.min = '60'; this.fovSlider.max = '110'; this.fovSlider.step = '1'; this.fovSlider.value = '75';
    this.fovSlider.oninput = () => this.pushSettings();
    const row5 = this.el('label', 'set-row', panel);
    row5.textContent = 'SUBTITLES';
    this.subsCheck = this.el('input', '', row5) as HTMLInputElement;
    this.subsCheck.type = 'checkbox'; this.subsCheck.checked = true;
    this.subsCheck.onchange = () => { this.subtitlesOn = this.subsCheck.checked; };

    this.el('p', 'hint', s).textContent = 'WASD move · SHIFT sprint · C crouch · ESC pause · F3 debug';
  }

  private togglePanel(): void {
    const p = document.getElementById('settings-panel')!;
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  }

  private pushSettings(): void {
    this.cbs.onSettingsChanged({
      sensitivity: parseFloat(this.sensSlider.value),
      volume: parseFloat(this.volSlider.value),
      quality: parseFloat(this.qualSelect.value),
      fov: parseFloat(this.fovSlider.value),
    });
  }

  loadSettings(s: SettingsData): void {
    this.sensSlider.value = String(s.sensitivity);
    this.volSlider.value = String(s.volume);
    this.qualSelect.value = String(s.quality);
    this.fovSlider.value = String(s.fov ?? 75);
    this.cbs.onSettingsChanged(s);
  }

  currentSettings(): SettingsData {
    return {
      sensitivity: parseFloat(this.sensSlider.value),
      volume: parseFloat(this.volSlider.value),
      quality: parseFloat(this.qualSelect.value),
      fov: parseFloat(this.fovSlider.value),
    };
  }

  private buildPause(): void {
    const p = this.el('div', 'screen pause-screen');
    p.style.display = 'none';
    this.pauseMenu = p;
    this.el('h2', 'pause-title', p).textContent = 'PAUSED — SIGNAL HELD';
    this.el('div', 'pause-summary', p);
    const col = this.el('div', 'menu-col', p);
    const r = this.el('button', 'btn primary', col) as HTMLButtonElement;
    r.textContent = 'RESUME';
    r.onclick = () => this.cbs.onResume();
    const s = this.el('button', 'btn', col) as HTMLButtonElement;
    s.textContent = 'SETTINGS';
    s.onclick = () => {
      // move the shared settings panel to root level so it overlays pause too
      const panel = document.getElementById('settings-panel');
      if (panel) {
        panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
        // reposition to center for pause context
        panel.style.position = 'fixed';
        panel.style.left = '50%';
        panel.style.top = '50%';
        panel.style.transform = 'translate(-50%, -50%)';
        panel.style.zIndex = '100';
      }
    };
    const q = this.el('button', 'btn danger', col) as HTMLButtonElement;
    q.textContent = 'SAVE & QUIT TO TITLE';
    q.onclick = () => this.cbs.onSaveQuit();
  }

  private buildHud(): void {
    const h = this.el('div', 'hud');
    h.style.display = 'none';
    this.hud = h;
    this.el('div', 'crosshair', h);
    const stam = this.el('div', 'stamina-wrap', h);
    this.staminaFill = this.el('div', 'stamina-fill', stam);
    this.batteryWrap = this.el('div', 'battery-wrap', h);
    this.torchIcon = this.el('span', 'torch-icon', this.batteryWrap);
    this.torchIcon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M6 3h12l-4 7v9a2 2 0 0 1-4 0v-9L6 3z"/><line x1="12" y1="13" x2="12" y2="16"/></svg>';
    this.batteryFill = this.el('div', 'battery-fill', this.batteryWrap);
    this.objectiveEl = this.el('div', 'objective', h);
    this.promptEl = this.el('div', 'prompt', h);
    this.subtitleEl = this.el('div', 'subtitle', h);
    // subtitle polish: italic serif, soft letter-spacing, layered text-shadow
    this.subtitleEl.style.fontFamily = "Georgia, 'Times New Roman', serif";
    this.subtitleEl.style.fontStyle = 'italic';
    this.subtitleEl.style.letterSpacing = '0.02em';
    this.subtitleEl.style.textShadow =
      '0 1px 4px #000, 0 0 14px rgba(0,0,0,0.85), 0 2px 8px rgba(0,0,0,0.9)';
    const loader = this.el('div', 'reconstructing');
    loader.textContent = 'RECONSTRUCTING';
    this.loadingEl = loader;
    this.toastArea = this.el('div', 'toast-area', h);
    const dbg = this.el('pre', 'debug-overlay', h);
    dbg.style.display = 'none';
    this.debugOverlay = dbg;
    this.endingEl = this.el('div', 'ending-overlay');
    this.endingEl.style.display = 'none';
    this.erosionEl = this.el('div', 'erosion-overlay');
    this.erosionEl.style.opacity = '0';
    document.body.appendChild(this.erosionEl);
    this.beaconFlash = this.el('div', 'beacon-flash');
    this.logEl = this.el('div', 'log-overlay');
    this.logEl.style.display = 'none';
    document.body.appendChild(this.logEl);
    this.noteEl = this.el('div', 'note-overlay');
    this.noteEl.style.display = 'none';
    document.body.appendChild(this.noteEl);
  }

  private noteOpenFlag = false;

  showNote(text: string): void {
    if (!this.noteEl) return;
    this.noteEl.innerHTML =
      '<div class="note-paper"><p>' + text + '</p><span>[E] put it down</span></div>';
    this.noteEl.style.display = 'flex';
    this.noteOpenFlag = true;
    this.inputRelease?.();
  }

  hideNote(): void {
    if (!this.noteEl) return;
    this.noteEl.style.display = 'none';
    this.noteOpenFlag = false;
  }

  get noteIsOpen(): boolean {
    return this.noteOpenFlag;
  }

  inputRelease: (() => void) | null = null;

  /** Diegetic expedition log (Tab). */
  setLog(open: boolean, lines?: string[]): void {
    this.logOpen = open;
    if (open && lines) {
      let html = '<h3>EXPEDITION LOG</h3>';
      for (const l of lines) html += '<p>' + l + '</p>';
      this.logEl.innerHTML = html;
    }
    this.logEl.style.display = open ? 'block' : 'none';
  }

  setErosion(v: number): void {
    this.erosionEl.style.opacity = String(Math.min(1, v).toFixed(2));
  }

  /** brief cyan pulse when a research beacon is contacted */
  flashBeacon(): void {
    if (!this.beaconFlash) return;
    this.beaconFlash.style.transition = 'none';
    this.beaconFlash.style.opacity = '0.55';
    requestAnimationFrame(() => {
      this.beaconFlash.style.transition = 'opacity 1.4s ease';
      this.beaconFlash.style.opacity = '0';
    });
  }

  /** torch charge bar: hidden until the player owns the flashlight */
  setBattery(v: number | null): void {
    if (v === null) {
      this.batteryWrap.style.display = 'none';
      return;
    }
    this.batteryWrap.style.display = 'block';
    this.batteryFill.style.width = (Math.max(0, Math.min(1, v)) * 100).toFixed(1) + '%';
    this.batteryFill.classList.toggle('low', v < 0.25);
    this.batteryFill.classList.toggle('on', v > 0 && this.torchOn);
    // pulse red when nearly dead (<20%)
    this.batteryWrap.classList.toggle('critical', v < 0.2);
    // torch icon dims while the light is off
    this.torchIcon.classList.toggle('lit', this.torchOn && v > 0);
  }

  torchOn = false;

  setPrompt(t: string | null): void {
    if (this.promptEl.textContent !== t) this.promptEl.textContent = t ?? '';
    this.promptEl.style.opacity = t ? '1' : '0';
  }

  setObjective(t: string): void {
    if (this.objectiveEl.textContent !== t) this.objectiveEl.textContent = t;
  }

  say(text: string, sec = 4): void {
    if (!this.subtitlesOn) return;
    this.subtitleEl.textContent = text;
    this.subtitleTimer = sec;
    this.subtitleEl.style.opacity = '1';
  }

  tickSubtitles(dt: number): void {
    if (this.subtitleTimer > 0) {
      this.subtitleTimer -= dt;
      if (this.subtitleTimer <= 0) this.subtitleEl.style.opacity = '0';
    }
  }

  showEnding(lines: string[], onDone: () => void): void {
    this.endingEl.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'ending-inner';
    // each line breathes in on its own beat (staggered 500ms)
    lines.forEach((l, i) => {
      const p = document.createElement('p');
      p.textContent = l;
      p.style.setProperty('--i', String(i));
      inner.appendChild(p);
    });
    // subtle pulsing separator before the coda
    const sep = document.createElement('div');
    sep.className = 'ending-sep';
    inner.appendChild(sep);
    // expedition seed stamp, small monospace at the bottom
    const seedEl = document.createElement('div');
    seedEl.className = 'ending-seed';
    seedEl.textContent = 'SEED ' + this.seedHex();
    inner.appendChild(seedEl);
    const b = document.createElement('button');
    b.style.setProperty('--i', String(lines.length + 1));
    b.className = 'btn';
    b.textContent = 'RETURN TO TITLE';
    b.onclick = onDone;
    inner.appendChild(b);
    this.endingEl.appendChild(inner);
    this.endingEl.style.display = 'flex';
    this.hud.style.display = 'none';
    this.pauseMenu.style.display = 'none';
  }

  showTitle(hasSave: boolean, summary?: string): void {
    if (this.endingEl) this.endingEl.style.display = 'none';
    this.titleScreen.style.display = 'flex';
    this.pauseMenu.style.display = 'none';
    this.hud.style.display = 'none';
    this.continueBtn.disabled = !hasSave;
    this.continueBtn.classList.toggle('disabled', !hasSave);
    this.continueBtn.textContent = hasSave && summary
      ? 'CONTINUE — ' + summary
      : 'CONTINUE';
  }

  showHud(): void {
    this.hideReconstructing();
    this.titleScreen.style.display = 'none';
    this.pauseMenu.style.display = 'none';
    this.hud.style.display = 'block';
  }

  /** "RECONSTRUCTING..." shown between NEW EXPEDITION click and first render. */
  showReconstructing(): void {
    if (!this.loadingEl) return;
    this.loadingEl.textContent = 'RECONSTRUCTING';
    this.loadingEl.style.display = 'block';
    let dots = 0;
    this.stopLoadingTimers();
    this.loadingDotsTimer = setInterval(() => {
      dots = (dots + 1) % 4;
      this.loadingEl.textContent = 'RECONSTRUCTING' + '.'.repeat(dots);
    }, 350);
    // safety net in case chunk generation stalls or errors out
    this.loadingSafetyTimer = setTimeout(() => this.hideReconstructing(), 12000);
  }

  hideReconstructing(): void {
    this.stopLoadingTimers();
    if (this.loadingEl) this.loadingEl.style.display = 'none';
  }

  private stopLoadingTimers(): void {
    if (this.loadingDotsTimer !== null) { clearInterval(this.loadingDotsTimer); this.loadingDotsTimer = null; }
    if (this.loadingSafetyTimer !== null) { clearTimeout(this.loadingSafetyTimer); this.loadingSafetyTimer = null; }
  }

  /** Deterministic hex fingerprint of the current expedition seed. */
  private seedHex(): string {
    const s = this.pendingSeed || String(Date.now());
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return '0x' + (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }

  showPause(): void {
    this.pauseMenu.style.display = 'flex';
  }

  setPauseSummary(t: string): void {
    const el = document.querySelector('.pause-summary');
    if (el) el.textContent = t;
  }

  hidePause(): void {
    this.pauseMenu.style.display = 'none';
  }

  /** Max simultaneous toasts; older ones are pushed out early. */
  private static readonly MAX_TOASTS = 3;

  toast(msg: string, ms = 5000): void {
    const t = this.el('div', 'toast', this.toastArea);
    t.textContent = msg;
    // start off-screen right, slide in
    t.style.opacity = '0';
    t.style.transform = 'translateX(64px)';
    const now = Date.now();
    const entry = {
      el: t,
      expiresAt: now + ms,
      fadeTimer: setTimeout(() => { /* replaced below */ }, 0),
    };
    this.toastQueue.push(entry);
    requestAnimationFrame(() => {
      t.style.transition =
        'opacity 0.4s ease, transform 0.55s cubic-bezier(0.16, 1, 0.3, 1)';
      t.style.opacity = '1';
      t.style.transform = 'translateX(0)';
    });
    this.scheduleToastFade(entry, ms, 0.6);
    // every older toast decays sooner and fades faster as the queue grows
    let rank = 0;
    for (let i = this.toastQueue.length - 2; i >= 0; i--) {
      rank++;
      const e = this.toastQueue[i];
      if (e.removeTimer) continue;
      e.expiresAt = Math.min(e.expiresAt, Date.now() + Math.max(0, e.expiresAt - Date.now()) * 0.65);
      this.scheduleToastFade(e, e.expiresAt - Date.now(), Math.max(0.15, 0.6 - rank * 0.15));
    }
    this.enforceToastLimit();
  }

  /** Fade a toast out over fadeSec seconds, then remove it from the DOM. */
  private scheduleToastFade(
    entry: { el: HTMLElement; expiresAt: number; fadeTimer: ReturnType<typeof setTimeout>; removeTimer?: ReturnType<typeof setTimeout> },
    delayMs: number,
    fadeSec: number,
  ): void {
    clearTimeout(entry.fadeTimer);
    if (entry.removeTimer) return; // already on its way out
    entry.fadeTimer = setTimeout(() => {
      entry.el.style.transition = `opacity ${fadeSec}s ease, transform ${fadeSec}s ease`;
      entry.el.style.opacity = '0';
      entry.el.style.transform = 'translateY(-8px)';
      entry.removeTimer = setTimeout(() => {
        entry.el.remove();
        const i = this.toastQueue.indexOf(entry);
        if (i >= 0) this.toastQueue.splice(i, 1);
      }, fadeSec * 1000 + 80);
    }, Math.max(0, delayMs));
  }

  /** Hard cap: never more than MAX_TOASTS visible at once. */
  private enforceToastLimit(): void {
    this.toastQueue = this.toastQueue.filter((e) => e.el.isConnected);
    while (this.toastQueue.length > UI.MAX_TOASTS) {
      const oldest = this.toastQueue.shift()!;
      this.scheduleToastFade(oldest, 0, 0.25);
    }
  }

  setStamina(v: number): void {
    this.staminaFill.style.width = (v * 100).toFixed(1) + '%';
    this.staminaFill.classList.toggle('low', v < 0.25);
  }

  /** called each frame with perf numbers */
  updateDebug(dtMs: number, info: Record<string, string | number>): void {
    if (!this.debugVisible) return;
    this.fpsAccum += dtMs; this.fpsFrames++;
    if (this.fpsAccum > 400) {
      this.fpsShown = Math.round(1000 / (this.fpsAccum / this.fpsFrames));
      this.fpsAccum = 0; this.fpsFrames = 0;
    }
    let s = 'FPS ~' + this.fpsShown + '\n';
    for (const [k, v] of Object.entries(info)) s += k + ': ' + v + '\n';
    this.debugOverlay.textContent = s;
  }

  toggleDebug(): boolean {
    this.debugVisible = !this.debugVisible;
    this.debugOverlay.style.display = this.debugVisible ? 'block' : 'none';
    return this.debugVisible;
  }
}


