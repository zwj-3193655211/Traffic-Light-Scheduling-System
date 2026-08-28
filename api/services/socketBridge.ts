/**
 * Redis Pub/Sub -> Socket.IO 桥接
 *
 * 后端各路由通过 Redis 发布领域事件，这里统一订阅并转发给前端，
 * 使数据库侧的变更（人工控制、紧急车辆、算法配时）能实时推送。
 */
import type { Server as IOServer } from 'socket.io'

import * as redis from '../config/redis.js'
import { setModelOverride, applyAiConfig } from './aiTrafficAdvisor.ts'

export async function startSocketBridge(io: IOServer) {
  try {
    await redis.subscribeMessage('sensor:data', (msg: any) => {
    io.emit('vehicleFlowUpdate', msg);
  });
    await redis.subscribeMessage('sensor:batch_data', (msg: any) => {
    io.emit('vehicleFlowUpdate', msg);
  });
    await redis.subscribeMessage('traffic_light:control', (msg: any) => {
    io.emit('trafficLightUpdate', msg);
  });
    await redis.subscribeMessage('traffic_light:state_changed', (msg: any) => {
    io.emit('trafficLightUpdate', msg);
  });
    await redis.subscribeMessage('traffic_light:emergency', (msg: any) => {
    io.emit('emergencyMode', 'emergency');
  });
    await redis.subscribeMessage('traffic_light:restore_normal', (msg: any) => {
    io.emit('emergencyMode', 'normal');
  });
    await redis.subscribeMessage('traffic_light:emergency_sync', (msg: any) => {
    io.emit('trafficLightUpdate', msg);
  });
    await redis.subscribeMessage('traffic_algorithm:timing_update', (msg: any) => {
    io.emit('trafficTimingUpdate', msg);
  });
    // AI 开关变更广播给所有客户端，让 Dashboard / TrafficControl / Demo 三处同步
    await redis.subscribeMessage('settings:ai_mode_changed', (msg: any) => {
    io.emit('aiModeChanged', msg);
  });
  // 运行时热切换模型：收到广播即刻生效（tick 内也会再读一次 Redis，双重保险）
    await redis.subscribeMessage('settings:ai_model_changed', (msg: any) => {
    try { setModelOverride(msg?.model ? String(msg.model) : null); } catch {}
  });
  // 前端 AI 配置面板写入后热切换 provider/key/model/思考开关（与 ai-config 路由的即时 applyAiConfig 互为兜底）
    await redis.subscribeMessage('settings:ai_config_changed', (msg: any) => {
    try { applyAiConfig(msg ?? null); } catch {}
  });
  } catch {}
}
