<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="CrawlVault logo">
</p>

<h1 align="center">CrawlVault</h1>

<p align="center">
  <b>Keep your Google Search Console crawl stats beyond 90 days.</b><br>
  Free &amp; open-source Chrome extension by <a href="https://www.theseocentral.com/">The SEO Central</a>.<br>
  🌐 <a href="https://www.crawlgram.com/">crawlgram.com</a>
</p>

<p align="center">
  <a href="https://github.com/abhinav-krishna-cs/crawlgram/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/abhinav-krishna-cs/crawlgram?label=release&color=E31E24"></a>
  <a href="https://github.com/abhinav-krishna-cs/crawlgram/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/abhinav-krishna-cs/crawlgram/total?color=0A0A0A"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/abhinav-krishna-cs/crawlgram?color=12A150"></a>
  <a href="https://github.com/abhinav-krishna-cs/crawlgram/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/abhinav-krishna-cs/crawlgram?style=flat&color=E31E24"></a>
  <img alt="Chrome 116+" src="https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-0A0A0A">
</p>

---

## Why

Search Console's **Crawl stats** report only shows the last 90 days, and there is no API for it. Once a day drops out of that window, it's gone.

CrawlVault reads the report straight from Search Console every few weeks and stores it **in your own browser**. Each backup merges with the previous ones, so your crawl history keeps growing for months and years.

## Features

- **One-click backup** from the toolbar popup, or the **Back up crawl stats** button that appears next to *Export* on the Crawl stats page
- **All your properties** load automatically from your Search Console account
- **Reminders** before Google deletes old data (every 21 days by default), or fully **automatic backups**
- **Dashboard** with charts for crawl requests, download size and response time, month-by-month table, date ranges, and breakdowns by response code, file type, purpose, Googlebot type and host
- **Side panel** view
- **Export** any range as CSV, or the whole vault as a JSON backup you can restore later
- **Import** older crawl stats CSV / zip exports from Search Console
- **Private by design**: no servers, no accounts, no analytics. Everything stays in your browser.

## Install

### From GitHub (2 minutes)

1. Download **`crawlvault-vX.Y.Z.zip`** from the [latest release](https://github.com/abhinav-krishna-cs/crawlgram/releases/latest).
2. Unzip it.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
6. Pin CrawlVault to the toolbar and click it.

Works in Chrome 116+ and other Chromium browsers (Edge, Brave, Arc, Opera).

> To update, download the new release, replace the folder, and click the reload ↻ icon on CrawlVault in `chrome://extensions`. Your saved data is kept.

## How to use

1. Sign in to [Search Console](https://search.google.com/search-console) in Chrome.
2. Click the **CrawlVault** icon, choose a property, and click **Back up crawl stats**.
3. That's it. CrawlVault reminds you when the next backup is due.

> Crawl stats are only available for **root-level properties** (domain properties, or URL-prefix properties without a path) where you have **Full** or **Owner** access.

## Privacy

CrawlVault has no backend. It only talks to `search.google.com`, using the Search Console session you are already signed in with, and saves data to your browser's local storage (IndexedDB). Nothing is sent to The SEO Central or anyone else. See [PRIVACY.md](PRIVACY.md).

### Permissions explained

| Permission | Why |
| --- | --- |
| `search.google.com` | Read the Crawl stats report and your property list |
| `storage`, `unlimitedStorage` | Save your crawl history locally |
| `alarms`, `notifications` | Backup reminders |
| `tabs` | Open the dashboard and Search Console pages |
| `sidePanel` | Show the dashboard in Chrome's side panel |

## Project structure

```
manifest.json          Extension manifest (MV3)
background.js          Service worker: reminders, backups
content/gsc-bridge.js  Button + status panel on Search Console pages
popup/                 Toolbar popup
dashboard/             Full dashboard / side panel
lib/                   Storage (IndexedDB), parsers, helpers
```

No build step and no dependencies. Edit the files and reload the extension.

## Contributing

Bug reports and pull requests are welcome!

- **Found a bug?** [Open an issue](https://github.com/abhinav-krishna-cs/crawlgram/issues). If a backup fails, include the error message (Google sometimes changes Search Console's page data).
- **Want to help?** Fork the repo, make your change, load it unpacked to test, and open a pull request.

## Releasing (maintainers)

1. Bump `version` in `manifest.json`.
2. Commit and push to `main`. (You can also use **Actions → Release → Run workflow**.)
3. GitHub Actions builds `crawlvault-v1.0.1.zip` and publishes the release automatically.

## License

[MIT](LICENSE) © Abhinav Krishna / [The SEO Central](https://www.theseocentral.com/)

CrawlVault is not affiliated with or endorsed by Google. Google Search Console is a trademark of Google LLC.
