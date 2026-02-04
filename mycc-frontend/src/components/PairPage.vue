<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  paired: [token: string, tunnelUrl: string]
}>()

const connectionCode = ref('')
const pairCode = ref('')
const isLoading = ref(false)
const errorMessage = ref('')

async function handlePair() {
  if (!connectionCode.value || !pairCode.value) {
    errorMessage.value = '请填写连接码和配对码'
    return
  }

  isLoading.value = true
  errorMessage.value = ''

  try {
    // 通过 mycc.dev API 获取 tunnel URL
    const infoResponse = await fetch(`https://api.mycc.dev/info/${connectionCode.value}`)
    if (!infoResponse.ok) {
      throw new Error('连接码无效')
    }
    const infoData = await infoResponse.json()

    if (infoData.error) {
      throw new Error(infoData.error)
    }

    const tunnelUrl = infoData.tunnelUrl
    if (!tunnelUrl) {
      throw new Error('无法获取服务器地址')
    }

    // 发送配对请求到本地 tunnel
    const pairResponse = await fetch(`${tunnelUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairCode: pairCode.value,
      })
    })

    if (!pairResponse.ok) {
      throw new Error('配对失败')
    }

    const pairData = await pairResponse.json()
    if (pairData.error) {
      throw new Error(pairData.error)
    }

    if (!pairData.success || !pairData.token) {
      throw new Error('配对响应无效')
    }

    emit('paired', pairData.token, tunnelUrl)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '配对失败，请重试'
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <div class="w-full max-w-md space-y-8">
      <!-- Logo -->
      <div class="text-center">
        <h1 class="text-4xl font-bold text-white">mycc</h1>
        <p class="mt-2 text-slate-400">在手机上使用 Claude Code</p>
      </div>

      <!-- 配对表单 -->
      <div class="space-y-6 rounded-xl bg-slate-900/50 p-8 backdrop-blur">
        <div class="space-y-2">
          <label class="text-sm font-medium text-slate-300">连接码</label>
          <input
            v-model="connectionCode"
            type="text"
            placeholder="输入连接码"
            class="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            :disabled="isLoading"
          />
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium text-slate-300">配对码</label>
          <input
            v-model="pairCode"
            type="text"
            placeholder="输入配对码"
            class="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            :disabled="isLoading"
          />
        </div>

        <!-- 错误提示 -->
        <div v-if="errorMessage" class="rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
          {{ errorMessage }}
        </div>

        <!-- 提交按钮 -->
        <button
          @click="handlePair"
          :disabled="isLoading"
          class="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ isLoading ? '配对中...' : '配对' }}
        </button>
      </div>

      <!-- 说明 -->
      <div class="text-center text-sm text-slate-500">
        <p>请在电脑上运行 /mycc 获取连接码和配对码</p>
      </div>
    </div>
  </div>
</template>
