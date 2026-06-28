# FuturingCST

A creativity support tool for reflective multi-horizon futuring

FuturingCST is an interactive prototype for exploring multiple plausible futures around a creative tool, prototype, or research artifact. The user describes the prototype's purpose and context, then the app generates a live graph of influence factors, stakeholder perspectives, 2-, 5-, and 10-year futures, and a backcast mission trace.

The project is framed as a creativity support tool: its purpose is to support reflection, alignment, and articulation around futures a prototype might help make possible.

## Core Position

FuturingCST is not an oracle and does not forecast a single future. It keeps multiple plausible futures visible and treats LLM output as reflective material for thought, critique, and discussion.

The app is built around four constraints:

- Multiple futures are always surfaced.
- Influence factors and perspectives remain visible.
- Futures are generated across 2-, 5-, and 10-year horizons.
- Outputs are for reflection and alignment, not prediction or factual certainty.

## Current Experience

The interface has three main areas:

- A left control panel where the user enters the prototype frame.
- A dark canvas where futures unfold as animated nodes and edges.
- A right detail panel that opens after generation when a factor, perspective, or scenario is selected.

The graph grows incrementally:

1. The app reads the submitted purpose and context.
2. It surfaces influence factors and perspectives.
3. It generates two divergent scenarios for each horizon: 2 years, 5 years, and 10 years.
4. It draws connections between factors, perspectives, scenarios, and mission steps.
5. The user can select a generated trace and ask critical follow-up questions about what it assumes, risks, or leaves out.

## Inputs

The current form asks for:

- `Purpose`: what the prototype is meant to make possible.
- `Context`: where, with whom, and under which constraints it would be used.
- `Stakeholders / perspectives`: people, institutions, practices, or worldviews that matter.
- `Signals / material`: known trends, references, tensions, or data points to consider.

`Purpose` and `Context` are required by the backend. The other fields are optional but improve the generated frame.

## Outputs

The backend asks the LLM for structured JSON and normalizes the result before sending it to the frontend.

The generated output includes:

- A short project label and futuring frame.
- Influence factors with category, rationale, and uncertainty.
- Perspectives with concerns.
- Scenario branches for 2-, 5-, and 10-year horizons.
- Scenario metadata: orientation, summary, signals, risks, and open questions.
- A mission trace generated through backcasting from the surfaced futures.

The frontend renders those outputs as a luminous graph on a dark canvas. Nodes represent the prototype, influence factors, perspectives, scenarios, and mission steps. Edges show relationships and horizon-to-horizon flow.

## Tech Stack

- Node.js HTTP server using built-in Node modules.
- Static frontend in plain HTML, CSS, and JavaScript.
- Canvas-based graph rendering.
- Server-Sent Events for streaming generation progress.
- OpenRouter-compatible chat completions API for LLM calls.

There are currently no declared npm runtime dependencies.

## Repository Structure

```text
.
├── package.json        # npm scripts and Node engine
├── server.js           # HTTP server, API routes, LLM prompts, static file serving
├── vercel.json         # Vercel API rewrite configuration
├── public/
│   ├── index.html      # app shell and input form
│   ├── app.js          # graph rendering, SSE handling, interaction, trace chat
│   └── styles.css      # dark visual system and responsive layout
└── README.md
```

## Requirements

- Node.js 18 or newer.
- An OpenRouter API key or compatible provider reachable through the configured base URL.

The server uses the global `fetch` API available in Node 18+.

## Environment Variables

Create a local `.env` file in the project root:

```env
OPENROUTER_API_KEY=your_api_key_here
```

Optional variables:

```env
PORT=5173
HOST=0.0.0.0
APP_URL=http://localhost:5173

OPENROUTER_MODEL=deepseek/deepseek-chat
LLM_MODEL=deepseek/deepseek-chat
LLM_BASE_URL=https://openrouter.ai/api/v1

LLM_MAX_TOKENS=2200
CHAT_MAX_TOKENS=360
LLM_TIMEOUT_MS=120000
MAX_BODY_BYTES=65536
```

Notes:

- `OPENROUTER_API_KEY` is required by the current server implementation.
- `LLM_MODEL` takes precedence over `OPENROUTER_MODEL`.
- `LLM_BASE_URL` can point to another OpenAI-compatible `/chat/completions` endpoint.
- `.env` should stay local and should not be committed.

## Running Locally

Start the app:

```bash
npm run dev
```

Or run the server directly:

```bash
node server.js
```

Then open:

```text
http://localhost:5173
```

The server serves both the frontend and the API.

## Available Scripts

```bash
npm run dev
```

Starts the local server with `node server.js`.

```bash
npm start
```

Also starts the local server.

```bash
npm run check
```

Runs Node's syntax checker against `server.js`.

## API Overview

### `GET /api/health`

Returns basic server and LLM configuration status.

Example response:

```json
{
  "ok": true,
  "provider": "openrouter",
  "configured": true,
  "model": "deepseek/deepseek-chat"
}
```

### `POST /api/extrapolate`

Starts a futuring run and streams progress as Server-Sent Events.

Request body:

```json
{
  "purpose": "What the prototype is meant to make possible.",
  "context": "Where and how it would be used.",
  "stakeholders": "People, institutions, or practices that matter.",
  "signals": "Known trends, tensions, references, or data points."
}
```

Streamed event types:

- `stage`: announces the current generation stage.
- `progress`: reports streamed LLM character progress.
- `frame`: returns the project frame, influence factors, and perspectives.
- `horizon`: returns scenarios for one horizon.
- `mission`: returns backcast mission steps.
- `done`: returns the complete normalized result.
- `error`: returns a generation error.

### `POST /api/chat`

Answers a follow-up question about the currently selected trace.

The chat route is scoped to the selected factor, perspective, or scenario. It is intended for critical reflection on assumptions, risks, blind spots, stakeholder conflicts, and alternative perspectives.

## LLM Flow

The backend calls the model in stages:

1. `buildFramePrompt()` creates the initial frame with influence factors and perspectives.
2. `buildHorizonPrompt(years)` creates divergent futures for each horizon.
3. `buildMissionPrompt()` creates mission steps by backcasting from surfaced scenarios.
4. `buildTraceChatPrompt()` supports follow-up questions on a selected trace.

Shared prompt rules in `server.js` require the model to:

- Return valid JSON.
- Avoid predicting a single future.
- Use the user's submitted purpose and context as the only project-specific source.
- Avoid invented citations, URLs, statistics, or claims of current factual certainty.

## Frontend Flow

`public/app.js` handles:

- Form submission.
- SSE stream parsing.
- Incremental graph construction.
- Canvas animation.
- Node hover and selection.
- Detail panel rendering.
- Follow-up chat for selected traces.

The canvas uses normalized coordinates for nodes, so the graph can resize across desktop and mobile layouts.

## Deployment Notes

The app can run as a single Node service because `server.js` serves both static assets and API routes.

`vercel.json` currently rewrites `/api/:path*` to:

```text
https://futuringcst-production.up.railway.app/api/:path*
```

That means a Vercel-hosted static frontend can call a Railway-hosted API backend. If the backend URL changes, update `vercel.json`.

## Troubleshooting

If the app says OpenRouter is not configured, check that `.env` contains `OPENROUTER_API_KEY`.

If generation fails with an LLM request error, check the API key, model name, provider quota, and `LLM_BASE_URL`.

If the server reports that the LLM did not return JSON, rerun the request or try a model that reliably supports JSON object responses.

If requests time out, increase `LLM_TIMEOUT_MS`.

If the page loads but generation does not start, check the browser console and confirm that `/api/health` returns `configured: true`.

## Project Framing For Contributors

Keep the framing consistent:

- FuturingCST is a creativity support tool.
- It supports reflective multi-horizon futuring.
- It should surface multiple plausible futures, not one forecast.
- It should keep influence factors and perspectives explicit.
- It should help users think, align, and articulate direction.

Avoid changing the project into a prediction tool, scoring tool, recommender, or single-answer decision system.

## Current Status

This repository contains a working prototype with:

- A dark graph-based interface.
- Streaming LLM generation.
- Multi-horizon scenario output.
- Selectable traces.
- Trace-scoped follow-up chat.

No license is currently declared in the repository.
