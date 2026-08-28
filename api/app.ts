/**
 * Express 应用装配：中间件、路由挂载、统一错误处理
 */
import express, { type Request, type Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

import authRoutes from './routes/auth.js'
import intersectionRoutes from './routes/intersections.js'
import trafficLightRoutes from './routes/trafficLights.js'
import vehicleFlowRoutes from './routes/vehicleFlows.js'
import emergencyVehicleRoutes from './routes/emergencyVehicles.js'
import settingsRoutes from './routes/settings.js'
import trafficAlgorithmRoutes from './routes/trafficAlgorithm.js'
import { aiTrafficAdvisor } from './services/aiTrafficAdvisor.ts'
import { aiRuntime } from './services/aiRuntime.ts'

dotenv.config()

const app = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

/** 路由挂载 */
app.use('/api/auth', authRoutes)
app.use('/api/intersections', intersectionRoutes)
app.use('/api/traffic-lights', trafficLightRoutes)
app.use('/api/vehicle-flows', vehicleFlowRoutes)
app.use('/api/emergency-vehicles', emergencyVehicleRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/traffic-algorithm', trafficAlgorithmRoutes)

/** AI 顾问运行时指标（调用次数/成功率/耗时/熔断/最近建议） */
app.get('/api/ai/metrics', (_req: Request, res: Response) => {
  res.json({
    success: true,
    advisor: aiTrafficAdvisor.getAdvisorMetrics(),
    runtime: { ...aiRuntime },
    ts: Date.now(),
  })
})

/** 健康检查 */
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({ success: true, message: 'ok' })
})

/** 未匹配路由 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'API not found' })
})

/**
 * 统一错误处理：必须保留 4 个形参，Express 才会识别为错误中间件
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error('[API] 未捕获错误:', error)
  res.status(500).json({ success: false, error: 'Server internal error' })
})

export default app
