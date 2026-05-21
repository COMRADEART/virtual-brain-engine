/**
 * BrainScene.tsx — Virtual Brain Engine, first core file.
 *
 * A self-contained React Three Fiber scene that renders a transparent
 * x-ray-style brain shell with procedurally generated folds, and a handful
 * of interactive anatomical regions floating inside it.
 *
 * Suggested folder layout (this file lives at the root of it):
 *
 *   src/experimental/brain-engine/
 *     ├── BrainScene.tsx          ← you are here (composition root)
 *     ├── shell/                  ← future: split shell + materials out
 *     ├── regions/                ← future: region data + meshes
 *     ├── lighting/               ← future: rigs / environments
 *     └── hooks/                  ← useNoiseField, useRegionSelection, ...
 *
 * Dependencies (not yet in package.json — install before importing):
 *   npm i @react-three/fiber @react-three/drei
 *
 * `three` and `@types/three` are already pinned at 0.171.0 in this repo.
 */

import { Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { Canvas, ThreeEvent, useFrame } from '@react-three/fiber';
import {
  Environment,
  Html,
  MeshTransmissionMaterial,
  OrbitControls,
  Stats,
} from '@react-three/drei';
import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/*  Region taxonomy                                                           */
/* -------------------------------------------------------------------------- */

export type RegionId =
  | 'frontal-l'
  | 'frontal-r'
  | 'parietal-l'
  | 'parietal-r'
  | 'temporal-l'
  | 'temporal-r'
  | 'occipital'
  | 'cerebellum';

interface RegionDef {
  id: RegionId;
  label: string;
  /** Centre of the region's blob, in shell-local coordinates (unit sphere-ish). */
  center: [number, number, number];
  radius: number;
  /** Hex colour used for both diffuse and emissive. */
  color: string;
}

const REGIONS: readonly RegionDef[] = [
  { id: 'frontal-l',  label: 'Frontal (L)',  center: [-0.45,  0.30,  0.65], radius: 0.34, color: '#4ea1ff' },
  { id: 'frontal-r',  label: 'Frontal (R)',  center: [ 0.45,  0.30,  0.65], radius: 0.34, color: '#4ea1ff' },
  { id: 'parietal-l', label: 'Parietal (L)', center: [-0.42,  0.50, -0.05], radius: 0.32, color: '#7be3a1' },
  { id: 'parietal-r', label: 'Parietal (R)', center: [ 0.42,  0.50, -0.05], radius: 0.32, color: '#7be3a1' },
  { id: 'temporal-l', label: 'Temporal (L)', center: [-0.78, -0.10,  0.10], radius: 0.32, color: '#ffd166' },
  { id: 'temporal-r', label: 'Temporal (R)', center: [ 0.78, -0.10,  0.10], radius: 0.32, color: '#ffd166' },
  { id: 'occipital',  label: 'Occipital',    center: [ 0.00,  0.18, -0.80], radius: 0.36, color: '#ef6f6c' },
  { id: 'cerebellum', label: 'Cerebellum',   center: [ 0.00, -0.58, -0.55], radius: 0.34, color: '#c78bff' },
];

/* -------------------------------------------------------------------------- */
/*  Deterministic 3D value noise                                              */
/*                                                                            */
/*  Inline so the file has no extra runtime deps. Two-band noise (low-freq    */
/*  lobes + high-freq gyri) plus an exponential fissure on x=0 is enough to   */
/*  read as a brain at a glance. Swap for simplex / curl noise later if you   */
/*  want sharper sulci.                                                       */
/* -------------------------------------------------------------------------- */

function hash3(x: number, y: number, z: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

function smoothNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);

  const c000 = hash3(xi,     yi,     zi);
  const c100 = hash3(xi + 1, yi,     zi);
  const c010 = hash3(xi,     yi + 1, zi);
  const c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi,     yi,     zi + 1);
  const c101 = hash3(xi + 1, yi,     zi + 1);
  const c011 = hash3(xi,     yi + 1, zi + 1);
  const c111 = hash3(xi + 1, yi + 1, zi + 1);

  const x00 = c000 * (1 - u) + c100 * u;
  const x10 = c010 * (1 - u) + c110 * u;
  const x01 = c001 * (1 - u) + c101 * u;
  const x11 = c011 * (1 - u) + c111 * u;
  const y0  = x00  * (1 - v) + x10  * v;
  const y1  = x01  * (1 - v) + x11  * v;
  return y0 * (1 - w) + y1 * w;
}

function fbm3(x: number, y: number, z: number, octaves = 4): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum  += amp * smoothNoise3(x * freq, y * freq, z * freq);
    norm += amp;
    amp  *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* -------------------------------------------------------------------------- */
/*  Brain shell                                                               */
/*                                                                            */
/*  Icosphere at subdivision 6 (~40k tris), displaced per-vertex. Geometry is */
/*  built once via useMemo — the displacement is deterministic and the shell  */
/*  is static, so we never rebuild on re-render.                              */
/* -------------------------------------------------------------------------- */

function useBrainShellGeometry(): THREE.BufferGeometry {
  return useMemo(() => {
    const geom = new THREE.IcosahedronGeometry(1, 6);
    const pos = geom.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    const dir = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      dir.copy(v).normalize();

      // Two scales of noise: large lobes + fine gyri.
      const lobe = fbm3(dir.x * 1.6, dir.y * 1.6, dir.z * 1.6, 4) - 0.5;
      const gyri = fbm3(dir.x * 7.0, dir.y * 7.0, dir.z * 7.0, 3) - 0.5;

      // Longitudinal fissure: a vertical groove down the midline (x ≈ 0).
      const fissure = Math.exp(-(dir.x * dir.x) * 80) * 0.06;

      const r = 1.0 + lobe * 0.10 + gyri * 0.05 - fissure;

      v.copy(dir).multiplyScalar(r);
      // Anatomical squash: slightly elongated front-to-back, narrower top.
      v.x *= 1.05;
      v.y *= 0.95;
      v.z *= 1.20;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geom.computeVertexNormals();
    return geom;
  }, []);
}

interface BrainShellProps {
  opacity?: number;
}

function BrainShell({ opacity: _opacity = 0.18 }: BrainShellProps) {
  const geometry = useBrainShellGeometry();
  return (
    <mesh geometry={geometry} renderOrder={2}>
      {/* MeshTransmissionMaterial is drei's screen-space glass. With `backside`
          on and a moderate `thickness`, refraction reads as wet anatomical tissue
          rather than crystal. Tune `distortion` higher for more organic shimmer,
          lower for cleaner medical-imaging look. */}
      <MeshTransmissionMaterial
        transmission={1}
        thickness={0.6}
        roughness={0.35}
        ior={1.25}
        chromaticAberration={0.02}
        anisotropy={0.1}
        distortion={0.15}
        distortionScale={0.4}
        temporalDistortion={0.05}
        color={'#ffd6e7'}
        attenuationColor={'#ff9ec4'}
        attenuationDistance={1.4}
        backside
      />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */
/*  Interactive region                                                        */
/* -------------------------------------------------------------------------- */

interface RegionProps {
  def: RegionDef;
  hovered: boolean;
  selected: boolean;
  onHover: (id: RegionId | null) => void;
  onSelect: (id: RegionId) => void;
}

function Region({ def, hovered, selected, onHover, onSelect }: RegionProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  // Subtle pulse on hover/select. Scale is computed off elapsed time so it
  // doesn't require triggering React renders.
  useFrame(({ clock }) => {
    const m = meshRef.current;
    if (!m) return;
    const t = clock.elapsedTime;
    const pulse = (hovered || selected) ? 0.04 + 0.02 * Math.sin(t * 4) : 0;
    m.scale.setScalar(1 + pulse);
  });

  const emissiveIntensity = selected ? 1.4 : hovered ? 0.9 : 0.35;
  const opacity            = selected ? 0.90 : hovered ? 0.75 : 0.55;

  return (
    <group position={def.center}>
      <mesh
        ref={meshRef}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover(def.id);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover(null);
          document.body.style.cursor = 'auto';
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect(def.id);
        }}
      >
        <sphereGeometry args={[def.radius, 48, 48]} />
        <meshStandardMaterial
          color={def.color}
          emissive={def.color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.4}
          metalness={0.1}
          transparent
          opacity={opacity}
        />
      </mesh>

      {/* Selection ring — a thin glowing torus around the region. */}
      {selected && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[def.radius * 1.15, 0.012, 16, 64]} />
          <meshBasicMaterial color={def.color} toneMapped={false} />
        </mesh>
      )}

      {/* Floating label, billboarded by drei.Html. Only shown for hover/select
          so the scene isn't cluttered at rest. */}
      {(hovered || selected) && (
        <Html
          center
          distanceFactor={6}
          position={[0, def.radius + 0.15, 0]}
          style={{
            color: '#fff',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: '14px',
            padding: '4px 8px',
            background: 'rgba(10, 8, 24, 0.7)',
            border: `1px solid ${def.color}`,
            borderRadius: '6px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {def.label}
        </Html>
      )}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Scene composition                                                         */
/* -------------------------------------------------------------------------- */

interface SceneProps {
  hovered: RegionId | null;
  selected: RegionId | null;
  onHover: (id: RegionId | null) => void;
  onSelect: (id: RegionId) => void;
}

function Scene({ hovered, selected, onHover, onSelect }: SceneProps) {
  return (
    <>
      {/* Three-point rig: warm key, cool fill, internal point for the
          transmission to pick up. */}
      <ambientLight intensity={0.45} />
      <directionalLight position={[5, 6, 4]} intensity={1.0} />
      <directionalLight position={[-4, 2, -5]} intensity={0.35} color="#aac8ff" />
      <pointLight position={[0, 0, 0]} intensity={0.4} color="#ff9ec4" />

      {/* Environment provides the HDRI reflections that make the glass
          shell read as real material. Suspense because HDR fetch is async. */}
      <Suspense fallback={null}>
        <Environment preset="city" />
      </Suspense>

      {/* Regions render BEFORE the shell so the shell's transmission pass
          refracts them. */}
      <group>
        {REGIONS.map(def => (
          <Region
            key={def.id}
            def={def}
            hovered={hovered === def.id}
            selected={selected === def.id}
            onHover={onHover}
            onSelect={onSelect}
          />
        ))}
      </group>

      <BrainShell />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Public component                                                          */
/* -------------------------------------------------------------------------- */

export interface BrainSceneProps {
  /** Render a dev-only fps/draw-call overlay in the top-left. */
  debug?: boolean;
  /** Fires when the user picks a region, or null when the selection is cleared. */
  onRegionSelect?: (id: RegionId | null) => void;
  /** Wrapper class. The wrapper is the sizing parent — give it a height. */
  className?: string;
}

export default function BrainScene({
  debug = false,
  onRegionSelect,
  className,
}: BrainSceneProps) {
  const [hovered, setHovered] = useState<RegionId | null>(null);
  const [selected, setSelected] = useState<RegionId | null>(null);

  // Toggle selection: clicking the same region twice clears it.
  const handleSelect = useCallback(
    (id: RegionId) => {
      setSelected(prev => {
        const next = prev === id ? null : id;
        onRegionSelect?.(next);
        return next;
      });
    },
    [onRegionSelect],
  );

  // R3F's onPointerMissed fires for clicks that hit no mesh — perfect for
  // "click empty space to deselect". No invisible plane needed.
  const handleMissed = useCallback(() => {
    setSelected(null);
    onRegionSelect?.(null);
  }, [onRegionSelect]);

  return (
    <div
      className={className}
      style={{
        width: '100%',
        height: '100%',
        background:
          'radial-gradient(circle at 50% 40%, #1a1530 0%, #050410 70%)',
      }}
    >
      <Canvas
        camera={{ position: [0, 0.4, 3.6], fov: 38, near: 0.1, far: 100 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        onPointerMissed={handleMissed}
      >
        <Scene
          hovered={hovered}
          selected={selected}
          onHover={setHovered}
          onSelect={handleSelect}
        />

        <OrbitControls
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          minDistance={1.8}
          maxDistance={6}
          autoRotate
          autoRotateSpeed={0.4}
        />

        {debug && <Stats />}
      </Canvas>
    </div>
  );
}
