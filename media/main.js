(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const persistedState = vscode.getState() || {};
  const packageColumn = { key: 'package', label: 'Package', minWidth: 116, defaultWidth: 180, maxWidth: 520 };
  const tableColumns = [
    { key: 'type', label: 'Type', minWidth: 42, defaultWidth: 52, maxWidth: 180 },
    { key: 'license', label: 'License', minWidth: 86, defaultWidth: 110, maxWidth: 360 },
    { key: 'current', label: 'Declared', minWidth: 68, defaultWidth: 92, maxWidth: 260 },
    { key: 'lock', label: 'Lock', minWidth: 70, defaultWidth: 86, maxWidth: 240 },
    { key: 'currentPublished', label: 'Current published', minWidth: 104, defaultWidth: 128, maxWidth: 300 },
    { key: 'latest', label: 'Latest', minWidth: 68, defaultWidth: 96, maxWidth: 260 },
    { key: 'latestPublished', label: 'Latest published', minWidth: 104, defaultWidth: 128, maxWidth: 300 },
    { key: 'update', label: 'Update', minWidth: 68, defaultWidth: 88, maxWidth: 220 },
    { key: 'risk', label: 'Risk', minWidth: 86, defaultWidth: 120, maxWidth: 420 },
    { key: 'action', label: 'Action', minWidth: 72, defaultWidth: 88, maxWidth: 220 }
  ];
  const allTableColumns = [packageColumn, ...tableColumns];
  const defaultVisibleColumns = ['current', 'latest', 'update', 'risk', 'action'];
  let searchTimer;
  let listScrollTop = 0;
  let showingDetail = false;
  const filterDefaults = { filter: 'all', riskFilter: 'all', updateFilter: 'all', licenseFilter: 'all', searchQuery: '' };
  const filterChoices = {
    filter: [['all', 'All types'], ['dependencies', 'Production'], ['devDependencies', 'Development']],
    riskFilter: [['all', 'Any risk'], ['vulnerable', 'Vulnerable'], ['deprecated', 'Deprecated'], ['notChecked', 'Not checked'], ['ok', 'No known issues']],
    updateFilter: [['all', 'Any update'], ['update', 'Updates available'], ['major', 'Major'], ['minor', 'Minor'], ['patch', 'Patch'], ['current', 'Up to date']]
  };
  let state = {
    packageFiles: [],
    selectedPackageJson: '',
    filter: persistedState.filter || 'all',
    riskFilter: persistedState.riskFilter || 'all',
    updateFilter: persistedState.updateFilter || 'all',
    licenseFilter: persistedState.licenseFilter || 'all',
    licenseOptions: [],
    searchQuery: persistedState.searchQuery || '',
    dependencyCounts: {
      dependencies: 0,
      devDependencies: 0
    },
    lockInfo: {
      exists: false,
      label: '',
      lockfileVersion: '',
      packageCount: 0,
      error: ''
    },
    cacheStats: {
      registry: 0,
      dependencies: 0,
      audit: 0,
      readme: 0,
      downloads: 0
    },
    dependencies: [],
    sortBy: persistedState.sortBy || 'name',
    filtersOpen: Boolean(persistedState.filtersOpen),
    visibleColumns: normalizeVisibleColumns(persistedState.visibleColumns),
    columnWidths: normalizeColumnWidths(persistedState.columnWidths)
  };

  const trustedMessageOrigin = window.location.origin;

  window.addEventListener('message', (event) => {
    if (event.origin !== trustedMessageOrigin || !event.data || typeof event.data !== 'object') {
      return;
    }

    const message = event.data;

    if (message.type === 'loading') {
      renderLoading(message.message);
    }

    if (message.type === 'error') {
      renderError(message.message);
    }

    if (message.type === 'state') {
      state = {
        ...state,
        ...message,
        visibleColumns: normalizeVisibleColumns(message.visibleColumns || state.visibleColumns),
        columnWidths: normalizeColumnWidths(message.columnWidths || state.columnWidths)
      };
      renderList();
    }

    if (message.type === 'detail') {
      renderDetail(message.detail);
    }

    if (message.type === 'updateState') {
      state.updateBusy = message.updateBusy;
      state.updateResult = message.updateResult;
      const status = document.getElementById('updateStatus');
      if (status) status.innerHTML = DOMPurify.sanitize(renderUpdateStatus());
      document.querySelectorAll('[data-update-package]').forEach((button) => {
        button.disabled = Boolean(state.updateBusy);
      });
    }
  });

  bindExternalLinks();

  function renderList() {
    const focusedId = document.activeElement?.id;
    const visibleDependencies = getVisibleDependencies();
    app.innerHTML = DOMPurify.sanitize(`
      <section class="dashboardHeader">
        <div class="headerTitle">
          <h1>npm Packages</h1>
          <p>Review dependencies. Choose what to update.</p>
        </div>
        <div class="headerActions">
          <details class="exportPicker">
            <summary>Export</summary>
            <div class="exportMenu">
              <button id="exportCsvButton" class="secondaryButton">Dependency report (CSV)</button>
              <button id="exportSbomButton" class="secondaryButton">Software bill of materials (SBOM)</button>
            </div>
          </details>
          <button id="refreshAllButton" class="secondaryButton" ${state.isLoading ? 'disabled' : ''} title="Reload dependency and security information">${state.isLoading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </section>
      <div class="projectBar">
        <label class="field packageField"><span>Project</span>
          <select id="packageSelect" ${!state.packageFiles.length ? 'disabled' : ''}>
            ${state.packageFiles.length ? state.packageFiles.map((file) => `<option value="${escapeAttr(file.path)}" ${file.path === state.selectedPackageJson ? 'selected' : ''}>${escapeHtml(file.label)}</option>`).join('') : '<option>No package.json found</option>'}
          </select>
        </label>
        <span class="projectMeta">${renderCompactStatus(state.packageManager, state.lockInfo, state.cacheStats)}</span>
      </div>
      <div id="updateStatus">${renderUpdateStatus()}</div>
      <nav class="overview" aria-label="Quick views">${renderOverview()}</nav>
      <section class="controlPanel" aria-label="Search and filters">
        <div class="searchToolbar">
          <label class="field searchField"><span class="srOnly">Search packages</span>
            <input id="searchInput" type="search" value="${escapeAttr(state.searchQuery)}" placeholder="Search by name or description…" aria-keyshortcuts="/">
          </label>
          <label class="field sortField"><span class="srOnly">Sort packages</span>
            <select id="sortSelect" aria-label="Sort packages">
              ${[['name', 'Name A–Z'], ['updates', 'Major updates first'], ['risk', 'Risk first']].map(([value, label]) => `<option value="${value}" ${state.sortBy === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
        </div>
        <details id="filtersPanel" class="filtersPanel" ${state.filtersOpen ? 'open' : ''}>
          <summary>Filters <span id="filterCount">${getActiveFilters().length || ''}</span></summary>
          <div class="filterGrid">
            ${Object.entries(filterChoices).map(([key, choices]) => `<label class="field"><span>${{filter:'Dependency type',riskFilter:'Risk',updateFilter:'Update'}[key]}</span><select data-view-filter="${key}">${choices.map(([value, label]) => `<option value="${value}" ${state[key] === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`).join('')}
            <label class="field"><span>License</span><select id="licenseSelect" data-view-filter="licenseFilter">${renderLicenseOptions()}</select></label>
          </div>
        </details>
        <div id="activeFilters" class="activeFilters" aria-label="Active filters">${renderActiveFilters()}</div>
      </section>
      <section class="dependencySection">
        <div class="sectionHeader">
          <div><h2>Dependencies</h2><p id="resultCount" role="status" aria-live="polite">${formatNumber(visibleDependencies.length)} of ${formatNumber(state.dependencies.length)} packages</p></div>
          ${renderColumnPicker()}
        </div>
        <div id="dependencyTable">${renderDependencyContent(visibleDependencies)}</div>
      </section>
    `);
    document.getElementById('packageSelect').addEventListener('change', (event) => {
      clearTimeout(searchTimer);
      sendFilters();
      vscode.postMessage({ type: 'selectPackageJson', path: event.target.value });
    });
    document.getElementById('refreshAllButton').addEventListener('click', () => {
      clearTimeout(searchTimer);
      sendFilters();
      vscode.postMessage({ type: 'refreshAll' });
    });
    for (const [id, type] of [['exportCsvButton', 'exportCsv'], ['exportSbomButton', 'exportSbom']]) {
      document.getElementById(id).addEventListener('click', () => {
        clearTimeout(searchTimer);
        sendFilters();
        document.querySelector('.exportPicker').open = false;
        vscode.postMessage({ type });
      });
    }
    document.querySelectorAll('[data-quick-view]').forEach((button) => button.addEventListener('click', () => {
      const view = button.dataset.quickView;
      setViewFilters({ ...filterDefaults, updateFilter: view === 'updates' ? 'update' : 'all', riskFilter: view === 'risk' ? 'vulnerable' : 'all' });
    }));
    document.querySelectorAll('[data-view-filter]').forEach((select) => select.addEventListener('change', () => setViewFilters({ [select.dataset.viewFilter]: select.value })));
    document.getElementById('filtersPanel').addEventListener('toggle', (event) => {
      state.filtersOpen = event.currentTarget.open;
      persistViewState();
    });
    document.getElementById('activeFilters').addEventListener('click', handleFilterClear);
    document.getElementById('dependencyTable').addEventListener('click', handleFilterClear);
    document.getElementById('sortSelect').addEventListener('change', (event) => {
      state.sortBy = event.target.value;
      persistViewState();
      updateDependencyTable();
    });
    document.getElementById('searchInput').addEventListener('input', (event) => setViewFilters({ searchQuery: event.target.value }, true));
    document.getElementById('searchInput').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setViewFilters({ searchQuery: '' });
    });
    bindPackageButtons();
    bindColumnPicker();
    bindColumnResizers();
    updateFilterControls();
    if (focusedId) document.getElementById(focusedId)?.focus();
    if (showingDetail) window.scrollTo(0, listScrollTop);
    showingDetail = false;
  }

  function renderOverview() {
    const cards = [
      ['all', 'All packages', state.dependencies.length, 'Browse this project'],
      ['updates', 'Updates available', filterByUpdate(state.dependencies, 'update').length, 'Choose a target version'],
      ['risk', 'Vulnerable', filterByRisk(state.dependencies, 'vulnerable').length, 'Review security findings']
    ];
    return cards.map(([key, label, count, hint]) => `<button class="overviewCard ${key}" data-quick-view="${key}" aria-pressed="false" ${state.isLoading ? 'disabled' : ''}><span>${label}</span><strong>${state.isLoading ? '—' : formatNumber(count)}</strong><small>${hint}</small></button>`).join('');
  }

  function getActiveFilters() {
    return Object.keys(filterDefaults).filter((key) => state[key] !== filterDefaults[key] && state[key]);
  }

  function renderActiveFilters() {
    const keys = getActiveFilters();
    if (!keys.length) return '';
    const chips = keys.map((key) => {
      const label = key === 'searchQuery' ? `Search: ${state[key]}` : key === 'licenseFilter' ? `License: ${state[key] === '__unknown__' ? 'Unknown' : getLicenseDisplayValue(state[key])}` : filterChoices[key].find(([value]) => value === state[key])?.[1] || state[key];
      return `<button class="filterChip" data-clear-filter="${key}" title="Remove ${escapeAttr(label)}" aria-label="Remove ${escapeAttr(label)}">${escapeHtml(label)} <span aria-hidden="true">×</span></button>`;
    });
    return `${chips.join('')}<button class="textButton" data-clear-all>Clear all</button>`;
  }

  function handleFilterClear(event) {
    const button = event.target.closest('button');
    if (button?.hasAttribute('data-clear-all')) {
      setViewFilters({ ...filterDefaults });
      document.getElementById('searchInput')?.focus();
    } else if (button?.dataset.clearFilter) {
      setViewFilters({ [button.dataset.clearFilter]: filterDefaults[button.dataset.clearFilter] });
      document.getElementById('searchInput')?.focus();
    }
  }

  function setViewFilters(patch, debounce = false) {
    clearTimeout(searchTimer);
    Object.assign(state, patch);
    persistViewState();
    updateFilterControls();
    updateDependencyTable();
    if (debounce) searchTimer = setTimeout(sendFilters, 200);
    else sendFilters();
  }

  function sendFilters() {
    vscode.postMessage({ type: 'setFilters', filters: Object.fromEntries(Object.keys(filterDefaults).map((key) => [key, state[key]])) });
  }

  function updateFilterControls() {
    const search = document.getElementById('searchInput');
    if (search && search.value !== state.searchQuery) search.value = state.searchQuery;
    document.querySelectorAll('[data-view-filter]').forEach((select) => { select.value = state[select.dataset.viewFilter]; });
    const chips = document.getElementById('activeFilters');
    if (chips) chips.innerHTML = DOMPurify.sanitize(renderActiveFilters());
    const count = document.getElementById('filterCount');
    if (count) count.textContent = getActiveFilters().length || '';
    document.querySelectorAll('[data-quick-view]').forEach((button) => {
      const expected = { ...filterDefaults, updateFilter: button.dataset.quickView === 'updates' ? 'update' : 'all', riskFilter: button.dataset.quickView === 'risk' ? 'vulnerable' : 'all' };
      button.setAttribute('aria-pressed', String(Object.keys(expected).every((key) => state[key] === expected[key])));
    });
  }

  document.addEventListener('click', (event) => {
    for (const selector of ['.exportPicker', '.columnPicker']) {
      if (!event.target.closest(selector)) { const menu = document.querySelector(selector); if (menu) menu.open = false; }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const menu = event.target.closest('.exportPicker, .columnPicker');
      if (menu) { menu.open = false; menu.querySelector('summary').focus(); }
    }
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest('input, select, textarea, [contenteditable]')) {
      const search = document.getElementById('searchInput');
      if (search) { event.preventDefault(); search.focus(); }
    }
  });

  function renderDependencyContent(visibleDependencies) {
    if (state.isLoading) {
      return renderInlineLoading(state.message);
    }
    if (state.message) {
      return `<p class="empty">${escapeHtml(state.message)}</p>`;
    }
    return renderDependencyTable(visibleDependencies);
  }

  function updateDependencyTable() {
    const dependencyTable = document.getElementById('dependencyTable');
    if (!dependencyTable) {
      return;
    }

    const visible = getVisibleDependencies();
    dependencyTable.innerHTML = DOMPurify.sanitize(renderDependencyContent(visible));
    const count = document.getElementById('resultCount');
    if (count) count.textContent = `${formatNumber(visible.length)} of ${formatNumber(state.dependencies.length)} packages`;
    bindPackageButtons(dependencyTable);
    bindColumnResizers();
  }

  function bindColumnPicker() {
    document.querySelectorAll('[data-column-toggle]').forEach(bindColumnToggle);
    document.querySelectorAll('[data-column-preset]').forEach((button) => button.addEventListener('click', () => {
      state.visibleColumns = button.dataset.columnPreset === 'all' ? tableColumns.map((column) => column.key) : [...defaultVisibleColumns];
      document.querySelectorAll('[data-column-toggle]').forEach((checkbox) => { checkbox.checked = state.visibleColumns.includes(checkbox.dataset.columnToggle); });
      handleColumnToggleChange();
    }));
  }

  function bindColumnToggle(checkbox) {
    checkbox.addEventListener('change', handleColumnToggleChange);
  }

  function handleColumnToggleChange() {
    const selected = [...document.querySelectorAll('[data-column-toggle]:checked')].map(getColumnToggleKey);
    state.visibleColumns = normalizeVisibleColumns(selected);
    persistViewState();
    vscode.postMessage({ type: 'setVisibleColumns', columns: state.visibleColumns });
    updateDependencyTable();
    updateColumnSummary();
  }

  function getColumnToggleKey(input) {
    return input.dataset.columnToggle;
  }

  function bindPackageButtons(root = document) {
    root.querySelectorAll('.name[data-package]').forEach((button) => {
      button.addEventListener('click', () => {
        if (document.getElementById('dependencyTable')) listScrollTop = window.scrollY;
        vscode.postMessage({ type: 'openPackage', name: button.dataset.package });
      });
    });

    root.querySelectorAll('[data-update-package]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({
          type: 'runUpdate',
          name: button.dataset.updatePackage,
          packageJsonPath: state.selectedPackageJson
        });
      });
    });
  }

  function getVisibleDependencies() {
    const query = String(state.searchQuery || '').trim().toLowerCase();
    const typed = state.dependencies.filter((dependency) => state.filter === 'all' || dependency.type === state.filter);
    const filtered = filterByLicense(filterByUpdate(filterByRisk(typed, state.riskFilter), state.updateFilter), state.licenseFilter);
    const matching = filtered.filter((dependency) => {
      return dependency.name.toLowerCase().includes(query) || String(dependency.description || '').toLowerCase().includes(query);
    });
    const priority = (dependency) => state.sortBy === 'updates' ? ({major:3,minor:2,patch:1}[dependency.updateType] || 0) : state.sortBy === 'risk' ? riskPriority(dependency) : 0;
    return matching.sort((a, b) => priority(b) - priority(a) || a.name.localeCompare(b.name));
  }

  function riskPriority(dependency) {
    if (hasKev(dependency)) return 7;
    if (filterByRisk([dependency], 'vulnerable').length) return 6;
    if (dependency.deprecated) return 2;
    if (dependency.auditStatus === 'unknown') return 1;
    return 0;
  }

  function filterByRisk(dependencies, riskFilter) {
    if (!riskFilter || riskFilter === 'all') {
      return dependencies;
    }

    return dependencies.filter((dependency) => {
      if (riskFilter === 'vulnerable') {
        return dependency.auditStatus === 'vulnerable' || dependency.transitiveVulnerabilityCount > 0 || hasOsv(dependency) || hasKev(dependency);
      }
      if (riskFilter === 'deprecated') {
        return dependency.deprecated;
      }
      if (riskFilter === 'notChecked') {
        return dependency.auditStatus === 'unknown';
      }
      if (riskFilter === 'ok') {
        return !dependency.deprecated && dependency.auditStatus !== 'vulnerable' && dependency.auditStatus !== 'unknown' && !dependency.transitiveVulnerabilityCount && !hasOsv(dependency) && !hasKev(dependency);
      }
      return true;
    });
  }

  function filterByUpdate(dependencies, updateFilter) {
    if (!updateFilter || updateFilter === 'all') {
      return dependencies;
    }

    return dependencies.filter((dependency) => {
      if (updateFilter === 'update') {
        return ['major', 'minor', 'patch'].includes(dependency.updateType);
      }
      return dependency.updateType === updateFilter;
    });
  }

  function filterByLicense(dependencies, licenseFilter) {
    if (!licenseFilter || licenseFilter === 'all') {
      return dependencies;
    }

    return dependencies.filter((dependency) => getLicenseFilterValue(dependency.license) === licenseFilter);
  }

  function renderDependencyTable(dependencies) {
    if (!dependencies.length) {
      return `<div class="emptyState"><strong>${state.dependencies.length ? 'No matching packages' : 'No dependencies yet'}</strong><p>${state.dependencies.length ? 'Try another search or remove a filter.' : 'Select a project with dependencies in package.json.'}</p>${getActiveFilters().length ? '<button class="secondaryButton" data-clear-all>Clear search and filters</button>' : ''}</div>`;
    }

    const visibleColumns = normalizeVisibleColumns(state.visibleColumns);
    const visibleColumnDefs = tableColumns.filter((column) => visibleColumns.includes(column.key));

    return `
      <div class="packageCards">${dependencies.map(renderPackageCard).join('')}</div>
      <div class="tableScroller">
        <div class="list">
        <div class="row head">
          ${renderHeaderCell(packageColumn)}
          ${visibleColumnDefs.map(renderHeaderCell).join('')}
        </div>
        ${dependencies.map((dependency) => `
          <div class="row ${getUpdateRowClass(dependency)}">
            <button class="name ${dependency.status}" data-package="${escapeAttr(dependency.name)}" title="${escapeAttr(dependency.description || dependency.name)}">
              ${escapeHtml(dependency.name)}
            </button>
            ${visibleColumnDefs.map((column) => renderDependencyCell(column.key, dependency)).join('')}
          </div>
        `).join('')}
        </div>
      </div>
    `;
  }

  function renderPackageCard(dependency) {
    return `<article class="packageCard ${getUpdateRowClass(dependency)}">
      <div class="cardTitle"><button class="name" data-package="${escapeAttr(dependency.name)}">${escapeHtml(dependency.name)}</button><span class="pill">${dependency.type === 'dependencies' ? 'Production' : 'Development'}</span></div>
      <p class="cardDescription">${escapeHtml(dependency.description || 'No description available.')}</p>
      <div class="cardVersions"><span><small>Declared</small>${escapeHtml(dependency.currentVersion)}</span><span aria-hidden="true">→</span><span><small>Latest</small>${escapeHtml(dependency.latestVersion || 'Unknown')}</span></div>
      <div class="cardFooter"><div class="cardBadges">${renderUpdate(dependency)} ${renderRisk(dependency)}</div>${renderUpdateAction(dependency)}</div>
    </article>`;
  }

  function renderHeaderCell(column) {
    return `
      <span class="columnHeader" data-column-header="${escapeAttr(column.key)}">
        <span>${escapeHtml(column.label)}</span>
        <span class="columnResizeHandle" data-column-resize="${escapeAttr(column.key)}" title="Resize ${escapeAttr(column.label)} (arrow keys)" tabindex="0" role="separator" aria-label="Resize ${escapeAttr(column.label)}" aria-orientation="vertical" aria-valuemin="${column.minWidth}" aria-valuemax="${column.maxWidth}" aria-valuenow="${getColumnWidth(column.key)}"></span>
      </span>
    `;
  }

  function renderDependencyCell(columnKey, dependency) {
    const cells = {
      type: `<span class="pill">${dependency.type === 'dependencies' ? 'dep' : 'dev'}</span>`,
      license: `<span class="licenseCell">${renderLicense(dependency.license)}</span>`,
      current: `<span class="version">${escapeHtml(dependency.currentVersion)}</span>`,
      lock: `<span class="lockCell">${renderLockBadge(dependency)}</span>`,
      currentPublished: `<span class="version">${renderDate(dependency.resolvedPublishedAt)}</span>`,
      latest: `<span class="version">${escapeHtml(dependency.latestVersion || '-')}</span>`,
      latestPublished: `<span class="version">${renderDate(dependency.latestPublishedAt)}</span>`,
      update: `<span class="update">${renderUpdate(dependency)}</span>`,
      risk: `<span class="risk">${renderRisk(dependency)}</span>`,
      action: `<span class="actionCell">${renderUpdateAction(dependency)}</span>`
    };
    return cells[columnKey] || '';
  }

  function renderColumnPicker() {
    const visibleColumns = normalizeVisibleColumns(state.visibleColumns);
    return `
      <details class="columnPicker">
        <summary>
          Columns
          <span id="columnSummary">${formatNumber(visibleColumns.length + 1)}</span>
        </summary>
        <div class="columnMenu">
          <div class="columnPresets"><button class="textButton" data-column-preset="essential">Essential</button><button class="textButton" data-column-preset="all">All columns</button></div>
          <label class="columnOption disabled">
            <input type="checkbox" checked disabled>
            <span>Package</span>
          </label>
          ${tableColumns.map((column) => `
            <label class="columnOption">
              <input type="checkbox" data-column-toggle="${escapeAttr(column.key)}" ${visibleColumns.includes(column.key) ? 'checked' : ''}>
              <span>${escapeHtml(column.label)}</span>
            </label>
          `).join('')}
        </div>
      </details>
    `;
  }

  function updateColumnSummary() {
    const summary = document.getElementById('columnSummary');
    if (summary) {
      summary.textContent = String(normalizeVisibleColumns(state.visibleColumns).length + 1);
    }
  }

  function normalizeVisibleColumns(columns) {
    const allowed = new Set(tableColumns.map((column) => column.key));
    return Array.isArray(columns) ? columns.filter((column) => allowed.has(column)) : defaultVisibleColumns;
  }

  function normalizeColumnWidths(widths) {
    const normalized = {};
    const source = widths && typeof widths === 'object' && !Array.isArray(widths) ? widths : {};
    allTableColumns.forEach((column) => {
      normalized[column.key] = clampColumnWidth(column.key, source[column.key]);
    });
    return normalized;
  }

  function getColumnDefinition(columnKey) {
    return allTableColumns.find((column) => column.key === columnKey);
  }

  function getColumnWidth(columnKey) {
    return clampColumnWidth(columnKey, state.columnWidths?.[columnKey]);
  }

  function clampColumnWidth(columnKey, value) {
    const column = getColumnDefinition(columnKey);
    if (!column) {
      return Number(value) || 0;
    }
    const width = Number(value);
    const effectiveWidth = Number.isFinite(width) ? width : column.defaultWidth;
    return Math.min(Math.max(Math.round(effectiveWidth), column.minWidth), column.maxWidth);
  }

  function getDependencyGridTemplate(visibleColumnDefs = tableColumns.filter((column) => normalizeVisibleColumns(state.visibleColumns).includes(column.key))) {
    return [`minmax(${getColumnWidth('package')}px, 1fr)`, ...visibleColumnDefs.map((column) => `${getColumnWidth(column.key)}px`)].join(' ');
  }

  function getDependencyMinWidth(visibleColumnDefs) {
    return [packageColumn, ...visibleColumnDefs].reduce((total, column) => total + getColumnWidth(column.key) + 6, 16);
  }

  function applyColumnWidths() {
    const list = document.querySelector('.list');
    if (!list) {
      return;
    }
    const visibleColumnDefs = tableColumns.filter((column) => normalizeVisibleColumns(state.visibleColumns).includes(column.key));
    list.style.setProperty('--dependency-columns', getDependencyGridTemplate(visibleColumnDefs));
    list.style.setProperty('--dependency-min-width', `${getDependencyMinWidth(visibleColumnDefs)}px`);
  }

  function bindColumnResizers() {
    applyColumnWidths();
    document.querySelectorAll('[data-column-resize]').forEach(bindColumnResizer);
  }

  function bindColumnResizer(handle) {
    handle.addEventListener('pointerdown', startColumnResize);
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const key = handle.dataset.columnResize;
      const column = getColumnDefinition(key);
      const width = event.key === 'Home' ? column.minWidth : event.key === 'End' ? column.maxWidth : getColumnWidth(key) + (event.key === 'ArrowRight' ? 10 : -10);
      state.columnWidths[key] = clampColumnWidth(key, width);
      handle.setAttribute('aria-valuenow', state.columnWidths[key]);
      applyColumnWidths();
      persistViewState();
      vscode.postMessage({ type: 'setColumnWidths', widths: state.columnWidths });
    });
  }

  function startColumnResize(event) {
    event.preventDefault();
    const handle = event.currentTarget;
    const columnKey = handle.dataset.columnResize;
    const startX = event.clientX;
    const startWidth = getColumnWidth(columnKey);
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizingColumns');

    const onPointerMove = (moveEvent) => {
      state.columnWidths = normalizeColumnWidths({
        ...state.columnWidths,
        [columnKey]: startWidth + moveEvent.clientX - startX
      });
      applyColumnWidths();
      handle.setAttribute('aria-valuenow', getColumnWidth(columnKey));
    };

    const onPointerUp = () => {
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
      document.body.classList.remove('resizingColumns');
      persistViewState();
      vscode.postMessage({ type: 'setColumnWidths', widths: state.columnWidths });
    };

    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
  }

  function persistViewState() {
    const previous = vscode.getState() || {};
    vscode.setState({
      ...previous,
      visibleColumns: state.visibleColumns,
      columnWidths: state.columnWidths,
      filter: state.filter,
      riskFilter: state.riskFilter,
      updateFilter: state.updateFilter,
      licenseFilter: state.licenseFilter,
      searchQuery: state.searchQuery,
      sortBy: state.sortBy,
      filtersOpen: state.filtersOpen
    });
  }

  function renderDetail(detail) {
    showingDetail = true;
    app.innerHTML = DOMPurify.sanitize(`
      <div class="detailPage">
        <header class="packageHeader">
          <button id="backButton" class="backButton" title="Back to dependencies" aria-label="Back to dependencies">‹</button>
          <div class="packageIdentity">
            <div class="packageTitleLine">
              <h1>${escapeHtml(detail.name)}</h1>
              <span class="risk packageRisk">${renderRisk(detail)}</span>
              ${canUpdateDependency(detail) ? `<button class="primaryUpdate updateButton" data-update-package="${escapeAttr(detail.name)}" ${state.updateBusy ? 'disabled' : ''}>Choose version…</button>` : ''}
              <button id="refreshPackageButton" class="secondaryButton compactButton" data-package="${escapeAttr(detail.name)}" title="Clear cache and reload this package">Refresh</button>
            </div>
            <p>${escapeHtml(detail.description || 'No description provided.')}</p>
          </div>
        </header>

        <div id="updateStatus">${renderUpdateStatus()}</div>
        <div class="packageLayout">
          <article class="readmePanel">
            <div class="sectionTitle">README</div>
            <div class="readme">${detail.readmeHtml || ''}</div>
          </article>

          <aside class="packageSidebar">
            <section class="sideSection">
              <h2>Install</h2>
              <code class="installCommand">${escapeHtml(detail.installCommand || `npm install ${detail.name}`)}</code>
            </section>

            <section class="sideSection">
              <h2>Versions</h2>
              <dl class="facts">
                ${detail.resolvedVersion ? `<div><dt>Resolved</dt><dd>${escapeHtml(detail.resolvedVersion)}</dd></div>` : ''}
                <div><dt>Resolved published</dt><dd>${renderDate(detail.resolvedPublishedAt)}</dd></div>
                <div><dt>Latest</dt><dd>${escapeHtml(detail.latestVersion || '-')}</dd></div>
                <div><dt>Latest published</dt><dd>${renderDate(detail.latestPublishedAt)}</dd></div>
                <div><dt>Update</dt><dd>${renderUpdate(detail)}</dd></div>
                ${detail.license ? `<div><dt>License</dt><dd>${escapeHtml(detail.license)}</dd></div>` : ''}
              </dl>
            </section>

            ${renderDependencyTreeContext(detail)}

            <section class="sideSection">
              <h2>Lockfile</h2>
              <dl class="facts">
                <div><dt>Manager</dt><dd>${renderPackageManager(detail.packageManager)}</dd></div>
                <div><dt>Status</dt><dd>${renderLockBadge(detail)}</dd></div>
                ${detail?.lockInfo.label ? `<div><dt>File</dt><dd>${escapeHtml(detail.lockInfo.label)}</dd></div>` : ''}
                ${detail?.lockInfo.lockfileVersion ? `<div><dt>lockfileVersion</dt><dd>${escapeHtml(detail.lockInfo.lockfileVersion)}</dd></div>` : ''}
                ${detail.lockPath ? `<div><dt>Package path</dt><dd>${escapeHtml(detail.lockPath)}</dd></div>` : ''}
                ${detail.lockResolved ? `<div><dt>Tarball</dt><dd><a href="${escapeAttr(detail.lockResolved)}">${escapeHtml(shortenUrl(detail.lockResolved))}</a></dd></div>` : ''}
                ${detail.lockIntegrity ? `<div><dt>Integrity</dt><dd><code class="integrity">${escapeHtml(detail.lockIntegrity)}</code></dd></div>` : ''}
                ${renderLockFlags(detail)}
              </dl>
            </section>

            <section class="sideSection">
              <h2>Downloads</h2>
              <dl class="facts">
                <div><dt>Weekly downloads</dt><dd>${formatNumber(detail.weeklyDownloads)}</dd></div>
              </dl>
            </section>

            ${renderNpmMetadata(detail)}

            ${renderSecurity(detail)}

            <section class="sideSection">
              <h2>Links</h2>
              <nav class="packageLinks">
                <a href="${escapeAttr(detail.npmUrl)}">npm</a>
                ${detail.homepage ? `<a href="${escapeAttr(detail.homepage)}">Homepage</a>` : ''}
                ${detail.repository ? `<a href="${escapeAttr(detail.repository)}">Repository</a>` : ''}
              </nav>
            </section>
          </aside>
        </div>
      </div>
    `);

    document.getElementById('backButton').addEventListener('click', () => {
      vscode.postMessage({ type: 'backToList' });
    });
    document.getElementById('refreshPackageButton').addEventListener('click', (event) => {
      vscode.postMessage({ type: 'refreshPackage', name: event.currentTarget.dataset.package });
    });
    bindPackageButtons();
  }

  function bindExternalLinks() {
    app.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link || !app.contains(link)) {
        return;
      }

      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      const url = toExternalUrl(href);
      if (url) {
        vscode.postMessage({ type: 'openExternal', url });
      }
    }, true);
  }

  function toExternalUrl(href) {
    if (href.startsWith('//')) {
      return `https:${href}`;
    }

    try {
      const url = new URL(href, window.location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
        return url.href;
      }
    } catch (error) {
      reportWebviewFallback('Ignored an invalid external URL', error);
      return '';
    }
    return '';
  }

  function renderLoading(message) {
    const container = document.createElement('div');
    container.className = 'center';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const text = document.createElement('p');
    text.textContent = String(message || 'Loading...');
    container.append(spinner, text);
    app.replaceChildren(container);
  }

  function renderInlineLoading(message) {
    return `
      <div class="inlineLoading" role="status" aria-live="polite">
        <div class="spinner"></div>
        <p>${escapeHtml(message || 'Loading...')}</p>
      </div>
    `;
  }

  function renderError(message) {
    const container = document.createElement('div');
    container.className = 'center error';
    const text = document.createElement('p');
    text.textContent = String(message || '');
    const retryButton = document.createElement('button');
    retryButton.id = 'retryButton';
    retryButton.textContent = 'Refresh';
    retryButton.addEventListener('click', () => vscode.postMessage({ type: 'ready' }));
    container.append(text, retryButton);
    app.replaceChildren(container);
  }

  function renderLicenseOptions() {
    const options = Array.isArray(state.licenseOptions) ? state.licenseOptions : [];
    const selected = state.licenseFilter || 'all';
    return [
      `<option value="all" ${selected === 'all' ? 'selected' : ''}>All licenses</option>`,
      ...options.map((option) => `<option value="${escapeAttr(option.value)}" ${selected === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
    ].join('');
  }

  function renderCompactStatus(packageManager, lockInfo) {
    const managerLabel = formatPackageManager(packageManager);
    const lockLabel = lockInfo?.exists ? (lockInfo.label || packageManager?.lockfile || 'lockfile') : 'no lock';
    return `${escapeHtml(managerLabel)} / ${escapeHtml(lockLabel)}`;
  }

  function formatPackageManager(packageManager) {
    if (!packageManager) {
      return 'npm';
    }
    const name = packageManager.label || packageManager.id || 'npm';
    const version = packageManager.version ? ` ${packageManager.version}` : '';
    return `${name}${version}`;
  }

  function renderPackageManager(packageManager) {
    const sourceLabels = {
      packageManager: 'package.json',
      lockfile: 'lockfile',
      default: 'default'
    };
    const source = packageManager?.source ? ` (${sourceLabels[packageManager.source] || packageManager.source})` : '';
    return `${escapeHtml(formatPackageManager(packageManager))}${escapeHtml(source)}`;
  }

  function renderDate(value) {
    if (!value) {
      return '-';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '-';
    }
    return `<time datetime="${escapeAttr(value)}">${date.toLocaleDateString()}</time>`;
  }

  function renderRisk(dependency) {
    const badges = [];
    if (dependency.deprecated) {
      badges.push('<span class="badge deprecated">deprecated</span>');
    }
    if (dependency.auditStatus === 'vulnerable') {
      badges.push(`<span class="badge vulnerable">${escapeHtml(dependency.maxSeverity || 'vuln')}</span>`);
    }
    if (hasOsv(dependency)) {
      badges.push(`<span class="badge osv">OSV ${formatNumber((dependency.osvVulnerabilities || []).length + (dependency.transitiveOsvVulnerabilities || []).length)}</span>`);
    }
    if (hasKev(dependency)) {
      badges.push(`<span class="badge kev">KEV</span>`);
    }
    if (hasSsvc(dependency)) {
      badges.push('<span class="badge ssvc">SSVC</span>');
    }
    if (Number.isFinite(dependency.securitySignals?.maxEpss?.epss)) {
      badges.push(`<span class="badge epss">EPSS ${formatPercent(dependency.securitySignals.maxEpss.epss)}</span>`);
    }
    if (dependency.transitiveVulnerabilityCount) {
      badges.push(`<span class="badge transitive">${escapeHtml(dependency.transitiveMaxSeverity || 'transitive')} ${formatNumber(dependency.transitiveVulnerabilityCount)}</span>`);
    }
    if (dependency.auditStatus === 'unknown') {
      badges.push('<span class="badge unknown">not checked</span>');
    }
    return badges.length ? badges.join('') : '<span class="badge ok">ok</span>';
  }

  function hasOsv(dependency) {
    return Boolean((dependency.osvVulnerabilities || []).length || (dependency.transitiveOsvVulnerabilities || []).length);
  }

  function hasKev(dependency) {
    return Boolean(dependency.securitySignals?.kev?.length);
  }

  function hasSsvc(dependency) {
    return Boolean(dependency.securitySignals?.ssvc?.length);
  }

  function renderLockBadge(dependency) {
    if (dependency.lockStatus === 'locked') {
      return `<span class="lockBadge locked" title="${escapeAttr(dependency.lockPath || 'Locked in package-lock.json')}">locked</span>`;
    }
    if (dependency.lockStatus === 'notParsed') {
      return '<span class="lockBadge unlocked" title="A lockfile was detected, but per-package lock details are currently available for npm only.">detected</span>';
    }
    return '<span class="lockBadge unlocked" title="Not found in package-lock.json">unlocked</span>';
  }

  function renderLockFlags(detail) {
    const flags = [];
    if (detail.lockDev) {
      flags.push('dev');
    }
    if (detail.lockOptional) {
      flags.push('optional');
    }
    if (detail.lockPeer) {
      flags.push('peer');
    }
    if (!flags.length) {
      return '';
    }
    const flagBadges = flags.map(renderLockFlag).join('');
    return `<div><dt>Flags</dt><dd>${flagBadges}</dd></div>`;
  }

  function renderLockFlag(flag) {
    return `<span class="lockFlag">${escapeHtml(flag)}</span>`;
  }

  function renderDependencyTreeContext(detail) {
    if (!detail.parentName && !detail.dependencyPath) {
      return '';
    }

    const facts = [];
    if (detail.dependencyPath) {
      facts.push(renderFact('Path', escapeHtml(detail.dependencyPath)));
    }
    if (detail.parentName) {
      facts.push(renderFact('Required by', escapeHtml(`${detail.parentName}@${detail.parentVersion || '-'}`)));
    }
    if (detail.currentVersion) {
      facts.push(renderFact('Requested range', escapeHtml(detail.currentVersion)));
    }
    if (detail.resolvedFromVersion) {
      facts.push(renderFact('Parent manifest', escapeHtml(detail.resolvedFromVersion)));
    }
    if (Number.isFinite(detail.dependencyDepth)) {
      facts.push(renderFact('Depth', formatNumber(detail.dependencyDepth)));
    }

    return `
      <section class="sideSection">
        <h2>Dependency Tree</h2>
        <dl class="facts">
          ${facts.join('')}
        </dl>
      </section>
    `;
  }

  function renderFact(label, value) {
    return `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  }

  function renderNpmMetadata(detail) {
    const distTags = Object.entries(detail.distTags || {});
    const maintainers = detail.maintainers || [];
    const keywords = detail.keywords || [];
    const facts = [];

    addTextFact(facts, 'Publisher', detail.publisher);
    addTextFact(facts, 'Author', detail.author);
    if (maintainers.length) {
      facts.push(renderFact('Maintainers', renderLimitedChips(maintainers, 6)));
    }
    if (detail.createdAt) {
      facts.push(renderFact('Created', renderDate(detail.createdAt)));
    }
    if (detail.modifiedAt) {
      facts.push(renderFact('Modified', renderDate(detail.modifiedAt)));
    }
    if (Number.isFinite(detail.versionCount)) {
      facts.push(renderFact('Versions', formatNumber(detail.versionCount)));
    }
    if (distTags.length) {
      facts.push(renderFact('Dist tags', distTags.map(renderDistTag).join('')));
    }
    if (keywords.length) {
      facts.push(renderFact('Keywords', renderLimitedChips(keywords, 12)));
    }

    return `
      <section class="sideSection npmMetadata">
        <h2>npm Metadata</h2>
        <dl class="facts">
          ${facts.join('')}
        </dl>
      </section>
    `;
  }

  function addTextFact(facts, label, value) {
    if (value) {
      facts.push(renderFact(label, escapeHtml(value)));
    }
  }

  function renderLimitedChips(values, limit) {
    const chips = values.slice(0, limit).map(renderMetadataChip).join('');
    const remainder = values.length - limit;
    return remainder > 0 ? `${chips}<small>+${remainder} more</small>` : chips;
  }

  function renderMetadataChip(value) {
    return `<span class="metadataChip">${escapeHtml(value)}</span>`;
  }

  function renderDistTag([tag, version]) {
    return `<span class="metadataChip tag"><strong>${escapeHtml(tag)}</strong> ${escapeHtml(version)}</span>`;
  }

  function renderUpdate(dependency) {
    let type = dependency.updateType;
    if (!type) {
      type = dependency.status === 'update' ? 'unknown' : 'current';
    }
    const label = dependency.updateLabel || type;
    return `<span class="updateBadge ${escapeAttr(type)}">${escapeHtml(label)}</span>`;
  }

  function renderLicense(license) {
    const value = getLicenseDisplayValue(license);
    const className = value === 'Unknown' ? 'unknown' : 'known';
    return `<span class="licenseBadge ${className}" title="${escapeAttr(value)}">${escapeHtml(value)}</span>`;
  }

  function getLicenseFilterValue(license) {
    const value = getLicenseDisplayValue(license);
    return value === 'Unknown' ? '__unknown__' : value;
  }

  function getLicenseDisplayValue(license) {
    const value = String(license || '').trim();
    return value || 'Unknown';
  }

  function renderUpdateAction(dependency) {
    if (!canUpdateDependency(dependency)) {
      return '<span class="mutedDash">-</span>';
    }

    return `<button class="secondaryButton compactButton updateButton" data-update-package="${escapeAttr(dependency.name)}" ${state.updateBusy ? 'disabled' : ''} title="Choose a version of ${escapeAttr(dependency.name)}">Update…</button>`;
  }

  function canUpdateDependency(dependency) {
    return Boolean(
      dependency?.name &&
      dependency.latestVersion &&
      !dependency.parentName &&
      !dependency.dependencyDepth
    );
  }

  function renderUpdateStatus() {
    const result = state.updateResult;
    if (!result) return '';
    const labels = { running: 'Updating', succeeded: 'Command succeeded', failed: 'Update failed', unknown: 'Result unconfirmed' };
    const status = Object.hasOwn(labels, result.status) ? result.status : 'unknown';
    const versionText = (value) => !value ? 'Unavailable' : value.resolvedVersion
      ? `${value.resolvedVersion} (package.json: ${value.range})`
      : `package.json: ${value.range} · Resolved version unavailable`;
    return `<section class="updateResult ${status}" role="status" aria-live="polite">
      <strong>${labels[status]}: ${escapeHtml(result.name)}</strong>
      <p class="resultVersion">${escapeHtml(versionText(result.before))}${status !== 'running' ? ` → ${escapeHtml(versionText(result.after))}` : ` → Target ${escapeHtml(result.targetVersion)}`}</p>
      <details ${status === 'failed' || status === 'unknown' || result.readError || result.refreshError ? 'open' : ''}><summary>Update details</summary>
      <p>${escapeHtml(result.message)}</p><dl>
        <div><dt>Target</dt><dd>${escapeHtml(result.targetVersion)}</dd></div>
        <div><dt>Before</dt><dd>${escapeHtml(versionText(result.before))}</dd></div>
        ${status !== 'running' ? `<div><dt>After</dt><dd>${escapeHtml(versionText(result.after))}</dd></div>` : ''}
      </dl></details>
      ${result.refreshing ? '<p>Refreshing dependency and security information…</p>' : ''}
      ${result.readError ? `<p>${escapeHtml(result.readError)}</p>` : ''}
      ${result.refreshError ? `<p>${escapeHtml(result.refreshError)}</p>` : ''}
    </section>`;
  }

  function getUpdateRowClass(dependency) {
    const type = dependency.updateType;
    return type && type !== 'current' && type !== 'unknown' ? `updateRow ${escapeAttr(type)}Update` : '';
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) {
      return '-';
    }
    return value.toLocaleString();
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) {
      return '-';
    }
    return `${Math.round(value * 100)}%`;
  }

  function shortenUrl(value) {
    try {
      const url = new URL(value);
      return `${url.host}${url.pathname}`;
    } catch (error) {
      reportWebviewFallback('Displayed an invalid metadata URL as-is', error);
      return value;
    }
  }

  function renderSecurity(detail) {
    const vulnerabilities = detail.vulnerabilities || [];
    const osvVulnerabilities = detail.osvVulnerabilities || [];
    const transitiveVulnerabilities = detail.transitiveVulnerabilities || [];
    const transitiveOsvVulnerabilities = detail.transitiveOsvVulnerabilities || [];
    const securitySignals = detail.securitySignals || {};
    if (!detail.deprecated && !vulnerabilities.length && !osvVulnerabilities.length && !transitiveVulnerabilities.length && !transitiveOsvVulnerabilities.length && detail.auditStatus !== 'unknown') {
      return '<section class="sideSection security okPanel"><h2>Security</h2><p>No deprecation or known vulnerability signals found for the resolved version.</p></section>';
    }

    const content = [
      renderSecuritySignals(securitySignals),
      renderDeprecatedNotice(detail),
      renderUnknownAuditNotice(detail),
      renderAdvisoryGroup('npm audit advisories', vulnerabilities, 'npm'),
      renderAdvisoryGroup('OSV vulnerabilities', osvVulnerabilities, 'osv'),
      renderAdvisoryGroup('Transitive vulnerabilities', transitiveVulnerabilities, 'transitiveNpm'),
      renderAdvisoryGroup('Transitive OSV vulnerabilities', transitiveOsvVulnerabilities, 'osv', true)
    ].join('');

    return `
      <section class="sideSection security">
        <h2>Security</h2>
        ${content}
      </section>
    `;
  }

  function renderDeprecatedNotice(detail) {
    if (!detail.deprecated) {
      return '';
    }
    const message = detail.deprecatedMessage || 'This package version is deprecated.';
    return `<div class="notice deprecatedNotice"><strong>Deprecated</strong><p>${escapeHtml(message)}</p></div>`;
  }

  function renderUnknownAuditNotice(detail) {
    if (detail.auditStatus !== 'unknown') {
      return '';
    }
    const message = detail.auditError || 'A resolved version was not available. Add or update package-lock.json for more accurate audit results.';
    return `<div class="notice unknownNotice"><strong>Vulnerabilities not checked</strong><p>${escapeHtml(message)}</p></div>`;
  }

  function renderSecuritySignals(signals) {
    const cves = signals.cves || [];
    const kev = signals.kev || [];
    const epss = signals.epss || [];
    const ssvc = signals.ssvc || [];
    if (!cves.length && !kev.length && !epss.length && !ssvc.length) {
      return '';
    }

    const content = [
      renderCveSignals(cves),
      renderKevSummary(kev),
      renderEpssSummary(epss),
      renderSsvcSummary(ssvc),
      kev.slice(0, 3).map(renderKevDetail).join(''),
      ssvc.slice(0, 3).map(renderSsvcDetail).join('')
    ].join('');

    return `
      <div class="signalPanel">
        <strong>Risk intelligence</strong>
        ${content}
      </div>
    `;
  }

  function renderCveSignals(cves) {
    if (!cves.length) {
      return '';
    }
    return `<p>CVEs: ${renderLimitedChips(cves, 6)}</p>`;
  }

  function renderKevSummary(kev) {
    if (!kev.length) {
      return '';
    }
    const suffix = kev.length === 1 ? '' : 's';
    return `<p><span class="badge kev">KEV</span> ${formatNumber(kev.length)} CVE${suffix} listed in CISA Known Exploited Vulnerabilities.</p>`;
  }

  function renderEpssSummary(epss) {
    if (!epss.length) {
      return '';
    }
    const percentile = Number.isFinite(epss[0].percentile) ? ` (${Math.round(epss[0].percentile * 100)}th percentile)` : '';
    return `<p>Highest EPSS: <strong>${formatPercent(epss[0].epss)}</strong>${percentile}</p>`;
  }

  function renderSsvcSummary(ssvc) {
    if (!ssvc.length) {
      return '';
    }
    const suffix = ssvc.length === 1 ? '' : 's';
    return `<p><span class="badge ssvc">SSVC</span> CISA decision points available for ${formatNumber(ssvc.length)} CVE${suffix}.</p>`;
  }

  function renderKevDetail(entry) {
    const name = entry.vulnerabilityName || `${entry.vendorProject} ${entry.product}`;
    const date = entry.dateAdded ? ` · added ${escapeHtml(entry.dateAdded)}` : '';
    return `<p class="signalDetail">${escapeHtml(entry.cve)}: ${escapeHtml(name)}${date}</p>`;
  }

  function renderSsvcDetail(entry) {
    const details = [
      entry.exploitation && `exploitation: ${entry.exploitation}`,
      entry.automatable && `automatable: ${entry.automatable}`,
      entry.technicalImpact && `technical impact: ${entry.technicalImpact}`
    ].filter(Boolean).join(' · ');
    const version = entry.version ? ` · SSVC ${entry.version}` : '';
    return `<p class="signalDetail">${escapeHtml(entry.cve)}: ${escapeHtml(details || 'decision points available')}${escapeHtml(version)}</p>`;
  }

  function renderAdvisoryGroup(title, advisories, kind, transitive = false) {
    if (!advisories.length) {
      return '';
    }
    const articles = advisories.map((advisory) => renderAdvisory(advisory, kind, transitive)).join('');
    return `
      <div class="advisories">
        <h3>${escapeHtml(title)}</h3>
        ${articles}
      </div>
    `;
  }

  function renderAdvisory(advisory, kind, transitive) {
    const className = transitive || kind === 'transitiveNpm' ? 'transitiveAdvisory' : '';
    const heading = getAdvisoryHeading(advisory, kind);
    const details = renderAdvisoryDetails(advisory, kind);
    return `
      <article class="advisory ${className} ${escapeAttr(advisory.severity || 'unknown')}">
        <div>
          <strong>${escapeHtml(heading)}</strong>
          <span>${escapeHtml(advisory.severity || 'unknown')}</span>
        </div>
        ${details}
      </article>
    `;
  }

  function getAdvisoryHeading(advisory, kind) {
    if (kind === 'transitiveNpm' || advisory.packageName) {
      return `${advisory.packageName || 'dependency'}@${advisory.packageVersion || '-'}`;
    }
    return advisory.title;
  }

  function renderAdvisoryDetails(advisory, kind) {
    const details = [];
    if (kind === 'transitiveNpm' || (kind === 'osv' && advisory.packageName)) {
      details.push(`<p>${escapeHtml(advisory.title)}</p>`);
    }
    if (kind === 'osv' && advisory.id) {
      details.push(`<p>ID: ${escapeHtml(advisory.id)}</p>`);
    }
    if (kind === 'osv' && advisory.cves?.length) {
      details.push(`<p>CVEs: ${advisory.cves.map(renderMetadataChip).join('')}</p>`);
    }
    addAdvisoryDetail(details, 'Vulnerable', advisory.vulnerableVersions);
    addAdvisoryDetail(details, 'Patched', advisory.patchedVersions);
    if (kind !== 'npm') {
      addAdvisoryDetail(details, 'Path', advisory.packagePath);
    }
    if (advisory.url) {
      details.push(`<a href="${escapeAttr(advisory.url)}">Advisory</a>`);
    }
    return details.join('');
  }

  function addAdvisoryDetail(details, label, value) {
    if (value) {
      details.push(`<p>${escapeHtml(label)}: ${escapeHtml(value)}</p>`);
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function reportWebviewFallback(context, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[npm-dependency-manager] ${context}: ${message}`);
  }

  vscode.postMessage({ type: 'ready' });
}());
