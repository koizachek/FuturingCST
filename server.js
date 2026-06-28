import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

loadEnv(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";

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

    if (req.method === "POST" && url.pathname === "/api/chat") {
      await handleTraceChat(req, res);
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
    // Stage 1 — frame: title, reading, influence factors, perspectives.
    send("stage", { stage: "frame", label: "Reading the prototype frame" });
    const frameRaw = await callLlm(
      buildFramePrompt(),
      payload,
      apiKey,
      model,
      (progress) => send("progress", { stage: "frame", ...progress })
    );
    const frame = normalizeFrame(frameRaw);
    const factorIds = new Set(frame.influenceFactors.map((factor) => factor.id));
    const perspectiveIds = new Set(frame.perspectives.map((perspective) => perspective.id));
    send("frame", frame);

    // Stage 2-4 — one horizon at a time so the graph can grow 2y -> 5y -> 10y.
    const allScenarios = [];
    for (const years of [2, 5, 10]) {
      send("stage", { stage: `horizon-${years}`, label: `Extrapolating ${years}-year futures` });
      const horizonRaw = await callLlm(
        buildHorizonPrompt(years),
        { input: payload, horizonYears: years, influenceFactors: frame.influenceFactors, perspectives: frame.perspectives },
        apiKey,
        model,
        (progress) => send("progress", { stage: `horizon-${years}`, ...progress })
      );
      const scenarios = normalizeScenarios(horizonRaw.scenarios, years, factorIds, perspectiveIds);
      scenarios.forEach((scenario) => allScenarios.push(scenario));
      send("horizon", { years, scenarios });
    }

    // Stage 5 — mission: backcasting from the surfaced scenarios.
    send("stage", { stage: "mission", label: "Outlining a mission" });
    const missionRaw = await callLlm(
      buildMissionPrompt(),
      { input: payload, scenarios: allScenarios.map((s) => ({ id: s.id, title: s.title, years: s.years })) },
      apiKey,
      model,
      (progress) => send("progress", { stage: "mission", ...progress })
    );
    const scenarioIds = new Set(allScenarios.map((scenario) => scenario.id));
    const mission = normalizeMission(missionRaw.mission, scenarioIds);
    send("mission", { mission });

    send("done", {
      title: frame.title,
      reading: frame.reading,
      input: payload,
      influenceFactors: frame.influenceFactors,
      perspectives: frame.perspectives,
      horizons: [2, 5, 10].map((years) => ({
        years,
        scenarios: allScenarios.filter((scenario) => scenario.years === years)
      })),
      mission,
      generatedAt: new Date().toISOString(),
      provider: getProviderName(),
      model
    });
  } catch (error) {
    send("error", { error: error.publicMessage || "LLM request failed." });
  } finally {
    res.end();
  }
}

async function handleTraceChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const payload = sanitizeChatInput(body);
    const apiKey = getApiKey();
    if (!apiKey) {
      const error = new Error("Set OPENROUTER_API_KEY in .env.");
      error.statusCode = 500;
      error.publicMessage = "OpenRouter is not configured. Set OPENROUTER_API_KEY in .env.";
      throw error;
    }

    const raw = await callLlm(
      buildTraceChatPrompt(),
      payload,
      apiKey,
      getModelName(),
      undefined,
      {
        maxTokens: Number(process.env.CHAT_MAX_TOKENS || 360),
        temperature: 0.45
      }
    );

    sendJson(res, 200, {
      reply: stringField(raw.reply, 1200) || "I can only discuss the selected futuring trace."
    });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      error: error.publicMessage || "Chat request failed.",
      detail: status >= 500 ? undefined : error.message
    });
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

function sanitizeChatInput(input) {
  const message = stringField(input.message, 600);
  if (message.length < 2) {
    const error = new Error("Chat message is required.");
    error.statusCode = 400;
    error.publicMessage = "Chat message is required.";
    throw error;
  }

  return {
    message,
    project: sanitizeProjectContext(input.project),
    trace: sanitizeTraceContext(input.trace),
    history: arrayOfObjects(input.history).slice(-6).map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: stringField(item.content, 600)
    })).filter((item) => item.content),
    limits: {
      maxAnswerWords: 120,
      maxHistoryMessages: 6
    }
  };
}

function sanitizeProjectContext(project = {}) {
  const input = project.input && typeof project.input === "object" ? project.input : {};
  return {
    title: stringField(project.title, 120),
    reading: stringField(project.reading, 360),
    purpose: stringField(input.purpose, 600),
    context: stringField(input.context, 700),
    stakeholders: stringField(input.stakeholders, 360),
    signals: stringField(input.signals, 360)
  };
}

function sanitizeTraceContext(trace = {}) {
  return {
    id: stringField(trace.id, 80),
    type: stringField(trace.type, 40),
    label: stringField(trace.label, 140),
    title: stringField(trace.title, 140),
    years: Number.isFinite(Number(trace.years)) ? Number(trace.years) : null,
    orientation: stringField(trace.orientation, 80),
    summary: stringField(trace.summary, 900),
    rationale: stringField(trace.rationale, 700),
    concern: stringField(trace.concern, 700),
    signals: clipStringArray(trace.signals, 6, 180),
    risks: clipStringArray(trace.risks, 6, 180),
    openQuestions: clipStringArray(trace.openQuestions, 6, 220),
    relatedFactors: arrayOfObjects(trace.relatedFactors).slice(0, 4).map((factor) => ({
      label: stringField(factor.label, 100),
      rationale: stringField(factor.rationale, 240),
      uncertainty: stringField(factor.uncertainty, 40)
    })),
    relatedPerspectives: arrayOfObjects(trace.relatedPerspectives).slice(0, 3).map((perspective) => ({
      label: stringField(perspective.label, 100),
      concern: stringField(perspective.concern, 240)
    }))
  };
}

function clipStringArray(value, count, length) {
  return arrayOfStrings(value).slice(0, count).map((item) => stringField(item, length));
}

async function callLlm(systemPrompt, userContent, apiKey, model, onProgress, options = {}) {
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
        "HTTP-Referer": process.env.APP_URL || `http://localhost:${port}`,
        "X-Title": "FuturingCST"
      },
      body: JSON.stringify({
        model,
        temperature: Number(options.temperature ?? 0.7),
        max_tokens: Number(options.maxTokens || process.env.LLM_MAX_TOKENS || 2200),
        response_format: { type: "json_object" },
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: typeof userContent === "string" ? userContent : JSON.stringify(userContent) }
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

const SHARED_RULES = `
You are the backend reasoning engine for FuturingCST, a reflective futuring tool for Creativity Support Tool prototypes.
Return only valid JSON. Do not include markdown.

Hard rules:
- Never predict one future. Always surface multiple plausible futures.
- Treat the output as reflection support, alignment support, and articulation support.
- Use the user's purpose and context as the only project-specific source.
- Do not invent citations, URLs, statistics, or claims of current factual certainty.
`.trim();

function buildFramePrompt() {
  return `${SHARED_RULES}

Task: read the prototype and surface its futuring frame.

Return JSON:
{
  "title": "short project label (max 6 words)",
  "reading": "one concise sentence describing the futuring frame",
  "influenceFactors": [
    { "label": "short label", "category": "technical|social|economic|institutional|cultural|ecological|ethical", "rationale": "why this factor matters", "uncertainty": "low|medium|high" }
  ],
  "perspectives": [
    { "label": "short stakeholder or worldview label", "concern": "what this perspective watches for" }
  ]
}

Cardinality: exactly 4 influenceFactors and exactly 3 perspectives. Keep every string short.`;
}

function buildHorizonPrompt(years) {
  return `${SHARED_RULES}

Task: given the project frame, influence factors, and perspectives, produce exactly 2 plausible (not predicted) scenarios for the ${years}-year horizon. The two scenarios must diverge from each other.

Return JSON:
{
  "scenarios": [
    {
      "title": "short scenario title (max 6 words)",
      "orientation": "adoption|resistance|adaptation|fragmentation|governance|care",
      "summary": "2-3 sentences describing this plausible future",
      "factorIds": ["ids chosen ONLY from the provided influenceFactors"],
      "perspectiveIds": ["ids chosen ONLY from the provided perspectives"],
      "signals": ["observable early signal"],
      "risks": ["risk"],
      "openQuestions": ["question for reflection"]
    }
  ]
}

Use 1-3 factorIds and 1-2 perspectiveIds per scenario, referencing the exact ids given. Exactly 2 scenarios.`;
}

function buildMissionPrompt() {
  return `${SHARED_RULES}

Task: given the project and the surfaced scenarios across horizons, outline a mission by backcasting from a preferred direction.

Return JSON:
{
  "mission": [
    { "fromScenarioId": "id chosen ONLY from the provided scenarios", "horizon": "now|2y|5y|10y", "action": "concrete backcasting action", "reason": "why this action follows" }
  ]
}

Exactly 4 mission steps. Each fromScenarioId must be one of the provided scenario ids.`;
}

function buildTraceChatPrompt() {
  return `${SHARED_RULES}

Task: answer one follow-up question as a critical futuring interlocutor for the selected trace.

Scope rules:
- Discuss only the selected trace, its related factors or perspectives, and the user's submitted prototype frame.
- Ground every answer in at least one concrete detail from the selected trace: its title, horizon, orientation, summary, signals, risks, open questions, related factors, or related perspectives.
- If the user asks a broad or vague question, interpret it as a request to pressure-test the selected trace.
- Make critical engagement possible: surface assumptions, tensions, blind spots, distribution of agency, stakeholder conflicts, risks, and counter-perspectives.
- Do not merely summarize the trace. Push on what the trace makes visible and what it leaves under-examined.
- If the question asks for unrelated advice, external facts, diagnosis, implementation code, or general chat, answer with a brief refusal that redirects to the selected futuring trace.
- Keep multiple plausible futures visible. Do not collapse the trace into one prediction.
- Do not add citations, statistics, URLs, or claims of current factual certainty.
- Maximum 150 words.

Return JSON:
{
  "reply": "short, concrete, critical, on-topic answer"
}`;
}

function normalizeFrame(raw) {
  const influenceFactors = arrayOfObjects(raw.influenceFactors).slice(0, 5).map((factor, index) => ({
    id: `factor_${index + 1}`,
    label: stringOr(factor.label, `Factor ${index + 1}`),
    category: stringOr(factor.category, "social"),
    rationale: stringOr(factor.rationale, ""),
    uncertainty: stringOr(factor.uncertainty, "medium")
  }));

  const perspectives = arrayOfObjects(raw.perspectives).slice(0, 4).map((perspective, index) => ({
    id: `perspective_${index + 1}`,
    label: stringOr(perspective.label, `Perspective ${index + 1}`),
    concern: stringOr(perspective.concern, "")
  }));

  return {
    title: stringOr(raw.title, "Untitled futuring map"),
    reading: stringOr(raw.reading, "Multiple plausible futures generated from the submitted purpose and context."),
    influenceFactors,
    perspectives
  };
}

function normalizeScenarios(rawScenarios, years, factorIds, perspectiveIds) {
  return arrayOfObjects(rawScenarios).slice(0, 3).map((scenario, index) => ({
    id: `scenario_${years}_${index + 1}`,
    years,
    title: stringOr(scenario.title, `${years}-year scenario ${index + 1}`),
    orientation: stringOr(scenario.orientation, "adaptation"),
    summary: stringOr(scenario.summary, ""),
    factorIds: arrayOfStrings(scenario.factorIds).filter((value) => factorIds.has(value)),
    perspectiveIds: arrayOfStrings(scenario.perspectiveIds).filter((value) => perspectiveIds.has(value)),
    signals: arrayOfStrings(scenario.signals),
    risks: arrayOfStrings(scenario.risks),
    openQuestions: arrayOfStrings(scenario.openQuestions)
  }));
}

function normalizeMission(rawMission, scenarioIds) {
  return arrayOfObjects(rawMission).slice(0, 6).map((step) => ({
    fromScenarioId: scenarioIds.has(step.fromScenarioId) ? step.fromScenarioId : null,
    horizon: stringOr(step.horizon, ""),
    action: stringOr(step.action, ""),
    reason: stringOr(step.reason, "")
  }));
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
