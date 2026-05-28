const express = require("express");
const fetch = require("node-fetch");
const { spawn } = require("child_process");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const MESHY_API_KEY = process.env.MESHY_API_KEY;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
  res.json({ status: "CAD Copilot Backend running", version: "10.0.0" });
});

// ── Meshy endpoints ──
app.post("/generate-3d", async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });
    const dataURI = `data:${mediaType || "image/png"};base64,${imageBase64}`;
    const r = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: dataURI, ai_model: "meshy-6", should_remesh: true, should_texture: true, enable_pbr: true, target_formats: ["glb", "obj", "stl"] }),
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d?.message || "Meshy error" });
    res.json({ taskId: d.result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/task-status/:taskId", async (req, res) => {
  try {
    const r = await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${req.params.taskId}`, {
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}` },
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d?.message });
    res.json({ status: d.status, progress: d.progress || 0, modelUrls: d.model_urls || null, error: d.task_error?.message || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/generate-3d-text", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });
    const r = await fetch("https://api.meshy.ai/openapi/v2/text-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "preview", prompt: prompt.substring(0, 600), should_remesh: true, target_formats: ["glb", "obj", "stl"] }),
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d?.message });
    res.json({ taskId: d.result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/refine-3d-text", async (req, res) => {
  try {
    const { previewTaskId } = req.body;
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });
    const r = await fetch("https://api.meshy.ai/openapi/v2/text-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "refine", preview_task_id: previewTaskId, target_formats: ["glb", "obj", "stl"] }),
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d?.message });
    res.json({ taskId: d.result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/text-task-status/:taskId", async (req, res) => {
  try {
    const r = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${req.params.taskId}`, {
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}` },
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d?.message });
    res.json({ status: d.status, progress: d.progress || 0, modelUrls: d.model_urls || null, error: d.task_error?.message || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/proxy-model", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "url required" });
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({ error: "Failed to fetch" });
    const buf = await r.buffer();
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// ── STL Parser ──
// ══════════════════════════════════════════════════════
function parseBinarySTL(buffer) {
  const tris = [];
  if (buffer.length < 84) return tris;
  const n = buffer.readUInt32LE(80);
  let o = 84;
  for (let i = 0; i < n; i++) {
    if (o + 50 > buffer.length) break;
    tris.push({
      id: i,
      normal: [buffer.readFloatLE(o), buffer.readFloatLE(o+4), buffer.readFloatLE(o+8)],
      v1: [buffer.readFloatLE(o+12), buffer.readFloatLE(o+16), buffer.readFloatLE(o+20)],
      v2: [buffer.readFloatLE(o+24), buffer.readFloatLE(o+28), buffer.readFloatLE(o+32)],
      v3: [buffer.readFloatLE(o+36), buffer.readFloatLE(o+40), buffer.readFloatLE(o+44)],
    });
    o += 50;
  }
  return tris;
}

function getBBox(tris) {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (const t of tris) for (const v of [t.v1,t.v2,t.v3]) {
    minX=Math.min(minX,v[0]); maxX=Math.max(maxX,v[0]);
    minY=Math.min(minY,v[1]); maxY=Math.max(maxY,v[1]);
    minZ=Math.min(minZ,v[2]); maxZ=Math.max(maxZ,v[2]);
  }
  return {minX,maxX,minY,maxY,minZ,maxZ};
}

// ══════════════════════════════════════════════════════
// ── Connectivity-based segmentation ──
// ══════════════════════════════════════════════════════

// Round vertex to a grid to handle floating point imprecision
function vertKey(v, precision = 4) {
  const p = Math.pow(10, precision);
  return `${Math.round(v[0]*p)},${Math.round(v[1]*p)},${Math.round(v[2]*p)}`;
}

// Build adjacency: which triangles share an edge
function buildAdjacency(triangles) {
  // Edge map: edgeKey -> [triIdx, ...]
  const edgeMap = new Map();

  for (let i = 0; i < triangles.length; i++) {
    const tri = triangles[i];
    const verts = [tri.v1, tri.v2, tri.v3];
    for (let j = 0; j < 3; j++) {
      const a = vertKey(verts[j]);
      const b = vertKey(verts[(j+1)%3]);
      // Canonical edge key (sorted)
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push(i);
    }
  }

  // Build adjacency list
  const adj = Array.from({ length: triangles.length }, () => new Set());
  for (const [key, triIndices] of edgeMap) {
    if (triIndices.length === 2) {
      adj[triIndices[0]].add(triIndices[1]);
      adj[triIndices[1]].add(triIndices[0]);
    }
  }

  return adj;
}

// BFS flood fill to find connected components
function findConnectedComponents(triangles, adj) {
  const visited = new Uint8Array(triangles.length);
  const components = [];

  for (let start = 0; start < triangles.length; start++) {
    if (visited[start]) continue;

    const component = [];
    const queue = [start];
    visited[start] = 1;

    while (queue.length > 0) {
      const curr = queue.shift();
      component.push(curr);
      for (const neighbour of adj[curr]) {
        if (!visited[neighbour]) {
          visited[neighbour] = 1;
          queue.push(neighbour);
        }
      }
    }

    components.push(component);
  }

  return components;
}

// Find "thin connections" between large mesh sections
// A thin connection = edge shared by triangles where
// removing those triangles would disconnect large groups
function findThinConnections(triangles, adj, bbox, targetParts) {
  // Strategy: find vertices/edges near natural boundaries
  // Use Y-axis clustering to find where the mesh is "thin"
  
  const rangeY = bbox.maxY - bbox.minY;
  const rangeX = bbox.maxX - bbox.minX;
  const rangeZ = bbox.maxZ - bbox.minZ;

  // Compute cross-sectional "thinness" along each axis
  // Divide into slices and measure how many triangles cross each slice
  const SLICES = 50;
  
  const measureThinness = (axis) => {
    const mn = axis==='x'?bbox.minX:axis==='y'?bbox.minY:bbox.minZ;
    const range = axis==='x'?rangeX:axis==='y'?rangeY:rangeZ;
    const ai = axis==='x'?0:axis==='y'?1:2;
    
    const sliceCounts = new Array(SLICES).fill(0);
    
    for (const tri of triangles) {
      const vs = [tri.v1, tri.v2, tri.v3];
      const minC = Math.min(...vs.map(v => v[ai]));
      const maxC = Math.max(...vs.map(v => v[ai]));
      
      const startSlice = Math.floor((minC - mn) / range * SLICES);
      const endSlice = Math.ceil((maxC - mn) / range * SLICES);
      
      for (let s = Math.max(0, startSlice); s < Math.min(SLICES, endSlice); s++) {
        sliceCounts[s]++;
      }
    }
    
    return sliceCounts;
  };

  // Find local minima in cross-section counts (thin spots)
  const findLocalMinima = (counts, axis) => {
    const mn = axis==='x'?bbox.minX:axis==='y'?bbox.minY:bbox.minZ;
    const range = axis==='x'?rangeX:axis==='y'?rangeY:rangeZ;
    
    const minima = [];
    const globalMax = Math.max(...counts);
    const threshold = globalMax * 0.15; // Only cuts where cross-section < 15% of max
    
    for (let i = 2; i < counts.length - 2; i++) {
      const isLocalMin = counts[i] <= counts[i-1] && counts[i] <= counts[i+1] &&
                         counts[i] <= counts[i-2] && counts[i] <= counts[i+2];
      
      if (isLocalMin && counts[i] < threshold && counts[i] > 0) {
        const pos = (mn + (i / SLICES) * range);
        const normalizedPos = i / SLICES;
        // Only consider cuts well within bounds
        if (normalizedPos > 0.1 && normalizedPos < 0.9) {
          minima.push({ axis, pos, normalizedPos, count: counts[i], score: globalMax / (counts[i] + 1) });
        }
      }
    }
    
    return minima;
  };

  // Analyse all three axes
  const allMinima = [];
  for (const axis of ['x', 'y', 'z']) {
    const counts = measureThinness(axis);
    const minima = findLocalMinima(counts, axis);
    allMinima.push(...minima);
  }

  // Sort by score (higher = thinner connection = better cut point)
  allMinima.sort((a, b) => b.score - a.score);

  // Deduplicate — remove minima too close to each other on the same axis
  const MIN_SEPARATION = 0.08;
  const selected = [];
  for (const m of allMinima) {
    const tooClose = selected.some(s => 
      s.axis === m.axis && Math.abs(s.normalizedPos - m.normalizedPos) < MIN_SEPARATION
    );
    if (!tooClose) selected.push(m);
    if (selected.length >= targetParts - 1) break;
  }

  console.log("Found thin connections:", selected.map(s => `${s.axis}@${s.normalizedPos.toFixed(2)} score=${s.score.toFixed(0)}`));
  return selected;
}

// ══════════════════════════════════════════════════════
// ── Triangle clipper (for clean edges at cut planes) ──
// ══════════════════════════════════════════════════════
function lerp(v1, v2, t) {
  return [v1[0]+(v2[0]-v1[0])*t, v1[1]+(v2[1]-v1[1])*t, v1[2]+(v2[2]-v1[2])*t];
}

function triArea(v1, v2, v3) {
  const ax=v2[0]-v1[0], ay=v2[1]-v1[1], az=v2[2]-v1[2];
  const bx=v3[0]-v1[0], by=v3[1]-v1[1], bz=v3[2]-v1[2];
  return 0.5*Math.sqrt((ay*bz-az*by)**2+(az*bx-ax*bz)**2+(ax*by-ay*bx)**2);
}

function clipTriangle(tri, axis, cutVal) {
  const ai = axis==='x'?0:axis==='y'?1:2;
  const vs = [tri.v1, tri.v2, tri.v3];
  const cs = vs.map(v => v[ai]);
  const SNAP = 0.0001;

  const snappedVs = vs.map((v,i) => {
    if (Math.abs(cs[i]-cutVal) < SNAP) { const s=[...v]; s[ai]=cutVal; return s; }
    return v;
  });
  const snappedCs = snappedVs.map(v => v[ai]);
  const belowMask = snappedCs.map(c => c <= cutVal);
  const belowCount = belowMask.filter(Boolean).length;

  if (belowCount === 3) return { below: [{ normal: tri.normal, v1: snappedVs[0], v2: snappedVs[1], v3: snappedVs[2] }], above: [] };
  if (belowCount === 0) return { below: [], above: [{ normal: tri.normal, v1: snappedVs[0], v2: snappedVs[1], v3: snappedVs[2] }] };

  const pairs = [[0,1],[1,2],[2,0]];
  const intersections = [];
  for (const [i,j] of pairs) {
    if (belowMask[i] !== belowMask[j]) {
      const denom = snappedCs[j]-snappedCs[i];
      if (Math.abs(denom) < 1e-10) continue;
      const t = (cutVal-snappedCs[i])/denom;
      const pt = lerp(snappedVs[i], snappedVs[j], t);
      pt[ai] = cutVal;
      intersections.push({ pt, i, j });
    }
  }

  if (intersections.length < 2) {
    return belowCount > 0 ? { below: [tri], above: [] } : { below: [], above: [tri] };
  }

  const p1 = intersections[0].pt;
  const p2 = intersections[1].pt;
  const minArea = 1e-10;

  if (belowCount === 1) {
    const i0 = belowMask.indexOf(true);
    const i1=(i0+1)%3, i2=(i0+2)%3;
    const below = [{ normal: tri.normal, v1: snappedVs[i0], v2: p1, v3: p2 }].filter(t=>triArea(t.v1,t.v2,t.v3)>minArea);
    const above = [
      { normal: tri.normal, v1: snappedVs[i1], v2: snappedVs[i2], v3: p2 },
      { normal: tri.normal, v1: snappedVs[i1], v2: p2, v3: p1 },
    ].filter(t=>triArea(t.v1,t.v2,t.v3)>minArea);
    return { below, above };
  } else {
    const i0 = belowMask.indexOf(false);
    const i1=(i0+1)%3, i2=(i0+2)%3;
    const below = [
      { normal: tri.normal, v1: snappedVs[i1], v2: snappedVs[i2], v3: p1 },
      { normal: tri.normal, v1: snappedVs[i2], v2: p2, v3: p1 },
    ].filter(t=>triArea(t.v1,t.v2,t.v3)>minArea);
    const above = [{ normal: tri.normal, v1: snappedVs[i0], v2: p2, v3: p1 }].filter(t=>triArea(t.v1,t.v2,t.v3)>minArea);
    return { below, above };
  }
}

function applyPlaneCut(triangles, axis, cutVal) {
  const below=[], above=[];
  for (const tri of triangles) {
    const r = clipTriangle(tri, axis, cutVal);
    below.push(...r.below);
    above.push(...r.above);
  }
  return { below, above };
}

// ══════════════════════════════════════════════════════
// ── Main smart slicer ──
// ══════════════════════════════════════════════════════
function smartSlice(triangles, targetParts, manualCutPlanes) {
  const bbox = getBBox(triangles);

  let cutPlanes;

  if (manualCutPlanes && manualCutPlanes.length > 0) {
    // Use manual cuts if provided
    cutPlanes = manualCutPlanes.map(cp => ({
      axis: cp.axis || 'y',
      pos: (axis => {
        const mn = axis==='x'?bbox.minX:axis==='y'?bbox.minY:bbox.minZ;
        const mx = axis==='x'?bbox.maxX:axis==='y'?bbox.maxY:bbox.maxZ;
        return mn + (mx-mn) * Math.max(0.05, Math.min(0.95, cp.position || 0.5));
      })(cp.axis || 'y'),
    }));
    console.log("Using manual cuts:", cutPlanes.map(c=>`${c.axis}@${c.pos.toFixed(3)}`));
  } else {
    // Auto-detect thin connections
    const thinConnections = findThinConnections(triangles, null, bbox, targetParts);
    cutPlanes = thinConnections.map(tc => ({
      axis: tc.axis,
      pos: tc.pos,
    }));

    if (cutPlanes.length === 0) {
      // Fallback: single Y cut at 0.3 (separates legs from body)
      const yMid = bbox.minY + (bbox.maxY - bbox.minY) * 0.3;
      cutPlanes = [{ axis: 'y', pos: yMid }];
    }
  }

  // Sort cuts: Z first, Y second, X last
  const axOrder = { z:0, y:1, x:2 };
  cutPlanes.sort((a,b) => {
    const ao = axOrder[a.axis]??1, bo = axOrder[b.axis]??1;
    if (ao !== bo) return ao-bo;
    return a.pos - b.pos;
  });

  // Apply cuts sequentially with proper clipping
  const parts = [];
  let remaining = [...triangles];

  for (const cp of cutPlanes) {
    const { below, above } = applyPlaneCut(remaining, cp.axis, cp.pos);
    if (below.length > 5) parts.push(below);
    remaining = above;
  }
  if (remaining.length > 5) parts.push(remaining);

  return parts;
}

// ══════════════════════════════════════════════════════
// ── STL writer ──
// ══════════════════════════════════════════════════════
function trianglesToBuffer(tris, name) {
  const buf = Buffer.alloc(80 + 4 + tris.length * 50);
  buf.write((name||"Part").substring(0,80).padEnd(80,' '), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    buf.writeFloatLE(t.normal[0],o); buf.writeFloatLE(t.normal[1],o+4); buf.writeFloatLE(t.normal[2],o+8);
    buf.writeFloatLE(t.v1[0],o+12); buf.writeFloatLE(t.v1[1],o+16); buf.writeFloatLE(t.v1[2],o+20);
    buf.writeFloatLE(t.v2[0],o+24); buf.writeFloatLE(t.v2[1],o+28); buf.writeFloatLE(t.v2[2],o+32);
    buf.writeFloatLE(t.v3[0],o+36); buf.writeFloatLE(t.v3[1],o+40); buf.writeFloatLE(t.v3[2],o+44);
    buf.writeUInt16LE(0,o+48);
    o += 50;
  }
  return buf;
}


// ══════════════════════════════════════════════════════
// ── Hollow via Python trimesh (proper mesh offsetting) ──
// ══════════════════════════════════════════════════════
function hollowWithPython(stlBase64, wallMm) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'hollow_stl.py');
    const py = spawn('python3', [scriptPath, String(wallMm)]);

    let stdout = '';
    let stderr = '';

    py.stdout.on('data', d => stdout += d.toString());
    py.stderr.on('data', d => stderr += d.toString());

    py.on('close', code => {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.success) {
          resolve(result.stlBase64);
        } else {
          console.error('Python hollow error:', result.error);
          reject(new Error(result.error || 'Python hollowing failed'));
        }
      } catch(e) {
        console.error('Python stdout:', stdout);
        console.error('Python stderr:', stderr);
        reject(new Error('Failed to parse Python output: ' + e.message));
      }
    });

    py.on('error', err => {
      reject(new Error('Failed to spawn Python: ' + err.message));
    });

    // Send STL base64 to stdin
    py.stdin.write(stlBase64);
    py.stdin.end();
  });
}

// Simple JS fallback for when Python unavailable
function hollowTriangles(tris, wallThicknessMm) {
  if (!tris || tris.length === 0) return tris;
  const t = wallThicknessMm || 2.0;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (const tri of tris) {
    for (const v of [tri.v1, tri.v2, tri.v3]) {
      if(v[0]<minX)minX=v[0]; if(v[0]>maxX)maxX=v[0];
      if(v[1]<minY)minY=v[1]; if(v[1]>maxY)maxY=v[1];
      if(v[2]<minZ)minZ=v[2]; if(v[2]>maxZ)maxZ=v[2];
    }
  }
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2, cz=(minZ+maxZ)/2;
  const sizeX=maxX-minX||1, sizeY=maxY-minY||1, sizeZ=maxZ-minZ||1;
  const scaleX=Math.max(0.05,(sizeX-t*2)/sizeX);
  const scaleY=Math.max(0.05,(sizeY-t*2)/sizeY);
  const scaleZ=Math.max(0.05,(sizeZ-t*2)/sizeZ);
  if(scaleX<0.1||scaleY<0.1||scaleZ<0.1) return tris;
  const innerShell=tris.map(tri=>({
    normal:[-tri.normal[0],-tri.normal[1],-tri.normal[2]],
    v1:[cx+(tri.v3[0]-cx)*scaleX, cy+(tri.v3[1]-cy)*scaleY, cz+(tri.v3[2]-cz)*scaleZ],
    v2:[cx+(tri.v2[0]-cx)*scaleX, cy+(tri.v2[1]-cy)*scaleY, cz+(tri.v2[2]-cz)*scaleZ],
    v3:[cx+(tri.v1[0]-cx)*scaleX, cy+(tri.v1[1]-cy)*scaleY, cz+(tri.v1[2]-cz)*scaleZ],
  }));
  return [...tris, ...innerShell];
}

// ══════════════════════════════════════════════════════
// ── POST /slice-stl ──
// ══════════════════════════════════════════════════════
app.post("/slice-stl", async (req, res) => {
  try {
    const { stlUrl, stlBase64, cutPlanes, partNames, targetParts, hollow, wallThickness } = req.body;
    if (!stlUrl && !stlBase64) return res.status(400).json({ error: "stlUrl or stlBase64 is required" });

    let stlBuf;
    if (stlBase64) {
      console.log(`v10: Using base64 STL...`);
      stlBuf = Buffer.from(stlBase64, 'base64');
    } else {
      console.log(`v10: Downloading STL...`);
      const stlRes = await fetch(stlUrl);
      if (!stlRes.ok) throw new Error(`Failed to download STL: ${stlRes.status}`);
      stlBuf = await stlRes.buffer();
    }

    const triangles = parseBinarySTL(stlBuf);
    console.log(`Parsed ${triangles.length} triangles`);

    // Use smart slicer — auto-detects thin connections OR uses manual cuts
    const numParts = targetParts || (partNames?.length) || 4;
    const parts = smartSlice(triangles, numParts, cutPlanes?.length > 0 ? cutPlanes : null);
    console.log(`Parts created:`, parts.map(p => p.length));

    const results = parts.map((tris, i) => {
      // Apply hollow/fill setting per part
      const finalTris = hollow ? hollowTriangles(tris, wallThickness || 2.0) : tris;
      return {
        partName: partNames?.[i] || `Part ${i+1}`,
        triangleCount: finalTris.length,
        stlBase64: trianglesToBuffer(finalTris, partNames?.[i] || `Part_${i+1}`).toString('base64'),
        hollow: !!hollow,
        wallThickness: hollow ? (wallThickness || 2.0) : null,
      };
    }).filter(p => p.triangleCount > 5);

    res.json({ success: true, parts: results, method: cutPlanes?.length > 0 ? "manual" : "auto-detect" });
  } catch (err) {
    console.error("/slice-stl error:", err);
    res.status(500).json({ error: err.message });
  }
});



// ══════════════════════════════════════════════════════
// ── POST /hollow-stl — proper hollowing via Python trimesh ──
// ══════════════════════════════════════════════════════
app.post("/hollow-stl", async (req, res) => {
  try {
    const { stlBase64, wallThickness } = req.body;
    if (!stlBase64) return res.status(400).json({ error: "stlBase64 required" });
    const wall = parseFloat(wallThickness) || 2.0;

    try {
      // Try Python trimesh first (proper hollowing)
      const hollowedB64 = await hollowWithPython(stlBase64, wall);
      const buf = Buffer.from(hollowedB64, 'base64');
      res.json({ success: true, stlBase64: hollowedB64, triangleCount: (buf.length - 84) / 50, method: 'trimesh' });
    } catch(pyErr) {
      console.warn('Python hollow failed, using JS fallback:', pyErr.message);
      // Fallback to JS method
      const buf = Buffer.from(stlBase64, 'base64');
      const triangles = parseBinarySTL(buf);
      const hollowed = hollowTriangles(triangles, wall);
      const result = trianglesToBuffer(hollowed, "Hollow_Part");
      res.json({ success: true, stlBase64: result.toString('base64'), triangleCount: hollowed.length, method: 'js-fallback' });
    }
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// ── History Storage (persistent, per user) ──
// ══════════════════════════════════════════════════════
const fs = require('fs');
const HISTORY_DIR = path.join('/tmp', 'cad-history');
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

function historyPath(userId, tool) {
  // Sanitise userId to prevent path traversal
  const safe = (userId||'anon').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);
  const safeTool = (tool||'image').replace(/[^a-z]/g, '');
  return path.join(HISTORY_DIR, `${safe}_${safeTool}.json`);
}

// GET /history/:tool?userId=xxx
app.get('/history/:tool', (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const p = historyPath(userId, req.params.tool);
    if (!fs.existsSync(p)) return res.json({ history: [] });
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    res.json({ history: data });
  } catch(e) { res.json({ history: [] }); }
});

// POST /history/:tool  { userId, history: [...] }
app.post('/history/:tool', (req, res) => {
  try {
    const { userId, history } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const p = historyPath(userId, req.params.tool);
    // Keep last 20 entries, strip huge base64 fields to save space
    const trimmed = (history || []).slice(0, 20).map(e => ({
      ...e,
      // Keep stlBase64 but truncate fullResult to save space  
      fullResult: e.fullResult ? { ...e.fullResult, openscad: undefined } : undefined,
    }));
    fs.writeFileSync(p, JSON.stringify(trimmed));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /history/:tool  { userId }
app.delete('/history/:tool', (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const p = historyPath(userId, req.params.tool);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`CAD Copilot Backend v10 running on port ${PORT}`));
