<script setup lang="ts">
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

// agent_traceback plugin — 统一「删除会话」确认弹窗。
// 按 session 来源（普通 / 重建 / fork 三态）动态渲染差异化文案 + 选项。
// 普通 session 也复用，保证体验一致。
//
// 选项：
// - 「清理重建产物」（仅「重建」态显示）：单选 Workflow Controller 子集 / 整个 target_cwd
//   （后者需二次输入目录名确认，防误删）。
//
// 确认时 emit('confirm', { clean_reconstruct })，由调用方调 removeSession。
import { computed, ref, watch } from 'vue'
import {
  NModal, NButton, NCheckbox, NRadioGroup, NRadio, NSpin, NInput, NAlert, useMessage,
} from 'naive-ui'
import type { SessionInfo } from '../../types/api'
import { classifyForDelete } from './deleteState'

const props = defineProps<{
  show: boolean
  session: SessionInfo | null
  /** 删除进行中（父组件控制：提交 true、完成 false）。弹窗 loading + 禁用关闭。 */
  loading?: boolean
}>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'confirm', payload: {
    clean_reconstruct: 'workflow_controller' | 'all' | undefined
  }): void
}>()

const message = useMessage()

const state = computed(() =>
  props.session ? classifyForDelete(props.session) : null,
)

// 选项状态（每次打开重置）
const cleanReconstructEnabled = ref(false)
const reconstructScope = ref<'workflow_controller' | 'all'>('workflow_controller')
const targetCwdConfirm = ref('')

// loading 透传
const submitting = computed(() => !!props.loading)

watch(() => props.show, (open) => {
  if (open) {
    cleanReconstructEnabled.value = false
    reconstructScope.value = 'workflow_controller'
    targetCwdConfirm.value = ''
  }
})

const isReconstruct = computed(() => state.value?.kind === 'reconstruct')
const isFork = computed(() => state.value?.kind === 'fork')
const targetCwdName = computed(() => {
  const p = state.value?.birth?.fork_cwd || ''
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] || p
})
// 「整个 target_cwd」需二次输入目录名（与 GitHub 删 repo 一致，防误删）
const aggressiveUnlocked = computed(() =>
  reconstructScope.value === 'all' && targetCwdConfirm.value.trim() === targetCwdName.value,
)

function close() {
  if (submitting.value) return
  emit('update:show', false)
}

function onConfirm() {
  if (isReconstruct.value && cleanReconstructEnabled.value
      && reconstructScope.value === 'all' && !aggressiveUnlocked.value) {
    message.warning(`请输入目录名 ${targetCwdName.value} 以确认整目录删除`)
    return
  }
  let clean_reconstruct: 'workflow_controller' | 'all' | undefined
  if (isReconstruct.value && cleanReconstructEnabled.value) {
    clean_reconstruct = reconstructScope.value
  }
  emit('confirm', { clean_reconstruct })
}
</script>

<template>
  <n-modal
    :show="show"
    @update:show="$emit('update:show', $event)"
    preset="card"
    :title="`删除会话：${session?.name || ''}`"
    style="width:520px"
    :mask-closable="!submitting"
    :closable="!submitting"
  >
    <n-spin :show="submitting">
      <div style="display:flex;flex-direction:column;gap:12px">
        <!-- 三态文案 -->
        <n-alert v-if="state?.kind === 'normal'" type="info" :bordered="false">
          该会话及其事件记录将被删除。
        </n-alert>
        <n-alert v-else-if="isReconstruct" type="warning" :bordered="false">
          这是从 db 重建的会话。删除后将移除事件记录；磁盘上的重建产物默认保留，可选清理。
        </n-alert>
        <n-alert v-else-if="isFork" type="warning" :bordered="false">
          这是重放产生的派生会话。删除将一并清理其隔离工作目录（~2GB 临时目录）。原会话不受影响。
        </n-alert>

        <!-- 运行态提示 -->
        <n-alert v-if="session?.state === 'running'" type="info" :bordered="false">
          会话正在运行，删除将先停止其 worker 进程。
        </n-alert>

        <!-- 重建产物清理选项 -->
        <template v-if="isReconstruct">
          <n-checkbox v-model:checked="cleanReconstructEnabled" :disabled="submitting">
            清理重建产物
          </n-checkbox>
          <div v-if="cleanReconstructEnabled" style="padding-left:24px;display:flex;flex-direction:column;gap:8px">
            <n-radio-group v-model:value="reconstructScope" :disabled="submitting">
              <n-radio value="workflow_controller">仅 Workflow Controller 产物（保留重建前已有的 .git/.opencode）</n-radio>
              <n-radio value="all">整个 target_cwd 目录（慎选，不可恢复）</n-radio>
            </n-radio-group>
            <template v-if="reconstructScope === 'all'">
              <n-input
                v-model:value="targetCwdConfirm"
                :placeholder="`输入目录名 ${targetCwdName} 以确认`"
                :disabled="submitting"
                :input-props="{ spellcheck: false }"
              />
              <small style="color:#d03050">
                将删除整个目录（含你在其中新增的任何文件），不可恢复。
              </small>
            </template>
          </div>
        </template>
      </div>
    </n-spin>

    <template #footer>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <n-button :disabled="submitting" @click="close">取消</n-button>
        <n-button
          type="error"
          :loading="submitting"
          :disabled="
            (isReconstruct && cleanReconstructEnabled && reconstructScope === 'all' && !aggressiveUnlocked)
          "
          @click="onConfirm"
        >
          确认删除
        </n-button>
      </div>
    </template>
  </n-modal>
</template>
