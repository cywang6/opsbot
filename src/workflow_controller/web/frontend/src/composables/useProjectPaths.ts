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

import { computed } from 'vue'
import { useSSE } from './useSSE'

// 当前项目目录指针 —— 后端单一来源、SSE config.project_dir 驱动。
// 后端 /api/v1/config 已是权威（PUT → config_update SSE 回推），刷新即由首帧覆盖。
const { config } = useSSE()

const projectDir = computed<string>({
  get: () => config.value?.project_dir ?? '',
  // 本地 setter 仅作乐观更新后备：实际权威是 PUT /api/v1/config → SSE 回推。
  // 调用方改项目时应直接 PUT /api/v1/config（SSE 首帧到达即覆盖）。
  set: (val: string) => {
    if (config.value) config.value.project_dir = val
  },
})

export function useProjectPaths() {
  return { projectDir }
}
