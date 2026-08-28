// P2.5.2 AI 健康面板：服务端运行时指标快照
// 由 server.ts 的 AI 循环写入（门控跳过/缓存命中/轮询计数/最近建议），
// 由 /api/ai/metrics 路由读取。抽成独立单例，避免循环闭包内的状态无法被路由访问。

export type AiRuntimeSnapshot = {
  gateSkips: number
  cacheHits: number
  tickCount: number
  lastAdvice: { intersectionId?: number | string; green: number; reason?: string } | null
  lastAdviceTs: number
}

export const aiRuntime: AiRuntimeSnapshot = {
  gateSkips: 0,
  cacheHits: 0,
  tickCount: 0,
  lastAdvice: null,
  lastAdviceTs: 0,
}
