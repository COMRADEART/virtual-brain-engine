// ─────────────────────────────────────────────────────────────────────────────
// SPIKE RASTER PLOT: 2D canvas overlay showing spikes as vertical pulses
// Colored by brain region, rendered as a scrolling raster.
// Uses HTML5 Canvas for performance.
// ─────────────────────────────────────────────────────────────────────────────

class SpikeRaster {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buffer: Float32Array = new Float32Array(2048); // Circular buffer
  private head: number = 0;
  private tail: number = 0;
  private width: number = 300;
  private height: number = 120;
  private regionColors: Record<string, string> = {
    "hippocampus-l": "#E1BEE7",
    "hippocampus-r": "#E1BEE7",
    "prefrontal-l": "#BBDEFB",
    "prefrontal-r": "#BBDEFB",
    "temporal-l": "#C8E6C9",
    "temporal-r": "#C8E6C9",
    "parietal-l": "#FFCDD2",
    "parietal-r": "#FFCDD2",
    "occipital-l": "#FFF9C4",
    "occipital-r": "#FFF9C4",
    "thalamus-l": "#D7CCC8",
    "thalamus-r": "#D7CCC8",
  };
  private pixelRatio: number = 1;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = `
      position: absolute;
      bottom: 10px;
      right: 10px;
      width: 300px;
      height: 120px;
      background: #000;
      opacity: 0.7;
      border-radius: 4px;
      z-index: 10;
      pointer-events: none;
    `;
    this.canvas.width = this.width * this.pixelRatio;
    this.canvas.height = this.height * this.pixelRatio;
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.scale(this.pixelRatio, this.pixelRatio);
    // Draw gridlines
    this.drawBackground();
  }

  private drawBackground(): void {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.width, this.height);
    
    // Gridlines:
    // - Vertical lines: 50ms intervals
    // - Horizontal lines: major regions
    this.ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    this.ctx.lineWidth = 0.5;
    
    // Vertical
    for (let x = 0; x < this.width; x += 25) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.height);
      this.ctx.stroke();
    }
    
    // Horizontal
    const regions = [
      { name: "Prefrontal", y: 15 },
      { name: "Temporal", y: 40 },
      { name: "Parietal", y: 65 },
      { name: "Occipital", y: 90 },
    ];
    
    this.ctx.font = "9px Arial";
    this.ctx.fillStyle = "#AAA";
    
    regions.forEach(region => {
      this.ctx.beginPath();
      this.ctx.moveTo(0, region.y);
      this.ctx.lineTo(this.width, region.y);
      this.ctx.stroke();
      this.ctx.fillText(region.name, 5, region.y - 2);
    });
    this.ctx.fillText("Hippocampus", 5, 110);
  }

  /**
   * Record a spike for raster visualization
   * @param regionId Brain region ID
   * @param neuronIndex Index of neuron in simulation
   * @param timestamp Simulation timestamp
   */
  recordSpike(regionId: BrainRegionId, neuronIndex: number, timestamp: number): void {
    // Store spike in circular buffer
    const bufferIndex = (this.head % this.buffer.length) * 3;
    this.buffer[bufferIndex] = timestamp;
    this.buffer[bufferIndex + 1] = neuronIndex;
    this.buffer[bufferIndex + 2] = REGION_INDEX[regionId] ?? -1;
    
    this.head++;
    if (this.head - this.tail > this.buffer.length / 3) {
      // Maintain fixed-size tail
      this.tail = this.head - this.buffer.length / 3;
    }
  }

  /**
   * Render the raster scroll
   * @param currentTime Current simulation time (for scroll reference)
   */
  render(currentTime: number): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.drawBackground();
    
    const now = currentTime;
    const maxAge = 0.8; // seconds
    const yScale = this.height / 30; // Neurons 0-30
    
    // Render spikes within the visible window
    for (let i = this.tail; i < this.head; i++) {
      const bufIdx = (i % this.buffer.length) * 3;
      const spikeTime = this.buffer[bufIdx];
      const neuronIndex = this.buffer[bufIdx + 1];
      const regionIdx = this.buffer[bufIdx + 2];
      
      const age = now - spikeTime;
      if (age > maxAge) {
        this.tail = i;
        continue;
      }
      
      const x = this.width - (age / maxAge) * this.width;
      const y = neuronIndex % 30 * yScale;
      
      // Color by region
      const regionId = Object.keys(REGION_INDEX).find(
        k => REGION_INDEX[k as BrainRegionId] === regionIdx
      ) as BrainRegionId | undefined;
      
      let color: string;
      if (regionId) {
        color = this.regionColors[regionId] || "#FFFFFF";
      } else {
        // Default color gradient by neuron index
        const t = neuronIndex / 100;
        color = `hsl(${220 + t * 40}, 80%, 60%)`;
      }
      
      // Fade with age
      const alpha = 1.0 - age / maxAge;
      this.ctx.strokeStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0');
      this.ctx.lineWidth = 1;
      
      // Draw spike line
      this.ctx.beginPath();
      this.ctx.moveTo(x, y);
      this.ctx.lineTo(x, y + yScale * 0.9);
      this.ctx.stroke();
    }
    
    // Draw current-time marker
    this.ctx.strokeStyle = "#FF0000";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(this.width, 0);
    this.ctx.lineTo(this.width, this.height);
    this.ctx.stroke();
  }

  getElement(): HTMLCanvasElement {
    return this.canvas;
  }

  dispose(): void {
    this.canvas.remove();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLASS EXTENSIONS
// ─────────────────────────────────────────────────────────────────────────────

export class BrainVisualEffects {
  // ... existing code ...

  private spikeRaster: SpikeRaster | null = null;
  private workingMemoryGroup = new THREE.Group();

  constructor(graph: NeuralGraph, simulation: BrainSimulation, opts = {}) {
    // ... existing init ...

    // Enable spike raster if using SpikingEngine
    if (simulation instanceof SpikingEngine && opts.enableSpikeRaster !== false) {
      this.spikeRaster = new SpikeRaster();
    }
    
    // Add working memory group
    this.workingMemoryGroup.name = "WorkingMemoryGroup";
    this.workingMemoryGroup.visible = false;
    this.group.add(this.workingMemoryGroup);
  }

  // ... existing methods ...

  /**
   * Call this every frame to record spikes and update the raster.
   * Only enabled for SpikingEngine.
   */
  update(
    elapsed: number,
    deltaSeconds: number,
    visibility: RegionVisibility,
    regionIntensity: Float32Array,
    pathwayIntensity: Float32Array,
  ): void {
    // ... existing update logic ...

    // Update spike raster
    if (this.spikeRaster && this.simulation instanceof SpikingEngine) {
      // Pull spike events from SpikingEngine
      // Note: In a full implementation, you'd hook into the spiking event broadcast
      // from SpikingEngine. For now, simulate spikes.
      
      // This would be replaced with actual spike events:
      if (Math.random() < 0.02) { // Simulate occasional spikes
        const regionIds = this.graph.regionOrder;
        const regionId = regionIds[Math.floor(Math.random() * regionIds.length)];
        const neuronIndex = Math.floor(Math.random() * this.graph.nodes.length);
        this.spikeRaster.recordSpike(regionId, neuronIndex, elapsed);
      }
      
      this.spikeRaster.render(elapsed);
    }
  }

  // ... existing private methods ...

  /**
   * For debugging: simulate a spike in the raster
   */
  debugRecordSpike(regionId: BrainRegionId, neuronIndex: number): void {
    if (this.spikeRaster) {
      this.spikeRaster.recordSpike(regionId, neuronIndex, performance.now() / 1000);
    }
  }

  /**
   * Enable/disable spike raster visibility
   */
  showSpikeRaster(visible: boolean): void {
    if (this.spikeRaster) {
      this.spikeRaster.getElement().style.display = visible ? "block" : "none";
    }
  }

  /**
   * Visualize working memory regions with highlighting
   */
  visualizeWorkingMemory(regionIds: BrainRegionId[], intensity: number = 1.0): void {
    // Clear existing
    while (this.workingMemoryGroup.children.length > 0) {
      this.workingMemoryGroup.remove(this.workingMemoryGroup.children[0]);
    }
    
    if (regionIds.length === 0) {
      this.workingMemoryGroup.visible = false;
      return;
    }
    
    this.workingMemoryGroup.visible = true;
    
    // Create translucent, glowing highlight for each region
    regionIds.forEach((regionId, index) => {
      const region = REGION_BY_ID[regionId];
      if (!region) return;
      
      const geo = new THREE.SphereGeometry(1, 32, 18);
      const mat = new THREE.MeshStandardMaterial({
        transparent: true,
        opacity: 0.35,
        emissive: new THREE.Color(0x66BBFF),
        emissiveIntensity: intensity * 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(region.center[0], region.center[1], region.center[2]);
      mesh.scale.set(
        region.radius[0] * 1.2,
        region.radius[1] * 1.2,
        region.radius[2] * 1.2
      );
      mesh.userData.baseIntensity = intensity;
      mesh.userData.animationPhase = index * 0.3;
      
      this.workingMemoryGroup.add(mesh);
    });
  }

  /**
   * Add debug visualization elements (spike raster, working memory toggles)
   */
  addDebugControls(container: HTMLElement): void {
    // Add spike raster element
    if (this.spikeRaster) {
      container.appendChild(this.spikeRaster.getElement());
    }
    
    // Debug spike button
    const spikeButton = document.createElement("button");
    spikeButton.textContent = "Trigger Spike";
    spikeButton.style.cssText = `
      position: absolute;
      bottom: 10px;
      right: 320px;
      z-index: 10;
    `;
    spikeButton.onclick = () => {
      if (this.spikeRaster) {
        const regionIds = this.graph.regionOrder;
        const regionId = regionIds[Math.floor(Math.random() * regionIds.length)];
        this.debugRecordSpike(regionId, Math.floor(Math.random() * 10));
      }
    };
    container.appendChild(spikeButton);
    
    // Working memory toggle
    const wmButton = document.createElement("button");
    wmButton.textContent = "Show Working Memory";
    wmButton.style.cssText = `
      position: absolute;
      bottom: 40px;
      right: 10px;
      z-index: 10;
    `;
    wmButton.onclick = () => {
      const regions = ["prefrontal-l", "prefrontal-r", "temporal-l", "hippocampus-l"];
      this.visualizeWorkingMemory(
        this.workingMemoryGroup.visible ? [] : regions,
        1.0
      );
    };
    container.appendChild(wmButton);
  }

  // ... existing dispose() ...

  dispose(): void {
    // ... existing dispose logic ...
    
    if (this.spikeRaster) {
      this.spikeRaster.dispose();
      this.spikeRaster = null;
    }
    
    while (this.workingMemoryGroup.children.length > 0) {
      this.workingMemoryGroup.remove(this.workingMemoryGroup.children[0]);
    }
  }
}