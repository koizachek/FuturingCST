"""Conditioned Timestral runs per sector, following scenarioGPT's generation.py.

Each sector has two quantified drivers with outcomes "accelerating" (continue the
observed linear slope per quarter) and "stalling" (hold the last value). Scenario 1 =
driver 1 accelerating, driver 2 stalling; scenario 2 = the reverse. Each scenario is
one joint Timestral-28M run to 2036 with known covariates = time index + both driver
paths (history + outcome path, clipped to bounds); 2028/2031/2036 are read with
band_at. One backtest per sector holds out 3 quarters with observed driver values.
"""
import copy
import json
import sys
from datetime import datetime, timezone

import numpy as np
from scenariogpt import domain, forecasting
from scenariogpt.generation import _horizon

ckl_path, v2_path, out_path = sys.argv[1:4]
records = {r["id"]: r for r in json.load(open(ckl_path)) + json.load(open(v2_path))}
MODEL = "mistralai/Timestral-28M"
YEARS = {"2y": 2028, "5y": 2031, "10y": 2036}

SECTORS = {
    "manufacturing": {
        "drivers": [("series-C-bf_operations", "Own AI use in operations"),
                    ("series-C-mit_ai_system_security_vulnerabilities_attacks", "AI system security risk")],
        "targets": ["series-C-bf_rd_product", "series-C-kind_generative_llm", "series-C-kind_agentic",
                    "series-C-share_vendor", "series-C-risk_third_party", "series-C-gov_policies_processes",
                    "series-C-mit_regulation_lagging_behind_ai", "series-C-risk_operational_reliability"],
    },
    "banking": {
        "drivers": [("series-L-kind_generative_llm", "Generative AI / LLM uptake"),
                    ("series-L-mit_fraud_scams_targeted_manipulation", "AI fraud and impersonation risk")],
        "targets": ["series-L-mit_false_or_misleading_information", "series-L-gov_oversight_structure",
                    "series-L-bf_decision_analytics", "series-L-bf_customer_service", "series-L-kind_agentic",
                    "series-L-share_vendor", "series-L-share_regulatory_risk", "series-L-risk_third_party"],
    },
    "it": {
        "drivers": [("series-K-kind_agentic", "Agentic AI"),
                    ("series-K-risk_market_demand", "AI market-demand risk (AI spending bubble)")],
        "targets": ["series-K-risk_workforce", "series-K-mit_devaluation_of_human_effort",
                    "series-K-mit_power_centralization_unfair_benefits", "series-K-risk_environmental",
                    "series-K-share_llm_adoption", "series-K-bf_it_cybersecurity",
                    "series-K-gov_policies_processes", "series-K-role_market_driver"],
    },
}


def slope(values):
    y = np.asarray(values, dtype=float)
    return float(np.polyfit(np.arange(len(y)), y, 1)[0])


def path(series, outcome, horizon):
    last = series["values"][-1]
    step = slope(series["values"]) if outcome == "accelerating" else 0.0
    bounds = series.get("bounds") or {}
    lo, hi = bounds.get("lower", -np.inf), bounds.get("upper", np.inf)
    return [min(max(last + step * (i + 1), lo), hi) for i in range(horizon)]


def covariate_rows(drivers, outcomes, length, horizon):
    rows = [{"name": "Time index", "values": [float(i) for i in range(length + horizon)],
             "assumption": "Calendar time, so that the model can continue the observed trend."}]
    for (series_id, name), outcome in zip(drivers, outcomes):
        series = records[series_id]
        if outcome is None:  # backtest: observed held-out values
            values = list(series["values"][: length + horizon])
            assumption = "Observed values."
        else:
            values = list(series["values"][:length]) + path(series, outcome, horizon)
            assumption = f"Outcome '{outcome}'."
        rows.append({"name": f"{name} ({series['name']})", "values": values, "assumption": assumption})
    return rows


def targets(ids, length=None):
    out = []
    for series_id in ids:
        series = copy.deepcopy(records[series_id])
        series["past_covariates"], series["known_covariates"] = [], []
        if length is not None:
            series["dates"], series["values"] = series["dates"][:length], series["values"][:length]
        out.append(series)
    return out


def run(target_ids, drivers, outcomes, length, horizon):
    series = targets(target_ids, length)
    series[0]["known_covariates"] = covariate_rows(drivers, outcomes, length, horizon)
    result = forecasting.run_forecast(series[0], {"horizon": horizon, "model_id": MODEL,
                                                  "additional_series": series[1:]})
    for target in result["targets"]:
        target.setdefault("series_id", target.get("series_id"))
    return result


out = {"model_id": MODEL, "generated_at": datetime.now(timezone.utc).isoformat(), "horizons": YEARS,
       "interval": {"lower": 0.1, "upper": 0.9},
       "method": "scenarioGPT generation.py: one Timestral run per driver-outcome combination; "
                 "known covariates = time index + driver paths; accelerating = observed linear slope per quarter, "
                 "stalling = hold last value; values clipped to bounds.",
       "sectors": {}}

for sector, spec in SECTORS.items():
    drivers, target_ids = spec["drivers"], spec["targets"]
    assert len(target_ids) <= 8
    dates = records[target_ids[0]]["dates"]
    for series_id in target_ids + [d[0] for d in drivers]:
        assert records[series_id]["dates"] == dates, series_id
    length = len(dates)
    horizon = _horizon(records[target_ids[0]], YEARS["10y"])

    # backtest: hold out 3 quarters, observed driver values as the known future
    hold = 3
    bt = run(target_ids, drivers, [None, None], length - hold, hold)
    inside = observed = 0
    for target in bt["targets"]:
        actual = records[target["series_id"]]["values"][length - hold:]
        for value, lo, hi in zip(actual, target["lower"], target["upper"]):
            if value is not None:
                observed += 1
                inside += lo <= value <= hi
    backtest = {"holdout": hold, "inside": inside, "observed": observed}

    scenarios = []
    for outcomes in (["accelerating", "stalling"], ["stalling", "accelerating"]):
        result = run(target_ids, drivers, outcomes, length, horizon)
        result["series_id"] = target_ids[0]
        by_horizon = {}
        for key, year in YEARS.items():
            by_horizon[key] = []
            for target in result["targets"]:
                band = domain.band_at(result, target["series_id"], year)
                by_horizon[key].append({
                    "series_id": target["series_id"], "name": target["name"].split(": ", 1)[-1],
                    "last_observed": records[target["series_id"]]["values"][-1],
                    **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in band.items()},
                })
        configuration = [{"driver": name, "series_id": sid, "outcome": o,
                          "change_per_quarter": round(slope(records[sid]["values"]) if o == "accelerating" else 0.0, 4),
                          "last_observed": records[sid]["values"][-1]}
                         for (sid, name), o in zip(drivers, outcomes)]
        scenarios.append({"configuration": configuration,
                          "assumption": "; ".join(f"{c['driver']}: {c['outcome']}" for c in configuration),
                          "by_horizon": by_horizon, "diagnostics": result["diagnostics"]})
    out["sectors"][sector] = {"drivers": [{"series_id": s, "name": n, "series_name": records[s]["name"],
                                           "values": records[s]["values"], "dates": dates} for s, n in drivers],
                              "backtest": backtest, "scenarios": scenarios}
    print(sector, backtest, file=sys.stderr)

json.dump(out, open(out_path, "w"), indent=1)
