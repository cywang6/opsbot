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
import type { PluginInfo } from '../types/api'

// Singleton plugin-list state (shared across all components). Fetched once on
// first use; refreshed when a plugin is toggled/installed. Generic core mechanism
// — not tied to any specific plugin.
const plugins = ref<PluginInfo[]>([])
const loaded = ref(false)
let inflight: Promise<void> | null = null

export function usePlugins() {
  async function loadPlugins() {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const r = await fetch('/api/v1/plugins')
        const d = await r.json()
        plugins.value = d.plugins || []
      } catch { plugins.value = [] }
      loaded.value = true
      inflight = null
    })()
    return inflight
  }

  // A plugin is "active" when it is loaded into the orchestrator (enabled in
  // config AND successfully installed). The /api/v1/plugins response only attaches
  // a `manifest` key to plugins present in orch.plugins, so its presence is the
  // reliable "loaded" signal (independent of the config `enabled` flag).
  function pluginLoaded(name: string): boolean {
    const entry = plugins.value.find(p => p.name === name)
    return !!entry && 'manifest' in entry
  }

  // Check if a plugin is enabled in config (regardless of loaded status).
  // The /api/v1/plugins response always includes `enabled` — works immediately
  // after Settings toggle without needing a reload.
  function pluginEnabled(name: string): boolean {
    if (!loaded.value) return false
    const entry = plugins.value.find(p => p.name === name)
    return !!entry && entry.enabled === true
  }

  return { plugins, loaded, loadPlugins, pluginLoaded, pluginEnabled }
}
