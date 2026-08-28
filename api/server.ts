/**
 * 本地开发/自部署服务入口
 *
 * 职责只做装配：初始化依赖 -> 建 HTTP + Socket.IO -> 桥接 Redis 事件 -> 启动后台循环。
 * 具体的相位推进与 AI 配时逻辑分别在 services/trafficScheduler.ts 与 services/aiAdvisorLoop.ts。
 */
import http from 'http'
import { Server as IOServer } from 'socket.io'

import app from './app.js'
import * as db from './config/database.js'
import * as redis from './config/redis.js'
import { startAiAdvisorLoop } from './services/aiAdvisorLoop.ts'
import { startSocketBridge } from './services/socketBridge.ts'
import { startTrafficLightScheduler } from './services/trafficScheduler.ts'
import { startVirtualFlowGenerator } from './services/virtualFlowGenerator.ts'

const PORT = Number(process.env.PORT) || 3001

async function bootstrap() {
  try {
    await redis.initializeRedis()
  } catch {
    console.warn('[启动] Redis 初始化失败，继续启动（将退回无缓存模式）')
  }

  try {
    await db.initializeDatabase()
  } catch {
    console.warn('[启动] 数据库初始化失败，请确认 MySQL 配置与权限')
  }
}

await bootstrap()

const httpServer = http.createServer(app)
const io = new IOServer(httpServer, { cors: { origin: '*' } })

io.on('connection', (socket) => {
  socket.emit('connected', { ts: Date.now() })
})

await startSocketBridge(io)

let loopsStarted = false
const startLoopsOnce = () => {
  if (loopsStarted) return
  loopsStarted = true
  startTrafficLightScheduler(io)
  startAiAdvisorLoop(io)
  startVirtualFlowGenerator()
}

httpServer.on('listening', () => {
  console.log(`[启动] 服务就绪，监听端口 ${PORT}`)
  startLoopsOnce()
})

const startListening = () => {
  try {
    if (!httpServer.listening) httpServer.listen(PORT)
  } catch {
    /* 由 error 事件兜底重试 */
  }
}

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  // 端口被占用时等待后重试，避免开发期重复启动直接崩掉
  if (err?.code === 'EADDRINUSE') {
    setTimeout(() => {
      try {
        httpServer.close(() => startListening())
      } catch {
        startListening()
      }
    }, 500)
    return
  }
  console.error('[启动] 服务异常:', err)
  process.exit(1)
})

startListening()

/** 优雅退出 */
function shutdown(signal: string) {
  console.log(`[退出] 收到 ${signal} 信号`)
  httpServer.close(() => {
    console.log('[退出] 服务已关闭')
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.once('SIGUSR2', () => {
  httpServer.close(() => process.kill(process.pid, 'SIGUSR2'))
})
