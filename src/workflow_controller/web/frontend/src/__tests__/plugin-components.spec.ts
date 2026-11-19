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

import { describe, expect, it } from 'vitest'
import { resolveRunPanel } from '../plugin-components'
import RunDagPanel from '../plugins/graph/ui/RunDagPanel.vue'

// 面板槽位协议：(format, 投影 schema_version) → 面板组件
describe('plugin-components', () => {
  const declarations = [
    { format: 'graph-yaml@1', component: 'graph.RunDagPanel', schema_version: 2 },
  ]

  it('format 命中声明且投影版本不超上限时解析出面板组件', () => {
    expect(resolveRunPanel(declarations, 'graph-yaml@1', 2)).toBe(RunDagPanel)
    expect(resolveRunPanel(declarations, 'graph-yaml@1', 1)).toBe(RunDagPanel)
  })

  it('format 未声明时不渲染（插件禁用即无声明）', () => {
    expect(resolveRunPanel(declarations, 'other@1', 2)).toBeNull()
    expect(resolveRunPanel([], 'graph-yaml@1', 2)).toBeNull()
  })

  it('投影版本超出声明上限或缺版本时不渲染（形状不兼容防呆）', () => {
    expect(resolveRunPanel(declarations, 'graph-yaml@1', 3)).toBeNull()
    expect(resolveRunPanel(declarations, 'graph-yaml@1', null)).toBeNull()
    expect(resolveRunPanel(declarations, '', 2)).toBeNull()
  })
})
