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

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// boot-server.sh 启动前把矩阵层临时启用的内置插件（清单集中声明在 boot
// 脚本：breather / agent_traceback）的源内 config.yaml 快照到独立目录并
// 改为 enabled: true。teardown 无论测试成败都把每个快照字节原样写回，
// 避免矩阵测试（含 MX-13 真实启停/行内配置写源码树）弄脏仓库工作区；
// 快照缺失即整跑失败（§8.6 快照还原不变量）。
const snapshotDir = process.env.WORKFLOW_CONTROLLER_E2E_PLUGIN_SNAPSHOT_DIR || '/tmp/workflow-controller-e2e-plugin-snapshots'
const pluginsRoot = fileURLToPath(new URL('../../../../../workflow_controller/plugins/', import.meta.url))

// reviewer mock 进程随 boot-server.sh 起在 webServer 进程之外（exec 前），
// playwright 只回收 webServer 本体，这里按 boot 落盘的 pidfile 收尾。
const mockPidFile = process.env.WORKFLOW_CONTROLLER_E2E_ANTHROPIC_PID || '/tmp/workflow-controller-e2e-anthropic-mock.pid'

function killMock(): void {
  if (!existsSync(mockPidFile)) return
  const pid = Number.parseInt(readFileSync(mockPidFile, 'utf-8').trim(), 10)
  if (Number.isInteger(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 进程已不在（硬杀 / 提前退出）——boot 的自愈清理兜底。
    }
  }
  rmSync(mockPidFile, { force: true })
}

export default async function (): Promise<void> {
  killMock()
  if (!existsSync(snapshotDir)) {
    throw new Error(`E2E teardown invariant violated: plugin snapshot dir missing: ${snapshotDir}`)
  }
  const snapshots = readdirSync(snapshotDir).filter(name => name.endsWith('.yaml'))
  if (snapshots.length === 0) {
    throw new Error(`E2E teardown invariant violated: no plugin snapshots in ${snapshotDir}`)
  }
  const unrestored: string[] = []
  for (const name of snapshots) {
    const plugin = name.replace(/\.yaml$/, '')
    const target = join(pluginsRoot, plugin, 'config.yaml')
    try {
      writeFileSync(target, readFileSync(join(snapshotDir, name)))
    } catch {
      unrestored.push(plugin)
    }
  }
  rmSync(snapshotDir, { recursive: true, force: true })
  if (unrestored.length > 0) {
    throw new Error(`E2E teardown invariant violated: failed to restore plugin configs: ${unrestored.join(', ')}`)
  }
}
