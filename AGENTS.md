# FuturingCST — Prototyping Briefing

> Briefing file for any coding agent (Claude Code, Cursor, Copilot, Aider, Codex, etc.).
> Read this in full before working on any code, design, or writing task in this repo.
> Treat the rules in "Hard constraints" and "Working agreement" as binding.

## What we are building

**FuturingCST** (working name in the paper: `NAME`) is a *futuring tool*: a Creativity Support Tool that takes a prototype's **purpose and context** as input and surfaces **multiple possible long-term futures** across **2-, 5-, and 10-year horizons**, together with the **influence factors** and **perspectives** that shape them.

It is realized as an **interactive playground**. The user provides their input; the **extrapolation then begins** and unfolds as **animated nodes and edges** that can be **followed visually** as they connect. The interaction model resembles a **node-graph / TouchDesigner-style interface**, where nodes and edges are wired to actions and the graph grows as futures branch out.

It is grounded in **futures studies**. It guides the user through three movements:

1. **Explore scenarios** — surface multiple plausible futures (not a single forecast).
2. **Envision a preferred future** — let the user select/define the future they want.
3. **Outline a mission** — work backward from the preferred future toward what realizing it requires.

## Who it is for

- Creative practitioners
- Tool designers
- Researchers (incl. CST researchers)

## Purpose

The tool is a **vehicle for the creators' reflective process**. It serves three functions, in priority order:

1. **Reflection** — help the user reflect on the futures their prototype is built toward.
2. **Alignment** — support alignment between collaborators about those futures.
3. **Articulation** — make the futures a prototype is built toward explicit and communicable.

## The abstract (source of truth for framing)

> Novel artifacts paint pathways toward one of many possible futures: the future in which their use has become feasible. Yet frameworks surrounding Creativity Support Tools (CSTs) rarely make this underlying future explicit. This gap hinders communication and complicates deployment. To address it, we examine the role of futuring in CSTs. We propose NAME, a futuring tool that takes a prototype's purpose and context as input and surfaces multiple possible long-term futures across 2-, 5-, and 10-year horizons, together with the influence factors and perspectives that shape them. Drawing on futures studies, the tool guides creative practitioners, tool designers, and researchers to explore scenarios, envision a preferred future, and outline a mission for realizing that vision. We contribute our artifact NAME as a vehicle for the creators' reflective process, that equally supports alignment between collaborators and envisions the futures a prototype is built toward.

## Hard constraints — DO NOT VIOLATE

- **It is NOT an oracle / NOT a forecaster.** Multiple scenarios always exist; data-driven and multiple-futures are NOT in tension. The tool surfaces several plausible futures — it never predicts the one future.
- **Reflection over prediction.** The output exists to make the user think about direction, not to tell them what will happen.
- **Multiple futures, multiple perspectives — always.** A single-future output is wrong by definition.
- **Data-informed divergence.** Influence factors and scenarios may be data-driven; the point is to spread the possibility space, not converge on it.

## Aesthetic & interaction direction

Grounded in three visual references provided by the author (dark, generative, cartographic). The look and feel:

- **Dark canvas, luminous graph.** Black/near-black background; nodes and edges rendered as light (fine points, dotted trails, thin connective lines) — a constellation / particle-field quality.
- **Nodes and edges as the primary visual language.** Futures, influence factors, and perspectives appear as nodes; relationships and extrapolation paths appear as edges. Edges can be **dotted/animated trails** that the eye can trace from node to node.
- **Animation on input.** Nothing pre-computed on screen: the user's input triggers extrapolation, and the graph **grows/branches in motion** outward across the 2/5/10-year horizons.
- **Node-graph / TouchDesigner idiom.** Nodes are wired to actions; edges carry flow. The interface reads as a live, operable patch — not a static diagram. Coordinate/label readouts surfacing near nodes (as in reference 3) are acceptable as part of the "operable" feel.
- **Followable.** The core experience is *visual tracing*: a person should be able to follow a path through the unfolding futures with their eyes.

Reference images (author-provided): (1) a particle/cloud field with cross-markers and annotation panels; (2) a scratched constellation/grid of dotted paths and ringed nodes; (3) a black canvas of boxed shapes connected by dashed directional edges with x/y coordinate labels.

## Submission target

- **NeurIPS 2026 Creative AI Track** — theme: *Agency*.
- Format: research paper, **2–6 pages without references**, NeurIPS template.
- This year the track is **non-archival**; accepted work shown as posters in a separate session. Showable / demonstrable artifacts are favored.

## Working agreement (applies to any agent)

- **The author generates the ideas, proposals, and direction.** The agent's role is **refinement and technical implementation only.**
- **Do NOT brainstorm or propose new concepts unless explicitly asked.**
- **Do NOT write code until the author explicitly approves the concept/approach for that step.**
- **Do NOT summarize the author's own prior work back to them.**
- Avoid the "not X, but Y" sentence construction.
- When refining text, change what is needed and stop; keep rationale brief and only if asked.

## Repo

- Repo name: `FuturingCST`
