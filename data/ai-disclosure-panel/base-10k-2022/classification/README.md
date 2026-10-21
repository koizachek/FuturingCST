# US AI disclosure dataset, run `us-panel-base-10K-2022`

Produced with the `airo` pipeline (`src/airo`, taxonomy v0.9) and `gemini-2.5-flash` on 2026-10-21.

## Files

```
us-panel-base-10K-2022/
├── chunks.jsonl                  328 classified passages (direct mentions), with text
├── context_passages.jsonl        1,378 context passages (implicit mentions), not classified
├── documents_manifest.json       86 filings, 86 distinct texts
├── docs.tar.gz                   per-document files: document.json, blocks.jsonl, passages.jsonl
├── reports.tar.gz                one report view per document
└── results/
    ├── classified_chunks.jsonl   325 labelled passages, every label field
    ├── filing_metrics.jsonl      one row per filing
    ├── us-filing-metrics.json    shares per filing month
    ├── codebook.md               the codebook used (classification_prompt.md is the same file)
    ├── labels_final.jsonl, agreement.json, report_summary.jsonl, recall_check.json
    └── the coder's label and run files
```

## Counts

- Filings: 86; distinct texts: 86
- Classified passages: 328, of which labelled 325, without label 3; about AI (`explicit`): 288
- Context passages (not classified): 1,378

| Month | Filings | AI mention | AI risk | Adoption | LLM adoption |
|---|---|---|---|---|---|
| 2022-06 | 1 | 100% | 100% | 0% | 0% |
| 2022-07 | 1 | 100% | 100% | 0% | 0% |
| 2022-08 | 4 | 75% | 50% | 25% | 25% |
| 2022-09 | 3 | 100% | 67% | 67% | 0% |
| 2022-10 | 2 | 100% | 0% | 50% | 0% |
| 2022-11 | 2 | 50% | 50% | 0% | 0% |
| 2022-12 | 1 | 100% | 100% | 0% | 0% |
| 2023-01 | 4 | 75% | 75% | 50% | 25% |
| 2023-02 | 68 | 62% | 41% | 29% | 1% |

## Definitions

A passage is a task when it contains a glossary term of tier `ai`; a passage with `context` terms only is context and is not labelled. `ai_mention` is true for a filing with at least one passage labelled `explicit`. `adoption`, `risk`, `harm` (role `incident`), `vendor` (an entity named), `llm_adoption` (role `adoption` with kind `generative_llm`), `cyber_risk` and `regulatory_risk` follow the labels. Field definitions: `results/codebook.md`.
