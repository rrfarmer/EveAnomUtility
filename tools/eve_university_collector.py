#!/usr/bin/env python3
"""
Cacheable Eve University mission page collector.

This is intentionally separate from the Eve-Survival collector. It discovers
Security mission report pages from Eve University's MediaWiki mission index,
fetches pages with a configurable rate limit, and stores raw HTML plus metadata
locally for repeatable parser/importer work.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen


BASE_URL = "https://wiki.eveuniversity.org"
DEFAULT_INDEX_URL = f"{BASE_URL}/Mission_reports"
DEFAULT_CACHE_DIR = Path("workspace") / "eve-university"
DEFAULT_USER_AGENT = "EveAnomUtility/0.1 (+local Eve University mission cache)"


@dataclass(frozen=True)
class EveUniversityMissionLink:
    source_index_url: str
    title: str
    enemy_faction: str
    level: int
    url: str
    page_key: str


class RateLimiter:
    def __init__(self, per_minute: float) -> None:
        if per_minute <= 0:
            raise ValueError("--rate-per-minute must be greater than zero")
        self.interval_seconds = 60.0 / per_minute
        self.next_at = 0.0

    def wait(self) -> None:
        now = time.monotonic()
        if self.next_at > now:
            time.sleep(self.next_at - now)
        self.next_at = time.monotonic() + self.interval_seconds


class TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[dict[str, Any]]] = []
        self._row: list[dict[str, Any]] | None = None
        self._cell: dict[str, Any] | None = None
        self._anchor: dict[str, Any] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {key.lower(): value or "" for key, value in attrs}
        tag = tag.lower()
        if tag == "tr":
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell = {"text_parts": [], "links": []}
        elif tag == "a" and self._cell is not None:
            self._anchor = {
                "href": attrs_dict.get("href", ""),
                "title": attrs_dict.get("title", ""),
                "text_parts": [],
            }

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell["text_parts"].append(data)
        if self._anchor is not None:
            self._anchor["text_parts"].append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "a" and self._anchor is not None and self._cell is not None:
            self._cell["links"].append(
                {
                    "href": self._anchor["href"],
                    "title": normalize_text(self._anchor["title"]),
                    "text": normalize_text("".join(self._anchor["text_parts"])),
                }
            )
            self._anchor = None
        elif tag in {"td", "th"} and self._cell is not None and self._row is not None:
            self._row.append(
                {
                    "text": normalize_text("".join(self._cell["text_parts"])),
                    "links": self._cell["links"],
                }
            )
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_levels(value: str) -> set[int]:
    levels: set[int] = set()
    for part in re.split(r"[,\s]+", value.strip()):
        if not part:
            continue
        if "-" in part:
            start_text, end_text = part.split("-", 1)
            start = int(start_text)
            end = int(end_text)
            levels.update(range(min(start, end), max(start, end) + 1))
        else:
            levels.add(int(part))
    invalid = sorted(level for level in levels if level < 1 or level > 5)
    if invalid:
        raise argparse.ArgumentTypeError(f"mission levels must be 1-5, got: {invalid}")
    return levels


def title_to_url(title: str) -> str:
    page = title.strip().replace(" ", "_")
    if not page:
        raise ValueError("empty Eve University page title")
    return f"{BASE_URL}/{quote(page, safe=':/()!,.')}"


def canonical_eve_university_url(url_or_title: str) -> str:
    value = (url_or_title or "").strip()
    if not value:
        raise ValueError("empty URL/title value")
    if not re.match(r"^https?://", value, re.IGNORECASE):
        return title_to_url(value)

    parsed = urlparse(value)
    path = parsed.path or "/"
    if parsed.netloc.lower() != "wiki.eveuniversity.org":
        return value
    return urlunparse(("https", "wiki.eveuniversity.org", path, "", "", ""))


def page_key_from_url(url: str) -> str:
    parsed = urlparse(url)
    page = parsed.path.rsplit("/", 1)[-1] if parsed.path else ""
    return unquote(page) or hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def sanitize_filename(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.()!-]+", "_", value.strip())
    return safe or "page"


def cache_paths(cache_dir: Path, url: str) -> dict[str, Path]:
    key = sanitize_filename(page_key_from_url(url))
    return {
        "raw": cache_dir / "raw" / "pages" / f"{key}.html",
        "metadata": cache_dir / "metadata" / "pages" / f"{key}.json",
    }


def http_get(url: str, timeout_seconds: float, user_agent: str) -> tuple[int, str, dict[str, str], bytes]:
    request = Request(url, headers={"User-Agent": user_agent})
    with urlopen(request, timeout=timeout_seconds) as response:
        headers = {key.lower(): value for key, value in response.headers.items()}
        return response.getcode(), response.geturl(), headers, response.read()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def fetch_url(
    url: str,
    *,
    cache_dir: Path,
    rate_limiter: RateLimiter,
    timeout_seconds: float,
    retries: int,
    retry_delay_seconds: float,
    user_agent: str,
    force: bool,
    offline: bool,
) -> dict[str, Any]:
    canonical_url = canonical_eve_university_url(url)
    paths = cache_paths(cache_dir, canonical_url)
    raw_path = paths["raw"]
    metadata_path = paths["metadata"]

    if raw_path.exists() and not force:
        metadata = read_json(metadata_path) if metadata_path.exists() else {}
        return {
            "url": canonical_url,
            "page_key": page_key_from_url(canonical_url),
            "status": "cache-hit",
            "raw_path": str(raw_path),
            "metadata_path": str(metadata_path),
            "sha256": metadata.get("sha256") or sha256_file(raw_path),
            "bytes": raw_path.stat().st_size,
            "fetched_at": metadata.get("fetched_at"),
        }

    if offline:
        return {
            "url": canonical_url,
            "page_key": page_key_from_url(canonical_url),
            "status": "missing-offline",
            "raw_path": str(raw_path),
            "metadata_path": str(metadata_path),
            "error": "cache entry is missing and --offline was set",
        }

    last_error = ""
    for attempt in range(retries + 1):
        try:
            rate_limiter.wait()
            status_code, final_url, headers, body = http_get(canonical_url, timeout_seconds, user_agent)
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_bytes(body)
            digest = hashlib.sha256(body).hexdigest()
            metadata = {
                "url": canonical_url,
                "final_url": final_url,
                "page_key": page_key_from_url(canonical_url),
                "status_code": status_code,
                "fetched_at": utc_now(),
                "sha256": digest,
                "bytes": len(body),
                "content_type": headers.get("content-type", ""),
                "etag": headers.get("etag", ""),
                "last_modified": headers.get("last-modified", ""),
                "raw_path": str(raw_path.relative_to(cache_dir)),
            }
            metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            return {
                "url": canonical_url,
                "page_key": metadata["page_key"],
                "status": "fetched",
                "raw_path": str(raw_path),
                "metadata_path": str(metadata_path),
                "sha256": digest,
                "bytes": len(body),
                "fetched_at": metadata["fetched_at"],
                "status_code": status_code,
            }
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            last_error = str(error)
            if attempt < retries:
                time.sleep(retry_delay_seconds * (2 ** attempt))

    return {
        "url": canonical_url,
        "page_key": page_key_from_url(canonical_url),
        "status": "error",
        "raw_path": str(raw_path),
        "metadata_path": str(metadata_path),
        "error": last_error,
    }


def extract_tabs_content(html_text: str, level: int) -> str:
    marker = f'tabs-content tabs-content-{level}"'
    start = html_text.find(marker)
    if start < 0:
        return ""
    next_match = re.search(r'<div class="tabs-content tabs-content-\d+"', html_text[start + len(marker) :])
    end = start + len(marker) + next_match.start() if next_match else len(html_text)
    return html_text[start:end]


def parse_security_index(html_bytes: bytes, index_url: str, levels: set[int]) -> list[EveUniversityMissionLink]:
    html_text = html_bytes.decode("utf-8", errors="replace")
    records: list[EveUniversityMissionLink] = []
    seen: set[tuple[int, str]] = set()

    for level in sorted(levels):
        content = extract_tabs_content(html_text, level)
        if not content:
            continue
        parser = TableParser()
        parser.feed(content)
        for row in parser.rows:
            if len(row) < 2:
                continue
            if row[0]["text"].lower() == "name":
                continue
            links = row[0]["links"]
            if not links:
                continue
            link = links[0]
            href = link.get("href", "")
            if not href:
                continue
            url = canonical_eve_university_url(urljoin(index_url, href))
            page_key = page_key_from_url(url)
            key = (level, page_key)
            if key in seen:
                continue
            seen.add(key)
            records.append(
                EveUniversityMissionLink(
                    source_index_url=index_url,
                    title=link.get("title") or link.get("text") or row[0]["text"],
                    enemy_faction=row[1]["text"],
                    level=level,
                    url=url,
                    page_key=page_key,
                )
            )
    return records


def dedupe_urls(urls: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for url in urls:
        canonical = canonical_eve_university_url(url)
        if canonical in seen:
            continue
        seen.add(canonical)
        result.append(canonical)
    return result


def write_discovery_outputs(
    cache_dir: Path,
    records: list[EveUniversityMissionLink],
    levels: set[int],
    source_index_url: str,
) -> dict[str, Any]:
    generated_at = utc_now()
    manifest_dir = cache_dir / "manifests"
    url_list_dir = cache_dir / "url-lists"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    url_list_dir.mkdir(parents=True, exist_ok=True)

    records_json = [asdict(record) for record in records]
    manifest_path = manifest_dir / "mission-reports-security-links.json"
    manifest_path.write_text(
        json.dumps(
            {
                "generated_at": generated_at,
                "source": source_index_url,
                "scope": "Eve University Mission reports security mission tabs",
                "levels": sorted(levels),
                "count": len(records_json),
                "records": records_json,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    list_paths: dict[str, str] = {}
    all_urls = dedupe_urls(record.url for record in records)
    all_path = url_list_dir / "security-missionreports-all.txt"
    all_path.write_text("\n".join(all_urls) + ("\n" if all_urls else ""), encoding="utf-8")
    list_paths["all"] = str(all_path)

    for level in sorted(levels):
        level_urls = dedupe_urls(record.url for record in records if record.level == level)
        level_path = url_list_dir / f"security-missionreports-level-{level}.txt"
        level_path.write_text("\n".join(level_urls) + ("\n" if level_urls else ""), encoding="utf-8")
        list_paths[str(level)] = str(level_path)

    return {
        "generated_at": generated_at,
        "manifest_path": str(manifest_path),
        "url_lists": list_paths,
        "count": len(records),
        "unique_url_count": len(all_urls),
        "counts_by_level": {
            str(level): sum(1 for record in records if record.level == level)
            for level in sorted(levels)
        },
        "unique_url_counts_by_level": {
            str(level): len(dedupe_urls(record.url for record in records if record.level == level))
            for level in sorted(levels)
        },
    }


def read_url_file(path: Path) -> list[str]:
    if path.suffix.lower() == ".json":
        payload = read_json(path)
        if isinstance(payload, dict) and isinstance(payload.get("records"), list):
            return [str(record["url"]) for record in payload["records"] if isinstance(record, dict) and record.get("url")]
        if isinstance(payload, list):
            urls: list[str] = []
            for item in payload:
                if isinstance(item, str):
                    urls.append(item)
                elif isinstance(item, dict) and item.get("url"):
                    urls.append(str(item["url"]))
            return urls
        raise ValueError(f"Could not find URLs in JSON file: {path}")

    urls = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        urls.append(line.split()[0])
    return urls


def collect_input_urls(args: argparse.Namespace) -> list[str]:
    urls: list[str] = []
    urls.extend(args.urls or [])
    urls.extend(args.url or [])
    for input_path in args.input or []:
        urls.extend(read_url_file(Path(input_path)))
    return dedupe_urls(urls)


def write_fetch_manifest(cache_dir: Path, rows: list[dict[str, Any]], manifest_name: str = "") -> Path:
    manifest_dir = cache_dir / "manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    name = manifest_name or f"eve-university-fetch-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.jsonl"
    manifest_path = manifest_dir / name
    with manifest_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")
    return manifest_path


def run_fetch(args: argparse.Namespace, urls: list[str] | None = None) -> int:
    cache_dir = Path(args.cache_dir)
    input_urls = dedupe_urls(urls if urls is not None else collect_input_urls(args))
    if args.limit:
        input_urls = input_urls[: args.limit]
    if not input_urls:
        print("No URLs supplied. Use positional URLs, --url, or --input.", file=sys.stderr)
        return 2

    if args.dry_run:
        for url in input_urls:
            paths = cache_paths(cache_dir, url)
            status = "cached" if paths["raw"].exists() and not args.force else "would-fetch"
            print(f"{status}\t{url}\t{paths['raw']}")
        return 0

    rate_limiter = RateLimiter(args.rate_per_minute)
    rows = []
    for index, url in enumerate(input_urls, start=1):
        row = fetch_url(
            url,
            cache_dir=cache_dir,
            rate_limiter=rate_limiter,
            timeout_seconds=args.timeout,
            retries=args.retries,
            retry_delay_seconds=args.retry_delay,
            user_agent=args.user_agent,
            force=args.force,
            offline=args.offline,
        )
        row["ordinal"] = index
        row["total"] = len(input_urls)
        rows.append(row)
        print(f"[{index}/{len(input_urls)}] {row['status']}: {row['url']}")
        if row.get("error"):
            print(f"  error: {row['error']}", file=sys.stderr)

    manifest_path = write_fetch_manifest(cache_dir, rows, args.manifest_name)
    fetched = sum(1 for row in rows if row["status"] == "fetched")
    cache_hits = sum(1 for row in rows if row["status"] == "cache-hit")
    errors = [row for row in rows if row["status"] in {"error", "missing-offline"}]
    print(
        f"Fetch manifest: {manifest_path}\n"
        f"Fetched: {fetched}; cache hits: {cache_hits}; errors: {len(errors)}"
    )
    return 1 if errors else 0


def run_discover_security(args: argparse.Namespace) -> int:
    levels = parse_levels(args.levels)
    cache_dir = Path(args.cache_dir)
    rate_limiter = RateLimiter(args.rate_per_minute)
    index_result = fetch_url(
        args.index_url,
        cache_dir=cache_dir,
        rate_limiter=rate_limiter,
        timeout_seconds=args.timeout,
        retries=args.retries,
        retry_delay_seconds=args.retry_delay,
        user_agent=args.user_agent,
        force=args.force_index,
        offline=args.offline,
    )
    if index_result["status"] in {"error", "missing-offline"}:
        print(f"Could not load index: {index_result.get('error')}", file=sys.stderr)
        return 1

    records = parse_security_index(Path(index_result["raw_path"]).read_bytes(), args.index_url, levels)
    output = write_discovery_outputs(cache_dir, records, levels, args.index_url)
    print(f"Discovery manifest: {output['manifest_path']}")
    for level in sorted(levels):
        key = str(level)
        count = output["counts_by_level"][key]
        unique = output["unique_url_counts_by_level"][key]
        print(f"  Level {level}: {count} rows / {unique} unique URLs -> {output['url_lists'][key]}")
    print(f"  All selected: {output['count']} rows / {output['unique_url_count']} unique URLs -> {output['url_lists']['all']}")
    return 0


def run_crawl_security(args: argparse.Namespace) -> int:
    levels = parse_levels(args.levels)
    cache_dir = Path(args.cache_dir)
    rate_limiter = RateLimiter(args.rate_per_minute)
    index_result = fetch_url(
        args.index_url,
        cache_dir=cache_dir,
        rate_limiter=rate_limiter,
        timeout_seconds=args.timeout,
        retries=args.retries,
        retry_delay_seconds=args.retry_delay,
        user_agent=args.user_agent,
        force=args.force_index,
        offline=args.offline,
    )
    if index_result["status"] in {"error", "missing-offline"}:
        print(f"Could not load index: {index_result.get('error')}", file=sys.stderr)
        return 1

    records = parse_security_index(Path(index_result["raw_path"]).read_bytes(), args.index_url, levels)
    output = write_discovery_outputs(cache_dir, records, levels, args.index_url)
    print(f"Discovery manifest: {output['manifest_path']}")
    for level in sorted(levels):
        key = str(level)
        count = output["counts_by_level"][key]
        unique = output["unique_url_counts_by_level"][key]
        print(f"  Level {level}: {count} rows / {unique} unique URLs -> {output['url_lists'][key]}")
    print(f"  All selected: {output['count']} rows / {output['unique_url_count']} unique URLs -> {output['url_lists']['all']}")
    return run_fetch(args, [record.url for record in records])


def add_common_network_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE_DIR), help="Local cache root.")
    parser.add_argument("--rate-per-minute", type=float, default=30.0, help="Maximum network fetches per minute.")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout in seconds.")
    parser.add_argument("--retries", type=int, default=2, help="Retries per URL after the first attempt.")
    parser.add_argument("--retry-delay", type=float, default=2.0, help="Initial retry delay in seconds; doubles each retry.")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="HTTP User-Agent header.")
    parser.add_argument("--offline", action="store_true", help="Only read local cache; fail missing entries.")


def add_fetch_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("urls", nargs="*", help="URLs or Eve University page titles to fetch.")
    parser.add_argument("--url", action="append", help="Additional URL or page title. Repeatable.")
    parser.add_argument("--input", action="append", help="Text URL list or discovery JSON manifest. Repeatable.")
    parser.add_argument("--force", action="store_true", help="Refetch even if raw HTML already exists.")
    parser.add_argument("--limit", type=int, default=0, help="Fetch only the first N URLs after dedupe.")
    parser.add_argument("--dry-run", action="store_true", help="Print cache/fetch decisions without network fetches.")
    parser.add_argument("--manifest-name", default="", help="Optional fetch manifest file name under cache manifests/.")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Discover and locally cache Eve University mission pages.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    discover = subparsers.add_parser("discover-security", help="Generate URL lists from Eve University's Mission reports page.")
    discover.add_argument("--index-url", default=DEFAULT_INDEX_URL, help="Mission index URL to parse.")
    discover.add_argument("--levels", default="1-5", help="Mission levels to include, e.g. 1,2,4-5.")
    discover.add_argument("--force-index", action="store_true", help="Refetch the index page before parsing.")
    add_common_network_args(discover)
    discover.set_defaults(func=run_discover_security)

    fetch = subparsers.add_parser("fetch", help="Fetch supplied URLs/page titles into the local cache.")
    add_common_network_args(fetch)
    add_fetch_args(fetch)
    fetch.set_defaults(func=run_fetch)

    crawl = subparsers.add_parser("crawl-security", help="Discover security mission URLs, then fetch them.")
    crawl.add_argument("--index-url", default=DEFAULT_INDEX_URL, help="Mission index URL to parse.")
    crawl.add_argument("--levels", default="1-5", help="Mission levels to include, e.g. 1,2,4-5.")
    crawl.add_argument("--force-index", action="store_true", help="Refetch the index page before parsing.")
    add_common_network_args(crawl)
    add_fetch_args(crawl)
    crawl.set_defaults(func=run_crawl_security)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
