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

import { ref } from 'vue'
import { useToast } from './useToast'

// 全局单例 —— Dashboard 与 Settings 共享同一份 auth 验证状态。
// 模块级 ref（函数外）保证所有组件实例看到同一状态。默认只读缓存，避免页面
// 启动时触发真实 driver 调用；force=true 仅用于用户显式要求重测。
const authReady = ref(false)
const authChecking = ref(true)
const authError = ref('')

async function checkAuth(force: boolean = false) {
  authChecking.value = true
  try {
    const r = await fetch(force ? '/api/v1/auth/test' : '/api/v1/auth/status', {
      method: force ? 'POST' : 'GET',
    })
    const d = await r.json()
    const ready = force ? d.success : d.has_api_key
    if (ready) {
      authReady.value = true
      authError.value = ''
    } else {
      authReady.value = false
      authError.value = d.error || 'unknown'
    }
  } catch (e: any) {
    authReady.value = false
    authError.value = String(e)
  }
  authChecking.value = false
}

async function activateProvider(index: number) {
  const toast = useToast()
  try {
    const r = await fetch('/api/v1/auth/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    })
    const d = await r.json()
    if (d.ok) {
      toast.success('Provider switched')
      await checkAuth(true)
    } else {
      toast.error(d.error || 'Failed to switch provider')
    }
  } catch (e: any) {
    toast.error(`Failed to switch: ${e}`)
  }
}

export function useAuth() {
  return { authReady, authChecking, authError, checkAuth, activateProvider }
}
