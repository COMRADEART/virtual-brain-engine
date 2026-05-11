import * as THREE from "three";

interface BrainShellOptions {
  opacity: number;
}

export function createBrainShell({ opacity }: BrainShellOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = "TransparentBrainShell";

  const shellGeometry = new THREE.SphereGeometry(1, 96, 48);
  const position = shellGeometry.attributes.position as THREE.BufferAttribute;
  const vertex = new THREE.Vector3();

  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index);
    const fold =
      Math.sin(vertex.x * 18 + vertex.z * 6) * 0.026 +
      Math.cos(vertex.y * 16 - vertex.z * 9) * 0.021 +
      Math.sin((vertex.x + vertex.y) * 11) * 0.014;

    const frontalBulge = vertex.z > 0 ? 1 + vertex.z * 0.08 : 1;
    const temporalTaper = 1 - Math.max(0, -vertex.y - 0.35) * 0.1;
    vertex.x *= (1 + fold) * temporalTaper;
    vertex.y *= 1 + fold * 0.45;
    vertex.z *= frontalBulge + fold * 0.6;
    position.setXYZ(index, vertex.x, vertex.y, vertex.z);
  }

  shellGeometry.computeVertexNormals();

  const shellMaterial = new THREE.MeshPhysicalMaterial({
    color: "#9defff",
    emissive: "#0d6f8e",
    emissiveIntensity: 0.42,
    metalness: 0,
    roughness: 0.24,
    transmission: 0.62,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const shell = new THREE.Mesh(shellGeometry, shellMaterial);
  shell.name = "Outer X-ray brain shell";
  shell.scale.set(2.05, 1.48, 1.52);
  shell.renderOrder = 1;
  group.add(shell);

  group.add(createFoldLines());
  group.add(createMidline());

  return group;
}

function createFoldLines(): THREE.LineSegments {
  const points: number[] = [];
  const xScale = 1.92;
  const yScale = 1.25;
  const zScale = 1.44;
  const bands = 18;
  const segments = 44;

  for (let band = 0; band < bands; band += 1) {
    const yNorm = -0.72 + (band / (bands - 1)) * 1.44;

    for (const side of [-1, 1]) {
      let previous: THREE.Vector3 | null = null;

      for (let segment = 0; segment <= segments; segment += 1) {
        const t = segment / segments;
        const angle = -Math.PI * 0.86 + t * Math.PI * 1.72;
        const radiusAtY = Math.sqrt(Math.max(0.05, 1 - yNorm * yNorm));
        const wave = Math.sin(t * Math.PI * 9 + band * 0.8) * 0.045;
        const x =
          side *
          (0.16 + Math.abs(Math.sin(angle)) * xScale * radiusAtY * (0.56 + wave));
        const y = yNorm * yScale + Math.sin(t * Math.PI * 5 + band) * 0.025;
        const z = Math.cos(angle) * zScale * radiusAtY * (0.9 + wave);
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
    color: "#7eefff",
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.name = "X-ray cortical fold traces";
  lines.renderOrder = 2;
  return lines;
}

function createMidline(): THREE.Line {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index <= 80; index += 1) {
    const t = index / 80;
    const y = -1.02 + t * 2.18;
    const z = 0.07 + Math.sin(t * Math.PI * 2) * 0.06;
    points.push(new THREE.Vector3(0, y, z));
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: "#d9ffff",
    transparent: true,
    opacity: 0.25,
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

    material.opacity = object.name.includes("fold") ? Math.min(0.24, opacity + 0.08) : opacity;
    material.needsUpdate = true;
  });
}
