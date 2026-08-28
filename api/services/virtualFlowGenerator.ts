import { createRequire } from 'module'
import * as redis from '../config/redis.js'

type Direction = 'North' | 'South' | 'East' | 'West'
type Period = '早高峰' | '午高峰' | '晚高峰' | '平峰' | '低谷'
type SplitQueue = { straight: number; left: number }
type SplitQueues = Record<Direction, SplitQueue>
type Movement = 'straight' | 'left'

const directions: Direction[] = ['North', 'South', 'East', 'West']
const require = createRequire(import.meta.url)
const db = require('../config/database.js')

function getPeriod(now: Date = new Date()): Period {
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes >= 7 * 60 && minutes < 9 * 60) return '早高峰'
  if (minutes >= 11 * 60 + 30 && minutes < 13 * 60 + 30) return '午高峰'
  if (minutes >= 17 * 60 && minutes < 19 * 60) return '晚高峰'
  if (minutes >= 22 * 60 || minutes < 7 * 60) return '低谷'
  return '平峰'
}

function baseArrivalRates(intersectionId: number, period: Period): Record<Direction, number> {
  if (intersectionId === 2) {
    if (period === '早高峰') return { North: 1.05, South: 0.85, East: 0.28, West: 0.45 }
    if (period === '午高峰') return { North: 1.15, South: 0.95, East: 0.35, West: 0.5 }
    if (period === '晚高峰') return { North: 1.25, South: 1.05, East: 0.3, West: 0.5 }
    if (period === '低谷') return { North: 0.28, South: 0.22, East: 0.18, West: 0.24 }
    return { North: 0.7, South: 0.5, East: 0.38, West: 0.52 }
  }

  if (period === '早高峰') return { North: 0.32, South: 0.38, East: 1.2, West: 1.0 }
  if (period === '午高峰') return { North: 0.42, South: 0.48, East: 0.7, West: 0.58 }
  if (period === '晚高峰') return { North: 0.3, South: 0.4, East: 1.3, West: 1.1 }
  if (period === '低谷') return { North: 0.18, South: 0.22, East: 0.28, West: 0.24 }
  return { North: 0.5, South: 0.6, East: 0.8, West: 0.68 }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function dirCode(d: Direction) {
  if (d === 'North') return 1
  if (d === 'South') return 2
  if (d === 'East') return 3
  return 4
}

function xorshift32(x: number) {
  let n = x | 0
  n ^= n << 13
  n ^= n >>> 17
  n ^= n << 5
  return n | 0
}

function seedFrom(intersectionId: number, d: Direction, m: Movement, salt: number) {
  const base = (intersectionId * 2654435761) ^ (dirCode(d) * 97) ^ (m === 'straight' ? 1231 : 4567) ^ salt
  return base | 0
}

function seededInt(intersectionId: number, d: Direction, m: Movement, salt: number, min: number, max: number) {
  const s = xorshift32(seedFrom(intersectionId, d, m, salt)) >>> 0
  const span = Math.max(1, (max - min + 1))
  return min + (s % span)
}

function arrivalMovementFactor(intersectionId: number, d: Direction, m: Movement) {
  if (m === 'straight') {
    if (intersectionId === 2) {
      if (d === 'North') return 1.05
      if (d === 'South') return 0.95
      if (d === 'East') return 0.9
      return 1.1
    }
    return 1
  }
  if (intersectionId === 2) {
    if (d === 'North') return 1.15
    if (d === 'South') return 0.95
    if (d === 'East') return 1.25
    return 0.9
  }
  if (d === 'East') return 1.1
  if (d === 'West') return 0.95
  if (d === 'North') return 0.9
  return 1
}

function capacityFactor(intersectionId: number, d: Direction, m: Movement) {
  if (intersectionId === 2) {
    if (m === 'straight') {
      if (d === 'North') return 1.05
      if (d === 'South') return 0.95
      if (d === 'East') return 0.85
      return 1.0
    }
    if (d === 'North') return 1.0
    if (d === 'South') return 0.9
    if (d === 'East') return 0.8
    return 0.95
  }
  return 1
}

export function startVirtualFlowGenerator() {
  const enabled = (process.env.VIRTUAL_FLOW_ENABLED ?? '1') !== '0' && process.env.NODE_ENV !== 'production'
  if (!enabled) return

  const onlyIntersections = (process.env.VIRTUAL_FLOW_INTERSECTIONS || '1,2')
    .split(',')
    .map(s => parseInt(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
  const intervalMs = clamp(parseInt(process.env.VIRTUAL_FLOW_INTERVAL_MS || '5000'), 500, 30_000)
  const retentionHours = clamp(parseInt(process.env.VIRTUAL_FLOW_RETENTION_HOURS || '24'), 1, 24 * 14)
  const noiseEnabled = (process.env.VIRTUAL_FLOW_NOISE ?? '1') !== '0'
  const noisePct = clamp(parseFloat(process.env.VIRTUAL_FLOW_NOISE_PCT || '10'), 0, 50) / 100
  const noiseAlpha = clamp(parseFloat(process.env.VIRTUAL_FLOW_NOISE_ALPHA || '0.8'), 0, 0.99)

  const state = new Map<number, SplitQueues>()
  const carry = new Map<number, SplitQueues>()
  const noise = new Map<number, SplitQueues>()
  const rngState = new Map<number, number>()
  const lastPersist = new Map<number, number>()

  const loadQueueFromCache = async (intersectionId: number) => {
    try {
      const keySplit = `virtual:queue_split:${intersectionId}`
      const keyTotal = `virtual:queue:${intersectionId}`
      const vSplit = await (redis.getCache ? redis.getCache(keySplit) : Promise.resolve(null))
      if (vSplit && typeof vSplit === 'object') {
        const next: SplitQueues = { North: { straight: 0, left: 0 }, South: { straight: 0, left: 0 }, East: { straight: 0, left: 0 }, West: { straight: 0, left: 0 } }
        for (const d of directions) {
          const row = (vSplit as any)[d] || {}
          next[d] = { straight: Number(row.straight ?? 0), left: Number(row.left ?? 0) }
        }
        state.set(intersectionId, next)
        return
      }

      const v = await (redis.getCache ? redis.getCache(keyTotal) : Promise.resolve(null))
      if (v && typeof v === 'object') {
        const next: SplitQueues = { North: { straight: 0, left: 0 }, South: { straight: 0, left: 0 }, East: { straight: 0, left: 0 }, West: { straight: 0, left: 0 } }
        for (const d of directions) {
          const total = Number((v as any)[d] ?? 0)
          const straight = Math.round(total * 0.7)
          const left = Math.max(0, total - straight)
          next[d] = { straight, left }
        }
        state.set(intersectionId, next)
      }
    } catch {}
  }

  const ensureState = async (intersectionId: number) => {
    if (state.has(intersectionId)) return
    await loadQueueFromCache(intersectionId)
    if (!state.has(intersectionId)) {
      const mk = (d: Direction): SplitQueue => {
        const baseStraight = d === 'North' || d === 'South' ? 10 : 12
        const baseLeft = d === 'North' || d === 'South' ? 5 : 6
        const ds = seededInt(intersectionId, d, 'straight', 11, -4, 4)
        const dl = seededInt(intersectionId, d, 'left', 19, -3, 3)
        return { straight: Math.max(0, baseStraight + ds), left: Math.max(0, baseLeft + dl) }
      }
      state.set(intersectionId, { North: mk('North'), South: mk('South'), East: mk('East'), West: mk('West') })
    }
    if (!carry.has(intersectionId)) {
      carry.set(intersectionId, {
        North: { straight: 0, left: 0 },
        South: { straight: 0, left: 0 },
        East: { straight: 0, left: 0 },
        West: { straight: 0, left: 0 },
      })
    }
    if (!noise.has(intersectionId)) {
      noise.set(intersectionId, {
        North: { straight: 0, left: 0 },
        South: { straight: 0, left: 0 },
        East: { straight: 0, left: 0 },
        West: { straight: 0, left: 0 },
      })
    }
    if (!rngState.has(intersectionId)) rngState.set(intersectionId, seedFrom(intersectionId, 'North', 'straight', 12345))
  }

  const persistState = async (intersectionId: number) => {
    try {
      const now = Date.now()
      const last = lastPersist.get(intersectionId) || 0
      if (now - last < 10_000) return
      lastPersist.set(intersectionId, now)
      const v = state.get(intersectionId)
      if (!v) return
      const keySplit = `virtual:queue_split:${intersectionId}`
      const keyTotal = `virtual:queue:${intersectionId}`
      const totals: Record<Direction, number> = { North: 0, South: 0, East: 0, West: 0 }
      for (const d of directions) totals[d] = Number(v[d]?.straight ?? 0) + Number(v[d]?.left ?? 0)
      await (redis.setCache ? redis.setCache(keySplit, v, 3600) : Promise.resolve())
      await (redis.setCache ? redis.setCache(keyTotal, totals, 3600) : Promise.resolve())
    } catch {}
  }

  const tickOnce = async () => {
    try {
      const [intersectionRows]: any = await db.pool.execute(
        `SELECT id, status FROM intersections WHERE id IN (${onlyIntersections.map(() => '?').join(',')})`,
        onlyIntersections
      )
      const activeIntersectionIds = new Set<number>(
        (intersectionRows || []).filter((r: any) => Number(r.status ?? 0) === 1).map((r: any) => Number(r.id))
      )

      const period = getPeriod()

      const [paramRows]: any = await db.pool.execute(
        `SELECT intersection_id, arrival_straight_scale, arrival_left_scale, release_straight_scale, release_left_scale
         FROM intersection_params WHERE intersection_id IN (${onlyIntersections.map(() => '?').join(',')})`,
        onlyIntersections
      )
      const paramMap = new Map<number, any>()
      for (const r of paramRows || []) paramMap.set(Number(r.intersection_id), r)

      const [lights]: any = await db.pool.execute(
        `SELECT intersection_id, direction, movement_type, current_status FROM traffic_lights WHERE intersection_id IN (${onlyIntersections.map(() => '?').join(',')})`,
        onlyIntersections
      )
      const lightMap = new Map<number, Array<{ direction: Direction; movement_type: 'straight' | 'left'; current_status: number }>>()
      for (const l of lights || []) {
        const id = Number(l.intersection_id)
        if (!lightMap.has(id)) lightMap.set(id, [])
        lightMap.get(id)!.push({
          direction: l.direction as Direction,
          movement_type: (l.movement_type ?? 'straight') as any,
          current_status: Number(l.current_status ?? 0),
        })
      }

      const now = new Date()
      const speed = 28

      for (const intersectionId of onlyIntersections) {
        if (!activeIntersectionIds.has(intersectionId)) continue
        await ensureState(intersectionId)

        const params = paramMap.get(intersectionId) || {}
        const arrivalStraightScale = clamp(Number(params.arrival_straight_scale ?? 0.3), 0, 10)
        const arrivalLeftScale = clamp(Number(params.arrival_left_scale ?? 0.2), 0, 10)
        const releaseStraightScale = clamp(Number(params.release_straight_scale ?? 0.8), 0.05, 10)
        const releaseLeftScale = clamp(Number(params.release_left_scale ?? 0.7), 0.05, 10)

        const queues = state.get(intersectionId)!
        const base = baseArrivalRates(intersectionId, period)
        const lightRows = lightMap.get(intersectionId) || []
        const noiseRow = noise.get(intersectionId)!
        const dt = intervalMs / 1000

        const nextRand = () => {
          const s = rngState.get(intersectionId) || 0
          const n = xorshift32(s)
          rngState.set(intersectionId, n)
          return (n >>> 0) / 4294967296
        }

        const isGreen = (d: Direction, m: 'straight' | 'left') =>
          lightRows.some(l => l.direction === d && l.movement_type === m && l.current_status === 2)

        const carryRow = carry.get(intersectionId)!

        for (const d of directions) {
          if (noiseEnabled) {
            noiseRow[d].straight = noiseRow[d].straight * noiseAlpha + (nextRand() * 2 - 1) * noisePct
            noiseRow[d].left = noiseRow[d].left * noiseAlpha + (nextRand() * 2 - 1) * noisePct
          } else {
            noiseRow[d].straight = 0
            noiseRow[d].left = 0
          }

          const straightFactor = arrivalMovementFactor(intersectionId, d, 'straight') * (1 + noiseRow[d].straight)
          const leftFactor = arrivalMovementFactor(intersectionId, d, 'left') * (1 + noiseRow[d].left)

          const arrivalsStraight = Math.max(0, base[d] * arrivalStraightScale * dt * straightFactor)
          const arrivalsLeft = Math.max(0, base[d] * 0.6 * arrivalLeftScale * dt * leftFactor)

          carryRow[d].straight = Math.max(0, carryRow[d].straight + arrivalsStraight)
          carryRow[d].left = Math.max(0, carryRow[d].left + arrivalsLeft)

          const incStraight = Math.floor(carryRow[d].straight)
          const incLeft = Math.floor(carryRow[d].left)
          carryRow[d].straight = carryRow[d].straight - incStraight
          carryRow[d].left = carryRow[d].left - incLeft

          const straightGreen = isGreen(d, 'straight')
          const leftGreen = isGreen(d, 'left')
          const capBase = 2.2

          const releaseStraight = straightGreen
            ? Math.min(queues[d].straight, Math.max(0, Math.floor(capBase * releaseStraightScale * dt * capacityFactor(intersectionId, d, 'straight'))))
            : 0
          const releaseLeft = leftGreen
            ? Math.min(queues[d].left, Math.max(0, Math.floor(capBase * releaseLeftScale * dt * capacityFactor(intersectionId, d, 'left'))))
            : 0

          queues[d].straight = clamp(queues[d].straight + incStraight - releaseStraight, 0, 999)
          queues[d].left = clamp(queues[d].left + incLeft - releaseLeft, 0, 999)
        }

        const values: any[] = []
        const paramsSql: any[] = []
        for (const d of directions) {
          const total = Number(queues[d].straight ?? 0) + Number(queues[d].left ?? 0)
          values.push('(?, ?, ?, ?)')
          paramsSql.push(intersectionId, d, total, speed)
        }

        await db.pool.execute(
          `INSERT INTO vehicle_flows (intersection_id, direction, vehicle_count, average_speed) VALUES ${values.join(',')}`,
          paramsSql
        )

        await (redis.publishMessage ? redis.publishMessage('sensor:batch_data', {
          intersectionId,
          batchData: directions.map(direction => ({
            sensorId: `sensor_${intersectionId}_${direction}`,
            intersectionId,
            direction,
            vehicleCount: (queues[direction].straight + queues[direction].left),
            straightCount: queues[direction].straight,
            leftCount: queues[direction].left,
            averageSpeed: speed,
            timestamp: now,
          })),
          timestamp: now,
        }) : Promise.resolve())

        await persistState(intersectionId)
      }
    } catch {}
  }

  const cleanupOnce = async () => {
    try {
      await db.pool.execute(
        `DELETE FROM vehicle_flows WHERE intersection_id IN (${onlyIntersections.map(() => '?').join(',')})
         AND timestamp < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
        [...onlyIntersections, retentionHours]
      )
    } catch {}
  }

  setInterval(() => { tickOnce().catch(() => {}) }, intervalMs)
  setInterval(() => { cleanupOnce().catch(() => {}) }, 10 * 60 * 1000)
}
