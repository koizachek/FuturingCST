import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

loadEnv(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        provider: getProviderName(),
        configured: Boolean(getApiKey()),
        model: getModelName() || null
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/extrapolate") {
      await handleExtrapolate(req, res);
      return;
    }

    if (req.method === "GET") {
      serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      error: error.publicMessage || "Server error",
      detail: status >= 500 ? undefined : error.message
    });
  }
});

server.listen(port, host, () => {
  console.log(`FuturingCST server running at http://localhost:${port}`);
});

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function getProviderName() {
  return process.env.OPENROUTER_API_KEY ? "openrouter" : "unconfigured";
}

function getApiKey() {
  return process.env.OPENROUTER_API_KEY || "";
}

function getBaseUrl() {
  if (process.env.LLM_BASE_URL) return process.env.LLM_BASE_URL.replace(/\/$/, "");
  return "https://openrouter.ai/api/v1";
}

function getModelName() {
  return process.env.LLM_MODEL || process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat";
}

async function readJsonBody(req) {
  const maxBytes = Number(process.env.MAX_BODY_BYTES || 65536);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes.`);
      error.statusCode = 413;
      error.publicMessage = "Request body is too large.";
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    error.publicMessage = "Invalid request JSON.";
    throw error;
  }
}

async function handleExtrapolate(req, res) {
  // Resolve everything that can fail with a normal HTTP error before we
  // switch the response into Server-Sent Events mode.
  let payload;
  let apiKey;
  let model;
  try {
    const body = await readJsonBody(req);
    payload = sanitizeInput(body);
    apiKey = getApiKey();
    if (!apiKey) {
      const error = new Error("Set OPENROUTER_API_KEY in .env.");
      error.statusCode = 500;
      error.publicMessage = "OpenRouter is not configured. Set OPENROUTER_API_KEY in .env.";
      throw error;
    }
    model = getModelName();
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      error: error.publicMessage || "Server error",
      detail: status >= 500 ? undefined : error.message
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive"
  });

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const llmResponse = await callLlm(payload, apiKey, model, (progress) => send("progress", progress));
    const result = validateExtrapolation(llmResponse, payload);
    send("done", result);
  } catch (error) {
    send("error", { error: error.publicMessage || "LLM request failed." });
  } finally {
    res.end();
  }
}

function sanitizeInput(input) {
  const purpose = stringField(input.purpose, 1600);
  const context = stringField(input.context, 2400);
  const stakeholders = stringField(input.stakeholders, 1200);
  const signals = stringField(input.signals, 1200);

  if (purpose.length < 12 || context.length < 12) {
    const error = new Error("Purpose and context are required.");
    error.statusCode = 400;
    error.publicMessage = "Please provide more detail for Purpose and Context.";
    throw error;
  }

  return { purpose, context, stakeholders, signals };
}

function stringField(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

async function callLlm(input, apiKey, model, onProgress) {
  const stream = typeof onProgress === "function";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.LLM_TIMEOUT_MS || 120000));

  try {
    const response = await fetch(`${getBaseUrl()}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "FuturingCST"
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: Number(process.env.LLM_MAX_TOKENS || 4096),
        response_format: { type: "json_object" },
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: JSON.stringify(input) }
        ]
      })
    }).catch((error) => {
      const wrapped = new Error(error.name === "AbortError" ? "LLM request timed out." : error.message);
      wrapped.statusCode = 502;
      wrapped.publicMessage = error.name === "AbortError"
        ? "LLM request timed out. Try again or increase LLM_TIMEOUT_MS."
        : "Could not reach OpenRouter.";
      throw wrapped;
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`LLM request failed with ${response.status}: ${detail}`);
      error.statusCode = 502;
      error.publicMessage = "LLM request failed. Check provider, model, and API key.";
      throw error;
    }

    const content = stream
      ? await readStreamedContent(response, onProgress)
      : extractContent(await response.json());

    try {
      return parseJsonContent(content);
    } catch {
      const error = new Error(`LLM message content was not JSON: ${content}`);
      error.statusCode = 502;
      error.publicMessage = "LLM did not return the required JSON structure.";
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function extractContent(data) {
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    const error = new Error("LLM response did not include message content.");
    error.statusCode = 502;
    error.publicMessage = "LLM response was empty.";
    throw error;
  }
  return content;
}

async function readStreamedContent(response, onProgress) {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let lastReported = 0;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) content += delta;

      if (content.length - lastReported >= 200) {
        lastReported = content.length;
        onProgress({ chars: content.length });
      }
    }
  }

  if (!content) {
    const error = new Error("LLM stream did not include any content.");
    error.statusCode = 502;
    error.publicMessage = "LLM response was empty.";
    throw error;
  }

  onProgress({ chars: content.length });
  return content;
}

function parseJsonContent(content) {
  const trimmed = String(content).trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1].trim());

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));

  throw new Error("No JSON object found.");
}

function buildSystemPrompt() {
  return `
You are the backend reasoning engine for FuturingCST, a reflective futuring tool for Creativity Support Tool prototypes.

Return only valid JSON. Do not include markdown.

Hard rules:
- Never predict one future.
- Always produce multiple plausible futures.
- Treat the output as reflection support, alignment support, and articulation support.
- Use the user's purpose and context as the only project-specific source.
- Make influence factors and perspectives explicit.
- Include uncertainty and evidence needs where the answer would require external validation.
- Do not invent citations, URLs, statistics, or claims of current factual certainty.

Required JSON shape:
{
  "title": "short project label",
  "reading": "one concise sentence describing the futuring frame",
  "influenceFactors": [
    {
      "id": "factor_1",
      "label": "short label",
      "category": "technical|social|economic|institutional|cultural|ecological|ethical",
      "rationale": "why this factor matters",
      "uncertainty": "low|medium|high"
    }
  ],
  "perspectives": [
    {
      "id": "perspective_1",
      "label": "short stakeholder or worldview label",
      "concern": "what this perspective watches for"
    }
  ],
  "horizons": [
    {
      "years": 2,
      "scenarios": [
        {
          "id": "scenario_2a",
          "title": "short scenario title",
          "orientation": "adoption|resistance|adaptation|fragmentation|governance|care",
          "summary": "plausible future, not a prediction",
          "factorIds": ["factor_1"],
          "perspectiveIds": ["perspective_1"],
          "signals": ["observable early signal"],
          "risks": ["risk"],
          "openQuestions": ["question for reflection"]
        }
      ]
    }
  ],
  "mission": [
    {
      "fromScenarioId": "scenario id this step relates to",
      "horizon": "now|2y|5y|10y",
      "action": "backcasting action",
      "reason": "why this action follows from the preferred direction"
    }
  ]
}

Cardinality:
- 4 to 5 influenceFactors.
- 3 to 4 perspectives.
- horizons must be exactly 2, 5, and 10 years.
- each horizon must contain 2 scenarios.
- mission must contain 4 to 5 actions.
`.trim();
}

function validateExtrapolation(raw, input) {
  // Normalize ids so every node has a stable id and every edge reference
  // (factorIds / perspectiveIds / fromScenarioId) resolves to a real node,
  // regardless of how loosely the model filled the schema.
  const influenceFactors = arrayOfObjects(raw.influenceFactors).slice(0, 8).map((factor, index) => ({
    ...factor,
    id: stringOr(factor.id, `factor_${index + 1}`)
  }));
  const factorIds = new Set(influenceFactors.map((factor) => factor.id));

  const perspectives = arrayOfObjects(raw.perspectives).slice(0, 8).map((perspective, index) => ({
    ...perspective,
    id: stringOr(perspective.id, `perspective_${index + 1}`)
  }));
  const perspectiveIds = new Set(perspectives.map((perspective) => perspective.id));

  const byYear = new Map(
    (Array.isArray(raw.horizons) ? raw.horizons : []).map((horizon) => [Number(horizon.years), horizon])
  );
  const scenarioIds = new Set();
  const horizons = [2, 5, 10].map((years) => ({
    years,
    scenarios: arrayOfObjects(byYear.get(years)?.scenarios).slice(0, 4).map((scenario, index) => {
      const id = stringOr(scenario.id, `scenario_${years}_${index + 1}`);
      scenarioIds.add(id);
      return {
        ...scenario,
        id,
        factorIds: arrayOfStrings(scenario.factorIds).filter((value) => factorIds.has(value)),
        perspectiveIds: arrayOfStrings(scenario.perspectiveIds).filter((value) => perspectiveIds.has(value)),
        signals: arrayOfStrings(scenario.signals),
        risks: arrayOfStrings(scenario.risks),
        openQuestions: arrayOfStrings(scenario.openQuestions)
      };
    })
  }));

  const mission = arrayOfObjects(raw.mission).slice(0, 8).map((step) => ({
    ...step,
    fromScenarioId: scenarioIds.has(step.fromScenarioId) ? step.fromScenarioId : null
  }));

  return {
    title: stringOr(raw.title, "Untitled futuring map"),
    reading: stringOr(raw.reading, "Multiple plausible futures generated from the submitted purpose and context."),
    input,
    influenceFactors,
    perspectives,
    horizons,
    mission,
    generatedAt: new Date().toISOString(),
    provider: getProviderName(),
    model: getModelName()
  };
}

function arrayOfObjects(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function stringOr(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function serveStatic(requestPath, res) {
  const cleanPath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const candidate = cleanPath === "/visualinspo.png"
    ? path.join(__dirname, "visualinspo.png")
    : path.join(publicDir, cleanPath);

  const resolved = path.resolve(candidate);
  const allowed = resolved.startsWith(publicDir + path.sep) || resolved === path.join(__dirname, "visualinspo.png");
  if (!allowed || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendText(res, 404, "Not found", "text/plain");
    return;
  }

  sendText(res, 200, fs.readFileSync(resolved), contentType(resolved));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  };
  return types[ext] || "application/octet-stream";
}

function sendJson(res, status, data) {
  sendText(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

function sendText(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}
