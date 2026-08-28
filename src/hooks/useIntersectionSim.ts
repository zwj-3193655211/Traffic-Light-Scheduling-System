import { useEffect, useRef, useState } from 'react'
import { applyActive, applyAllRed, applyYellow, calcPass, directions, nextPhaseOf, samplePoisson } from '../sim/core'
import type { Direction, LightState, Phase, Step } from '../sim/core'

const flowSchedule: Array<{ label: string; duration: number; rates: Record<Direction, number> }> = [
  { label: '早高峰东西向', duration: 90, rates: { North: 0.4, South: 0.5, East: 1.2, West: 1.1 } },
  { label: '平峰均衡', duration: 90, rates: { North: 0.6, South: 0.6, East: 0.6, West: 0.6 } },
  { label: '午高峰南北向', duration: 90, rates: { North: 1.1, South: 1.2, East: 0.4, West: 0.3 } },
]

export function useIntersectionSim(intersectionId: number | null, overrides?: {
  arrivalStraightScale?: number
  arrivalLeftScale?: number
  releaseStraightScale?: number
  releaseLeftScale?: number
}): {
  queuesStraight: Record<Direction, number>
  queuesLeft: Record<Direction, number>
  lights: Record<Direction, LightState>
  phase: Phase
  step: Step
  slotIdx: number
  slotLeft: number
  forceSwitchPhase: () => void
  forceAllRed: () => void
  forceYellow: () => void
  setSlotPeriod: (index: number) => void
  holdAllRed: () => void
  holdYellow: () => void
  clearOverride: () => void
  resetSimulation: () => void
} {
  const persistKey = intersectionId != null ? `sim_intersection_${intersectionId}` : 'sim_intersection_unknown'
  const [queuesStraight, setQueuesStraight] = useState<Record<Direction, number>>({ North: 0, South: 0, East: 0, West: 0 })
  const [queuesLeft, setQueuesLeft] = useState<Record<Direction, number>>({ North: 0, South: 0, East: 0, West: 0 })
  const [lights, setLights] = useState<Record<Direction, LightState>>(() => {
    const init: Record<Direction, LightState> = {
      North: { direction: 'North', straight: { status: 0, remainingTime: 0, defaultGreenTime: 30 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
      South: { direction: 'South', straight: { status: 0, remainingTime: 0, defaultGreenTime: 30 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
      East: { direction: 'East', straight: { status: 2, remainingTime: 40, defaultGreenTime: 40 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
      West: { direction: 'West', straight: { status: 2, remainingTime: 40, defaultGreenTime: 40 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
    }
    return init
  })
  const lightsRef = useRef<Record<Direction, LightState>>(lights)
  const [phase, setPhase] = useState<Phase>('EW_STRAIGHT')
  const [step, setStep] = useState<Step>('ACTIVE')
  const [slotIdx, setSlotIdx] = useState(0)
  const [slotLeft, setSlotLeft] = useState(flowSchedule[0].duration)
  const slotIdxRef = useRef(slotIdx)
  const stepRef = useRef(step)
  const phaseRef = useRef(phase)
  const greenElapsedRef = useRef<number>(0)
  const queuesStraightRef = useRef<Record<Direction, number>>({ North: 0, South: 0, East: 0, West: 0 })
  const queuesLeftRef = useRef<Record<Direction, number>>({ North: 0, South: 0, East: 0, West: 0 })
  const [override, setOverride] = useState<null | 'ALL_RED' | 'YELLOW'>(null)
  const overrideRef = useRef<null | 'ALL_RED' | 'YELLOW'>(null)
  useEffect(() => { overrideRef.current = override }, [override])
  const arrivalStraightScale = useRef<number>(parseFloat(((import.meta as any).env?.VITE_DEMO_ARRIVAL_SCALE_STRAIGHT) || '0.3'))
  const arrivalLeftScale = useRef<number>(parseFloat(((import.meta as any).env?.VITE_DEMO_ARRIVAL_SCALE_LEFT) || '0.12'))
  const releaseStraightScale = useRef<number>(parseFloat(((import.meta as any).env?.VITE_DEMO_RELEASE_STRAIGHT_SCALE) || '0.8'))
  const releaseLeftScale = useRef<number>(parseFloat(((import.meta as any).env?.VITE_DEMO_RELEASE_LEFT_SCALE) || '1.4'))

  useEffect(() => { slotIdxRef.current = slotIdx }, [slotIdx])
  useEffect(() => { stepRef.current = step }, [step])
  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { queuesStraightRef.current = queuesStraight }, [queuesStraight])
  useEffect(() => { queuesLeftRef.current = queuesLeft }, [queuesLeft])
  useEffect(() => { lightsRef.current = lights }, [lights])
  useEffect(() => {
    if (overrides?.arrivalStraightScale !== undefined) arrivalStraightScale.current = overrides.arrivalStraightScale
    if (overrides?.arrivalLeftScale !== undefined) arrivalLeftScale.current = overrides.arrivalLeftScale
    if (overrides?.releaseStraightScale !== undefined) releaseStraightScale.current = overrides.releaseStraightScale
    if (overrides?.releaseLeftScale !== undefined) releaseLeftScale.current = overrides.releaseLeftScale
  }, [overrides?.arrivalStraightScale, overrides?.arrivalLeftScale, overrides?.releaseStraightScale, overrides?.releaseLeftScale])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(persistKey)
      if (raw) {
        const s = JSON.parse(raw)
        if (s.queuesStraight) setQueuesStraight(s.queuesStraight)
        if (s.queuesLeft) setQueuesLeft(s.queuesLeft)
        if (s.lights) setLights(s.lights)
        if (s.phase) setPhase(s.phase)
        if (s.step) setStep(s.step)
        if (typeof s.slotIdx === 'number') setSlotIdx(s.slotIdx)
        if (typeof s.slotLeft === 'number') setSlotLeft(s.slotLeft)
      }
    } catch {}
  }, [persistKey])

  useEffect(() => {
    const s = { queuesStraight, queuesLeft, lights, phase, step, slotIdx, slotLeft }
    try { localStorage.setItem(persistKey, JSON.stringify(s)) } catch {}
  }, [queuesStraight, queuesLeft, lights, phase, step, slotIdx, slotLeft, persistKey])

  const onSpawnTick = () => {
    setSlotLeft((n) => {
      const v = n - 1
      if (v > 0) return v
      const nextIdx = (slotIdxRef.current + 1) % flowSchedule.length
      setSlotIdx(nextIdx)
      return flowSchedule[nextIdx].duration
    })
    setQueuesStraight((q) => {
      const next = { ...q }
      const rates = flowSchedule[slotIdxRef.current].rates
      directions.forEach((d) => {
        const lambda = Math.max(0, rates[d] * arrivalStraightScale.current)
        const add = samplePoisson(lambda)
        next[d] = Math.min(999, next[d] + add)
      })
      return next
    })
    setQueuesLeft((q) => {
      const next = { ...q }
      const rates = flowSchedule[slotIdxRef.current].rates
      directions.forEach((d) => {
        const lambda = Math.max(0, rates[d] * arrivalLeftScale.current * 0.6)
        const add = samplePoisson(lambda)
        next[d] = Math.min(999, next[d] + add)
      })
      return next
    })
  }

  const onLightsTick = () => {
    if (overrideRef.current === 'ALL_RED') {
      setLights((prev) => applyAllRed(prev))
      setStep('ALL_RED')
      return
    }
    if (overrideRef.current === 'YELLOW') {
      setLights((prev) => applyYellow(prev, phaseRef.current))
      setStep('YELLOW')
      return
    }
    setLights((prev) => {
      const next = { ...prev }
      directions.forEach((d) => {
        next[d] = {
          direction: d,
          straight: { ...next[d].straight, remainingTime: Math.max(0, next[d].straight.remainingTime - 1) },
          left: { ...next[d].left, remainingTime: Math.max(0, next[d].left.remainingTime - 1) },
        }
      })
      if (stepRef.current === 'ACTIVE') {
        if (phaseRef.current === 'EW_STRAIGHT') {
          const g = (next.East.straight.defaultGreenTime || 0) - next.East.straight.remainingTime
          greenElapsedRef.current = Math.max(0, g)
        } else if (phaseRef.current === 'EW_LEFT') {
          const g = (next.East.left.defaultGreenTime || 0) - next.East.left.remainingTime
          greenElapsedRef.current = Math.max(0, g)
        } else if (phaseRef.current === 'NS_STRAIGHT') {
          const g = (next.North.straight.defaultGreenTime || 0) - next.North.straight.remainingTime
          greenElapsedRef.current = Math.max(0, g)
        } else {
          const g = (next.North.left.defaultGreenTime || 0) - next.North.left.remainingTime
          greenElapsedRef.current = Math.max(0, g)
        }
      } else {
        greenElapsedRef.current = 0
      }
      const threshold = parseInt((import.meta as any).env?.VITE_LOW_FLOW_THRESHOLD || '8')
      const minGreen = parseInt((import.meta as any).env?.VITE_MIN_GREEN_FLOOR_SECONDS || '5')
      if (stepRef.current === 'ACTIVE') {
        if (phaseRef.current === 'EW_STRAIGHT') {
          const group = (queuesStraightRef.current.East || 0) + (queuesStraightRef.current.West || 0)
          if (group <= threshold) {
            next.East.straight.remainingTime = Math.min(next.East.straight.remainingTime, minGreen)
            next.West.straight.remainingTime = Math.min(next.West.straight.remainingTime, minGreen)
          }
        } else if (phaseRef.current === 'EW_LEFT') {
          const group = (queuesLeftRef.current.East || 0) + (queuesLeftRef.current.West || 0)
          if (group <= threshold) {
            next.East.left.remainingTime = Math.min(next.East.left.remainingTime, minGreen)
            next.West.left.remainingTime = Math.min(next.West.left.remainingTime, minGreen)
          }
        } else if (phaseRef.current === 'NS_STRAIGHT') {
          const group = (queuesStraightRef.current.North || 0) + (queuesStraightRef.current.South || 0)
          if (group <= threshold) {
            next.North.straight.remainingTime = Math.min(next.North.straight.remainingTime, minGreen)
            next.South.straight.remainingTime = Math.min(next.South.straight.remainingTime, minGreen)
          }
        } else {
          const group = (queuesLeftRef.current.North || 0) + (queuesLeftRef.current.South || 0)
          if (group <= threshold) {
            next.North.left.remainingTime = Math.min(next.North.left.remainingTime, minGreen)
            next.South.left.remainingTime = Math.min(next.South.left.remainingTime, minGreen)
          }
        }
      }
      return next
    })

    if (stepRef.current === 'ACTIVE') {
      if (phaseRef.current === 'EW_STRAIGHT') {
        setQueuesStraight((q) => {
          const next = { ...q }
          const passE = calcPass(next.East, greenElapsedRef.current, 'straight', releaseStraightScale.current)
          const passW = calcPass(next.West, greenElapsedRef.current, 'straight', releaseStraightScale.current)
          next.East = Math.max(0, next.East - passE)
          next.West = Math.max(0, next.West - passW)
          return next
        })
      }
      if (phaseRef.current === 'EW_LEFT') {
        setQueuesLeft((q) => {
          const next = { ...q }
          const passE = calcPass(next.East, greenElapsedRef.current, 'left', releaseLeftScale.current)
          const passW = calcPass(next.West, greenElapsedRef.current, 'left', releaseLeftScale.current)
          next.East = Math.max(0, next.East - passE)
          next.West = Math.max(0, next.West - passW)
          return next
        })
      }
      if (phaseRef.current === 'NS_STRAIGHT') {
        setQueuesStraight((q) => {
          const next = { ...q }
          const passN = calcPass(next.North, greenElapsedRef.current, 'straight', releaseStraightScale.current)
          const passS = calcPass(next.South, greenElapsedRef.current, 'straight', releaseStraightScale.current)
          next.North = Math.max(0, next.North - passN)
          next.South = Math.max(0, next.South - passS)
          return next
        })
      }
      if (phaseRef.current === 'NS_LEFT') {
        setQueuesLeft((q) => {
          const next = { ...q }
          const passN = calcPass(next.North, greenElapsedRef.current, 'left', releaseLeftScale.current)
          const passS = calcPass(next.South, greenElapsedRef.current, 'left', releaseLeftScale.current)
          next.North = Math.max(0, next.North - passN)
          next.South = Math.max(0, next.South - passS)
          return next
        })
      }
    }

    setLights((prev) => {
      const isActiveEnded = (() => {
        if (stepRef.current !== 'ACTIVE') return false
        if (phaseRef.current === 'EW_STRAIGHT') return prev.East.straight.remainingTime === 0 && prev.West.straight.remainingTime === 0
        if (phaseRef.current === 'EW_LEFT') return prev.East.left.remainingTime === 0 && prev.West.left.remainingTime === 0
        if (phaseRef.current === 'NS_STRAIGHT') return prev.North.straight.remainingTime === 0 && prev.South.straight.remainingTime === 0
        return prev.North.left.remainingTime === 0 && prev.South.left.remainingTime === 0
      })()
      if (stepRef.current === 'ACTIVE' && isActiveEnded) {
        const next = applyYellow(prev, phaseRef.current)
        setStep('YELLOW')
        return next
      }

      const isYellowEnded = stepRef.current === 'YELLOW' && directions.every((d) => prev[d].straight.remainingTime === 0 && prev[d].left.remainingTime === 0)
      if (isYellowEnded) {
        const next = applyAllRed(prev)
        setStep('ALL_RED')
        return next
      }

      const isAllRedEnded = stepRef.current === 'ALL_RED' && directions.every((d) => prev[d].straight.remainingTime === 0 && prev[d].left.remainingTime === 0)
      if (isAllRedEnded) {
        const nextPhase = nextPhaseOf(phaseRef.current)
        const next = applyActive(nextPhase, prev, queuesStraightRef.current, queuesLeftRef.current)
        setPhase(nextPhase)
        setStep('ACTIVE')
        return next
      }

      return prev
    })
  }

  useEffect(() => {
    if (!intersectionId) return
    let w: Worker | null = null
    let timer: any = null
    try {
      w = new Worker(new URL('../workers/timerWorker.ts', import.meta.url), { type: 'module' })
      w.onmessage = () => {
        onLightsTick()
        onSpawnTick()
      }
      w.postMessage({ type: 'START', interval: 1000 })
    } catch {
      timer = setInterval(() => {
        onLightsTick()
        onSpawnTick()
      }, 1000)
    }
    return () => {
      if (w) {
        try { w.postMessage({ type: 'STOP' }) } catch {}
        try { w.terminate() } catch {}
      }
      if (timer) clearInterval(timer)
    }
  }, [intersectionId])

  const forceSwitchPhase = () => {
    const nextPhase = nextPhaseOf(phaseRef.current)
    setLights(prev => applyActive(nextPhase, prev, queuesStraightRef.current, queuesLeftRef.current))
    setPhase(nextPhase)
    setStep('ACTIVE')
  }
  const forceAllRed = () => {
    setLights(prev => applyAllRed(prev))
    setStep('ALL_RED')
  }
  const forceYellow = () => {
    setLights(prev => applyYellow(prev, phaseRef.current))
    setStep('YELLOW')
  }

  const setSlotPeriod = (index: number) => {
    const i = Math.max(0, Math.min(flowSchedule.length - 1, index))
    setSlotIdx(i)
    setSlotLeft(flowSchedule[i].duration)
    try {
      const raw = localStorage.getItem(persistKey)
      const s = raw ? JSON.parse(raw) : {}
      s.slotIdx = i
      s.slotLeft = flowSchedule[i].duration
      s.override = overrideRef.current
      localStorage.setItem(persistKey, JSON.stringify(s))
    } catch {}
  }

  const holdAllRed = () => {
    setOverride('ALL_RED')
    try {
      const raw = localStorage.getItem(persistKey)
      const s = raw ? JSON.parse(raw) : {}
      s.override = 'ALL_RED'
      localStorage.setItem(persistKey, JSON.stringify(s))
    } catch {}
  }
  const holdYellow = () => {
    setOverride('YELLOW')
    try {
      const raw = localStorage.getItem(persistKey)
      const s = raw ? JSON.parse(raw) : {}
      s.override = 'YELLOW'
      localStorage.setItem(persistKey, JSON.stringify(s))
    } catch {}
  }
  const clearOverride = () => {
    setOverride(null)
    try {
      const raw = localStorage.getItem(persistKey)
      const s = raw ? JSON.parse(raw) : {}
      s.override = null
      localStorage.setItem(persistKey, JSON.stringify(s))
    } catch {}
  }

  // 同步数据到后端
  useEffect(() => {
    const enableBackendSync = String(((import.meta as any).env?.VITE_DEMO_SYNC_BACKEND) ?? '') === '1'
    if (!intersectionId || !enableBackendSync) return

    fetch('/api/settings/selected-intersection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intersectionId })
    }).catch(() => {})
    
    const syncToBackend = async () => {
      // 1. 同步车流数据
      const flowPayload = {
        intersectionId,
        flowData: directions.map(d => ({
          direction: d,
          vehicleCount: queuesStraightRef.current[d] + queuesLeftRef.current[d],
          averageSpeed: 30 // 模拟速度
        }))
      }
      
      fetch('/api/vehicle-flows/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flowPayload)
      }).catch(() => {}) // 忽略错误，避免刷屏

      // 2. 同步红绿灯状态
      const lightsPayload: any[] = []
      directions.forEach(d => {
        const l = lightsRef.current[d]
        lightsPayload.push({
          direction: d,
          movement_type: 'straight',
          current_status: l.straight.status,
          remaining_time: l.straight.remainingTime
        })
        lightsPayload.push({
          direction: d,
          movement_type: 'left',
          current_status: l.left.status,
          remaining_time: l.left.remainingTime
        })
      })

      fetch('/api/traffic-lights/batch-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intersectionId,
          lights: lightsPayload
        })
      }).catch(() => {})
    }

    syncToBackend().catch(() => {})
    const timer = setInterval(syncToBackend, 3000) // 每3秒同步一次
    return () => clearInterval(timer)
  }, [intersectionId])

  const resetSimulation = () => {
    setQueuesStraight({ North: 0, South: 0, East: 0, West: 0 })
    setQueuesLeft({ North: 0, South: 0, East: 0, West: 0 })
    setLights({
      North: { direction: 'North', straight: { status: 0, remainingTime: 0, defaultGreenTime: 30 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
      South: { direction: 'South', straight: { status: 0, remainingTime: 0, defaultGreenTime: 30 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
      East: { direction: 'East', straight: { status: 2, remainingTime: 40, defaultGreenTime: 40 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
      West: { direction: 'West', straight: { status: 2, remainingTime: 40, defaultGreenTime: 40 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
    })
    setPhase('EW_STRAIGHT')
    setStep('ACTIVE')
    setSlotIdx(0)
    setSlotLeft(flowSchedule[0].duration)
    try { localStorage.removeItem(persistKey) } catch {}
  }

  return { queuesStraight, queuesLeft, lights, phase, step, slotIdx, slotLeft, forceSwitchPhase, forceAllRed, forceYellow, setSlotPeriod, holdAllRed, holdYellow, clearOverride, resetSimulation }
}
