import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sdk_runner import SDK_PROMPT, NodeRepl, code_action


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
            apis=SimpleNamespace(example=SimpleNamespace(echo=lambda **args: args)),
        )
        node = NodeRepl(world, records(), {})
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

    def test_errors_recover_and_parallel_original_api_calls_complete(self):
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
                "code": "console.log(await Promise.all([apis.example.echo({value: 3}), apis.example.echo({value: 4})]));",
            }
        )
        self.assertIn("value: 3", result["output"])
        self.assertIn("value: 4", result["output"])

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
        with self.assertRaisesRegex(ValueError, "exactly one"):
            code_action({"output": response["output"] + [response["output"][1]]})

    def test_prompt_contains_discovery_entry_points_not_domain_schema(self):
        self.assertIn("relate.describe()", SDK_PROMPT)
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
