/**
 * AI 动态配时循环
 *
 * 按 AI_ADVICE_INTERVAL_MS 周期向 AI 请求建议绿灯时长，经约束夹紧后落地到数据库并广播，
 * 全程 fire-and-forget，慢模型不会阻塞主轮询。
 *
 * 本文件由 server.ts 原样迁出，行为不变，仅做依赖显式化（io 由外部注入）。
 */
import type { Server as IOServer } from 'socket.io'

import * as db from '../config/database.js'
import * as redis from '../config/redis.js'
import { aiTrafficAdvisor, setModelOverride, type Constraints } from './aiTrafficAdvisor.ts'
import { aiRuntime } from './aiRuntime.ts'

const AI_ADVICE_INTERVAL_MS = parseInt(process.env.AI_ADVICE_INTERVAL_MS || '10000')
const AI_DEV_AUTOSTART =
  (process.env.AI_DEV_AUTOSTART ?? '0') === '1' && process.env.NODE_ENV !== 'production'
let aiModeEnabled = false
let aiDevAutostartLogged = false

export async function startAiAdvisorLoop(io: IOServer) {
  if (AI_DEV_AUTOSTART && !aiDevAutostartLogged) {
    aiDevAutostartLogged = true;
    console.log(`[AI] dev自动启动已开启：轮询间隔=${Math.ceil(AI_ADVICE_INTERVAL_MS / 1000)}秒（可用 AI_DEV_AUTOSTART=0 关闭）`);
  }
  
  // 记录每个路口的当前相位和轮询次数
  // Map<intersectionId, { phase: number, count: number }>
  const aiPhaseTracker = new Map<number, { phase: number, count: number }>();

  // 优化：增量门控快照、响应缓存命中计数、指标
  const aiStatsSnapshot = new Map<number, { phase: number; totals: number[] }>();
  // P2.5.2：AI 运行时指标统一写入共享单例 aiRuntime（server.ts 写入，/api/ai/metrics 读取），不再用局部变量。
  const AI_GATE_DELTA = parseInt(process.env.AI_GATE_DELTA || '2');
  // P3 异步队列化：记录飞行中的 AI 决策（按路口），防止慢模型/网络下同一路口调用堆叠
  const aiInFlight = new Set<number>();

  // P3：将 AI 建议落地到数据库并广播。缓存命中路径与异步 AI 回调复用同一逻辑，
  // 且全程 fire-and-forget（不 await），确保主轮询循环绝不被慢 API 拖慢。
  const applyAiAdvice = (
    intersectionId: number,
    advice: { green: number; reason?: string },
    ctx: { yellowFixed: number; cycleMax: number; tracker?: { phase: number; count: number }; currentPhase: number }
  ) => {
    const { yellowFixed, cycleMax, tracker, currentPhase } = ctx;
    const green = advice.green;
    const yellow = yellowFixed;
    const red = Math.max(0, cycleMax - green - yellow);
    console.log(`[AI建议] 路口 ${intersectionId}：当前绿灯建议调整为 ${green}秒`);
    // P2.5.2：写入最近一次 AI 建议，供健康面板展示
    aiRuntime.lastAdvice = { intersectionId, green, reason: advice?.reason };
    aiRuntime.lastAdviceTs = Date.now();

    // 1. 更新当前处于绿灯状态的灯的“默认时长” (default_green_time)
    db.pool.execute(
      `UPDATE traffic_lights SET default_green_time = ?, default_red_time = ?, default_yellow_time = ? WHERE intersection_id = ? AND current_status = 2`,
      [green, red, yellow, intersectionId]
    ).then(([updateResult]: any) => {
      console.log(`[AI应用] 路口 ${intersectionId}：已更新当前绿灯时长为 ${green}秒 (受影响行数: ${updateResult.affectedRows})`);
    }).catch(() => {});

    // 2. 非绿灯灯重置为安全默认值 30s，避免相位串味
    db.pool.execute(
      `UPDATE traffic_lights SET default_green_time = 30 WHERE intersection_id = ? AND current_status != 2`,
      [intersectionId]
    ).catch(() => {});

    // 3. 立即更新当前实时倒计时
    db.pool.execute(
      `UPDATE traffic_lights SET remaining_time = CASE current_status WHEN 2 THEN ? WHEN 1 THEN ? WHEN 0 THEN ? END WHERE intersection_id = ?`,
      [green, yellow, red, intersectionId]
    ).catch(() => {});

    db.pool.execute(
      `SELECT id, intersection_id, direction, movement_type, current_status, remaining_time, default_green_time, default_red_time, default_yellow_time FROM traffic_lights WHERE intersection_id = ? ORDER BY phase_number, direction, movement_type`,
      [intersectionId]
    ).then(([updatedNow]: any) => {
      io.emit('trafficTimingUpdate', { intersectionId, source: 'ai', advice: { green, reason: advice?.reason } });
      io.emit('trafficLightUpdate', updatedNow);
    }).catch(() => {});

    // 成功应用 AI 建议后，增加轮询计数（用于“每相位最多 3 次”上限）
    if (tracker) {
      tracker.count++;
      console.log(`[AI计数] 路口 ${intersectionId}：相位 ${currentPhase} 轮询次数已更新为 ${tracker.count}/3`);
    }
  };

  const schedule = () => setTimeout(() => { tick().catch(() => {}) }, AI_ADVICE_INTERVAL_MS);
  const tick = async () => {
    try {
      try {
        const cached = await (redis.getCache ? redis.getCache('system:ai_mode') : Promise.resolve(null));
        if (cached !== null) aiModeEnabled = String(cached) === '1';
      } catch {}
      if (!aiModeEnabled) return;

      // 运行时热切换模型（见 docs/AI优化设计.md 5.1）：读取 Redis system:ai_model
      try {
        const m = await (redis.getCache ? redis.getCache('system:ai_model') : Promise.resolve(null));
        setModelOverride(m ? String(m) : null);
      } catch {}

      const defaultWindow = parseInt(process.env.LOW_FLOW_WINDOW_SECONDS || '10');
      const defaultMinGreen = parseInt(process.env.MIN_GREEN_FLOOR_SECONDS || '5');
      const maxGreen = parseInt(process.env.MAX_GREEN_SECONDS || '120');
      const [sysRows]: any = await db.pool.execute(
        `SELECT max_cycle_length, yellow_light_duration FROM system_settings ORDER BY id DESC LIMIT 1`
      );
      const sys = sysRows[0] || {};
      const minYellow = parseInt(process.env.MIN_YELLOW_SECONDS || '1');
      const maxYellow = parseInt(process.env.MAX_YELLOW_SECONDS || '10');
      const cycleMax = parseInt((sys?.max_cycle_length ?? process.env.CYCLE_MAX_SECONDS) || '120');
      const constraints: Constraints = {
        minGreen: defaultMinGreen,
        maxGreen,
        minYellow,
        maxYellow,
        cycleMax
      };
      const yellowFixed = Math.max(minYellow, Math.min(maxYellow, parseInt(String(sys?.yellow_light_duration ?? 3))));
      
      const [ids]: any = await db.pool.execute(
        `SELECT DISTINCT intersection_id FROM traffic_lights ORDER BY intersection_id`
      );
      
      let selectedIntersectionId: number | null = null;
      try {
        const cached = await (redis.getCache ? redis.getCache('system:selected_intersection') : Promise.resolve(null));
        if (cached !== null && cached !== '0') {
          selectedIntersectionId = parseInt(cached);
        }
      } catch {}
      
      // 如果没有选定路口，则不执行任何 AI 逻辑
      if (selectedIntersectionId === null) {
        if (AI_DEV_AUTOSTART && Array.isArray(ids) && ids.length > 0) {
          selectedIntersectionId = Number(ids[0].intersection_id);
          try {
            await (redis.setCache ? redis.setCache('system:selected_intersection', String(selectedIntersectionId), 86400) : Promise.resolve());
          } catch {}
          console.log(`[AI] dev自动选择路口: system:selected_intersection=${selectedIntersectionId}`);
        } else {
          console.log('[AI] 未选择路口，跳过（打开前端选择路口，或调用 POST /api/settings/selected-intersection）');
          return;
        }
      }

      if (selectedIntersectionId === null) {
        return;
      }

      for (const row of ids) {
        const intersectionId = row.intersection_id;
        
        if (selectedIntersectionId !== null && intersectionId !== selectedIntersectionId) {
          continue;
        }
        try {
          // 获取各个方向的当前候车数 (取最新的一条记录作为当前排队快照)
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
          
          // 获取当前红绿灯状态，包括当前通行方向和剩余时间
          const [lightsStatus]: any = await db.pool.execute(
            `SELECT direction, movement_type, current_status, remaining_time, phase_number 
             FROM traffic_lights 
             WHERE intersection_id = ? 
             ORDER BY current_status DESC, remaining_time DESC`,
            [intersectionId]
          );
          
          // 找出当前绿灯方向和剩余时间
          const currentGreen = lightsStatus.find((light: any) => light.current_status === 2);
          const currentGreenDirection = currentGreen?.direction || 'Unknown';
          const currentGreenMovementType = currentGreen?.movement_type || 'straight';
          const currentGreenRemaining = currentGreen?.remaining_time || 0;
          const currentPhase = Number(currentGreen?.phase_number || 0);

          const intervalSeconds = Math.ceil(AI_ADVICE_INTERVAL_MS / 1000);
          if (!currentGreen || currentGreenRemaining <= 0) {
            continue;
          }
          if (currentGreenRemaining < intervalSeconds) {
            console.log(`[AI跳过] 路口 ${intersectionId}：绿灯剩余${currentGreenRemaining}秒 < 轮询间隔${intervalSeconds}秒`);
            continue;
          }

          // 检查轮询次数限制
          let tracker = aiPhaseTracker.get(intersectionId);
          if (!tracker || tracker.phase !== currentPhase) {
            // 如果是新相位，重置计数
            tracker = { phase: currentPhase, count: 0 };
            aiPhaseTracker.set(intersectionId, tracker);
          }

          if (tracker.count >= 3) {
            console.log(`[AI跳过] 路口 ${intersectionId}：当前相位 ${currentPhase} 已轮询 ${tracker.count} 次，达到上限`);
            continue;
          }
          
          // 按照用户要求的格式组织数据：每个方向显示直行和左转车辆数
          const directionMap = new Map<string, number>();
          counts.forEach((count: any) => {
            directionMap.set(count.direction, count.cnt);
          });

          // 尝试从 Redis 获取真实的直行/左转分流数据 (与前端显示保持一致)
          let splitData: any = null;
          try {
            const cachedSplit = await (redis.getCache ? redis.getCache(`virtual:queue_split:${intersectionId}`) : Promise.resolve(null));
             if (cachedSplit && typeof cachedSplit === 'object') {
               splitData = cachedSplit;
             }
          } catch {}

          const getCounts = (dir: string) => {
             if (splitData && splitData[dir]) {
                 return {
                     straight: Number(splitData[dir].straight ?? 0),
                     left: Number(splitData[dir].left ?? 0)
                 };
             }
             // Fallback: use total count from DB and estimate 70/30 split
             const total = directionMap.get(dir) || 0;
             return {
                 straight: Math.round(total * 0.7),
                 left: Math.round(total * 0.3)
             };
          };

          const countsNorth = getCounts('North');
          const countsSouth = getCounts('South');
          const countsEast = getCounts('East');
          const countsWest = getCounts('West');

          // 计算规则模式的基础建议时长 (Base Rule-Based Timing)
          // 即使在 AI 模式下，也先用规则算一个“保底值”，AI 可以在此基础上微调
          // 这样如果 AI 挂了或者返回 -1，我们至少有一个合理的动态值，而不是死板的默认值
          let baseRuleGreen = 30;
          try {
              const pair = (currentPhase === 3 || currentPhase === 4) ? ['North', 'South'] : ['East', 'West'];
              const movement = (currentPhase === 1 || currentPhase === 3) ? 'straight' : 'left';
              
              // 构造 queuesByDirection 供 getRuleGreenSeconds 使用
              // 注意：getRuleGreenSeconds 内部目前的 splitMovement 逻辑是估算 0.7/0.3
              // 为了复用现有逻辑，我们这里传入总数 (straight + left) 让它去切分
              // 或者更优的做法：直接修改 getRuleGreenSeconds 支持 split 输入，但为了不破坏旧代码，
              // 我们这里手动适配一下：
              const qRule: any = {};
              ['North', 'South', 'East', 'West'].forEach(d => {
                  const c = getCounts(d);
                  qRule[d] = c.straight + c.left; // 传总数
              });
              
              // 也可以考虑直接重写一段简单的逻辑，用真实的 split 数据
              const qReal = Number(getCounts(pair[0] as any)[movement as 'straight'|'left']) + 
                            Number(getCounts(pair[1] as any)[movement as 'straight'|'left']);
                            
              // 简单的分段函数 (类似 ruleBasedTiming.ts 的 bucketGreenSeconds)
              if (movement === 'left') {
                  if (qReal <= 5) baseRuleGreen = 12;
                  else if (qReal <= 20) baseRuleGreen = 18;
                  else baseRuleGreen = 25;
              } else {
                  if (qReal <= 10) baseRuleGreen = 20;
                  else if (qReal <= 40) baseRuleGreen = 35;
                  else baseRuleGreen = 50;
              }
              baseRuleGreen = Math.max(defaultMinGreen, Math.min(maxGreen, baseRuleGreen));
              // console.log(`[AI-Base] 路口 ${intersectionId} 规则保底值: ${baseRuleGreen}s (Q=${qReal})`);
          } catch {}

          
          // 为每个方向构建数据格式
          const formattedStats = {
            North: {
              straight: countsNorth.straight,
              left: countsNorth.left,
              straightStatus: lightsStatus.find((l: any) => l.direction === 'North' && l.movement_type === 'straight'),
              leftStatus: lightsStatus.find((l: any) => l.direction === 'North' && l.movement_type === 'left')
            },
            South: {
              straight: countsSouth.straight,
              left: countsSouth.left,
              straightStatus: lightsStatus.find((l: any) => l.direction === 'South' && l.movement_type === 'straight'),
              leftStatus: lightsStatus.find((l: any) => l.direction === 'South' && l.movement_type === 'left')
            },
            East: {
              straight: countsEast.straight,
              left: countsEast.left,
              straightStatus: lightsStatus.find((l: any) => l.direction === 'East' && l.movement_type === 'straight'),
              leftStatus: lightsStatus.find((l: any) => l.direction === 'East' && l.movement_type === 'left')
            },
            West: {
              straight: countsWest.straight,
              left: countsWest.left,
              straightStatus: lightsStatus.find((l: any) => l.direction === 'West' && l.movement_type === 'straight'),
              leftStatus: lightsStatus.find((l: any) => l.direction === 'West' && l.movement_type === 'left')
            },
            currentGreenDirection,
            currentGreenMovementType,
            currentGreenRemaining
          };
          
          // 增量门控：若相位未变且各方向车流变化量都小于阈值，则跳过本次 AI 调用（复用上次建议）
          const gateTotals = ['North', 'South', 'East', 'West'].map((dir) => {
            const d: any = (formattedStats as any)[dir] || {};
            return Number(d.straight || 0) + Number(d.left || 0);
          });
          const prevSnap = aiStatsSnapshot.get(intersectionId);
          if (prevSnap && prevSnap.phase === currentPhase) {
            const delta =
              Math.abs(gateTotals[0] - prevSnap.totals[0]) +
              Math.abs(gateTotals[1] - prevSnap.totals[1]) +
              Math.abs(gateTotals[2] - prevSnap.totals[2]) +
              Math.abs(gateTotals[3] - prevSnap.totals[3]);
            if (delta <= AI_GATE_DELTA) {
              aiRuntime.gateSkips++;
              console.log(`[AI门控] 路口 ${intersectionId}：车流变化 ${delta} <= ${AI_GATE_DELTA}，跳过 AI 调用`);
              continue;
            }
          }
          aiStatsSnapshot.set(intersectionId, { phase: currentPhase, totals: gateTotals });

          // 构建完整的统计数据，包括当前绿灯状态
          const stats = {
            window: defaultWindow,
            formattedStats,
            currentGreenDirection,
            currentGreenMovementType,
            currentGreenRemaining,
            allLights: lightsStatus
          };
          
          // 按照用户要求的格式记录统计数据
          console.log(`[AI输入] 路口 ${intersectionId}：`);
          const directions = ['North', 'South', 'East', 'West'];
          directions.forEach(dir => {
            const data = formattedStats[dir as keyof typeof formattedStats];
            const straightStatus = data.straightStatus;
            const leftStatus = data.leftStatus;
            
            const straightStatusText = straightStatus ? (['红灯', '黄灯', '绿灯'][straightStatus.current_status]) : '未知';
            const leftStatusText = leftStatus ? (['红灯', '黄灯', '绿灯'][leftStatus.current_status]) : '未知';
            
            const straightRemainingText = straightStatus && straightStatus.current_status === 2 ? `，绿灯剩余${straightStatus.remaining_time}秒` : '';
            const leftRemainingText = leftStatus && leftStatus.current_status === 2 ? `，绿灯剩余${leftStatus.remaining_time}秒` : '';
            
            console.log(`  ${dir}：直行${data.straight}辆，${straightStatusText}${straightRemainingText}；左转${data.left}辆，${leftStatusText}${leftRemainingText}`);
          });
          let advice: { green: number; reason?: string } | null = null
          const cacheKey = `ai:advice:${intersectionId}`
          let fromCache = false
          try {
            const cached = await (redis.getCache ? redis.getCache(cacheKey) : Promise.resolve(null));
            if (cached && typeof cached === 'object' && typeof (cached as any).green === 'number') {
              advice = { green: (cached as any).green, reason: (cached as any).reason };
              fromCache = true;
              aiRuntime.cacheHits++;
            }
          } catch {}
          if (!fromCache) {
            // P3 异步队列化：不在主循环里 await AI 调用，避免慢 API 拖慢 10s 轮询。
            // 仅当上一轮决策仍在飞行中时跳过，防止慢模型/网络下同一路口调用堆叠。
            if (aiInFlight.has(intersectionId)) {
              console.log(`[AI跳过] 路口 ${intersectionId}：上一轮 AI 决策仍在处理中，本 tick 不再发起`);
            } else {
              aiInFlight.add(intersectionId);
              aiTrafficAdvisor.getAdvice(
                { intersectionId: String(intersectionId), stats },
                constraints
              )
                .then((adv) => {
                  try {
                    if (redis.setCache) redis.setCache(cacheKey, { green: adv.green, reason: adv.reason ?? '', ts: Date.now() }, AI_ADVICE_INTERVAL_MS * 2);
                  } catch {}
                  try {
                    applyAiAdvice(intersectionId, adv, { yellowFixed, cycleMax, tracker, currentPhase });
                  } catch (err) {
                    console.error(`[AI应用异常] 路口 ${intersectionId}:`, err);
                  }
                })
                .catch((e: any) => {
                  const msg = String(e?.message || '');
                  if (msg.includes('AI建议不调整')) {
                    if (Math.abs(currentGreenRemaining - baseRuleGreen) > 10) {
                      console.log(`[AI建议不调整] 但规则建议差异大，采用规则值: ${baseRuleGreen}s (当前: ${currentGreenRemaining}s)`);
                      applyAiAdvice(intersectionId, { green: baseRuleGreen }, { yellowFixed, cycleMax, tracker, currentPhase });
                    } else {
                      console.log(`[AI建议] 路口 ${intersectionId}：当前绿灯时长不需要调整 (规则值 ${baseRuleGreen}s 与当前接近)`);
                    }
                  } else {
                    console.warn(`[AI异常] 路口 ${intersectionId}：${msg || 'unknown'} -> 降级为规则模式: ${baseRuleGreen}s`);
                    applyAiAdvice(intersectionId, { green: baseRuleGreen }, { yellowFixed, cycleMax, tracker, currentPhase });
                  }
                })
                .finally(() => { aiInFlight.delete(intersectionId); });
            }
          } // end if (!fromCache)

          if (!advice) continue;

          // P3：复用 applyAiAdvice（与异步 AI 回调同一逻辑）。缓存命中路径同步即时应用，无需等待网络。
          applyAiAdvice(intersectionId, advice, { yellowFixed, cycleMax, tracker, currentPhase });
        } catch {
          continue
        }
      }

      aiRuntime.tickCount++
      if (aiRuntime.tickCount % 30 === 0) {
        const am: any = aiTrafficAdvisor.getAdvisorMetrics();
        console.log(`[AI指标] ticks=${aiRuntime.tickCount} 门控跳过=${aiRuntime.gateSkips} 缓存命中=${aiRuntime.cacheHits} 调用=${am.calls} 成功=${am.successes} 失败=${am.failures} 熔断跳过=${am.circuitOpenSkips} 平均耗时=${am.avgLatencyMs}ms`);
      }
    } catch {} finally {
      schedule();
    }
  };
  tick().catch(() => schedule());
}
