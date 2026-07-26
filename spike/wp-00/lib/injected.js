/*
 * WP-00 spike — in-page probe. DISPOSABLE. Not to be imported by any later package.
 *
 * Installs window.__probe with the primitives Track B and Track C measure:
 *   - ref strategies (candidate element-identity recipes)
 *   - regionDigest recipes (candidate change-detection recipes)
 *   - a compact AX-ish projection used for token-cost comparison
 *
 * Everything here is deliberately hand-rolled: the point of the spike is to
 * measure candidate recipes, not to inherit someone else's.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function accessibleName(el) {
    // Deliberately simplified: aria-label > associated <label> > title >
    // alt > trimmed own text. Mirrors what an adapter author would rely on.
    var v = el.getAttribute && el.getAttribute('aria-label');
    if (norm(v)) return norm(v);
    if (el.id) {
      var lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && norm(lab.textContent)) return norm(lab.textContent);
    }
    var closestLabel = el.closest ? el.closest('label') : null;
    if (closestLabel && norm(closestLabel.textContent)) return norm(closestLabel.textContent);
    if (norm(el.getAttribute && el.getAttribute('title'))) return norm(el.getAttribute('title'));
    if (norm(el.getAttribute && el.getAttribute('alt'))) return norm(el.getAttribute('alt'));
    var t = norm(el.textContent);
    return t.length <= 120 ? t : t.slice(0, 120);
  }

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role');
    if (norm(explicit)) return norm(explicit);
    var tag = el.tagName.toLowerCase();
    var map = {
      a: 'link', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading',
      ul: 'list', ol: 'list', li: 'listitem', table: 'table', img: 'img',
      section: 'region', main: 'main', header: 'banner', nav: 'navigation',
      iframe: 'iframe', dt: 'term', dd: 'definition', label: 'label'
    };
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'number' || type === 'text') return 'textbox';
      return 'input-' + type;
    }
    return map[tag] || tag;
  }

  function isVisible(el) {
    if (!el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // -------------------------------------------------------- ref strategies
  // A "ref" is a string an agent could hold across turns. Each strategy must
  // implement make(el) -> ref | null, and resolve(ref) -> Element | null.

  function domPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var parent = node.parentElement;
      if (!parent) break;
      var idx = 1;
      var sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) idx++;
      }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + idx + ')');
      node = parent;
    }
    return parts.join('>');
  }

  function axPath(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 12) {
      var role = roleOf(node);
      var name = accessibleName(node);
      // index among siblings with the same role, to disambiguate
      var idx = 0;
      var sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (roleOf(sib) === role) idx++;
      }
      parts.unshift(role + '[' + (name ? name.slice(0, 60) : '') + ']#' + idx);
      node = node.parentElement;
      depth++;
    }
    return parts.join('/');
  }

  var STRATEGIES = {
    // S1 — positional DOM path. Cheap, no adapter knowledge, notoriously brittle.
    'dom-path': {
      make: function (el) { return domPath(el); },
      resolve: function (ref) {
        try { return document.querySelector(ref.split('>').join(' > ')); } catch (e) { return null; }
      }
    },
    // S2 — accessibility path: role+name chain. What a generic AX-snapshot agent has.
    'ax-path': {
      make: function (el) { return axPath(el); },
      resolve: function (ref) {
        var want = ref;
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          if (axPath(all[i]) === want) return all[i];
        }
        return null;
      }
    },
    // S3 — platform-native entity id + declared action. What an ADAPTER has.
    'entity-id': {
      make: function (el) {
        var row = el.closest ? el.closest('[data-entity-id]') : null;
        var action = el.getAttribute && el.getAttribute('data-action');
        if (!row || !action) return null;
        return row.getAttribute('data-entity-id') + '::' + action;
      },
      resolve: function (ref) {
        var parts = ref.split('::');
        try {
          return document.querySelector(
            '[data-entity-id="' + CSS.escape(parts[0]) + '"] [data-action="' + CSS.escape(parts[1]) + '"]'
          );
        } catch (e) { return null; }
      }
    },
    // S4 — role + exact accessible name. Human-legible, label-drift sensitive.
    'text-anchor': {
      make: function (el) { return roleOf(el) + '|' + accessibleName(el); },
      resolve: function (ref) {
        var sep = ref.indexOf('|');
        var role = ref.slice(0, sep);
        var name = ref.slice(sep + 1);
        var all = document.querySelectorAll('*');
        var hits = [];
        for (var i = 0; i < all.length; i++) {
          if (roleOf(all[i]) === role && accessibleName(all[i]) === name) hits.push(all[i]);
        }
        // strict: ambiguity is a resolution failure, not a coin flip
        return hits.length === 1 ? hits[0] : null;
      }
    }
  };

  // ------------------------------------------------------- digest recipes
  // A regionDigest answers "has this region changed in a way I must care about?"
  // FALSE VALIDATION = digest unchanged while the region did change (dangerous).
  // FALSE INVALIDATION = digest changed while nothing semantic changed (costly).

  function regionEl(sel) {
    return document.querySelector(sel) ||
      // restructure-dom drift renames the grid container
      document.querySelector('#campaigns-grid-v2') ||
      document.querySelector('[role="grid"]');
  }

  var RECIPES = {
    // R1 — normalized visible text hash.
    'R1-text': function (root) {
      return fnv1a(norm(root.innerText || root.textContent));
    },
    // R2 — structural skeleton: tag+role only, no text, no attributes.
    'R2-structure': function (root) {
      var out = [];
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      var n = root;
      do {
        out.push(n.tagName.toLowerCase() + '/' + (n.getAttribute('role') || ''));
      } while ((n = walker.nextNode()));
      return fnv1a(out.join(','));
    },
    // R3 — AX tuples: (role, accessible name, value) for every element.
    'R3-ax-tuples': function (root) {
      var out = [];
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      var n = root;
      do {
        var val = ('value' in n) ? String(n.value == null ? '' : n.value) : '';
        out.push(roleOf(n) + '|' + accessibleName(n) + '|' + val);
      } while ((n = walker.nextNode()));
      return fnv1a(out.join('\n'));
    },
    // R4 — adapter-declared field projection: only the fields an adapter says
    // are operationally meaningful, keyed by stable entity id.
    'R4-entity-fields': function (root) {
      var rows = root.querySelectorAll('[data-entity-id]');
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var q = function (sel) {
          var e = r.querySelector(sel);
          return e ? norm(e.textContent) : '';
        };
        out.push([
          r.getAttribute('data-entity-id'),
          q('.cell-status'),
          q('.cell-budget'),
          q('.cell-spend'),
          q('.cell-clicks')
        ].join('|'));
      }
      out.sort();
      return fnv1a(out.join('\n'));
    }
  };

  // ------------------------------------------------- compact AX projection
  // Used for token-cost comparison against Playwright's ariaSnapshot.

  function project(root, opts) {
    opts = opts || {};
    var viewportOnly = !!opts.viewportOnly;
    var maxDepth = opts.maxDepth || 25;
    var lines = [];
    function walk(el, depth) {
      if (depth > maxDepth) return;
      // NB: emission is gated on visibility, recursion is NOT. Zero-height
      // wrapper elements are ubiquitous (a virtualized grid's row container
      // collapses to 0px because its rows are absolutely positioned); gating
      // recursion on visibility silently drops the entire dataset.
      var emit = isVisible(el);
      if (emit && viewportOnly) {
        var r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) emit = false;
      }
      var role = roleOf(el);
      var name = accessibleName(el);
      var interactive = /^(button|link|checkbox|radio|textbox|option|listbox|combobox)$/.test(role);
      var ownText = '';
      for (var i = 0; i < el.childNodes.length; i++) {
        if (el.childNodes[i].nodeType === 3) ownText += el.childNodes[i].nodeValue;
      }
      ownText = norm(ownText);
      if (emit && (interactive || ownText || /^(heading|grid|row|gridcell|region|main|iframe)$/.test(role))) {
        lines.push(
          new Array(depth + 1).join('  ') + '- ' + role +
          (name ? ' "' + name + '"' : '') +
          (interactive ? ' [i]' : '')
        );
      }
      for (var c = 0; c < el.children.length; c++) walk(el.children[c], depth + 1);
    }
    walk(root, 0);
    return lines.join('\n');
  }

  // --------------------------------------------------------------- surface

  window.__probe = {
    strategies: Object.keys(STRATEGIES),
    recipes: Object.keys(RECIPES),

    /** Ground-truth target set: the budget control of every rendered row. */
    targets: function () {
      var els = document.querySelectorAll('[data-entity-id] [data-action="budget-edit"]');
      var out = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var row = el.closest('[data-entity-id]');
        var refs = {};
        for (var s in STRATEGIES) {
          refs[s] = STRATEGIES[s].make(el);
        }
        out.push({ entityId: row.getAttribute('data-entity-id'), refs: refs });
      }
      return out;
    },

    /** Resolve a ref and report which entity it actually landed on. */
    resolveRef: function (strategy, ref) {
      if (ref == null) return { status: 'no-ref' };
      var st = STRATEGIES[strategy];
      if (!st) return { status: 'unknown-strategy' };
      var el;
      try { el = st.resolve(ref); } catch (e) { return { status: 'error', error: String(e) }; }
      if (!el) return { status: 'unresolved' };
      var row = el.closest ? el.closest('[data-entity-id]') : null;
      return {
        status: 'resolved',
        entityId: row ? row.getAttribute('data-entity-id') : null,
        action: el.getAttribute ? el.getAttribute('data-action') : null,
        visible: isVisible(el)
      };
    },

    digest: function (sel, recipe) {
      var root = regionEl(sel);
      if (!root) return null;
      return RECIPES[recipe](root);
    },

    digestAll: function (sel) {
      var root = regionEl(sel);
      if (!root) return null;
      var out = {};
      for (var r in RECIPES) out[r] = RECIPES[r](root);
      return out;
    },

    project: function (sel, opts) {
      var root = sel ? regionEl(sel) : document.body;
      if (!root) return null;
      return project(root, opts);
    },

    /**
     * What an ADAPTER would hand the agent instead of a page snapshot:
     * normalised records keyed by platform-native id. This is the Data Plane
     * shape from PLAN v1.1 §4, and the thing being priced against a snapshot.
     */
    records: function () {
      var root = regionEl('#campaign-grid');
      if (!root) return [];
      var rows = root.querySelectorAll('[data-entity-id]');
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var pick = function (sel) {
          var e = r.querySelector(sel);
          return e ? norm(e.textContent) : null;
        };
        out.push({
          id: r.getAttribute('data-entity-id'),
          name: pick('.cell-name'),
          status: pick('.cell-status'),
          budget: pick('.cell-budget'),
          spend: pick('.cell-spend'),
          clicks: pick('.cell-clicks')
        });
      }
      return out;
    },

    /** Facts an adapter would need for reconciliation / coverage accounting. */
    coverage: function () {
      var root = regionEl('#campaign-grid');
      var rows = root ? root.querySelectorAll('[data-entity-id]') : [];
      var spendEl = document.getElementById('summary-total-spend');
      var budgetEl = document.getElementById('summary-total-budget');
      return {
        renderedRows: rows.length,
        summaryTotalSpend: spendEl ? norm(spendEl.textContent) : null,
        summaryTotalBudget: budgetEl ? norm(budgetEl.textContent) : null,
        gridContainerId: root ? root.id : null
      };
    },

    /** Hit-test agreement: does the DOM box centre actually hit the element? */
    hitTest: function (selector) {
      var els = document.querySelectorAll(selector);
      var agree = 0, total = 0, offscreen = 0;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > innerHeight) { offscreen++; continue; }
        total++;
        var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit === el || el.contains(hit) || (hit && hit.contains(el))) agree++;
      }
      return { total: total, agree: agree, offscreen: offscreen };
    },

    /** Structural facts the report needs about shadow DOM observability. */
    shadowFacts: function () {
      var open = document.querySelector('account-switcher');
      var closed = document.querySelector('budget-editor');
      return {
        openShadowPresent: !!(open && open.shadowRoot),
        openShadowText: open && open.shadowRoot ? norm(open.shadowRoot.textContent) : null,
        closedShadowExposed: !!(closed && closed.shadowRoot)
      };
    }
  };
})();
