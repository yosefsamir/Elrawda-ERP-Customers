/** Application-owned adapter for the installed whatsapp-web.js 1.34.7.
 * No node_modules edits. Upstream inject waits for Debug.VERSION but dereferences
 * WAWebSocketModel even while it is null; navigation listeners also ignore rejected promises.
 */
export function reliableWhatsAppClasses(Client: any, LocalAuth: any) {
  class PersistentAuth extends LocalAuth {
    constructor(options: any) { super(options); }
    retired = false;
    async beforeBrowserInitialized() {
      if (!this.retired) await super.beforeBrowserInitialized();
    }
    async afterBrowserInitialized() {
      if (!this.retired) await super.afterBrowserInitialized();
    }
    async logout() {
      // Client.js:498 calls this with Chromium still open. Do not delete a live profile.
      // The owner records revocation, closes Chromium, then archives on explicit relinking.
      this.retired = true;
      this.client.emit("session_logout");
    }
  }

  class ReliableClient extends Client {
    constructor(options: any) { super(options); }
    private retired = false;
    private injection?: Promise<void>;
    private destruction?: Promise<void>;
    async destroy() {
      if (this.destruction) return this.destruction;
      this.destruction = (async () => {
        const browser = this.pupBrowser;
        // Puppeteer 25 exposes connected; upstream 1.34.7 destroy checks the removed
        // isConnected() method and silently skips browser.close() with our pinned override.
        if (browser && (browser.connected ?? browser.isConnected?.())) await browser.close();
        await this.authStrategy.destroy();
      })();
      try { await this.destruction; } finally { this.destruction = undefined; }
    }
    retire() {
      this.retired = true;
      this.authStrategy.retired = true;
    }
    async inject() {
      if (this.retired) return;
      if (this.injection) return this.injection;
      this.injection = (async () => {
        try {
          // Check the actual modules used by ExposeAuthStore, with bounded timer polling.
          // This predicate runs in the browser; it deliberately returns no auth data.
          await this.pupPage.waitForFunction(`(() => {
            try {
              if (!window.Debug?.VERSION || typeof window.require !== 'function') return false;
              return Boolean(window.require('WAWebSocketModel')?.Socket &&
                window.require('WAWebCmd')?.Cmd && window.require('WAWebConnModel')?.Conn &&
                window.require('WAWebOfflineHandler')?.OfflineMessageHandler &&
                window.require('WAWebAltDeviceLinkingApi') && window.require('WABase64') &&
                window.require('WAWebCompanionRegClientUtils') && window.require('WAWebAdvSignatureApi') &&
                window.require('WAWebUserPrefsInfoStore') && window.require('WAWebSignalStoreApi'));
            } catch { return false; }
          })()`, { polling: 200, timeout: this.options.authTimeoutMs || 30000 });
          if (!this.retired) await super.inject();
        } catch (error) {
          // Applies to initial and later navigation injections. A handled owner event avoids
          // the upstream async EventEmitter listener becoming an unhandled rejection.
          if (!this.retired) this.emit("lifecycle_error", error);
        }
      })();
      try { await this.injection; } finally { this.injection = undefined; }
    }
  }
  return { ReliableClient, PersistentAuth };
}
