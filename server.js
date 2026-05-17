const express = require("express");
const fetch = require("node-fetch");

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
  res.json({ status: "CAD Copilot Backend running", version: "6.0.0" });
});

// ── Meshy endpoints ──
app.post("/generate-3d", async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });
    const dataURI = `data:${mediaType || "image/png"};base64,${imageBase64}`;
    const meshyRes = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: dataURI, ai_model: "meshy-6", should_remesh: true, should_texture: true, enable_pbr: true, target_formats: ["glb", "obj", "stl"] }),
    });
    const data = await meshyRes.json();
    if (!meshyRes.ok) return res.status(meshyRes.status).json({ error: data?.message || "Meshy error" });
    res.json({ taskId: data.result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/task-status/:taskId", async (req, res) => {
  try {
    const meshyRes = await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${req.params.taskId}`, {
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}` },
    });
    const data = await meshyRes.json();
    if (!meshyRes.ok) return res.status(meshyRes.status).json({ error: data?.message });
    res.json({ status: data.status, progress: data.progress || 0, modelUrls: data.model_urls || null, error: data.task_error?.message || null });
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

// ── STL utilities ──
function parseBinarySTL(buffer) {
  const triangles = [];
  if (buffer.length < 84) return triangles;
  const n = buffer.readUInt32LE(80);
  let offset = 84;
  for (let i = 0; i < n; i++) {
    if (offset + 50 > buffer.length) break;
    triangles.push({
      normal: [buffer.readFloatLE(offset), buffer.readFloatLE(offset+4), buffer.readFloatLE(offset+8)],
      v1: [buffer.readFloatLE(offset+12), buffer.readFloatLE(offset+16), buffer.readFloatLE(offset+20)],
      v2: [buffer.readFloatLE(offset+24), buffer.readFloatLE(offset+28), buffer.readFloatLE(offset+32)],
      v3: [buffer.readFloatLE(offset+36), buffer.readFloatLE(offset+40), buffer.readFloatLE(offset+44)],
    });
    offset += 50;
  }
  return triangles;
}

function getBBox(triangles) {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (const t of triangles) for (const v of [t.v1,t.v2,t.v3]) {
    minX=Math.min(minX,v[0]); maxX=Math.max(maxX,v[0]);
    minY=Math.min(minY,v[1]); maxY=Math.max(maxY,v[1]);
    minZ=Math.min(minZ,v[2]); maxZ=Math.max(maxZ,v[2]);
  }
  return {minX,maxX,minY,maxY,minZ,maxZ};
}

function lerp(v1,v2,t) {
  return [v1[0]+(v2[0]-v1[0])*t, v1[1]+(v2[1]-v1[1])*t, v1[2]+(v2[2]-v1[2])*t];
}

function axisIdx(axis) { return axis==='x'?0:axis==='y'?1:2; }

function getCoord(v,axis) { return v[axisIdx(axis)]; }

// ── Clip triangle against a plane (below = coord <= cutVal) ──
function clipTri(tri, axis, cutVal, below) {
  const vs = [tri.v1, tri.v2, tri.v3];
  const cs = vs.map(v => getCoord(v, axis));
  const ins = cs.map(c => below ? c <= cutVal : c >= cutVal);
  const inCount = ins.filter(Boolean).length;

  if (inCount === 3) return { tris: [tri], edges: [] };
  if (inCount === 0) return { tris: [], edges: [] };

  if (inCount === 1) {
    const i0 = ins.indexOf(true), i1=(i0+1)%3, i2=(i0+2)%3;
    const t1 = (cutVal-cs[i0])/(cs[i1]-cs[i0]);
    const t2 = (cutVal-cs[i0])/(cs[i2]-cs[i0]);
    const p1 = lerp(vs[i0],vs[i1],t1);
    const p2 = lerp(vs[i0],vs[i2],t2);
    return { tris: [{ normal: tri.normal, v1: vs[i0], v2: p1, v3: p2 }], edges: [[p1,p2]] };
  } else {
    const i0 = ins.indexOf(false), i1=(i0+1)%3, i2=(i0+2)%3;
    const t1 = (cutVal-cs[i1])/(cs[i0]-cs[i1]);
    const t2 = (cutVal-cs[i2])/(cs[i0]-cs[i2]);
    const p1 = lerp(vs[i1],vs[i0],t1);
    const p2 = lerp(vs[i2],vs[i0],t2);
    return {
      tris: [
        { normal: tri.normal, v1: vs[i1], v2: vs[i2], v3: p1 },
        { normal: tri.normal, v1: vs[i2], v2: p2, v3: p1 },
      ],
      edges: [[p1,p2]],
    };
  }
}

// ── Cylindrical cut — splits based on distance from central axis ──
function clipTriCylindrical(tri, axis, cutVal, radius, bbox, inside) {
  // axis = main axis of cylinder, radius = normalized 0-1
  const vs = [tri.v1, tri.v2, tri.v3];
  const ai = axisIdx(axis);

  // Get the two perpendicular axes
  const perp1 = ai === 0 ? 1 : 0;
  const perp2 = ai === 2 ? 1 : 2;

  // Centre of bbox on perpendicular axes
  const cx = ai===0 ? (bbox.minY+bbox.maxY)/2 : (bbox.minX+bbox.maxX)/2;
  const cy = ai===2 ? (bbox.minY+bbox.maxY)/2 : (bbox.minZ+bbox.maxZ)/2;

  // Radius in world units
  const rangeX = ai===0 ? bbox.maxY-bbox.minY : bbox.maxX-bbox.minX;
  const rangeY = ai===2 ? bbox.maxY-bbox.minY : bbox.maxZ-bbox.minZ;
  const worldRadius = radius * Math.max(rangeX, rangeY) / 2;

  // Classify each vertex - inside cylinder or outside
  const classify = (v) => {
    const dx = v[perp1] - cx;
    const dy = v[perp2] - cy;
    const dist = Math.sqrt(dx*dx + dy*dy);
    return inside ? dist <= worldRadius : dist >= worldRadius;
  };

  const ins = vs.map(classify);
  const inCount = ins.filter(Boolean).length;

  if (inCount === 3) return [tri];
  if (inCount === 0) return [];

  // For partial intersections just use centroid classification
  const centroid = [
    (vs[0][0]+vs[1][0]+vs[2][0])/3,
    (vs[0][1]+vs[1][1]+vs[2][1])/3,
    (vs[0][2]+vs[1][2]+vs[2][2])/3,
  ];
  return classify(centroid) ? [tri] : [];
}

// ── Angled cut ──
function clipTriAngled(tri, axis, cutVal, tilt, bbox, below) {
  const ai = axisIdx(axis);
  const perpIdx = ai === 1 ? 0 : 1;

  const vs = [tri.v1, tri.v2, tri.v3];
  const range = axis==='x' ? bbox.maxX-bbox.minX : axis==='y' ? bbox.maxY-bbox.minY : bbox.maxZ-bbox.minZ;
  const perpRange = perpIdx===0 ? bbox.maxX-bbox.minX : bbox.maxY-bbox.minY;
  const perpMin = perpIdx===0 ? bbox.minX : bbox.minY;

  const classify = (v) => {
    const perpNorm = (v[perpIdx] - perpMin) / (perpRange || 1);
    const adjustedCut = cutVal + tilt * (perpNorm - 0.5);
    const worldCut = (axis==='x'?bbox.minX:axis==='y'?bbox.minY:bbox.minZ) + adjustedCut * range;
    return below ? v[ai] <= worldCut : v[ai] >= worldCut;
  };

  const ins = vs.map(classify);
  const inCount = ins.filter(Boolean).length;
  if (inCount === 3) return [tri];
  if (inCount === 0) return [];
  const centroid = [(vs[0][0]+vs[1][0]+vs[2][0])/3,(vs[0][1]+vs[1][1]+vs[2][1])/3,(vs[0][2]+vs[1][2]+vs[2][2])/3];
  return classify(centroid) ? [tri] : [];
}

// ── Generate cap to close cut ──
function generateCap(edges, normalVec) {
  if (edges.length === 0) return [];
  let cx=0,cy=0,cz=0;
  for (const [p1,p2] of edges) { cx+=(p1[0]+p2[0])/2; cy+=(p1[1]+p2[1])/2; cz+=(p1[2]+p2[2])/2; }
  cx/=edges.length; cy/=edges.length; cz/=edges.length;
  return edges.map(([p1,p2]) => ({ normal: normalVec, v1: [cx,cy,cz], v2: p1, v3: p2 }));
}

// ── Main slicer — handles straight, cylindrical, angled ──
function sliceMesh(triangles, cutPlanes) {
  const bbox = getBBox(triangles);

  // Sort planes by position
  const planes = [...cutPlanes].sort((a,b) => (a.position||0.5)-(b.position||0.5));

  let remaining = [...triangles];
  const parts = [];

  for (const plane of planes) {
    const type = plane.type || 'straight';
    const axis = plane.axis || 'y';
    const pos = plane.position || 0.5;

    if (type === 'cylindrical') {
      // Split into inside cylinder vs outside
      const radius = plane.radius || 0.3;
      const inside = remaining.filter(t => clipTriCylindrical(t, axis, pos, radius, bbox, true).length > 0);
      const outside = remaining.filter(t => clipTriCylindrical(t, axis, pos, radius, bbox, false).length > 0);
      parts.push(inside);
      remaining = outside;

    } else if (type === 'angled') {
      // Angled/tapered cut
      const tilt = plane.tilt || 0.1;
      const belowTris = [], aboveTris = [], belowEdges = [], aboveEdges = [];
      for (const tri of remaining) {
        const b = clipTriAngled(tri, axis, pos, tilt, bbox, true);
        const a = clipTriAngled(tri, axis, pos, -tilt, bbox, false);
        belowTris.push(...b);
        aboveTris.push(...a);
      }
      const capN = axis==='x'?[1,0,0]:axis==='y'?[0,1,0]:[0,0,1];
      parts.push([...belowTris]);
      remaining = [...aboveTris];

    } else {
      // Standard straight cut
      const range = axis==='x'?[bbox.minX,bbox.maxX]:axis==='y'?[bbox.minY,bbox.maxY]:[bbox.minZ,bbox.maxZ];
      const cutVal = range[0] + (range[1]-range[0]) * pos;

      const belowTris=[], aboveTris=[], belowEdges=[], aboveEdges=[];
      for (const tri of remaining) {
        const b = clipTri(tri, axis, cutVal, true);
        const a = clipTri(tri, axis, cutVal, false);
        belowTris.push(...b.tris); belowEdges.push(...b.edges);
        aboveTris.push(...a.tris); aboveEdges.push(...a.edges);
      }
      const capN = axis==='x'?[1,0,0]:axis==='y'?[0,1,0]:[0,0,1];
      const capNeg = capN.map(n=>-n);
      const belowCaps = generateCap(belowEdges, capN);
      const aboveCaps = generateCap(aboveEdges, capNeg);
      parts.push([...belowTris, ...belowCaps]);
      remaining = [...aboveTris, ...aboveCaps];
    }
  }

  parts.push(remaining);
  return parts.filter(p => p.length > 0);
}

function trianglesToBuffer(triangles, name) {
  const buf = Buffer.alloc(80 + 4 + triangles.length * 50);
  buf.write((name||"Part").substring(0,80).padEnd(80,' '), 0, 'ascii');
  buf.writeUInt32LE(triangles.length, 80);
  let offset = 84;
  for (const t of triangles) {
    buf.writeFloatLE(t.normal[0],offset); buf.writeFloatLE(t.normal[1],offset+4); buf.writeFloatLE(t.normal[2],offset+8);
    buf.writeFloatLE(t.v1[0],offset+12); buf.writeFloatLE(t.v1[1],offset+16); buf.writeFloatLE(t.v1[2],offset+20);
    buf.writeFloatLE(t.v2[0],offset+24); buf.writeFloatLE(t.v2[1],offset+28); buf.writeFloatLE(t.v2[2],offset+32);
    buf.writeFloatLE(t.v3[0],offset+36); buf.writeFloatLE(t.v3[1],offset+40); buf.writeFloatLE(t.v3[2],offset+44);
    buf.writeUInt16LE(0,offset+48);
    offset += 50;
  }
  return buf;
}

// ── POST /slice-stl ──
app.post("/slice-stl", async (req, res) => {
  try {
    const { stlUrl, cutPlanes, partNames } = req.body;
    if (!stlUrl) return res.status(400).json({ error: "stlUrl is required" });
    if (!cutPlanes || cutPlanes.length === 0) return res.status(400).json({ error: "cutPlanes required" });

    console.log("Downloading STL...", stlUrl.substring(0,60));
    const stlRes = await fetch(stlUrl);
    if (!stlRes.ok) throw new Error(`Failed to download STL: ${stlRes.status}`);
    const stlBuffer = await stlRes.buffer();

    const triangles = parseBinarySTL(stlBuffer);
    console.log(`Parsed ${triangles.length} triangles, running ${cutPlanes.length} cuts`);

    const parts = sliceMesh(triangles, cutPlanes);
    console.log("Parts:", parts.map(p=>p.length));

    const results = parts.map((tris, i) => ({
      partName: partNames?.[i] || `Part ${i+1}`,
      triangleCount: tris.length,
      stlBase64: trianglesToBuffer(tris, partNames?.[i] || `Part_${i+1}`).toString('base64'),
    })).filter(p => p.triangleCount > 10);

    res.json({ success: true, parts: results });
  } catch (err) {
    console.error("/slice-stl error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`CAD Copilot Backend v6 running on port ${PORT}`));
