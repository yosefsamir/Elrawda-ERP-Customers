"""Offline, experimental inventory reconstruction; never connects to ERP.

Input is the JSON recordsets from inspect_inventory_reports.sql. Only unit 1
is supported. Directions and the August opening interpretation remain subject
to ERP reconciliation. Output must not be published as approved stock.
"""

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path


SIGNS = {
    "gard": 1, "ward": 1, "sadr": -1, "return_s": 1, "return_w": -1,
    "sarf_s": -1, "sarf_w": 1, "manf": 1, "costitemsmanf": -1,
}
SOURCES = set(SIGNS) | {"trans", "transstorbranch"}
OMITTED = {
    "itemssadr", "itemssarf_w", "restsadr", "restitemssadr", "manfforms",
    "costitemsward", "costitemstrans", "costitemssarf_w", "costitemsmanfforms",
    "devcostitem", "mainitem", "restshow", "show_s", "show_w",
}


def number(value):
    if value is None:
        raise ValueError("NULL quantity; cannot assume zero")
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError("Non-finite quantity")
    return result


def timestamp(value):
    result = datetime.fromisoformat(value)
    if result.tzinfo is not None:
        raise ValueError("Expected raw ERP wall-clock dates without timezone")
    return result


def reconstruct(recordsets, baseline, start, until):
    if not baseline < start < until:
        raise ValueError("Require baseline < start < until; baseline-day reporting is unsupported")
    if any(value.time() != datetime.min.time() for value in (baseline, start, until)):
        raise ValueError("Period boundaries must be midnight")
    coverage, rows, products, branches, stores, omitted = recordsets
    if {r["source"] for r in coverage} != SOURCES:
        raise ValueError("Missing source coverage")
    if any(r["missing_headers"] or r["null_deletion_flags"] for r in coverage):
        raise ValueError("Unresolved headers or deletion flags")
    if any(timestamp(r["export_until"]) < until for r in coverage):
        raise ValueError("Requested end exceeds the SQL export cutoff")
    if {r["source"] for r in omitted} != OMITTED or any(int(r["all_lines"]) for r in omitted):
        raise ValueError("Additional inventory sources require investigation")

    labels = {r["iddet"]: r for r in products}
    branch_labels = {r["idbranch"]: r["branch_name"] for r in branches}
    valid_stores = {(r["idbranch"], r["idstor"]) for r in stores}
    events = defaultdict(list)
    seen = set()
    skipped = Counter()
    flags = Counter()
    opening_rows = 0
    for row in rows:
        source = row["source"]
        if source not in SOURCES or str(row["idunit"]) != "1":
            raise ValueError("Unknown source or unverified unit conversion")
        identity = (source, row["idprogramitems"], row["idbranch"], row["line_id"])
        if identity in seen:
            raise ValueError("Duplicate source row")
        seen.add(identity)
        if source == "trans" and row["changes_product"] is not False:
            raise ValueError("Unknown/product-changing internal transfer")
        if source == "costitemsmanf" and row["component_direction"] != -1:
            raise ValueError("Unverified manufacturing component direction")
        if source in ("sarf_s", "sarf_w") and row["consignment_flag"] is True:
            raise ValueError("Consignment movements need separate validation")
        date = timestamp(row["movement_date"])
        if source == "gard":
            opening_rows += 1
            if date != baseline:
                raise ValueError("Opening rows do not share the assumed baseline")
        if source == "manf":
            if not row["manufacturing_closed_date"]:
                raise ValueError("Open manufacturing needs separate validation")
            date = timestamp(row["manufacturing_closed_date"])
        if date < baseline or date >= until:
            skipped[source] += 1
            continue
        quantity = number(row["quantity"])
        bonus = number(row["bonus"])
        if bonus:
            raise ValueError("Nonzero bonus needs validation for performance metrics")
        if quantity < 0:
            flags["negative_quantity_" + source] += 1

        def emit(branch, store, role, sign):
            if (branch, store) not in valid_stores or row["iddet"] not in labels:
                raise ValueError("Unresolved store or product")
            key = (row["idprogramitems"], branch, store, row["iddet"])
            events[key].append({
                "date": date, "role": role, "delta": sign * quantity,
                "document": row["idno_s"], "line_id": row["line_id"],
                "hint": number(row["quantity_hint"]),
            })

        if source in ("trans", "transstorbranch"):
            if source == "trans" and row["destination_product"] not in (None, row["iddet"]):
                raise ValueError("Different destination product")
            emit(row["idbranch"], row["idstor"], "transfer_out", -1)
            emit(row["destination_branch"], row["destination_store"], "transfer_in", 1)
        else:
            emit(row["idbranch"], row["idstor"], source, SIGNS[source])
    if not opening_rows:
        raise ValueError("No opening evidence")

    results = []
    checks = Counter()
    for (program, branch, store, product), ledger in sorted(events.items()):
        ledger.sort(key=lambda e: e["date"])
        simultaneous = Counter(e["date"] for e in ledger)
        opening = sum((e["delta"] for e in ledger if e["date"] < start), Decimal(0))
        balance = Decimal(0)
        hints = Counter()
        movements = defaultdict(Decimal)
        daily = defaultdict(list)
        period_ledger = []
        for event in ledger:
            balance += event["delta"]
            # fbkg is only a diagnostic hint, NOT an authoritative stock field.
            # Exclude ambiguous same-time sequences from this comparison.
            if event["role"] == "sadr" and simultaneous[event["date"]] == 1:
                status = "match" if balance == event["hint"] else "different"
                hints[status] += 1
                checks[status] += 1
            if event["date"] >= start:
                movements[event["role"]] += event["delta"]
                daily[event["date"].date()].append(event)
                period_ledger.append({
                    "date": event["date"].isoformat(sep=" "),
                    "role": event["role"], "delta": event["delta"],
                    "balance_after": balance, "document": event["document"],
                    "line_id": event["line_id"],
                })
        day = start
        daily_balance = opening
        available_days = negative_days = ambiguous_days = 0
        while day < until:
            available = daily_balance > 0
            negative = daily_balance < 0
            at_time = defaultdict(Decimal)
            ambiguous_days += any(simultaneous[e["date"]] > 1 for e in daily[day.date()])
            for event in daily[day.date()]:
                at_time[event["date"]] += event["delta"]
            for delta in (at_time[t] for t in sorted(at_time)):
                daily_balance += delta
                available |= daily_balance > 0
                negative |= daily_balance < 0
            available_days += bool(available)
            negative_days += bool(negative)
            day += timedelta(days=1)
        if daily_balance != balance:
            raise AssertionError("Daily and ledger balances disagree")
        # User policy: report negative stock as zero. Keep the signed ledger
        # intact so later receipts offset earlier shortages rather than create stock.
        reported_opening = max(opening, Decimal(0))
        reported_closing = max(balance, Decimal(0))
        net_sold = -movements["sadr"] - movements["return_s"]
        denominator = reported_opening + movements["ward"] + movements["transfer_in"]
        contextual = any(movements[k] for k in (
            "transfer_out", "sarf_s", "sarf_w", "return_w", "manf", "costitemsmanf", "gard",
        ))
        needs_review = (hints["different"] > 0 or contextual
                        or any(e["delta"] > 0 for e in ledger if e["role"] == "sadr")
                        or labels[product]["service_item"])
        rate = net_sold / available_days if available_days and net_sold >= 0 else None
        results.append({
            "program": program, "branch": branch, "branch_name": branch_labels[branch],
            "store": store, "product": product, **labels[product],
            "opening": reported_opening, "closing": reported_closing,
            "raw_opening": opening, "raw_closing": balance,
            "negative_stock_as_zero": True, "movements": dict(movements),
            "net_sold": net_sold, "denominator": denominator,
            "candidate_sell_through_pct": net_sold * 100 / denominator if denominator > 0 else None,
            "candidate_available_days": available_days, "period_days": (until-start).days,
            "days_with_negative_balance": negative_days,
            "days_with_simultaneous_events": ambiguous_days,
            "candidate_rate": rate,
            "candidate_cover_days": reported_closing / rate if rate else None,
            "quantity_hint_comparison": dict(hints), "needs_review": needs_review,
            "timeline": period_ledger,
        })
    return {
        "status": "experimental; not reconciled to ERP report",
        "assumptions": [
            "gard is an opening at baseline; older transactions excluded",
            "sarf_w adds stock and sarf_s removes it, subject to ERP confirmation",
            "manf enters on closing date; components leave on component date",
            "unit 1 only; no product conversions, bonuses or active omitted sources",
            "availability means positive balance observed during a calendar day; approximate",
            "no automatic performance classification; hints do not certify stock",
            "user policy: negative reported stock is zero; signed ledger retained",
        ],
        "baseline": baseline.isoformat(), "start": start.isoformat(), "until": until.isoformat(),
        "raw_rows": len(rows), "event_count": sum(map(len, events.values())),
        "skipped_outside_baseline_period": dict(skipped), "source_flags": dict(flags),
        "quantity_hint_comparison": dict(checks),
        "negative_closing_groups": sum(r["raw_closing"] < 0 for r in results),
        "groups": results,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--baseline", required=True, type=datetime.fromisoformat)
    parser.add_argument("--from", dest="start", required=True, type=datetime.fromisoformat)
    parser.add_argument("--until", required=True, type=datetime.fromisoformat)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error("Input and output must differ")
    snapshot = json.loads(args.input.read_text())
    result = reconstruct(snapshot["recordsets"], args.baseline, args.start, args.until)
    result["source"] = snapshot.get("source")
    result["checkedAt"] = snapshot.get("checkedAt")
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    print(json.dumps({k: v for k, v in result.items() if k != "groups"}, ensure_ascii=False))
