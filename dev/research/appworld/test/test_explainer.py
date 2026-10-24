"""Offline guards for treatment isolation and source coverage claims."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from explainer_experiments import variant
from explainer_support import acquisition_coverage


class ExplainerTests(unittest.TestCase):
    def test_only_named_graph_treatments_change_the_graph(self):
        source = (Path(__file__).resolve().parents[1] / "sdk-graph.mjs").read_text()
        for arm in [
            "baseline",
            "actions",
            "errors",
            "collections",
            "relationships",
            "filters",
            "snapshot_ts",
        ]:
            self.assertEqual(variant(source, arm), source)
        self.assertIn(
            "createdAt: localDateTime({ precision: 'second' })",
            variant(source, "datetime"),
        )
        coverage = variant(source, "coverage")
        self.assertIn("collectionCoverage:", coverage)
        self.assertIn("acquisitionAuthorized = false", coverage)
        self.assertIn("localDateTime(", coverage)
        with self.assertRaises(AssertionError):
            variant("unrecognized graph", "datetime")

    def test_empty_acquired_scope_is_complete_but_missing_scope_is_not_invented(self):
        reports = acquisition_coverage({"Transaction": []})
        self.assertEqual(set(reports), {"Transaction"})
        report = reports["Transaction"]
        self.assertEqual(report["pagination"], "exhausted")
        self.assertEqual(report["gaps"], [])
        self.assertGreater(report["expiresAt"], report["observedAt"])
        self.assertNotIn("count", report)


if __name__ == "__main__":
    unittest.main()
