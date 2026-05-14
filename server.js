const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3001;
const MESHY_API_KEY = process.env.MESHY_API_KEY;

// ── Middleware ──
app.use(cors({
  origin: "*", // Allow all origins — restrict this to your domain when live
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "20mb" })); // Allow large base64 images

// ── Health check ──
app.get("/", (req, res) => {
  res.json({ status: "CAD Copilot Backend is running ✅", version: "1.0.0" });
});

// ── POST /generate-3d ──
// Accepts: { imageBase64: "...", mediaType: "image/png" }
// Returns: { taskId: "..." }
app.post("/generate-3d", async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }
    if (!MESHY_API_KEY) {
      return res.status(500).json({ error: "MESHY_API_KEY not configured on server" });
    }

    const dataURI = `data:${mediaType || "image/png"};base64,${imageBase64}`;

    const meshyRes = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MESHY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: dataURI,
        ai_model: "meshy-6",
        should_remesh: true,
        should_texture: true,
        enable_pbr: true,
        target_formats: ["glb", "obj", "stl"],
      }),
    });

    const meshyData = await meshyRes.json();

    if (!meshyRes.ok) {
      return res.status(meshyRes.status).json({
        error: meshyData?.message || "Meshy API error",
        details: meshyData,
      });
    }

    res.json({ taskId: meshyData.result });

  } catch (err) {
    console.error("Error in /generate-3d:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /task-status/:taskId ──
// Polls Meshy for task status and returns progress + URLs when done
app.get("/task-status/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;

    if (!MESHY_API_KEY) {
      return res.status(500).json({ error: "MESHY_API_KEY not configured on server" });
    }

    const meshyRes = await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`, {
      headers: { "Authorization": `Bearer ${MESHY_API_KEY}` },
    });

    const data = await meshyRes.json();

    if (!meshyRes.ok) {
      return res.status(meshyRes.status).json({
        error: data?.message || "Meshy poll error",
      });
    }

    res.json({
      status: data.status,           // PENDING | IN_PROGRESS | SUCCEEDED | FAILED
      progress: data.progress || 0,
      modelUrls: data.model_urls || null,
      error: data.task_error?.message || null,
    });

  } catch (err) {
    console.error("Error in /task-status:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──
app.listen(PORT, () => {
  console.log(`✅ CAD Copilot Backend running on port ${PORT}`);
});
