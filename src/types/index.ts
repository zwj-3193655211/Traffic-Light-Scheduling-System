/**
 * 全站共享类型定义
 *
 * 此前这些接口在 Dashboard / TrafficControl / Demo / IntersectionDetail /
 * EmergencyManagement / IntersectionList 等页面各写一份，字段口径不一致且容易漂移，
 * 现统一到此处，各页面按需取用。
 */

/** 路口方向 */
export type Direction = 'North' | 'South' | 'East' | 'West'

/** 通行方式 */
export type MovementType = 'straight' | 'left'

/** 灯色状态码（与后端 traffic_lights.current_status 一致） */
export const LightStatus = {
  RED: 0,
  YELLOW: 1,
  GREEN: 2,
} as const

export type LightStatusCode = (typeof LightStatus)[keyof typeof LightStatus]

/** phase_number 语义：1=东西直行 2=东西左转 3=南北直行 4=南北左转 */
export type PhaseNumber = 1 | 2 | 3 | 4

/**
 * 红绿灯记录（对应 traffic_lights 表）
 *
 * 说明：IntersectionDetail 走的是另一套字段（status / duration），
 * 这里一并保留为可选，避免同一实体出现两种类型定义。
 */
export interface TrafficLight {
  id: number
  intersection_id: number
  direction: Direction | string
  movement_type?: MovementType | string
  current_status?: LightStatusCode | number
  remaining_time?: number
  default_green_time?: number
  default_red_time?: number
  default_yellow_time?: number
  phase_number?: PhaseNumber | number
  created_at?: string
  updated_at?: string
  /** 详情页接口使用的替代字段名 */
  status?: LightStatusCode | number | 'red' | 'yellow' | 'green'
  duration?: number
}

/** 路口 */
export interface Intersection {
  id: number
  name: string
  latitude?: number
  longitude?: number
  coordinates?: string
  status?: 'active' | 'inactive' | 'maintenance' | number | string
  current_phase?: number
  cycle_length?: number
  auto_mode?: number
  created_at?: string
  updated_at?: string
  next_north_id?: number | null
  next_south_id?: number | null
  next_east_id?: number | null
  next_west_id?: number | null
  next_north_name?: string | null
  next_south_name?: string | null
  next_east_name?: string | null
  next_west_name?: string | null
}

/** 车流记录 */
export interface VehicleFlow {
  id: number
  intersection_id: number
  direction: Direction | string
  vehicle_count: number
  straight_count?: number
  left_count?: number
  average_speed?: number
  timestamp: string
}

export type EmergencyVehicleType = 'ambulance' | 'fire_truck' | 'police' | 'other'

/** 优先级 1~5，数值越大越优先 */
export type EmergencyPriority = 1 | 2 | 3 | 4 | 5

/** 紧急车辆 */
export interface EmergencyVehicle {
  id: number
  intersection_id?: number
  vehicle_type?: EmergencyVehicleType | string
  license_plate?: string
  direction?: Direction | string
  vehicle_id?: string
  priority_level?: EmergencyPriority | number
  /** 0-等待 1-已通过 2-已取消 */
  status?: number
  estimated_arrival?: string
  created_at?: string
  updated_at?: string
}

/** AI 建议回显 */
export interface AiAdvice {
  intersectionId: number
  green: number
  reason?: string
}

/** 后端统一响应包装 */
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
  error?: string
  fromCache?: boolean
}

/** Socket.IO 服务端推送事件 */
export interface ServerEvents {
  light_status_update: (payload: {
    lightId: number
    status: number
    remainingTime: number
    direction?: string
  }) => void
  trafficLightUpdate: (lights: TrafficLight[]) => void
  vehicleFlowUpdate: (payload: unknown) => void
  trafficTimingUpdate: (payload: {
    intersectionId: number
    source: 'ai' | 'fallback'
    advice?: { green: number; reason?: string }
  }) => void
  emergencyMode: (mode: 'emergency' | 'normal') => void
  aiModeChanged: (payload: { enabled: boolean; ts: number }) => void
  connected: (payload: { ts: number }) => void
}
