# WASM Trap 实验室

围绕 WebAssembly trap 的交互式实验台：在 wasm 中触发越界、除零、除法溢出、
非法转换、栈溢出，在 Worker 中捕获并归一化，展示栈回溯 / 函数索引 / 偏移量 /
源码映射，对比各类 trap 行为，并覆盖各种降级路径。

## 运行

```bash
python3 -m http.server 8000   # 或任意静态服务器
# 打开 http://localhost:8000
```

> 必须通过 HTTP 访问（ES module + Worker 不支持 file://）。

## 验证

```bash
node test/node-check.mjs   # 无浏览器端到端验证（Node 的 V8 与 Chrome 同源）
```

## 结构

- `js/wasm-module.js` — 手工编码的 WASM 模块构建器（含 name section 与偏移→WAT 源码映射）
- `js/trap-core.js` — trap 定义、栈解析、分类、归一化、JS 模拟降级、特性探测
- `js/worker.js` — 在 Worker 中实例化 wasm、触发 trap、回传纯数据报告
- `js/db.js` — IndexedDB 报告持久化
- `js/viz.js` — Canvas 可视化（内存 / 调用栈 / 类型对比 / 历史时间线）
- `js/main.js` — 主线程编排（UI 不阻塞，心跳指示活性）

## 覆盖的边界情况

- 浏览器不支持异常处理提案：特性探测展示（本 demo 不依赖该提案，trap 走传统 JS 异常）
- 栈回溯缺失（如 JavaScriptCore）：降级为仅展示错误名/消息
- 源码映射缺失：勾选「模拟源码映射缺失」，降级为原始偏移
- trap 不可恢复：报告中标注 resumable=false，wasm 在 trap 点中止展开到 JS
- 跨 Worker 传播：Error 不直接 postMessage（栈会丢失），在 Worker 内解析后传纯数据
- JS 模拟 trap：勾选「JS 模拟 trap」，无 wasm 环境下走纯 JS 降级管线
- trap 后实例状态：每次 trap 后校验内存哨兵与导出可调用性，支持一键重新实例化
