// Legacy standalone entrypoint — reads config from .env
// For the UI-driven API server mode run: npm run start:api
import { config, validateConfig } from './config.js';
import { PolymarketCopyBot } from './bot.js';

async function main() {
  validateConfig();

  const bot = new PolymarketCopyBot({
    targetWallet: config.targetWallet,
    privateKey: config.privateKey,
    rpcUrl: config.rpcUrl,
    alchemyWsUrl: config.alchemy.wsUrl,
    useAlchemy: config.alchemy.enabled,
    polymarketGeoToken: config.polymarketGeoToken,
    trading: config.trading,
    risk: config.risk,
    monitoring: config.monitoring,
  });

  process.on('SIGINT', () => {
    console.log('\n\nReceived SIGINT, shutting down...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });

  try {
    await bot.initialize();
    await bot.start();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
