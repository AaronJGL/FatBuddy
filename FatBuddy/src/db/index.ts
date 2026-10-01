import Dexie, { type Table } from 'dexie';
import type { Restaurant } from '../components/Roulette';

export interface AppPreferences {
  id: string;
  searchRadius: number;
}

export interface LastKnownLocation {
  id: string;
  lat: number;
  lng: number;
  updatedAt: number;
}

export interface CandidateCache {
  id: string;
  lat: number;
  lng: number;
  region: 'hk' | 'cn' | 'global';
  radius: number;
  candidates: Restaurant[];
  updatedAt: number;
}

export interface FavoriteRestaurant extends Restaurant {
  savedAt: number;
}

export interface TempExclusion {
  placeId: string;
  expiredAt: number; // 时间戳 Date.now() + 24 * 3600 * 1000
  restaurantName?: string;
  address?: string;
}

export interface PermanentBlacklist {
  placeId: string;
  createdAt: number;
  restaurantName?: string;
  address?: string;
}

export interface UserNote {
  id?: number;
  placeId: string;
  restaurantName: string;
  rating: number; // 1-5分
  notes: string;
  updatedAt: number;
  publishedAt?: number;
}

class EatRouletteDB extends Dexie {
  tempExclusions!: Table<TempExclusion, string>;
  blacklists!: Table<PermanentBlacklist, string>;
  notes!: Table<UserNote, number>;
  favorites!: Table<FavoriteRestaurant, string>;
  preferences!: Table<AppPreferences, string>;
  lastKnownLocations!: Table<LastKnownLocation, string>;
  candidateCaches!: Table<CandidateCache, string>;

  constructor() {
    super('EatRouletteDB');
    this.version(1).stores({
      tempExclusions: 'placeId, expiredAt',
      blacklists: 'placeId, createdAt',
      notes: 'placeId, updatedAt'
    });
    this.version(2).stores({
      tempExclusions: 'placeId, expiredAt',
      blacklists: 'placeId, createdAt',
      notes: 'placeId, updatedAt',
      preferences: 'id',
      lastKnownLocations: 'id, updatedAt',
      candidateCaches: 'id, updatedAt, region, radius',
    });
    this.version(3).stores({
      tempExclusions: 'placeId, expiredAt',
      blacklists: 'placeId, createdAt',
      notes: 'placeId, updatedAt, publishedAt',
      preferences: 'id',
      lastKnownLocations: 'id, updatedAt',
      candidateCaches: 'id, updatedAt, region, radius',
    });
    this.version(4).stores({
      tempExclusions: 'placeId, expiredAt',
      blacklists: 'placeId, createdAt',
      notes: '++id, placeId, updatedAt, publishedAt',
      preferences: 'id',
      lastKnownLocations: 'id, updatedAt',
      candidateCaches: 'id, updatedAt, region, radius',
    }).upgrade(async (transaction) => {
      const notes = transaction.table('notes');
      const previousNotes = await notes.toArray() as Array<UserNote & { id?: number }>;
      await notes.clear();
      await notes.bulkAdd(previousNotes.map(({ id: _previousId, ...note }) => note));
    });
    this.version(5).stores({
      tempExclusions: 'placeId, expiredAt',
      blacklists: 'placeId, createdAt',
      notes: '++id, placeId, updatedAt, publishedAt',
      favorites: 'id, savedAt',
      preferences: 'id',
      lastKnownLocations: 'id, updatedAt',
      candidateCaches: 'id, updatedAt, region, radius',
    });
  }
}

export const db = new EatRouletteDB();