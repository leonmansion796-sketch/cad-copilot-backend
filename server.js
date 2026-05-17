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
  res.json({ status: "CAD Copilot Backend running", version: "5.0.0" });
});

// ── POST /generate-3d ──
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

// ── GET /task-status/:taskId ──
app.get("/task-status/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });
    const meshyRes = await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`, {
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}` },
    });
    const data = await meshyRes.json();
    if (!meshyRes.ok) return res.status(meshyRes.status).json({ error: data?.message || "Poll error" });
    res.json({ status: data.status, progress: data.progress || 0, modelUrls: data.model_urls || null, error: data.task_error?.message || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /generate-3d-text ──
app.post("/generate-3d-text", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });
    const previewRes = await fetch("https://api.meshy.ai/openapi/v2/text-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "preview", prompt: prompt.substring(0, 600), should_remesh: true, target_formats: ["glb", "obj", "stl"] }),
    });
    const data = await previewRes.json();
    if (!previewRes.ok) return res.status(previewRes.status).json({ error: data?.message || "Meshy error" });
    res.json({ taskId: data.result, type: "text-to-3d" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /refine-3d-text ──
app.post("/refine-3d-text", async (req, res) => {
  try {
    const { previewTaskId, prompt } = req.body;
    if (!previewTaskId) return res.status(400).json({ error: "previewTaskId is required" });
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });
    const refineRes = await fetch("https://api.meshy.ai/openapi/v2/text-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "refine", preview_task_id: previewTaskId, target_formats: ["glb", "obj", "stl"] }),
    });
    const data = await refineRes.json();
    if (!refineRes.ok) return res.status(refineRes.status).json({ error: data?.message || "Meshy error" });
    res.json({ taskId: data.result, type: "refine" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /text-task-status/:taskId ──
app.get("/text-task-status/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });
    const meshyRes = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${taskId}`, {
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}` },
    });
    const data = await meshyRes.json();
    if (!meshyRes.ok) return res.status(meshyRes.status).json({ error: data?.message || "Poll error" });
    res.json({ status: data.status, progress: data.progress || 0, modelUrls: data.model_urls || null, error: data.task_error?.message || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /proxy-model ──
app.get("/proxy-model", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "url is required" });
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).json({ error: "Failed to fetch model" });
    const buffer = await response.buffer();
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", contentType);
    res.send(buffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STL Parser ──
function parseBinarySTL(buffer) {
  const triangles = [];
  if (buffer.length < 84) return triangles;
  const numTriangles = buffer.readUInt32LE(80);
  let offset = 84;
  for (let i = 0; i < numTriangles; i++) {
    if (offset + 50 > buffer.length) break;
    const nx = buffer.readFloatLE(offset);
    const ny = buffer.readFloatLE(offset + 4);
    const nz = buffer.readFloatLE(offset + 8);
    const v1 = [buffer.readFloatLE(offset + 12), buffer.readFloatLE(offset + 16), buffer.readFloatLE(offset + 20)];
    const v2 = [buffer.readFloatLE(offset + 24), buffer.readFloatLE(offset + 28), buffer.readFloatLE(offset + 32)];
    const v3 = [buffer.readFloatLE(offset + 36), buffer.readFloatLE(offset + 40), buffer.readFloatLE(offset + 44)];
    triangles.push({ normal: [nx, ny, nz], v1, v2, v3 });
    offset += 50;
  }
  return triangles;
}

// ── Compute bounding box ──
function getBoundingBox(triangles) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const tri of triangles) {
    for (const v of [tri.v1, tri.v2, tri.v3]) {
      minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
      minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]);
      minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

// ── Get vertex coordinate on axis ──
function getCoord(v, axis) {
  return axis === 'x' ? v[0] : axis === 'y' ? v[1] : v[2];
}

// ── Interpolate vertex along edge ──
function interpolate(v1, v2, t) {
  return [
    v1[0] + (v2[0] - v1[0]) * t,
    v1[1] + (v2[1] - v1[1]) * t,
    v1[2] + (v2[2] - v1[2]) * t,
  ];
}

// ── Clip triangle against a plane ──
// Returns triangles that are on the "below" side (coord < cutValue)
// and intersection edges for cap generation
function clipTriangle(tri, axis, cutValue, below) {
  const verts = [tri.v1, tri.v2, tri.v3];
  const coords = verts.map(v => getCoord(v, axis));
  
  // Classify vertices
  const inside = coords.map(c => below ? c <= cutValue : c >= cutValue);
  const insideCount = inside.filter(Boolean).length;
  
  if (insideCount === 3) return { tris: [tri], edges: [] };
  if (insideCount === 0) return { tris: [], edges: [] };
  
  const result = { tris: [], edges: [] };
  
  if (insideCount === 1) {
    // One vertex inside — creates one smaller triangle
    const i0 = inside.indexOf(true);
    const i1 = (i0 + 1) % 3;
    const i2 = (i0 + 2) % 3;
    const t1 = (cutValue - coords[i0]) / (coords[i1] - coords[i0]);
    const t2 = (cutValue - coords[i0]) / (coords[i2] - coords[i0]);
    const p1 = interpolate(verts[i0], verts[i1], t1);
    const p2 = interpolate(verts[i0], verts[i2], t2);
    result.tris.push({ normal: tri.normal, v1: verts[i0], v2: p1, v3: p2 });
    result.edges.push([p1, p2]);
  } else {
    // Two vertices inside — creates a quad (two triangles)
    const i0 = inside.indexOf(false);
    const i1 = (i0 + 1) % 3;
    const i2 = (i0 + 2) % 3;
    const t1 = (cutValue - coords[i1]) / (coords[i0] - coords[i1]);
    const t2 = (cutValue - coords[i2]) / (coords[i0] - coords[i2]);
    const p1 = interpolate(verts[i1], verts[i0], t1);
    const p2 = interpolate(verts[i2], verts[i0], t2);
    result.tris.push({ normal: tri.normal, v1: verts[i1], v2: verts[i2], v3: p1 });
    result.tris.push({ normal: tri.normal, v1: verts[i2], v2: p2, v3: p1 });
    result.edges.push([p1, p2]);
  }
  
  return result;
}

// ── Generate cap triangles to close cut faces ──
function generateCap(edges, axis, cutValue, normal) {
  if (edges.length === 0) return [];
  
  // Find centroid of all edge midpoints
  let cx = 0, cy = 0, cz = 0;
  for (const [p1, p2] of edges) {
    cx += (p1[0] + p2[0]) / 2;
    cy += (p1[1] + p2[1]) / 2;
    cz += (p1[2] + p2[2]) / 2;
  }
  cx /= edges.length; cy /= edges.length; cz /= edges.length;
  
  const centroid = [cx, cy, cz];
  const capTris = [];
  
  for (const [p1, p2] of edges) {
    capTris.push({ normal, v1: centroid, v2: p1, v3: p2 });
  }
  
  return capTris;
}

// ── Slice mesh with proper clipping ──
function sliceMeshProperly(triangles, cutPlanes) {
  const bbox = getBoundingBox(triangles);
  
  // Convert normalized positions to world coordinates
  const planes = cutPlanes.map(cp => {
    const range = cp.axis === 'x' ? [bbox.minX, bbox.maxX] :
                  cp.axis === 'y' ? [bbox.minY, bbox.maxY] :
                                    [bbox.minZ, bbox.maxZ];
    return {
      axis: cp.axis,
      value: range[0] + (range[1] - range[0]) * cp.position,
    };
  }).sort((a, b) => a.value - b.value);

  // Start with all triangles
  let currentTris = [...triangles];
  const parts = [];
  
  for (let i = 0; i < planes.length; i++) {
    const plane = planes[i];
    const belowTris = [];
    const aboveTris = [];
    const belowEdges = [];
    const aboveEdges = [];
    
    for (const tri of currentTris) {
      const belowResult = clipTriangle(tri, plane.axis, plane.value, true);
      const aboveResult = clipTriangle(tri, plane.axis, plane.value, false);
      belowTris.push(...belowResult.tris);
      aboveTris.push(...aboveResult.tris);
      belowEdges.push(...belowResult.edges);
      aboveEdges.push(...aboveResult.edges);
    }
    
    // Generate cap faces to close the cut
    const capNormalBelow = plane.axis === 'x' ? [1,0,0] : plane.axis === 'y' ? [0,1,0] : [0,0,1];
    const capNormalAbove = capNormalBelow.map(n => -n);
    
    const belowCaps = generateCap(belowEdges, plane.axis, plane.value, capNormalBelow);
    const aboveCaps = generateCap(aboveEdges, plane.axis, plane.value, capNormalAbove);
    
    parts.push([...belowTris, ...belowCaps]);
    currentTris = [...aboveTris, ...aboveCaps];
  }
  
  // Last part is what remains above all cut planes
  parts.push(currentTris);
  
  return parts;
}

// ── Convert triangles to binary STL Buffer ──
function trianglesToSTLBuffer(triangles, name) {
  const buffer = Buffer.alloc(80 + 4 + triangles.length * 50);
  buffer.write((name || "Part").substring(0, 80).padEnd(80, ' '), 0, 'ascii');
  buffer.writeUInt32LE(triangles.length, 80);
  let offset = 84;
  for (const tri of triangles) {
    buffer.writeFloatLE(tri.normal[0], offset);
    buffer.writeFloatLE(tri.normal[1], offset + 4);
    buffer.writeFloatLE(tri.normal[2], offset + 8);
    buffer.writeFloatLE(tri.v1[0], offset + 12);
    buffer.writeFloatLE(tri.v1[1], offset + 16);
    buffer.writeFloatLE(tri.v1[2], offset + 20);
    buffer.writeFloatLE(tri.v2[0], offset + 24);
    buffer.writeFloatLE(tri.v2[1], offset + 28);
    buffer.writeFloatLE(tri.v2[2], offset + 32);
    buffer.writeFloatLE(tri.v3[0], offset + 36);
    buffer.writeFloatLE(tri.v3[1], offset + 40);
    buffer.writeFloatLE(tri.v3[2], offset + 44);
    buffer.writeUInt16LE(0, offset + 48);
    offset += 50;
  }
  return buffer;
}

// ── POST /slice-stl ──
app.post("/slice-stl", async (req, res) => {
  try {
    const { stlUrl, cutPlanes, partNames } = req.body;
    if (!stlUrl) return res.status(400).json({ error: "stlUrl is required" });
    if (!cutPlanes || cutPlanes.length === 0) return res.status(400).json({ error: "cutPlanes is required" });

    console.log("Downloading STL from:", stlUrl);
    const stlRes = await fetch(stlUrl);
    if (!stlRes.ok) throw new Error(`Failed to download STL: ${stlRes.status}`);
    const stlBuffer = await stlRes.buffer();
    console.log("STL downloaded, size:", stlBuffer.length, "bytes");

    const triangles = parseBinarySTL(stlBuffer);
    console.log("Triangles parsed:", triangles.length);

    // Use proper clipping slicer
    const parts = sliceMeshProperly(triangles, cutPlanes);
    console.log("Parts created:", parts.length, "with sizes:", parts.map(p => p.length));

    const results = parts.map((partTris, i) => {
      const name = partNames?.[i] || `Part_${i + 1}`;
      const stlBuffer = trianglesToSTLBuffer(partTris, name);
      return {
        partName: partNames?.[i] || `Part ${i + 1}`,
        triangleCount: partTris.length,
        stlBase64: stlBuffer.toString('base64'),
      };
    }).filter(p => p.triangleCount > 0);

    res.json({ success: true, parts: results });

  } catch (err) {
    console.error("/slice-stl error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CAD Copilot Backend v5 running on port ${PORT}`);
});
