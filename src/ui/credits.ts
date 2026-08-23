    // Only backdrop clicks close; clicks inside the panel stay.
    if (ev.target === this.overlay) this.hide();
  };

  private onKey = (ev: KeyboardEvent): void => {
    if (!this.openState) return;
    const k = ev.key;
    if (k === 'Escape' || k === 'Esc') this.hide();
  };
}


