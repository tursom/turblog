// @ts-check

(() => {
  const panel = document.querySelector('[data-footnote-preview-panel]');
  const content = panel?.querySelector('[data-footnote-preview-content]');
  if (!(panel instanceof HTMLElement) || !(content instanceof HTMLElement)) return;

  const referenceSelector = 'a[data-footnote-preview-ref]';
  const panelId = panel.id;
  const coarsePointer = matchMedia('(hover: none), (pointer: coarse)');
  /** @type {HTMLAnchorElement | null} */
  let activeReference = null;
  /** @type {HTMLAnchorElement | null} */
  let armedReference = null;
  /** @type {string | null} */
  let lastPointerType = null;
  /** @type {number | undefined} */
  let closeTimer;
  /** @type {number | undefined} */
  let positionFrame;

  /** @param {EventTarget | null} target */
  const referenceFrom = (target) => {
    if (!(target instanceof Element)) return null;
    const reference = target.closest(referenceSelector);
    return reference instanceof HTMLAnchorElement ? reference : null;
  };

  /** @param {HTMLAnchorElement} reference */
  const targetFor = (reference) => {
    const href = reference.getAttribute('href');
    if (!href?.startsWith('#')) return null;
    try {
      return document.getElementById(decodeURIComponent(href.slice(1)));
    } catch {
      return null;
    }
  };

  /** @param {Node} target @param {'start' | 'end'} direction */
  const cloneBoundedContent = (target, direction) => {
    const parent = target.parentNode;
    if (!parent) return document.createDocumentFragment();

    const range = document.createRange();
    if (direction === 'start') {
      range.setStartAfter(target);
      let boundary = target.nextSibling;
      while (boundary) {
        if (boundary instanceof HTMLElement && boundary.dataset.footnotePreviewTarget === 'start') {
          break;
        }
        boundary = boundary.nextSibling;
      }
      if (boundary) range.setEndBefore(boundary);
      else range.setEnd(parent, parent.childNodes.length);
    } else {
      let boundary = target.previousSibling;
      while (boundary) {
        if (boundary instanceof HTMLElement && boundary.dataset.footnotePreviewTarget === 'end') {
          break;
        }
        boundary = boundary.previousSibling;
      }
      if (boundary) range.setStartAfter(boundary);
      else range.setStart(parent, 0);
      range.setEndBefore(target);
    }
    return range.cloneContents();
  };

  /** @param {Element} target */
  const cloneFootnote = (target) => {
    const kind = target.getAttribute('data-footnote-preview-target');
    let fragment;
    if (kind === 'start' || kind === 'end') fragment = cloneBoundedContent(target, kind);
    else {
      fragment = document.createDocumentFragment();
      for (const child of target.childNodes) fragment.append(child.cloneNode(true));
    }

    const wrapper = document.createElement('div');
    wrapper.append(fragment);
    wrapper.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    wrapper.querySelectorAll('[data-footnote-backref]').forEach((element) => element.remove());
    wrapper
      .querySelectorAll('a[data-footnote-preview-ref], a[data-footnote-ref]')
      .forEach((link) => link.replaceWith(...link.childNodes));
    return wrapper;
  };

  const clearCloseTimer = () => {
    if (closeTimer !== undefined) window.clearTimeout(closeTimer);
    closeTimer = undefined;
  };

  const positionPanel = () => {
    positionFrame = undefined;
    if (!activeReference || panel.hidden) return;
    const referenceRect = activeReference.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const above = referenceRect.top - panelRect.height - gap;
    const below = referenceRect.bottom + gap;
    const top =
      above >= margin
        ? above
        : below + panelRect.height <= window.innerHeight - margin
          ? below
          : Math.max(margin, Math.min(window.innerHeight - panelRect.height - margin, above));
    const centered = referenceRect.left + referenceRect.width / 2 - panelRect.width / 2;
    const left = Math.max(margin, Math.min(window.innerWidth - panelRect.width - margin, centered));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.visibility = 'visible';
  };

  const schedulePosition = () => {
    if (positionFrame !== undefined) return;
    positionFrame = requestAnimationFrame(positionPanel);
  };

  /** @param {boolean} [restoreFocus] */
  const closePreview = (restoreFocus = false) => {
    clearCloseTimer();
    if (restoreFocus && activeReference) activeReference.focus();
    if (activeReference) activeReference.setAttribute('aria-expanded', 'false');
    activeReference = null;
    panel.hidden = true;
    panel.style.visibility = 'hidden';
    content.replaceChildren();
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer = window.setTimeout(() => {
      const focused = document.activeElement;
      if (
        armedReference === activeReference ||
        focused === activeReference ||
        (focused instanceof Node && panel.contains(focused)) ||
        panel.matches(':hover') ||
        activeReference?.matches(':hover')
      ) {
        return;
      }
      closePreview();
    }, 120);
  };

  /** @param {HTMLAnchorElement} reference */
  const openPreview = (reference) => {
    const target = targetFor(reference);
    if (!target) return false;
    const clone = cloneFootnote(target);
    if (!clone.textContent?.trim() && !clone.querySelector('img, video, audio')) return false;

    clearCloseTimer();
    if (activeReference && activeReference !== reference) {
      activeReference.setAttribute('aria-expanded', 'false');
    }
    activeReference = reference;
    reference.setAttribute('aria-controls', panelId);
    reference.setAttribute('aria-expanded', 'true');
    panel.setAttribute('aria-label', `脚注 ${reference.textContent?.trim() || ''} 预览`);
    content.replaceChildren(...clone.childNodes);
    panel.style.visibility = 'hidden';
    panel.hidden = false;
    schedulePosition();
    return true;
  };

  /** @returns {HTMLElement[]} */
  const panelFocusables = () =>
    Array.from(
      panel.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element instanceof HTMLElement);

  /** @param {HTMLAnchorElement} reference */
  const nextFocusableAfter = (reference) => {
    const focusables = Array.from(
      document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        element instanceof HTMLElement &&
        !panel.contains(element) &&
        element.getClientRects().length > 0,
    );
    const index = focusables.indexOf(reference);
    return index >= 0 ? focusables[index + 1] : undefined;
  };

  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const reference = referenceFrom(event.target);
    if (reference) openPreview(reference);
    else if (event.target instanceof Node && panel.contains(event.target)) clearCloseTimer();
  });

  document.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'touch') return;
    if (
      referenceFrom(event.target) === activeReference ||
      (event.target instanceof Node && panel.contains(event.target))
    ) {
      scheduleClose();
    }
  });

  document.addEventListener('focusin', (event) => {
    const reference = referenceFrom(event.target);
    if (reference) openPreview(reference);
    else if (event.target instanceof Node && panel.contains(event.target)) clearCloseTimer();
  });

  document.addEventListener('focusout', (event) => {
    if (
      referenceFrom(event.target) === activeReference ||
      (event.target instanceof Node && panel.contains(event.target))
    ) {
      scheduleClose();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    lastPointerType = event.pointerType;
    const reference = referenceFrom(event.target);
    if (!reference && !(event.target instanceof Node && panel.contains(event.target))) {
      armedReference = null;
      closePreview();
    }
  });

  document.addEventListener('click', (event) => {
    const reference = referenceFrom(event.target);
    if (reference) {
      const touchActivation =
        event.detail > 0 &&
        (lastPointerType === 'touch' || (lastPointerType === null && coarsePointer.matches));
      lastPointerType = null;
      if (touchActivation && (armedReference !== reference || activeReference !== reference)) {
        event.preventDefault();
        if (openPreview(reference)) armedReference = reference;
        return;
      }
      armedReference = null;
      closePreview();
      return;
    }
    if (event.target instanceof Node && panel.contains(event.target)) {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (link) {
        armedReference = null;
        closePreview();
      }
      return;
    }
    armedReference = null;
    closePreview();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeReference) {
      event.preventDefault();
      closePreview(panel.contains(document.activeElement));
      armedReference = null;
      return;
    }
    if (event.key !== 'Tab' || !activeReference || panel.hidden) return;

    const focusables = panelFocusables();
    const firstPanelFocus = focusables[0] ?? panel;
    const lastPanelFocus = focusables.at(-1) ?? panel;
    if (!event.shiftKey && document.activeElement === activeReference) {
      event.preventDefault();
      firstPanelFocus.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === firstPanelFocus) {
      event.preventDefault();
      activeReference.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === lastPanelFocus) {
      const next = nextFocusableAfter(activeReference);
      if (next instanceof HTMLElement) {
        event.preventDefault();
        closePreview();
        next.focus();
      }
    }
  });

  addEventListener('resize', schedulePosition);
  addEventListener('scroll', schedulePosition, true);
  new ResizeObserver(schedulePosition).observe(panel);
})();
