/*
 * viz.js — Canvas 可视化：trap 类型对比、栈回溯瀑布、事件时间线。
 */
(function (global) {
  'use strict';

  const COLORS = {
    oob: '#e05252', div: '#e08a3c', cvt: '#b06fd6', rec: '#3f8fe0',
    ok: '#3fae6a', bad: '#c0392b', grid: '#2c3242', text: '#cfd6e4', dim: '#7d8699',
  };

  // 老浏览器无 CanvasRenderingContext2D.roundRect 时的降级
  if (typeof CanvasRenderingContext2D !== 'undefined' &&
      !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) {
      this.rect(x, y, w, h);
      return this;
    };
  }

  function setup(canvas) {
    const dpr = global.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.max(1, w * dpr);
    canvas.height = Math.max(1, h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '12px ui-monospace, monospace';
    return { ctx, w, h };
  }
  function badge(ctx, x, y, text, color) {
    ctx.fillStyle = color;
    const w = ctx.measureText(text).width + 12;
    ctx.beginPath();
    ctx.roundRect(x, y, w, 16, 8);
    ctx.fill();
    ctx.fillStyle = '#0d1117';
    ctx.fillText(text, x + 6, y + 12);
    return w;
  }

  // ---------- 1. trap 类型对比 ----------
  function drawComparison(canvas, reportsByType, trapTypes) {
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    const types = Object.keys(trapTypes);
    const rowH = Math.min(64, (h - 30) / types.length);
    const maxFrames = Math.max(4, ...types.map((t) =>
      reportsByType[t] ? Math.min(reportsByType[t].frames.length, 40) : 0));

    ctx.fillStyle = COLORS.dim;
    ctx.fillText('caught', 150, 14);
    ctx.fillText('error name', 210, 14);
    ctx.fillText('stack frames', 360, 14);

    types.forEach((t, i) => {
      const y = 24 + i * rowH;
      const r = reportsByType[t];
      ctx.fillStyle = COLORS[t];
      ctx.fillText(trapTypes[t].label, 8, y + 14);
      if (!r) {
        ctx.fillStyle = COLORS.dim;
        ctx.fillText('— 未运行 —', 150, y + 14);
        return;
      }
      badge(ctx, 150, y + 2, r.caught ? '✓ caught' : '✗ miss', r.caught ? COLORS.ok : COLORS.bad);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(r.errorName || '?', 210, y + 14);
      // 帧数条形（栈溢出帧很多，截断显示）
      const frames = r.frames.length;
      const bw = Math.min(frames, 40) / maxFrames * (w - 480);
      ctx.fillStyle = COLORS[t] + 'aa';
      ctx.fillRect(360, y + 4, Math.max(2, bw), 12);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(frames >= 40 ? frames + '+' : String(frames), 365 + Math.max(2, bw), y + 14);
      // 第二行：消息 + 映射状态
      ctx.fillStyle = COLORS.dim;
      const mapped = r.sourceMapped ? 'srcmap ✓' : 'srcmap ✗';
      const sim = r.simulated ? ' [JS 模拟]' : '';
      ctx.fillText(`${r.message || ''} · ${mapped}${sim}`, 150, y + 30);
    });
  }

  // ---------- 2. 栈回溯瀑布 ----------
  function drawStackWaterfall(canvas, report) {
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!report) {
      ctx.fillStyle = COLORS.dim;
      ctx.fillText('运行一个 trap 以查看栈回溯', 10, 20);
      return;
    }
    if (!report.frames.length) {
      ctx.fillStyle = COLORS.bad;
      ctx.fillText('⚠ 无可用栈回溯（引擎未提供或被禁用）— 降级为仅错误名/消息', 10, 20);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(`${report.errorName}: ${report.message}`, 10, 40);
      return;
    }
    const frames = report.frames.slice(0, 12);
    const boxH = Math.min(34, (h - 20) / frames.length - 6);
    frames.forEach((f, i) => {
      const y = 10 + i * (boxH + 6);
      const x = 10 + i * 18;
      const bw = Math.min(w - x - 10, 560);
      ctx.fillStyle = '#1b2233';
      ctx.strokeStyle = COLORS[report.type] || COLORS.text;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, boxH, 4);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = COLORS.text;
      const src = f.source ? ` → ${f.source.file}:${f.source.line}` : '';
      ctx.fillText(`#${i} func[${f.funcIndex}] ${f.funcName || '?'} @ ${f.offsetHex}${src}`, x + 8, y + boxH / 2 + 4);
      if (i < frames.length - 1) {
        ctx.strokeStyle = COLORS.dim;
        ctx.beginPath();
        ctx.moveTo(x + 14, y + boxH);
        ctx.lineTo(x + 32, y + boxH + 6);
        ctx.stroke();
      }
    });
    if (report.frames.length > frames.length) {
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(`… 共 ${report.frames.length} 帧（截断显示）`, 10, h - 8);
    }
  }

  // ---------- 3. 事件时间线 ----------
  function drawTimeline(canvas, reports) {
    const { ctx, w, h } = setup(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!reports.length) {
      ctx.fillStyle = COLORS.dim;
      ctx.fillText('暂无历史（IndexedDB 为空）', 10, 20);
      return;
    }
    const t0 = reports[0].timestamp;
    const t1 = Math.max(reports[reports.length - 1].timestamp, t0 + 1);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath(); ctx.moveTo(10, h / 2); ctx.lineTo(w - 10, h / 2); ctx.stroke();
    reports.slice(-60).forEach((r) => {
      const x = 10 + (r.timestamp - t0) / (t1 - t0) * (w - 20);
      ctx.fillStyle = COLORS[r.type] || COLORS.text;
      ctx.beginPath();
      ctx.arc(x, h / 2, 5, 0, Math.PI * 2);
      ctx.fill();
      if (r.simulated) {
        ctx.strokeStyle = '#fff';
        ctx.beginPath(); ctx.arc(x, h / 2, 8, 0, Math.PI * 2); ctx.stroke();
      }
    });
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(`${reports.length} 条记录 · ${new Date(t0).toLocaleTimeString()} → ${new Date(t1).toLocaleTimeString()}`, 10, h - 8);
  }

  global.TrapViz = { drawComparison, drawStackWaterfall, drawTimeline };
})(typeof self !== 'undefined' ? self : globalThis);
