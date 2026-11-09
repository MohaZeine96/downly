# Downly

An Internet Download Manager style downloader with browser integration.

## Run

```
npm install
npm start
```

Build an installer: `npm run dist`. Windows builds bundle `yt-dlp.exe` and `ffmpeg.exe` from the project root.

## Browser extension (Chrome / Edge / Brave / Opera)

Create a distributable ZIP with `npm run package:extension`. It is written to
`dist/Downly-Browser-Extension-1.0.0.zip` with `manifest.json` at the archive root.
To install locally, extract the ZIP, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
and select the extracted folder. To publish through the Chrome Web Store, upload the ZIP package.
The app's Options -> Browser -> "Open browser extension folder" opens the source extension folder.

1. Start the app (it listens on 127.0.0.1:7395, changeable in Options -> Browser).
2. Use the installed extension:
3. Downloads of the configured file types are captured automatically; right-click any link/video/image ->
   "Download with Downly"; right-click a page -> "Download all links on this page";
   the toolbar popup lists videos/audio detected on the current page.
   If the app is not running, the browser keeps handling downloads itself.
   Only extension origins may talk to the local server (web pages get 403).

## Features

Engine: segmented multi-connection downloads (up to 32) with dynamic re-segmentation (idle connections take over half of the
slowest range), pause/resume (survives restarts), auto-retry, redirects, per-download and global speed limits,
HLS (.m3u8) streams incl. AES-128 and master playlists, yt-dlp support for video-sharing sites and YouTube Music,
video resolution selection and MP3 audio extraction with selectable bitrate; yt-dlp downloads embed the video thumbnail as cover art,
including in extracted MP3 files. HTTP/HTTPS proxy (with auth), HTTP Basic site passwords
(OS-keychain encrypted), referer/cookie/user-agent per download, refresh expired address.
MP3 audio extraction uses the bundled FFmpeg 9.0.2 LGPL v3+ build. Its Windows binary is from
[FFmpeg-Builds](https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/latest) (archive SHA-256:
`2d211b9e1e33d49b26f0b52828690303690117673f83061fee8695e6a91a7c8e`).
The corresponding [FFmpeg source commit](https://github.com/FFmpeg/FFmpeg/commit/d4070a14ce) and build recipes
are available online. The installer includes `FFmpeg-LICENSE.txt`.
Organisation: automatic category folders, duplicate detection, rename-or-overwrite policy, multiple queues,
scheduler (start/stop time, weekdays, per-queue parallelism), finish action (exit/sleep/hibernate/shutdown with 30s cancel).
Tools: site grabber (crawler with depth + file type filters), batch download from [001-100] / [a-z] patterns,
import/export list, drag & drop links, clipboard link monitor, antivirus/post-download command.
UI: dark/light theme, sidebar filters, sortable columns, context menu, per-connection progress view, live speed graph,
tray icon, notifications + sound, start with OS.

## Not included

FTP, Firefox/Safari extension, DASH (.mpd) and live streams, DRM-protected media, video conversion.
