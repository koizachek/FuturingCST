# US AI disclosure dataset, run `us-panel-2023-2026`

Produced with the `airo` pipeline (`src/airo`, taxonomy v0.9) and `gemini-2.5-flash` on 2026-10-21.

## Files

```
us-panel-2023-2026/
├── chunks.jsonl                  7,227 classified passages (direct mentions), with text
├── context_passages.jsonl        11,452 context passages (implicit mentions), not classified
├── documents_manifest.json       1,265 filings, 1,265 distinct texts
├── docs.tar.gz                   per-document files: document.json, blocks.jsonl, passages.jsonl
├── reports.tar.gz                one report view per document
└── results/
    ├── classified_chunks.jsonl   7,215 labelled passages, every label field
    ├── filing_metrics.jsonl      one row per filing
    ├── us-filing-metrics.json    shares per filing month
    ├── codebook.md               the codebook used (classification_prompt.md is the same file)
    ├── labels_final.jsonl, agreement.json, report_summary.jsonl, recall_check.json
    └── the coder's label and run files
```

## Counts

- Filings: 1,265; distinct texts: 1,265
- Classified passages: 7,227, of which labelled 7,215, without label 12; about AI (`explicit`): 6,935
- Context passages (not classified): 11,452

| Month | Filings | AI mention | AI risk | Adoption | LLM adoption |
|---|---|---|---|---|---|
| 2023-03 | 8 | 88% | 62% | 25% | 0% |
| 2023-04 | 34 | 29% | 21% | 18% | 6% |
| 2023-05 | 47 | 28% | 23% | 9% | 0% |
| 2023-06 | 8 | 100% | 88% | 12% | 12% |
| 2023-07 | 31 | 35% | 26% | 26% | 13% |
| 2023-08 | 51 | 41% | 37% | 18% | 8% |
| 2023-09 | 6 | 83% | 83% | 33% | 17% |
| 2023-10 | 40 | 48% | 35% | 28% | 5% |
| 2023-11 | 44 | 43% | 36% | 20% | 9% |
| 2023-12 | 5 | 80% | 80% | 20% | 20% |
| 2024-01 | 14 | 86% | 86% | 50% | 21% |
| 2024-02 | 68 | 88% | 87% | 63% | 29% |
| 2024-03 | 7 | 86% | 86% | 43% | 29% |
| 2024-04 | 30 | 57% | 43% | 37% | 10% |
| 2024-05 | 53 | 51% | 47% | 28% | 15% |
| 2024-06 | 7 | 100% | 100% | 43% | 14% |
| 2024-07 | 36 | 56% | 44% | 31% | 6% |
| 2024-08 | 45 | 56% | 51% | 27% | 16% |
| 2024-09 | 7 | 86% | 86% | 57% | 14% |
| 2024-10 | 49 | 59% | 53% | 29% | 14% |
| 2024-11 | 35 | 54% | 51% | 34% | 23% |
| 2024-12 | 5 | 80% | 80% | 60% | 0% |
| 2025-01 | 14 | 100% | 93% | 64% | 36% |
| 2025-02 | 68 | 93% | 91% | 74% | 35% |
| 2025-03 | 9 | 89% | 89% | 78% | 33% |
| 2025-04 | 35 | 63% | 46% | 23% | 6% |
| 2025-05 | 50 | 60% | 54% | 44% | 22% |
| 2025-06 | 5 | 100% | 100% | 80% | 60% |
| 2025-07 | 39 | 69% | 54% | 38% | 15% |
| 2025-08 | 42 | 50% | 45% | 31% | 21% |
| 2025-09 | 8 | 88% | 88% | 75% | 38% |
| 2025-10 | 50 | 66% | 52% | 34% | 6% |
| 2025-11 | 34 | 59% | 53% | 47% | 24% |
| 2025-12 | 6 | 83% | 83% | 67% | 33% |
| 2026-01 | 13 | 85% | 85% | 38% | 31% |
| 2026-02 | 67 | 100% | 96% | 91% | 40% |
| 2026-03 | 11 | 91% | 91% | 73% | 55% |
| 2026-04 | 41 | 76% | 66% | 39% | 12% |
| 2026-05 | 43 | 77% | 63% | 47% | 14% |
| 2026-06 | 6 | 100% | 100% | 83% | 67% |
| 2026-07 | 46 | 76% | 61% | 46% | 13% |
| 2026-08 | 36 | 83% | 64% | 56% | 22% |
| 2026-09 | 7 | 100% | 86% | 86% | 43% |
| 2026-10 | 5 | 60% | 60% | 40% | 0% |

## Definitions

A passage is a task when it contains a glossary term of tier `ai`; a passage with `context` terms only is context and is not labelled. `ai_mention` is true for a filing with at least one passage labelled `explicit`. `adoption`, `risk`, `harm` (role `incident`), `vendor` (an entity named), `llm_adoption` (role `adoption` with kind `generative_llm`), `cyber_risk` and `regulatory_risk` follow the labels. Field definitions: `results/codebook.md`.
