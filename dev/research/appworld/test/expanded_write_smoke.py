"""Exercise every new mutation through the SDK and confirm provider state.

Runs on one disposable training world, with no task instructions or solutions.
"""

import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sdk_runner import AppWorld, NodeRepl, HERE, path_store
from music_acquire import music_catalog

path_store.update_root(str(HERE / ".local/world"))
with AppWorld(
    task_id="692c77d_1",
    experiment_name="expanded-write-smoke-" + uuid.uuid4().hex[:10],
    load_ground_truth=False,
) as world:
    passwords = {
        r["account_name"]: r["password"]
        for r in world.apis.supervisor.show_account_passwords()
    }
    token = world.apis.spotify.login(
        username=world.task.supervisor.email, password=passwords["spotify"]
    )["access_token"]
    rows = music_catalog(world.apis, token, world.task.supervisor.email)
    rows["Person"] = [
        {
            "sourceId": world.task.supervisor.email,
            "email": world.task.supervisor.email,
            "name": "Supervisor",
        }
    ]
    node = NodeRepl(world, rows, tokens={"spotify": token})
    try:

        def execute(code):
            event = node.request({"type": "execute", "code": code})
            assert event["error"] is None, event
            return event["output"]

        execute("""var key = 0; var run = async (name,input={}) => {const r=await relate.actions[name]({input,idempotencyKey:'smoke-'+(++key)}); if(r.state!=='succeeded'||r.output.refreshState!=='current')throw new Error(JSON.stringify(r)); return r;};
            var song=(await relate.objects.Song.query({limit:1})).data[0];
            var artist=(await relate.objects.Artist.query({limit:1})).data[0];
            var saved=(await relate.objects.SavedSong.query({limit:1})).data[0];
            var album=(await relate.objects.SavedAlbum.query({limit:1})).data[0];""")
        for name, args in [
            ("likeSong", "{song:song.id}"),
            ("downloadSong", "{song:song.id}"),
            ("followArtist", "{artist:artist.id}"),
            ("unfollowArtist", "{artist:artist.id}"),
            ("rateSong", "{song:song.id,rating:5}"),
            ("rateSong", "{song:song.id,rating:4}"),
        ]:
            print(name, flush=True)
            execute(f"await run({json.dumps(name)},{args});")
        execute("""var created=await run('createPlaylist',{title:'Adapter smoke playlist'});
          var playlist=(await relate.objects.Playlist.query({where:{sourceId:created.output.sourceId}})).data[0];
          if(!playlist)throw new Error('Created playlist not adopted');
          await run('addPlaylistSong',{playlist:playlist.id,song:song.id});
          var members=[]; for await (const x of relate.objects.Playlist.traverse.songs(playlist.id)) members.push(x.id);
          if(!members.includes(song.id))throw new Error('Added membership absent');
          await run('removePlaylistSong',{playlist:playlist.id,song:song.id});
          for await (const x of relate.objects.Playlist.traverse.songs(playlist.id)) throw new Error('Deleted membership retained');""")
        for name, args in [
            ("removeSavedSong", "{song:saved.data.song}"),
            ("removeSavedAlbum", "{album:album.data.album}"),
            ("queueSong", "{song:song.id}"),
            ("nextSong", "{}"),
            ("previousSong", "{}"),
            ("playSong", "{song:song.id}"),
            ("refreshMusic", "{}"),
        ]:
            print(name, flush=True)
            execute(f"await run({json.dumps(name)},{args});")
        replay = execute("""var request={input:{title:'Replay smoke'},idempotencyKey:'fixed-create'};
          var first=await relate.actions.createPlaylist(request); var again=await relate.actions.createPlaylist(request);
          if(JSON.stringify(first)!==JSON.stringify(again))throw new Error('Receipt replay mismatch');
          console.log(JSON.stringify({song:song.data.sourceId,artist:artist.data.sourceId,playlist:created.output.sourceId,saved:saved.data.sourceId,album:album.data.sourceId}));""")
        observed = json.loads(replay)
        private = world.apis.spotify.show_song_privates(
            song_id=int(observed["song"]), access_token=token
        )
        assert private["liked"] and private["downloaded"]
        reviews = world.apis.spotify.show_song_reviews(
            song_id=int(observed["song"]), user_email=world.task.supervisor.email
        )
        assert len(reviews) == 1 and reviews[0]["rating"] == 4
        assert not world.apis.spotify.show_artist_following(
            artist_id=int(observed["artist"]), access_token=token
        )["following"]
        assert not world.apis.spotify.show_playlist(
            playlist_id=int(observed["playlist"]), access_token=token
        )["songs"]
        assert world.apis.spotify.show_current_song(access_token=token)[
            "song_id"
        ] == int(observed["song"])
        print(
            "PASS: all 14 music mutations, refresh, create/update/delete visibility, personal state, and receipt replay"
        )
    finally:
        node.close()
