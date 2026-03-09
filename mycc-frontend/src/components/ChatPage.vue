<script setup lang="ts">
import { ref, onMounted, computed, nextTick, watch } from 'vue'
import { Send, Plus, LogOut, MessageSquare, Settings, ChevronLeft, Terminal, FileEdit, Search, ChevronDown, ChevronRight, Sun, Moon, Menu, X } from 'lucide-vue-next'

const props = defineProps<{
  authToken: string
  tunnelUrl: string
}>()

const emit = defineEmits<{
  unpair: []
}>()

interface ToolUse {
  name: string
  input?: any
  output?: string
  status?: 'running' | 'success' | 'error'
  expanded?: boolean
}

interface Message {
  type: 'user' | 'assistant' | 'system' | 'result'
  message?: {
    role?: string
    content?: string | Array<{ type: string; text?: string; tool_use_id?: string; name?: string; input?: any; content?: string; is_error?: boolean }>
    id?: string
  }
  sessionId?: string
  timestamp?: string
  uuid?: string
  _displayContent?: string
  _toolUses?: ToolUse[]
}

interface ConversationSummary {
  sessionId: string
  startTime: string
  lastTime: string
  messageCount: number
  lastMessagePreview: string
}

interface ConversationHistory {
  sessionId: string
  messages: Message[]
}

const sessions = ref<ConversationSummary[]>([])
const currentSessionId = ref('')
const messages = ref<Message[]>([])
const inputMessage = ref('')
const isLoading = ref(false)
const isLoadingHistory = ref(false)
const isSidebarOpen = ref(true)
const messagesContainer = ref<HTMLElement>()
const isDark = ref(true)
const isMobile = ref(false)

// 检测是否为移动端
function checkMobile() {
  isMobile.value = window.innerWidth < 768
  // 移动端默认关闭侧边栏
  if (isMobile.value) {
    isSidebarOpen.value = false
  }
}

// 监听窗口大小变化
onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})

// 思考动画文字
const thinkingWords = ['thinking', 'baking', 'wandering', 'revealing', 'ideating', 'dreaming', 'crafting', 'pondering']
const currentThinkingWord = ref(0)
let thinkingInterval: ReturnType<typeof setInterval> | null = null

// 当前会话
const currentSession = computed(() => {
  return sessions.value.find(s => s.sessionId === currentSessionId.value)
})

// 监听 loading 状态，启动/停止思考动画
watch(isLoading, (loading) => {
  if (loading) {
    thinkingInterval = setInterval(() => {
      currentThinkingWord.value = (currentThinkingWord.value + 1) % thinkingWords.length
    }, 200)
  } else {
    if (thinkingInterval) {
      clearInterval(thinkingInterval)
      thinkingInterval = null
    }
    currentThinkingWord.value = 0
  }
})

// 获取当前动画文字
const currentThinkingText = computed(() => thinkingWords[currentThinkingWord.value])

// 加载历史会话列表
onMounted(async () => {
  // 从 localStorage 加载主题设置
  const savedTheme = localStorage.getItem('mycc_theme')
  if (savedTheme === 'light') {
    isDark.value = false
  }
  await loadSessions()
})

async function loadSessions() {
  isLoadingHistory.value = true
  try {
    const response = await fetch(`${props.tunnelUrl}/history/list`, {
      headers: {
        'Authorization': `Bearer ${props.authToken}`
      }
    })

    if (!response.ok) {
      throw new Error('获取会话列表失败')
    }

    const data = await response.json()
    if (data.conversations && data.conversations.length > 0) {
      sessions.value = data.conversations
      const latest = sessions.value[0]
      if (latest) {
        currentSessionId.value = latest.sessionId
        await loadSessionDetail(latest.sessionId)
      }
    } else {
      createNewSession()
    }
  } catch (error) {
    console.error('加载会话列表失败:', error)
    createNewSession()
  } finally {
    isLoadingHistory.value = false
  }
}

async function loadSessionDetail(sessionId: string) {
  try {
    const response = await fetch(`${props.tunnelUrl}/history/${sessionId}`, {
      headers: {
        'Authorization': `Bearer ${props.authToken}`
      }
    })

    if (!response.ok) {
      throw new Error('获取对话详情失败')
    }

    const data: ConversationHistory = await response.json()
    messages.value = (data.messages || []).map(msg => parseMessage(msg))
    nextTick(() => {
      scrollToBottom()
    })
  } catch (error) {
    console.error('加载对话详情失败:', error)
    messages.value = []
  }
}

function createNewSession() {
  currentSessionId.value = ''
  messages.value = []
}

function selectSession(sessionId: string) {
  currentSessionId.value = sessionId
  loadSessionDetail(sessionId)
  // 移动端选择会话后关闭侧边栏
  if (isMobile.value) {
    isSidebarOpen.value = false
  }
}

// 解析消息，提取工具调用
function parseMessage(msg: Message): Message {
  const content = msg.message?.content
  const toolUses: ToolUse[] = []

  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'tool_use' && item.name) {
        toolUses.push({
          name: item.name,
          input: item.input,
          status: 'success',
          expanded: false
        })
      } else if (item.type === 'text' && item.tool_use_id) {
        const relatedTool = toolUses.find(t => t.input?.tool_use_id === item.tool_use_id)
        if (relatedTool) {
          relatedTool.output = item.content
          relatedTool.status = item.is_error ? 'error' : 'success'
        }
      }
    }
  }

  return {
    ...msg,
    _displayContent: getMessageContentRaw(msg),
    _toolUses: toolUses
  }
}

async function sendMessage() {
  if (!inputMessage.value.trim() || isLoading.value) return

  const userMessage = inputMessage.value
  inputMessage.value = ''
  isLoading.value = true

  const userMsg: Message = {
    type: 'user',
    sessionId: currentSessionId.value || '',
    timestamp: new Date().toISOString(),
    uuid: '',
    message: {
      role: 'user',
      content: userMessage
    },
    _displayContent: userMessage
  }
  messages.value.push(userMsg)

  scrollToBottom()

  const assistantIndex = messages.value.length
  const assistantMsg: Message = {
    type: 'assistant',
    sessionId: currentSessionId.value || '',
    timestamp: new Date().toISOString(),
    uuid: '',
    message: {
      content: ''
    },
    _displayContent: '',
    _toolUses: []
  }
  messages.value.push(assistantMsg)

  try {
    const response = await fetch(`${props.tunnelUrl}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${props.authToken}`
      },
      body: JSON.stringify({
        message: userMessage,
        sessionId: currentSessionId.value || undefined,
      })
    })

    if (!response.ok) {
      throw new Error('发送消息失败')
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应')

    const decoder = new TextDecoder()
    let assistantContent = ''
    let currentToolUse: ToolUse | null = null
    const toolUses: ToolUse[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')

      for (const line of lines) {
        const trimmedLine = line.trim()
        if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue

        try {
          const data = JSON.parse(trimmedLine.slice(6))
          console.log('[SSE]', data)

          if (data.type === 'system' && data.session_id) {
            currentSessionId.value = data.session_id
          } else if (data.type === 'content') {
            if (typeof data.content === 'string') {
              assistantContent += data.content
            }
          } else if (data.type === 'result') {
            if (currentToolUse) {
              currentToolUse.output = String(data.content || '')
              currentToolUse.status = data.is_error ? 'error' : 'success'
              currentToolUse = null
            }
          } else if (data.toolUse) {
            console.log('[SSE] 工具调用:', data.toolUse.name)
            currentToolUse = {
              name: data.toolUse.name,
              input: data.toolUse.input,
              status: 'running',
              expanded: true
            }
            toolUses.push(currentToolUse)
            console.log('[SSE] 当前工具数量:', toolUses.length)
          } else if (data.type === 'done') {
            console.log('[SSE] 对话完成')
            await loadSessions()
          }

          // 更新消息 - 深拷贝 toolUses 确保响应式
          const updatedMsg: Message = {
            type: 'assistant',
            sessionId: currentSessionId.value || '',
            timestamp: new Date().toISOString(),
            uuid: '',
            message: {
              content: assistantContent
            },
            _displayContent: assistantContent,
            _toolUses: toolUses.map(t => ({ ...t })) // 深拷贝每个工具对象
          }
          messages.value[assistantIndex] = { ...updatedMsg }

          // 强制触发响应式更新
          messages.value = [...messages.value]

          scrollToBottom()
        } catch (e) {
          console.error('[SSE] 解析错误:', e, trimmedLine)
        }
      }
    }
  } catch (error) {
    console.error('[Chat] 错误:', error)
    const errorMsg: Message = {
      type: 'system',
      timestamp: new Date().toISOString(),
      uuid: '',
      _displayContent: `错误: ${error instanceof Error ? error.message : '发送失败'}`
    }
    if (messages.value.length > 0) {
      messages.value[messages.value.length - 1] = errorMsg as Message
    }
  } finally {
    isLoading.value = false
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

function formatTime(timestamp: string) {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))

  if (hours < 1) return '刚刚'
  if (hours < 24) return `${hours}小时前`
  if (hours < 24 * 7) return `${Math.floor(hours / 24)}天前`
  return date.toLocaleDateString()
}

function getMessageContentRaw(msg: Message): string {
  if (!msg.message?.content) return ''

  const content = msg.message.content
  if (typeof content === 'string') {
    return content.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim()
  }
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const item of content) {
      if (item.type === 'text' && item.text) {
        texts.push(item.text)
      }
    }
    return texts.join('').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim()
  }
  return ''
}

function getDisplayContent(msg: Message): string {
  if (msg._displayContent !== undefined) {
    return msg._displayContent
  }
  return getMessageContentRaw(msg)
}

function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase()
  if (name.includes('bash') || name.includes('command') || name.includes('shell') || name.includes('execute')) {
    return Terminal
  }
  if (name.includes('edit') || name.includes('write') || name.includes('create') || name.includes('file')) {
    return FileEdit
  }
  if (name.includes('search') || name.includes('grep') || name.includes('find') || name.includes('read')) {
    return Search
  }
  return Terminal
}

function getToolStatusColor(status?: string) {
  if (status === 'running') {
    return isDark.value
      ? 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10'
      : 'text-yellow-700 border-yellow-300 bg-yellow-50'
  }
  if (status === 'error') {
    return isDark.value
      ? 'text-red-400 border-red-400/30 bg-red-400/10'
      : 'text-red-700 border-red-300 bg-red-50'
  }
  return isDark.value
    ? 'text-green-400 border-green-400/30 bg-green-400/10'
    : 'text-green-700 border-green-300 bg-green-50'
}

function toggleToolExpand(msg: Message, toolIndex: number) {
  if (msg._toolUses && msg._toolUses[toolIndex]) {
    msg._toolUses[toolIndex].expanded = !msg._toolUses[toolIndex].expanded
  }
}

async function handleUnpair() {
  if (confirm('确定要解除配对吗？这将清除所有本地对话记录。')) {
    localStorage.removeItem('mycc_auth_token')
    localStorage.removeItem('mycc_tunnel_url')
    emit('unpair')
  }
}

function showSettings() {
  if (confirm('要更换连接吗？这将清除当前配对。')) {
    handleUnpair()
  }
}

function toggleTheme() {
  isDark.value = !isDark.value
  localStorage.setItem('mycc_theme', isDark.value ? 'dark' : 'light')
}

function hasContent(msg: Message): boolean {
  const content = getDisplayContent(msg).trim()
  const hasTools = Boolean(msg._toolUses && msg._toolUses.length > 0)
  return content.length > 0 || hasTools
}
</script>

<template>
  <div :class="['flex h-screen overflow-hidden', isDark ? 'bg-slate-950' : 'bg-gray-50']">
    <!-- 移动端遮罩层 -->
    <div
      v-if="isMobile && isSidebarOpen"
      @click="isSidebarOpen = false"
      class="fixed inset-0 bg-black/50 z-40 md:hidden"
    ></div>

    <!-- 侧边栏 -->
    <div
      :class="[
        'flex flex-col border-r transition-all duration-300 z-50',
        isDark ? 'border-slate-800 bg-slate-900/50' : 'border-gray-200 bg-white/80',
        isMobile ? 'fixed inset-y-0 left-0 shadow-2xl' : 'relative',
        isSidebarOpen ? (isMobile ? 'w-80' : 'w-72') : (isMobile ? '-translate-x-full' : 'w-0')
      ]"
    >
      <div :class="['flex items-center justify-between border-b p-4', isDark ? 'border-slate-800' : 'border-gray-200']">
        <div class="flex items-center gap-2">
          <MessageSquare :size="20" :class="isDark ? 'text-blue-400' : 'text-blue-600'" />
          <h1 :class="['font-bold', isDark ? 'text-white' : 'text-gray-900']">mycc</h1>
        </div>
        <div class="flex items-center gap-1">
          <!-- 移动端关闭按钮 -->
          <button
            v-if="isMobile"
            @click="isSidebarOpen = false"
            class="rounded-lg p-2 transition"
            :class="isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'"
          >
            <X :size="20" />
          </button>
          <button
            @click="toggleTheme"
            class="rounded-lg p-2 transition"
            :class="isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'"
            :title="isDark ? '切换到亮色模式' : '切换到暗色模式'"
          >
            <Sun v-if="isDark" :size="18" />
            <Moon v-else :size="18" />
          </button>
          <button
            @click="showSettings"
            class="rounded-lg p-2 transition"
            :class="isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'"
            title="设置"
          >
            <Settings :size="18" />
          </button>
        </div>
      </div>

      <div class="p-3">
        <button
          @click="createNewSession"
          :class="[
            'flex w-full items-center gap-2 rounded-lg border border-dashed px-4 py-3 transition',
            isDark
              ? 'border-slate-700 text-slate-400 hover:border-slate-600 hover:text-white'
              : 'border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-900'
          ]"
        >
          <Plus :size="18" />
          <span>新建对话</span>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-3 pb-3">
        <div v-if="isLoadingHistory" :class="['text-center py-8', isDark ? 'text-slate-500' : 'text-gray-500']">
          <p>加载中...</p>
        </div>
        <div v-else class="space-y-1">
          <div
            v-for="session in sessions"
            :key="session.sessionId"
            @click="selectSession(session.sessionId)"
            :class="[
              'cursor-pointer rounded-lg px-4 py-3 transition',
              currentSessionId === session.sessionId
                ? (isDark ? 'bg-slate-800 text-white' : 'bg-blue-50 text-gray-900')
                : (isDark ? 'text-slate-400 hover:bg-slate-800/50 hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')
            ]"
          >
            <div class="flex items-center justify-between">
              <span class="truncate text-sm font-medium">
                {{ session.lastMessagePreview || '(空对话)' }}
              </span>
            </div>
            <div :class="['mt-1 text-xs', isDark ? 'text-slate-500' : 'text-gray-500']">
              {{ formatTime(session.lastTime) }} · {{ session.messageCount }} 条消息
            </div>
          </div>
        </div>
      </div>

      <div :class="['border-t p-4', isDark ? 'border-slate-800' : 'border-gray-200']">
        <button
          @click="handleUnpair"
          :class="[
            'flex w-full items-center gap-2 rounded-lg px-3 py-2 transition',
            isDark
              ? 'text-slate-400 hover:bg-slate-800 hover:text-red-400'
              : 'text-gray-600 hover:bg-gray-100 hover:text-red-600'
          ]"
        >
          <LogOut :size="18" />
          <span class="text-sm">解除配对</span>
        </button>
      </div>
    </div>

    <!-- 主内容区 -->
    <div class="flex flex-1 flex-col min-w-0">
      <div :class="['flex items-center border-b px-4 py-3 gap-2', isDark ? 'border-slate-800 bg-slate-900/50' : 'border-gray-200 bg-white/80']">
        <!-- 移动端菜单按钮 -->
        <button
          @click="isSidebarOpen = true"
          :class="[
            'rounded-lg p-2 transition md:hidden',
            isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
          ]"
        >
          <Menu :size="20" />
        </button>
        <!-- 桌面端侧边栏切换按钮 -->
        <button
          v-if="!isSidebarOpen && !isMobile"
          @click="isSidebarOpen = true"
          :class="[
            'rounded-lg p-2 transition hidden md:block',
            isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
          ]"
        >
          <ChevronLeft :size="20" />
        </button>
        <div class="flex-1 min-w-0">
          <h2 :class="['text-sm font-medium truncate', isDark ? 'text-white' : 'text-gray-900']">
            {{ currentSession?.lastMessagePreview || '新对话' }}
          </h2>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span class="h-2 w-2 rounded-full" :class="isLoading ? 'bg-yellow-500 animate-pulse' : 'bg-green-500'"></span>
          <span :class="['text-sm hidden sm:inline', isDark ? 'text-slate-400' : 'text-gray-600']">
            <template v-if="isLoading">
              <span class="inline-block w-16 text-center">{{ currentThinkingText }}</span>
              <span class="animate-pulse">...</span>
            </template>
            <template v-else>已连接</template>
          </span>
        </div>
      </div>

      <!-- 消息区域 -->
      <div
        ref="messagesContainer"
        class="flex-1 overflow-y-auto p-4"
      >
        <div v-if="messages.length === 0" class="flex h-full items-center justify-center">
          <div :class="['text-center', isDark ? 'text-slate-500' : 'text-gray-500']">
            <MessageSquare :size="48" class="mx-auto mb-4 opacity-50" />
            <p class="text-lg">开始新对话</p>
            <p class="mt-2 text-sm">在下方输入消息与 Claude 对话</p>
          </div>
        </div>

        <div v-else class="space-y-4">
          <div
            v-for="(msg, index) in messages"
            :key="msg.uuid || index"
            v-show="(msg.type === 'user' || msg.type === 'assistant') && (hasContent(msg) || (msg.type === 'assistant' && isLoading && index === messages.length - 1))"
            :class="[
              'flex flex-col',
              msg.type === 'user' ? 'items-end' : 'items-start'
            ]"
          >
            <!-- 消息内容 -->
            <div
              v-if="getDisplayContent(msg).trim()"
              :class="[
                'rounded-2xl px-4 py-3 sm:px-5 sm:max-w-[85%] max-w-[95%]',
                msg.type === 'user'
                  ? 'bg-blue-600 text-white'
                  : (isDark ? 'bg-slate-800 text-slate-100' : 'bg-white text-gray-900 shadow-sm border border-gray-200')
              ]"
            >
              <div class="whitespace-pre-wrap break-words text-sm sm:text-base">{{ getDisplayContent(msg) }}</div>
            </div>

            <!-- 思考中指示器 -->
            <div
              v-else-if="msg.type === 'assistant' && isLoading && index === messages.length - 1 && !hasContent(msg)"
              :class="[
                'rounded-2xl px-4 py-3 sm:px-5 sm:max-w-[85%] max-w-[95%]',
                isDark ? 'bg-slate-800 text-slate-100' : 'bg-white text-gray-900 shadow-sm border border-gray-200'
              ]"
            >
              <div class="flex items-center gap-2">
                <span class="text-sm font-mono">{{ currentThinkingText }}</span>
                <span class="animate-pulse">...</span>
              </div>
            </div>

            <!-- 工具调用标签 -->
            <div v-if="msg._toolUses && msg._toolUses.length > 0" class="mt-2 space-y-2">
              <div
                v-for="(tool, idx) in msg._toolUses"
                :key="idx"
                :class="[
                  'rounded-lg border text-sm cursor-pointer transition-all sm:max-w-[85%] max-w-[95%]',
                  getToolStatusColor(tool.status)
                ]"
                @click="toggleToolExpand(msg, idx)"
              >
                <div class="flex items-center gap-2 px-3 py-2">
                  <component :is="getToolIcon(tool.name)" :size="16" />
                  <span class="font-medium">{{ tool.name }}</span>
                  <span v-if="tool.status === 'running'" class="animate-pulse">运行中...</span>
                  <component
                    :is="tool.expanded ? ChevronDown : ChevronRight"
                    :size="14"
                    class="ml-auto"
                  />
                </div>
                <!-- 展开的工具详情 -->
                <div v-if="tool.expanded" class="border-t border-current/20 px-3 py-2 mt-2 space-y-2">
                  <div v-if="tool.input" class="text-xs opacity-75">
                    <div class="font-medium mb-1">输入：</div>
                    <pre class="whitespace-pre-wrap break-all">{{ JSON.stringify(tool.input, null, 2) }}</pre>
                  </div>
                  <div v-if="tool.output" class="text-xs opacity-75">
                    <div class="font-medium mb-1">输出：</div>
                    <div class="whitespace-pre-wrap break-all">{{ tool.output }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 输入区域 -->
      <div :class="['border-t p-3 sm:p-4', isDark ? 'border-slate-800 bg-slate-900/50' : 'border-gray-200 bg-white/80']">
        <div class="flex gap-2 sm:gap-3">
          <input
            v-model="inputMessage"
            type="text"
            placeholder="输入消息... (Enter 发送)"
            :class="[
              'flex-1 rounded-lg border px-3 py-2 sm:px-4 sm:py-3 text-sm sm:text-base focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20',
              isDark
                ? 'border-slate-700 bg-slate-800 text-white placeholder-slate-500'
                : 'border-gray-300 bg-white text-gray-900 placeholder-gray-400'
            ]"
            :disabled="isLoading"
            @keydown.enter="sendMessage"
          />
          <button
            @click="sendMessage"
            :disabled="isLoading || !inputMessage.trim()"
            class="rounded-lg bg-blue-600 px-3 py-2 sm:px-5 sm:py-3 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center"
            title="发送消息"
          >
            <Send :size="18" class="sm:hidden" />
            <Send :size="20" class="hidden sm:block" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
