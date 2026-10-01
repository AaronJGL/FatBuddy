import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  ArrowLeft,
  Clock3,
  Heart,
  MapPin,
  Navigation,
  NotebookPen,
  RotateCcw,
  RotateCw,
  Search,
  Send,
  ShieldBan,
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
import type { Restaurant } from './Roulette';

type View = 'settings' | 'participants' | 'exclusions' | 'blacklist' | 'reviews' | 'favorites';

interface ManagementDialogProps {
  preferences: AppPreferences | null;
  draftPreferences: Omit<AppPreferences, 'id'>;
  setDraftPreferences: Dispatch<SetStateAction<Omit<AppPreferences, 'id'>>>;
  candidates: Restaurant[];
  allCandidates: Restaurant[];
  radiusPreviewCount: number | null;
  isPreviewingRadius: boolean;
  radiusPreviewError: string;
  initialView?: View;
  onSavePreferences: () => Promise<void>;
  onClose: () => void;
  onRefreshCandidates: () => Promise<void>;
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

function getMapUrl(restaurant: Restaurant): string {
  if (restaurant.googlePlaceId) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(restaurant.name)}&query_place_id=${restaurant.googlePlaceId}`;
  }
  const searchText = encodeURIComponent(`${restaurant.name} ${restaurant.address ?? ''}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${searchText}`;
}

export function ManagementDialog({
  preferences,
  draftPreferences,
  setDraftPreferences,
  candidates,
  allCandidates,
  radiusPreviewCount,
  isPreviewingRadius,
  radiusPreviewError,
  initialView = 'settings',
  onSavePreferences,
  onClose,
  onRefreshCandidates,
}: ManagementDialogProps) {
  const [view, setView] = useState<View>(initialView);
  const [search, setSearch] = useState('');
  const [exclusions, setExclusions] = useState<TempExclusion[]>([]);
  const [blacklist, setBlacklist] = useState<PermanentBlacklist[]>([]);
  const [reviews, setReviews] = useState<UserNote[]>([]);
  const [favorites, setFavorites] = useState<FavoriteRestaurant[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  const allRestaurants = useMemo(() => new Map(allCandidates.map((r) => [r.id, r])), [allCandidates]);
  const nameFor = (placeId: string, savedName?: string) => savedName || allRestaurants.get(placeId)?.name || placeId;

  const reloadFavoritesAndLocation = async () => {
    try {
      const [favs, loc] = await Promise.all([
        db.favorites.toArray(),
        db.lastKnownLocations.get('last'),
      ]);
      setFavoriteIds(new Set(favs.map((f) => f.id)));
      setFavorites(favs.sort((a, b) => b.savedAt - a.savedAt));
      if (loc?.lat && loc?.lng) setUserLocation({ lat: loc.lat, lng: loc.lng });
    } catch {
      // 靜默處理
    }
  };

  const reloadViewData = async () => {
    try {
      if (view === 'exclusions') {
        try {
          await db.tempExclusions.where('expiredAt').below(Date.now()).delete();
        } catch {
          // 清理失敗時忽略，直接獲取全部
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

  const openView = (nextView: View) => {
    setView(nextView);
    setSearch('');
    setSelectedIds([]);
  };

  const toggleFavorite = async (restaurant: Restaurant) => {
    if (favoriteIds.has(restaurant.id)) {
      await db.favorites.delete(restaurant.id);
    } else {
      await db.favorites.put({ ...restaurant, savedAt: Date.now() });
    }
    await reloadFavoritesAndLocation();
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

  const moveExclusionsToBlacklist = async (placeIds: string[]) => {
    setIsWorking(true);
    try {
      const rows = await db.tempExclusions.bulkGet(placeIds);
      await db.blacklists.bulkPut(rows.flatMap((row) => row ? [{
        placeId: row.placeId,
        restaurantName: nameFor(row.placeId, row.restaurantName),
        address: row.address || allRestaurants.get(row.placeId)?.address,
        createdAt: Date.now(),
      }] : []));
      await db.tempExclusions.bulkDelete(placeIds);
      setSelectedIds([]);
      await reloadViewData();
      await onRefreshCandidates();
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

  const publishDraft = async (note: UserNote, publishedAt: number) => {
    await db.notes.put({ ...note, publishedAt, updatedAt: publishedAt });
    await reloadViewData();
  };

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = candidates.filter((restaurant) => {
      if (!q) return true;
      return restaurant.name.toLowerCase().includes(q) || (restaurant.address && restaurant.address.toLowerCase().includes(q));
    });

    return matched.map((item) => {
      const dist = (item as any).calculatedDistance ?? (
        userLocation && item.lat && item.lng
          ? distanceMeters(userLocation.lat, userLocation.lng, item.lat, item.lng)
          : null
      );
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
  }, [candidates, search, favoriteIds, userLocation]);

  const filteredExclusions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return exclusions.filter((row) => {
      if (!q) return true;
      const name = resolveRestaurantName(allCandidates, row.placeId, row.restaurantName).toLowerCase();
      return name.includes(q) || (row.address && row.address.toLowerCase().includes(q));
    });
  }, [exclusions, search, allCandidates]);

  const filteredBlacklist = useMemo(() => {
    const q = search.trim().toLowerCase();
    return blacklist.filter((row) => {
      if (!q) return true;
      const name = resolveRestaurantName(allCandidates, row.placeId, row.restaurantName).toLowerCase();
      return name.includes(q) || (row.address && row.address.toLowerCase().includes(q));
    });
  }, [blacklist, search, allCandidates]);

  const filteredReviews = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reviews.filter((row) => !q || row.restaurantName.toLowerCase().includes(q) || row.notes.toLowerCase().includes(q));
  }, [reviews, search]);

  const filteredFavorites = useMemo(() => {
    const q = search.trim().toLowerCase();
    return favorites.filter((row) => !q || row.name.toLowerCase().includes(q) || (row.address && row.address.toLowerCase().includes(q)));
  }, [favorites, search]);

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
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#162119]/45 p-4 backdrop-blur-sm" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="management-title"
        className="max-h-[92svh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#e8ebe5] pb-3">
          <div className="flex items-start gap-2">
            {view !== 'settings' && (
              <button
                type="button"
                onClick={() => openView('settings')}
                className="-ml-2 grid size-9 cursor-pointer place-items-center rounded-full hover:bg-[#f1f3ef] transition-all duration-150 hover:scale-105 active:scale-95"
                aria-label="返回搜尋設定"
              >
                <ArrowLeft className="size-5" />
              </button>
            )}
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#64715f]">FATBUDDY</p>
              <h2 id="management-title" className="mt-0.5 text-xl font-bold text-[#202720]">{VIEW_TITLES[view]}</h2>
            </div>
          </div>
          {preferences && (
            <button
              type="button"
              onClick={onClose}
              className="grid size-9 cursor-pointer place-items-center rounded-full hover:bg-[#f1f3ef] transition-all duration-150 hover:scale-105 active:scale-95"
              aria-label="關閉"
            >
              <X className="size-5" />
            </button>
          )}
        </div>

        {view === 'settings' && (
          <>
            <fieldset className="mt-5">
              <legend className="text-sm font-bold text-[#202720]">搜尋半徑</legend>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-[#64715f]">500 公尺</span>
                <output className="min-w-20 text-center text-lg font-bold text-[#263d30]">
                  {formatDistance(draftPreferences.searchRadius)}
                </output>
                <span className="text-xs text-[#64715f]">5 公里</span>
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
                className="mt-3 w-full cursor-pointer accent-[#263d30]"
                aria-label="搜尋半徑"
              />
              <div className="mt-2 flex min-h-5 items-center justify-center gap-2 text-xs text-[#64715f]" aria-live="polite">
                {isPreviewingRadius ? (
                  <><RotateCw className="size-3 animate-spin" /> 正在計算此範圍的餐廳數</>
                ) : radiusPreviewError ? (
                  radiusPreviewError
                ) : radiusPreviewCount === null ? (
                  '允許定位後可預估附近餐廳數'
                ) : (
                  `此範圍目前有 ${radiusPreviewCount} 家可參與抽選`
                )}
              </div>
            </fieldset>

            <div className="mt-5 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => openView('blacklist')}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-[#d9ded4] bg-white px-4 py-3 text-left text-sm font-semibold text-[#202720] transition-all duration-150 ease-in-out hover:scale-[1.02] hover:border-[#263d30] hover:bg-[#f5f8f4] active:scale-[0.98]"
              >
                <ShieldBan className="size-4 shrink-0 text-[#64715f]" /> 永久黑名單
              </button>
              <button
                type="button"
                onClick={() => openView('reviews')}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-[#d9ded4] bg-white px-4 py-3 text-left text-sm font-semibold text-[#202720] transition-all duration-150 ease-in-out hover:scale-[1.02] hover:border-[#263d30] hover:bg-[#f5f8f4] active:scale-[0.98]"
              >
                <NotebookPen className="size-4 shrink-0 text-[#64715f]" /> 我的食記
              </button>
              <button
                type="button"
                onClick={() => openView('favorites')}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-[#d9ded4] bg-white px-4 py-3 text-left text-sm font-semibold text-[#202720] transition-all duration-150 ease-in-out hover:scale-[1.02] hover:border-[#263d30] hover:bg-[#f5f8f4] active:scale-[0.98]"
              >
                <Heart className="size-4 shrink-0 text-[#c34f54]" /> 收藏餐廳
              </button>
            </div>

            <button
              type="button"
              onClick={() => void onSavePreferences()}
              className="mt-6 w-full cursor-pointer rounded-full bg-[#263d30] px-4 py-3 text-sm font-bold text-white transition-all duration-150 ease-in-out hover:scale-[1.02] hover:bg-[#1a2b21] active:scale-[0.98]"
            >
              {preferences ? '儲存設定' : '開始使用'}
            </button>
          </>
        )}

        {view !== 'settings' && (
          <div className="mt-4">
            <label className="flex items-center gap-2 rounded-xl border border-[#d9ded4] bg-[#fafbfa] px-3 py-2.5">
              <Search className="size-4 shrink-0 text-[#64715f]" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`搜尋${VIEW_TITLES[view]}`}
                aria-label={`搜尋${VIEW_TITLES[view]}`}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </label>

            {view === 'participants' && (
              <>
                <p className="mt-3 text-xs font-semibold text-[#64715f]">{filteredCandidates.length} / {candidates.length} 家參與本次抽選</p>
                <ul className="mt-2 max-h-[52svh] overflow-y-auto pr-1">
                  {filteredCandidates.map((restaurant) => {
                    const isFav = restaurant.isFav;
                    const dist = restaurant.calculatedDistance;

                    return (
                      <li key={restaurant.id} className="my-2 rounded-2xl border border-[#e8ebe5] bg-[#fafbfa] p-3.5 shadow-2xs transition-all">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-1 flex-col items-start text-left">
                            {isFav && (
                              <span className="mb-1 inline-flex items-center gap-0.5 rounded-full bg-[#fce8e8] px-2 py-0.5 text-[10px] font-bold text-[#c34f54]">
                                <Heart className="size-3 fill-current" /> 已收藏
                              </span>
                            )}
                            <h3 className="break-words text-left text-base font-bold text-[#202720] leading-snug">
                              {restaurant.name}
                            </h3>
                            <p className="mt-0.5 break-words text-left text-xs text-[#64715f] leading-normal">
                              {restaurant.address || '地址資訊未提供'}
                            </p>

                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                              {dist !== null && (
                                <span className="inline-flex items-center gap-0.5 font-semibold text-[#4a6b4c]">
                                  <MapPin className="size-3.5" />
                                  {dist < 1000 ? `${Math.round(dist)}m` : `${(dist / 1000).toFixed(1)}km`}
                                </span>
                              )}
                              {typeof restaurant.rating === 'number' && restaurant.rating > 0 && (
                                <span className="font-semibold text-[#d69a34]">
                                  ★ {restaurant.rating.toFixed(1)}
                                </span>
                              )}
                              {restaurant.type && (
                                <span className="rounded-md bg-[#eef1eb] px-2 py-0.5 text-[11px] font-medium text-[#526950]">
                                  {restaurant.type}
                                </span>
                              )}
                              {(restaurant.sources || (restaurant.source ? [restaurant.source] : [])).map((src) => (
                                <span key={src} className="rounded-full bg-[#e9eee6] px-2 py-0.5 text-[9px] font-bold uppercase text-[#344434]">
                                  {src}
                                </span>
                              ))}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                            <a
                              href={getMapUrl(restaurant)}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="查看地圖"
                              className="grid size-8.5 cursor-pointer place-items-center rounded-full border border-[#d9ded4] bg-white text-[#344434] shadow-2xs transition-all duration-150 hover:scale-105 hover:border-[#263d30] hover:bg-[#eaf0e8] active:scale-95"
                            >
                              <Navigation className="size-4" />
                            </a>
                            <button
                              type="button"
                              onClick={() => void toggleFavorite(restaurant)}
                              aria-label={isFav ? '取消收藏' : '新增收藏'}
                              className={`grid size-8.5 cursor-pointer place-items-center rounded-full border shadow-2xs transition-all duration-150 hover:scale-105 active:scale-95 ${
                                isFav
                                  ? 'border-[#f2c4c4] bg-[#fce8e8] text-[#c34f54]'
                                  : 'border-[#d9ded4] bg-white text-[#879083] hover:border-[#f2c4c4] hover:text-[#c34f54]'
                              }`}
                            >
                              <Heart className={`size-4 ${isFav ? 'fill-current' : ''}`} />
                            </button>
                            <button
                              type="button"
                              onClick={() => void addToBlacklist(restaurant)}
                              aria-label="永久排除"
                              className="grid size-8.5 cursor-pointer place-items-center rounded-full border border-[#d9ded4] bg-white text-[#879083] shadow-2xs transition-all duration-150 hover:scale-105 hover:border-[#78655b] hover:bg-[#f5eeea] hover:text-[#78655b] active:scale-95"
                            >
                              <ShieldBan className="size-4" />
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                  {filteredCandidates.length === 0 && <li className="py-8 text-center text-sm text-[#64715f]">沒有符合的餐廳</li>}
                </ul>
              </>
            )}

            {/* 臨時排除列表：改為圖標按鈕組 */}
            {view === 'exclusions' && (
              <>
                <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[#64715f]">
                  <span>{filteredExclusions.length} 家臨時排除</span>
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} className="cursor-pointer" /> 全選
                  </label>
                </div>
                <div className="mt-2 max-h-[50svh] divide-y divide-[#e8ebe5] overflow-y-auto pr-1">
                  {filteredExclusions.map((row) => (
                    <div key={row.placeId} className="flex items-center gap-3 py-3">
                      <input type="checkbox" checked={selectedIds.includes(row.placeId)} onChange={() => toggleSelected(row.placeId)} aria-label={`選取${nameFor(row.placeId, row.restaurantName)}`} className="cursor-pointer" />
                      <div className="min-w-0 flex-1 text-left">
                        <p className="break-words text-sm font-bold text-[#202720]">{nameFor(row.placeId, row.restaurantName)}</p>
                        <p className="mt-1 text-xs text-[#64715f]">排除至 {new Date(row.expiredAt).toLocaleString()}</p>
                      </div>
                      
                      {/* 右側圖標按鈕群 */}
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void releaseExclusions([row.placeId])}
                          disabled={isWorking}
                          title="釋放（恢復參與抽選）"
                          aria-label="釋放"
                          className="grid size-8.5 cursor-pointer place-items-center rounded-full border border-[#d9ded4] bg-white text-[#344434] shadow-2xs transition-all duration-150 hover:scale-105 hover:border-[#263d30] hover:bg-[#eaf0e8] active:scale-95 disabled:opacity-50"
                        >
                          <RotateCcw className="size-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void extendExclusions([row.placeId], 24 * 60 * 60 * 1000)}
                          disabled={isWorking}
                          title="延長 24 小時"
                          aria-label="延長 24 小時"
                          className="grid size-8.5 cursor-pointer place-items-center rounded-full border border-[#d9ded4] bg-white text-[#64715f] shadow-2xs transition-all duration-150 hover:scale-105 hover:border-[#263d30] hover:bg-[#eaf0e8] hover:text-[#263d30] active:scale-95 disabled:opacity-50"
                        >
                          <Clock3 className="size-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void moveExclusionsToBlacklist([row.placeId])}
                          disabled={isWorking}
                          title="移至永久黑名單"
                          aria-label="移至永久黑名單"
                          className="grid size-8.5 cursor-pointer place-items-center rounded-full border border-[#d9ded4] bg-white text-[#879083] shadow-2xs transition-all duration-150 hover:scale-105 hover:border-[#78655b] hover:bg-[#f5eeea] hover:text-[#78655b] active:scale-95 disabled:opacity-50"
                        >
                          <ShieldBan className="size-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {filteredExclusions.length === 0 && <p className="py-8 text-center text-sm text-[#64715f]">沒有符合的排除項目</p>}
                </div>
                {selectedIds.length > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => void releaseExclusions(selectedIds)} disabled={isWorking} className="cursor-pointer rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-bold text-[#344434] hover:bg-[#f1f3ef]">釋放所選 ({selectedIds.length})</button>
                    <button type="button" onClick={() => void extendExclusions(selectedIds, 24 * 60 * 60 * 1000)} disabled={isWorking} className="cursor-pointer rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold text-[#64715f] hover:bg-[#f1f3ef]">延長 24 小時</button>
                    <button type="button" onClick={() => void extendExclusions(selectedIds, 7 * 24 * 60 * 60 * 1000)} disabled={isWorking} className="cursor-pointer rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold text-[#64715f] hover:bg-[#f1f3ef]">延長 7 天</button>
                    <button type="button" onClick={() => void moveExclusionsToBlacklist(selectedIds)} disabled={isWorking} className="cursor-pointer rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold text-[#78655b] hover:bg-[#f5eeea]">移至永久黑名單</button>
                  </div>
                )}
              </>
            )}

            {view === 'blacklist' && (
              <>
                <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[#64715f]">
                  <span>{filteredBlacklist.length} 家永久排除</span>
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} className="cursor-pointer" /> 全選
                  </label>
                </div>
                <div className="mt-2 max-h-[52svh] divide-y divide-[#e8ebe5] overflow-y-auto">
                  {filteredBlacklist.map((row) => (
                    <div key={row.placeId} className="flex items-start gap-3 py-3">
                      <input type="checkbox" checked={selectedIds.includes(row.placeId)} onChange={() => toggleSelected(row.placeId)} aria-label={`選取${nameFor(row.placeId, row.restaurantName)}`} className="mt-1 cursor-pointer" />
                      <div className="min-w-0 flex-1 text-left">
                        <p className="break-words text-sm font-bold text-[#202720]">{nameFor(row.placeId, row.restaurantName)}</p>
                        <p className="mt-1 text-xs text-[#64715f]">{row.address || `加入於 ${new Date(row.createdAt).toLocaleDateString()}`}</p>
                      </div>
                      <button type="button" onClick={() => void releaseBlacklist([row.placeId])} disabled={isWorking} className="cursor-pointer px-2 py-1 text-xs font-semibold text-[#344434] hover:underline">解除</button>
                    </div>
                  ))}
                  {filteredBlacklist.length === 0 && <p className="py-8 text-center text-sm text-[#64715f]">永久黑名單是空的</p>}
                </div>
                {selectedIds.length > 0 && (
                  <button type="button" onClick={() => void releaseBlacklist(selectedIds)} disabled={isWorking} className="mt-3 w-full cursor-pointer rounded-lg border border-[#d9ded4] px-3 py-2 text-sm font-bold text-[#344434] hover:bg-[#f1f3ef]">
                    解除所選 ({selectedIds.length})
                  </button>
                )}
              </>
            )}

            {view === 'reviews' && (
              <div className="mt-2 max-h-[58svh] divide-y divide-[#e8ebe5] overflow-y-auto">
                {filteredReviews.map((note) => (
                  <article key={note.id ?? `${note.placeId}-${note.updatedAt}`} className="py-3 text-left">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-bold text-[#202720]">{note.restaurantName}</h3>
                        <p className="mt-1 text-xs text-[#916229]">{'★'.repeat(note.rating)}{'☆'.repeat(5 - note.rating)}</p>
                      </div>
                      {note.publishedAt ? (
                        <span className="shrink-0 rounded-full bg-[#e9eee6] px-2.5 py-1 text-[11px] font-semibold text-[#344434]">已發布</span>
                      ) : (
                        <button type="button" onClick={() => void publishDraft(note, Date.now())} className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs font-bold text-[#344434] hover:underline">
                          <Send className="size-3" /> 發佈
                        </button>
                      )}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#4e584b]">{note.notes}</p>
                    <p className="mt-2 text-[11px] text-[#879083]">{new Date(note.publishedAt ?? note.updatedAt).toLocaleString()}</p>
                  </article>
                ))}
                {filteredReviews.length === 0 && <p className="py-8 text-center text-sm text-[#64715f]">沒有符合的食記</p>}
              </div>
            )}

            {view === 'favorites' && (
              <div className="mt-2 max-h-[58svh] divide-y divide-[#e8ebe5] overflow-y-auto">
                {filteredFavorites.map((restaurant) => (
                  <article key={restaurant.id} className="flex items-center justify-between gap-3 py-3 text-left">
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-bold text-[#202720]">{restaurant.name}</h3>
                      <p className="mt-1 break-words text-xs text-[#64715f]">{restaurant.address || '地址資訊未提供'}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeFavorite(restaurant.id)}
                      aria-label="取消收藏"
                      className="grid size-8.5 shrink-0 cursor-pointer place-items-center rounded-full border border-[#f2c4c4] bg-[#fce8e8] text-[#c34f54] shadow-2xs transition-all duration-150 hover:scale-105 active:scale-95"
                    >
                      <Heart className="size-4 fill-current" />
                    </button>
                  </article>
                ))}
                {filteredFavorites.length === 0 && <p className="py-8 text-center text-sm text-[#64715f]">沒有符合的收藏餐廳</p>}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}