import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  ArrowLeft,
  NotebookPen,
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
import { filterByBilingualSearch } from '../utils/search';
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

export function ManagementDialog({
  preferences,
  draftPreferences,
  setDraftPreferences,
  candidates,
  allCandidates,
  radiusPreviewCount,
  isPreviewingRadius,
  radiusPreviewError,
  onSavePreferences,
  onClose,
  onRefreshCandidates,
}: ManagementDialogProps) {
  const [view, setView] = useState<View>('settings');
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

  const allRestaurants = new Map(allCandidates.map((restaurant) => [restaurant.id, restaurant]));
  const nameFor = (placeId: string, savedName?: string) => savedName || allRestaurants.get(placeId)?.name || placeId;

  const openView = async (nextView: View) => {
    setView(nextView);
    setSearch('');
    setSelectedIds([]);
    try {
      if (nextView === 'exclusions') {
        await db.tempExclusions.where('expiredAt').below(Date.now()).delete();
        setExclusions(await db.tempExclusions.toArray());
      } else if (nextView === 'blacklist') {
        setBlacklist(await db.blacklists.toArray());
      } else if (nextView === 'reviews') {
        setReviews((await db.notes.toArray()).sort((first, second) => second.updatedAt - first.updatedAt));
      } else if (nextView === 'favorites') {
        setFavorites((await db.favorites.toArray()).sort((first, second) => second.savedAt - first.savedAt));
      }
    } catch {
      setSearch('資料讀取失敗，請重新開啟此清單');
    }
  };

  const reloadView = async () => {
    if (view === 'exclusions') setExclusions(await db.tempExclusions.toArray());
    if (view === 'blacklist') setBlacklist(await db.blacklists.toArray());
    if (view === 'reviews') {
      setReviews((await db.notes.toArray()).sort((first, second) => second.updatedAt - first.updatedAt));
    }
    if (view === 'favorites') {
      setFavorites((await db.favorites.toArray()).sort((first, second) => second.savedAt - first.savedAt));
    }
  };

  const toggleSelected = (placeId: string) => {
    setSelectedIds((ids) => ids.includes(placeId) ? ids.filter((id) => id !== placeId) : [...ids, placeId]);
  };

  const releaseExclusions = async (placeIds: string[]) => {
    setIsWorking(true);
    try {
      await db.tempExclusions.bulkDelete(placeIds);
      setSelectedIds([]);
      await reloadView();
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
      await reloadView();
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
      await reloadView();
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
      await reloadView();
      await onRefreshCandidates();
    } finally {
      setIsWorking(false);
    }
  };

  const publishDraft = async (note: UserNote, publishedAt: number) => {
    await db.notes.put({ ...note, publishedAt, updatedAt: publishedAt });
    await reloadView();
  };

  const removeFavorite = async (restaurantId: string) => {
    await db.favorites.delete(restaurantId);
    await reloadView();
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      filterByBilingualSearch(candidates, search, (restaurant) => [restaurant.name, restaurant.address]),
      filterByBilingualSearch(exclusions, search, (row) => [resolveRestaurantName(allCandidates, row.placeId, row.restaurantName), row.address]),
      filterByBilingualSearch(blacklist, search, (row) => [resolveRestaurantName(allCandidates, row.placeId, row.restaurantName), row.address]),
      filterByBilingualSearch(reviews, search, (row) => [row.restaurantName, row.notes]),
      filterByBilingualSearch(favorites, search, (row) => [row.name, row.address]),
    ]).then(([nextCandidates, nextExclusions, nextBlacklist, nextReviews, nextFavorites]) => {
      if (cancelled) return;
      setFilteredCandidates(nextCandidates);
      setFilteredExclusions(nextExclusions);
      setFilteredBlacklist(nextBlacklist);
      setFilteredReviews(nextReviews);
      setFilteredFavorites(nextFavorites);
    });

    return () => {
      cancelled = true;
    };
  }, [search, candidates, exclusions, blacklist, reviews, favorites, allCandidates]);
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
    <div className="fixed inset-0 z-20 grid place-items-center bg-[#162119]/45 p-4" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="management-title"
        className="max-h-[92svh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2">
            {view !== 'settings' && (
              <button
                type="button"
                onClick={() => void openView('settings')}
                className="-ml-2 grid size-9 place-items-center rounded-full hover:bg-[#f1f3ef]"
                aria-label="返回搜尋設定"
              >
                <ArrowLeft className="size-5" />
              </button>
            )}
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#64715f]">FATBUDDY</p>
              <h2 id="management-title" className="mt-1 text-xl font-bold">{VIEW_TITLES[view]}</h2>
            </div>
          </div>
          {preferences && (
            <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-full hover:bg-[#f1f3ef]" aria-label="關閉">
              <X className="size-5" />
            </button>
          )}
        </div>

        {view === 'settings' && (
          <>
            <fieldset className="mt-5">
              <legend className="text-sm font-semibold">搜尋半徑</legend>
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
                className="mt-3 w-full accent-[#263d30]"
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

            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => void openView('blacklist')} className="flex items-center gap-2 rounded-xl border border-[#d9ded4] px-3 py-3 text-left text-sm">
                <ShieldBan className="size-4 shrink-0" /> 永久黑名單
              </button>
              <button type="button" onClick={() => void openView('reviews')} className="flex items-center gap-2 rounded-xl border border-[#d9ded4] px-3 py-3 text-left text-sm">
                <NotebookPen className="size-4 shrink-0" /> 我的食記
              </button>
              <button type="button" onClick={() => void openView('favorites')} className="flex items-center gap-2 rounded-xl border border-[#d9ded4] px-3 py-3 text-left text-sm">
                <span aria-hidden="true" className="text-base text-[#bd5a50]">♥</span> 收藏餐廳
              </button>
            </div>

            <button
              type="button"
              onClick={() => void onSavePreferences()}
              className="mt-5 w-full rounded-full bg-[#263d30] px-4 py-3 text-sm font-bold text-white"
            >
              {preferences ? '儲存設定' : '開始使用'}
            </button>
          </>
        )}

        {view !== 'settings' && (
          <div className="mt-5">
            <label className="flex items-center gap-2 rounded-xl border border-[#d9ded4] px-3 py-2.5">
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
                <p className="mt-3 text-xs text-[#64715f]">{filteredCandidates.length} / {candidates.length} 家參與本次抽選</p>
                <ul className="mt-2 max-h-[52svh] divide-y divide-[#e8ebe5] overflow-y-auto">
                  {filteredCandidates.map((restaurant) => (
                    <li key={restaurant.id}>
                      <div className="w-full py-3 text-left">
                        <span className="block text-sm font-semibold">{restaurant.name}</span>
                        <span className="mt-1 block truncate text-xs text-[#64715f]">{restaurant.address || restaurant.source || '餐廳'}</span>
                      </div>
                    </li>
                  ))}
                  {filteredCandidates.length === 0 && <li className="py-8 text-center text-sm text-[#64715f]">沒有符合的餐廳</li>}
                </ul>
              </>
            )}

            {view === 'exclusions' && (
              <>
                <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[#64715f]">
                  <span>{filteredExclusions.length} 家臨時排除</span>
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} /> 全選
                  </label>
                </div>
                <div className="mt-2 max-h-[40svh] divide-y divide-[#e8ebe5] overflow-y-auto">
                  {filteredExclusions.map((row) => (
                    <div key={row.placeId} className="flex items-start gap-3 py-3">
                      <input type="checkbox" checked={selectedIds.includes(row.placeId)} onChange={() => toggleSelected(row.placeId)} aria-label={`選取${nameFor(row.placeId, row.restaurantName)}`} className="mt-1" />
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-semibold">{nameFor(row.placeId, row.restaurantName)}</p>
                        <p className="mt-1 text-xs text-[#64715f]">排除至 {new Date(row.expiredAt).toLocaleString()}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <button type="button" onClick={() => void releaseExclusions([row.placeId])} disabled={isWorking} className="px-2 py-1 text-xs font-semibold text-[#344434]">釋放</button>
                        <button type="button" onClick={() => void extendExclusions([row.placeId], 24 * 60 * 60 * 1000)} disabled={isWorking} className="px-2 py-1 text-xs text-[#64715f]">延長 24 小時</button>
                        <button type="button" onClick={() => void moveExclusionsToBlacklist([row.placeId])} disabled={isWorking} className="px-2 py-1 text-xs text-[#78655b]">永久排除</button>
                      </div>
                    </div>
                  ))}
                  {filteredExclusions.length === 0 && <p className="py-8 text-center text-sm text-[#64715f]">沒有符合的排除項目</p>}
                </div>
                {selectedIds.length > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => void releaseExclusions(selectedIds)} disabled={isWorking} className="rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold">釋放所選 ({selectedIds.length})</button>
                    <button type="button" onClick={() => void extendExclusions(selectedIds, 24 * 60 * 60 * 1000)} disabled={isWorking} className="rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold">延長 24 小時</button>
                    <button type="button" onClick={() => void extendExclusions(selectedIds, 7 * 24 * 60 * 60 * 1000)} disabled={isWorking} className="rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold">延長 7 天</button>
                    <button type="button" onClick={() => void moveExclusionsToBlacklist(selectedIds)} disabled={isWorking} className="rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold">移至永久黑名單</button>
                  </div>
                )}
              </>
            )}

            {view === 'blacklist' && (
              <>
                <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[#64715f]">
                  <span>{filteredBlacklist.length} 家永久排除</span>
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} /> 全選
                  </label>
                </div>
                <div className="mt-2 max-h-[52svh] divide-y divide-[#e8ebe5] overflow-y-auto">
                  {filteredBlacklist.map((row) => (
                    <div key={row.placeId} className="flex items-start gap-3 py-3">
                      <input type="checkbox" checked={selectedIds.includes(row.placeId)} onChange={() => toggleSelected(row.placeId)} aria-label={`選取${nameFor(row.placeId, row.restaurantName)}`} className="mt-1" />
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-semibold">{nameFor(row.placeId, row.restaurantName)}</p>
                        <p className="mt-1 text-xs text-[#64715f]">{row.address || `加入於 ${new Date(row.createdAt).toLocaleDateString()}`}</p>
                      </div>
                      <button type="button" onClick={() => void releaseBlacklist([row.placeId])} disabled={isWorking} className="px-2 py-1 text-xs font-semibold text-[#344434]">解除</button>
                    </div>
                  ))}
                  {filteredBlacklist.length === 0 && <p className="py-8 text-center text-sm text-[#64715f]">永久黑名單是空的</p>}
                </div>
                {selectedIds.length > 0 && (
                  <button type="button" onClick={() => void releaseBlacklist(selectedIds)} disabled={isWorking} className="mt-3 w-full rounded-lg border border-[#d9ded4] px-3 py-2 text-sm font-semibold">
                    解除所選 ({selectedIds.length})
                  </button>
                )}
              </>
            )}

            {view === 'reviews' && (
              <div className="mt-2 max-h-[58svh] divide-y divide-[#e8ebe5] overflow-y-auto">
                {filteredReviews.map((note) => (
                  <article key={note.id ?? `${note.placeId}-${note.updatedAt}`} className="py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-semibold">{note.restaurantName}</h3>
                        <p className="mt-1 text-xs text-[#916229]">{'★'.repeat(note.rating)}{'☆'.repeat(5 - note.rating)}</p>
                      </div>
                      {note.publishedAt ? (
                        <span className="shrink-0 rounded-full bg-[#e9eee6] px-2 py-1 text-[11px] text-[#344434]">已發布</span>
                      ) : (
                        <button type="button" onClick={() => void publishDraft(note, Date.now())} className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-[#344434]">
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
                  <article key={restaurant.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-semibold">{restaurant.name}</h3>
                      <p className="mt-1 break-words text-xs text-[#64715f]">{restaurant.address || '地址資訊未提供'}</p>
                    </div>
                    <button type="button" onClick={() => void removeFavorite(restaurant.id)} className="shrink-0 px-2 py-1 text-xs font-semibold text-[#78655b]">
                      取消收藏
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