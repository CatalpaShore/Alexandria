[▶ Watch the introduction: v6 with additional path redaction · 2026-10-27](../client/public/tour/product-tour.mp4?raw=1) · [Video chapters, in Chinese](VIDEO.md)

# Feature guide

[Documentation](README.en.md) · [简体中文](USER_GUIDE.md) · **English** · [日本語](USER_GUIDE.ja.md)

For a self-hosted Alexandria 18+ personal library. Start with the [setup guide](GETTING_STARTED.en.md) if this is your first installation. The [demo guide](../demo/README.md) explains the separate non-adult demo. Some maintenance labels still appear in Chinese; their names are included below where useful.

| Task | Jump to |
| --- | --- |
| Connect disks / NAS and import artwork | [Sources](#library-import) · [Local metadata](#metadata) |
| Find a title and choose a file version | [Media wall](#media-wall) |
| Play, resume, and fix subtitle encoding | [Playback](#playback) · [Subtitles](#subtitles) |
| Explore people, genres, and connections | [Topics and graph](#topics) |
| Choose the next title | [Viewing Desk](#viewing-desk) · [Curator](#curator) |
| Keep favorites, lists, history, and clips | [Personal records](#personal-library) · [Highlights](#highlights) |
| Inspect tasks, back up, or change disks | [Maintenance](#maintenance) · [Backups](#backup-migration) |
| Use a phone or change language | [Devices and language](#devices-language) |

<a id="library-import"></a>
## 1. Connect an existing collection

1. On a fresh installation, use the [setup script](GETTING_STARTED.en.md) with a read-only preview. On a running service, select **Connect library**, or open resource paths under the tools menu.
2. Enter an absolute path readable by the **server**. Mount NAS / SMB / NFS in the server OS first. For Docker, use the container path, such as **/media**.
3. Give each source a stable category and name. Preserve these values when replacing a disk.
4. Select **Preview import and relocation**, check readability, retained records, and empty-folder notices, then **Back up and start scanning**.
5. Return to the wall. Let scanning and background media probing finish, and check a few titles before adding a large collection.

Ordinary scanning does not organize source files. Disconnected sources retain offline records; deleting the database is not a fix for a missing mount. See [path examples](GETTING_STARTED.en.md) and the [migration procedure, in Chinese](MIGRATION.md).

<a id="metadata"></a>
## 2. Local metadata and artwork

Place sidecars beside the video. This is a neutral example, not a requirement to rename an existing collection:

~~~text
media/
└── Sample-001/
    ├── Sample-001.mp4
    ├── Sample-001.nfo
    ├── Sample-001.media.json
    ├── Sample-001-poster.jpg
    ├── Sample-001.zh.srt
    └── Sample-001.ja.srt
~~~

A matching **.media.json** can contain any of these fields:

~~~json
{
  "title": "Sample Film",
  "description": "A neutral local-metadata example.",
  "director": "Sample Director",
  "people": ["Sample Performer"],
  "collection": "Personal Collection",
  "tags": ["Animation", "Adventure"],
  "studio": "Sample Studio",
  "year": 2019
}
~~~

- NFO supports movie / episodedetails; a single-video folder can use **movie.nfo**. JSON overrides NFO by field. Existing manual corrections and completed external metadata take precedence.
- Posters support matching **-poster / .poster / .cover** names, or **poster / folder / cover** in single-video folders, using JPG / PNG / WebP.
- Rescan after adding sidecars, then inspect the detail page. Higher-priority metadata can prevent a sidecar change from replacing a field.
- Files without sidecars can still be indexed and played. Local import needs no network connection; external enrichment requires separate [configuration, in Chinese](OPERATIONS.md).

<a id="media-wall"></a>
## 3. Media wall, search, and versions

1. Open Media and search for a title, filename, identifier, or person; suggestions can take you to related items.
2. Combine filters for source, folder, type, people, genres, series, favorites, and watched state. On phones, expand **Filters**.
3. Open a card for details, or use its play button. Check format, size, duration, compatibility, and metadata source in the detail drawer.
4. If a work has multiple files, choose the actual version to play. Each file can have different subtitles and compatibility. Grouping does not merge or delete disk files.
5. Explore related works by cast, series, or tags, or switch to random browsing.

[Wall screenshot](screenshots/media-wall.png) · [Detail screenshot](../client/public/showcase/media-detail.png)

<a id="playback"></a>
## 4. Playback and resume

Use the playback-mode control at the bottom of the player. Confirm that the source is online before preparing a different format.

| Situation | Action |
| --- | --- |
| Browser supports the file | Play the original; adjust position, speed, and volume |
| Container is unsuitable but codecs are supported | Choose remux and wait for preparation |
| Video or audio codec is unsupported | Use transcoding / HLS; check FFmpeg and free disk space |
| Probe pending or preparation failed | Inspect the compatibility center and tasks / alerts for the actual error |
| Source is offline | Restore its mount first; conversion cannot replace a missing source |

Progress belongs to the active user. Resume from the personal page. Preparation takes time; wait for its state to finish. A successful H.264 / MP4 test does not establish support for every browser and codec.

<a id="subtitles"></a>
## 5. Subtitle tracks and encoding

1. Put SRT / ASS / SSA / VTT beside the video, using a language suffix such as **Sample-001.zh.srt**.
2. Rescan, then choose a language in the player's subtitle selector. Select off to hide subtitles.
3. If text is garbled, choose the appropriate encoding: UTF-8, GB18030, Big5, Shift JIS, or Windows-1252. UTF-8 / UTF-16 BOMs are detected automatically. Changing the selection does not rewrite the subtitle file.
4. Embedded MKV / MP4 text tracks appear after FFprobe detection and FFmpeg extraction.

ASS / SSA conversion does not preserve complex layouts and effects. Image subtitles require separate OCR. Translation and speech recognition need their own configured services; existing subtitles need no language model. Subtitle language, UI language, and metadata language are separate.

[Player screenshot](screenshots/player-subtitles.png) · [Compatibility table](../README.en.md#sources-and-playback-compatibility)

<a id="topics"></a>
## 6. Topics and knowledge graph

1. Open Topics and choose cast, series, genres, directors, studios, or another dimension; search or change the order.
2. Open a topic to see metadata and associated works. A topic requires the relevant imported fields.
3. Switch to the graph, choose a starting dimension and node, then select the next relationship dimension to explore.
4. If few nodes or no edges appear, relax filters, lower the shared-work threshold, and check cast / genre metadata.

The small demo defaults to one shared work. Its people nodes use representative film artwork rather than portraits. Your own graph depends on your imported metadata.

[Topics](../client/public/showcase/topics.png) · [Graph](../client/public/showcase/knowledge-graph.png)

<a id="viewing-desk"></a>
## 7. Choose a title with the Viewing Desk

1. Open the Viewing Desk and choose an entry such as quick selection, discovery, favorites, or unwatched.
2. Set topic conditions. If too few candidates remain, relax constraints and check the recent-watch exclusion.
3. Make pairwise choices or explore candidates to narrow the selection.
4. Inspect the familiar, exploratory, and adventurous result groups, then open a title's details to play. Resume an existing session or adjust a recent one.

This local selection flow needs no language model. The public demo blocks new choices that write data; preset results remain available. [Screenshot](../client/public/showcase/viewing-desk.png)

<a id="curator"></a>
## 8. Curator and local models

**Preview first:** without a model, open the Curator and switch between sample questions. Recommendation cards and citations demonstrate the flow. The **Fixed example · Not an AI response** label identifies prepared text that does not enter real conversations.

**Use your own collection:**

1. Follow the [model setup, in Chinese](OPERATIONS.md#可选本地馆长) to prepare Ollama, a chat model, and an embedding model. Use the address and model names actually installed.
2. Update private settings, restart the service, and check the connection in the Curator.
3. Load the model manually, complete the library index, and create a conversation.
4. Try a request such as “Recommend a few unwatched adventure titles.” Use @, /, and # for entities, intents, and constraints, then ask follow-up questions.
5. Inspect citations and open the suggested titles. Review confirmation cards before a proposed change.

Models are not installed with the repository. A remote Ollama receives relevant queries and context. The public demo does not call a model. [Example](screenshots/curator-demo.png)

<a id="personal-library"></a>
## 9. Favorites, playlists, history, and users

1. Favorite a work or topic and find it on the personal page. Work and topic favorites are organized separately.
2. Use the playlist action to choose or create a list, then manage its contents from the personal page.
3. Review continue-watching items, history, and the journal. Check the active user before clearing records or changing watched state.
4. Open the user control in the header to create or switch persistent profiles, each keeping its own favorites, lists, and viewing records.

Guest records are discarded when leaving guest mode or restarting the service. Profiles organize personal records; they are not enterprise account authorization. The demo supplies six work favorites, three lists, and eight viewing records; changes are not saved.

[Journal screenshot](../client/public/showcase/personal-library.png)

<a id="highlights"></a>
## 10. Save and revisit highlights

1. While playing the source, select the scissors button.
2. Enter a title and set the start and end at the current position, or enter seconds directly. Clips range from one second to 30 minutes.
3. Seek to the start to review it, then save the clip.
4. Open **My highlights** to inspect its state and play or download it when ready. For failures, check the source, FFmpeg, and clip storage, then retry.

Clips are saved independently. Removing a clip leaves the original intact. Restore disconnected clip storage before retrying. The public demo does not create clips.

<a id="maintenance"></a>
## 11. Statistics, metadata, and tasks

| Entry | How to use it |
| --- | --- |
| Analytics | Inspect years, genres, codecs, capacity, and field coverage |
| Metadata management | Filter by state and verify titles before requesting enrichment from configured services |
| Translation management | Inspect subtitle / speech task stages and queues; configure required services first |
| Compatibility center | Filter files by compatibility and schedule probing, remuxing, or transcoding as needed |
| Tasks and alerts | Read failure reasons and waiting states; restore dependencies before retrying |
| Automatic ingestion | Check source, destination, rules, and batch details; inspect audit records and file availability before rollback |

Ordinary scans and ingestion that moves files are different operations. Start management actions with a small batch. A placeholder or queued state does not mean processing has completed.

<a id="backup-migration"></a>
## 12. Backups, changing disks, and recovery

1. Open the backup center under tools, select a destination, and check space and write permissions.
2. Select scopes, run an immediate backup, and confirm completion. Configure a schedule if needed.
3. Include the database and independent attachments: artwork, subtitles, clips, and necessary settings. Check what each selected scope actually contains.
4. Stop services using the database before changing disks or restoring. Rehearse on a copy and follow the [migration guide, in Chinese](MIGRATION.md).
5. Check title counts, metadata, favorites, progress, lists, clip references, and sample playback before switching regular use.

An upgrade snapshot is not a full resource backup. Full-file fingerprints can help track moves; ambiguous duplicates are not merged automatically. Do not run two services against one database. Full-environment backups can contain private configuration and should stay in private storage.

<a id="devices-language"></a>
## 13. Phones and language

- Choose Chinese, English, or Japanese in the header. The browser remembers it without changing movie records or source identity.
- Enable LAN access while retaining pairing authentication; use the server log's pairing code. See [network configuration, in Chinese](OPERATIONS.md#媒体与目录).
- The phone navigation contains Media, Topics, Viewing Desk, Curator, and the personal page. Expand filters on narrow screens.
- Paths belong to the server. Test a few files on each device because networking, browsers, and decoding support differ.

<a id="demo"></a>
## 14. Suggested demo walkthrough

Run **pnpm demo:start** and open <http://127.0.0.1:4312>:

1. Search for **Sintel** and inspect the actual year, director, voice cast, and artwork.
2. Play the labeled 12-second compatibility clip and switch Chinese / English / Japanese subtitles and encoding.
3. Explore topics and graph relationships, then browse preset Viewing Desk results and personal records.
4. Switch between the Curator's three fixed questions and open a film card.
5. Read the source / demo notice for artwork credits, CC BY licenses, and official project links.

The in-memory database resets on restart. The server blocks imports, file management, model requests, and writes. The redacted private-library tour is also excluded from this non-adult deployment. [Demo details](../demo/README.md) · [Film sources](DEMO_FILMS.md)

<a id="troubleshooting"></a>
## 15. Troubleshooting order

Check **environment → source mounts → scan / probe state → one-file playback → subtitle track / encoding → background tasks**. Report the version, deployment method, selected playback mode, and reproduction steps. Remove private paths, credentials, pairing codes, and media content.

[Setup problems](GETTING_STARTED.en.md) · [Configuration, in Chinese](OPERATIONS.md) · [Migration, in Chinese](MIGRATION.md) · [Validation limits, in Chinese](VERIFICATION.md)
