function normalizeRepositoryUrl(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url;
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const isHostedShorthand = /^(?:github|gitlab|bitbucket):/i.test(value.trim());
  if (isHostedShorthand && !/^(?:github|gitlab|bitbucket):[^/]+\/.+/i.test(value.trim())) {
    return '';
  }

  let normalized = value.trim()
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/i, 'https://github.com/')
    .replace(/^gitlab:/i, 'https://gitlab.com/')
    .replace(/^bitbucket:/i, 'https://bitbucket.org/');

  normalized = normalized
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i, 'https://$1/$2');

  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }

    url.pathname = url.pathname.replace(/\.git$/i, '');
    return url.href;
  } catch {
    return '';
  }
}

module.exports = { normalizeRepositoryUrl };
