import React, { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import IntersectionMonitor from '../components/IntersectionMonitor';
import FlowDots from '../components/FlowDots';
import type { Direction, LightState, Phase, Step } from '../sim/core';
import { useTrendEngine } from '../stores/trendEngine';
import { getTrafficPeriod } from '../lib/utils';
import { useAiMode } from '@/hooks/useAiMode';
import { getSocket } from '@/lib/socket';
import type { AiAdvice, Intersection, TrafficLight, VehicleFlow } from '@/types';

// P2.5.2 AI 健康面板的单指标卡片
const MetricCard: React.FC<{ label: string; value: string; tone?: 'ok' | 'warn' }> = ({ label, value, tone }) => (
  <div className="bg-gray-50 rounded-lg p-3">
    <p className="text-xs text-gray-500">{label}</p>
    <p className={`text-lg font-semibold ${tone === 'warn' ? 'text-amber-600' : 'text-gray-900'}`}>{value}</p>
  </div>
);

const Dashboard: React.FC = () => {
  const [trafficLights, setTrafficLights] = useState<TrafficLight[]>([]);
  const [displayLights, setDisplayLights] = useState<TrafficLight[]>([]);
  const [vehicleFlows, setVehicleFlows] = useState<VehicleFlow[]>([]);
  const [trendData, setTrendData] = useState<Array<{ ts: number; time: string; North: number; South: number; East: number; West: number }>>([]);
  const trendTimerRef = useRef<any>(null);
  const trendFallbackRef = useRef<any>(null);
  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [selectedIntersectionId, setSelectedIntersectionId] = useState<number | null>(null);
  const selectedIntersectionIdRef = useRef<number | null>(null);
  const [emergencyStatus, setEmergencyStatus] = useState<string>('normal');
  const workerRef = useRef<Worker | null>(null);
  const trendStoreData = useTrendEngine(s => s.trendData)
  const trendStart = useTrendEngine(s => s.start)
  const trendSetIntersection = useTrendEngine(s => s.setIntersection)
  // AI 开关：拉取、提交、跨页面广播同步统一由 hook 处理
  const { enabled: aiEnabled, setEnabled: updateAiMode, enabledRef: aiEnabledRef } = useAiMode()
  const [lastAiAdvice, setLastAiAdvice] = useState<AiAdvice | null>(null)
  const [queueSnapshot, setQueueSnapshot] = useState<Record<Direction, number>>({ North: 0, South: 0, East: 0, West: 0 })
  const [queueSnapshotSplit, setQueueSnapshotSplit] = useState<{ straight: Record<Direction, number>; left: Record<Direction, number> } | null>(null)

  useEffect(() => {
    selectedIntersectionIdRef.current = selectedIntersectionId
  }, [selectedIntersectionId])
  // 关闭 AI 时清空上一次建议，避免展示过期数据
  useEffect(() => {
    if (!aiEnabled) setLastAiAdvice(null)
  }, [aiEnabled])

  useEffect(() => {
    // 复用全局 socket 单例（此前各页面各自 io()，同会话最多开 5 条连接）
    const newSocket = getSocket();

    // 监听红绿灯状态更新
    // 注意：UI 的 `displayLights` 只由 worker 单向驱动；这里不直接 setDisplayLights，
    // 否则会和 worker 的每秒 tick 产生双源更新，导致读秒跳变（同一秒被服务端值与
    // worker 减秒同时覆盖）。
    newSocket.on('trafficLightUpdate', (data: TrafficLight[]) => {
      if (!Array.isArray(data) || data.length === 0) return;
      const selected = selectedIntersectionIdRef.current
      if (selected != null && data[0].intersection_id !== selected) {
        return
      }
      setTrafficLights(data);
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'INIT', lights: data });
      }
    });

    newSocket.on('light_status_update', (data: any) => {
      if (!data || data.lightId == null) return;
      setTrafficLights(prev => prev.map(l => l.id === data.lightId ? {
        ...l,
        current_status: data.status,
        remaining_time: data.remainingTime
      } : l));
      if (workerRef.current) {
        workerRef.current.postMessage({
          type: 'UPDATE_LIGHT',
          light: { id: data.lightId, remaining_time: data.remainingTime, current_status: data.status },
        });
      }
    });

    // 监听车流量更新（实时追加到趋势）
    newSocket.on('vehicleFlowUpdate', (data: any) => {
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
              average_speed: Number(it?.averageSpeed ?? it?.average_speed ?? 0),
              timestamp: (it?.timestamp ?? data?.timestamp ?? new Date().toISOString()) as string,
            }))
          : []);

      setVehicleFlows(normalized);
      const selected = selectedIntersectionIdRef.current
      if (selected == null) return;
      const items = normalized.filter(d => d.intersection_id === selected);
      if (items.length === 0) return;
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
            ;(next as any)[it.direction] = it.vehicle_count
          }
        }
        return next
      })
      setTrendData(prev => {
        const next = [...prev];
        for (const it of items) {
          const ts = Math.floor(new Date(it.timestamp).getTime() / 10000) * 10000; // 10s 桶
          const idx = next.findIndex(p => p.ts === ts);
          const time = new Date(ts).toLocaleTimeString();
          if (idx === -1) {
            const row = { ts, time, North: 0, South: 0, East: 0, West: 0 };
            (row as any)[it.direction as 'North'|'South'|'East'|'West'] = it.vehicle_count;
            next.push(row);
          } else {
            const row = next[idx];
            (row as any)[it.direction as 'North'|'South'|'East'|'West'] += it.vehicle_count;
          }
        }
        // 限制窗口长度
        return next.slice(Math.max(0, next.length - 300));
      });
    });

    // 监听紧急情况
    newSocket.on('emergencyMode', (status: string) => {
      setEmergencyStatus(status);
    });
    newSocket.on('trafficTimingUpdate', (data: any) => {
      if (aiEnabledRef.current && data?.source === 'ai') {
        setLastAiAdvice({
          intersectionId: data.intersectionId,
          green: data.advice?.green,
          reason: data.advice?.reason,
        })
      }
    })
    // AI 开关的跨页面同步由 useAiMode 内部监听，此处不再重复订阅

    fetchInitialIntersections();
    trendStart();

    // 订阅路口管理事件，收到后触发重新拉取
    const bc = new BroadcastChannel('intersections_update');
    bc.onmessage = () => {
      fetchInitialIntersections();
      if (selectedIntersectionId != null) {
        setSelectedIntersectionId(prev => prev) // 触发依赖 effect 重新拉取当前路口数据
      }
    }
    newSocket.on('intersections:changed', () => {
      fetchInitialIntersections();
      if (selectedIntersectionId != null) setSelectedIntersectionId(prev => prev)
    })

    return () => {
      newSocket.close();
      bc.close();
    };
  }, []);

  // P2.5.2 AI 健康面板：轮询 /api/ai/metrics 展示调用成功率/耗时/熔断/降本与最近建议
  const [aiHealth, setAiHealth] = useState<any>(null);
  const [aiLatencyHistory, setAiLatencyHistory] = useState<Array<{ t: number; ms: number }>>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/ai/metrics');
        const j = await r.json();
        if (!alive || !j?.success || !j?.advisor) return;
        setAiHealth(j);
        setAiLatencyHistory(prev => [...prev, { t: prev.length, ms: j.advisor.avgLatencyMs }].slice(-20));
      } catch {}
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const fetchInitialIntersections = async () => {
    try {
      const [intersectionsRes, selectedRes] = await Promise.all([
        fetch('/api/intersections'),
        fetch('/api/settings/selected-intersection').catch(() => null as any),
      ]);
      const intersectionsJson = await intersectionsRes.json();
      const list: Intersection[] = intersectionsJson.data || [];
      setIntersections(list);

      let backendSelectedId: number | null = null;
      try {
        if (selectedRes) {
          const selectedJson = await selectedRes.json();
          const v = Number(selectedJson?.data ?? 0);
          backendSelectedId = v > 0 ? v : null;
        }
      } catch {}

      const current = selectedIntersectionIdRef.current;
      const hasId = (id: number | null | undefined) => id != null && list.some(i => Number(i.id) === Number(id));
      const nextSelected =
        hasId(backendSelectedId)
          ? (backendSelectedId as number)
          : hasId(current)
            ? (current as number)
            : (list.length > 0 ? Number(list[0].id) : null);

      if (nextSelected !== current) {
        setSelectedIntersectionId(nextSelected);
      }
    } catch (error) {
      console.error('获取初始数据失败:', error);
    }
  };

  useEffect(() => {
    if (selectedIntersectionId == null) return;
    // 路口切换瞬间立即清空脏数据，避免显示上一个路口的灯状态/队列
    setTrafficLights([])
    setDisplayLights([])
    setQueueSnapshot({ North: 0, South: 0, East: 0, West: 0 })
    setQueueSnapshotSplit(null)
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'INIT', lights: [] })
    }
    const loadByIntersection = async () => {
      try {
        const tlRes = await fetch(`/api/traffic-lights?intersection_id=${selectedIntersectionId}`);
        const tlJson = await tlRes.json();
        setTrafficLights(tlJson.data || []);
        if (workerRef.current) {
          workerRef.current.postMessage({ type: 'INIT', lights: tlJson.data || [] });
        }
        const flowsRes = await fetch(`/api/vehicle-flows?intersection_id=${selectedIntersectionId}&time_range=hour`);
        const flowsJson = await flowsRes.json();
        const flows = Array.isArray(flowsJson.data) ? flowsJson.data : []
        setVehicleFlows(flows);
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
          const splitRes = await fetch(`/api/vehicle-flows/realtime-split?intersection_id=${selectedIntersectionId}`)
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
          } else {
            // split 缓存为空时，保持已经从 flows 加载的总数，不要清掉
            setQueueSnapshotSplit(null)
          }
        } catch {
          // split 接口异常时同样保留总数
          setQueueSnapshotSplit(null)
        }
      } catch (e) {
        console.error('按路口加载数据失败:', e);
      }
    }
    loadByIntersection();
    fetch('/api/settings/selected-intersection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intersectionId: selectedIntersectionId })
    }).catch(() => {})
    trendSetIntersection(selectedIntersectionId)
  }, [selectedIntersectionId]);

  const getTrafficLightColor = (status: number) => {
    switch (status) {
      case 0: return 'bg-red-500';
      case 1: return 'bg-yellow-500';
      case 2: return 'bg-green-500';
      default: return 'bg-gray-500';
    }
  };

  const getTrafficLightText = (status: number) => {
    switch (status) {
      case 0: return '红灯';
      case 1: return '黄灯';
      case 2: return '绿灯';
      default: return '未知';
    }
  };

  // 使用 displayLights（worker 每秒倒计时的快照）作为 UI 数据源，
  // 让 IntersectionMonitor 中的剩余秒数能平滑读秒，而无需等待 socket 推送或手动刷新。
  const selectedLights = selectedIntersectionId == null
    ? []
    : displayLights.filter(l => l.intersection_id === selectedIntersectionId)

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

  const greenDirs = {
    straight: step === 'ACTIVE' && phase === 'EW_STRAIGHT' ? (['East', 'West'] as Direction[]) :
      step === 'ACTIVE' && phase === 'NS_STRAIGHT' ? (['North', 'South'] as Direction[]) : ([] as Direction[]),
    left: step === 'ACTIVE' && phase === 'EW_LEFT' ? (['East', 'West'] as Direction[]) :
      step === 'ACTIVE' && phase === 'NS_LEFT' ? (['North', 'South'] as Direction[]) : ([] as Direction[]),
  }

  useEffect(() => {
    const w = new Worker(new URL('../workers/countdownWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent) => {
      setDisplayLights(e.data.lights || []);
    };
    // 立即用最新的 trafficLights 初始化，避免 mount 时拿到的是闭包里的初始空数组。
    w.postMessage({ type: 'INIT', lights: trafficLights });
    w.postMessage({ type: 'TICK_START' });
    return () => {
      w.postMessage({ type: 'STOP' });
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  // 当 trafficLights 集合本身变化（如切换路口、socket 推送）时，
  // 同步把最新数据喂给 worker，保证倒计时基准与服务端最新状态对齐。
  useEffect(() => {
    if (workerRef.current && trafficLights.length > 0) {
      workerRef.current.postMessage({ type: 'INIT', lights: trafficLights });
    }
  }, [trafficLights]);

  // 趋势数据供折线图使用（总车流 = 四向之和）
  const baseData = trendStoreData
  const lineData = baseData.map(d => ({
    ...d,
    total: (d.North || 0) + (d.South || 0) + (d.East || 0) + (d.West || 0),
  }));

  // Y 轴动态范围：根据当前数据的最大值算合适的上限，避免长期使用固定大刻度
  // 把曲线压扁在 X 轴附近。上限留 20% 余量并向上取整到 10 的倍数。
  const yAxisMax = (() => {
    if (lineData.length === 0) return 100
    const max = Math.max(...lineData.map(d => d.total || 0))
    if (max <= 0) return 100
    const padded = Math.ceil(max * 1.2)
    // 向上对齐到便于阅读的刻度：< 100 取 10 倍, < 1000 取 50 倍, 否则 100 倍
    if (padded < 100) return Math.ceil(padded / 10) * 10
    if (padded < 1000) return Math.ceil(padded / 50) * 50
    return Math.ceil(padded / 100) * 100
  })();

  const TrendTooltip: React.FC<any> = ({ active, payload, label }) => {
    if (!active || !payload || !payload.length) return null;
    const p = payload[0].payload as any;
    return (
      <div className="bg-white border border-gray-200 rounded-md p-3 shadow">
        <div className="text-sm font-medium text-gray-900 mb-1">{p.time}</div>
        <div className="text-xs text-gray-700 space-y-1">
          <div>总车流：{p.total}</div>
          <div>北向：{p.North}</div>
          <div>南向：{p.South}</div>
          <div>东向：{p.East}</div>
          <div>西向：{p.West}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800 mb-2">交通监控系统</h1>
        <div className="flex items-center space-x-4">
          <div className={`px-3 py-1 rounded-full text-sm font-medium ${
            emergencyStatus === 'normal' ? 'bg-green-100 text-green-800' :
            emergencyStatus === 'emergency' ? 'bg-red-100 text-red-800' :
            'bg-yellow-100 text-yellow-800'
          }`}>
            {emergencyStatus === 'normal' ? '正常运行' :
             emergencyStatus === 'emergency' ? '紧急模式' : '维护模式'}
          </div>
          <div className="text-sm text-gray-600">
            最后更新: {new Date().toLocaleTimeString()}
          </div>
        </div>
        <div className="mt-4 flex items-center space-x-3">
          <label className="text-sm text-gray-700">选择路口</label>
          <select
            value={selectedIntersectionId ?? ''}
            onChange={(e) => setSelectedIntersectionId(e.target.value ? Number(e.target.value) : null)}
            className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900"
          >
            {intersections.map(i => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
          <label className="ml-4 flex items-center">
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
        {selectedIntersectionId && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            {(() => {
              const current = intersections.find(i => i.id === selectedIntersectionId)
              const items = [
                { label: '北向下一路口', id: current?.next_north_id },
                { label: '南向下一路口', id: current?.next_south_id },
                { label: '东向下一路口', id: current?.next_east_id },
                { label: '西向下一路口', id: current?.next_west_id },
              ]
              return items.map((it, idx) => (
                <div key={idx} className="bg-white rounded-lg shadow p-3 flex items-center justify-between">
                  <span className="text-sm text-gray-700">{it.label}</span>
                  {it.id ? (
                    <button
                      onClick={() => setSelectedIntersectionId(it.id!)}
                      className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200"
                    >
                      跳转
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">无</span>
                  )}
                </div>
              ))
            })()}
          </div>
        )}
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex items-center">
            <div className="p-3 rounded-full bg-blue-100 text-blue-600">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">活跃路口</p>
              <p className="text-2xl font-semibold text-gray-900">
                {intersections.filter(i => i.status === 1 || i.status === 'active').length}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex items-center">
            <div className="p-3 rounded-full bg-green-100 text-green-600">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">总车流量</p>
              <p className="text-2xl font-semibold text-gray-900">
                {vehicleFlows.reduce((sum, flow) => sum + flow.vehicle_count, 0)}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex items-center">
            <div className="p-3 rounded-full bg-yellow-100 text-yellow-600">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">平均等待时间</p>
              <p className="text-2xl font-semibold text-gray-900">{(() => {
                const Y = 3, R = 2
                const phaseOrder = ['EW_STRAIGHT','EW_LEFT','NS_STRAIGHT','NS_LEFT'] as const
                const idx = phaseOrder.indexOf(phase)
                const durations: Record<string, number> = {
                  EW_STRAIGHT: Math.max(monitorLights.East?.straight?.defaultGreenTime || 30, monitorLights.West?.straight?.defaultGreenTime || 30),
                  EW_LEFT: Math.max(monitorLights.East?.left?.defaultGreenTime || 20, monitorLights.West?.left?.defaultGreenTime || 20),
                  NS_STRAIGHT: Math.max(monitorLights.North?.straight?.defaultGreenTime || 30, monitorLights.South?.straight?.defaultGreenTime || 30),
                  NS_LEFT: Math.max(monitorLights.North?.left?.defaultGreenTime || 20, monitorLights.South?.left?.defaultGreenTime || 20),
                }
                const remActive = (() => {
                  if (step === 'ACTIVE') {
                    if (phase === 'EW_STRAIGHT') return Math.max(monitorLights.East?.straight?.remainingTime || 0, monitorLights.West?.straight?.remainingTime || 0)
                    if (phase === 'EW_LEFT') return Math.max(monitorLights.East?.left?.remainingTime || 0, monitorLights.West?.left?.remainingTime || 0)
                    if (phase === 'NS_STRAIGHT') return Math.max(monitorLights.North?.straight?.remainingTime || 0, monitorLights.South?.straight?.remainingTime || 0)
                    return Math.max(monitorLights.North?.left?.remainingTime || 0, monitorLights.South?.left?.remainingTime || 0)
                  }
                  const yRem = Math.max(
                    monitorLights.East?.straight?.status === 1 ? (monitorLights.East?.straight?.remainingTime || 0) : 0,
                    monitorLights.West?.straight?.status === 1 ? (monitorLights.West?.straight?.remainingTime || 0) : 0,
                    monitorLights.North?.straight?.status === 1 ? (monitorLights.North?.straight?.remainingTime || 0) : 0,
                    monitorLights.South?.straight?.status === 1 ? (monitorLights.South?.straight?.remainingTime || 0) : 0,
                    monitorLights.East?.left?.status === 1 ? (monitorLights.East?.left?.remainingTime || 0) : 0,
                    monitorLights.West?.left?.status === 1 ? (monitorLights.West?.left?.remainingTime || 0) : 0,
                    monitorLights.North?.left?.status === 1 ? (monitorLights.North?.left?.remainingTime || 0) : 0,
                    monitorLights.South?.left?.status === 1 ? (monitorLights.South?.left?.remainingTime || 0) : 0,
                  )
                  const rRem = Math.max(
                    monitorLights.East?.straight?.status === 0 ? (monitorLights.East?.straight?.remainingTime || 0) : 0,
                    monitorLights.West?.straight?.status === 0 ? (monitorLights.West?.straight?.remainingTime || 0) : 0,
                    monitorLights.North?.straight?.status === 0 ? (monitorLights.North?.straight?.remainingTime || 0) : 0,
                    monitorLights.South?.straight?.status === 0 ? (monitorLights.South?.straight?.remainingTime || 0) : 0,
                    monitorLights.East?.left?.status === 0 ? (monitorLights.East?.left?.remainingTime || 0) : 0,
                    monitorLights.West?.left?.status === 0 ? (monitorLights.West?.left?.remainingTime || 0) : 0,
                    monitorLights.North?.left?.status === 0 ? (monitorLights.North?.left?.remainingTime || 0) : 0,
                    monitorLights.South?.left?.status === 0 ? (monitorLights.South?.left?.remainingTime || 0) : 0,
                  )
                  if (step === 'YELLOW') return (yRem || Y) + R
                  if (step === 'ALL_RED') return (rRem || R)
                  return 0
                })()
                const timeToPhase = (target: string) => {
                  if (target === phase && step === 'ACTIVE') return 0
                  let total = remActive
                  let p = idx
                  while (true) {
                    // transition to next phase
                    total += Y + R
                    p = (p + 1) % phaseOrder.length
                    const ph = phaseOrder[p] as unknown as string
                    total += durations[ph]
                    if (ph === target) break
                  }
                  return total
                }
                const qNS_straight = (queuesStraight.North || 0) + (queuesStraight.South || 0)
                const qEW_straight = (queuesStraight.East || 0) + (queuesStraight.West || 0)
                const qNS_left = (queuesLeft.North || 0) + (queuesLeft.South || 0)
                const qEW_left = (queuesLeft.East || 0) + (queuesLeft.West || 0)
                const sumQ = qNS_straight + qEW_straight + qNS_left + qEW_left
                if (sumQ === 0) return '0s'
                const wNS = timeToPhase('NS_STRAIGHT') * qNS_straight
                const wEW = timeToPhase('EW_STRAIGHT') * qEW_straight
                const wNSL = timeToPhase('NS_LEFT') * qNS_left
                const wEWL = timeToPhase('EW_LEFT') * qEW_left
                const avg = (wNS + wEW + wNSL + wEWL) / sumQ
                return `${Math.round(avg)}s`
              })()}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex items-center">
            <div className="p-3 rounded-full bg-red-100 text-red-600">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">紧急事件</p>
              <p className="text-2xl font-semibold text-gray-900">0</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
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
        <FlowDots
          queuesStraight={queuesStraight}
          queuesLeft={queuesLeft}
          greenDirs={greenDirs as any}
          step={step as any}
        />
      </div>

      {/* 实时流量趋势 */}
      <div className="mt-8 bg-white rounded-lg shadow-md p-6">
        <h2 className="text-xl font-semibold text-gray-800 mb-4">实时流量趋势</h2>
        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={lineData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" />
            <YAxis domain={[0, yAxisMax]} allowDataOverflow={false} />
            <Tooltip content={<TrendTooltip />} />
            <Line type="monotone" dataKey="total" stroke="#1f2937" name="总车流" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* P2.5.2 AI 健康面板：轮询 /api/ai/metrics 展示调用成功率/耗时/熔断/降本与最近建议 */}
      <div className="mt-8 bg-white rounded-lg shadow-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-800">AI 调度健康面板</h2>
          <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
            !aiHealth ? 'bg-gray-100 text-gray-500'
            : aiHealth.advisor.calls === 0 ? 'bg-gray-100 text-gray-500'
            : aiHealth.advisor.circuitOpenSkips > 0 ? 'bg-amber-100 text-amber-700'
            : 'bg-green-100 text-green-700'
          }`}>
            {!aiHealth ? '加载中…'
              : aiHealth.advisor.calls === 0 ? '待调用'
              : aiHealth.advisor.circuitOpenSkips > 0 ? '熔断跳过中' : '运行正常'}
          </span>
        </div>

        {!aiHealth ? (
          <p className="text-sm text-gray-400">正在加载 AI 运行指标…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <MetricCard
                label="调用成功率"
                value={aiHealth.advisor.calls > 0 ? `${Math.round((aiHealth.advisor.successes / aiHealth.advisor.calls) * 100)}%` : '—'}
                tone={aiHealth.advisor.calls > 0 && (aiHealth.advisor.successes / aiHealth.advisor.calls) < 0.8 ? 'warn' : undefined}
              />
              <MetricCard
                label="平均耗时"
                value={aiHealth.advisor.avgLatencyMs ? `${aiHealth.advisor.avgLatencyMs}ms` : '—'}
                tone={aiHealth.advisor.avgLatencyMs > 5000 ? 'warn' : undefined}
              />
              <MetricCard
                label="熔断跳过"
                value={String(aiHealth.advisor.circuitOpenSkips)}
                tone={aiHealth.advisor.circuitOpenSkips > 0 ? 'warn' : undefined}
              />
              <MetricCard
                label="门控跳过"
                value={String(aiHealth.runtime.gateSkips)}
              />
              <MetricCard
                label="缓存命中"
                value={String(aiHealth.runtime.cacheHits)}
              />
            </div>

            <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* 最近一次 AI 建议 */}
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">最近一次 AI 建议</p>
                {aiHealth.runtime.lastAdvice ? (
                  <div className="space-y-1">
                    <p className="text-sm text-gray-700">
                      路口 <span className="font-semibold">{aiHealth.runtime.lastAdvice.intersectionId}</span>
                      {' · '}建议绿灯{' '}
                      <span className="font-semibold text-blue-600">
                        {aiHealth.runtime.lastAdvice.green === -1 ? '保持当前' : `${aiHealth.runtime.lastAdvice.green}s`}
                      </span>
                    </p>
                    <p className="text-sm text-gray-500">
                      {aiHealth.runtime.lastAdvice.reason || '（无说明）'}
                    </p>
                    <p className="text-xs text-gray-400">
                      {aiHealth.runtime.lastAdviceTs ? `更新于 ${new Date(aiHealth.runtime.lastAdviceTs).toLocaleTimeString()}` : ''}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">暂无 AI 建议（可能 AI 未启用或尚未产生决策）</p>
                )}
              </div>

              {/* 平均耗时趋势 */}
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">平均耗时趋势（近 {aiLatencyHistory.length} 次采样）</p>
                {aiLatencyHistory.length > 1 ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={aiLatencyHistory}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="t" hide />
                      <YAxis domain={[0, 'auto']} width={36} fontSize={10} />
                      <Tooltip formatter={(v: number) => [`${v}ms`, '平均耗时']} />
                      <Line type="monotone" dataKey="ms" stroke="#2563eb" dot={false} strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-gray-400">采集中…（每 3 秒刷新）</p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
