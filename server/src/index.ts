import ngeohash from 'ngeohash';
import * as OpenCC from 'opencc-js';

const GRID_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const FEHD_QUERY_URL = 'https://portal.csdi.gov.hk/server/rest/services/common/fehd_rcd_1630036390312_58893/FeatureServer/0/query';

const toSimplifiedChinese = OpenCC.Converter({ from: 'hk', to: 'cn' });
type DataRegion = 'hk' | 'cn' | 'global';

export interface Env {
  GEO_CACHE: KVNamespace;
  AMAP_KEY?: string;
  GOOGLE_MAPS_KEY?: string;
  ALLOWED_ORIGIN?: string;
}

export interface Restaurant {
  id: string;
  name: string;
  lat: number;
  lng: number;
  rating?: number;
  userRatingCount?: number;
  address: string;
  type?: string;
  price?: string;
  priceLevel?: string;
  licenseType?: string;
  phone?: string;
  openingHours?: string;
  googleMapsUri?: string;
  dataUpdatedAt?: number;
  isInactive?: boolean;
  source: 'google' | 'fehd' | 'amap';

  googlePlaceId?: string;
  amapPoiId?: string;
  fehdObjectId?: string;
  sources?: Array<'google' | 'fehd' | 'amap'>;
}

const SOURCE_PRIORITY: Record<string, number> = {
  google: 4,
  fehd: 3,
  amap: 2,
};

const CATEGORY_TRANSLATIONS: Record<string, string> = {
  'restaurant': '餐廳',
  'chinese_restaurant': '中菜館',
  'cantonese_restaurant': '粵菜酒家',
  'sichuan_restaurant': '川菜館',
  'asian_restaurant': '亞洲菜',
  'western_restaurant': '西式餐廳',
  'japanese_restaurant': '日本料理',
  'korean_restaurant': '韓國料理',
  'italian_restaurant': '意式餐廳',
  'french_restaurant': '法式餐廳',
  'thai_restaurant': '泰式料理',
  'vietnamese_restaurant': '越南菜',
  'indian_restaurant': '印度菜',
  'seafood_restaurant': '海鮮菜館',
  'sushi_restaurant': '壽司店',
  'ramen_restaurant': '拉麵店',
  'hot_pot_restaurant': '火鍋店',
  'barbecue_restaurant': '燒烤/燒肉',
  'fast_food_restaurant': '快餐店',
  'cafe': '咖啡店',
  'coffee_shop': '咖啡店',
  'bakery': '麵包餅店',
  'bar': '酒吧',
  'pub': '酒吧/酒館',
  'ice_cream_shop': '雪糕冰品店',
  'dessert_shop': '甜品糖水店',
  'dessert_restaurant': '甜品糖水店',
  'dim_sum_restaurant': '點心茶樓',
  'noodle_shop': '粉麵店',
  'tea_house': '茶館',
  'breakfast_restaurant': '早餐店',
  'brunch_restaurant': '早午餐',
  'meal_takeaway': '外賣店',
  'food_court': '美食廣場',
  'chinese restaurant': '中菜館',
  'japanese restaurant': '日本料理',
  'korean restaurant': '韓國料理',
  'western restaurant': '西式餐廳',
  'fast food restaurant': '快餐店',
  'seafood restaurant': '海鮮菜館',
  'asian restaurant': '亞洲菜',
  'italian restaurant': '意式餐廳',
  'french restaurant': '法式餐廳',
  'thai restaurant': '泰式料理',
  'vietnamese restaurant': '越南菜',
  'ramen restaurant': '拉麵店',
  'sushi restaurant': '壽司店',
  'hot pot restaurant': '火鍋店',
  'barbecue restaurant': '燒烤/燒肉',
  'dessert shop': '甜品糖水店',
  'coffee shop': '咖啡店',
  'food court': '美食廣場',
};

function translateCategory(rawType?: string): string | undefined {
  if (!rawType) return undefined;
  const trimmed = rawType.trim();
  if (!trimmed) return undefined;
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed;

  const normalizedKey = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const snakeKey = trimmed.toLowerCase().replace(/\s+/g, '_');

  if (CATEGORY_TRANSLATIONS[normalizedKey]) return CATEGORY_TRANSLATIONS[normalizedKey];
  if (CATEGORY_TRANSLATIONS[snakeKey]) return CATEGORY_TRANSLATIONS[snakeKey];
  if (normalizedKey.includes('restaurant')) return '餐廳';
  return trimmed;
}

function extractCoreBrandName(name: string): string {
  if (!name) return '';
  let cleaned = toSimplifiedChinese(name).normalize('NFKC').toLowerCase();
  cleaned = cleaned.replace(/^(上海|北京|四川|香港|台灣|本地|老牌|正宗)/g, '');
  cleaned = cleaned.replace(/(菜館|餐廳|飯店|小廚|美食|記|分店|店|坊|閣|居|屋|冰室|茶餐廳)/g, '');
  return cleaned.replace(/[^\p{L}\p{N}]/gu, '');
}

function extractShopNumber(address: string): string | null {
  if (!address) return null;
  const normalized = address.toLowerCase().replace(/\s+/g, '');
  const match = normalized.match(/(?:shop|地下|地下層|室|舖|铺)?\s*([a-z]?\d+[a-z]?)\s*(?:號|号)(?:舖|铺|室)?/i) 
             || normalized.match(/shop\s*([a-z]?\d+[a-z]?)/i);
  return match ? match[1] : null;
}

const corsHeaders = (env: Env): HeadersInit => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Expose-Headers': 'X-Cache',
  'Vary': 'Origin',
});

const jsonResponse = (body: unknown, status: number, env: Env, extraHeaders?: HeadersInit) => {
  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
};

function readNumber(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return null;
  const val = Number(raw);
  return Number.isFinite(val) ? val : null;
}

function normalizeRating(value: unknown): number {
  const rating = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(rating) && rating >= 0 ? Math.min(rating, 5) : 0;
}

function normalizePlaceText(value: string): string {
  return toSimplifiedChinese(value).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function inferRegion(lat: number, lng: number): DataRegion {
  if (lat >= 22.15 && lat <= 22.57 && lng >= 113.82 && lng <= 114.45) return 'hk';
  if (lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271) return 'cn';
  return 'global';
}

async function fetchGooglePlacesBasic(
  lat: number,
  lng: number,
  radius: number,
  apiKey: string,
  region: DataRegion
): Promise<Restaurant[]> {
  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress,places.primaryType,places.primaryTypeDisplayName,places.googleMapsUri,places.nationalPhoneNumber',
    },
    body: JSON.stringify({
      includedTypes: ['restaurant', 'cafe', 'fast_food_restaurant'],
      maxResultCount: 20,
      rankPreference: 'DISTANCE',
      languageCode: region === 'cn' ? 'zh-CN' : 'zh-HK',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
    }),
  });

  if (!response.ok) return [];
  const result = (await response.json()) as { places?: any[] };

  return (result.places ?? []).flatMap((place): Restaurant[] => {
    const pLat = place.location?.latitude;
    const pLng = place.location?.longitude;
    const name = place.displayName?.text?.trim();
    if (!place.id || !name || !Number.isFinite(pLat) || !Number.isFinite(pLng)) return [];

    const rawCategory = place.primaryTypeDisplayName?.text ?? place.primaryType;

    return [{
      id: `google:${place.id}`,
      name,
      lat: pLat,
      lng: pLng,
      address: place.formattedAddress ?? '',
      source: 'google',
      type: translateCategory(rawCategory),
      phone: place.nationalPhoneNumber,
      googleMapsUri: place.googleMapsUri,
      googlePlaceId: place.id,
      sources: ['google'],
    }];
  });
}

async function fetchAmapSingle(lat: number, lng: number, radius: number, apiKey: string): Promise<Restaurant[]> {
  const url = new URL('https://restapi.amap.com/v3/place/around');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('location', `${lng.toFixed(6)},${lat.toFixed(6)}`);
  url.searchParams.set('radius', String(radius));
  url.searchParams.set('types', '050000');
  url.searchParams.set('offset', '25');
  url.searchParams.set('output', 'JSON');
  url.searchParams.set('extensions', 'all');

  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const result = (await response.json()) as { status?: string; pois?: any[] };
    if (result.status !== '1') return [];

    return (result.pois ?? []).flatMap((poi): Restaurant[] => {
      const [lngText, latText] = (poi.location ?? '').split(',');
      const pLat = Number(latText);
      const pLng = Number(lngText);
      const name = poi.name?.trim();
      if (!poi.id || !name || !Number.isFinite(pLat) || !Number.isFinite(pLng)) return [];

      const rawRating = poi.biz_ext?.rating;
      const rating = typeof rawRating === 'string' && rawRating.length > 0 ? Number(rawRating) : undefined;
      const rawCost = poi.biz_ext?.cost;
      const price = typeof rawCost === 'string' && rawCost.length > 0 && rawCost !== '0.00' ? `￥${Math.round(Number(rawCost))}/人` : undefined;

      const rawPhone = Array.isArray(poi.tel) ? poi.tel.join(', ') : poi.tel;
      const rawOpentime = poi.biz_ext?.opentime2 || poi.biz_ext?.opentime;

      return [{
        id: `amap:${poi.id}`,
        name,
        lat: pLat,
        lng: pLng,
        address: Array.isArray(poi.address) ? poi.address.join('') : poi.address ?? '',
        source: 'amap',
        type: translateCategory(poi.type),
        rating: Number.isFinite(rating) && (rating ?? 0) > 0 ? rating : undefined,
        price,
        phone: typeof rawPhone === 'string' && rawPhone.trim() ? rawPhone.trim() : undefined,
        openingHours: typeof rawOpentime === 'string' && rawOpentime.trim() ? rawOpentime.trim() : undefined,
        amapPoiId: poi.id,
        sources: ['amap'],
      }];
    });
  } catch {
    return [];
  }
}

async function fetchAmapRecursive(
  lat: number,
  lng: number,
  radius: number,
  apiKey: string,
  depth = 0
): Promise<Restaurant[]> {
  const currentBatch = await fetchAmapSingle(lat, lng, radius, apiKey);
  if (currentBatch.length >= 25 && depth < 2 && radius > 80) {
    const subRadius = radius / 2;
    const offset = radius / 4;
    const subCoords = [
      { lat: lat + offset, lng: lng + offset },
      { lat: lat + offset, lng: lng - offset },
      { lat: lat - offset, lng: lng + offset },
      { lat: lat - offset, lng: lng - offset },
    ];
    const subResults = await Promise.all(subCoords.map((coord) => fetchAmapRecursive(coord.lat, coord.lng, subRadius, apiKey, depth + 1)));
    return mergePlaces([currentBatch, ...subResults]);
  }
  return currentBatch;
}

async function ensureFehdSyncedMonthly(env: Env): Promise<Record<string, Restaurant>> {
  const now = new Date();
  const currentMonthKey = `fehd:data:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const statusKey = 'fehd:status';

  const currentStatus = await env.GEO_CACHE.get(statusKey);
  const storedMaster = await env.GEO_CACHE.get('fehd:master_db', 'json') as Record<string, Restaurant> | null;
  const masterDb: Record<string, Restaurant> = storedMaster || {};

  if (currentStatus === currentMonthKey && Object.keys(masterDb).length > 0) return masterDb;

  try {
    const url = new URL(FEHD_QUERY_URL);
    url.searchParams.set('where', '1=1');
    url.searchParams.set('outFields', 'OBJECTID,NSEARCH03_EN,NSEARCH03_TC,ADDRESS_EN,ADDRESS_TC,NAME_EN,NAME_TC,LATITUDE,LONGITUDE,LASTUPDATE');
    url.searchParams.set('returnGeometry', 'true');
    url.searchParams.set('outSR', '4326');
    url.searchParams.set('resultRecordCount', '50000');
    url.searchParams.set('f', 'json');

    const res = await fetch(url);
    if (!res.ok) return masterDb;
    const json = (await res.json()) as { features?: any[] };
    const fetchedFeatures = json.features || [];
    const fetchedIds = new Set<string>();

    for (const feat of fetchedFeatures) {
      const attr = feat.attributes;
      if (!attr?.OBJECTID) continue;
      const fehdId = String(attr.OBJECTID);
      fetchedIds.add(fehdId);

      const pLat = Number(attr.LATITUDE ?? feat.geometry?.y);
      const pLng = Number(attr.LONGITUDE ?? feat.geometry?.x);
      if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) continue;

      const address = attr.ADDRESS_TC?.trim() || attr.ADDRESS_EN?.trim() || '';
      const name = attr.NSEARCH03_TC?.trim() || attr.NSEARCH03_EN?.trim() || address;

      masterDb[fehdId] = {
        id: `fehd:${fehdId}`,
        fehdObjectId: fehdId,
        name,
        lat: pLat,
        lng: pLng,
        address,
        licenseType: attr.NAME_TC?.trim() || attr.NAME_EN?.trim(),
        source: 'fehd',
        sources: ['fehd'],
        isInactive: false,
      };
    }

    for (const fehdId of Object.keys(masterDb)) {
      if (!fetchedIds.has(fehdId)) masterDb[fehdId].isInactive = true;
    }

    await env.GEO_CACHE.put('fehd:master_db', JSON.stringify(masterDb));
    await env.GEO_CACHE.put(statusKey, currentMonthKey);
    return masterDb;
  } catch {
    return masterDb;
  }
}

function mergePlaces(sourceGroups: Restaurant[][]): Restaurant[] {
  const merged: Restaurant[] = [];

  for (const sourceGroup of sourceGroups) {
    for (const candidate of sourceGroup) {
      const candidateName = normalizePlaceText(candidate.name);
      const candidateAddr = normalizePlaceText(candidate.address);
      const candidateShop = extractShopNumber(candidate.address);
      const candidateCoreBrand = extractCoreBrandName(candidate.name);

      const existingIndex = merged.findIndex((place) => {
        if (candidate.googlePlaceId && place.googlePlaceId && place.googlePlaceId === candidate.googlePlaceId) return true;
        if (candidate.fehdObjectId && place.fehdObjectId === candidate.fehdObjectId) return true;
        if (candidate.amapPoiId && place.amapPoiId === candidate.amapPoiId) return true;

        const dist = distanceMeters(place.lat, place.lng, candidate.lat, candidate.lng);
        const firstName = normalizePlaceText(place.name);
        const placeCoreBrand = extractCoreBrandName(place.name);

        if (candidateCoreBrand.length >= 2 && placeCoreBrand === candidateCoreBrand && dist <= 300) {
          return true;
        }

        if (dist <= 100) {
          const placeShop = extractShopNumber(place.address);
          if (candidateShop && placeShop && candidateShop === placeShop) return true;
        }

        if (dist <= 150) {
          const isSameShop = Boolean(candidateShop && extractShopNumber(place.address) === candidateShop);
          const nameOverlap = firstName.includes(candidateName) || candidateName.includes(firstName);
          if (isSameShop || nameOverlap) return true;
        }

        return false;
      });

      if (existingIndex !== -1) {
        const existing = merged[existingIndex];
        const candidatePrio = SOURCE_PRIORITY[candidate.source] || 0;
        const existingPrio = SOURCE_PRIORITY[existing.source] || 0;

        // 規則：如果新條目是 Google（具備 googlePlaceId 或 source 為 google），而舊條目是 fehd，強制以 Google 優先覆蓋為核心主體
        const isGoogleCandidate = Boolean(candidate.googlePlaceId || candidate.source === 'google');
        const isExistingFehd = existing.source === 'fehd' && !existing.googlePlaceId;

        if (isGoogleCandidate && isExistingFehd) {
          // 強制將 Google 數據提升為主體
          merged[existingIndex] = {
            ...existing,
            ...candidate,
            id: candidate.id,
            source: 'google',
            sources: Array.from(new Set([...(existing.sources || []), ...(candidate.sources || [candidate.source])])),
          };
        } else {
          if (candidatePrio > existingPrio) {
            existing.id = candidate.id;
            existing.name = candidate.name;
            existing.source = candidate.source;
            if (candidate.lat && candidate.lng) {
              existing.lat = candidate.lat;
              existing.lng = candidate.lng;
            }
          }

          if (candidate.googlePlaceId) existing.googlePlaceId = candidate.googlePlaceId;
          if (candidate.fehdObjectId) existing.fehdObjectId = candidate.fehdObjectId;
          if (candidate.amapPoiId) existing.amapPoiId = candidate.amapPoiId;

          existing.sources = Array.from(new Set([...(existing.sources || [existing.source]), candidate.source]));

          if (candidate.name.length >= existing.name.length || (!/[\u4e00-\u9fa5]/.test(existing.name) && /[\u4e00-\u9fa5]/.test(candidate.name))) {
            existing.name = candidate.name;
          }

          if (!existing.address || existing.address.length < candidate.address.length) existing.address = candidate.address;
          if (candidate.type) existing.type = translateCategory(candidate.type);
          if (candidate.licenseType) existing.licenseType = candidate.licenseType;
          if (candidate.rating) existing.rating = candidate.rating;
          if (candidate.userRatingCount) existing.userRatingCount = candidate.userRatingCount;
          if (candidate.price) existing.price = candidate.price;
          if (candidate.phone) existing.phone = candidate.phone;
          if (candidate.openingHours) existing.openingHours = candidate.openingHours;
          if (candidate.googleMapsUri) existing.googleMapsUri = candidate.googleMapsUri;
          if (candidate.dataUpdatedAt) existing.dataUpdatedAt = candidate.dataUpdatedAt;
        }

      } else {
        merged.push({
          ...candidate,
          type: translateCategory(candidate.type),
          sources: candidate.sources || [candidate.source],
        });
      }
    }
  }

  return merged;
}

async function fetchGoogleRecursive(
  lat: number,
  lng: number,
  radius: number,
  apiKey: string,
  region: DataRegion,
  depth = 0
): Promise<Restaurant[]> {
  const currentBatch = await fetchGooglePlacesBasic(lat, lng, radius, apiKey, region);
  if (currentBatch.length >= 20 && depth < 2 && radius > 80) {
    const subRadius = radius / 2;
    const offset = radius / 4;
    const subCoords = [
      { lat: lat + offset, lng: lng + offset },
      { lat: lat + offset, lng: lng - offset },
      { lat: lat - offset, lng: lng + offset },
      { lat: lat - offset, lng: lng - offset },
    ];
    const subResults = await Promise.all(subCoords.map((coord) => fetchGoogleRecursive(coord.lat, coord.lng, subRadius, apiKey, region, depth + 1)));
    return mergePlaces([currentBatch, ...subResults]);
  }
  return currentBatch;
}

function getGeohashesInRadius(lat: number, lng: number, radiusMeters: number): string[] {
  const geohashes = new Set<string>();
  const precision = 7;
  const latStep = 0.00135;
  const lngStep = 0.00146;
  const steps = Math.ceil(radiusMeters / 150);

  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const pointLat = lat + i * latStep;
      const pointLng = lng + j * lngStep;
      if (distanceMeters(lat, lng, pointLat, pointLng) <= radiusMeters + 100) {
        geohashes.add(ngeohash.encode(pointLat, pointLng, precision));
      }
    }
  }

  return Array.from(geohashes);
}

async function fetchPlacesForGridCell(
  gh7: string,
  region: DataRegion,
  env: Env,
  fehdMaster: Record<string, Restaurant>
): Promise<Restaurant[]> {
  const gridCacheKey = `grid:v6:${region}:${gh7}`;
  const cached = await env.GEO_CACHE.get(gridCacheKey, 'json') as Restaurant[] | null;
  if (cached) return cached;

  const { latitude: cLat, longitude: cLng } = ngeohash.decode(gh7);
  const requests: Array<Promise<Restaurant[]>> = [];

  if (env.GOOGLE_MAPS_KEY) requests.push(fetchGoogleRecursive(cLat, cLng, 150, env.GOOGLE_MAPS_KEY, region, 0));
  if (region === 'cn' && env.AMAP_KEY) requests.push(fetchAmapRecursive(cLat, cLng, 150, env.AMAP_KEY, 0));
  if (region === 'hk') {
    const fehdMatches = Object.values(fehdMaster).filter(
      (r) => !r.isInactive && distanceMeters(cLat, cLng, r.lat, r.lng) <= 150
    );
    requests.push(Promise.resolve(fehdMatches));
  }

  const results = await Promise.allSettled(requests);
  const successfulGroups = results.flatMap((res) => (res.status === 'fulfilled' ? [res.value] : []));
  let mergedCellData = mergePlaces(successfulGroups);

  if (region !== 'cn') {
    mergedCellData = mergedCellData
      .filter((r) => r.source !== 'amap')
      .map((r) => ({ ...r, amapPoiId: undefined, sources: r.sources?.filter((s) => s !== 'amap') }));
  }

  if (mergedCellData.length > 0) {
    await env.GEO_CACHE.put(gridCacheKey, JSON.stringify(mergedCellData), { expirationTtl: GRID_CACHE_TTL_SECONDS });
  }

  return mergedCellData;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (url.pathname === '/health') return jsonResponse({ ok: true }, 200, env);

    if (url.pathname === '/api/places/details') {
      if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, env);

      const requestedId = url.searchParams.get('id') ?? '';
      if (!requestedId) return jsonResponse({ error: 'id is required' }, 400, env);

      const googlePlaceId = requestedId.startsWith('google:') ? requestedId.slice(7) : requestedId;
      if (!env.GOOGLE_MAPS_KEY) return jsonResponse({ error: 'GOOGLE_MAPS_KEY not set' }, 503, env);

      try {
        const googleUrl = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(googlePlaceId)}`);
        const detailsRes = await fetch(googleUrl, {
          headers: {
            'X-Goog-Api-Key': env.GOOGLE_MAPS_KEY,
            'X-Goog-Language-Code': 'zh-HK',
            'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,priceLevel,primaryType,primaryTypeDisplayName,googleMapsUri,nationalPhoneNumber',
          },
        });

        if (!detailsRes.ok) throw new Error('Details fetch failed');
        const detailsData = (await detailsRes.json()) as any;

        const fetchedName = detailsData.displayName?.text;
        const fetchedAddress = detailsData.formattedAddress;
        const rawCategory = detailsData.primaryTypeDisplayName?.text ?? detailsData.primaryType;

        const updatedRecord: Partial<Restaurant> = {
          id: requestedId,
          googlePlaceId,
          rating: normalizeRating(detailsData.rating),
          userRatingCount: detailsData.userRatingCount,
          priceLevel: detailsData.priceLevel,
          type: translateCategory(rawCategory),
          phone: detailsData.nationalPhoneNumber,
          googleMapsUri: detailsData.googleMapsUri,
          dataUpdatedAt: Date.now(),
        };

        if (fetchedName && /[\u4e00-\u9fa5]/.test(fetchedName)) updatedRecord.name = fetchedName;
        if (fetchedAddress) updatedRecord.address = fetchedAddress;

        return jsonResponse({ data: updatedRecord, source: 'google_live' }, 200, env);
      } catch {
        return jsonResponse({ error: 'Failed to fetch details' }, 502, env);
      }
    }

    if (url.pathname !== '/api/places') return jsonResponse({ error: 'Not found' }, 404, env);
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, env);

    const lat = readNumber(url, 'lat');
    const lng = readNumber(url, 'lng');
    const radius = readNumber(url, 'radius') ?? 1000;
    const requestedRegion = url.searchParams.get('region');

    if (lat === null || lng === null) return jsonResponse({ error: 'lat and lng required' }, 400, env);

    const region: DataRegion = requestedRegion === 'hk' || requestedRegion === 'cn' || requestedRegion === 'global' ? requestedRegion : inferRegion(lat, lng);

    try {
      const fehdMaster = region === 'hk' ? await ensureFehdSyncedMonthly(env) : {};
      const gridHashes = getGeohashesInRadius(lat, lng, radius);
      const gridPromises = gridHashes.map((gh7) => fetchPlacesForGridCell(gh7, region, env, fehdMaster));
      const gridResults = await Promise.all(gridPromises);

      const allMerged = mergePlaces(gridResults);
      const finalCandidates = allMerged.filter((r) => !r.isInactive && distanceMeters(lat, lng, r.lat, r.lng) <= radius);

      return jsonResponse({ region, radius, total: finalCandidates.length, data: finalCandidates }, 200, env);
    } catch {
      return jsonResponse({ error: 'Places search failed' }, 502, env);
    }
  },
};