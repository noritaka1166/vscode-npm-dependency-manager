const DEFAULT_TIMEOUT_MS = 15000;
const { setMaxListeners } = require('node:events');

function isCancellation(error) {
  return error?.name === 'AbortError';
}

class NetworkClient {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this.controller = new AbortController();
    // One listener per active request; batch lookups can legitimately exceed ten.
    setMaxListeners(0, this.controller.signal);
  }

  cancel() {
    const error = new Error('Request cancelled');
    error.name = 'AbortError';
    this.controller.abort(error);
  }

  throwIfCancelled() {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
  }

  async request(url, options, consume) {
    this.throwIfCancelled();
    const controller = new AbortController();
    const parentSignal = this.controller.signal;
    const cancel = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', cancel, { once: true });
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      const error = new Error(`Request timed out after ${this.timeoutMs / 1000} seconds`);
      error.name = 'TimeoutError';
      controller.abort(error);
    }, this.timeoutMs);
    try {
      // Cover both response headers and body reading, even if a mock ignores abort.
      const operation = (async () => {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (controller.signal.aborted) throw controller.signal.reason;
        return consume(response);
      })();
      const value = await Promise.race([operation, aborted]);
      this.throwIfCancelled();
      return value;
    } catch (error) {
      // Release the underlying transport when reading or HTTP validation fails.
      controller.abort(error);
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  json(url, options = {}) {
    return this.request(url, options, (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
  }

  text(url, options = {}) {
    return this.request(url, options, (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    });
  }
}

module.exports = { NetworkClient, isCancellation };
