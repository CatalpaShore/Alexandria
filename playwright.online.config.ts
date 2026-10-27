import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
const baseURL = process.env.ONLINE_DEMO_URL || 'http://127.0.0.1:44241/Alexandria/';
export default defineConfig({
  testDir: './tests/online-demo', testMatch: '*.spec.ts', timeout: 45000, workers: 2,
  reporter: 'list', retries: 0,
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', channel: process.env.CI ? undefined : 'chrome' },
  webServer: process.env.ONLINE_DEMO_URL ? undefined : {
    command: `node node_modules/vite/bin/vite.js preview --base /Alexandria/ --outDir "${path.resolve('.local/online-demo/site')}" --host 127.0.0.1 --port 44241 --strictPort`,
    url: baseURL, reuseExistingServer: false
  },
  projects: [{ name: 'desktop', use: devices['Desktop Chrome'] }, { name: 'mobile', use: devices['Pixel 7'] }]
});
