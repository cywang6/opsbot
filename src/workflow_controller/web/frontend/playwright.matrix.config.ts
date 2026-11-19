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

// 特性矩阵层 e2e 配置（设计文档 docs/designs/workflow-controller-e2e-feature-matrix.md）。
//
// 与 mock 层套件（playwright.config.ts）分离而不是共用一个 webServer：
// 矩阵层需要完全不同的服务端环境（隔离 HOME/配置/密钥、PATH 前置 CLI
// shim、独立端口与 cwd），共用会把隔离环境强加给 mock 层用例。
//
// 可观赏运行（浏览器窗口 + 放慢动作）：
//   E2E_SLOWMO=600 npm run e2e:matrix -- --headed
// 真模型冒烟：E2E_LIVE=1 npm run e2e:matrix，boot 不注入 shim，用例换成
// live 版（claude-live.spec.ts）；真模型一轮可达分钟级，live 下放宽用例超时。
const slowMo = Number(process.env.E2E_SLOWMO || 0)
const live = process.env.E2E_LIVE === '1'

export default defineConfig({
  testDir: './e2e/matrix',
  globalTeardown: './e2e/matrix/global-teardown.ts',
  timeout: live ? 600_000 : 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18601',
    ...devices['Desktop Chrome'],
    ...(slowMo > 0 ? { launchOptions: { slowMo } } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    // boot-server.sh：构建前端 → 准备隔离环境（shim PATH、假 provider、
    // breather 临时启用）→ 以矩阵根为 cwd 起被测 workflow-controller web。
    command: 'bash src/workflow_controller/web/frontend/e2e/matrix/boot-server.sh',
    cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
    url: 'http://127.0.0.1:18601/api/v1/health',
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
})
