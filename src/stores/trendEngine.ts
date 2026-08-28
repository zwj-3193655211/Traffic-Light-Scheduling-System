import { create } from 'zustand'

type TrendPoint = { ts: number; time: string; North: number; South: number; East: number; West: number }

let pollTimer: any = null

export const useTrendEngine = create<{
  selectedIntersectionId: number | null;
  trendData: TrendPoint[];
  start: () => void;
  setIntersection: (id: number | null) => void;
}>((set, get) => ({
  selectedIntersectionId: null,
  trendData: [],
  start: () => {
    if (pollTimer) return
    const sync = async () => {
      const id = get().selectedIntersectionId
      if (!id) return
      try {
        const r = await fetch(`/api/vehicle-flows/aggregate?intersection_id=${id}&range_seconds=1800&bucket_seconds=10`)
        const j = await r.json()
        const data: TrendPoint[] = Array.isArray(j.data) ? j.data : []
        set({ trendData: data })
        try { localStorage.setItem(`trend_${id}`, JSON.stringify(data)) } catch {}
      } catch {
        set({ trendData: [] })
      }
    }
    sync().catch(() => {})
    pollTimer = setInterval(sync, 5000)
  },
  setIntersection: (id) => {
    set({ selectedIntersectionId: id })
    if (!id) return
    try {
      const raw = localStorage.getItem(`trend_${id}`)
      if (raw) {
        const arr = JSON.parse(raw)
        set({ trendData: arr })
      } else {
        set({ trendData: [] })
      }
    } catch {
      set({ trendData: [] })
    }
  },
}))
