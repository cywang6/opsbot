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

import type { Component } from 'vue'
import type { RunPanelDeclaration } from './types/api'
import RunDagPanel from './plugins/graph/ui/RunDagPanel.vue'

// 插件贡献的 Vue 组件注册表：键为插件声明的组件 id（get_run_panels 的
// component 字段）。构建期静态注册，不做运行时动态加载。
const pluginComponents: Record<string, Component> = {
  'graph.RunDagPanel': RunDagPanel,
}

// 面板槽位协议：按 (format, 投影 schema_version) 解析 run 详情的驱动面板。
// 投影版本超出声明上限或缺版本时不渲染——形状不兼容的防呆。
export function resolveRunPanel(
  declarations: RunPanelDeclaration[],
  format: string,
  projectionSchemaVersion: number | null,
): Component | null {
  if (!format || projectionSchemaVersion == null) return null
  const declaration = declarations.find((d) => d.format === format)
  if (!declaration || declaration.schema_version < projectionSchemaVersion) {
    return null
  }
  return pluginComponents[declaration.component] ?? null
}
