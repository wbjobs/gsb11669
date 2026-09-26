# Wasm Trap Lab

在 wasm 中触发四类 trap（越界 / 除零 / 非法转换 / 栈溢出），捕获后展示
栈回溯、函数索引、指令偏移与源码映射，并对比各 trap 类型行为。

## 运行

浏览器需通过 http 访问（`file://` 下 Worker 会被拦截）：

```sh
python3 -m http.server 8000
# 打开 http://localhost:8000
```

Node 侧核心逻辑测试（无需浏览器）：

```sh
node test/core-test.mjs   # 41 项断言
node test/probe.mjs       # 查看原始栈格式与偏移
```

## 覆盖点

- **四类 trap**：`i32.load` 越界、`i32.div_s` 除零、`i32.trunc_f64_s` NaN 截断、无限递归栈溢出。
- **栈回溯**：解析 `wasm-function[i]:0xoff`，经 name section 还原函数名；
  合成 source-map v3 把文件偏移映射到虚拟 WAT 行号。
- **降级**：不支持异常处理提案 / 无栈回溯 / 无源码映射时均有降级展示；
  可切换纯 JS 模拟 trap（同名错误类型 + 相同可观察行为）。
- **不可恢复与实例状态**：trap 在断点中止、无法续跑；trap 前的内存写入保留，
  实例本身未损坏、可继续调用（`write_then_trap` + `read_mem0` 验证）。
- **跨 Worker 传播**：trap 报告 主线程 ↔ worker-a ↔ worker-b 逐跳重抛/捕获，
  并可探测 Error 的结构化克隆能力。
- **持久化与可视化**：报告存入 IndexedDB；Canvas 绘制类型对比、
  栈回溯瀑布、事件时间线；rAF FPS 计证明主线程不被阻塞。

## 文件

- `js/wasm-gen.js` — 手工汇编 wasm 二进制 + 合成 WAT 源码与 source map
- `js/trap-core.js` — trap 触发/捕获/栈解析/源码映射/JS 降级
- `js/worker.js` — Worker 执行与传播协议
- `js/db.js` — IndexedDB 封装
- `js/viz.js` — Canvas 可视化
- `js/main.js` — UI 装配
