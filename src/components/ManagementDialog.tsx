import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  ArrowLeft,
  Clock3,
  Heart,
  MapPin,
  Navigation,
  NotebookPen,
  Pencil,
  RotateCcw,
  Search,
  ShieldBan,
  Trash2,
  X,
} from 'lucide-react';
import {
  db,
  type AppPreferences,
  type FavoriteRestaurant,
  type PermanentBlacklist,
  type TempExclusion,
  type UserNote,
} from '../db';
import { filterByBilingualSearch } from '../utils/search';
import type { Restaurant } from './Roulette';
import { formatCategory } from '../pages/Home';

type View = 'settings' | 'participants' | 'exclusions' | 'blacklist' | 'reviews' | 'favorites';

interface ManagementDialogProps {
  preferences: AppPreferences | null;
  draftPreferences: Omit<AppPreferences, 'id'>;
  setDraftPreferences: Dispatch<SetStateAction<Omit<AppPreferences, 'id'>>>;
  candidates: Restaurant[];
  allCandidates: Restaurant[];
  rawCandidates: Restaurant[];
  userLocation: { lat: number; lng: number } | null;
  initialView?: View;
  onSavePreferences: () => Promise<void>;
  onClose: () => void;
  onRefreshCandidates: () => Promise<void>;
  onNavClick?: (restaurant: Restaurant) => void;
}

const VIEW_TITLES: Record<View, string> = {
  settings: '搜尋設定',
  participants: '參與抽選',
  exclusions: '臨時排除',
  blacklist: '永久黑名單',
  reviews: '我的食記',
  favorites: '收藏餐廳',
};

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(meters % 1000 === 0 ? 0 : 1)} 公里` : `${meters} 公尺`;
}

function resolveRestaurantName(allCandidates: Restaurant[], placeId: string, savedName?: string): string {
  return savedName || allCandidates.find((restaurant) => restaurant.id === placeId)?.name || placeId;
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(lat2 - lat1);
  const longitudeDelta = radians(lng2 - lng1);
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
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
    PRICE_LEVEL_INEXPENSIVE: '$',     PRICE_LEVEL_MODERATE: '$$',     PRICE_LEVEL_EXPENSIVE: '$$$',     PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
  };
  return labels[level] ?? level;
}

export function ManagementDialog({
  preferences,
  draftPreferences,
  setDraftPreferences,
  candidates,
  allCandidates,
  rawCandidates,
  userLocation,
  initialView = 'settings',
  onSavePreferences,
  onClose,
  onRefreshCandidates,
  onNavClick,
}: ManagementDialogProps) {
  const [view, setView] = useState<View>(initialView);
  const [search, setSearch] = useState('');
  const [exclusions, setExclusions] = useState<TempExclusion[]>([]);
  const [blacklist, setBlacklist] = useState<PermanentBlacklist[]>([]);
  const [reviews, setReviews] = useState<UserNote[]>([]);
  const [favorites, setFavorites] = useState<FavoriteRestaurant[]>([]);
  
  const [filteredCandidates, setFilteredCandidates] = useState<Restaurant[]>(candidates);
  const [filteredExclusions, setFilteredExclusions] = useState<TempExclusion[]>([]);
  const [filteredBlacklist, setFilteredBlacklist] = useState<PermanentBlacklist[]>([]);
  const [filteredReviews, setFilteredReviews] = useState<UserNote[]>([]);
  const [filteredFavorites, setFilteredFavorites] = useState<FavoriteRestaurant[]>([]);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editNotesText, setEditNotesText] = useState('');
  const [editRating, setEditRating] = useState(0);

  const allRestaurants = new Map(allCandidates.map((r) => [r.id, r]));
  const nameFor = (placeId: string, savedName?: string) => savedName || allRestaurants.get(placeId)?.name || placeId;

  const estimatedCount = useMemo(() => {
    if (!userLocation || rawCandidates.length === 0) return null;
    return rawCandidates.filter((item) => 
      distanceMeters(userLocation.lat, userLocation.lng, item.lat, item.lng) <= draftPreferences.searchRadius
    ).length;
  }, [userLocation, rawCandidates, draftPreferences.searchRadius]);

  const reloadFavoritesAndLocation = async () => {
    try {
      const favs = await db.favorites.toArray();
      setFavoriteIds(new Set(favs.map((f) => f.id)));
      setFavorites(favs.sort((a, b) => b.savedAt - a.savedAt));
    } catch {
      // 靜默處理
    }
  };

  const toggleFavorite = async (restaurant: Restaurant) => {
    if (favoriteIds.has(restaurant.id)) {
      await db.favorites.delete(restaurant.id);
    } else {
      await db.favorites.put({ ...restaurant, savedAt: Date.now() });
    }
    await reloadFavoritesAndLocation();
  };

  const reloadViewData = async () => {
    try {
      if (view === 'exclusions') {
        try {
          await db.tempExclusions.where('expiredAt').below(Date.now()).delete();
        } catch {
          // 靜默處理
        }
        const rows = await db.tempExclusions.toArray();
        setExclusions(rows.filter((r) => r.expiredAt > Date.now()));
      } else if (view === 'blacklist') {
        setBlacklist(await db.blacklists.toArray());
      } else if (view === 'reviews') {
        setReviews((await db.notes.toArray()).sort((first, second) => second.updatedAt - first.updatedAt));
      } else if (view === 'favorites') {
        setFavorites((await db.favorites.toArray()).sort((first, second) => second.savedAt - first.savedAt));
      }
      await reloadFavoritesAndLocation();
    } catch {
      // 靜默處理
    }
  };

  useEffect(() => {
    void reloadViewData();
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      filterByBilingualSearch(candidates, search, (item) => [item.name, item.address]),
      filterByBilingualSearch(exclusions, search, (row) => [resolveRestaurantName(allCandidates, row.placeId, row.restaurantName), row.address]),
      filterByBilingualSearch(blacklist, search, (row) => [resolveRestaurantName(allCandidates, row.placeId, row.restaurantName), row.address]),
      filterByBilingualSearch(reviews, search, (row) => [row.restaurantName, row.notes]),
      filterByBilingualSearch(favorites, search, (row) => [row.name, row.address]),
    ]).then(([nextCandidates, nextExclusions, nextBlacklist, nextReviews, nextFavorites]) => {
      if (cancelled) return;
      
      const processedCandidates = nextCandidates.map((item) => {
        const dist = (item as any).calculatedDistance ?? (
          userLocation && item.lat && item.lng
            ? distanceMeters(userLocation.lat, userLocation.lng, item.lat, item.lng)
            : null
        );
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

      setFilteredCandidates(processedCandidates);
      setFilteredExclusions(nextExclusions);
      setFilteredBlacklist(nextBlacklist);
      setFilteredReviews(nextReviews);
      setFilteredFavorites(nextFavorites);
    });

    return () => { cancelled = true; };
  }, [search, candidates, exclusions, blacklist, reviews, favorites, allCandidates, favoriteIds, userLocation]);

  const openView = (nextView: View) => {
    setView(nextView);
    setSearch('');
    setSelectedIds([]);
  };

  const removeFavorite = async (restaurantId: string) => {
    await db.favorites.delete(restaurantId);
    await reloadFavoritesAndLocation();
  };

  const addToBlacklist = async (restaurant: Restaurant) => {
    await db.blacklists.put({
      placeId: restaurant.id,
      restaurantName: restaurant.name,
      address: restaurant.address,
      createdAt: Date.now(),
    });
    await onRefreshCandidates();
    await reloadViewData();
  };

  const toggleSelected = (placeId: string) => {
    setSelectedIds((ids) => ids.includes(placeId) ? ids.filter((id) => id !== placeId) : [...ids, placeId]);
  };

  const releaseExclusions = async (placeIds: string[]) => {
    setIsWorking(true);
    try {
      await db.tempExclusions.bulkDelete(placeIds);
      setSelectedIds([]);
      await reloadViewData();
      await onRefreshCandidates();
    } finally {
      setIsWorking(false);
    }
  };

  const extendExclusions = async (placeIds: string[], extraMilliseconds: number) => {
    setIsWorking(true);
    try {
      const rows = await db.tempExclusions.bulkGet(placeIds);
      await db.tempExclusions.bulkPut(rows.flatMap((row) => row ? [{
        ...row,
        expiredAt: Math.max(Date.now(), row.expiredAt) + extraMilliseconds,
      }] : []));
      setSelectedIds([]);
      await reloadViewData();
    } finally {
      setIsWorking(false);
    }
  };

  const releaseBlacklist = async (placeIds: string[]) => {
    setIsWorking(true);
    try {
      await db.blacklists.bulkDelete(placeIds);
      setSelectedIds([]);
      await reloadViewData();
      await onRefreshCandidates();
    } finally {
      setIsWorking(false);
    }
  };

  const startEditNote = (note: UserNote) => {
    if (!note.id) return;
    setEditingNoteId(note.id);
    setEditNotesText(note.notes);
    setEditRating(note.rating);
  };

  const cancelEditNote = () => {
    setEditingNoteId(null);
    setEditNotesText('');
    setEditRating(0);
  };

  const saveEditNote = async (noteId: number) => {
    if (!editNotesText.trim() || editRating < 1) return;
    await db.notes.update(noteId, {
      notes: editNotesText.trim(),
      rating: editRating,
      updatedAt: Date.now(),
    });
    cancelEditNote();
    await reloadViewData();
  };

  const deleteNote = async (noteId?: number) => {
    if (!noteId) return;
    await db.notes.delete(noteId);
    if (editingNoteId === noteId) cancelEditNote();
    await reloadViewData();
  };

  const currentRegion = userLocation
    ? (userLocation.lng >= 72.004 && userLocation.lng <= 137.8347 && userLocation.lat >= 0.8293 && userLocation.lat <= 55.8271
        ? (userLocation.lat >= 22.15 && userLocation.lat <= 22.57 && userLocation.lng >= 113.82 && userLocation.lng <= 114.45 ? 'hk' : 'cn')
        : 'global')
    : 'global';

  const visibleIds = view === 'exclusions'
    ? filteredExclusions.map((row) => row.placeId)
    : view === 'blacklist'
      ? filteredBlacklist.map((row) => row.placeId)
      : [];
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleAllVisible = () => {
    setSelectedIds((ids) => allVisibleSelected
      ? ids.filter((id) => !visibleIds.includes(id))
      : [...new Set([...ids, ...visibleIds])]);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#162119]/50 dark:bg-black/75 p-4 backdrop-blur-xs animate-fade-in" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="management-title"
        className="max-h-[90svh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white dark:bg-[#18221c] border border-[#e2e8dc] dark:border-[#28382e] p-6 shadow-2xl text-[#202720] dark:text-[#f0f4f0]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#f0f2ee] dark:border-[#223027] pb-4">
          <div className="flex items-center gap-2.5">
            {view !== 'settings' && (
              <button
                type="button"
                onClick={() => openView('settings')}
                className="-ml-2 grid size-9 cursor-pointer place-items-center rounded-2xl hover:bg-[#f1f3ef] dark:hover:bg-[#25352b] transition-all"
                aria-label="返回"
              >
                <ArrowLeft className="size-4.5" />
              </button>
            )}
            <div className="text-left">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#64715f] dark:text-[#88a385]">FATBUDDY</p>
              <h2 id="management-title" className="mt-0.5 text-lg font-black tracking-tight text-[#1a241c] dark:text-[#eaf2ea]">{VIEW_TITLES[view]}</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-9 cursor-pointer place-items-center rounded-2xl hover:bg-[#f1f3ef] dark:hover:bg-[#25352b] transition-all"
            aria-label="關閉"
          >
            <X className="size-4.5" />
          </button>
        </div>

        {view === 'settings' && (
          <>
            <fieldset className="mt-6 text-left">
              <legend className="text-xs font-bold uppercase tracking-wider text-[#64715f] dark:text-[#98aba6]">搜尋半徑</legend>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-[#879083]">500 公尺</span>
                <output className="min-w-24 text-center text-xl font-black text-[#263d30] dark:text-[#88c298]">
                  {formatDistance(draftPreferences.searchRadius)}
                </output>
                <span className="text-xs text-[#879083]">5 公里</span>
              </div>
              <input
                type="range"
                min={500}
                max={5000}
                step={500}
                value={draftPreferences.searchRadius}
                onChange={(event) => setDraftPreferences((current) => ({
                  ...current,
                  searchRadius: Number(event.target.value),
                }))}
                className="mt-3.5 w-full cursor-pointer accent-[#263d30] dark:accent-[#88c298]"
                aria-label="搜尋半徑"
              />
              <div className="mt-2.5 flex min-h-5 items-center justify-center gap-1.5 text-xs font-medium text-[#5a6b57] dark:text-[#9bb398]" aria-live="polite">
                <MapPin className="size-3.5" />
                <span>
                  {estimatedCount !== null ? `範圍內約有 ${estimatedCount} 家餐廳` : '即時計算中…'}
                </span>
              </div>
            </fieldset>

            <div className="mt-6 flex flex-col gap-2.5">
              <button type="button" onClick={() => openView('blacklist')} className="flex cursor-pointer items-center justify-between rounded-2xl border border-[#e2e8dc] dark:border-[#28382e] bg-[#fafbfa] dark:bg-[#141c17] px-4 py-3 text-left text-xs font-bold transition-all hover:scale-[1.01]">
                <span className="flex items-center gap-3"><ShieldBan className="size-4 text-[#64715f] dark:text-[#98aba6]" />永久黑名單</span>
                <span className="text-[#879083]">→</span>
              </button>
              <button type="button" onClick={() => openView('reviews')} className="flex cursor-pointer items-center justify-between rounded-2xl border border-[#e2e8dc] dark:border-[#28382e] bg-[#fafbfa] dark:bg-[#141c17] px-4 py-3 text-left text-xs font-bold transition-all hover:scale-[1.01]">
                <span className="flex items-center gap-3"><NotebookPen className="size-4 text-[#64715f] dark:text-[#98aba6]" />我的食記</span>
                <span className="text-[#879083]">→</span>
              </button>
              <button type="button" onClick={() => openView('favorites')} className="flex cursor-pointer items-center justify-between rounded-2xl border border-[#e2e8dc] dark:border-[#28382e] bg-[#fafbfa] dark:bg-[#141c17] px-4 py-3 text-left text-xs font-bold transition-all hover:scale-[1.01]">
                <span className="flex items-center gap-3"><Heart className="size-4 text-[#c34f54]" />收藏餐廳</span>
                <span className="text-[#879083]">→</span>
              </button>
            </div>

            <button type="button" onClick={() => void onSavePreferences()} className="mt-6 w-full cursor-pointer rounded-full bg-[#263d30] dark:bg-[#3d5746] px-4 py-3.5 text-xs font-black uppercase tracking-wider text-white shadow-md transition-all hover:scale-[1.02] active:scale-95">
              {preferences ? '儲存設定' : '開始使用'}
            </button>
          </>
        )}

        {view !== 'settings' && (
          <div className="mt-4">
            <label className="flex items-center gap-2 rounded-2xl border border-[#e2e8dc] dark:border-[#28382e] bg-[#fafbfa] dark:bg-[#141c17] px-3.5 py-3">
              <Search className="size-4 shrink-0 text-[#64715f] dark:text-[#98aba6]" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`搜尋${VIEW_TITLES[view]}`}
                aria-label="搜尋"
                className="min-w-0 flex-1 bg-transparent text-xs text-[#202720] dark:text-[#f0f4f0] placeholder-[#879083] outline-none"
              />
            </label>

            {view === 'participants' && (
              <>
                <p className="mt-3 text-xs font-bold text-[#64715f] dark:text-[#98aba6] text-left">{filteredCandidates.length} / {candidates.length} 家參與抽選</p>
                <ul className="mt-2 max-h-[50svh] overflow-y-auto pr-1">
                  {filteredCandidates.map((restaurant) => {
                    const isFav = (restaurant as any).isFav;
                    const dist = (restaurant as any).calculatedDistance;
                    const priceFormatted = restaurant.source === 'google'
                      ? formatPriceLevel(restaurant.priceLevel || restaurant.price)
                      : restaurant.price;

                    return (
                      <li key={restaurant.id} className="my-2.5 rounded-2xl border border-[#e2e8dc] dark:border-[#28382e] bg-[#fafbfa] dark:bg-[#141c17] p-3.5 shadow-xs">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-1 flex-col items-start text-left">
                            {isFav && (
                              <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-[#fce8e8] dark:bg-[#3d2325] px-2.5 py-0.5 text-[10px] font-bold text-[#c34f54]">
                                <Heart className="size-2.5 fill-current" /> 已收藏
                              </span>
                            )}
                            <h3 className="break-words text-left text-sm font-bold text-[#202720] dark:text-[#f0f4f0] leading-snug">
                              {restaurant.name}
                            </h3>
                            <p className="mt-0.5 break-words text-left text-[11px] leading-normal text-[#64715f] dark:text-[#98aba6]">
                              {restaurant.address || '地址資訊未提供'}
                            </p>

                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                              {dist !== null && (
                                <span className="inline-flex items-center gap-0.5 font-bold text-[#4a6b4c] dark:text-[#7bb07e]">
                                  <MapPin className="size-3" />
                                  {dist < 1000 ? `${Math.round(dist)}m` : `${(dist / 1000).toFixed(1)}km`}
                                </span>
                              )}
                              
                              {typeof restaurant.rating === 'number' && restaurant.rating > 0 ? (
                                <span className="font-bold text-[#b88228] dark:text-[#e6b363]">
                                  ★ {restaurant.rating.toFixed(1)}
                                </span>
                              ) : (
                                <span className="text-[#879083]">尚無評分</span>
                              )}

                              {priceFormatted && (
                                <span className="rounded-md bg-[#f4eee4] dark:bg-[#362e22] px-1.5 py-0.5 text-[10px] font-bold text-[#8a611c]">
                                  {priceFormatted}
                                </span>
                              )}

                              {(restaurant.sources || [restaurant.source]).map((src) => (
                                <span key={src} className="rounded-full bg-[#eef3ec] dark:bg-[#25352b] px-2 py-0.5 text-[9px] font-bold uppercase text-[#344434] dark:text-[#c0d4c0]">
                                  {src}
                                </span>
                              ))}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1 pt-0.5">
                            <a
                              href={getSmartNavUrl(restaurant, currentRegion)}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="查看地圖"
                              onClick={() => onNavClick?.(restaurant)}
                              className="grid size-8.5 cursor-pointer place-items-center rounded-xl border border-[#e2e8dc] dark:border-[#28382e] bg-white dark:bg-[#1a261f] shadow-xs hover:scale-105"
                            >
                              <Navigation className="size-3.5" />
                            </a>
                            <button
                              type="button"
                              onClick={() => void toggleFavorite(restaurant)}
                              aria-label="收藏"
                              className={`grid size-8.5 cursor-pointer place-items-center rounded-xl border shadow-xs hover:scale-105 ${
                                isFav ? 'border-[#f2c4c4] bg-[#fce8e8] text-[#c34f54]' : 'border-[#e2e8dc] dark:border-[#28382e] bg-white dark:bg-[#1a261f] text-[#879083]'
                              }`}
                            >
                              <Heart className={`size-3.5 ${isFav ? 'fill-current' : ''}`} />
                            </button>
                            <button
                              type="button"
                              onClick={() => void addToBlacklist(restaurant)}
                              aria-label="永久排除"
                              className="grid size-8.5 cursor-pointer place-items-center rounded-xl border border-[#e2e8dc] dark:border-[#28382e] bg-white dark:bg-[#1a261f] text-[#879083] shadow-xs hover:scale-105"
                            >
                              <ShieldBan className="size-3.5" />
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                  {filteredCandidates.length === 0 && <li className="py-8 text-center text-xs text-[#64715f]">沒有符合的餐廳</li>}
                </ul>
              </>
            )}

            {view === 'exclusions' && (
              <>
                <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[#64715f] dark:text-[#98aba6]">
                  <span>{filteredExclusions.length} 家暫時排除</span>
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} className="cursor-pointer" /> 全選
                  </label>
                </div>
                <div className="mt-2 max-h-[50svh] divide-y divide-[#f0f2ee] dark:divide-[#223027] overflow-y-auto pr-1">
                  {filteredExclusions.map((row) => (
                    <div key={row.placeId} className="flex items-center gap-3 py-3">
                      <input type="checkbox" checked={selectedIds.includes(row.placeId)} onChange={() => toggleSelected(row.placeId)} aria-label="選取" className="cursor-pointer" />
                      <div className="min-w-0 flex-1 text-left">
                        <p className="break-words text-xs font-bold text-[#202720] dark:text-[#f0f4f0]">{nameFor(row.placeId, row.restaurantName)}</p>
                        <p className="mt-0.5 text-[11px] text-[#64715f]">排除至 {new Date(row.expiredAt).toLocaleString()}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => void releaseExclusions([row.placeId])} disabled={isWorking} title="釋放" className="grid size-8 cursor-pointer place-items-center rounded-xl border border-[#e2e8dc] dark:border-[#28382e] bg-white dark:bg-[#1a261f] hover:scale-105">
                          <RotateCcw className="size-3.5" />
                        </button>
                        <button type="button" onClick={() => void extendExclusions([row.placeId], 24 * 60 * 60 * 1000)} disabled={isWorking} title="延長" className="grid size-8 cursor-pointer place-items-center rounded-xl border border-[#e2e8dc] dark:border-[#28382e] bg-white dark:bg-[#1a261f] hover:scale-105">
                          <Clock3 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {filteredExclusions.length === 0 && <p className="py-8 text-center text-xs text-[#64715f]">沒有排除項目</p>}
                </div>
              </>
            )}

            {view === 'blacklist' && (
              <div className="mt-2 max-h-[52svh] divide-y divide-[#f0f2ee] dark:divide-[#223027] overflow-y-auto">
                {filteredBlacklist.map((row) => (
                  <div key={row.placeId} className="flex items-center justify-between gap-3 py-3 text-left">
                    <div className="min-w-0">
                      <p className="break-words text-xs font-bold text-[#202720] dark:text-[#f0f4f0]">{nameFor(row.placeId, row.restaurantName)}</p>
                      <p className="mt-0.5 text-[11px] text-[#64715f]">{row.address || '永久黑名單'}</p>
                    </div>
                    <button type="button" onClick={() => void releaseBlacklist([row.placeId])} disabled={isWorking} className="cursor-pointer rounded-xl border border-[#e2e8dc] dark:border-[#28382e] px-3 py-1 text-xs font-bold hover:bg-[#f1f3ef]">解除</button>
                  </div>
                ))}
                {filteredBlacklist.length === 0 && <p className="py-8 text-center text-xs text-[#64715f]">黑名單是空的</p>}
              </div>
            )}

            {view === 'reviews' && (
              <div className="mt-2 max-h-[58svh] divide-y divide-[#f0f2ee] dark:divide-[#223027] overflow-y-auto">
                {filteredReviews.map((note) => (
                  <article key={note.id} className="py-3 text-left">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words text-xs font-bold text-[#202720] dark:text-[#f0f4f0]">{note.restaurantName}</h3>
                        {editingNoteId === note.id ? (
                          <div className="mt-2 space-y-2">
                            <div className="flex items-center gap-1">
                              {[1, 2, 3, 4, 5].map((star) => (
                                <button key={star} type="button" onClick={() => setEditRating(star)} className={`text-sm ${star <= editRating ? 'text-[#d69a34]' : 'text-[#cbd1c8]'}`}>★</button>
                              ))}
                            </div>
                            <textarea value={editNotesText} onChange={(e) => setEditNotesText(e.target.value)} rows={2} className="w-full rounded-xl border border-[#e2e8dc] dark:border-[#28382e] p-2 text-xs" />
                            <div className="flex gap-2">
                              <button type="button" onClick={() => note.id && void saveEditNote(note.id)} className="rounded-xl bg-[#263d30] px-3 py-1 text-xs font-bold text-white">儲存</button>
                              <button type="button" onClick={cancelEditNote} className="rounded-xl border border-[#e2e8dc] dark:border-[#28382e] px-3 py-1 text-xs">取消</button>
                            </div>
                          </div>
                        ) : (
                          <p className="mt-0.5 text-xs text-[#b88228]">{'★'.repeat(note.rating)}</p>
                        )}
                      </div>
                      {!editingNoteId && note.id && (
                        <div className="flex items-center gap-1.5">
                          <button type="button" onClick={() => startEditNote(note)} title="編輯" className="text-[#526950] hover:scale-110"><Pencil className="size-3.5" /></button>
                          <button type="button" onClick={() => void deleteNote(note.id)} title="刪除" className="text-[#c34f54] hover:scale-110"><Trash2 className="size-3.5" /></button>
                        </div>
                      )}
                    </div>
                    {editingNoteId !== note.id && <p className="mt-1.5 text-xs text-[#4e584b] dark:text-[#98aba6] leading-relaxed">{note.notes}</p>}
                  </article>
                ))}
                {filteredReviews.length === 0 && <p className="py-8 text-center text-xs text-[#64715f]">沒有食記記錄</p>}
              </div>
            )}

            {view === 'favorites' && (
              <div className="mt-2 max-h-[58svh] divide-y divide-[#f0f2ee] dark:divide-[#223027] overflow-y-auto">
                {filteredFavorites.map((restaurant) => (
                  <article key={restaurant.id} className="flex items-center justify-between gap-3 py-3 text-left">
                    <div className="min-w-0">
                      <h3 className="break-words text-xs font-bold text-[#202720] dark:text-[#f0f4f0]">{restaurant.name}</h3>
                      <p className="mt-0.5 text-[11px] text-[#64715f]">{restaurant.address || '地址資訊未提供'}</p>
                    </div>
                    <button type="button" onClick={() => void removeFavorite(restaurant.id)} aria-label="取消收藏" className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-xl border border-[#f2c4c4] bg-[#fce8e8] text-[#c34f54] hover:scale-105">
                      <Heart className="size-3.5 fill-current" />
                    </button>
                  </article>
                ))}
                {filteredFavorites.length === 0 && <p className="py-8 text-center text-xs text-[#64715f]">沒有收藏餐廳</p>}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}