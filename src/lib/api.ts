/**
 * 统一 API 客户端
 *
 * 此前各页面散落着 25+ 处裸 fetch('/api/...')，每处各自处理 JSON 解析、
 * success 判定与错误提示，行为不一致。这里统一收敛为一层。
 */
import type { ApiResponse, AiAdvice, EmergencyVehicle, Intersection, TrafficLight, VehicleFlow } from '@/types'

const BASE_URL = '/api'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch (e) {
    throw new ApiError('网络请求失败，请检查服务是否启动', 0, e)
  }

  let json: ApiResponse<T>
  try {
    json = (await res.json()) as ApiResponse<T>
  } catch {
    throw new ApiError(`响应解析失败 (HTTP ${res.status})`, res.status)
  }

  if (!res.ok || json.success === false) {
    throw new ApiError(json.message || json.error || `请求失败 (HTTP ${res.status})`, res.status, json)
  }
  return json.data as T
}

/** 合并方法与额外 init（额外 init 用于自定义 header，如 Authorization） */
function withBody(method: string, body?: unknown, init?: RequestInit): RequestInit {
  return {
    ...init,
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, withBody('POST', body, init)),
  put: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, withBody('PUT', body, init)),
  del: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, withBody('DELETE', body, init)),
}

/** AI 动态红绿灯开关（三个页面共用同一个后端开关） */
export const aiModeApi = {
  get: () => api.get<boolean>('/settings/ai-mode'),
  set: (enabled: boolean) => api.post<boolean>('/settings/ai-mode', { enabled }),
}

/** 前端 AI 配置面板：provider + API Key + 模型名 + 思考开关 */
export interface AiConfig {
  provider: string
  /** 明文回显（仅云端 provider 使用；llama.cpp 为空） */
  apiKey: string
  model: string
  baseUrl?: string
  enableThinking: boolean
}

export const aiConfigApi = {
  get: () => api.get<AiConfig>('/settings/ai-config'),
  set: (cfg: Partial<AiConfig>) => api.post<AiConfig>('/settings/ai-config', cfg),
}

export const authApi = {
  login: (username: string, password: string) =>
    api.post<{ token: string; expires_at: string; username: string }>('/auth/login', { username, password }),
  logout: (token: string) =>
    api.post('/auth/logout', { token }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }),
}

export const intersectionsApi = {
  list: () => api.get<Intersection[]>('/intersections'),
  detail: (id: number | string) => api.get<Intersection>(`/intersections/${id}`),
}

export const trafficLightsApi = {
  list: () => api.get<TrafficLight[]>('/traffic-lights'),
  byIntersection: (id: number | string) => api.get<TrafficLight[]>(`/traffic-lights/intersection/${id}`),
  batchUpdate: (payload: unknown) => api.post('/traffic-lights/batch-update', payload),
}

export const vehicleFlowsApi = {
  list: () => api.get<VehicleFlow[]>('/vehicle-flows'),
  batch: (payload: unknown) => api.post('/vehicle-flows/batch', payload),
}

export const emergencyVehiclesApi = {
  list: () => api.get<EmergencyVehicle[]>('/emergency-vehicles'),
  report: (payload: unknown) => api.post('/emergency-vehicles/report', payload),
}

export const settingsApi = {
  get: <T = Record<string, unknown>>() => api.get<T>('/settings'),
  update: (payload: unknown) => api.put('/settings', payload),
  reset: () => api.post('/settings/reset'),
  getSelectedIntersection: () => api.get<{ intersectionId: number | null }>('/settings/selected-intersection'),
  setSelectedIntersection: (intersectionId: number | null) =>
    api.post('/settings/selected-intersection', { intersectionId }),
  getIntersectionParams: (id: number | string) => api.get<IntersectionParams>(`/settings/intersection-params/${id}`),
  updateIntersectionParams: (id: number | string, payload: Partial<IntersectionParams>) =>
    api.put(`/settings/intersection-params/${id}`, payload),
}

/** 单个路口的自适应配时参数 */
export interface IntersectionParams {
  intersection_id: number
  window_seconds: number
  low_flow_threshold: number
  min_green_floor: number
  arrival_straight_scale?: number
  arrival_left_scale?: number
  release_straight_scale?: number
  release_left_scale?: number
}

export const aiMetricsApi = {
  get: () => api.get<{ advisor: Record<string, number>; runtime: Record<string, unknown>; ts: number }>('/ai/metrics'),
}

export type { AiAdvice }
