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

app.use(express.json({ limit: "25mb" }));

// ── Health check ──
app.get("/", (req, res) => {
  res.json({ status: "CAD Copilot Backend is running", version: "2.0.0" });
});

// ── Helper: create Meshy task ──
async function createMeshyTask(imageBase64, mediaType, partDescription) {
  const dataURI = `data:${mediaType || "image/png"};base64,${imageBase64}`;

  const body = {
    image_url: dataURI,
    ai_model: "meshy-6",
    should_remesh: true,
    should_texture: true,
    enable_pbr: true,
    target_formats: ["glb", "obj", "stl"],
  };

  // Add part description as a prompt hint if provided
  if (partDescription) {
    body.prompt = partDescription;
  }

  const meshyRes = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MESHY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const meshyData = await meshyRes.json();
  console.log("Meshy create response:", JSON.stringify(meshyData));

  if (!meshyRes.ok) {
    throw new Error(meshyData?.message || `Meshy API error: ${meshyRes.status}`);
  }

  return meshyData.result;
}

// ── POST /generate-3d ── (full model)
app.post("/generate-3d", async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured on server" });

    const taskId = await createMeshyTask(imageBase64, mediaType, null);
    res.json({ taskId });
  } catch (err) {
    console.error("Error in /generate-3d:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate-3d-part ── (individual part)
app.post("/generate-3d-part", async (req, res) => {
  try {
    const { imageBase64, mediaType, partDescription } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured on server" });

    const taskId = await createMeshyTask(imageBase64, mediaType, partDescription);
    res.json({ taskId });
  } catch (err) {
    console.error("Error in /generate-3d-part:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /task-status/:taskId ──
app.get("/task-status/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured on server" });

    const meshyRes = await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`, {
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}` },
    });

    const data = await meshyRes.json();
    console.log("Meshy poll:", data.status, data.progress);

    if (!meshyRes.ok) return res.status(meshyRes.status).json({ error: data?.message || "Meshy poll error" });

    res.json({
      status: data.status,
      progress: data.progress || 0,
      modelUrls: data.model_urls || null,
      error: data.task_error?.message || null,
    });
  } catch (err) {
    console.error("Error in /task-status:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CAD Copilot Backend v2 running on port ${PORT}`);
});
