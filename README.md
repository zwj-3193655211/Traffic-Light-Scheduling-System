# 智能交通信号调度系统

Traffic-Light-Scheduling-System —— 面向路口信号控制的演示型全栈项目，覆盖
**路口监控 · 自适应配时 · AI 动态红绿灯 · 紧急车辆优先** 四条主线。

技术栈：React 18 + TypeScript + Vite + TailwindCSS / Express + Socket.IO / MySQL / Redis。

---

## 快速开始

```bash
git clone https://github.com/zwj-3193655211/Traffic-Light-Scheduling-System.git
cd Traffic-Light-Scheduling-System
npm install
cp .env.example .env     # 按需修改，尤其 AI 相关配置
npm run dev              # 前后端同时启动
```

- 前端：<http://localhost:5173>
- 后端：<http://localhost:3001>
- 首次启动会自动建库建表（`api/config/database.js` 的 `initializeDatabase`）

### 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 18 | 后端用 `tsx` 直接运行 TypeScript |
| MySQL | ≥ 8 | 需具备建库建表权限 |
| Redis | ≥ 5 | 可选；缺失时后端降级启动，仅 AI 开关缓存失效 |

---

## AI 动态红绿灯：云端 / 本地双模式

AI 层统一走 **OpenAI 兼容的 Chat Completions 协议**，因此云端 API 与本地
`llama.cpp` 可以共用同一套调用代码，仅通过环境变量切换。

| 模式 | `AI_PROVIDER` | 是否需要密钥 | 特点 |
| --- | --- | --- | --- |
| DeepSeek | `deepseek` | 需要 | 云端，延迟低（约 1~2s），无需本地算力 |
| 智谱 GLM | `zhipu` | 需要 | 云端备选 |
| llama.cpp | `llamacpp` | 不需要 | 本地离线，免密钥；建议 GPU 卸载，推理约 1~3s |

### 配置示例

```bash
# 云端模式（默认）
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_MODEL=deepseek-chat

# 本地模式：先启动 llama-server（GPU 卸载，-ngl 为卸载到显存的层数）
#   llama-server.exe -m "D:\llama.cpp\models\Qwen3.5-2B-Q8_0.gguf" \
#       -c 4096 -ngl 99 --jinja --reasoning-budget 0 \
#       --host 127.0.0.1 --port 8080
AI_PROVIDER=llamacpp
LLAMACPP_BASE_URL=http://127.0.0.1:8080/v1
LLAMACPP_MODEL=local-gguf
```

> `llama-server` 原生暴露 `/v1/chat/completions`，与云端接口同构，
> 所以本地模式不需要额外的适配层。

**`-m` 必须指向 `.gguf` 文件本身，不是目录。** 若启动后 Web UI 显示
`No models available`，就是没指到模型文件。

**推理速度取决于 `-ngl`**：层数全部卸载到 GPU 时通常 1~3 秒出结果。
若只跑 CPU（`-ngl 0`）会慢一个数量级，此时建议调大 `AI_TIMEOUT_MS`。

### 关闭本地模型的思考模式

Qwen3 系模型默认输出思考过程，会拖慢响应并降低 JSON 依从性——而本场景只需要一个 JSON。
本项目默认在**请求层**关闭：向 llama.cpp 透传 `chat_template_kwargs: { enable_thinking: false }`。

服务端侧也可全局关闭（任选其一，效果相同）：

```bash
--reasoning-budget 0                                  # llama.cpp 推荐方式
--jinja --chat-template-kwargs '{"enable_thinking":false}'   # 走 chat template
```

> 注意：请求层的 `enable_thinking` 需要 llama-server 以 `--jinja` 启动才生效；
> 不支持该参数的模型会忽略它，不会报错。

若确实想保留思考模式，在 `.env` 设 `LLAMACPP_ENABLE_THINKING=1`。

即使思考标签漏了出来也没关系——后端会剥离 `think` / `thinking` / `thought` /
`reasoning` / `analyze` 等各类标签，并兜底提取 JSON。

### 双模式互为备份

```bash
# 本地优先，云端兜底
AI_PROVIDER=llamacpp
AI_FALLBACK_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-xxx
```

主 provider 超时、熔断或本地服务未启动时，自动切换到备用 provider；
两者都不可用时退回规则配时（`api/services/ruleBasedTiming.ts`），
**红绿灯调度在任何情况下都不会中断**。

注意：模型名按 provider 独立解析 —— 本地 `local-gguf` 与云端 `deepseek-chat`
不会互相串用，避免回退时把本地模型名发给云端导致 `model not found`。

### 其他 AI 参数

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AI_ADVICE_INTERVAL_MS` | 10000 | 建议刷新间隔 |
| `AI_TIMEOUT_MS` | 云端 12000 / 本地 30000 | 单次请求超时（毫秒） |
| `MAX_GREEN_SECONDS` | 120 | 绿灯上限 |
| `MIN_YELLOW_SECONDS` / `MAX_YELLOW_SECONDS` | 3 / 5 | 黄灯上下限 |
| `CYCLE_MAX_SECONDS` | 120 | 整周期上限 |

> **本地模式超时的取值权衡**：本地默认 30s 是为了给「模型还没加载进显存的第一个
> 请求」留余量，GPU 卸载下的实际推理只有 1~3 秒。不建议再调大——超时越长，
> `llama-server` 挂掉后等待主 provider 超时、再切到备用 provider 的空窗期越久。
> 服务常驻预热后，设 `AI_TIMEOUT_MS=15000` 可以显著加快故障切换。

### 运行机制

启用后后端按 `AI_ADVICE_INTERVAL_MS` 周期执行：

1. 汇总近窗口车流作为上下文（按方向与直行/左转拆分）
2. 请求 AI 返回 `{ green, reason }` 严格 JSON
3. 按约束夹紧（绿/黄上下限、周期总长）
4. 写入数据库：更新默认配时，并立即重置当前相位 `remaining_time`
5. 通过 Socket.IO 广播 `trafficTimingUpdate` 与 `trafficLightUpdate`

配套的可靠性设计：**熔断器**（连续失败 5 次进入 OPEN，60s 后 HALF_OPEN 探活）、
**指数退避重试**（仅 429/5xx/网络超时，最多 2 次）、**指标埋点**
（`GET /api/ai/metrics` 返回调用量/成功率/耗时/熔断次数/当前 provider）。

---

## 目录结构

```
api/
  app.ts                    Express 装配：中间件、路由、统一错误处理
  server.ts                 本地服务入口（仅做装配，约 90 行）
  config/
    database.js             MySQL 连接池 + 自动建库建表 + schema 兜底
    redis.js                Redis 客户端 + Pub/Sub + 缓存封装
  routes/                   REST 路由（intersections / traffic-lights /
                            vehicle-flows / emergency-vehicles / settings /
                            traffic-algorithm / auth）
  services/
    trafficScheduler.ts     相位推进调度器（每秒 tick）
    aiAdvisorLoop.ts        AI 配时轮询循环
    aiTrafficAdvisor.ts     Provider 注册表、提示词、JSON 解析、约束夹紧、熔断
    ruleBasedTiming.ts      规则配时（AI 不可用时的降级路径）
    virtualFlowGenerator.ts 虚拟车流生成
    socketBridge.ts         Redis Pub/Sub → Socket.IO 桥接

src/
  types/index.ts            全站共享类型
  lib/api.ts                统一 API 客户端
  lib/socket.ts             Socket.IO 单例
  hooks/useAiMode.ts        AI 开关（拉取/提交/跨页面同步）
  pages/                    仪表盘、路口、交通控制、紧急管理、设置、功能演示
  components/               Header、Sidebar、IntersectionMonitor、FlowDots
  sim/core.ts               本地仿真内核（相位、队列、出入流）
  stores/                   趋势与演示引擎
  workers/                  倒计时与定时器 Worker（减少主线程抖动）
```

---

## 常用脚本

```bash
npm run dev        # 前后端同时启动
npm run build      # 前端生产构建
npm run check      # TypeScript 类型检查
npm run lint       # ESLint
npm run db:init    # 手动初始化数据库
npm run ai:smoke   # AI 对话连通性测试
npm run ai:advice  # AI 严格 JSON 建议测试
npm run ai:test    # 约束夹紧测试（不依赖模型）
```

## Socket.IO 事件

| 事件 | 用途 |
| --- | --- |
| `trafficLightUpdate` | 推送某路口完整红绿灯数组 |
| `light_status_update` | 每秒推送单灯状态与剩余秒数 |
| `vehicleFlowUpdate` | 推送车流数据 |
| `emergencyMode` | 紧急 / 正常状态切换 |
| `trafficTimingUpdate` | 配时更新来源与建议（AI 或 fallback） |
| `aiModeChanged` | AI 开关变更，用于三处页面状态同步 |

## 常见问题

- **端口占用 `EADDRINUSE :::3001`**：已有进程占用，或修改 `.env` 的 `PORT` 后重启。
  后端内置了占用重试，重复启动不会直接崩掉。
- **前端读不到环境变量**：Vite 仅识别 `VITE_` 前缀，修改 `.env` 后需重启前端。
- **本地 llama.cpp 连不上**：确认 `llama-server` 已启动且端口与 `LLAMACPP_BASE_URL`
  一致；AI 不可用时系统会自动降级到规则配时或备用 provider。

## 注意事项

- `.env` 已加入 `.gitignore`，**请勿提交真实密钥**；可共享的配置写在 `.env.example`。
- 开发时只保留一个后端入口（`npm run server:dev` 的 `api/server.ts`），
  避免重复启动导致端口冲突。
