#!/usr/bin/env bash
# Copyright (c) 2026 Workflow Controller Contributors
#
# Licensed under the MIT License (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://opensource.org/licenses/MIT
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -euo pipefail

pid_file="${E2E_INSIGHT_PID_FILE:-}"
child_pid=""
cleanup() {
  if [[ -n "$child_pid" ]]; then
    kill "$child_pid" 2>/dev/null || true
  fi
  if [[ -n "$pid_file" ]]; then
    rm -f "$pid_file"
  fi
  rm -f "$(dirname "$0")/.next/dev/lock"
}
trap cleanup EXIT INT TERM

if [[ -n "$pid_file" ]]; then
  echo "$$" > "$pid_file"
fi
# Resolve to an absolute path so `ps -p <pid> -o command=` shows
# `.../tests/cannbot-insight/server.py` (not `python3 ./server.py`). The E2E
# teardown (global-teardown.ts `isFixtureProcess`) matches on that substring —
# a relative path would silently make the teardown skip the process and leak
# the fixture on every run.
python3 "$(cd "$(dirname "$0")" && pwd)/server.py" &
child_pid=$!
if [[ -n "$pid_file" ]]; then
  echo "$child_pid" >> "$pid_file"
fi
wait "$child_pid"
