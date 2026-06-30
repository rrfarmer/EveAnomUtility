# Eve University Collector

`eve_university_collector.py` is a separate Python utility for creating a local,
repeatable cache of Eve University mission pages. It does not use or modify the
Eve-Survival cache.

## Source Layout

Eve University's [Mission reports](https://wiki.eveuniversity.org/Mission_reports)
page is a MediaWiki page with tabbed `wikitable` sections:

- Level 1 Missions
- Level 2 Missions
- Level 3 Missions
- Level 4 Missions
- Level 5 Missions

Each row links to a mission page and includes an enemy faction column. The
collector discovers those links, writes URL lists, and saves raw HTML pages for
later parser/importer work.

## What It Handles

- URL generation from `https://wiki.eveuniversity.org/Mission_reports`
- Direct URL or page-title input
- Text URL lists or discovery JSON as input
- Configurable network rate limiting with `--rate-per-minute`
- Local raw HTML cache under `workspace/eve-university/raw/pages/`
- Per-page metadata under `workspace/eve-university/metadata/pages/`
- Discovery and fetch manifests under `workspace/eve-university/manifests/`
- Offline/cache-only reuse with `--offline`
- Refetching with `--force` or `--force-index`

`workspace/` is already gitignored, so the fetched pages stay local.

## Common Commands

Generate URL lists for all security mission levels without fetching every page:

```powershell
python tools/eve_university_collector.py discover-security --levels 1-5 --rate-per-minute 20
```

Fetch the generated Level 1 list:

```powershell
python tools/eve_university_collector.py fetch --input workspace/eve-university/url-lists/security-missionreports-level-1.txt --rate-per-minute 20
```

Discover and fetch all security mission pages:

```powershell
python tools/eve_university_collector.py crawl-security --levels 1-5 --rate-per-minute 20
```

Fetch one known page by page title:

```powershell
python tools/eve_university_collector.py fetch "Alluring Emanations (Level 1)"
```

Preview what would be fetched without network requests:

```powershell
python tools/eve_university_collector.py fetch --input workspace/eve-university/url-lists/security-missionreports-level-4.txt --dry-run
```

Reuse the local cache only:

```powershell
python tools/eve_university_collector.py fetch --input workspace/eve-university/url-lists/security-missionreports-level-4.txt --offline
```

## Cache Layout

```text
workspace/eve-university/
  raw/pages/<Page_Title>.html
  metadata/pages/<Page_Title>.json
  manifests/mission-reports-security-links.json
  manifests/eve-university-fetch-YYYYMMDD-HHMMSS.jsonl
  url-lists/security-missionreports-level-<N>.txt
  url-lists/security-missionreports-all.txt
```

The raw HTML files are the reusable source for later parsing. The JSON metadata
records original URL, final URL, fetch time, SHA-256, byte count, content type,
`ETag`, and `Last-Modified` when the server sends them.
