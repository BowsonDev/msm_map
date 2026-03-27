#!/usr/bin/env python3
"""
Taiwan Listed/OTC Company Scraper
==================================
Fetches company data from TWSE (上市) and TPEX (上櫃) public APIs,
geocodes addresses via Nominatim (OpenStreetMap), and outputs:
  - data/companies.json  (app format, replaces existing)
  - data/companies_raw.csv  (all fields, for manual review)

Usage:
  pip install requests
  python scripts/fetch_companies.py

Notes:
  - Nominatim has a 1 req/sec rate limit; geocoding 500+ companies takes ~10 min.
  - Run with --no-geocode to skip geocoding (lat/lng will be blank).
  - Run with --limit N to only process first N companies (for testing).
  - Existing lat/lng in companies.json are preserved if tax_id matches.
"""

import argparse
import json
import csv
import time
import sys
import os
import re
from datetime import datetime

try:
    import requests
except ImportError:
    print("請先安裝 requests: pip install requests")
    sys.exit(1)

# ── Constants ──────────────────────────────────────────────────────────────────

TWSE_LISTED_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
TPEX_OTC_URL    = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_perday_trading_stock_info"
TPEX_BASIC_URL  = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"
NOMINATIM_URL   = "https://nominatim.openstreetmap.org/search"

HEADERS = {"User-Agent": "msm_map-scraper/1.0 (github.com/BowsonDev/msm_map)"}

# Map TWSE industry codes → our industry labels
INDUSTRY_MAP = {
    "水泥工業":     "建材營造",
    "食品工業":     "食品飲料",
    "塑膠工業":     "石化原料",
    "紡織纖維":     "紡織",
    "電機機械":     "電機機械",
    "電器電纜":     "電子零組件",
    "化學工業":     "化學工業",
    "生技醫療":     "生技醫療",
    "玻璃陶瓷":     "建材營造",
    "造紙工業":     "其他製造",
    "鋼鐵工業":     "鋼鐵金屬",
    "橡膠工業":     "其他製造",
    "汽車工業":     "汽車",
    "電子工業":     "電子零組件",
    "建材營造":     "建材營造",
    "航運業":       "航運",
    "觀光餐旅":     "觀光餐旅",
    "金融保險":     "金融",
    "貿易百貨":     "通路",
    "油電燃氣業":   "能源",
    "綜合":         "其他",
    "其他":         "其他",
    "半導體業":     "半導體製造",
    "電腦及週邊設備業": "電腦品牌",
    "光電業":       "光電零組件",
    "通信網路業":   "電信",
    "電子零組件業": "電子零組件",
    "電子通路業":   "通路",
    "資訊服務業":   "資訊服務",
    "其他電子業":   "EMS電子製造",
    "文化創意業":   "其他",
    "農業科技業":   "食品飲料",
    "電子商務":     "資訊服務",
    "綠能環保":     "能源",
    "數位雲端":     "資訊服務",
    "居家生活":     "其他",
    "運動休閒":     "其他",
    "倉儲物流業":   "航運",
}

# ── Helpers ────────────────────────────────────────────────────────────────────

def clean_number(s):
    """Remove commas/spaces from numeric strings."""
    if not s:
        return ""
    return re.sub(r"[,\s]", "", str(s))


def parse_capital(s):
    """Return capital in NTD integer, or empty string."""
    val = clean_number(s)
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return ""


def parse_revenue(s):
    """Return revenue in 億元 (100M NTD), or empty string."""
    val = clean_number(s)
    try:
        # TWSE revenue field is often in thousands NTD
        ntd_thousands = float(val)
        return round(ntd_thousands / 100_000, 1)   # thousands → 億
    except (ValueError, TypeError):
        return ""


def map_industry(raw):
    """Map raw TWSE industry string to our label."""
    if not raw:
        return "其他"
    raw = raw.strip()
    return INDUSTRY_MAP.get(raw, raw)


def geocode(address, session, delay=1.1):
    """Query Nominatim for lat/lng. Returns (lat, lng) or (None, None)."""
    query = address.strip() + " 台灣"
    try:
        r = session.get(
            NOMINATIM_URL,
            params={"q": query, "format": "json", "limit": 1, "addressdetails": 0},
            headers=HEADERS,
            timeout=10,
        )
        time.sleep(delay)
        data = r.json()
        if data:
            return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception as e:
        print(f"  ⚠ geocode error for '{address}': {e}")
    return None, None


# ── Fetch TWSE Listed Companies ────────────────────────────────────────────────

def fetch_twse_listed():
    """Returns list of dicts from TWSE openapi."""
    print("📡 Fetching TWSE listed companies…")
    try:
        r = requests.get(TWSE_LISTED_URL, headers=HEADERS, timeout=30)
        r.raise_for_status()
        data = r.json()
        print(f"  ✔ Got {len(data)} companies from TWSE")
        return data
    except Exception as e:
        print(f"  ✘ TWSE fetch failed: {e}")
        return []


def fetch_tpex_otc():
    """Returns list of dicts from TPEX openapi."""
    print("📡 Fetching TPEX OTC companies…")
    try:
        r = requests.get(TPEX_BASIC_URL, headers=HEADERS, timeout=30)
        r.raise_for_status()
        data = r.json()
        print(f"  ✔ Got {len(data)} companies from TPEX")
        return data
    except Exception as e:
        print(f"  ✘ TPEX fetch failed: {e}")
        return []


# ── Normalize ──────────────────────────────────────────────────────────────────

def extract_city_district(address):
    """Extract city and district from a Taiwan address string."""
    city = ""
    district = ""
    # Normalize 臺 → 台
    address = address.replace("臺", "台")
    m = re.match(r"^(台[北中南]市|新[北竹]市|桃園市|高雄市|基隆市|嘉義市|花蓮縣|宜蘭縣|屏東縣|台東縣|澎湖縣|金門縣|\S+[縣市])", address)
    if m:
        city = m.group(1)
    m2 = re.match(r"^\S+[縣市](\S+[區鄉鎮市])", address)
    if m2:
        district = m2.group(1)
    return city, district


def normalize_twse(raw):
    """Convert one TWSE record to our schema dict.

    TWSE t187ap03_L fields (公開資訊觀測站):
      公司代號, 公司簡稱, 住址, 營利事業統一編號, 實收資本額(元),
      電話號碼, 產業類別, 公司網址, 英文簡稱, 出表日期, 上市日期, …
    NOTE: full 公司名稱 is NOT in this endpoint; we use 公司簡稱 as name.
    """
    address   = raw.get("住址", "").strip().replace("臺", "台")
    city, district = extract_city_district(address)
    industry_raw   = raw.get("產業類別", "").strip()
    industry       = map_industry(industry_raw)

    capital_raw = clean_number(raw.get("實收資本額(元)", ""))
    try:
        capital = int(float(capital_raw))
    except (ValueError, TypeError):
        capital = ""

    stock_code   = raw.get("公司代號", "").strip()
    # t187ap03_L only has 公司簡稱, not 公司名稱
    short_name   = raw.get("公司簡稱", "").strip()
    name         = raw.get("公司名稱", short_name).strip() or short_name
    tax_id       = raw.get("營利事業統一編號", "").strip()
    phone        = raw.get("電話號碼", "").strip()
    website      = raw.get("公司網址", "").strip()
    english_name = raw.get("英文簡稱", "").strip()

    tags = [industry] if industry else []
    if industry_raw and industry_raw not in tags:
        tags.append(industry_raw)

    return {
        "id": None,
        "rank": None,
        "name": name,
        "short_name": short_name,
        "english_name": english_name,
        "tax_id": tax_id,
        "capital": capital,
        "city": city,
        "district": district,
        "address": address,
        "lat": None,
        "lng": None,
        "phone": phone,
        "website": website if website.startswith("http") else ("https://" + website if website else ""),
        "employees": "",
        "revenue_100m": "",
        "industry": industry,
        "tags": tags,
        "stock_code": stock_code,
        "listed": True,
        "notes": "",
        "_industry_raw": industry_raw,
    }


def normalize_tpex(raw):
    """Convert one TPEX record to our schema dict. Field names same as TWSE."""
    address = raw.get("住址", "").strip().replace("臺", "台")
    city, district = extract_city_district(address)

    industry_raw = raw.get("產業類別", "")
    industry = map_industry(industry_raw)

    capital_raw = clean_number(raw.get("實收資本額(元)", ""))
    try:
        capital = int(float(capital_raw))
    except (ValueError, TypeError):
        capital = ""

    stock_code = raw.get("公司代號", "").strip()
    name = raw.get("公司名稱", raw.get("公司簡稱", "")).strip()
    short_name = raw.get("公司簡稱", "").strip()
    tax_id = raw.get("營利事業統一編號", "").strip()
    phone = raw.get("電話號碼", "").strip()
    website = raw.get("公司網址", "").strip()
    english_name = raw.get("英文簡稱", "").strip()

    tags = []
    if industry:
        tags.append(industry)

    return {
        "id": None,
        "rank": None,
        "name": name or short_name,
        "short_name": short_name,
        "english_name": english_name,
        "tax_id": tax_id,
        "capital": capital,
        "city": city,
        "district": district,
        "address": address,
        "lat": None,
        "lng": None,
        "phone": phone,
        "website": website if website.startswith("http") else ("https://" + website if website else ""),
        "employees": "",
        "revenue_100m": "",
        "industry": industry,
        "tags": tags,
        "stock_code": stock_code,
        "listed": False,   # OTC
        "notes": "",
        "_industry_raw": industry_raw,
    }


# ── Load existing coords cache ─────────────────────────────────────────────────

def load_existing_coords(json_path):
    """Returns dict: tax_id -> (lat, lng) from existing companies.json."""
    coords = {}
    if not os.path.exists(json_path):
        return coords
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for c in data.get("companies", []):
            tid = c.get("tax_id", "")
            lat = c.get("lat")
            lng = c.get("lng")
            if tid and lat is not None and lng is not None:
                coords[tid] = (lat, lng)
    except Exception as e:
        print(f"  ⚠ Could not load existing coords: {e}")
    return coords


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fetch Taiwan listed company data")
    parser.add_argument("--no-geocode", action="store_true", help="Skip Nominatim geocoding")
    parser.add_argument("--limit", type=int, default=0, help="Process only first N companies (0 = all)")
    parser.add_argument("--source", choices=["twse", "tpex", "both"], default="both",
                        help="Data source: twse (上市), tpex (上櫃), or both")
    parser.add_argument("--output-json", default="data/companies.json", help="Output JSON path")
    parser.add_argument("--output-csv", default="data/companies_raw.csv", help="Output CSV path")
    parser.add_argument("--debug", action="store_true", help="Print first raw API record and exit")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root  = os.path.dirname(script_dir)
    json_path  = os.path.join(repo_root, args.output_json)
    csv_path   = os.path.join(repo_root, args.output_csv)

    # Load existing coords to avoid re-geocoding
    print("📂 Loading existing coordinate cache…")
    existing_coords = load_existing_coords(json_path)
    print(f"  ✔ {len(existing_coords)} cached coordinates found")

    # Fetch
    raw_companies = []
    if args.source in ("twse", "both"):
        twse_raw = fetch_twse_listed()
        if args.debug and twse_raw:
            print("\n── TWSE sample record ──")
            print(json.dumps(twse_raw[0], ensure_ascii=False, indent=2))
            print("────────────────────────\n")
            if args.source == "twse":
                sys.exit(0)
        for r in twse_raw:
            raw_companies.append(normalize_twse(r))
    if args.source in ("tpex", "both"):
        tpex_raw = fetch_tpex_otc()
        if args.debug and tpex_raw:
            print("\n── TPEX sample record ──")
            print(json.dumps(tpex_raw[0], ensure_ascii=False, indent=2))
            print("────────────────────────\n")
            sys.exit(0)
        for r in tpex_raw:
            raw_companies.append(normalize_tpex(r))

    # Deduplicate by tax_id (TWSE takes precedence over TPEX)
    seen_tax = {}
    deduped = []
    for c in raw_companies:
        tid = c["tax_id"]
        if tid and tid in seen_tax:
            continue
        if tid:
            seen_tax[tid] = True
        deduped.append(c)

    # Filter out companies with no name
    deduped = [c for c in deduped if c["name"]]

    # Apply limit
    if args.limit > 0:
        deduped = deduped[:args.limit]

    print(f"\n📊 {len(deduped)} unique companies to process")

    # Assign IDs / ranks
    for i, c in enumerate(deduped, start=1):
        c["id"]   = i
        c["rank"] = i

    # Geocode
    if not args.no_geocode:
        session = requests.Session()
        need_geocode = [c for c in deduped if c["tax_id"] not in existing_coords and c["address"]]
        from_cache   = [c for c in deduped if c["tax_id"] in existing_coords]
        no_address   = [c for c in deduped if not c["address"] and c["tax_id"] not in existing_coords]

        print(f"\n🌍 Geocoding:")
        print(f"  From cache : {len(from_cache)}")
        print(f"  Need fetch : {len(need_geocode)}")
        print(f"  No address : {len(no_address)}")

        # Restore cached coords
        for c in deduped:
            if c["tax_id"] in existing_coords:
                c["lat"], c["lng"] = existing_coords[c["tax_id"]]

        # Geocode new ones
        for i, c in enumerate(need_geocode, start=1):
            print(f"  [{i}/{len(need_geocode)}] {c['name'][:20]}…", end=" ", flush=True)
            lat, lng = geocode(c["address"], session)
            if lat:
                c["lat"] = round(lat, 6)
                c["lng"] = round(lng, 6)
                print(f"({lat:.4f}, {lng:.4f})")
            else:
                print("(no result)")
    else:
        print("\n⏭ Skipping geocoding (--no-geocode)")
        for c in deduped:
            if c["tax_id"] in existing_coords:
                c["lat"], c["lng"] = existing_coords[c["tax_id"]]

    # Build final company objects (clean internal fields)
    companies = []
    for c in deduped:
        companies.append({
            "id":           c["id"],
            "rank":         c["rank"],
            "name":         c["name"],
            "short_name":   c["short_name"],
            "english_name": c["english_name"],
            "tax_id":       c["tax_id"],
            "capital":      c["capital"],
            "city":         c["city"],
            "district":     c["district"],
            "address":      c["address"],
            "lat":          c["lat"],
            "lng":          c["lng"],
            "phone":        c["phone"],
            "website":      c["website"],
            "employees":    c["employees"],
            "revenue_100m": c["revenue_100m"],
            "industry":     c["industry"],
            "tags":         c["tags"],
            "stock_code":   c["stock_code"],
            "listed":       c["listed"],
            "notes":        c["notes"],
        })

    # Write JSON
    output = {
        "version":    2,
        "updated_at": datetime.now().strftime("%Y-%m-%d"),
        "companies":  companies,
    }
    os.makedirs(os.path.dirname(json_path), exist_ok=True)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n✅ Wrote {len(companies)} companies → {json_path}")

    # Write CSV (for manual review / re-import)
    fieldnames = [
        "id","rank","name","short_name","english_name","tax_id","capital",
        "city","district","address","lat","lng","phone","website",
        "employees","revenue_100m","industry","tags","stock_code","listed","notes"
    ]
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for c in companies:
            row = dict(c)
            row["tags"] = ",".join(c.get("tags", []))
            writer.writerow(row)
    print(f"✅ Wrote CSV → {csv_path}")

    # Summary
    geocoded = sum(1 for c in companies if c["lat"] is not None)
    no_coord = sum(1 for c in companies if c["lat"] is None)
    print(f"\n📈 Summary:")
    print(f"  Total companies : {len(companies)}")
    print(f"  With coordinates: {geocoded}")
    print(f"  Missing coords  : {no_coord} (will not show on map)")
    print(f"\nDone! Commit data/companies.json and push to update the site.")


if __name__ == "__main__":
    main()
