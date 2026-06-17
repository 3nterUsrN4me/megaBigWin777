import { buildServer } from "./server.js";
import { logger } from "./middleware/requestLogger.js";

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

async function main() {
  const server = await buildServer();

  try {
    await server.listen({ port: PORT, host: HOST });
    logger.info({ host: HOST, port: PORT }, "WS Gateway listening");
  } catch (err) {
    logger.fatal({ err }, "Failed to start WS Gateway");
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
