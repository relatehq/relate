import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from source_writes import SourceWrites


class SourceWritesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "writes.sqlite3"
        self.writes = 0
        self.reads = 0
        self.fail_read = False
        self.lose_response = False
        self.event = {
            "operation": "commentOnTransaction",
            "operationId": "stable-1",
            "sourceId": "1",
            "comment": "Thanks",
        }
        self.api = SimpleNamespace(
            create_transaction_comment=self.post,
            like_transaction=self.post,
            show_transaction=self.read,
        )

    def open(self, account="me@test"):
        journal = SourceWrites(self.path, self.api, "secret", {"1"}, account)
        self.addCleanup(journal.close)
        return journal

    def post(self, **args):
        self.writes += 1
        if self.lose_response:
            raise TimeoutError("Response lost after provider commit")
        return {"message": "Commented", "comment_id": self.writes}

    def read(self, **args):
        self.reads += 1
        if self.fail_read:
            raise TimeoutError("Readback failed")
        return {
            "transaction_id": 1,
            "sender": {"email": "me@test"},
            "receiver": {"email": "me@test"},
            "amount": 10,
            "description": "Test",
            "created_at": "2023-01-01",
            "like_count": 0,
            "comment_count": self.writes,
        }

    def test_failed_readback_retains_confirmed_write_across_reopen(self):
        first = self.open()
        self.fail_read = True
        result = first.execute(self.event)
        self.assertEqual(result["mutationState"], "confirmed")
        self.assertEqual(result["refreshState"], "pending")
        self.assertEqual(result["output"]["commentId"], "1")
        self.fail_read = False
        replay = self.open().execute(self.event)
        self.assertEqual(replay["output"], result["output"])
        self.assertEqual(replay["refreshState"], "current")
        self.assertEqual(self.writes, 1)
        self.assertEqual(self.reads, 2)
        self.assertNotIn(b"secret", self.path.read_bytes())

    def test_lost_response_is_uncertain_and_never_reposted(self):
        self.lose_response = True
        result = self.open().execute(self.event)
        self.assertEqual(result, {"mutationState": "uncertain"})
        self.lose_response = False
        self.assertEqual(self.open().execute(self.event), result)
        self.assertEqual(self.writes, 1)
        self.assertEqual(self.reads, 0)

    def test_reserved_operation_after_crash_cannot_dispatch_again(self):
        journal = self.open()
        from source_writes import canonical

        request = {k: v for k, v in self.event.items() if k != "operationId"}
        journal.db.execute(
            "INSERT INTO operations(id, request) VALUES (?, ?)",
            ("stable-1", canonical(request)),
        )
        self.assertEqual(
            self.open().execute(self.event), {"mutationState": "uncertain"}
        )
        self.assertEqual(self.writes, 0)

    def test_changed_input_conflicts_and_account_scope_is_checked(self):
        self.open().execute(self.event)
        journal = self.open()
        self.assertEqual(
            journal.execute({**self.event, "comment": "Different"}),
            {"mutationState": "conflict"},
        )
        with self.assertRaisesRegex(ValueError, "another provider account"):
            self.open("another@test")
        self.assertEqual(self.writes, 1)

    def test_refresh_is_read_only_and_does_not_resolve_uncertainty(self):
        journal = self.open()
        self.lose_response = True
        journal.execute(self.event)
        result = journal.execute({"operation": "refreshTransaction", "sourceId": "1"})
        self.assertEqual(result["mutationState"], "none")
        self.assertEqual(result["refreshState"], "current")
        self.assertEqual(journal.execute(self.event), {"mutationState": "uncertain"})
        self.assertEqual(self.writes, 1)

    def test_missing_identity_and_out_of_scope_writes_fail_before_dispatch(self):
        journal = self.open()
        for event in [
            {**self.event, "operationId": None},
            {**self.event, "sourceId": "2"},
        ]:
            with self.assertRaises(ValueError):
                journal.execute(event)
        self.assertEqual(self.writes, 0)


if __name__ == "__main__":
    unittest.main()
