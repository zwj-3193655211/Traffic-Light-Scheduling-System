import { create } from 'zustand'
import { straightGreen, leftGreen, samplePoisson, calcPass, nextPhaseOf, applyActive, applyYellow, applyAllRed } from '../sim/core'

type Direction = 'North' | 'South' | 'East' | 'West'
type Phase = 'EW_STRAIGHT' | 'EW_LEFT' | 'NS_STRAIGHT' | 'NS_LEFT'
type Step = 'ACTIVE' | 'YELLOW' | 'ALL_RED'

interface MovementState {
  status: 0 | 1 | 2
  remainingTime: number
  defaultGreenTime: number
}

interface LightState {
  direction: Direction
  straight: MovementState
  left: MovementState
}

interface WeatherInfo {
  condition: '晴' | '多云' | '小雨' | '大雨' | '阴'
  temperature: number
}

const directions: Direction[] = ['North', 'South', 'East', 'West']
const flowSchedule: Array<{ label: string; duration: number; rates: Record<Direction, number> }> = [
  { label: '早高峰东西向', duration: 90, rates: { North: 0.4, South: 0.5, East: 1.2, West: 1.1 } },
  { label: '平峰均衡', duration: 90, rates: { North: 0.6, South: 0.6, East: 0.6, West: 0.6 } },
  { label: '午高峰南北向', duration: 90, rates: { North: 1.1, South: 1.2, East: 0.4, West: 0.3 } },
  { label: '晚间低流量', duration: 90, rates: { North: 0.2, South: 0.2, East: 0.3, West: 0.3 } },
]

interface DemoState {
  queuesStraight: Record<Direction, number>
  queuesLeft: Record<Direction, number>
  lights: Record<Direction, LightState>
  phase: Phase
  step: Step
  weather: WeatherInfo
  slotIdx: number
  slotLeft: number
  arrivalStraightScale: number
  arrivalLeftScale: number
  releaseStraightScale: number
  releaseLeftScale: number
}

interface DemoActions {
  start: () => void
  clearQueues: () => void
  switchPhaseNow: () => void
  setArrivalStraightScale: (v: number) => void
  setArrivalLeftScale: (v: number) => void
  setReleaseStraightScale: (v: number) => void
  setReleaseLeftScale: (v: number) => void
}

const persistKey = 'demo_state_v1'
let worker: Worker | null = null
let weatherTimer: any = null

export const useDemoEngine = create<DemoState & DemoActions>((set, get) => {
  const initialLights: Record<Direction, LightState> = {
    North: { direction: 'North', straight: { status: 0, remainingTime: 0, defaultGreenTime: 30 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
    South: { direction: 'South', straight: { status: 0, remainingTime: 0, defaultGreenTime: 30 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
    East: { direction: 'East', straight: { status: 2, remainingTime: 40, defaultGreenTime: 40 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
    West: { direction: 'West', straight: { status: 2, remainingTime: 40, defaultGreenTime: 40 }, left: { status: 0, remainingTime: 0, defaultGreenTime: 20 } },
  }

  let initial: DemoState = {
    queuesStraight: { North: 0, South: 0, East: 0, West: 0 },
    queuesLeft: { North: 0, South: 0, East: 0, West: 0 },
    lights: initialLights,
    phase: 'EW_STRAIGHT',
    step: 'ACTIVE',
    weather: { condition: '晴', temperature: 22 },
    slotIdx: 0,
    slotLeft: flowSchedule[0].duration,
    arrivalStraightScale: parseFloat(((import.meta as any).env?.VITE_DEMO_ARRIVAL_SCALE_STRAIGHT) || '0.3'),
    arrivalLeftScale: parseFloat(((import.meta as any).env?.VITE_DEMO_ARRIVAL_SCALE_LEFT) || '0.2'),
    releaseStraightScale: parseFloat(((import.meta as any).env?.VITE_DEMO_RELEASE_STRAIGHT_SCALE) || '0.8'),
    releaseLeftScale: parseFloat(((import.meta as any).env?.VITE_DEMO_RELEASE_LEFT_SCALE) || '0.7'),
  }

  try {
    const raw = localStorage.getItem(persistKey)
    if (raw) {
      const s = JSON.parse(raw)
      initial = { ...initial, ...s }
    }
  } catch {}

  const save = () => {
    try { localStorage.setItem(persistKey, JSON.stringify(get())) } catch {}
  }

  const onSpawnTick = () => {
    const st = get()
    const nextSlotLeft = st.slotLeft - 1
    let slotIdx = st.slotIdx
    let slotLeft = nextSlotLeft
    if (nextSlotLeft <= 0) {
      slotIdx = (st.slotIdx + 1) % flowSchedule.length
      slotLeft = flowSchedule[slotIdx].duration
    }
    const rates = flowSchedule[slotIdx].rates
    const nextQueuesStraight: Record<Direction, number> = { ...st.queuesStraight }
    const nextQueuesLeft: Record<Direction, number> = { ...st.queuesLeft }
    directions.forEach((d) => {
      const lambdaS = Math.max(0, rates[d] * st.arrivalStraightScale)
      const addS = samplePoisson(lambdaS)
      nextQueuesStraight[d] = Math.min(999, nextQueuesStraight[d] + addS)
      const lambdaL = Math.max(0, rates[d] * st.arrivalLeftScale)
      const addL = samplePoisson(lambdaL)
      nextQueuesLeft[d] = Math.min(999, nextQueuesLeft[d] + addL)
    })
    set({ slotIdx, slotLeft, queuesStraight: nextQueuesStraight, queuesLeft: nextQueuesLeft })
    save()
  }

  const onLightsTick = () => {
    const st = get()
    const nextLights: Record<Direction, LightState> = { ...st.lights }
    directions.forEach((d) => {
      nextLights[d] = {
        direction: d,
        straight: { ...nextLights[d].straight, remainingTime: Math.max(0, nextLights[d].straight.remainingTime - 1) },
        left: { ...nextLights[d].left, remainingTime: Math.max(0, nextLights[d].left.remainingTime - 1) },
      }
    })

    let greenElapsed = 0
    if (st.step === 'ACTIVE') {
      if (st.phase === 'EW_STRAIGHT') {
        const g = (nextLights.East.straight.defaultGreenTime || 0) - nextLights.East.straight.remainingTime
        greenElapsed = Math.max(0, g)
      } else if (st.phase === 'EW_LEFT') {
        const g = (nextLights.East.left.defaultGreenTime || 0) - nextLights.East.left.remainingTime
        greenElapsed = Math.max(0, g)
      } else if (st.phase === 'NS_STRAIGHT') {
        const g = (nextLights.North.straight.defaultGreenTime || 0) - nextLights.North.straight.remainingTime
        greenElapsed = Math.max(0, g)
      } else {
        const g = (nextLights.North.left.defaultGreenTime || 0) - nextLights.North.left.remainingTime
        greenElapsed = Math.max(0, g)
      }
    }

    const threshold = parseInt((import.meta as any).env?.VITE_LOW_FLOW_THRESHOLD || '8')
    const minGreen = parseInt((import.meta as any).env?.VITE_MIN_GREEN_FLOOR_SECONDS || '5')
    if (st.step === 'ACTIVE') {
      if (st.phase === 'EW_STRAIGHT') {
        const group = (st.queuesStraight.East || 0) + (st.queuesStraight.West || 0)
        if (group <= threshold) {
          nextLights.East.straight.remainingTime = Math.min(nextLights.East.straight.remainingTime, minGreen)
          nextLights.West.straight.remainingTime = Math.min(nextLights.West.straight.remainingTime, minGreen)
        }
      } else if (st.phase === 'EW_LEFT') {
        const group = (st.queuesLeft.East || 0) + (st.queuesLeft.West || 0)
        if (group <= threshold) {
          nextLights.East.left.remainingTime = Math.min(nextLights.East.left.remainingTime, minGreen)
          nextLights.West.left.remainingTime = Math.min(nextLights.West.left.remainingTime, minGreen)
        }
      } else if (st.phase === 'NS_STRAIGHT') {
        const group = (st.queuesStraight.North || 0) + (st.queuesStraight.South || 0)
        if (group <= threshold) {
          nextLights.North.straight.remainingTime = Math.min(nextLights.North.straight.remainingTime, minGreen)
          nextLights.South.straight.remainingTime = Math.min(nextLights.South.straight.remainingTime, minGreen)
        }
      } else {
        const group = (st.queuesLeft.North || 0) + (st.queuesLeft.South || 0)
        if (group <= threshold) {
          nextLights.North.left.remainingTime = Math.min(nextLights.North.left.remainingTime, minGreen)
          nextLights.South.left.remainingTime = Math.min(nextLights.South.left.remainingTime, minGreen)
        }
      }
    }

    let nextQueuesStraight = st.queuesStraight
    let nextQueuesLeft = st.queuesLeft
    if (st.step === 'ACTIVE') {
      if (st.phase === 'EW_STRAIGHT') {
        const q = { ...nextQueuesStraight }
        const passE = calcPass(q.East, greenElapsed, 'straight', st.releaseStraightScale)
        const passW = calcPass(q.West, greenElapsed, 'straight', st.releaseStraightScale)
        q.East = Math.max(0, q.East - passE)
        q.West = Math.max(0, q.West - passW)
        nextQueuesStraight = q
      }
      if (st.phase === 'EW_LEFT') {
        const q = { ...nextQueuesLeft }
        const passE = calcPass(q.East, greenElapsed, 'left', st.releaseLeftScale)
        const passW = calcPass(q.West, greenElapsed, 'left', st.releaseLeftScale)
        q.East = Math.max(0, q.East - passE)
        q.West = Math.max(0, q.West - passW)
        nextQueuesLeft = q
      }
      if (st.phase === 'NS_STRAIGHT') {
        const q = { ...nextQueuesStraight }
        const passN = calcPass(q.North, greenElapsed, 'straight', st.releaseStraightScale)
        const passS = calcPass(q.South, greenElapsed, 'straight', st.releaseStraightScale)
        q.North = Math.max(0, q.North - passN)
        q.South = Math.max(0, q.South - passS)
        nextQueuesStraight = q
      }
      if (st.phase === 'NS_LEFT') {
        const q = { ...nextQueuesLeft }
        const passN = calcPass(q.North, greenElapsed, 'left', st.releaseLeftScale)
        const passS = calcPass(q.South, greenElapsed, 'left', st.releaseLeftScale)
        q.North = Math.max(0, q.North - passN)
        q.South = Math.max(0, q.South - passS)
        nextQueuesLeft = q
      }
    }

    const isActiveEnded = (() => {
      if (st.step !== 'ACTIVE') return false
      if (st.phase === 'EW_STRAIGHT') return nextLights.East.straight.remainingTime === 0 && nextLights.West.straight.remainingTime === 0
      if (st.phase === 'EW_LEFT') return nextLights.East.left.remainingTime === 0 && nextLights.West.left.remainingTime === 0
      if (st.phase === 'NS_STRAIGHT') return nextLights.North.straight.remainingTime === 0 && nextLights.South.straight.remainingTime === 0
      return nextLights.North.left.remainingTime === 0 && nextLights.South.left.remainingTime === 0
    })()

    let phase = st.phase
    let step = st.step
    if (st.step === 'ACTIVE' && isActiveEnded) {
      const y = applyYellow(nextLights, st.phase)
      nextLights.North = y.North; nextLights.South = y.South; nextLights.East = y.East; nextLights.West = y.West
      step = 'YELLOW'
    }

    const isYellowEnded = step === 'YELLOW' && directions.every((d) => nextLights[d].straight.remainingTime === 0 && nextLights[d].left.remainingTime === 0)
    if (isYellowEnded) {
      const r = applyAllRed(nextLights)
      nextLights.North = r.North; nextLights.South = r.South; nextLights.East = r.East; nextLights.West = r.West
      step = 'ALL_RED'
    }

    const isAllRedEnded = step === 'ALL_RED' && directions.every((d) => nextLights[d].straight.remainingTime === 0 && nextLights[d].left.remainingTime === 0)
    if (isAllRedEnded) {
      const nextPhase = nextPhaseOf(phase)
      const a = applyActive(nextPhase, nextLights, nextQueuesStraight, nextQueuesLeft)
      nextLights.North = a.North; nextLights.South = a.South; nextLights.East = a.East; nextLights.West = a.West
      phase = nextPhase
      step = 'ACTIVE'
    }

    set({ lights: nextLights, queuesStraight: nextQueuesStraight, queuesLeft: nextQueuesLeft, phase, step })
    save()
  }

  return {
    ...initial,
    start: () => {
      if (!worker) {
        worker = new Worker(new URL('../workers/timerWorker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = () => {
          onLightsTick()
          onSpawnTick()
        }
        worker.postMessage({ type: 'START', interval: 1000 })
      }
      if (!weatherTimer) {
        weatherTimer = setInterval(() => {
          const conds: WeatherInfo['condition'][] = ['晴', '多云', '小雨', '阴']
          const next: WeatherInfo = {
            condition: conds[Math.floor(Math.random() * conds.length)],
            temperature: Math.floor(18 + Math.random() * 12),
          }
          set({ weather: next })
          save()
        }, 60_000)
      }
    },
    clearQueues: () => {
      set({ queuesStraight: { North: 0, South: 0, East: 0, West: 0 }, queuesLeft: { North: 0, South: 0, East: 0, West: 0 } })
      save()
    },
    switchPhaseNow: () => {
      const st = get()
      const next = nextPhaseOf(st.phase)
      const lights = applyActive(next, st.lights, st.queuesStraight, st.queuesLeft)
      set({ step: 'ACTIVE', phase: next, lights })
      save()
    },
    setArrivalStraightScale: (v: number) => { set({ arrivalStraightScale: v }); save() },
    setArrivalLeftScale: (v: number) => { set({ arrivalLeftScale: v }); save() },
    setReleaseStraightScale: (v: number) => { set({ releaseStraightScale: v }); save() },
    setReleaseLeftScale: (v: number) => { set({ releaseLeftScale: v }); save() },
  }
})
