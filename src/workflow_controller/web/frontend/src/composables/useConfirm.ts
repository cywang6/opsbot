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

import { useDialog } from 'naive-ui'

// 确认对话框工具。在 setup 上下文中调用（如 view 的 script setup）。
// 非 setup 上下文可通过 window.$dialog 访问。

export function useConfirm() {
  const dialog = useDialog()

  return {
    confirmDelete: (label: string) =>
      new Promise<boolean>((resolve) => {
        dialog.warning({
          title: '确认删除',
          content: `确定要删除「${label}」吗？此操作不可恢复`,
          positiveText: '删除',
          negativeText: '取消',
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
        })
      }),

    confirmAction: (title: string, content: string) =>
      new Promise<boolean>((resolve) => {
        dialog.warning({
          title,
          content,
          positiveText: '确定',
          negativeText: '取消',
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
        })
      }),
  }
}
