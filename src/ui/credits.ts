/**
 * Credits roll: the ABOUT / endgame scrolling credits overlay.
 *
 * A full-screen dimmed overlay carrying a slow upward-scrolling panel of
 * section blocks. Opened from an ABOUT button injected into the title
 * screen's menu column directly below SETTINGS, and from the ending flow.
 * Backdrop clicks and Escape dismiss it; interaction inside the panel is
 * left alone so text selection and link hovers survive.
 *
 * Pure DOM: no engine dependencies, safe to mount headless in tests.
 */

/** Style property bag view of CSSStyleDeclaration for string assignment. */
interface StyleBag {
  [prop: string]: string;
}

/**
 * Structural minimum of a DOM element this module walks. Everything else
 * about the title screen stays opaque, so injection works against any
 * host markup that carries the expected class tokens.
 */
interface MinimalElement {
  children: { length: number; item(index: number): MinimalElement | null } | MinimalElement[];
  textContent?: string | null;
  tagName?: string;
  classList?: { contains(token: string): boolean };
}

/** One credits block: a heading plus its role/name rows. */
interface CreditsSection {
  heading: string;
  rows: ReadonlyArray<{ role: string; name: string }>;
}

/** True when the element's class attribute carries the given token. */
function hasClassToken(el: MinimalElement, token: string): boolean {
  return el.classList ? el.classList.contains(token) : false;
}

/**
 * Depth-first search for the first descendant whose class list contains
 * the given token. Returns null when the host markup has none.
 */
function findByClassToken(root: MinimalElement, token: string): MinimalElement | null {
  const kids = root.children;
  const count = kids.length;
  for (let i = 0; i < count; i++) {
    const child = kids[i];
    if (!child) continue;
    if (hasClassToken(child, token)) return child;
    const nested = findByClassToken(child, token);
    if (nested) return nested;
  }
  return null;
}

/** The roll itself, newest layer of the building first. */
const SECTIONS: readonly CreditsSection[] = [
  {
    heading: 'BACKROOMS: MEMORY BLEED',
    rows: [
      { role: '', name: 'a recovery of the session that was' },
    ],
  },
  {
    heading: 'WORLD ARCHITECTURE',
    rows: [
      { role: 'The Lattice', name: 'procedural district planner' },
      { role: 'The Rooms', name: 'chunk mesher & material atlases' },
      { role: 'The Weather', name: 'fog, drip and hum systems' },
    ],
  },
  {
    heading: 'ENTITIES',
    rows: [
      { role: 'Direction', name: 'horror director & tension curves' },
      { role: 'Company', name: 'crowd simulation and vocal loops' },
    ],
  },
  {
    heading: 'SOUND',
    rows: [
      { role: 'Ambience', name: 'fluorescent hum harmonics' },
      { role: 'Structure', name: 'creak variety & chain sway cues' },
    ],
  },
  {
    heading: 'FIELD SURVEYORS',
    rows: [
      { role: 'QA', name: 'everyone who walked the halls headless' },
    ],
  },
  {
    heading: 'SPECIAL THANKS',
    rows: [
      { role: '', name: 'The Management appreciates your compliance.' },
      { role: '', name: 'No memory was harmed in its bleeding.' },
    ],
  },
];

/**
 * Owns the overlay lifecycle: construction, ABOUT-button injection, open/
 * close state, staggered scroll restarts and input dismissal.
 */
export class CreditsRoll {
  private readonly doc: Document;
  /** Full-screen backdrop; also the click-to-dismiss surface. */
  private overlay: HTMLElement;
  /** Scrolling content panel inside the overlay. */
  private panel: HTMLElement;
  /** ABOUT button injected into the title screen menu (if any). */
  private aboutBtn: HTMLButtonElement | null = null;
  /** Whether the roll is currently on screen. */
  private openState = false;

  constructor(container: HTMLElement = document.body, doc: Document = document) {
    this.doc = doc;
    this.overlay = this.buildOverlay(container);
    this.panel = this.buildPanel(this.overlay);
    this.populate();
    container.appendChild(this.overlay);
    this.aboutBtn = this.injectTitleButton();
  }

  /** True while the roll is visible. */
  get isOpen(): boolean {
    return this.openState;
  }

  /** Show when hidden, hide when shown. */
  toggle(): void {
    if (this.openState) this.hide();
    else this.show();
  }

  /** Raise the overlay and restart the staggered scroll animation. */
  show(): void {
    if (this.openState) return;
    this.openState = true;
    this.overlay.style.display = 'flex';
    // Restart the CSS scroll: re-adding the animation class after a reflow
    // resets every row's staggered animationDelay timeline.
    this.panel.classList.remove('credits-animate');
    void (this.panel as unknown as { offsetWidth: number }).offsetWidth;
    this.panel.classList.add('credits-animate');
    window.addEventListener('keydown', this.onKey, true);
  }

  /** Lower the overlay. Safe to call when already hidden. */
  hide(): void {
    if (!this.openState) return;
    this.openState = false;
    this.overlay.style.display = 'none';
    window.removeEventListener('keydown', this.onKey, true);
  }

  /** Build the backdrop element (not yet attached). */
  private buildOverlay(container: HTMLElement): HTMLElement {
    const overlay = this.doc.createElement('div');
    overlay.className = 'credits-overlay';
    overlay.style.cssText =
      'position:absolute;inset:0;display:none;align-items:center;' +
      'justify-content:center;background:rgba(8,8,6,0.88);z-index:60;';
    overlay.addEventListener('click', this.onBackdropClick);
    void container;
    return overlay;
  }

  /** Build the scrolling panel and its static chrome. */
  private buildPanel(overlay: HTMLElement): HTMLElement {
    const panel = this.doc.createElement('div');
    panel.className = 'credits-panel';
    panel.style.cssText =
      'width:min(560px,80vw);max-height:70vh;overflow:hidden;text-align:center;';
    const close = this.doc.createElement('button');
    close.className = 'btn credits-close';
    close.textContent = 'CLOSE';
    close.addEventListener('click', () => this.hide());
    overlay.appendChild(panel);
    overlay.appendChild(close);
    return panel;
  }

  /** Fill the panel with the section blocks of the roll. */
  private populate(): void {
    let index = 0;
    const title = this.makeEl('credits-title', 'h2');
    title.textContent = 'BACKROOMS: MEMORY BLEED';
    index++;
    for (const section of SECTIONS) {
      const block = this.makeEl('credits-section', 'section');
      const heading = this.makeEl('credits-heading', 'h3');
      heading.textContent = section.heading;
      block.appendChild(heading);
      for (const row of section.rows) {
        const line = this.makeEl('credits-row', 'div');
        if (row.role) {
          const role = this.makeEl('credits-role', 'span');
          role.textContent = row.role + ' — ';
          line.appendChild(role);
        }
        const name = this.makeEl('credits-name', 'span');
        name.textContent = row.name;
        line.appendChild(name);
        index++;
      }
    }
    const sep = this.makeEl('credits-end', 'p');
    sep.textContent = '· · ·';
    void index;
  }

  /**
   * Create one styled panel child. `index` staggers its scroll
   * animation start so long names drift into view after their headings.
   */
  private makeEl(cls: string, tag = 'div', index = -1): HTMLElement {
    const el = this.doc.createElement(tag);
    el.className = cls;
    if (index >= 0) {
      (el.style as unknown as StyleBag)['animationDelay'] =
        (index * 0.32).toFixed(2) + 's';
    }
    this.panel.appendChild(el);
    return el;
  }

  /**
   * Locate the title screen's menu column inside the container and add an
   * ABOUT button directly below SETTINGS. Returns the button (attached, or
   * detached when no title-screen menu exists in this container).
   */
  private injectTitleButton(): HTMLButtonElement {
    const root = (this.overlay.parentNode ?? this.overlay) as unknown as MinimalElement;
    const screen = findByClassToken(root, 'title-screen');
    const menu = screen ? findByClassToken(screen, 'menu-col') : null;
    const btn = this.makeAboutButton();
    if (!menu) return btn;
    let anchor: MinimalElement | null = null;
    for (const child of menu.children) {
      const text = typeof child.textContent === 'string' ? child.textContent : '';
      const isButtonish =
        hasClassToken(child, 'btn') ||
        String((child as { tagName?: unknown }).tagName ?? '').toUpperCase() === 'BUTTON';
      if (isButtonish && text.indexOf('SETTINGS') === 0) {
        anchor = child;
        break;
      }
    }
    const host = menu as unknown as {
      insertBefore?(node: HTMLButtonElement, ref: MinimalElement | null): unknown;
      appendChild?(c: HTMLButtonElement): unknown;
    };
    if (anchor && typeof host.insertBefore === 'function') {
      host.insertBefore(btn, anchor);
    } else if (typeof host.appendChild === 'function') {
      host.appendChild(btn);
    }
    return btn;
  }

  private makeAboutButton(): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'ABOUT';
    btn.addEventListener('click', () => this.toggle());
    return btn;
  }

  /** Drop the overlay, its listeners and the injected ABOUT button. */
  dispose(): void {
    this.hide();
    this.overlay.removeEventListener('click', this.onBackdropClick);
    this.aboutBtn?.remove();
    this.overlay.remove();
  }

  /** Backdrop dismissal handler installed at construction. */
  private onBackdropClick = (ev: MouseEvent): void => {
    // Only backdrop clicks close; clicks inside the panel stay.
    if (ev.target === this.overlay) this.hide();
  };

  private onKey = (ev: KeyboardEvent): void => {
    if (!this.openState) return;
    const k = ev.key;
    if (k === 'Escape' || k === 'Esc') this.hide();
  };
}

/**
 * Mount a credits roll onto `container` (default document body) and
 * return it. Callers own the returned instance's dispose() lifecycle.
 */
export function mountCredits(
  container: HTMLElement = document.body,
  doc: Document = document,
): CreditsRoll {
  return new CreditsRoll(container, doc);
}
