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

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

const mockConfig = ref<any>(null)
const mockSessions = ref<any[]>([])
const mockProjectDir = ref('')
const mockAuthReady = ref(true)

const routerPushMock = vi.fn()
const routerReplaceMock = vi.fn()
const mockRoute = ref<any>({ name: 'dashboard', params: {} })
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPushMock, replace: routerReplaceMock }),
  useRoute: () => mockRoute.value,
}))

vi.mock('../composables/useSettingsModal', () => ({
  useSettingsModal: () => ({ open: vi.fn() }),
}))
vi.mock('../composables/useRecentDirs', () => ({
  useRecentDirs: () => ({ addDir: vi.fn(), removeDir: vi.fn() }),
}))
vi.mock('../composables/useProjectPaths', () => ({
  useProjectPaths: () => ({ projectDir: mockProjectDir }),
}))
vi.mock('../composables/useSSE', () => ({
  useSSE: () => ({ sessions: mockSessions, config: mockConfig }),
}))
const removeSessionMock = vi.fn()
vi.mock('../composables/useSessions', () => ({
  useSessions: () => ({ removeSession: removeSessionMock }),
}))
vi.mock('../composables/useAuth', () => ({
  useAuth: () => ({ authReady: mockAuthReady }),
}))
vi.mock('../composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

async function mountSidebar() {
  const { default: AppSidebar } = await import('../components/layout/AppSidebar.vue')
  return mount(AppSidebar, { global: { stubs: { DeleteSessionDialog: true } } })
}

beforeEach(() => {
  mockConfig.value = null
  mockSessions.value = []
  mockProjectDir.value = ''
  mockAuthReady.value = true
  mockRoute.value = { name: 'dashboard', params: {} }
  routerPushMock.mockClear()
  routerReplaceMock.mockClear()
  removeSessionMock.mockReset()
  removeSessionMock.mockResolvedValue({ ok: true })
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true })
})

describe('AppSidebar brand name', () => {
  it('renders the configured brand name from SSE config', async () => {
    mockConfig.value = { brand_name: 'Ascendbot', recent_dirs: [] }
    const wrapper = await mountSidebar()
    expect(wrapper.find('.sidebar-title').text()).toBe('Ascendbot')
    wrapper.unmount()
  })

  it('falls back to the default brand when config has no brand_name (old backend)', async () => {
    mockConfig.value = { recent_dirs: [] }
    const wrapper = await mountSidebar()
    expect(wrapper.find('.sidebar-title').text()).toBe('Workflow Controller')
    wrapper.unmount()
  })
})

describe('AppSidebar 会话树', () => {
  it('运行中会话显示绿色状态点，idle 会话无状态点', async () => {
    mockConfig.value = { recent_dirs: ['/proj'] }
    mockProjectDir.value = '/proj'
    mockSessions.value = [
      { id: 's1', name: '空闲会话', project_dir: '/proj', state: 'idle', loop_status: 'yes', created_at_iso: '2026-01-02T00:00:00', plugin_metadata: {} },
      { id: 's2', name: '运行会话', project_dir: '/proj', state: 'running', loop_status: 'no', created_at_iso: '2026-01-03T00:00:00', plugin_metadata: {} },
    ]
    const wrapper = await mountSidebar()
    const rows = wrapper.findAll('.project-session-row')
    expect(rows).toHaveLength(2)
    // 按创建时间倒序：s2（运行中）在前，带绿色状态点；s1（idle）无任何状态点
    expect(rows[0].find('.project-running-dot').exists()).toBe(true)
    expect(rows[1].find('.project-running-dot').exists()).toBe(false)
    expect(rows[1].find('.history-dot').exists()).toBe(false)
    wrapper.unmount()
  })

  it('graph 插件创建的会话不进入会话树', async () => {
    mockConfig.value = { recent_dirs: ['/proj'] }
    mockProjectDir.value = '/proj'
    mockSessions.value = [
      { id: 'g1', name: 'graph node', project_dir: '/proj', state: 'idle', created_at_iso: '2026-01-02T00:00:00', plugin_metadata: { graph: {} } },
    ]
    const wrapper = await mountSidebar()
    expect(wrapper.find('.project-session-row').exists()).toBe(false)
    expect(wrapper.find('.project-sessions').text()).toBe('')
    wrapper.unmount()
  })
})

describe('AppSidebar 顶部添加项目入口', () => {
  it('选中项目后仍可添加项目，无需会话授权', async () => {
    mockConfig.value = { recent_dirs: [] }
    mockAuthReady.value = false
    const openImport = vi.fn()
    const openNewSession = vi.fn()
    window.addEventListener('workflow-controller:open-import', openImport)
    window.addEventListener('workflow-controller:open-new-session', openNewSession)
    const wrapper = await mountSidebar()
    const button = wrapper.get('.section-header button')
    try {
      expect(button.text()).toBe('添加项目')
      await button.trigger('click')
      expect(openImport).toHaveBeenCalledTimes(1)

      mockConfig.value = { recent_dirs: ['/proj'] }
      mockProjectDir.value = '/proj'
      await flushPromises()

      expect(button.text()).toBe('添加项目')
      expect(button.attributes('disabled')).toBeUndefined()
      await button.trigger('click')
      expect(openImport).toHaveBeenCalledTimes(2)
      expect(openNewSession).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      window.removeEventListener('workflow-controller:open-import', openImport)
      window.removeEventListener('workflow-controller:open-new-session', openNewSession)
    }
  })
})

describe('AppSidebar 行级 Enter 双重触发护栏', () => {
  it('项目行内部按钮的 Enter 不触发行级 selectProject（target 检查）', async () => {
    mockConfig.value = { brand_name: 'Workflow Controller', recent_dirs: ['/proj'] }
    const wrapper = await mountSidebar()
    const row = wrapper.find('.project-row')
    expect(row.exists()).toBe(true)
    // 直接对行触发 Enter：target === currentTarget → 切换项目（内部 router.push）
    await row.trigger('keydown.enter')
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalled()
    routerPushMock.mockClear()
    // 对内部按钮触发 Enter（模拟按钮冒泡 + 浏览器合成 click）：不应触发行级跳转
    const newBtn = row.find('.project-new-session')
    await newBtn.trigger('keydown.enter')
    await flushPromises()
    expect(routerPushMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('会话行内部删除按钮的 Enter 不触发行级 openSession', async () => {
    mockConfig.value = { brand_name: 'Workflow Controller', recent_dirs: ['/proj'] }
    mockProjectDir.value = '/proj'
    mockSessions.value = [{
      id: 'sess-1', name: 's1', state: 'idle', project_dir: '/proj',
      created_at_iso: '2026-01-01T00:00:00', plugin_metadata: {},
    }]
    const wrapper = await mountSidebar()
    const row = wrapper.find('.project-session-row')
    expect(row.exists()).toBe(true)
    await row.trigger('keydown.enter')
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalledWith('/session/sess-1')
    routerPushMock.mockClear()
    const delBtn = row.find('.history-delete')
    await delBtn.trigger('keydown.enter')
    await flushPromises()
    expect(routerPushMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('AppSidebar 项目行键盘与 aria', () => {
  it('aria-expanded 随展开状态切换，aria-controls 指向会话列表；Space 激活当前项目行即收起', async () => {
    mockConfig.value = { brand_name: 'Workflow Controller', recent_dirs: ['/proj'] }
    mockProjectDir.value = '/proj'
    const wrapper = await mountSidebar()
    const row = wrapper.find('.project-row')
    expect(row.attributes('aria-expanded')).toBe('true')
    const listId = row.attributes('aria-controls')
    expect(listId).toBeTruthy()
    expect(wrapper.find(`#${listId}`).classes()).toContain('project-sessions')
    await row.trigger('keydown.space')
    expect(row.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.project-sessions').exists()).toBe(false)
    wrapper.unmount()
  })

  it('Space 激活非当前项目行切项目；内部按钮的 Space 冒泡不触发行级切换', async () => {
    mockConfig.value = { brand_name: 'Workflow Controller', recent_dirs: ['/proj'] }
    mockProjectDir.value = ''
    const wrapper = await mountSidebar()
    const row = wrapper.find('.project-row')
    await row.trigger('keydown.space')
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalled()
    routerPushMock.mockClear()
    const newBtn = row.find('.project-new-session')
    await newBtn.trigger('keydown.space')
    await flushPromises()
    expect(routerPushMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('AppSidebar 会话行键盘激活', () => {
  function seedOneSession() {
    mockConfig.value = { brand_name: 'Workflow Controller', recent_dirs: ['/proj'] }
    mockProjectDir.value = '/proj'
    mockSessions.value = [{
      id: 'sess-1', name: 's1', state: 'idle', project_dir: '/proj',
      created_at_iso: '2026-01-01T00:00:00', plugin_metadata: {},
    }]
  }

  it('Space 激活会话行打开会话；内部删除按钮的 Space 冒泡不触发行级打开', async () => {
    seedOneSession()
    const wrapper = await mountSidebar()
    const row = wrapper.find('.project-session-row')
    expect(row.exists()).toBe(true)
    await row.trigger('keydown.space')
    await flushPromises()
    expect(routerPushMock).toHaveBeenCalledWith('/session/sess-1')
    routerPushMock.mockClear()
    const delBtn = row.find('.history-delete')
    await delBtn.trigger('keydown.space')
    await flushPromises()
    expect(routerPushMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('Space 激活会话行时拦截浏览器默认页面滚动', async () => {
    seedOneSession()
    const wrapper = await mountSidebar()
    const row = wrapper.find('.project-session-row')
    let defaultPrevented = false
    row.element.addEventListener('keydown', (e) => {
      defaultPrevented = e.defaultPrevented
    })
    await row.trigger('keydown', { key: ' ' })
    expect(defaultPrevented).toBe(true)
    wrapper.unmount()
  })
})

describe('AppSidebar 删除当前查看会话后回首页', () => {
  function seedSessions() {
    mockConfig.value = { brand_name: 'Workflow Controller', recent_dirs: ['/proj'] }
    mockProjectDir.value = '/proj'
    mockSessions.value = [{
      id: 'sess-1', name: 's1', state: 'idle', project_dir: '/proj',
      created_at_iso: '2026-01-01T00:00:00', plugin_metadata: {},
    }]
  }

  it('删除成功且命中当前路由会话（含级联删除）时 replace 到 /', async () => {
    seedSessions()
    mockRoute.value = { name: 'sessionDetail', params: { id: 'sess-1' } }
    removeSessionMock.mockResolvedValue({ ok: true, deleted_session_ids: ['sess-9', 'sess-1'] })
    const wrapper = await mountSidebar()
    await wrapper.find('.history-delete').trigger('click')
    const dialog = wrapper.findComponent({ name: 'DeleteSessionDialog' })
    expect(dialog.exists()).toBe(true)
    dialog.vm.$emit('confirm', {})
    await flushPromises()
    expect(routerReplaceMock).toHaveBeenCalledWith('/')
    wrapper.unmount()
  })

  it('删除的是其他会话时不回跳', async () => {
    seedSessions()
    mockRoute.value = { name: 'sessionDetail', params: { id: 'sess-2' } }
    removeSessionMock.mockResolvedValue({ ok: true, deleted_session_ids: ['sess-1'] })
    const wrapper = await mountSidebar()
    await wrapper.find('.history-delete').trigger('click')
    wrapper.findComponent({ name: 'DeleteSessionDialog' }).vm.$emit('confirm', {})
    await flushPromises()
    expect(routerReplaceMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
