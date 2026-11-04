/** Guard the installed library's sync callback without changing node_modules.
 * The old change:hasSynced listener also fires for false/undefined during logout.
 */
export function installSyncGuard(page: any, alive: () => boolean, failed: (error: unknown) => void) {
  const expose = page.exposeFunction.bind(page);
  let registrations = Promise.resolve();
  let syncing: Promise<unknown> | undefined;
  page.exposeFunction = (name: string, callback: (...args: any[]) => any) => {
    const wrapped = name !== "onAppStateHasSyncedEvent" ? callback : (...args: any[]) => {
      if (!alive()) return Promise.resolve();
      if (syncing) return syncing;
      syncing = page.evaluate(`(() => {
        try {
          const socket = window.require('WAWebSocketModel').Socket;
          return socket.hasSynced === true && !['UNPAIRED','UNPAIRED_IDLE'].includes(socket.state)
            && !window.location.search.includes('post_logout=1');
        } catch { return false; }
      })()`).then((synced: boolean) => {
        if (synced && alive()) return callback(...args);
      }).catch((error: unknown) => { if (alive()) failed(error); })
        .finally(() => { syncing = undefined; });
      return syncing;
    };
    // The upstream exists-check and expose are not atomic. Serialize and replace
    // the binding through Puppeteer's supported API if two callbacks race.
    const next = registrations.then(async () => {
      if (!alive()) return;
      try { await page.removeExposedFunction(name); }
      catch (error: any) {
        if (!/not exist|not found/i.test(String(error?.message))) throw error;
      }
      await expose(name, wrapped);
    });
    registrations = next.catch(() => {});
    return next;
  };
}
