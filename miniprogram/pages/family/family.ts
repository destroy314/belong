import {
  clearFamilyChatCache,
  clearSelectedFamily,
  createFamily as createFamilyRequest,
  deleteFamily,
  ensureSession,
  Family,
  getErrorMessage,
  getLlmConfig,
  getMembers,
  getSelectedFamilyId,
  joinFamily as joinFamilyRequest,
  leaveFamily,
  loginAsDevelopmentUser,
  listFamilies,
  Member,
  removeFamilyMember,
  selectFamily,
  updateLlmConfig,
  updateMyProfile,
  uploadMyAvatar,
  User,
} from '../../utils/api'

interface InputEvent {
  detail: {
    value: string
  }
}

interface DatasetEvent {
  currentTarget: {
    dataset: {
      id?: string
      mode?: 'create' | 'join'
    }
  }
}

interface AvatarEvent {
  detail: {
    avatarUrl: string
  }
}

interface ProfileSubmitEvent {
  detail: {
    value: {
      nickname?: string
    }
  }
}

interface DisplayMember extends Member {
  initial: string
  roleLabel: string
  isCurrentUser: boolean
}

function getRoleLabel(role?: Family['role'] | Member['role']): string {
  if (role === 'owner') {
    return '创建者'
  }
  if (role === 'admin') {
    return '管理员'
  }
  return '成员'
}

function toDisplayMember(member: Member, currentUserId: string): DisplayMember {
  const nickname = member.nickname || '家庭成员'
  return {
    ...member,
    nickname,
    initial: nickname.slice(0, 1),
    roleLabel: getRoleLabel(member.role),
    isCurrentUser: member.userId === currentUserId,
  }
}

function isDevelopmentBuild(): boolean {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion === 'develop'
  } catch {
    return false
  }
}

Page({
  data: {
    loading: true,
    submitting: false,
    savingConfig: false,
    savingProfile: false,
    uploadingAvatar: false,
    showProfileSettings: false,
    leavingFamily: false,
    deletingFamily: false,
    removingMemberId: '',
    switchingDevOwner: false,
    showDevelopmentTools: isDevelopmentBuild(),
    families: [] as Family[],
    currentFamily: null as Family | null,
    currentUser: null as User | null,
    currentRoleLabel: '',
    members: [] as DisplayMember[],
    canEditConfig: false,
    canManageMembers: false,
    formMode: 'create' as 'create' | 'join',
    showFamilyForm: false,
    familyNameInput: '',
    inviteCodeInput: '',
    profileNicknameInput: '',
    profileInitial: '我',
    baseUrlInput: '',
    modelInput: '',
    apiKeyInput: '',
    hasApiKey: false,
    usingDefaultConfig: false,
    configStatus: '待配置',
  },

  async onLoad() {
    await this.loadPage()
  },

  async onPullDownRefresh() {
    await this.loadPage()
    wx.stopPullDownRefresh()
  },

  async loadPage() {
    this.setData({ loading: true })
    try {
      const currentUser = await ensureSession()
      const families = await listFamilies()
      const selectedId = getSelectedFamilyId()
      const currentFamily = families.find((item) => item.id === selectedId) || families[0] || null

      if (!currentFamily) {
        this.setData({
          families: [],
          currentFamily: null,
          currentUser,
          profileNicknameInput: currentUser.nickname || '',
          profileInitial: (currentUser.nickname || '我').slice(0, 1),
          members: [],
          canManageMembers: false,
          showFamilyForm: true,
          loading: false,
        })
        return
      }

      selectFamily(currentFamily.id)
      const [members, config] = await Promise.all([
        getMembers(currentFamily.id),
        getLlmConfig(currentFamily.id),
      ])
      const canEditConfig = !currentFamily.role
        || currentFamily.role === 'owner'
        || currentFamily.role === 'admin'
      const canManageMembers = currentFamily.role === 'owner'

      this.setData({
        families,
        currentFamily,
        currentUser,
        currentRoleLabel: getRoleLabel(currentFamily.role),
        members: members.map((member) => toDisplayMember(member, currentUser.id)),
        canEditConfig,
        canManageMembers,
        profileNicknameInput: currentUser.nickname || '',
        profileInitial: (currentUser.nickname || '我').slice(0, 1),
        baseUrlInput: config.baseUrl || '',
        modelInput: config.model || '',
        apiKeyInput: '',
        hasApiKey: config.hasApiKey,
        usingDefaultConfig: config.usingDefault,
        configStatus: config.hasApiKey
          ? '家庭配置'
          : (config.usingDefault ? '默认配置' : '待配置'),
        loading: false,
      })
    } catch (error) {
      this.setData({ loading: false })
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    }
  },

  setFormMode(event: DatasetEvent) {
    const mode = event.currentTarget.dataset.mode
    if (mode) {
      this.setData({ formMode: mode })
    }
  },

  toggleFamilyForm() {
    this.setData({ showFamilyForm: !this.data.showFamilyForm })
  },

  handleFamilyName(event: InputEvent) {
    this.setData({ familyNameInput: event.detail.value })
  },

  handleInviteCode(event: InputEvent) {
    this.setData({ inviteCodeInput: event.detail.value.toUpperCase() })
  },

  handleProfileNickname(event: InputEvent) {
    this.setData({ profileNicknameInput: event.detail.value })
  },

  openProfileSettings() {
    const currentUser = this.data.currentUser
    if (!currentUser) {
      return
    }
    this.setData({
      showProfileSettings: true,
      profileNicknameInput: currentUser.nickname || '',
    })
  },

  closeProfileSettings() {
    if (!this.data.savingProfile && !this.data.uploadingAvatar) {
      this.setData({ showProfileSettings: false })
    }
  },

  preventProfileSettingsClose() {
    // Prevent taps inside the panel from closing the modal.
  },

  async saveProfile(event: ProfileSubmitEvent) {
    const submittedNickname = event.detail.value.nickname
    const nickname = (submittedNickname || '').trim()
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    if (this.data.savingProfile || this.data.uploadingAvatar) {
      return
    }
    this.setData({ savingProfile: true })
    try {
      const currentUser = await updateMyProfile({ nickname })
      this.setData({
        currentUser,
        profileNicknameInput: currentUser.nickname || '',
        profileInitial: (currentUser.nickname || '我').slice(0, 1),
        showProfileSettings: false,
      })
      await this.loadPage()
      wx.showToast({ title: '资料已保存', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    } finally {
      this.setData({ savingProfile: false })
    }
  },

  async chooseAvatar(event: AvatarEvent) {
    const avatarUrl = event.detail.avatarUrl
    if (!avatarUrl || this.data.savingProfile || this.data.uploadingAvatar) {
      return
    }
    this.setData({ uploadingAvatar: true })
    try {
      const currentUser = await uploadMyAvatar(avatarUrl)
      this.setData({ currentUser })
      await this.loadPage()
      wx.showToast({ title: '头像已更新', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    } finally {
      this.setData({ uploadingAvatar: false })
    }
  },

  handleBaseUrl(event: InputEvent) {
    this.setData({ baseUrlInput: event.detail.value })
  },

  handleModel(event: InputEvent) {
    this.setData({ modelInput: event.detail.value })
  },

  handleApiKey(event: InputEvent) {
    this.setData({ apiKeyInput: event.detail.value })
  },

  async submitFamilyForm() {
    if (this.data.submitting) {
      return
    }
    const isCreate = this.data.formMode === 'create'
    const value = isCreate
      ? this.data.familyNameInput.trim()
      : this.data.inviteCodeInput.trim().toUpperCase()
    if (!value) {
      wx.showToast({ title: isCreate ? '请输入家庭名称' : '请输入邀请码', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    try {
      const family = isCreate
        ? await createFamilyRequest(value)
        : await joinFamilyRequest(value)
      selectFamily(family.id)
      this.setData({
        familyNameInput: '',
        inviteCodeInput: '',
        showFamilyForm: false,
      })
      await this.loadPage()
      wx.showToast({ title: isCreate ? '家庭已创建' : '已加入家庭', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  async switchFamily(event: DatasetEvent) {
    const familyId = event.currentTarget.dataset.id
    if (!familyId || familyId === this.data.currentFamily?.id) {
      return
    }
    selectFamily(familyId)
    await this.loadPage()
  },

  switchToDevelopmentOwner() {
    if (this.data.switchingDevOwner) {
      return
    }
    wx.showModal({
      title: '切换开发账号',
      content: '将清除当前登录状态，并以 belong-dev-owner 重新登录。',
      confirmText: '切换',
      success: async ({ confirm }) => {
        if (!confirm) {
          return
        }
        this.setData({ switchingDevOwner: true })
        try {
          await loginAsDevelopmentUser('belong-dev-owner')
          await this.loadPage()
          wx.showToast({ title: '已切换为开发创建者', icon: 'success' })
        } catch (error) {
          wx.showToast({ title: getErrorMessage(error), icon: 'none' })
        } finally {
          this.setData({ switchingDevOwner: false })
        }
      },
    })
  },

  copyInviteCode() {
    const inviteCode = this.data.currentFamily?.inviteCode
    if (!inviteCode) {
      return
    }
    wx.setClipboardData({
      data: inviteCode,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }),
    })
  },

  removeMember(event: DatasetEvent) {
    const currentFamily = this.data.currentFamily
    const memberUserId = event.currentTarget.dataset.id
    if (!currentFamily || !this.data.canManageMembers || !memberUserId || this.data.removingMemberId) {
      return
    }
    const member = this.data.members.find((item) => item.userId === memberUserId)
    if (!member || member.role === 'owner') {
      return
    }

    wx.showModal({
      title: '移除成员',
      content: `确定将「${member.nickname}」移出家庭吗？对方将无法继续访问家庭库存。`,
      confirmText: '移除',
      confirmColor: '#c94b43',
      success: async ({ confirm }) => {
        if (!confirm) {
          return
        }
        this.setData({ removingMemberId: memberUserId })
        try {
          await removeFamilyMember(currentFamily.id, memberUserId)
          await this.loadPage()
          wx.showToast({ title: '成员已移除', icon: 'success' })
        } catch (error) {
          wx.showToast({ title: getErrorMessage(error), icon: 'none' })
        } finally {
          this.setData({ removingMemberId: '' })
        }
      },
    })
  },

  exitFamily() {
    const currentFamily = this.data.currentFamily
    if (!currentFamily || this.data.leavingFamily || currentFamily.role === 'owner') {
      return
    }
    wx.showModal({
      title: '退出家庭',
      content: '退出后，你将无法查看或编辑该家庭的库存。',
      confirmText: '退出',
      confirmColor: '#c94b43',
      success: async ({ confirm }) => {
        if (!confirm) {
          return
        }
        this.setData({ leavingFamily: true })
        try {
          await leaveFamily(currentFamily.id)
          clearFamilyChatCache(currentFamily.id)
          clearSelectedFamily()
          await this.loadPage()
          wx.showToast({ title: '已退出家庭', icon: 'success' })
        } catch (error) {
          wx.showToast({ title: getErrorMessage(error), icon: 'none' })
        } finally {
          this.setData({ leavingFamily: false })
        }
      },
    })
  },

  deleteCurrentFamily() {
    const currentFamily = this.data.currentFamily
    if (!currentFamily || !this.data.canManageMembers || this.data.deletingFamily) {
      return
    }
    wx.showModal({
      title: '删除家庭',
      content: '删除后，所有成员、家庭库存和模型配置都将永久清除，无法恢复。',
      confirmText: '删除',
      confirmColor: '#c94b43',
      success: async ({ confirm }) => {
        if (!confirm) {
          return
        }
        this.setData({ deletingFamily: true })
        try {
          await deleteFamily(currentFamily.id)
          clearFamilyChatCache(currentFamily.id)
          clearSelectedFamily()
          await this.loadPage()
          wx.showToast({ title: '家庭已删除', icon: 'success' })
        } catch (error) {
          wx.showToast({ title: getErrorMessage(error), icon: 'none' })
        } finally {
          this.setData({ deletingFamily: false })
        }
      },
    })
  },

  async saveLlmConfig() {
    const currentFamily = this.data.currentFamily
    if (!currentFamily || !this.data.canEditConfig || this.data.savingConfig) {
      return
    }

    const baseUrl = this.data.baseUrlInput.trim().replace(/\/$/, '')
    const model = this.data.modelInput.trim()
    const apiKey = this.data.apiKeyInput.trim()
    if (!/^https?:\/\//.test(baseUrl)) {
      wx.showToast({ title: 'API 地址需以 http:// 或 https:// 开头', icon: 'none' })
      return
    }
    if (!model) {
      wx.showToast({ title: '请输入模型名称', icon: 'none' })
      return
    }
    if (!apiKey && !this.data.hasApiKey) {
      wx.showToast({ title: '首次配置需要填写 API Key', icon: 'none' })
      return
    }

    this.setData({ savingConfig: true })
    try {
      const config = await updateLlmConfig(currentFamily.id, {
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
      })
      this.setData({
        baseUrlInput: config.baseUrl,
        modelInput: config.model,
        apiKeyInput: '',
        hasApiKey: config.hasApiKey,
        usingDefaultConfig: config.usingDefault,
        configStatus: config.hasApiKey
          ? '家庭配置'
          : (config.usingDefault ? '默认配置' : '待配置'),
      })
      wx.showToast({ title: '模型设置已保存', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: getErrorMessage(error), icon: 'none' })
    } finally {
      this.setData({ savingConfig: false })
    }
  },
})
