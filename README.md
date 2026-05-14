# CAD Copilot Backend

A lightweight Express server that proxies Meshy AI requests to avoid CORS issues in the browser.

## Endpoints

- `GET /` — Health check
- `POST /generate-3d` — Start a Meshy image-to-3D task
- `GET /task-status/:taskId` — Poll task progress and get download URLs

## Deploy to Railway

1. Push this folder to a GitHub repository
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Select your repo
4. Go to Variables and add: `MESHY_API_KEY=your_key_here`
5. Railway auto-deploys and gives you a live URL

## Local Development

```bash
npm install
MESHY_API_KEY=your_key node server.js
```
