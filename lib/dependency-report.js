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
  'Deprecated',
  'Lock path',
  'Resolved URL',
  'Description'
];
const FORMULA_PROTECTED_COLUMNS = new Set(['License', 'Resolved URL', 'Description']);

function createDependencyReportCsv(dependencies) {
  const header = REPORT_COLUMNS.map(escapeCsvCell).join(',');
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
    source.deprecated ? 'Yes' : 'No',
    source.lockPath,
    source.lockResolved,
    source.description
  ];
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
  REPORT_COLUMNS,
  createDependencyReportCsv,
  escapeCsvCell
};
