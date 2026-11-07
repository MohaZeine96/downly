# downly build with electron

An Internet Download Manager style downloader with browser integration.

## Run

```
npm install
npm start
```

Build an installer: `npm run dist`

## Browser extension (Chrome / Edge / Brave / Opera)

1. Start the app (it listens on 127.0.0.1:7395, changeable in Options -> Browser).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, pick the `extension/` folder
   (Options -> Browser -> "Open browser extension folder" opens it).
3. Downloads of the configured file types are captured automatically; right-click any link/video/image ->
   "Download with IDM Clone"; right-click a page -> "Download all links on this page";
   the toolbar popup lists videos/audio detected on the current page.
   If the app is not running, the browser keeps handling downloads itself.
   Only extension origins may talk to the local server (web pages get 403).

## Features

Engine: segmented multi-connection downloads (up to 32) with dynamic re-segmentation (idle connections take over half of the
slowest range), pause/resume (survives restarts), auto-retry, redirects, per-download and global speed limits,
HLS (.m3u8) streams incl. AES-128 and master playlists, HTTP/HTTPS proxy (with auth), HTTP Basic site passwords
(OS-keychain encrypted), referer/cookie/user-agent per download, refresh expired address.
Organisation: automatic category folders, duplicate detection, rename-or-overwrite policy, multiple queues,
scheduler (start/stop time, weekdays, per-queue parallelism), finish action (exit/sleep/hibernate/shutdown with 30s cancel).
Tools: site grabber (crawler with depth + file type filters), batch download from [001-100] / [a-z] patterns,
import/export list, drag & drop links, clipboard link monitor, antivirus/post-download command.
UI: dark/light theme, sidebar filters, sortable columns, context menu, per-connection progress view, live speed graph,
tray icon, notifications + sound, start with OS.

## Not included

FTP, Firefox/Safari extension, DASH (.mpd) and live streams, DRM-protected media, video conversion.
