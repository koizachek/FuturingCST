# AI disclosure panel: manufacturing, software/IT/telecommunications, finance and insurance

Quarterly series of what large US companies disclose about AI in their SEC filings, 2023Q1–2026Q2,
for three ISIC Rev. 5 sections: C (manufacturing), K (software, IT and telecommunications) and
L (finance and insurance). The series measure reporting, not verified adoption or incidents.

## Panel

`panel_90.csv`: 30 companies per section (`role` = `panel`) and ten reserve companies, chosen from
the latest 10-K of each company by public float (cover page, or SEC XBRL `EntityPublicFloat` when the
Markdown lacks it). Set by the project owner: Autodesk and Airbnb included; Strategy and Fiserv left out;
gold and bitcoin trusts and RTB Digital (float misstated on its cover page) excluded. BlackRock reports
under a new CIK since 2024; both CIKs are listed in `panel_90_ciks.txt`. Shopify has no filings for
2023Q1–2024Q3 in the provider's data. Built by `scripts/select_panel.py`.

## Filings and classification

- `filings-2023q1-2026q2/`: 1,265 10-K and 10-Q filings of the panel companies (source:
  financialfilings.com), one manifest row per filing in `manifest.jsonl`.
- `base-10k-2022/`: 86 10-Ks released June 2022 to February 2023, the base for the first 10-Qs.

Each holds the airo classification-pipeline export (taxonomy v0.9, `gemini-2.5-flash` on Vertex AI,
thinking budget 0): `classification/chunks.jsonl` (passages that mention AI), `context_passages.jsonl`,
`documents_manifest.json`, `reports.tar.gz` (one report per filing) and `results/` (labels, the
coder's run records with token counts and cost, and `filing_metrics.jsonl` with one row of flags per
filing). 12 of 7,227 passages in the main set and 3 of 328 in the base set have no valid label.
The filing Markdown and the parsed documents (`docs.tar.gz`, 128 MB) are not in this repository.

## Series and backtest

`series_CKL.csv` (by `scripts/build_series.py`): per section and calendar quarter, the share of panel
companies whose filings show each flag and the mean number of AI passages. A filing counts for the
calendar quarter nearest to the end of its reporting period; a 10-Q is read together with the
company's latest 10-K, because a 10-Q reports only changes to it. `series_CKL_records.json`
(by `scripts/series_records.py`) holds the same series as scenarioGPT records for **Import series file**.

`backtest_CKL_<size>.json` (by `scripts/backtest_series.py`): the four Timestral checkpoints forecast
2025Q4–2026Q2 from 2023Q1–2025Q3 for four series per section, compared with the last value and the
linear trend of the last four quarters.
