import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

loadEnv(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";

const HORIZON_YEARS = [2, 5, 10];
const SECTORS = { manufacturing: "Manufacturing", banking: "Banking (finance and insurance)", it: "IT (software, IT and telecommunications)" };
const scenarioRuns = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "timestral_scenarios.json"), "utf8"));
const sectorProfiles = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "sector_profiles.json"), "utf8"));
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 3600000);
const rateBuckets = new Map();

const cacheStaticAssets = process.env.NODE_ENV === "production";
const staticCache = new Map();

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
      enforceRateLimit(req, "extrapolate", Number(process.env.RATE_LIMIT_EXTRAPOLATE || 10));
      await handleExtrapolate(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      enforceRateLimit(req, "chat", Number(process.env.RATE_LIMIT_CHAT || 60));
      await handleTraceChat(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/rating") {
      enforceRateLimit(req, "rating", Number(process.env.RATE_LIMIT_CHAT || 60));
      await handleRating(req, res);
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

function enforceRateLimit(req, route, limit) {
  if (!limit || limit <= 0) return; // a limit of 0 disables the check

  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  const key = `${route}:${ip}`;
  const now = Date.now();

  const hits = (rateBuckets.get(key) || []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= limit) {
    const error = new Error(`Rate limit of ${limit} ${route} requests per window reached.`);
    error.statusCode = 429;
    error.publicMessage = "Too many requests. Please wait a while before trying again.";
    throw error;
  }

  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 2000) pruneRateBuckets(now);
}

function pruneRateBuckets(now) {
  for (const [key, hits] of rateBuckets) {
    if (!hits.some((time) => now - time < RATE_LIMIT_WINDOW_MS)) rateBuckets.delete(key);
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
  return process.env.LLM_MODEL || process.env.OPENROUTER_MODEL || "google/gemini-3.5-flash";
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
  let sessionId;
  try {
    const body = await readJsonBody(req);
    sessionId = stringField(body.sessionId, 80);
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
  const runId = randomUUID();
  const startedAt = Date.now();
  const { sectorEvidence: _evidence, ...loggedInput } = payload;
  const sectorKey = Object.keys(SECTORS).find((key) => SECTORS[key] === payload.sector);

  try {
    // Stage 1 — frame: title, reading, influence factors, perspectives.
    send("stage", { stage: "frame", label: "Reading the focal issue" });
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

    // Stage 2-4 — the horizons only depend on the frame, so the three LLM
    // calls run in parallel; events are emitted in order so the graph still
    // grows 2y -> 5y -> 10y.
    send("stage", { stage: "horizons", label: "Extrapolating 2/5/10-year futures" });
    const progressByYears = new Map();
    const forecastsByYears = new Map(HORIZON_YEARS.map((years) => [years, scenarioForecasts(sectorKey, years)]));
    const horizonPromises = HORIZON_YEARS.map((years) =>
      callLlm(
        buildHorizonPrompt(years),
        { input: payload, horizonYears: years, scenarioForecasts: forecastsByYears.get(years), influenceFactors: frame.influenceFactors, perspectives: frame.perspectives },
        apiKey,
        model,
        (progress) => {
          progressByYears.set(years, progress.chars || 0);
          let chars = 0;
          for (const value of progressByYears.values()) chars += value;
          send("progress", { stage: "horizons", chars });
        }
      )
    );
    // Rejections surface through the ordered awaits below; this keeps an
    // early failure from leaving the later promises' rejections unhandled.
    horizonPromises.forEach((promise) => promise.catch(() => {}));

    const allScenarios = [];
    for (const [index, years] of HORIZON_YEARS.entries()) {
      const horizonRaw = await horizonPromises[index];
      const scenarios = normalizeScenarios(horizonRaw.scenarios, years, factorIds, perspectiveIds);
      checkScenarioValues(scenarios, horizonRaw.scenarios, forecastsByYears.get(years));
      scenarios.forEach((scenario) => allScenarios.push(scenario));
      send("horizon", { years, scenarios });
    }

    // Stage 5 — implications of the surfaced scenarios.
    send("stage", { stage: "mission", label: "Deriving implications" });
    const missionRaw = await callLlm(
      buildMissionPrompt(),
      { input: payload, scenarios: allScenarios.map((s) => ({ id: s.id, title: s.title, years: s.years, summary: s.summary })) },
      apiKey,
      model,
      (progress) => send("progress", { stage: "mission", ...progress })
    );
    const scenarioIds = new Set(allScenarios.map((scenario) => scenario.id));
    const mission = normalizeMission(missionRaw.mission, scenarioIds);
    send("mission", { mission });

    const output = {
      title: frame.title,
      reading: frame.reading,
      influenceFactors: frame.influenceFactors,
      perspectives: frame.perspectives,
      horizons: HORIZON_YEARS.map((years) => ({
        years,
        scenarios: allScenarios.filter((scenario) => scenario.years === years)
      })),
      mission
    };
    logEvent("extrapolation", {
      runId, sessionId, input: loggedInput, timestralModel: scenarioRuns.model_id, output,
      provider: getProviderName(), model, durationMs: Date.now() - startedAt
    });

    send("done", {
      runId,
      title: frame.title,
      reading: frame.reading,
      input: payload,
      influenceFactors: frame.influenceFactors,
      perspectives: frame.perspectives,
      horizons: HORIZON_YEARS.map((years) => ({
        years,
        scenarios: allScenarios.filter((scenario) => scenario.years === years)
      })),
      mission,
      generatedAt: new Date().toISOString(),
      provider: getProviderName(),
      model
    });
  } catch (error) {
    console.error(`[extrapolate] ${error.message}`);
    logEvent("extrapolation_error", { runId, sessionId, input: loggedInput, error: error.message });
    send("error", { error: error.publicMessage || "LLM request failed." });
  } finally {
    res.end();
  }
}

async function handleTraceChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
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

    const reply = stringField(raw.reply, 1200) || "I can only discuss the selected futuring trace.";
    logEvent("chat", {
      runId: stringField(body.runId, 80),
      sessionId: stringField(body.sessionId, 80),
      trace: { id: payload.trace.id, type: payload.trace.type, title: payload.trace.title, years: payload.trace.years },
      message: payload.message,
      reply
    });
    sendJson(res, 200, { reply });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      error: error.publicMessage || "Chat request failed.",
      detail: status >= 500 ? undefined : error.message
    });
  }
}

const RATING_CRITERIA = new Set(["plausibility", "desirability"]);

async function handleRating(req, res) {
  const body = await readJsonBody(req);
  const value = Number(body.value);
  if (!RATING_CRITERIA.has(body.criterion) || !Number.isInteger(value) || value < 1 || value > 5) {
    sendJson(res, 400, { error: "Invalid rating." });
    return;
  }
  logEvent("rating", {
    runId: stringField(body.runId, 80),
    sessionId: stringField(body.sessionId, 80),
    scenarioId: stringField(body.scenarioId, 80),
    scenarioTitle: stringField(body.scenarioTitle, 140),
    years: Number.isFinite(Number(body.years)) ? Number(body.years) : null,
    criterion: body.criterion,
    value
  });
  sendJson(res, 200, { ok: true });
}

// MongoDB logging of inputs, outputs, ratings, and chats; a no-op when the
// MONGODB_* variables are missing, and a failed write never fails a request.
let logCollection;

function getLogCollection() {
  if (logCollection !== undefined) return logCollection;
  const { MONGODB_MAS_NAME: user, MONGODB_MAS_KEY: key, MONGODB_HOST: rawHost, MONGODB_DATABASE: database, MONGODB_COLLECTION: collection } = process.env;
  if (!user || !key || !rawHost || !database || !collection) {
    console.warn("MongoDB logging disabled: MONGODB_* variables are incomplete.");
    logCollection = null;
    return logCollection;
  }
  const host = rawHost.replace(/^mongodb(\+srv)?:\/\//, "").replace(/\/.*$/, "");
  const scheme = /:\d+$/.test(host) ? "mongodb" : "mongodb+srv";
  const client = new MongoClient(`${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(key)}@${host}/?retryWrites=true&w=majority`);
  logCollection = client.db(database).collection(collection);
  return logCollection;
}

function logEvent(type, data) {
  const collection = getLogCollection();
  if (!collection) return;
  collection.insertOne({ type, createdAt: new Date(), ...data })
    .catch((error) => console.error(`[mongodb] ${type} log failed: ${error.message}`));
}

function sanitizeInput(input) {
  const purpose = stringField(input.purpose, 1600);
  const assumptions = stringField(input.assumptions, 2400);
  const stakeholders = stringField(input.stakeholders, 1200);
  const signals = stringField(input.signals, 1200);

  if (purpose.length < 12) {
    const error = new Error("Purpose is required.");
    error.statusCode = 400;
    error.publicMessage = "Please provide more detail for Purpose.";
    throw error;
  }

  const sector = Object.hasOwn(SECTORS, input.sector) ? input.sector : "manufacturing";
  return { sector: SECTORS[sector], purpose, assumptions, stakeholders, signals, criticalUncertainties: criticalUncertainties(sector), sectorEvidence: sectorEvidence(sector) };
}

// what the sector's 30 panel firms disclose about AI, counted per category (early vs late period)
function sectorEvidence(sector) {
  const { firms, ...profile } = sectorProfiles.sectors[sector];
  const label = (row) => `${row.value.replace(/_/g, " ")}: ${row.firms_early} -> ${row.firms_late} of ${firms.length} firms`;
  const byGrowth = (rows) => [...rows].sort((a, b) => (b.firms_late - b.firms_early) - (a.firms_late - a.firms_early));
  // the sector's strongest AI uses and fastest-growing risks anchor the driving forces
  const keyDrivers = {
    aiUses: profile.business_functions.slice(0, 3).map(label),
    risks: byGrowth(profile.risk_types).slice(0, 2).map(label)
  };
  return { source: sectorProfiles.source, periods: sectorProfiles.periods, firmCount: firms.length, exampleFirms: firms.slice(0, 12), keyDrivers, ...profile };
}

const pct = (value) => `${Math.round(value * 100)} %`;

// the two quantified drivers of the sector, as in scenarioGPT: each has the
// outcomes "accelerating" (observed slope per quarter) and "stalling" (hold)
function criticalUncertainties(sector) {
  return scenarioRuns.sectors[sector].drivers.map((driver) => ({
    name: driver.name,
    measure: driver.series_name,
    history: `${pct(driver.values[0])} (${driver.dates[0].slice(0, 7)}) -> ${pct(driver.values.at(-1))} (${driver.dates.at(-1).slice(0, 7)})`,
    outcomes: ["accelerating", "stalling"]
  }));
}

function quartersBetween(from, to) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return Math.round(((ty - fy) * 12 + (tm - fm)) / 3);
}

// Each scenario has its own Timestral-28M run, conditioned on its driver outcomes
// (known covariates), precomputed with scenarioGPT's method; read at the horizon year.
function scenarioForecasts(sector, years) {
  const { drivers, backtest, scenarios } = scenarioRuns.sectors[sector];
  const key = `${years}y`;
  return scenarios.map((scenario, index) => {
    const date = scenario.by_horizon[key][0].date;
    return {
      scenario: index + 1,
      configuration: scenario.configuration.map((entry, i) => {
        const steps = quartersBetween(drivers[i].dates.at(-1), date);
        const value = Math.min(1, Math.max(0, entry.last_observed + entry.change_per_quarter * steps));
        return { driver: entry.driver, outcome: entry.outcome, value: Math.round(value * 1000) / 1000, today: entry.last_observed };
      }),
      date,
      backtest: `${backtest.inside} of ${backtest.observed} held-out values inside the 10-90 % band`,
      series: scenario.by_horizon[key].map((band) => ({
        series_id: band.series_id, name: band.name, today: band.last_observed,
        lower: band.lower, median: band.median, upper: band.upper
      }))
    };
  });
}

// Indicators come from the scenario's own forecast: driver values, then the
// model's stated values checked against that forecast's 10-90 % band.
function checkScenarioValues(scenarios, rawScenarios, forecasts) {
  const raw = arrayOfObjects(rawScenarios);
  scenarios.forEach((scenario, index) => {
    const forecast = forecasts[index];
    if (!forecast) return;
    const year = forecast.date.slice(0, 4);
    const byId = new Map(forecast.series.map((band) => [band.series_id, band]));
    const configuration = forecast.configuration.map((entry) =>
      `${entry.driver}: ${entry.outcome}, ${pct(entry.value)} by ${year} (today ${pct(entry.today)})`);
    const reasons = [];
    const values = arrayOfObjects(raw[index]?.values).map((item) => {
      const band = byId.get(item.series_id);
      const value = Number(item.value);
      if (!band || !Number.isFinite(value)) return null;
      const inside = band.lower <= value && value <= band.upper;
      const reason = stringOr(item.outside_band_reason, "");
      if (!inside) reasons.push(`${band.name}: ${reason || "no reason given"}`);
      return `${band.name}: ${pct(value)} by ${year} (Timestral median ${pct(band.median)}, band ${pct(band.lower)}-${pct(band.upper)})${inside ? "" : " - outside band"}`;
    }).filter(Boolean);
    scenario.configuration = configuration;
    scenario.signals = [...configuration, ...values, ...scenario.signals];
    scenario.outsideBandReason = reasons.join("; ");
  });
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
    sector: stringField(input.sector, 80),
    purpose: stringField(input.purpose, 600),
    assumptions: stringField(input.assumptions, 700),
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
    outsideBandReason: stringField(trace.outsideBandReason, 400),
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
  // Automatic retries with backoff for transient failures: non-JSON content,
  // upstream rate limits (429), and provider errors (5xx). Auth and network
  // configuration failures surface immediately.
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await callLlmOnce(systemPrompt, userContent, apiKey, model, onProgress, options);
    } catch (error) {
      // dropped streams ("terminated", socket resets) are transient as well
      const dropped = error instanceof TypeError || /terminated|ECONNRESET|socket/i.test(error.message || "");
      if (!(error.retryable || dropped) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

async function callLlmOnce(systemPrompt, userContent, apiKey, model, onProgress, options = {}) {
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
        // reasoning models (e.g. Gemini 3.5 Flash) spend output tokens on thinking,
        // so the answer budget gets headroom and thinking is kept low and hidden
        max_tokens: Number(options.maxTokens || process.env.LLM_MAX_TOKENS || 2200) + Number(process.env.LLM_REASONING_TOKENS || 4000),
        reasoning: { effort: process.env.LLM_REASONING_EFFORT || "low", exclude: true },
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
      error.retryable = response.status === 429 || response.status >= 500;
      error.publicMessage = response.status === 429
        ? "The model is temporarily rate-limited upstream. Try again in a moment."
        : "LLM request failed. Check provider, model, and API key.";
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
      error.retryable = true;
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
You are the backend reasoning engine for FuturingCST, a strategy support tool for reflective multi-horizon futuring.
It supports CIOs and CTOs in a scenario workshop on AI adoption, AI risk, and AI use in their sector.
Return only valid JSON. Do not include markdown.

Terms:
- Focal issue: the selected sector together with the user's question (purpose).
- Driving forces: the forces that shape the focal issue (returned as influenceFactors).
- Uncertainties: the most important and most uncertain driving forces; scenarios diverge along them.
- Indicators: observable values that show which scenario is unfolding (returned as signals).
- Implications: what a scenario means for CIOs and CTOs in the sector.

Hard rules:
- Never predict one future. Always surface multiple plausible futures.
- Treat the output as reflection support, alignment support, and articulation support.
- Use the user's sector, purpose, assumptions, sectorEvidence, and the Timestral scenario forecasts as the only project-specific sources.
- The input carries sectorEvidence: how many of the sector's 30 firms disclose each AI business function, risk type, risk subdomain, AI kind, and governance response, early (2023-24) versus late (2025-26), with example passages. Derive driving forces, scenarios, indicators, and implications from this sector's evidence and its changes over time. Name the sector's concrete business functions, risks, and firm types. A driving force or scenario that would fit any sector equally is wrong.
- The input carries criticalUncertainties: the sector's two quantified drivers, each with the outcomes "accelerating" and "stalling". Scenarios are distinct configurations of these outcomes.
- The user's assumptions are human judgement. Take them seriously and combine them with the forecasts.
- Corporate disclosures describe reporting; do not equate them with verified adoption, impacts, incidents or societal outcomes. Projection quantiles concern a measured variable and time point, not scenario probabilities.
- Do not invent citations, URLs, statistics, or claims of current factual certainty.
`.trim();

function buildFramePrompt() {
  return `${SHARED_RULES}

Task: read the focal issue and surface its driving forces and the perspectives of those affected.

Return JSON:
{
  "title": "short project label (max 6 words)",
  "reading": "one concise sentence describing the focal issue",
  "influenceFactors": [
    { "label": "short driving force label", "category": "technical|social|economic|institutional|cultural|ecological|ethical", "rationale": "why this driving force matters for the focal issue", "uncertainty": "low|medium|high" }
  ],
  "perspectives": [
    { "label": "short stakeholder or worldview label relevant to CIOs and CTOs in the sector", "concern": "what this perspective watches for" }
  ]
}

The first 2 influenceFactors are the 2 criticalUncertainties, with their names as labels, uncertainty "high", and the measured history in the rationale. The other 2 come from sectorEvidence (a business function or risk of this sector with its firm counts) or from the user's assumptions, with uncertainty "low" or "medium".
Perspectives: if the user named stakeholders, return exactly one perspective per named stakeholder (at most 4) and no others; otherwise exactly 3.
Cardinality: exactly 4 influenceFactors. Keep every string short.`;
}

function buildHorizonPrompt(years) {
  return `${SHARED_RULES}

Task: given the focal issue, driving forces, and perspectives, produce exactly 2 plausible (not predicted) scenarios for the ${years}-year horizon.
The input carries scenarioForecasts: scenario i (in order) is the configuration of driver outcomes in scenarioForecasts[i].configuration and has its own Timestral forecast, conditioned on that configuration: per series the 10-90 % band and median at the horizon date, and the backtest hit rate. The same scenario index keeps the same configuration across the 2-, 5- and 10-year horizons, so write scenario i as the ${years}-year state of that path.
Explain the system logic of each scenario with the sector's evidence: which business functions, risks, firm types and actors move, and how the driver outcomes interact. Write each scenario with its own numbers, not those of the other scenario.
State in "values" the numbers the scenario relies on: 3-4 series_ids from that scenario's forecast. A value inside the 10-90 % band needs no comment. A value outside it, e.g. because of the user's assumptions, needs "outside_band_reason": the mechanism, outside the measured history, that moves the series there.
Use direct, literal language; avoid slogans and metaphors. The narrative carries the scenario: write it as connected prose, not as a list. Give exactly 1 signal, 1 risk, and 1 open question.

Return JSON:
{
  "scenarios": [
    {
      "title": "short scenario title (max 6 words)",
      "orientation": "adoption|resistance|adaptation|fragmentation|governance|care",
      "summary": "narrative of 150-220 words in 2-3 paragraphs separated by \\n\\n: who acts, what changes in the sector's business functions and risks, how the driver outcomes interact, and what the sector looks like at the horizon",
      "factorIds": ["ids chosen ONLY from the provided influenceFactors"],
      "perspectiveIds": ["ids chosen ONLY from the provided perspectives"],
      "values": [{ "series_id": "id from this scenario's forecast", "value": 0.5, "outside_band_reason": "" }],
      "signals": ["one observable qualitative indicator that this scenario is unfolding"],
      "risks": ["one key risk"],
      "openQuestions": ["one question for reflection"]
    }
  ]
}

Use 1-3 factorIds and 1-2 perspectiveIds per scenario, referencing the exact ids given. Exactly 2 scenarios, in the order of scenarioForecasts, with distinct titles.
Titles: name the concrete state of the sector in the horizon year (actors, business function, risk), max 6 words. Do not use the driver outcome words or their variants: accelerate, accelerating, accelerated, acceleration, stall, stalling, stalled, surge, rapid, rise, rising, escalate, escalating, controlled, contained, amid, driven. Do not reuse a word between the two titles except the sector name.`;
}

function buildMissionPrompt() {
  return `${SHARED_RULES}

Task: given the focal issue and the surfaced scenarios across horizons, derive the implications: what the scenarios mean for CIOs and CTOs in the sector.

Return JSON:
{
  "mission": [
    { "fromScenarioId": "id chosen ONLY from the provided scenarios", "horizon": "2y|5y|10y", "action": "concrete implication for CIOs and CTOs", "reason": "why this implication follows from the scenario" }
  ]
}

Exactly 4 implications. Each fromScenarioId must be one of the provided scenario ids.`;
}

function buildTraceChatPrompt() {
  return `${SHARED_RULES}

Task: answer one follow-up question as a critical futuring interlocutor for the selected trace.

Scope rules:
- Discuss only the selected trace, its related factors or perspectives, and the user's focal issue and assumptions.
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
    openQuestions: arrayOfStrings(scenario.openQuestions),
    outsideBandReason: stringOr(scenario.outsideBandReason, "")
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
  const resolved = path.resolve(path.join(publicDir, cleanPath));
  if (!resolved.startsWith(publicDir + path.sep)) {
    sendText(res, 404, "Not found", "text/plain");
    return;
  }

  let entry = cacheStaticAssets ? staticCache.get(resolved) : undefined;
  if (!entry) {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      sendText(res, 404, "Not found", "text/plain");
      return;
    }
    entry = { body: fs.readFileSync(resolved), type: contentType(resolved) };
    if (cacheStaticAssets) staticCache.set(resolved, entry);
  }

  res.writeHead(200, {
    "Content-Type": entry.type,
    "Cache-Control": cacheStaticAssets ? "public, max-age=300" : "no-store"
  });
  res.end(entry.body);
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
