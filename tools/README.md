# Eve-Survival Collector

`eve_survival_collector.py` is a small Python utility for creating a local,
repeatable cache of Eve-Survival mission pages. It does not write EveJS data and
does not apply mission templates; it only discovers URLs and saves raw source
pages plus metadata for later parser/importer work.

## What It Handles

- URL generation from `https://eve-survival.org/?wakka=MissionReports`
- Arbitrary URL or Wakka-key input via CLI args, text files, or discovery JSON
- Configurable network rate limiting with `--rate-per-minute`
- Local raw HTML cache under `workspace/eve-survival/raw/eve-survival/`
- Per-page metadata under `workspace/eve-survival/metadata/eve-survival/`
- Discovery and fetch manifests under `workspace/eve-survival/manifests/`
- Offline/cache-only reuse with `--offline`
- Refetching with `--force` or `--force-index`

`workspace/` is already gitignored, so the fetched pages stay local.
Discovery URL lists are deduped by canonical Eve-Survival URL, so duplicate
MissionReports rows do not trigger duplicate fetches.

## Common Commands

Generate URL lists for Levels 2 through 5 without fetching every mission page:

```powershell
python tools/eve_survival_collector.py discover --levels 2-5 --rate-per-minute 20
```

Fetch the generated Level 2 list:

```powershell
python tools/eve_survival_collector.py fetch --input workspace/eve-survival/url-lists/missionreports-level-2.txt --rate-per-minute 20
```

Discover and fetch Levels 2 through 5 in one pass:

```powershell
python tools/eve_survival_collector.py crawl-missionreports --levels 2-5 --rate-per-minute 20
```

Fetch one known page by Wakka key:

```powershell
python tools/eve_survival_collector.py fetch Score1gu
```

Preview what would be fetched without network requests:

```powershell
python tools/eve_survival_collector.py fetch --input workspace/eve-survival/url-lists/missionreports-level-4.txt --dry-run
```

Reuse the local cache only:

```powershell
python tools/eve_survival_collector.py fetch --input workspace/eve-survival/url-lists/missionreports-level-4.txt --offline
```

## Cache Layout

```text
workspace/eve-survival/
  raw/eve-survival/<Wakka>.html
  metadata/eve-survival/<Wakka>.json
  manifests/missionreports-links.json
  manifests/fetch-YYYYMMDD-HHMMSS.jsonl
  url-lists/missionreports-level-<N>.txt
  url-lists/missionreports-all.txt
```

The raw HTML files are the reusable source of truth for later parser work. The
JSON metadata records original URL, final URL, fetch time, SHA-256, byte count,
content type, `ETag`, and `Last-Modified` when the server sends them.
