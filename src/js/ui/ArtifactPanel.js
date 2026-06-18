// src/js/ui/ArtifactPanel.js
//
// Floating "Scene Analysis" panel — toggles pipeline artifact visualizations.
// Completely standalone: no pipeline imports, no cameraContainer access.
// Reads artifact availability from ArtifactRenderer.list() every 600ms.
//
// Visual identity: BLUE accent (#89b4fa) — deliberately distinct from
// the AMBER Composite Drawer (#fab387) so the user always knows which
// system they are looking at.

// ── Artifact catalogue ────────────────────────────────────────────────────
// Only artifacts with confirmed field names from actual pipeline logs are
// included here. Unconfirmed artifacts are commented out until verified.
// The panel auto-shows/hides buttons based on registry availability,
// so adding an entry here before its upload code exists is harmless —
// the button simply never appears.

const STAGE_GROUPS = [
  {
    label: 'Topology · Structure',
    artifacts: [
      {
        name:   'topologyMap',
        label:  'Topology Regions',
        desc:   'Per-pixel topological region identity',
        mode:   'label',
        params: { background: 0, opacity: 0.78 }
      },
      {
        name:   'componentMap',
        label:  'Components',
        desc:   'Connected component labelling',
        mode:   'label',
        params: { background: 0, opacity: 0.78 }
      },
      {
        name:   'phiMin',
        label:  'Level Set φ',
        desc:   'Energy-minimised SDF — animated contours',
        mode:   'contour_animated',
        params: { min: -0.1, max: 0.1, opacity: 0.88,
                  scrollSpeed: 0.12, contourDensity: 12.0 }
      },
    ]
  },
  {
    label: 'Surface · Warp',
    artifacts: [
      {
        name:   'warpField',
        label:  'Warp Field (UV)',
        desc:   'Surface UV parameterisation — (r, θ) per pixel',
        mode:   'flow',
        params: { maxMag: 3.15, opacity: 0.85 }
      },
      {
        name:   'worldFrameMap',
        label:  'World Frame Map',
        desc:   'Temporal surface identity — which element does this pixel see?',
        mode:   'label',
        params: { background: 0, opacity: 0.75 }
      },
    ]
  },
  // ── Below: entries kept for future use, upload code not yet added ──────
  // {
  //   label: 'Motion · Optical',
  //   artifacts: [
  //     { name: 'flowUV',           label: 'Optical Flow',   ... },
  //     { name: 'directionalField', label: 'Directional Field', ... },
  //     { name: 'coherence',        label: 'Coherence',      ... },
  //   ]
  // },
  // {
  //   label: 'Energy · Motion Groups',
  //   artifacts: [
  //     { name: 'kemField',    label: 'Kinetic Energy', ... },
  //     { name: 'cladeMap',    label: 'Motion Clades',  ... },
  //     { name: 'tensionField',label: 'Tension',        ... },
  //   ]
  // },
];

// Flat lookup for quick access in _fire()
const ARTIFACT_META = {};
for (const group of STAGE_GROUPS) {
  for (const a of group.artifacts) {
    ARTIFACT_META[a.name] = a;
  }
}

export class ArtifactPanel {
  /**
   * @param {Object} opts
   *   artifactRenderer {ArtifactRenderer}
   *   onActivate       {Function(name, mode, params)}  — called on button click
   *   onClear          {Function()}                    — called on "Camera Only"
   */
  constructor({ artifactRenderer, onActivate, onClear } = {}) {
    this._ar         = artifactRenderer;
    this._onActivate = onActivate || (() => {});
    this._onClear    = onClear    || (() => {});

    this._activeName   = null;
    this._opacity      = 0.85;
    this._collapsed    = false;

    this._panelEl      = null;
    this._listEl       = null;
    this._indicatorEl  = null;
    this._refreshTimer = null;

    this._buildPanel();
    this._buildIndicator();
    this._startAutoRefresh();
  }

  // ── Panel DOM ───────────────────────────────────────────────────────────

  _buildPanel() {
    const el = document.createElement('div');
    el.className   = 'ap-panel';
    el.id          = 'artifact-panel';
    el.setAttribute('role', 'complementary');
    el.setAttribute('aria-label', 'Pipeline artifact visualization panel');

    el.innerHTML = `
      <div class="ap-header">
        <span class="ap-title">⬡ Scene Analysis</span>
        <div class="ap-header-actions">
          <span class="ap-count" id="ap-count">0</span>
          <button class="ap-collapse-btn" id="ap-collapse" title="Collapse">−</button>
        </div>
      </div>
      <div class="ap-body" id="ap-body">
        <div class="ap-controls-row">
          <span class="ap-label">Opacity</span>
          <input class="ap-slider" type="range" id="ap-opacity"
                 min="0" max="100" value="${Math.round(this._opacity * 100)}">
          <span class="ap-slider-val" id="ap-opacity-val">
            ${Math.round(this._opacity * 100)}%
          </span>
        </div>
        <div class="ap-artifact-list" id="ap-artifact-list">
          <div class="ap-placeholder">
            No artifacts yet.<br>Pipeline will populate this panel.
          </div>
        </div>
        <button class="ap-clear-btn" id="ap-clear-btn">◎ Camera Only</button>
      </div>`;

    document.body.appendChild(el);
    this._panelEl = el;
    this._listEl  = el.querySelector('#ap-artifact-list');

    this._wirePanelEvents();
  }

  _wirePanelEvents() {
    const el = this._panelEl;

    // Collapse / expand
    el.querySelector('#ap-collapse').addEventListener('click', () => {
      this._collapsed = !this._collapsed;
      el.querySelector('#ap-body').style.display   = this._collapsed ? 'none' : '';
      el.querySelector('#ap-collapse').textContent = this._collapsed ? '+' : '−';
    });

    // Opacity slider — updates active artifact live
    const slider    = el.querySelector('#ap-opacity');
    const sliderVal = el.querySelector('#ap-opacity-val');
    slider.addEventListener('input', () => {
      this._opacity      = slider.value / 100;
      sliderVal.textContent = slider.value + '%';
      if (this._activeName) this._fire(this._activeName);
    });

    // Camera-only button
    el.querySelector('#ap-clear-btn').addEventListener('click', () => {
      this._setActive(null);
      this._onClear();
      this._hideIndicator();
    });
  }

  // ── Canvas indicator badge ──────────────────────────────────────────────
  // Mounted inside .viewport so it sits within the canvas area.
  // Always tells the viewer exactly what they are looking at.

  _buildIndicator() {
    const el = document.createElement('div');
    el.className = 'artifact-indicator hidden';
    el.id        = 'artifact-indicator';
    el.innerHTML = `
      <span class="ai-dot"></span>
      <span class="ai-name" id="ai-name">—</span>
      <span class="ai-desc" id="ai-desc"></span>
      <span class="ai-mode-badge" id="ai-mode-badge"></span>
      <button class="ai-dismiss" id="ai-dismiss" title="Return to camera only">✕</button>`;

    // Attach to .viewport so the badge stays within the canvas
    const viewport = document.querySelector('.viewport') || document.body;
    viewport.appendChild(el);
    this._indicatorEl = el;

    el.querySelector('#ai-dismiss').addEventListener('click', () => {
      this._setActive(null);
      this._onClear();
      this._hideIndicator();
    });
  }

  _showIndicator(name, mode) {
    const meta = ARTIFACT_META[name] || { label: name, desc: '' };
    const el   = this._indicatorEl;
    if (!el) return;

    el.querySelector('#ai-name').textContent      = meta.label;
    el.querySelector('#ai-desc').textContent      = meta.desc ? ' — ' + meta.desc : '';
    el.querySelector('#ai-mode-badge').textContent = mode;

    // Remove any previous mode class and apply the current one
    el.className = el.className.replace(/\bmode-\S+/g, '').trim();
    el.classList.add(`mode-${mode.replace(/_/g, '-')}`);
    el.classList.remove('hidden');
  }

  _hideIndicator() {
    if (this._indicatorEl) this._indicatorEl.classList.add('hidden');
  }

  // ── Artifact list ───────────────────────────────────────────────────────

  _refresh() {
    if (!this._ar) return;

    const available = new Set(this._ar.list().map(e => e.name));
    const count     = available.size;

    // Update count badge
    const countEl = this._panelEl.querySelector('#ap-count');
    if (countEl) countEl.textContent = count;

    if (count === 0) {
      this._listEl.innerHTML =
        '<div class="ap-placeholder">No artifacts yet — pipeline will populate this.</div>';
      return;
    }

    // Build grouped button list from STAGE_GROUPS filtered to what is available
    let html = '';
    let any  = false;

    for (const group of STAGE_GROUPS) {
      const inGroup = group.artifacts.filter(a => available.has(a.name));
      if (!inGroup.length) continue;
      any = true;

      html += `<div class="ap-group">`;
      html += `<div class="ap-group-label">${group.label}</div>`;
      html += `<div class="ap-group-buttons">`;

      for (const a of inGroup) {
        const isActive   = this._activeName === a.name;
        const modeClass  = `ap-mode-${a.mode.replace(/_/g, '-')}`;
        const activeClass = isActive ? ' ap-btn-active' : '';
        html += `<button class="ap-artifact-btn ${modeClass}${activeClass}"
                         data-name="${a.name}"
                         title="${a.desc}">${a.label}</button>`;
      }

      html += `</div></div>`;
    }

    if (!any) {
      html = '<div class="ap-placeholder">Artifacts loading…</div>';
    }

    // Only rewrite DOM when content actually changes
    if (this._listEl.innerHTML !== html) {
      this._listEl.innerHTML = html;
      // Wire click handlers on freshly-created buttons
      this._listEl.querySelectorAll('.ap-artifact-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.name;
          this._setActive(name);
          this._fire(name);
        });
      });
    }
  }

  _fire(name) {
    const meta = ARTIFACT_META[name];
    if (!meta) return;
    const params = { ...(meta.params || {}), opacity: this._opacity };
    this._onActivate(name, meta.mode, params);
    this._showIndicator(name, meta.mode);
  }

  _setActive(name) {
    this._activeName = name;
    // Sync highlighted state on all visible buttons
    this._listEl.querySelectorAll('.ap-artifact-btn').forEach(btn => {
      btn.classList.toggle('ap-btn-active', btn.dataset.name === name);
    });
  }

  // ── Auto-refresh ────────────────────────────────────────────────────────

  _startAutoRefresh() {
    // Poll every 600ms — fast enough to feel responsive, slow enough to
    // avoid unnecessary DOM thrash.
    this._refreshTimer = setInterval(() => this._refresh(), 600);
    this._refresh(); // immediate first render
  }

  // ── Public API ──────────────────────────────────────────────────────────

  destroy() {
    clearInterval(this._refreshTimer);
    if (this._panelEl?.parentNode) {
      this._panelEl.parentNode.removeChild(this._panelEl);
    }
    if (this._indicatorEl?.parentNode) {
      this._indicatorEl.parentNode.removeChild(this._indicatorEl);
    }
  }
}

export { ARTIFACT_META };
export default ArtifactPanel;