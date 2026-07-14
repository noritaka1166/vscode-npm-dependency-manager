const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRepositoryUrl } = require('../lib/repository');

test('npm の一般的な repository URL を外部ブラウザ用の HTTPS URL に正規化できる', () => {
  const cases = [
    ['https://github.com/npm/cli.git', 'https://github.com/npm/cli'],
    ['git+https://github.com/npm/cli.git', 'https://github.com/npm/cli'],
    ['git://github.com/npm/cli.git', 'https://github.com/npm/cli'],
    ['git@github.com:npm/cli.git', 'https://github.com/npm/cli'],
    ['git+ssh://git@github.com/npm/cli.git', 'https://github.com/npm/cli'],
    ['github:npm/cli', 'https://github.com/npm/cli'],
    [{ url: 'gitlab:gitlab-org/gitlab.git' }, 'https://gitlab.com/gitlab-org/gitlab']
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeRepositoryUrl(input), expected);
  }
});

test('ブラウザで開けない repository URL は除外する', () => {
  assert.equal(normalizeRepositoryUrl('github:npm'), '');
  assert.equal(normalizeRepositoryUrl('file:../private-repository'), '');
  assert.equal(normalizeRepositoryUrl(undefined), '');
});
