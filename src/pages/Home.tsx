import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Heart, ListChecks, MapPin, Navigation, NotebookPen, RotateCw, Settings, ShieldBan } from 'lucide-react';
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
const CACHE_ID = 'latest_v2';
const CACHE_DISTANCE_METERS = 200;

type ViewMode = 'settings' | 'participants' | 'exclusions' | 'blacklist' | 'reviews' | 'favorites';

interface PlacesResponse {
  region: 'hk' | 'cn' | 'global';
  data: Restaurant[];
}

interface GoogleDetailsResponse {
  data: {
    rating: number;
    userRatingCount?: number;
    priceLevel?: string;
  };
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

async function fetchGoogleDetails(placeId: string): Promise<GoogleDetailsResponse['data']> {
  const query = new URLSearchParams({ id: placeId });
  const response = await fetch(workerApiUrl(`/api/places/details?${query}`));
  const result = await response.json() as GoogleDetailsResponse & { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'Google 餐廳資料載入失敗。');
  return result.data;
}

function getNavigationLinks(restaurant: Restaurant): Array<{ name: string; url: string }> {
  const searchText = encodeURIComponent(`${restaurant.name} ${restaurant.address ?? ''}`.trim());
  const googleUrl = restaurant.googlePlaceId
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(restaurant.name)}&query_place_id=${restaurant.googlePlaceId}`
    : `https://www.google.com/maps/search/?api=1&query=${searchText}`;
  const amapUrl = restaurant.lat !== undefined && restaurant.lng !== undefined
    ? `https://uri.amap.com/marker?coordinate=${restaurant.lng},${restaurant.lat}&name=${encodeURIComponent(restaurant.name)}&src=FatBuddy`
    : `https://uri.amap.com/search?keyword=${searchText}`;
  return [{ name: 'Google Maps', url: googleUrl }, { name: '高德地圖', url: amapUrl }];
}

function formatPriceLevel(level?: string): string | undefined {
  if (!level || level === 'PRICE_LEVEL_UNSPECIFIED') return undefined;
  const labels: Record<string, string> = {
    PRICE_LEVEL_FREE: '免費',
    PRICE_LEVEL_INEXPENSIVE: '$',     PRICE_LEVEL_MODERATE: '$$',     PRICE_LEVEL_EXPENSIVE: '$$$',     PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
  };
  return labels[level] ?? level;
}

export const HomePage = () => {
  const [preferences, setPreferences] = useState<AppPreferences | null>(null);
  const [draftPreferences, setDraftPreferences] = useState<Omit<AppPreferences, 'id'>>(DEFAULT_PREFERENCES);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogView, setDialogView] = useState<ViewMode>('settings');
  const [radiusPreviewCount, setRadiusPreviewCount] = useState<number | null>(null);
  const [isPreviewingRadius, setIsPreviewingRadius] = useState(false);
  const [radiusPreviewError, setRadiusPreviewError] = useState('');
  const [candidates, setCandidates] = useState<Restaurant[]>([]);
  const [allCandidates, setAllCandidates] = useState<Restaurant[]>([]);
  const [currentSelected, setCurrentSelected] = useState<Restaurant | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [googleDetails, setGoogleDetails] = useState<{ placeId: string; data: GoogleDetailsResponse['data'] } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteRating, setNoteRating] = useState(0);
  const [notesHistory, setNotesHistory] = useState<MealNote[]>([]);
  const [isFavorite, setIsFavorite] = useState(false);
  const [spinId, setSpinId] = useState(0);
  const rawCandidatesRef = useRef<Restaurant[]>([]);
  const selectedRestaurantRef = useRef<Restaurant | null>(null);

  const updateSelection = (restaurant: Restaurant | null) => {
    if (restaurant?.id !== selectedRestaurantRef.current?.id) {
      setNoteText('');
      setNoteRating(0);
      setNotesHistory([]);
      setIsFavorite(false);
      setGoogleDetails(null);
    }
    selectedRestaurantRef.current = restaurant;
    setCurrentSelected(restaurant);
  };

  const loadFavorites = async () => {
    try {
      const favs = await db.favorites.toArray();
      setFavoriteIds(new Set(favs.map((f) => f.id)));
    } catch {
      // 靜默處理
    }
  };

  const openManagementView = (view: ViewMode) => {
    if (preferences) {
      setDraftPreferences({ searchRadius: preferences.searchRadius });
      setRadiusPreviewCount(candidates.length);
      setRadiusPreviewError('');
    }
    setDialogView(view);
    setDialogOpen(true);
  };

  useEffect(() => {
    void loadFavorites();
  }, [currentSelected]);

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
        if (!cancelled) setErrorMessage('無法讀取本機設定，請檢查瀏覽器儲存空間。');
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
        setErrorMessage('無法讀取本機餐廳快取。');
      }

      if (lastLocation && !cancelled) {
        setUserLocation({ lat: lastLocation.lat, lng: lastLocation.lng });
      }

      const lastRegion = lastLocation ? getDataRegion(lastLocation.lat, lastLocation.lng) : null;
      const settingsMatch = cache?.region === lastRegion && cache.radius === preferences.searchRadius;
      const locationPairMatch = cache && lastLocation
        && distanceMeters(cache.lat, cache.lng, lastLocation.lat, lastLocation.lng) < 1;
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
      const cacheIsNearby = Boolean(cache && cache.region === region && cache.radius === preferences.searchRadius
        && distanceMeters(cache.lat, cache.lng, location.lat, location.lng) < CACHE_DISTANCE_METERS);
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
        else if (!eligible.some((restaurant) => restaurant.id === selectedRestaurantRef.current?.id)) {
          setCandidates(eligible);
          updateSelection(null);
        }
        setErrorMessage('');
      } catch (requestError) {
        if (!cancelled) {
          const prefix = cacheWasDisplayed ? '目前顯示上次快取。' : '';
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

  useEffect(() => {
    if (!dialogOpen || dialogView !== 'settings') return;
    if (preferences && !isLoading && preferences.searchRadius === draftPreferences.searchRadius) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      const previewRadius = async () => {
        setIsPreviewingRadius(true);
        setRadiusPreviewError('');
        try {
          const savedLocation = await db.lastKnownLocations.get(LOCATION_ID);
          const location = savedLocation ?? await getCurrentLocation();
          const result = await fetchPlaces(location, draftPreferences.searchRadius);
          const eligible = await getValidCandidates(result.data);
          if (!cancelled) setRadiusPreviewCount(eligible.length);
        } catch (previewError) {
          if (!cancelled) setRadiusPreviewError(previewError instanceof Error ? previewError.message : '目前無法計算餐廳數');
        } finally {
          if (!cancelled) setIsPreviewingRadius(false);
        }
      };
      void previewRadius();
    }, 700);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [dialogOpen, dialogView, draftPreferences.searchRadius, preferences, isLoading]);

  useEffect(() => {
    let cancelled = false;
    if (currentSelected) {
      void Promise.all([
        db.notes.where('placeId').equals(currentSelected.id).toArray(),
        db.favorites.get(currentSelected.id),
      ]).then(([notes, favorite]) => {
        if (cancelled) return;
        const sortedNotes = (notes as MealNote[]).sort((first, second) => second.updatedAt - first.updatedAt);
        setNotesHistory(sortedNotes);
        setIsFavorite(Boolean(favorite));
      });
    }
    return () => { cancelled = true; };
  }, [currentSelected]);

  const savePreferences = async () => {
    const nextPreferences: AppPreferences = { id: 'default', ...draftPreferences };
    if (preferences?.searchRadius === nextPreferences.searchRadius) {
      setDialogOpen(false);
      return;
    }
    await db.preferences.put(nextPreferences);
    setPreferences(nextPreferences);
    updateSelection(null);
    setDialogOpen(false);
  };

  const refreshCandidates = async () => {
    const eligible = await getValidCandidates(rawCandidatesRef.current);
    setCandidates(eligible);
    await loadFavorites();
    if (selectedRestaurantRef.current && !eligible.some((place) => place.id === selectedRestaurantRef.current?.id)) {
      updateSelection(null);
    }
  };

  // 排除此店再轉：寫入 IndexedDB 臨時排除 (24小時) + 重新旋轉
const handleNextTime = async () => {
  if (!currentSelected) return;
  await add24hTempExclusion(currentSelected.id, currentSelected);
  await refreshCandidates();
  updateSelection(null);
  setSpinId((prev) => prev + 1);
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
    await loadFavorites();
  };

  const loadGoogleDetails = async () => {
    const targetId = currentSelected?.googlePlaceId || currentSelected?.id;
    if (!currentSelected || !targetId || googleDetails || isLoadingDetails) return;
    setIsLoadingDetails(true);
    try {
      const data = await fetchGoogleDetails(targetId);
      setGoogleDetails({ placeId: currentSelected.id, data });
    } catch (detailsError) {
      setErrorMessage(detailsError instanceof Error ? detailsError.message : '餐廳詳情載入失敗。');
    } finally {
      setIsLoadingDetails(false);
    }
  };

  const saveNote = async () => {
    if (!currentSelected || !noteText.trim() || noteRating < 1) return;
    setIsSavingNote(true);
    try {
      const publishedAt = Date.now();
      const newNote = {
        placeId: currentSelected.id,
        restaurantName: currentSelected.name,
        rating: noteRating,
        notes: noteText.trim(),
        updatedAt: publishedAt,
        publishedAt,
      };
      await db.notes.add(newNote);
      setNoteText('');
      setNoteRating(0);
      const updatedNotes = await db.notes.where('placeId').equals(currentSelected.id).toArray();
      setNotesHistory((updatedNotes as MealNote[]).sort((a, b) => b.updatedAt - a.updatedAt));
    } catch {
      setErrorMessage('評論發布失敗，請再試一次。');
    } finally {
      setIsSavingNote(false);
    }
  };

  const closeDialog = () => {
    if (preferences) setDraftPreferences({ searchRadius: preferences.searchRadius });
    setDialogOpen(false);
  };

  const savedGoogleDetails = googleDetails && googleDetails.placeId === currentSelected?.id ? googleDetails.data : null;
  const displayedRating = savedGoogleDetails?.rating ?? currentSelected?.rating ?? 0;
  const displayedUserRatingCount = savedGoogleDetails?.userRatingCount ?? currentSelected?.userRatingCount ?? 0;
  const displayedPrice = currentSelected?.source === 'google'
    ? formatPriceLevel(savedGoogleDetails?.priceLevel)
    : currentSelected?.price;

  // 使用 useMemo 快取加工後的候選池，確保效能與響應速度
  const processedCandidates = useMemo(() => {
    return candidates.map((item) => {
      const dist = userLocation && item.lat && item.lng
        ? distanceMeters(userLocation.lat, userLocation.lng, item.lat, item.lng)
        : null;
      return {
        ...item,
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
    <main className="min-h-screen bg-[#f5f6f2] px-4 py-5 text-[#202720] sm:px-6">
      <div className="mx-auto flex min-h-[calc(100svh-2.5rem)] w-full max-w-xl flex-col">
        {/* Header 頂部欄 */}
        <header className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#64715f]">FATBUDDY / NEARBY</p>
            <h1 className="mt-1 text-xl font-bold text-[#202720]">今天吃什麼？</h1>
          </div>
          
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => openManagementView('settings')}
              className="grid size-10 cursor-pointer place-items-center rounded-full border border-[#d9ded4] bg-white text-[#344434] shadow-sm transition-all duration-150 ease-in-out hover:scale-105 hover:border-[#263d30] hover:bg-[#f0f4ee] hover:text-[#263d30] active:scale-95"
              aria-label="搜尋設定"
            >
              <Settings className="size-5" />
            </button>

            <button
              type="button"
              onClick={() => openManagementView('exclusions')}
              className="grid size-10 cursor-pointer place-items-center rounded-full border border-[#d9ded4] bg-white text-[#344434] shadow-sm transition-all duration-150 ease-in-out hover:scale-105 hover:border-[#263d30] hover:bg-[#f0f4ee] hover:text-[#263d30] active:scale-95"
              aria-label="臨時排除"
            >
              <Clock3 className="size-5" />
            </button>

            <button
              type="button"
              onClick={() => openManagementView('participants')}
              className="relative grid size-10 cursor-pointer place-items-center rounded-full border border-[#d9ded4] bg-white text-[#344434] shadow-sm transition-all duration-150 ease-in-out hover:scale-105 hover:border-[#263d30] hover:bg-[#f0f4ee] hover:text-[#263d30] active:scale-95"
              aria-label="參與抽選列表"
            >
              <ListChecks className="size-5" />
              {candidates.length > 0 && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-[#263d30] text-[10px] font-bold text-white">
                  {candidates.length > 999 ? '999+' : candidates.length}
                </span>
              )}
            </button>
          </div>
        </header>

        {/* 轉盤主要區域 */}
        <section className="flex flex-1 flex-col items-center justify-center py-5">
          <div className="mb-1 flex min-h-6 items-center gap-2 text-sm text-[#64715f]">
            {isRefreshing ? <RotateCw className="size-4 animate-spin" /> : <MapPin className="size-4" />}
            <span>{isRefreshing ? '正在背景更新附近餐廳' : `${preferences?.searchRadius ?? 500} 公尺內`}</span>
          </div>
          {isLoading ? (
            <div className="grid min-h-[230px] place-items-center text-sm text-[#64715f]">正在搜尋附近餐廳…</div>
          ) : candidates.length === 0 ? (
            <div className="grid min-h-[230px] max-w-sm place-items-center text-center">
              <div>
                <p className="font-semibold">{errorMessage ? '目前無法開始抽選' : '附近沒有其他選擇'}</p>
                <p className="mt-2 text-sm leading-6 text-[#64715f]">{errorMessage || '試著擴大搜尋半徑，或稍後重新搜尋。'}</p>
                <button type="button" onClick={() => openManagementView('settings')} className="mt-4 cursor-pointer rounded-full bg-[#263d30] px-4 py-2 text-sm font-semibold text-white transition-all duration-150 hover:scale-105 active:scale-95">調整搜尋設定</button>
              </div>
            </div>
          ) : (
            <Roulette key={spinId} candidates={processedCandidates} autoStart onFinish={updateSelection} />
          )}
          {errorMessage && !isLoading && <p role="status" className="mt-2 max-w-sm text-center text-xs text-[#80604a]">{errorMessage}</p>}
        </section>

        {/* 當前選中餐廳資訊卡片 */}
        {currentSelected && preferences && (
          <section className="mt-4 mb-2 rounded-2xl border border-[#dce1d7] bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#64715f]">就吃這家</p>
                <h2 className="mt-1 break-words text-xl font-bold text-[#202720]">{currentSelected.name}</h2>
                <p className="mt-1 text-sm text-[#64715f]">{currentSelected.address || '地址資訊未提供'}</p>
                <p className="mt-1 text-sm text-[#916229]">
                  {typeof displayedUserRatingCount === 'number' && displayedUserRatingCount > 0 && (
                    <span>{displayedUserRatingCount} 人參與評分 · </span>
                  )}
                  {displayedRating > 0 ? `★ ${displayedRating.toFixed(1)}` : '尚無評分'}
                </p>
                {currentSelected.type && <p className="mt-1 text-sm text-[#64715f]">類別：{currentSelected.type}</p>}
                {displayedPrice && <p className="mt-1 text-sm text-[#64715f]">人均/價格參考：{displayedPrice}</p>}
                {currentSelected.googlePlaceId && !savedGoogleDetails && (
                  <button type="button" onClick={loadGoogleDetails} disabled={isLoadingDetails} className="mt-2 cursor-pointer rounded-lg border border-[#d9ded4] px-3 py-2 text-xs font-semibold text-[#344434] transition-all duration-150 hover:scale-105 active:scale-95 disabled:opacity-50">
                    {isLoadingDetails ? '載入資料…' : '載入 Google 評分與價格'}
                  </button>
                )}
              </div>
              <nav aria-label="選擇導航地圖" className="flex shrink-0 flex-col gap-2">
                {getNavigationLinks(currentSelected).map((link) => (
                  <a key={link.name} href={link.url} target="_blank" rel="noreferrer" className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#263d30] px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-all duration-150 hover:scale-105 active:scale-95">
                    <Navigation className="size-4" />{link.name}
                  </a>
                ))}
              </nav>
            </div>

            {/* 我的評論與歷史評論記錄 */}
            <div className="mt-4 border-t border-[#e8ebe5] pt-3">
              <label htmlFor="meal-note" className="flex items-center gap-2 text-sm font-semibold">
                <NotebookPen className="size-4 text-[#526950]" /> 我的評論
              </label>
              <textarea
                id="meal-note"
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder="分享這次用餐體驗"
                className="mt-2 w-full resize-y rounded-xl border border-[#d9ded4] bg-[#fbfcfa] p-3 text-sm outline-none focus:border-[#607c61]"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1" aria-label="評論評分">
                  {[1, 2, 3, 4, 5].map((rating) => (
                    <button key={rating} type="button" onClick={() => setNoteRating(rating)} className={`size-8 cursor-pointer text-lg transition-all duration-150 hover:scale-125 ${rating <= noteRating ? 'text-[#d69a34]' : 'text-[#cbd1c8]'}`} aria-label={`${rating} 分`}>
                      ★
                    </button>
                  ))}
                </div>
                <button type="button" onClick={saveNote} disabled={!noteText.trim() || noteRating < 1 || isSavingNote} className="cursor-pointer rounded-full border border-[#cdd5c8] bg-white px-4 py-1.5 text-sm font-semibold text-[#344434] transition-all duration-150 hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
                  {isSavingNote ? '發布中…' : '發布評論'}
                </button>
              </div>

              {notesHistory.length > 0 && (
                <div className="mt-4 space-y-2.5 border-t border-[#f0f2ee] pt-3">
                  <p className="text-xs font-semibold text-[#64715f]">過往評論 ({notesHistory.length})</p>
                  <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                    {notesHistory.map((note) => (
                      <div key={note.id ?? note.publishedAt} className="rounded-xl border border-[#eef1eb] bg-[#f8faf7] p-3 text-xs">
                        <div className="flex items-center justify-between text-[#916229]">
                          <span className="font-semibold">{'★'.repeat(note.rating)}</span>
                          <span className="text-[10px] text-[#879083]">
                            {new Date(note.publishedAt).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="mt-1.5 whitespace-pre-line leading-relaxed text-[#344434]">{note.notes}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 卡片底端按鈕列 */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#e8ebe5] pt-3">
              <button type="button" onClick={toggleFavorite} aria-pressed={isFavorite} className={`inline-flex cursor-pointer items-center gap-1.5 px-2 py-2 text-xs transition-all duration-150 hover:scale-105 active:scale-95 ${isFavorite ? 'font-bold text-[#c34f54]' : 'text-[#78655b]'}`}>
                <Heart className={`size-4 ${isFavorite ? 'fill-current' : ''}`} />{isFavorite ? '已收藏' : '收藏餐廳'}
              </button>
              <button type="button" onClick={handleBlacklist} className="inline-flex cursor-pointer items-center gap-1.5 px-2 py-2 text-xs text-[#78655b] transition-all duration-150 hover:scale-105 active:scale-95"><ShieldBan className="size-4" />永久排除</button>
              <button type="button" onClick={handleReroll} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[#cdd5c8] bg-white px-3.5 py-2 text-sm font-semibold text-[#344434] transition-all duration-150 hover:scale-105 active:scale-95"><RotateCw className="size-4" />直接再轉</button>
              <button type="button" onClick={handleNextTime} className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-[#e9eee6] px-4 py-2 text-sm font-semibold text-[#344434] transition-all duration-150 hover:scale-105 active:scale-95"><RotateCw className="size-4" />排除此店再轉</button>
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
          radiusPreviewCount={radiusPreviewCount}
          isPreviewingRadius={isPreviewingRadius}
          radiusPreviewError={radiusPreviewError}
          initialView={dialogView}
          onSavePreferences={savePreferences}
          onClose={closeDialog}
          onRefreshCandidates={refreshCandidates}
        />
      )}
    </main>
  );
};