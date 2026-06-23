const REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const AUDIT_BULK_URL = `${REGISTRY_BASE_URL}/-/npm/v1/security/advisories/bulk`;
const OSV_QUERY_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns';
const EPSS_API_URL = 'https://api.first.org/data/v1/epss';
const CISA_KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

class SecurityService {
  constructor() {
    this.auditCache = new Map();
    this.osvCache = new Map();
    this.osvDetailCache = new Map();
    this.epssCache = new Map();
    this.kevCatalogCache = undefined;
  }

  clear() {
    this.auditCache.clear();
    this.osvCache.clear();
    this.osvDetailCache.clear();
    this.epssCache.clear();
    this.kevCatalogCache = undefined;
  }

  clearPackage() {
    this.clear();
  }

  getCacheStats() {
    return {
      audit: this.auditCache.size,
      osv: this.osvCache.size,
      epss: this.epssCache.size,
      kev: this.kevCatalogCache ? this.kevCatalogCache.size : 0
    };
  }

  async enrichDependencies(dependencies, lockInfo) {
    const auditInput = {};
    dependencies.forEach((dependency) => {
      if (!dependency.resolvedVersion) {
        applyUnknownSecurityState(dependency);
        return;
      }

      if (!auditInput[dependency.name]) {
        auditInput[dependency.name] = [];
      }
      auditInput[dependency.name].push(dependency.resolvedVersion);
    });

    const auditResult = await this.getAuditAdvisories(auditInput);
    const lockAuditResult = lockInfo.exists ? await this.getAuditAdvisories(getLockAuditInput(lockInfo)) : new Map();
    const osvResult = await this.getOsvVulnerabilitiesForDependencies(dependencies);
    const lockOsvResult = lockInfo.exists ? await this.getOsvVulnerabilitiesForLock(lockInfo) : new Map();
    const threatIntel = await this.getThreatIntelForCves(collectCvesFromSecurityResults(auditResult, osvResult, lockAuditResult, lockOsvResult));

    dependencies.forEach((dependency) => {
      if (!dependency.resolvedVersion) {
        return;
      }

      const directSecurity = normalizeDirectSecurityState(
        auditResult.get(dependency.name) || [],
        osvResult.get(getPackageVersionKey(dependency.name, dependency.resolvedVersion)) || []
      );
      dependency.vulnerabilities = directSecurity.vulnerabilities;
      dependency.osvVulnerabilities = directSecurity.osvVulnerabilities;
      dependency.auditStatus = directSecurity.auditStatus;
      dependency.auditError = directSecurity.auditError;
      dependency.transitiveVulnerabilities = getTransitiveVulnerabilities(lockInfo, dependency, lockAuditResult);
      dependency.transitiveOsvVulnerabilities = getTransitiveOsvVulnerabilities(lockInfo, dependency, lockOsvResult);
      dependency.transitiveVulnerabilityCount = dependency.transitiveVulnerabilities.length + dependency.transitiveOsvVulnerabilities.length;
      dependency.securitySignals = buildSecuritySignals(
        [...dependency.vulnerabilities, ...dependency.osvVulnerabilities, ...dependency.transitiveVulnerabilities, ...dependency.transitiveOsvVulnerabilities],
        threatIntel
      );
      dependency.maxSeverity = getMaxSeverity([...dependency.vulnerabilities, ...dependency.osvVulnerabilities]);
      dependency.transitiveMaxSeverity = getMaxSeverity([...dependency.transitiveVulnerabilities, ...dependency.transitiveOsvVulnerabilities]);
    });
  }

  async getPackageSecurity({ name, resolvedVersion, dependency, lockPackage, lockInfo }) {
    let vulnerabilities = dependency && dependency.vulnerabilities ? dependency.vulnerabilities : [];
    let auditStatus = dependency && dependency.auditStatus ? dependency.auditStatus : '';
    let auditError = dependency && dependency.auditError ? dependency.auditError : '';
    let transitiveVulnerabilities = dependency && dependency.transitiveVulnerabilities ? dependency.transitiveVulnerabilities : [];
    let osvVulnerabilities = dependency && dependency.osvVulnerabilities ? dependency.osvVulnerabilities : [];
    let transitiveOsvVulnerabilities = dependency && dependency.transitiveOsvVulnerabilities ? dependency.transitiveOsvVulnerabilities : [];

    if (!auditStatus && resolvedVersion) {
      const auditResult = await this.getAuditAdvisories({ [name]: [resolvedVersion] });
      const directSecurity = normalizeDirectSecurityState(auditResult.get(name) || [], osvVulnerabilities);
      vulnerabilities = directSecurity.vulnerabilities;
      auditStatus = directSecurity.auditStatus;
      auditError = directSecurity.auditError;
    }

    if (!auditStatus) {
      auditStatus = resolvedVersion ? 'ok' : 'unknown';
    }

    if (!osvVulnerabilities.length && resolvedVersion) {
      const osvResult = await this.getOsvVulnerabilities([{ name, version: resolvedVersion }]);
      osvVulnerabilities = osvResult.get(getPackageVersionKey(name, resolvedVersion)) || [];
    }

    if (!transitiveVulnerabilities.length && lockPackage && getLockPath(lockPackage) && lockInfo.exists) {
      const lockAuditResult = await this.getAuditAdvisories(getLockAuditInput(lockInfo));
      transitiveVulnerabilities = getTransitiveVulnerabilities(lockInfo, { lockPath: getLockPath(lockPackage) }, lockAuditResult);
    }

    if (!transitiveOsvVulnerabilities.length && lockPackage && getLockPath(lockPackage) && lockInfo.exists) {
      const lockOsvResult = await this.getOsvVulnerabilitiesForLock(lockInfo);
      transitiveOsvVulnerabilities = getTransitiveOsvVulnerabilities(lockInfo, { lockPath: getLockPath(lockPackage) }, lockOsvResult);
    }

    if (auditStatus === 'ok' && osvVulnerabilities.length) {
      auditStatus = 'vulnerable';
    }

    const advisories = [
      ...vulnerabilities,
      ...osvVulnerabilities,
      ...transitiveVulnerabilities,
      ...transitiveOsvVulnerabilities
    ];
    const threatIntel = await this.getThreatIntelForCves(collectCvesFromAdvisories(advisories));

    return {
      vulnerabilities,
      osvVulnerabilities,
      transitiveVulnerabilities,
      transitiveOsvVulnerabilities,
      transitiveVulnerabilityCount: transitiveVulnerabilities.length + transitiveOsvVulnerabilities.length,
      transitiveMaxSeverity: getMaxSeverity([...transitiveVulnerabilities, ...transitiveOsvVulnerabilities]),
      auditStatus,
      auditError,
      maxSeverity: dependency && dependency.maxSeverity ? dependency.maxSeverity : getMaxSeverity([...vulnerabilities, ...osvVulnerabilities]),
      securitySignals: buildSecuritySignals(advisories, threatIntel)
    };
  }

  async getAuditAdvisories(packageVersions) {
    const normalized = {};
    Object.entries(packageVersions).forEach(([name, versions]) => {
      const uniqueVersions = [...new Set(versions.filter(Boolean))];
      if (uniqueVersions.length) {
        normalized[name] = uniqueVersions;
      }
    });

    const cacheKey = JSON.stringify(normalized);
    if (this.auditCache.has(cacheKey)) {
      return this.auditCache.get(cacheKey);
    }

    const result = new Map();
    if (!Object.keys(normalized).length) {
      this.auditCache.set(cacheKey, result);
      return result;
    }

    try {
      const response = await fetch(AUDIT_BULK_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify(normalized)
      });

      if (!response.ok) {
        throw new Error(`npm audit returned ${response.status}`);
      }

      const data = await response.json();
      Object.entries(data || {}).forEach(([name, advisories]) => {
        result.set(name, Array.isArray(advisories) ? advisories.map(normalizeAdvisory) : []);
      });
    } catch (error) {
      Object.keys(normalized).forEach((name) => {
        result.set(name, [{
          title: getErrorMessage(error),
          severity: 'unknown',
          url: '',
          vulnerableVersions: '',
          auditError: true
        }]);
      });
    }

    this.auditCache.set(cacheKey, result);
    return result;
  }

  async getOsvVulnerabilitiesForDependencies(dependencies) {
    return this.getOsvVulnerabilities(
      dependencies
        .filter((dependency) => dependency.name && dependency.resolvedVersion)
        .map((dependency) => ({ name: dependency.name, version: dependency.resolvedVersion }))
    );
  }

  async getOsvVulnerabilitiesForLock(lockInfo) {
    if (!lockInfo || !lockInfo.paths) {
      return new Map();
    }

    const packages = [];
    lockInfo.paths.forEach((packageInfo) => {
      if (packageInfo.name && packageInfo.version) {
        packages.push({ name: packageInfo.name, version: packageInfo.version });
      }
    });

    return this.getOsvVulnerabilities(packages);
  }

  async getOsvVulnerabilities(packages) {
    const uniquePackages = [...new Map((packages || [])
      .filter((packageInfo) => packageInfo.name && packageInfo.version)
      .map((packageInfo) => [getPackageVersionKey(packageInfo.name, packageInfo.version), packageInfo])).values()];
    const result = new Map();
    const missing = [];

    uniquePackages.forEach((packageInfo) => {
      const key = getPackageVersionKey(packageInfo.name, packageInfo.version);
      if (this.osvCache.has(key)) {
        result.set(key, this.osvCache.get(key));
      } else {
        missing.push(packageInfo);
      }
    });

    for (const chunk of chunkArray(missing, 100)) {
      let data;
      try {
        const response = await fetch(OSV_QUERY_BATCH_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            queries: chunk.map((packageInfo) => ({
              package: {
                ecosystem: 'npm',
                name: packageInfo.name
              },
              version: packageInfo.version
            }))
          })
        });

        if (!response.ok) {
          throw new Error(`OSV returned ${response.status}`);
        }
        data = await response.json();
      } catch (error) {
        chunk.forEach((packageInfo) => {
          const key = getPackageVersionKey(packageInfo.name, packageInfo.version);
          this.osvCache.set(key, []);
          result.set(key, []);
        });
        continue;
      }

      await Promise.all(chunk.map(async (packageInfo, index) => {
        const key = getPackageVersionKey(packageInfo.name, packageInfo.version);
        const vulns = data && data.results && data.results[index] && Array.isArray(data.results[index].vulns) ? data.results[index].vulns : [];
        const detailed = await this.getOsvVulnerabilityDetails(vulns.map((vuln) => vuln.id).filter(Boolean));
        const normalized = detailed.map((vuln) => normalizeOsvVulnerability(vuln, packageInfo)).filter(Boolean);
        this.osvCache.set(key, normalized);
        result.set(key, normalized);
      }));
    }

    return result;
  }

  async getOsvVulnerabilityDetails(ids) {
    const uniqueIds = [...new Set(ids || [])];
    const details = [];

    await Promise.all(uniqueIds.map(async (id) => {
      if (this.osvDetailCache.has(id)) {
        details.push(this.osvDetailCache.get(id));
        return;
      }

      try {
        const response = await fetch(`${OSV_VULN_URL}/${encodeURIComponent(id)}`, {
          headers: { accept: 'application/json' }
        });
        if (!response.ok) {
          throw new Error(`OSV detail returned ${response.status}`);
        }
        const detail = await response.json();
        this.osvDetailCache.set(id, detail);
        details.push(detail);
      } catch (error) {
        this.osvDetailCache.set(id, null);
      }
    }));

    return details.filter(Boolean);
  }

  async getThreatIntelForCves(cves) {
    const uniqueCves = [...new Set((cves || []).filter(isCveId))];
    const epss = await this.getEpssScores(uniqueCves);
    const kev = await this.getKevCatalog();

    return {
      epss,
      kev
    };
  }

  async getEpssScores(cves) {
    const result = new Map();
    const missing = [];
    (cves || []).forEach((cve) => {
      if (this.epssCache.has(cve)) {
        result.set(cve, this.epssCache.get(cve));
      } else {
        missing.push(cve);
      }
    });

    for (const chunk of chunkArray(missing, 100)) {
      try {
        const url = `${EPSS_API_URL}?cve=${encodeURIComponent(chunk.join(','))}`;
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) {
          throw new Error(`EPSS returned ${response.status}`);
        }
        const data = await response.json();
        const rows = Array.isArray(data.data) ? data.data : [];
        const byCve = new Map(rows.map((row) => [row.cve, normalizeEpss(row)]));
        chunk.forEach((cve) => {
          const score = byCve.get(cve) || null;
          this.epssCache.set(cve, score);
          result.set(cve, score);
        });
      } catch (error) {
        chunk.forEach((cve) => {
          this.epssCache.set(cve, null);
          result.set(cve, null);
        });
      }
    }

    return result;
  }

  async getKevCatalog() {
    if (this.kevCatalogCache) {
      return this.kevCatalogCache;
    }

    const catalog = new Map();
    try {
      const response = await fetch(CISA_KEV_URL, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        throw new Error(`CISA KEV returned ${response.status}`);
      }
      const data = await response.json();
      (Array.isArray(data.vulnerabilities) ? data.vulnerabilities : []).forEach((entry) => {
        if (entry.cveID) {
          catalog.set(entry.cveID, normalizeKevEntry(entry));
        }
      });
    } catch (error) {
      // Keep the catalog empty when the feed cannot be reached.
    }

    this.kevCatalogCache = catalog;
    return catalog;
  }
}

function applyUnknownSecurityState(dependency) {
  dependency.auditStatus = 'unknown';
  dependency.vulnerabilities = [];
  dependency.osvVulnerabilities = [];
  dependency.transitiveVulnerabilities = [];
  dependency.transitiveOsvVulnerabilities = [];
  dependency.transitiveVulnerabilityCount = 0;
  dependency.securitySignals = { cves: [], kev: [], epss: [], maxEpss: null };
}

function normalizeDirectSecurityState(vulnerabilities, osvVulnerabilities) {
  let auditStatus = '';
  let auditError = '';
  let normalizedVulnerabilities = vulnerabilities;
  const auditUnknown = normalizedVulnerabilities.length && normalizedVulnerabilities.every((advisory) => advisory.auditError);

  if (auditUnknown) {
    auditStatus = 'unknown';
    auditError = normalizedVulnerabilities[0] && normalizedVulnerabilities[0].title;
    normalizedVulnerabilities = [];
  }

  return {
    vulnerabilities: normalizedVulnerabilities,
    osvVulnerabilities,
    auditStatus: auditUnknown && !osvVulnerabilities.length ? 'unknown' : (normalizedVulnerabilities.length || osvVulnerabilities.length ? 'vulnerable' : 'ok'),
    auditError
  };
}

function getLockAuditInput(lockInfo) {
  const input = {};
  if (!lockInfo || !lockInfo.paths) {
    return input;
  }

  lockInfo.paths.forEach((packageInfo) => {
    if (!packageInfo.name || !packageInfo.version) {
      return;
    }
    if (!input[packageInfo.name]) {
      input[packageInfo.name] = [];
    }
    input[packageInfo.name].push(packageInfo.version);
  });
  return input;
}

function getTransitiveVulnerabilities(lockInfo, dependency, auditResult) {
  if (!dependency.lockPath || !lockInfo || !lockInfo.paths || !auditResult) {
    return [];
  }

  const root = lockInfo.paths.get(dependency.lockPath);
  if (!root) {
    return [];
  }

  const vulnerabilities = [];
  const seenPaths = new Set();
  const seenAdvisories = new Set();
  collectTransitiveVulnerabilities(root, lockInfo, auditResult, vulnerabilities, seenPaths, seenAdvisories);
  return vulnerabilities;
}

function getTransitiveOsvVulnerabilities(lockInfo, dependency, osvResult) {
  if (!dependency.lockPath || !lockInfo || !lockInfo.paths || !osvResult) {
    return [];
  }

  const root = lockInfo.paths.get(dependency.lockPath);
  if (!root) {
    return [];
  }

  const vulnerabilities = [];
  const seenPaths = new Set();
  const seenAdvisories = new Set();
  collectTransitiveOsvVulnerabilities(root, lockInfo, osvResult, vulnerabilities, seenPaths, seenAdvisories);
  return vulnerabilities;
}

function collectTransitiveVulnerabilities(packageInfo, lockInfo, auditResult, vulnerabilities, seenPaths, seenAdvisories) {
  if (!packageInfo || seenPaths.has(packageInfo.path)) {
    return;
  }
  seenPaths.add(packageInfo.path);

  const dependencies = {
    ...(packageInfo.dependencies || {}),
    ...(packageInfo.optionalDependencies || {})
  };

  Object.keys(dependencies).forEach((dependencyName) => {
    const child = findLockChild(lockInfo, packageInfo.path, dependencyName);
    if (!child) {
      return;
    }

    const advisories = auditResult.get(child.name) || [];
    advisories.forEach((advisory) => {
      if (advisory.auditError) {
        return;
      }
      const key = `${child.path}:${advisory.title}:${advisory.severity}:${advisory.vulnerableVersions}`;
      if (seenAdvisories.has(key)) {
        return;
      }
      seenAdvisories.add(key);
      vulnerabilities.push({
        ...advisory,
        packageName: child.name,
        packageVersion: child.version,
        packagePath: child.path
      });
    });

    collectTransitiveVulnerabilities(child, lockInfo, auditResult, vulnerabilities, seenPaths, seenAdvisories);
  });
}

function collectTransitiveOsvVulnerabilities(packageInfo, lockInfo, osvResult, vulnerabilities, seenPaths, seenAdvisories) {
  if (!packageInfo || seenPaths.has(packageInfo.path)) {
    return;
  }
  seenPaths.add(packageInfo.path);

  const dependencies = {
    ...(packageInfo.dependencies || {}),
    ...(packageInfo.optionalDependencies || {})
  };

  Object.keys(dependencies).forEach((dependencyName) => {
    const child = findLockChild(lockInfo, packageInfo.path, dependencyName);
    if (!child) {
      return;
    }

    const advisories = osvResult.get(getPackageVersionKey(child.name, child.version)) || [];
    advisories.forEach((advisory) => {
      const key = `${child.path}:${advisory.id || advisory.title}`;
      if (seenAdvisories.has(key)) {
        return;
      }
      seenAdvisories.add(key);
      vulnerabilities.push({
        ...advisory,
        packageName: child.name,
        packageVersion: child.version,
        packagePath: child.path
      });
    });

    collectTransitiveOsvVulnerabilities(child, lockInfo, osvResult, vulnerabilities, seenPaths, seenAdvisories);
  });
}

function findLockChild(lockInfo, parentPath, dependencyName) {
  const nestedPath = `${parentPath}/node_modules/${dependencyName}`;
  if (lockInfo.paths.has(nestedPath)) {
    return lockInfo.paths.get(nestedPath);
  }

  const hoistedPath = `node_modules/${dependencyName}`;
  if (lockInfo.paths.has(hoistedPath)) {
    return lockInfo.paths.get(hoistedPath);
  }

  return lockInfo.packages.get(dependencyName);
}

function getLockPath(lockPackage) {
  return lockPackage.lockPath || lockPackage.path || '';
}

function getPackageVersionKey(name, version) {
  return `${name}@${version}`;
}

function normalizeAdvisory(advisory) {
  return {
    id: advisory.id || advisory.source || '',
    source: 'npm audit',
    title: advisory.title || advisory.name || 'Security advisory',
    severity: advisory.severity || 'unknown',
    url: advisory.url || advisory.source || '',
    vulnerableVersions: advisory.vulnerable_versions || advisory.vulnerableVersions || advisory.range || '',
    patchedVersions: advisory.patched_versions || advisory.patchedVersions || '',
    cves: normalizeCves(advisory.cves || advisory.cve || advisory.cwe || [])
  };
}

function normalizeOsvVulnerability(vulnerability, packageInfo) {
  if (!vulnerability || !vulnerability.id) {
    return null;
  }

  const cves = normalizeCves([...(vulnerability.aliases || []), vulnerability.id]);
  const affected = Array.isArray(vulnerability.affected) ? vulnerability.affected : [];
  const packageAffected = affected.find((entry) => {
    return entry && entry.package && entry.package.ecosystem === 'npm' && entry.package.name === packageInfo.name;
  }) || affected[0] || {};

  return {
    id: vulnerability.id,
    source: 'OSV',
    title: vulnerability.summary || vulnerability.id,
    severity: normalizeOsvSeverity(vulnerability),
    url: `https://osv.dev/vulnerability/${encodeURIComponent(vulnerability.id)}`,
    vulnerableVersions: getOsvAffectedRanges(packageAffected),
    patchedVersions: getOsvFixedVersions(packageAffected),
    aliases: vulnerability.aliases || [],
    cves,
    modified: vulnerability.modified || '',
    published: vulnerability.published || ''
  };
}

function normalizeOsvSeverity(vulnerability) {
  if (vulnerability.database_specific && vulnerability.database_specific.severity) {
    return String(vulnerability.database_specific.severity).toLowerCase();
  }

  const severity = Array.isArray(vulnerability.severity) ? vulnerability.severity[0] : undefined;
  if (severity && severity.score) {
    const score = Number.parseFloat(String(severity.score).split('/').at(-1));
    if (Number.isFinite(score)) {
      if (score >= 9) {
        return 'critical';
      }
      if (score >= 7) {
        return 'high';
      }
      if (score >= 4) {
        return 'moderate';
      }
      return 'low';
    }
  }

  return 'unknown';
}

function getOsvAffectedRanges(affected) {
  const ranges = Array.isArray(affected.ranges) ? affected.ranges : [];
  return ranges.map((range) => {
    const events = Array.isArray(range.events) ? range.events : [];
    return events.map((event) => {
      if (event.introduced) {
        return `>=${event.introduced}`;
      }
      if (event.fixed) {
        return `<${event.fixed}`;
      }
      if (event.last_affected) {
        return `<=${event.last_affected}`;
      }
      return '';
    }).filter(Boolean).join(' ');
  }).filter(Boolean).join(', ');
}

function getOsvFixedVersions(affected) {
  const ranges = Array.isArray(affected.ranges) ? affected.ranges : [];
  const fixed = [];
  ranges.forEach((range) => {
    (Array.isArray(range.events) ? range.events : []).forEach((event) => {
      if (event.fixed) {
        fixed.push(event.fixed);
      }
    });
  });
  return [...new Set(fixed)].join(', ');
}

function normalizeCves(values) {
  return [...new Set([values].flat(Infinity)
    .map((value) => String(value || '').toUpperCase().trim())
    .filter(isCveId))];
}

function isCveId(value) {
  return /^CVE-\d{4}-\d{4,}$/i.test(String(value || ''));
}

function normalizeEpss(row) {
  const score = Number.parseFloat(row.epss);
  const percentile = Number.parseFloat(row.percentile);
  return {
    cve: row.cve,
    epss: Number.isFinite(score) ? score : null,
    percentile: Number.isFinite(percentile) ? percentile : null,
    date: row.date || ''
  };
}

function normalizeKevEntry(entry) {
  return {
    cve: entry.cveID,
    vendorProject: entry.vendorProject || '',
    product: entry.product || '',
    vulnerabilityName: entry.vulnerabilityName || '',
    dateAdded: entry.dateAdded || '',
    dueDate: entry.dueDate || '',
    knownRansomwareCampaignUse: entry.knownRansomwareCampaignUse || '',
    requiredAction: entry.requiredAction || '',
    notes: entry.notes || ''
  };
}

function collectCvesFromSecurityResults(...results) {
  const cves = [];
  results.forEach((result) => {
    if (!result) {
      return;
    }
    result.forEach((advisories) => {
      cves.push(...collectCvesFromAdvisories(advisories));
    });
  });
  return [...new Set(cves)];
}

function collectCvesFromAdvisories(advisories) {
  const cves = [];
  (advisories || []).forEach((advisory) => {
    cves.push(...normalizeCves(advisory.cves || advisory.aliases || advisory.id || []));
  });
  return [...new Set(cves)];
}

function buildSecuritySignals(advisories, threatIntel) {
  const cves = collectCvesFromAdvisories(advisories);
  const kev = [];
  const epss = [];

  cves.forEach((cve) => {
    const kevEntry = threatIntel && threatIntel.kev ? threatIntel.kev.get(cve) : null;
    const epssEntry = threatIntel && threatIntel.epss ? threatIntel.epss.get(cve) : null;
    if (kevEntry) {
      kev.push(kevEntry);
    }
    if (epssEntry) {
      epss.push(epssEntry);
    }
  });

  epss.sort((a, b) => (b.epss || 0) - (a.epss || 0));

  return {
    cves,
    kev,
    epss,
    maxEpss: epss[0] || null
  };
}

function getMaxSeverity(vulnerabilities) {
  const order = ['info', 'low', 'moderate', 'high', 'critical'];
  return (vulnerabilities || []).reduce((max, vulnerability) => {
    const severity = vulnerability.severity || 'unknown';
    return order.indexOf(severity) > order.indexOf(max) ? severity : max;
  }, 'info');
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

module.exports = {
  SecurityService
};
