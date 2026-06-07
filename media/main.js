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
            <div class="readme">${markdownToHtml(detail.readme)}</div>
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
                ${detail.license ? `<div><dt>License</dt><dd>${escapeHtml(detail.license)}</dd></div>` : ''}
              </dl>
            </section>

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

  function markdownToHtml(markdown) {
    const source = String(markdown || '').replace(/\r\n?/g, '\n');
    const references = collectMarkdownReferences(source);
    const lines = source.split('\n');
    const html = [];
    let paragraph = [];
    let list = null;
    let blockquote = [];
    let inCode = false;
    let codeLanguage = '';
    let codeLines = [];
    let htmlCenter = false;

    function flushParagraph() {
      if (!paragraph.length) {
        return;
      }
      html.push(`<p>${renderInline(paragraph.join(' '), references)}</p>`);
      paragraph = [];
    }

    function flushList() {
      if (!list) {
        return;
      }
      html.push(`<${list.type}>${list.items.map((item) => `<li>${renderInline(item, references)}</li>`).join('')}</${list.type}>`);
      list = null;
    }

    function flushBlockquote() {
      if (!blockquote.length) {
        return;
      }
      html.push(`<blockquote>${blockquote.map((line) => `<p>${renderInline(line, references)}</p>`).join('')}</blockquote>`);
      blockquote = [];
    }

    function flushOpenBlocks() {
      flushParagraph();
      flushList();
      flushBlockquote();
    }

    lines.forEach((line) => {
      if (isReferenceDefinitionLine(line)) {
        return;
      }

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

      const opensCenteredHtml = /<(div|p)\b[^>]*align=["']?center["']?[^>]*>/i.test(line);
      const closesCenteredHtml = /<\/(div|p)>/i.test(line);
      const htmlSnippet = renderAllowedHtmlSnippet(line, htmlCenter || opensCenteredHtml, references);
      if (htmlSnippet !== null) {
        flushOpenBlocks();
        if (htmlSnippet) {
          html.push(htmlSnippet);
        }
        if (opensCenteredHtml) {
          htmlCenter = true;
        }
        if (closesCenteredHtml) {
          htmlCenter = false;
        }
        return;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushOpenBlocks();
        const level = Math.min(heading[1].length, 3);
        html.push(`<h${level}>${renderInline(heading[2].replace(/\s+#+$/, ''), references)}</h${level}>`);
        return;
      }

      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
        return;
      }

      if (/^\|(.+)\|\s*$/.test(line) && html.length && html[html.length - 1].startsWith('<table')) {
        appendTableRow(html, line, references);
        return;
      }

      if (/^\|(.+)\|\s*$/.test(line)) {
        flushOpenBlocks();
        html.push(startTable(line, references));
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

  function startTable(line, references) {
    const cells = splitTableCells(line);
    return `<table><thead><tr>${cells.map((cell) => `<th>${renderInline(cell, references)}</th>`).join('')}</tr></thead><tbody></tbody></table>`;
  }

  function appendTableRow(html, line, references) {
    const cells = splitTableCells(line);
    const row = `<tr>${cells.map((cell) => `<td>${renderInline(cell, references)}</td>`).join('')}</tr>`;
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

  function renderAllowedHtmlSnippet(line, forceCentered, references) {
    if (!/<\/?[a-z][\s\S]*>/i.test(line)) {
      return null;
    }

    const images = [...line.matchAll(/<img\b([^>]*)>/gi)]
      .map((match) => renderHtmlImage(match[1]))
      .filter(Boolean);
    const breaks = (line.match(/<br\s*\/?>/gi) || []).map(() => '<br>');
    const text = stripAllowedHtml(line).trim();
    const content = [...images, ...breaks, text ? renderInline(text, references) : ''].filter(Boolean).join('');

    if (!content) {
      return '';
    }

    return forceCentered ? `<div class="htmlMedia centerMedia">${content}</div>` : `<div class="htmlMedia">${content}</div>`;
  }

  function renderHtmlImage(attributes) {
    const src = getHtmlAttribute(attributes, 'src');
    if (!src || !/^https:\/\//i.test(src)) {
      return '';
    }

    const alt = getHtmlAttribute(attributes, 'alt');
    const width = getHtmlAttribute(attributes, 'width');
    const widthAttr = /^\d{1,4}$/.test(width) ? ` width="${escapeAttr(width)}"` : '';
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${widthAttr}>`;
  }

  function getHtmlAttribute(attributes, name) {
    const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = attributes.match(pattern);
    return match ? (match[2] || match[3] || match[4] || '') : '';
  }

  function stripAllowedHtml(value) {
    return value
      .replace(/<img\b[^>]*>/gi, '')
      .replace(/<source\b[^>]*>/gi, '')
      .replace(/<\/?(div|picture|p|span|br|a|strong|em|b|i|code)\b[^>]*>/gi, '')
      .replace(/<\/?[a-z][^>]*>/gi, '');
  }

  function collectMarkdownReferences(source) {
    const references = {};
    const pattern = /(?:^|\s)\[([^\]]+)\]:\s*(\S+)/gm;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      references[normalizeReferenceId(match[1])] = match[2];
    }
    return references;
  }

  function isReferenceDefinitionLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) {
      return false;
    }
    return trimmed.replace(/\[[^\]]+\]:\s*\S+\s*/g, '').trim() === '';
  }

  function normalizeReferenceId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function renderInline(value, references) {
    let output = escapeHtml(value);
    const codeSpans = [];

    output = output.replace(/`([^`]+)`/g, (match, code) => {
      const token = `@@CODE${codeSpans.length}@@`;
      codeSpans.push(`<code>${code}</code>`);
      return token;
    });

    output = output
      .replace(/\[!\[([^\]]*)\]\[([^\]]+)\]\]\[([^\]]+)\]/g, (match, alt, imageRef, linkRef) => {
        const imageUrl = references && references[normalizeReferenceId(imageRef)];
        const linkUrl = references && references[normalizeReferenceId(linkRef)];
        if (!isSafeImageUrl(imageUrl)) {
          return match;
        }
        const image = `<img class="badgeImage" src="${escapeAttr(imageUrl)}" alt="${escapeAttr(alt)}">`;
        return isSafeLinkUrl(linkUrl) ? `<a class="badgeLink" href="${escapeAttr(linkUrl)}">${image}</a>` : image;
      })
      .replace(/!\[([^\]]*)\]\[([^\]]+)\]/g, (match, alt, imageRef) => {
        const imageUrl = references && references[normalizeReferenceId(imageRef)];
        return isSafeImageUrl(imageUrl) ? `<img class="badgeImage" src="${escapeAttr(imageUrl)}" alt="${escapeAttr(alt)}">` : match;
      })
      .replace(/\[([^\]]+)\]\[([^\]]+)\]/g, (match, label, linkRef) => {
        const linkUrl = references && references[normalizeReferenceId(linkRef)];
        return isSafeLinkUrl(linkUrl) ? `<a href="${escapeAttr(linkUrl)}">${label}</a>` : match;
      })
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

  function isSafeImageUrl(value) {
    return /^https:\/\//i.test(value || '') || /^data:image\//i.test(value || '');
  }

  function isSafeLinkUrl(value) {
    return /^https:\/\//i.test(value || '');
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
