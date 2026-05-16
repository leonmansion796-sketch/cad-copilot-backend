const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3001;
const MESHY_API_KEY = process.env.MESHY_API_KEY;

// ── CORS ──
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

app.use(express.json({ limit: "50mb" }));

// ── Health check ──
app.get("/", (req, res) => {
  res.json({ status: "CAD Copilot Backend running", version: "4.0.0" });
});

// ── Helper: poll Meshy task ──
async function pollMeshyTask(taskId, endpoint, maxWait = 300000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await fetch(`https://api.meshy.ai/openapi/v1/${endpoint}/${taskId}`, {
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}` },
    });
    const data = await res.json();
    if (data.status === "SUCCEEDED") return data;
    if (data.status === "FAILED" || data.status === "EXPIRED") throw new Error(data.task_error?.message || "Task failed");
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error("Task timed out");
}

// ── POST /generate-3d ── (Image to 3D)
app.post("/generate-3d", async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });

    const dataURI = `data:${mediaType || "image/png"};base64,${imageBase64}`;
    const meshyRes = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: dataURI,
        ai_model: "meshy-6",
        should_remesh: true,
        should_texture: true,
        enable_pbr: true,
        target_formats: ["glb", "obj", "stl"],
      }),
    });
    const data = await meshyRes.json();
    if (!meshyRes.ok) return res.status(meshyRes.status).json({ error: data?.message || "Meshy error" });
    res.json({ taskId: data.result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /task-status/:taskId ── (Image to 3D polling)
app.get("/task-status/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });
    const meshyRes = await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`, {
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}` },
    });
    const data = await meshyRes.json();
    if (!meshyRes.ok) return res.status(meshyRes.status).json({ error: data?.message || "Poll error" });
    res.json({
      status: data.status,
      progress: data.progress || 0,
      modelUrls: data.model_urls || null,
      error: data.task_error?.message || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate-3d-text ── (Text to 3D preview)
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /refine-3d-text ── (Text to 3D refine)
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /text-task-status/:taskId ── (Text to 3D polling)
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /proxy-model ── (proxy GLB files to avoid CORS)
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /slice-stl ── (Download STL from Meshy and slice into parts)
app.post("/slice-stl", async (req, res) => {
  try {
    const { stlUrl, cutPlanes, partNames } = req.body;
    if (!stlUrl) return res.status(400).json({ error: "stlUrl is required" });
    if (!cutPlanes || cutPlanes.length === 0) return res.status(400).json({ error: "cutPlanes is required" });

    console.log("Downloading STL from:", stlUrl);

    // Download the STL file
    const stlRes = await fetch(stlUrl);
    if (!stlRes.ok) throw new Error(`Failed to download STL: ${stlRes.status}`);
    const stlBuffer = await stlRes.buffer();

    console.log("STL downloaded, size:", stlBuffer.length, "bytes");

    // Parse binary STL
    const triangles = parseBinarySTL(stlBuffer);
    console.log("Triangles parsed:", triangles.length);

    // Slice the mesh at each cut plane
    const parts = sliceMesh(triangles, cutPlanes, partNames);
    console.log("Parts created:", parts.length);

    // Convert each part to base64 STL
    const results = parts.map((part, i) => ({
      partName: partNames?.[i] || `Part ${i + 1}`,
      triangleCount: part.length,
      stlBase64: trianglesToSTLBase64(part, partNames?.[i] || `Part_${i + 1}`),
    }));

    res.json({ success: true, parts: results });

  } catch (err) {
    console.error("/slice-stl error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── STL Parser ──
function parseBinarySTL(buffer) {
  const triangles = [];
  // Skip 80 byte header
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

// ── Mesh Slicer ──
function sliceMesh(triangles, cutPlanes, partNames) {
  // cutPlanes is array of { axis: 'y', position: 0.3 } where position is 0-1 normalized
  // First find bounding box
  let minY = Infinity, maxY = -Infinity;
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const tri of triangles) {
    for (const v of [tri.v1, tri.v2, tri.v3]) {
      minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
      minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]);
      minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
    }
  }

  const ranges = { x: [minX, maxX], y: [minY, maxY], z: [minZ, maxZ] };

  // Sort cut planes by position
  const sorted = [...cutPlanes].sort((a, b) => a.position - b.position);

  // Create boundaries
  const boundaries = [];
  boundaries.push({ axis: sorted[0].axis, min: -Infinity, max: ranges[sorted[0].axis][0] + (ranges[sorted[0].axis][1] - ranges[sorted[0].axis][0]) * sorted[0].position });
  for (let i = 0; i < sorted.length - 1; i++) {
    boundaries.push({
      axis: sorted[i].axis,
      min: ranges[sorted[i].axis][0] + (ranges[sorted[i].axis][1] - ranges[sorted[i].axis][0]) * sorted[i].position,
      max: ranges[sorted[i + 1].axis][0] + (ranges[sorted[i + 1].axis][1] - ranges[sorted[i + 1].axis][0]) * sorted[i + 1].position,
    });
  }
  boundaries.push({ axis: sorted[sorted.length - 1].axis, min: ranges[sorted[sorted.length - 1].axis][0] + (ranges[sorted[sorted.length - 1].axis][1] - ranges[sorted[sorted.length - 1].axis][0]) * sorted[sorted.length - 1].position, max: Infinity });

  // Assign triangles to parts
  return boundaries.map(boundary => {
    return triangles.filter(tri => {
      const centroid = [
        (tri.v1[0] + tri.v2[0] + tri.v3[0]) / 3,
        (tri.v1[1] + tri.v2[1] + tri.v3[1]) / 3,
        (tri.v1[2] + tri.v2[2] + tri.v3[2]) / 3,
      ];
      const axisIndex = boundary.axis === 'x' ? 0 : boundary.axis === 'y' ? 1 : 2;
      return centroid[axisIndex] >= boundary.min && centroid[axisIndex] < boundary.max;
    });
  });
}

// ── Convert triangles to binary STL base64 ──
function trianglesToSTLBase64(triangles, name) {
  const buffer = Buffer.alloc(80 + 4 + triangles.length * 50);

  // Header
  buffer.write(name.substring(0, 80).padEnd(80, ' '), 0, 'ascii');
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

  return buffer.toString('base64');
}

app.listen(PORT, () => {
  console.log(`CAD Copilot Backend v4 running on port ${PORT}`);
});
