import { db } from '../db';

export async function getValidCandidates<T extends { id: string }>(rawPlaces: T[]): Promise<T[]> {
  const now = Date.now();

  // 1. 自动清理过期的临时剔除记录
  await db.tempExclusions.where('expiredAt').below(now).delete();

  // 2. 获取当前有效的临时剔除和永久黑名单 ID
  const activeTemp = await db.tempExclusions.toArray();
  const tempIds = new Set(activeTemp.map(item => item.placeId));
  
  const blacklists = await db.blacklists.toArray();
  const blackIds = new Set(blacklists.map(item => item.placeId));

  // 3. 过滤候选池
  return rawPlaces.filter(place => !tempIds.has(place.id) && !blackIds.has(place.id));
}

// 添加 24 小时临时剔除
export async function add24hTempExclusion(placeId: string, restaurant?: { name: string; address?: string }) {
  const expiredAt = Date.now() + 24 * 60 * 60 * 1000;
  await db.tempExclusions.put({
    placeId,
    expiredAt,
    restaurantName: restaurant?.name,
    address: restaurant?.address,
  });
}