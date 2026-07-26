(function () {
  'use strict';

  var ROW_HEIGHT = 40;
  var VISIBLE_COUNT = 15;
  var BUFFER = 5;
  var PAGE_SIZE = 100;
  var DRIFT_MODES = ['none', 'rename-labels', 'reorder-columns', 'restructure-dom', 'slow'];

  var state = {
    driftMode: 'none',
    renderCount: 0,
    renderKeyCounter: 0,
    totalRows: 500,
    editingId: null,
    editValue: '',
    editStatus: null,
    editError: '',
    lastStart: 0,
    lastEnd: 0,
  };

  var rowCache = new Array(500);
  var rowsById = new Map();
  var pagePromises = new Map();
  var validateTimer = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function L(text) {
    return state.driftMode === 'rename-labels' ? text + ' (v2)' : text;
  }

  function apiFetch(url, opts) {
    function doFetch() {
      return fetch(url, opts).then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () {
            return { error: 'request failed' };
          }).then(function (e) {
            return Promise.reject(e);
          });
        }
        return r.json();
      });
    }
    if (state.driftMode === 'slow') {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          doFetch().then(resolve, reject);
        }, 1500);
      });
    }
    return doFetch();
  }

  function validateBudgetClient(raw) {
    var trimmed = String(raw == null ? '' : raw).trim();
    if (trimmed === '') return { ok: false, error: 'Value is required' };
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: false, error: 'Must be a number' };
    var value = Number(trimmed);
    if (value <= 0) return { ok: false, error: 'Must be greater than 0' };
    if (value > 10000) return { ok: false, error: 'Must be at most 10000' };
    var rounded = Math.round(value * 100) / 100;
    if (Math.abs(rounded - value) > 1e-9) return { ok: false, error: 'Max 2 decimal places' };
    return { ok: true, value: rounded };
  }

  function pageIndexFor(i) {
    return Math.floor(i / PAGE_SIZE);
  }

  function loadPage(p) {
    if (pagePromises.has(p)) return pagePromises.get(p);
    var offset = p * PAGE_SIZE;
    var promise = apiFetch('/api/campaigns?offset=' + offset + '&limit=' + PAGE_SIZE).then(function (data) {
      data.rows.forEach(function (row, idx) {
        rowCache[offset + idx] = row;
        rowsById.set(row.id, row);
      });
      state.totalRows = data.total;
    }).catch(function () {
      pagePromises.delete(p);
    });
    pagePromises.set(p, promise);
    return promise;
  }

  function ensureLoaded(startIdx, endIdx) {
    var firstPage = pageIndexFor(startIdx);
    var lastPage = pageIndexFor(Math.max(startIdx, endIdx - 1));
    var promises = [];
    for (var p = firstPage; p <= lastPage; p++) promises.push(loadPage(p));
    return Promise.all(promises);
  }

  // ---- DOM refs (grabbed before any restructuring) ----
  var gridRoot = document.getElementById('campaign-grid');
  var gridHeader = document.getElementById('grid-header');
  var gridViewport = document.getElementById('grid-viewport');
  var gridSpacer = document.getElementById('grid-spacer');
  var gridRows = document.getElementById('grid-rows');
  var liveMetricsEl = document.getElementById('live-metrics');
  var summaryEl = document.getElementById('summary-widget');

  function getColumns() {
    var base = [
      { key: 'checkbox', label: '', render: renderCheckboxCell },
      { key: 'name', label: L('Name'), render: renderNameCell },
      { key: 'status', label: L('Status'), render: renderStatusCell },
      { key: 'budget', label: L('Daily budget'), render: renderBudgetCell },
      { key: 'spend', label: L('Spend'), render: renderSpendCell },
      { key: 'clicks', label: L('Clicks'), render: renderClicksCell },
    ];
    if (state.driftMode === 'reorder-columns') {
      var si = base.findIndex(function (c) { return c.key === 'spend'; });
      var ci = base.findIndex(function (c) { return c.key === 'clicks'; });
      var tmp = base[si];
      base[si] = base[ci];
      base[ci] = tmp;
    }
    return base;
  }

  function renderCheckboxCell(row) {
    return '<div class="cell cell-checkbox" role="gridcell"><input type="checkbox" data-action="select" data-row="' + row.id + '" aria-label="' + escapeHtml(L('Select ' + row.name)) + '"></div>';
  }
  function renderNameCell(row) {
    return '<div class="cell cell-name" role="gridcell"><a href="#" class="row-link" data-row="' + row.id + '">' + escapeHtml(row.name) + '</a></div>';
  }
  function renderStatusCell(row) {
    return '<div class="cell cell-status" role="gridcell"><span class="status-badge status-' + row.status.toLowerCase() + '">' + row.status + '</span></div>';
  }
  function renderSpendCell(row) {
    return '<div class="cell cell-spend" role="gridcell">$' + row.spend.toFixed(2) + '</div>';
  }
  function renderClicksCell(row) {
    return '<div class="cell cell-clicks" role="gridcell">' + row.clicks + '</div>';
  }
  function renderBudgetMessage(rowId) {
    var text = '';
    var cls = 'budget-msg';
    if (state.editStatus === 'validating') { text = L('Checking...'); cls += ' is-checking'; }
    else if (state.editStatus === 'valid') { text = L('Looks good'); cls += ' is-valid'; }
    else if (state.editStatus === 'error') { text = state.editError; cls += ' is-error'; }
    else if (state.editStatus === 'pending') { text = L('Saving...'); cls += ' is-pending'; }
    else if (state.editStatus === 'success') { text = L('Saved'); cls += ' is-success'; }
    return '<span class="' + cls + '" data-role="budget-msg" data-row="' + rowId + '">' + escapeHtml(text) + '</span>';
  }
  function renderBudgetCell(row) {
    if (state.editingId === row.id) {
      var disabled = (state.editStatus === 'pending' || state.editStatus === 'success') ? 'disabled' : '';
      var saveLabel = state.driftMode === 'rename-labels' ? 'Apply' : 'Save';
      return '<div class="cell cell-budget" role="gridcell">' +
        '<div class="budget-editor-inline">' +
        '<label class="sr-only" for="budget-input-' + row.id + '">' + escapeHtml(L('Daily budget for ' + row.name)) + '</label>' +
        '<input id="budget-input-' + row.id + '" type="text" inputmode="decimal" value="' + escapeHtml(state.editValue) + '" data-action="budget-input" data-row="' + row.id + '" aria-label="' + escapeHtml(L('Daily budget for ' + row.name)) + '" ' + disabled + '>' +
        '<button type="button" data-action="budget-save" data-row="' + row.id + '" aria-label="' + escapeHtml(L('Save budget for ' + row.name)) + '" ' + disabled + '>' + escapeHtml(saveLabel) + '</button>' +
        '<button type="button" data-action="budget-cancel" data-row="' + row.id + '" aria-label="' + escapeHtml(L('Cancel editing budget for ' + row.name)) + '" ' + disabled + '>Cancel</button>' +
        renderBudgetMessage(row.id) +
        '</div></div>';
    }
    return '<div class="cell cell-budget" role="gridcell">' +
      '<button type="button" class="budget-value" data-action="budget-edit" data-row="' + row.id + '" aria-label="' + escapeHtml(L('Edit budget for ' + row.name + ', currently $' + row.dailyBudget.toFixed(2))) + '">$' + row.dailyBudget.toFixed(2) + '</button>' +
      '</div>';
  }

  function renderHeader() {
    var cols = getColumns();
    gridHeader.setAttribute('role', 'row');
    gridHeader.innerHTML = cols.map(function (c) {
      return '<div class="cell cell-header" role="gridcell">' + escapeHtml(c.label) + '</div>';
    }).join('');
  }

  function renderRow(row, idx) {
    var key = ++state.renderKeyCounter;
    var cols = getColumns();
    var cells = cols.map(function (c) { return c.render(row); }).join('');
    return '<div class="grid-row" role="row" data-entity-id="' + row.id + '" data-render-key="' + key + '" style="top:' + (idx * ROW_HEIGHT) + 'px;height:' + ROW_HEIGHT + 'px;">' + cells + '</div>';
  }

  function paintRows(startIndex, endIndex) {
    state.lastStart = startIndex;
    state.lastEnd = endIndex;
    state.renderCount++;
    var parts = [];
    for (var i = startIndex; i < endIndex; i++) {
      var row = rowCache[i];
      if (!row) continue;
      parts.push(renderRow(row, i));
    }
    gridRows.innerHTML = parts.join('');
  }

  function scheduleRenderGrid() {
    var scrollTop = gridViewport.scrollTop;
    var rawStart = Math.floor(scrollTop / ROW_HEIGHT) - BUFFER;
    var startIndex = Math.max(0, rawStart);
    var endIndex = Math.min(state.totalRows, startIndex + VISIBLE_COUNT + BUFFER * 2);
    if (endIndex <= startIndex) endIndex = startIndex + 1;
    ensureLoaded(startIndex, endIndex).then(function () {
      paintRows(startIndex, endIndex);
    });
  }

  function startEdit(id) {
    var row = rowsById.get(id);
    if (!row) return;
    state.editingId = id;
    state.editValue = row.dailyBudget.toFixed(2);
    state.editStatus = null;
    state.editError = '';
    paintRows(state.lastStart, state.lastEnd);
  }

  function cancelEdit() {
    state.editingId = null;
    state.editStatus = null;
    state.editError = '';
    paintRows(state.lastStart, state.lastEnd);
  }

  function scheduleValidate() {
    clearTimeout(validateTimer);
    state.editStatus = 'validating';
    var id = state.editingId;
    updateBudgetMessageDom(id);
    validateTimer = setTimeout(function () {
      var result = validateBudgetClient(state.editValue);
      state.editStatus = result.ok ? 'valid' : 'error';
      state.editError = result.ok ? '' : result.error;
      updateBudgetMessageDom(id);
    }, 400);
  }

  function updateBudgetMessageDom(id) {
    var msgEl = gridRows.querySelector('[data-role="budget-msg"][data-row="' + id + '"]');
    if (msgEl) {
      var tmp = document.createElement('div');
      tmp.innerHTML = renderBudgetMessage(id);
      var newMsg = tmp.firstElementChild;
      msgEl.className = newMsg.className;
      msgEl.textContent = newMsg.textContent;
    }
    var rowEl = gridRows.querySelector('.grid-row[data-entity-id="' + id + '"]');
    if (rowEl) {
      var disable = state.editStatus === 'pending' || state.editStatus === 'success';
      var els = rowEl.querySelectorAll('[data-action="budget-input"],[data-action="budget-save"],[data-action="budget-cancel"]');
      for (var i = 0; i < els.length; i++) els[i].disabled = disable;
    }
  }

  function saveEdit() {
    var id = state.editingId;
    var row = rowsById.get(id);
    if (!row) return;
    var result = validateBudgetClient(state.editValue);
    if (!result.ok) {
      state.editStatus = 'error';
      state.editError = result.error;
      updateBudgetMessageDom(id);
      return;
    }
    state.editStatus = 'pending';
    updateBudgetMessageDom(id);
    apiFetch('/api/campaigns/' + id + '/budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: result.value }),
    }).then(function (resp) {
      row.dailyBudget = resp.row.dailyBudget;
      row.updatedAt = resp.row.updatedAt;
      state.editStatus = 'success';
      updateBudgetMessageDom(id);
      setTimeout(function () {
        if (state.editingId === id) {
          state.editingId = null;
          paintRows(state.lastStart, state.lastEnd);
        }
      }, 500);
    }).catch(function (err) {
      state.editStatus = 'error';
      state.editError = (err && err.error) || 'Save failed';
      updateBudgetMessageDom(id);
    });
  }

  function setupGrid() {
    renderHeader();
    gridSpacer.style.height = (state.totalRows * ROW_HEIGHT) + 'px';
    scheduleRenderGrid();
    gridViewport.addEventListener('scroll', scheduleRenderGrid);
    setInterval(scheduleRenderGrid, 5000);
    gridRows.addEventListener('input', function (e) {
      var input = e.target.closest('[data-action="budget-input"]');
      if (input) {
        state.editValue = input.value;
        scheduleValidate();
      }
    });
    gridRows.addEventListener('click', function (e) {
      var editBtn = e.target.closest('[data-action="budget-edit"]');
      if (editBtn) { startEdit(editBtn.getAttribute('data-row')); return; }
      var saveBtn = e.target.closest('[data-action="budget-save"]');
      if (saveBtn) { saveEdit(); return; }
      var cancelBtn = e.target.closest('[data-action="budget-cancel"]');
      if (cancelBtn) { cancelEdit(); return; }
      var link = e.target.closest('.row-link');
      if (link) { e.preventDefault(); }
    });
  }

  function renderLiveMetrics() {
    state.renderCount++;
    var activeCount = Math.floor(200 + Math.random() * 50);
    var rps = (50 + Math.random() * 20).toFixed(1);
    var latency = Math.floor(30 + Math.random() * 120);
    liveMetricsEl.innerHTML =
      '<div class="metric-group" role="group" aria-label="' + escapeHtml(L('Live metrics')) + '">' +
      '<div class="metric-item"><span class="metric-label">' + escapeHtml(L('Active now')) + '</span><span class="metric-value">' + activeCount + '</span></div>' +
      '<div class="metric-item"><span class="metric-label">' + escapeHtml(L('Requests/sec')) + '</span><span class="metric-value">' + rps + '</span></div>' +
      '<div class="metric-item"><span class="metric-label">' + escapeHtml(L('Avg latency (ms)')) + '</span><span class="metric-value">' + latency + '</span></div>' +
      '<div class="metric-item"><span class="metric-label">' + escapeHtml(L('Render tick')) + '</span><span class="metric-value">' + state.renderCount + '</span></div>' +
      '</div>';
  }

  function loadSummary() {
    apiFetch('/api/campaigns/summary').then(function (data) {
      summaryEl.innerHTML =
        '<h2>' + escapeHtml(L('Summary')) + '</h2>' +
        '<dl class="summary-list">' +
        '<div class="summary-row"><dt>' + escapeHtml(L('Total campaigns')) + '</dt><dd>' + data.totalRows + '</dd></div>' +
        '<div class="summary-row"><dt>' + escapeHtml(L('Total spend')) + '</dt><dd id="summary-total-spend">$' + data.totalSpend.toFixed(2) + '</dd></div>' +
        '<div class="summary-row"><dt>' + escapeHtml(L('Total daily budget')) + '</dt><dd id="summary-total-budget">$' + data.totalBudget.toFixed(2) + '</dd></div>' +
        '</dl>';
    }).catch(function () {});
  }

  function applyDomRestructure() {
    if (state.driftMode !== 'restructure-dom') return;
    gridRoot.id = 'campaigns-grid-v2';
    var wrap1 = document.createElement('div');
    wrap1.className = 'drift-wrap drift-wrap-outer';
    var wrap2 = document.createElement('div');
    wrap2.className = 'drift-wrap drift-wrap-inner';
    var parent = gridRoot.parentNode;
    parent.insertBefore(wrap1, gridRoot);
    wrap1.appendChild(wrap2);
    wrap2.appendChild(gridRoot);
  }

  function applyStaticLabelDrift() {
    if (state.driftMode !== 'rename-labels') return;
    var labeled = document.querySelectorAll('[aria-label]');
    labeled.forEach(function (el) {
      if (el.hasAttribute('data-keep-label')) return;
      el.setAttribute('aria-label', el.getAttribute('aria-label') + ' (v2)');
    });
    var buttons = document.querySelectorAll('button:not([data-keep-label])');
    buttons.forEach(function (btn) {
      if (btn.textContent && btn.textContent.trim()) {
        btn.textContent = btn.textContent + ' (v2)';
      }
    });
  }

  function defineCustomElements() {
    if (!customElements.get('account-switcher')) {
      customElements.define('account-switcher', class extends HTMLElement {
        connectedCallback() {
          var shadow = this.attachShadow({ mode: 'open' });
          var accounts = ['Acme Inc', 'Globex Corp', 'Initech'];
          shadow.innerHTML =
            '<style>.switcher{font:inherit;}button{padding:4px 8px;}ul{list-style:none;margin:4px 0 0;padding:0;border:1px solid #999;}li{padding:4px 8px;cursor:pointer;}li[aria-selected="true"]{background:#dbe9ff;}</style>' +
            '<div class="switcher">' +
            '<button aria-label="' + escapeHtml(L('Switch account')) + '">' + escapeHtml(L('Account: ' + accounts[0])) + '</button>' +
            '<ul role="listbox" aria-label="' + escapeHtml(L('Accounts')) + '">' +
            accounts.map(function (a, i) {
              return '<li role="option" tabindex="0" aria-selected="' + (i === 0) + '">' + escapeHtml(a) + '</li>';
            }).join('') +
            '</ul></div>';
        }
      });
    }
    if (!customElements.get('budget-editor')) {
      customElements.define('budget-editor', class extends HTMLElement {
        connectedCallback() {
          var shadow = this.attachShadow({ mode: 'closed' });
          shadow.innerHTML =
            '<label>' + escapeHtml(L('Quick budget')) +
            ' <input type="number" step="0.01" aria-label="' + escapeHtml(L('Quick budget amount')) + '"></label>';
          this._closedShadow = shadow;
        }
      });
    }
  }

  function init(mode) {
    state.driftMode = mode;
    applyDomRestructure();
    applyStaticLabelDrift();
    defineCustomElements();
    renderLiveMetrics();
    setInterval(renderLiveMetrics, 800);
    setupGrid();
    loadSummary();
    setInterval(loadSummary, 10000);

    window.__fixture = {
      get driftMode() { return state.driftMode; },
      get renderCount() { return state.renderCount; },
      forceRerender: function () {
        paintRows(state.lastStart, state.lastEnd);
        renderLiveMetrics();
        return true;
      },
      seedRow: function (id, patch) {
        var row = rowsById.get(id);
        if (!row) return false;
        Object.assign(row, patch);
        paintRows(state.lastStart, state.lastEnd);
        return true;
      },
      getVisibleEntityIds: function () {
        return Array.prototype.map.call(gridRows.querySelectorAll('[data-entity-id]'), function (el) {
          return el.getAttribute('data-entity-id');
        });
      },
    };
  }

  var params = new URLSearchParams(window.location.search);
  var urlDrift = params.get('drift');
  if (urlDrift && DRIFT_MODES.indexOf(urlDrift) !== -1) {
    fetch('/api/drift?mode=' + encodeURIComponent(urlDrift)).catch(function () {});
    init(urlDrift);
  } else {
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      init(DRIFT_MODES.indexOf(cfg.driftMode) !== -1 ? cfg.driftMode : 'none');
    }).catch(function () { init('none'); });
  }
})();
