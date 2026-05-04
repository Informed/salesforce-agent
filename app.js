import { App, LogLevel } from '@slack/bolt';
import { config as loadEnv } from 'dotenv';
import { registerListeners } from './listeners/index.js';

loadEnv({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
  ignoreSelf: false,
});

registerListeners(app);

(async () => {
  await app.start();
  app.logger.info('Starter Agent is running!');
})();
