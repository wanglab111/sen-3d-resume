import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

// 架在头顶的墨镜。
//
// 位置不是目测的，是从「头顶三维高度场」反解出来的：
//   _tools/sunscan.cjs   从上方竖直打射线扫出头顶点云 y_top(x,z)（含前额、后脑、左右宽度）
//   _tools/sunfit2.py    按「镜框下缘」搜倾角 × 相切点
//   _tools/sunfit3.py    再收窄到「额头正上方那一段」下缘的跨度
//   _tools/sundef.py     吐出下面这些常量（可复现，不是手抄的）
// 选定 42°：此时镜框的**上缘和下缘都只微陷 0.005~0.008**，也就是整条镜框压在发面上，
// 而不是悬在前方。更立（34°）会浮到前额外面，更躺（54°）下半圈会整个陷进头发。
//
// 为什么必须自己驱动朝向：头部是靠**顶点着色器**做刚性旋转的（模型没有骨骼），
// 新加的 3D 物件不会自己跟着转 —— 不驱动的话，鼠标一晃墨镜就留在原地、头从里面穿出去。
// 这里复用 Stickers.tsx 里那套同款公式（和着色器里那段完全一致）：
//     局部点 = meshWorld⁻¹ · 世界点
//     旋转后 = uPivot + uHeadRot · (局部点 − uPivot)
//     世界点 = meshWorld · 旋转后        朝向 = qHead · 基准朝向
// 头顶远在 uNeck 以上（权重恒为 1），所以是整体刚性旋转，不需要按高度插值。

type HeadLike = {
  uniforms: {
    uHeadRot: { value: THREE.Matrix3 }
    uPivot: { value: THREE.Vector3 }
  }
} | null

const SUN = {
  // 镜框中心（世界坐标；2.6 = 身高，和代码里其它坐标同一套）
  center: [0.025, 2.5662, 0.192] as [number, number, number],
  // 42°：法线朝上前 → 镜片朝斜上，正是"眼镜推上头顶"的样子。
  // 中线取 x=+0.025（由实测双眼中心 +0.122 / -0.0715 反推）——
  // 墨镜是对称件，挂错中线就会一边压进头发、一边翘在空中。
  normal: [0, 0.6691, 0.7431] as [number, number, number],
  up: [0, 0.7431, -0.6691] as [number, number, number],
  lensR: 0.042, // 镜片半径
  lensX: 0.052, // 镜片中心到中线的距离
  rim: 0.0072, // 镜框管半径
  lensT: 0.005, // 镜片厚度
  templeR: 0.0085,
  frame: '#96683a', // 暖琥珀（醋酸纤维框）：比头发（L≈55）亮、比背景（L≈161）暗，
  lens: '#0b0e13', // 两边都能读出轮廓；实测框 vs 头发对比 61 灰阶（>45 就很清楚）
  // 镜片压得很暗、且调低环境反射 —— 她的头发是蓝灰（RGB≈50,62,79，L≈55），
  // 镜片如果按"玻璃"那样吃满 IBL，渲染出来也是 L≈55，会和头发糊成一片（实测踩到过）。
  // 压到比头发暗 20 灰阶左右，镜片才读得出是"两片深色椭圆嵌在琥珀圈里"。
  // 镜腿控制点（世界坐标）。**左右分开给** —— 她的头发右高左低差 0.05 世界单位
  // （≈12px），用同一条曲线镜像必然一边埋进头发、一边浮在空中。
  // 每个点 = 该侧头顶表面高度 + 0.004（略微埋进去：宁可陷进头发，也别浮着）。
  temples: {
    right: [
      [0.125, 2.5662, 0.192],
      [0.161, 2.5459, 0.13],
      [0.181, 2.5388, 0.075],
      [0.191, 2.5435, 0.015],
      [0.193, 2.4875, -0.05],
      [0.185, 2.4137, -0.11],
    ],
    left: [
      [0.125, 2.5662, 0.192],
      [-0.111, 2.5573, 0.13],
      [-0.131, 2.5403, 0.075],
      [-0.141, 2.5389, 0.015],
      [-0.143, 2.529, -0.05],
      [-0.135, 2.4829, -0.11],
    ],
  },
}

export default function Sunglasses({
  mesh,
  head,
}: {
  mesh: THREE.Object3D | null
  head: HeadLike
}) {
  const group = useRef<THREE.Group>(null)

  // 基准姿态：用 (中心, 法线, 平面内上) 建一组正交基 → 局部 +Z = 镜框法线
  const base = useMemo(() => {
    const n = new THREE.Vector3(...SUN.normal).normalize()
    const u = new THREE.Vector3(...SUN.up).normalize()
    const r = new THREE.Vector3().crossVectors(u, n).normalize()
    const pos = new THREE.Vector3(...SUN.center)
    const quat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(r, u, n),
    )
    return { pos, quat, r, u, n }
  }, [])

  // 镜腿：世界坐标 → 镜框局部坐标，再串成 CatmullRom 管
  const templeGeo = useMemo(() => {
    const mk = (pts: number[][]) => {
      const local = pts.map((p) => {
        const d = new THREE.Vector3(p[0], p[1], p[2]).sub(base.pos)
        return new THREE.Vector3(d.dot(base.r), d.dot(base.u), d.dot(base.n))
      })
      // tension 0.4：控制点比较密，张力小一点才不会在折角处过冲
      const curve = new THREE.CatmullRomCurve3(local, false, 'catmullrom', 0.4)
      return new THREE.TubeGeometry(curve, 56, SUN.templeR, 10, false)
    }
    return { right: mk(SUN.temples.right), left: mk(SUN.temples.left) }
  }, [base])

  const mats = useMemo(() => {
    const frame = new THREE.MeshStandardMaterial({
      color: new THREE.Color(SUN.frame),
      roughness: 0.34,
      metalness: 0.18, // 醋酸纤维：一点点金属感让边框能吃到 IBL 的高光
      envMapIntensity: 1.1,
    })
    const lens = new THREE.MeshStandardMaterial({
      color: new THREE.Color(SUN.lens),
      roughness: 0.14, // 留一点镜面高光（看得出是"片"而不是"洞"）
      metalness: 0.0,
      envMapIntensity: 0.2, // 压住 IBL —— 吃满的话它会亮到和头发同亮度（实测 L≈55）
    })
    return { frame, lens }
  }, [])

  // 逐帧复用的临时对象（不在帧里 new，避免每帧 GC 抖动）
  const tmp = useMemo(
    () => ({
      mw: new THREE.Matrix4(),
      mwInv: new THREE.Matrix4(),
      rot: new THREE.Matrix4(),
      rotInv: new THREE.Matrix4(),
      m3r: new THREE.Matrix3(),
      m3ri: new THREE.Matrix3(),
      m3w: new THREE.Matrix3(),
      m4w: new THREE.Matrix4(),
      qHead: new THREE.Quaternion(),
      local: new THREE.Vector3(),
      rel: new THREE.Vector3(),
      vec: new THREE.Vector3(),
    }),
    [],
  )

  useFrame(() => {
    const g = group.current
    if (!g) return
    // 先摆基准姿态（模型还没就绪 / head 还没建好时，就停在这一版）
    g.position.copy(base.pos)
    g.quaternion.copy(base.quat)
    if (!mesh || !head) return

    const H = head.uniforms
    const t = tmp
    t.mw.copy(mesh.matrixWorld)
    t.mwInv.copy(t.mw).invert()
    t.rot.extractRotation(t.mw)
    t.rotInv.copy(t.rot).invert()
    // 世界空间的头旋转 = M · R_local · M⁻¹
    t.m3r.setFromMatrix4(t.rot)
    t.m3ri.setFromMatrix4(t.rotInv)
    t.m3w.copy(t.m3r).multiply(H.uHeadRot.value).multiply(t.m3ri)
    t.qHead.setFromRotationMatrix(t.m4w.setFromMatrix3(t.m3w))

    // 头部刚性旋转（和顶点着色器里那段一模一样的公式）
    t.local.copy(base.pos).applyMatrix4(t.mwInv)
    t.rel.copy(t.local).sub(H.uPivot.value)
    t.vec.copy(t.rel).applyMatrix3(H.uHeadRot.value).add(H.uPivot.value)
    g.position.copy(t.vec).applyMatrix4(t.mw)
    g.quaternion.copy(t.qHead).multiply(base.quat)

    if (import.meta.env.DEV) {
      // 诊断：__proj 投的是**基准姿态**的世界坐标，而实际渲染的墨镜会被头部旋转带走，
      // 两者对不上时靠这个看差在哪（headRot 是不是单位阵 / 枢轴在哪）。
      ;(window as any).__sun = {
        pos: [+g.position.x.toFixed(4), +g.position.y.toFixed(4), +g.position.z.toFixed(4)],
        base: [+base.pos.x.toFixed(4), +base.pos.y.toFixed(4), +base.pos.z.toFixed(4)],
        pivot: [+H.uPivot.value.x.toFixed(4), +H.uPivot.value.y.toFixed(4), +H.uPivot.value.z.toFixed(4)],
        rot: Array.from(H.uHeadRot.value.elements).map((v) => +v.toFixed(4)),
      }
    }
  })

  return (
    <group ref={group}>
      {[-1, 1].map((s) => (
        <group key={s} position={[s * SUN.lensX, 0, 0]}>
          {/* 镜框圈 */}
          <mesh material={mats.frame}>
            <torusGeometry args={[SUN.lensR, SUN.rim, 14, 56]} />
          </mesh>
          {/* 镜片：做成薄圆柱而不是平面，这样从任意角度看都有体积，
              不用 DoubleSide 也不会出现"背面露空" */}
          <mesh material={mats.lens} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry
              args={[SUN.lensR - SUN.rim * 0.2, SUN.lensR - SUN.rim * 0.2, SUN.lensT, 48]}
            />
          </mesh>
          {/* 镜腿铰链 */}
          <mesh material={mats.frame} position={[s * (SUN.lensR + 0.004), 0, 0]}>
            <boxGeometry args={[0.013, 0.011, 0.011]} />
          </mesh>
        </group>
      ))}
      {/* 鼻梁桥 */}
      <mesh material={mats.frame} position={[0, 0.009, 0]}>
        <boxGeometry args={[0.034, 0.011, SUN.rim * 1.8]} />
      </mesh>
      {/* 镜腿（世界坐标量出来的，绕着头侧往后走） */}
      <mesh geometry={templeGeo.right} material={mats.frame} />
      <mesh geometry={templeGeo.left} material={mats.frame} />
    </group>
  )
}
