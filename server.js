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
  res.json({ status: "CAD Copilot Backend is running", version: "3.0.0" });
});

// ── POST /generate-3d ── (Image to 3D - full object)
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
    console.log("Image-to-3D create:", JSON.stringify(data));
    if (!meshyRes.ok) return res.status(meshyRes.status).json({ error: data?.message || "Meshy error" });
    res.json({ taskId: data.result });

  } catch (err) {
    console.error("/generate-3d error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate-3d-text ── (Text to 3D - individual parts, two-step)
app.post("/generate-3d-text", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });

    // Step 1: Create preview task
    const previewRes = await fetch("https://api.meshy.ai/openapi/v2/text-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "preview",
        prompt: prompt.substring(0, 600), // max 600 chars
        should_remesh: true,
        target_formats: ["glb", "obj", "stl"],
      }),
    });

    const previewData = await previewRes.json();
    console.log("Text-to-3D preview create:", JSON.stringify(previewData));
    if (!previewRes.ok) return res.status(previewRes.status).json({ error: previewData?.message || "Meshy preview error" });

    res.json({ taskId: previewData.result, type: "text-to-3d" });

  } catch (err) {
    console.error("/generate-3d-text error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /refine-3d-text ── (Step 2: apply texture to preview)
app.post("/refine-3d-text", async (req, res) => {
  try {
    const { previewTaskId, prompt } = req.body;
    if (!previewTaskId) return res.status(400).json({ error: "previewTaskId is required" });
    if (!MESHY_API_KEY) return res.status(500).json({ error: "MESHY_API_KEY not configured" });

    const refineRes = await fetch("https://api.meshy.ai/openapi/v2/text-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "refine",
        preview_task_id: previewTaskId,
        texture_prompt: prompt ? prompt.substring(0, 600) : undefined,
        target_formats: ["glb", "obj", "stl"],
      }),
    });

    const refineData = await refineRes.json();
    console.log("Text-to-3D refine create:", JSON.stringify(refineData));
    if (!refineRes.ok) return res.status(refineRes.status).json({ error: refineData?.message || "Meshy refine error" });

    res.json({ taskId: refineData.result, type: "refine" });

  } catch (err) {
    console.error("/refine-3d-text error:", err);
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
    console.error("/task-status error:", err);
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

    res.json({
      status: data.status,
      progress: data.progress || 0,
      modelUrls: data.model_urls || null,
      error: data.task_error?.message || null,
    });
  } catch (err) {
    console.error("/text-task-status error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CAD Copilot Backend v3 running on port ${PORT}`);
});
