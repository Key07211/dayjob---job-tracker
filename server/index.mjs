import { start } from './app.mjs';

try {
  const app = await start();
  console.log(`Dayjob is ready at ${app.url}`);
  console.log(`Data: ${app.filename}`);
  const scoring = await app.scorer.status();
  console.log(scoring.available ? `AI scoring: ${scoring.detail}` : `AI scoring is off: ${scoring.detail}`);
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(`Dayjob could not start: ${error.message}`);
  process.exitCode = 1;
}
