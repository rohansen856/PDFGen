import puppeteer from 'puppeteer-core';
import { config } from './config.js';

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// One long-lived Chromium per worker process. Launching Chromium is the expensive part
// (~1 s and a few hundred MB); a new tab per render is cheap. The browser is replaced after
// N renders (Chromium leaks slowly) or as soon as it dies.
export class BrowserPool {
  constructor({ recycleAfter = config.browserRecycleAfter } = {}) {
    this.recycleAfter = recycleAfter;
    this.current = null; // { browser, renders, inflight, retiring }
  }

  async #launch() {
    const browser = await puppeteer.launch({
      executablePath: config.chromiumPath,
      headless: true,
      args: [
        '--no-sandbox', // container is the sandbox; Chromium's needs extra kernel caps
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--js-flags=--max-old-space-size=512',
      ],
    });
    const slot = { browser, renders: 0, inflight: 0, retiring: false };
    browser.on('disconnected', () => {
      if (this.current === slot) this.current = null;
    });
    return slot;
  }

  async #acquire() {
    while (!this.current || this.current.retiring || !this.current.browser.connected) {
      // Concurrent callers share one launch instead of starting several browsers.
      this.launching ??= this.#launch().finally(() => { this.launching = null; });
      this.current = await this.launching;
    }
    const slot = this.current;
    slot.inflight++;
    slot.renders++;
    if (slot.renders >= this.recycleAfter) slot.retiring = true;
    return slot;
  }

  async #release(slot) {
    slot.inflight--;
    if (slot.retiring && slot.inflight === 0) await slot.browser.close().catch(() => {});
  }

  // Run fn(page) on a fresh tab; the tab is always closed afterwards.
  // A renderer that crashes (typically OOM) leaves Puppeteer calls on that page pending forever,
  // so the work is raced against the page's 'error' (crash) event and a hard deadline.
  async withPage(fn, { timeoutMs = config.renderTimeoutMs } = {}) {
    const slot = await this.#acquire();
    let page;
    let timer;
    try {
      page = await slot.browser.newPage();
      const crashed = new Promise((_, reject) => page.once('error', (e) => reject(new Error(`renderer crashed: ${e.message}`))));
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`render exceeded ${timeoutMs} ms`)), timeoutMs); });
      return await Promise.race([fn(page), crashed, deadline]);
    } finally {
      clearTimeout(timer);
      if (page) await withTimeout(page.close(), 5000).catch(() => {});
      await this.#release(slot);
    }
  }

  async close() {
    if (this.current) await this.current.browser.close().catch(() => {});
    this.current = null;
  }
}
