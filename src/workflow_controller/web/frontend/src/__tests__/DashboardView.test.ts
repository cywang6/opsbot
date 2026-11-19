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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InlineDirectoryPicker from '../components/common/InlineDirectoryPicker.vue'

const mockAddDir = vi.fn()
const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }

vi.mock('../composables/useSSE', () => ({
  useSSE: () => ({
    connected: ref(true),
  }),
}))
vi.mock('../composables/useProjectPaths', () => ({
  useProjectPaths: () => ({ projectDir: ref('/proj') }),
}))
vi.mock('../composables/usePlugins', () => ({
  usePlugins: () => ({ loadPlugins: vi.fn() }),
}))
vi.mock('../composables/useSessions', () => ({
  useSessions: () => ({ stopAll: vi.fn() }),
}))
vi.mock('../composables/useRecentDirs', () => ({
  useRecentDirs: () => ({ addDir: mockAddDir, removeDir: vi.fn() }),
}))
vi.mock('../composables/useToast', () => ({
  useToast: () => mockToast,
}))
vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({ confirmAction: vi.fn().mockResolvedValue(false) }),
}))

async function mountDashboard() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/session/:id', component: { template: '<div />' } },
      { path: '/run/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  const DashboardView = (await import('../views/DashboardView.vue')).default
  const wrapper = mount(DashboardView, {
    global: {
      plugins: [router],
      stubs: {
        NewSessionModal: true, DirPicker: true,
        InlineDirectoryPicker: true,
        // 去掉传送门，弹窗内容随 show 就地渲染/卸载，便于断言
        NModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('本地文件夹添加项目（onLocalFolderSelected）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('addDir 成功后写 project_dir、保存配置并关闭导入弹窗', async () => {
    const fetchCalls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([String(input), init])
      return { ok: true, json: async () => ({ sessions: [] }) } as Response
    }))
    mockAddDir.mockResolvedValue({ ok: true })

    const wrapper = await mountDashboard()
    window.dispatchEvent(new Event('workflow-controller:open-import'))
    await flushPromises()

    const picker = wrapper.findComponent(InlineDirectoryPicker)
    expect(picker.exists()).toBe(true)
    picker.vm.$emit('selected', '/data/newproj')
    await flushPromises()
    await nextTick()

    // 成功判定契约（addDir 成功必得 ok:true）：不得早退进失败分支
    expect(mockAddDir).toHaveBeenCalledWith('/data/newproj')
    expect(mockToast.error).not.toHaveBeenCalled()
    expect(mockToast.success).toHaveBeenCalledWith('项目已添加')
    const putCall = fetchCalls.find(([url, init]) => url === '/api/v1/config' && init?.method === 'PUT')
    expect(putCall).toBeTruthy()
    expect(JSON.parse(String(putCall![1]!.body)).project_dir).toBe('/data/newproj')
    expect(fetchCalls.some(([url, init]) => url === '/api/v1/config/save' && init?.method === 'POST')).toBe(true)
    // findComponent 对已卸载 stub 有陈旧匹配，按 DOM 判定弹窗关闭
    expect(wrapper.html()).not.toContain('inline-directory-picker')
    wrapper.unmount()
  })
})
