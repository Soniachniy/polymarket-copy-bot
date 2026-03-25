import { createHttpServer } from './app.js';

const PORT = parseInt(process.env.API_PORT ?? '3000');

const { httpServer, controller } = createHttpServer();

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 API server running on http://0.0.0.0:${PORT}`);
  console.log(`🔌 WebSocket available at ws://0.0.0.0:${PORT}/ws`);
  console.log(`\nOpen the UI at http://localhost:8080\n`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down API server...');
  await controller.stop();
  httpServer.close(() => process.exit(0));
});
process.on('SIGTERM', async () => {
  await controller.stop();
  httpServer.close(() => process.exit(0));
});
