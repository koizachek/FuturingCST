const form = document.querySelector("#futuring-form");
const statusEl = document.querySelector("#status");
const resultPanel = document.querySelector("#result-panel");
const selectionPanel = document.querySelector("#selection-panel");
const canvas = document.querySelector("#graph-canvas");
const ctx = canvas.getContext("2d");

let graph = emptyGraph();
let latestData = null;
let selectedNodeId = null;
let hoveredNodeId = null;
let preferredScenarioId = null;
let frameId = null;

const palette = {
  root: "#f2fff8",
  factor: "#d8d19b",
  perspective: "#b8fff2",
  scenario: "#eef5ef",
  mission: "#f0ffb0"
};

const typeLabels = {
  root: "PROTOTYPE",
  factor: "FACTOR",
  perspective: "PERSPECTIVE",
  scenario: "SCENARIO",
  mission: "MISSION"
};

const HORIZON_COLUMNS = [
  { years: 2, nx: 0.42 },
  { years: 5, nx: 0.64 },
  { years: 10, nx: 0.86 }
];
const FRAME_DIVIDER_NX = 0.31;

const crosses = makeCrosses(46);

resizeCanvas();
window.addEventListener("resize", resizeCanvas);
canvas.addEventListener("click", selectNode);
canvas.addEventListener("mousemove", hoverNode);
canvas.addEventListener("mouseleave", () => { hoveredNodeId = null; });
form.addEventListener("submit", submitForm);
resultPanel.addEventListener("click", handleResultClick);
animate();

function emptyGraph() {
  return { nodes: [], edges: [], index: new Map(), scenariosByYear: new Map(), startedAt: performance.now() };
}

async function submitForm(event) {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  setStatus("Starting extrapolation...");
  resultPanel.innerHTML = "<p class=\"empty-state\">Futures will appear here as each horizon is generated.</p>";
  selectionPanel.innerHTML = "<p class=\"empty-state\">The graph grows stage by stage. Select a node to inspect its trace.</p>";
  graph = emptyGraph();
  latestData = null;
  selectedNodeId = null;
  preferredScenarioId = null;

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  const startedAt = performance.now();

  try {
    const response = await fetch("/api/extrapolate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("text/event-stream")) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || "Request failed.");
    }

    await consumeStream(response, startedAt);
  } catch (error) {
    setStatus(error.message, true);
    resultPanel.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

async function consumeStream(response, startedAt) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      const event = parseEvent(block);
      if (event) handleEvent(event, startedAt);
    }
  }
}

function handleEvent(event, startedAt) {
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(0);

  if (event.name === "stage") {
    setStatus(`${event.data.label}... (${seconds}s)`);
  } else if (event.name === "progress") {
    setStatus(`${stageTitle(event.data.stage)} - ${event.data.chars || 0} characters (${seconds}s)`);
  } else if (event.name === "frame") {
    latestData = { ...event.data, horizons: [], mission: [] };
    addFrame(event.data);
    if (!selectedNodeId) selectedNodeId = "root";
    renderResult(latestData);
    renderSelection();
  } else if (event.name === "horizon") {
    if (latestData) latestData.horizons.push({ years: event.data.years, scenarios: event.data.scenarios });
    addHorizon(event.data.years, event.data.scenarios);
    renderResult(latestData);
  } else if (event.name === "mission") {
    if (latestData) latestData.mission = event.data.mission;
    addMission(event.data.mission);
    renderResult(latestData);
  } else if (event.name === "done") {
    latestData = event.data;
    renderResult(latestData);
    setStatus(`Generated with ${event.data.provider} / ${event.data.model}.`);
  } else if (event.name === "error") {
    throw new Error(event.data.error || "LLM request failed.");
  }
}

function stageTitle(stage) {
  if (stage === "frame") return "Reading frame";
  if (stage === "mission") return "Outlining mission";
  if (typeof stage === "string" && stage.startsWith("horizon-")) return `Extrapolating ${stage.slice(8)}-year futures`;
  return "Extrapolating";
}

function parseEvent(block) {
  let name = "message";
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { name, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

/* ---------- incremental graph construction ---------- */

function nowElapsed() {
  return performance.now() - graph.startedAt;
}

function addNode(node) {
  graph.nodes.push(node);
  graph.index.set(node.id, node);
}

function addEdge(from, to, kind, appearAt) {
  graph.edges.push({ from, to, kind, appearAt });
}

function commit() {
  computeLayout(graph);
}

function addFrame(data) {
  const base = nowElapsed();
  addNode({
    id: "root",
    type: "root",
    label: data.title,
    payload: data,
    nx: 0.06,
    ny: 0.5,
    r: 7,
    labelSide: "right",
    appearAt: base
  });

  const factors = data.influenceFactors || [];
  factors.forEach((factor, index) => {
    addNode({
      id: factor.id,
      type: "factor",
      label: factor.label,
      payload: factor,
      nx: 0.19,
      ny: span(index, factors.length, 0.14, 0.46),
      r: 5,
      labelSide: "right",
      appearAt: base + 250 + index * 120
    });
    addEdge("root", factor.id, "frame", base + 320 + index * 120);
  });

  const perspectives = data.perspectives || [];
  perspectives.forEach((perspective, index) => {
    addNode({
      id: perspective.id,
      type: "perspective",
      label: perspective.label,
      payload: perspective,
      nx: 0.19,
      ny: span(index, perspectives.length, 0.6, 0.88),
      r: 4,
      labelSide: "right",
      appearAt: base + 650 + index * 120
    });
    addEdge("root", perspective.id, "frame", base + 720 + index * 120);
  });

  commit();
}

function addHorizon(years, scenarios) {
  const base = nowElapsed();
  const column = HORIZON_COLUMNS.find((entry) => entry.years === years) || { nx: 0.7 };
  const created = [];

  scenarios.forEach((scenario, index) => {
    addNode({
      id: scenario.id,
      type: "scenario",
      label: scenario.title,
      payload: scenario,
      nx: column.nx,
      ny: span(index, scenarios.length, 0.32, 0.66),
      r: 6,
      labelSide: years === 10 ? "left" : "right",
      appearAt: base + index * 220
    });
    created.push(scenario.id);

    scenario.factorIds.forEach((factorId, i) => {
      addEdge(factorId, scenario.id, "link", base + 120 + index * 220 + i * 40);
    });
    scenario.perspectiveIds.forEach((perspectiveId, i) => {
      addEdge(perspectiveId, scenario.id, "link", base + 160 + index * 220 + i * 40);
    });
  });

  // Flow edges connect the previous horizon to this one so the timeline is traceable.
  const previousYears = years === 5 ? 2 : years === 10 ? 5 : null;
  if (previousYears) {
    const previous = graph.scenariosByYear.get(previousYears) || [];
    created.forEach((toId, i) => {
      const fromId = previous[i] || previous[0];
      if (fromId) addEdge(fromId, toId, "flow", base + 80 + i * 220);
    });
  }

  graph.scenariosByYear.set(years, created);
  commit();
}

function addMission(mission) {
  const base = nowElapsed();
  const steps = mission || [];
  steps.forEach((step, index) => {
    const id = `mission_${index}`;
    addNode({
      id,
      type: "mission",
      label: step.action,
      payload: step,
      nx: span(index, steps.length, 0.42, 0.86),
      ny: 0.93,
      r: 4,
      labelSide: "top",
      appearAt: base + index * 160
    });
    const allScenarios = [...graph.scenariosByYear.values()].flat();
    const from = step.fromScenarioId || allScenarios[index % Math.max(1, allScenarios.length)] || "root";
    addEdge(from, id, "mission", base + 80 + index * 160);
  });
  commit();
}

function span(index, count, min, max) {
  if (count <= 1) return (min + max) / 2;
  return min + (index / (count - 1)) * (max - min);
}

function computeLayout(target) {
  const width = canvas.clientWidth || 900;
  const height = canvas.clientHeight || 700;
  for (const node of target.nodes) {
    node.x = node.nx * width + (node.ox || 0);
    node.y = node.ny * height + (node.oy || 0);
  }
}

/* ---------- rendering ---------- */

function animate() {
  frameId = requestAnimationFrame(animate);
  draw();
}

function startAnimation() {
  if (frameId === null) animate();
}

function stopAnimation() {
  if (frameId !== null) {
    cancelAnimationFrame(frameId);
    frameId = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopAnimation();
  else startAnimation();
});

function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const now = performance.now();
  const elapsed = now - graph.startedAt;
  const active = hoveredNodeId || selectedNodeId;

  if (graph.nodes.length) computeLayout(graph);
  ctx.clearRect(0, 0, width, height);
  drawField(width, height, now);
  drawScaffold(width, height);

  for (const edge of graph.edges) {
    const age = elapsed - edge.appearAt;
    if (age <= 0) continue;
    const from = graph.index.get(edge.from);
    const to = graph.index.get(edge.to);
    if (!from || !to) continue;
    const highlight = active && (edge.from === active || edge.to === active);
    drawEdge(from, to, Math.min(1, age / 700), now, edge.kind, highlight);
  }

  for (const node of graph.nodes) {
    const age = elapsed - node.appearAt;
    if (age <= 0) continue;
    drawNode(node, Math.min(1, age / 520), now);
  }

  drawLegend(width, height);
}

function drawField(width, height, now) {
  ctx.save();
  for (let i = 0; i < 220; i += 1) {
    const x = (i * 67 + now * 0.005) % width;
    const y = (i * 113 + Math.sin(now * 0.0006 + i) * 26) % height;
    const yellow = i % 11 === 0;
    ctx.fillStyle = yellow ? "rgba(240,255,176,0.5)" : "rgba(214,232,224,0.22)";
    ctx.fillRect(x, y, 1, 1);
  }

  ctx.lineWidth = 1;
  for (const cross of crosses) {
    const x = cross.x * width;
    const y = cross.y * height;
    const s = cross.s;
    const twinkle = 0.18 + 0.12 * Math.sin(now * 0.001 + cross.p);
    ctx.strokeStyle = cross.yellow ? `rgba(240,255,176,${twinkle + 0.1})` : `rgba(220,236,228,${twinkle})`;
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.lineTo(x + s, y);
    ctx.moveTo(x, y - s);
    ctx.lineTo(x, y + s);
    ctx.stroke();
  }
  ctx.restore();
}

function drawScaffold(width, height) {
  if (!graph.nodes.length) return;
  ctx.save();
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textBaseline = "top";

  // divider between the frame zone and the horizon zone
  const dividerX = FRAME_DIVIDER_NX * width;
  ctx.strokeStyle = "rgba(230,244,236,0.08)";
  ctx.setLineDash([1, 5]);
  ctx.beginPath();
  ctx.moveTo(dividerX, height * 0.08);
  ctx.lineTo(dividerX, height * 0.92);
  ctx.stroke();

  ctx.fillStyle = "rgba(156,171,164,0.7)";
  ctx.fillText("FRAME", width * 0.06, height * 0.05);

  for (const column of HORIZON_COLUMNS) {
    const x = column.nx * width;
    ctx.strokeStyle = "rgba(230,244,236,0.07)";
    ctx.setLineDash([1, 6]);
    ctx.beginPath();
    ctx.moveTo(x, height * 0.12);
    ctx.lineTo(x, height * 0.9);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(184,255,242,0.55)";
    ctx.textAlign = "center";
    ctx.fillText(`${column.years}-YEAR`, x, height * 0.05);
    ctx.textAlign = "left";
  }
  ctx.restore();
}

function drawEdge(from, to, progress, now, kind, highlight) {
  const endX = from.x + (to.x - from.x) * progress;
  const endY = from.y + (to.y - from.y) * progress;
  const dashOffset = (now * 0.04) % 16;

  let color = "rgba(214,232,224,0.22)";
  let width = 1;
  let dash = [2, 7];
  if (kind === "flow") { color = "rgba(184,255,242,0.4)"; width = 1.2; dash = [4, 6]; }
  else if (kind === "mission") { color = "rgba(240,255,176,0.32)"; dash = [1, 6]; }
  else if (kind === "frame") { color = "rgba(216,209,155,0.28)"; }

  if (highlight) {
    color = kind === "mission" ? "rgba(240,255,176,0.85)" : "rgba(184,255,242,0.85)";
    width += 0.6;
  }

  ctx.save();
  ctx.setLineDash(dash);
  ctx.lineDashOffset = -dashOffset;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.restore();
}

function drawNode(node, progress, now) {
  const color = palette[node.type] || palette.scenario;
  const radius = node.r * progress;
  const active = node.id === selectedNodeId || node.id === hoveredNodeId;

  ctx.save();

  // soft particle halo
  ctx.globalAlpha = progress * 0.5;
  const haloCount = node.type === "root" || node.type === "scenario" ? 10 : 6;
  for (let i = 0; i < haloCount; i += 1) {
    const angle = (i / haloCount) * Math.PI * 2 + now * 0.0004 * (i % 2 ? 1 : -1);
    const dist = node.r * (1.8 + 0.5 * Math.sin(now * 0.001 + i));
    ctx.fillStyle = color;
    ctx.fillRect(node.x + Math.cos(angle) * dist, node.y + Math.sin(angle) * dist, 1, 1);
  }

  ctx.globalAlpha = progress;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = active ? 20 : 10;
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  drawLabel(node, color, progress, active);
  ctx.restore();
}

function drawLabel(node, color, progress, active) {
  const text = truncate(node.label || node.id, 26);
  const tag = typeLabels[node.type] || "NODE";
  const coord = `${node.nx.toFixed(2)} / ${node.ny.toFixed(2)}`;
  ctx.font = "11px Inter, system-ui, sans-serif";
  const textWidth = Math.max(ctx.measureText(text).width, ctx.measureText(coord).width, ctx.measureText(tag).width);

  let lx;
  let ly = node.y - 8;
  let leadFromX = node.x;
  let leadToX;

  if (node.labelSide === "left") {
    lx = node.x - 14 - textWidth;
    leadToX = node.x - 12;
  } else if (node.labelSide === "top") {
    lx = node.x - textWidth / 2;
    ly = node.y - 40;
    leadFromX = node.x;
    leadToX = node.x;
  } else {
    lx = node.x + 14;
    leadToX = node.x + 12;
  }

  ctx.globalAlpha = active ? 1 : 0.62 * progress;

  // leader line
  ctx.strokeStyle = active ? color : "rgba(214,232,224,0.3)";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  if (node.labelSide === "top") {
    ctx.moveTo(node.x, node.y - 10);
    ctx.lineTo(node.x, ly + 26);
  } else {
    ctx.moveTo(leadFromX, node.y);
    ctx.lineTo(leadToX, node.y);
    ctx.lineTo(lx + (node.labelSide === "left" ? textWidth : 0), ly + 10);
  }
  ctx.stroke();

  if (active) {
    ctx.fillStyle = "rgba(6,10,9,0.78)";
    ctx.fillRect(lx - 5, ly - 12, textWidth + 10, 40);
    ctx.strokeStyle = color;
    ctx.strokeRect(lx - 5, ly - 12, textWidth + 10, 40);
  }

  ctx.fillStyle = active ? "rgba(120,134,128,0.95)" : "rgba(120,134,128,0.7)";
  ctx.fillText(tag, lx, ly - 10);
  ctx.fillStyle = active ? "rgba(245,250,247,1)" : "rgba(230,240,234,0.82)";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.fillText(text, lx, ly + 4);
  ctx.fillStyle = "rgba(120,134,128,0.7)";
  ctx.font = "9px Inter, system-ui, sans-serif";
  ctx.fillText(coord, lx, ly + 18);
}

function drawLegend(width, height) {
  if (!graph.nodes.length) return;
  const items = [
    ["root", "Prototype"],
    ["factor", "Influence factor"],
    ["perspective", "Perspective"],
    ["scenario", "Scenario"],
    ["mission", "Mission step"]
  ];
  ctx.save();
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const x = 16;
  let y = height - 16 - items.length * 16;
  for (const [type, label] of items) {
    ctx.fillStyle = palette[type];
    ctx.shadowColor = palette[type];
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(214,232,224,0.7)";
    ctx.fillText(label, x + 10, y);
    y += 16;
  }
  ctx.restore();
}

function makeCrosses(count) {
  const out = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let i = 0; i < count; i += 1) {
    out.push({ x: rand(), y: rand(), s: 2 + rand() * 3, p: rand() * 6.28, yellow: rand() > 0.85 });
  }
  return out;
}

/* ---------- interaction ---------- */

function pickNode(event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let nearest = null;
  let nearestDistance = 22;
  for (const node of graph.nodes) {
    const dist = Math.hypot(node.x - x, node.y - y);
    if (dist < nearestDistance) {
      nearest = node;
      nearestDistance = dist;
    }
  }
  return nearest;
}

function selectNode(event) {
  const nearest = pickNode(event);
  if (nearest) {
    selectedNodeId = nearest.id;
    renderSelection();
  }
}

function hoverNode(event) {
  const nearest = pickNode(event);
  hoveredNodeId = nearest ? nearest.id : null;
  canvas.style.cursor = nearest ? "pointer" : "default";
}

function handleResultClick(event) {
  const scenarioButton = event.target.closest("[data-scenario-id]");
  if (!scenarioButton) return;

  preferredScenarioId = scenarioButton.dataset.scenarioId;
  selectedNodeId = preferredScenarioId;
  renderResult(latestData);
  renderSelection();
}

/* ---------- side panels ---------- */

function renderResult(data) {
  if (!data) return;

  const horizons = (data.horizons || []).map((horizon) => `
    <div class="result-block">
      <h2>${horizon.years}-year futures</h2>
      <div class="scenario-list">
        ${(horizon.scenarios || []).map((scenario) => `
          <button class="scenario-row ${scenario.id === preferredScenarioId ? "selected" : ""}" type="button" data-scenario-id="${escapeHtml(scenario.id || "")}">
            <span>${escapeHtml(scenario.title || "Untitled")}</span>
            <small>${escapeHtml(scenario.orientation || "scenario")}</small>
          </button>
          <p>${escapeHtml(scenario.summary || "")}</p>
        `).join("")}
      </div>
    </div>
  `).join("");

  const missionBlock = (data.mission || []).length ? `
    <div class="result-block">
      <h2>Mission trace</h2>
      <ul>
        ${(data.mission || []).map((step) => `
          <li><strong>${escapeHtml(step.horizon || "")}</strong>: ${escapeHtml(step.action || "")}</li>
        `).join("")}
      </ul>
    </div>` : "";

  resultPanel.innerHTML = `
    <div class="result-block">
      <h2>${escapeHtml(data.title)}</h2>
      <p>${escapeHtml(data.reading)}</p>
    </div>
    <div class="result-block">
      <h2>Influence factors</h2>
      <ul>
        ${(data.influenceFactors || []).map((factor) => `
          <li><strong>${escapeHtml(factor.label || factor.id)}</strong>: ${escapeHtml(factor.rationale || "")}</li>
        `).join("")}
      </ul>
    </div>
    <div class="result-block">
      <h2>Perspectives</h2>
      <ul>
        ${(data.perspectives || []).map((perspective) => `
          <li><strong>${escapeHtml(perspective.label || perspective.id)}</strong>: ${escapeHtml(perspective.concern || "")}</li>
        `).join("")}
      </ul>
    </div>
    ${horizons}
    ${missionBlock}
  `;
}

function renderSelection() {
  const node = graph.index.get(selectedNodeId);
  if (!node) {
    selectionPanel.innerHTML = "<p class=\"empty-state\">Select a generated node to inspect its trace.</p>";
    return;
  }

  if (node.type === "root") {
    selectionPanel.innerHTML = header("prototype", node.label) + `<p>${escapeHtml(node.payload?.reading || "")}</p>`;
    return;
  }

  if (node.type === "factor") {
    selectionPanel.innerHTML = header(node.payload?.category || "factor", node.label) +
      `<p>${escapeHtml(node.payload?.rationale || "")}</p>` +
      `<p class="metadata-line">uncertainty: ${escapeHtml(node.payload?.uncertainty || "unspecified")}</p>`;
    return;
  }

  if (node.type === "perspective") {
    selectionPanel.innerHTML = header("perspective", node.label) + `<p>${escapeHtml(node.payload?.concern || "")}</p>`;
    return;
  }

  if (node.type === "scenario") {
    const payload = node.payload || {};
    selectionPanel.innerHTML = header(`${payload.years || ""}y scenario`, payload.title || node.label) +
      `<p>${escapeHtml(payload.summary || "")}</p>` +
      renderMiniList("Signals", payload.signals) +
      renderMiniList("Risks", payload.risks) +
      renderMiniList("Open questions", payload.openQuestions);
    return;
  }

  selectionPanel.innerHTML = header(node.payload?.horizon || "mission", node.label) +
    `<p>${escapeHtml(node.payload?.reason || "")}</p>`;
}

function header(tag, title) {
  return `
    <div class="selection-header">
      <span>${escapeHtml(tag)}</span>
      <h2>${escapeHtml(title || "")}</h2>
    </div>`;
}

function renderMiniList(title, items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return "";

  return `
    <div class="mini-list">
      <h3>${escapeHtml(title)}</h3>
      <ul>
        ${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </div>
  `;
}

/* ---------- utilities ---------- */

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (graph.nodes.length) computeLayout(graph);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function truncate(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

window.addEventListener("beforeunload", stopAnimation);
