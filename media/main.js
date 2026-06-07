(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = {
    packageFiles: [],
    selectedPackageJson: '',
    filter: 'all',
    dependencyCounts: {
      dependencies: 0,
      devDependencies: 0
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

      </section>

      ${state.message ? `<p class="empty">${escapeHtml(state.message)}</p>` : renderDependencyTable(state.dependencies)}
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

    document.querySelectorAll('[data-package]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'openPackage', name: button.dataset.package });
      });
    });
  }

  function renderDependencyTable(dependencies) {
    if (!dependencies.length) {
      return '<p class="empty">No dependencies match this filter.</p>';
    }

    return `
      <div class="list">
        <div class="row head">
          <span>Package</span>
          <span>Type</span>
          <span>Current</span>
          <span>Current published</span>
          <span>Latest</span>
          <span>Latest published</span>
          <span>Risk</span>
        </div>
        ${dependencies.map((dependency) => `
          <div class="row">
            <button class="name ${dependency.status}" data-package="${escapeAttr(dependency.name)}" title="${escapeAttr(dependency.description || dependency.name)}">
              ${escapeHtml(dependency.name)}
            </button>
            <span class="pill">${dependency.type === 'dependencies' ? 'dep' : 'dev'}</span>
            <span class="version">${escapeHtml(dependency.currentVersion)}</span>
            <span class="version">${renderDate(dependency.resolvedPublishedAt)}</span>
            <span class="version">${escapeHtml(dependency.latestVersion || '-')}</span>
            <span class="version">${renderDate(dependency.latestPublishedAt)}</span>
            <span class="risk">${renderRisk(dependency)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderDetail(detail) {
    app.innerHTML = `
      <section class="detailTop">
        <button id="backButton" class="iconButton" title="Back">‹</button>
        <div>
          <h1>${escapeHtml(detail.name)}</h1>
          <p>${escapeHtml(detail.description || '')}</p>
        </div>
      </section>

      <section class="meta">
        ${detail.resolvedVersion ? `<div><span>Resolved</span><strong>${escapeHtml(detail.resolvedVersion)}</strong></div>` : ''}
        <div><span>Resolved published</span><strong>${renderDate(detail.resolvedPublishedAt)}</strong></div>
        <div><span>Latest</span><strong>${escapeHtml(detail.latestVersion || '-')}</strong></div>
        <div><span>Latest published</span><strong>${renderDate(detail.latestPublishedAt)}</strong></div>
        ${detail.license ? `<div><span>License</span><strong>${escapeHtml(detail.license)}</strong></div>` : ''}
      </section>

      ${renderSecurity(detail)}

      <section class="links">
        <a href="${escapeAttr(detail.npmUrl)}">npm</a>
        ${detail.homepage ? `<a href="${escapeAttr(detail.homepage)}">Homepage</a>` : ''}
        ${detail.repository ? `<a href="${escapeAttr(detail.repository)}">Repository</a>` : ''}
      </section>

      <article class="readme">${markdownToHtml(detail.readme)}</article>
    `;

    document.getElementById('backButton').addEventListener('click', () => {
      vscode.postMessage({ type: 'backToList' });
    });
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

  function renderSecurity(detail) {
    const vulnerabilities = detail.vulnerabilities || [];
    if (!detail.deprecated && !vulnerabilities.length && detail.auditStatus !== 'unknown') {
      return '<section class="security okPanel"><h2>Security</h2><p>No deprecation or known vulnerabilities found for the resolved version.</p></section>';
    }

    return `
      <section class="security">
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

  function markdownToHtml(markdown) {
    const source = String(markdown || '').replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const html = [];
    let paragraph = [];
    let list = null;
    let blockquote = [];
    let inCode = false;
    let codeLanguage = '';
    let codeLines = [];

    function flushParagraph() {
      if (!paragraph.length) {
        return;
      }
      html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }

    function flushList() {
      if (!list) {
        return;
      }
      html.push(`<${list.type}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${list.type}>`);
      list = null;
    }

    function flushBlockquote() {
      if (!blockquote.length) {
        return;
      }
      html.push(`<blockquote>${blockquote.map((line) => `<p>${renderInline(line)}</p>`).join('')}</blockquote>`);
      blockquote = [];
    }

    function flushOpenBlocks() {
      flushParagraph();
      flushList();
      flushBlockquote();
    }

    lines.forEach((line) => {
      const fenceMatch = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
      if (fenceMatch) {
        if (inCode) {
          html.push(`<pre><code${codeLanguage ? ` class="language-${escapeAttr(codeLanguage)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
          inCode = false;
          codeLanguage = '';
          codeLines = [];
          return;
        }

        flushOpenBlocks();
        inCode = true;
        codeLanguage = fenceMatch[1] || '';
        return;
      }

      if (inCode) {
        codeLines.push(line);
        return;
      }

      if (!line.trim()) {
        flushOpenBlocks();
        return;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushOpenBlocks();
        const level = Math.min(heading[1].length, 3);
        html.push(`<h${level}>${renderInline(heading[2].replace(/\s+#+$/, ''))}</h${level}>`);
        return;
      }

      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
        return;
      }

      if (/^\|(.+)\|\s*$/.test(line) && html.length && html[html.length - 1].startsWith('<table')) {
        appendTableRow(html, line);
        return;
      }

      if (/^\|(.+)\|\s*$/.test(line)) {
        flushOpenBlocks();
        html.push(startTable(line));
        return;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        blockquote.push(quote[1]);
        return;
      }

      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        flushBlockquote();
        const type = ordered ? 'ol' : 'ul';
        if (!list || list.type !== type) {
          flushList();
          list = { type, items: [] };
        }
        list.items.push((unordered || ordered)[1]);
        return;
      }

      flushList();
      flushBlockquote();
      paragraph.push(line.trim());
    });

    if (inCode) {
      html.push(`<pre><code${codeLanguage ? ` class="language-${escapeAttr(codeLanguage)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    }
    flushOpenBlocks();

    return html.join('');
  }

  function startTable(line) {
    const cells = splitTableCells(line);
    return `<table><thead><tr>${cells.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody></tbody></table>`;
  }

  function appendTableRow(html, line) {
    const cells = splitTableCells(line);
    const row = `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`;
    html[html.length - 1] = html[html.length - 1].replace('</tbody>', `${row}</tbody>`);
  }

  function splitTableCells(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  function renderInline(value) {
    let output = escapeHtml(value);
    const codeSpans = [];

    output = output.replace(/`([^`]+)`/g, (match, code) => {
      const token = `@@CODE${codeSpans.length}@@`;
      codeSpans.push(`<code>${code}</code>`);
      return token;
    });

    output = output
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/_([^_\n]+)_/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    codeSpans.forEach((code, index) => {
      output = output.replace(`@@CODE${index}@@`, code);
    });

    return output;
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
