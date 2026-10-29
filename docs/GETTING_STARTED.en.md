# Start with the folders you already have

The web preview samples up to 300 directory entries and reports videos, subtitles and metadata; it is not a full inventory. For an empty new library, local metadata and subtitles become available before full-file fingerprinting completes. Existing libraries retain conservative migration matching.

Matching subtitles can be placed next to the video or in its `Subs` or `Subtitles` subfolder, for example `Subs/Sample-001.zh-Hant.srt`. Ambiguous versions are left unmatched rather than guessed.

To access WebDAV or other supported remote storage today, configure a third-party mount such as [rclone](https://rclone.org/commands/rclone_mount/) and connect its local mount path as a regular folder. For example, after configuring `myremote` and creating an empty mount directory, run `rclone mount myremote: /absolute/path/to/mount --read-only`. Keep it running, check permissions, and for Docker bind-mount it read-only before starting the container. This is not a native connector: seeking and availability depend on the mount and remote, and first-time full-file hashing can consume substantial traffic. Never commit credentials or mount configuration.

Continue with the [feature guide](USER_GUIDE.en.md), [playback](USER_GUIDE.en.md#playback), [subtitles](USER_GUIDE.en.md#subtitles), or [documentation index](README.en.md).

[简体中文](GETTING_STARTED.md) · [English](GETTING_STARTED.en.md) · [日本語](GETTING_STARTED.ja.md)

Alexandria 18+ is a personal media library. Start with one folder containing a few titles, check playback and subtitles, then add the rest. For a preview without personal media, run the separate non-adult demo with `pnpm demo:start`.

## 1. Prepare the environment

Install Node.js 22, pnpm 11.7.0, FFmpeg, and FFprobe. From the project root:

```sh
corepack pnpm@11.7.0 install --frozen-lockfile
pnpm doctor
```

`doctor` only checks the environment. It installs nothing, starts no service, and does not read a database. Install missing tools first; a missing production build is resolved later with `pnpm build`.

## 2. Choose how to connect

### Already running: use the web wizard

1. Choose the UI language at the top of the home page, then select **Connect library**. An empty library also shows a welcome card.
2. Enter an absolute media folder path. Add multiple folders if needed. Keep the source name and category when changing disks; JSON editing is not required.
3. Select **Preview import and relocation**. Check readability and the number of records to retain. Unreadable folders cannot be saved; empty folders require explicit acknowledgment.
4. Select **Back up and start scanning**. The database is backed up before indexing. Ordinary scans do not move, rename, or rewrite media.
5. Return to the media wall, open a title, and check playback, subtitle tracks, and encoding. Progress is available in the header and **Tasks and alerts**.

Most users do not need the advanced two-root layout. Saving that specialized configuration replaces the general media sources.

### Fresh installation: use the script

```sh
# Read-only preview. Repeat --source for more folders; quote paths with spaces.
pnpm setup:library --source "/absolute/path/to/media" --dry-run --lang en
# After reviewing, explicitly create the initial private settings:
pnpm setup:library --source "/absolute/path/to/media" --write --lang en
pnpm build
pnpm start
```

Open <http://127.0.0.1:4310>, or the port configured in `.env`. The script supports `--lang zh-CN|en|ja`. Run `pnpm setup:library --lang en` in an interactive terminal to enter folders one at a time; this still only previews.

The script samples at most 300 directory entries and reports video, subtitle, and metadata counts. **This is not a full scan.** Writing creates private settings and a missing `.env`, while preserving any existing `.env`. It does not install models or copy media. Existing databases, source settings, and demo mode prevent overwriting; use the web wizard instead.

The default output is the Git-ignored `.local/data/library-sources.json`, or the directory selected by `DATA_DIR`. Keep application data outside the folders being scanned.

## 3. Local metadata and subtitles

Example layout; these files are not distributed with the project:

```text
media/
└── Sample-001/
    ├── Sample-001.mp4
    ├── Sample-001.nfo
    ├── Sample-001.media.json
    ├── Sample-001-poster.jpg
    └── Sample-001.zh.srt
```

You can index and play files without sidecars. Local artwork and NFO / JSON do not need a network connection. JSON overrides NFO by field; manual corrections take precedence. External subtitles support SRT / ASS / SSA / VTT and selectable encodings. Embedded MKV / MP4 text subtitles need FFprobe and FFmpeg; image subtitles are not supported.

## 4. NAS and Docker paths

| Deployment | Path to enter |
| --- | --- |
| Server and files on the same machine | The absolute media path on that machine |
| Mounted NAS, SMB, NFS, or cloud drive | Mount it in the server OS first, then enter the mount path |
| Docker | The container path, such as `/media`, rather than the host path |
| Phone or another computer browsing | The path still belongs to the server, not the browser device |

The supplied Compose file mounts `ALEXANDRIA_MEDIA_DIR` read-only at `/media`. See Docker commands in the README. For multiple mounts, add them explicitly to Compose, then register their container paths in the app. Native WebDAV / Emby / Jellyfin connectors are not implemented.

## 5. Troubleshooting

- **Folder not found:** check the server machine, container mounts, and read permissions. Browsers cannot pick server folders directly; paste the absolute path.
- **Script refuses to overwrite:** use the web preview and backup flow for an existing collection. Do not delete the database to bypass the check.
- **Slow scan:** the first scan reads metadata and computes full-file fingerprints. Large NAS collections can take time; start small.
- **No poster:** check matching filenames and single-video folder naming rules, then metadata quality. Without a configured external service, metadata is not enriched over the network.
- **Garbled or differently styled subtitles:** select an encoding in the player. ASS / SSA conversion loses complex effects; image subtitles require separate OCR.
- **Phone asks for pairing:** use the six-digit code in the server terminal. See [LAN configuration, in Chinese](OPERATIONS.md).
- **No model:** browsing, playback, organization, and the Viewing Desk work without one. The Curator shows labeled fixed examples.

Before changing storage or restoring data, read the [migration guide, in Chinese](MIGRATION.md). See [internationalization development notes](I18N.md) to extend translations.
