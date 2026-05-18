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
  res.json({ status: "CAD Copilot Backend running", version: "9.0.0" });
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

// ── STL utilities ──
function parseBinarySTL(buffer) {
  const tris = [];
  if (buffer.length < 84) return tris;
  const n = buffer.readUInt32LE(80);
  let o = 84;
  for (let i = 0; i < n; i++) {
    if (o + 50 > buffer.length) break;
    tris.push({
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

function lerp(v1, v2, t) {
  return [
    v1[0] + (v2[0]-v1[0])*t,
    v1[1] + (v2[1]-v1[1])*t,
    v1[2] + (v2[2]-v1[2])*t,
  ];
}

function axisIdx(axis) { return axis==='x'?0:axis==='y'?1:2; }

// ── Snap a vertex to the cut plane to avoid slivers ──
function snapToPlane(v, axis, cutVal, tolerance=0.001) {
  const ai = axisIdx(axis);
  if (Math.abs(v[ai] - cutVal) < tolerance) {
    const snapped = [...v];
    snapped[ai] = cutVal;
    return snapped;
  }
  return v;
}

// ── Compute triangle area ──
function triArea(v1, v2, v3) {
  const ax = v2[0]-v1[0], ay = v2[1]-v1[1], az = v2[2]-v1[2];
  const bx = v3[0]-v1[0], by = v3[1]-v1[1], bz = v3[2]-v1[2];
  return 0.5 * Math.sqrt(
    (ay*bz-az*by)**2 + (az*bx-ax*bz)**2 + (ax*by-ay*bx)**2
  );
}

// ── Clip single triangle against a plane, with snapping to avoid teeth ──
function clipTriangle(tri, axis, cutVal) {
  const ai = axisIdx(axis);
  const vs = [tri.v1, tri.v2, tri.v3];
  const cs = vs.map(v => v[ai]);
  const SNAP = 0.0001;

  // Snap vertices very close to cut plane
  const snappedVs = vs.map((v, i) => {
    if (Math.abs(cs[i] - cutVal) < SNAP) {
      const s = [...v]; s[ai] = cutVal; return s;
    }
    return v;
  });
  const snappedCs = snappedVs.map(v => v[ai]);

  const belowMask = snappedCs.map(c => c <= cutVal);
  const belowCount = belowMask.filter(Boolean).length;

  if (belowCount === 3) return { below: [{ ...tri, v1: snappedVs[0], v2: snappedVs[1], v3: snappedVs[2] }], above: [] };
  if (belowCount === 0) return { below: [], above: [{ ...tri, v1: snappedVs[0], v2: snappedVs[1], v3: snappedVs[2] }] };

  // Find the two intersection points
  const pairs = [[0,1],[1,2],[2,0]];
  const intersections = [];
  for (const [i,j] of pairs) {
    if (belowMask[i] !== belowMask[j]) {
      const denom = snappedCs[j] - snappedCs[i];
      if (Math.abs(denom) < 1e-10) continue;
      const t = (cutVal - snappedCs[i]) / denom;
      const pt = lerp(snappedVs[i], snappedVs[j], t);
      pt[ai] = cutVal; // Force exactly on plane
      intersections.push({ pt, i, j });
    }
  }

  if (intersections.length < 2) {
    return belowCount > 0
      ? { below: [tri], above: [] }
      : { below: [], above: [tri] };
  }

  const p1 = intersections[0].pt;
  const p2 = intersections[1].pt;

  // Skip degenerate (zero area) triangles
  const minArea = 1e-10;

  const makeBelow = () => {
    if (belowCount === 1) {
      const i0 = belowMask.indexOf(true);
      const t = { normal: tri.normal, v1: snappedVs[i0], v2: p1, v3: p2 };
      return triArea(t.v1, t.v2, t.v3) > minArea ? [t] : [];
    } else {
      const i0 = belowMask.indexOf(false);
      const i1 = (i0+1)%3, i2 = (i0+2)%3;
      const t1 = { normal: tri.normal, v1: snappedVs[i1], v2: snappedVs[i2], v3: p1 };
      const t2 = { normal: tri.normal, v1: snappedVs[i2], v2: p2, v3: p1 };
      return [t1,t2].filter(t => triArea(t.v1,t.v2,t.v3) > minArea);
    }
  };

  const makeAbove = () => {
    if (belowCount === 1) {
      const i0 = belowMask.indexOf(true);
      const i1 = (i0+1)%3, i2 = (i0+2)%3;
      const t1 = { normal: tri.normal, v1: snappedVs[i1], v2: snappedVs[i2], v3: p2 };
      const t2 = { normal: tri.normal, v1: snappedVs[i1], v2: p2, v3: p1 };
      return [t1,t2].filter(t => triArea(t.v1,t.v2,t.v3) > minArea);
    } else {
      const i0 = belowMask.indexOf(false);
      const t = { normal: tri.normal, v1: snappedVs[i0], v2: p2, v3: p1 };
      return triArea(t.v1, t.v2, t.v3) > minArea ? [t] : [];
    }
  };

  return { below: makeBelow(), above: makeAbove() };
}

// ── Apply one plane cut ──
function applyPlaneCut(triangles, axis, cutVal) {
  const below = [], above = [];
  for (const tri of triangles) {
    const r = clipTriangle(tri, axis, cutVal);
    below.push(...r.below);
    above.push(...r.above);
  }
  return { below, above };
}

// ── Main slicer ──
function sliceMesh(triangles, cutPlanes, bbox) {
  const getWorld = (axis, pos) => {
    const mn = axis==='x'?bbox.minX:axis==='y'?bbox.minY:bbox.minZ;
    const mx = axis==='x'?bbox.maxX:axis==='y'?bbox.maxY:bbox.maxZ;
    return mn + (mx-mn) * Math.max(0.05, Math.min(0.95, pos));
  };

  // Sort: Z first (front/back), then Y (top/bottom), then X (left/right)
  // This gives cleanest results for aircraft and furniture
  const axOrder = { z:0, y:1, x:2 };
  const sorted = [...cutPlanes].sort((a,b) => {
    const ao = axOrder[a.axis||'y'] ?? 1;
    const bo = axOrder[b.axis||'y'] ?? 1;
    if (ao !== bo) return ao - bo;
    return (a.position||0.5) - (b.position||0.5);
  });

  const parts = [];
  let remaining = [...triangles];

  for (const cp of sorted) {
    const axis = cp.axis || 'y';
    const cutVal = getWorld(axis, cp.position || 0.5);
    const { below, above } = applyPlaneCut(remaining, axis, cutVal);
    if (below.length > 5) parts.push(below);
    remaining = above;
  }

  if (remaining.length > 5) parts.push(remaining);
  return parts;
}

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

// ── POST /slice-stl ──
app.post("/slice-stl", async (req, res) => {
  try {
    const { stlUrl, cutPlanes, partNames } = req.body;
    if (!stlUrl) return res.status(400).json({ error: "stlUrl is required" });
    if (!cutPlanes || cutPlanes.length === 0) return res.status(400).json({ error: "cutPlanes required" });

    console.log(`v9: Downloading STL (${cutPlanes.length} cuts)...`);
    const stlRes = await fetch(stlUrl);
    if (!stlRes.ok) throw new Error(`Failed to download STL: ${stlRes.status}`);
    const stlBuf = await stlRes.buffer();

    const triangles = parseBinarySTL(stlBuf);
    console.log(`Parsed ${triangles.length} triangles`);

    const bbox = getBBox(triangles);
    const parts = sliceMesh(triangles, cutPlanes, bbox);
    console.log(`Parts:`, parts.map(p => p.length));

    const results = parts.map((tris, i) => ({
      partName: partNames?.[i] || `Part ${i+1}`,
      triangleCount: tris.length,
      stlBase64: trianglesToBuffer(tris, partNames?.[i] || `Part_${i+1}`).toString('base64'),
    })).filter(p => p.triangleCount > 5);

    res.json({ success: true, parts: results });
  } catch (err) {
    console.error("/slice-stl error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`CAD Copilot Backend v9 running on port ${PORT}`));
