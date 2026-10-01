import { useEffect, useState } from 'react';
import { ChevronDown, Clock3, ListChecks, Search } from 'lucide-react';
import { db, type TempExclusion } from '../db';
import { filterByBilingualSearch } from '../utils/search';
import type { Restaurant } from './Roulette';

interface HomeListsProps {
  candidates: Restaurant[];
  allCandidates: Restaurant[];
  exclusionRevision: number;
  onCandidatesChanged: () => Promise<void>;
}

function resolveRestaurantName(allCandidates: Restaurant[], placeId: string, savedName?: string): string {
  return savedName || allCandidates.find((restaurant) => restaurant.id === placeId)?.name || placeId;
}

export function HomeLists({ candidates, allCandidates, exclusionRevision, onCandidatesChanged }: HomeListsProps) {
  const [candidateSearch, setCandidateSearch] = useState('');
  const [exclusionSearch, setExclusionSearch] = useState('');
  const [exclusions, setExclusions] = useState<TempExclusion[]>([]);
  const [filteredCandidates, setFilteredCandidates] = useState<Restaurant[]>(candidates);
  const [filteredExclusions, setFilteredExclusions] = useState<TempExclusion[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isWorking, setIsWorking] = useState(false);

  const allRestaurants = new Map(allCandidates.map((restaurant) => [restaurant.id, restaurant]));
  const nameFor = (placeId: string, savedName?: string) => resolveRestaurantName(allCandidates, placeId, savedName);

  const refreshExclusions = async () => {
    const now = Date.now();
    await db.tempExclusions.where('expiredAt').below(now).delete();
    setExclusions(await db.tempExclusions.toArray());
  };

  useEffect(() => {
    let cancelled = false;
    void db.tempExclusions.where('expiredAt').below(Date.now()).delete()
      .then(() => db.tempExclusions.toArray())
      .then((rows) => {
        if (!cancelled) setExclusions(rows);
      });
    return () => {
      cancelled = true;
    };
  }, [exclusionRevision]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      filterByBilingualSearch(candidates, candidateSearch, (restaurant) => [restaurant.name, restaurant.address]),
      filterByBilingualSearch(exclusions, exclusionSearch, (row) => [resolveRestaurantName(allCandidates, row.placeId, row.restaurantName), row.address]),
    ]).then(([nextCandidates, nextExclusions]) => {
      if (cancelled) return;
      setFilteredCandidates(nextCandidates);
      setFilteredExclusions(nextExclusions);
    });

    return () => {
      cancelled = true;
    };
  }, [candidates, candidateSearch, exclusions, exclusionSearch, allCandidates]);

  const toggleSelected = (placeId: string) => {
    setSelectedIds((ids) => ids.includes(placeId) ? ids.filter((id) => id !== placeId) : [...ids, placeId]);
  };

  const runExclusionAction = async (placeIds: string[], action: 'release' | 'extend24h' | 'extend7d' | 'blacklist') => {
    setIsWorking(true);
    try {
      if (action === 'release') {
        await db.tempExclusions.bulkDelete(placeIds);
        await onCandidatesChanged();
      } else if (action === 'blacklist') {
        const rows = await db.tempExclusions.bulkGet(placeIds);
        await db.blacklists.bulkPut(rows.flatMap((row) => row ? [{
          placeId: row.placeId,
          restaurantName: nameFor(row.placeId, row.restaurantName),
          address: row.address || allRestaurants.get(row.placeId)?.address,
          createdAt: Date.now(),
        }] : []));
        await db.tempExclusions.bulkDelete(placeIds);
        await onCandidatesChanged();
      } else {
        const rows = await db.tempExclusions.bulkGet(placeIds);
        const extraTime = action === 'extend24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        await db.tempExclusions.bulkPut(rows.flatMap((row) => row ? [{
          ...row,
          expiredAt: Math.max(Date.now(), row.expiredAt) + extraTime,
        }] : []));
      }

      setSelectedIds([]);
      await refreshExclusions();
    } finally {
      setIsWorking(false);
    }
  };

  const visibleIds = filteredExclusions.map((row) => row.placeId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleAllVisible = () => {
    setSelectedIds((ids) => allVisibleSelected
      ? ids.filter((id) => !visibleIds.includes(id))
      : [...new Set([...ids, ...visibleIds])]);
  };

  return (
    <section className="w-full border-t border-[#dce1d7]" aria-label="餐廳清單">
      <details className="border-b border-[#dce1d7]">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm font-semibold">
          <ListChecks className="size-4 text-[#526950]" />
          參與抽選
          <span className="ml-auto mr-2 text-xs font-normal text-[#64715f]">{candidates.length} 家</span>
          <ChevronDown className="size-4 text-[#64715f]" />
        </summary>
        <div className="pb-3">
          <label className="flex items-center gap-2 rounded-lg border border-[#d9ded4] bg-white px-3 py-2">
            <Search className="size-4 shrink-0 text-[#64715f]" />
            <input
              type="search"
              value={candidateSearch}
              onChange={(event) => setCandidateSearch(event.target.value)}
              placeholder="搜尋候選餐廳"
              aria-label="搜尋候選餐廳"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <p className="mt-2 text-xs text-[#64715f]">{filteredCandidates.length} / {candidates.length} 家</p>
          <ul className="mt-1 max-h-56 divide-y divide-[#e8ebe5] overflow-y-auto">
            {filteredCandidates.map((restaurant) => (
              <li key={restaurant.id} className="py-2">
                <p className="text-sm font-medium">{restaurant.name}</p>
                <p className="mt-0.5 truncate text-xs text-[#64715f]">{restaurant.address || restaurant.source || '餐廳'}</p>
              </li>
            ))}
            {filteredCandidates.length === 0 && <li className="py-5 text-center text-sm text-[#64715f]">沒有符合的餐廳</li>}
          </ul>
        </div>
      </details>

      <details className="border-b border-[#dce1d7]">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm font-semibold">
          <Clock3 className="size-4 text-[#526950]" />
          臨時排除
          <span className="ml-auto mr-2 text-xs font-normal text-[#64715f]">{exclusions.length} 家</span>
          <ChevronDown className="size-4 text-[#64715f]" />
        </summary>
        <div className="pb-3">
          <label className="flex items-center gap-2 rounded-lg border border-[#d9ded4] bg-white px-3 py-2">
            <Search className="size-4 shrink-0 text-[#64715f]" />
            <input
              type="search"
              value={exclusionSearch}
              onChange={(event) => setExclusionSearch(event.target.value)}
              placeholder="搜尋臨時排除"
              aria-label="搜尋臨時排除"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <div className="mt-2 flex items-center justify-between text-xs text-[#64715f]">
            <span>{filteredExclusions.length} / {exclusions.length} 家</span>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} /> 全選
            </label>
          </div>
          <ul className="mt-1 max-h-64 divide-y divide-[#e8ebe5] overflow-y-auto">
            {filteredExclusions.map((row) => (
              <li key={row.placeId} className="flex items-start gap-2 py-2">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(row.placeId)}
                  onChange={() => toggleSelected(row.placeId)}
                  aria-label={`選取${nameFor(row.placeId, row.restaurantName)}`}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{nameFor(row.placeId, row.restaurantName)}</p>
                  <p className="mt-0.5 text-xs text-[#64715f]">排除至 {new Date(row.expiredAt).toLocaleString()}</p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    <button type="button" onClick={() => void runExclusionAction([row.placeId], 'release')} disabled={isWorking} className="font-semibold text-[#344434]">釋放</button>
                    <button type="button" onClick={() => void runExclusionAction([row.placeId], 'extend24h')} disabled={isWorking} className="text-[#64715f]">延長 24 小時</button>
                    <button type="button" onClick={() => void runExclusionAction([row.placeId], 'blacklist')} disabled={isWorking} className="text-[#78655b]">永久排除</button>
                  </div>
                </div>
              </li>
            ))}
            {filteredExclusions.length === 0 && <li className="py-5 text-center text-sm text-[#64715f]">目前沒有臨時排除的餐廳</li>}
          </ul>
          {selectedIds.length > 0 && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => void runExclusionAction(selectedIds, 'release')} disabled={isWorking} className="rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold">釋放 ({selectedIds.length})</button>
              <button type="button" onClick={() => void runExclusionAction(selectedIds, 'extend24h')} disabled={isWorking} className="rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold">延長 24 小時</button>
              <button type="button" onClick={() => void runExclusionAction(selectedIds, 'extend7d')} disabled={isWorking} className="rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold">延長 7 天</button>
              <button type="button" onClick={() => void runExclusionAction(selectedIds, 'blacklist')} disabled={isWorking} className="rounded-lg border border-[#d9ded4] px-2 py-2 text-xs font-semibold">移至黑名單</button>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}