import React from 'react'
import type { Direction, LightState, Phase, Step } from '../sim/core'
import { formatDurationSeconds } from '../lib/utils'

const directions: Direction[] = ['North', 'South', 'East', 'West']

function getLightClass(status: 0 | 1 | 2) {
  switch (status) {
    case 0: return 'bg-red-500'
    case 1: return 'bg-yellow-500'
    case 2: return 'bg-green-500'
    default: return 'bg-gray-400'
  }
}

function phaseLabel(p: Phase): string {
  if (p === 'EW_STRAIGHT') return '东西直行'
  if (p === 'EW_LEFT') return '东西左转'
  if (p === 'NS_STRAIGHT') return '南北直行'
  return '南北左转'
}

function stepLabel(s: Step): string {
  if (s === 'ACTIVE') return '运行中'
  if (s === 'YELLOW') return '黄灯过渡'
  return '全红过渡'
}

export default function IntersectionMonitor({
  lights,
  queuesStraight,
  queuesLeft,
  phase,
  step,
  periodLabel,
  periodLeft,
  greenLeft,
}: {
  lights: Record<Direction, LightState>
  queuesStraight: Record<Direction, number>
  queuesLeft: Record<Direction, number>
  phase: Phase
  step: Step
  periodLabel: string
  periodLeft: number
  greenLeft: number
}) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700">
          当前相位：{phaseLabel(phase)}（{stepLabel(step)}）
        </div>
        <div className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700">
          交通时段：{periodLabel}（剩余 {formatDurationSeconds(periodLeft)}）
        </div>
        <div className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700">
          当前绿灯剩余：{greenLeft}s
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {directions.map((d) => {
          const dirLabel = d === 'North' ? '北向' : d === 'South' ? '南向' : d === 'East' ? '东向' : '西向'
          const straight = lights[d].straight
          const left = lights[d].left
          return (
            <div key={d} className="border rounded-lg p-4">
              <div className="font-medium text-gray-900 mb-3">{dirLabel}</div>
              {/* 直行：信号灯 + 队列数 + 绿灯倒计时（如有），合并为单行 */}
              <div className="flex items-center justify-between text-sm mb-2">
                <div className="flex items-center gap-2 text-gray-700">
                  <span className={`w-3 h-3 rounded-full ${getLightClass(straight.status)}`} aria-label="直行信号灯" />
                  <span>直行</span>
                  <span className="font-semibold text-gray-900">{queuesStraight[d]} 辆</span>
                </div>
                {straight.status === 2 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                    剩 {straight.remainingTime}s
                  </span>
                )}
                {straight.status === 1 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700">
                    黄 {straight.remainingTime}s
                  </span>
                )}
              </div>
              {/* 左转：同样合并显示 */}
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 text-gray-700">
                  <span className={`w-3 h-3 rounded-full ${getLightClass(left.status)}`} aria-label="左转信号灯" />
                  <span>左转</span>
                  <span className="font-semibold text-gray-900">{queuesLeft[d]} 辆</span>
                </div>
                {left.status === 2 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                    剩 {left.remainingTime}s
                  </span>
                )}
                {left.status === 1 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700">
                    黄 {left.remainingTime}s
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
