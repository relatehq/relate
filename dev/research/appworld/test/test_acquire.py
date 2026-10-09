import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from acquire import graph_payments, pages, payments
from unittest.mock import patch


class AcquireTests(unittest.TestCase):
    def test_pages_checks_terminal_empty_page(self):
        calls = []

        def api(**kwargs):
            calls.append(kwargs["page_index"])
            return [{"id": kwargs["page_index"]}] if kwargs["page_index"] < 2 else []

        self.assertEqual(pages(api), [{"id": 0}, {"id": 1}])
        self.assertEqual(calls, [0, 1, 2])

    def test_unbounded_collection_does_not_claim_complete(self):
        with self.assertRaisesRegex(ValueError, "cannot claim complete"):
            pages(lambda **kwargs: [{"id": kwargs["page_index"]}])

    def test_payment_join_uses_email_not_name_and_preserves_direction(self):
        contacts = [
            {
                "email": "a@example.test",
                "first_name": "Same",
                "last_name": "Name",
                "relationships": ["roommate"],
            }
        ]
        transactions = [
            {
                "transaction_id": 7,
                "sender": {"name": "Same Name", "email": "b@example.test"},
                "receiver": {"name": "Same Name", "email": "a@example.test"},
                "amount": 5,
                "description": "Test",
                "created_at": "2023-01-01",
                "like_count": 1,
                "comment_count": 0,
            }
        ]
        apis = SimpleNamespace(
            phone=SimpleNamespace(
                search_contacts=lambda **k: contacts if k["page_index"] == 0 else []
            ),
            venmo=SimpleNamespace(
                show_transactions=lambda **k: (
                    transactions if k["page_index"] == 0 else []
                )
            ),
        )
        result = payments(apis, "phone", "venmo")
        self.assertEqual(len(result["Person"]), 2)
        self.assertEqual(result["Transaction"][0]["sender"], "b@example.test")
        self.assertEqual(result["Transaction"][0]["receiver"], "a@example.test")
        matched = next(p for p in result["Person"] if p["sourceId"] == "a@example.test")
        self.assertEqual(matched["relationshipsJson"], '["roommate"]')

    def test_graph_labels_are_owner_scoped_and_preserve_multiple_labels(self):
        source_rows = {
            "Person": [
                {
                    "sourceId": "contact@test",
                    "name": "Contact",
                    "relationshipsJson": '["friend", "coworker", "friend"]',
                },
                {
                    "sourceId": "participant@test",
                    "name": "Participant",
                    "relationshipsJson": "[]",
                },
            ],
            "Transaction": [
                {"sourceId": "1", "sender": "contact@test", "receiver": "owner@test"}
            ],
        }
        supervisor = {"email": "owner@test", "first_name": "Owner", "last_name": "Name"}
        with patch("acquire.payments", return_value=source_rows) as acquire:
            rows = graph_payments("apis", "phone", "venmo", supervisor)
        acquire.assert_called_once_with("apis", "phone", "venmo")
        self.assertEqual(rows["Transaction"], source_rows["Transaction"])
        self.assertEqual(len(rows["Person"]), 3)
        self.assertTrue(
            all(
                "relationshipsJson" not in p and p["email"] == p["sourceId"]
                for p in rows["Person"]
            )
        )
        labels = rows["ContactRelationship"]
        self.assertEqual(
            {(r["owner"], r["contact"], r["kind"]) for r in labels},
            {
                ("owner@test", "contact@test", "friend"),
                ("owner@test", "contact@test", "coworker"),
            },
        )
        self.assertEqual(len(labels), 2)
        with patch("acquire.payments", return_value=source_rows):
            other = graph_payments(
                "apis", "phone", "venmo", {**supervisor, "email": "other@test"}
            )
        self.assertTrue(
            {r["sourceId"] for r in labels}.isdisjoint(
                r["sourceId"] for r in other["ContactRelationship"]
            )
        )


if __name__ == "__main__":
    unittest.main()
