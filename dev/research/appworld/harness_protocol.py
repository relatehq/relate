"""Shared execution schema and historical static-note treatment.

Keep these values byte-for-byte stable across runners: changing either is a
research intervention. This module has no interpreter or provider dependencies.
"""

SCHEMA = {
    "type": "object",
    "properties": {"code": {"type": "string"}},
    "required": ["code"],
    "additionalProperties": False,
}

SEMANTICS = """Relationship notes: a playlist contains many songs; a song can occur in multiple playlists.
Playlist membership is distinct from the user's song library. Song public popularity is not the user's personal liking.
Use source song IDs for original app action APIs. Deduplicate songs when combining playlists.
Phone contacts and Venmo transaction participants can be joined by exact email in this simulator.\nTransactions have distinct sender and receiver; filter direction and date before summing.\nDuration fields are in seconds. A collection page is not the complete collection.
"""
