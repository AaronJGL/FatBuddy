import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

const createEnv = (cachedValue: string | null = null) => ({
  GEO_CACHE: {
    get: vi.fn().mockResolvedValue(cachedValue),
    put: vi.fn().mockResolvedValue(undefined),
  },
  AMAP_KEY: 'amap-test-key',
  GOOGLE_MAPS_KEY: 'google-test-key',
}) as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/places', () => {
  it('rejects missing coordinates', async () => {
    const env = createEnv();
    const response = await worker.fetch(new Request('https://api.example.com/api/places'), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'lat and lng are required numbers' });
  });

  it('accepts zero coordinates and normalizes Google Places', async () => {
    const env = createEnv();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('FeatureServer/0/query')) {
        return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        places: [{
          id: 'place-123',
          displayName: { text: 'Zero Point Cafe' },
          location: { latitude: 0, longitude: 0 },
          primaryType: 'cafe',
          primaryTypeDisplayName: { text: 'Cafe' },
          formattedAddress: 'Null Island',
        }],
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://api.example.com/api/places?lat=0&lng=0&region=hk&radius=500'),
      env,
    );
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    const googleCall = fetchMock.mock.calls.find(([input]) => String(input).includes('places.googleapis.com'))!;
    const googleRequest = googleCall[0] as RequestInfo | URL;
    const googleInit = googleCall[1] as RequestInit;

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache')).toBe('MISS');
    expect(body.data).toEqual([{
      id: 'google:place-123',
      name: 'Zero Point Cafe',
      lat: 0,
      lng: 0,
      rating: 0,
      address: 'Null Island',
      source: 'google',
      type: 'Cafe',
    }]);
    expect(String(googleRequest)).toBe('https://places.googleapis.com/v1/places:searchNearby');
    expect(JSON.parse(String(googleInit.body))).toMatchObject({
      locationRestriction: { circle: { radius: 500, center: { latitude: 0, longitude: 0 } } },
    });
    const googleHeaders = googleInit.headers as Record<string, string>;
    expect(googleHeaders['X-Goog-FieldMask']).not.toContain('places.rating');
    expect(googleHeaders['X-Goog-FieldMask']).toContain('places.primaryType');
    expect(env.GEO_CACHE.put).toHaveBeenCalledOnce();
    expect(env.GEO_CACHE.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { expirationTtl: 60 * 60 * 24 },
    );
  });

  it('supplements Google results with nearby FEHD restaurants and removes duplicates', async () => {
    const env = createEnv();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('FeatureServer/0/query')) {
        return Promise.resolve(new Response(JSON.stringify({
          features: [
            {
              attributes: {
                OBJECTID: 1,
                NSEARCH03_TC: '甲餐廳',
                ADDRESS_TC: '中環一號',
                NAME_TC: '普通食肆',
                LATITUDE: '22.3',
                LONGITUDE: '114.2',
                LASTUPDATE: '2026-09-29',
              },
              geometry: { x: 114.2, y: 22.3 },
            },
            {
              attributes: {
                OBJECTID: 2,
                NSEARCH03_TC: '乙茶餐廳',
                ADDRESS_TC: '中環二號',
                NAME_TC: '小食食肆',
                LATITUDE: '22.301',
                LONGITUDE: '114.201',
                LASTUPDATE: '2026-09-29',
              },
              geometry: { x: 114.201, y: 22.301 },
            },
          ],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        places: [{
          id: 'google-1',
          displayName: { text: '甲餐廳' },
          location: { latitude: 22.3, longitude: 114.2 },
          rating: 4.5,
          formattedAddress: '中環一號',
        }],
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://api.example.com/api/places?lat=22.3&lng=114.2&radius=500'),
      env,
    );
    const body = await response.json() as { region: string; data: Array<Record<string, unknown>> };
    const fehdRequest = new URL(String(fetchMock.mock.calls.find(([input]) => String(input).includes('FeatureServer/0/query'))?.[0]));

    expect(response.status).toBe(200);
    expect(body.region).toBe('hk');
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ id: 'google:google-1', rating: 0, source: 'google' });
    expect(body.data[1]).toMatchObject({
      id: 'fehd:2',
      name: '乙茶餐廳',
      lat: 22.301,
      lng: 114.201,
      rating: 0,
      address: '中環二號',
      source: 'fehd',
      licenseType: '小食食肆',
      dataUpdatedAt: '2026-09-29',
    });
    expect(fehdRequest.searchParams.get('geometry')).toBe('114.2,22.3');
    expect(fehdRequest.searchParams.get('distance')).toBe('500');
    expect(fehdRequest.searchParams.get('outSR')).toBe('4326');
  });

  it('queries Google, Amap, and FEHD concurrently in Hong Kong', async () => {
    const env = createEnv();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const requestUrl = String(input);
      if (requestUrl.includes('FeatureServer/0/query')) {
        return Promise.resolve(new Response(JSON.stringify({ features: [] }), { status: 200 }));
      }
          if (requestUrl.includes('restapi.amap.com')) {
        return Promise.resolve(new Response(JSON.stringify({
          status: '1',
            pois: [
              {
                id: 'amap-duplicate',
                name: '海底捞火锅',
                location: '114.204001,22.304001',
                address: '九龍測試街 2 號',
                biz_ext: { rating: '4.3' },
              },
              {
                id: 'amap-unique',
                name: '高德獨有餐廳',
                location: '114.205000,22.305000',
                address: '九龍測試街 1 號',
                biz_ext: { rating: '4.1' },
              },
            ],
        }), { status: 200 }));
      }
          if (requestUrl.includes('overpass-api.de')) {
            return Promise.resolve(new Response(JSON.stringify({ elements: [] }), { status: 200 }));
          }
      return Promise.resolve(new Response(JSON.stringify({
        places: [
          {
            id: 'google-unique',
            displayName: { text: 'Google 獨有餐廳' },
            location: { latitude: 22.304, longitude: 114.204 },
            rating: 4.7,
            formattedAddress: '九龍測試街 2 號',
          },
          {
            id: 'google-duplicate',
            displayName: { text: '海底撈火鍋' },
            location: { latitude: 22.304, longitude: 114.204 },
            rating: 4.8,
            formattedAddress: '九龍測試街 2 號',
          },
        ],
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://api.example.com/api/places?lat=22.3&lng=114.2&radius=1000'),
      env,
    );
    const body = await response.json() as { region: string; data: Array<Record<string, unknown>> };
    const urls = fetchMock.mock.calls.map(([input]) => String(input));

    expect(response.status).toBe(200);
    expect(body.region).toBe('hk');
      expect(urls).toHaveLength(4);
    expect(urls.some((url) => url.includes('places.googleapis.com'))).toBe(true);
    expect(urls.some((url) => url.includes('restapi.amap.com'))).toBe(true);
    expect(urls.some((url) => url.includes('FeatureServer/0/query'))).toBe(true);
    expect(body.data.map((place) => place.source)).toEqual(['google', 'google', 'amap']);
    expect(body.data.some((place) => place.id === 'amap:amap-duplicate')).toBe(false);
  });

  it('uses OSM worldwide and reads node and way-center coordinates', async () => {
    const env = createEnv();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const requestUrl = String(input);
      if (requestUrl.includes('overpass-api.de')) {
        return Promise.resolve(new Response(JSON.stringify({
          elements: [
            {
              type: 'node',
              id: 123,
              lat: 35.6595,
              lon: 139.7005,
              tags: { name: '東京食堂', amenity: 'restaurant', 'addr:city': '東京' },
            },
            {
              type: 'way',
              id: 456,
              center: { lat: 35.66, lon: 139.701 },
              tags: { name: 'Sushi Cafe', amenity: 'cafe' },
            },
          ],
        }), { status: 200 }));
      }
      if (requestUrl.includes('places.googleapis.com')) {
        return Promise.resolve(new Response(JSON.stringify({ places: [] }), { status: 200 }));
      }
      throw new Error('Amap should not be queried for global locations');
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://api.example.com/api/places?lat=35.6595&lng=139.7005&radius=500'),
      env,
    );
    const body = await response.json() as { region: string; data: Array<Record<string, unknown>> };
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    const osmCall = fetchMock.mock.calls.find(([input]) => String(input).includes('overpass-api.de'));
    const osmInit = osmCall?.[1] as RequestInit;
    const osmBody = new URLSearchParams(String(osmInit.body));

    expect(response.status).toBe(200);
    expect(body.region).toBe('global');
    expect(body.data).toEqual([
      {
        id: 'osm:node:123',
        name: '東京食堂',
        lat: 35.6595,
        lng: 139.7005,
        rating: 0,
        address: '東京',
        source: 'osm',
        type: 'restaurant',
      },
      {
        id: 'osm:way:456',
        name: 'Sushi Cafe',
        lat: 35.66,
        lng: 139.701,
        rating: 0,
        address: '',
        source: 'osm',
        type: 'cafe',
      },
    ]);
    expect(urls.some((url) => url.includes('restapi.amap.com'))).toBe(false);
    expect(osmBody.get('data')).toContain('around:500,35.6595,139.7005');
    expect(osmInit.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to OSM when the mainland Amap key has the wrong platform', async () => {
    const env = createEnv();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const requestUrl = String(input);
      if (requestUrl.includes('restapi.amap.com')) {
        return Promise.resolve(new Response(JSON.stringify({
          status: '0',
          info: 'USERKEY_PLAT_NOMATCH',
        }), { status: 200 }));
      }
      if (requestUrl.includes('places.googleapis.com')) {
        return Promise.resolve(new Response(JSON.stringify({ places: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        elements: [{
          type: 'node',
          id: 789,
          lat: 39.9,
          lon: 116.3,
          tags: { name: '北京 OSM 食堂', amenity: 'restaurant' },
        }],
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://api.example.com/api/places?lat=39.9&lng=116.3&radius=500'),
      env,
    );
    const body = await response.json() as { region: string; data: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.region).toBe('cn');
    expect(body.data).toEqual([{
      id: 'osm:node:789',
      name: '北京 OSM 食堂',
      lat: 39.9,
      lng: 116.3,
      rating: 0,
      address: '',
      source: 'osm',
      type: 'restaurant',
    }]);
  });

  it('uses FEHD restaurant data when Google Places is unavailable', async () => {
    const env = createEnv();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('FeatureServer/0/query')) {
        return Promise.resolve(new Response(JSON.stringify({
          features: [{
            attributes: {
              OBJECTID: 3,
              NSEARCH03_TC: '丙茶餐廳',
              ADDRESS_TC: '灣仔道三號',
              LATITUDE: '22.276',
              LONGITUDE: '114.172',
            },
            geometry: { x: 114.172, y: 22.276 },
          }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Google unavailable', { status: 503 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://api.example.com/api/places?lat=22.276&lng=114.172'),
      env,
    );
    const body = await response.json() as { region: string; data: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.region).toBe('hk');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: 'fehd:3',
      name: '丙茶餐廳',
      source: 'fehd',
      rating: 0,
    });
  });

  it('fetches expensive Google review and price fields only on details request and does not cache them', async () => {
    const env = createEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      rating: 4.7,
      userRatingCount: 218,
      priceLevel: 'PRICE_LEVEL_MODERATE',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://api.example.com/api/places/details?id=google:place-123'),
      env,
    );
    const body = await response.json() as { data: Record<string, unknown> };
    const placeRequest = fetchMock.mock.calls[0];
    const detailsUrl = new URL(String(placeRequest[0]));
    const detailsHeaders = placeRequest[1].headers as Record<string, string>;

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ rating: 4.7, userRatingCount: 218, priceLevel: 'PRICE_LEVEL_MODERATE' });
    expect(detailsUrl.pathname).toBe('/v1/places/place-123');
    expect(detailsHeaders['X-Goog-FieldMask']).toBe('rating,userRatingCount,priceLevel');
    expect(env.GEO_CACHE.get).not.toHaveBeenCalled();
    expect(env.GEO_CACHE.put).not.toHaveBeenCalled();
  });

  it('normalizes Amap POIs and uses GPS-to-Amap coordinates', async () => {
    const env = createEnv();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const requestUrl = String(input);
      if (requestUrl.includes('restapi.amap.com')) {
        return Promise.resolve(new Response(JSON.stringify({
          status: '1',
          pois: [{
            id: 'B0FF123',
            name: '測試餐廳',
            type: '餐飲服務;中餐廳',
            location: '116.404000,39.915000',
            address: ['北京市', '東城區'],
            biz_ext: { rating: '4.2', cost: '68' },
          }],
        }), { status: 200 }));
      }
      if (requestUrl.includes('places.googleapis.com')) {
        return Promise.resolve(new Response(JSON.stringify({ places: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ elements: [] }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://api.example.com/api/places?lat=39.9&lng=116.3&radius=1000'),
      env,
    );
    const body = await response.json() as { region: string; data: Array<Record<string, unknown>> };
    const amapRequest = fetchMock.mock.calls.find(([input]) => String(input).includes('restapi.amap.com'));
    const amapUrl = new URL(String(amapRequest?.[0]));

    expect(response.status).toBe(200);
    expect(body.region).toBe('cn');
    expect(body.data).toEqual([{
      id: 'amap:B0FF123',
      name: '測試餐廳',
      lat: 39.915,
      lng: 116.404,
      rating: 4.2,
      address: '北京市東城區',
      source: 'amap',
      type: '餐飲服務;中餐廳',
      price: '68',
    }]);
    expect(amapUrl.origin + amapUrl.pathname).toBe('https://restapi.amap.com/v3/place/around');
    expect(amapUrl.searchParams.get('location')).not.toBe('116.300000,39.900000');
    expect(amapUrl.searchParams.get('radius')).toBe('1000');
  });

  it('serves a cached response without calling a provider', async () => {
    const cachedValue = JSON.stringify({ geohash: 'wx4g0b', data: [] });
    const env = createEnv(cachedValue);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://api.example.com/api/places?lat=22.3&lng=114.2&region=hk&radius=1000'),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache')).toBe('HIT');
    expect(await response.text()).toBe(cachedValue);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(env.GEO_CACHE.put).not.toHaveBeenCalled();
  });

  it('rejects an unsupported region', async () => {
    const response = await worker.fetch(
      new Request('https://api.example.com/api/places?lat=22.3&lng=114.2&region=us'),
      createEnv(),
    );

    expect(response.status).toBe(400);
  });
});