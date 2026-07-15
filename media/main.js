(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const persistedState = vscode.getState() || {};
  const packageColumn = { key: 'package', label: 'Package', minWidth: 116, defaultWidth: 180, maxWidth: 520 };
  const tableColumns = [
    { key: 'type', label: 'Type', minWidth: 42, defaultWidth: 52, maxWidth: 180 },
    { key: 'license', label: 'License', minWidth: 86, defaultWidth: 110, maxWidth: 360 },
    { key: 'current', label: 'Current', minWidth: 68, defaultWidth: 92, maxWidth: 260 },
    { key: 'lock', label: 'Lock', minWidth: 70, defaultWidth: 86, maxWidth: 240 },
    { key: 'currentPublished', label: 'Current published', minWidth: 104, defaultWidth: 128, maxWidth: 300 },
    { key: 'latest', label: 'Latest', minWidth: 68, defaultWidth: 96, maxWidth: 260 },
    { key: 'latestPublished', label: 'Latest published', minWidth: 104, defaultWidth: 128, maxWidth: 300 },
    { key: 'update', label: 'Update', minWidth: 68, defaultWidth: 88, maxWidth: 220 },
    { key: 'risk', label: 'Risk', minWidth: 86, defaultWidth: 120, maxWidth: 420 },
    { key: 'action', label: 'Action', minWidth: 72, defaultWidth: 88, maxWidth: 220 }
  ];
  const allTableColumns = [packageColumn, ...tableColumns];
  const defaultVisibleColumns = tableColumns.map((column) => column.key);
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
  });

  bindExternalLinks();

  function renderList() {
    const counts = state.dependencyCounts || { dependencies: 0, devDependencies: 0 };
    const visibleDependencies = getVisibleDependencies();
    const dependencyContent = renderDependencyContent(visibleDependencies);

    app.innerHTML = `
      <section class="dashboardHeader">
        <div class="headerTitle">
          <h1>npm Packages</h1>
          <p>${escapeHtml(state.selectedLabel || state.selectedPackageJson || 'No package.json selected')}</p>
        </div>
        <div class="headerActions">
          <span class="headerMeta">${renderCompactStatus(state.packageManager, state.lockInfo, state.cacheStats)}</span>
          <button id="refreshAllButton" class="secondaryButton" title="Clear cache and reload registry data">Refresh all</button>
        </div>
      </section>

      <section class="controlPanel">
        <div class="controlPrimary">
          <label class="field packageField">
            <span>package.json</span>
            <select id="packageSelect">
              ${state.packageFiles.map((file) => `<option value="${escapeAttr(file.path)}" ${file.path === state.selectedPackageJson ? 'selected' : ''}>${escapeHtml(file.label)}</option>`).join('')}
            </select>
          </label>

          <label class="field searchField">
            <span>Search packages</span>
            <input id="searchInput" type="search" value="${escapeAttr(state.searchQuery || '')}" placeholder="Package name">
          </label>
        </div>

        <div class="filterGrid">
          <div class="filterGroup">
            <span class="groupLabel">Type</span>
            <div class="segments" role="group" aria-label="Dependency type">
              ${segment('all', 'All')}
              ${segment('dependencies', `dependencies ${counts.dependencies}`)}
              ${segment('devDependencies', `dev ${counts.devDependencies}`)}
            </div>
          </div>

          <div class="filterGroup">
            <span class="groupLabel">Risk</span>
            <div class="segments riskSegments" role="group" aria-label="Risk">
              ${riskSegment('all', 'All')}
              ${riskSegment('vulnerable', 'Vulnerable')}
              ${riskSegment('deprecated', 'Deprecated')}
              ${riskSegment('notChecked', 'Not checked')}
              ${riskSegment('ok', 'OK')}
            </div>
          </div>

          <div class="filterGroup wide">
            <span class="groupLabel">Update</span>
            <div class="segments updateSegments" role="group" aria-label="Update">
              ${updateSegment('all', 'All updates')}
              ${updateSegment('update', 'Updates')}
              ${updateSegment('major', 'Major')}
              ${updateSegment('minor', 'Minor')}
              ${updateSegment('patch', 'Patch')}
              ${updateSegment('current', 'Current')}
            </div>
          </div>

          <label class="field licenseField">
            <span>License</span>
            <select id="licenseSelect">
              ${renderLicenseOptions()}
            </select>
          </label>
        </div>

      </section>

      <section class="dependencySection">
        <div class="sectionHeader">
          <div>
            <h2>Packages</h2>
            <p>${formatNumber(visibleDependencies.length)} shown from ${formatNumber(state.dependencies.length)} loaded packages</p>
          </div>
          ${renderColumnPicker()}
        </div>
        <div id="dependencyTable">
          ${dependencyContent}
        </div>
      </section>
    `;

    const packageSelect = document.getElementById('packageSelect');
    if (packageSelect) {
      packageSelect.addEventListener('change', (event) => {
        vscode.postMessage({ type: 'selectPackageJson', path: event.target.value });
      });
    }

    const refreshAllButton = document.getElementById('refreshAllButton');
    if (refreshAllButton) {
      refreshAllButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'refreshAll' });
      });
    }

    document.querySelectorAll('[data-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter;
        persistViewState();
        vscode.postMessage({ type: 'setFilter', filter: button.dataset.filter });
      });
    });

    document.querySelectorAll('[data-risk-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        state.riskFilter = button.dataset.riskFilter;
        updateRiskSegments();
        updateDependencyTable();
        persistViewState();
        vscode.postMessage({ type: 'setRiskFilter', filter: button.dataset.riskFilter });
      });
    });

    document.querySelectorAll('[data-update-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        state.updateFilter = button.dataset.updateFilter;
        updateUpdateSegments();
        updateDependencyTable();
        persistViewState();
        vscode.postMessage({ type: 'setUpdateFilter', filter: button.dataset.updateFilter });
      });
    });

    const licenseSelect = document.getElementById('licenseSelect');
    if (licenseSelect) {
      licenseSelect.addEventListener('change', (event) => {
        state.licenseFilter = event.target.value;
        updateDependencyTable();
        persistViewState();
        vscode.postMessage({ type: 'setLicenseFilter', filter: event.target.value });
      });
    }

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      let searchTimer;
      searchInput.addEventListener('input', (event) => {
        state.searchQuery = event.target.value;
        updateDependencyTable();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          persistViewState();
          vscode.postMessage({ type: 'setSearchQuery', query: event.target.value });
        }, 300);
      });
    }

    bindPackageButtons();
    bindColumnPicker();
    bindColumnResizers();
  }

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

    dependencyTable.innerHTML = renderDependencyTable(getVisibleDependencies());
    bindPackageButtons();
    bindColumnResizers();
  }

  function bindColumnPicker() {
    document.querySelectorAll('[data-column-toggle]').forEach(bindColumnToggle);
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

  function bindPackageButtons() {
    document.querySelectorAll('.name[data-package]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'openPackage', name: button.dataset.package });
      });
    });

    document.querySelectorAll('[data-update-package]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({
          type: 'runUpdate',
          name: button.dataset.updatePackage,
          version: button.dataset.updateVersion,
          dependencyType: button.dataset.dependencyType
        });
      });
    });
  }

  function getVisibleDependencies() {
    const query = String(state.searchQuery || '').trim().toLowerCase();
    const filtered = filterByLicense(filterByUpdate(filterByRisk(state.dependencies, state.riskFilter), state.updateFilter), state.licenseFilter);
    if (!query) {
      return filtered;
    }

    return filtered.filter((dependency) => {
      return dependency.name.toLowerCase().includes(query) || String(dependency.description || '').toLowerCase().includes(query);
    });
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
      return '<p class="empty">No packages match this filter or search.</p>';
    }

    const visibleColumns = normalizeVisibleColumns(state.visibleColumns);
    const visibleColumnDefs = tableColumns.filter((column) => visibleColumns.includes(column.key));
    const gridTemplate = getDependencyGridTemplate(visibleColumnDefs);
    const minWidth = getDependencyMinWidth(visibleColumnDefs);

    return `
      <div class="tableScroller">
        <div class="list" style="--dependency-columns: ${escapeAttr(gridTemplate)}; --dependency-min-width: ${minWidth}px">
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

  function renderHeaderCell(column) {
    return `
      <span class="columnHeader" data-column-header="${escapeAttr(column.key)}">
        <span>${escapeHtml(column.label)}</span>
        <span class="columnResizeHandle" data-column-resize="${escapeAttr(column.key)}" title="Resize ${escapeAttr(column.label)}"></span>
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
    return [packageColumn, ...visibleColumnDefs].map((column) => `${getColumnWidth(column.key)}px`).join(' ');
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
    document.querySelectorAll('[data-column-resize]').forEach(bindColumnResizer);
  }

  function bindColumnResizer(handle) {
    handle.addEventListener('pointerdown', startColumnResize);
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
      searchQuery: state.searchQuery
    });
  }

  function renderDetail(detail) {
    app.innerHTML = `
      <div class="detailPage">
        <header class="packageHeader">
          <button id="backButton" class="backButton" title="Back">‹</button>
          <div class="packageIdentity">
            <div class="packageTitleLine">
              <h1>${escapeHtml(detail.name)}</h1>
              <span class="risk packageRisk">${renderRisk(detail)}</span>
              <button id="refreshPackageButton" class="secondaryButton compactButton" data-package="${escapeAttr(detail.name)}" title="Clear cache and reload this package">Refresh</button>
            </div>
            <p>${escapeHtml(detail.description || 'No description provided.')}</p>
          </div>
        </header>

        <div class="packageLayout">
          <article class="readmePanel">
            <div class="sectionTitle">README</div>
            <div class="readme">${detail.readmeHtml || ''}</div>
          </article>

          <aside class="packageSidebar">
            <section class="sideSection">
              <h2>Install</h2>
              <code class="installCommand">${escapeHtml(detail.installCommand || `npm install ${detail.name}`)}</code>
              ${renderDetailUpdateAction(detail)}
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
    `;

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
    app.innerHTML = `<div class="center"><div class="spinner"></div><p>${escapeHtml(message || 'Loading...')}</p></div>`;
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
    app.innerHTML = `
      <div class="center error">
        <p>${escapeHtml(message)}</p>
        <button id="retryButton">Refresh</button>
      </div>
    `;
    document.getElementById('retryButton').addEventListener('click', () => vscode.postMessage({ type: 'ready' }));
  }

  function segment(value, label) {
    return `<button data-filter="${value}" class="${state.filter === value ? 'active' : ''}">${escapeHtml(label)}</button>`;
  }

  function riskSegment(value, label) {
    return `<button data-risk-filter="${value}" class="${state.riskFilter === value ? 'active' : ''}">${escapeHtml(label)}</button>`;
  }

  function updateSegment(value, label) {
    return `<button data-update-filter="${value}" class="${state.updateFilter === value ? 'active' : ''}">${escapeHtml(label)}</button>`;
  }

  function renderLicenseOptions() {
    const options = Array.isArray(state.licenseOptions) ? state.licenseOptions : [];
    const selected = state.licenseFilter || 'all';
    return [
      `<option value="all" ${selected === 'all' ? 'selected' : ''}>All licenses</option>`,
      ...options.map((option) => `<option value="${escapeAttr(option.value)}" ${selected === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
    ].join('');
  }

  function updateRiskSegments() {
    document.querySelectorAll('[data-risk-filter]').forEach((button) => {
      button.classList.toggle('active', button.dataset.riskFilter === state.riskFilter);
    });
  }

  function updateUpdateSegments() {
    document.querySelectorAll('[data-update-filter]').forEach((button) => {
      button.classList.toggle('active', button.dataset.updateFilter === state.updateFilter);
    });
  }

  function renderCompactStatus(packageManager, lockInfo, cacheStats) {
    const stats = cacheStats || {};
    const cacheTotal = ['registry', 'dependencies', 'audit', 'osv', 'epss', 'readme', 'downloads'].reduce((sum, key) => {
      return sum + (Number.isFinite(stats[key]) ? stats[key] : 0);
    }, 0);
    const managerLabel = formatPackageManager(packageManager);
    const lockLabel = lockInfo?.exists ? (lockInfo.label || packageManager?.lockfile || 'lockfile') : 'no lock';
    return `${escapeHtml(managerLabel)} / ${escapeHtml(lockLabel)} / cache ${formatNumber(cacheTotal)}`;
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

    return `<button class="secondaryButton compactButton updateButton" data-update-package="${escapeAttr(dependency.name)}" data-update-version="${escapeAttr(dependency.latestVersion)}" data-dependency-type="${escapeAttr(dependency.type || '')}" title="Update ${escapeAttr(dependency.name)} to ${escapeAttr(dependency.latestVersion)}">Update</button>`;
  }

  function renderDetailUpdateAction(detail) {
    if (!canUpdateDependency(detail)) {
      return '';
    }

    const scope = detail.type === 'devDependencies' ? 'devDependency' : 'dependency';
    return `
      <div class="installAction">
        <button class="secondaryButton updateButton" data-update-package="${escapeAttr(detail.name)}" data-update-version="${escapeAttr(detail.latestVersion)}" data-dependency-type="${escapeAttr(detail.type || '')}">
          Update to ${escapeHtml(detail.latestVersion)}
        </button>
        <small>Runs as a ${escapeHtml(scope)} update in the selected package.json directory.</small>
      </div>
    `;
  }

  function canUpdateDependency(dependency) {
    return Boolean(
      dependency?.name &&
      dependency.latestVersion &&
      !dependency.parentName &&
      !dependency.dependencyDepth &&
      ['major', 'minor', 'patch'].includes(dependency.updateType)
    );
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
    if (!cves.length && !kev.length && !epss.length) {
      return '';
    }

    const content = [
      renderCveSignals(cves),
      renderKevSummary(kev),
      renderEpssSummary(epss),
      kev.slice(0, 3).map(renderKevDetail).join('')
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

  function renderKevDetail(entry) {
    const name = entry.vulnerabilityName || `${entry.vendorProject} ${entry.product}`;
    const date = entry.dateAdded ? ` · added ${escapeHtml(entry.dateAdded)}` : '';
    return `<p class="signalDetail">${escapeHtml(entry.cve)}: ${escapeHtml(name)}${date}</p>`;
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
