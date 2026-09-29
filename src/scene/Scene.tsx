import { Suspense, useMemo, useRef, useState, useEffect, type MutableRefObject } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { Html, useGLTF } from '@react-three/drei'
import { animate, motion, useMotionValue, useScroll, useTransform } from 'framer-motion'
import { EffectComposer, Bloom, DepthOfField, SMAA } from '@react-three/postprocessing'
import * as THREE from 'three'
import Env from './Env'
import Stickers from './Stickers'
import { FOCUS_POINTS, FRAMES_PER_NODE } from '../data/focusPoints'
import { SHOTS, type Shot } from '../data/cameraShots'
import { getSite1Height } from '../site1/anchor'
import { openChatSoon } from '../chat/open'

useGLTF.preload(`${import.meta.env.BASE_URL}models/me.glb`)

// 聚焦锚点（glb 内 focus-* 空对象），顺序对应履历节点；名单是唯一真源，见 data/focusPoints.ts
const POINTS = FOCUS_POINTS as readonly string[]
const M = POINTS.length // 时间轴节点数（= 履历条数），从名单推导，不写死
const RESUME_FRAMES = M * FRAMES_PER_NODE // 履历区帧数：每节点 FRAMES_PER_NODE 帧（节点 k → 第 k·50 帧）
const WORKS_ENTRANCE = 50 // 作品区"入场"（画廊屏幕从底部滑入覆盖）占的帧数
const FPS = 24 // 所有 clip @24fps 共享时间轴；相机动画总帧数运行时从 CameraAction clip 读（见 totalFrames）
const NODE_LINE = 0.3 // 节点"终点"参考线：条目顶部到达视口该高度(从上 30%)时锁定为该节点

// 模型归一化后的世界身高。原版 me.glb 的人物约 2.6 单位高，保持一致，
// 这样景深 / 光照 / 后期那套调好的数值不用重调。机位距离都以「身高」为单位。
const RIG_HEIGHT = 2.6

/* 复用的临时向量（DEV 探针用，见 useFrame 里的 __herPoint）——
   每帧 new 一个 Vector3 会往 GC 上堆垃圾，这个文件的每帧回调本来就不少。 */
const HER_PROBE = new THREE.Vector3()

// —— 眼球总开关：默认关闭 ——
//
// 为什么关掉：这个模型的五官是「画在贴图上的平面二次元脸」，没有独立眼球网格。
// 硬叠两个 3D 球体有三个绕不过去的问题：
//   1) 位置对不上。贴图上画的瞳孔偏下、偏内，而球体摆在了偏上偏外的地方，
//      结果落在"眼睛和眉毛之间"的上眼睑上，看起来就是凭空空降的两颗球。
//   2) 材质露馅。球面上贴的是程序化画的"深色虹膜 + 一颗纯白高光点"，
//      贴在平面的画眼前就是一块边缘生硬的椭圆片，和脸接不上；
//      那颗纯白高光还会被 Bloom 再套一圈光晕，于是更像一团说不清颜色的白点。
//   3) 更本质的：球体会跟着鼠标转，画在贴图上的眼睛不会。一动就穿帮。
// 想看效果做对比：地址栏加 ?eye=1（不用改代码）；要彻底删掉这段就说一声。
const EYE_ENABLED =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('eye') === '1'

// —— 眼球（补出来的，见下方 makeEyeMeshes；当前默认不启用）——
// 球心位置 / 大小 / 扁平度全部是「占身高比例」，直接改数字即可。
// 下面这几个 y/x 是初版量出来的值，实测仍然偏高偏外（球心落在眉下而非瞳孔上），
// 真要重新启用，先把 y 往下调约 0.016、x 收窄约 0.004 再自行微调。
const EYE = {
  enabled: EYE_ENABLED,
  y: 0.875, // 眼球中心高度（占身高）—— 偏高，实测应约 0.859
  x: 0.043, // 单眼中心到面部中线的距离（占身高）—— 偏宽，实测应约 0.039
  z: 0.0894, // 眼球中心的前后位置（占身高，越大越靠前）
  r: 0.031, // 球半径（占身高）
  flatten: 0.35, // 沿 Z 压扁的比例（1=正球，越小越贴脸）
  maxYaw: 15, // 水平转动幅度上限（度）
  maxPitch: 8, // 垂直转动幅度上限（度）
  gain: 3, // 跟随灵敏度
  smooth: 0.44, // 平滑（0~1，越大越跟手）
  invertX: false,
  invertY: false,
}

// —— 头部跟随鼠标（顶点着色器实现，默认开启）——
//
// 目标：鼠标在页面上移动时，人物转头看向鼠标 → 画在脸上的眼睛自然就"追随"了光标。
//
// 为什么这么做，而不是贴眼球 / 加骨骼：
//   1) 这个模型是「单个网格」，没有头骨节点、没有独立眼球，五官全画在贴图上。
//      贴 3D 眼球必然穿帮——画的眼珠不会跟球一起转（上一版实测过，已废弃）。
//   2) 贴图是碎片化图集（脸被切成很多 UV 岛），没法只偏移"眼睛那块"的 UV。
//   3) 所以让「头本身」转过去看鼠标：眼睛在脸上，头一转眼睛自然跟着看，
//      而且颈部以下用 smoothstep 平滑过渡，看不出接缝、也不会有异物感。
//
// 实现：不改变模型、不烘焙，运行时给材质注入一段顶点着色器：
//   颈部以上（沿世界竖直方向的高度 > neckFrac）整体刚性旋转，
//   neckFrac → fullFrac 之间平滑过渡，fullFrac 以上完全刚性（保证整张脸不shear）。
// 过渡带位置是先用点云量出体型后定的：下巴约在 0.81，所以过渡带落在
// 0.72→0.81（衣领附近），面部位移到 0.81 以上才开始，脸部不会被拉扯。
const HEAD = {
  enabled: true,
  maxYaw: 38, // 水平转头幅度上限（度）—— 26 时用户觉得"不明显"，38 是一眼能看出的转头
  maxPitch: 21, // 抬头/低头幅度上限（度）
  edge: 0.5, // 行程：光标走到"头部屏幕位置 → 屏幕边缘"这段距离的 50% 时打满
  ease: 0.0015, // 缓动。**这个是"每秒保留比例"，不是"跟手百分比"**：
  //   eh = 1 - ease^dt（每帧），时间常数 τ = −1/ln(ease)。
  //   旧值 0.14 → τ≈0.51s，实测 63% 要 0.4s、95% 要 1.5s —— 鼠标一动头在后面慢慢追，
  //   主观感受就是"不跟着鼠标转"（_tools/settle.cjs 实测）。
  //   0.0015 → τ≈0.15s，等价于"每帧 lerp 0.10"这种经典跟手手感，95% 约 0.45s。
  //   想更"有惯性/慵懒"就往 0.05 走，想几乎即时贴住鼠标就往 0.0002 走。
  refFrac: 0.88, // 头部参考点高度（占身高），用于算"光标相对头部的偏移"
  neckFrac: 0.72, // 过渡带起点（占身高）——以下不转
  fullFrac: 0.81, // 过渡带终点（占身高）——以上整体刚性旋转
  heroWeight: 1, // 首屏（About）跟随权重
  timelineWeight: 0.9, // 履历区跟随权重（0.5 时特写下只有 ±13°，几乎看不出在动；0.9 → ±34°）
  worksWeight: 1, // 作品区跟随权重。**别改回 0** —— 人物在作品区一直是可见的
  //（左半边全身，画廊只占右半屏），归零会让整个作品区转头死掉。
}

// —— 身体待机微动（呼吸 + 重心微摆，默认开启）——
//
// 解决的问题：只有"转头"的话，躯干和下半身是完全静止的，站着不动像一尊雕像。
// 加一点点呼吸和重心摆动，"活着"的感觉立刻就出来了 —— 但幅度必须很小，
// 大了就从"细腻"变成"喝多了在晃"。
//
// 和转头同一套做法：**运行时注入顶点着色器**，不改模型、不用骨骼
// （这个模型是单网格、无骨骼，没有任何可动的部件）。
//
// 两个分量：
//   呼吸 —— 胸口沿「相对竖轴的外法向」鼓起，同时胸口以上整体微升（肩、头跟着起落）。
//           用径向而不是顶点法线：胸是桶形，径向鼓起才自然；也不会受贴图法线影响。
//   微摆 —— 以脚底为支点的「倒立摆」：横向位移随高度线性增长，
//           脚钉在原地不动、头摆得最多。左右与前后用不同相位 → 头顶走扁椭圆，
//           不是沿直线来回推；每条轴再叠一个不同频率的泛音，避免钟摆的机械感。
//
// 开关：地址栏加 `?noidle` 整段关掉 —— 用来 A/B 对照，直接看"死板"和"活着"的差别。
const IDLE_ENABLED =
  typeof window !== 'undefined' && !new URLSearchParams(window.location.search).has('noidle')

// 单位说明：所有系数都是「相对 amp」的倍率，amp 是「占身高的比例」。
//   amp 0.010 → 把一个 1.7m 的人当参照：腰胯横移约 17mm、头约 8mm（见 headKeep）、
//   吸气时胸口以上抬升约 9mm、胸口径向鼓起约 7mm。
//   这几个数就是"真人静止站着不动时的实测量级"（真人站立的重心摆动是厘米级，
//   头因为被主动稳住只有它的六七成）—— 所以看起来会像"活着"，而不是"在晃"。
//   觉得不够明显往 0.016 走；超过 0.03 会开始像站不稳。
const IDLE = {
  enabled: IDLE_ENABLED,
  amp: 0.010, // 总幅度（占身高），一切分量的基准
  lean: 1.0, // 重心微摆：左右方向的位移（× amp）
  leanFwd: 0.45, // 重心微摆：前后方向（× amp）。和左右用不同相位 → 走成一个扁椭圆，不是直线来回
  swayFrom: 0.28, // 微摆从脚底到哪个高度涨到满幅（占身高）—— 以下（小腿/脚）基本不动，以上腰胯整体平移
  headKeep: 0.5, // 头保留多少微摆（1=跟着一起摆）。真人站立时头是被主动稳住的，
  //   摆得比肩胯少；而且贴纸/人脸特写下头横移太多会像"画面在飘"。0.5 是"看得出来在动、
  //   又不会觉得脸在滑"的折中。想让头更活就往 0.8 走。
  rise: 0.55, // 呼吸：吸气时胸口以上整体抬升（× amp）
  bulge: 0.4, // 呼吸：吸气时胸口径向鼓起（× amp）
  chestBand: 0.7, // 鼓起带的中心高度（占身高）—— 就是胸口的位置
  bandWidth: 5.0, // 鼓起带的宽窄（越大越窄）
  riseFrom: 0.6, // 微升从哪个高度开始（占身高）
  riseTo: 0.95, // 微升到哪个高度达到满幅
  breathW: 1.75, // 呼吸角频率（rad/s）：1.75 ≈ 3.6 秒一次（真人在 3~5 秒）
  swayW: 0.95, // 微摆角频率（rad/s）：0.95 ≈ 6.6 秒一轮
  // 两个基频不成整数比 → 合成周期极长，盯着看也不会觉得在循环
}

// 调参浮层：地址栏加 `?hud` 会在左上角实时显示转头角度 / 生效权重 / 指针判定。
// 用途是**一眼分辨**「代码根本没生效（页面是旧的）」和「生效了但看不出转」——
// 前者的浮层根本不会出现，或者数字不动。
const HEAD_HUD =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('hud')

// —— 点击她 → 挥手 + 微笑（顶点着色器，默认开启）——
//
// 这个模型没有骨骼、没有任何可动部件，"挥手"只能靠运行时顶点位移。
// 难点不在"怎么动"，而在 **"动哪些点"**：这个 glb 是**一整块网格、没有骨骼**，
// 而且她的**手是搭在黑色工装裤袋上的**——手和裤袋在网格里是连着的同一片皮。
//
// ⚠️ 踩过的两个坑（都修好了，记下来免得重犯）：
//
//   坑 1：种子点找错了 —— 一开始按"左手指向大概在胯边"估了个种子 (0.28,1.29,0.10)，
//         结果那个点落在**裤袋**上。于是所谓"挥手"其实是在转**裤子**，
//         画面上甩出一大片黑色刀片（_shots/wave_sheet.png）。
//         正确做法：用底色贴图把"皮肤"顶点挑出来再按空间聚类
//         （_fetch/findhands2.py）——手实际在 **x≈±0.35, y≈1.06~1.19**，
//         是一块 0.09×0.13 的小皮岛，和裤袋只差 0.1。
//         另注：材质走 EXT_texture_webp，底色贴图是 images[1] 不是 images[0]（images[0] 是法线图）。
//
//   坑 2：用"绕关节旋转"来抬手 —— 旋转的位移 ∝ 到枢轴的距离，离枢轴 0.6 的点会被甩出
//         2·0.6·sin(θ/2) 的弧。手虽然只走了 0.1，胯上那些被权重扫到的点却被甩出 0.5，
//         于是整片布被拉成扇面 = 黑刀片。**换成纯平移**后位移被向量本身封顶，
//         无论多远都不会甩出去，剩下的只有"权重带内部被剪切"这一项，
//         而它完全由带宽决定（_fetch/wavetrans.py 的对照板 A/B 行）。
//
// 现在采用：**平移**。权重 = 「从手心出发的测地距离」的 smoothstep。
//   数据离线算好放 public/models/waveR.f32（每顶点一个 float，按 glb 原始顶点顺序）。
//   d < d0 → 1，d > d1 → 0，中间 smoothstep：过渡带铺在手腕/裤袋上，
//   因为位移有上限，这条带只会"平移+剪切"，不会扇开。
//   实测（d0=0.04 / d1=0.30 / 位移 0.20）：手移动 0.202，胯位移 0.000，大腿位移 0.032，
//   最大边拉伸 2.16，拉伸>2.5 的边 **0 条**（真人抬手皮肤拉伸也就 1.5 左右，2.2 肉眼看不出来）。
//
// 观感 = 「把手从裤袋上抬起来、在身侧来回摆」。手本来就在胯的高度，
// 所以抬起来是"抬手打招呼"，不是"举过头顶"。想抬更高得先在 Blender 里把手和裤袋切开。
// ⚠️ 换模型必须重算 waveR.f32（见 _fetch/armcheck.py）——而且种子必须落在**手**上，不是裤袋上。
const WAVE = {
  enabled: true,
  // —— 权重带（从手心出发的测地距离，世界单位）——
  // ⚠️ 带必须够宽。同样的位移，带越窄就被压在越短的表面上 → 边被拉得越长。
  // 实测（_fetch/wavetrans.py）：d1=0.16 时位移 0.11 边拉伸已到 2.4；d1=0.30 时位移 0.20 也才 2.2。
  // 原因是位移是"平移"而不是"旋转"（见下），拉伸完全由这条带吸收，带宽就是它的缓冲垫。
  d0: 0.02, // d < d0 → 权重 1（整只手都跟着走）
  d1: 0.42, // d > d1 → 0；中间 smoothstep
  // —— 位移量（占身高）——
  // 这几个数是**在真实渲染里调出来的**，别按离线指标放大：
  // 离线看"边拉伸 2.2"好像还行，但位移一大，手和裤袋之间那圈**焊缝皮肤**就被
  // 拉成一只有纹理的"袜子"（贴图被拉出人字形），肉眼非常明显。
  // 实测：位移 0.20 时那层蹼肉眼可见；降到 0.13 左右才干净。
  // ⚠️ 单位别搞错（这三个数是**在页面里调出来的**，别按字面理解）：
  //   它们先乘 norm.h（未缩放世界身高）再送进着色器，而着色器里的 position 是**原始属性**，
  //   两者差一个节点缩放（这个模型 0.587×）→ 实际世界位移 = 这里的值 × 1.53。
  //   即 lift 0.105 实际抬手约 0.16 世界单位（身高 2.6 的 6%）。
  //   所以别"顺手改成占身高比例"—— 那会把幅度直接砍掉三分之一。
  lift: [0.045, 0.105] as [number, number], // 抬起：[向外 +x, 向上 +y]
  swing: 0.042, // 抬到位后的左右摆幅（同一单位）——"挥手"主要靠它
  // —— 时间线 ——
  durUp: 0.45, // 抬手时长（秒）
  durHold: 1.8, // 保持摆动时长（秒）
  durDown: 0.6, // 放下时长（秒）
  wobbleHz: 2.2, // 摆动频率（Hz）——2.2 次/秒，接近真人挥手
  headYaw: 9, // 挥手时额外转头（度，朝抬起的那只手）——"看着你挥手"
  headRoll: 6, // 挥手时额外歪头（度）
  // 微笑：同样是顶点位移 —— 把嘴角两端往上提，**画在贴图上的那张嘴**就跟着弯成笑嘴。
  // 为什么不做"笑脸贴纸"盖上去：贴图上五官碎在几十个 UV 岛里，贴纸要么对不准、
  // 要么边缘露馅（脸上本来就有唇色和腮红）；让原本那张嘴弯起来，
  // 颜色/受光/景深/头部旋转全部自动一致，零对齐成本。
  // ⚠️ 这里曾经是个真 bug，记下来省得再踩：
  //   mouth 填的是**世界单位**（2.157），但旧版 toLocal 是 Vector3(frac * h).applyMatrix4(inv)，
  //   而 inv 在 useMemo 跑的时候外层 <group scale> 还没接上（只含模型自己的节点变换），
  //   于是同一份数字被放大了 RIG_HEIGHT 倍 —— 嘴中心实际落在世界 y = 5.61，
  //   而模型头顶才 2.6：微笑窗口整个飘在头顶上方，**从来没生效过一次**。
  //   （当时"看起来在笑"是转头 9° + 腮红造成的错觉，拿 rest/wave 两帧对比是分不出来的：
  //     挥手时头会转，两张图连姿态都不同。）
  //   现在统一成「世界单位」并改用与时机无关的换算（见下面 toRaw），
  //   想验证必须用 __pose() 做**同姿态**的 A/B。
  // amp：世界单位（身高 2.6 ≈ 真人 1.7m）。
  // 这个数不是拍的，是从**实测的唇宽**反推的：
  //   · 唇半宽 0.076 世界单位（红润度带 61px 宽 / 400 px 每世界单位，见 mouthmeas.py）
  //   · smileR 取 0.101，正好让嘴角落在 0.75×R —— 那里 sWin≈0.98、sCorner=1
  //     （sCorner 在 |sX|/R ≥ 0.70 就满权重），于是嘴角拿到 ≈0.98 的权重
  //   · 屏幕上抬升 px = amp × 400 × 0.98 → 取 amp=0.018 得到 ≈7px，
  //     对一条 61px 宽的嘴来说约 1/9 唇宽，是"一眼看得出在笑"的量级
  // 能放心加幅度，是因为 __probe().vCount 实测窗口里有 **100 个顶点**（总 69619）——
  // 顶点够密，位移是把嘴"弯"起来，而不是把那两三个点拽出硬折角。
  smileAmp: 0.018,
  // 嘴角窗口半径（世界单位）。取 0.101 = 唇半宽 0.076 ÷ 0.75，让嘴角落在 0.75×R。
  // 为什么不是"约嘴宽的 0.8 倍"（旧注释写的，值 0.026）：0.026 只有唇半宽的 1/3，
  // 窗户够不到嘴角，只有嘴中间被顶起来；现在窗口横跨整条嘴（±0.101 ≈ ±40px），
  // 竖直方向不会误伤鼻子/下巴 —— 那两处 |sX|≈0，被 sCorner 的 smoothstep(0.10,·) 压成 0。
  smileR: 0.101,
  mouth: [0.0, 2.157, 0.225] as [number, number, number], // 嘴中心（世界坐标，2.6 = 身高）
  // 嘴中心这个值已被 __px() 对账验证过：把嘴中心投影到屏幕得 (729.0, 285.2)，
  // 与图上量出的唇带中心（735.5, 293）之差 ≈ (6.5, 7.8) px，而 wink 那侧的
  // 眼心也有同样大小的偏移（实测 754.5 vs 投影 746.8）—— 整体偏移是静止时的轻微
  // 歪头造成的，两者**相对距离只差 0.8px**，说明嘴中心配得准。

  // —— 单眼 wink（点击时只闭一只眼）——
  // 只闭**世界 +x 那一只**（就是抬手那侧），另一只照常睁着 —— 两只一起闭那是"眨"不是"wink"。
  // 眼位是**量出来的**，不是猜的（见 _fetch/eyeview.py → _fetch/eyecomp.py）：
  //   正射渲染脸部 → 逐行扫深色连续段 → 左眼中心(+0.122, 2.2295)、右眼(-0.0715, 2.2295)，
  //   眼宽约 0.095、眼高约 0.065（世界单位，2.6 = 身高）。
  //   顺带印证：代码里原来手调的 EYE.y = 0.859 身高 ≈ 2.233，和量出来的 2.2295 几乎重合。
  // 下面全部是**世界单位**（和 mouth 同一套）。
  eyeWink: [0.122, 2.2295] as [number, number], // 要闭的那只眼的中心（x, y；世界坐标）
  eyeHalf: 0.033, // 竖直核心半高：|竖直偏移| < 它 → 全额压扁（正好覆盖眼高 0.065 的一半）
  eyeR: 0.058, // 竖直衰减半径：到这里为止恢复成"不动"—— 上眼睑走一小段，眉毛不动
  // 水平半宽 0.075：双眼中心间距 0.1935 → 到另一只眼还有 0.022 的余量，绝对碰不到；
  // 而眼睛自身的半宽是 0.047，落在 0.034→0.075 的淡出区间里，所以眼角只闭到七成 ——
  // 这正是想要的效果：真 wink 是上下眼睑合拢、眼角留一点缝，全关死反而像"画上去的"。
  eyeRx: 0.075, // 水平半宽窗口：超过它完全不作用 —— 保证另一只眼和眉毛不受影响
  eyeSquash: 0.13, // 核心区压到原高度的 13%：虹膜+眼白+睫毛被压成一条深线，就读作"闭眼"
  // 时间线：眨眼自己走一遍（闭得快、睁得慢），**不跟着 2.8 秒的挥手一直闭着** ——
  // 真人 wink 只保持零点几秒，闭一整个挥手时长就从"打招呼"变成"眯着眼盯你"了。
  winkDelay: 0.06, // 点击后先留一拍再闭（否则像是被点"打"闭的）
  winkClose: 0.15, // 闭眼时长（秒）
  winkHold: 0.60, // 保持闭眼时长（秒）
  winkOpen: 0.26, // 睁眼时长（秒）
}

// 点击挥手用的「权重文件是否已加载」。没加载完之前整段位移由 uWaveW 关掉 ——
// 否则顶点属性缺失会默认成 0，权重算出来是 1，整个人会被转过去。
const WAVE_SRC = `${import.meta.env.BASE_URL}models/waveR.f32`

// —— 皮肤上色（2026-09-17）——
//
// 用户："肤色可以弄成图片的肤色吗，这个肤色有点太白了"。
//
// 为什么是「压绿蓝」而不是「整体调亮/调暗」：量出来两者的红通道**几乎一样**，
// 差在绿蓝偏高 —— 也就是饱和度不够、发灰白，不是亮度问题。
//
//   参考图肤色（目标）  #DAB0A6   RGB 218 176 166
//   模型渲染肤色（改前）#E1BAAF   RGB 225 186 175
//   → 需要的线性系数 [0.931, 0.884, 0.890]（量法见 _tools/skin_measure.py）
//
// 根因是灯光：主光 `#ffd9c6` 是暖的，但补光 `#9fc6ff` 是一盏**蓝色灯**、强度 1.8，
// 打在人身上就把皮肤往冷里推了一大截。不动灯是有意的 —— 那盏冷光同时给了头发和
// 衣服一层漂亮的冷调轮廓，全局改灯会把这层质感一起弄丢。所以只在**皮肤**上把绿蓝压回去，
// 等于就地抵消蓝补光，其余材质分毫不动。
//
// 怎么只挑皮肤：见 skinFragment() 的注释。这里只放"调多少"。
const SKIN = {
  enabled:
    typeof window !== 'undefined' && !new URLSearchParams(window.location.search).has('noskin'),
  // 线性空间逐通道相乘（在 <map_fragment> 之后作用在 albedo 上）。
  // 这一版是「量一次 → 调一次 → 再量」收敛出来的，不是一次成型：
  //   第 1 轮 [0.931, 0.884, 0.890] → 1440×900 首屏皮肤中位数 #DEB3AA（目标 #DAB0A6）
  //   → 残差 [0.970, 0.987, 0.974] → 乘上去得下面这一组，首屏基本压到目标。
  mul: [0.903, 0.873, 0.867] as [number, number, number],
  // 0~1 总强度，留个旋钮方便对半调
  amount: 1,
  // 皮肤高光压制：这个 glb 带了 KHR_materials_specular，specularColorFactor 是 [2,2,2]，
  // three 算出来 F0 = min(0.2² × 2, 1) = 0.08（常规材质是 0.04）—— 等于双倍镜面反射，
  // 打出一层"瓷白"油光，是「太白」的第二大来源（第一是蓝补光）。
  // 只压皮肤：头发那层漂亮的油亮光泽要留着，全局压会把整顶头发做哑。
  spec: 0.45,
}

// 皮肤上色的 uniform 声明（拼进 fragment shader 的 <common> 之后）
const SKIN_UNIFORM_DECL = `
uniform vec3 uSkinMul;
uniform float uSkinAmt;
uniform float uSkinSpec;
`

// 皮肤上色的着色器片段（拼进 <map_fragment> 之后）。
//
// 挑皮肤的判据是**暖度**，不是亮度：
//   warm = (r - b) / max(r,g,b)
// 这个模型里头发和衣服都是冷调深蓝（红 < 蓝）→ warm 为负 → 权重直接 0；
// 眼白、高光接近中性 → warm ≈ 0 → 也不会被染成粉色；只有皮肤（连同唇色、腮红）
// 落在 warm ≈ 0.15~0.30 这一段。所以一条 warm 就能把皮肤干净地摘出来，
// 不用额外给贴图做 mask —— 换模型只要 warm 的区间还成立就继续有效。
//
// 另外还乘一个"别在近黑处动手"的窗：贴图阴影区的皮肤像素本身噪声大，
// 在那里放大色偏只会脏，不会更像皮肤。
//
// ⚠️ 这些系数都是**线性空间**的（three 的 map_fragment 已经把 sRGB 贴图解成线性），
//    量出来的比例也是线性的，两边可以直接对上；别拿 sRGB 的差值往里填。
//
// ⚠️ skMask 必须声明在 main 的**顶层作用域**（不能裹在自己的 {} 里）——
//    下面压高光那一段还要用它。裹起来的话那一处会编译不过（未定义标识符）。
const SKIN_FRAGMENT = `
float skMask = 0.0;
{
  vec3 skC = diffuseColor.rgb;
  float skMax = max(max(skC.r, skC.g), skC.b);
  float skWarm = (skC.r - skC.b) / max(skMax, 1e-5);
  skMask = smoothstep(0.05, 0.13, skWarm);
  skMask *= smoothstep(0.010, 0.060, skMax);
  skMask *= uSkinAmt;
  diffuseColor.rgb *= mix(vec3(1.0), uSkinMul, skMask);
}
`

// 皮肤高光压制（拼进 <lights_physical_fragment> 之后）。
// 那里 three 刚算完 material.specularColor / specularF90，正好就地按 skMask 压。
const SKIN_SPECULAR_FRAGMENT = `
material.specularColor *= mix(vec3(1.0), vec3(uSkinSpec), skMask);
material.specularF90 *= mix(1.0, uSkinSpec, skMask);
`

// —— 首屏「Click me」提示：手写体 + 手绘箭头，指着她的头 ——
//
// 位置不是估的，是**量出来再反解**的（两把脚本都留在 _tools/）：
//   ① 先扫出头部轮廓（hintpos.cjs）。判据用**射线命中**而不是亮度阈值 ——
//      背景是渐变、头发本身有大片接近背景的暗区，灰度会重叠，阈值法必然要么漏要么溢；
//      "这个像素打不打得到模型"是精确的布尔值，轮廓就是"最后一个命中的像素"。
//      1440×900 实测：头顶在像素 (726, 188)、世界 (0.004, 2.577, 0.129)；
//      头部右上角约 (770, 205) px；局部比例 ≈ 218 px/世界单位（横）、226 px/世界单位（纵）。
//   ② 再把「文字左上角该落在哪个像素」反解成世界坐标（hintsolve.cjs）：
//      目标 (866, 152) → 世界 (0.63, 2.75, 0.168)，投影回去误差 0.2px。
//      z 取 0.168 是为了和头部表面同深度 —— 箭头看起来才贴在她所在的那个平面上。
//   ③ 箭头尖落在 (800, 222)：比头部右缘（那一行约 778px）再右 23px，
//      是"指着她"而不是"戳着她"。换算成世界坐标就是 tip = (0.327, 2.44, 0.168)。
//
// 为什么用 drei 的 <Html> 钉在世界坐标上，而不是写死像素：
// 镜头是**滚动驱动**的（data/cameraShots.ts 那七站之间插值），而且窗口尺寸会变，
// 写死像素一滚就漂；钉在世界坐标上由投影每帧重算，就永远跟着头走。
const HINT_DISABLED =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('nohint')

// （原 `?nosun` 墨镜开关随之移除，见文件下方 Man2 内的说明。）

const HINT = {
  // 两个文案：触屏设备上"Click"是错的动词。用 CSS 媒体查询切换（见 styles.css），
  // 不在 JS 里判 —— 纯 CSS 的重估是自动的，混合设备（Surface 那种）插拔鼠标也能跟上。
  text: 'Click me',
  textTouch: 'Tap me',
  // ⚠️ 锚点钉的是**箭头尖**，不是文字 —— 这一点是量过才改对的：
  //   一开始锚点取文字左上角，箭头长度写死 66px。桌面 1440 下尖端离头部右缘 23px，
  //   看着正好；但"每世界单位占多少像素"是**随视口高度变**的（纵向 FOV 固定），
  //   1440×900 → 218 px/单位，900×700 → 162 px/单位。于是同一个 66px 在窄屏上
  //   相当于更长的世界距离，尖端一路往脸上贴：
  //     1440×900  间距 23.1px   ✓
  //     1280×800  间距 10.8px
  //     900×700   间距  0.4px   ← 已经戳进头发里了
  //   反过来把**尖端**钉在世界坐标上，指向就与视口无关了（尖端～头的关系是"世界里的关系"）；
  //   文字摆在尖端右上多少 px 只影响构图，不影响"指着她"。
  tip: [0.327, 2.44, 0.168] as [number, number, number],
  // 文字 / 箭尾相对尖端的像素布局全部写在 styles.css 的 .click-hint-* 里
  // （那边是纯像素空间的事，和 3D 无关，放一起更好读）。
}

let hudEl: HTMLDivElement | null = null
function updateHeadHud(yaw: number, pitch: number, w: number, pointer: boolean) {
  if (!hudEl) {
    hudEl = document.createElement('div')
    hudEl.style.cssText =
      'position:fixed;left:12px;top:12px;z-index:99999;pointer-events:none;' +
      'font:600 13px/1.5 ui-monospace,Consolas,monospace;color:#fff;white-space:pre;' +
      'background:rgba(15,15,20,.72);padding:8px 12px;border-radius:8px;letter-spacing:.02em'
    document.body.appendChild(hudEl)
  }
  hudEl.textContent =
    `HEAD  yaw ${yaw.toFixed(1)}°   pitch ${pitch.toFixed(1)}°\n` +
    `      w ${w.toFixed(2)}   pointer ${pointer ? 'on' : 'OFF ← 判定成触屏了'}`
}

// 程序化眼球贴图：中间深色虹膜 + 高光，其余透明。
// 透明背景是关键——只把「瞳孔」叠在原本画好的眼睛上，不至于把二次元的脸盖掉。
function makeEyeTexture(): THREE.Texture {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D
  ctx.clearRect(0, 0, S, S)
  // 虹膜外圈（略透，压住原本画好的眼珠）
  // 半径是按「球面投影回贴图 UV」倒推的：UV 半径 du 对应球面上的横向偏移 r·sin(du·360°)，
  // 想让可见虹膜直径 ≈ 原画眼睛宽度，du 取 0.12（不是 0.245，那样会糊满整个眼球）。
  ctx.fillStyle = 'rgba(22, 20, 28, 0.9)'
  ctx.beginPath()
  ctx.arc(S / 2, S / 2, S * 0.12, 0, Math.PI * 2)
  ctx.fill()
  // 瞳孔
  ctx.fillStyle = 'rgba(5, 5, 9, 0.95)'
  ctx.beginPath()
  ctx.arc(S / 2, S / 2, S * 0.062, 0, Math.PI * 2)
  ctx.fill()
  // 高光（动漫脸的眼睛靠这个「亮」起来，也是转动时最明显的视觉线索）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)'
  ctx.beginPath()
  ctx.arc(S / 2 - S * 0.046, S / 2 - S * 0.05, S * 0.036, 0, Math.PI * 2)
  ctx.fill()
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

// 造两个眼球网格（名字含 eye → 会被下面的眼球跟随逻辑自动接管）
function makeEyeMeshes(h: number): THREE.Mesh[] {
  const r = EYE.r * h
  const geo = new THREE.SphereGeometry(r, 24, 16)
  const mat = new THREE.MeshBasicMaterial({
    map: makeEyeTexture(),
    transparent: true,
    depthWrite: false,
    // toneMapped 保持默认（跟场景一起做 ACES 色调映射）。
    // 早期这行写过 toneMapped:false，会让纯白高光停在 1.0 亮度、被 Bloom 多套一圈光晕；
    // 去掉之后光晕轻一些，但解决不了"球体和画的眼睛对不上"这个根本问题——
    // 所以眼球最终是整体关掉，而不是靠调材质补救。
  })
  return [-1, 1].map((s, i) => {
    const m = new THREE.Mesh(geo, mat)
    m.name = `eye${i + 1}`
    m.position.set(s * EYE.x * h, EYE.y * h, EYE.z * h)
    // 球体贴图 (u=0.5, v=0.5) 落在 +X 方向，绕 Y 转 -90° 把虹膜正对 +Z（脸的前方）
    m.rotation.y = -Math.PI / 2
    // 沿 Z 压扁成「贴脸的薄壳」，避免正球体看起来像贴了两颗弹珠
    m.scale.set(1, 1, EYE.flatten)
    m.renderOrder = 2
    return m
  })
}

// 在「连续镜头索引 p」处取机位：p=0 首屏、p=k 第 k 个履历节点、p=M+1 作品区。
// 相邻两站之间线性插值（每条履历占 FRAMES_PER_NODE 帧，所以过渡节奏与原版一致）。
const SHOTS_LIST = SHOTS as readonly Shot[]
const WORLD_UP = new THREE.Vector3(0, 1, 0)
const lerpShot = (p: number) => {
  const last = SHOTS_LIST.length - 1
  const i = THREE.MathUtils.clamp(Math.floor(p), 0, last - 1)
  const t = THREE.MathUtils.clamp(p - i, 0, 1)
  const a = SHOTS_LIST[i]
  const b = SHOTS_LIST[i + 1]
  const L = THREE.MathUtils.lerp
  return {
    focusY: L(a.focusY, b.focusY, t),
    focusX: L(a.focusX, b.focusX, t),
    dist: L(a.dist, b.dist, t),
    azimuth: L(a.azimuth, b.azimuth, t),
    elevation: L(a.elevation, b.elevation, t),
    fov: L(a.fov, b.fov, t),
    shiftX: L(a.shiftX, b.shiftX, t),
  }
}

// 上下渐变背景球（包裹相机），两端颜色可调
function GradientBackground() {
  // 镜头基本平视、视角又窄，一屏只扫到渐变中间一条；陡度把可见窄带拉成完整过渡。
  // 2.6 时一屏能看全「上绿下米白」；想更平调小，想更浓调大。
  const top = '#6f906f'
  const bottom = '#dbd3b5'
  const steep = 2.6

  const uniforms = useMemo(
    () => ({
      uTop: { value: new THREE.Color() },
      uBottom: { value: new THREE.Color() },
      uSteep: { value: 1 },
    }),
    []
  )
  uniforms.uTop.value.set(top)
  uniforms.uBottom.value.set(bottom)
  uniforms.uSteep.value = steep

  return (
    <mesh scale={100}>
      <sphereGeometry args={[1, 32, 32]} />
      <shaderMaterial
        side={THREE.BackSide}
        depthWrite={false}
        uniforms={uniforms}
        vertexShader={/* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={/* glsl */ `
          uniform vec3 uTop;
          uniform vec3 uBottom;
          uniform float uSteep;
          varying vec3 vDir;
          void main() {
            // 以地平线(y=0)为中心按陡度拉伸，narrow-fov 下也能看到完整过渡
            float t = clamp(vDir.y * uSteep * 0.5 + 0.5, 0.0, 1.0);
            gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
          }
        `}
      />
    </mesh>
  )
}

// 所有光源（HDRI 环境 + 半球 + 主/补方向光）
function Lights() {
  // 光照：原版是按作者自己模型的贴图亮度调的，换成你的模型后如果发白发灰，
  // 优先动这三个 intensity —— 皮肤过曝就压低，人太暗就抬高。
  const c = {
    envIntensity: 0.8,
    hemiIntensity: 0.95,
    hemiSky: '#ffffff',
    hemiGround: '#404040',
    keyIntensity: 2.0,
    keyColor: '#ffd9c6',
    keyPos: [5, 8, 5] as [number, number, number],
    fillIntensity: 1.8,
    fillColor: '#9fc6ff',
    fillPos: [-5, 4, -4] as [number, number, number],
  }

  return (
    <>
      <Env
        intensity={c.envIntensity}
        rotationX={0}
        rotationY={0}
        rotationZ={0}
        asBackground={false}
        bgIntensity={0.4}
        bgBlur={0}
      />
      <hemisphereLight args={[c.hemiSky, c.hemiGround, c.hemiIntensity]} />
      <directionalLight
        position={c.keyPos}
        intensity={c.keyIntensity}
        color={c.keyColor}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <directionalLight position={c.fillPos} intensity={c.fillIntensity} color={c.fillColor} />
    </>
  )
}

// 首屏提示：「Click me」+ 手绘箭头，指向她的头。
//
// 三件事要做对：
//   ① 位置钉在 3D 世界坐标上（镜头会动）—— 由 drei 的 <Html> 每帧投影，见上面 HINT 的注释。
//   ② 点过一次就淡出 —— 提示的使命完成了，再留着就成了遮挡。
//   ③ 滚动就淡出 —— 一滚镜头就把她推走，提示留在原地会变成无意义的浮字。
//
// 注意 <Html> 的 children 是渲染在**另一个 React root** 里的（drei 内部 createRoot），
// 所以它拿不到外层的 context；这里只用 props 和一个 window 级的滚动值，不依赖 context。
// 容器本身 drei 会设成 pointer-events:none，所以它**不会挡住"点她"** —— 点穿过去照旧生效。
function ClickHint({ gone }: { gone: boolean }) {
  // 用「网站2 自己的滚动量」：减掉网站1 的高度，否则网站1 期间那个值恒为 0，
  // 「点我」的提示会跟着影片一起出现（anchor.ts 顶部的说明）。
  // 这里是深层组件、拿不到 App 的 s1h，就直接读模块值 —— 它是每帧现算的，
  // 差一帧对一段 180px 的淡出行程没有影响，而且网站1 期间这整个 3D 层本来就是隐藏的。
  const { scrollY: rawScrollY } = useScroll()
  const scrollFade = useTransform(rawScrollY, (s) => {
    const s2 = Math.max(0, s - getSite1Height())
    return 1 - Math.min(Math.max(s2 / 180, 0), 1)
  })
  // 点击淡出：用独立的 motion value 走一段 0.5s 缓动，
  // 不能直接乘布尔值 —— 那样是"啪"地消失，而这是全站最柔和的一处动效。
  const clickFade = useMotionValue(1)
  useEffect(() => {
    if (gone) animate(clickFade, 0, { duration: 0.5, ease: 'easeOut' })
  }, [gone, clickFade])
  const opacity = useTransform([clickFade, scrollFade], ([a, b]: number[]) => a * b)

  return (
    <Html
      position={HINT.tip}
      zIndexRange={[3, 0]}
      // 只用默认的非 transform 模式：它把 DOM 的左上角（= .click-hint 的原点）钉在投影点上、
      // 缩放恒为 1，于是"原点 = 箭头尖"这件事在 CSS 里是确定成立的
      // （transform 模式会引入一层透视矩阵，锚点就不再是纯粹的屏幕像素了）。
      style={{ pointerEvents: 'none' }}
    >
      <motion.div className="click-hint" style={{ opacity }}>
        <div className="click-hint-bob">
          <span className="click-hint-text">
            {/* 触屏上换成 Tap：Cursor 是 Click、手指是 Tap，用错动词会显得很"网页味" */}
            <span className="hint-label-fine">{HINT.text}</span>
            <span className="hint-label-coarse">{HINT.textTouch}</span>
          </span>
          {/* 手绘箭头：从文字的左下角起笔，向左下兜一道弧，收在原点。
              下面这些数就是把量到的像素直接换算进这个 96×84 的 viewBox 里的：
              起笔 (62,28) = 页面 (858,172)，收笔 (4,78) —— 而 (4,78) 正是原点
              （CSS 里盒子放在 left:-4px; top:-78px，于是那个点落在锚点上）。 */}
          <svg className="click-hint-arrow" viewBox="0 0 96 84" aria-hidden="true">
            <path className="click-hint-stroke" d="M 62 28 C 46 26 24 46 4 78" />
            {/* 箭头翅：按落笔方向的切线 (-20,32) 反推 ±30°，两翅各长 13 */}
            <path className="click-hint-stroke" d="M 15.5 72 L 4 78 L 4.5 65" />
          </svg>
        </div>
      </motion.div>
    </Html>
  )
}

// me.glb：模型 + glb 自带相机动画（滚动分 5 段擦除）+ 自动对焦 + 眼睛跟随
function Man2({
  focusRef,
  focusSurfaceRef,
  frameRef,
  dofBokehRef,
  dofRangeRef,
  hintGone,
  onWaveStart,
}: {
  focusRef: MutableRefObject<THREE.Vector3>
  focusSurfaceRef: MutableRefObject<THREE.Vector3>
  frameRef: MutableRefObject<number>
  dofBokehRef: MutableRefObject<number>
  dofRangeRef: MutableRefObject<number>
  hintGone: boolean
  onWaveStart: () => void
}) {
  const rotationY = 0

  // mobilePullback：移动端相机沿「焦点→相机」方向拉远的倍率（1 = 不变，1.2 = 远 20%）
  // mobileTimelineShift：移动端「时间轴阶段」相机水平位移，单位=视距占比（正=左移，负=右移，0=关）
  const cam = {
    damping: 0.1,
    dwell: 0.35,
    parallax: 4,
    parallaxEase: 0.1,
    mobilePullback: 1.2,
    mobileTimelineShift: 0.12,
  }

  // 眼球跟随参数：位置/大小见文件顶部 EYE（补出来的眼球），跟随手感在这里
  const eye = {
    enabled: EYE.enabled,
    gain: EYE.gain,
    maxYaw: EYE.maxYaw,
    maxPitch: EYE.maxPitch,
    invertX: EYE.invertX,
    invertY: EYE.invertY,
    smooth: EYE.smooth,
    crossEye: 45,
    crossRadius: 0.25,
  }

  const get = useThree((s) => s.get)
  const size = useThree((s) => s.size)
  const { scene, animations } = useGLTF(`${import.meta.env.BASE_URL}models/me.glb`)

  // 克隆模型；收集眼睛对象、聚焦锚点对象、glb 自带相机、各锚点景深开关
  const { model, eyes, head, mainMesh, points, startPoint, glbCam, focusNode, dof, norm, skin } =
    useMemo(() => {
    const clone = scene.clone(true)
    const eyes: any[] = []
    const pmap: Record<string, any> = {}
    let startPoint: any = null
    let glbCam: any = null
    let focusNode: any = null

    // —— 模型归一化 ——
    // 量出包围盒，把模型整体挪到「脚底平面 y=0、左右前后居中」，再统一缩放到 RIG_HEIGHT。
    // 之后机位一律用「占身高比例」描述，换模型不用重调任何一个数字。
    // （模型经过 gltf-transform flatten，根节点没有残留变换，直接改 position 是安全的）
    const box = new THREE.Box3().setFromObject(clone)
    const h = Math.max(1e-6, box.max.y - box.min.y)
    const cx = (box.min.x + box.max.x) / 2
    const cz = (box.min.z + box.max.z) / 2
    clone.position.set(-cx, -box.min.y, -cz)

    // —— 补两个眼球 ——
    // 摆在脸部位置，名字含 eye，下面的 traverse 会自动把它们收进眼睛列表，
    // 于是原版「眼睛跟着鼠标转」的逻辑不用改一行就生效了。
    if (EYE.enabled) makeEyeMeshes(h).forEach((m) => clone.add(m))

    let mainMesh: any = null
    clone.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
        if (!mainMesh || o.geometry.attributes.position.count > mainMesh.geometry.attributes.position.count) {
          mainMesh = o
        }
      }
      if (o.isCamera) glbCam = o
      // 首页锚点：兼容旧名 focus-start 与 intro3d 统一命名 focus-0
      if (o.name === 'focus-start' || o.name === 'focus-0') startPoint = o
      if (o.name === 'focus-works') focusNode = o
      if (POINTS.includes(o.name)) pmap[o.name] = o
      if (/eye/i.test(o.name)) {
        // 平滑着色：重算平滑顶点法线 + 关闭 flatShading
        if (o.isMesh) {
          o.geometry.computeVertexNormals()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          mats.forEach((m: any) => {
            m.flatShading = false
            m.needsUpdate = true
          })
        }
        eyes.push({ obj: o, base: o.quaternion.clone(), x: o.position.x })
      }
    })
    // 按本地 x 定左右：最左眼 sx=-1、最右眼 sx=+1，用于斗鸡眼内转方向
    if (eyes.length > 1) {
      const xs = eyes.map((e) => e.x)
      const min = Math.min(...xs)
      const max = Math.max(...xs)
      const mid = (min + max) / 2
      eyes.forEach((e) => {
        e.sx = e.x < mid ? -1 : 1
      })
    } else {
      eyes.forEach((e) => (e.sx = 0))
    }

    // —— 头部跟随鼠标：给主网格（以及它的阴影深度材质）注入顶点着色器 ——
    // 需要先刷新世界矩阵，才能把「世界竖直方向 / 颈部高度」折算到网格局部空间。
    // 这样写的好处：完全不依赖模型导出时的朝向（Z-up / Y-up 都行），换模型不用改。
    const headUniforms = {
      uHeadRot: { value: new THREE.Matrix3() },
      uPivot: { value: new THREE.Vector3() },
      uAxis: { value: new THREE.Vector3(0, 1, 0) },
      uNeck: { value: 0 },
      uFalloff: { value: 1 },
      uHeadWeight: { value: 0 },
      // 待机微动（和转头共用同一段注入，所以放在同一个 uniform 袋子里）
      uIdleAmp: { value: IDLE.enabled ? IDLE.amp * h : 0 },
      uIdlePhase: { value: new THREE.Vector3(0, 0, 0) }, // x=呼吸、y=左右摆、z=前后摆（都已算好的 -1..1）
      uIdleFoot: { value: 0 }, // 脚底在 uAxis 上的投影
      uIdleInvH: { value: 1 }, // 1 / 身高投影，把高度归一化成 0~1
      uIdleSide: { value: new THREE.Vector3(1, 0, 0) }, // 世界 +X 在局部空间的方向
      uIdleFwd: { value: new THREE.Vector3(0, 0, 1) }, // 世界 +Z 在局部空间的方向
      // 点击挥手（权重来自 waveR.f32；uWaveW 是总闸，权重没加载完就恒为 0）
      // uWaveMove = 这一帧要平移多少（局部空间向量；由「世界方向 × 位移量」折过来）
      uWaveMove: { value: new THREE.Vector3() },
      uWaveW: { value: 0 },
      uWaveD0: { value: WAVE.d0 },
      uWaveD1: { value: WAVE.d1 },
      // 微笑（嘴角上提）
      uSmile: { value: 0 },
      // ⚠️ 下面这几个「长度」先占位成 0，真正的值在「世界坐标 → 原始属性空间」那段里统一算。
      //    绝对不要写成 × h：h 只是"未缩放世界"的身高，和着色器里的 position 差一个
      //    节点缩放（这个模型 0.587×），乘出来的窗口会大 1.7 倍。
      uSmileR: { value: 0 },
      uSmileAmp: { value: 0 },
      uMouthPos: { value: new THREE.Vector3() },
      uSmileDx: { value: new THREE.Vector3(1, 0, 0) },
      // 单眼 wink（把眼睛那块几何竖直压扁，画在贴图上的眼睛就闭成一条线）
      uWink: { value: 0 },
      uWinkPos: { value: new THREE.Vector3() },
      uWinkHalf: { value: 0 },
      uWinkR: { value: 0 },
      uWinkRx: { value: 0 },
      uWinkK: { value: WAVE.eyeSquash },
    }
    let head: {
      uniforms: typeof headUniforms
      rotOnly: THREE.Matrix4
      rotInv: THREE.Matrix4
      // 原始属性长度 → 世界长度 的倍率（dev 钩子里把位移换回世界单位用）
      worldPerRaw: number
    } | null = null

    // 皮肤上色的对外快照（目前只有 dev 钩子读）。
    // ⚠️ 必须声明在**外面**：真正的赋值点在下面 `if (HEAD.enabled || IDLE.enabled)` 那个块里，
    //    在里面声明的话作用域出不来，外面只能拿到 undefined。
    //    patched 又必须是对象里的一个字段而不是一个布尔变量 ——
    //    onBeforeCompile 是渲染时才跑的，那时 useMemo 早就返回了，
    //    直接返回值只会把"返回那一刻的 false"快照出去，永远看不到 true。
    const skinInfo: {
      mul: THREE.Vector3
      amt: number
      spec: number
      state: { patched: boolean }
    } = {
      mul: new THREE.Vector3(...SKIN.mul),
      amt: SKIN.enabled ? SKIN.amount : 0,
      spec: SKIN.spec,
      state: { patched: false },
    }

    const HEAD_UNIFORM_DECL = `
uniform mat3 uHeadRot;
uniform vec3 uPivot;
uniform vec3 uAxis;
uniform float uNeck;
uniform float uFalloff;
uniform float uHeadWeight;
uniform float uIdleAmp;
uniform vec3 uIdlePhase;
uniform float uIdleFoot;
uniform float uIdleInvH;
uniform vec3 uIdleSide;
uniform vec3 uIdleFwd;
uniform vec3 uWaveMove;
uniform float uWaveW;
uniform float uWaveD0;
uniform float uWaveD1;
uniform float uSmile;
uniform vec3 uMouthPos;
uniform vec3 uSmileDx;
uniform float uSmileR;
uniform float uSmileAmp;
uniform float uWink;
uniform vec3 uWinkPos;
uniform float uWinkHalf;
uniform float uWinkR;
uniform float uWinkRx;
uniform float uWinkK;
attribute float aWaveD;`

    // 位移权重：颈部以下 0、fullFrac 以上 1，中间平滑过渡。
    // 用 position（原始属性）而不是 transformed —— 法线块在位移块之前求值。
    const HEAD_WEIGHT_DECL = `float headW = uHeadWeight * smoothstep(uNeck, uNeck + uFalloff, dot(position, uAxis));`
    // 顶点位移（headW 由调用方声明，避免重复定义）
    const HEAD_DISPLACE = `
  if (headW > 0.0) {
    vec3 headRel = transformed - uPivot;
    transformed = uPivot + mix(headRel, uHeadRot * headRel, headW);
  }`
    // 法线同步旋转
    const HEAD_NORMAL = `
  if (headW > 0.0) objectNormal = normalize(mix(objectNormal, uHeadRot * objectNormal, headW));`

    // —— 点击挥手 ——
    // 每顶点权重：从手心出发的测地距离（attribute aWaveD，离线算好）。
    // 近手 → 1（跟着转），远手 → 0（不动），中间 smoothstep —— 过渡带在小臂上。
    // 变量名用 wW 而不是 waveW：要和 headW 一样在两个块里共用。
    const WAVE_WEIGHT_DECL = `
  float wW = uWaveW * (1.0 - smoothstep(uWaveD0, uWaveD1, aWaveD));`
    const WAVE_DISPLACE = `
  if (wW > 0.0) transformed += uWaveMove * wW;`
    // 平移不改法线。保留成空串是为了不动下面 patchVertex 里的字符串拼接。
    const WAVE_NORMAL = ``

    // —— 微笑：嘴角上提 ——
    // 以嘴中心为原点建一个"脸的平面坐标"：uSmileDx = 世界水平方向在局部空间的投影、
    // uAxis = 世界竖直方向（同一个 uniform，转头的过渡带也在用）。
    // 窗口 sr<1 内的点按 |x| 加权上提 —— |x| 越大提得越多，于是"嘴角"上翘、
    // 嘴中间基本不动，画在贴图上的那张嘴就被弯成了笑嘴。
    // uSmile=0 时整段是死代码（uniform 分支，编译期不会展开，但代价只有一次比较）。
    const SMILE_DISPLACE = `
  if (uSmile > 0.0) {
    vec3 sRel = position - uMouthPos;
    float sX = dot(sRel, uSmileDx);
    float sY = dot(sRel, uAxis);
    // 窗口是**椭圆**，不是圆 —— 嘴是"宽而扁"的特征，竖直方向必须比水平方向收得快。
    // 系数 1.6：竖直有效半径 = uSmileR/1.6 ≈ 0.063（25px），水平仍是 0.101（40px）。
    // 不做这一步的实测后果（第一版就是圆窗）：变化区纵向 45px、一直顶到 y271，
    // 而眼睛就在 y264~293 —— 下半张脸会跟着往上鼓，像被推起来的。
    // 椭圆化之后嘴角权重完全不变（嘴角上 sY≈0，乘系数不影响）。
    float sYc = sY * 1.6;
    float sR = sqrt(sX * sX + sYc * sYc) / uSmileR;
    // 窗口用到 1.10 才归零、0.72 才开始衰减 —— 这两个数很关键。
    // 原来写 (0.45, 1.0)，结果是：**嘴角恰好落在窗口边缘上**（嘴角在 0.75×R 处），
    // 权重几乎为 0，只有嘴中间被顶起来 —— 不像笑，像"抿嘴"。
    // 实测依据：唇半宽 0.076 世界单位（_tools/mouthmeas.py 量红润度带 → 61px 宽），
    // 而旧 R=0.026 只有唇半宽的 1/3，窗户压根够不到嘴角。
    float sWin = 1.0 - smoothstep(0.72, 1.10, sR);
    float sCorner = smoothstep(0.10, 0.70, abs(sX) / uSmileR);
    transformed += uAxis * (uSmile * uSmileAmp * sWin * sCorner);
  }`

    // —— 单眼 wink：把一只眼那块几何**竖直压扁** ——
    // 为什么是"压扁"而不是"盖一张闭眼的贴片"：
    //   眼睛是**画在贴图上的**，脸上根本没有眼睑/眼球这种能单独动的几何。
    //   盖贴片要么盖不住原本的黑瞳（露一圈边），要么和皮肤的受光不一致而显形，
    //   而且贴片得自己跟着顶点着色器转的头一起搬（Blush.tsx 里那套换算，容易在额角露边）。
    //   直接把这块面压扁，用的还是它**自己的贴图** —— 虹膜、眼白、睫毛一起被压成一条深色横线，
    //   颜色 / 受光 / 景深 / 头部旋转全部自动一致，零对齐成本。
    //   和"微笑靠把嘴弯起来"是同一个思路，也是同一组 uniform。
    // 窗口怎么建：
    //   · 竖直：核心区 |dy| < uWinkHalf 内**整体**压到 uWinkK。这一点是关键 ——
    //     如果只在中心附近加权，眼睛只是被"拉歪"而不会"闭上"。
    //     再往外到 uWinkR 平滑回到 1：上眼睑走一小段，眉毛和颧骨基本不动，不会拉出折角。
    //   · 水平：uWinkRx 之外完全不作用，保证只闭这一只眼。
    //   · 用 position（原始属性）而不是 transformed —— 和 HEAD / SMILE 一致，
    //     因为法线块在位移块之前求值，两边要看到同一个基准。
    //   · uSmileDx 直接复用：它就是「世界 +X 在局部空间的方向」，正是这里要的水平轴。
    const WINK_DISPLACE = `
  if (uWink > 0.0) {
    vec3 kRel = position - uWinkPos;
    float kUp = dot(kRel, uAxis);
    float kSide = abs(dot(kRel, uSmileDx));
    float kLat = 1.0 - smoothstep(uWinkRx * 0.45, uWinkRx, kSide);
    if (kLat > 0.0) {
      float kScale = mix(uWinkK, 1.0, smoothstep(uWinkHalf, uWinkR, abs(kUp)));
      // 沿 uAxis 把 kUp 缩掉：kUp → kUp * kScale，于是位移量 = kUp * (kScale - 1)
      transformed += uAxis * (kUp * (kScale - 1.0) * kLat * uWink);
    }
  }`
    // 竖直方向被压缩 k 倍 → 法线在该方向的分量要按 1/k 放大（法线按逆缩放变换）。
    // 没这一段，闭眼处会留下一块"受光还以为是睁着的"违和感。
    //
    // ⚠️ 但**只能作用在真正被压扁的核心区**（|dy| < uWinkHalf）。这里踩过一个坑，
    //    症状就是"闭眼时眼睛下方多一块黑"：
    //      位移的竖直权重在过渡带 uWinkHalf→uWinkR 里从 uWinkK(0.13) 一路升到 1。
    //      旧代码把"权重"当成"缩放率"来取倒数，于是过渡带里被放大了 1/0.13≈7.7 倍
    //      —— 而那一带位移场其实是**被拉开**的（真实拉伸率 J = d(u·k(u))/du ≈ 1.2~3），
    //      法线本该压平而不是放大。放大的结果就是眼下方那块被错误地照成暗色。
    //    实测（_tools/onnrmcmp.py / acceptance.py，噪声底为 0，所以差异全部来自这一段）：
    //      眼下纯脸颊 y[287,299] x[735,764] 变暗>15 的像素：修复前 24（最深 54 灰阶）
    //                                                     修复后  0（最深 14，= 完全不做修正时的水平）
    //      闭眼线 y[277,278] 最深亮度：修复前 87/52 → 修复后 64/52（保留），
    //                                  而且比完全不做修正时更黑（81/79）
    //      另一只眼：0 个像素变化
    //    为什么不能只砍掉过渡带、要再往上收一段：位移把过渡带的顶点**顶稀了** ——
    //    核心区顶点被压到 y≈273 内聚成一条，下一个顶点留在 y≈281、再下一个 y≈293，
    //    跨这几个顶点的三角形会把"放大的法线"插值到眼睛下缘 2~6px 之外。
    //    所以收窄到核心区的 70%~88%：让"被修正的顶点"离眼睛下缘还有一段距离，
    //    渗漏落在眼内而不是脸颊上，同时不切硬边。
    const WINK_NORMAL = `
  if (uWink > 0.0) {
    vec3 kRelN = position - uWinkPos;
    float kUpN = dot(kRelN, uAxis);
    float kLatN = 1.0 - smoothstep(uWinkRx * 0.45, uWinkRx, abs(dot(kRelN, uSmileDx)));
    if (kLatN > 0.0) {
      float wN = 1.0 - smoothstep(uWinkHalf * 0.70, uWinkHalf * 0.88, abs(kUpN));
      if (wN > 0.0) {
        float scaleV = mix(1.0, 1.0 / max(uWinkK, 0.05), wN * uWink * kLatN);
        objectNormal = normalize(objectNormal + uAxis * (dot(objectNormal, uAxis) * (scaleV - 1.0)));
      }
    }
  }`

    // 身体待机微动：在「转头」位移之后叠加。
    //   1) hn 把顶点高度归一化：0 = 脚底、1 = 头顶（用原始 position 属性，不受前面位移影响）
    //   2) 呼吸：径向鼓起用「顶点减去它在竖轴上的投影」再归一化 —— 这对桶形的躯干才自然；
    //      用顶点法线做会被贴图的硬边和衣服的褶皱带偏。这里刻意不碰法线，
    //      幅度只有千分之几身高，光照上的误差看不出来。
    //   3) 微摆：横向位移 ∝ hn —— 脚底 0、头顶最大，等价于绕脚底做倒立摆。
    //      左右与前后用不同相位 → 头顶走一个扁椭圆，而不是沿直线来回推。这一点很关键：
    //      单方向的来回推看起来像"被风吹"，椭圆轨迹才像人在自己调整重心。
    // 注意：所有系数都写死在着色器里（JS 里改 IDLE 会重新生成这段源码），
    // 所以改动 IDLE 之后必须同时改下面 customProgramCacheKey 的版本号，
    // 否则 three 会复用旧编译结果，改了看不到效果。
    const IDLE_DISPLACE = `
  if (uIdleAmp > 0.0) {
    float idleH = clamp((dot(position, uAxis) - uIdleFoot) * uIdleInvH, 0.0, 1.4);
    float bulgeBand = exp(-pow((idleH - ${IDLE.chestBand.toFixed(3)}) * ${IDLE.bandWidth.toFixed(3)}, 2.0));
    float riseBand = smoothstep(${IDLE.riseFrom.toFixed(3)}, ${IDLE.riseTo.toFixed(3)}, idleH);
    vec3 radialAxis = position - uAxis * dot(position, uAxis);
    vec3 radial = normalize(radialAxis + vec3(1e-6));
    vec3 sway = uIdleSide * (uIdlePhase.y * ${IDLE.lean.toFixed(3)})
              + uIdleFwd  * (uIdlePhase.z * ${IDLE.leanFwd.toFixed(3)});
    // 微摆的"高度权重"不是从脚底线性拉满，而是：脚/小腿几乎不动 → 到 swayFrom 高度涨满
    // → 头顶再收一档（headKeep）。三段都用 smoothstep，接缝处没有折角。
    float swayW = smoothstep(0.0, ${IDLE.swayFrom.toFixed(3)}, idleH)
                * (1.0 - ${(1 - IDLE.headKeep).toFixed(3)} * smoothstep(0.75, 1.0, idleH));
    transformed += sway   * (uIdleAmp * swayW)
                 + radial * (uIdlePhase.x * ${IDLE.bulge.toFixed(3)} * uIdleAmp * bulgeBand)
                 + uAxis  * (uIdlePhase.x * ${IDLE.rise.toFixed(3)} * uIdleAmp * riseBand);
  }`

    // 待机微动复用同一套「局部空间高度」的机制，所以 HEAD 关掉也不能跳过这段初始化
    if ((HEAD.enabled || IDLE.enabled) && mainMesh) {
      clone.updateMatrixWorld(true)
      const rotOnly = new THREE.Matrix4().extractRotation(mainMesh.matrixWorld)
      const rotInv = rotOnly.clone().invert()
      // 局部空间里的「世界竖直方向」——着色器用它当高度轴
      headUniforms.uAxis.value.set(0, 1, 0).applyMatrix4(rotInv).normalize()
      // 用世界高度上的两个比例反查局部坐标，得到过渡带的起止
      const inv = new THREE.Matrix4().copy(mainMesh.matrixWorld).invert()
      const atHeight = (frac: number) => new THREE.Vector3(0, frac * h, 0).applyMatrix4(inv)
      const pNeck = atHeight(HEAD.neckFrac)
      const pFull = atHeight(HEAD.fullFrac)
      headUniforms.uPivot.value.copy(pNeck)
      headUniforms.uNeck.value = pNeck.dot(headUniforms.uAxis.value)
      headUniforms.uFalloff.value = Math.max(
        1e-6,
        pFull.dot(headUniforms.uAxis.value) - headUniforms.uNeck.value,
      )
      // —— 待机微动：脚底/头顶在高度轴上的投影，用来把高度归一化成 0~1 ——
      const pFoot = atHeight(0)
      const pTop = atHeight(1)
      headUniforms.uIdleFoot.value = pFoot.dot(headUniforms.uAxis.value)
      headUniforms.uIdleInvH.value =
        1 /
        Math.max(1e-6, pTop.dot(headUniforms.uAxis.value) - headUniforms.uIdleFoot.value)
      // 世界水平方向折算到局部空间（和 uAxis 同一套换算），微摆才有"世界里的左右"这个概念
      headUniforms.uIdleSide.value.set(1, 0, 0).applyMatrix4(rotInv).normalize()
      headUniforms.uIdleFwd.value.set(0, 0, 1).applyMatrix4(rotInv).normalize()

      // —— 世界坐标 / 世界长度 → 网格「原始属性空间」——
      // 着色器里的 position 是**原始属性**（这个模型的竖直方向甚至是 z，不是 y），
      // 所以嘴中心、眼心、各种窗口半径都必须换算过去。
      //
      // ⚠️ 这里刻意**不用** inverse(mainMesh.matrixWorld)：useMemo 跑的时候外层
      //    <group scale={norm.scale}> 往往还没接上，那样算出来的是"未缩放世界 → 原始"，
      //    同一份数字送进着色器就整体偏了 RIG_HEIGHT 倍。这个坑是真埋下过的 ——
      //    WAVE.mouth 填 2.157，换算后落到世界 y=5.61（头顶才 2.6），微笑窗口整个飘在
      //    头顶上方，一次都没生效过。改成用「几何包围盒 + 世界朝向」直接求换算，
      //    不再依赖 matrixWorld 的时机。
      //
      // 依据：上面的归一化保证世界包围盒是「脚底 y=0、高 RIG_HEIGHT、x/z 居中」；
      // 而 uAxis / uSmileDx / uIdleFwd 正好是「世界 +Y / +X / +Z 在原始空间里的方向」，
      // 三个正交单位向量 —— 据此就能把世界点反解回原始空间。
      const uAxisV = headUniforms.uAxis.value
      const absAxis = new THREE.Vector3(Math.abs(uAxisV.x), Math.abs(uAxisV.y), Math.abs(uAxisV.z))
      const bbRaw = new THREE.Box3().setFromBufferAttribute(
        (mainMesh.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute,
      )
      const szRaw = bbRaw.getSize(new THREE.Vector3())
      const cRaw = bbRaw.getCenter(new THREE.Vector3())
      // 模型在竖直方向上的原始属性跨度（bbox 沿 uAxis 的投影长度；轴对齐，直接点乘取绝对值）
      const rawH = Math.max(1e-6, szRaw.dot(absAxis))
      const worldPerRaw = RIG_HEIGHT / rawH
      const rawPerWorld = 1 / worldPerRaw
      // 世界长度 → 原始属性长度（给各种"窗口半径"用）
      const L = (worldLen: number) => worldLen * rawPerWorld
      const W0 = new THREE.Vector3(0, RIG_HEIGHT / 2, 0) // 世界包围盒中心
      const toRaw = (world: readonly [number, number, number]) => {
        const d = new THREE.Vector3(world[0], world[1], world[2]).sub(W0)
        return new THREE.Vector3()
          .addScaledVector(uAxisV, d.y)
          .addScaledVector(headUniforms.uSmileDx.value, d.x)
          .addScaledVector(headUniforms.uIdleFwd.value, d.z)
          .multiplyScalar(rawPerWorld)
          .add(cRaw)
      }
      headUniforms.uSmileDx.value.set(1, 0, 0).applyMatrix4(rotInv).normalize()
      headUniforms.uMouthPos.value.copy(toRaw(WAVE.mouth))
      headUniforms.uSmileR.value = L(WAVE.smileR)
      headUniforms.uSmileAmp.value = L(WAVE.smileAmp)
      // 眼心只要 x / y：着色器是把它投到 uAxis（世界竖直）和 uSmileDx（世界水平）上取偏移的，
      // 世界 z 分量根本进不了公式 —— 所以第三个分量填 0 就行，不用去脸上量"眼睛有多深"。
      headUniforms.uWinkPos.value.copy(toRaw([WAVE.eyeWink[0], WAVE.eyeWink[1], 0]))
      headUniforms.uWinkHalf.value = L(WAVE.eyeHalf)
      headUniforms.uWinkR.value = L(WAVE.eyeR)
      headUniforms.uWinkRx.value = L(WAVE.eyeRx)
      head = { uniforms: headUniforms, rotOnly, rotInv, worldPerRaw }

      const patchVertex = (vs: string, withNormal: boolean): string => {
        let out = vs.replace('#include <common>', '#include <common>' + HEAD_UNIFORM_DECL)
        if (withNormal) {
          // 着色器里 beginnormal 块在 begin_vertex 之前，headW/wW 在这里声明，下面直接用
          out = out.replace(
            '#include <beginnormal_vertex>',
            `vec3 objectNormal = vec3( normal );
  ${HEAD_WEIGHT_DECL}${HEAD_NORMAL}${WAVE_WEIGHT_DECL}${WAVE_NORMAL}${WINK_NORMAL}`,
          )
          out = out.replace(
            '#include <begin_vertex>',
            'vec3 transformed = vec3( position );' +
              HEAD_DISPLACE + IDLE_DISPLACE + WAVE_DISPLACE + SMILE_DISPLACE + WINK_DISPLACE,
          )
        } else {
          // 深度材质（阴影）没有法线块，headW/wW 要在位移块里自己声明
          out = out.replace(
            '#include <begin_vertex>',
            `vec3 transformed = vec3( position );
  ${HEAD_WEIGHT_DECL}${HEAD_DISPLACE}${WAVE_WEIGHT_DECL}${IDLE_DISPLACE}${WAVE_DISPLACE}${SMILE_DISPLACE}${WINK_DISPLACE}`,
          )
        }
        return out
      }

      // —— 皮肤上色：和头部跟随一样走 onBeforeCompile，但打的是 fragment ——
      const skinUniforms = {
        uSkinMul: { value: new THREE.Vector3(...SKIN.mul) },
        // 关掉时把强度压成 0，而不是不注入：保持着色器源码不变，
        // 免得「带 ?noskin 的页面」和「不带的」编译出两份 program。
        uSkinAmt: { value: SKIN.enabled ? SKIN.amount : 0 },
        uSkinSpec: { value: SKIN.spec },
      }
      // 皮肤上色的对外快照（对象是上面声明好的，这里只填值 —— 保持引用不变）
      skinInfo.mul.copy(skinUniforms.uSkinMul.value)
      skinInfo.amt = skinUniforms.uSkinAmt.value
      skinInfo.spec = skinUniforms.uSkinSpec.value
      // ⚠️ 下面几处 replace 都是在猜 three 内部的 chunk 名，猜不中就**静默失效**
      //    （页面照常渲染，只是肤色没变）。所以既留 dev 警告，也留个 state 供钩子查。
      const patchFragment = (fs: string): string => {
        const need = ['#include <common>', '#include <map_fragment>', '#include <lights_physical_fragment>']
        const miss = need.filter((k) => !fs.includes(k))
        if (import.meta.env.DEV && miss.length) {
          console.warn('[skin] fragment chunk 没对上，皮肤上色不完整：缺 ' + miss.join(', '))
        }
        let out = fs
        if (fs.includes('#include <common>')) {
          out = out.replace('#include <common>', '#include <common>' + SKIN_UNIFORM_DECL)
        }
        if (out.includes('#include <map_fragment>')) {
          out = out.replace('#include <map_fragment>', '#include <map_fragment>' + SKIN_FRAGMENT)
        }
        // 高光压制必须排在上色之后：它要用上色那段算出来的 skMask
        if (out.includes('#include <lights_physical_fragment>')) {
          out = out.replace(
            '#include <lights_physical_fragment>',
            '#include <lights_physical_fragment>' + SKIN_SPECULAR_FRAGMENT,
          )
        }
        if (!miss.length) skinInfo.state.patched = true
        return out
      }

      const mats = Array.isArray(mainMesh.material) ? mainMesh.material : [mainMesh.material]
      mats.forEach((m: any) => {
        m.onBeforeCompile = (shader: any) => {
          Object.assign(shader.uniforms, headUniforms, skinUniforms)
          shader.vertexShader = patchVertex(shader.vertexShader, true)
          shader.fragmentShader = patchFragment(shader.fragmentShader)
        }
        // ⚠️ 这个 key 必须随「注入的 GLSL 源码」一起变 —— three 的 program 缓存
        // 只认 key、不认源码，key 不变就会复用旧编译结果，改了 shader 却看不到效果。
        // 末尾那个 skin2 就是为皮肤上色加的：忘了改它，照色调参调半天都不会动。
        m.customProgramCacheKey = () => 'head-follow+idle4+wave7+skin2'
        m.needsUpdate = true
      })

      // 阴影走的是另一套深度材质，不一起打补丁的话地上会留一个"没转头、也没呼吸"的影子
      const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
      depthMat.onBeforeCompile = (shader: any) => {
        Object.assign(shader.uniforms, headUniforms)
        shader.vertexShader = patchVertex(shader.vertexShader, false)
      }
      depthMat.customProgramCacheKey = () => 'head-follow+idle4-depth6'
      mainMesh.customDepthMaterial = depthMat

      // —— 载入挥手权重（每顶点一个 float，按 glb 原始顶点顺序）→ 当成自定义属性喂给着色器 ——
      // 载入是异步的，所以用 uWaveW 当总闸：数据到了才允许这段位移生效。
      // （属性缺失时 GLSL 会读到 0，权重会算成 1，整个人被转过去 —— 所以必须有关闸。）
      //
      // ⚠️ 两个坑，都是实测踩出来的：
      //   1. 属性挂在 **geometry** 上（跟着 useGLTF 的缓存全局共享），而 uniform 袋子是
      //      每次 useMemo 重建的。所以**不能**把"开闸"只写在 fetch 的回调里 ——
      //      useMemo 重跑（StrictMode / Suspense 重挂）之后 fetch 因为属性已存在直接跳过，
      //      新袋子的闸就永远是 0，现象是"权重明明加载了、挥手就是不动"。
      //      正确做法：先查属性在不在，在就当场开闸；不在才 fetch，回调里同时挂属性 + 开闸。
      //   2. 属性数量必须和顶点数一致，不一致宁可禁掉，也不要让权重错位到别的部位。
      const geo = mainMesh.geometry as THREE.BufferGeometry
      const setWaveGate = (on: boolean) => {
        headUniforms.uWaveW.value = on && WAVE.enabled ? 1 : 0
        mats.forEach((m: any) => (m.needsUpdate = true))
      }
      const existing = geo.getAttribute('aWaveD')
      if (existing && existing.count === geo.getAttribute('position').count) {
        setWaveGate(true)
        if (import.meta.env.DEV) (window as any).__waveReady = true
      } else {
        fetch(WAVE_SRC)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((buf) => {
            const f32 = new Float32Array(buf)
            const need = geo.getAttribute('position').count
            if (f32.length !== need) {
              console.warn('[wave] 权重数量与顶点数不符，挥手已禁用', f32.length, need)
              return
            }
            geo.setAttribute('aWaveD', new THREE.BufferAttribute(f32, 1))
            setWaveGate(true)
            if (import.meta.env.DEV) (window as any).__waveReady = true
          })
          .catch((e) => console.warn('[wave] 权重载入失败，挥手已禁用：', e.message))
      }
    }

    const pts = POINTS.map((n) => pmap[n] || null)
    // 作品区锚点：优先 focus-works（旧 glb）；缺省（intro3d 统一命名不导）则复用末时间轴节点 focus-M。
    const works = focusNode || pts[pts.length - 1] || null
    // 首页锚点：focus-start / focus-0；都没有则回退首个时间轴节点。
    const start = startPoint || pts[0] || null
    // 逐锚点景深参数（intro3d 导出写入 userData/extras）：dofBokeh 虚化强度、dofFocusRange 清晰范围、
    // dofEnabled 开关（关→有效 bokeh 记 0）。has=false（老 glb 无这些字段）→ Post2 走原全局帧混合，行为不变。
    const ud = (o: any): any => o?.userData ?? {}
    const hasDofParams = [...pts, start, works].some((o) => ud(o).dofBokeh !== undefined)
    const effBokeh = (o: any): number => (ud(o).dofEnabled === false ? 0 : (ud(o).dofBokeh ?? 0))
    const effRange = (o: any): number => ud(o).dofFocusRange ?? 0
    return {
      model: clone,
      eyes,
      head,
      mainMesh,
      points: pts,
      startPoint: start,
      glbCam,
      focusNode: works,
      // 皮肤上色的当前档位 + 有没有真的注入成功（dev 钩子用）
      skin: skinInfo,
      // 归一化结果：h = 模型原始身高，scale = 缩到 RIG_HEIGHT 的倍率
      norm: { h, scale: RIG_HEIGHT / h },
      dof: {
        has: hasDofParams,
        bokeh: pts.map(effBokeh),
        range: pts.map(effRange),
        startBokeh: effBokeh(start),
        startRange: effRange(start),
        worksBokeh: effBokeh(works),
        worksRange: effRange(works),
      },
    }
  }, [scene])

  // 相机动画总帧数：从 CameraAction clip 读（回退到最长 clip / 默认履历+入场+横移），不写死。
  // 作品区帧段 = [RESUME_FRAMES, totalFrames]，长度随 glb 而定（当前 me.glb 为 100 帧）。
  const totalFrames = useMemo(() => {
    const clips: any[] = animations || []
    const cam = clips.find((c: any) => c.name === 'CameraAction')
    const clip = cam || (clips.length ? clips.reduce((a, b) => (b.duration > a.duration ? b : a)) : null)
    return clip ? Math.round(clip.duration * FPS) : RESUME_FRAMES + 2 * WORKS_ENTRANCE
  }, [animations])

  // 动画混合器：把全部 clip（manAction + CameraAction）都挂上，逐帧设 time + update(0) 擦除
  const mixer = useMemo(() => new THREE.AnimationMixer(model), [model])
  const actions = useRef<any[]>([])
  useEffect(() => {
    if (!animations || animations.length === 0) return
    mixer.stopAllAction()
    actions.current = animations.map((clip) => {
      const a = mixer.clipAction(clip)
      a.play()
      a.paused = true
      return { action: a, duration: clip.duration }
    })
    return () => {
      mixer.stopAllAction()
      actions.current = []
    }
  }, [mixer, animations])

  // 不切换激活相机（避免后处理 CoC 缓存旧相机 near/far 导致整体糊）。
  // 改为每帧把 glb 相机的世界变换 + fov 拷到默认相机上。

  // window 级鼠标输入（smouse 为缓动后的值）
  // 同时监听 pointermove：某些内嵌预览面板 / 自动化环境只派发 pointer 事件，
  // 只挂 mousemove 会收不到 → 跟随整体失效。
  const mouse = useRef({ x: 0, y: 0 })
  const smouse = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const onMove = (e: MouseEvent | PointerEvent) => {
      mouse.current.x = (e.clientX / window.innerWidth) * 2 - 1
      mouse.current.y = -((e.clientY / window.innerHeight) * 2 - 1)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  // —— 点击她 → 挥手 ——
  // 这里自己打一条射线，**没有**用 R3F 的 onClick：R3F 的指针事件会在每次 pointermove 上
  // 对 7.5 万面的网格做一次 intersectObject（实测 ~12ms/次），鼠标在画布上一动就掉帧；
  // 点击是低频事件，自己打一条完全够用。
  // 判定条件：事件目标是 canvas（点在压在上面的文字/链接上就不算"点她"）+ 射线打到她身上。
  const waveT = useRef(-1) // <0 = 没在挥手；>=0 = 已经挥了多少秒
  const waveState = useRef({ env: 0, smile: 0, wink: 0 }) // 给头部小动作 / dev 钩子读
  // 调试用：把微笑 / wink 强行钉在指定值。为什么需要它 ——
  // freeze 挥手做不了"同一姿态"的对比：env 一变头就跟着转，两张图连姿态都不同，
  // 于是分不清"是表情变了"还是"头动了"（微笑当初就是这么被误判成"生效了"的）。
  const poseOverride = useRef<{ smile: number; wink: number } | null>(null)
  // 「点过就收起提示」的回调。点击监听挂在只依赖 [mainMesh, get] 的 effect 里，
  // 直接把回调塞进去会让父组件每次重渲染都解绑/重绑一次监听 —— 所以过一道 ref。
  const onWaveStartRef = useRef(onWaveStart)
  useEffect(() => {
    onWaveStartRef.current = onWaveStart
  })
  /* 点她 → 聊天面板。
     ⚠️ 这里只负责"点到了她"，**延迟由 AvatarChat 做**（openChatSoon 只是发信号）。
        原因：点她会触发父组件 setState，这棵 3D 子树会被卸载重挂，
        挂在组件里的定时器会在 cleanup 里被清掉 —— 那次的现象就是
        "点了有反应，但面板永远不弹"，看起来像事件没派发（2026-09-19 踩过）。
        另外"这段延迟里用户接着滚了就别弹"的判断也在那边，和面板状态放在一起。 */
  useEffect(() => {
    if (!mainMesh) return
    const rc = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    // 「点在链接/按钮上」不算点她 —— 否则点头部的导航链接会被顺手当成"摸头"。
    const INTERACTIVE = 'a,button,input,textarea,select,[role="button"]'
    const isUi = (t: EventTarget | null) =>
      !!(t as HTMLElement | null)?.closest?.(INTERACTIVE)
    let dId = -1
    let dX = 0
    let dY = 0
    // ⚠️ 千万别用 `e.target === canvas` 当条件：canvas 上面盖着 section.hero / main.content，
    // 点击的目标永远是那层 DOM，挂在 window 上的监听器于是永远 return（之前就是这么静默失效的，
    // 端到端点击测试 _tools/clicktest.cjs 才把它逮出来）。
    // 判据改成两条：① 不是点在交互控件上；② 射线确实打到她身上。
    // 另外从 pointerdown 挪到 pointerup + 位移阈值：手指滚页面时不会误触发。
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (isUi(e.target)) return
      dId = e.pointerId
      dX = e.clientX
      dY = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      /* DEV 探针：把这次点击的判定过程记下来，供 _tools/kc_click.cjs 归因。
         没有它的话，「点了没反应」只能靠猜 —— 是没配对上、被当成点了控件、
         还是射线没打到（这一次就是靠它定位到"根本没进命中分支"的）。 */
      const dbg: Record<string, unknown> = {
        pointerId: e.pointerId,
        downId: dId,
        move: Math.round(Math.hypot(e.clientX - dX, e.clientY - dY)),
        isUi: isUi(e.target),
        hit: -1,
      }
      if (import.meta.env.DEV) (window as any).__clickProbe = dbg
      if (e.pointerId !== dId) return
      dId = -1
      if (Math.hypot(e.clientX - dX, e.clientY - dY) > 8) return // 拖拽/滑动不算
      if (isUi(e.target)) return
      ndc.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1))
      rc.setFromCamera(ndc, get().camera)
      dbg.hit = rc.intersectObject(mainMesh, true).length
      if (dbg.hit === 0) return
      waveT.current = 0
      // 真的点到了她 → 首屏提示完成使命，收起（父组件驱动淡出）
      onWaveStartRef.current()
      // 卖萌先露出来，再把「和她聊聊」浮上来（面板已开着的话就是个空操作）
      openChatSoon()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
    }
  }, [mainMesh, get])

  // 移动端 / 触屏（无鼠标可跟随）：关闭眼睛跟随，眼睛保持默认朝向。
  // 判定 = 触屏指针 或 窄视口（≤640px，与移动端样式断点一致）。
  // 注意：这个旗标只管「布局相关的移动端处理」（镜头拉远 / 整体左移 / 眼睛跟随）。
  const isMobile = useRef(
    typeof window !== 'undefined' &&
      (window.matchMedia?.('(pointer: coarse)').matches === true ||
        window.innerWidth <= 640)
  )

  // 「能不能跟随光标」是另一件事，不能复用 isMobile：
  // 桌面浏览器把窗口拖窄（或 IDE 预览面板本身很窄）时 innerWidth 会 ≤640，
  // 但鼠标照旧可用 —— 之前误判成移动端，导致窄窗口下转头完全失效。
  // 判定只排除「纯触屏」（primary pointer 是 coarse 且没有 fine 指针）；
  // 拿不准的环境（matchMedia 缺失 / 两个查询都为假）一律按「可跟随」处理，
  // 宁可多转一点，也不要静默失效。
  const hasPointer = useRef(
    typeof window === 'undefined'
      ? true
      : !(
          window.matchMedia?.('(pointer: coarse)').matches === true &&
          window.matchMedia?.('(pointer: fine)').matches !== true
        )
  )

  // 履历锚点 DOM 元素（决定当前播放到第几段）
  const anchorEls = useRef<any>(null)
  // 作品区画廊 DOM 元素（决定作品入场 / 横移阶段的帧）
  const galleryEl = useRef<any>(null)

  // 复用对象，避免每帧分配
  const frameSmooth = useRef(0)
  const posA = useRef(new THREE.Vector3())
  const posB = useRef(new THREE.Vector3())

  const tmpEuler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'))
  const tmpQuat = useRef(new THREE.Quaternion())
  const desiredQuat = useRef(new THREE.Quaternion())
  const tmpVec = useRef(new THREE.Vector3())

  // 拷贝 glb 相机世界变换用
  const camPos = useRef(new THREE.Vector3())
  const camQuat = useRef(new THREE.Quaternion())
  const camScl = useRef(new THREE.Vector3())
  const paraEuler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'))
  const paraQuat = useRef(new THREE.Quaternion())
  // 镜头导演：由机位算朝向用
  const lookM = useRef(new THREE.Matrix4())

  // 景深「对焦到表面」用（复用，不每帧分配）
  const dofRay = useRef({
    rc: new THREE.Raycaster(),
    dir: new THREE.Vector3(),
    cam: new THREE.Vector3(1e9, 1e9, 1e9),
    frame: -1e9,
    n: 0, // DEV：累计射线次数，用来验证节流真的生效（window.__dofRays）
  })

  // 头部跟随鼠标用（全部复用，不每帧分配）
  const headAng = useRef({ x: 0, y: 0 }) // 平滑后的偏航/俯仰（弧度）
  const headNDC = useRef(new THREE.Vector3())
  const headRight = useRef(new THREE.Vector3())
  const headQ1 = useRef(new THREE.Quaternion())
  const headQ2 = useRef(new THREE.Quaternion())
  const headM1 = useRef(new THREE.Matrix4())
  const headM2 = useRef(new THREE.Matrix4())
  const headQ3 = useRef(new THREE.Quaternion())
  const headFwd = useRef(new THREE.Vector3())

  // 待机微动的时间轴（秒）。自己累加而不是用 clock —— 页面切到后台再回来时
  // dt 可能会跳一下，累加能让相位保持连续，不会突然抽一下。
  const idleT = useRef(0)

  useFrame((_, dt) => {
    /* DEV：把她的包围盒投到屏幕，供端到端脚本（_tools/kc_click.cjs）真的点在她身上。
       ⚠️ 别用「局部原点往上量一个固定高度」去猜她身上某点（第一次就是这么写的）：
          那个点未必落在网格表面上，射线从它出发自然打空 —— 表现为 hit=0，
          而脚本只会看到"点了没反应"，像功能坏了。用几何包围盒的 8 个角投影出
          屏幕矩形，脚本在框内自检挑一个真能命中的点即可。
       每帧只做 8 次矩阵乘，包围盒本身算一次就缓存（7.5 万面，别每帧重算）。 */
    if (import.meta.env.DEV && mainMesh) {
      const geo = mainMesh.geometry as THREE.BufferGeometry
      if (!geo.boundingBox) geo.computeBoundingBox()
      const bb = geo.boundingBox
      if (bb) {
        const cam = get().camera
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (let i = 0; i < 8; i++) {
          HER_PROBE.set(
            i & 1 ? bb.max.x : bb.min.x,
            i & 2 ? bb.max.y : bb.min.y,
            i & 4 ? bb.max.z : bb.min.z,
          )
          mainMesh.localToWorld(HER_PROBE)
          HER_PROBE.project(cam)
          const sx = (HER_PROBE.x * 0.5 + 0.5) * window.innerWidth
          const sy = (-HER_PROBE.y * 0.5 + 0.5) * window.innerHeight
          minX = Math.min(minX, sx)
          maxX = Math.max(maxX, sx)
          minY = Math.min(minY, sy)
          maxY = Math.max(maxY, sy)
        }
        ;(window as any).__herBox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
        ;(window as any).__herPoint = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
      }
    }

    const a = 1 - Math.pow(cam.damping, dt)

    // 1) 由履历锚点（文档坐标）算连续索引 s：
    //    顶部 s≈-1，sysu 居中 s=0，hotsar=1 … zooop=4
    if (!anchorEls.current) {
      anchorEls.current = POINTS.map((n) => document.querySelector(`[data-point="${n}"]`))
    }
    const els = anchorEls.current
    // 节点停顿：对每段滚动做停顿重映射——靠近某节点的一段滚动里 s 保持不变（停顿），
    // 段中部快速过渡到下一节点。只改"滚动→s"的节奏，glb 动画仍是 s 的线性函数。
    const d = THREE.MathUtils.clamp(cam.dwell, 0, 0.49)
    const dwell = (t: number) => {
      if (d <= 0) return t
      if (t < d) return 0
      if (t > 1 - d) return 1
      return THREE.MathUtils.smoothstep((t - d) / (1 - 2 * d), 0, 1)
    }
    let sTarget = THREE.MathUtils.clamp(frameSmooth.current / FRAMES_PER_NODE - 1, -1, M - 1)
    if (els && els.length === M && els.every(Boolean)) {
      // ⚠️ 网站1 接在前面之后，这里的坐标必须整体搬回「网站2 自己的坐标」——
      //    否则在网站1 里滚的那 720vh 就已经把这套 s（连续节点索引）推过大半，
      //    人还没滑到简历站，机位已经跑到履历节点上去了。
      //    （site1/anchor.ts 把这层修正集中在一处，别在这里另写一套。）
      const H1 = getSite1Height()
      const sy = Math.max(0, window.scrollY - H1)
      // 参考线在视口 NODE_LINE 高度；锚点用条目顶部（文字位置，不含底部大 padding）
      const refLine = sy + window.innerHeight * NODE_LINE
      const tops = els.map((el: any) => el.getBoundingClientRect().top + window.scrollY - H1)
      if (refLine <= tops[0]) {
        // 顶部 → sysu 的渐入段：网站2 自己的 scrollY=0 时 s=-1（第 0 帧），sysu 到达参考线时 s=0
        const heroScroll = Math.max(1, tops[0] - window.innerHeight * NODE_LINE)
        sTarget = -1 + dwell(THREE.MathUtils.clamp(sy / heroScroll, 0, 1))
      } else if (refLine >= tops[M - 1]) {
        sTarget = M - 1
      } else {
        for (let i = 0; i < M - 1; i++) {
          if (refLine <= tops[i + 1]) {
            const t = (refLine - tops[i]) / Math.max(1, tops[i + 1] - tops[i])
            sTarget = i + dwell(t)
            break
          }
        }
      }
    }
    // 2) 帧驱动：先算"目标帧"（履历/作品统一，交界处两侧都是 RESUME_FRAMES → 连续），
    //    再对最终帧做一次缓动——避免之前"平滑 s + 直读 rectTop"两路径不一致导致的瞬跳。
    //    履历区 0–RESUME_FRAMES（节点 i→(i+1)·50）；作品区 = 入场（屏幕滑入）+ 首板块横移，直到末帧
    let frameTarget = THREE.MathUtils.clamp((sTarget + 1) * FRAMES_PER_NODE, 0, RESUME_FRAMES)
    let inWorks = false
    if (!galleryEl.current) galleryEl.current = document.querySelector('.wk-gallery')
    if (galleryEl.current) {
      const ih = window.innerHeight
      const rectTop = galleryEl.current.getBoundingClientRect().top
      const range = Math.max(0, galleryEl.current.offsetHeight - ih)
      if (rectTop < ih) {
        inWorks = true
        // 入场段结束帧（作品屏幕完全覆盖时）：履历末尾 + 入场帧数，钳到总帧
        const entranceEnd = Math.min(RESUME_FRAMES + WORKS_ENTRANCE, totalFrames)
        if (rectTop > 0) {
          // 作品屏幕从底部(rectTop=ih)滑到完全覆盖(rectTop=0)：入场帧段
          const pA = THREE.MathUtils.clamp(1 - rectTop / ih, 0, 1)
          frameTarget = RESUME_FRAMES + (entranceEnd - RESUME_FRAMES) * pA
        } else {
          // 已钉住，首板块水平移入（前一整屏 100vw 横移）：入场结束 → 末帧，之后定格末帧
          // 竖滚与横移 1:1（px）；横移 100vw = innerWidth px
          const scrolled = THREE.MathUtils.clamp(-rectTop, 0, range)
          const pB = THREE.MathUtils.clamp(scrolled / window.innerWidth, 0, 1)
          frameTarget = entranceEnd + (totalFrames - entranceEnd) * pB
        }
      }
    }
    // 缓动程度随目标帧过渡：≤RESUME_FRAMES 正常平滑；入场段渐关；入场后 a=1（直接跟手、无 smooth）
    const smoothOff = THREE.MathUtils.smoothstep(frameTarget, RESUME_FRAMES, RESUME_FRAMES + WORKS_ENTRANCE)
    const aEff = THREE.MathUtils.lerp(a, 1, smoothOff)
    frameSmooth.current += (frameTarget - frameSmooth.current) * aEff
    const frame = frameSmooth.current
    // 所有 clip 共享时间轴：time = frame/FPS，各自钳到自身时长
    // （较短的 clip 播完后保持末帧，相机 clip CameraAction 走满 totalFrames）
    if (actions.current.length) {
      const t = frame / FPS
      for (const { action: act, duration } of actions.current) {
        act.time = Math.min(t, duration)
      }
      mixer.update(0)
    }
    if (frameRef) frameRef.current = frame

    // 履历段用于对焦的连续索引：由平滑后的帧反推，确保对焦与镜头同步
    const s = THREE.MathUtils.clamp(frame / FRAMES_PER_NODE - 1, -1, M - 1)

    // 相机基准机位有两个来源：glb 自带相机动画（原版 me.glb），或镜头导演按帧算（本项目模型）。
    const useGlbCam = !!glbCam

    // 3) 自动对焦：作品区跟随 glb focus-works 空对象；履历区按 focus 锚点插值
    //    （在 mixer.update 之后取世界坐标，保证与当前帧一致）
    //    走镜头导演时，对焦点由机位自己给出（见 2b），这里不参与。
    if (focusRef && useGlbCam) {
      if (inWorks && focusNode) {
        focusNode.getWorldPosition(focusRef.current)
      } else if (s < 0 && startPoint && points[0]) {
        startPoint.getWorldPosition(posA.current)
        points[0].getWorldPosition(posB.current)
        focusRef.current.lerpVectors(posA.current, posB.current, THREE.MathUtils.clamp(s + 1, 0, 1))
      } else {
        const sc = THREE.MathUtils.clamp(s, 0, M - 1)
        const iA = Math.floor(sc)
        const iB = Math.min(iA + 1, M - 1)
        const f = sc - iA
        if (points[iA] && points[iB]) {
          points[iA].getWorldPosition(posA.current)
          points[iB].getWorldPosition(posB.current)
          focusRef.current.lerpVectors(posA.current, posB.current, f)
        }
      }
    }

    // 3b) 景深：glb 带逐锚点参数（intro3d 导出）时，沿当前连续索引在相邻锚点间插值 bokeh/focusRange，
    //     写入 refs 供 Post2 直接采用（忠实还原 intro3d）；无参数（老 glb）则写哨兵 -1 → Post2 走原全局帧混合。
    if (dofBokehRef && dofRangeRef) {
      if (!dof.has) {
        dofBokehRef.current = -1
      } else {
        const sample = (arr: number[], sv: number, wv: number): number => {
          if (inWorks) return wv
          if (s < 0) return THREE.MathUtils.lerp(sv, arr[0] ?? sv, THREE.MathUtils.clamp(s + 1, 0, 1))
          const sc = THREE.MathUtils.clamp(s, 0, M - 1)
          const iA = Math.floor(sc)
          const iB = Math.min(iA + 1, M - 1)
          return THREE.MathUtils.lerp(arr[iA] ?? 0, arr[iB] ?? 0, sc - iA)
        }
        dofBokehRef.current = sample(dof.bokeh, dof.startBokeh, dof.worksBokeh)
        // focusRange 按模型缩放折算到世界单位（scene 被放大 norm.scale 倍，清晰范围需同比放大才与 intro3d 观感一致）。
        dofRangeRef.current = sample(dof.range, dof.startRange, dof.worksRange) * norm.scale
      }
    }

    // 2b) 相机：先定「基准机位」（写进 camPos / camQuat / camFov），
    //     再统一叠「绕焦点的轨道式鼠标视差」——焦点在屏幕上不动，只有四周产生视差。
    //     基准机位的来源：glb 自带相机动画（原版），或镜头导演按帧插值（本项目模型没有相机）。
    const camera: any = get().camera
    let camFov = camera.fov
    let hasBase = false
    let dbgP = -1
    let lateralShift = 0 // 横向重新构图：把人物推离画面中心（单位=画面宽度的比例）

    if (glbCam && camera.isPerspectiveCamera) {
      glbCam.updateWorldMatrix(true, false)
      glbCam.matrixWorld.decompose(camPos.current, camQuat.current, camScl.current)
      camFov = glbCam.fov
      hasBase = true
    } else if (camera.isPerspectiveCamera) {
      // 连续镜头索引 p：0 = 首屏；k = 第 k 个履历节点（k = 1…M）；M+1 = 作品区
      const p =
        frame <= RESUME_FRAMES
          ? frame / FRAMES_PER_NODE
          : M + (totalFrames > RESUME_FRAMES ? (frame - RESUME_FRAMES) / (totalFrames - RESUME_FRAMES) : 0)
      dbgP = p
      const shot = lerpShot(p)
      const H = RIG_HEIGHT
      const fx = shot.focusX * H // 焦点：人物身上被注视的那个点，同时也是景深对焦处
      const fy = shot.focusY * H
      const r = shot.dist * H // 相机到焦点的距离
      const az = (shot.azimuth * Math.PI) / 180
      const el = (shot.elevation * Math.PI) / 180
      const ce = Math.cos(el)
      camPos.current.set(fx + r * ce * Math.sin(az), fy + r * Math.sin(el), r * ce * Math.cos(az))
      focusRef.current.set(fx, fy, 0)
      lookM.current.lookAt(camPos.current, focusRef.current, WORLD_UP)
      camQuat.current.setFromRotationMatrix(lookM.current)
      camFov = shot.fov
      lateralShift = shot.shiftX
      hasBase = true
    }

    if (hasBase) {
      // 鼠标缓动：无限趋近目标值
      const me = 1 - Math.pow(cam.parallaxEase, dt)
      smouse.current.x += (mouse.current.x - smouse.current.x) * me
      smouse.current.y += (mouse.current.y - smouse.current.y) * me
      const ax = THREE.MathUtils.degToRad(cam.parallax)
      paraEuler.current.set(-smouse.current.y * ax, -smouse.current.x * ax, 0)
      paraQuat.current.setFromEuler(paraEuler.current)
      // 绕焦点旋转相机位置 + 同步旋转朝向 → 焦点不动，仅四周产生视差
      tmpVec.current
        .copy(camPos.current)
        .sub(focusRef.current)
        .applyQuaternion(paraQuat.current)
      // 移动端沿「焦点→相机」方向整体拉远：焦点屏幕位置不变，主体更小、留白更多
      if (isMobile.current) tmpVec.current.multiplyScalar(cam.mobilePullback)
      tmpVec.current.add(focusRef.current)
      camera.position.copy(tmpVec.current)
      camera.quaternion.multiplyQuaternions(paraQuat.current, camQuat.current)
      // 移动端「时间轴阶段」把镜头整体左移，让主体从满宽文字后错开。
      // 权重：从 Hero 渐入(s: -0.8→0.3)、进入作品区随 smoothOff 渐出 → 无跳变。
      if (isMobile.current && cam.mobileTimelineShift !== 0) {
        const tlWeight = THREE.MathUtils.smoothstep(s, -0.8, 0.3) * (1 - smoothOff)
        if (tlWeight > 0) {
          // translateX 沿局部 +X（屏幕右）；取负 → 相机左移
          const dist = camera.position.distanceTo(focusRef.current)
          camera.translateX(-dist * cam.mobileTimelineShift * tlWeight)
        }
      }
      if (camera.fov !== camFov) {
        camera.fov = camFov
        camera.updateProjectionMatrix()
      }
      // 横向重新构图：把相机沿自身右方向平移，人物就挪到画面另一侧（履历区让人物让开右侧文字）。
      // 平移量按「焦点处画面宽度」折算，所以换分辨率 / 换焦距观感一致。
      if (lateralShift !== 0) {
        const dist = camera.position.distanceTo(focusRef.current)
        const visH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
        camera.translateX(lateralShift * visH * camera.aspect)
      }

      // 2c) 景深对焦面：把对焦点从「人体中轴 (fx, fy, 0)」挪到相机视线真正打到的**表面**上。
      //     为什么必须挪：postprocessing 的 CoC 是
      //         magnitude = smoothstep(0, focusRange, |线性深度 − focusDistance|)
      //     也就是说 focusRange 是「**虚化饱和**距离」，不是「清晰带宽」——离焦面 0.4 就糊满。
      //     中轴对焦时，脸/胸表面比焦点近约 0.25（这个模型 z∈[−0.29,+0.29]），
      //     smoothstep(0, 0.4, 0.25)=0.79 → 「脸部特写」那一站整张脸和贴纸全糊了。
      //     ⚠️ 性能：主网格 75k 面、无 BVH，一次 intersectObject 实测 ~12ms。
      //     第一版写成「相机动过就打」，等于滚动时每帧都吃 12ms，直接把帧率打掉一半。
      //     改成**双重节流**：距上次至少 10 帧、且相机确实走了 >0.1 单位才重打
      //     → 摊到每帧 ~1ms，画面静止时零开销。对焦面本身变化很慢，肉眼无感。
      if (focusSurfaceRef && mainMesh) {
        const dr = dofRay.current
        const sinceRay = Math.abs(frame - dr.frame)
        const moved = dr.cam.distanceToSquared(camera.position) > 0.01
        if (sinceRay >= 10 && (moved || dr.frame === 0)) {
          mainMesh.updateWorldMatrix(true, false)
          dr.frame = frame
          dr.cam.copy(camera.position)
          dr.dir.copy(focusRef.current).sub(camera.position)
          const len = dr.dir.length()
          if (len > 1e-6) {
            dr.dir.multiplyScalar(1 / len)
            dr.rc.set(camera.position, dr.dir)
            dr.rc.far = len * 1.5
            const hits = dr.rc.intersectObject(mainMesh, true)
            if (hits.length) focusSurfaceRef.current.copy(hits[0].point)
            else focusSurfaceRef.current.copy(focusRef.current)
            dr.n++
            if (import.meta.env.DEV) (window as any).__dofRays = dr.n
          }
        }
      }

      if (import.meta.env.DEV) {
        ;(window as any).__rig = {
          frames: { frame: +frame.toFixed(1), total: totalFrames, resume: RESUME_FRAMES },
          shotP: +dbgP.toFixed(3),
          modelH: +norm.h.toFixed(4),
          scale: +norm.scale.toFixed(4),
          fov: camera.fov,
          camPos: camera.position.toArray().map((v: number) => +v.toFixed(3)),
          focus: focusRef.current.toArray().map((v: number) => +v.toFixed(3)),
          // 景深实际对焦面 + 射线累计次数（验证「对焦到表面」与节流是否生效）
          focusSurf: focusSurfaceRef
            ? focusSurfaceRef.current.toArray().map((v: number) => +v.toFixed(3))
            : null,
          dofRays: dofRay.current.n,
        }
        // 世界坐标 → 屏幕像素（调试用：把坐标网格叠到截图上核对贴纸落点）
        ;(window as any).__proj = (x: number, y: number, z = 0) => {
          const v = new THREE.Vector3(x, y, z).project(camera)
          return [
            +(((v.x + 1) / 2) * window.innerWidth).toFixed(1),
            +(((1 - v.y) / 2) * window.innerHeight).toFixed(1),
          ]
        }
        // 屏幕像素 → 世界坐标（调试用：在截图上指一个点，问"这里在模型上的世界坐标是多少"）。
        // 用来给测地距离选种子点 —— 光看截图猜坐标会猜错（已经踩过一次：把手心的位置
        // 猜成了裤子口袋）。命中点法线也一并返回，方便判断是正面还是侧面。
        ;(window as any).__pick = (px: number, py: number) => {
          const ndc = new THREE.Vector2(
            (px / window.innerWidth) * 2 - 1,
            -((py / window.innerHeight) * 2 - 1),
          )
          const rc = new THREE.Raycaster()
          rc.setFromCamera(ndc, camera)
          const hits = rc.intersectObject(mainMesh, true)
          if (!hits.length) return null
          const h = hits[0]
          const n = h.face
            ? h.face.normal
                .clone()
                .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mainMesh.matrixWorld))
                .normalize()
            : null
          return {
            hit: [+h.point.x.toFixed(4), +h.point.y.toFixed(4), +h.point.z.toFixed(4)],
            n: n ? [+n.x.toFixed(3), +n.y.toFixed(3), +n.z.toFixed(3)] : null,
            dist: +h.distance.toFixed(3),
            uv: h.uv ? [+h.uv.x.toFixed(4), +h.uv.y.toFixed(4)] : null,
          }
        }
        // 任意射线（世界坐标 → 世界命中点 + 世界法线）。
        // __pick 只能从相机出发，量不了"从头顶往下打"这种射线 ——
        // 而"给她加个配件"这类活儿恰恰需要知道头顶的**三维形状**（哪块高、哪里是后脑勺），
        // 光靠屏幕轮廓量不出来（正视图把前后关系压平了）。
        ;(window as any).__cast = (o: number[], d: number[], all = false) => {
          const rc = new THREE.Raycaster(
            new THREE.Vector3(o[0], o[1], o[2]),
            new THREE.Vector3(d[0], d[1], d[2]).normalize(),
          )
          const hits = rc.intersectObject(mainMesh, true)
          if (!hits.length) return null
          const convert = (h: THREE.Intersection) => ({
            hit: [+h.point.x.toFixed(4), +h.point.y.toFixed(4), +h.point.z.toFixed(4)],
            n: h.face
              ? [
                  +h.face.normal
                    .clone()
                    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mainMesh.matrixWorld))
                    .normalize()
                    .x.toFixed(3),
                  +h.face.normal
                    .clone()
                    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mainMesh.matrixWorld))
                    .normalize()
                    .y.toFixed(3),
                  +h.face.normal
                    .clone()
                    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mainMesh.matrixWorld))
                    .normalize()
                    .z.toFixed(3),
                ]
              : null,
            dist: +h.distance.toFixed(4),
            uv: h.uv ? [+h.uv.x.toFixed(4), +h.uv.y.toFixed(4)] : null,
            name: h.object.name || '(unnamed)',
          })
          // all=true 时返回该射线命中的**全部**交点（近→远）——
          // 判断"配件有没有插进模型里"要看串起来的每一层，只看第一层会漏掉穿插。
          return all ? hits.map(convert) : convert(hits[0])
        }
      }
    }

    // 3.5) 身体待机微动：呼吸 + 重心微摆。
    //      和鼠标无关、也和触屏判定无关，所以刻意放在头部那块**外面** ——
    //      手机上转不了头，人也不该是根木头。
    //      每个分量都叠一个"泛音"：呼吸 1.75rad/s（≈3.6s）配 2.31 倍泛音，
    //      微摆 0.95rad/s（≈6.6s）配 0.47 倍泛音，前后方向再换一个相位与频率比。
    //      几个基频互不成整数比 → 合成周期极长，盯着看也不会觉得在循环。
    if (IDLE.enabled && head && head.uniforms.uIdleAmp.value > 0) {
      idleT.current += Math.min(dt, 0.1) // 切回前台时 dt 会很大，夹一下防止相位突跳
      const t = idleT.current
      const sw = IDLE.swayW
      head.uniforms.uIdlePhase.value.set(
        Math.sin(t * IDLE.breathW) + 0.16 * Math.sin(t * IDLE.breathW * 2.31 + 0.7),
        0.62 * Math.sin(t * sw) + 0.38 * Math.sin(t * sw * 0.47 + 1.9),
        0.5 * Math.sin(t * sw * 1.27 + 0.9) + 0.5 * Math.sin(t * sw * 2.13),
      )
    }

    // 3.6) 点击挥手 + 微笑：把「抬手包络 / 摆动 / 笑的程度」算成 uniform，喂给顶点着色器。
    //      整段只在 uWaveW>0（权重文件已就位）时才会动 —— 否则挥手会作用在"默认 0 权重"上。
    const WS = waveState.current
    if (head && WAVE.enabled && head.uniforms.uWaveW.value > 0) {
      const T = WAVE
      const total = T.durUp + T.durHold + T.durDown
      let env = 0 // 抬手包络 0..1（乘在"抬起来"那份位移上）
      let wob = 0 // 摆动 -1..1（乘在左右摆幅上）
      let smile = 0 // 笑的程度 0..1
      let wink = 0 // 闭眼程度 0..1（单眼 wink）
      let t = waveT.current
      if (t >= 0) {
        t = Math.min(t + Math.min(dt, 0.05), total + 0.001)
        waveT.current = t
        // 眨眼自己一条时间线：留一拍 → 快速闭合 → 保持 → 柔和睁开。
        if (t >= T.winkDelay) {
          if (t < T.winkDelay + T.winkClose) {
            // ease-out：闭眼要快（真眨眼 0.1~0.15 秒），起手慢就没那一下"闪"的感觉
            wink = 1 - Math.pow(1 - (t - T.winkDelay) / T.winkClose, 2)
          } else if (t < T.winkDelay + T.winkClose + T.winkHold) {
            wink = 1
          } else if (t < T.winkDelay + T.winkClose + T.winkHold + T.winkOpen) {
            const p = (t - T.winkDelay - T.winkClose - T.winkHold) / T.winkOpen
            wink = 1 - p * p * (3 - 2 * p) // smoothstep：睁眼要柔
          }
        }
        if (t < T.durUp) {
          // 抬手：ease-out（起步快、到顶收住）—— 用了 ease-in 会显得手很重
          const p = t / T.durUp
          env = 1 - Math.pow(1 - p, 3)
          smile = 1 - Math.pow(1 - p, 2)
        } else if (t < T.durUp + T.durHold) {
          env = 1
          smile = 1
          // 摆动相位从"抬手结束"起算，所以每次点击的节奏完全一致；
          // 最后 0.4 秒摆动幅度收小，免得放下时手还在甩。
          const fade = THREE.MathUtils.clamp((T.durUp + T.durHold - t) / 0.4, 0, 1)
          wob = Math.sin((t - T.durUp) * Math.PI * 2 * T.wobbleHz) * fade
        } else {
          const p = THREE.MathUtils.clamp((t - T.durUp - T.durHold) / T.durDown, 0, 1)
          const k = p * p * (3 - 2 * p) // smoothstep：放下要柔
          env = 1 - k
          smile = 1 - k
          wob = Math.sin((t - T.durUp) * Math.PI * 2 * T.wobbleHz) * 0.25 * (1 - p)
        }
        if (t >= total) {
          env = 0
          smile = 0
          wob = 0
          waveT.current = -1
        }
      }
      // 先把 override 应用到走完时间线的值上，再写进 uniform / state
      if (poseOverride.current) {
        smile = poseOverride.current.smile
        wink = poseOverride.current.wink
      }
      WS.env = env
      WS.smile = smile
      WS.wink = wink

      // 位移 = 世界方向 × 位移量，再折到网格局部空间。
      // uIdleSide / uAxis 正好就是「世界 +X / 世界 +Y 在局部空间的方向」（旋转部分已经算好），
      // 直接用它们拼出这一帧的平移向量 —— 和转头、待机微摆同一套换算，不依赖模型朝向。
      head.uniforms.uWaveMove.value
        .copy(head.uniforms.uIdleSide.value)
        .multiplyScalar((T.lift[0] * env + T.swing * wob) * norm.h)
        .addScaledVector(head.uniforms.uAxis.value, T.lift[1] * env * norm.h)
      head.uniforms.uSmile.value = smile
      head.uniforms.uWink.value = wink
    } else if (WS.env !== 0 || WS.smile !== 0 || WS.wink !== 0) {
      WS.env = 0
      WS.smile = 0
      WS.wink = 0
      if (head) {
        head.uniforms.uSmile.value = 0
        head.uniforms.uWink.value = 0
      }
    }
    if (import.meta.env.DEV) {
      // 皮肤上色的档位。patched=false 表示片段没注入进去 —— 那和"参数不对"现象一样，
      // 但成因完全不同，所以单独拆出来暴露。
      ;(window as any).__skin = {
        patched: skin.state.patched,
        mul: skin.mul.toArray().map((v: number) => +v.toFixed(3)),
        amt: skin.amt,
        spec: skin.spec,
        enabled: SKIN.enabled,
      }
      ;(window as any).__wave = {
        t: +waveT.current.toFixed(3),
        env: +WS.env.toFixed(3),
        smile: +WS.smile.toFixed(3),
        wink: +WS.wink.toFixed(3),
        // 这一帧的实际平移量（局部单位，= 占身高比例 × h），换算成"占身高比例"看
        move: head ? +(head.uniforms.uWaveMove.value.length() / norm.h).toFixed(4) : 0,
        ready: !!(window as any).__waveReady,
        // 条件拆开暴露：分不清"没生效"和"生效了但看不出来"的时候，一眼就能定位
        hasHead: !!head,
        uWaveW: head ? head.uniforms.uWaveW.value : -1,
        uSmile: head ? head.uniforms.uSmile.value : -1,
        uWink: head ? head.uniforms.uWink.value : -1,
        // 真实世界位移（原始属性单位 × worldPerRaw）。上面那个 move 是"× norm.h"的单位，
        // 和注释里的"世界单位"差 1.53 倍，看数字时容易误判。
        moveW: head ? +(head.uniforms.uWaveMove.value.length() * head.worldPerRaw).toFixed(4) : 0,
      }
      // 测试钩子：不用去截图上找人物像素，直接触发一次挥手
      ;(window as any).__doWave = () => {
        waveT.current = 0
      }
      // 测试钩子：把挥手"定格"到指定时刻（t 秒）。headless 只有 2~3fps，
      // 靠等待采样会采不到想要的相位 —— 直接把时间拨过去，采到的一定是那一刻。
      ;(window as any).__waveAt = (t: number) => {
        waveT.current = t
      }
      // 调试钩子：把表情钉在指定值（null = 取消）。用于**同姿态**的 A/B：
      // 挥手停住时 env 不变 → 头不转 → 两张图只差表情。
      ;(window as any).__pose = (sm: number | null, wk = 0) => {
        poseOverride.current = sm === null ? null : { smile: sm, wink: wk }
      }
      // 探针：世界坐标 → 屏幕像素（左上角为原点，和截图坐标一致）。
      // 为什么必须有它：要判断"嘴中心配得对不对"，只能在**渲染出来的那张图**上量唇色范围，
      // 而那是在像素空间；光有世界坐标没法对账 —— 中间隔着相机、透视、DPR。
      // 有了这个钩子，就能拿「着色器认为的嘴中心」和「图上量出来的唇中心」直接比。
      ;(window as any).__px = (world: number[] | THREE.Vector3) => {
        const v = Array.isArray(world) ? new THREE.Vector3(world[0], world[1], world[2]) : world.clone()
        camera.updateMatrixWorld()
        v.project(camera)
        // 用 CSS 像素（= 截图像素）：canvas 的 backing store 可能被 DPR 放大，
        // 而 page.screenshot 给的是 CSS 像素，两边对不上就会白量一通。
        return [
          +((v.x * 0.5 + 0.5) * size.width).toFixed(1),
          +((-v.y * 0.5 + 0.5) * size.height).toFixed(1),
        ]
      }
      // 探针：把「着色器实际拿到的局部坐标」还原回世界坐标打出来。
      // 为什么需要它：toLocal(frac) 用的是 Vector3(frac * h).applyMatrix4(inv)，
      // 而 h 是**模型自然身高**（这个模型 = 1.174），并不是世界身高（2.6）。
      // 光看代码推不出"到底落在脸上哪个位置"，只能把两个空间都打出来对。
      ;(window as any).__probe = () => {
        if (!head || !mainMesh) return null
        const mw = mainMesh.matrixWorld
        const toWorld = (v: THREE.Vector3) => {
          const w = v.clone().applyMatrix4(mw)
          return [+w.x.toFixed(4), +w.y.toFixed(4), +w.z.toFixed(4)]
        }
        const U = head.uniforms
        const dirWorld = (v: THREE.Vector3) =>
          [+v.clone().applyMatrix4(new THREE.Matrix4().extractRotation(mw)).normalize().x.toFixed(3),
           +v.clone().applyMatrix4(new THREE.Matrix4().extractRotation(mw)).normalize().y.toFixed(3),
           +v.clone().applyMatrix4(new THREE.Matrix4().extractRotation(mw)).normalize().z.toFixed(3)]
        // 顶点属性自己的世界包围盒（对照用）
        const pos = mainMesh.geometry.getAttribute('position')
        const bb = new THREE.Box3()
        for (let i = 0; i < pos.count; i += 97) bb.expandByPoint(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)))
        return {
          h: +norm.h.toFixed(4),
          scale: +norm.scale.toFixed(4),
          // 局部（= 着色器里 position 所在的空间）
          local: {
            mouth: U.uMouthPos.value.toArray().map((v: number) => +v.toFixed(4)),
            wink: U.uWinkPos.value.toArray().map((v: number) => +v.toFixed(4)),
            smileR: +U.uSmileR.value.toFixed(4),
            winkHalf: +U.uWinkHalf.value.toFixed(4),
            winkR: +U.uWinkR.value.toFixed(4),
            winkRx: +U.uWinkRx.value.toFixed(4),
          },
          // 局部坐标换算回世界，才是"到底在脸上哪儿"
          world: { mouth: toWorld(U.uMouthPos.value), wink: toWorld(U.uWinkPos.value) },
          // 目标（世界坐标，占身高比例空间）
          want: { mouth: WAVE.mouth, wink: [WAVE.eyeWink[0], WAVE.eyeWink[1]] },
          rawBBox: {
            min: bb.min.toArray().map((v: number) => +v.toFixed(3)),
            max: bb.max.toArray().map((v: number) => +v.toFixed(3)),
          },
          dirs: { axis: dirWorld(U.uAxis.value), side: dirWorld(U.uSmileDx.value) },
          uWink: +U.uWink.value.toFixed(3),
          // 顶点密度：顶点着色器只能移动**已经存在的顶点**。
          // 窗口里没几个点的话，窗口再准、幅度再大也只是把那两三个点拽歪（出硬折角），
          // 而不会把「画在贴图上的嘴」弯成笑嘴 —— 这是判断"还能不能靠调参救"的唯一依据。
          vCount: (() => {
            const rel = (i: number, o: THREE.Vector3) => {
              const d = new THREE.Vector3(pos.getX(i) - o.x, pos.getY(i) - o.y, pos.getZ(i) - o.z)
              return { up: d.dot(U.uAxis.value), side: d.dot(U.uSmileDx.value) }
            }
            let mouth = 0, eye = 0
            for (let i = 0; i < pos.count; i++) {
              const m = rel(i, U.uMouthPos.value)
              if (Math.hypot(m.side, m.up) <= U.uSmileR.value) mouth++
              const e = rel(i, U.uWinkPos.value)
              if (Math.abs(e.side) <= U.uWinkRx.value && Math.abs(e.up) <= U.uWinkR.value) eye++
            }
            return { mouth, eye, total: pos.count }
          })(),
        }
      }
    }

    // 4) 头部跟随鼠标
    //    屏幕空间做法：量出「头部投影到屏幕的位置」，光标相对它偏多少，头就转多少。
    //    这样在任何机位角度（正面 / 侧面 / 特写）都成立，不用去换算世界空间朝向。
    //    触屏设备没有 hover，跳过（判定用 hasPointer，不用 isMobile ——
    //    窄窗口下鼠标依然可用，不能因为窗口窄就不跟随）。
    if (HEAD.enabled && head && hasPointer.current) {
      // 权重：首屏(About) 满幅 → 履历区 timelineWeight → 作品区 worksWeight。
      // ⚠️ 这里原来写的是 `... * (1 - smoothOff)`，等于作品区权重恒为 0。
      // 旧注释假设"作品区画廊覆盖满屏、看不到人"，但实测（_shots/wk_1440_5000_L.png）
      // 人物一直完整显示在左半边、画廊只占右半屏 —— 于是页面最后 ~45% 的滚动区间里
      // 转头是彻底死的，用户表现就是"不跟着鼠标转"。改成按 smoothOff 混到 worksWeight。
      const heroW = 1 - THREE.MathUtils.smoothstep(s, -0.9, -0.1)
      const baseW = THREE.MathUtils.lerp(HEAD.timelineWeight, HEAD.heroWeight, heroW)
      const w = THREE.MathUtils.lerp(baseW, HEAD.worksWeight, smoothOff)

      // 头部参考点投影到屏幕（NDC）。Camera.updateMatrixWorld 会顺带刷新 matrixWorldInverse，
      // 保证用的是「本帧刚设好的」机位，而不是上一帧的。
      camera.updateMatrixWorld()
      headNDC.current.set(0, HEAD.refFrac * RIG_HEIGHT, 0).project(camera)
      const dx = mouse.current.x - headNDC.current.x
      const dy = mouse.current.y - headNDC.current.y
      // 按「光标再走多远才到屏幕边缘」归一化：头部不在画面正中时（首屏在偏上、
      // 侧面镜头在偏左），上下左右的行程才一致，不会有一侧刚动就打满、另一侧推不动。
      const rangeX = dx >= 0 ? 1 - headNDC.current.x : 1 + headNDC.current.x
      const rangeY = dy >= 0 ? 1 - headNDC.current.y : 1 + headNDC.current.y
      const tx = THREE.MathUtils.clamp(dx / Math.max(1e-3, rangeX * HEAD.edge), -1, 1)
      const ty = THREE.MathUtils.clamp(dy / Math.max(1e-3, rangeY * HEAD.edge), -1, 1)
      // 挥手时额外"朝抬手那一侧偏头"——人挥手时会看着对方/看着自己的手，
      // 只抬手不转头会显得像机械臂。幅度小（9°），叠加在鼠标跟随之上。
      const waveAdd = THREE.MathUtils.degToRad(WAVE.headYaw * WS.env)
      const yawTarget = tx * THREE.MathUtils.degToRad(HEAD.maxYaw) + waveAdd
      const pitchTarget = ty * THREE.MathUtils.degToRad(HEAD.maxPitch)

      const eh = 1 - Math.pow(HEAD.ease, dt)
      headAng.current.x += (yawTarget - headAng.current.x) * eh
      headAng.current.y += (pitchTarget - headAng.current.y) * eh

      // 世界空间旋转：绕世界竖直轴偏航（左右看）+ 绕相机右轴俯仰（上下看）。
      // 相机无 roll，所以它的局部 X 轴就是水平右方向，俯仰轴取它最稳。
      headRight.current.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize()
      headQ1.current.setFromAxisAngle(WORLD_UP, headAng.current.x)
      headQ2.current.setFromAxisAngle(headRight.current, -headAng.current.y)
      headQ1.current.multiply(headQ2.current)
      // 挥手时再歪一下头（绕相机视线方向滚转）——"歪头 + 挥手"是打招呼的固定搭配
      if (WS.env > 0) {
        headFwd.current.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize()
        headQ3.current.setFromAxisAngle(headFwd.current, THREE.MathUtils.degToRad(WAVE.headRoll * WS.env))
        headQ1.current.premultiply(headQ3.current)
      }

      // 世界旋转 → 局部旋转：R_local = M⁻¹ · R · M（M = 网格 local→world 的旋转部分）
      headM1.current.makeRotationFromQuaternion(headQ1.current)
      headM2.current.multiplyMatrices(head.rotInv, headM1.current)
      headM1.current.multiplyMatrices(headM2.current, head.rotOnly)
      head.uniforms.uHeadRot.value.setFromMatrix4(headM1.current)
      head.uniforms.uHeadWeight.value = w

      if (import.meta.env.DEV) {
        ;(window as any).__head = {
          w: +w.toFixed(3),
          pointer: hasPointer.current,
          yaw: +THREE.MathUtils.radToDeg(headAng.current.x).toFixed(2),
          pitch: +THREE.MathUtils.radToDeg(headAng.current.y).toFixed(2),
          mouse: [+mouse.current.x.toFixed(3), +mouse.current.y.toFixed(3)],
          headNDC: [+headNDC.current.x.toFixed(3), +headNDC.current.y.toFixed(3)],
          neck: +head.uniforms.uNeck.value.toFixed(4),
          falloff: +head.uniforms.uFalloff.value.toFixed(4),
          // 待机微动：amp（局部单位）+ 当前相位，用来验证它真的在跑、以及幅度是不是想要的
          idleAmp: +head.uniforms.uIdleAmp.value.toFixed(5),
          idle: [
            +head.uniforms.uIdlePhase.value.x.toFixed(3),
            +head.uniforms.uIdlePhase.value.y.toFixed(3),
            +head.uniforms.uIdlePhase.value.z.toFixed(3),
          ],
        }
        if (HEAD_HUD) {
          updateHeadHud(
            THREE.MathUtils.radToDeg(headAng.current.x),
            THREE.MathUtils.radToDeg(headAng.current.y),
            w,
            hasPointer.current,
          )
        }
      }
    }

    // 5) 眼睛跟随（用当前激活相机做屏幕投影）；移动端 / 触屏则跳过
    if (!eye.enabled || eyes.length === 0 || !hasPointer.current) return
    const sx = eye.invertX ? -1 : 1
    const sy = eye.invertY ? -1 : 1

    let ax = 0
    let ay = 0
    for (const e of eyes) {
      e.obj.getWorldPosition(tmpVec.current).project(camera)
      ax += tmpVec.current.x
      ay += tmpVec.current.y
    }
    ax /= eyes.length
    ay /= eyes.length

    const mx = mouse.current.x - ax
    const my = mouse.current.y - ay
    const yawBase = sx * mx * THREE.MathUtils.degToRad(eye.maxYaw) * eye.gain
    const pitch = sy * -my * THREE.MathUtils.degToRad(eye.maxPitch) * eye.gain

    const dist = Math.hypot(mx, my)
    const convWeight = THREE.MathUtils.clamp(1 - dist / eye.crossRadius, 0, 1)
    const convRad = THREE.MathUtils.degToRad(eye.crossEye) * convWeight

    for (const e of eyes) {
      const yaw = yawBase - e.sx * convRad
      tmpEuler.current.set(pitch, yaw, 0)
      tmpQuat.current.setFromEuler(tmpEuler.current)
      desiredQuat.current.copy(tmpQuat.current).multiply(e.base)
      e.obj.quaternion.slerp(desiredQuat.current, eye.smooth)
    }
  })

  return (
    <>
      <group rotation={[0, (rotationY * Math.PI) / 180, 0]} scale={norm.scale}>
        <primitive object={model} />
      </group>
      {/* 首屏「Click me」提示。
          挂在这里（而不是 Scene 里）是有意的：Man2 用了 useGLTF，会 suspense ——
          所以它能被渲染出来时，模型一定已经就位，提示不会在"空场景"里先闪一下。
          地址栏加 ?nohint 可以整块关掉。 */}
      {!HINT_DISABLED && <ClickHint gone={hintGone} />}
      {/* 墨镜已移除 —— 戴上之后太抢眼，跟整站的清淡色调打架，而且把二次元脸的眉眼全挡了
          （点击 wink 的趣味也就看不见了）。要恢复：放开下面一行，并把文件顶部的
          `import Sunglasses from './Sunglasses'` 加回来，再把 `?nosun` 那个开关补回上方
          （组件仍在 scene/Sunglasses.tsx，头顶高度场反解出来的位置/倾角参数都还在，没删）。
      {!SUN_DISABLED && <Sunglasses mesh={mainMesh} head={head} />}
      */}
      {/* 腮红已移除 —— 点击的动作改成「单眼 wink + 微笑 + 挥手」，不需要脸红了。
          要恢复：放开下面三行，并把文件顶部的 `import Blush from './Blush'` 加回来
          （组件仍在 scene/Blush.tsx，`?noblush` 开关也还在，都没删）。
      <Suspense fallback={null}>
        <Blush mesh={mainMesh} head={head} state={waveState} />
      </Suspense>
      */}
      {/* 贴纸已移除。要恢复：放开下面的注释，并把文件顶部的 `import Stickers from './Stickers'` 加回来。
          （素材仍在 public/stickers/，布局在 data/stickers.ts，组件在 scene/Stickers.tsx，都没删。）
      <Suspense fallback={null}>
        <Stickers mesh={mainMesh} head={head} />
      </Suspense>
      */}
    </>
  )
}

// 后处理：DepthOfField → Bloom → SMAA。
// DoF 焦点逐帧跟随 focusRef（自动对焦）；30–220 帧间收紧清晰范围、加大虚化。
function Post2({
  focusRef,
  focusSurfaceRef,
  frameRef,
  dofBokehRef,
  dofRangeRef,
}: {
  focusRef: MutableRefObject<THREE.Vector3>
  focusSurfaceRef: MutableRefObject<THREE.Vector3>
  frameRef: MutableRefObject<number>
  dofBokehRef: MutableRefObject<number>
  dofRangeRef: MutableRefObject<number>
}) {
  // 景深档位：原版是按作者的模型调的手感。换成你的模型后如果特写糊得看不清，
  // 优先加大 focusRange（清晰范围）或降低 focusBokeh（虚化强度）。
  // Bloom 值偏低会让整块浅色背景一起"发光"→ 画面发雾。阈值必须高于背景亮度，
  // 只让真正的高光（皮肤反光、白衣、亮部）泛光；觉得不够亮就调 intensity，别降 threshold。
  const post = {
    bloomIntensity: 0.3,
    bloomThreshold: 0.92,
    dof: true,
    startBokeh: 7.4,
    startRange: 2.0,
    focusBokeh: 7.0,
    // 0.4 → 0.55：CoC 里 focusRange 是「虚化饱和距离」而不是「清晰带宽」，
    // 0.4 时离对焦面 0.25 的地方已经吃到 79% 虚化。配合下面「对焦到表面」的修正，
    // 0.55 能让五官/贴纸全清晰、同时鬓角头发与耳朵留一点点柔，接近原版特写的观感。
    focusRange: 0.55,
    startBlendFrame: 48,
    endBlendFrame: RESUME_FRAMES - 50, // 末节点附近回到"起始帧"景深档（原 250−50=200）
  }

  const dofRef = useRef<any>(null)
  useFrame(() => {
    const e = dofRef.current
    if (!e) return
    if (e.target) e.target.copy(focusSurfaceRef ? focusSurfaceRef.current : focusRef.current)
    // 权重 w=1 用"开始帧档"，w=0 用"聚焦点档"。
    // 开头(f→0)和末节点(f→RESUME_FRAMES)都取开始帧档；中间各节点取聚焦点档。
    const f = frameRef ? frameRef.current : 0
    const wStart = 1 - THREE.MathUtils.smoothstep(f, 0, post.startBlendFrame)
    const wEnd = THREE.MathUtils.smoothstep(f, post.endBlendFrame, RESUME_FRAMES)
    const w = Math.max(wStart, wEnd)
    if (dofBokehRef && dofBokehRef.current >= 0) {
      // glb 自带逐锚点景深参数（intro3d 导出）：直接采用，忠实还原 intro3d 的虚化强度/清晰范围（bokeh=0 即该点关景深）。
      e.bokehScale = dofBokehRef.current
      if (e.cocMaterial) e.cocMaterial.focusRange = Math.max(1e-4, dofRangeRef ? dofRangeRef.current : post.focusRange)
    } else {
      // 老 glb（无逐锚点参数）：沿用原全局帧混合档位。
      e.bokehScale = THREE.MathUtils.lerp(post.focusBokeh, post.startBokeh, w)
      if (e.cocMaterial) e.cocMaterial.focusRange = THREE.MathUtils.lerp(post.focusRange, post.startRange, w)
    }
  })

  return (
    <EffectComposer multisampling={0} stencilBuffer={false} depthBuffer>
      {(post.dof ? (
        <DepthOfField
          ref={dofRef}
          // 对焦点跟着「当前机位的注视点」走：每一站看哪儿就把景深对到哪儿。
          // 之前写死成 [0, 1.3, 0]（胸口），于是「脸部特写」那一站脸离对焦距离差了约 0.4，
          // 正好越过 focusRange，脸和贴纸全被虚化掉了。focusRef 是 Man2 每帧写入的那个 Vector3，
          // 原地修改 → 这里传引用即可跟随，不用额外同步。
          target={focusRef.current}
          worldFocusRange={post.focusRange}
          bokehScale={post.focusBokeh}
          height={480}
        />
      ) : null) as any}
      <Bloom
        mipmapBlur
        intensity={post.bloomIntensity}
        luminanceThreshold={post.bloomThreshold}
        luminanceSmoothing={0.3}
      />
      <SMAA />
    </EffectComposer>
  )
}

// 调参用开关：地址栏加 ?nopost 关掉景深/Bloom/SMAA，方便单独看构图和模型本身。
const NO_POST = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('nopost')

// 场景根组件：展示 me.glb（相机由 glb 动画 + 滚动驱动）
export default function Scene() {
  const focusRef = useRef(new THREE.Vector3(0, 1.3, 0))
  // 首屏「Click me」提示是否已经收起。放在这里（而不是 Man2 内部）是因为
  // 触发它的那一下点击发生在 Man2 的监听里，而提示的淡出状态要能跨渲染保留。
  const [hintGone, setHintGone] = useState(false)
  // 景深实际对焦的那个点：Man2 每帧沿「相机→注视点」打射线，取**表面**命中点写进来；
  // Post2 拿它当 DepthOfField 的 target。为什么不用 focusRef 见 Man2 里的注释。
  const focusSurfaceRef = useRef(new THREE.Vector3(0, 1.3, 0))
  const frameRef = useRef(0)
  // 逐锚点景深（intro3d 导出的 glb 携带）：Man2 每帧写、Post2 读。dofBokeh=-1 表示无参数 → Post2 走旧全局混合。
  const dofBokehRef = useRef(-1)
  const dofRangeRef = useRef(0.15)
  return (
    <>
      <GradientBackground />

      <Suspense fallback={null}>
        <Lights />
        <Man2
          focusRef={focusRef}
          focusSurfaceRef={focusSurfaceRef}
          frameRef={frameRef}
          dofBokehRef={dofBokehRef}
          dofRangeRef={dofRangeRef}
          hintGone={hintGone}
          onWaveStart={() => setHintGone(true)}
        />
      </Suspense>

      {!NO_POST && (
        <Post2
          focusRef={focusRef}
          focusSurfaceRef={focusSurfaceRef}
          frameRef={frameRef}
          dofBokehRef={dofBokehRef}
          dofRangeRef={dofRangeRef}
        />
      )}
    </>
  )
}
