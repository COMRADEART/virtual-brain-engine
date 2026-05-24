// Spiking-stability diagnostic. Reads the LIVE AdvancedBrainCore internals over
// CDP (membrane potentials, per-region drive, synaptic conductances, spike counts)
// to diagnose the network's dynamical regime. This is the tool that uncovered the
// epileptic-runaway state documented in docs/IMPROVEMENT_PLAN.md (🔴 Critical
// finding). Requires BrainScene to expose window.__sim/__fx/__gr — re-add those
// dev-only globals in BrainScene effect2 before running, remove after.
//   usage: npm run dev, then `node scripts/diag-probe.mjs`
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/?useSpiking=true";
const WAIT = Number(process.env.SHOT_WAIT_MS ?? 10000);
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 45000);

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chromePath = chromeCandidates.find((c) => existsSync(c));
const userDataDir = path.join(os.tmpdir(), `cdp-probe-${process.pid}`);
const chrome = spawn(chromePath, [
  "--headless=new", "--no-first-run", "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`, "--window-size=1440,900", TARGET_URL,
], { stdio: ["ignore", "ignore", "pipe"] });

let stderr = "";
chrome.stderr.on("data", (c) => { stderr += String(c); });
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no port")), 10000);
  const iv = setInterval(() => {
    const m = stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) { clearInterval(iv); clearTimeout(t); resolve(Number(m[1])); }
  }, 100);
});
const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const pageTab = tabs.find((t) => t.type === "page") ?? tabs[0];
const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
await send("Page.navigate", { url: TARGET_URL });
await new Promise((r) => setTimeout(r, WAIT));

const probe = await send("Runtime.evaluate", {
  expression: `(() => {
    const sim = window.__sim, fx = window.__fx, gr = window.__gr;
    const mn = sim && sim.membranePotentialNorm;
    const arr = mn ? Array.from(mn) : null;
    let min=1, max=0, sum=0, nz=0;
    if (arr) for (const x of arr) { if (x<min) min=x; if (x>max) max=x; sum+=x; if (x>0.001) nz++; }
    // inspect the actual GPU attribute the shader reads
    const geo = fx && fx.neuronAttrGeometry;
    const mAttr = geo && geo.getAttribute && geo.getAttribute('membraneNorm');
    const mArr = mAttr ? Array.from(mAttr.array.slice(0,8)) : null;
    // is the neuron mesh material the custom shader?
    const nMesh = gr && gr.neuronMesh;
    const isShader = nMesh && nMesh.material && !!nMesh.material.vertexShader;
    // neuron mesh render state — why are instances not visible?
    let meshState = null;
    if (nMesh) {
      const mat = nMesh.material;
      // decompose first few instance scales
      const im = nMesh.instanceMatrix && nMesh.instanceMatrix.array;
      const scales = [];
      if (im) for (let q=0; q<5; q++){ const o=q*16; // matrix scale = length of basis cols
        const sx=Math.hypot(im[o+0],im[o+1],im[o+2]); scales.push(+sx.toFixed(4)); }
      const geo = nMesh.geometry;
      geo && geo.computeBoundingSphere && !geo.boundingSphere && geo.computeBoundingSphere();
      meshState = {
        visible: nMesh.visible, count: nMesh.count, frustumCulled: nMesh.frustumCulled,
        inScene: !!(nMesh.parent),
        matTransparent: mat && mat.transparent, matDepthTest: mat && mat.depthTest,
        matDepthWrite: mat && mat.depthWrite, matBlending: mat && mat.blending,
        matVisible: mat && mat.visible, matOpacity: mat && mat.opacity,
        instScales: scales,
        geoBoundR: geo && geo.boundingSphere && +geo.boundingSphere.radius.toFixed(4),
        renderOrder: nMesh.renderOrder,
        // is MY edited shader actually in the live material?
        fragHasMagenta: mat && typeof mat.fragmentShader === 'string' && mat.fragmentShader.includes('force opaque magenta'),
        vertNoInstance: mat && typeof mat.vertexShader === 'string' && mat.vertexShader.includes('no instanceMatrix'),
        // geometry integrity
        posCount: geo && geo.getAttribute && geo.getAttribute('position') && geo.getAttribute('position').count,
        idxCount: geo && geo.index && geo.index.count,
        instMatCount: nMesh.instanceMatrix && nMesh.instanceMatrix.count,
        hasMembraneAttr: !!(geo && geo.getAttribute && geo.getAttribute('membraneNorm')),
        // world transform of the mesh (group scale could be 0)
        wScale: (() => { const s = new (window.THREE ? window.THREE.Vector3 : Object)(); try { nMesh.getWorldScale(s); return [+s.x.toFixed(3),+s.y.toFixed(3),+s.z.toFixed(3)]; } catch(e){ return 'n/a'; } })(),
        parentVisible: nMesh.parent && nMesh.parent.visible,
        parentType: nMesh.parent && nMesh.parent.type,
      };
    }
    // internal drive state (TS 'private' is not runtime-enforced)
    const rd = sim && sim.regionDrive ? Array.from(sim.regionDrive) : null;
    let rdMin=1e9, rdMax=-1e9; if (rd) for (const x of rd){ if(x<rdMin)rdMin=x; if(x>rdMax)rdMax=x; }
    const homeo = sim && sim.dynamics && sim.dynamics.getHomeostaticGain ? sim.dynamics.getHomeostaticGain() : null;
    const rn = sim && sim.regionNeurons;
    const rnSizes = rn ? rn.map(a => a.length) : null;
    const rnTotal = rnSizes ? rnSizes.reduce((a,b)=>a+b,0) : null;
    const ls = sim && sim.izh && sim.izh.getLastStepSpikes ? sim.izh.getLastStepSpikes() : null;
    const lastSpikes = ls ? ls.length : null;
    const lsSample = ls ? Array.from(ls.slice(0,10)) : null;
    const lsUnique = ls ? new Set(ls).size : null;
    const stat = (a) => { if(!a) return null; let mn=1e18,mx=-1e18,s=0; for(const x of a){if(x<mn)mn=x;if(x>mx)mx=x;s+=x;} return {min:+mn.toFixed(2),max:+mx.toFixed(2),mean:+(s/a.length).toFixed(2)}; };
    const gAmpa = sim && sim.izh && sim.izh.g_ampa ? stat(sim.izh.g_ampa) : null;
    const gNmda = sim && sim.izh && sim.izh.g_nmda ? stat(sim.izh.g_nmda) : null;
    const gGabaA = sim && sim.izh && sim.izh.g_gaba_a ? stat(sim.izh.g_gaba_a) : null;
    const uStat = sim && sim.izh && sim.izh.u ? stat(sim.izh.u) : null;
    // raw membrane voltage range (mV) for sanity
    const vv = sim && sim.izh && sim.izh.v ? Array.from(sim.izh.v) : null;
    let vMin=1e9, vMax=-1e9; if (vv) for (const x of vv){ if(x<vMin)vMin=x; if(x>vMax)vMax=x; }
    return JSON.stringify({
      running: sim && sim.running, actionId: sim && sim.actionId,
      memMin: arr && +min.toFixed(3), memMax: arr && +max.toFixed(3),
      memMean: arr && +(sum/arr.length).toFixed(3), memNonZero: nz,
      regionDriveMin: rd && +rdMin.toFixed(3), regionDriveMax: rd && +rdMax.toFixed(3),
      homeostaticGain: homeo,
      regionNeuronTotal: rnTotal, regionCount: rnSizes && rnSizes.length,
      regionsWithNeurons: rnSizes && rnSizes.filter(s=>s>0).length,
      lastStepSpikes: lastSpikes, lsUnique, lsSample,
      gAmpa, gNmda, gGabaA, uStat,
      vMin: vv && +vMin.toFixed(2), vMax: vv && +vMax.toFixed(2),
      neuronIsCustomShader: isShader, neuronCount: nMesh && nMesh.count,
      meshState,
      neuronDraws: window.__neuronDraws ?? null,
      // what objects are actually in the graph renderer group?
      groupChildren: gr && gr.group && gr.group.children
        ? gr.group.children.map(c => ({ type: c.type, visible: c.visible,
            count: c.count, isInstanced: !!c.isInstancedMesh,
            matType: c.material && (Array.isArray(c.material) ? 'arr' : c.material.type) }))
        : null,
      neuronMatType: nMesh && nMesh.material && nMesh.material.type,
      fxGroupChildren: fx && fx.group && fx.group.children
        ? fx.group.children.map(c => ({ type: c.type, visible: c.visible, name: c.name || '',
            n: c.children ? c.children.length : (c.count || undefined),
            matType: c.material && (Array.isArray(c.material) ? 'arr' : c.material.type) }))
        : null,
    });
  })()`,
  returnByValue: true,
});
console.log("PROBE:", probe?.result?.value ?? probe?.exceptionDetails?.text ?? "no result");
chrome.kill();
process.exit(0);
