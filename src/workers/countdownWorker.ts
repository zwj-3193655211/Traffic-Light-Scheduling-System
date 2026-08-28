// 红绿灯倒计时 Worker：仅负责本地每秒读秒，让前端 UI 平滑显示剩余秒数。
//
// 重要：红/黄/绿之间的状态切换由服务端权威决定（因为四个方向之间存在
// 相位冲突约束，不能在客户端各自独立切换，否则会出现"全绿灯/冲突相位"等
// 错误状态）。客户端 worker 的职责只有两件事：
//   1. 接收服务端通过 INIT/UPDATE_LIGHT 推送的最新状态作为基准；
//   2. 每秒把每个灯的 remaining_time 减 1（不为负），等服务端下一次推送切换。
//
// 状态约定：0=红, 1=黄, 2=绿

type Light = {
  id: number;
  current_status: 0 | 1 | 2;
  remaining_time: number;
  [key: string]: any;
};

let timer: ReturnType<typeof setInterval> | null = null;
let lights: Light[] = [];

function tickOnce(): void {
  lights = lights.map((l) => {
    const remaining = Number(l.remaining_time ?? 0);
    // 仅减秒数，不在 worker 内自行切换相位；
    // remaining_time 到 0 后停在 0，等待服务端 socket 推送新的状态。
    const next = remaining > 0 ? remaining - 1 : 0;
    if (next === remaining) return l;
    return { ...l, remaining_time: next };
  });
  (self as any).postMessage({ lights });
}

// 智能合并服务端推送：
// - 如果灯的 status 变化（红/黄/绿切换），完整覆盖（这是权威切换信号）
// - 如果只是 remaining_time 变化但与本地差 ≤ 1，保留本地 worker 的递减节奏
//   （避免服务端 1Hz 推送 + worker 1Hz tick 双源覆盖造成的秒数跳变）
// - 如果差距 > 1，说明服务端发生了截断/延长等非自然变化，按服务端值对齐
function mergeServerLight(local: Light, server: Light): Light {
  if (local.current_status !== server.current_status) {
    return { ...local, ...server };
  }
  const localRem = Number(local.remaining_time ?? 0);
  const serverRem = Number(server.remaining_time ?? 0);
  if (Math.abs(localRem - serverRem) > 1) {
    return { ...local, ...server };
  }
  // 节奏一致时，只更新非时序字段，保留本地 remaining_time
  return { ...local, ...server, remaining_time: localRem, current_status: local.current_status };
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'INIT') {
    const incoming: Light[] = Array.isArray(msg.lights) ? msg.lights.map((l: Light) => ({ ...l })) : [];
    if (lights.length === 0) {
      // 首次 INIT，直接采用
      lights = incoming;
    } else {
      // 合并：保留本地 tick 节奏，只在 status 变化或剧烈偏差时强制对齐
      const byId = new Map<number, Light>();
      for (const l of lights) byId.set(l.id, l);
      lights = incoming.map((srv) => {
        const local = byId.get(srv.id);
        if (!local) return srv;
        return mergeServerLight(local, srv);
      });
    }
    (self as any).postMessage({ lights });
  } else if (msg.type === 'UPDATE_LIGHT') {
    const { id, remaining_time, current_status } = msg.light || {};
    lights = lights.map((l) => {
      if (l.id !== id) return l;
      const incoming: Light = {
        ...l,
        remaining_time: Number(remaining_time ?? l.remaining_time ?? 0),
        current_status: (current_status ?? l.current_status) as 0 | 1 | 2,
      };
      return mergeServerLight(l, incoming);
    });
    (self as any).postMessage({ lights });
  } else if (msg.type === 'TICK_START') {
    if (timer) return;
    timer = setInterval(tickOnce, 1000);
  } else if (msg.type === 'STOP') {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
};
