import type {
  VisualKnowledgeGraph,
  VisualKnowledgeNode,
  VisualKnowledgeEdge,
  BoundingBox,
} from "../../../shared/vision.js";

class VisualKG {
  private nodes: Map<string, VisualKnowledgeNode> = new Map();
  private edges: VisualKnowledgeEdge[] = [];
  private activeWindowId: string | null = null;
  private lastCaptureId: string = "";

  getGraph(): VisualKnowledgeGraph {
    return {
      nodes: new Map(this.nodes),
      edges: [...this.edges],
      lastCaptureId: this.lastCaptureId,
      activeWindowId: this.activeWindowId,
    };
  }

  addNode(node: VisualKnowledgeNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: VisualKnowledgeEdge): void {
    const exists = this.edges.some(
      (e) => e.source === edge.source && e.target === edge.target
    );
    if (!exists) {
      this.edges.push(edge);
    }
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    this.edges = this.edges.filter((e) => e.source !== id && e.target !== id);
  }

  getNode(id: string): VisualKnowledgeNode | undefined {
    return this.nodes.get(id);
  }

  setActiveWindow(nodeId: string | null): void {
    this.activeWindowId = nodeId;
    if (nodeId) {
      const node = this.nodes.get(nodeId);
      if (node) {
        node.timestamp = Date.now();
      }
    }
  }

  updateLastCapture(captureId: string): void {
    this.lastCaptureId = captureId;
  }

  findNodesByApp(app: string): VisualKnowledgeNode[] {
    return Array.from(this.nodes.values()).filter(
      (n) => n.app.toLowerCase() === app.toLowerCase()
    );
  }

  findNodesByType(
    type: VisualKnowledgeNode["type"]
  ): VisualKnowledgeNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.type === type);
  }

  findNodesInRegion(bounds: BoundingBox): VisualKnowledgeNode[] {
    return Array.from(this.nodes.values()).filter((node) => {
      return this.boundsOverlap(bounds, node.position);
    });
  }

  private boundsOverlap(a: BoundingBox, b: BoundingBox): boolean {
    return !(
      a.x + a.width < b.x ||
      b.x + b.width < a.x ||
      a.y + a.height < b.y ||
      b.y + b.height < a.y
    );
  }

  addChildRelation(parentId: string, childId: string): void {
    const parent = this.nodes.get(parentId);
    const child = this.nodes.get(childId);

    if (parent && child) {
      parent.children.push(childId);
      child.parent = parentId;

      this.addEdge({
        source: parentId,
        target: childId,
        relation: "contains",
        weight: 0.9,
      });
    }
  }

  getRelatedNodes(
    nodeId: string,
    relation?: VisualKnowledgeEdge["relation"]
  ): VisualKnowledgeNode[] {
    const relatedIds = this.edges
      .filter((e) => {
        if (e.source === nodeId) return true;
        if (e.target === nodeId && relation === undefined) return true;
        return false;
      })
      .filter((e) => (relation ? e.relation === relation : true))
      .flatMap((e) => (e.source === nodeId ? [e.target] : [e.source]));

    return relatedIds
      .map((id) => this.nodes.get(id))
      .filter((n): n is VisualKnowledgeNode => n !== undefined);
  }

  clear(): void {
    this.nodes.clear();
    this.edges = [];
    this.activeWindowId = null;
    this.lastCaptureId = "";
  }

  pruneOldNodes(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let pruned = 0;

    for (const [id, node] of this.nodes) {
      if (now - node.timestamp > maxAgeMs && id !== this.activeWindowId) {
        this.removeNode(id);
        pruned++;
      }
    }

    return pruned;
  }

  getStats(): {
    nodeCount: number;
    edgeCount: number;
    nodesByType: Record<string, number>;
    activeWindow: string | null;
  } {
    const nodesByType: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      nodesByType,
      activeWindow: this.activeWindowId,
    };
  }
}

export const visualKnowledgeGraph = new VisualKG();

export function createKnowledgeNode(
  id: string,
  type: VisualKnowledgeNode["type"],
  app: string,
  position: BoundingBox,
  captureId: string,
  text?: string
): VisualKnowledgeNode {
  return {
    id,
    type,
    app,
    position,
    text,
    children: [],
    parent: null,
    captureId,
    timestamp: Date.now(),
  };
}

export function inferRelations(
  nodes: VisualKnowledgeNode[]
): VisualKnowledgeEdge[] {
  const edges: VisualKnowledgeEdge[] = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];

      if (a.captureId !== b.captureId) continue;

      if (isInside(a.position, b.position)) {
        edges.push({
          source: b.id,
          target: a.id,
          relation: "contains",
          weight: calculateOverlapConfidence(a.position, b.position),
        });
      } else if (isInside(b.position, a.position)) {
        edges.push({
          source: a.id,
          target: b.id,
          relation: "contains",
          weight: calculateOverlapConfidence(b.position, a.position),
        });
      } else if (overlaps(a.position, b.position)) {
        edges.push({
          source: a.id,
          target: b.id,
          relation: "overlaps",
          weight: calculateOverlapConfidence(a.position, b.position),
        });
      }
    }
  }

  return edges;
}

function isInside(inner: BoundingBox, outer: BoundingBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function overlaps(a: BoundingBox, b: BoundingBox): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

function calculateOverlapConfidence(inner: BoundingBox, outer: BoundingBox): number {
  const overlapArea =
    Math.max(0, Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x)) *
    Math.max(0, Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y));

  const innerArea = inner.width * inner.height;
  if (innerArea === 0) return 0;

  return Math.min(1, overlapArea / innerArea);
}