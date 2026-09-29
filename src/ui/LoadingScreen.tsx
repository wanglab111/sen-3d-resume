import { useEffect, useRef, useState } from 'react'
import { useProgress } from '@react-three/drei'

// 全屏加载遮罩：读取 three LoadingManager 进度（useProgress），
// 模型/贴图全部加载完 **且 3D 场景渲染过首帧**（ready）之后才淡出并卸载。
// 纯动态 UI：随真实进度填充的旋转圆环，无文字。
// 用 CSS 过渡 + setTimeout 控制淡出/卸载（不依赖 rAF，后台/离屏也可靠）。

/* ⚠️ 为什么要多等一个 `ready`（2026-09-19）
   ------------------------------------------------------------------
   用户报告「网页一到网页二卡卡的」，实测那一下是**一个 4142ms 的长任务**：
   3D 的 GL program 编译 + 贴图上传全砸在首帧上，而首帧原先恰好发生在
   用户滚到交接段的那一刻（详见 App.tsx 的 Warmup）。
   现在把首帧提前到遮罩底下执行 —— 于是遮罩也必须等到它做完才散，
   否则用户会在"页面看起来已经能看了"的状态下撞上这几秒冻结，反而更像卡死。
   ⚠️ 圆环是 CSS transform 动画（合成器线程），主线程被编译冻住时它照样转 —— 这是
      "让它等"的前提，别把它改成 JS 驱动的动画。 */
export default function LoadingScreen({ ready = false }: { ready?: boolean }) {
  const { progress } = useProgress()
  // reached：进度到过 100% **且** 首帧渲染完（单向 false→true，避免分批加载的抖动）
  const [reached, setReached] = useState(false)
  const [hiding, setHiding] = useState(false) // 开始淡出
  const [removed, setRemoved] = useState(false) // 彻底卸载
  // 记录最高进度，防止分批注册资源时圆环回缩
  const peak = useRef(0)
  peak.current = Math.max(peak.current, Math.min(Math.max(progress, 0), 100))

  useEffect(() => {
    if (progress >= 100 && ready) setReached(true)
  }, [progress, ready])

  /* 兜底：资源到齐后预热最多再等 6 秒。
     ⚠️ 必须有 —— 万一 WebGL 不可用 / glb 挂了 / compile 抛异常导致 warm 永远不来，
        没有这条兜底用户会被永久关在黑屏遮罩里（比卡顿严重得多）。 */
  useEffect(() => {
    if (progress < 100) return
    const t = setTimeout(() => setReached(true), 6000)
    return () => clearTimeout(t)
  }, [progress])

  // 到过 100% 后：停留片刻 → 淡出 → 卸载（一次性，锁定不受后续进度变化影响）
  useEffect(() => {
    if (!reached) return
    const t1 = setTimeout(() => setHiding(true), 400)
    const t2 = setTimeout(() => setRemoved(true), 1100)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [reached])

  if (removed) return null

  const R = 34
  const C = 2 * Math.PI * R
  const offset = C * (1 - peak.current / 100)

  return (
    <div className={`loading-screen${hiding ? ' is-hidden' : ''}`} aria-hidden="true">
      <div className="loading-ring">
        <svg viewBox="0 0 80 80">
          <circle className="lr-track" cx="40" cy="40" r={R} />
          <circle
            className="lr-arc"
            cx="40"
            cy="40"
            r={R}
            style={{ strokeDasharray: C, strokeDashoffset: offset }}
          />
        </svg>
      </div>
    </div>
  )
}
