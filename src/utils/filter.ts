import { db } from '../db';

export async function getValidCandidates<T extends { id: string }>(rawPlaces: T[]): Promise<T[]> {
  const now = Date.now();

  // 1. 清理過期的臨時剔除記錄（使用 try-catch 防止資料庫索引異常中斷執行）
  try {
    await db.tempExclusions.where('expiredAt').below(now).delete();
  } catch (error) {
    console.warn('自動清理過期紀錄失敗，改用記憶體雙重過濾：', error);
  }

  // 2. 獲取當前有效的臨時剔除與永久黑名單 ID（記憶體二次校驗，確保過期項絕不生效）
  const activeTemp = await db.tempExclusions.toArray();
  const validTemp = activeTemp.filter((item) => item.expiredAt > now);
  const tempIds = new Set(validTemp.map((item) => item.placeId));

  const blacklists = await db.blacklists.toArray();
  const blackIds = new Set(blacklists.map((item) => item.placeId));

  // 3. 精準過濾候選池
  return rawPlaces.filter((place) => !tempIds.has(place.id) && !blackIds.has(place.id));
}

// 新增 24 小時臨時剔除
export async function add24hTempExclusion(
  placeId: string,
  restaurant?: { name?: string; address?: string }
) {
  if (!placeId) return;

  const expiredAt = Date.now() + 24 * 60 * 60 * 1000;
  await db.tempExclusions.put({
    placeId,
    expiredAt,
    restaurantName: restaurant?.name || placeId,
    address: restaurant?.address || '',
  });
}