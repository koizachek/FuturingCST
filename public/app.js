const form = document.querySelector("#futuring-form");
const appShell = document.querySelector(".app-shell");
const statusEl = document.querySelector("#status");
const detailPanel = document.querySelector("#detail-panel");
const resultPanel = document.querySelector("#result-panel");
const selectionPanel = document.querySelector("#selection-panel");
const canvas = document.querySelector("#graph-canvas");
const ctx = canvas.getContext("2d");
const cursor = document.querySelector("#cursor");

let graph = emptyGraph();
let latestData = null;
let selectedNodeId = null;
let hoveredNodeId = null;
let preferredScenarioId = null;
let frameId = null;
let chatThreads = new Map();
let generationComplete = false;

const palette = {
  root: "#f4f4ef",
  factor: "#aaa9a2",
  perspective: "#c9c9c3",
  scenario: "#eeeeea",
  mission: "#7f7f7a"
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
  { years: 5, nx: 0.63 },
  { years: 10, nx: 0.84 }
];

const labelMax = { root: 24, factor: 22, perspective: 22, scenario: 24, mission: 18 };
const FRAME_DIVIDER_NX = 0.31;
const CHAT_INPUT_MAX = 420;
const CHAT_HISTORY_LIMIT = 6;

const crosses = makeCrosses(46);

initCursor();
resizeCanvas();
window.addEventListener("resize", resizeCanvas);
canvas.addEventListener("click", selectNode);
canvas.addEventListener("mousemove", hoverNode);
canvas.addEventListener("mouseleave", () => {
  hoveredNodeId = null;
  if (cursor) cursor.classList.remove("big");
});
form.addEventListener("submit", submitForm);
resultPanel.addEventListener("click", handleResultClick);
detailPanel.addEventListener("submit", handleChatSubmit);
animate();

function emptyGraph() {
  return { nodes: [], edges: [], index: new Map(), scenariosByYear: new Map(), startedAt: performance.now() };
}

async function submitForm(event) {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  setStatus("Starting extrapolation...");
  closeDetailPanel();
  graph = emptyGraph();
  latestData = null;
  selectedNodeId = null;
  preferredScenarioId = null;
  chatThreads = new Map();
  generationComplete = false;

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
    closeDetailPanel();
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
  } else if (event.name === "horizon") {
    if (latestData) latestData.horizons.push({ years: event.data.years, scenarios: event.data.scenarios });
    addHorizon(event.data.years, event.data.scenarios);
  } else if (event.name === "mission") {
    if (latestData) latestData.mission = event.data.mission;
    addMission(event.data.mission);
  } else if (event.name === "done") {
    latestData = event.data;
    generationComplete = true;
    setStatus(`Generated with ${event.data.provider} / ${event.data.model}.`);
    if (selectedNodeId) renderSelection();
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
      labelSide: "top",
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
    ctx.fillStyle = yellow ? "rgba(238,238,232,0.5)" : "rgba(214,214,208,0.22)";
    ctx.fillRect(x, y, 1, 1);
  }

  ctx.lineWidth = 1;
  for (const cross of crosses) {
    const x = cross.x * width;
    const y = cross.y * height;
    const s = cross.s;
    const twinkle = 0.18 + 0.12 * Math.sin(now * 0.001 + cross.p);
    ctx.strokeStyle = cross.yellow ? `rgba(238,238,232,${twinkle + 0.1})` : `rgba(220,220,214,${twinkle})`;
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
  ctx.font = "10px 'Space Mono', ui-monospace, monospace";
  ctx.textBaseline = "top";

  // divider between the frame zone and the horizon zone
  const dividerX = FRAME_DIVIDER_NX * width;
  ctx.strokeStyle = "rgba(232,232,226,0.08)";
  ctx.setLineDash([1, 5]);
  ctx.beginPath();
  ctx.moveTo(dividerX, height * 0.08);
  ctx.lineTo(dividerX, height * 0.92);
  ctx.stroke();

  ctx.fillStyle = "rgba(156,171,164,0.7)";
  ctx.fillText("FRAME", width * 0.06, height * 0.05);

  for (const column of HORIZON_COLUMNS) {
    const x = column.nx * width;
    ctx.strokeStyle = "rgba(232,232,226,0.07)";
    ctx.setLineDash([1, 6]);
    ctx.beginPath();
    ctx.moveTo(x, height * 0.12);
    ctx.lineTo(x, height * 0.9);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(214,214,208,0.62)";
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

  let color = "rgba(214,214,208,0.22)";
  let width = 1;
  let dash = [2, 7];
  if (kind === "flow") { color = "rgba(226,226,220,0.4)"; width = 1.2; dash = [4, 6]; }
  else if (kind === "mission") { color = "rgba(180,180,174,0.32)"; dash = [1, 6]; }
  else if (kind === "frame") { color = "rgba(170,169,162,0.28)"; }

  if (highlight) {
    color = kind === "mission" ? "rgba(214,214,208,0.82)" : "rgba(238,238,232,0.86)";
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
  const tag = typeLabels[node.type] || "NODE";
  const text = truncate(node.label || node.id, labelMax[node.type] || 22);
  const coord = active ? `${node.nx.toFixed(2)} / ${node.ny.toFixed(2)}` : "";

  const tagFont = "9px 'Space Mono', ui-monospace, monospace";
  const textFont = "12px 'Space Mono', ui-monospace, monospace";
  ctx.font = tagFont;
  const tagW = ctx.measureText(tag).width;
  ctx.font = textFont;
  const textW = ctx.measureText(text).width;
  const blockW = Math.max(tagW, textW, coord ? 70 : 0) + 12;
  const blockH = coord ? 44 : 32;

  const pad = node.r + 8;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  let bx;
  let by;
  if (node.labelSide === "left") {
    bx = node.x - pad - blockW;
    by = node.y - blockH / 2;
  } else if (node.labelSide === "top") {
    bx = node.x - blockW / 2;
    by = node.y - pad - blockH;
  } else {
    bx = node.x + pad;
    by = node.y - blockH / 2;
  }

  // keep the block inside the canvas
  bx = Math.max(6, Math.min(bx, width - blockW - 6));
  by = Math.max(4, Math.min(by, height - blockH - 4));

  ctx.globalAlpha = active ? 1 : 0.85 * progress;

  // leader line from node edge toward the block
  const anchorX = Math.max(bx, Math.min(node.x, bx + blockW));
  const anchorY = Math.max(by, Math.min(node.y, by + blockH));
  ctx.strokeStyle = active ? color : "rgba(214,214,208,0.28)";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(node.x, node.y);
  ctx.lineTo(anchorX, anchorY);
  ctx.stroke();

  // dark backing so text reads over the particle field
  ctx.fillStyle = active ? "rgba(6,10,9,0.92)" : "rgba(6,10,9,0.6)";
  ctx.fillRect(bx, by, blockW, blockH);
  if (active) {
    ctx.strokeStyle = color;
    ctx.strokeRect(bx, by, blockW, blockH);
  }

  const tx = bx + 6;
  ctx.textAlign = "left";
  ctx.fillStyle = active ? "rgba(150,164,158,1)" : "rgba(140,154,148,0.85)";
  ctx.font = tagFont;
  ctx.fillText(tag, tx, by + 12);
  ctx.fillStyle = active ? "rgba(245,250,247,1)" : "rgba(232,242,236,0.95)";
  ctx.font = textFont;
  ctx.fillText(text, tx, by + 25);
  if (coord) {
    ctx.fillStyle = "rgba(146,146,140,0.8)";
    ctx.font = tagFont;
    ctx.fillText(coord, tx, by + 38);
  }
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
  ctx.font = "10px 'Space Mono', ui-monospace, monospace";
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
    ctx.fillStyle = "rgba(214,214,208,0.7)";
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
  if (cursor) cursor.classList.toggle("big", Boolean(nearest));
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
  if (!node || !canOpenDetail(node)) {
    closeDetailPanel();
    return;
  }

  openDetailPanel();
  let content = "";

  if (node.type === "factor") {
    content = header(node.payload?.category || "signal", node.label) +
      `<p>${escapeHtml(node.payload?.rationale || "")}</p>` +
      `<p class="metadata-line">uncertainty: ${escapeHtml(node.payload?.uncertainty || "unspecified")}</p>`;
  } else if (node.type === "perspective") {
    content = header("perspective", node.label) + `<p>${escapeHtml(node.payload?.concern || "")}</p>`;
  } else if (node.type === "scenario") {
    const payload = node.payload || {};
    content = header(`${payload.years || ""}y scenario`, payload.title || node.label) +
      `<p>${escapeHtml(payload.summary || "")}</p>` +
      renderMiniList("Signals", payload.signals) +
      renderMiniList("Risks", payload.risks) +
      renderMiniList("Open questions", payload.openQuestions);
  }

  selectionPanel.innerHTML = content;
  renderChatPanel(node);
}

function canOpenDetail(node) {
  if (!latestData || !generationComplete || !node) return false;
  return node.type === "scenario" || node.type === "factor" || node.type === "perspective";
}

function openDetailPanel() {
  appShell.classList.add("detail-open");
  detailPanel.hidden = false;
  resizeCanvas();
}

function closeDetailPanel() {
  appShell.classList.remove("detail-open");
  detailPanel.hidden = true;
  selectionPanel.innerHTML = "<p class=\"empty-state\">Select a generated trace.</p>";
  resultPanel.innerHTML = "";
  resizeCanvas();
}

function getChatThread(nodeId) {
  if (!chatThreads.has(nodeId)) chatThreads.set(nodeId, []);
  return chatThreads.get(nodeId);
}

function renderChatPanel(node) {
  const thread = getChatThread(node.id);
  const busy = thread.some((message) => message.pending);
  const messages = thread.length
    ? thread.map((message) => `
      <div class="chat-message ${escapeHtml(message.role)} ${message.pending ? "pending" : ""} ${message.error ? "error" : ""}">
        ${escapeHtml(message.content || (message.pending ? "Thinking..." : ""))}
      </div>
    `).join("")
    : "<p class=\"empty-state\">Ask a focused follow-up about this trace.</p>";

  resultPanel.innerHTML = `
    <div class="chat-log" aria-live="polite">${messages}</div>
    <form class="chat-form">
      <textarea name="message" rows="3" maxlength="${CHAT_INPUT_MAX}" ${busy ? "disabled" : ""} placeholder="Ask about this trace"></textarea>
      <button class="primary-button" type="submit" ${busy ? "disabled" : ""}>Send</button>
    </form>
  `;

  const log = resultPanel.querySelector(".chat-log");
  if (log) log.scrollTop = log.scrollHeight;
}

async function handleChatSubmit(event) {
  const chatForm = event.target.closest(".chat-form");
  if (!chatForm) return;

  event.preventDefault();
  const node = graph.index.get(selectedNodeId);
  if (!node || !canOpenDetail(node)) return;

  const input = chatForm.elements.message;
  const message = String(input.value || "").replace(/\s+/g, " ").trim().slice(0, CHAT_INPUT_MAX);
  if (!message) return;

  const thread = getChatThread(node.id);
  const history = thread
    .filter((item) => !item.pending && !item.error)
    .slice(-CHAT_HISTORY_LIMIT)
    .map((item) => ({ role: item.role, content: item.content }));

  thread.push({ role: "user", content: message });
  const pending = { role: "assistant", content: "", pending: true };
  thread.push(pending);
  renderChatPanel(node);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history,
        trace: buildTraceContext(node),
        project: buildProjectContext()
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Chat request failed.");

    pending.content = data.reply || "No response.";
    pending.pending = false;
  } catch (error) {
    pending.content = error.message || "Chat request failed.";
    pending.pending = false;
    pending.error = true;
  }

  trimChatThread(thread);
  renderChatPanel(node);
}

function trimChatThread(thread) {
  const maxMessages = CHAT_HISTORY_LIMIT + 6;
  if (thread.length > maxMessages) thread.splice(0, thread.length - maxMessages);
}

function buildProjectContext() {
  return {
    title: latestData?.title || "",
    reading: latestData?.reading || "",
    input: latestData?.input || {}
  };
}

function buildTraceContext(node) {
  const payload = node.payload || {};
  const trace = {
    id: node.id,
    type: node.type,
    label: node.label,
    title: payload.title || node.label,
    years: payload.years || null,
    orientation: payload.orientation || "",
    summary: payload.summary || "",
    rationale: payload.rationale || "",
    concern: payload.concern || "",
    signals: payload.signals || [],
    risks: payload.risks || [],
    openQuestions: payload.openQuestions || []
  };

  if (node.type === "scenario") {
    trace.relatedFactors = (payload.factorIds || [])
      .map((id) => graph.index.get(id)?.payload)
      .filter(Boolean)
      .map((factor) => ({ label: factor.label, rationale: factor.rationale, uncertainty: factor.uncertainty }));
    trace.relatedPerspectives = (payload.perspectiveIds || [])
      .map((id) => graph.index.get(id)?.payload)
      .filter(Boolean)
      .map((perspective) => ({ label: perspective.label, concern: perspective.concern }));
  }

  return trace;
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

function initCursor() {
  if (!cursor || window.matchMedia("(pointer: coarse)").matches) return;

  const interactiveSelector = "a, button, textarea, input, select, [role='button']";
  document.addEventListener("mousemove", (event) => {
    cursor.classList.add("is-visible");
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
  });
  document.addEventListener("mouseover", (event) => {
    if (event.target.closest(interactiveSelector)) cursor.classList.add("big");
  });
  document.addEventListener("mouseout", (event) => {
    const next = event.relatedTarget;
    if (!next || !next.closest || !next.closest(interactiveSelector)) cursor.classList.remove("big");
  });
}

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
