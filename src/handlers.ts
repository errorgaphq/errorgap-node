import type { Client } from "./client.js";

let installed = false;
let uncaughtHandler: ((err: Error) => void) | null = null;
let rejectionHandler: ((reason: unknown) => void) | null = null;

export function installProcessHandlers(client: Client): void {
  if (installed) return;
  installed = true;

  uncaughtHandler = (err: Error) => {
    void client.notify(err, {
      sync: true,
      context: { source: "uncaughtException" },
    });
  };

  rejectionHandler = (reason: unknown) => {
    void client.notify(reason, {
      sync: true,
      context: { source: "unhandledRejection" },
    });
  };

  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", rejectionHandler);
}

export function uninstallProcessHandlers(): void {
  if (!installed) return;
  if (uncaughtHandler) process.off("uncaughtException", uncaughtHandler);
  if (rejectionHandler) process.off("unhandledRejection", rejectionHandler);
  uncaughtHandler = null;
  rejectionHandler = null;
  installed = false;
}
