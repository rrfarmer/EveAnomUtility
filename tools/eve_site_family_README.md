# EVE Site-Family Collector

`eve_site_family_collector.py` is a separate Python utility for locally caching
non-mission site pages. It does not use or modify either mission scraper cache.

## Source

The default source is EVE University's MediaWiki category API. The built-in root
categories are:

- `Cosmic Anomalies`
- `Cosmic Signatures`
- `Expeditions`
- `Wormhole sites`
- `Incursions sites`

With recursive category walking, these pull in pages for combat anomalies, ore
and ice sites, DED complexes, unrated complexes, gas sites, chemical labs, data
sites, relic sites, expeditions/escalations, wormhole sites, and incursion
sites. `Abyssal Deadspace` is added as a seed page because it exists as a useful
standalone page but does not appear to be exposed through a site category.

## What It Handles

- Recursive MediaWiki category discovery
- Direct URL or page-title input
- Additional `--category` and `--page` seeds
- Configurable network/API rate limiting with `--rate-per-minute`
- Local raw HTML cache under `workspace/eve-site-families/eve-university/raw/pages/`
- Category API cache under `workspace/eve-site-families/eve-university/metadata/categories/`
- Per-page metadata under `workspace/eve-site-families/eve-university/metadata/pages/`
- Discovery and fetch manifests under `workspace/eve-site-families/eve-university/manifests/`
- Offline/cache-only reuse with `--offline`
- Refetching with `--force` or `--force-categories`

`workspace/` is already gitignored, so the fetched pages stay local.

## Common Commands

Generate URL lists without fetching every page:

```powershell
python tools/eve_site_family_collector.py discover --rate-per-minute 20
```

Discover and fetch all default non-mission site-family pages:

```powershell
python tools/eve_site_family_collector.py crawl --rate-per-minute 20
```

Fetch from the generated all-sites list:

```powershell
python tools/eve_site_family_collector.py fetch --input workspace/eve-site-families/eve-university/url-lists/site-family-all.txt --rate-per-minute 20
```

Add a category during discovery:

```powershell
python tools/eve_site_family_collector.py discover --category "Incursions" --rate-per-minute 20
```

Fetch one known page by page title:

```powershell
python tools/eve_site_family_collector.py fetch "Angel Hideaway"
```

Preview what would be fetched without network requests:

```powershell
python tools/eve_site_family_collector.py fetch --input workspace/eve-site-families/eve-university/url-lists/site-family-all.txt --dry-run
```

Reuse the local cache only:

```powershell
python tools/eve_site_family_collector.py fetch --input workspace/eve-site-families/eve-university/url-lists/site-family-all.txt --offline
```

## Cache Layout

```text
workspace/eve-site-families/eve-university/
  raw/pages/<Page_Title>.html
  metadata/categories/<Category>.json
  metadata/pages/<Page_Title>.json
  manifests/site-family-links.json
  manifests/site-family-fetch-YYYYMMDD-HHMMSS.jsonl
  url-lists/site-family-all.txt
  url-lists/site-family-root-<Category>.txt
```

The raw HTML files are the reusable source for later parsing. The JSON metadata
records original URL, final URL, fetch time, SHA-256, byte count, content type,
`ETag`, and `Last-Modified` when the server sends them.
