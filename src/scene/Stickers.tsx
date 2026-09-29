import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { STICKERS } from '../data/stickers'

// 贴在脸上的模切贴纸。
//
// 做法（不依赖 Blender）：
//   1) 每一帧第一次运行时，对每条贴纸从正前方（+Z 远处）发一条射线打向角色网格；
//   2) 命中点的**世界法线**就是贴纸朝向 → 建一组基，平面伏在皮肤曲面上；
//      再沿法线往外推 offset，避免和皮肤打架（z-fighting）；
//   3) 因为头部是靠顶点着色器做刚性旋转的（没有骨骼），贴纸必须**手动跟着转**，
//      否则头一转贴纸就滑到耳后了。这里把每个贴纸的基准点/朝向按同一套变换搬一遍：
//        局部点   = meshWorld⁻¹ · 世界点
//        旋转后   = uPivot + uHeadRot · (局部点 − uPivot)
//        世界点   = meshWorld · 旋转后
//      朝向同理用 M · R_local · M⁻¹ 换到世界空间。
//   4) 脸上贴纸全在 fullFrac 以上（权重恒为 1），所以是整体刚性旋转，不需要插值。

type HeadLike = {
  uniforms: {
    uHeadRot: { value: THREE.Matrix3 }
    uPivot: { value: THREE.Vector3 }
  }
} | null

export default function Stickers({
  mesh,
  head,
}: {
  mesh: THREE.Object3D | null
  head: HeadLike
}) {
  const urls = useMemo(
    () => STICKERS.map((s) => `${import.meta.env.BASE_URL}stickers/${s.file}.webp`),
    [],
  )
  const textures = useTexture(urls) as THREE.Texture[]

  const { materials, geometries } = useMemo(() => {
    const materials = textures.map((t) => {
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 4
      return new THREE.MeshBasicMaterial({
        map: t,
        transparent: true,
        // 写深度：景深按深度缓冲虚化，不写深度的话贴纸会被当成"背后那层"的深度而糊错。
        // 贴纸边缘是硬模切，alphaTest 硬裁反而干净，也省掉半透明排序问题。
        alphaTest: 0.5,
        depthWrite: true,
        side: THREE.DoubleSide,
      })
    })
    const geometries = textures.map((t) => {
      const img = t.image as { width?: number; height?: number } | undefined
      const aspect = img?.width && img?.height ? img.width / img.height : 1
      return new THREE.PlaneGeometry(aspect, 1)
    })
    return { materials, geometries }
  }, [textures])

  const refs = useRef<(THREE.Mesh | null)[]>([])
  // 一次性算出每条贴纸的「基准世界位置 + 基准世界朝向」，之后每帧只做头部变换
  const base = useRef<{ pos: THREE.Vector3; quat: THREE.Quaternion }[] | null>(null)
  // 调试：每条贴纸的瞄准点与真实命中点（DEV 下暴露为 window.__stickers）
  const debug = useRef<
    {
      file: string
      label: string
      aim: number[]
      hit: number[]
      n: number[]
      size: number
      front: boolean
    }[]
  >([])

  // 复用对象
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
      tiltQ: new THREE.Quaternion(),
      mw: new THREE.Matrix4(),
      mwInv: new THREE.Matrix4(),
      rotOnly: new THREE.Matrix4(),
      rotOnlyInv: new THREE.Matrix4(),
      r3: new THREE.Matrix3(),
      worldRot3: new THREE.Matrix3(),
      local: new THREE.Vector3(),
      rel: new THREE.Vector3(),
      qHead: new THREE.Quaternion(),
      qTmp: new THREE.Quaternion(),
      vec: new THREE.Vector3(),
    }),
    [],
  )

  useFrame(({ clock }) => {
    if (!mesh) return
    // 等一两帧，确保 R3F 已经把外层 group 的缩放写进 matrixWorld 再打射线
    if (!base.current) {
      if (clock.elapsedTime < 0.05) return
      mesh.updateWorldMatrix(true, false)
      debug.current = []
      base.current = STICKERS.map((s) => {
        const fallback = {
          pos: new THREE.Vector3(s.tx, s.ty, 0.2),
          quat: new THREE.Quaternion(),
        }
        tmp.origin.set(s.tx, s.ty, 5)
        tmp.ray.set(tmp.origin, tmp.dir)
        // 射线是沿 -Z 直着打过来的，命中点的法线已经朝向镜头附近，
        // 但仍要换成世界法线再判断（模型局部坐标是 Z-up，不能直接用 face.normal.z）
        tmp.nMat.getNormalMatrix(mesh.matrixWorld)
        const hits = tmp.ray.intersectObject(mesh, true)
        let good: (typeof hits)[number] | null = null
        for (const h of hits) {
          if (!h.face) continue
          tmp.n.copy(h.face.normal).applyMatrix3(tmp.nMat).normalize()
          if (tmp.n.z > 0.15) {
            good = h
            break
          }
        }
        const hit = good ?? hits[0]
        if (!hit || !hit.face) return fallback

        tmp.n.copy(hit.face.normal).applyMatrix3(tmp.nMat).normalize()
        // 建基：局部 +Z 对齐表面法线，+Y 取世界竖直在切平面上的投影
        tmp.xAxis.crossVectors(tmp.up, tmp.n)
        if (tmp.xAxis.lengthSq() < 1e-8) tmp.xAxis.set(1, 0, 0)
        tmp.xAxis.normalize()
        tmp.yAxis.crossVectors(tmp.n, tmp.xAxis).normalize()
        tmp.basis.makeBasis(tmp.xAxis, tmp.yAxis, tmp.n)
        const q = new THREE.Quaternion().setFromRotationMatrix(tmp.basis)
        // 面内旋转（绕自身法线）
        tmp.tiltQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(s.tilt))
        q.multiply(tmp.tiltQ)
        const rec = {
          pos: hit.point.clone().addScaledVector(tmp.n, s.offset),
          quat: q,
        }
        // 调试：记录实际命中点，方便核对贴纸落点（DEV 下 __stickers）
        debug.current.push({
          file: s.file,
          label: s.label,
          aim: [s.tx, s.ty],
          hit: [+hit.point.x.toFixed(3), +hit.point.y.toFixed(3), +hit.point.z.toFixed(3)],
          n: [+tmp.n.x.toFixed(3), +tmp.n.y.toFixed(3), +tmp.n.z.toFixed(3)],
          size: s.size,
          front: tmp.n.z > 0.15,
        })
        return rec
      })
      if (import.meta.env.DEV) {
        ;(window as any).__stickers = debug.current
        ;(window as any).__mesh = mesh
        // 探针：从正前方 (x,y,5) 沿 -Z 打一条射线，返回命中信息。
        // 用来扫「脸上哪个坐标是皮肤/头发/眼睛」，方便精确摆贴纸。
        ;(window as any).__ray = (x: number, y: number) => {
          const o = new THREE.Vector3(x, y, 5)
          const r = new THREE.Raycaster(o, new THREE.Vector3(0, 0, -1))
          const hits = r.intersectObject(mesh, true)
          for (const h of hits) {
            if (!h.face) continue
            const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
            const n = h.face.normal.clone().applyMatrix3(nm).normalize()
            if (n.z > 0.15)
              return {
                hit: [+h.point.x.toFixed(3), +h.point.y.toFixed(3), +h.point.z.toFixed(3)],
                n: [+n.x.toFixed(3), +n.y.toFixed(3), +n.z.toFixed(3)],
                uv: h.uv ? [+h.uv.x.toFixed(4), +h.uv.y.toFixed(4)] : null,
                name: h.object.name || '(unnamed)',
                front: true,
              }
          }
          const h = hits[0]
          if (!h) return null
          const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
          const n = h.face ? h.face.normal.clone().applyMatrix3(nm).normalize() : new THREE.Vector3()
          return {
            hit: [+h.point.x.toFixed(3), +h.point.y.toFixed(3), +h.point.z.toFixed(3)],
            n: [+n.x.toFixed(3), +n.y.toFixed(3), +n.z.toFixed(3)],
            uv: h.uv ? [+h.uv.x.toFixed(4), +h.uv.y.toFixed(4)] : null,
            name: h.object.name || '(unnamed)',
            front: false,
          }
        }
      }
    }

    const H = head?.uniforms
    if (H) {
      tmp.mw.copy(mesh.matrixWorld)
      tmp.mwInv.copy(tmp.mw).invert()
      tmp.rotOnly.extractRotation(tmp.mw)
      tmp.rotOnlyInv.copy(tmp.rotOnly).invert()
      // 世界空间的头旋转 = M · R_local · M⁻¹
      tmp.r3.setFromMatrix4(tmp.rotOnly)
      tmp.worldRot3.copy(tmp.r3).multiply(H.uHeadRot.value).multiply(new THREE.Matrix3().setFromMatrix4(tmp.rotOnlyInv))
      tmp.qHead.setFromRotationMatrix(tmp.basis.setFromMatrix3(tmp.worldRot3))
    }

    for (let i = 0; i < STICKERS.length; i++) {
      const m = refs.current[i]
      const b = base.current[i]
      if (!m) continue
      if (!b) {
        m.visible = false
        continue
      }
      m.visible = true
      if (!H) {
        m.position.copy(b.pos)
        m.quaternion.copy(b.quat)
        continue
      }
      // 头部刚性旋转：和顶点着色器里那段一模一样的公式
      tmp.local.copy(b.pos).applyMatrix4(tmp.mwInv)
      tmp.rel.copy(tmp.local).sub(H.uPivot.value)
      tmp.vec.copy(tmp.rel).applyMatrix3(H.uHeadRot.value).add(H.uPivot.value)
      m.position.copy(tmp.vec).applyMatrix4(tmp.mw)
      tmp.qTmp.copy(tmp.qHead).multiply(b.quat)
      m.quaternion.copy(tmp.qTmp)
    }
  })

  return (
    <group>
      {STICKERS.map((s, i) => (
        <mesh
          // 同一个 file 可能被用多次（换内容前的占位），所以 key 用索引，别用 file
          key={`${i}-${s.file}`}
          ref={(el) => {
            refs.current[i] = el
          }}
          geometry={geometries[i]}
          material={materials[i]}
          scale={s.size}
          visible={false}
        />
      ))}
    </group>
  )
}
