<!--
  Copyright (c) 2026 Workflow Controller Contributors

  Licensed under the MIT License (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://opensource.org/licenses/MIT

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { zhCN, dateZhCN, darkTheme } from 'naive-ui'
import NaiveBridge from './components/common/NaiveBridge.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import SettingsModal from './components/SettingsModal.vue'
import { useSSE } from './composables/useSSE'
import { useAuth } from './composables/useAuth'
import { DEFAULT_BRAND_NAME } from './utils/brand'
import { useAppearance } from './composables/useAppearance'

// 全局导航栏常驻（会话详情页也保留项目/会话导航），宽度可拖拽调整。
const APP_SIDEBAR_WIDTH_KEY = 'workflow-controller-app-sidebar-width'
const APP_SIDEBAR_MIN_WIDTH = 180
const APP_SIDEBAR_MAX_WIDTH = 480
const appSidebarWidth = ref(240)
const appSidebarResizing = ref(false)
let appSidebarStartX = 0
let appSidebarStartWidth = 240
let previousBodyCursor = ''
let previousBodyUserSelect = ''

function loadAppSidebarWidth() {
  try {
    // 首次运行（key 不存在）保留默认 240px，而不是把 Number(null)=0 钳到最小值。
    const stored = window.localStorage.getItem(APP_SIDEBAR_WIDTH_KEY)
    if (stored === null || stored === '') return
    const width = Number(stored)
    if (Number.isFinite(width)) appSidebarWidth.value = Math.min(APP_SIDEBAR_MAX_WIDTH, Math.max(APP_SIDEBAR_MIN_WIDTH, width))
  } catch {}
}
function startAppSidebarResize(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  appSidebarResizing.value = true
  appSidebarStartX = event.clientX
  appSidebarStartWidth = appSidebarWidth.value
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  previousBodyCursor = document.body.style.cursor
  previousBodyUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  event.preventDefault()
}
function moveAppSidebarResize(event: PointerEvent) {
  if (!appSidebarResizing.value) return
  appSidebarWidth.value = Math.min(APP_SIDEBAR_MAX_WIDTH, Math.max(APP_SIDEBAR_MIN_WIDTH, appSidebarStartWidth + event.clientX - appSidebarStartX))
  event.preventDefault()
}
function finishAppSidebarResize() {
  if (!appSidebarResizing.value) return
  appSidebarResizing.value = false
  document.body.style.cursor = previousBodyCursor
  document.body.style.userSelect = previousBodyUserSelect
  try { window.localStorage.setItem(APP_SIDEBAR_WIDTH_KEY, String(Math.round(appSidebarWidth.value))) } catch {}
}
// 键盘微调宽度：←/→ 步进 10px，按住 Shift 步进 50px。
function resizeAppSidebarWithKeyboard(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const delta = event.key === 'ArrowRight' ? 10 : -10
  appSidebarWidth.value = Math.min(APP_SIDEBAR_MAX_WIDTH, Math.max(APP_SIDEBAR_MIN_WIDTH, appSidebarWidth.value + delta * (event.shiftKey ? 5 : 1)))
  try { window.localStorage.setItem(APP_SIDEBAR_WIDTH_KEY, String(Math.round(appSidebarWidth.value))) } catch {}
  event.preventDefault()
}

// SSE 连接由根组件统一托管：useSSE 是模块级单例，全局只一条 EventSource，
// onMounted 建连、onUnmounted 断连。不随路由 / keep-alive 切换，根治多连接泄漏
// 与「断开→重连」toast 死循环。子组件只读 useSSE 暴露的响应式状态。
const { connect, disconnect, config } = useSSE()
const { selectedTheme, isDark } = useAppearance()

// 浏览器标签标题跟随全局配置品牌名（config_update SSE 实时推，改品牌即时生效，
// 无需重建前端）。index.html 的静态 <title> 只是配置到达前的回退。
watch(
  () => config.value?.brand_name,
  (name) => { document.title = name?.trim() || DEFAULT_BRAND_NAME },
  { immediate: true },
)

// authReady 是模块级单例，刷新后归零；根组件统一触发，保证任意路由首屏都鉴权。
const { checkAuth } = useAuth()

onMounted(() => {
  loadAppSidebarWidth()
  connect()
  checkAuth()
})
onUnmounted(disconnect)

// 主题色随外观选择联动：Naive UI 令牌与 --workflow-controller-* 变量同源，深浅由 isDark 切换。
const themeOverrides = computed(() => {
  const colors = selectedTheme.value.colors
  return {
    common: {
      primaryColor: colors.primary,
      primaryColorHover: colors.primaryHover,
      primaryColorPressed: colors.primary,
      primaryColorSuppl: colors.primary,
      successColor: '#35d6b1',
      successColorHover: '#4ce2c1',
      warningColor: '#f4b860',
      warningColorHover: '#ffc979',
      errorColor: '#ff7c86',
      errorColorHover: '#ff9ca3',
      infoColor: '#9b8cff',
      infoColorHover: '#b0a4ff',
      baseColor: colors.surface,
      cardColor: colors.card,
      modalColor: colors.modal,
      popoverColor: colors.modal,
      tableColor: colors.surface,
      bodyColor: colors.body,
      textColorBase: colors.text,
      textColor1: colors.text,
      textColor2: colors.text,
      textColor3: colors.textMuted,
      borderColor: colors.border,
      dividerColor: colors.divider,
      borderRadius: '12px',
      inputColor: colors.input,
      inputColorDisabled: colors.surface,
      inputColorActive: colors.input,
      inputTextColor: colors.text,
      placeholderColor: colors.textMuted,
      placeholderColorDisabled: colors.textMuted,
      selectOptionTextColor: colors.text,
      iconColor: colors.textMuted,
      iconColorDisabled: colors.textMuted,
      optionColorPending: colors.hover,
      optionColorActive: colors.hover,
      optionTextColor: colors.text,
      optionTextColorActive: colors.text,
      optionCheckColor: colors.primary,
    },
    InternalSelectMenu: {
      color: colors.modal,
      groupHeaderTextColor: colors.textMuted,
      actionDividerColor: colors.divider,
      optionTextColor: colors.text,
      optionTextColorPressed: colors.text,
      optionTextColorDisabled: colors.textMuted,
      optionTextColorActive: colors.text,
      optionCheckColor: colors.primary,
      optionColorPending: colors.hover,
      optionColorActive: colors.hover,
      optionColorActivePending: colors.hover,
    },
  }
})
</script>

<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN" :theme="isDark ? darkTheme : undefined" :theme-overrides="themeOverrides" class="h-full">
    <n-dialog-provider>
      <n-message-provider>
        <NaiveBridge>
          <n-layout has-sider style="height: 100%">
            <n-layout-sider
              :width="appSidebarWidth"
              :collapsed-width="0"
              collapse-mode="width"
              bordered
              style="height: 100vh; min-width:0; overflow: hidden; background:var(--workflow-controller-body)"
            >
              <AppSidebar />
            </n-layout-sider>
            <div
              class="app-sidebar-resizer"
              :class="{ resizing: appSidebarResizing }"
              role="separator"
              aria-label="调整导航栏宽度"
              aria-orientation="vertical"
              :aria-valuemin="APP_SIDEBAR_MIN_WIDTH"
              :aria-valuemax="APP_SIDEBAR_MAX_WIDTH"
              :aria-valuenow="Math.round(appSidebarWidth)"
              tabindex="0"
              @pointerdown="startAppSidebarResize"
              @pointermove="moveAppSidebarResize"
              @pointerup="finishAppSidebarResize"
              @pointercancel="finishAppSidebarResize"
              @lostpointercapture="finishAppSidebarResize"
              @keydown="resizeAppSidebarWithKeyboard"
            />
            <n-layout class="app-main-layout" style="height: 100vh; min-width:0; overflow: hidden">
              <router-view v-slot="{ Component }">
                <keep-alive :exclude="['SessionDetailView', 'RunView']">
                  <component :is="Component" />
                </keep-alive>
              </router-view>
            </n-layout>
          </n-layout>
          <SettingsModal />
        </NaiveBridge>
      </n-message-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>

<style>
html, body, #app {
  height: 100%;
  margin: 0;
  padding: 0;
  background: var(--workflow-controller-body);
  font-family: var(--workflow-controller-font-family);
  color: var(--workflow-controller-text);
  -webkit-font-smoothing: antialiased;
}
.app-main-layout { background:var(--workflow-controller-body); }
.app-sidebar-resizer { background:var(--workflow-controller-body); }
html[data-appearance-theme] .sidebar,
html[data-appearance-theme] .session-detail-shell,
html[data-appearance-theme] .app-main-layout { background:var(--workflow-controller-body) !important; color:var(--workflow-controller-text) !important; }
html[data-appearance-theme] .sidebar { color:var(--workflow-controller-text) !important; }
html[data-appearance-theme] .n-card,
html[data-appearance-theme] .n-modal .n-card,
html[data-appearance-theme] .n-modal .n-card-header,
html[data-appearance-theme] .n-modal .n-card__content { background:var(--workflow-controller-card) !important; color:var(--workflow-controller-text) !important; }
html[data-appearance-theme] .n-input,
html[data-appearance-theme] .n-base-selection { background:var(--workflow-controller-input) !important; color:var(--workflow-controller-text) !important; }
html[data-appearance-theme] .n-modal .n-card { border-color:var(--workflow-controller-border) !important; }
.app-sidebar-resizer { position:relative; z-index:2; flex:0 0 12px; width:12px; margin-left:-12px; cursor:col-resize; touch-action:none; background:transparent; user-select:none; }
.app-sidebar-resizer::before { content:""; position:absolute; top:50%; left:50%; width:1px; height:36px; border-radius:2px; background:rgba(148,163,184,.45); transform:translate(-50%,-50%); transition:height .15s ease, background-color .15s ease; }
.app-sidebar-resizer:hover::before, .app-sidebar-resizer:focus-visible::before, .app-sidebar-resizer.resizing::before { height:52px; background:#8b9cff; }
button:focus-visible, [role="button"]:focus-visible, .n-button:focus-visible { outline:2px solid var(--workflow-controller-primary); outline-offset:2px; }
.n-modal, .n-card, .n-dialog, .n-popover { color:var(--workflow-controller-text); }
.n-modal .n-card, .n-modal .n-card-header, .n-modal .n-card__content { background:var(--workflow-controller-modal) !important; color:var(--workflow-controller-text) !important; }
.n-input, .n-input-wrapper, .n-base-selection, .n-input-number, .n-input-number .n-input {
  background:var(--workflow-controller-input) !important;
  color:var(--workflow-controller-text) !important;
  border-color:var(--workflow-controller-border) !important;
  border-radius:10px !important;
  box-shadow:none !important;
}
.n-input:hover, .n-base-selection:hover, .n-input-number:hover { border-color:var(--workflow-controller-primary) !important; }
.n-input:focus-within, .n-base-selection--active, .n-input-number:focus-within { border-color:var(--workflow-controller-primary) !important; box-shadow:0 0 0 2px color-mix(in srgb, var(--workflow-controller-primary) 16%, transparent) !important; }
.n-input__input-el, .n-input__textarea-el, .n-base-selection-label, .n-base-selection-input__content { color:var(--workflow-controller-text) !important; }
.n-input__input-el, .n-input__textarea-el { background:transparent !important; }
.n-input__input-el::placeholder, .n-input__textarea-el::placeholder { color:var(--workflow-controller-text-muted) !important; }
.n-input--disabled, .n-input--disabled .n-input__input-el, .n-input--disabled .n-input__textarea-el { background:var(--workflow-controller-surface) !important; color:var(--workflow-controller-text-muted) !important; opacity:1 !important; }
.n-base-select-menu, .n-dropdown-menu, .n-select-menu {
  background:var(--workflow-controller-modal) !important;
  border-color:var(--workflow-controller-border) !important;
  --n-option-color-pending:color-mix(in srgb, var(--workflow-controller-primary) 14%, transparent) !important;
  --n-option-color-active:color-mix(in srgb, var(--workflow-controller-primary) 22%, transparent) !important;
  --n-option-text-color:var(--workflow-controller-text) !important;
  --n-option-text-color-active:var(--workflow-controller-text) !important;
  --n-option-check-color:var(--workflow-controller-primary) !important;
}
.n-base-select-option,
.n-base-select-menu .n-base-select-option,
html body div.n-base-select-menu div.n-base-select-option {
  background:var(--workflow-controller-modal) !important;
  background-color:var(--workflow-controller-modal) !important;
  color:var(--workflow-controller-text) !important;
  --n-option-color-pending:color-mix(in srgb, var(--workflow-controller-primary) 14%, transparent) !important;
  --n-option-color-active:color-mix(in srgb, var(--workflow-controller-primary) 22%, transparent) !important;
  --n-option-text-color:var(--workflow-controller-text) !important;
  --n-option-text-color-active:var(--workflow-controller-text) !important;
  --n-option-check-color:var(--workflow-controller-primary) !important;
}
.n-base-select-menu .n-base-select-option--pending,
.n-base-select-menu .n-base-select-option--selected,
.n-base-select-menu .n-base-select-option[aria-selected="true"],
.n-base-select-menu .n-base-select-option[data-selected="true"],
html body div.n-base-select-menu div.n-base-select-option.n-base-select-option--selected,
html body div.n-base-select-menu div.n-base-select-option.n-base-select-option--pending {
  background:color-mix(in srgb, var(--workflow-controller-primary) 28%, var(--workflow-controller-modal)) !important;
  background-color:color-mix(in srgb, var(--workflow-controller-primary) 28%, var(--workflow-controller-modal)) !important;
  color:var(--workflow-controller-text) !important;
}
html body div.n-base-select-menu div.n-base-select-option.n-base-select-option--selected::before,
html body div.n-base-select-menu div.n-base-select-option.n-base-select-option--pending::before {
  background:color-mix(in srgb, var(--workflow-controller-primary) 28%, var(--workflow-controller-modal)) !important;
}
.n-base-select-option__check { color:var(--workflow-controller-primary) !important; }
.n-tabs-nav--segment-type .n-tabs-rail { background:var(--workflow-controller-modal) !important; border:1px solid var(--workflow-controller-border) !important; }
.n-tabs-nav--segment-type .n-tabs-tab { color:var(--workflow-controller-text-muted) !important; }
.n-tabs-nav--segment-type .n-tabs-tab--active { background:var(--workflow-controller-surface) !important; color:var(--workflow-controller-text) !important; box-shadow:0 2px 8px color-mix(in srgb, var(--workflow-controller-body) 28%, transparent) !important; }
.n-data-table { --n-th-color:var(--workflow-controller-modal) !important; --n-th-color-hover:var(--workflow-controller-hover) !important; --n-th-color-sorting:var(--workflow-controller-hover) !important; --n-td-color:var(--workflow-controller-surface) !important; --n-td-color-hover:var(--workflow-controller-modal) !important; --n-td-color-sorting:var(--workflow-controller-modal) !important; --n-th-text-color:var(--workflow-controller-text) !important; --n-td-text-color:var(--workflow-controller-text) !important; --n-border-color:var(--workflow-controller-border) !important; --n-th-font-weight:600 !important; }
.n-data-table .n-data-table-thead, .n-data-table .n-data-table-thead th { background:var(--workflow-controller-modal) !important; color:var(--workflow-controller-text) !important; }
.n-data-table .n-data-table-tbody, .n-data-table .n-data-table-tbody td { background:var(--workflow-controller-surface) !important; color:var(--workflow-controller-text) !important; }
.n-data-table .n-data-table-tr:hover td { background:var(--workflow-controller-modal) !important; }
.n-tag.n-tag--default-type { --n-color:var(--workflow-controller-modal) !important; --n-text-color:var(--workflow-controller-text) !important; --n-border:1px solid var(--workflow-controller-border) !important; }
.provider-runtime-tag { background:var(--workflow-controller-modal) !important; color:var(--workflow-controller-text) !important; border:1px solid var(--workflow-controller-border) !important; }
.n-modal [style*="#171717"], .n-modal [style*="#2e2e2e"], .n-modal [style*="#6f6f6f"] { color:var(--workflow-controller-text-muted) !important; }
html body .n-modal [style*="171717"], html body .n-modal [style*="2e2e2e"], html body .n-modal [style*="6f6f6f"] { color:var(--workflow-controller-text-muted) !important; }
.n-modal .n-base-selection, .n-modal .n-input, .n-modal .n-input-wrapper, .n-modal .n-input-number { border:1px solid var(--workflow-controller-border) !important; }
.n-modal small { color:var(--workflow-controller-text-muted) !important; }
.n-input-number .n-button { background:var(--workflow-controller-modal) !important; color:var(--workflow-controller-text) !important; border-color:var(--workflow-controller-border) !important; }

/* 浅色主题补全：部分旧视图带深色日志/导航样式，需要显式恢复浅色对比度。 */
html[data-appearance-theme$="-light"] .sidebar,
html[data-appearance-theme="cappuccin-latte"] .sidebar { background:var(--workflow-controller-surface) !important; border-right-color:var(--workflow-controller-border) !important; }
html[data-appearance-theme$="-light"] .sidebar-title,
html[data-appearance-theme$="-light"] .section-label,
html[data-appearance-theme$="-light"] .project-row,
html[data-appearance-theme$="-light"] .project-row.active,
html[data-appearance-theme$="-light"] .project-session-row,
html[data-appearance-theme$="-light"] .project-session-row.active,
html[data-appearance-theme$="-light"] .settings-btn,
html[data-appearance-theme="cappuccin-latte"] .sidebar-title,
html[data-appearance-theme="cappuccin-latte"] .section-label,
html[data-appearance-theme="cappuccin-latte"] .project-row,
html[data-appearance-theme="cappuccin-latte"] .project-row.active,
html[data-appearance-theme="cappuccin-latte"] .project-session-row,
html[data-appearance-theme="cappuccin-latte"] .project-session-row.active,
html[data-appearance-theme="cappuccin-latte"] .settings-btn { color:var(--workflow-controller-text) !important; }
html[data-appearance-theme$="-light"] .project-folder-icon,
html[data-appearance-theme="cappuccin-latte"] .project-folder-icon { color:var(--workflow-controller-text-muted) !important; }
html[data-appearance-theme$="-light"] .sidebar-footer,
html[data-appearance-theme="cappuccin-latte"] .sidebar-footer { border-top-color:var(--workflow-controller-divider) !important; }
html[data-appearance-theme$="-light"] .session-detail-shell .vlog,
html[data-appearance-theme$="-light"] .session-detail-shell .tool-block,
html[data-appearance-theme$="-light"] .session-detail-shell .tool-block-title,
html[data-appearance-theme$="-light"] .session-detail-shell .cls-thinking,
html[data-appearance-theme$="-light"] .session-detail-shell .cls-result,
html[data-appearance-theme$="-light"] .session-detail-shell .cls-system,
html[data-appearance-theme$="-light"] .session-detail-shell .cls-tool-arg,
html[data-appearance-theme$="-light"] .session-detail-shell .tool-heading,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .vlog,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .tool-block,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .tool-block-title,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .cls-thinking,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .cls-result,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .cls-system,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .cls-tool-arg,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .tool-heading { color:var(--workflow-controller-text) !important; }
html[data-appearance-theme$="-light"] .session-detail-shell .cls-user,
html[data-appearance-theme$="-light"] .session-detail-shell .cls-thinking-active,
html[data-appearance-theme$="-light"] .session-detail-shell .tool-summary-active .tool-heading,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .cls-user,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .cls-thinking-active,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .tool-summary-active .tool-heading { color:var(--workflow-controller-text) !important; }
html[data-appearance-theme$="-light"] .session-detail-shell .tool-block-body,
html[data-appearance-theme$="-light"] .session-detail-shell .vlog-line.cls-tool,
html[data-appearance-theme$="-light"] .session-detail-shell .vlog-line.cls-result,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .tool-block-body,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .vlog-line.cls-tool,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .vlog-line.cls-result { background:var(--workflow-controller-surface) !important; color:var(--workflow-controller-text) !important; border-color:var(--workflow-controller-border) !important; }
html[data-appearance-theme$="-light"] .session-detail-shell .n-card-header__main,
html[data-appearance-theme$="-light"] .session-detail-shell .session-meta-stats span,
html[data-appearance-theme$="-light"] .session-detail-shell .session-meta-stats strong,
html[data-appearance-theme$="-light"] .session-detail-shell .context-breakdown,
html[data-appearance-theme$="-light"] .session-detail-shell .context-breakdown-used,
html[data-appearance-theme$="-light"] .session-detail-shell .context-breakdown-pct,
html[data-appearance-theme$="-light"] .session-detail-shell .context-history-heading,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .n-card-header__main,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .session-meta-stats span,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .session-meta-stats strong,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .context-breakdown,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .context-breakdown-used,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .context-breakdown-pct,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .context-history-heading { color:var(--workflow-controller-text) !important; }
html[data-appearance-theme$="-light"] .session-detail-shell .context-breakdown-total,
html[data-appearance-theme$="-light"] .session-detail-shell .context-breakdown-label,
html[data-appearance-theme$="-light"] .session-detail-shell .context-breakdown-value,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .context-breakdown-total,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .context-breakdown-label,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .context-breakdown-value { color:var(--workflow-controller-text-muted) !important; }
html[data-appearance-theme$="-light"] .session-detail-shell .agent-detail-title,
html[data-appearance-theme$="-light"] .session-detail-shell .agent-detail-stats,
html[data-appearance-theme$="-light"] .session-detail-shell .agent-detail-prompt,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .agent-detail-title,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .agent-detail-stats,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .agent-detail-prompt { color:var(--workflow-controller-text) !important; background:var(--workflow-controller-surface) !important; }
html[data-appearance-theme$="-light"] .session-detail-shell .tool-block-result,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .tool-block-result { background:var(--workflow-controller-surface) !important; color:var(--workflow-controller-tool-result-text) !important; border-top-color:var(--workflow-controller-border) !important; }
html[data-appearance-theme$="-light"] .session-detail-shell .tool-block-command,
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell .tool-block-command { background:var(--workflow-controller-tool-command-bg) !important; color:var(--workflow-controller-tool-command-text) !important; }
html[data-appearance-theme$="-light"] .session-detail-shell [style*="#6f6f6f"],
html[data-appearance-theme$="-light"] .session-detail-shell [style*="#8f8f8f"],
html[data-appearance-theme$="-light"] .session-detail-shell [style*="#cbd5e1"],
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell [style*="#6f6f6f"],
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell [style*="#8f8f8f"],
html[data-appearance-theme="cappuccin-latte"] .session-detail-shell [style*="#cbd5e1"] { color:var(--workflow-controller-text-muted) !important; }
html[data-appearance-theme$="-light"] .file-preview-dialog,
html[data-appearance-theme="cappuccin-latte"] .file-preview-dialog { background:var(--workflow-controller-modal) !important; color:var(--workflow-controller-text) !important; }
.n-switch { --n-box-shadow-focus:0 0 0 2px rgba(124,140,255,.18) !important; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
</style>
