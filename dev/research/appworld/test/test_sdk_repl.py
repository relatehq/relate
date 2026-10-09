import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sdk_runner import SDK_PROMPT, NodeRepl, code_action, model_call


def records():
    return {
        "Playlist": [{"sourceId": "1", "title": "Morning"}],
        "Song": [
            {
                "sourceId": str(i),
                "title": f"Song {i}",
                "albumId": "1",
                "duration": i,
                "genre": "pop",
                "releaseDate": "2020-01-01",
                "likeCount": 1,
                "playCount": 1,
                "artistsJson": "[]",
            }
            for i in (2, 3)
        ],
        "Membership": [
            {"sourceId": f"1:{i}", "playlist": "1", "song": str(i)} for i in (2, 3)
        ],
    }


class SdkReplTests(unittest.TestCase):
    def start(self):
        world = SimpleNamespace(
            requester=SimpleNamespace(request_tracker=SimpleNamespace(requests=[])),
            apis=SimpleNamespace(
                supervisor=SimpleNamespace(complete_task=lambda **args: args)
            ),
        )
        node = NodeRepl(world, records())
        self.addCleanup(node.close)
        return node

    def test_persistent_typescript_discovery_query_and_through_traversal(self):
        node = self.start()
        result = node.request(
            {
                "type": "execute",
                "code": "const x: number = 7; console.log(relate.describe().objects.map(o => o.apiName));",
            }
        )
        self.assertIn("Playlist", result["output"])
        result = node.request(
            {
                "type": "execute",
                "code": """
const playlists = await relate.objects.Playlist.query({where: {title: 'Morning'}, select: ['title']});
let total = 0;
for await (const song of relate.objects.Playlist.traverse.songs(playlists.data[0].id, {limit: 1, select: ['duration']})) total += song.data.duration;
console.log(JSON.stringify({x, total, evidence: playlists.data[0].meta.evidence}));
""",
            }
        )
        self.assertIn('"total":5', result["output"])
        self.assertIn('"x":7', result["output"])
        self.assertIn('"evidence":"compact"', result["output"])
        self.assertIsNone(result["error"])

    def test_errors_recover_and_completion_works(self):
        node = self.start()
        for code in [
            "missingVariable",
            'await Promise.reject(new Error("bad call"))',
            "let = ;",
        ]:
            result = node.request({"type": "execute", "code": code})
            self.assertIsNotNone(result["error"])
        result = node.request(
            {
                "type": "execute",
                "code": 'console.log(await completeTask({answer: "done"}));',
            }
        )
        self.assertIn("done", result["output"])
        self.assertIsNone(result["error"])

    def test_original_apis_and_credentials_are_not_exposed(self):
        node = self.start()
        result = node.request(
            {
                "type": "execute",
                "code": "console.log(typeof apis, typeof tokens, typeof completeTask);",
            }
        )
        self.assertEqual(result["output"].strip(), "undefined undefined function")
        result = node.request(
            {
                "type": "execute",
                "code": "await apis.spotify.show_playlist_library({});",
            }
        )
        self.assertIn("ReferenceError", result["error"])
        result = node.request(
            {
                "type": "execute",
                "code": "await completeTask({app: 'spotify', api: 'show_song'});",
            }
        )
        self.assertIn("accepts only an optional answer", result["error"])
        result = node.request(
            {
                "type": "execute",
                "code": "console.log(await completeTask());",
            }
        )
        self.assertIsNone(result["error"])

    def test_host_rejects_old_application_api_protocol(self):
        node = self.start()
        node.buffer = b'{"type":"api","app":"spotify","api":"show_song","args":{}}\n'
        with self.assertRaisesRegex(RuntimeError, "Unsupported Node worker event"):
            node.request({"type": "execute", "code": "console.log('ok');"})
        # Drain the legitimate queued result before normal cleanup.
        node.process.stdout.readline()

    def test_host_secrets_and_files_are_unavailable(self):
        node = self.start()
        result = node.request(
            {
                "type": "execute",
                "code": "console.log(typeof process, typeof require, typeof research);",
            }
        )
        self.assertEqual(result["output"].strip(), "undefined undefined undefined")
        result = node.request(
            {
                "type": "execute",
                "code": 'const fs = await import("node:fs/promises"); await fs.readFile("/etc/passwd", "utf8");',
            }
        )
        self.assertIsNotNone(result["error"])
        self.assertNotIn("root:", result["output"])

    def test_only_the_explicit_code_tool_executes(self):
        response = {
            "output": [
                {
                    "type": "message",
                    "phase": "commentary",
                    "content": [
                        {
                            "type": "output_text",
                            "text": '{"code":"do not execute commentary"}',
                        }
                    ],
                },
                {
                    "type": "function_call",
                    "name": "execute_code",
                    "call_id": "call-1",
                    "arguments": '{"code":"console.log(1)"}',
                },
            ]
        }
        self.assertEqual(code_action(response), ('{"code":"console.log(1)"}', "call-1"))
        self.assertEqual(
            code_action({"output": response["output"] + [response["output"][1]]}),
            ("", None),
        )
        self.assertEqual(code_action({"output": [{"type": "reasoning"}]}), ("", None))

    def test_no_action_response_retains_billed_usage(self):
        response = {
            "output": [{"type": "reasoning"}],
            "status": "incomplete",
            "model": "gpt-5.4-mini",
            "usage": {"input_tokens": 100, "output_tokens": 50},
        }
        fake = SimpleNamespace(status_code=200, json=lambda: response)
        with patch("sdk_runner.requests.post", return_value=fake):
            content, metadata = model_call("test-only", "gpt-5.4-mini", [], 4096, "low")
        self.assertEqual(content, "")
        self.assertIsNone(metadata["call_id"])
        self.assertEqual(metadata["usage"]["output_tokens"], 50)
        self.assertGreater(metadata["estimated_usd"], 0)
        self.assertEqual(metadata["provider_output"], response["output"])

    def test_prompt_contains_discovery_entry_points_not_domain_schema(self):
        self.assertIn("relate.describe()", SDK_PROMPT)
        self.assertIn("await completeTask({answer: ...})", SDK_PROMPT)
        self.assertNotIn("apis.", SDK_PROMPT)
        for word in [
            "Playlist",
            "Membership",
            "Transaction",
            "relationshipsJson",
            "roommate",
            "research(",
        ]:
            self.assertNotIn(word, SDK_PROMPT)


if __name__ == "__main__":
    unittest.main()
