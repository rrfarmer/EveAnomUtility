#!/usr/bin/env python3
"""
Cacheable EVE site-family collector.

This utility is separate from both mission collectors. It uses Eve University's
MediaWiki category API to discover non-mission site pages such as combat
anomalies, DED/unrated complexes, expeditions, data/relic/gas/ore sites,
wormhole sites, and incursion sites. It then caches raw page HTML locally for
later parser/importer work.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, unquote, urlparse, urlunparse
from urllib.request import Request, urlopen


BASE_URL = "https://wiki.eveuniversity.org"
API_URL = f"{BASE_URL}/api.php"
DEFAULT_CACHE_DIR = Path("workspace") / "eve-site-families" / "eve-university"
DEFAULT_USER_AGENT = "EveAnomUtility/0.1 (+local non-mission site cache)"

DEFAULT_ROOT_CATEGORIES = [
    "Cosmic Anomalies",
    "Cosmic Signatures",
    "Expeditions",
    "Wormhole sites",
    "Incursions sites",
]

DEFAULT_SEED_PAGES = [
    "Abyssal Deadspace",
]


@dataclass
class SitePageRecord:
    title: str
    url: str
    pageid: int | None = None
    source_categories: set[str] = field(default_factory=set)
    root_categories: set[str] = field(default_factory=set)
    source_pages: set[str] = field(default_factory=set)

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["source_categories"] = sorted(self.source_categories)
        payload["root_categories"] = sorted(self.root_categories)
        payload["source_pages"] = sorted(self.source_pages)
        return payload


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


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def normalize_category(value: str) -> str:
    category = normalize_text(value)
    return re.sub(r"^Category:", "", category, flags=re.IGNORECASE).strip()


def title_to_url(title: str) -> str:
    page = normalize_text(title).replace(" ", "_")
    if not page:
        raise ValueError("empty Eve University page title")
    return f"{BASE_URL}/{quote(page, safe=':/()!,.')}"


def canonical_eve_university_url(url_or_title: str) -> str:
    value = normalize_text(url_or_title)
    if not value:
        raise ValueError("empty URL/title value")
    if not re.match(r"^https?://", value, re.IGNORECASE):
        return title_to_url(value)

    parsed = urlparse(value)
    if parsed.netloc.lower() != "wiki.eveuniversity.org":
        return value
    return urlunparse(("https", "wiki.eveuniversity.org", parsed.path or "/", "", "", ""))


def page_title_from_url(url: str) -> str:
    parsed = urlparse(url)
    page = parsed.path.rsplit("/", 1)[-1] if parsed.path else ""
    return unquote(page).replace("_", " ") or url


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


def category_metadata_path(cache_dir: Path, category: str) -> Path:
    return cache_dir / "metadata" / "categories" / f"{sanitize_filename(category)}.json"


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


def mediawiki_api_get(
    params: dict[str, str],
    *,
    rate_limiter: RateLimiter,
    timeout_seconds: float,
    retries: int,
    retry_delay_seconds: float,
    user_agent: str,
) -> dict[str, Any]:
    final_params = dict(params)
    final_params["format"] = "json"
    url = f"{API_URL}?{urlencode(final_params)}"
    last_error = ""
    for attempt in range(retries + 1):
        try:
            rate_limiter.wait()
            _, _, _, body = http_get(url, timeout_seconds, user_agent)
            return json.loads(body.decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            last_error = str(error)
            if attempt < retries:
                time.sleep(retry_delay_seconds * (2 ** attempt))
    raise RuntimeError(f"MediaWiki API request failed: {last_error}")


def fetch_category_members(
    category: str,
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
    category = normalize_category(category)
    path = category_metadata_path(cache_dir, category)
    if path.exists() and not force:
        return read_json(path)
    if offline:
        raise RuntimeError(f"category cache missing and --offline was set: {category}")

    members: list[dict[str, Any]] = []
    continuation: dict[str, str] = {}
    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{category}",
            "cmnamespace": "0|14",
            "cmlimit": "500",
        }
        params.update(continuation)
        payload = mediawiki_api_get(
            params,
            rate_limiter=rate_limiter,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
            user_agent=user_agent,
        )
        members.extend(payload.get("query", {}).get("categorymembers", []))
        if "continue" not in payload:
            break
        continuation = payload["continue"]

    result = {
        "category": category,
        "fetched_at": utc_now(),
        "page_count": sum(1 for member in members if member.get("ns") == 0),
        "subcategory_count": sum(1 for member in members if member.get("ns") == 14),
        "members": members,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def add_page_record(
    records: dict[str, SitePageRecord],
    *,
    title: str,
    pageid: int | None = None,
    source_category: str = "",
    root_category: str = "",
    source_page: str = "",
) -> None:
    url = title_to_url(title)
    key = page_key_from_url(url)
    record = records.get(key)
    if not record:
        record = SitePageRecord(title=normalize_text(title), url=url, pageid=pageid)
        records[key] = record
    if pageid is not None:
        record.pageid = pageid
    if source_category:
        record.source_categories.add(normalize_category(source_category))
    if root_category:
        record.root_categories.add(normalize_category(root_category))
    if source_page:
        record.source_pages.add(normalize_text(source_page))


def discover_site_pages(args: argparse.Namespace) -> tuple[list[SitePageRecord], dict[str, Any]]:
    cache_dir = Path(args.cache_dir)
    rate_limiter = RateLimiter(args.rate_per_minute)
    categories = []
    if not args.no_defaults:
        categories.extend(DEFAULT_ROOT_CATEGORIES)
    categories.extend(args.category or [])
    categories = dedupe_categories(categories)

    records: dict[str, SitePageRecord] = {}
    category_graph: dict[str, dict[str, Any]] = {}
    visited: set[str] = set()
    queue: list[tuple[str, str, int]] = [(category, category, 0) for category in categories]

    while queue:
        category, root_category, depth = queue.pop(0)
        category = normalize_category(category)
        root_category = normalize_category(root_category)
        visit_key = f"{root_category}\0{category}"
        if visit_key in visited:
            continue
        visited.add(visit_key)

        category_payload = fetch_category_members(
            category,
            cache_dir=cache_dir,
            rate_limiter=rate_limiter,
            timeout_seconds=args.timeout,
            retries=args.retries,
            retry_delay_seconds=args.retry_delay,
            user_agent=args.user_agent,
            force=args.force_categories,
            offline=args.offline,
        )
        category_graph[visit_key] = {
            "category": category,
            "root_category": root_category,
            "depth": depth,
            "page_count": category_payload["page_count"],
            "subcategory_count": category_payload["subcategory_count"],
        }

        for member in category_payload.get("members", []):
            ns = member.get("ns")
            title = member.get("title", "")
            if ns == 0 and title:
                add_page_record(
                    records,
                    title=title,
                    pageid=member.get("pageid"),
                    source_category=category,
                    root_category=root_category,
                )
            elif ns == 14 and title and args.recursive and depth < args.max_depth:
                child = normalize_category(title)
                queue.append((child, root_category, depth + 1))

    seed_pages = []
    if not args.no_defaults:
        seed_pages.extend(DEFAULT_SEED_PAGES)
    seed_pages.extend(args.page or [])
    for page in seed_pages:
        add_page_record(records, title=page, source_page="seed-page")

    return sorted(records.values(), key=lambda record: record.title.lower()), {
        "category_graph": list(category_graph.values()),
        "root_categories": categories,
        "seed_pages": seed_pages,
    }


def dedupe_categories(categories: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for category in categories:
        normalized = normalize_category(category)
        if not normalized or normalized.lower() in seen:
            continue
        seen.add(normalized.lower())
        result.append(normalized)
    return result


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


def write_discovery_outputs(cache_dir: Path, records: list[SitePageRecord], discovery: dict[str, Any]) -> dict[str, Any]:
    generated_at = utc_now()
    manifest_dir = cache_dir / "manifests"
    url_list_dir = cache_dir / "url-lists"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    url_list_dir.mkdir(parents=True, exist_ok=True)

    records_json = [record.to_json() for record in records]
    manifest_path = manifest_dir / "site-family-links.json"
    manifest_path.write_text(
        json.dumps(
            {
                "generated_at": generated_at,
                "source": "https://wiki.eveuniversity.org categories via MediaWiki API",
                "scope": "Non-mission site-family pages",
                "root_categories": discovery["root_categories"],
                "seed_pages": discovery["seed_pages"],
                "category_graph": discovery["category_graph"],
                "count": len(records_json),
                "records": records_json,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    all_urls = [record.url for record in records]
    all_path = url_list_dir / "site-family-all.txt"
    all_path.write_text("\n".join(all_urls) + ("\n" if all_urls else ""), encoding="utf-8")

    root_paths: dict[str, str] = {}
    for root_category in discovery["root_categories"]:
        root_urls = [
            record.url
            for record in records
            if normalize_category(root_category) in record.root_categories
        ]
        path = url_list_dir / f"site-family-root-{sanitize_filename(root_category)}.txt"
        path.write_text("\n".join(root_urls) + ("\n" if root_urls else ""), encoding="utf-8")
        root_paths[root_category] = str(path)

    return {
        "generated_at": generated_at,
        "manifest_path": str(manifest_path),
        "url_lists": {"all": str(all_path), **root_paths},
        "count": len(records),
        "counts_by_root": {
            root: sum(1 for record in records if normalize_category(root) in record.root_categories)
            for root in discovery["root_categories"]
        },
        "category_count": len(discovery["category_graph"]),
    }


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
                "title": page_title_from_url(canonical_url),
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
    name = manifest_name or f"site-family-fetch-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.jsonl"
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


def run_discover(args: argparse.Namespace) -> int:
    records, discovery = discover_site_pages(args)
    output = write_discovery_outputs(Path(args.cache_dir), records, discovery)
    print(f"Discovery manifest: {output['manifest_path']}")
    print(f"  Categories walked: {output['category_count']}")
    for root, count in output["counts_by_root"].items():
        print(f"  {root}: {count} pages -> {output['url_lists'][root]}")
    print(f"  All selected: {output['count']} unique pages -> {output['url_lists']['all']}")
    return 0


def run_crawl(args: argparse.Namespace) -> int:
    records, discovery = discover_site_pages(args)
    output = write_discovery_outputs(Path(args.cache_dir), records, discovery)
    print(f"Discovery manifest: {output['manifest_path']}")
    print(f"  Categories walked: {output['category_count']}")
    for root, count in output["counts_by_root"].items():
        print(f"  {root}: {count} pages -> {output['url_lists'][root]}")
    print(f"  All selected: {output['count']} unique pages -> {output['url_lists']['all']}")
    return run_fetch(args, [record.url for record in records])


def add_common_network_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE_DIR), help="Local cache root.")
    parser.add_argument("--rate-per-minute", type=float, default=30.0, help="Maximum network/API requests per minute.")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout in seconds.")
    parser.add_argument("--retries", type=int, default=2, help="Retries per request after the first attempt.")
    parser.add_argument("--retry-delay", type=float, default=2.0, help="Initial retry delay in seconds; doubles each retry.")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="HTTP User-Agent header.")
    parser.add_argument("--offline", action="store_true", help="Only read local cache; fail missing entries.")


def add_discovery_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--category", action="append", help="Additional Eve University category. Repeatable.")
    parser.add_argument("--page", action="append", help="Additional Eve University seed page title. Repeatable.")
    parser.add_argument("--no-defaults", action="store_true", help="Do not include the built-in category/page seeds.")
    parser.add_argument("--no-recursive", dest="recursive", action="store_false", help="Do not walk subcategories.")
    parser.add_argument("--max-depth", type=int, default=4, help="Maximum subcategory recursion depth.")
    parser.add_argument("--force-categories", action="store_true", help="Refetch category API data before discovery.")
    parser.set_defaults(recursive=True)


def add_fetch_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("urls", nargs="*", help="URLs or Eve University page titles to fetch.")
    parser.add_argument("--url", action="append", help="Additional URL or page title. Repeatable.")
    parser.add_argument("--input", action="append", help="Text URL list or discovery JSON manifest. Repeatable.")
    parser.add_argument("--force", action="store_true", help="Refetch pages even if raw HTML already exists.")
    parser.add_argument("--limit", type=int, default=0, help="Fetch only the first N URLs after dedupe.")
    parser.add_argument("--dry-run", action="store_true", help="Print cache/fetch decisions without page fetches.")
    parser.add_argument("--manifest-name", default="", help="Optional fetch manifest file name under cache manifests/.")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Discover and locally cache non-mission EVE site-family pages.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    discover = subparsers.add_parser("discover", help="Discover site-family URLs from Eve University categories.")
    add_common_network_args(discover)
    add_discovery_args(discover)
    discover.set_defaults(func=run_discover)

    fetch = subparsers.add_parser("fetch", help="Fetch supplied URLs/page titles into the local cache.")
    add_common_network_args(fetch)
    add_fetch_args(fetch)
    fetch.set_defaults(func=run_fetch)

    crawl = subparsers.add_parser("crawl", help="Discover site-family URLs, then fetch them.")
    add_common_network_args(crawl)
    add_discovery_args(crawl)
    add_fetch_args(crawl)
    crawl.set_defaults(func=run_crawl)

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
