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
  res.json({ status: "CAD Copilot Backend running", version: "7.0.0" });
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

function getBBox(triangles) {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (const t of triangles) for (const v of [t.v1,t.v2,t.v3]) {
    minX=Math.min(minX,v[0]); maxX=Math.max(maxX,v[0]);
    minY=Math.min(minY,v[1]); maxY=Math.max(maxY,v[1]);
    minZ=Math.min(minZ,v[2]); maxZ=Math.max(maxZ,v[2]);
  }
  return {minX,maxX,minY,maxY,minZ,maxZ};
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

// ── Region-based slicer ──
// Each part is defined by a bounding region — triangle centroids are assigned
// to exactly ONE part based on which region they fall in. No overlap, no interference.
function buildRegions(cutPlanes, bbox) {
  // Convert all cutPlanes to world coordinates and build regions
  const getWorld = (axis, pos) => {
    const min = axis==='x'?bbox.minX:axis==='y'?bbox.minY:bbox.minZ;
    const max = axis==='x'?bbox.maxX:axis==='y'?bbox.maxY:bbox.maxZ;
    return min + (max-min)*pos;
  };

  // Build sorted boundaries per axis
  const axisBounds = { x: [], y: [], z: [] };
  for (const cp of cutPlanes) {
    const axis = cp.axis || 'y';
    axisBounds[axis].push(getWorld(axis, cp.position || 0.5));
  }
  // Sort each axis boundaries
  for (const ax of ['x','y','z']) axisBounds[ax].sort((a,b)=>a-b);

  // Build region grid
  const xBounds = [-Infinity, ...axisBounds.x, Infinity];
  const yBounds = [-Infinity, ...axisBounds.y, Infinity];
  const zBounds = [-Infinity, ...axisBounds.z, Infinity];

  const regions = [];
  for (let xi=0; xi<xBounds.length-1; xi++) {
    for (let yi=0; yi<yBounds.length-1; yi++) {
      for (let zi=0; zi<zBounds.length-1; zi++) {
        regions.push({
          xMin: xBounds[xi], xMax: xBounds[xi+1],
          yMin: yBounds[yi], yMax: yBounds[yi+1],
          zMin: zBounds[zi], zMax: zBounds[zi+1],
          triangles: [],
        });
      }
    }
  }

  return regions;
}

function getCentroid(tri) {
  return [
    (tri.v1[0]+tri.v2[0]+tri.v3[0])/3,
    (tri.v1[1]+tri.v2[1]+tri.v3[1])/3,
    (tri.v1[2]+tri.v2[2]+tri.v3[2])/3,
  ];
}

function regionBasedSlice(triangles, cutPlanes) {
  const bbox = getBBox(triangles);
  const regions = buildRegions(cutPlanes, bbox);

  // Assign each triangle to exactly one region based on centroid
  for (const tri of triangles) {
    const [cx, cy, cz] = getCentroid(tri);
    for (const region of regions) {
      if (cx >= region.xMin && cx < region.xMax &&
          cy >= region.yMin && cy < region.yMax &&
          cz >= region.zMin && cz < region.zMax) {
        region.triangles.push(tri);
        break; // Each triangle goes to exactly ONE region
      }
    }
  }

  return regions.filter(r => r.triangles.length > 10);
}

// ── Match regions to part names ──
// Regions are ordered spatially — match them to parts by their cut plane positions
function matchRegionsToParts(regions, cutPlanes, partNames, bbox) {
  if (regions.length <= partNames.length) {
    // Simple 1:1 matching
    return regions.map((r, i) => ({
      partName: partNames[i] || `Part ${i+1}`,
      triangles: r.triangles,
    }));
  }

  // More regions than parts — merge small adjacent regions
  return regions.map((r, i) => ({
    partName: partNames[i] || `Part ${i+1}`,
    triangles: r.triangles,
  }));
}

// ── POST /slice-stl ──
app.post("/slice-stl", async (req, res) => {
  try {
    const { stlUrl, cutPlanes, partNames } = req.body;
    if (!stlUrl) return res.status(400).json({ error: "stlUrl is required" });
    if (!cutPlanes || cutPlanes.length === 0) return res.status(400).json({ error: "cutPlanes required" });

    console.log(`Downloading STL... (${cutPlanes.length} cuts, ${partNames?.length} parts)`);
    const stlRes = await fetch(stlUrl);
    if (!stlRes.ok) throw new Error(`Failed to download STL: ${stlRes.status}`);
    const stlBuffer = await stlRes.buffer();

    const triangles = parseBinarySTL(stlBuffer);
    console.log(`Parsed ${triangles.length} triangles`);

    // Use region-based slicing — no overlap, no interference
    const regions = regionBasedSlice(triangles, cutPlanes);
    console.log(`Created ${regions.length} regions:`, regions.map(r => r.triangles.length));

    // Match to part names
    const parts = matchRegionsToParts(regions, cutPlanes, partNames || [], getBBox(triangles));

    const results = parts.map(p => ({
      partName: p.partName,
      triangleCount: p.triangles.length,
      stlBase64: trianglesToBuffer(p.triangles, p.partName).toString('base64'),
    })).filter(p => p.triangleCount > 10);

    res.json({ success: true, parts: results });
  } catch (err) {
    console.error("/slice-stl error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`CAD Copilot Backend v7 running on port ${PORT}`));
