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

import type { MessageApi, DialogApi } from 'naive-ui'

// Naive UI 全局桥接。
// NaiveBridge.vue 在 providers 内部设置 window.$message / window.$dialog;
// 非 setup 上下文（如 useAuth.ts 的函数内部）也能通过全局变量发送通知/弹框。

declare global {
  interface Window {
    $message?: MessageApi
    $dialog?: DialogApi
  }
}

export function useToast() {
  const msg = (): MessageApi | undefined => window.$message

  return {
    success: (s: string) => msg()?.success(s),
    error: (s: string) => msg()?.error(s),
    warning: (s: string) => msg()?.warning(s),
    info: (s: string) => msg()?.info(s),
  }
}
