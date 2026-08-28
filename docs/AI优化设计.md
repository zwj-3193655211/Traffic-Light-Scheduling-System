# AI 动态红绿灯 —— 优化设计

> 适用范围：`api/services/aiTrafficAdvisor.ts` + `api/server.ts` 中的 AI 建议循环。
> 前置变更：本项目已**弃用 Ollama（本地推理）**，AI 统一改为 **DeepSeek（OpenAI 兼容协议）** 调用，详见 `README.md` 与 `.env`。
> 本文在“已切换到云端模型”的前提下，给出进一步降本、提速、增强稳定性的优化方案。

---

## 0. 迁移小结（已完成）

| 项 | 旧 | 新 |
| --- | --- | --- |
| Provider | Ollama 本地 `/api/chat` | DeepSeek 云端 `/chat/completions`（OpenAI 兼容） |
| 配置 | `AI_PROVIDER=ollama` + `OLLAMA_MODEL` | `AI_PROVIDER=deepseek` + `DEEPSEEK_API_KEY` + `DEEPSEEK_MODEL` |
| 鉴权 | 无 | `Authorization: Bearer <DEEPSEEK_API_KEY>` |
| 解析 | Ollama `data.message.content` | OpenAI `data.choices[0].message.content` |
| 备选 | — | 智谱 GLM（`AI_PROVIDER=zhipu`）同为 OpenAI 兼容，复用同一套适配代码 |

切换**仅改配置、不动业务契约**：`getAdvice(ctx, constraints, abortSignal)` 签名与 `green`/`-1`/夹紧语义保持不变，`server.ts` 无需修改即可生效。

---

## 1. 优化方向总览

```
                  ┌─────────────┐
   车流/信号状态 ─▶│ 增量门控    │─(Δ 足够大?)─▶┐
                  └─────────────┘              │
                                              ▼
                  ┌─────────────┐      ┌──────────────┐
   Redis 缓存命中 ─▶│ 响应缓存    │─(命中?)─▶ 复用上次建议
                  └─────────────┘              │(未命中)
                                              ▼
                                         ┌──────────────┐
                                         │ AI 批处理调用 │ (多路口/多相位一次请求)
                                         └──────┬───────┘
                                                │
                              ┌─────────────────┼─────────────────┐
                              ▼                                   ▼
                       ┌─────────────┐                    ┌─────────────┐
                       │ 熔断器/重试 │                    │ 约束夹紧    │ (原有)
                       └──────┬──────┘                    └─────────────┘
                              │
                              ▼
                       ┌─────────────┐
                       │ 指标埋点    │ (耗时/成功率/成本)
                       └─────────────┘
```

---

## 2. 调用成本与延迟（最优先）

### 2.1 增量门控（skip-if-unchanged）
现状：AI 循环每 `AI_ADVICE_INTERVAL_MS`（10s）固定调用一次，即使车流毫无变化。
优化：在调用前比较当前 `formattedStats` 与上次请求的快照，若各方向车流变化量都小于阈值（如 ±2 辆）且信号相位未变，**直接复用上次建议、跳过本次 AI 调用**。
- 实现点：`server.ts` 的 `tick()` 内、`getAdvice` 之前增加 `statsDeltaGate()`。
- 收益：稳态路口 AI 调用量可下降 60%~90%，直接降低 token 成本与延迟。

### 2.2 响应缓存（Redis）
- Key：`ai:advice:{intersectionId}`，Value：`{ green, reason, ts }`，TTL 取 `AI_ADVICE_INTERVAL_MS * 2`。
- 同一窗口内多客户端/多相位请求直接命中缓存。
- 与 2.1 门控配合：门控判断“是否需要新决策”，缓存负责“重复决策去重”。

### 2.3 多路口批量
现状：`server.ts` 串行 `for (const row of ids)`，实际只处理 `selectedIntersectionId` 一个路口。
优化（多路口场景）：
- 将多个需要决策的路口合并为**一次**模型请求（在 prompt 中以数组给出各路口数据，要求模型返回 `[{intersectionId, green, reason}]`）。
- 请求改为 `Promise.all` 并发，避免串行阻塞相位机主循环。
- 收益：N 个路口的 API 调用从 N 次降为 1 次，端到端延迟取决于最慢单路口而非累加。

### 2.4 Prompt 与采样
- `temperature: 0.2`（已在 advisor 中设置）：配时无需创造性，低温度保证稳定。
- 精简 user prompt：去掉与决策无关的字段；对“当前绿灯剩余 X 秒”等已在 server 端处理的信息可弱化。
- 明确输出仅 `{"green":int,"reason":str}`，避免模型输出冗余解释浪费 token。

---

## 3. 稳定性与降级

### 3.1 熔断器（Circuit Breaker）
现状：AI 异常时回退 `baseRuleGreen`（已有），但每次 tick 仍会发起失败请求。
优化：维护一个失败计数，`连续失败 ≥ 5 次` 进入 **OPEN** 状态，在 `cooldown`（如 60s）内不再调用 AI、直接走规则模式；冷却后进入 **HALF_OPEN** 试探一次，成功则恢复。
- 实现点：在 `aiTrafficAdvisor` 内维护模块级状态，或抽到 `lib/circuitBreaker.ts` 复用。
- 收益：云端抖动/限流时避免雪崩与无谓重试。

### 3.2 超时与退避重试
- 现有 `AI_TIMEOUT_MS` 超时已具备。
- 仅对 `5xx / 网络超时 / 限流(429)` 做 **指数退避**（最多 2 次），对 `4xx`（鉴权/参数错误）直接失败走降级，不做无效重试。

---

## 4. 可解释性与审计（落地 README 已承诺但未实现的 reason）

现状：代码只解析 `green`，`reason` 仅打印到日志，前端与广播均未体现。
优化（小改动、高价值，呼应项目“约束可解释”卖点）：
1. `aiTrafficAdvisor.getAdvice` 已解析 `reason`，扩展返回 `{ green, reason }`。
2. `server.ts` 在 `io.emit('trafficTimingUpdate', { intersectionId, source:'ai', advice:{ green, reason } })` 中带上 `reason`。
3. 前端 `Dashboard / TrafficControl / Demo` 在 AI 建议卡片下展示 `reason` 一行小字。
- 收益：每一次 AI 决策都可被审计、可向用户解释“为什么给了这个绿灯时长”。

---

## 5. 配置与可观测

### 5.1 运行时热切换模型
- 新增 `POST /api/settings/ai-model`，写入 Redis `system:ai_model`，`aiTrafficAdvisor` 每次请求读取，实现**不重启切换模型**（deepseek-v4-flash ↔ 其他）。
- 与现有 `ai-mode` 开关同一套 Redis 广播机制。

### 5.2 指标埋点
- 每次调用记录：耗时（已有 `elapsed`）、是否命中缓存、是否走熔断、成功/失败、估计 token 成本。
- 轻量方案：结构化日志 + 可选 Prometheus `/metrics`；至少把“AI 建议成功率 / 平均耗时 / 成本”在 Dashboard 健康面板展示。

---

## 6. 架构层面

- **AI 调用异步化**：将 AI 决策从相位机 `tick()` 主循环抽离为独立 Worker/队列，主循环只负责读缓存结果并应用，避免慢 API 拖慢秒级倒计时。
- **本地相位机不变**：倒计时仍由 `remaining_time` 本地驱动，AI 仅在周期边界更新建议值（现有设计已正确，保持）。

---

## 7. 落地优先级（建议顺序）

| 优先级 | 项 | 成本 | 收益 | 状态（2026-08-05 已落地） |
| --- | --- | --- | --- | --- |
| P0 | 2.1 增量门控 + 2.2 Redis 缓存 | 低 | 降本 60%~90% | ✅ 已落地：`server.ts` 增量门控（车流变化 ≤ `AI_GATE_DELTA` 默认 2 且相位不变则跳过）+ Redis 缓存 `ai:advice:{id}`（TTL=间隔×2） |
| P0 | 3.1 熔断器 | 低 | 抗云端抖动，防雪崩 | ✅ 已落地：`aiTrafficAdvisor` 模块级熔断器，连续失败 ≥ 5 → OPEN 60s 内不走网络、直接规则降级；冷却后 HALF_OPEN 探活 |
| P1 | 4. reason 可解释（前后端各一处） | 低 | 实现"可解释"卖点 | ✅ 已落地：`getAdvice` 返回 `{ green, reason }`，`trafficTimingUpdate` 广播带 reason，Demo/Dashboard/TrafficControl 三页展示"依据" |
| P1 | 5.1 运行时切模型 | 中 | 运维友好 | ✅ 已落地：`POST /api/settings/ai-model` 写 Redis `system:ai_model` + 发布广播；`server` 每 tick 读取并 `setModelOverride`，不重启切换 |
| P2 | 2.3 多路口批量 + 并发 | 中 | 多路口场景提速 | ⬜ 未做（当前仅启用单选中路口，批量收益有限，按需再做） |
| P2 | 5.2 指标埋点 + 健康面板 | 中 | 可观测、便于调参 | ✅ 已落地：`getAdvisorMetrics()`（调用/成功/失败/熔断跳过/平均耗时）+ `server` 每 30 tick 打印汇总日志；新增 `aiRuntime` 单例与 `GET /api/ai/metrics` 端点输出 advisor 指标 + 运行时门控跳过/缓存命中/最近建议；Dashboard「AI 调度健康面板」每 3s 轮询，展示成功率/平均耗时/熔断跳过/门控跳过/缓存命中 + 健康状态徽标 + 最近建议(含 reason) + 平均耗时趋势图。Prometheus `/metrics` 仍为可选增强项 |
| P3 | 6. AI 异步队列化 | 高 | 主循环解耦 | ✅ 已落地：`server.ts` 中 AI 调用改为 detached Promise（不 `await`），循环只做门控/缓存/状态读取即返回；结果到达后由 `applyAiAdvice()` 异步落地 DB + 广播。新增 `aiInFlight` 飞行中守卫，防止慢模型下同一路口调用堆叠 |

---

## 8. 关键改动文件索引

- `api/services/aiTrafficAdvisor.ts`：provider 注册表、OpenAI 兼容请求/解析、系统提示词、reason 解析。
- `api/server.ts`：`tick()` 内门控/缓存/熔断接入点；`trafficTimingUpdate` 广播增加 reason。
- `scripts/ai-chat-smoke.ts`：连通性冒烟（支持 deepseek/zhipu）。
- `.env`：`AI_PROVIDER` / `DEEPSEEK_*` / `GLM_*` / `AI_TIMEOUT_MS`。
- `README.md`：AI 接入说明同步更新。
