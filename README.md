# FuturingCST

A strategy support tool for reflective multi-horizon futuring

This branch (`main`) holds the workshop version of FuturingCST for CIOs and CTOs in manufacturing, banking, and IT. Participants explore scenarios of AI adoption, AI risk, and AI use in their sector across 2-, 5-, and 10-year horizons. The scenarios combine sector data from SEC filings, conditioned forecasts from Mistral's time-series model Timestral, a language model, and the participants' own assumptions.

The original creativity support tool version (prototype purpose and context as input) is preserved on the branch `cst`.

<img width="1429" height="834" alt="Bildschirmfoto 2026-06-28 um 22 32 37" src="https://github.com/user-attachments/assets/23e105cf-da7c-4b73-90a4-2ed6e3dae503" />

<img width="1443" height="826" alt="Bildschirmfoto 2026-06-28 um 22 33 13" src="https://github.com/user-attachments/assets/b1c61776-5c50-4e33-8b2f-6660b78c2dac" />

It also comes in light mode.
<img width="1462" height="835" alt="Bildschirmfoto 2026-07-07 um 02 04 31" src="https://github.com/user-attachments/assets/c05b1f5e-e601-4c7c-977a-290f8ca969e8" />

## Core Position

FuturingCST does not forecast a single future. It keeps multiple plausible futures visible and treats model output as material for reflection, discussion, and assessment.

- Two divergent scenarios per horizon, always.
- Driving forces and perspectives stay visible in the graph.
- Forecast bands describe a measured variable at a point in time, never the probability of a scenario.
- The data measure what firms report, not verified adoption or incidents.

## Live Deployment

| Part | Host | URL |
|---|---|---|
| Frontend + API | Render (Node web service, auto-deploy from `main`) | https://futuringcst.onrender.com |
| Frontend (alternative entry) | Vercel, rewrites `/api/*` to Render | https://futuring-cst.vercel.app |

`vercel.json` rewrites `/api/:path*` to `https://futuringcst.onrender.com/api/:path*`. The earlier Railway backend (`futuringcst-production.up.railway.app`) is no longer referenced.

Render settings: build `npm install`, start `node server.js`, environment variables as listed below.

## User Flow

1. Choose a sector: Manufacturing, Banking, or IT.
2. Choose a Purpose question from the list, or select Other and write one.
3. Optional: Your assumptions, Stakeholders / perspectives, Signals / material.
4. Begin extrapolation. The graph grows from the focal issue over driving forces and perspectives to two scenarios at each horizon and their implications.
5. Click a scenario node to open it (40 % of the page width, closable with ×). Read the narrative, open the Timestral indicators, rate plausibility and desirability from 1 to 5, and ask follow-up questions in the chat.

An "About & how to use" dialog at the bottom of the left panel explains the method to participants.

### Purpose questions

- How will LLM adoption in this sector develop over the next 2, 5, and 10 years?
- How will dependence on AI vendors in this sector develop?
- Which futures are possible if almost all firms report AI risks, but only some deploy LLMs?
- Other (free text)

### Terminology

| Term | Meaning in the app | Graph node |
|---|---|---|
| Focal issue | Sector plus the Purpose question | root |
| Driving forces | Forces shaping the focal issue; the first two are the sector's critical uncertainties | factor |
| Uncertainties | The two quantified drivers the scenarios diverge on | factor (high) |
| Perspectives | One per named stakeholder (max. 4), otherwise 3 | perspective |
| Indicators | Driver values and Timestral values per scenario, checked against the band | in scenario panel |
| Implications | What the scenarios mean for CIOs and CTOs | bottom row |

## Data

All data live in `data/`.

### `data/ai-disclosure-panel/`

Copied from the scenarioGPT repository.

- 30 large US-listed panel firms per sector (`panel_90.csv`): ISIC section C = manufacturing, K = software, IT and telecommunications ("IT"), L = finance and insurance ("Banking").
- SEC 10-K and 10-Q filings, 2023 Q1 to 2026 Q2 (`filings-2023q1-2026q2/`), plus base 10-Ks from 2022 (`base-10k-2022/`).
- Every AI passage classified with taxonomy v0.9 by gemini-2.5-flash (`classification/results/labels_final.jsonl`, codebook in `codebook.md`): frame, roles, risk types, MIT AI risk subdomains, adoption stage, business functions, AI kinds, governance responses, substantiveness.
- `series_CKL.csv` / `series_CKL_records.json`: 9 quarterly measures × 3 sectors × 14 quarters (AI mention, adoption, LLM adoption, vendor, risk, cyber risk, regulatory risk, specific disclosure, passages per filing).
- `backtest_CKL_*.json`: 3-quarter backtests of the four Timestral checkpoints against last-value and linear-trend baselines.

### `data/sector_series_v2/`

111 additional Timestral-ready quarterly series derived from the classified passages (business functions, risk types, MIT subdomains, AI kinds, governance, roles, adoption stage, substantiveness, explicit AI passages per firm). Same quarter logic as scenarioGPT's `build_series.py` (filing assigned to the calendar quarter nearest its period end; a 10-Q combined with the firm's latest 10-K). Selection rule: peak ≥ 0.15, movement or sector difference ≥ 0.15, not saturated (last-year mean ≤ 0.95).

### `data/sector_profiles.json`

Per sector: number of panel firms naming each business function, risk type, MIT subdomain, AI kind, governance response, and adoption stage, early (filings 2023-01 to 2024-06) versus late (2025-07 to 2026-06), with example passages. Sent to the language model as `sectorEvidence`.

### `data/timestral_scenarios.json`

The precomputed, conditioned Timestral runs that carry the scenarios (see below).

### `data/timestral_forecasts.json`

Earlier unconditioned per-series forecasts (Timestral-28M, no covariates). Kept for reference; the server no longer uses it.

### Limitations

- n = 30 firms per sector; one firm moves a share by about 3 percentage points.
- 14 quarterly observations; beyond two years the forecast bands become very wide.
- Disclosure measures reporting; growth partly reflects boilerplate diffusion.
- Sector composition is mixed (manufacturing includes semiconductors, pharma, consumer staples; IT includes telecoms and platforms; banking includes payments and health insurers).
- Single LLM coder for the classification, no inter-coder reliability.

## Scenario Mechanism

The mechanism follows scenarioGPT's `generation.py`: one Timestral run per driver-outcome combination, with the outcomes entering as known-future covariates.

### Critical uncertainties per sector

| Sector | Driver 1 | Driver 2 | Backtest (3 held-out quarters) |
|---|---|---|---|
| Manufacturing | Own AI use in operations (0 → 43 %) | AI system security risk (7 → 73 %) | 16 / 24 inside 10-90 % band |
| Banking | Generative AI / LLM uptake (3 → 73 %) | AI fraud and impersonation risk (3 → 70 %) | 11 / 24 |
| IT | Agentic AI (0 → 67 %) | AI market-demand risk (10 → 53 %) | 15 / 24 |

Each driver has two outcomes: **accelerating** (the observed linear slope per quarter continues, clipped to [0, 1]) and **stalling** (stays at the 2026 Q2 value).

- Scenario 1 = driver 1 accelerating, driver 2 stalling.
- Scenario 2 = driver 1 stalling, driver 2 accelerating.
- The same scenario index keeps its configuration across 2, 5, and 10 years, so the flow edges in the graph trace one path.

### Timestral runs

- Model: `mistralai/Timestral-28M` (best band coverage in the scenarioGPT backtest: 20 / 36).
- Per sector and scenario: one joint forecast of 8 sector series to 2036 Q4 (42 quarters).
- Known covariates: a time index plus both driver paths (14 observed values followed by the outcome path).
- Read at the last forecast date of 2028, 2031, and 2036: median and 10-90 % band.
- Backtest per sector: last 3 quarters held out, observed driver values as the known future.
- 6 scenario runs + 3 backtests, generated with `scripts/scenario_runs.py` (scenarioGPT environment, `scenariogpt.forecasting.run_forecast`).

What Timestral contributes: with 14 quarterly points it mostly continues the observed level, and the differences between scenarios come from the driver paths. Shock flags without history (e.g. a 0/1 "regulation" step) gave erratic, model-size-dependent output and are not used.

### Language model

The language model writes each scenario from its own forecast, the sector evidence, and the participant's input:

- 150-220 word narrative in 2-3 paragraphs, 1 signal, 1 risk, 1 open question.
- `values`: 3-4 series values the scenario relies on. The server checks each against that scenario's 10-90 % band; a value outside the band needs `outside_band_reason` and is flagged.
- Indicators shown to participants are built by the server: driver outcome and value per horizon, then the checked values with Timestral median and band.
- Titles: concrete sector state, no driver outcome words (accelerating, stalling, surge, etc.), no shared words between the two titles of a horizon.

## LLM Configuration

- Provider: OpenRouter (`https://openrouter.ai/api/v1/chat/completions`, OpenAI-compatible).
- Model: set by `LLM_MODEL` (takes precedence) or `OPENROUTER_MODEL`; code default `google/gemini-3.5-flash`. Production on Render runs `anthropic/claude-haiku-5.5`.
- `response_format: json_object`, temperature 0.7 (chat 0.45).
- `max_tokens` = `LLM_MAX_TOKENS` (default 2200; chat `CHAT_MAX_TOKENS`, default 360) + `LLM_REASONING_TOKENS` (default 4000) headroom, because reasoning models spend output tokens on thinking.
- `reasoning: { effort: LLM_REASONING_EFFORT (default "low"), exclude: true }`.
- Up to 3 attempts per call on non-JSON output, 429, 5xx, and dropped streams.

### Calls per run (`POST /api/extrapolate`)

1. `buildFramePrompt()`: focal issue, 4 driving forces (first two = critical uncertainties), perspectives.
2. `buildHorizonPrompt(years)` × 3, in parallel: 2 scenarios per horizon from `scenarioForecasts`.
3. `buildMissionPrompt()`: 4 implications for CIOs and CTOs.
4. `buildTraceChatPrompt()`: follow-up chat on a selected trace (`POST /api/chat`).

A full run takes about 25-30 seconds.

## Logging (MongoDB)

Every input, output, rating, and chat is written to MongoDB. Logging is a no-op when the variables are missing, and a failed write never fails a request.

| `type` | Content |
|---|---|
| `extrapolation` | `runId`, `sessionId`, input (sector, purpose, assumptions, stakeholders, signals, critical uncertainties), full output, model, Timestral model, duration |
| `extrapolation_error` | `runId`, `sessionId`, input, error message |
| `chat` | `runId`, `sessionId`, selected trace, message, reply |
| `rating` | `runId`, `sessionId`, scenario id, title, horizon, criterion (`plausibility` / `desirability`), value 1-5 |

`sessionId` is generated per page load in the browser; `runId` per extrapolation on the server. `GET /api/health` reports `logging.configured`, `lastWriteAt`, and `lastError`.

The connection string is built as `mongodb+srv://<MONGODB_MAS_NAME>:<MONGODB_MAS_KEY>@<MONGODB_HOST>/` (or `mongodb://` when the host has a port).

## Environment Variables

```env
# required
OPENROUTER_API_KEY=
LLM_MODEL=anthropic/claude-haiku-5.5

# MongoDB logging
MONGODB_MAS_NAME=
MONGODB_MAS_KEY=
MONGODB_HOST=
MONGODB_DATABASE=
MONGODB_COLLECTION=

# optional
PORT=5173
HOST=0.0.0.0
APP_URL=http://localhost:5173
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MAX_TOKENS=2200
CHAT_MAX_TOKENS=360
LLM_REASONING_TOKENS=4000
LLM_REASONING_EFFORT=low
LLM_TIMEOUT_MS=120000
MAX_BODY_BYTES=65536
NODE_ENV=production
```

There are no rate limits in the workshop version. `.env` stays local and is never committed.

## Tech Stack

- Node.js ≥ 18 HTTP server (`server.js`), one runtime dependency: `mongodb` (v6).
- Static frontend in plain HTML, CSS, and JavaScript (`public/`), canvas graph rendering.
- Server-Sent Events for streaming generation progress.
- Typography: Space Mono for the interface; Times New Roman for everything participants write, scenario narratives, and the About text.

## Repository Structure

```text
.
├── server.js              # HTTP server, API routes, prompts, scenario forecasts, band checks, MongoDB logging
├── package.json           # scripts, Node engine, mongodb dependency
├── vercel.json            # Vercel rewrite of /api/* to Render
├── scripts/scenario_runs.py  # precomputes the conditioned Timestral runs
├── public/
│   ├── index.html         # app shell, sector tabs, input form, About dialog
│   ├── app.js             # SSE handling, graph, scenario panel, ratings, chat
│   └── styles.css         # dark/light themes, layout, typography
└── data/
    ├── ai-disclosure-panel/      # original filings, classification, series, panel, backtests
    ├── sector_series_v2/         # 111 derived quarterly series
    ├── sector_profiles.json      # per-sector evidence profiles
    ├── timestral_scenarios.json  # conditioned Timestral runs (used)
    └── timestral_forecasts.json  # unconditioned forecasts (reference)
```

## API

- `GET /api/health`: provider, model, logging status.
- `POST /api/extrapolate`: body `{ sector, purpose, assumptions?, stakeholders?, signals?, sessionId }`; streams `stage`, `progress`, `frame`, `horizon`, `mission`, `done` (with `runId`), `error`.
- `POST /api/chat`: body `{ message, history, trace, project, runId, sessionId }`.
- `POST /api/rating`: body `{ runId, sessionId, scenarioId, scenarioTitle, years, criterion, value }`.

## Running Locally

```bash
npm install
npm run dev
```

Open http://localhost:5173. The server serves both the frontend and the API.

## Regenerating the Timestral Runs

The runs are precomputed in the scenarioGPT Python environment (Timestral package and cached checkpoints):

```bash
SCENARIOGPT_OFFLINE=1 SCENARIOGPT_MODEL_CACHE=<scenarioGPT>/.local/models \
  <scenarioGPT>/.venv/bin/python -I scripts/scenario_runs.py \
  data/ai-disclosure-panel/series_CKL_records.json \
  data/sector_series_v2/series_records.json \
  data/timestral_scenarios.json
```

Drivers, outcomes, and target series per sector are defined at the top of `scripts/scenario_runs.py`.

## Troubleshooting

- "LLM did not return the required JSON structure": usually a truncated answer; raise `LLM_REASONING_TOKENS` or `LLM_MAX_TOKENS`, or use a non-reasoning model.
- "LLM request failed": check API key, model name, and OpenRouter credit.
- Render free instances sleep after 15 minutes; the first request then takes about a minute.

MIT license
