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
  res.json({ status: "CAD Copilot Backend running", version: "8.0.0" });
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

// ── STL Parser ──
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

function getBBox(tris) {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (const t of tris) for (const v of [t.v1,t.v2,t.v3]) {
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

// ── Clip single triangle against one plane ──
// Returns { below: [triangles], above: [triangles] }
function clipTriangle(tri, axis, cutVal) {
  const ai = axisIdx(axis);
  const vs = [tri.v1, tri.v2, tri.v3];
  const cs = vs.map(v => v[ai]);

  const belowMask = cs.map(c => c <= cutVal);
  const belowCount = belowMask.filter(Boolean).length;

  if (belowCount === 3) return { below: [tri], above: [] };
  if (belowCount === 0) return { below: [], above: [tri] };

  // Find intersection points
  const intersections = [];
  for (let i = 0; i < 3; i++) {
    const j = (i+1)%3;
    if (belowMask[i] !== belowMask[j]) {
      const t = (cutVal - cs[i]) / (cs[j] - cs[i]);
      intersections.push({ point: lerp(vs[i], vs[j], t), fromIdx: i, toIdx: j });
    }
  }

  if (intersections.length < 2) {
    return belowCount > 0 ? { below: [tri], above: [] } : { below: [], above: [tri] };
  }

  const p1 = intersections[0].point;
  const p2 = intersections[1].point;
  const capNormal = axis==='x'?[1,0,0]:axis==='y'?[0,1,0]:[0,0,1];

  if (belowCount === 1) {
    const i0 = belowMask.indexOf(true);
    return {
      below: [{ normal: tri.normal, v1: vs[i0], v2: p1, v3: p2 }],
      above: [
        { normal: tri.normal, v1: vs[(i0+1)%3], v2: vs[(i0+2)%3], v3: p1 },
        { normal: tri.normal, v1: vs[(i0+2)%3], v2: p2, v3: p1 },
        // Cap face for below
        { normal: capNormal, v1: vs[i0], v2: p2, v3: p1 },
        // Cap face for above
        { normal: capNormal.map(n=>-n), v1: p1, v2: p2, v3: vs[(i0+1)%3] },
      ].filter((_,i)=>i<2),
    };
  } else {
    // belowCount === 2
    const i0 = belowMask.indexOf(false);
    const i1 = (i0+1)%3;
    const i2 = (i0+2)%3;
    return {
      below: [
        { normal: tri.normal, v1: vs[i1], v2: vs[i2], v3: p1 },
        { normal: tri.normal, v1: vs[i2], v2: p2, v3: p1 },
      ],
      above: [{ normal: tri.normal, v1: vs[i0], v2: p2, v3: p1 }],
    };
  }
}

// ── Apply one plane cut to a set of triangles ──
function applyPlaneCut(triangles, axis, cutVal) {
  const below = [];
  const above = [];
  for (const tri of triangles) {
    const result = clipTriangle(tri, axis, cutVal);
    below.push(...result.below);
    above.push(...result.above);
  }
  return { below, above };
}

// ── Main slicer: sequential cuts, each on remaining geometry ──
// Produces clean cuts by properly clipping triangles at boundaries
function sliceMesh(triangles, cutPlanes, bbox) {
  // Convert to world coords and group by axis
  const getWorld = (axis, pos) => {
    const mn = axis==='x'?bbox.minX:axis==='y'?bbox.minY:bbox.minZ;
    const mx = axis==='x'?bbox.maxX:axis==='y'?bbox.maxY:bbox.maxZ;
    return mn + (mx-mn)*pos;
  };

  // Sort cuts: do Y cuts first, then X, then Z for aircraft
  const sorted = [...cutPlanes].sort((a,b) => {
    const axOrder = {y:0, x:1, z:2};
    if (axOrder[a.axis||'y'] !== axOrder[b.axis||'y']) return axOrder[a.axis||'y'] - axOrder[b.axis||'y'];
    return (a.position||0.5) - (b.position||0.5);
  });

  // Apply cuts sequentially — each cut splits the REMAINING geometry cleanly
  const parts = [];
  let remaining = [...triangles];

  for (const cp of sorted) {
    const axis = cp.axis || 'y';
    const cutVal = getWorld(axis, cp.position || 0.5);
    const { below, above } = applyPlaneCut(remaining, axis, cutVal);
    if (below.length > 10) parts.push(below);
    remaining = above;
  }

  if (remaining.length > 10) parts.push(remaining);
  return parts;
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

    console.log(`Downloading STL... (${cutPlanes.length} cuts)`);
    const stlRes = await fetch(stlUrl);
    if (!stlRes.ok) throw new Error(`Failed to download STL: ${stlRes.status}`);
    const stlBuffer = await stlRes.buffer();

    const triangles = parseBinarySTL(stlBuffer);
    console.log(`Parsed ${triangles.length} triangles`);

    const bbox = getBBox(triangles);
    const parts = sliceMesh(triangles, cutPlanes, bbox);
    console.log(`Parts:`, parts.map(p => p.length));

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

app.listen(PORT, () => console.log(`CAD Copilot Backend v8 running on port ${PORT}`));
