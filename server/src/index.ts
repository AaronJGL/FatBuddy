import ngeohash from 'ngeohash';
import OpenCC from 'opencc-js/t2cn';

const CACHE_TTL_SECONDS = 60 * 60 * 24;
const DEFAULT_RADIUS_METERS = 1000;
const MAX_RESULTS = 20;
const FEHD_RESULT_LIMIT = 1000;
const FEHD_QUERY_URL = 'https://portal.csdi.gov.hk/server/rest/services/common/fehd_rcd_1630036390312_58893/FeatureServer/0/query';
const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OSM_QUERY_TIMEOUT_SECONDS = 2;
const OSM_REQUEST_TIMEOUT_MS = 2500;
const OSM_RESULT_LIMIT = 100;
const AMAP_RESULT_LIMIT = 25;
const toSimplifiedChinese = OpenCC.Converter({ from: 'tw', to: 'cn' });

type DataRegion = 'hk' | 'cn' | 'global';

export interface Env {
  GEO_CACHE: KVNamespace;
  AMAP_KEY?: string;
  GOOGLE_MAPS_KEY?: string;
  ALLOWED_ORIGIN?: string;
  OVERPASS_URL?: string;
}

export interface Restaurant {
  id: string;
  name: string;
  lat: number;
  lng: number;
  rating: number;
  address: string;
  source: 'google' | 'amap' | 'fehd' | 'osm';
  type?: string;
  price?: string;
  priceLevel?: string;
  userRatingCount?: number;
  licenseType?: string;
  dataUpdatedAt?: string;
}

interface PlacesResponse {
  geohash: string;
  region: DataRegion;
  data: Restaurant[];
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  formattedAddress?: string;
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
}

interface GooglePlaceDetails {
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
}

interface AmapPoi {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  address?: string | string[];
  biz_ext?: { rating?: string | number; cost?: string | number };
}

interface FehdFeature {
  attributes?: {
    OBJECTID?: number;
    NSEARCH03_EN?: string | null;
    NSEARCH03_TC?: string | null;
    ADDRESS_EN?: string | null;
    ADDRESS_TC?: string | null;
    NAME_EN?: string | null;
    NAME_TC?: string | null;
    LATITUDE?: string | number | null;
    LONGITUDE?: string | number | null;
    LASTUPDATE?: string | null;
  };
  geometry?: { x?: number; y?: number };
}

interface OsmElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string | undefined>;
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
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeRating(value: unknown): number {
  const rating = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(rating) && rating >= 0 ? Math.min(rating, 5) : 0;
}

function isHongKongLocation(lat: number, lng: number): boolean {
  return lat >= 22.15 && lat <= 22.57 && lng >= 113.82 && lng <= 114.45;
}

function inferRegion(lat: number, lng: number): DataRegion {
  const inChinaBounds = lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
  const inHongKong = isHongKongLocation(lat, lng);
  const inMacau = lat >= 22.1 && lat <= 22.24 && lng >= 113.52 && lng <= 113.62;
  const inTaiwan = lat >= 21.8 && lat <= 25.4 && lng >= 119.3 && lng <= 122.1;
  if (inHongKong) return 'hk';
  if (inChinaBounds && !inMacau && !inTaiwan) return 'cn';
  return 'global';
}

function transformLatitude(x: number, y: number): number {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  value += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return value;
}

function transformLongitude(x: number, y: number): number {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  value += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return value;
}

function toAmapCoordinates(lat: number, lng: number): { lat: number; lng: number } {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };

  const semiMajorAxis = 6378245;
  const eccentricitySquared = 0.006693421622965943;
  const radians = (lat * Math.PI) / 180;
  let deltaLat = transformLatitude(lng - 105, lat - 35);
  let deltaLng = transformLongitude(lng - 105, lat - 35);
  const sinRadians = Math.sin(radians);
  let magic = 1 - eccentricitySquared * sinRadians * sinRadians;
  const sqrtMagic = Math.sqrt(magic);
  deltaLat = (deltaLat * 180) / (((semiMajorAxis * (1 - eccentricitySquared)) / (magic * sqrtMagic)) * Math.PI);
  deltaLng = (deltaLng * 180) / ((semiMajorAxis / sqrtMagic) * Math.cos(radians) * Math.PI);
  magic = lat + deltaLat;

  return { lat: magic, lng: lng + deltaLng };
}

async function fetchGooglePlaces(
  lat: number,
  lng: number,
  radius: number,
  apiKey: string,
  region: DataRegion,
): Promise<Restaurant[]> {
  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress,places.primaryType,places.primaryTypeDisplayName,places.rating,places.userRatingCount',
    },
    body: JSON.stringify({
      includedTypes: ['restaurant'],
      maxResultCount: MAX_RESULTS,
      rankPreference: 'DISTANCE',
      languageCode: region === 'cn' ? 'zh-CN' : region === 'hk' ? 'zh-HK' : 'en',
      ...(region === 'global' ? {} : { regionCode: region === 'cn' ? 'CN' : 'HK' }),
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
    }),
  });

  if (!response.ok) throw new Error(`Google Places returned ${response.status}`);
  const result = await response.json() as { places?: GooglePlace[] };

  return (result.places ?? []).flatMap((place): Restaurant[] => {
    const placeLat = place.location?.latitude;
    const placeLng = place.location?.longitude;
    const name = place.displayName?.text?.trim();
    if (!place.id || !name || !Number.isFinite(placeLat) || !Number.isFinite(placeLng)) return [];

    return [{
      id: `google:${place.id}`,
      name,
      lat: placeLat!,
      lng: placeLng!,
      rating: 0,
      address: place.formattedAddress ?? '',
      source: 'google',
      type: place.primaryTypeDisplayName?.text ?? place.primaryType,
    }];
  });
}

async function fetchGooglePlaceDetails(placeId: string, apiKey: string): Promise<GooglePlaceDetails> {
  const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
  const response = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'rating,userRatingCount,priceLevel',
    },
  });
  if (!response.ok) throw new Error(`Google Place Details returned ${response.status}`);
  const details = await response.json() as GooglePlaceDetails;

  return {
    rating: normalizeRating(details.rating),
    userRatingCount: details.userRatingCount,
    priceLevel: details.priceLevel,
  };
}

async function fetchAmapPlaces(
  lat: number,
  lng: number,
  radius: number,
  apiKey: string,
): Promise<Restaurant[]> {
  const amapCoordinates = toAmapCoordinates(lat, lng);
  const url = new URL('https://restapi.amap.com/v3/place/around');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('location', `${amapCoordinates.lng.toFixed(6)},${amapCoordinates.lat.toFixed(6)}`);
  url.searchParams.set('radius', String(radius));
  url.searchParams.set('types', '050000');
  url.searchParams.set('offset', String(AMAP_RESULT_LIMIT));
  url.searchParams.set('page', '1');
  url.searchParams.set('extensions', 'all');
  url.searchParams.set('output', 'JSON');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Amap returned ${response.status}`);
  const result = await response.json() as { status?: string; pois?: AmapPoi[] };
  if (result.status !== '1') throw new Error('Amap rejected the nearby search');

  return (result.pois ?? []).flatMap((poi): Restaurant[] => {
    const [lngText, latText] = (poi.location ?? '').split(',');
    const poiLat = Number(latText);
    const poiLng = Number(lngText);
    const name = poi.name?.trim();
    if (!poi.id || !name || !Number.isFinite(poiLat) || !Number.isFinite(poiLng)) return [];

    return [{
      id: `amap:${poi.id}`,
      name,
      lat: poiLat,
      lng: poiLng,
      rating: normalizeRating(poi.biz_ext?.rating),
      address: Array.isArray(poi.address) ? poi.address.join('') : poi.address ?? '',
      source: 'amap',
      type: poi.type,
      price: poi.biz_ext?.cost === undefined ? undefined : String(poi.biz_ext.cost),
    }];
  });
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(lat2 - lat1);
  const longitudeDelta = toRadians(lng2 - lng1);
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function normalizePlaceText(value: string): string {
  return toSimplifiedChinese(value).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

async function fetchFehdPlaces(lat: number, lng: number, radius: number): Promise<Restaurant[]> {
  const url = new URL(FEHD_QUERY_URL);
  url.searchParams.set('where', '1=1');
  url.searchParams.set('geometry', `${lng},${lat}`);
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('distance', String(radius));
  url.searchParams.set('units', 'esriSRUnit_Meter');
  url.searchParams.set('outFields', 'OBJECTID,NSEARCH03_EN,NSEARCH03_TC,ADDRESS_EN,ADDRESS_TC,NAME_EN,NAME_TC,LATITUDE,LONGITUDE,LASTUPDATE');
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('resultRecordCount', String(FEHD_RESULT_LIMIT));
  url.searchParams.set('f', 'json');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`FEHD CSDI returned ${response.status}`);
  const result = await response.json() as { error?: { message?: string }; features?: FehdFeature[] };
  if (result.error) throw new Error(result.error.message ?? 'FEHD CSDI query failed');

  return (result.features ?? []).flatMap((feature): Restaurant[] => {
    const attributes = feature.attributes;
    if (!attributes?.OBJECTID) return [];

    const placeLat = Number(attributes.LATITUDE ?? feature.geometry?.y);
    const placeLng = Number(attributes.LONGITUDE ?? feature.geometry?.x);
    if (!Number.isFinite(placeLat) || !Number.isFinite(placeLng)) return [];

    const address = attributes.ADDRESS_TC?.trim() || attributes.ADDRESS_EN?.trim() || '';
    const name = attributes.NSEARCH03_TC?.trim()
      || attributes.NSEARCH03_EN?.trim()
      || (address ? `持牌餐廳 · ${address}` : `FEHD 持牌餐廳 ${attributes.OBJECTID}`);

    return [{
      id: `fehd:${attributes.OBJECTID}`,
      name,
      lat: placeLat,
      lng: placeLng,
      rating: 0,
      address,
      source: 'fehd',
      licenseType: attributes.NAME_TC?.trim() || attributes.NAME_EN?.trim() || undefined,
      dataUpdatedAt: attributes.LASTUPDATE?.trim() || undefined,
    }];
  });
}

async function fetchOsmPlaces(
  lat: number,
  lng: number,
  radius: number,
  endpoint: string,
): Promise<Restaurant[]> {
  const boundedRadius = Math.min(radius, 5000);
  const query = [
    `[out:json][timeout:${OSM_QUERY_TIMEOUT_SECONDS}];`,
    `nwr(around:${boundedRadius},${lat},${lng})["amenity"~"^(restaurant|fast_food|cafe|food_court)$"];`,
    `out center ${OSM_RESULT_LIMIT};`,
  ].join('\n');
  const body = new URLSearchParams({ data: query });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'FatBuddy/1.0',
    },
    body,
    signal: AbortSignal.timeout(OSM_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`Overpass returned ${response.status}`);
  const result = await response.json() as { elements?: OsmElement[] };

  return (result.elements ?? []).flatMap((element): Restaurant[] => {
    const tags = element.tags;
    const placeLat = element.lat ?? element.center?.lat;
    const placeLng = element.lon ?? element.center?.lon;
    const name = tags?.['name:zh-Hant']
      || tags?.['name:zh']
      || tags?.name
      || tags?.['name:en']
      || tags?.brand;
    if (!element.type || !element.id || !name || !Number.isFinite(placeLat) || !Number.isFinite(placeLng)) return [];

    const address = tags?.['addr:full']
      || [tags?.['addr:housenumber'], tags?.['addr:street'], tags?.['addr:city']].filter(Boolean).join(' ');
    return [{
      id: `osm:${element.type}:${element.id}`,
      name,
      lat: placeLat!,
      lng: placeLng!,
      rating: 0,
      address,
      source: 'osm',
      type: tags?.cuisine || tags?.amenity,
      price: tags?.price_range,
    }];
  });
}

function mergePlaces(sourceGroups: Restaurant[][]): Restaurant[] {
  const merged: Restaurant[] = [];

  for (const sourceGroup of sourceGroups) {
    const additions: Restaurant[] = [];
    for (const candidate of sourceGroup) {
      const candidateName = normalizePlaceText(candidate.name);
      const candidateAddress = normalizePlaceText(candidate.address);
      const duplicate = merged.some((place) => {
        if (distanceMeters(place.lat, place.lng, candidate.lat, candidate.lng) > 35) return false;
        const namesMatch = normalizePlaceText(place.name) === candidateName;
        const addressesMatch = Boolean(candidateAddress)
          && normalizePlaceText(place.address) === candidateAddress;
        return namesMatch || addressesMatch;
      });

      if (!duplicate) additions.push(candidate);
    }
    merged.push(...additions);
  }

  return merged;
}

async function fetchPlacesFromAllSources(
  lat: number,
  lng: number,
  radius: number,
  region: DataRegion,
  env: Env,
): Promise<Restaurant[]> {
  const requests: Array<Promise<Restaurant[]>> = [];

  if (env.GOOGLE_MAPS_KEY) requests.push(fetchGooglePlaces(lat, lng, radius, env.GOOGLE_MAPS_KEY, region));
  if (region !== 'global' && env.AMAP_KEY) requests.push(fetchAmapPlaces(lat, lng, radius, env.AMAP_KEY));
  if (region === 'hk') requests.push(fetchFehdPlaces(lat, lng, radius));
  requests.push(fetchOsmPlaces(lat, lng, radius, env.OVERPASS_URL || DEFAULT_OVERPASS_URL));

  const results = await Promise.allSettled(requests);
  const successfulSources = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (successfulSources.length === 0) throw new Error('All restaurant data sources are unavailable');
  return mergePlaces(successfulSources);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (url.pathname === '/health') return jsonResponse({ ok: true }, 200, env);
    if (url.pathname === '/api/places/details') {
      if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, env);
      const requestedId = url.searchParams.get('id') ?? '';
      const placeId = requestedId.startsWith('google:') ? requestedId.slice('google:'.length) : requestedId;
      if (!/^[A-Za-z0-9_-]+$/.test(placeId)) return jsonResponse({ error: 'A valid Google place ID is required' }, 400, env);
      if (!env.GOOGLE_MAPS_KEY) return jsonResponse({ error: 'GOOGLE_MAPS_KEY is not configured' }, 503, env);
      try {
        return jsonResponse({ data: await fetchGooglePlaceDetails(placeId, env.GOOGLE_MAPS_KEY) }, 200, env);
      } catch {
        return jsonResponse({ error: 'Google Place Details request failed' }, 502, env);
      }
    }
    if (url.pathname !== '/api/places') return jsonResponse({ error: 'Not found' }, 404, env);
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, env);

    const lat = readNumber(url, 'lat');
    const lng = readNumber(url, 'lng');
    const radius = url.searchParams.has('radius') ? readNumber(url, 'radius') : DEFAULT_RADIUS_METERS;
    const requestedRegion = url.searchParams.get('region');

    if (lat === null || lng === null) return jsonResponse({ error: 'lat and lng are required numbers' }, 400, env);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return jsonResponse({ error: 'lat or lng is outside the valid range' }, 400, env);
    }
    if (radius === null || radius < 100 || radius > 50000) {
      return jsonResponse({ error: 'radius must be between 100 and 50000 meters' }, 400, env);
    }
    if (requestedRegion && requestedRegion !== 'hk' && requestedRegion !== 'cn' && requestedRegion !== 'global') {
      return jsonResponse({ error: 'region must be hk, cn, or global' }, 400, env);
    }
    const region: DataRegion = requestedRegion === 'hk' || requestedRegion === 'cn' || requestedRegion === 'global'
      ? requestedRegion
      : inferRegion(lat, lng);

    const geohash = ngeohash.encode(lat, lng, 6);
    const sourceSet = `${env.GOOGLE_MAPS_KEY ? 'g' : ''}${region !== 'global' && env.AMAP_KEY ? 'a' : ''}${region === 'hk' ? 'f' : ''}o`;
    const cacheKey = `places:v7:${sourceSet}:${region}:${Math.round(radius)}:${geohash}`;

    try {
      const cached = await env.GEO_CACHE.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: new Headers({ ...Object.fromEntries(new Headers(corsHeaders(env))), 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' }),
        });
      }

      const data = await fetchPlacesFromAllSources(lat, lng, Math.round(radius), region, env);
      const responseBody: PlacesResponse = { geohash, region, data };
      const serialized = JSON.stringify(responseBody);

      try {
        await env.GEO_CACHE.put(cacheKey, serialized, {
          expirationTtl: CACHE_TTL_SECONDS,
        });
      } catch {
        // Keep provider results available if the optional cache write fails.
      }

      return new Response(serialized, {
        status: 200,
        headers: new Headers({ ...Object.fromEntries(new Headers(corsHeaders(env))), 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' }),
      });
    } catch {
      return jsonResponse({ error: 'Restaurant provider request failed' }, 502, env);
    }
  },
};