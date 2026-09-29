// 镜头导演 —— 每一站的机位。
//
// 原版这个网站的运镜，是烘进 glb 的 `CameraAction` 动画；你的模型是「图片→3D」生成的
// 静态网格，没有相机也没有动画。所以这里把运镜路径改成**代码定义**：
// 每一站描述「看向人物身上的哪个点 + 相机站在哪个方位、多远、多大视场角」，
// Scene.tsx 按滚动进度在相邻两站之间插值，得到与原版一致的「滚动即运镜」。
//
// 索引约定（与 data/focusPoints.ts 的帧约定严格对应）：
//   第 0 项    → 首屏机位（对应第 0 帧）
//   第 k 项    → 第 k 个履历节点（k = 1…M，对应第 k·FRAMES_PER_NODE 帧，M = FOCUS_POINTS.length）
//   第 M+1 项  → 作品区机位（最后一站）
// ⚠️ 所以本数组长度必须等于 FOCUS_POINTS.length + 2。增删履历时两边一起改。
//
// 所有长度都以**身高**为单位（1 = 人物总高），跟模型实际尺寸无关，换模型不用重调。
// 角度：azimuth 0° = 相机在人物正前方；正值相机绕到人物的右手边。
//       elevation 正值 = 相机在焦点上方（俯视），负值 = 仰视。
// shiftX 是「横向重新构图」：正值把人物往画面左边推（相机往右挪）。
//        履历区文字在右半边，所以那里都给 0.26 左右，让人物让开文字。

export type Shot = {
  focusY: number
  focusX: number
  dist: number
  azimuth: number
  elevation: number
  fov: number
  shiftX: number
}

// 当前：7 个履历节点（FOCUS_POINTS.length = 7）→ 共 9 站
export const SHOTS: readonly Shot[] = [
  // 0 · 首屏：全身，轻微四分之三侧；About 文字压在腰部，所以人物摆正中间
  { focusY: 0.55, focusX: 0, dist: 2.9, azimuth: -10, elevation: 3, fov: 30, shiftX: 0 },

  // 1 · 教育背景 + 技能：胸以上半身，正一点（第一站，先让人看清脸）
  { focusY: 0.86, focusX: 0, dist: 1.6, azimuth: 12, elevation: 3, fov: 28, shiftX: 0.26 },
  // 2 · 洛希极限（海外 AI 增长）：脸部特写
  { focusY: 0.9, focusX: 0, dist: 1.3, azimuth: -6, elevation: 1, fov: 27, shiftX: 0.26 },
  // 3 · 接力科创（活动执行）：胸腰，看整体穿着
  { focusY: 0.6, focusX: 0, dist: 1.65, azimuth: 20, elevation: 0, fov: 28, shiftX: 0.26 },
  // 4 · DeVries Global（品牌传播）：下半身（工装裤 / 厚底鞋）
  { focusY: 0.26, focusX: 0, dist: 1.4, azimuth: -18, elevation: -8, fov: 28, shiftX: 0.26 },
  // 5 · 阿里巴巴（数据分析）：拉回全身，转到另一侧
  { focusY: 0.7, focusX: 0, dist: 2.1, azimuth: 28, elevation: 8, fov: 31, shiftX: 0.26 },
  // 6 · 南昌唐宁（自媒体 / 私域）：肩以上，转回正面偏侧
  { focusY: 0.82, focusX: 0, dist: 1.5, azimuth: -14, elevation: 4, fov: 28, shiftX: 0.26 },
  // 7 · 校青媒（社团）：侧身中景，收尾前换个角度
  { focusY: 0.62, focusX: 0, dist: 1.8, azimuth: 34, elevation: 2, fov: 30, shiftX: 0.26 },

  // 8 · 作品区：再退远，人物让到左边，中间留给作品画廊
  { focusY: 0.55, focusX: 0, dist: 2.65, azimuth: -26, elevation: 8, fov: 33, shiftX: 0.28 },
]
