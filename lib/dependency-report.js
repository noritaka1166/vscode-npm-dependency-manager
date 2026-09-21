const REPORT_COLUMNS = [
  'Package',
  'Dependency type',
  'Requested version',
  'Resolved version',
  'Latest version',
  'License',
  'Lock status',
  'Update type',
  'Audit status',
  'Direct vulnerabilities',
  'Transitive vulnerabilities',
  'Maximum severity',
  'CISA KEV',
  'KEV CVEs',
  'KEV added dates',
  'KEV due dates',
  'KEV ransomware use',
  'CISA SSVC available',
  'SSVC CVEs',
  'SSVC exploitation',
  'SSVC automatable',
  'SSVC technical impact',
  'SSVC version',
  'Deprecated',
  'Lock path',
  'Resolved URL',
  'Description'
];
const FORMULA_PROTECTED_COLUMNS = new Set([
  'License',
  'KEV CVEs',
  'KEV added dates',
  'KEV due dates',
  'KEV ransomware use',
  'SSVC CVEs',
  'SSVC exploitation',
  'SSVC automatable',
  'SSVC technical impact',
  'SSVC version',
  'Resolved URL',
  'Description'
]);

function createDependencyReportCsv(dependencies) {
  const header = REPORT_COLUMNS.map((column) => escapeCsvCell(column)).join(',');
  const records = (Array.isArray(dependencies) ? dependencies : []).map(createDependencyRow);
  const body = records.map((row) => row.map((value, index) => {
    return escapeCsvCell(value, FORMULA_PROTECTED_COLUMNS.has(REPORT_COLUMNS[index]));
  }).join(','));
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

function createDependencyRow(dependency) {
  const source = dependency && typeof dependency === 'object' ? dependency : {};
  return [
    source.name,
    source.type,
    source.currentVersion,
    source.resolvedVersion,
    source.latestVersion,
    source.license,
    source.lockStatus,
    source.updateType,
    source.auditStatus,
    getDirectVulnerabilityCount(source),
    source.transitiveVulnerabilityCount || 0,
    source.maxSeverity,
    hasKev(source) ? 'Yes' : 'No',
    getKevField(source, 'cve'),
    getKevField(source, 'dateAdded'),
    getKevField(source, 'dueDate'),
    getKevField(source, 'knownRansomwareCampaignUse'),
    hasSsvc(source) ? 'Yes' : 'No',
    getSsvcField(source, 'cve'),
    getSsvcField(source, 'exploitation'),
    getSsvcField(source, 'automatable'),
    getSsvcField(source, 'technicalImpact'),
    getSsvcField(source, 'version'),
    source.deprecated ? 'Yes' : 'No',
    source.lockPath,
    source.lockResolved,
    source.description
  ];
}

function hasKev(dependency) {
  return Array.isArray(dependency.securitySignals?.kev) && dependency.securitySignals.kev.length > 0;
}

function getKevField(dependency, field) {
  if (!hasKev(dependency)) {
    return '';
  }

  return [...new Set(dependency.securitySignals.kev
    .map((entry) => entry?.[field])
    .filter(Boolean))].join('; ');
}

function hasSsvc(dependency) {
  return Array.isArray(dependency.securitySignals?.ssvc) && dependency.securitySignals.ssvc.length > 0;
}

function getSsvcField(dependency, field) {
  if (!hasSsvc(dependency)) {
    return '';
  }

  return [...new Set(dependency.securitySignals.ssvc
    .map((entry) => entry?.[field])
    .filter(Boolean))].join('; ');
}

function getDirectVulnerabilityCount(dependency) {
  return (dependency.vulnerabilities || []).length + (dependency.osvVulnerabilities || []).length;
}

function escapeCsvCell(value, protectFormula = false) {
  let cell = value === undefined || value === null ? '' : String(value);
  if (protectFormula && /^[=+\-@]/.test(cell)) {
    cell = `\u200B${cell}`;
  }
  return `"${cell.replaceAll('"', '""')}"`;
}

module.exports = {
  createDependencyReportCsv
};
