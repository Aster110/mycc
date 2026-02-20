<script setup lang="ts">
import { ref, onMounted } from 'vue'
import PairPage from './components/PairPage.vue'
import ChatPage from './components/ChatPage.vue'

const isPaired = ref(false)
const authToken = ref('')
const tunnelUrl = ref('')

// 检查本地存储的配对状态
onMounted(() => {
  const savedToken = localStorage.getItem('mycc_auth_token')
  const savedTunnelUrl = localStorage.getItem('mycc_tunnel_url')
  if (savedToken && savedTunnelUrl) {
    authToken.value = savedToken
    tunnelUrl.value = savedTunnelUrl
    isPaired.value = true
  }
})

function handlePairSuccess(token: string, url: string) {
  authToken.value = token
  tunnelUrl.value = url
  isPaired.value = true
  localStorage.setItem('mycc_auth_token', token)
  localStorage.setItem('mycc_tunnel_url', url)
}

function handleUnpair() {
  isPaired.value = false
  authToken.value = ''
  tunnelUrl.value = ''
  localStorage.removeItem('mycc_auth_token')
  localStorage.removeItem('mycc_tunnel_url')
}
</script>

<template>
  <div class="min-h-screen bg-gradient-to-br from-slate-950 to-slate-900">
    <PairPage v-if="!isPaired" @paired="handlePairSuccess" />
    <ChatPage
      v-else
      :auth-token="authToken"
      :tunnel-url="tunnelUrl"
      @unpair="handleUnpair"
    />
  </div>
</template>
