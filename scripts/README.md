# Scripts

## fetch_companies.py — 抓取台灣上市/上櫃公司資料

從 TWSE（台灣證券交易所）和 TPEX（櫃買中心）公開 API 抓取所有上市/上櫃公司，
輸出為 `data/companies.json`（供網站直接使用）和 `data/companies_raw.csv`。

### 安裝

```bash
pip install requests
```

### 使用方式

```bash
# 抓取全部（上市 + 上櫃），包含地址自動地理編碼（約 10–20 分鐘）
python scripts/fetch_companies.py

# 只抓上市公司，跳過地理編碼（快速，適合先檢查資料）
python scripts/fetch_companies.py --source twse --no-geocode

# 先看 API 回傳的原始欄位名稱（除錯用）
python scripts/fetch_companies.py --debug --source twse

# 只處理前 20 筆（測試用）
python scripts/fetch_companies.py --limit 20

# 指定輸出路徑
python scripts/fetch_companies.py --output-json data/companies.json --output-csv data/companies_raw.csv
```

### 資料來源

| 來源 | API URL | 說明 |
|------|---------|------|
| TWSE 上市 | `https://openapi.twse.com.tw/v1/opendata/t187ap03_L` | 約 950 家 |
| TPEX 上櫃 | `https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O` | 約 800 家 |

### 地理編碼

地址轉座標使用 [Nominatim](https://nominatim.openstreetmap.org/)（OpenStreetMap）。
- 速率限制：1 req/sec
- 已抓取過的公司座標（依統一編號）會從現有 `data/companies.json` 讀取，不重複請求
- 若地址查無結果，lat/lng 會留空，該公司不會顯示在地圖上（但仍可搜尋到）

### 更新流程

```bash
# 1. 執行腳本（已有座標快取，只會補齊新公司的座標）
python scripts/fetch_companies.py

# 2. 確認輸出
head -c 500 data/companies.json

# 3. 提交並推送
git add data/companies.json
git commit -m "Update company data ($(date +%Y-%m-%d))"
git push
```

### CSV 手動匯入

如果不想執行腳本，也可以：
1. 從 [公開資訊觀測站](https://mops.twse.com.tw/mops/web/index) 手動下載資料
2. 整理成符合 `data/template.csv` 格式的 CSV
3. 在網站上點「📥 匯入 CSV」上傳

CSV 欄位格式請參考 `data/template.csv`。
