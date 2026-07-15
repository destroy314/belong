import {
  ensureSession,
  getErrorMessage,
  getSelectedFamilyId,
  listFamilies,
  resetDevelopmentChat,
  selectFamily,
  sendChatMessage,
} from '../../utils/api'
import { CHAT_CACHE_PREFIX, LAST_CHAT_CACHE_KEY } from '../../utils/storage-keys'

interface InputEvent {
  detail: {
    value: string
  }
}

interface LineChangeEvent {
  detail: {
    lineCount: number
  }
}

interface KeyboardHeightEvent {
  detail: {
    height: number
  }
}

interface ChatScrollEvent {
  detail: {
    scrollTop: number
  }
}

interface LayoutRect {
  height: number
}

interface SuggestionEvent {
  currentTarget: {
    dataset: {
      text?: string
    }
  }
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  changeSummary?: string
  changeTokens?: Array<{ text: string; tone: 'positive' | 'negative' | '' }>
}

function getChangeTokens(summary?: string): ChatMessage['changeTokens'] {
  if (!summary) return []
  return summary.split(/([+-]\d+)/g).filter(Boolean).map((text) => ({
    text,
    tone: text.startsWith('+') ? 'positive' : text.startsWith('-') ? 'negative' : '',
  }))
}

function decorateMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    changeTokens: getChangeTokens(message.changeSummary),
  }))
}

const INPUT_LINE_HEIGHT_RPX = 42
const INPUT_VERTICAL_PADDING_RPX = 20
const INPUT_MAX_LINES = 4
const INPUT_MIN_HEIGHT_RPX = INPUT_LINE_HEIGHT_RPX + INPUT_VERTICAL_PADDING_RPX
const SESSION_BOUNDARY_HOUR = 4
let sessionBoundaryTimer: number | undefined
let latestChatScrollTop = 0
let localChatMessageSequence = 0
let activeChatRequestToken = 0
let hiddenChatScrollState: {
  familyId: string
  chatDate: string
  scrollTop: number
} | undefined

function getSessionDate(now = new Date()): string {
  const sessionDay = new Date(now.getTime() - SESSION_BOUNDARY_HOUR * 60 * 60 * 1000)
  const month = `${sessionDay.getMonth() + 1}`.padStart(2, '0')
  const day = `${sessionDay.getDate()}`.padStart(2, '0')
  return `${sessionDay.getFullYear()}-${month}-${day}`
}

function nextSessionBoundaryMs(now = new Date()): number {
  const nextBoundary = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    SESSION_BOUNDARY_HOUR,
  )
  if (nextBoundary.getTime() <= now.getTime()) {
    nextBoundary.setDate(nextBoundary.getDate() + 1)
  }
  return nextBoundary.getTime()
}

function isDevelopmentBuild(): boolean {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion === 'develop'
  } catch {
    return false
  }
}

function getKeyboardComposerOffset(): number {
  try {
    const windowInfo = wx.getSystemInfoSync()
    const safeAreaBottom = windowInfo.safeArea?.bottom ?? windowInfo.screenHeight
    const safeAreaInsetBottom = Math.max(0, windowInfo.screenHeight - safeAreaBottom)
    const defaultPadding = 4 * windowInfo.windowWidth / 750
    return (defaultPadding + safeAreaInsetBottom) / 2
  } catch {
    return 1
  }
}

function createChatMessageId(prefix: string): string {
  localChatMessageSequence += 1
  return `${prefix}-${Date.now()}-${localChatMessageSequence}`
}

function getChatCacheKey(familyId: string): string {
  return `${CHAT_CACHE_PREFIX}${familyId}_${getSessionDate()}`
}

function loadCachedMessages(familyId: string): ChatMessage[] {
  const cacheKey = getChatCacheKey(familyId)
  const previousKey = wx.getStorageSync(LAST_CHAT_CACHE_KEY) as string
  if (previousKey && previousKey !== cacheKey) {
    wx.removeStorageSync(previousKey)
  }
  wx.setStorageSync(LAST_CHAT_CACHE_KEY, cacheKey)
  return (wx.getStorageSync(cacheKey) as ChatMessage[]) || []
}

function saveCachedMessages(familyId: string, messages: ChatMessage[]): void {
  wx.setStorageSync(getChatCacheKey(familyId), messages.slice(-50))
}

Page({
  data: {
    familyId: '',
    familyName: '',
    authReady: false,
    loading: true,
    sending: false,
    canManuallyResetChat: isDevelopmentBuild(),
    chatDate: getSessionDate(),
    inputValue: '',
    inputHeight: INPUT_MIN_HEIGHT_RPX,
    topHeight: 0,
    composerHeight: 0,
    keyboardHeight: 0,
    keyboardComposerOffset: getKeyboardComposerOffset(),
    composerBottom: 0,
    messages: [] as ChatMessage[],
    queuedMessages: [] as ChatMessage[],
    scrollIntoView: '',
    scrollAnimated: false,
    suggestions: [
      '护照放在哪里？',
      '家里有哪些数据线？',
      '把备用钥匙移到玄关抽屉',
    ],
  },

  async onLoad() {
    this.scheduleSessionBoundaryReset()
    this.syncLayout()
  },

  onReady() {
    this.syncLayout()
  },

  async onShow() {
    const firstShow = !this.data.authReady
    const scrollState = hiddenChatScrollState
    hiddenChatScrollState = undefined
    const previousFamilyId = this.data.familyId
    const previousChatDate = this.data.chatDate
    if (
      !firstShow
      && scrollState
      && scrollState.familyId === previousFamilyId
      && scrollState.chatDate === previousChatDate
    ) {
      this.restoreScrollPosition(scrollState.scrollTop)
    }
    await this.loadFamilyContext()
    this.syncLayout()
    const contextChanged = previousFamilyId !== this.data.familyId
      || previousChatDate !== this.data.chatDate
    const hiddenContextChanged = Boolean(
      scrollState
      && (
        scrollState.familyId !== this.data.familyId
        || scrollState.chatDate !== this.data.chatDate
      ),
    )
    if (firstShow || contextChanged || hiddenContextChanged) {
      this.scrollToBottom(false)
    }
  },

  onHide() {
    hiddenChatScrollState = {
      familyId: this.data.familyId,
      chatDate: this.data.chatDate,
      scrollTop: latestChatScrollTop,
    }
  },

  onUnload() {
    if (sessionBoundaryTimer !== undefined) {
      clearTimeout(sessionBoundaryTimer)
      sessionBoundaryTimer = undefined
    }
    latestChatScrollTop = 0
    hiddenChatScrollState = undefined
    activeChatRequestToken += 1
  },

  async loadFamilyContext() {
    if (!this.data.authReady) {
      this.setData({ loading: true })
    }
    try {
      await ensureSession()
      const families = await listFamilies()
      const selectedId = getSelectedFamilyId()
      const family = families.find((item) => item.id === selectedId) || families[0]

      if (!family) {
        const today = getSessionDate()
        const familyChanged = this.data.familyId !== ''
        const dayChanged = today !== this.data.chatDate
        const contextData = {
          familyId: '',
          familyName: '',
          chatDate: today,
          authReady: true,
          loading: false,
        }
        if (familyChanged || dayChanged) {
          activeChatRequestToken += 1
          this.setData({
            ...contextData,
            messages: [],
            queuedMessages: [],
            sending: false,
          })
        } else {
          this.setData(contextData)
        }
        return
      }

      const today = getSessionDate()
      const familyChanged = family.id !== this.data.familyId
      const dayChanged = today !== this.data.chatDate
      selectFamily(family.id)
      const contextData = {
        familyId: family.id,
        familyName: family.name,
        chatDate: today,
        authReady: true,
        loading: false,
      }
      if (familyChanged || dayChanged) {
        activeChatRequestToken += 1
        this.setData({
          ...contextData,
          messages: decorateMessages(loadCachedMessages(family.id)),
          queuedMessages: [],
          sending: false,
        })
      } else {
        this.setData(contextData)
      }
    } catch (error) {
      this.setData({ loading: false })
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    }
  },

  handleInput(event: InputEvent) {
    const inputValue = event.detail.value
    if (inputValue.endsWith('\n')) {
      const content = inputValue.replace(/\n+$/, '')
      this.setData(
        content
          ? { inputValue: content }
          : { inputValue: content, inputHeight: INPUT_MIN_HEIGHT_RPX },
        () => {
          this.syncLayout()
          if (content.trim()) wx.nextTick(() => this.sendMessage())
        },
      )
      return
    }
    this.setData(
      inputValue
        ? { inputValue }
        : { inputValue, inputHeight: INPUT_MIN_HEIGHT_RPX },
      () => this.syncLayout(),
    )
  },

  handleInputLineChange(event: LineChangeEvent) {
    const lineCount = Math.min(
      Math.max(event.detail.lineCount, 1),
      INPUT_MAX_LINES,
    )
    const inputHeight = lineCount * INPUT_LINE_HEIGHT_RPX + INPUT_VERTICAL_PADDING_RPX
    if (inputHeight !== this.data.inputHeight) {
      this.setData({ inputHeight }, () => this.syncLayout())
    }
  },

  handleInputFocus() {
    this.syncLayout()
  },

  handleInputBlur() {
    if (this.data.keyboardHeight !== 0) {
      this.setData({ keyboardHeight: 0, composerBottom: 0 }, () => this.syncLayout())
    }
  },

  handleKeyboardHeightChange(event: KeyboardHeightEvent) {
    const keyboardHeight = Math.max(0, Number(event.detail.height || 0))
    if (keyboardHeight === this.data.keyboardHeight) {
      return
    }
    const composerBottom = keyboardHeight > 0
      ? Math.max(0, keyboardHeight - this.data.keyboardComposerOffset)
      : 0
    this.setData({ keyboardHeight, composerBottom }, () => {
      this.syncLayout()
      this.scrollToBottom()
    })
  },

  handleChatScroll(event: ChatScrollEvent) {
    latestChatScrollTop = Math.max(0, Number(event.detail.scrollTop || 0))
  },

  preventAreaMove() {
    // The top and composer guards consume movement outside the chat scroller.
  },

  useSuggestion(event: SuggestionEvent) {
    const text = event.currentTarget.dataset.text || ''
    this.setData(
      { inputValue: text, inputHeight: INPUT_MIN_HEIGHT_RPX },
      () => this.syncLayout(),
    )
  },

  sendMessage() {
    const content = this.data.inputValue.trim()
    if (!content) {
      return
    }
    if (!this.data.familyId) {
      this.openFamily()
      return
    }

    const today = getSessionDate()
    const dayChanged = today !== this.data.chatDate
    const currentMessages = !dayChanged
      ? this.data.messages
      : loadCachedMessages(this.data.familyId)
    const currentQueue = dayChanged ? [] : this.data.queuedMessages
    if (dayChanged) {
      activeChatRequestToken += 1
    }

    const userMessage: ChatMessage = {
      id: createChatMessageId('user'),
      role: 'user',
      content,
    }
    const queuedMessages = [...currentQueue, userMessage]
    this.setData(
      {
        inputValue: '',
        inputHeight: INPUT_MIN_HEIGHT_RPX,
        messages: currentMessages,
        queuedMessages,
        sending: dayChanged ? false : this.data.sending,
        chatDate: today,
      },
      () => {
        this.syncLayout()
        this.processNextChatMessage()
      },
    )
    saveCachedMessages(this.data.familyId, [...currentMessages, ...queuedMessages])
    this.scrollToBottom()
  },

  async processNextChatMessage() {
    if (this.data.sending || this.data.queuedMessages.length === 0) {
      return
    }

    const [userMessage, ...queuedMessages] = this.data.queuedMessages
    const familyId = this.data.familyId
    const chatDate = this.data.chatDate
    if (!familyId || !userMessage) {
      return
    }

    const messages = [...this.data.messages, userMessage]
    const requestToken = ++activeChatRequestToken
    this.setData(
      { messages, queuedMessages, sending: true },
      () => this.syncLayout(),
    )
    saveCachedMessages(familyId, [...messages, ...queuedMessages])
    this.scrollToBottom()

    let assistantMessage: ChatMessage
    try {
      const result = await sendChatMessage(familyId, userMessage.content)
      assistantMessage = {
        id: createChatMessageId('assistant'),
        role: 'assistant',
        content: result.reply,
        changeSummary: result.changeSummary,
        changeTokens: getChangeTokens(result.changeSummary),
      }
    } catch (error) {
      assistantMessage = {
        id: createChatMessageId('assistant-error'),
        role: 'assistant',
        content: getErrorMessage(error),
      }
    }

    if (
      requestToken !== activeChatRequestToken
      || familyId !== this.data.familyId
      || chatDate !== this.data.chatDate
    ) {
      return
    }

    const nextMessages = [...this.data.messages, assistantMessage]
    this.setData(
      { messages: nextMessages, sending: false },
      () => this.processNextChatMessage(),
    )
    saveCachedMessages(familyId, [...nextMessages, ...this.data.queuedMessages])
    this.scrollToBottom()
  },

  scrollToBottom(animated = true) {
    setTimeout(() => {
      this.setData({ scrollAnimated: animated, scrollIntoView: 'chat-bottom' })
    }, 50)
  },

  restoreScrollPosition(scrollTop: number) {
    this.setData({ scrollAnimated: false, scrollIntoView: '' }, () => {
      wx.nextTick(() => {
        const query = this.createSelectorQuery()
        query.select('#chat-scroll').context((result) => {
          const scrollView = result.context as WechatMiniprogram.ScrollViewContext
          if (scrollView && typeof scrollView.scrollTo === 'function') {
            scrollView.scrollTo({ top: scrollTop, animated: false })
          }
        })
        query.exec()
      })
    })
  },

  syncLayout() {
    setTimeout(() => {
      const query = this.createSelectorQuery()
      query.select('#top-guard').boundingClientRect()
      query.select('#composer-wrap').boundingClientRect()
      query.exec((results) => {
        const topRect = results[0] as LayoutRect | null
        const composerRect = results[1] as LayoutRect | null
        const topHeight = Math.ceil(topRect?.height || 0)
        const composerHeight = Math.ceil(composerRect?.height || 0)
        if (
          topHeight !== this.data.topHeight
          || composerHeight !== this.data.composerHeight
        ) {
          this.setData({ topHeight, composerHeight })
        }
      })
    }, 0)
  },

  scheduleSessionBoundaryReset() {
    if (sessionBoundaryTimer !== undefined) {
      clearTimeout(sessionBoundaryTimer)
    }
    const now = new Date()
    const nextBoundary = nextSessionBoundaryMs(now)
    sessionBoundaryTimer = setTimeout(() => {
      const familyId = this.data.familyId
      activeChatRequestToken += 1
      this.setData({
        chatDate: getSessionDate(),
        messages: familyId ? loadCachedMessages(familyId) : [],
        queuedMessages: [],
        sending: false,
      }, () => this.syncLayout())
      this.scheduleSessionBoundaryReset()
    }, Math.max(1000, nextBoundary - now.getTime() + 100))
  },

  async resetDevelopmentChat() {
    const familyId = this.data.familyId
    if (
      !this.data.canManuallyResetChat
      || !familyId
      || this.data.sending
      || this.data.queuedMessages.length > 0
    ) {
      return
    }
    try {
      await resetDevelopmentChat(familyId)
      const cacheKey = getChatCacheKey(familyId)
      wx.removeStorageSync(cacheKey)
      wx.setStorageSync(LAST_CHAT_CACHE_KEY, cacheKey)
      activeChatRequestToken += 1
      this.setData({
        chatDate: getSessionDate(),
        messages: [],
        queuedMessages: [],
      }, () => this.syncLayout())
      wx.showToast({ title: '开发会话已重置', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    }
  },

  openInventory() {
    if (!this.data.familyId) {
      wx.showToast({ title: '请先创建或加入家庭', icon: 'none' })
      this.openFamily()
      return
    }
    wx.navigateTo({ url: '/pages/inventory/inventory' })
  },

  openFamily() {
    wx.navigateTo({ url: '/pages/family/family' })
  },
})
