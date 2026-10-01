# FatBuddy

FatBuddy is a location-based restaurant picker with a React/Vite PWA and a Cloudflare Worker API.

## Local development

Install dependencies in each deployable project:

```powershell
npm --prefix .\FatBuddy install
Push-Location .\server
npm install
Pop-Location
```

Set `GOOGLE_MAPS_KEY` and `AMAP_KEY` in `server/.dev.vars`. Keep this file local and never commit real keys. Start the Worker and frontend in separate terminals:

```powershell
Push-Location .\server
npm run dev
```

```powershell
npm --prefix .\FatBuddy run dev
```

The Vite `/api` proxy forwards requests to `http://127.0.0.1:8787`.

## Cloudflare deployment

Deploy the Worker from `server/`, then add the provider keys as Worker secrets:

```powershell
npx wrangler secret put GOOGLE_MAPS_KEY
npx wrangler secret put AMAP_KEY
npm run deploy
```

For Cloudflare Pages, set the project root to `FatBuddy`, the build command to `npm run build`, and the output directory to `dist`. Set `VITE_WORKER_API_URL` to the deployed Worker origin in the Pages build environment. The Worker accepts `ALLOWED_ORIGIN` as an optional environment variable to restrict browser CORS to the Pages origin.

The Google Places API must be enabled with billing for the Google key. The Amap key must be a Web Service key. Configure a real KV namespace ID in `server/wrangler.jsonc` if the existing binding is not part of your Cloudflare account.

## Restaurant data sources

The Worker queries configured providers concurrently. In mainland China it combines Amap, Google Places, and OpenStreetMap; in Hong Kong it combines Google Places, Amap, FEHD, and OpenStreetMap; elsewhere it combines Google Places and OpenStreetMap. Each failed provider is isolated so successful sources can still return results. Overpass queries are limited to a 5 km radius, 100 records, and a 2.5 second request timeout. All regions are cached for 24 hours.

OpenStreetMap is a best-effort global supplement, not a guaranteed restaurant directory: coverage, names, and opening data vary by country. Public Overpass instances are shared community services without an SLA; use a managed Overpass provider or a self-hosted instance for sustained production traffic. OSM-derived results are attributed as © OpenStreetMap contributors and available under ODbL.

Nearby cross-provider duplicate names/addresses are normalized to Simplified Chinese before matching, and higher-priority provider records are retained.

FEHD adds licensed Hong Kong restaurants that are missing from map providers. The merged Hong Kong response is cached for 24 hours, aligned with the dataset's daily 9:00 a.m. update schedule. Concurrent calls can consume quota or incur charges at both Google and Amap; configure billing limits and API restrictions for both keys. 

The app attributes FEHD records to FEHD / DATA.GOV.HK. A restaurant licence is not proof that a restaurant is open now, and FEHD records do not provide user ratings. See [Restaurant licences](https://data.gov.hk/en-data/dataset/hk-fehd-fehdlmis-restaurant-licences), [DATA.GOV.HK terms](https://data.gov.hk/en/terms-and-conditions), and [OpenStreetMap copyright and ODbL](https://www.openstreetmap.org/copyright).

The navigation settings no longer select the restaurant data provider. Restaurant search uses all configured sources; the result card offers both Google Maps and Amap navigation links. Candidate, exclusion, blacklist, and review searches accept Simplified or Traditional Chinese input.

## Checks

```powershell
npm --prefix .\FatBuddy run build
Push-Location .\server
npx tsc --noEmit
npm test -- --run
Pop-Location
```
