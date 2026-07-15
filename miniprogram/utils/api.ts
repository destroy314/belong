import { API_BASE_URL, REQUEST_TIMEOUT_MS } from '../config'
import {
  CHAT_CACHE_PREFIX,
  FAMILY_STORAGE_KEY,
  LAST_CHAT_CACHE_KEY,
  TOKEN_STORAGE_KEY,
  USER_STORAGE_KEY,
} from './storage-keys'

export interface User {
  id: string
  nickname?: string | null
  avatarUrl?: string | null
}

export interface Family {
  id: string
  name: string
  inviteCode: string
  role?: 'owner' | 'admin' | 'member'
  memberCount?: number
}

export interface Member {
  id?: string
  userId: string
  nickname?: string | null
  avatarUrl?: string | null
  role: 'owner' | 'admin' | 'member'
  joinedAt?: string
}

export interface LlmConfig {
  baseUrl: string
  model: string
  hasApiKey: boolean
  configured: boolean
  usingDefault: boolean
}

export interface InventoryResponse {
  content: string
  version: string
}

export interface ChatResponse {
  reply: string
  changeSummary?: string
  inventoryVersion?: string
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  data?: object
  authenticated?: boolean
}

interface ApiErrorBody {
  error?: string | {
    message?: string
  }
  message?: string
}

export class ApiError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
  }
}

function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = wx.getStorageSync(TOKEN_STORAGE_KEY) as string
  const authenticated = options.authenticated !== false
  const header: Record<string, string> = {
    'content-type': 'application/json',
  }

  if (authenticated && token) {
    header.Authorization = `Bearer ${token}`
  }

  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: `${API_BASE_URL}${path}`,
      method: options.method || 'GET',
      data: options.data,
      header,
      timeout: REQUEST_TIMEOUT_MS,
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as unknown as T)
          return
        }

        const body = response.data as unknown as ApiErrorBody
        const nestedMessage = typeof body.error === 'string'
          ? body.error
          : body.error?.message
        const message = body.message || nestedMessage || `请求失败（${response.statusCode}）`
        if (response.statusCode === 401) {
          wx.removeStorageSync(TOKEN_STORAGE_KEY)
        }
        reject(new ApiError(message, response.statusCode))
      },
      fail: () => {
        reject(new ApiError('无法连接服务，请检查后端是否已启动', 0))
      },
    })
  })
}

let loginPromise: Promise<User> | undefined

function login(devOpenid?: string): Promise<User> {
  if (loginPromise) {
    return loginPromise
  }

  loginPromise = new Promise<User>((resolve, reject) => {
    wx.login({
      success: async ({ code }) => {
        try {
          const result = await request<{ token: string; user: User }>('/auth/wechat', {
            method: 'POST',
            authenticated: false,
            data: {
              code,
              ...(devOpenid ? { devOpenid } : {}),
            },
          })
          wx.setStorageSync(TOKEN_STORAGE_KEY, result.token)
          wx.setStorageSync(USER_STORAGE_KEY, result.user)
          resolve(result.user)
        } catch (error) {
          reject(error)
        }
      },
      fail: () => reject(new ApiError('微信登录失败，请稍后重试', 0)),
    })
  }).finally(() => {
    loginPromise = undefined
  })

  return loginPromise
}

export async function ensureSession(): Promise<User> {
  const token = wx.getStorageSync(TOKEN_STORAGE_KEY) as string
  const user = wx.getStorageSync(USER_STORAGE_KEY) as User
  if (token && user && user.id) {
    return user
  }
  return login()
}

export async function updateMyProfile(profile: {
  nickname: string
  avatarUrl?: string
}): Promise<User> {
  const response = await request<{ user: User }>('/users/me', {
    method: 'PUT',
    data: profile,
  })
  wx.setStorageSync(USER_STORAGE_KEY, response.user)
  return response.user
}

function avatarContentType(filePath: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const normalized = filePath.toLowerCase()
  if (normalized.endsWith('.png')) return 'image/png'
  if (normalized.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

export async function uploadMyAvatar(filePath: string): Promise<User> {
  const data = await new Promise<ArrayBuffer>((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: ({ data: fileData }) => {
        if (fileData instanceof ArrayBuffer) {
          resolve(fileData)
        } else {
          reject(new ApiError('无法读取头像文件', 0))
        }
      },
      fail: () => reject(new ApiError('无法读取头像文件', 0)),
    })
  })
  const token = wx.getStorageSync(TOKEN_STORAGE_KEY) as string
  return new Promise<User>((resolve, reject) => {
    wx.request({
      url: `${API_BASE_URL}/users/me/avatar`,
      method: 'POST',
      data,
      header: {
        Authorization: `Bearer ${token}`,
        'content-type': avatarContentType(filePath),
      },
      timeout: REQUEST_TIMEOUT_MS,
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          const user = (response.data as { user: User }).user
          wx.setStorageSync(USER_STORAGE_KEY, user)
          resolve(user)
          return
        }
        const body = response.data as ApiErrorBody
        const nestedMessage = typeof body.error === 'string'
          ? body.error
          : body.error?.message
        reject(new ApiError(body.message || nestedMessage || '头像上传失败', response.statusCode))
      },
      fail: () => reject(new ApiError('头像上传失败，请稍后重试', 0)),
    })
  })
}

/** 仅用于本地联调：清除当前会话并以指定的开发身份重新登录。 */
export async function loginAsDevelopmentUser(devOpenid: string): Promise<User> {
  wx.removeStorageSync(TOKEN_STORAGE_KEY)
  wx.removeStorageSync(USER_STORAGE_KEY)
  wx.removeStorageSync(FAMILY_STORAGE_KEY)
  return login(devOpenid)
}

export function getSelectedFamilyId(): string {
  return (wx.getStorageSync(FAMILY_STORAGE_KEY) as string) || ''
}

export function selectFamily(familyId: string): void {
  wx.setStorageSync(FAMILY_STORAGE_KEY, familyId)
}

export function clearSelectedFamily(): void {
  wx.removeStorageSync(FAMILY_STORAGE_KEY)
}

export function clearFamilyChatCache(familyId: string): void {
  const cacheKey = wx.getStorageSync(LAST_CHAT_CACHE_KEY) as string
  if (cacheKey.startsWith(`${CHAT_CACHE_PREFIX}${familyId}_`)) {
    wx.removeStorageSync(cacheKey)
    wx.removeStorageSync(LAST_CHAT_CACHE_KEY)
  }
}

export async function listFamilies(): Promise<Family[]> {
  const response = await request<{ families: Family[] }>('/families')
  return response.families
}

export async function createFamily(name: string): Promise<Family> {
  const response = await request<{ family: Family }>('/families', {
    method: 'POST',
    data: { name },
  })
  return response.family
}

export async function joinFamily(inviteCode: string): Promise<Family> {
  const response = await request<{ family: Family }>('/families/join', {
    method: 'POST',
    data: { inviteCode },
  })
  return response.family
}

export function getInventory(familyId: string): Promise<InventoryResponse> {
  return request<InventoryResponse>(`/families/${familyId}/inventory`)
}

export async function getMembers(familyId: string): Promise<Member[]> {
  const response = await request<{ members: Member[] }>(`/families/${familyId}/members`)
  return response.members
}

export function leaveFamily(familyId: string): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>(`/families/${familyId}/members/me`, {
    method: 'DELETE',
  })
}

export function removeFamilyMember(
  familyId: string,
  memberUserId: string,
): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>(`/families/${familyId}/members/${memberUserId}`, {
    method: 'DELETE',
  })
}

export function deleteFamily(familyId: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/families/${familyId}`, {
    method: 'DELETE',
  })
}

export function getLlmConfig(familyId: string): Promise<LlmConfig> {
  return request<LlmConfig>(`/families/${familyId}/llm-config`)
}

export function updateLlmConfig(
  familyId: string,
  config: { baseUrl: string; model: string; apiKey?: string },
): Promise<LlmConfig> {
  return request<LlmConfig>(`/families/${familyId}/llm-config`, {
    method: 'PUT',
    data: config,
  })
}

export function sendChatMessage(familyId: string, message: string): Promise<ChatResponse> {
  return request<ChatResponse>(`/families/${familyId}/chat`, {
    method: 'POST',
    data: { message },
  })
}

export function resetDevelopmentChat(familyId: string): Promise<{ removed: number }> {
  return request<{ removed: number }>(`/families/${familyId}/chat/reset`, {
    method: 'POST',
  })
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}
