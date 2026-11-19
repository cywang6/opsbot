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

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { INSIGHT_PID_FILE } from './constants'

function isFixtureProcess(pid: number): boolean {
  // The pid file is shared and may outlive a run, so a bare kill could take down an
  // unrelated process that reuses the same pid (or another run's fixture on shared
  // machines). Only terminate processes whose command line identifies the fixture.
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    // The fixture's python server is always spawned as `python3 .../tests/cannbot-insight/server.py`
    // (start.sh resolves the script to an absolute path so this matches), so this tight
    // path cannot hit an unrelated `server.py` elsewhere.
    return command.includes('cannbot-insight/server.py')
  } catch {
    // Process already gone (or not inspectable) — nothing to kill.
    return false
  }
}

function remainingFixtureProcesses(): number[] {
  // `pgrep -f 'cannbot-insight/server.py'` matches the fixture's python process by
  // command line. Used as an invariant assertion so a teardown regression (e.g. the
  // pid filter silently no longer matching) fails the run loudly instead of leaking
  // a fixture that then occupies port 21025 for the next run.
  try {
    const out = execFileSync('pgrep', ['-f', 'cannbot-insight/server.py'], { encoding: 'utf8' })
    return out
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    // pgrep exits 1 when nothing matches.
    return []
  }
}

export default function globalTeardown() {
  const pidFile = process.env.E2E_INSIGHT_PID_FILE || INSIGHT_PID_FILE
  if (existsSync(pidFile)) {
    const pids = readFileSync(pidFile, 'utf8')
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    for (const pid of pids) {
      if (!isFixtureProcess(pid)) {
        continue
      }
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // The web server may already have cleaned up the fixture.
      }
    }
    // The wrapper's own trap (`rm -f "$pid_file"` in start.sh) may already have
    // removed the file after the fixture exits, so tolerate a missing file.
    rmSync(pidFile, { force: true })
  }

  // Invariant: no fixture process may survive a run. Poll briefly — the SIGTERM
  // above (and the webServer's graceful shutdown) takes a moment to settle.
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (remainingFixtureProcesses().length === 0) {
      return
    }
    execFileSync('sleep', ['0.2'])
  }
  const leaked = remainingFixtureProcesses().join(', ')
  throw new Error(`E2E teardown invariant violated: fixture processes still running (${leaked})`)
}
