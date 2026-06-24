const form = document.querySelector("#futuring-form");
const statusEl = document.querySelector("#status");
const resultPanel = document.querySelector("#result-panel");
const selectionPanel = document.querySelector("#selection-panel");
const canvas = document.querySelector("#graph-canvas");
const ctx = canvas.getContext("2d");

let graph = { nodes: [], edges: [], index: new Map(), startedAt: performance.now() };
let latestData = null;
let selectedNodeId = null;
let preferredScenarioId = null;
let frameId = null;

const palette = {
  root: "#f2fff8",
  factor: "#d8d19b",
  perspective: "#b8fff2",
  scenario: "#eef5ef",
  mission: "#f0ffb0"
};

resizeCanvas();
window.addEventListener("resize", resizeCanvas);
canvas.addEventListener("click", selectNode);
form.addEventListener("submit", submitForm);
resultPanel.addEventListener("click", handleResultClick);
animate();

async function submitForm(event) {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  setStatus("LLM extrapolation running...");
  resultPanel.innerHTML = "<p class=\"empty-state\">Waiting for structured LLM response.</p>";
  selectionPanel.innerHTML = "<p class=\"empty-state\">Graph will unfold after the LLM response arrives.</p>";
  graph = { nodes: [], edges: [], index: new Map(), startedAt: performance.now() };
  latestData = null;
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

    const data = await consumeStream(response, startedAt);
    if (!data) throw new Error("No futures were returned.");

    latestData = data;
    graph = buildGraph(data);
    selectedNodeId = graph.nodes[0]?.id || null;
    renderResult(data);
    renderSelection();
    setStatus(`Generated with ${data.provider} / ${data.model}.`);
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
  let result = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const block of events) {
      const event = parseEvent(block);
      if (!event) continue;

      if (event.name === "progress") {
        const seconds = ((performance.now() - startedAt) / 1000).toFixed(0);
        setStatus(`Extrapolating... ${event.data.chars || 0} characters received (${seconds}s)`);
      } else if (event.name === "done") {
        result = event.data;
      } else if (event.name === "error") {
        throw new Error(event.data.error || "LLM request failed.");
      }
    }
  }

  return result;
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

function buildGraph(data) {
  const start = performance.now();
  const nodes = [];
  const edges = [];

  const rootId = "root";
  nodes.push({
    id: rootId,
    type: "root",
    label: data.title,
    payload: data,
    nx: 0.12,
    ny: 0.5,
    r: 7,
    appearAt: 0
  });

  const factors = data.influenceFactors || [];
  factors.forEach((factor, index) => {
    const angle = -1.35 + (index / Math.max(1, factors.length - 1)) * 2.7;
    const id = factor.id || `factor_${index}`;
    nodes.push({
      id,
      type: "factor",
      label: factor.label,
      payload: factor,
      nx: 0.28,
      ny: 0.5 + Math.sin(angle) * 0.32,
      ox: Math.cos(angle) * 54,
      r: 5,
      appearAt: 450 + index * 110
    });
    edges.push({ from: rootId, to: id, appearAt: 520 + index * 110 });
  });

  const perspectives = data.perspectives || [];
  perspectives.forEach((perspective, index) => {
    const id = perspective.id || `perspective_${index}`;
    nodes.push({
      id,
      type: "perspective",
      label: perspective.label,
      payload: perspective,
      nx: 0.22,
      ny: 0.14 + index * 0.14,
      r: 4,
      appearAt: 760 + index * 120
    });
    edges.push({ from: rootId, to: id, appearAt: 860 + index * 120 });
  });

  const horizonX = { 2: 0.48, 5: 0.68, 10: 0.88 };
  const allScenarios = [];
  (data.horizons || []).forEach((horizon) => {
    const scenarios = horizon.scenarios || [];
    scenarios.forEach((scenario, index) => {
      const id = scenario.id || `scenario_${horizon.years}_${index}`;
      nodes.push({
        id,
        type: "scenario",
        label: `${horizon.years}y / ${scenario.title}`,
        payload: { ...scenario, years: horizon.years },
        nx: horizonX[horizon.years] || 0.7,
        ny: 0.5 + (index - (scenarios.length - 1) / 2) * 0.17,
        r: 6,
        appearAt: 1300 + horizon.years * 160 + index * 150
      });
      allScenarios.push({ id, scenario });

      const linkedFactors = scenario.factorIds?.length ? scenario.factorIds : factors.slice(0, 2).map((factor) => factor.id);
      linkedFactors.forEach((factorId, factorIndex) => {
        edges.push({
          from: factorId,
          to: id,
          appearAt: 1450 + horizon.years * 160 + index * 150 + factorIndex * 50
        });
      });

      (scenario.perspectiveIds || []).slice(0, 2).forEach((perspectiveId, perspectiveIndex) => {
        edges.push({
          from: perspectiveId,
          to: id,
          appearAt: 1520 + horizon.years * 160 + index * 150 + perspectiveIndex * 70
        });
      });
    });
  });

  const mission = data.mission || [];
  mission.forEach((step, index) => {
    const id = `mission_${index}`;
    nodes.push({
      id,
      type: "mission",
      label: step.action,
      payload: step,
      nx: 0.42 + index * 0.07,
      ny: 0.86,
      r: 4,
      appearAt: 3600 + index * 140
    });
    const from = step.fromScenarioId || allScenarios[index % Math.max(1, allScenarios.length)]?.id || rootId;
    edges.push({ from, to: id, appearAt: 3700 + index * 140 });
  });

  const index = new Map(nodes.map((node) => [node.id, node]));
  const built = { nodes, edges, index, startedAt: start };
  computeLayout(built);
  return built;
}

function computeLayout(target) {
  const width = canvas.clientWidth || 900;
  const height = canvas.clientHeight || 700;
  for (const node of target.nodes) {
    node.x = node.nx * width + (node.ox || 0);
    node.y = node.ny * height + (node.oy || 0);
  }
}

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

  ctx.clearRect(0, 0, width, height);
  drawField(width, height, now);

  for (const edge of graph.edges) {
    const age = elapsed - edge.appearAt;
    if (age <= 0) continue;
    const from = graph.index.get(edge.from);
    const to = graph.index.get(edge.to);
    if (!from || !to) continue;
    drawEdge(from, to, Math.min(1, age / 900), now);
  }

  for (const node of graph.nodes) {
    const age = elapsed - node.appearAt;
    if (age <= 0) continue;
    drawNode(node, Math.min(1, age / 520));
  }
}

function drawField(width, height, now) {
  ctx.save();
  ctx.globalAlpha = 0.4;
  for (let i = 0; i < 120; i += 1) {
    const x = ((i * 73 + now * 0.006) % width);
    const y = ((i * 131 + Math.sin(now * 0.0007 + i) * 28) % height);
    ctx.fillStyle = i % 7 === 0 ? "rgba(240,255,176,0.42)" : "rgba(230,244,236,0.26)";
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.restore();
}

function drawEdge(from, to, progress, now) {
  const endX = from.x + (to.x - from.x) * progress;
  const endY = from.y + (to.y - from.y) * progress;
  const dashOffset = (now * 0.04) % 16;

  ctx.save();
  ctx.setLineDash([2, 8]);
  ctx.lineDashOffset = -dashOffset;
  ctx.strokeStyle = "rgba(224, 244, 236, 0.32)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.restore();
}

function drawNode(node, progress) {
  const color = palette[node.type] || palette.scenario;
  const radius = node.r * progress;
  const selected = node.id === selectedNodeId;

  ctx.save();
  ctx.globalAlpha = progress;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = selected ? 18 : 9;
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.fill();

  if (selected || node.type === "root") {
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color;
    ctx.strokeRect(node.x + 12, node.y - 13, Math.min(210, 28 + String(node.label || "").length * 6), 23);
    ctx.fillStyle = "rgba(238, 245, 239, 0.88)";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(truncate(node.label || node.id, 28), node.x + 20, node.y + 3);
  }
  ctx.restore();
}

function selectNode(event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let nearest = null;
  let nearestDistance = 18;

  for (const node of graph.nodes) {
    const dist = Math.hypot(node.x - x, node.y - y);
    if (dist < nearestDistance) {
      nearest = node;
      nearestDistance = dist;
    }
  }

  if (nearest) {
    selectedNodeId = nearest.id;
    renderSelection();
  }
}

function handleResultClick(event) {
  const scenarioButton = event.target.closest("[data-scenario-id]");
  if (!scenarioButton) return;

  preferredScenarioId = scenarioButton.dataset.scenarioId;
  selectedNodeId = preferredScenarioId;
  renderResult(latestData);
  renderSelection();
}

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
    <div class="result-block">
      <h2>Mission trace</h2>
      <ul>
        ${(data.mission || []).map((step) => `
          <li><strong>${escapeHtml(step.horizon || "")}</strong>: ${escapeHtml(step.action || "")}</li>
        `).join("")}
      </ul>
    </div>
  `;
}

function renderSelection() {
  const node = graph.nodes.find((item) => item.id === selectedNodeId);
  if (!node) {
    selectionPanel.innerHTML = "<p class=\"empty-state\">Select a generated node to inspect its trace.</p>";
    return;
  }

  if (node.type === "root") {
    selectionPanel.innerHTML = `
      <div class="selection-header">
        <span>${escapeHtml(node.type)}</span>
        <h2>${escapeHtml(node.label || "")}</h2>
      </div>
      <p>${escapeHtml(node.payload?.reading || "")}</p>
    `;
    return;
  }

  if (node.type === "factor") {
    selectionPanel.innerHTML = `
      <div class="selection-header">
        <span>${escapeHtml(node.payload?.category || "factor")}</span>
        <h2>${escapeHtml(node.label || "")}</h2>
      </div>
      <p>${escapeHtml(node.payload?.rationale || "")}</p>
      <p class="metadata-line">uncertainty: ${escapeHtml(node.payload?.uncertainty || "unspecified")}</p>
    `;
    return;
  }

  if (node.type === "perspective") {
    selectionPanel.innerHTML = `
      <div class="selection-header">
        <span>perspective</span>
        <h2>${escapeHtml(node.label || "")}</h2>
      </div>
      <p>${escapeHtml(node.payload?.concern || "")}</p>
    `;
    return;
  }

  if (node.type === "scenario") {
    const payload = node.payload || {};
    selectionPanel.innerHTML = `
      <div class="selection-header">
        <span>${escapeHtml(payload.years || "")}y scenario</span>
        <h2>${escapeHtml(payload.title || node.label || "")}</h2>
      </div>
      <p>${escapeHtml(payload.summary || "")}</p>
      ${renderMiniList("Signals", payload.signals)}
      ${renderMiniList("Risks", payload.risks)}
      ${renderMiniList("Open questions", payload.openQuestions)}
    `;
    return;
  }

  selectionPanel.innerHTML = `
    <div class="selection-header">
      <span>${escapeHtml(node.payload?.horizon || "mission")}</span>
      <h2>${escapeHtml(node.label || "")}</h2>
    </div>
    <p>${escapeHtml(node.payload?.reason || "")}</p>
  `;
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
