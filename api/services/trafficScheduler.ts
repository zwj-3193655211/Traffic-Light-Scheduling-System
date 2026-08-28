/**
 * 红绿灯周期调度器
 *
 * 每秒推进一次所有自动模式路口的相位：绿灯倒计时 -> 黄灯 -> 全红 -> 智能选相，
 * 并叠加低车流快速切绿、拥堵失衡截断等自适应策略。
 *
 * 本文件由 server.ts 原样迁出，行为不变，仅做依赖显式化（io 由外部注入）。
 */
import type { Server as IOServer } from 'socket.io'

import * as db from '../config/database.js'
import * as redis from '../config/redis.js'
import { getRuleGreenSeconds } from './ruleBasedTiming.ts'

export async function startTrafficLightScheduler(io: IOServer) {
  const schedulerStartedAt = Date.now();
  setInterval(async () => {
    try {
      let aiEnabledNow = false;
      try {
        const cached = await (redis.getCache ? redis.getCache('system:ai_mode') : Promise.resolve(null));
        aiEnabledNow = String(cached ?? '0') === '1';
      } catch {}

      const latestQueueCache = new Map<number, Record<string, number>>();
      const getLatestQueuesByDirection = async (intersectionId: number) => {
        if (latestQueueCache.has(intersectionId)) return latestQueueCache.get(intersectionId)!;
        const out: Record<string, number> = { North: 0, South: 0, East: 0, West: 0 };
        try {
          const [counts]: any = await db.pool.execute(
            `SELECT v1.direction, v1.vehicle_count as cnt 
             FROM vehicle_flows v1
             INNER JOIN (
                 SELECT direction, MAX(id) as max_id
                 FROM vehicle_flows
                 WHERE intersection_id = ?
                 GROUP BY direction
             ) v2 ON v1.direction = v2.direction AND v1.id = v2.max_id
             WHERE v1.intersection_id = ?`,
            [intersectionId, intersectionId]
          );
          if (Array.isArray(counts)) {
            for (const c of counts) {
              const dir = String(c.direction);
              if (dir === 'North' || dir === 'South' || dir === 'East' || dir === 'West') out[dir] = Number(c.cnt ?? 0);
            }
          }
        } catch {}
        latestQueueCache.set(intersectionId, out);
        return out;
      };

      const latestSplitQueueCache = new Map<number, any>();
      const getLatestSplitQueues = async (intersectionId: number) => {
        if (latestSplitQueueCache.has(intersectionId)) return latestSplitQueueCache.get(intersectionId);
        let out: any = null;
        try {
          const key = `virtual:queue_split:${intersectionId}`;
          const cached = await (redis.getCache ? redis.getCache(key) : Promise.resolve(null));
          if (cached && typeof cached === 'object') out = cached;
        } catch {}
        latestSplitQueueCache.set(intersectionId, out);
        return out;
      };

      const [paramsRows]: any = await db.pool.execute(
        `SELECT intersection_id, window_seconds, low_flow_threshold, min_green_floor FROM intersection_params`
      );
      const defaultWindow = parseInt(process.env.LOW_FLOW_WINDOW_SECONDS || '10');
      const defaultThreshold = parseInt(process.env.LOW_FLOW_THRESHOLD || '15');
      const defaultMinGreen = parseInt(process.env.MIN_GREEN_FLOOR_SECONDS || '10');
      const defaultMaxGreen = parseInt(process.env.MAX_GREEN_SECONDS || '120');
      const paramsMap = new Map<number, { window: number; threshold: number; minGreen: number }>();
      for (const r of paramsRows) {
        paramsMap.set(r.intersection_id, {
          window: r.window_seconds ?? defaultWindow,
          threshold: r.low_flow_threshold ?? defaultThreshold,
          minGreen: r.min_green_floor ?? defaultMinGreen,
        });
      }
      const [lights]: any = await db.pool.execute(
        `SELECT id, intersection_id, direction, movement_type, current_status, remaining_time, default_green_time, default_red_time, default_yellow_time, phase_number FROM traffic_lights`
      );
      const [intersectionRows]: any = await db.pool.execute(
        `SELECT id, current_phase, auto_mode FROM intersections`
      );
      const intersectionPhase = new Map<number, number>();
      const intersectionAuto = new Map<number, boolean>();
      for (const r of intersectionRows || []) {
        intersectionPhase.set(Number(r.id), Number(r.current_phase ?? 1));
        intersectionAuto.set(Number(r.id), Number(r.auto_mode ?? 1) !== 0);
      }

      const updatedIntersections = new Set<number>();
      
      // 按路口和相位分组
      const intersectionsMap = new Map<number, Map<number, any[]>>();
      for (const light of lights) {
        if (!intersectionsMap.has(light.intersection_id)) {
          intersectionsMap.set(light.intersection_id, new Map());
        }
        const phaseMap = intersectionsMap.get(light.intersection_id)!;
        if (!phaseMap.has(light.phase_number)) {
          phaseMap.set(light.phase_number, []);
        }
        phaseMap.get(light.phase_number)!.push(light);
      }

      // 按路口处理每个相位
      for (const [intersectionId, phaseMap] of intersectionsMap) {
        if (intersectionAuto.get(intersectionId) === false) {
          updatedIntersections.add(intersectionId);
          continue;
        }
        const phases = Array.from(phaseMap.keys()).sort((a, b) => a - b);
        if (phases.length === 0) continue;

        let activePhase = intersectionPhase.get(intersectionId) ?? phases[0];
        if (!phases.includes(activePhase)) {
          activePhase = phases[0];
          await db.pool.execute(
            `UPDATE intersections SET current_phase = ?, updated_at = NOW() WHERE id = ?`,
            [activePhase, intersectionId]
          );
        }

        const activeLights = phaseMap.get(activePhase) || [];
        const hasGreen = activeLights.some((l: any) => l.current_status === 2);
        const hasYellow = activeLights.some((l: any) => l.current_status === 1);

        let forcedGreenThisTick = false;
        if (!hasGreen && !hasYellow) {
          const hasRedCountdown = activeLights.some((l: any) => l.current_status === 0 && Number(l.remaining_time ?? 0) > 0);
          forcedGreenThisTick = true;
          if (hasRedCountdown) {
            console.log(`[PHASE] intersection=${intersectionId} phase=${activePhase} start GREEN (recover from RED countdown)`);
          } else {
            console.log(`[PHASE] intersection=${intersectionId} phase=${activePhase} start GREEN`);
          }
        }

          let capGreenTo10 = false;
        const cfg = paramsMap.get(intersectionId) || { window: defaultWindow, threshold: defaultThreshold, minGreen: defaultMinGreen };
        if (!forcedGreenThisTick && hasGreen && (Date.now() - schedulerStartedAt) > 5000) {
          const activeGreenMax = Math.max(0, ...activeLights.filter((l: any) => l.current_status === 2).map((l: any) => Number(l.remaining_time ?? 0)));
          const activeGreenDefault = Math.max(0, ...activeLights.filter((l: any) => l.current_status === 2).map((l: any) => Number(l.default_green_time ?? 0)));
          // 仅在绿灯已运行 >= 3 秒（即剩余 <= default - 3）后才允许 cap，避免新相位刚启动就被打到 10
          const alreadyRunSeconds = Math.max(0, activeGreenDefault - activeGreenMax);
          if (activeGreenMax > 10 && alreadyRunSeconds >= 3) {
            const pair = activePhase === 3 || activePhase === 4 ? ['North', 'South'] : ['East', 'West'];
            const movementType = (activePhase === 1 || activePhase === 3) ? 'straight' : 'left';
            const split = await getLatestSplitQueues(intersectionId);
            if (split) {
              const a = Number(split?.[pair[0]]?.[movementType] ?? 0);
              const b = Number(split?.[pair[1]]?.[movementType] ?? 0);
              capGreenTo10 = (a + b) < cfg.threshold;
            } else {
              const q = await getLatestQueuesByDirection(intersectionId);
              const phaseTotal = Number(q[pair[0]] ?? 0) + Number(q[pair[1]] ?? 0);
              capGreenTo10 = phaseTotal < cfg.threshold;
            }
          }
        }

        // 拥堵失衡感知：若其他相位中存在远高于当前相位的拥堵（>= 3 倍且差值绝对值大），
        // 把当前绿灯立刻削到 minGreen，加速切换到拥堵相位。
        let capGreenToMin = false;
        if (!forcedGreenThisTick && hasGreen && (Date.now() - schedulerStartedAt) > 5000) {
          try {
            const split = await getLatestSplitQueues(intersectionId);
            const totalsByDir = await getLatestQueuesByDirection(intersectionId);
            const demandOf = (p: number): number => {
              const pair: ('North'|'South'|'East'|'West')[] = (p === 3 || p === 4) ? ['North', 'South'] : ['East', 'West'];
              const movement: 'straight' | 'left' = (p === 1 || p === 3) ? 'straight' : 'left';
              if (split && typeof split === 'object') {
                return pair.reduce((acc, d) => acc + Number(split?.[d]?.[movement] ?? 0), 0);
              }
              const ratio = movement === 'straight' ? 0.7 : 0.3;
              return pair.reduce((acc, d) => acc + Math.round(Number(totalsByDir[d] ?? 0) * ratio), 0);
            };
            const currentDemand = demandOf(activePhase);
            const otherPhases = phases.filter(p => p !== activePhase);
            const otherMax = otherPhases.reduce((m, p) => Math.max(m, demandOf(p)), 0);
            const IMBALANCE_FACTOR = 3;
            const IMBALANCE_DELTA = 50; // 至少差 50 辆车才算严重失衡
            if (otherMax > currentDemand * IMBALANCE_FACTOR && (otherMax - currentDemand) >= IMBALANCE_DELTA) {
              capGreenToMin = true;
              console.log(`[IMBALANCE] intersection=${intersectionId} current_phase=${activePhase}(q=${currentDemand}) vs max_other=${otherMax}, cap green to minGreen=${cfg.minGreen}`);
            }
          } catch {}
        }

        let ruleGreenSeconds: number | null = null;
        if (forcedGreenThisTick) {
          // 无论 AI 模式是否开启，新相位启动时都按规则根据当前队列动态决定绿灯时长。
          // AI 模式会通过 AI advisor loop 异步覆盖这个值（如果 AI 给出更优建议），
          // 但启动瞬间至少有一个基于队列的合理时长，避免拥堵相位只拿到 default_green_time。
          try {
            const split = await getLatestSplitQueues(intersectionId);
            const queuesByDirection: any = {};
            if (split && typeof split === 'object') {
              // 优先使用 split 数据（更准确），把同向 straight+left 加成总数
              for (const dir of ['North','South','East','West']) {
                const s = Number((split as any)?.[dir]?.straight ?? 0);
                const l = Number((split as any)?.[dir]?.left ?? 0);
                queuesByDirection[dir] = s + l;
              }
            } else {
              const [counts]: any = await db.pool.execute(
                `SELECT v1.direction, v1.vehicle_count as cnt
                 FROM vehicle_flows v1
                 INNER JOIN (
                     SELECT direction, MAX(id) as max_id
                     FROM vehicle_flows
                     WHERE intersection_id = ?
                     GROUP BY direction
                 ) v2 ON v1.direction = v2.direction AND v1.id = v2.max_id
                 WHERE v1.intersection_id = ?`,
                [intersectionId, intersectionId]
              );
              if (Array.isArray(counts)) {
                for (const c of counts) {
                  queuesByDirection[c.direction] = Number(c.cnt ?? 0);
                }
              }
            }
            const movementType = (activePhase === 1 || activePhase === 3) ? 'straight' : 'left';
            const cfg = paramsMap.get(intersectionId) || { window: defaultWindow, threshold: defaultThreshold, minGreen: defaultMinGreen };
            ruleGreenSeconds = getRuleGreenSeconds({
              intersectionId,
              phaseNumber: activePhase,
              movementType,
              queuesByDirection,
              minGreen: cfg.minGreen,
              maxGreen: defaultMaxGreen,
            });
          } catch {}
        }

        let lowFlow = false;
        if (!forcedGreenThisTick && hasGreen) {
          const pair = activePhase === 3 || activePhase === 4 ? ['North', 'South'] : ['East', 'West'];
          const [rows]: any = await db.pool.execute(
            `SELECT COUNT(*) AS samples, COALESCE(SUM(vehicle_count),0) AS cnt FROM vehicle_flows WHERE intersection_id = ? AND direction IN (?, ?) AND timestamp >= DATE_SUB(NOW(), INTERVAL ? SECOND)`,
            [intersectionId, pair[0], pair[1], cfg.window]
          );
          const samples = Number(rows[0]?.samples ?? 0);
          const cnt = Number(rows[0]?.cnt ?? 0);
          lowFlow = samples > 0 && cnt < cfg.threshold;
        }

        let phaseToYellow = false;
        let phaseToAllRed = false;

        for (const [phaseNum, phaseLights] of phaseMap) {
          const isActive = phaseNum === activePhase;
          for (const light of phaseLights) {
            const oldStatus = light.current_status;
            let newStatus = light.current_status;
            let newRemaining = light.remaining_time;

            if (!isActive) {
              newStatus = 0;
              newRemaining = 0;
            } else if (forcedGreenThisTick) {
              newStatus = 2;
              newRemaining = ruleGreenSeconds ?? (light.default_green_time || 30);
            } else {
              if (newStatus === 2 && lowFlow && newRemaining > cfg.minGreen) {
                newRemaining = cfg.minGreen;
              }

              if (newRemaining > 0) {
                newRemaining = newRemaining - 1;
              } else {
                if (newStatus === 0) {
                  newStatus = 2;
                  newRemaining = light.default_green_time || 30;
                } else if (newStatus === 2) {
                  newStatus = 1;
                  newRemaining = light.default_yellow_time || 3;
                } else if (newStatus === 1) {
                  newStatus = 0;
                  newRemaining = 0;
                }
              }
            }

          if (capGreenTo10 && newStatus === 2 && newRemaining > 10) {
            newRemaining = 10;
            console.log(`[LOWFLOW10] intersection=${intersectionId} phase=${activePhase} green_remaining->10`);
          }

          // 拥堵失衡截断：把绿灯打到 minGreen，让拥堵相位尽快接管
          if (capGreenToMin && newStatus === 2 && newRemaining > cfg.minGreen) {
            newRemaining = cfg.minGreen;
          }

            if (isActive && !forcedGreenThisTick) {
              if (oldStatus === 2 && newStatus === 1) phaseToYellow = true;
              if (oldStatus === 1 && newStatus === 0) phaseToAllRed = true;
            }

            await db.pool.execute(
              `UPDATE traffic_lights
               SET current_status = ?,
                   remaining_time = ?,
                   default_green_time = COALESCE(?, default_green_time),
                   updated_at = NOW()
               WHERE id = ?`,
              [newStatus, newRemaining, (forcedGreenThisTick && isActive && ruleGreenSeconds != null) ? ruleGreenSeconds : null, light.id]
            );

            updatedIntersections.add(intersectionId);
            io.emit('light_status_update', {
              lightId: light.id,
              status: newStatus,
              remainingTime: newRemaining,
              direction: light.direction,
            });
          }
        }

        if (phaseToYellow) console.log(`[PHASE] intersection=${intersectionId} phase=${activePhase} GREEN -> YELLOW`);
        if (phaseToAllRed) {
          console.log(`[PHASE] intersection=${intersectionId} phase=${activePhase} YELLOW -> ALL_RED`);
          if (phases.length > 1) {
            // 智能相位选择：根据各相位对应方向的队列长度，挑选最拥堵的下一相位，
            // 而不是简单的环形轮转。排除当前相位以保证轮换公平性。
            // 相位约定：1=东西直行, 2=东西左转, 3=南北直行, 4=南北左转
            const split = await getLatestSplitQueues(intersectionId);
            const totalsByDir = await getLatestQueuesByDirection(intersectionId);
            const phaseDemand = (p: number): number => {
              const pair: ('North'|'South'|'East'|'West')[] = (p === 3 || p === 4) ? ['North', 'South'] : ['East', 'West'];
              const movement: 'straight' | 'left' = (p === 1 || p === 3) ? 'straight' : 'left';
              if (split && typeof split === 'object') {
                return pair.reduce((acc, d) => acc + Number(split?.[d]?.[movement] ?? 0), 0);
              }
              // fallback：用总流量按 0.7/0.3 拆分粗估
              const ratio = movement === 'straight' ? 0.7 : 0.3;
              return pair.reduce((acc, d) => acc + Math.round(Number(totalsByDir[d] ?? 0) * ratio), 0);
            };
            const candidates = phases.filter(p => p !== activePhase);
            // 在候选中按队列总数排序，最长者优先
            let bestPhase = candidates[0];
            let bestQueue = -1;
            for (const p of candidates) {
              const demand = phaseDemand(p);
              if (demand > bestQueue) {
                bestQueue = demand;
                bestPhase = p;
              }
            }
            // 公平性兜底：如果"按队列选出的相位"已经被连续跳过太多轮（>= 2 次），
            // 则强制走环形轮转，避免某个低流量相位被永远饿死。
            try {
              const skipKey = `phase:skip_count:${intersectionId}`;
              const rawSkip = await (redis.getCache ? redis.getCache(skipKey) : Promise.resolve(null));
              const skipMap: Record<string, number> = (rawSkip && typeof rawSkip === 'object') ? rawSkip as any : {};
              const currentIndex = phases.indexOf(activePhase);
              const naturalNext = phases[(currentIndex + 1) % phases.length];
              // 没被选中的相位计数 +1，被选中的清零
              for (const p of phases) {
                const k = String(p);
                if (p === activePhase) continue; // 当前相位本来就刚跑完，不计
                if (p === bestPhase) {
                  skipMap[k] = 0;
                } else {
                  skipMap[k] = (skipMap[k] || 0) + 1;
                }
              }
              // 如果自然轮转中的下一相位已被连续跳过 ≥ 2 次，强制走自然轮转
              const naturalSkip = skipMap[String(naturalNext)] || 0;
              if (naturalSkip >= 2 && naturalNext !== bestPhase) {
                console.log(`[PHASE] intersection=${intersectionId} fairness override: ${bestPhase} -> ${naturalNext} (skipped ${naturalSkip}x)`);
                bestPhase = naturalNext;
                skipMap[String(naturalNext)] = 0;
              }
              if (redis.setCache) await redis.setCache(skipKey, skipMap, 600);
            } catch {}
            await db.pool.execute(
              `UPDATE intersections SET current_phase = ?, updated_at = NOW() WHERE id = ?`,
              [bestPhase, intersectionId]
            );
            console.log(`[PHASE] intersection=${intersectionId} switch ${activePhase} -> ${bestPhase} (queue=${bestQueue})`);
          }
        }
      }

      for (const intersectionId of Array.from(updatedIntersections)) {
        const [updated]: any = await db.pool.execute(
          `SELECT id, intersection_id, direction, movement_type, current_status, remaining_time, default_green_time, default_red_time, default_yellow_time FROM traffic_lights WHERE intersection_id = ? ORDER BY phase_number, direction, movement_type`,
          [intersectionId]
        );
        io.emit('trafficLightUpdate', updated);
      }
    } catch {}
  }, 1000);
}
