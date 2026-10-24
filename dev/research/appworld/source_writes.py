"""Task/account-local external-write journal, independent of SDK receipt rollback.

One file belongs to one AppWorld state and authenticated account. Reopen that
file when reconnecting to the same state; never reuse it for a reset episode.
No access tokens are persisted. An ambiguous dispatch is never retried here.
"""

import json
import sqlite3
from pathlib import Path

from acquire import transaction_row


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


class SourceWrites:
    def __init__(self, path, api, token, writable_ids, account_id):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS operations "
            "(id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT)"
        )
        self.db.execute("CREATE TABLE IF NOT EXISTS account (id TEXT NOT NULL)")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            saved_account = self.db.execute("SELECT id FROM account").fetchone()
            if saved_account is None:
                self.db.execute("INSERT INTO account VALUES (?)", (account_id,))
            elif saved_account[0] != account_id:
                raise ValueError("Journal belongs to another provider account")
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            self.db.close()
            raise
        self.api = api
        self.token = token
        self.writable_ids = writable_ids

    def close(self):
        self.db.close()

    def refresh(self, source_id):
        try:
            record = self.api.show_transaction(
                transaction_id=int(source_id), access_token=self.token
            )
            return {
                "refreshState": "current",
                "transaction": transaction_row(record),
            }
        except Exception:
            # Read failure must not erase a confirmed mutation or invite a POST.
            return {"refreshState": "pending"}

    def execute(self, event):
        source_id, operation = event["sourceId"], event["operation"]
        if source_id not in self.writable_ids:
            raise ValueError("Transaction is outside the acquired graph")
        if operation == "refreshTransaction":
            return {
                "mutationState": "none",
                "output": {"message": "Transaction refresh attempted"},
                **self.refresh(source_id),
            }
        if operation not in {"likeTransaction", "commentOnTransaction"}:
            raise ValueError("Unsupported source write")
        operation_id = event.get("operationId")
        if not isinstance(operation_id, str) or not operation_id.strip():
            raise ValueError("Stable SDK operationId is required before source writes")
        request = {"operation": operation, "sourceId": source_id}
        if operation == "commentOnTransaction":
            if not isinstance(event.get("comment"), str):
                raise ValueError("Comment must be a string")
            request["comment"] = event["comment"]
        fingerprint = canonical(request)
        # Commit the reservation before dispatch. A NULL result means that a
        # provider write may have happened, even after a host process restart.
        cursor = self.db.execute(
            "INSERT OR IGNORE INTO operations(id, request) VALUES (?, ?)",
            (operation_id, fingerprint),
        )
        if cursor.rowcount == 0:
            saved_request, result = self.db.execute(
                "SELECT request, result FROM operations WHERE id = ?", (operation_id,)
            ).fetchone()
            if saved_request != fingerprint:
                return {"mutationState": "conflict"}
            if result is None:
                return {"mutationState": "uncertain"}
            output = json.loads(result)
        else:
            args = {"transaction_id": int(source_id), "access_token": self.token}
            try:
                if operation == "likeTransaction":
                    result = self.api.like_transaction(**args)
                    output = {"message": result["message"]}
                else:
                    result = self.api.create_transaction_comment(
                        **args, comment=request["comment"]
                    )
                    output = {
                        "message": result["message"],
                        "commentId": str(result["comment_id"]),
                    }
                self.db.execute(
                    "UPDATE operations SET result = ? WHERE id = ?",
                    (canonical(output), operation_id),
                )
            except Exception:
                # Includes response loss and journal failures after the POST.
                # Without provider idempotency/lookup, retrying could duplicate it.
                return {"mutationState": "uncertain"}
        return {
            "mutationState": "confirmed",
            "output": output,
            **self.refresh(source_id),
        }
