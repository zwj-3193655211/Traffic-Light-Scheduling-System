import React, { useEffect, useRef, useState } from 'react'
import type { Direction, Step } from '../sim/core'

type PathFn = (t: number) => { x: number, y: number }
type Dot = { id: number, t: number, speed: number, path: PathFn, lane: 'straight' | 'left' }

// 中国靠右行驶规则下的车道布局（SVG viewBox 100x100，道路十字宽 20）：
//   x=50 / y=50 是中央分隔虚线。
//   - "North" 进口道（车辆由北向南行驶，方向 ↓）：行驶方向右手为西侧（x<50）。
//     直行靠外缘 x≈45，左转靠内缘 x≈48。
//   - "South" 进口道（车辆由南向北行驶，方向 ↑）：右手为东侧（x>50）。
//     直行 x≈55，左转 x≈52。
//   - "East" 进口道（车辆由东向西行驶，方向 ←）：右手为北侧（y<50）。
//     直行 y≈45，左转 y≈48。
//   - "West" 进口道（车辆由西向东行驶，方向 →）：右手为南侧（y>50）。
//     直行 y≈55，左转 y≈52。
const LANE = {
  North: { straight: 45, left: 48 },
  South: { straight: 55, left: 52 },
  East: { straight: 45, left: 48 },
  West: { straight: 55, left: 52 },
} as const

// 每条车道队列的固定可视长度（单列、固定上限）：流量大时只加深颜色，不再额外排列。
const QUEUE_DISPLAY_CAP = 8
// 当排队达到这个数量视为完全拥堵（颜色最深）。
const QUEUE_CONGESTION_FULL = 30
// 队头位置（紧贴停止线那一格）— 行驶车辆将从这里启动。
const STOP_OFFSET = 3 // 与路口边缘 (38/62) 的距离

function pathStraight(dir: Direction): PathFn {
  // 起点：紧贴停止线的“队头”位置；终点：穿出路口对侧。
  if (dir === 'North') {
    const x = LANE.North.straight
    const startY = 38 - STOP_OFFSET // 35
    const endY = 95
    return (t) => ({ x, y: startY + (endY - startY) * t })
  }
  if (dir === 'South') {
    const x = LANE.South.straight
    const startY = 62 + STOP_OFFSET // 65
    const endY = 5
    return (t) => ({ x, y: startY + (endY - startY) * t })
  }
  if (dir === 'East') {
    const y = LANE.East.straight
    const startX = 62 + STOP_OFFSET // 65
    const endX = 5
    return (t) => ({ x: startX + (endX - startX) * t, y })
  }
  // West
  const y = LANE.West.straight
  const startX = 38 - STOP_OFFSET // 35
  const endX = 95
  return (t) => ({ x: startX + (endX - startX) * t, y })
}

// 左转：从所在进口道的左转队头出发，行至路口中心后折线直角左转，
// 出路口时落到下游道路的“车流方向右侧”车道。
function pathLeft(dir: Direction): PathFn {
  if (dir === 'North') {
    const startX = LANE.North.left
    const startY = 38 - STOP_OFFSET
    const endY = LANE.West.straight
    return (t) => {
      if (t < 0.5) {
        const tt = t / 0.5
        return { x: startX, y: startY + (50 - startY) * tt }
      }
      const tt = (t - 0.5) / 0.5
      return { x: startX + (95 - startX) * tt, y: 50 + (endY - 50) * tt }
    }
  }
  if (dir === 'South') {
    const startX = LANE.South.left
    const startY = 62 + STOP_OFFSET
    const endY = LANE.East.straight
    return (t) => {
      if (t < 0.5) {
        const tt = t / 0.5
        return { x: startX, y: startY - (startY - 50) * tt }
      }
      const tt = (t - 0.5) / 0.5
      return { x: startX - (startX - 5) * tt, y: 50 - (50 - endY) * tt }
    }
  }
  if (dir === 'East') {
    const startY = LANE.East.left
    const startX = 62 + STOP_OFFSET
    const endX = LANE.North.straight
    return (t) => {
      if (t < 0.5) {
        const tt = t / 0.5
        return { x: startX - (startX - 50) * tt, y: startY }
      }
      const tt = (t - 0.5) / 0.5
      return { x: 50 - (50 - endX) * tt, y: startY + (95 - startY) * tt }
    }
  }
  // West
  const startY = LANE.West.left
  const startX = 38 - STOP_OFFSET
  const endX = LANE.South.straight
  return (t) => {
    if (t < 0.5) {
      const tt = t / 0.5
      return { x: startX + (50 - startX) * tt, y: startY }
    }
    const tt = (t - 0.5) / 0.5
    return { x: 50 + (endX - 50) * tt, y: startY - (startY - 5) * tt }
  }
}

// 生成单列排队点位置（不移动），按方向与车道在停止线前排队（车流方向的右手车道）。
// 队列点数量固定为 min(实际排队, QUEUE_DISPLAY_CAP)，超出部分用颜色加深来表示。
function queuePositions(dir: Direction, lane: 'straight' | 'left', count: number): Array<{ x: number; y: number }> {
  const cap = Math.min(QUEUE_DISPLAY_CAP, count)
  const res: Array<{ x: number; y: number }> = []
  const gap = 4
  for (let i = 0; i < cap; i++) {
    if (dir === 'North') {
      const x = lane === 'straight' ? LANE.North.straight : LANE.North.left
      res.push({ x, y: 38 - STOP_OFFSET - i * gap })
    } else if (dir === 'South') {
      const x = lane === 'straight' ? LANE.South.straight : LANE.South.left
      res.push({ x, y: 62 + STOP_OFFSET + i * gap })
    } else if (dir === 'East') {
      const y = lane === 'straight' ? LANE.East.straight : LANE.East.left
      res.push({ x: 62 + STOP_OFFSET + i * gap, y })
    } else {
      const y = lane === 'straight' ? LANE.West.straight : LANE.West.left
      res.push({ x: 38 - STOP_OFFSET - i * gap, y })
    }
  }
  return res
}

// 根据排队数量返回灰色深度（透明度）：人数越多越深。
function congestionAlpha(count: number): number {
  const ratio = Math.max(0, Math.min(1, count / QUEUE_CONGESTION_FULL))
  // 在 0.35（基本可见） ~ 1.0（最深）之间映射
  return 0.35 + ratio * 0.65
}

// 根据排队数量返回灰色色相（拥挤时偏暖橙红，畅通时偏中性灰）。
function congestionColor(count: number): string {
  const ratio = Math.max(0, Math.min(1, count / QUEUE_CONGESTION_FULL))
  if (ratio < 0.33) return '#9ca3af' // gray-400
  if (ratio < 0.66) return '#6b7280' // gray-500
  if (ratio < 0.9) return '#b45309'  // amber-700 警告
  return '#991b1b'                   // red-800  严重拥堵
}

export default function FlowDots({ queuesStraight, queuesLeft, greenDirs, step }: {
  queuesStraight: Record<Direction, number>
  queuesLeft: Record<Direction, number>
  greenDirs: { straight: Direction[]; left: Direction[] }
  step: Step
}) {
  const [dots, setDots] = useState<Dot[]>([])
  const nextId = useRef(1)

  useEffect(() => {
    const raf = { id: 0 }
    const tick = () => {
      setDots((prev) => prev
        .map(d => ({ ...d, t: d.t + d.speed }))
        .filter(d => d.t <= 1)
      )
      raf.id = requestAnimationFrame(tick)
    }
    raf.id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.id)
  }, [])

  useEffect(() => {
    const spawn = () => {
      if (step !== 'ACTIVE') return
      greenDirs.straight.forEach((dir) => {
        const cap = Math.min(2, Math.floor((queuesStraight[dir] || 0) / 10) + 1)
        for (let i = 0; i < cap; i++) {
          setDots((prev) => prev.length < 80 ? [...prev, { id: nextId.current++, t: 0, speed: 0.010, path: pathStraight(dir), lane: 'straight' }] : prev)
        }
      })
      greenDirs.left.forEach((dir) => {
        const cap = Math.min(2, Math.floor((queuesLeft[dir] || 0) / 12) + 1)
        for (let i = 0; i < cap; i++) {
          setDots((prev) => prev.length < 80 ? [...prev, { id: nextId.current++, t: 0, speed: 0.012, path: pathLeft(dir), lane: 'left' }] : prev)
        }
      })
    }
    const timer = setInterval(spawn, 700)
    return () => clearInterval(timer)
  }, [queuesStraight, queuesLeft, greenDirs, step])

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-gray-900">车流动画</h2>
        {/* 拥挤度图例 */}
        <div className="flex items-center space-x-2 text-xs text-gray-600">
          <span>畅通</span>
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#9ca3af' }} />
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#6b7280' }} />
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#b45309' }} />
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#991b1b' }} />
          <span>拥堵</span>
        </div>
      </div>
      <div className="relative w-full" style={{ height: 380, overflow: 'hidden' }}>
        {/* SVG 十字路口背景与车辆渲染（统一坐标系） */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
          {/* 横向道路 */}
          <rect x="0" y="40" width="100" height="20" fill="#374151" />
          {/* 纵向道路 */}
          <rect x="40" y="0" width="20" height="100" fill="#374151" />
          {/* 中央分隔虚线（双向行车分界线） */}
          <line x1="0" y1="50" x2="100" y2="50" stroke="#f9fafb" strokeWidth="1.5" strokeDasharray="4 3" />
          <line x1="50" y1="0" x2="50" y2="100" stroke="#f9fafb" strokeWidth="1.5" strokeDasharray="4 3" />
          {/* 停止线 */}
          <line x1="40" y1="38" x2="50" y2="38" stroke="#fef3c7" strokeWidth="1.5" />
          <line x1="50" y1="62" x2="60" y2="62" stroke="#fef3c7" strokeWidth="1.5" />
          <line x1="62" y1="40" x2="62" y2="50" stroke="#fef3c7" strokeWidth="1.5" />
          <line x1="38" y1="50" x2="38" y2="60" stroke="#fef3c7" strokeWidth="1.5" />

          {/* 排队静态点：单列固定长度，超出部分通过颜色与不透明度反映拥挤度 */}
          {(['North', 'South', 'East', 'West'] as Direction[]).flatMap(dir => {
            const qs = queuesStraight[dir] || 0
            const ql = queuesLeft[dir] || 0
            const fillS = congestionColor(qs)
            const fillL = congestionColor(ql)
            const opS = congestionAlpha(qs)
            const opL = congestionAlpha(ql)
            return [
              ...queuePositions(dir, 'straight', QUEUE_DISPLAY_CAP).map((p, idx) => (
                <circle key={`qs-${dir}-${idx}`} cx={p.x} cy={p.y} r={1.3} fill={fillS} opacity={opS} />
              )),
              ...queuePositions(dir, 'left', QUEUE_DISPLAY_CAP).map((p, idx) => (
                <circle key={`ql-${dir}-${idx}`} cx={p.x} cy={p.y} r={1.3} fill={fillL} opacity={opL} />
              )),
            ]
          })}

          {/* 运动车辆点（从队头出发） */}
          {dots.map(d => {
            const { x, y } = d.path(d.t)
            return (
              <circle key={d.id} cx={x} cy={y} r={1.5} fill={d.lane === 'straight' ? '#3B82F6' : '#10B981'} />
            )
          })}
        </svg>
      </div>
    </div>
  )
}
