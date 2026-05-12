import * as THREE from "three";

interface BrainShellOptions {
  opacity: number;
}

// The shell is a *group* of distinct anatomical pieces — two cerebral hemispheres,
// the cerebellum, and the brainstem stub. Each piece keeps its own material so we
// can tune their look independently while still treating the group as one Object3D.
export function createBrainShell({ opacity }: BrainShellOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = "TransparentBrainShell";

  group.add(createHemisphere(-1, opacity));
  group.add(createHemisphere(1, opacity));
  group.add(createCerebellum(opacity));
  group.add(createBrainstem(opacity));
  group.add(createFoldLines());
  group.add(createMidline());

  return group;
}

function createHemisphere(side: number, opacity: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(1, 96, 48);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const vertex = new THREE.Vector3();

  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index);

    // Pinch the medial (toward x=0) face so the two hemispheres meet at a clear fissure
    // rather than blobbing together. Vertices whose own x sign disagrees with `side`
    // get squashed back toward the midline.
    if (vertex.x * side < 0) {
      vertex.x *= 0.05;
    }

    // Multi-octave gyri/sulci displacement. Higher frequencies on the cortical surface
    // than the original single-shell version so folds read at a closer camera distance.
    const fold =
      Math.sin(vertex.x * 14 + vertex.z * 7) * 0.05 +
      Math.cos(vertex.y * 12 - vertex.z * 9) * 0.038 +
      Math.sin((vertex.x + vertex.y) * 18 + vertex.z * 4) * 0.022 +
      Math.cos((vertex.y + vertex.z) * 22) * 0.018;

    const frontalBulge = vertex.z > 0 ? 1 + vertex.z * 0.1 : 1;
    const temporalTaper = 1 - Math.max(0, -vertex.y - 0.4) * 0.12;
    vertex.x *= (1 + fold) * temporalTaper;
    vertex.y *= 1 + fold * 0.55;
    vertex.z *= frontalBulge + fold * 0.7;
    position.setXYZ(index, vertex.x, vertex.y, vertex.z);
  }

  geometry.computeVertexNormals();

  const material = new THREE.MeshPhysicalMaterial({
    color: "#a7eaff",
    emissive: "#0c5876",
    emissiveIntensity: 0.36,
    metalness: 0,
    roughness: 0.32,
    transmission: 0.45,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = side < 0 ? "Left cerebral hemisphere" : "Right cerebral hemisphere";
  // Per-hemisphere scale: longer front-to-back, wide enough laterally to contain all
  // bilateral cortices (temporal lobe extends to |x|≈1.16). The medial pinch above
  // keeps the longitudinal fissure visible at x≈0.
  mesh.scale.set(1.28, 0.95, 1.5);
  mesh.position.set(side * 0.05, 0.02, 0);
  mesh.renderOrder = 1;
  return mesh;
}

function createCerebellum(opacity: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(1, 64, 32);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const vertex = new THREE.Vector3();

  // Cerebellar foliation: high-frequency, low-amplitude ridges that read as the
  // densely-folded cerebellar surface.
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index);
    const fold =
      Math.sin(vertex.x * 30 + vertex.z * 12) * 0.025 +
      Math.cos(vertex.y * 28 - vertex.z * 18) * 0.02 +
      Math.sin((vertex.x + vertex.y) * 36) * 0.015;
    vertex.x *= 1 + fold * 0.6;
    vertex.y *= 1 + fold * 0.4;
    vertex.z *= 1 + fold;
    position.setXYZ(index, vertex.x, vertex.y, vertex.z);
  }

  geometry.computeVertexNormals();

  const material = new THREE.MeshPhysicalMaterial({
    color: "#bdf4c2",
    emissive: "#1a6b34",
    emissiveIntensity: 0.32,
    metalness: 0,
    roughness: 0.4,
    transmission: 0.4,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "Cerebellum shell";
  mesh.scale.set(1.05, 0.4, 0.5);
  mesh.position.set(0, -0.78, -0.85);
  mesh.renderOrder = 1;
  return mesh;
}

function createBrainstem(opacity: number): THREE.Mesh {
  // Capsule isn't reliable across all three.js versions on the pinned 0.171.0,
  // but it's present — fall back to a cylinder if your build complains.
  const geometry = new THREE.CapsuleGeometry(0.18, 0.55, 8, 20);
  const material = new THREE.MeshPhysicalMaterial({
    color: "#e4d4b4",
    emissive: "#5b4523",
    emissiveIntensity: 0.3,
    metalness: 0,
    roughness: 0.5,
    transmission: 0.25,
    transparent: true,
    opacity: Math.min(1, opacity + 0.15),
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "Brainstem shell";
  mesh.position.set(0, -1.0, -0.2);
  mesh.rotation.x = Math.PI * 0.08; // gentle forward tilt
  mesh.renderOrder = 1;
  return mesh;
}

function createFoldLines(): THREE.LineSegments {
  const points: number[] = [];
  const bands = 16;
  const segments = 40;

  // Two passes: one per hemisphere, wrapping that hemisphere's surface.
  for (const xCenter of [-0.5, 0.5]) {
    const sideSign = xCenter > 0 ? 1 : -1;
    for (let band = 0; band < bands; band += 1) {
      const yNorm = -0.7 + (band / (bands - 1)) * 1.4;
      let previous: THREE.Vector3 | null = null;

      for (let segment = 0; segment <= segments; segment += 1) {
        const t = segment / segments;
        const angle = -Math.PI * 0.86 + t * Math.PI * 1.72;
        const radiusAtY = Math.sqrt(Math.max(0.05, 1 - yNorm * yNorm));
        const wave = Math.sin(t * Math.PI * 9 + band * 0.8) * 0.045;
        const x =
          xCenter +
          sideSign *
            Math.abs(Math.sin(angle)) *
            0.62 *
            radiusAtY *
            (0.62 + wave);
        const y = yNorm * 1.18 + Math.sin(t * Math.PI * 5 + band) * 0.025;
        const z = Math.cos(angle) * 1.4 * radiusAtY * (0.92 + wave);
        const current = new THREE.Vector3(x, y, z);

        if (previous) {
          points.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
        }

        previous = current;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));

  const material = new THREE.LineBasicMaterial({
    color: "#bff5ff",
    transparent: true,
    opacity: 0.2,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.name = "X-ray cortical fold traces";
  lines.renderOrder = 2;
  return lines;
}

function createMidline(): THREE.Line {
  // Interhemispheric seam — a single line down the longitudinal fissure with a slight
  // anterior–posterior curve following the gross brain shape.
  const points: THREE.Vector3[] = [];
  for (let index = 0; index <= 90; index += 1) {
    const t = index / 90;
    const y = -0.95 + t * 2.05;
    const z = -1.05 + t * 2.05 + Math.sin(t * Math.PI) * 0.08;
    points.push(new THREE.Vector3(0, y, z));
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: "#eaffff",
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const line = new THREE.Line(geometry, material);
  line.name = "Hemispheric seam";
  return line;
}

export function setBrainShellOpacity(shellGroup: THREE.Group, opacity: number): void {
  shellGroup.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (!material) {
      return;
    }

    if (Array.isArray(material)) {
      material.forEach((entry) => {
        entry.opacity = opacity;
        entry.needsUpdate = true;
      });
      return;
    }

    // Folds and the brainstem stay a touch more visible than the cerebral shells —
    // they're our anatomical reference lines.
    const name = object.name;
    if (name.includes("fold") || name.includes("seam")) {
      material.opacity = Math.min(0.34, opacity + 0.15);
    } else if (name.includes("Brainstem")) {
      material.opacity = Math.min(1, opacity + 0.15);
    } else {
      material.opacity = opacity;
    }
    material.needsUpdate = true;
  });
}
