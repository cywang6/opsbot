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
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSettingsModal } from '../composables/useSettingsModal'

const route = useRoute()
const router = useRouter()
const { open } = useSettingsModal()

onMounted(() => {
  const section = route.query.section as string | undefined
  open(section || '全局设置')
  router.replace('/')
})
</script>

<template>
  <div />
</template>
