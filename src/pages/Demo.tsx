import React, { useEffect, useRef, useState } from 'react'
import IntersectionMonitor from '../components/IntersectionMonitor'
import type { Direction, LightState, Phase, Step } from '../sim/core'
import { getTrafficPeriod } from '../lib/utils'
import { useAiMode } from '@/hooks/useAiMode'
import { getSocket } from '@/lib/socket'
import type { AiAdvice, TrafficLight, VehicleFlow } from '@/types'

const Demo: React.FC = () => {
  const [intersections, setIntersections] = useState<Array<{ id: number; name: string }>>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selectedIdRef = useRef<number | null>(null)
  const [trafficLights, setTrafficLights] = useState<TrafficLight[]>([])
  // AI 开关：拉取、提交、跨页面广播同步统一由 hook 处理
  const { enabled: aiEnabled, setEnabled: updateAiMode, enabledRef: aiEnabledRef } = useAiMode()
  const [lastAiAdvice, setLastAiAdvice] = useState<AiAdvice | null>(null)
  const [queueSnapshot, setQueueSnapshot] = useState<Record<Direction, number>>({ North: 0, South: 0, East: 0, West: 0 })
  const [queueSnapshotSplit, setQueueSnapshotSplit] = useState<{ straight: Record<Direction, number>; left: Record<Direction, number> } | null>(null)
  const [arrivalStraightScale, setArrivalStraightScale] = useState<number>(parseFloat(((import.meta as any).env?.VITE_DEMO_ARRIVAL_SCALE_STRAIGHT) || '0.3'))
  const [arrivalLeftScale, setArrivalLeftScale] = useState<number>(parseFloat(((import.meta as any).env?.VITE_DEMO_ARRIVAL_SCALE_LEFT) || '0.2'))
  const [releaseStraightScale, setReleaseStraightScale] = useState<number>(parseFloat(((import.meta as any).env?.VITE_DEMO_RELEASE_STRAIGHT_SCALE) || '0.8'))
  const [releaseLeftScale, setReleaseLeftScale] = useState<number>(parseFloat(((import.meta as any).env?.VITE_DEMO_RELEASE_LEFT_SCALE) || '0.7'))
  const [paramsLoaded, setParamsLoaded] = useState(false)

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])
  // 关闭 AI 时清空上一次建议，避免展示过期数据
  useEffect(() => {
    if (!aiEnabled) setLastAiAdvice(null)
  }, [aiEnabled])

  useEffect(() => {
    ;(async () => {
      try {
        const [res, selectedRes] = await Promise.all([
          fetch('/api/intersections'),
          fetch('/api/settings/selected-intersection').catch(() => null as any),
        ])
        const json = await res.json()
        const list = (json.data || []).map((i: any) => ({ id: Number(i.id), name: i.name }))
        setIntersections(list)

        let backendSelectedId: number | null = null
        try {
          if (selectedRes) {
            const selectedJson = await selectedRes.json()
            const v = Number(selectedJson?.data ?? 0)
            backendSelectedId = v > 0 ? v : null
          }
        } catch {}

        const hasId = (id: number | null | undefined) => id != null && list.some((i: any) => Number(i.id) === Number(id))
        const nextSelected = hasId(backendSelectedId)
          ? backendSelectedId
          : (list.length > 0 ? Number(list[0].id) : null)
        setSelectedId(nextSelected)
      } catch {}
    })()
  }, [])

  useEffect(() => {
    const s = getSocket()

    const onTrafficLightUpdate = (data: any) => {
      const selected = selectedIdRef.current
      if (selected != null && Array.isArray(data) && data.length > 0 && data[0].intersection_id !== selected) return
      setTrafficLights(Array.isArray(data) ? data : [])
    }
    s.on('trafficLightUpdate', onTrafficLightUpdate)

    const onLightStatusUpdate = (data: any) => {
      setTrafficLights(prev => prev.map(l => l.id === data.lightId ? { ...l, current_status: data.status, remaining_time: data.remainingTime } : l))
    }
    s.on('light_status_update', onLightStatusUpdate)

    const onVehicleFlowUpdate = (data: any) => {
      const normalized: VehicleFlow[] = Array.isArray(data)
        ? data
        : (Array.isArray(data?.batchData)
          ? data.batchData.map((it: any, idx: number) => ({
              id: (it?.id ?? idx) as number,
              intersection_id: Number(it?.intersectionId ?? data?.intersectionId) as number,
              direction: it?.direction as any,
              vehicle_count: Number(it?.vehicleCount ?? it?.vehicle_count ?? 0),
              straight_count: it?.straightCount ?? it?.straight_count,
              left_count: it?.leftCount ?? it?.left_count,
              timestamp: (it?.timestamp ?? data?.timestamp ?? new Date().toISOString()) as string,
            }))
          : [])

      const selected = selectedIdRef.current
      if (selected == null) return
      const items = normalized.filter(d => d.intersection_id === selected)
      if (items.length === 0) return
      const hasSplit = items.some((it: any) => it?.straight_count != null || it?.left_count != null)
      if (hasSplit) {
        setQueueSnapshotSplit(prev => {
          const next = prev ?? { straight: { North: 0, South: 0, East: 0, West: 0 }, left: { North: 0, South: 0, East: 0, West: 0 } }
          const straight = { ...next.straight }
          const left = { ...next.left }
          for (const it of items as any[]) {
            if (it.direction === 'North' || it.direction === 'South' || it.direction === 'East' || it.direction === 'West') {
              if (it.straight_count != null) (straight as any)[it.direction] = Number(it.straight_count ?? 0)
              if (it.left_count != null) (left as any)[it.direction] = Number(it.left_count ?? 0)
            }
          }
          return { straight, left }
        })
      }
      setQueueSnapshot(prev => {
        const next = { ...prev }
        for (const it of items) {
          if (it.direction === 'North' || it.direction === 'South' || it.direction === 'East' || it.direction === 'West') {
            ;(next as any)[it.direction] = Number(it.vehicle_count ?? 0)
          }
        }
        return next
      })
    };
    s.on('vehicleFlowUpdate', onVehicleFlowUpdate)

    const onTrafficTimingUpdate = (data: any) => {
      if (aiEnabledRef.current && data?.source === 'ai') {
        setLastAiAdvice({
          intersectionId: data.intersectionId,
          green: data.advice?.green,
          reason: data.advice?.reason,
        })
      }
    }
    s.on('trafficTimingUpdate', onTrafficTimingUpdate)

    // AI 开关的跨页面同步由 useAiMode 内部监听，此处不再重复订阅
    // 注意：socket 为全局单例，此处不能 close/disconnect，否则会影响其他页面的实时推送
    // 卸载时只解绑自己的监听，避免 StrictMode 双挂载/路由往返导致重复注册
    return () => {
      s.off('trafficLightUpdate', onTrafficLightUpdate)
      s.off('light_status_update', onLightStatusUpdate)
      s.off('vehicleFlowUpdate', onVehicleFlowUpdate)
      s.off('trafficTimingUpdate', onTrafficTimingUpdate)
    }
  }, [])

  useEffect(() => {
    if (selectedId == null) return
    // 路口切换瞬间立即清空脏数据
    setTrafficLights([])
    setQueueSnapshot({ North: 0, South: 0, East: 0, West: 0 })
    setQueueSnapshotSplit(null)
    ;(async () => {
      try {
        const tlRes = await fetch(`/api/traffic-lights?intersection_id=${selectedId}`)
        const tlJson = await tlRes.json()
        setTrafficLights(tlJson.data || [])

        const flowsRes = await fetch(`/api/vehicle-flows?intersection_id=${selectedId}&time_range=hour`)
        const flowsJson = await flowsRes.json()
        const flows = Array.isArray(flowsJson.data) ? flowsJson.data : []
        const nextSnapshot: Record<Direction, number> = { North: 0, South: 0, East: 0, West: 0 }
        const seen = new Set<string>()
        for (const it of flows) {
          const dir = it?.direction
          if ((dir === 'North' || dir === 'South' || dir === 'East' || dir === 'West') && !seen.has(dir)) {
            seen.add(dir)
            nextSnapshot[dir] = Number(it?.vehicle_count ?? 0)
          }
        }
        setQueueSnapshot(nextSnapshot)
        try {
          const splitRes = await fetch(`/api/vehicle-flows/realtime-split?intersection_id=${selectedId}`)
          const splitJson = await splitRes.json()
          const v = splitJson?.data
          if (v && typeof v === 'object') {
            const straight: Record<Direction, number> = { North: 0, South: 0, East: 0, West: 0 }
            const left: Record<Direction, number> = { North: 0, South: 0, East: 0, West: 0 }
            for (const dir of ['North', 'South', 'East', 'West'] as Direction[]) {
              straight[dir] = Number(v?.[dir]?.straight ?? 0)
              left[dir] = Number(v?.[dir]?.left ?? 0)
            }
            setQueueSnapshotSplit({ straight, left })
            setQueueSnapshot({ North: straight.North + left.North, South: straight.South + left.South, East: straight.East + left.East, West: straight.West + left.West })
          }
        } catch {}
      } catch {}
    })()

    fetch('/api/settings/selected-intersection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intersectionId: selectedId })
    }).catch(() => {})

    try {
      setParamsLoaded(false)
      ;(async () => {
        try {
          const res = await fetch(`/api/settings/intersection-params/${selectedId}`)
          const json = await res.json()
          const p = json?.data
          if (p) {
            if (p.arrival_straight_scale != null) setArrivalStraightScale(Number(p.arrival_straight_scale))
            if (p.arrival_left_scale != null) setArrivalLeftScale(Number(p.arrival_left_scale))
            if (p.release_straight_scale != null) setReleaseStraightScale(Number(p.release_straight_scale))
            if (p.release_left_scale != null) setReleaseLeftScale(Number(p.release_left_scale))
          }
          setParamsLoaded(true)
        } catch {
          setParamsLoaded(true)
        }
      })()
    } catch {}
  }, [selectedId])

  useEffect(() => {
    if (selectedId == null) return
    if (!paramsLoaded) return
    const timer = setTimeout(() => {
      fetch(`/api/settings/intersection-params/${selectedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          arrival_straight_scale: arrivalStraightScale,
          arrival_left_scale: arrivalLeftScale,
          release_straight_scale: releaseStraightScale,
          release_left_scale: releaseLeftScale,
        })
      }).catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [selectedId, paramsLoaded, arrivalStraightScale, arrivalLeftScale, releaseStraightScale, releaseLeftScale])

  const selectedLights = selectedId == null ? [] : trafficLights.filter(l => l.intersection_id === selectedId)

  const monitorLights: Record<Direction, LightState> = (['North', 'South', 'East', 'West'] as Direction[]).reduce((acc, dir) => {
    const pick = (movement: 'straight' | 'left') =>
      selectedLights.find(l => l.direction === dir && (l.movement_type ?? 'straight') === movement)
      ?? selectedLights.find(l => l.direction === dir)

    const s = pick('straight')
    const l = pick('left')

    acc[dir] = {
      direction: dir,
      straight: {
        status: (s?.current_status ?? 0) as 0 | 1 | 2,
        remainingTime: Number(s?.remaining_time ?? 0),
        defaultGreenTime: Number(s?.default_green_time ?? 30),
      },
      left: {
        status: (l?.current_status ?? 0) as 0 | 1 | 2,
        remainingTime: Number(l?.remaining_time ?? 0),
        defaultGreenTime: Number(l?.default_green_time ?? 20),
      },
    }
    return acc
  }, {} as Record<Direction, LightState>)

  const queuesStraight: Record<Direction, number> = queueSnapshotSplit?.straight ?? {
    North: Math.round((queueSnapshot.North || 0) * 0.7),
    South: Math.round((queueSnapshot.South || 0) * 0.7),
    East: Math.round((queueSnapshot.East || 0) * 0.7),
    West: Math.round((queueSnapshot.West || 0) * 0.7),
  }
  const queuesLeft: Record<Direction, number> = queueSnapshotSplit?.left ?? {
    North: Math.round((queueSnapshot.North || 0) * 0.3),
    South: Math.round((queueSnapshot.South || 0) * 0.3),
    East: Math.round((queueSnapshot.East || 0) * 0.3),
    West: Math.round((queueSnapshot.West || 0) * 0.3),
  }

  const step: Step = selectedLights.some(l => l.current_status === 2)
    ? 'ACTIVE'
    : selectedLights.some(l => l.current_status === 1)
      ? 'YELLOW'
      : 'ALL_RED'

  const phase: Phase = (() => {
    const greens = selectedLights.filter(l => l.current_status === 2)
    const active = greens.length > 0 ? greens : selectedLights.filter(l => l.current_status === 1)
    const has = (dirs: Direction[], movement: 'straight' | 'left') =>
      active.some(l => (l.direction === dirs[0] || l.direction === dirs[1]) && (l.movement_type ?? 'straight') === movement)

    if (has(['East', 'West'], 'straight')) return 'EW_STRAIGHT'
    if (has(['East', 'West'], 'left')) return 'EW_LEFT'
    if (has(['North', 'South'], 'straight')) return 'NS_STRAIGHT'
    if (has(['North', 'South'], 'left')) return 'NS_LEFT'
    return 'EW_STRAIGHT'
  })()

  const greenLeft = Math.max(0, ...selectedLights.filter(l => l.current_status === 2).map(l => Number(l.remaining_time ?? 0)))
  const period = getTrafficPeriod()
  const periodLabel = period.label
  const periodLeft = Math.max(0, Math.floor((period.endsAt - Date.now()) / 1000))

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">功能演示：路口选择</h1>
        </div>
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-700">选择路口</span>
            <select
              value={selectedId ?? ''}
              onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
              className="px-3 py-2 border border-gray-300 rounded bg-white"
            >
              {intersections.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={aiEnabled}
              onChange={(e) => updateAiMode(e.target.checked)}
              className="mr-2"
            />
            <span className="text-sm text-gray-700">开启AI动态红绿灯</span>
          </label>

          {lastAiAdvice && (
            <div className="text-xs text-gray-600">
              AI建议: G {lastAiAdvice.green}s
              {lastAiAdvice.reason && (
                <div className="text-[11px] text-gray-500 mt-0.5">依据: {lastAiAdvice.reason}</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <IntersectionMonitor
          lights={monitorLights as any}
          queuesStraight={queuesStraight}
          queuesLeft={queuesLeft}
          phase={phase as any}
          step={step as any}
          periodLabel={periodLabel}
          periodLeft={periodLeft}
          greenLeft={greenLeft}
        />

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">虚拟车流参数</h2>
          <div className="text-sm text-gray-700 mb-4">
            到达缩放影响队列增长速度；释放缩放影响绿灯期间队列消散速度。
          </div>
          <div className="grid grid-cols-1 gap-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-700">直行到达缩放</span>
                <span className="text-sm text-gray-900">{arrivalStraightScale.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={10}
                step={0.05}
                value={arrivalStraightScale}
                onChange={(e) => setArrivalStraightScale(parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-700">左转到达缩放</span>
                <span className="text-sm text-gray-900">{arrivalLeftScale.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                step={0.05}
                value={arrivalLeftScale}
                onChange={(e) => setArrivalLeftScale(parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-700">直行释放强度缩放</span>
                <span className="text-sm text-gray-900">{releaseStraightScale.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.05}
                max={10}
                step={0.05}
                value={releaseStraightScale}
                onChange={(e) => setReleaseStraightScale(parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-700">左转释放强度缩放</span>
                <span className="text-sm text-gray-900">{releaseLeftScale.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.05}
                max={10}
                step={0.05}
                value={releaseLeftScale}
                onChange={(e) => setReleaseLeftScale(parseFloat(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Demo
