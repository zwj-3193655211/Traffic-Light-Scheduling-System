import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import IntersectionMonitor from '../components/IntersectionMonitor';
import type { Direction, LightState, Phase, Step } from '../sim/core';
import { getTrafficPeriod } from '../lib/utils';

interface TrafficLightRow {
  id: number;
  intersection_id: number;
  direction: string;
  movement_type?: string;
  current_status: number; // 0:red,1:yellow,2:green
  remaining_time: number;
  default_green_time: number;
  default_red_time: number;
  default_yellow_time: number;
}

interface IntersectionRow {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  status: number | string;
}

const TrafficControl: React.FC = () => {
  const [trafficLights, setTrafficLights] = useState<TrafficLightRow[]>([]);
  const [displayLights, setDisplayLights] = useState<TrafficLightRow[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const [intersections, setIntersections] = useState<IntersectionRow[]>([]);
  const [selectedIntersection, setSelectedIntersection] = useState<number | null>(null);
  const selectedIntersectionRef = useRef<number | null>(selectedIntersection);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [aiEnabled, setAiEnabled] = useState(false);
  const [lastAiAdvice, setLastAiAdvice] = useState<{ intersectionId: number; green: number; reason?: string } | null>(null);
  const aiEnabledRef = useRef(aiEnabled)
  const [queueSnapshot, setQueueSnapshot] = useState<Record<Direction, number>>({ North: 0, South: 0, East: 0, West: 0 })
  const [queueSnapshotSplit, setQueueSnapshotSplit] = useState<{ straight: Record<Direction, number>; left: Record<Direction, number> } | null>(null)
  const [intersectionMeta, setIntersectionMeta] = useState<{ auto_mode: number; current_phase: number } | null>(null)

  useEffect(() => {
    selectedIntersectionRef.current = selectedIntersection
  }, [selectedIntersection])
  useEffect(() => {
    aiEnabledRef.current = aiEnabled
    if (!aiEnabled) setLastAiAdvice(null)
  }, [aiEnabled])

  useEffect(() => {
    (async () => {
      try {
        const [intersectionsRes, selectedRes] = await Promise.all([
          fetch('/api/intersections'),
          fetch('/api/settings/selected-intersection').catch(() => null as any),
        ]);
        const intersectionsJson = await intersectionsRes.json();
        const list = intersectionsJson.data || [];
        setIntersections(list);

        let backendSelectedId: number | null = null;
        try {
          if (selectedRes) {
            const selectedJson = await selectedRes.json();
            const v = Number(selectedJson?.data ?? 0);
            backendSelectedId = v > 0 ? v : null;
          }
        } catch {}

        const hasId = (id: number | null | undefined) => id != null && list.some((i: any) => Number(i.id) === Number(id));
        const nextSelected = hasId(backendSelectedId)
          ? backendSelectedId
          : (list.length > 0 ? Number(list[0].id) : null);

        setSelectedIntersection(nextSelected);
      } catch (error) {
        console.error('获取路口信息失败:', error);
      }
    })();
  }, []);

  useEffect(() => {
    const s = io();
    // UI 的 displayLights 只由 worker 驱动，避免双源更新导致读秒跳变
    s.on('trafficLightUpdate', (data: any) => {
      if (!Array.isArray(data) || data.length === 0) return;
      const selected = selectedIntersectionRef.current
      if (selected != null && data[0].intersection_id !== selected) return
      setTrafficLights(data);
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'INIT', lights: data });
      }
    });
    s.on('trafficTimingUpdate', (data: any) => {
      if (aiEnabledRef.current && data?.source === 'ai') {
        setLastAiAdvice({
          intersectionId: data.intersectionId,
          green: data.advice?.green,
          reason: data.advice?.reason,
        });
      }
    });
    // 监听 AI 开关跨页面同步
    s.on('aiModeChanged', (data: any) => {
      if (data && typeof data.enabled === 'boolean') {
        setAiEnabled(data.enabled);
      }
    });
    s.on('light_status_update', (data: any) => {
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
    s.on('vehicleFlowUpdate', (data: any) => {
      const normalized = Array.isArray(data)
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
          : []);

      const selected = selectedIntersectionRef.current
      const items = normalized.filter((d: any) => d.intersection_id === selected)
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
    })
    return () => { s.close(); };
  }, []);

  useEffect(() => {
    if (selectedIntersection != null) {
      // 路口切换瞬间立即清空脏数据
      setTrafficLights([])
      setDisplayLights([])
      setQueueSnapshot({ North: 0, South: 0, East: 0, West: 0 })
      setQueueSnapshotSplit(null)
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'INIT', lights: [] })
      }
      fetchTrafficLights();
      fetchIntersectionMeta();
      fetch('/api/settings/selected-intersection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intersectionId: selectedIntersection })
      }).catch(() => {})
      ;(async () => {
        try {
          const splitRes = await fetch(`/api/vehicle-flows/realtime-split?intersection_id=${selectedIntersection}`)
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
            setQueueSnapshotSplit(null)
          }
        } catch {
          setQueueSnapshotSplit(null)
        }
      })()
    }
  }, [selectedIntersection]);

  const fetchAiMode = async () => {
    try {
      const response = await fetch('/api/settings/ai-mode');
      const json = await response.json();
      setAiEnabled(!!json.data);
    } catch {}
  };

  const fetchIntersectionMeta = async () => {
    try {
      if (selectedIntersection == null) return
      const response = await fetch(`/api/intersections/${selectedIntersection}`)
      const json = await response.json()
      const inter = json?.data?.intersection
      if (inter) {
        setIntersectionMeta({
          auto_mode: Number(inter.auto_mode ?? 1),
          current_phase: Number(inter.current_phase ?? 1),
        })
      }
    } catch {}
  }

  useEffect(() => {
    fetchAiMode();
  }, []);

  const updateAiMode = async (enabled: boolean) => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/settings/ai-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const json = await response.json();
      setAiEnabled(!!json.data);
      setMessage(`AI动态红绿灯${enabled ? '已开启' : '已关闭'}`);
      setTimeout(() => setMessage(''), 3000);
    } catch {
      setMessage('更新AI模式失败');
      setTimeout(() => setMessage(''), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchTrafficLights = async () => {
    try {
      if (selectedIntersection == null) return;
      const response = await fetch(`/api/traffic-lights?intersection_id=${selectedIntersection}`);
      const json = await response.json();
      setTrafficLights(json.data || []);
      // 不直接 setDisplayLights，让 worker 单向驱动 UI
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'INIT', lights: json.data || [] });
      }
    } catch (error) {
      console.error('获取红绿灯信息失败:', error);
    }
  };

  const updateTrafficLight = async (lightId: number, newState: 'red' | 'yellow' | 'green') => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/traffic-lights/${lightId}/state`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: newState }),
      });

      if (response.ok) {
        setMessage('红绿灯状态更新成功');
        fetchTrafficLights(); // 刷新数据
        setTimeout(() => setMessage(''), 3000);
      } else {
        const error = await response.json();
        setMessage(`更新失败: ${error.message}`);
        setTimeout(() => setMessage(''), 5000);
      }
    } catch (error) {
      setMessage('网络错误，请稍后重试');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleAutomaticMode = async (lightId: number, isAutomatic: boolean) => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/traffic-lights/${lightId}/mode`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: isAutomatic ? 'auto' : 'manual' }),
      });

      if (response.ok) {
        setMessage(`已切换到${isAutomatic ? '自动' : '手动'}模式`);
        fetchTrafficLights();
        setTimeout(() => setMessage(''), 3000);
      } else {
        const error = await response.json();
        setMessage(`模式切换失败: ${error.message}`);
        setTimeout(() => setMessage(''), 5000);
      }
    } catch (error) {
      setMessage('网络错误，请稍后重试');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

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

  // 当 trafficLights 变化（路口切换、socket 推送、手动控制）时，
  // 同步喂给 worker，保证读秒与服务端最新状态对齐。
  useEffect(() => {
    if (workerRef.current && trafficLights.length > 0) {
      workerRef.current.postMessage({ type: 'INIT', lights: trafficLights });
    }
  }, [trafficLights]);

  // 使用 displayLights（worker 每秒倒计时的快照）作为 UI 数据源，
  // 让 IntersectionMonitor 中的剩余秒数能平滑读秒，而无需等待 socket 推送或手动刷新。
  const selectedLights = selectedIntersection == null ? [] : displayLights.filter(l => l.intersection_id === selectedIntersection)

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
  const metaPhaseText = intersectionMeta?.current_phase === 1 ? '东西直行'
    : intersectionMeta?.current_phase === 2 ? '东西左转'
      : intersectionMeta?.current_phase === 3 ? '南北直行'
        : intersectionMeta?.current_phase === 4 ? '南北左转'
          : '未知'
  const metaModeText = intersectionMeta?.auto_mode === 0 ? '手动' : '自动'

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800 mb-2">交通灯控制面板</h1>
        <p className="text-gray-600">手动控制红绿灯状态和切换模式</p>
      </div>

      {/* 消息提示 */}
      {message && (
        <div className={`mb-4 p-4 rounded-lg ${
          message.includes('成功') || message.includes('已切换') 
            ? 'bg-green-100 text-green-800 border border-green-200' 
            : 'bg-red-100 text-red-800 border border-red-200'
        }`}>
          {message}
        </div>
      )}

      {/* 路口选择 */}
      <div className="mb-6 bg-white rounded-lg shadow-md p-6">
        <h2 className="text-xl font-semibold text-gray-800 mb-4">选择路口</h2>
        <select 
          value={selectedIntersection ?? ''} 
          onChange={(e) => setSelectedIntersection(e.target.value ? Number(e.target.value) : null)}
          className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          {(intersections || []).map((intersection) => (
            <option key={intersection.id} value={intersection.id}>
              {intersection.name} - {intersection.latitude},{intersection.longitude}
            </option>
          ))}
        </select>
        <div className="mt-4 flex items-center justify-between text-sm text-gray-700">
          <div>模式：{metaModeText}</div>
          <div>相位：{metaPhaseText}</div>
        </div>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
          <button
            disabled={selectedIntersection == null}
            onClick={async () => {
              if (selectedIntersection == null) return
              try {
                await fetch(`/api/intersections/${selectedIntersection}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ auto_mode: 1, current_phase: 1 })
                })
                await fetchIntersectionMeta()
                setMessage('已切换到东西直行')
                setTimeout(() => setMessage(''), 3000)
              } catch {
                setMessage('切换相位失败')
                setTimeout(() => setMessage(''), 3000)
              }
            }}
            className="px-3 py-2 rounded bg-gray-800 text-white hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            东西直行
          </button>
          <button
            disabled={selectedIntersection == null}
            onClick={async () => {
              if (selectedIntersection == null) return
              try {
                await fetch(`/api/intersections/${selectedIntersection}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ auto_mode: 1, current_phase: 2 })
                })
                await fetchIntersectionMeta()
                setMessage('已切换到东西左转')
                setTimeout(() => setMessage(''), 3000)
              } catch {
                setMessage('切换相位失败')
                setTimeout(() => setMessage(''), 3000)
              }
            }}
            className="px-3 py-2 rounded bg-gray-800 text-white hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            东西左转
          </button>
          <button
            disabled={selectedIntersection == null}
            onClick={async () => {
              if (selectedIntersection == null) return
              try {
                await fetch(`/api/intersections/${selectedIntersection}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ auto_mode: 1, current_phase: 3 })
                })
                await fetchIntersectionMeta()
                setMessage('已切换到南北直行')
                setTimeout(() => setMessage(''), 3000)
              } catch {
                setMessage('切换相位失败')
                setTimeout(() => setMessage(''), 3000)
              }
            }}
            className="px-3 py-2 rounded bg-gray-800 text-white hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            南北直行
          </button>
          <button
            disabled={selectedIntersection == null}
            onClick={async () => {
              if (selectedIntersection == null) return
              try {
                await fetch(`/api/intersections/${selectedIntersection}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ auto_mode: 1, current_phase: 4 })
                })
                await fetchIntersectionMeta()
                setMessage('已切换到南北左转')
                setTimeout(() => setMessage(''), 3000)
              } catch {
                setMessage('切换相位失败')
                setTimeout(() => setMessage(''), 3000)
              }
            }}
            className="px-3 py-2 rounded bg-gray-800 text-white hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            南北左转
          </button>
        </div>
        <div className="mt-4 flex items-center justify-between">
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
        <div className="mt-4 grid grid-cols-1 md:grid-cols-1 gap-3">
          <button onClick={async () => {
            if (selectedIntersection == null) return
            try {
              await fetch(`/api/intersections/${selectedIntersection}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_mode: 0 }) })
              await fetchIntersectionMeta()
              setMessage('已申请人工介入')
              setTimeout(() => setMessage(''), 3000)
            } catch {
              setMessage('申请人工介入失败')
              setTimeout(() => setMessage(''), 3000)
            }
          }} disabled={selectedIntersection == null} className="w-full px-3 py-2 rounded bg-gray-800 text-white hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed">申请人工介入</button>
        </div>
      </div>

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
    </div>
  );
};

export default TrafficControl;
