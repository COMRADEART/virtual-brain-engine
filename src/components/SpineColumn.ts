import * as THREE from "three";

// ─── The spinal cord ────────────────────────────────────────────────────────
//
// A vertical nerve-fiber bundle descending from the brainstem (top) to the body
// terminus (bottom). It visualises the spine subsystem the server runs:
//
//   • EFFERENT impulses (brain → body) travel DOWN when a motor command is
//     dispatched / a reflex fires / a program runs — tinted by tract.
//   • AFFERENT impulses (body → brain) travel UP when feedback returns — the
//     outcome climbing back to cognition (green ok / red blocked).
//
// Structure: procedural helical fiber strands (always render) + a translucent
// core + an optional textured "sheath" (a higgsfield-generated nerve image at
// /spine-fiber.webp; falls back to a procedural gradient if the asset is
// missing, so the headless render check can never blank) + a Points cloud of
// travelling impulses advanced on the CPU (≤ MAX_IMPULSES, trivially cheap).
//
// It owns NO simulation state from React — like NeuronField it is built once and
// driven by update() each frame; BrainScene spawns impulses from `spine` bus
// events. Mirrors the engine/render boundary the rest of the scene keeps.

const MAX_IMPULSES = 96;
const STRAND_COUNT = 16;
const STRAND_SEGMENTS = 28;

export type SpineDirection = 1 | -1; // +1 = efferent (down), -1 = afferent (up)

interface Impulse {
  t: number; // progress along the cord, 0 = top (brainstem), 1 = bottom (body)
  dir: SpineDirection;
  speed: number; // per second
  phase: number; // strand angle so the impulse rides a fiber
  radius: number; // lateral offset from the centreline
  size: number;
  color: THREE.Color;
  alive: boolean;
  glow: number; // 0..1 fade
}

function mulberry32(seed: number): () => number {
  return () => {
    let v = (seed += 0x6d2b79f5);
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

function softSprite(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture();
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

const IMPULSE_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aAlpha * aSize * uPixelRatio * 70.0 / max(0.0001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const IMPULSE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.001) discard;
    float a = texture2D(uMap, gl_PointCoord).a;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor, a * vAlpha);
  }
`;

export interface SpineColumnOptions {
  top?: THREE.Vector3;
  bottom?: THREE.Vector3;
  pixelRatio?: number;
  textureUrl?: string;
}

export class SpineColumn {
  readonly group: THREE.Group;

  private readonly top: THREE.Vector3;
  private readonly bottom: THREE.Vector3;
  private readonly axis = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  private readonly impulses: Impulse[] = [];
  private readonly imp: {
    geom: THREE.BufferGeometry;
    pos: Float32Array;
    col: Float32Array;
    size: Float32Array;
    alpha: Float32Array;
    material: THREE.ShaderMaterial;
  };
  private readonly strandMat: THREE.LineBasicMaterial;
  private readonly sheathMat: THREE.MeshBasicMaterial;
  private readonly coreMat: THREE.MeshBasicMaterial;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private tone = 0; // resting-tone phase

  constructor(opts: SpineColumnOptions = {}) {
    this.group = new THREE.Group();
    this.group.name = "SpinalCord";
    this.top = opts.top ?? new THREE.Vector3(0, -0.5, -0.12);
    this.bottom = opts.bottom ?? new THREE.Vector3(0, -3.1, -0.12);
    this.axis.copy(this.bottom).sub(this.top); // top → bottom
    // A stable basis perpendicular to the axis for lateral offsets.
    this.forward.set(0, 0, 1);
    this.right.copy(this.axis).normalize().cross(this.forward).normalize();
    this.forward.copy(this.right).cross(this.axis.clone().normalize()).normalize();

    const rand = mulberry32(7);

    // ── Procedural helical fiber strands ──────────────────────────────────────
    this.strandMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.disposables.push(this.strandMat);
    const cyan = new THREE.Color("#5fe6ff");
    const violet = new THREE.Color("#a98bff");
    for (let s = 0; s < STRAND_COUNT; s += 1) {
      const phase = (s / STRAND_COUNT) * Math.PI * 2;
      const turns = 1.4 + rand() * 0.6;
      const baseR = 0.05 + rand() * 0.03;
      const positions = new Float32Array((STRAND_SEGMENTS + 1) * 3);
      const colors = new Float32Array((STRAND_SEGMENTS + 1) * 3);
      for (let i = 0; i <= STRAND_SEGMENTS; i += 1) {
        const t = i / STRAND_SEGMENTS;
        // Radius pinches near the brainstem, swells slightly mid-cord.
        const r = baseR * (0.45 + 0.9 * Math.sin(t * Math.PI));
        const p = this.pointAt(t, phase, r, turns);
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;
        const c = cyan.clone().lerp(violet, t);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      this.disposables.push(geom);
      const line = new THREE.Line(geom, this.strandMat);
      line.renderOrder = 1;
      line.frustumCulled = false;
      this.group.add(line);
    }

    // ── Translucent core + textured sheath cylinder ───────────────────────────
    const length = this.axis.length();
    const mid = this.top.clone().add(this.bottom).multiplyScalar(0.5);
    const orient = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      this.axis.clone().normalize().multiplyScalar(-1), // cylinder Y → up = top
    );

    const coreGeom = new THREE.CylinderGeometry(0.035, 0.05, length, 12, 1, true);
    this.disposables.push(coreGeom);
    this.coreMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#3aa9ff"),
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.disposables.push(this.coreMat);
    const core = new THREE.Mesh(coreGeom, this.coreMat);
    core.position.copy(mid);
    core.quaternion.copy(orient);
    core.renderOrder = 0;
    core.frustumCulled = false;
    this.group.add(core);

    const sheathGeom = new THREE.CylinderGeometry(0.14, 0.18, length, 18, 1, true);
    this.disposables.push(sheathGeom);
    this.sheathMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#7ad6ff"),
      transparent: true,
      opacity: 0.0, // raised once the texture loads (or the procedural fallback)
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.disposables.push(this.sheathMat);
    const sheath = new THREE.Mesh(sheathGeom, this.sheathMat);
    sheath.position.copy(mid);
    sheath.quaternion.copy(orient);
    sheath.renderOrder = 0;
    sheath.frustumCulled = false;
    this.group.add(sheath);
    this.loadSheathTexture(opts.textureUrl ?? "/spine-fiber.webp");

    // ── Travelling-impulse Points cloud ───────────────────────────────────────
    const pos = new Float32Array(MAX_IMPULSES * 3);
    const col = new Float32Array(MAX_IMPULSES * 3);
    const size = new Float32Array(MAX_IMPULSES);
    const alpha = new Float32Array(MAX_IMPULSES);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geom.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geom.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
    geom.boundingSphere = new THREE.Sphere(mid.clone(), length);
    this.disposables.push(geom);
    const sprite = softSprite();
    this.disposables.push(sprite);
    const material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: sprite }, uPixelRatio: { value: opts.pixelRatio ?? 1 } },
      vertexShader: IMPULSE_VERT,
      fragmentShader: IMPULSE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.disposables.push(material);
    const points = new THREE.Points(geom, material);
    points.name = "SpineImpulses";
    points.renderOrder = 2;
    points.frustumCulled = false;
    this.group.add(points);
    this.imp = { geom, pos, col, size, alpha, material };

    for (let i = 0; i < MAX_IMPULSES; i += 1) {
      this.impulses.push({
        t: 0, dir: 1, speed: 0, phase: 0, radius: 0, size: 0,
        color: new THREE.Color(), alive: false, glow: 0,
      });
    }
  }

  /** A point on the cord at progress t (0=top), strand `phase`, lateral `r`. */
  private pointAt(t: number, phase: number, r: number, turns: number): THREE.Vector3 {
    const p = this.top.clone().addScaledVector(this.axis, t);
    // Gentle whole-cord S so it reads organic, not a stick.
    const sway = Math.sin(t * Math.PI) * 0.06;
    const ang = phase + t * Math.PI * 2 * turns;
    p.addScaledVector(this.right, Math.cos(ang) * r + sway);
    p.addScaledVector(this.forward, Math.sin(ang) * r);
    return p;
  }

  private loadSheathTexture(url: string): void {
    const onReady = (): void => {
      this.sheathMat.opacity = 0.22;
    };
    try {
      new THREE.TextureLoader().load(
        url,
        (tex) => {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(2, 3);
          this.sheathMat.map = tex;
          this.sheathMat.needsUpdate = true;
          this.disposables.push(tex);
          onReady();
        },
        undefined,
        () => onReady(), // asset missing → keep the procedural gradient glow
      );
    } catch {
      onReady();
    }
  }

  /** Spawn one travelling impulse. dir +1 = efferent (down), -1 = afferent (up). */
  spawnImpulse(dir: SpineDirection, color: THREE.ColorRepresentation, speed = 0.9, size = 3.2): void {
    const slot = this.impulses.find((m) => !m.alive);
    if (!slot) return;
    slot.alive = true;
    slot.dir = dir;
    slot.t = dir === 1 ? 0 : 1;
    slot.speed = Math.max(0.2, speed);
    slot.phase = Math.random() * Math.PI * 2;
    slot.radius = 0.03 + Math.random() * 0.05;
    slot.size = size;
    slot.glow = 1;
    slot.color.set(color);
    // A spawn momentarily brightens the whole cord.
    this.sheathMat.opacity = Math.min(0.5, this.sheathMat.opacity + 0.12);
  }

  /** Per-frame: advance impulses, breathe the resting tone, write attributes. */
  update(delta: number, elapsed: number): void {
    this.tone = elapsed;
    // Resting tone shimmer on the strands.
    this.strandMat.opacity = 0.4 + 0.12 * (0.5 + 0.5 * Math.sin(elapsed * 1.3));
    this.coreMat.opacity = 0.12 + 0.06 * (0.5 + 0.5 * Math.sin(elapsed * 0.8 + 1));
    // Sheath relaxes back toward its resting glow after a spawn.
    if (this.sheathMat.opacity > 0.22) {
      this.sheathMat.opacity = Math.max(0.22, this.sheathMat.opacity - delta * 0.6);
    }

    const turns = 1.6;
    for (let i = 0; i < MAX_IMPULSES; i += 1) {
      const m = this.impulses[i];
      let a = 0;
      if (m.alive) {
        m.t += m.dir * m.speed * delta;
        if (m.t <= 0 || m.t >= 1) {
          m.alive = false;
          m.glow = 0;
        } else {
          // Fade in/out near the ends so impulses don't pop.
          const edge = Math.min(m.t, 1 - m.t);
          a = Math.min(1, edge * 6) * m.glow;
          const p = this.pointAt(m.t, m.phase, m.radius, turns);
          this.imp.pos[i * 3] = p.x;
          this.imp.pos[i * 3 + 1] = p.y;
          this.imp.pos[i * 3 + 2] = p.z;
          this.imp.col[i * 3] = m.color.r;
          this.imp.col[i * 3 + 1] = m.color.g;
          this.imp.col[i * 3 + 2] = m.color.b;
          this.imp.size[i] = m.size;
        }
      }
      this.imp.alpha[i] = a;
    }
    (this.imp.geom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.imp.geom.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    (this.imp.geom.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
    (this.imp.geom.getAttribute("aAlpha") as THREE.BufferAttribute).needsUpdate = true;
  }

  setPixelRatio(pixelRatio: number): void {
    this.imp.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* best-effort */
      }
    }
  }
}
