#!/usr/bin/env python3
"""
Cacheable Eve-Survival mission page collector.

This tool is intentionally separate from EveJS runtime data. It discovers mission
URLs from Eve-Survival indexes, fetches pages with a configurable rate limit, and
stores raw HTML plus metadata locally so later parser/importer work can run from
disk.
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
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen


DEFAULT_INDEX_URL = "https://eve-survival.org/?wakka=MissionReports"
DEFAULT_CACHE_DIR = Path("workspace") / "eve-survival"
DEFAULT_USER_AGENT = "EveAnomUtility/0.1 (+local mission cache; contact: local operator)"


@dataclass(frozen=True)
class MissionLink:
    source_index_url: str
    title: str
    faction: str
    level: int
    wakka: str
    url: str
    link_label: str


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


class MissionReportsParser(HTMLParser):
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
            self._anchor = {"href": attrs_dict.get("href", ""), "text_parts": []}

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell["text_parts"].append(data)
        if self._anchor is not None:
            self._anchor["text_parts"].append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "a" and self._anchor is not None and self._cell is not None:
            text = normalize_text("".join(self._anchor["text_parts"]))
            self._cell["links"].append({"href": self._anchor["href"], "text": text})
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


def canonical_eve_survival_url(url_or_wakka: str) -> str:
    value = (url_or_wakka or "").strip()
    if not value:
        raise ValueError("empty URL/wakka value")
    if not re.match(r"^https?://", value, re.IGNORECASE):
        wakka = value
        return f"https://eve-survival.org/?{urlencode({'wakka': wakka})}"

    parsed = urlparse(value)
    query = parse_qs(parsed.query)
    wakka = first_query_value(query, "wakka")
    if wakka:
        return urlunparse(
            (
                parsed.scheme or "https",
                parsed.netloc or "eve-survival.org",
                parsed.path or "/",
                "",
                urlencode({"wakka": wakka}),
                "",
            )
        )
    return value


def first_query_value(query: dict[str, list[str]], key: str) -> str:
    for query_key, values in query.items():
        if query_key.lower() == key.lower() and values:
            return values[0]
    return ""


def wakka_from_url(url: str) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    wakka = first_query_value(query, "wakka")
    if wakka:
        return wakka
    match = re.search(r"[?&]wakka=([A-Za-z0-9_]+)", url)
    return match.group(1) if match else ""


def cache_key_for_url(url: str) -> str:
    wakka = wakka_from_url(url)
    if wakka:
        return sanitize_filename(wakka)
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    return f"url-{digest}"


def sanitize_filename(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return safe or "page"


def cache_paths(cache_dir: Path, url: str) -> dict[str, Path]:
    key = cache_key_for_url(url)
    return {
        "raw": cache_dir / "raw" / "eve-survival" / f"{key}.html",
        "metadata": cache_dir / "metadata" / "eve-survival" / f"{key}.json",
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
    canonical_url = canonical_eve_survival_url(url)
    paths = cache_paths(cache_dir, canonical_url)
    raw_path = paths["raw"]
    metadata_path = paths["metadata"]

    if raw_path.exists() and not force:
        metadata = read_json(metadata_path) if metadata_path.exists() else {}
        return {
            "url": canonical_url,
            "wakka": wakka_from_url(canonical_url),
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
            "wakka": wakka_from_url(canonical_url),
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
                "wakka": wakka_from_url(canonical_url),
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
                "wakka": metadata["wakka"],
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
        "wakka": wakka_from_url(canonical_url),
        "status": "error",
        "raw_path": str(raw_path),
        "metadata_path": str(metadata_path),
        "error": last_error,
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


def parse_missionreports_index(html_bytes: bytes, index_url: str, levels: set[int]) -> list[MissionLink]:
    parser = MissionReportsParser()
    parser.feed(html_bytes.decode("latin1", errors="replace"))

    records: list[MissionLink] = []
    seen: set[tuple[int, str]] = set()
    for row in parser.rows:
        if len(row) < 3:
            continue
        title = row[0]["text"]
        faction = row[1]["text"]
        if not title or title.lower().startswith("title "):
            continue

        for level in range(1, 6):
            if level not in levels:
                continue
            cell_index = level + 1
            if cell_index >= len(row):
                continue
            for link in row[cell_index]["links"]:
                href = link.get("href", "")
                if not href:
                    continue
                link_label = link.get("text", "")
                if not re.search(rf"\blevel\s*{level}\b", link_label, re.IGNORECASE):
                    continue
                url = canonical_eve_survival_url(urljoin(index_url, href))
                wakka = wakka_from_url(url)
                if not wakka or wakka == "MissionReports":
                    continue
                key = (level, wakka)
                if key in seen:
                    continue
                seen.add(key)
                records.append(
                    MissionLink(
                        source_index_url=index_url,
                        title=title,
                        faction=faction,
                        level=level,
                        wakka=wakka,
                        url=url,
                        link_label=link_label,
                    )
                )
    return records


def write_discovery_outputs(
    cache_dir: Path,
    records: list[MissionLink],
    levels: set[int],
    source_index_url: str,
) -> dict[str, Any]:
    generated_at = utc_now()
    manifest_dir = cache_dir / "manifests"
    url_list_dir = cache_dir / "url-lists"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    url_list_dir.mkdir(parents=True, exist_ok=True)

    records_json = [asdict(record) for record in records]
    manifest_path = manifest_dir / "missionreports-links.json"
    manifest_path.write_text(
        json.dumps(
            {
                "generated_at": generated_at,
                "source": source_index_url,
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
    all_path = url_list_dir / "missionreports-all.txt"
    all_path.write_text("\n".join(record.url for record in records) + ("\n" if records else ""), encoding="utf-8")
    list_paths["all"] = str(all_path)

    for level in sorted(levels):
        level_records = [record for record in records if record.level == level]
        level_path = url_list_dir / f"missionreports-level-{level}.txt"
        level_path.write_text(
            "\n".join(record.url for record in level_records) + ("\n" if level_records else ""),
            encoding="utf-8",
        )
        list_paths[str(level)] = str(level_path)

    return {
        "generated_at": generated_at,
        "manifest_path": str(manifest_path),
        "url_lists": list_paths,
        "count": len(records),
        "counts_by_level": {
            str(level): sum(1 for record in records if record.level == level)
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


def dedupe_urls(urls: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for url in urls:
        canonical = canonical_eve_survival_url(url)
        if canonical in seen:
            continue
        seen.add(canonical)
        result.append(canonical)
    return result


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
    name = manifest_name or f"fetch-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.jsonl"
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

    html_bytes = Path(index_result["raw_path"]).read_bytes()
    records = parse_missionreports_index(html_bytes, args.index_url, levels)
    output = write_discovery_outputs(cache_dir, records, levels, args.index_url)
    print(f"Discovery manifest: {output['manifest_path']}")
    for level, count in output["counts_by_level"].items():
        print(f"  Level {level}: {count} URLs -> {output['url_lists'][level]}")
    print(f"  All selected: {output['count']} URLs -> {output['url_lists']['all']}")
    return 0


def run_crawl_missionreports(args: argparse.Namespace) -> int:
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

    records = parse_missionreports_index(Path(index_result["raw_path"]).read_bytes(), args.index_url, levels)
    output = write_discovery_outputs(cache_dir, records, levels, args.index_url)
    print(f"Discovery manifest: {output['manifest_path']}")
    for level, count in output["counts_by_level"].items():
        print(f"  Level {level}: {count} URLs -> {output['url_lists'][level]}")
    print(f"  All selected: {output['count']} URLs -> {output['url_lists']['all']}")
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
    parser.add_argument("urls", nargs="*", help="URLs or Eve-Survival wakka keys to fetch.")
    parser.add_argument("--url", action="append", help="Additional URL or wakka key. Repeatable.")
    parser.add_argument("--input", action="append", help="Text URL list or discovery JSON manifest. Repeatable.")
    parser.add_argument("--force", action="store_true", help="Refetch even if raw HTML already exists.")
    parser.add_argument("--limit", type=int, default=0, help="Fetch only the first N URLs after dedupe.")
    parser.add_argument("--dry-run", action="store_true", help="Print cache/fetch decisions without network fetches.")
    parser.add_argument("--manifest-name", default="", help="Optional fetch manifest file name under cache manifests/.")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Discover and locally cache Eve-Survival mission pages.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    discover = subparsers.add_parser("discover", help="Generate local URL lists from MissionReports.")
    discover.add_argument("--index-url", default=DEFAULT_INDEX_URL, help="Mission index URL to parse.")
    discover.add_argument("--levels", default="1-5", help="Mission levels to include, e.g. 1,2,4-5.")
    discover.add_argument("--force-index", action="store_true", help="Refetch the index page before parsing.")
    add_common_network_args(discover)
    discover.set_defaults(func=run_discover)

    fetch = subparsers.add_parser("fetch", help="Fetch supplied URLs/wakka keys into the local cache.")
    add_common_network_args(fetch)
    add_fetch_args(fetch)
    fetch.set_defaults(func=run_fetch)

    crawl = subparsers.add_parser("crawl-missionreports", help="Discover MissionReports URLs, then fetch them.")
    crawl.add_argument("--index-url", default=DEFAULT_INDEX_URL, help="Mission index URL to parse.")
    crawl.add_argument("--levels", default="1-5", help="Mission levels to include, e.g. 1,2,4-5.")
    crawl.add_argument("--force-index", action="store_true", help="Refetch the index page before parsing.")
    add_common_network_args(crawl)
    add_fetch_args(crawl)
    crawl.set_defaults(func=run_crawl_missionreports)

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
