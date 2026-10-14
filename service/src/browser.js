import puppeteer from 'puppeteer-core';
import { config } from './config.js';

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
  async withPage(fn) {
    const slot = await this.#acquire();
    let page;
    try {
      page = await slot.browser.newPage();
      return await fn(page);
    } finally {
      if (page) await page.close().catch(() => {});
      await this.#release(slot);
    }
  }

  async close() {
    if (this.current) await this.current.browser.close().catch(() => {});
    this.current = null;
  }
}
