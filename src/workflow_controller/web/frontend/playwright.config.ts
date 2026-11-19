// Copyright (c) 2026 Workflow Controller Contributors
//
// Licensed under the MIT License (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://opensource.org/licenses/MIT
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { INSIGHT_PID_FILE } from './e2e/constants'

// fileURLToPath decodes the percent-escaped segments that URL.pathname leaves
// behind when the checkout path contains spaces or non-ASCII characters.
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))

export default defineConfig({
  testDir: './e2e',
  // 矩阵层 spec（e2e/matrix/）有独立配置与 webServer（隔离 HOME + CLI
  // shim），混进 mock 层会撞真实 CLI/网络；两套用例只在各自配置下运行。
  testIgnore: '**/matrix/**',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:18600',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    // `--insight` 显式指向仓库内 fixture：66f929db 起 `--insight` 裸旗走
    // PATH 查找，会命中用户全局安装的真实 cannbot-insight（非确定性、
    // 缺 fake 标记、上游不可达时反代 502）。
    command: `npm --prefix src/workflow_controller/web/frontend run build && E2E_INSIGHT_PID_FILE=${INSIGHT_PID_FILE} UV_CACHE_DIR=/tmp/workflow-controller-uv-cache uv run workflow-controller web --insight "${repoRoot}/tests/cannbot-insight/start.sh" --no-open --host 127.0.0.1 --port 18600`,
    cwd: repoRoot,
    url: 'http://127.0.0.1:18600/api/v1/health',
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    // Send SIGTERM (instead of the default SIGKILL) when stopping the server:
    // `workflow-controller web` installs a SIGTERM handler that killpgs the fixture's own
    // process group (start_new_session), so the fake insight is cleaned up even
    // if the pid-file teardown below is skipped. 10s is enough for the graceful
    // shutdown + 1s killpg wait.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
})
