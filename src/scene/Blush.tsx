import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

// 「笑着的腮红」—— 点击她挥手时，两颊淡淡地泛红（跟着笑一起淡入淡出）。
//
// 为什么只有腮红、没有"笑脸嘴巴"贴纸：
//   嘴是**顶点位移**改的（见 Scene.tsx 的 SMILE_DISPLACE）—— 直接让贴图上原本那张嘴
//   弯成笑嘴，颜色/受光/景深/头部旋转全都自动一致。再叠一张画出来的嘴只会有两个结果：
//   要么被原本的唇色顶出来（边缘露馅），要么盖住原本的嘴形成双嘴。
//   腮红不一样：它本来就是一片没有边界的柔光，用「软边渐变 + 低不透明度」叠在皮肤上，
//   和贴图里已有的腮红是同一类东西，不会像贴纸。所以只补腮红。
//
// 落点同样是**射线打上去**的（不是手填坐标）：从正前方沿 -Z 打一条射线，命中点的
// 世界法线就是平面朝向，沿法线外推 offset 防 z-fighting / 防平面在曲面上"陷边"。
// 头是**顶点着色器**转的（没有骨骼），所以每帧要按同一套公式把腮红搬一遍，
// 否则头一转腮红就滑到耳后去了（和之前贴纸的坑一模一样）。
//
// 关掉：地址栏加 `?noblush`。

const BLUSH_ENABLED =
  typeof window !== 'undefined' && !new URLSearchParams(window.location.search).has('noblush')

// 两颊的世界坐标（占身高，1 = 总高）。x 取 ±0.062：眼下方一点、避开鼻梁与头发。
// size 是贴片边长（世界单位）—— 脸宽约 0.22，0.055 ≈ 脸宽 25%，是"一眼能看出脸红"的下限。
const BLUSH = {
  size: 0.062,
  offset: 0.006,
  spots: [
    { x: -0.068, y: 2.148 },
    { x: 0.068, y: 2.148 },
  ],
}

// 程序化腮红贴图：中心淡粉、边缘完全透明（软边是关键，硬边就会像贴纸）。
function makeBlushTexture(): THREE.Texture {
  const S = 128
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  // 三层：中心很淡、中段最浓、边缘归零 —— 单一径向渐变会像"圆饼"，
  // 中间压淡一点才像血色的透出来的感觉。
  g.addColorStop(0, 'rgba(240, 120, 138, 0.34)')
  g.addColorStop(0.45, 'rgba(238, 106, 128, 0.52)')
  g.addColorStop(0.75, 'rgba(232, 96, 120, 0.18)')
  g.addColorStop(1, 'rgba(230, 90, 115, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

type HeadLike = {
  uniforms: {
    uHeadRot: { value: THREE.Matrix3 }
    uPivot: { value: THREE.Vector3 }
  }
} | null

export default function Blush({
  mesh,
  head,
  state,
}: {
  mesh: THREE.Object3D | null
  head: HeadLike
  state: { current: { env: number; smile: number } }
}) {
  const texture = useMemo(() => makeBlushTexture(), [])
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        // 写深度：景深按深度缓冲虚化，不写深度的话腮红会被当成"背后那层"的深度而糊错。
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
    [texture],
  )
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), [])

  const refs = useRef<(THREE.Mesh | null)[]>([])
  const base = useRef<{ pos: THREE.Vector3; quat: THREE.Quaternion }[] | null>(null)

  const tmp = useMemo(
    () => ({
      ray: new THREE.Raycaster(),
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(0, 0, -1),
      up: new THREE.Vector3(0, 1, 0),
      n: new THREE.Vector3(),
      xAxis: new THREE.Vector3(),
      yAxis: new THREE.Vector3(),
      nMat: new THREE.Matrix3(),
      basis: new THREE.Matrix4(),
      mw: new THREE.Matrix4(),
      mwInv: new THREE.Matrix4(),
      rotOnly: new THREE.Matrix4(),
      rotOnlyInv: new THREE.Matrix4(),
      r3: new THREE.Matrix3(),
      worldRot3: new THREE.Matrix3(),
      local: new THREE.Vector3(),
      rel: new THREE.Vector3(),
      vec: new THREE.Vector3(),
      qHead: new THREE.Quaternion(),
      qTmp: new THREE.Quaternion(),
    }),
    [],
  )

  useFrame(({ clock }) => {
    if (!mesh || !BLUSH_ENABLED) return
    // 等一两帧，确保 R3F 已经把外层 group 的缩放写进 matrixWorld 再打射线
    if (!base.current) {
      if (clock.elapsedTime < 0.05) return
      mesh.updateWorldMatrix(true, false)
      tmp.nMat.getNormalMatrix(mesh.matrixWorld)
      const fallback = { pos: new THREE.Vector3(0, 2.14, 0.25), quat: new THREE.Quaternion() }
      base.current = BLUSH.spots.map((s) => {
        tmp.origin.set(s.x, s.y, 5)
        tmp.ray.set(tmp.origin, tmp.dir)
        const hits = tmp.ray.intersectObject(mesh, true)
        let good: THREE.Intersection | null = null
        for (const h of hits) {
          if (!h.face) continue
          // 判"是不是正面"必须用**世界法线**：模型局部坐标是 Z-up，直接看 face.normal.z 会判错
          tmp.n.copy(h.face.normal).applyMatrix3(tmp.nMat).normalize()
          if (tmp.n.z > 0.3) {
            good = h
            break
          }
        }
        const hit = good ?? hits[0]
        if (!hit || !hit.face) return fallback
        tmp.n.copy(hit.face.normal).applyMatrix3(tmp.nMat).normalize()
        tmp.xAxis.crossVectors(tmp.up, tmp.n)
        if (tmp.xAxis.lengthSq() < 1e-8) tmp.xAxis.set(1, 0, 0)
        tmp.xAxis.normalize()
        tmp.yAxis.crossVectors(tmp.n, tmp.xAxis).normalize()
        tmp.basis.makeBasis(tmp.xAxis, tmp.yAxis, tmp.n)
        return {
          pos: hit.point.clone().addScaledVector(tmp.n, BLUSH.offset),
          quat: new THREE.Quaternion().setFromRotationMatrix(tmp.basis),
        }
      })
    }

    // 淡入淡出：笑 → 腮红，同一个包络。乘 0.9 让它在"笑满"时也不至于太浓。
    const op = Math.max(0, Math.min(1, state.current.smile)) * 0.9
    material.opacity = op
    if (op <= 0.001) {
      for (const m of refs.current) if (m) m.visible = false
      return
    }

    const H = head?.uniforms
    if (H) {
      // 头是顶点着色器转的：世界空间头旋转 = M · R_local · M⁻¹
      tmp.mw.copy(mesh.matrixWorld)
      tmp.mwInv.copy(tmp.mw).invert()
      tmp.rotOnly.extractRotation(tmp.mw)
      tmp.rotOnlyInv.copy(tmp.rotOnly).invert()
      tmp.r3.setFromMatrix4(tmp.rotOnly)
      tmp.worldRot3
        .copy(tmp.r3)
        .multiply(H.uHeadRot.value)
        .multiply(new THREE.Matrix3().setFromMatrix4(tmp.rotOnlyInv))
      tmp.qHead.setFromRotationMatrix(tmp.basis.setFromMatrix3(tmp.worldRot3))
    }

    for (let i = 0; i < BLUSH.spots.length; i++) {
      const m = refs.current[i]
      const b = base.current[i]
      if (!m || !b) continue
      m.visible = true
      m.scale.setScalar(BLUSH.size)
      if (!H) {
        m.position.copy(b.pos)
        m.quaternion.copy(b.quat)
        continue
      }
      // 和顶点着色器里那段一模一样的公式：局部 → 绕 uPivot 转 → 世界
      tmp.local.copy(b.pos).applyMatrix4(tmp.mwInv)
      tmp.rel.copy(tmp.local).sub(H.uPivot.value)
      tmp.vec.copy(tmp.rel).applyMatrix3(H.uHeadRot.value).add(H.uPivot.value)
      m.position.copy(tmp.vec).applyMatrix4(tmp.mw)
      m.quaternion.copy(tmp.qHead).multiply(b.quat)
    }
  })

  if (!BLUSH_ENABLED) return null
  return (
    <group>
      {BLUSH.spots.map((s, i) => (
        <mesh
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          geometry={geometry}
          material={material}
          visible={false}
        />
      ))}
    </group>
  )
}
