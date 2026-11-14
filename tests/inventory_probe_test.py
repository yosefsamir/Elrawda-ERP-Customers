"""Checks for the offline probe; no SQL connection or private ERP fixtures."""

import importlib.util
import unittest
from copy import deepcopy
from datetime import datetime
from decimal import Decimal
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "inventory_probe", Path(__file__).resolve().parents[1] / "scripts/probe_inventory_copy.py"
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
BASE = datetime(2026, 8, 1)
START = datetime(2026, 10, 1)
END = datetime(2026, 10, 28)


def row(source, quantity, date, **overrides):
    return {
        "source": source, "idprogramitems": "9", "idbranch": "39", "idstor": "28",
        "idno_s": "1", "line_id": "1", "iddet": "123", "idunit": "1",
        "quantity": quantity, "bonus": 0, "quantity_hint": 0,
        "movement_date": date, "manufacturing_closed_date": None,
        "changes_product": False, "component_direction": -1, "consignment_flag": None,
        "destination_product": None, "destination_branch": "45", "destination_store": "35",
        **overrides,
    }


def snapshot(rows):
    return [
        [{"source": s, "missing_headers": 0, "null_deletion_flags": 0,
          "export_until": "2026-10-28"} for s in probe.SOURCES],
        rows,
        [{"iddet": "123", "code": "TEST", "service_item": False}],
        [{"idbranch": "39", "branch_name": "A"}, {"idbranch": "45", "branch_name": "B"}],
        [{"idbranch": "39", "idstor": "28"}, {"idbranch": "45", "idstor": "35"}],
        [{"source": source, "all_lines": "0"} for source in sorted(probe.OMITTED)],
    ]


class InventoryProbeTests(unittest.TestCase):
    def test_transfer_counts_both_ends_without_creating_stock_or_sales(self):
        result = probe.reconstruct(snapshot([
            row("gard", 10, "2026-08-01"),
            row("transstorbranch", 4, "2026-10-05"),
        ]), BASE, START, END)
        groups = {g["branch"]: g for g in result["groups"]}
        self.assertEqual(groups["39"]["closing"], Decimal(6))
        self.assertEqual(groups["45"]["closing"], Decimal(4))
        self.assertEqual(sum(g["closing"] for g in groups.values()), Decimal(10))
        self.assertTrue(all(g["net_sold"] == 0 for g in groups.values()))

    def test_returns_not_added_twice_to_sell_through_denominator(self):
        result = probe.reconstruct(snapshot([
            row("gard", 20, "2026-08-01"),
            row("ward", 10, "2026-10-02"),
            row("sadr", 18, "2026-10-03", quantity_hint=12),
            row("return_s", 2, "2026-10-04"),
        ]), BASE, START, END)["groups"][0]
        self.assertEqual(result["closing"], Decimal(14))
        self.assertEqual(result["net_sold"], Decimal(16))
        self.assertEqual(result["denominator"], Decimal(30))

    def test_stockout_day_counts_as_available_and_later_days_do_not(self):
        result = probe.reconstruct(snapshot([
            row("gard", 1, "2026-08-01"),
            row("sadr", 1, "2026-10-09 19:05:13"),
        ]), BASE, START, END)["groups"][0]
        self.assertEqual(result["candidate_available_days"], 9)
        self.assertEqual(result["period_days"], 27)
        self.assertEqual(result["closing"], 0)

    def test_negative_sale_stays_signed_and_requires_review(self):
        result = probe.reconstruct(snapshot([
            row("gard", 5, "2026-08-01"),
            row("sadr", -2, "2026-10-02", quantity_hint=7),
        ]), BASE, START, END)["groups"][0]
        self.assertEqual(result["closing"], Decimal(7))
        self.assertEqual(result["net_sold"], Decimal(-2))
        self.assertTrue(result["needs_review"])

    def test_cutoff_and_unverified_sources_fail_instead_of_guessing(self):
        original = snapshot([row("gard", 5, "2026-08-01")])
        cases = []
        data = deepcopy(original)
        data[0][0]["export_until"] = "2026-10-20"
        cases.append(data)
        data = deepcopy(original)
        data[5][0]["all_lines"] = "1"
        cases.append(data)
        data = deepcopy(original)
        data[1][0]["idunit"] = "2"
        cases.append(data)
        data = deepcopy(original)
        data[1].append(deepcopy(data[1][0]))
        cases.append(data)
        for data in cases:
            with self.subTest(data=data), self.assertRaises(ValueError):
                probe.reconstruct(data, BASE, START, END)

    def test_older_transactions_are_not_subtracted_from_opening_again(self):
        result = probe.reconstruct(snapshot([
            row("gard", 5, "2026-08-01"),
            row("sadr", 3, "2026-07-31"),
        ]), BASE, START, END)
        self.assertEqual(result["groups"][0]["opening"], Decimal(5))
        self.assertEqual(result["skipped_outside_baseline_period"], {"sadr": 1})

    def test_manufacturing_uses_close_date_not_document_date(self):
        result = probe.reconstruct(snapshot([
            row("gard", 5, "2026-08-01"),
            row("manf", 10, "2026-09-20", manufacturing_closed_date="2026-10-02"),
        ]), BASE, START, END)["groups"][0]
        self.assertEqual(result["opening"], Decimal(5))
        self.assertEqual(result["closing"], Decimal(15))
        self.assertTrue(result["needs_review"])

    def test_negative_closing_reports_zero_without_blocking_on_negative_stock(self):
        report = probe.reconstruct(snapshot([
            row("gard", 1, "2026-08-01"),
            row("sadr", 2, "2026-10-02", quantity_hint=-1),
        ]), BASE, START, END)
        result = report["groups"][0]
        self.assertEqual(result["closing"], Decimal(0))
        self.assertEqual(result["raw_closing"], Decimal(-1))
        self.assertEqual(result["candidate_cover_days"], Decimal(0))
        self.assertEqual(report["negative_closing_groups"], 1)
        self.assertFalse(result["needs_review"])

    def test_negative_opening_is_zero_in_metrics_but_receipts_offset_raw_shortage(self):
        result = probe.reconstruct(snapshot([
            row("gard", -3, "2026-08-01"),
            row("ward", 5, "2026-10-02"),
        ]), BASE, START, END)["groups"][0]
        self.assertEqual(result["opening"], Decimal(0))
        self.assertEqual(result["raw_opening"], Decimal(-3))
        self.assertEqual(result["denominator"], Decimal(5))
        self.assertEqual(result["closing"], Decimal(2))
        self.assertEqual(result["candidate_available_days"], 26)

    def test_receipt_does_not_make_stock_available_until_shortage_is_offset(self):
        result = probe.reconstruct(snapshot([
            row("gard", -3, "2026-08-01"),
            row("ward", 2, "2026-10-02"),
        ]), BASE, START, END)["groups"][0]
        self.assertEqual(result["closing"], Decimal(0))
        self.assertEqual(result["raw_closing"], Decimal(-1))
        self.assertEqual(result["timeline"][0]["balance_after"], Decimal(-1))
        self.assertEqual(result["candidate_available_days"], 0)


if __name__ == "__main__":
    unittest.main()
