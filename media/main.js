(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = {
    packageFiles: [],
    selectedPackageJson: '',
    filter: 'all',
    riskFilter: 'all',
    searchQuery: '',
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
    dependencies: []
  };

  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.type === 'loading') {
      renderLoading(message.message);
    }

    if (message.type === 'error') {
      renderError(message.message);
    }

    if (message.type === 'state') {
      state = { ...state, ...message };
      renderList();
    }

    if (message.type === 'detail') {
      renderDetail(message.detail);
    }
  });

  function renderList() {
    const counts = state.dependencyCounts || { dependencies: 0, devDependencies: 0 };

    app.innerHTML = `
      <section class="toolbar">
        <label class="field">
          <span>package.json</span>
          <select id="packageSelect">
            ${state.packageFiles.map((file) => `<option value="${escapeAttr(file.path)}" ${file.path === state.selectedPackageJson ? 'selected' : ''}>${escapeHtml(file.label)}</option>`).join('')}
          </select>
        </label>

        <div class="segments" role="group" aria-label="Dependency type">
          ${segment('all', 'All')}
          ${segment('dependencies', `dependencies ${counts.dependencies}`)}
          ${segment('devDependencies', `dev ${counts.devDependencies}`)}
        </div>

        <div class="segments riskSegments" role="group" aria-label="Risk">
          ${riskSegment('all', 'All risk')}
          ${riskSegment('vulnerable', 'Vulnerable')}
          ${riskSegment('deprecated', 'Deprecated')}
          ${riskSegment('notChecked', 'Not checked')}
          ${riskSegment('ok', 'OK')}
        </div>

        <label class="field">
          <span>Search packages</span>
          <input id="searchInput" type="search" value="${escapeAttr(state.searchQuery || '')}" placeholder="Package name">
        </label>

        ${renderLockSummary(state.lockInfo)}
      </section>

      <section id="dependencyTable">
        ${state.message ? `<p class="empty">${escapeHtml(state.message)}</p>` : renderDependencyTable(getVisibleDependencies())}
      </section>
    `;

    const packageSelect = document.getElementById('packageSelect');
    if (packageSelect) {
      packageSelect.addEventListener('change', (event) => {
        vscode.postMessage({ type: 'selectPackageJson', path: event.target.value });
      });
    }

    document.querySelectorAll('[data-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'setFilter', filter: button.dataset.filter });
      });
    });

    document.querySelectorAll('[data-risk-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        state.riskFilter = button.dataset.riskFilter;
        updateRiskSegments();
        updateDependencyTable();
        vscode.postMessage({ type: 'setRiskFilter', filter: button.dataset.riskFilter });
      });
    });

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      let searchTimer;
      searchInput.addEventListener('input', (event) => {
        state.searchQuery = event.target.value;
        updateDependencyTable();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          vscode.postMessage({ type: 'setSearchQuery', query: event.target.value });
        }, 300);
      });
    }

    bindPackageButtons();
  }

  function updateDependencyTable() {
    const dependencyTable = document.getElementById('dependencyTable');
    if (!dependencyTable) {
      return;
    }

    dependencyTable.innerHTML = renderDependencyTable(getVisibleDependencies());
    bindPackageButtons();
  }

  function bindPackageButtons() {
    document.querySelectorAll('[data-package]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'openPackage', name: button.dataset.package });
      });
    });
  }

  function getVisibleDependencies() {
    const query = String(state.searchQuery || '').trim().toLowerCase();
    const riskFiltered = filterByRisk(state.dependencies, state.riskFilter);
    if (!query) {
      return riskFiltered;
    }

    return riskFiltered.filter((dependency) => {
      return dependency.name.toLowerCase().includes(query) || String(dependency.description || '').toLowerCase().includes(query);
    });
  }

  function filterByRisk(dependencies, riskFilter) {
    if (!riskFilter || riskFilter === 'all') {
      return dependencies;
    }

    return dependencies.filter((dependency) => {
      if (riskFilter === 'vulnerable') {
        return dependency.auditStatus === 'vulnerable';
      }
      if (riskFilter === 'deprecated') {
        return dependency.deprecated;
      }
      if (riskFilter === 'notChecked') {
        return dependency.auditStatus === 'unknown';
      }
      if (riskFilter === 'ok') {
        return !dependency.deprecated && dependency.auditStatus !== 'vulnerable' && dependency.auditStatus !== 'unknown';
      }
      return true;
    });
  }

  function renderDependencyTable(dependencies) {
    if (!dependencies.length) {
      return '<p class="empty">No packages match this filter or search.</p>';
    }

    return `
      <div class="list">
        <div class="row head">
          <span>Package</span>
          <span>Type</span>
          <span>Current</span>
          <span>Lock</span>
          <span>Current published</span>
          <span>Latest</span>
          <span>Latest published</span>
          <span>Update</span>
          <span>Risk</span>
        </div>
        ${dependencies.map((dependency) => `
          <div class="row ${getUpdateRowClass(dependency)}">
            <button class="name ${dependency.status}" data-package="${escapeAttr(dependency.name)}" title="${escapeAttr(dependency.description || dependency.name)}">
              ${escapeHtml(dependency.name)}
            </button>
            <span class="pill">${dependency.type === 'dependencies' ? 'dep' : 'dev'}</span>
            <span class="version">${escapeHtml(dependency.currentVersion)}</span>
            <span class="lockCell">${renderLockBadge(dependency)}</span>
            <span class="version">${renderDate(dependency.resolvedPublishedAt)}</span>
            <span class="version">${escapeHtml(dependency.latestVersion || '-')}</span>
            <span class="version">${renderDate(dependency.latestPublishedAt)}</span>
            <span class="update">${renderUpdate(dependency)}</span>
            <span class="risk">${renderRisk(dependency)}</span>
          </div>
        `).join('')}
      </div>
    `;
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
              <code class="installCommand">npm i ${escapeHtml(detail.name)}</code>
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

            <section class="sideSection">
              <h2>Lockfile</h2>
              <dl class="facts">
                <div><dt>Status</dt><dd>${renderLockBadge(detail)}</dd></div>
                ${detail.lockInfo && detail.lockInfo.label ? `<div><dt>File</dt><dd>${escapeHtml(detail.lockInfo.label)}</dd></div>` : ''}
                ${detail.lockInfo && detail.lockInfo.lockfileVersion ? `<div><dt>lockfileVersion</dt><dd>${escapeHtml(detail.lockInfo.lockfileVersion)}</dd></div>` : ''}
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
    bindReadmeLinks();
  }

  function bindReadmeLinks() {
    const readme = document.querySelector('.readme');
    if (!readme) {
      return;
    }

    readme.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link || !readme.contains(link)) {
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
      return '';
    }
    return '';
  }

  function renderLoading(message) {
    app.innerHTML = `<div class="center"><div class="spinner"></div><p>${escapeHtml(message || 'Loading...')}</p></div>`;
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

  function updateRiskSegments() {
    document.querySelectorAll('[data-risk-filter]').forEach((button) => {
      button.classList.toggle('active', button.dataset.riskFilter === state.riskFilter);
    });
  }

  function renderLockSummary(lockInfo) {
    if (!lockInfo) {
      return '';
    }
    if (lockInfo.error) {
      return `<div class="lockSummary warning"><span>package-lock</span><strong>Could not read lockfile</strong><small>${escapeHtml(lockInfo.error)}</small></div>`;
    }
    if (!lockInfo.exists) {
      return '<div class="lockSummary warning"><span>package-lock</span><strong>Not found</strong><small>Resolved versions and vulnerability checks may be less accurate.</small></div>';
    }

    const version = lockInfo.lockfileVersion ? `v${escapeHtml(lockInfo.lockfileVersion)}` : 'version unknown';
    return `
      <div class="lockSummary">
        <span>package-lock</span>
        <strong>${escapeHtml(lockInfo.label || 'package-lock.json')}</strong>
        <small>${version} &middot; ${formatNumber(lockInfo.packageCount)} locked packages</small>
      </div>
    `;
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
    if (dependency.auditStatus === 'unknown') {
      badges.push('<span class="badge unknown">not checked</span>');
    }
    return badges.length ? badges.join('') : '<span class="badge ok">ok</span>';
  }

  function renderLockBadge(dependency) {
    if (dependency.lockStatus === 'locked') {
      return `<span class="lockBadge locked" title="${escapeAttr(dependency.lockPath || 'Locked in package-lock.json')}">locked</span>`;
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
    return flags.length ? `<div><dt>Flags</dt><dd>${flags.map((flag) => `<span class="lockFlag">${escapeHtml(flag)}</span>`).join('')}</dd></div>` : '';
  }

  function renderNpmMetadata(detail) {
    const distTags = Object.entries(detail.distTags || {});
    const maintainers = detail.maintainers || [];
    const keywords = detail.keywords || [];

    return `
      <section class="sideSection npmMetadata">
        <h2>npm Metadata</h2>
        <dl class="facts">
          ${detail.publisher ? `<div><dt>Publisher</dt><dd>${escapeHtml(detail.publisher)}</dd></div>` : ''}
          ${detail.author ? `<div><dt>Author</dt><dd>${escapeHtml(detail.author)}</dd></div>` : ''}
          ${maintainers.length ? `<div><dt>Maintainers</dt><dd>${maintainers.slice(0, 6).map((person) => `<span class="metadataChip">${escapeHtml(person)}</span>`).join('')}${maintainers.length > 6 ? `<small>+${maintainers.length - 6} more</small>` : ''}</dd></div>` : ''}
          ${detail.createdAt ? `<div><dt>Created</dt><dd>${renderDate(detail.createdAt)}</dd></div>` : ''}
          ${detail.modifiedAt ? `<div><dt>Modified</dt><dd>${renderDate(detail.modifiedAt)}</dd></div>` : ''}
          ${Number.isFinite(detail.versionCount) ? `<div><dt>Versions</dt><dd>${formatNumber(detail.versionCount)}</dd></div>` : ''}
          ${distTags.length ? `<div><dt>Dist tags</dt><dd>${distTags.map(([tag, version]) => `<span class="metadataChip tag"><strong>${escapeHtml(tag)}</strong> ${escapeHtml(version)}</span>`).join('')}</dd></div>` : ''}
          ${keywords.length ? `<div><dt>Keywords</dt><dd>${keywords.slice(0, 12).map((keyword) => `<span class="metadataChip">${escapeHtml(keyword)}</span>`).join('')}${keywords.length > 12 ? `<small>+${keywords.length - 12} more</small>` : ''}</dd></div>` : ''}
        </dl>
      </section>
    `;
  }

  function renderUpdate(dependency) {
    const type = dependency.updateType || (dependency.status === 'update' ? 'unknown' : 'current');
    const label = dependency.updateLabel || type;
    return `<span class="updateBadge ${escapeAttr(type)}">${escapeHtml(label)}</span>`;
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

  function shortenUrl(value) {
    try {
      const url = new URL(value);
      return `${url.host}${url.pathname}`;
    } catch (error) {
      return value;
    }
  }

  function renderSecurity(detail) {
    const vulnerabilities = detail.vulnerabilities || [];
    if (!detail.deprecated && !vulnerabilities.length && detail.auditStatus !== 'unknown') {
      return '<section class="sideSection security okPanel"><h2>Security</h2><p>No deprecation or known vulnerabilities found for the resolved version.</p></section>';
    }

    return `
      <section class="sideSection security">
        <h2>Security</h2>
        ${detail.deprecated ? `<div class="notice deprecatedNotice"><strong>Deprecated</strong><p>${escapeHtml(detail.deprecatedMessage || 'This package version is deprecated.')}</p></div>` : ''}
        ${detail.auditStatus === 'unknown' ? `<div class="notice unknownNotice"><strong>Vulnerabilities not checked</strong><p>${escapeHtml(detail.auditError || 'A resolved version was not available. Add or update package-lock.json for more accurate audit results.')}</p></div>` : ''}
        ${vulnerabilities.length ? `
          <div class="advisories">
            ${vulnerabilities.map((advisory) => `
              <article class="advisory ${escapeAttr(advisory.severity || 'unknown')}">
                <div>
                  <strong>${escapeHtml(advisory.title)}</strong>
                  <span>${escapeHtml(advisory.severity || 'unknown')}</span>
                </div>
                ${advisory.vulnerableVersions ? `<p>Vulnerable: ${escapeHtml(advisory.vulnerableVersions)}</p>` : ''}
                ${advisory.patchedVersions ? `<p>Patched: ${escapeHtml(advisory.patchedVersions)}</p>` : ''}
                ${advisory.url ? `<a href="${escapeAttr(advisory.url)}">Advisory</a>` : ''}
              </article>
            `).join('')}
          </div>
        ` : ''}
      </section>
    `;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  vscode.postMessage({ type: 'ready' });
}());
