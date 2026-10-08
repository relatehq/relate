import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from acquire import pages, payments


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


if __name__ == "__main__":
    unittest.main()
