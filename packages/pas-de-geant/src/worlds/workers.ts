export type WorldWorkerKind = "terrain-scheduler" | "imagery-scheduler" | "imagery-decoder";
export type WorldWorkerFactory = (kind: WorldWorkerKind, moduleUrl: URL) => Worker;
/** Same-origin packaged workers for hosts whose policy excludes Blob workers. */
export function createWorldWorkerFactory(urls: Readonly<Record<WorldWorkerKind, string | URL>>): WorldWorkerFactory {
  return kind => new Worker(urls[kind], { type: "module" });
}
/** Cross-origin module graph bootstrap. Use the same-origin factory when CSP excludes blob:. */
export function createModuleWorldWorkerFactory(): WorldWorkerFactory {
  return (_kind, moduleUrl) => {
    const url = URL.createObjectURL(new Blob([`import ${JSON.stringify(moduleUrl.href)};`], { type: "text/javascript" }));
    try {
      const worker = new Worker(url, { type: "module" });
      // The URL must survive asynchronous worker startup; release it with the owning worker.
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { terminate(); URL.revokeObjectURL(url); };
      return worker;
    } catch (error) { URL.revokeObjectURL(url); throw error; }
  };
}
