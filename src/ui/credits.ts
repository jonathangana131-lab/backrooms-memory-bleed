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


(Showing lines 330-379 of 445. Use offset=380 to continue.)

// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
    // Only backdrop clicks close; clicks inside the panel stay.
    if (ev.target === this.overlay) this.hide();
  };

  private onKey = (ev: KeyboardEvent): void => {
    if (!this.openState) return;
    const k = ev.key;
    if (k === 'Escape' || k === 'Esc') this.hide();
  };
}


