import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Heart, ListChecks, MapPin, Navigation, NotebookPen, Pencil, RotateCw, Settings, ShieldBan, Trash2, X } from 'lucide-react';
import { Roulette, type Restaurant } from '../components/Roulette';
import { ManagementDialog } from '../components/ManagementDialog';
import { add24hTempExclusion, getValidCandidates } from '../utils/filter';
import { db, type AppPreferences } from '../db';

interface MealNote {
  id?: number;
  placeId: string;
  restaurantName: string;
  rating: number;
  notes: string;
  updatedAt: number;
  publishedAt: number;
}

const DEFAULT_PREFERENCES: AppPreferences = { id: 'default', searchRadius: 500 };
const LOCATION_ID = 'last';
const CACHE_ID = 'latest_v3';
const CACHE_DISTANCE_METERS = 200;

type ViewMode = 'settings' | 'participants' | 'exclusions' | 'blacklist' | 'reviews' | 'favorites';

interface PlacesResponse {
  region: 'hk' | 'cn' | 'global';
  data: Restaurant[];
}

interface GoogleDetailsResponse {
  data: Partial<Restaurant>;
}

// 🌟 前端詳細數據緩衝佇列
let pendingDetailsQueue: Restaurant[] = [];

function flushBatchDetailsQueue() {
  if (pendingDetailsQueue.length === 0) return;
  const payload = [...pendingDetailsQueue];
  pendingDetailsQueue = []; // 清空佇列

  const base = import.meta.env.VITE_WORKER_API_URL?.replace(/\/$/, '') ?? '';
  const url = `${base}/api/places/batch-details`;

  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true, // 頁面關閉或切後台時依然能傳送完成
    }).catch(() => {
      // 失敗時補回佇列
      pendingDetailsQueue.unshift(...payload);
    });
  } catch {
    pendingDetailsQueue.unshift(...payload);
  }
}

function queueRestaurantDetail(detail: Restaurant) {
  if (!pendingDetailsQueue.some((item) => item.id === detail.id)) {
    pendingDetailsQueue.push(detail);
  }
  if (pendingDetailsQueue.length >= 5) {
    flushBatchDetailsQueue();
  }
}

function formatBadgeCount(count: number): string {
  if (count >= 1000) {
    const k = Math.floor(count / 1000);
    return `${k}k+`;
  }
  return String(count);
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(lat2 - lat1);
  const longitudeDelta = radians(lng2 - lng1);
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function getCurrentLocation(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('此裝置不支援定位服務。'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lng: coords.longitude }),
      (error) => reject(new Error(error.code === error.PERMISSION_DENIED
        ? '請允許定位，才能搜尋附近餐廳。'
        : '目前無法取得定位，請稍後重試。')),
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 8_000 },
    );
  });
}

function getDataRegion(lat: number, lng: number): PlacesResponse['region'] {
  const inChinaBounds = lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
  const inHongKong = lat >= 22.15 && lat <= 22.57 && lng >= 113.82 && lng <= 114.45;
  const inMacau = lat >= 22.1 && lat <= 22.24 && lng >= 113.52 && lng <= 113.62;
  const inTaiwan = lat >= 21.8 && lat <= 25.4 && lng >= 119.3 && lng <= 122.1;
  if (inHongKong) return 'hk';
  if (inChinaBounds && !inMacau && !inTaiwan) return 'cn';
  return 'global';
}

function workerApiUrl(path: string): string {
  const base = import.meta.env.VITE_WORKER_API_URL?.replace(/\/$/, '') ?? '';
  return `${base}${path}`;
}

async function fetchPlaces(
  location: { lat: number; lng: number },
  radius: number,
): Promise<PlacesResponse> {
  const query = new URLSearchParams({
    lat: String(location.lat),
    lng: String(location.lng),
    radius: String(radius),
  });
  const response = await fetch(workerApiUrl(`/api/places?${query}`));
  const result = await response.json() as PlacesResponse & { error?: string };
  if (!response.ok) throw new Error(result.error ?? '附近餐廳載入失敗。');
  if (!Array.isArray(result.data)) throw new Error('餐廳資料格式不正確。');
  return result;
}

async function fetchGoogleDetails(placeId: string): Promise<Partial<Restaurant>> {
  const query = new URLSearchParams({ id: placeId });
  const response = await fetch(workerApiUrl(`/api/places/details?${query}`));
  const result = await response.json() as GoogleDetailsResponse & { error?: string };
  if (!response.ok) throw new Error(result.error ?? '餐廳詳細資料載入失敗。');
  return result.data;
}

function getSmartNavUrl(restaurant: Restaurant, region: 'hk' | 'cn' | 'global'): string {
  if (region === 'cn') {
    if (restaurant.lat !== undefined && restaurant.lng !== undefined) {
      return `https://uri.amap.com/marker?coordinate=${restaurant.lng},${restaurant.lat}&name=${encodeURIComponent(restaurant.name)}&src=FatBuddy`;
    }
    return `https://uri.amap.com/search?keyword=${encodeURIComponent(restaurant.name)}`;
  }
  if (restaurant.googleMapsUri) {
    return restaurant.googleMapsUri;
  }
  if (restaurant.googlePlaceId) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(restaurant.name)}&query_place_id=${restaurant.googlePlaceId}`;
  }
  const searchText = encodeURIComponent(`${restaurant.name} ${restaurant.address ?? ''}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${searchText}`;
}

function formatPriceLevel(level?: string): string | undefined {
  if (!level || level === 'PRICE_LEVEL_UNSPECIFIED') return undefined;
  const labels: Record<string, string> = {
    PRICE_LEVEL_FREE: '免費',
    PRICE_LEVEL_INEXPENSIVE: '$',
    PRICE_LEVEL_MODERATE: '$$',
    PRICE_LEVEL_EXPENSIVE: '$$$',
    PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
  };
  return labels[level] ?? level;
}

export function formatCategory(type?: string): string | undefined {
  if (!type) return undefined;
  if (/[\u4e00-\u9fa5]/.test(type)) return type;

  const map: Record<string, string> = {
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
    'cafe': '咖啡店',
    'restaurant': '餐廳',
  };

  const key = type.toLowerCase().trim();
  return map[key] ?? type;
}

export const HomePage = () => {
  const [preferences, setPreferences] = useState<AppPreferences | null>(null);
  const [draftPreferences, setDraftPreferences] = useState<Omit<AppPreferences, 'id'>>(DEFAULT_PREFERENCES);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogView, setDialogView] = useState<ViewMode>('settings');
  const [candidates, setCandidates] = useState<Restaurant[]>([]);
  const [allCandidates, setAllCandidates] = useState<Restaurant[]>([]);
  const [tempExclusionCount, setTempExclusionCount] = useState<number>(0);
  const [currentSelected, setCurrentSelected] = useState<Restaurant | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteRating, setNoteRating] = useState(0);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [notesHistory, setNotesHistory] = useState<MealNote[]>([]);
  const [isFavorite, setIsFavorite] = useState(false);
  const [spinId, setSpinId] = useState(0);
  const rawCandidatesRef = useRef<Restaurant[]>([]);
  const selectedRestaurantRef = useRef<Restaurant | null>(null);

  // 🌟 定時器与切頁離場事件監聽：批量刷入 KV
  useEffect(() => {
    const timer = setInterval(() => {
      flushBatchDetailsQueue();
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushBatchDetailsQueue();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      flushBatchDetailsQueue(); // 組件卸載時整理一次
    };
  }, []);

  const updateSelection = (restaurant: Restaurant | null) => {
    if (restaurant?.id !== selectedRestaurantRef.current?.id) {
      setNoteText('');
      setNoteRating(0);
      setEditingNoteId(null);
      setNotesHistory([]);
      setIsFavorite(false);
    }
    selectedRestaurantRef.current = restaurant;
    setCurrentSelected(restaurant);
  };

  const loadFavoritesAndExclusionsCount = async () => {
    try {
      const [favs, activeExclusions] = await Promise.all([
        db.favorites.toArray(),
        db.tempExclusions.where('expiredAt').above(Date.now()).count(),
      ]);
      setFavoriteIds(new Set(favs.map((f) => f.id)));
      setTempExclusionCount(activeExclusions);
    } catch {
      // 靜默處理
    }
  };

  const openManagementView = (view: ViewMode) => {
    if (preferences) {
      setDraftPreferences({ searchRadius: preferences.searchRadius });
    }
    setDialogView(view);
    setDialogOpen(true);
  };

  useEffect(() => {
    void loadFavoritesAndExclusionsCount();
  }, [currentSelected, dialogOpen]);

  useEffect(() => {
    let cancelled = false;
    void db.preferences.get('default')
      .then((savedPreferences) => {
        if (cancelled) return;
        if (savedPreferences) {
          setPreferences(savedPreferences);
          setDraftPreferences({ searchRadius: savedPreferences.searchRadius });
        } else {
          setDialogView('settings');
          setDialogOpen(true);
        }
      })
      .catch(() => {
        if (!cancelled) setErrorMessage('無法讀取本機設定。');
      })
      .finally(() => {
        if (!cancelled) setPreferencesReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!preferencesReady || !preferences) return;
    let cancelled = false;
    let cacheWasDisplayed = false;

    const loadRestaurants = async () => {
      setErrorMessage('');
      setIsLoading(true);
      setIsRefreshing(false);
      let cache = null;
      let lastLocation = null;
      try {
        [cache, lastLocation] = await Promise.all([
          db.candidateCaches.get(CACHE_ID),
          db.lastKnownLocations.get(LOCATION_ID),
        ]);
      } catch {
        // 靜默處理
      }

      if (lastLocation && !cancelled) {
        setUserLocation({ lat: lastLocation.lat, lng: lastLocation.lng });
      }

      const lastRegion = lastLocation ? getDataRegion(lastLocation.lat, lastLocation.lng) : null;
      const settingsMatch = cache?.region === lastRegion;
      const locationPairMatch = cache && lastLocation
        && distanceMeters(cache.lat, cache.lng, lastLocation.lat, lastLocation.lng) < 1;

      if (cache && settingsMatch && locationPairMatch && cache.candidates.length > 0 && cache.radius >= preferences.searchRadius) {
        rawCandidatesRef.current = cache.candidates;
        const filtered = cache.candidates.filter((item: Restaurant) => 
          lastLocation && distanceMeters(lastLocation.lat, lastLocation.lng, item.lat, item.lng) <= preferences.searchRadius
        );
        setAllCandidates(filtered);
        setCandidates(await getValidCandidates(filtered));
        if (cancelled) return;
        updateSelection(null);
        setIsLoading(false);
        return;
      }

      if (cache && settingsMatch && locationPairMatch && cache.candidates.length > 0) {
        rawCandidatesRef.current = cache.candidates;
        setAllCandidates(cache.candidates);
        setCandidates(await getValidCandidates(cache.candidates));
        if (cancelled) return;
        updateSelection(null);
        setIsLoading(false);
        cacheWasDisplayed = true;
      }

      let location: { lat: number; lng: number };
      try {
        location = await getCurrentLocation();
        if (!cancelled) setUserLocation(location);
      } catch (locationError) {
        if (cancelled) return;
        setErrorMessage(locationError instanceof Error ? locationError.message : '定位失敗。');
        setIsLoading(false);
        return;
      }

      const region = getDataRegion(location.lat, location.lng);
      const cacheIsNearby = Boolean(cache && cache.region === region && cache.radius >= preferences.searchRadius
        && distanceMeters(cache.lat, cache.lng, location.lat, location.lng) < CACHE_DISTANCE_METERS);
      
      if (cacheIsNearby && cache) {
        rawCandidatesRef.current = cache.candidates;
        const filtered = cache.candidates.filter((item: Restaurant) => 
          distanceMeters(location.lat, location.lng, item.lat, item.lng) <= preferences.searchRadius
        );
        setAllCandidates(filtered);
        setCandidates(await getValidCandidates(filtered));
        setIsLoading(false);
        return;
      }

      if (!cacheIsNearby) {
        rawCandidatesRef.current = [];
        setAllCandidates([]);
        setCandidates([]);
        updateSelection(null);
        setIsLoading(true);
      } else {
        setIsRefreshing(true);
      }

      try {
        await db.lastKnownLocations.put({ id: LOCATION_ID, ...location, updatedAt: Date.now() });
        const result = await fetchPlaces(location, preferences.searchRadius);
        if (cancelled) return;
        rawCandidatesRef.current = result.data;
        setAllCandidates(result.data);
        await db.candidateCaches.put({
          id: CACHE_ID,
          ...location,
          region: result.region,
          radius: preferences.searchRadius,
          candidates: result.data,
          updatedAt: Date.now(),
        });
        const eligible = await getValidCandidates(result.data);
        if (cancelled) return;
        if (!selectedRestaurantRef.current) setCandidates(eligible);
        setErrorMessage('');
      } catch (requestError) {
        if (!cancelled) {
          const prefix = cacheWasDisplayed ? '目前顯示快取。' : '';
          setErrorMessage(`${prefix}${requestError instanceof Error ? requestError.message : '附近餐廳載入失敗。'}`);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    };

    void loadRestaurants();
    return () => { cancelled = true; };
  }, [preferences, preferencesReady]);

  const savePreferences = async () => {
    const nextPreferences: AppPreferences = { id: 'default', ...draftPreferences };
    if (preferences?.searchRadius === nextPreferences.searchRadius) {
      setDialogOpen(false);
      return;
    }
    await db.preferences.put(nextPreferences);
    setPreferences(nextPreferences);
    
    if (rawCandidatesRef.current.length > 0 && userLocation) {
      const filtered = rawCandidatesRef.current.filter((item) => 
        distanceMeters(userLocation.lat, userLocation.lng, item.lat, item.lng) <= nextPreferences.searchRadius
      );
      setAllCandidates(filtered);
      const eligible = await getValidCandidates(filtered);
      setCandidates(eligible);
      updateSelection(null);
    }

    setDialogOpen(false);
  };

  const refreshCandidates = async () => {
    const eligible = await getValidCandidates(rawCandidatesRef.current);
    setCandidates(eligible);
    await loadFavoritesAndExclusionsCount();
    if (selectedRestaurantRef.current && !eligible.some((place) => place.id === selectedRestaurantRef.current?.id)) {
      updateSelection(null);
    }
  };

  const handleNextTime = async () => {
    if (!currentSelected) return;
    await add24hTempExclusion(currentSelected.id, currentSelected);
    await refreshCandidates();
    updateSelection(null);
    setSpinId((current) => current + 1);
  };

  const handleBlacklist = async () => {
    if (!currentSelected) return;
    await db.blacklists.put({
      placeId: currentSelected.id,
      restaurantName: currentSelected.name,
      address: currentSelected.address,
      createdAt: Date.now(),
    });
    await refreshCandidates();
    updateSelection(null);
  };

  const handleReroll = () => {
    updateSelection(null);
    setSpinId((current) => current + 1);
  };

  const toggleFavorite = async () => {
    if (!currentSelected) return;
    if (isFavorite) {
      await db.favorites.delete(currentSelected.id);
      setIsFavorite(false);
    } else {
      await db.favorites.put({ ...currentSelected, savedAt: Date.now() });
      setIsFavorite(true);
    }
    await loadFavoritesAndExclusionsCount();
  };

  const handleNavClick = (restaurant: Restaurant) => {
    const googleId = restaurant.googlePlaceId || (restaurant.id.startsWith('google:') ? restaurant.id.slice(7) : null);
    if (!googleId) return;

    void fetchGoogleDetails(`google:${googleId}`).then((detailed) => {
      let fullUpdatedRestaurant: Restaurant | null = null;

      const mergeDetails = (item: Restaurant) => {
        const isMatch = item.id === restaurant.id || (googleId && item.googlePlaceId === googleId);
        if (!isMatch) return item;

        const merged: Restaurant = {
          ...item,
          name: detailed.name || item.name,
          address: detailed.address || item.address,
          rating: detailed.rating ?? item.rating,
          userRatingCount: detailed.userRatingCount ?? item.userRatingCount,
          priceLevel: detailed.priceLevel ?? item.priceLevel,
          type: formatCategory(detailed.type) || item.type,
          phone: detailed.phone || item.phone,
          googleMapsUri: detailed.googleMapsUri || item.googleMapsUri,
          dataUpdatedAt: detailed.dataUpdatedAt ?? item.dataUpdatedAt,
        };

        fullUpdatedRestaurant = merged;
        return merged;
      };

      rawCandidatesRef.current = rawCandidatesRef.current.map(mergeDetails);
      setAllCandidates((prev) => prev.map(mergeDetails));
      setCandidates((prev) => prev.map(mergeDetails));

      if (selectedRestaurantRef.current?.id === restaurant.id) {
        setCurrentSelected((prev) => (prev ? mergeDetails(prev) : null));
      }

      // 🌟 将查询到的最新餐厅详情推送至本地打包队列
      if (fullUpdatedRestaurant) {
        queueRestaurantDetail(fullUpdatedRestaurant);
      }
    }).catch(() => {
      // 靜默處理
    });
  };

  const saveNote = async () => {
    if (!currentSelected || !noteText.trim() || noteRating < 1) return;
    setIsSavingNote(true);
    try {
      const now = Date.now();
      if (editingNoteId) {
        await db.notes.update(editingNoteId, {
          rating: noteRating,
          notes: noteText.trim(),
          updatedAt: now,
        });
      } else {
        await db.notes.add({
          placeId: currentSelected.id,
          restaurantName: currentSelected.name,
          rating: noteRating,
          notes: noteText.trim(),
          updatedAt: now,
          publishedAt: now,
        });
      }
      setNoteText('');
      setNoteRating(0);
      setEditingNoteId(null);
      const updatedNotes = await db.notes.where('placeId').equals(currentSelected.id).toArray();
      setNotesHistory((updatedNotes as MealNote[]).sort((a, b) => b.updatedAt - a.updatedAt));
    } catch {
      setErrorMessage('評論發布失敗。');
    } finally {
      setIsSavingNote(false);
    }
  };

  const startEditNote = (note: MealNote) => {
    if (!note.id) return;
    setEditingNoteId(note.id);
    setNoteText(note.notes);
    setNoteRating(note.rating);
  };

  const cancelEditNote = () => {
    setEditingNoteId(null);
    setNoteText('');
    setNoteRating(0);
  };

  const deleteNote = async (noteId?: number) => {
    if (!noteId || !currentSelected) return;
    await db.notes.delete(noteId);
    if (editingNoteId === noteId) cancelEditNote();
    const updatedNotes = await db.notes.where('placeId').equals(currentSelected.id).toArray();
    setNotesHistory((updatedNotes as MealNote[]).sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const currentRegion = userLocation ? getDataRegion(userLocation.lat, userLocation.lng) : 'global';
  const displayedRating = currentSelected?.rating ?? 0;
  const displayedUserRatingCount = currentSelected?.userRatingCount ?? 0;
  const displayedPrice = currentSelected?.source === 'google'
    ? formatPriceLevel(currentSelected?.priceLevel || currentSelected?.price)
    : currentSelected?.price;

  const processedCandidates = useMemo(() => {
    return candidates.map((item) => {
      const dist = userLocation && item.lat && item.lng
        ? distanceMeters(userLocation.lat, userLocation.lng, item.lat, item.lng)
        : null;
      return {
        ...item,
        type: formatCategory(item.type),
        calculatedDistance: dist,
        isFav: favoriteIds.has(item.id),
      };
    }).sort((a, b) => {
      if (a.isFav !== b.isFav) return a.isFav ? -1 : 1;
      if (a.calculatedDistance !== null && b.calculatedDistance !== null) {
        return a.calculatedDistance - b.calculatedDistance;
      }
      return 0;
    });
  }, [candidates, userLocation, favoriteIds]);

  return (
    <main className="min-h-screen bg-[#f7f8f4] dark:bg-[#101613] px-4 py-6 text-[#1d241e] dark:text-[#edf2ed] transition-colors duration-200 sm:px-6">
      <div className="mx-auto flex min-h-[calc(100svh-3rem)] w-full max-w-xl flex-col">
        {/* Header 頂部欄 */}
        <header className="flex items-center justify-between pb-3">
          <div>
            <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-[#6b7a66] dark:text-[#88a385]">FATBUDDY / NEARBY</p>
            <h1 className="mt-0.5 text-2xl font-black tracking-tight text-[#162118] dark:text-[#eaf2ea]">今天吃什麼？</h1>
          </div>
          
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openManagementView('settings')}
              className="grid size-10 cursor-pointer place-items-center rounded-2xl border border-[#dfe4d8] dark:border-[#25352b] bg-white dark:bg-[#17211b] text-[#344434] dark:text-[#d0ded0] shadow-xs transition-all duration-150 hover:scale-105 active:scale-95"
              aria-label="搜尋設定"
            >
              <Settings className="size-4.5" />
            </button>

            <button
              type="button"
              onClick={() => openManagementView('exclusions')}
              className="relative grid size-10 cursor-pointer place-items-center rounded-2xl border border-[#dfe4d8] dark:border-[#25352b] bg-white dark:bg-[#17211b] text-[#344434] dark:text-[#d0ded0] shadow-xs transition-all duration-150 hover:scale-105 active:scale-95"
              aria-label="臨時排除"
            >
              <Clock3 className="size-4.5" />
              {tempExclusionCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#c34f54] px-1 text-[9px] font-bold text-white shadow-xs">
                  {formatBadgeCount(tempExclusionCount)}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => openManagementView('participants')}
              className="relative grid size-10 cursor-pointer place-items-center rounded-2xl border border-[#dfe4d8] dark:border-[#25352b] bg-white dark:bg-[#17211b] text-[#344434] dark:text-[#d0ded0] shadow-xs transition-all duration-150 hover:scale-105 active:scale-95"
              aria-label="參與抽選列表"
            >
              <ListChecks className="size-4.5" />
              {candidates.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#263d30] dark:bg-[#3d5746] px-1 text-[9px] font-bold text-white shadow-xs">
                  {formatBadgeCount(candidates.length)}
                </span>
              )}
            </button>
          </div>
        </header>

        {/* 輪盤主區域 */}
        <section className="flex flex-1 flex-col items-center justify-center py-2">
          {isLoading ? (
            <div className="grid min-h-[260px] place-items-center text-sm font-medium text-[#6b7a66] dark:text-[#9eb09a] animate-pulse">正在搜尋附近餐廳…</div>
          ) : candidates.length === 0 ? (
            <div className="grid min-h-[260px] max-w-sm place-items-center text-center">
              <div>
                <p className="font-bold text-base">{errorMessage ? '目前無法開始抽選' : '附近沒有餐廳'}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-[#6b7a66] dark:text-[#9eb09a]">{errorMessage || '試著在設定中調大搜尋半徑。'}</p>
                <button type="button" onClick={() => openManagementView('settings')} className="mt-4 cursor-pointer rounded-full bg-[#263d30] dark:bg-[#3d5746] px-5 py-2.5 text-xs font-bold text-white shadow-sm transition-all hover:scale-105 active:scale-95">調整搜尋設定</button>
              </div>
            </div>
          ) : (
            <Roulette key={spinId} candidates={processedCandidates} autoStart onFinish={updateSelection} />
          )}

          {!isLoading && candidates.length > 0 && (
            <div className="mt-3.5 inline-flex items-center gap-2 rounded-full border border-[#dfe4d8] dark:border-[#25352b] bg-white/80 dark:bg-[#16201a]/80 px-4 py-1.5 text-xs font-bold text-[#4a5c47] dark:text-[#9bb398] shadow-xs backdrop-blur-xs">
              {isRefreshing ? <RotateCw className="size-3.5 animate-spin" /> : <MapPin className="size-3.5 text-[#263d30] dark:text-[#88c298]" />}
              <span>{isRefreshing ? '背景更新中' : `${preferences?.searchRadius ?? 500} 公尺內`}</span>
            </div>
          )}

          {errorMessage && !isLoading && <p role="status" className="mt-2 text-center text-xs text-[#c34f54] dark:text-[#e07579]">{errorMessage}</p>}
        </section>

        {/* 選中餐廳卡片 */}
        {currentSelected && preferences && (
          <section className="mt-2 mb-3 rounded-3xl border border-[#dfe4d8] dark:border-[#25352b] bg-white dark:bg-[#16201a] p-5 shadow-xl shadow-black/5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 text-left">
                <span className="inline-block rounded-full bg-[#eef3ec] dark:bg-[#223328] px-2.5 py-0.5 text-[10px] font-extrabold tracking-wider uppercase text-[#395237] dark:text-[#9ac497]">就吃這家</span>
                <h2 className="mt-1.5 break-words text-xl font-black tracking-tight text-[#162118] dark:text-[#eaf2ea]">{currentSelected.name}</h2>
                <p className="mt-1 break-words text-xs leading-relaxed text-[#6b7a66] dark:text-[#98aba6]">{currentSelected.address || '地址資訊未提供'}</p>
                
                <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
                  {displayedRating > 0 ? (
                    <span className="font-bold text-[#b88228] dark:text-[#e6b363]">
                      ★ {displayedRating.toFixed(1)}
                      {typeof displayedUserRatingCount === 'number' && displayedUserRatingCount > 0 && (
                        <span className="ml-1 text-[11px] font-normal text-[#879083]">({displayedUserRatingCount})</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#879083]">尚無評分</span>
                  )}

                  {displayedPrice && (
                    <span className="rounded-md bg-[#f4eee4] dark:bg-[#332b20] px-2 py-0.5 text-[11px] font-bold text-[#8a611c] dark:text-[#e0b263]">
                      {displayedPrice}
                    </span>
                  )}

                  {currentSelected.type && (
                    <span className="rounded-md bg-[#eef3ec] dark:bg-[#223328] px-2 py-0.5 text-[11px] font-medium text-[#445c42] dark:text-[#a0c49f]">
                      {formatCategory(currentSelected.type)}
                    </span>
                  )}
                </div>

                {(currentSelected.phone || currentSelected.openingHours) && (
                  <div className="mt-2.5 space-y-1 border-t border-[#f2f4ee] dark:border-[#202c25] pt-2 text-xs text-[#6b7a66] dark:text-[#98aba6]">
                    {currentSelected.phone && <p>電話：{currentSelected.phone}</p>}
                    {currentSelected.openingHours && <p>營業時間：{currentSelected.openingHours}</p>}
                  </div>
                )}
              </div>

              <a
                href={getSmartNavUrl(currentSelected, currentRegion)}
                target="_blank"
                rel="noreferrer"
                onClick={() => handleNavClick(currentSelected)}
                title="開啟地圖導航"
                aria-label="開啟地圖導航"
                className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-2xl bg-[#263d30] dark:bg-[#3d5746] text-white shadow-md transition-all duration-150 hover:scale-105 active:scale-95"
              >
                <Navigation className="size-5" />
              </a>
            </div>

            {/* 食記與評論區 */}
            <div className="mt-4 border-t border-[#f2f4ee] dark:border-[#202c25] pt-3.5">
              <div className="flex items-center justify-between text-xs font-bold">
                <label htmlFor="meal-note" className="flex items-center gap-1.5 text-[#1d241e] dark:text-[#edf2ed]">
                  <NotebookPen className="size-3.5 text-[#526950] dark:text-[#88ab86]" />
                  {editingNoteId ? '編輯評論' : '我的評論'}
                </label>
                {editingNoteId && (
                  <button type="button" onClick={cancelEditNote} className="inline-flex items-center gap-1 text-[11px] text-[#879083] hover:underline">
                    <X className="size-3" /> 取消
                  </button>
                )}
              </div>
              
              <textarea
                id="meal-note"
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder="記錄這次的用餐心得與評分…"
                className="mt-2 w-full resize-y rounded-2xl border border-[#dfe4d8] dark:border-[#25352b] bg-[#fafbfa] dark:bg-[#121a15] p-3 text-xs text-[#1d241e] dark:text-[#edf2ed] placeholder-[#879083] outline-none focus:border-[#425e40]"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1" aria-label="評分">
                  {[1, 2, 3, 4, 5].map((rating) => (
                    <button key={rating} type="button" onClick={() => setNoteRating(rating)} className={`size-7 cursor-pointer text-base transition-all hover:scale-125 ${rating <= noteRating ? 'text-[#d69a34]' : 'text-[#cbd1c8] dark:text-[#2d3b32]'}`} aria-label={`${rating}分`}>
                      ★
                    </button>
                  ))}
                </div>
                <button type="button" onClick={saveNote} disabled={!noteText.trim() || noteRating < 1 || isSavingNote} className="cursor-pointer rounded-full border border-[#dfe4d8] dark:border-[#25352b] bg-white dark:bg-[#17211b] px-3.5 py-1.5 text-xs font-bold text-[#344434] dark:text-[#e0ebe0] transition-all hover:scale-105 disabled:opacity-40">
                  {isSavingNote ? '儲存中…' : editingNoteId ? '更新評論' : '發布評論'}
                </button>
              </div>

              {notesHistory.length > 0 && (
                <div className="mt-3 space-y-2 border-t border-[#f2f4ee] dark:border-[#202c25] pt-3">
                  <p className="text-[11px] font-bold text-[#6b7a66] dark:text-[#9eb09a]">過往食記 ({notesHistory.length})</p>
                  <div className="max-h-36 space-y-2 overflow-y-auto pr-1">
                    {notesHistory.map((note) => (
                      <div key={note.id ?? note.publishedAt} className="rounded-2xl border border-[#eef3ec] dark:border-[#243329] bg-[#f8faf7] dark:bg-[#141d18] p-3 text-xs text-left">
                        <div className="flex items-center justify-between text-[#916229] dark:text-[#e0aa53]">
                          <span className="font-bold">{'★'.repeat(note.rating)}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-[#879083]">{new Date(note.publishedAt ?? note.updatedAt).toLocaleDateString()}</span>
                            <button type="button" onClick={() => startEditNote(note)} title="編輯" className="text-[#526950] hover:scale-110"><Pencil className="size-3.5" /></button>
                            <button type="button" onClick={() => void deleteNote(note.id)} title="刪除" className="text-[#c34f54] hover:scale-110"><Trash2 className="size-3.5" /></button>
                          </div>
                        </div>
                        <p className="mt-1 whitespace-pre-line leading-relaxed text-[#344434] dark:text-[#d0ded0]">{note.notes}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 底部按鈕列 */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#f2f4ee] dark:border-[#202c25] pt-3">
              <button type="button" onClick={toggleFavorite} aria-pressed={isFavorite} className={`inline-flex cursor-pointer items-center gap-1 px-2 py-1.5 text-xs font-medium transition-all hover:scale-105 ${isFavorite ? 'font-bold text-[#c34f54]' : 'text-[#6b7a66] dark:text-[#98aba6]'}`}>
                <Heart className={`size-4 ${isFavorite ? 'fill-current' : ''}`} />{isFavorite ? '已收藏' : '收藏'}
              </button>
              <button type="button" onClick={handleBlacklist} className="inline-flex cursor-pointer items-center gap-1 px-2 py-1.5 text-xs font-medium text-[#6b7a66] dark:text-[#98aba6] hover:scale-105"><ShieldBan className="size-4" />永久排除</button>
              <button type="button" onClick={handleReroll} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[#dfe4d8] dark:border-[#25352b] bg-white dark:bg-[#17211b] px-3.5 py-1.5 text-xs font-bold text-[#344434] dark:text-[#e0ebe0] transition-all hover:scale-105"><RotateCw className="size-3.5" />再轉一次</button>
              <button type="button" onClick={handleNextTime} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#eef3ec] dark:bg-[#223328] px-4 py-1.5 text-xs font-bold text-[#344434] dark:text-[#c0d4c0] transition-all hover:scale-105"><RotateCw className="size-3.5" />排除此店</button>
            </div>
          </section>
        )}

        <footer className="py-2 text-center text-xs text-[#879083]">
          <span className="block">{candidates.length > 0 && !currentSelected ? `${candidates.length} 家餐廳參與抽選` : '本機保存偏好與評論'}</span>
        </footer>
      </div>

      {dialogOpen && (
        <ManagementDialog
          preferences={preferences}
          draftPreferences={draftPreferences}
          setDraftPreferences={setDraftPreferences}
          candidates={processedCandidates}
          allCandidates={allCandidates}
          rawCandidates={rawCandidatesRef.current}
          userLocation={userLocation}
          initialView={dialogView}
          onSavePreferences={savePreferences}
          onClose={() => setDialogOpen(false)}
          onRefreshCandidates={refreshCandidates}
          onNavClick={handleNavClick}
        />
      )}
    </main>
  );
};