import { createApiServer, startDailyChatCleanup } from './api.js';
import { loadConfig } from './config.js';
import { createDatabase, MetadataStore } from './db.js';
import { InventoryStore } from './inventory.js';

const config = loadConfig();
const database = createDatabase(config.databasePath);
const metadata = new MetadataStore(database);
const inventory = new InventoryStore(config.inventoryDir);
const server = createApiServer({ config, metadata, inventory });
const stopChatCleanup = startDailyChatCleanup(
  metadata,
  config.dayTimezoneOffsetMinutes,
  config.dayBoundaryHour,
);

server.listen(config.port, config.host, () => {
  console.log(`Belong server listening on http://${config.host}:${config.port}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  stopChatCleanup();
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
